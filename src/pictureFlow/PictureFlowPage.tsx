import { ExternalLink, Gamepad2, Loader2, Play } from "lucide-react";
import {
  Badge,
  Button,
  Callout,
  Card,
  Flex,
  Heading,
  Text,
} from "@radix-ui/themes";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../shared/api";
import {
  cutoutPhotoScratchSlot,
  fetchPhotoScratchSlots,
  generatePhotoScratchSlotMesh,
  matchPhotoScratchSlot,
  photoScratchSlotIsDone,
  photoScratchSlotPlayHref,
  publishPhotoScratchGame,
  type PhotoScratchSlot,
} from "../shared/models";
import { MaskEditor } from "../videoFlow/MaskEditor";
import { PhotoScratchSymbolPicker } from "../videoFlow/PhotoScratchSymbolPicker";
import { iconProps, MediaPreview } from "../videoFlow/ui";
import { VideoFlowShell } from "../videoFlow/VideoFlowShell";

type StepId = "layers" | "match" | "cutout" | "mesh" | "symbols" | "game";

type StepDef = {
  id: StepId;
  label: string;
  subtitle: string;
  blurb: string;
};

const STEPS: StepDef[] = [
  {
    id: "layers",
    label: "Layers",
    subtitle: "Background + bikini + top",
    blurb: "Approve background, bikini, and top in Video Flow first.",
  },
  {
    id: "match",
    label: "Match",
    subtitle: "Line up bikini + top for the game",
    blurb:
      "Puts both layers on the same canvas so scratching the top reveals the bikini underneath without a double face.",
  },
  {
    id: "cutout",
    label: "Cutout",
    subtitle: "Girl without scene",
    blurb:
      "Remove the scene behind the girl into RGBA cutouts. Originals stay on the card.",
  },
  {
    id: "mesh",
    label: "Mesh",
    subtitle: "Scratch mask lattice",
    blurb: "Build a static scratch mesh from the top layer, then fix the mask if needed.",
  },
  {
    id: "symbols",
    label: "Symbols",
    subtitle: "12 UV anchors",
    blurb: "Place all 12 symbol points on the dress.",
  },
  {
    id: "game",
    label: "Game",
    subtitle: "Publish & play",
    blurb: "Publish this card and open the playable photo scratch game.",
  },
];

function readQuery(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name)?.trim() || "";
}

function layersComplete(slot: PhotoScratchSlot): boolean {
  return Boolean(slot.background && slot.bikini && slot.clothes);
}

function stepDone(slot: PhotoScratchSlot, step: StepId): boolean {
  switch (step) {
    case "layers":
      return layersComplete(slot);
    case "match":
      return Boolean(slot.has_match);
    case "cutout":
      return Boolean(slot.has_cutout);
    case "mesh":
      return Boolean(slot.mesh);
    case "symbols":
      return Boolean(slot.has_symbols);
    case "game":
      return photoScratchSlotIsDone(slot);
  }
}

function currentStep(slot: PhotoScratchSlot): StepId {
  for (const step of STEPS) {
    if (!stepDone(slot, step.id)) return step.id;
  }
  return "game";
}

function stepUnlocked(slot: PhotoScratchSlot, step: StepId): boolean {
  const index = STEPS.findIndex((s) => s.id === step);
  if (index <= 0) return true;
  return stepDone(slot, STEPS[index - 1]!.id);
}

function stepStatus(
  slot: PhotoScratchSlot,
  step: StepId,
): "done" | "ready" | "locked" {
  if (stepDone(slot, step)) return "done";
  if (stepUnlocked(slot, step)) return "ready";
  return "locked";
}

function stepBadge(status: "done" | "ready" | "locked"): {
  color: "green" | "blue" | "gray";
  label: string;
} {
  if (status === "done") return { color: "green", label: "Done" };
  if (status === "ready") return { color: "blue", label: "Ready" };
  return { color: "gray", label: "Locked" };
}

async function pollJob(jobId: string, label: string) {
  for (let i = 0; i < 180; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const next = await api<{ id: string; status: string; logs: string[] }>(
      `/api/jobs/${encodeURIComponent(jobId)}`,
    );
    if (next.status === "succeeded") return;
    if (next.status === "failed" || next.status === "cancelled") {
      throw new Error(next.logs?.[next.logs.length - 1] ?? next.status);
    }
  }
  throw new Error(`${label} timed out`);
}

/** Prep screen: Video Flow pipeline boxes + detail screen on the right. */
export function PictureFlowPage() {
  const cardId = useMemo(() => readQuery("card"), []);
  const focusSlot = useMemo(() => readQuery("slot"), []);
  const detailRef = useRef<HTMLElement | null>(null);
  const [slots, setSlots] = useState<PhotoScratchSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cutoutBusy, setCutoutBusy] = useState("");
  const [matchBusy, setMatchBusy] = useState("");
  const [meshBusy, setMeshBusy] = useState("");
  const [publishBusy, setPublishBusy] = useState("");
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [manualStepBySlot, setManualStepBySlot] = useState<Record<string, StepId>>(
    {},
  );
  const [fixMeshOpen, setFixMeshOpen] = useState(false);

  async function refresh() {
    if (!cardId) {
      setSlots([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await fetchPhotoScratchSlots(cardId);
      setSlots(next);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [cardId]);

  const readySlots = slots.filter(layersComplete);
  const visibleSlots = focusSlot
    ? readySlots.filter((s) => s.id === focusSlot)
    : readySlots;

  useEffect(() => {
    if (visibleSlots.length === 0) {
      setSelectedSlotId("");
      return;
    }
    if (focusSlot && visibleSlots.some((s) => s.id === focusSlot)) {
      setSelectedSlotId(focusSlot);
      return;
    }
    if (!visibleSlots.some((s) => s.id === selectedSlotId)) {
      setSelectedSlotId(visibleSlots[0]!.id);
    }
  }, [focusSlot, visibleSlots, selectedSlotId]);

  const slot = visibleSlots.find((s) => s.id === selectedSlotId) ?? null;
  const busy = Boolean(cutoutBusy || matchBusy || meshBusy || publishBusy);

  const autoStep = slot ? currentStep(slot) : "layers";
  const activeStep = slot ? (manualStepBySlot[slot.id] ?? autoStep) : "layers";
  const activeDef = STEPS.find((s) => s.id === activeStep) ?? STEPS[0]!;
  const done = slot ? photoScratchSlotIsDone(slot) : false;

  const previewClothes =
    slot?.clothes_cutout || slot?.clothes || slot?.bikini_cutout || slot?.bikini || "";
  const previewBikini = slot?.bikini_cutout || slot?.bikini || "";

  function clearManualStep(slotId: string) {
    setManualStepBySlot((prev) => {
      const next = { ...prev };
      delete next[slotId];
      return next;
    });
  }

  function selectStep(step: StepId) {
    if (!slot || !stepUnlocked(slot, step)) return;
    setFixMeshOpen(false);
    setManualStepBySlot((prev) => ({ ...prev, [slot.id]: step }));
    // On stacked (narrow) layout the detail sits below the pipeline — bring it into view.
    requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function handleMatch(slotId: string, relock = false) {
    if (!cardId || busy) return;
    setMatchBusy(slotId);
    setError("");
    try {
      const job = await matchPhotoScratchSlot(cardId, slotId, "", { relock });
      await pollJob(job.id, relock ? "AI re-dress top" : "Register layers");
      clearManualStep(slotId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMatchBusy("");
    }
  }

  async function handleCutout(slotId: string) {
    if (!cardId || busy) return;
    setCutoutBusy(slotId);
    setError("");
    try {
      const job = await cutoutPhotoScratchSlot(cardId, slotId);
      await pollJob(job.id, "Cut out girl");
      clearManualStep(slotId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCutoutBusy("");
    }
  }

  async function handleMesh(slotId: string) {
    if (!cardId || busy) return;
    setMeshBusy(slotId);
    setError("");
    try {
      const job = await generatePhotoScratchSlotMesh(cardId, slotId);
      await pollJob(job.id, "Mesh generation");
      clearManualStep(slotId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMeshBusy("");
    }
  }

  async function handleCreateGame(slotId: string) {
    if (!cardId || busy) return;
    setPublishBusy(slotId);
    setError("");
    try {
      await publishPhotoScratchGame(cardId, slotId);
      window.open(photoScratchSlotPlayHref(cardId, slotId), "_blank", "noopener,noreferrer");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPublishBusy("");
    }
  }

  return (
    <VideoFlowShell
      active="picture"
      error={error}
      subtitle={
        cardId
          ? `Card ${cardId} — layers → match → cutout → mesh → symbols → game.`
          : "Open from Video Flow after uploading 3 layers on a photo card."
      }
      title="Photo scratch game"
      onRefresh={() => void refresh()}
    >
      {!cardId ? (
        <Text color="gray">Missing ?card= in the URL.</Text>
      ) : loading ? (
        <Text color="gray">Loading photo cards…</Text>
      ) : visibleSlots.length === 0 ? (
        <Card size="3">
          <Heading size="4" mb="2">
            No photo cards ready
          </Heading>
          <Text color="gray" size="2" mb="3">
            Upload or generate background + bikini + top in Video Flow first, then open Picture
            Flow again.
          </Text>
          <Button asChild>
            <a href={`/dashboard/video-flow/run?card=${encodeURIComponent(cardId)}`}>
              Open Video Flow
            </a>
          </Button>
        </Card>
      ) : slot ? (
        <Flex direction="column" gap="4">
          {!focusSlot && visibleSlots.length > 1 ? (
            <Flex gap="2" wrap="wrap">
              {visibleSlots.map((entry) => (
                <Button
                  key={entry.id}
                  size="1"
                  variant={entry.id === slot.id ? "solid" : "soft"}
                  onClick={() => {
                    setSelectedSlotId(entry.id);
                    setFixMeshOpen(false);
                  }}
                >
                  {entry.label}
                  {photoScratchSlotIsDone(entry) ? (
                    <Badge color="green" ml="2" size="1">
                      Done
                    </Badge>
                  ) : null}
                </Button>
              ))}
            </Flex>
          ) : null}

          <div className="video-flow-run-layout picture-flow-run-layout">
            <aside className="video-flow-run-steps">
              <Text size="2" weight="bold" mb="3">
                Pipeline
              </Text>
              <Text color="gray" size="1" mb="2">
                {slot.label}
              </Text>
              {STEPS.map((step, index) => {
                const status = stepStatus(slot, step.id);
                const badge = stepBadge(status);
                const locked = status === "locked";
                return (
                  <button
                    key={step.id}
                    type="button"
                    className={[
                      "video-flow-run-step",
                      `is-${status}`,
                      activeStep === step.id ? "is-active" : "",
                      locked ? "is-disabled" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    disabled={locked}
                    onClick={() => selectStep(step.id)}
                  >
                    <span className="video-flow-run-step-num">{index + 1}</span>
                    <span className="video-flow-run-step-body">
                      <strong>{step.label}</strong>
                      <span>{step.subtitle}</span>
                    </span>
                    <Badge color={badge.color} size="1">
                      {badge.label}
                    </Badge>
                  </button>
                );
              })}
              {cardId ? (
                <div className="video-flow-run-total-time">
                  <Button asChild color="gray" size="1" variant="soft">
                    <a href={`/dashboard/video-flow/run?card=${encodeURIComponent(cardId)}`}>
                      <ExternalLink {...iconProps} />
                      Back to Video Flow
                    </a>
                  </Button>
                </div>
              ) : null}
            </aside>

            <section
              ref={detailRef}
              className="video-flow-run-detail"
              id="picture-flow-detail"
            >
              {busy ? (
                <Callout.Root color="blue" mb="4">
                  <Callout.Text>
                    {matchBusy
                      ? "Matching bikini + top…"
                      : cutoutBusy
                        ? "Cutting out girl…"
                        : meshBusy
                          ? "Building mesh…"
                          : "Publishing game…"}
                  </Callout.Text>
                </Callout.Root>
              ) : null}

              <div className="flow-editor">
                <div className="flow-editor-head">
                  <Flex align="center" gap="2" wrap="wrap">
                    <Badge color="gray">
                      Step {STEPS.findIndex((s) => s.id === activeStep) + 1}
                    </Badge>
                    <Heading size="4">{activeDef.label}</Heading>
                  </Flex>
                  <Text color="gray" size="2">
                    {activeDef.blurb}
                  </Text>
                </div>

                {activeStep === "layers" ? (
                  <Flex direction="column" gap="4">
                    <Callout.Root color="blue">
                      <Callout.Text>
                        Layers are managed in Video Flow. Come back here after background, bikini,
                        and top are approved.
                      </Callout.Text>
                    </Callout.Root>
                    <Flex gap="2" wrap="wrap">
                      {slot.background ? (
                        <MediaPreview
                          label="Background"
                          size="compact"
                          type="image"
                          value={slot.background}
                          zoomable
                        />
                      ) : null}
                      {slot.bikini ? (
                        <MediaPreview
                          label="Bikini"
                          size="compact"
                          type="image"
                          value={slot.bikini}
                          zoomable
                        />
                      ) : null}
                      {slot.clothes ? (
                        <MediaPreview
                          label="Top"
                          size="compact"
                          type="image"
                          value={slot.clothes}
                          zoomable
                        />
                      ) : null}
                    </Flex>
                  </Flex>
                ) : null}

                {activeStep === "match" ? (
                  <Flex direction="column" gap="4">
                    <Flex gap="2" wrap="wrap">
                      {slot.bikini ? (
                        <MediaPreview
                          label="Bikini (reference)"
                          size="compact"
                          type="image"
                          value={slot.bikini}
                          zoomable
                        />
                      ) : null}
                      {slot.clothes ? (
                        <MediaPreview
                          label="Top (before match)"
                          size="compact"
                          type="image"
                          value={slot.clothes}
                          zoomable
                        />
                      ) : null}
                      {slot.clothes_matched ? (
                        <MediaPreview
                          label="Top (matched)"
                          size="compact"
                          type="image"
                          value={slot.clothes_matched}
                          zoomable
                        />
                      ) : null}
                      {slot.match_blend ? (
                        <MediaPreview
                          label="Blend (50/50)"
                          size="compact"
                          type="image"
                          value={slot.match_blend}
                          zoomable
                        />
                      ) : null}
                      {slot.match_overlay ? (
                        <MediaPreview
                          label="Difference (bikini − matched)"
                          size="compact"
                          type="image"
                          value={slot.match_overlay}
                          zoomable
                        />
                      ) : null}
                    </Flex>
                    {slot.has_match && slot.match_pose_ok === false ? (
                      <Callout.Root color="orange">
                        <Callout.Text>
                          Arms/stance look different between bikini and top. Re-generate the
                          Top from the bikini (pose-lock prompt), or use{" "}
                          <strong>AI re-dress</strong> below as a last resort. Bright
                          fabric in Difference / ghosting in Blend is normal — two
                          outfits, not a failed match.
                        </Callout.Text>
                      </Callout.Root>
                    ) : null}
                    {slot.has_match && slot.match_pose_ok ? (
                      <Callout.Root color="green">
                        <Callout.Text>
                          Layers registered. Blend is 50/50 ghost; Difference is{" "}
                          <code>mix-blend-mode: difference</code> (black = same pixels,
                          bright = mismatch). Proceed to Cutout.
                        </Callout.Text>
                      </Callout.Root>
                    ) : null}
                    {!slot.has_match ? (
                      <Callout.Root color="blue">
                        <Callout.Text>
                          Start with <strong>Register layers</strong>. Use{" "}
                          <strong>AI re-dress</strong> only if the top was generated
                          with wrong arms/pose.
                        </Callout.Text>
                      </Callout.Root>
                    ) : null}
                  </Flex>
                ) : null}

                {activeStep === "cutout" ? (
                  <Flex direction="column" gap="4">
                    {slot.has_cutout ? (
                      <Flex gap="2" wrap="wrap">
                        {slot.bikini_cutout ? (
                          <MediaPreview
                            label="Bikini cutout"
                            size="compact"
                            type="image"
                            value={slot.bikini_cutout}
                            zoomable
                          />
                        ) : null}
                        {slot.clothes_cutout ? (
                          <MediaPreview
                            label="Top cutout"
                            size="compact"
                            type="image"
                            value={slot.clothes_cutout}
                            zoomable
                          />
                        ) : null}
                      </Flex>
                    ) : (
                      <Callout.Root color="blue">
                        <Callout.Text>
                          Run Cut out girl to generate the RGBA cutouts (bikini + top). Arm gaps
                          (pink/beige wall between the arms) are punched automatically. If a pocket
                          remains: Mesh → Erase, paint just that bay, then clear it — aim for clean
                          edges, no artifacts. Originals stay on the Layers step only.
                        </Callout.Text>
                      </Callout.Root>
                    )}
                  </Flex>
                ) : null}

                {activeStep === "mesh" ? (
                  <Flex direction="column" gap="4">
                    {fixMeshOpen && slot.mesh && previewClothes && cardId ? (
                      <MaskEditor
                        imageSrc={previewClothes}
                        meshFile={`public/cards/${cardId}/photo-scratch/${slot.id}/mesh.json`}
                        meshSavePath={`public/cards/${cardId}/photo-scratch/${slot.id}/mesh.json`}
                        meshUrl={slot.mesh}
                        title="Photo scratch mask"
                        onError={setError}
                        onSaved={() => void refresh()}
                      />
                    ) : (
                      <>
                        {previewClothes ? (
                          <MediaPreview
                            label="Mesh source (top / bikini)"
                            size="compact"
                            type="image"
                            value={previewClothes}
                            zoomable
                          />
                        ) : null}
                        {slot.mesh ? (
                          <Callout.Root color="green">
                            <Callout.Text>
                              Mesh ready at <code>{slot.mesh}</code>. Use Fix mesh to paint the
                              garment mask.
                            </Callout.Text>
                          </Callout.Root>
                        ) : (
                          <Callout.Root color="blue">
                            <Callout.Text>
                              Create mesh builds a static UV lattice from the cutout top layer.
                            </Callout.Text>
                          </Callout.Root>
                        )}
                      </>
                    )}
                  </Flex>
                ) : null}

                {activeStep === "symbols" ? (
                  <Flex direction="column" gap="4">
                    {slot.mesh && previewClothes && cardId ? (
                      <PhotoScratchSymbolPicker
                        cardId={cardId}
                        imageSrc={previewClothes}
                        meshUrl={slot.mesh}
                        slotId={slot.id}
                        onError={setError}
                        onSaved={() => {
                          clearManualStep(slot.id);
                          void refresh();
                        }}
                      />
                    ) : (
                      <Callout.Root color="amber">
                        <Callout.Text>Create mesh first, then place symbols here.</Callout.Text>
                      </Callout.Root>
                    )}
                  </Flex>
                ) : null}

                {activeStep === "game" ? (
                  <Flex direction="column" gap="4">
                    <Callout.Root color={done ? "green" : "amber"}>
                      <Callout.Text>
                        {done
                          ? "All steps done — publish to open the playable game."
                          : "Finish cutout, mesh, and symbols before creating the game."}
                      </Callout.Text>
                    </Callout.Root>
                    <Flex gap="2" wrap="wrap">
                      {slot.background ? (
                        <MediaPreview
                          label="Background"
                          size="compact"
                          type="image"
                          value={slot.background}
                          zoomable
                        />
                      ) : null}
                      {previewBikini ? (
                        <MediaPreview
                          label="Bikini"
                          size="compact"
                          type="image"
                          value={previewBikini}
                          zoomable
                        />
                      ) : null}
                      {previewClothes ? (
                        <MediaPreview
                          label="Top"
                          size="compact"
                          type="image"
                          value={previewClothes}
                          zoomable
                        />
                      ) : null}
                    </Flex>
                  </Flex>
                ) : null}
              </div>

              <div className="flow-run-bar">
                <Flex direction="column" gap="2" style={{ flex: 1 }}>
                  <Text size="2" weight="medium">
                    {activeDef.label}
                    {stepDone(slot, activeStep) ? " — done" : ""}
                  </Text>
                  <Text color="gray" size="1">
                    {activeDef.subtitle}
                  </Text>
                </Flex>
                <Flex gap="2" wrap="wrap">
                  {activeStep === "layers" ? (
                    <Button asChild>
                      <a
                        href={`/dashboard/video-flow/run?card=${encodeURIComponent(cardId)}`}
                      >
                        Open Video Flow
                      </a>
                    </Button>
                  ) : null}

                  {activeStep === "match" ? (
                    <Flex direction="column" gap="3" style={{ width: "100%" }}>
                      <Flex direction="column" gap="1" style={{ maxWidth: 420 }}>
                        <Button
                          color="red"
                          disabled={busy || !slot.bikini || !slot.clothes}
                          onClick={() => void handleMatch(slot.id, false)}
                        >
                          {matchBusy === slot.id ? (
                            <Loader2 {...iconProps} className="spin" />
                          ) : (
                            <Play {...iconProps} />
                          )}
                          {slot.has_match ? "Re-register layers" : "Register layers"}
                        </Button>
                        <Text color="gray" size="1">
                          Default. Aligns the approved top onto the bikini framing
                          (same canvas for Cutout). Fast, no new AI image. Use this
                          first.
                        </Text>
                      </Flex>
                      <Flex direction="column" gap="1" style={{ maxWidth: 420 }}>
                        <Button
                          variant="soft"
                          disabled={busy || !slot.bikini || !slot.clothes}
                          onClick={() => void handleMatch(slot.id, true)}
                        >
                          AI re-dress
                        </Button>
                        <Text color="gray" size="1">
                          Last resort. Asks AI to redraw the top outfit onto the
                          bikini pose. Slow and can blur the face — only if arms or
                          stance clearly don&apos;t match.
                        </Text>
                      </Flex>
                    </Flex>
                  ) : null}

                  {activeStep === "cutout" ? (
                    <Button
                      color="red"
                      disabled={busy || !slot.has_match}
                      title={slot.has_match ? undefined : "Finish Match first"}
                      onClick={() => void handleCutout(slot.id)}
                    >
                      {cutoutBusy === slot.id ? (
                        <Loader2 {...iconProps} className="spin" />
                      ) : (
                        <Play {...iconProps} />
                      )}
                      {slot.has_cutout ? "Re-cut girl" : "Cut out girl"}
                    </Button>
                  ) : null}

                  {activeStep === "mesh" ? (
                    <>
                      <Button
                        color="red"
                        disabled={busy || !slot.has_cutout}
                        onClick={() => void handleMesh(slot.id)}
                      >
                        {meshBusy === slot.id ? (
                          <Loader2 {...iconProps} className="spin" />
                        ) : (
                          <Play {...iconProps} />
                        )}
                        {slot.mesh ? "Rebuild mesh" : "Create mesh"}
                      </Button>
                      <Button
                        disabled={!slot.mesh}
                        variant="soft"
                        onClick={() => setFixMeshOpen((open) => !open)}
                      >
                        {fixMeshOpen ? "Hide fix mesh" : "Fix mesh"}
                      </Button>
                    </>
                  ) : null}

                  {activeStep === "symbols" ? (
                    <Text color="gray" size="2">
                      Place points on the canvas above, then Save.
                    </Text>
                  ) : null}

                  {activeStep === "game" ? (
                    <>
                      <Button
                        color="green"
                        disabled={!done || busy}
                        onClick={() => void handleCreateGame(slot.id)}
                      >
                        {publishBusy === slot.id ? (
                          <Loader2 {...iconProps} className="spin" />
                        ) : (
                          <Gamepad2 {...iconProps} />
                        )}
                        Create game
                      </Button>
                      <Button
                        disabled={!done}
                        variant="soft"
                        onClick={() =>
                          window.open(
                            photoScratchSlotPlayHref(cardId, slot.id),
                            "_blank",
                            "noopener,noreferrer",
                          )
                        }
                      >
                        <Play {...iconProps} />
                        Play
                      </Button>
                    </>
                  ) : null}
                </Flex>
              </div>
            </section>
          </div>
        </Flex>
      ) : null}
    </VideoFlowShell>
  );
}
