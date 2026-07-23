import { ExternalLink, Gamepad2, Loader2, Play, Sparkles, Square } from "lucide-react";
import {
  Badge,
  Button,
  Callout,
  Card,
  Flex,
  Heading,
  Text,
  TextField,
} from "@radix-ui/themes";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  parseTrackedMesh,
  randomSymbolPoints,
  sampleTrackedMesh,
  SYMBOL_POINT_COUNT,
} from "../meshGeometry";
import { api } from "../shared/api";
import {
  cutoutPhotoScratchSlot,
  fetchPhotoScratchSlots,
  generatePhotoScratchSlotMesh,
  matchPhotoScratchSlot,
  photoScratchSlotIsDone,
  photoScratchSlotPlayHref,
  publishPhotoScratchGame,
  savePhotoScratchSlotSymbols,
  zoomPhotoScratchSlot,
  type PhotoScratchSlot,
} from "../shared/models";
import { MaskEditor } from "../videoFlow/MaskEditor";
import { PhotoScratchSymbolPicker } from "../videoFlow/PhotoScratchSymbolPicker";
import { iconProps, MediaPreview } from "../videoFlow/ui";
import { VideoFlowShell } from "../videoFlow/VideoFlowShell";

type StepId =
  | "layers"
  | "match"
  | "cutout"
  | "zooming"
  | "mesh"
  | "symbols"
  | "game";

type AutoStepId = "match" | "cutout" | "zooming" | "mesh" | "symbols" | "game" | "done";

type AutoProgress = {
  slotId: string;
  slotLabel: string;
  step: AutoStepId;
  index: number;
  total: number;
  detail: string;
};

const AUTO_STEP_LABEL: Record<AutoStepId, string> = {
  match: "Match",
  cutout: "Cutout",
  zooming: "Zooming",
  mesh: "Mesh",
  symbols: "Symbols",
  game: "Publish",
  done: "Done",
};

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
    id: "zooming",
    label: "Zooming",
    subtitle: "Bikini + top front/back",
    blurb:
      "Scale bikini and top together over the room (background fixed). Larger = closer, smaller = farther — then confirm before Mesh.",
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
    case "zooming":
      return Boolean(slot.has_zoom);
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

async function pollJob(
  jobId: string,
  label: string,
  options?: { shouldStop?: () => boolean },
) {
  for (let i = 0; i < 180; i += 1) {
    if (options?.shouldStop?.()) {
      try {
        await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
          method: "POST",
        });
      } catch {
        // Best-effort cancel — still stop the client loop.
      }
      throw new Error("AUTO_APPROVE_STOPPED");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const next = await api<{ id: string; status: string; logs: string[] }>(
      `/api/jobs/${encodeURIComponent(jobId)}`,
    );
    if (next.status === "succeeded") return;
    if (next.status === "cancelled") {
      throw new Error("AUTO_APPROVE_STOPPED");
    }
    if (next.status === "failed") {
      throw new Error(next.logs?.[next.logs.length - 1] ?? next.status);
    }
  }
  throw new Error(`${label} timed out`);
}

async function autoSaveRandomSymbols(
  cardId: string,
  slotId: string,
  meshUrl: string,
) {
  const meshResponse = await fetch(meshUrl, { cache: "no-store" });
  if (!meshResponse.ok) {
    throw new Error(`Mesh not found (${meshResponse.status})`);
  }
  const meshData = parseTrackedMesh(await meshResponse.json());
  if (!meshData) {
    throw new Error("Invalid mesh JSON");
  }
  const sample = sampleTrackedMesh(meshData, 0);
  const points = randomSymbolPoints(sample, SYMBOL_POINT_COUNT, meshData.garment);
  if (points.length !== SYMBOL_POINT_COUNT) {
    throw new Error(
      `Could only place ${points.length}/${SYMBOL_POINT_COUNT} symbol points`,
    );
  }
  await savePhotoScratchSlotSymbols(cardId, slotId, points);
}

/** Prep screen: Video Flow pipeline boxes + detail screen on the right. */
export function PictureFlowPage() {
  const cardId = useMemo(() => readQuery("card"), []);
  const focusSlot = useMemo(() => readQuery("slot"), []);
  const autoStart = useMemo(() => readQuery("auto") === "1", []);
  const detailRef = useRef<HTMLElement | null>(null);
  const autoStartedRef = useRef(false);
  const autoCancelRef = useRef(false);
  const [slots, setSlots] = useState<PhotoScratchSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cutoutBusy, setCutoutBusy] = useState("");
  const [matchBusy, setMatchBusy] = useState("");
  const [zoomBusy, setZoomBusy] = useState("");
  const [meshBusy, setMeshBusy] = useState("");
  const [publishBusy, setPublishBusy] = useState("");
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoProgress, setAutoProgress] = useState<AutoProgress | null>(null);
  const [autoStatus, setAutoStatus] = useState("");
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [manualStepBySlot, setManualStepBySlot] = useState<Record<string, StepId>>(
    {},
  );
  const [fixMeshOpen, setFixMeshOpen] = useState(false);
  const [zoomScale, setZoomScale] = useState("1");
  const [zoomTx, setZoomTx] = useState("0");
  const [zoomTy, setZoomTy] = useState("0");

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

  // Always use every layer-ready teacher — ?slot= only picks the initial tab.
  const readySlots = slots.filter(layersComplete);

  useEffect(() => {
    if (readySlots.length === 0) {
      setSelectedSlotId("");
      return;
    }
    if (selectedSlotId && readySlots.some((s) => s.id === selectedSlotId)) {
      return;
    }
    if (focusSlot && readySlots.some((s) => s.id === focusSlot)) {
      setSelectedSlotId(focusSlot);
      return;
    }
    setSelectedSlotId(readySlots[0]!.id);
  }, [focusSlot, readySlots, selectedSlotId]);

  const slot = readySlots.find((s) => s.id === selectedSlotId) ?? null;
  const busy = Boolean(
    cutoutBusy || matchBusy || zoomBusy || meshBusy || publishBusy || autoBusy,
  );

  useEffect(() => {
    if (!slot?.has_cutout) return;
    setZoomScale(slot.zoom_scale != null ? String(slot.zoom_scale) : "1");
    setZoomTx(slot.zoom_tx != null ? String(slot.zoom_tx) : "0");
    setZoomTy(slot.zoom_ty != null ? String(slot.zoom_ty) : "0");
  }, [
    slot?.id,
    slot?.has_cutout,
    slot?.zoom_scale,
    slot?.zoom_tx,
    slot?.zoom_ty,
  ]);

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

  function parseZoom() {
    const scale = Number(zoomScale);
    const tx = Number(zoomTx);
    const ty = Number(zoomTy);
    if (!Number.isFinite(scale) || scale <= 0.1 || scale > 3) {
      throw new Error("Scale must be between 0.1 and 3");
    }
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
      throw new Error("tx / ty must be numbers");
    }
    return { scale, tx, ty };
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

  async function handleZoomApply(slotId: string) {
    if (!cardId || busy) return;
    setZoomBusy(slotId);
    setError("");
    try {
      const { scale, tx, ty } = parseZoom();
      await zoomPhotoScratchSlot(cardId, slotId, "", {
        scale,
        tx,
        ty,
        apply: true,
        confirm: true,
      });
      clearManualStep(slotId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setZoomBusy("");
    }
  }

  async function handleZoomConfirm(slotId: string) {
    if (!cardId || busy) return;
    setZoomBusy(slotId);
    setError("");
    try {
      // Bake current form values so Mesh is built at the same scale as the preview.
      const { scale, tx, ty } = parseZoom();
      await zoomPhotoScratchSlot(cardId, slotId, "", {
        scale,
        tx,
        ty,
        apply: true,
        confirm: true,
      });
      clearManualStep(slotId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setZoomBusy("");
    }
  }

  async function handleMesh(slotId: string) {
    if (!cardId || busy) return;
    setMeshBusy(slotId);
    setError("");
    try {
      const job = await generatePhotoScratchSlotMesh(cardId, slotId);
      await pollJob(job.id, "Mesh generation");
      // Stay on Mesh and open the mask editor — don't auto-advance to Symbols.
      setManualStepBySlot((prev) => ({ ...prev, [slotId]: "mesh" }));
      setFixMeshOpen(true);
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

  async function handleAutoApprove() {
    if (!cardId || busy) return;
    autoCancelRef.current = false;
    setAutoBusy(true);
    setAutoStatus("");
    setAutoProgress(null);
    setError("");
    setFixMeshOpen(false);

    const throwIfStopped = () => {
      if (autoCancelRef.current) {
        throw new Error("AUTO_APPROVE_STOPPED");
      }
    };

    const waitJob = (jobId: string, label: string) =>
      pollJob(jobId, label, { shouldStop: () => autoCancelRef.current });

    try {
      let current = await fetchPhotoScratchSlots(cardId);
      setSlots(current);
      throwIfStopped();

      // Always every layer-ready teacher — never only the focused ?slot=.
      const candidates = current.filter(layersComplete);
      const pending = candidates.filter((s) => !photoScratchSlotIsDone(s));
      if (pending.length === 0) {
        setAutoProgress({
          slotId: "",
          slotLabel: "All teachers",
          step: "game",
          index: candidates.length,
          total: candidates.length,
          detail: "Publishing finished games…",
        });
        throwIfStopped();
        await publishPhotoScratchGame(cardId);
        setAutoProgress({
          slotId: "",
          slotLabel: "All teachers",
          step: "done",
          index: candidates.length,
          total: candidates.length,
          detail: `Published ${candidates.length} teacher(s).`,
        });
        setAutoStatus(`Published ${candidates.length} teacher(s).`);
        await refresh();
        return;
      }

      let published = 0;
      for (let index = 0; index < pending.length; index += 1) {
        throwIfStopped();
        const target = pending[index]!;
        const progressNum = index + 1;
        setSelectedSlotId(target.id);
        setFixMeshOpen(false);
        let entry =
          current.find((s) => s.id === target.id) ?? target;

        const setRunning = (step: AutoStepId, detail: string) => {
          setAutoProgress({
            slotId: entry.id,
            slotLabel: entry.label,
            step,
            index: progressNum,
            total: pending.length,
            detail,
          });
          if (step !== "game" && step !== "done") {
            setManualStepBySlot((prev) => ({ ...prev, [entry.id]: step }));
          }
        };

        const reloadSlot = async () => {
          current = await fetchPhotoScratchSlots(cardId);
          setSlots(current);
          const next = current.find((s) => s.id === target.id);
          if (!next) {
            throw new Error(`${target.label} disappeared after a step`);
          }
          entry = next;
        };

        // Always press Register / Re-register layers (same as the red Match button).
        throwIfStopped();
        setRunning("match", "Re-registering bikini + top layers…");
        {
          const job = await matchPhotoScratchSlot(cardId, entry.id);
          await waitJob(job.id, "Register layers");
          await reloadSlot();
        }

        if (!entry.has_cutout) {
          throwIfStopped();
          setRunning("cutout", "Cutting girl out of the scene…");
          const job = await cutoutPhotoScratchSlot(cardId, entry.id);
          await waitJob(job.id, "Cut out girl");
          await reloadSlot();
        }

        if (!entry.has_zoom) {
          throwIfStopped();
          setRunning("zooming", "Confirming zoom framing…");
          await zoomPhotoScratchSlot(cardId, entry.id, "", {
            scale: entry.zoom_scale ?? 1,
            tx: entry.zoom_tx ?? 0,
            ty: entry.zoom_ty ?? 0,
            apply: true,
            confirm: true,
          });
          await reloadSlot();
        }

        if (!entry.mesh) {
          throwIfStopped();
          setRunning("mesh", "Building scratch mesh…");
          const job = await generatePhotoScratchSlotMesh(cardId, entry.id);
          await waitJob(job.id, "Mesh generation");
          await reloadSlot();
        }

        if (!entry.has_symbols) {
          throwIfStopped();
          setRunning("symbols", "Placing 12 random symbol anchors…");
          const meshUrl =
            entry.mesh ||
            `/cards/${encodeURIComponent(cardId)}/photo-scratch/${encodeURIComponent(entry.id)}/mesh.json`;
          await autoSaveRandomSymbols(cardId, entry.id, meshUrl);
          await reloadSlot();
        }

        throwIfStopped();
        setRunning("game", "Publishing playable game…");
        await publishPhotoScratchGame(cardId, entry.id);
        published += 1;
        clearManualStep(entry.id);
      }

      setAutoProgress({
        slotId: "",
        slotLabel: "All teachers",
        step: "done",
        index: published,
        total: pending.length,
        detail: `Auto-approved and published ${published} teacher(s).`,
      });
      setAutoStatus(`Done — auto-approved and published ${published} teacher(s).`);
      await refresh();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message === "AUTO_APPROVE_STOPPED") {
        setError("");
        setAutoStatus("Stopped — finished teachers stay done; resume anytime.");
        setAutoProgress((prev) =>
          prev
            ? {
                ...prev,
                step: "done",
                detail: `Stopped at ${prev.slotLabel} · ${AUTO_STEP_LABEL[prev.step]}. Resume with Auto-approve all.`,
              }
            : {
                slotId: "",
                slotLabel: "Stopped",
                step: "done",
                index: 0,
                total: 0,
                detail: "Stopped. Resume with Auto-approve all.",
              },
        );
        await refresh();
      } else {
        setError(message);
        setAutoStatus("");
        setAutoProgress(null);
      }
    } finally {
      autoCancelRef.current = false;
      setAutoBusy(false);
    }
  }

  function handleStopAutoApprove() {
    if (!autoBusy) return;
    autoCancelRef.current = true;
    setAutoProgress((prev) =>
      prev
        ? { ...prev, detail: `Stopping after current job… (${prev.detail})` }
        : prev,
    );
  }

  // Video Flow "Auto-approve all" lands here with ?auto=1 — start once slots load.
  useEffect(() => {
    if (!autoStart || autoStartedRef.current || loading || !cardId) return;
    if (readySlots.length === 0) return;
    autoStartedRef.current = true;
    const url = new URL(window.location.href);
    if (url.searchParams.has("auto")) {
      url.searchParams.delete("auto");
      window.history.replaceState({}, "", `${url.pathname}${url.search}`);
    }
    void handleAutoApprove();
  }, [autoStart, loading, cardId, readySlots.length]);

  return (
    <VideoFlowShell
      active="picture"
      error={error}
      subtitle={
        cardId
          ? `Card ${cardId} — layers → match → cutout → zooming → mesh → symbols → game.`
          : "Open from Video Flow after uploading 3 layers on a photo card."
      }
      title="Photo scratch game"
      onRefresh={() => void refresh()}
    >
      {!cardId ? (
        <Text color="gray">Missing ?card= in the URL.</Text>
      ) : loading ? (
        <Text color="gray">Loading photo cards…</Text>
      ) : readySlots.length === 0 ? (
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
          <Flex align="center" gap="3" wrap="wrap" justify="between">
            <Flex align="center" gap="2" wrap="wrap">
              <Button
                color="green"
                disabled={busy || readySlots.length === 0}
                onClick={() => void handleAutoApprove()}
                title="Run match → cutout → zoom → mesh → random symbols → publish for every incomplete teacher — no need to open each tab"
              >
                {autoBusy ? (
                  <Loader2 {...iconProps} className="spin" />
                ) : (
                  <Sparkles {...iconProps} />
                )}
                {autoBusy
                  ? "Auto-approving…"
                  : `Auto-approve all (${readySlots.filter((s) => !photoScratchSlotIsDone(s)).length || readySlots.length})`}
              </Button>
              {autoBusy ? (
                <Button
                  color="red"
                  variant="solid"
                  onClick={handleStopAutoApprove}
                  title="Stop after the current job finishes cancelling"
                >
                  <Square {...iconProps} />
                  Stop
                </Button>
              ) : null}
            </Flex>
            {!autoBusy && !autoProgress ? (
              <Text color="gray" size="2">
                One click for every teacher — match → cutout → zoom → mesh → symbols → publish.
              </Text>
            ) : null}
          </Flex>

          {autoProgress ? (
            <Callout.Root
              color={
                autoProgress.step === "done"
                  ? autoStatus.startsWith("Stopped")
                    ? "amber"
                    : "green"
                  : "blue"
              }
              size="2"
            >
              <Callout.Text>
                <Flex align="center" gap="3" wrap="wrap">
                  {autoBusy ? <Loader2 {...iconProps} className="spin" /> : null}
                  <Text weight="bold">
                    {autoProgress.step === "done"
                      ? autoStatus.startsWith("Stopped")
                        ? "Stopped"
                        : "Finished"
                      : `Running ${autoProgress.index}/${autoProgress.total}`}
                  </Text>
                  <Badge color="red" size="2" variant="solid">
                    {autoProgress.slotLabel}
                  </Badge>
                  {autoProgress.step !== "done" ? (
                    <Badge color="blue" size="2" variant="soft">
                      Step: {AUTO_STEP_LABEL[autoProgress.step]}
                    </Badge>
                  ) : null}
                  <Text size="2">{autoProgress.detail}</Text>
                  {autoStatus && autoProgress.step === "done" ? (
                    <Text size="2">{autoStatus}</Text>
                  ) : null}
                  {autoBusy ? (
                    <Button color="red" size="1" variant="soft" onClick={handleStopAutoApprove}>
                      <Square {...iconProps} />
                      Stop
                    </Button>
                  ) : null}
                </Flex>
              </Callout.Text>
            </Callout.Root>
          ) : null}

          {readySlots.length > 1 ? (
            <Flex gap="2" wrap="wrap">
              {readySlots.map((entry) => {
                const isRunning =
                  autoBusy && autoProgress?.slotId === entry.id;
                const isDone = photoScratchSlotIsDone(entry);
                const isSelected = entry.id === slot.id;
                return (
                  <Button
                    key={entry.id}
                    size="1"
                    color={isRunning ? "blue" : undefined}
                    variant={isRunning || isSelected ? "solid" : "soft"}
                    disabled={autoBusy && !isRunning}
                    onClick={() => {
                      if (autoBusy) return;
                      setSelectedSlotId(entry.id);
                      setFixMeshOpen(false);
                    }}
                  >
                    {isRunning ? (
                      <Loader2 {...iconProps} className="spin" />
                    ) : null}
                    {entry.label}
                    {isRunning ? (
                      <Badge color="blue" ml="2" size="1" variant="solid">
                        {AUTO_STEP_LABEL[autoProgress.step]}…
                      </Badge>
                    ) : isDone ? (
                      <Badge color="green" ml="2" size="1">
                        Done
                      </Badge>
                    ) : autoBusy ? (
                      <Badge color="gray" ml="2" size="1">
                        Waiting
                      </Badge>
                    ) : null}
                  </Button>
                );
              })}
            </Flex>
          ) : null}

          <div className="video-flow-run-layout picture-flow-run-layout">
            <aside className="video-flow-run-steps">
              <Text size="2" weight="bold" mb="3">
                Pipeline
              </Text>
              <Text color="gray" size="1" mb="2">
                {slot.label}
                {autoBusy && autoProgress?.slotId === slot.id
                  ? ` — running ${AUTO_STEP_LABEL[autoProgress.step]}`
                  : ""}
              </Text>
              {STEPS.map((step, index) => {
                const status = stepStatus(slot, step.id);
                const badge = stepBadge(status);
                const locked = status === "locked";
                const isAutoRunning =
                  autoBusy &&
                  autoProgress?.slotId === slot.id &&
                  autoProgress.step === step.id;
                return (
                  <button
                    key={step.id}
                    type="button"
                    className={[
                      "video-flow-run-step",
                      `is-${status}`,
                      activeStep === step.id || isAutoRunning ? "is-active" : "",
                      locked ? "is-disabled" : "",
                      isAutoRunning ? "is-auto-running" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    disabled={locked || autoBusy}
                    onClick={() => selectStep(step.id)}
                  >
                    <span className="video-flow-run-step-num">{index + 1}</span>
                    <span className="video-flow-run-step-body">
                      <strong>{step.label}</strong>
                      <span>{step.subtitle}</span>
                    </span>
                    {isAutoRunning ? (
                      <Badge color="blue" size="1">
                        Running
                      </Badge>
                    ) : (
                      <Badge color={badge.color} size="1">
                        {badge.label}
                      </Badge>
                    )}
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
                          label="Top (matched) — use this"
                          size="compact"
                          type="image"
                          value={slot.clothes_matched}
                          zoomable
                        />
                      ) : null}
                      {slot.match_overlay ? (
                        <MediaPreview
                          label="Difference (QA)"
                          size="compact"
                          type="image"
                          value={slot.match_overlay}
                          zoomable
                        />
                      ) : null}
                      {slot.match_blend ? (
                        <MediaPreview
                          label="Ghost check (50/50) — not the game layer"
                          size="compact"
                          type="image"
                          value={slot.match_blend}
                          zoomable
                        />
                      ) : null}
                    </Flex>
                    {slot.has_match && slot.match_pose_ok === false ? (
                      <Callout.Root color="orange">
                        <Callout.Text>
                          Arms/stance look different between bikini and top. Re-generate the
                          Top from the bikini (pose-lock prompt), or use{" "}
                          <strong>AI re-dress</strong> below as a last resort. Ignore the
                          Ghost check — it always looks double-exposed on purpose.
                        </Callout.Text>
                      </Callout.Root>
                    ) : null}
                    {slot.has_match && slot.match_pose_ok ? (
                      <Callout.Root color="green">
                        <Callout.Text>
                          Judge <strong>Top (matched)</strong> only — that is the game
                          layer. Ghost check is a deliberate 50/50 of bikini + top (double
                          face/body is expected). Difference highlights pixel mismatch.
                          Proceed to Cutout.
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
                    {slot.has_match ? (
                      <Callout.Root color="blue">
                        <Callout.Text>
                          Next: <strong>Cutout</strong> when the matched top looks
                          aligned.
                        </Callout.Text>
                      </Callout.Root>
                    ) : null}
                  </Flex>
                ) : null}

                {activeStep === "cutout" ? (
                  <Flex direction="column" gap="4">
                    <Callout.Root color="blue">
                      <Callout.Text>
                        {slot.has_cutout
                          ? "If pink/beige wall remains between the arms (or thighs): Mesh → Erase, paint only that bay, then clear it — “remove the pink/beige wall background between the arms”. If the hole looks rough, tidy the rim — clean edges, no artifacts."
                          : "Run Cut out girl for RGBA cutouts (bikini + top). Arm gaps are punched when the pink/beige wall is clear. Leftovers: Mesh → Erase — paint a selection between the arms, then clear (“remove the pink/beige wall background between the arms”). Rough hole → clean edges, no artifacts."}
                      </Callout.Text>
                    </Callout.Root>
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
                    ) : null}
                  </Flex>
                ) : null}

                {activeStep === "zooming" ? (
                  <Flex direction="column" gap="4">
                    <Callout.Root color="blue">
                      <Callout.Text>
                        Bikini + top zoom together as one unit over the room
                        (background stays put). Larger = closer/front, smaller =
                        farther/back. Apply bakes both cutouts; Looks good unlocks
                        Mesh without changing pixels.
                      </Callout.Text>
                    </Callout.Root>
                    {slot.has_cutout ? (
                      <Flex gap="2" wrap="wrap" align="start">
                        {slot.background ? (
                          <div className="picture-flow-zoom-composite">
                            <Text size="1" weight="medium" mb="1">
                              In room (bikini + top together)
                            </Text>
                            <div className="picture-flow-zoom-stage">
                              <img
                                alt=""
                                className="picture-flow-zoom-bg"
                                src={slot.background}
                              />
                              <div
                                className="picture-flow-zoom-girl-stack"
                                style={{
                                  transform: `translate(${((Number(zoomTx) || 0) * 140) / 1170}px, ${((Number(zoomTy) || 0) * 240) / 2016}px) scale(${Number(zoomScale) || 1})`,
                                }}
                              >
                                {slot.bikini_cutout_src || slot.bikini_cutout ? (
                                  <img
                                    alt=""
                                    className="picture-flow-zoom-girl picture-flow-zoom-girl--bikini"
                                    src={
                                      slot.bikini_cutout_src ||
                                      slot.bikini_cutout ||
                                      ""
                                    }
                                  />
                                ) : null}
                                {slot.clothes_cutout_src || slot.clothes_cutout ? (
                                  <img
                                    alt=""
                                    className="picture-flow-zoom-girl picture-flow-zoom-girl--top"
                                    src={
                                      slot.clothes_cutout_src ||
                                      slot.clothes_cutout ||
                                      ""
                                    }
                                  />
                                ) : null}
                              </div>
                            </div>
                          </div>
                        ) : null}
                        {slot.bikini_cutout ? (
                          <MediaPreview
                            label="Bikini (baked)"
                            size="compact"
                            type="image"
                            value={slot.bikini_cutout}
                            cacheBust={slot.zoom_scale ?? "0"}
                            zoomable
                          />
                        ) : null}
                        {slot.clothes_cutout ? (
                          <MediaPreview
                            label="Top (baked)"
                            size="compact"
                            type="image"
                            value={slot.clothes_cutout}
                            cacheBust={slot.zoom_scale ?? "0"}
                            zoomable
                          />
                        ) : null}
                      </Flex>
                    ) : null}
                    <Flex gap="3" wrap="wrap">
                      <Flex direction="column" gap="1" style={{ minWidth: 120 }}>
                        <Text size="1" weight="medium">
                          Scale
                        </Text>
                        <TextField.Root
                          type="number"
                          step="0.01"
                          min="0.1"
                          max="3"
                          value={zoomScale}
                          onChange={(e) => setZoomScale(e.target.value)}
                        />
                        <Text color="gray" size="1">
                          &gt;1 closer · &lt;1 farther
                        </Text>
                      </Flex>
                      <Flex direction="column" gap="1" style={{ minWidth: 120 }}>
                        <Text size="1" weight="medium">
                          tx (px)
                        </Text>
                        <TextField.Root
                          type="number"
                          step="1"
                          value={zoomTx}
                          onChange={(e) => setZoomTx(e.target.value)}
                        />
                        <Text color="gray" size="1">
                          +right / −left
                        </Text>
                      </Flex>
                      <Flex direction="column" gap="1" style={{ minWidth: 120 }}>
                        <Text size="1" weight="medium">
                          ty (px)
                        </Text>
                        <TextField.Root
                          type="number"
                          step="1"
                          value={zoomTy}
                          onChange={(e) => setZoomTy(e.target.value)}
                        />
                        <Text color="gray" size="1">
                          +down / −up
                        </Text>
                      </Flex>
                    </Flex>
                    {slot.has_zoom ? (
                      <Callout.Root color="green">
                        <Callout.Text>
                          Zooming confirmed
                          {slot.zoom_scale != null
                            ? ` (scale ${slot.zoom_scale})`
                            : ""}
                          . Both girl layers share this framing. Proceed to Mesh.
                        </Callout.Text>
                      </Callout.Root>
                    ) : null}
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
                              Create mesh builds a static UV lattice from the
                              zoomed top cutout so scratch scale matches Zooming.
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
                          : "Finish cutout, zooming, mesh, and symbols before creating the game."}
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
                      title={
                        slot.has_match
                          ? undefined
                          : "Finish Match first (Register layers)"
                      }
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

                  {activeStep === "zooming" ? (
                    <Flex direction="column" gap="3" style={{ width: "100%" }}>
                      <Flex gap="2" wrap="wrap">
                        <Button
                          color="red"
                          disabled={busy || !slot.has_cutout}
                          onClick={() => void handleZoomApply(slot.id)}
                        >
                          {zoomBusy === slot.id ? (
                            <Loader2 {...iconProps} className="spin" />
                          ) : (
                            <Play {...iconProps} />
                          )}
                          Apply scale
                        </Button>
                        <Button
                          variant="soft"
                          disabled={busy || !slot.has_cutout}
                          onClick={() => void handleZoomConfirm(slot.id)}
                        >
                          Looks good
                        </Button>
                      </Flex>
                      <Text color="gray" size="1">
                        Apply scale / Looks good both bake bikini + top at the
                        current scale (so Mesh uses the same framing), then unlock
                        Mesh.
                      </Text>
                    </Flex>
                  ) : null}

                  {activeStep === "mesh" ? (
                    <>
                      <Button
                        color="red"
                        disabled={busy || !slot.has_zoom}
                        title={
                          slot.has_zoom
                            ? undefined
                            : "Finish Zooming first (Apply scale or Looks good)"
                        }
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
