import { Check, Play, RotateCcw } from "lucide-react";
import { Button, Callout, Flex, Select, Text, TextField } from "@radix-ui/themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parseTrackedMesh,
  randomSymbolPoints,
  sampleTrackedMesh,
  SYMBOL_POINT_COUNT,
} from "../../meshGeometry";
import { api } from "../../shared/api";
import { fetchModels, createMotionCardDraft, type ModelInfo } from "../../shared/models";
import { fetchThemes, type ThemeInfo } from "../../shared/themes";
import { PROJECT_ID_PATTERN, slugifyProjectId } from "../projects";
import type { VideoFlowStepKey } from "../schema";
import { MaskEditor } from "../MaskEditor";
import { SymbolPointPicker } from "../SymbolPointPicker";
import { FilePathPicker, iconProps, MediaPreview } from "../ui";
import { VideoFlowShell } from "../VideoFlowShell";
import { liteRequestBody, type LiteDraftInput } from "./defaults";
import { LiteCanvas, type LiteNodeStatus } from "./LiteCanvas";

type JobInfo = {
  id: string;
  kind: string;
  command: string[];
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  logs: string[];
};

type LiteStepState = {
  status: "locked" | "ready" | "review" | "approved";
  label: string;
  artifacts: string[];
};

type LiteFlowState = {
  card_id: string;
  approved: string[];
  steps: Partial<Record<VideoFlowStepKey, LiteStepState>>;
  complete: boolean;
  picture_choice?: number | null;
};

type HealthResponse = {
  xai_key_loaded?: boolean;
  wavespeed_key_loaded?: boolean;
};

type SavedDraft = {
  image?: string;
  bikini_image?: string;
  face_image?: string;
  theme?: string;
  dress_reference_image?: string;
  card_label?: string;
  model_id?: string;
};

const AUTO_STEPS = [
  "background",
  "dress",
  "boomerang",
  "card",
  "mesh",
  "symbols",
  "compress",
] as const;

/** Survives a strict-mode remount so a step is queued once. */
const liteHeld = new Set<string>();

function errorText(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught);
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    /* response was plain text */
  }
  return raw;
}

function pictureChoiceFromArtifact(path: string): number | null {
  const name = path.split("?")[0].split("/").pop() ?? "";
  const match = /^picture-([123])\.png$/i.exec(name);
  return match ? Number(match[1]) : null;
}

function readyPaths(paths: string[] | undefined): string[] {
  return (paths ?? []).filter((path) => path.trim());
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function loadPublishedMesh(cardId: string) {
  const url = `/mesh/${encodeURIComponent(cardId)}.json`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, { cache: "no-store" });
    if (response.ok) {
      const mesh = parseTrackedMesh(await response.json());
      if (mesh) return mesh;
    }
    await sleep(1000);
  }
  throw new Error("The card could not be finished.");
}

export function LiteFlowPage() {
  const bootCard = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("card")?.trim() ?? "";
  }, []);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [themes, setThemes] = useState<ThemeInfo[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [modelId, setModelId] = useState("");
  const [cardLabel, setCardLabel] = useState("");
  const [cardId, setCardId] = useState("");
  const [image, setImage] = useState("");
  const [bikini, setBikini] = useState("");
  const [face, setFace] = useState("");
  const [theme, setTheme] = useState("");
  const [costume, setCostume] = useState("");
  const [flowState, setFlowState] = useState<LiteFlowState | null>(null);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [error, setError] = useState("");
  const [missingCard, setMissingCard] = useState(false);
  const [pendingStep, setPendingStep] = useState<string | null>(null);
  const [catalogReady, setCatalogReady] = useState(false);

  const epochRef = useRef(0);
  const fieldsRef = useRef<LiteDraftInput>({
    cardId: "",
    cardLabel: "",
    modelId: "",
    image: "",
    bikini: "",
    face: "",
    theme: "",
    costume: "",
    hasXai: false,
    hasWavespeed: false,
  });

  fieldsRef.current = {
    cardId,
    cardLabel,
    modelId,
    image,
    bikini,
    face,
    theme,
    costume,
    hasXai: Boolean(health?.xai_key_loaded),
    hasWavespeed: Boolean(health?.wavespeed_key_loaded),
  };

  const commitState = useCallback((next: LiteFlowState) => {
    epochRef.current += 1;
    setFlowState(next);
  }, []);

  const refresh = useCallback(async () => {
    const id = fieldsRef.current.cardId.trim();
    if (!id) return;
    const ticket = epochRef.current;
    const [state, jobData] = await Promise.all([
      api<LiteFlowState>(`/api/video-flow/${encodeURIComponent(id)}/state`),
      api<{ jobs: JobInfo[] }>("/api/jobs"),
    ]);
    if (ticket !== epochRef.current) return;
    if (fieldsRef.current.cardId.trim() !== id) return;
    setFlowState(state);
    setJobs(jobData.jobs);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [modelList, themeList, healthBody] = await Promise.all([
          fetchModels(),
          fetchThemes(),
          api<HealthResponse>("/api/health"),
        ]);
        if (cancelled) return;
        setModels(modelList);
        setThemes(themeList);
        setHealth(healthBody);
        if (!bootCard) return;
        try {
          const data = await api<{ draft: SavedDraft }>(
            `/api/video-flow/${encodeURIComponent(bootCard)}/draft`,
          );
          if (cancelled) return;
          const draft = data.draft;
          setCardId(bootCard);
          setCardLabel(draft.card_label?.trim() || bootCard);
          setModelId(draft.model_id?.trim() || "");
          setImage(draft.image?.trim() || "");
          setBikini(draft.bikini_image?.trim() || "");
          setFace(draft.face_image?.trim() || "");
          setTheme(draft.theme?.trim() || "");
          setCostume(draft.dress_reference_image?.trim() || "");
        } catch {
          if (!cancelled) setMissingCard(true);
        }
      } catch (caught) {
        if (!cancelled) setError(errorText(caught));
      } finally {
        if (!cancelled) setCatalogReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootCard]);

  useEffect(() => {
    if (!cardId) return;
    let cancelled = false;
    const tick = () => {
      void refresh().catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(() => {
      if (!cancelled) tick();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [cardId, refresh]);

  const cardJobs = useMemo(
    () =>
      jobs.filter(
        (job) => job.kind === "video-flow-step" && job.command[2] === cardId,
      ),
    [jobs, cardId],
  );

  const runningJob = cardJobs.find(
    (job) => job.status === "queued" || job.status === "running",
  );
  const latestJob = cardJobs[0];
  const latestFailed = latestJob?.status === "failed";

  useEffect(() => {
    if (!pendingStep) return;
    const job = cardJobs.find((entry) => entry.command[1] === pendingStep);
    const status = flowState?.steps[pendingStep as VideoFlowStepKey]?.status;
    if (job?.status === "queued" || job?.status === "running") return;
    if (
      job?.status === "failed" ||
      job?.status === "succeeded" ||
      job?.status === "cancelled" ||
      status === "review" ||
      status === "approved"
    ) {
      setPendingStep(null);
    }
  }, [cardJobs, flowState, pendingStep]);

  const saveDraft = useCallback(async (id: string) => {
    const fields = fieldsRef.current;
    await api(`/api/video-flow/${encodeURIComponent(id)}/draft`, {
      method: "POST",
      body: JSON.stringify(
        liteRequestBody({
          ...fields,
          cardId: id,
        }),
      ),
    });
  }, []);

  const enqueue = useCallback(
    async (step: VideoFlowStepKey, force: boolean) => {
      const id = fieldsRef.current.cardId.trim();
      if (!id) return;
      setPendingStep(step);
      setError("");
      await saveDraft(id);
      await api("/api/jobs/video-flow/step", {
        method: "POST",
        body: JSON.stringify({
          ...liteRequestBody({ ...fieldsRef.current, cardId: id }),
          step,
          force,
        }),
      });
      await refresh().catch(() => undefined);
    },
    [refresh, saveDraft],
  );

  const placeSymbols = useCallback(async () => {
    const id = fieldsRef.current.cardId.trim();
    setPendingStep("symbols");
    setError("");
    const mesh = await loadPublishedMesh(id);
    const points = randomSymbolPoints(
      sampleTrackedMesh(mesh, 0),
      SYMBOL_POINT_COUNT,
      mesh.garment,
    );
    if (points.length !== SYMBOL_POINT_COUNT) {
      throw new Error("The card could not be finished.");
    }
    const data = await api<LiteFlowState>(
      `/api/video-flow/${encodeURIComponent(id)}/symbol-points`,
      {
        method: "POST",
        body: JSON.stringify({ points }),
      },
    );
    commitState(data);
  }, [commitState]);

  useEffect(() => {
    if (!cardId || !flowState || pendingStep || runningJob) return;
    const picture = flowState.steps.picture?.status;
    const background = flowState.steps.background?.status;
    const dress = flowState.steps.dress?.status;
    let step: (typeof AUTO_STEPS)[number] | null = null;
    if (picture === "approved" && background === "ready") step = "background";
    else if (background === "approved" && dress === "ready" && fieldsRef.current.costume.trim()) step = "dress";
    else if (dress === "approved" && !flowState.complete) {
      if (flowState.steps.boomerang?.status !== "approved") step = "boomerang";
      else if (flowState.steps.card?.status !== "approved") step = "card";
      else if (flowState.steps.mesh?.status !== "approved") step = "mesh";
      else if (flowState.steps.symbols?.status !== "approved") step = "symbols";
      else if (flowState.steps.compress?.status !== "approved") step = "compress";
    }
    if (!step) return;
    const token = `${cardId}:${step}`;
    if (liteHeld.has(token)) return;
    liteHeld.add(token);
    void (async () => {
      try {
        if (step === "symbols") await placeSymbols();
        else await enqueue(step, false);
      } catch (caught) {
        setPendingStep(null);
        setError("Something went wrong.");
        console.error(errorText(caught));
      }
    })();
  }, [cardId, costume, enqueue, flowState, pendingStep, placeSymbols, runningJob]);

  async function startPictures() {
    const girl = modelId.trim();
    const name = cardLabel.trim();
    if (!girl) {
      setError("Choose a girl.");
      return;
    }
    if (!name) {
      setError("Type a name.");
      return;
    }
    if (!image.trim()) {
      setError("Add her photo.");
      return;
    }
    if (!bikini.trim()) {
      setError("Add the bikini photo.");
      return;
    }
    if (!face.trim()) {
      setError("Add her face photo.");
      return;
    }
    if (!theme.trim()) {
      setError("Choose a theme.");
      return;
    }
    const id = slugifyProjectId(name).slice(0, 64).replace(/_+$/g, "");
    if (!PROJECT_ID_PATTERN.test(id)) {
      setError("Use a name with letters.");
      return;
    }
    setError("");
    try {
      let nextId = cardId.trim();
      if (!nextId) {
        let taken = false;
        try {
          await api(`/api/video-flow/${encodeURIComponent(id)}/draft`);
          taken = true;
        } catch {
          taken = false;
        }
        if (taken) {
          setError("That name is already used. Open that card or pick another name.");
          return;
        }
        await createMotionCardDraft(id, name, girl);
        nextId = id;
        setCardId(id);
        fieldsRef.current = { ...fieldsRef.current, cardId: id, cardLabel: name, modelId: girl };
        window.history.replaceState(
          null,
          "",
          `/dashboard/video-flow/lite?card=${encodeURIComponent(id)}`,
        );
      }
      liteHeld.delete(`${nextId}:picture`);
      await enqueue("picture", false);
    } catch (caught) {
      setPendingStep(null);
      setError(errorText(caught));
    }
  }

  async function approve(step: VideoFlowStepKey, pictureChoice?: number) {
    const id = cardId.trim();
    if (!id) return;
    setError("");
    try {
      const data = await api<LiteFlowState>(
        `/api/video-flow/${encodeURIComponent(id)}/approve`,
        {
          method: "POST",
          body: JSON.stringify({
            step,
            ...(pictureChoice ? { picture_choice: pictureChoice } : {}),
          }),
        },
      );
      commitState(data);
    } catch (caught) {
      setError("Something went wrong.");
      console.error(errorText(caught));
    }
  }

  async function retry(step: VideoFlowStepKey) {
    const id = cardId.trim();
    if (!id) return;
    if (step === "dress" && !costume.trim()) {
      setError("Add the costume photo.");
      return;
    }
    for (const name of ["picture", ...AUTO_STEPS]) liteHeld.delete(`${id}:${name}`);
    try {
      await enqueue(step, true);
    } catch (caught) {
      setPendingStep(null);
      setError("Something went wrong.");
      console.error(errorText(caught));
    }
  }

  function stepStatus(step: VideoFlowStepKey): LiteStepState["status"] | "missing" {
    return flowState?.steps[step]?.status ?? "missing";
  }

  function nodeStatus(
    step: VideoFlowStepKey,
    locked: boolean,
  ): LiteNodeStatus {
    if (pendingStep === step || runningJob?.command[1] === step) return "running";
    const status = stepStatus(step);
    if (status === "approved") return "approved";
    if (status === "review") return "review";
    if (latestFailed && latestJob?.command[1] === step && status === "ready") return "failed";
    if (locked || status === "locked" || status === "missing") return "locked";
    return "ready";
  }

  const pictureStatus = stepStatus("picture");
  const backgroundStatus = stepStatus("background");
  const dressStatus = stepStatus("dress");
  const pictureRunning = nodeStatus("picture", false) === "running";
  const backgroundRunning = nodeStatus("background", pictureStatus !== "approved") === "running";
  const dressRunning = nodeStatus("dress", backgroundStatus !== "approved") === "running";

  const pictureArtifacts = readyPaths(flowState?.steps.picture?.artifacts).filter(
    (path) => pictureChoiceFromArtifact(path) != null,
  );
  const movingClip = readyPaths(flowState?.steps.background?.artifacts)[0] ?? "";
  const outfitClip = readyPaths(flowState?.steps.dress?.artifacts)[0] ?? "";
  const cardClip =
    readyPaths(flowState?.steps.compress?.artifacts).find((path) =>
      /foreground/i.test(path),
    ) ||
    readyPaths(flowState?.steps.card?.artifacts).find((path) => /foreground/i.test(path)) ||
    outfitClip;

  const runBusy = Boolean(pendingStep || runningJob);
  const keysMissing = health && !health.xai_key_loaded;
  const runHref = cardId
    ? `/dashboard/video-flow/run?card=${encodeURIComponent(cardId)}`
    : "/dashboard/video-flow/run";

  const photoStatus: LiteNodeStatus = pictureRunning
    ? "running"
    : pictureStatus === "approved" || pictureStatus === "review"
      ? "approved"
      : "ready";

  const picturesNodeStatus: LiteNodeStatus = pictureRunning
    ? "running"
    : pictureStatus === "review"
      ? "review"
      : pictureStatus === "approved"
        ? "approved"
        : latestFailed && latestJob?.command[1] === "picture"
          ? "failed"
          : "locked";

  const movingNodeStatus = nodeStatus("background", pictureStatus !== "approved");
  const outfitNodeStatus = nodeStatus("dress", backgroundStatus !== "approved");
  const meshStatus = stepStatus("mesh");
  const symbolsStatus = stepStatus("symbols");
  const meshNodeStatus: LiteNodeStatus =
    nodeStatus("mesh", dressStatus !== "approved") === "running" ||
    (dressStatus === "approved" &&
      meshStatus !== "approved" &&
      (pendingStep === "boomerang" ||
        pendingStep === "card" ||
        runningJob?.command[1] === "boomerang" ||
        runningJob?.command[1] === "card"))
      ? "running"
      : nodeStatus("mesh", dressStatus !== "approved");
  const symbolsNodeStatus = nodeStatus("symbols", meshStatus !== "approved");
  const gameNodeStatus: LiteNodeStatus =
    nodeStatus("compress", symbolsStatus !== "approved") === "running"
      ? "running"
      : (latestFailed &&
          (latestJob?.command[1] === "card" ||
            latestJob?.command[1] === "mesh" ||
            latestJob?.command[1] === "symbols" ||
            latestJob?.command[1] === "compress" ||
            latestJob?.command[1] === "boomerang")) ||
          (error === "Something went wrong." && dressStatus === "approved" && !flowState?.complete)
        ? "failed"
        : nodeStatus("compress", symbolsStatus !== "approved");

  return (
    <VideoFlowShell
      active="lite"
      error={error === "Something went wrong." ? "" : error}
      subtitle="Drop a photo, pick a theme, and press Run."
      title="Make a card"
      onRefresh={() => {
        void refresh().catch((caught) => setError(errorText(caught)));
      }}
    >
      {keysMissing ? (
        <Callout.Root color="orange" mb="4">
          <Callout.Text>Add an API key in .env before pictures can be made.</Callout.Text>
        </Callout.Root>
      ) : null}
      {missingCard ? (
        <Callout.Root color="orange" mb="4">
          <Callout.Text>
            That card was not found.{" "}
            <a href="/dashboard/video-flow/lite">Start a new one.</a>
          </Callout.Text>
        </Callout.Root>
      ) : null}
      {latestFailed || error === "Something went wrong." ? (
        <Callout.Root color="red" mb="4">
          <Callout.Text>
            Something went wrong.{" "}
            <a href={runHref}>Open the full editor</a> if you need the prompts and settings.
          </Callout.Text>
        </Callout.Root>
      ) : null}
      {!catalogReady ? (
        <Text color="gray">Loading…</Text>
      ) : (
        <LiteCanvas
          nodes={[
            {
              id: "photo",
              title: "Her photo",
              status: photoStatus,
              body: (
                <Flex direction="column" gap="3">
                  {models.length === 0 ? (
                    <Text size="2">
                      Add a girl on <a href="/dashboard/models">Models</a> first.
                    </Text>
                  ) : (
                    <label>
                      <Text as="div" color="gray" mb="1" size="2" weight="bold">
                        Girl
                      </Text>
                      <Select.Root
                        disabled={Boolean(cardId)}
                        value={modelId || undefined}
                        onValueChange={setModelId}
                      >
                        <Select.Trigger placeholder="Choose a girl" />
                        <Select.Content>
                          {models.map((model) => (
                            <Select.Item key={model.id} value={model.id}>
                              {model.label}
                            </Select.Item>
                          ))}
                          {modelId && !models.some((model) => model.id === modelId) ? (
                            <Select.Item value={modelId}>{modelId}</Select.Item>
                          ) : null}
                        </Select.Content>
                      </Select.Root>
                    </label>
                  )}
                  <label>
                    <Text as="div" color="gray" mb="1" size="2" weight="bold">
                      Card name
                    </Text>
                    <TextField.Root
                      disabled={Boolean(cardId)}
                      placeholder="Beach night"
                      value={cardLabel}
                      onChange={(event) => setCardLabel(event.currentTarget.value)}
                    />
                  </label>
                  <FilePathPicker
                    accept="image/*"
                    placeholder="Her photo"
                    preview="image"
                    previewLabel="Her photo"
                    previewSize="compact"
                    value={image}
                    onChange={setImage}
                    onError={setError}
                  />
                  <FilePathPicker
                    accept="image/*"
                    placeholder="Bikini photo"
                    preview="image"
                    previewLabel="Bikini"
                    previewSize="compact"
                    value={bikini}
                    onChange={setBikini}
                    onError={setError}
                  />
                  <FilePathPicker
                    accept="image/*"
                    placeholder="Face photo"
                    preview="image"
                    previewLabel="Face"
                    previewSize="compact"
                    value={face}
                    onChange={setFace}
                    onError={setError}
                  />
                  <label>
                    <Text as="div" color="gray" mb="1" size="2" weight="bold">
                      Theme
                    </Text>
                    <Select.Root
                      value={theme || undefined}
                      onValueChange={setTheme}
                    >
                      <Select.Trigger placeholder="Choose a theme" />
                      <Select.Content>
                        {themes.map((entry) => (
                          <Select.Item key={entry.id} value={entry.label}>
                            {entry.label}
                          </Select.Item>
                        ))}
                        {theme &&
                        !themes.some(
                          (entry) => entry.label.toLowerCase() === theme.toLowerCase(),
                        ) ? (
                          <Select.Item value={theme}>{theme}</Select.Item>
                        ) : null}
                      </Select.Content>
                    </Select.Root>
                  </label>
                  {pictureStatus === "review" ||
                  pictureStatus === "approved" ||
                  picturesNodeStatus === "failed" ? null : (
                    <Button disabled={runBusy || models.length === 0} type="button" onClick={() => void startPictures()}>
                      <Play {...iconProps} />
                      {pictureRunning ? "Working…" : "Run"}
                    </Button>
                  )}
                </Flex>
              ),
            },
            {
              id: "pictures",
              title: "Pictures",
              status: picturesNodeStatus,
              body: (
                <Flex direction="column" gap="3">
                  {pictureArtifacts.length === 0 ? (
                    <Text color="gray" size="2">
                      {pictureRunning ? "Making pictures…" : "Pictures show up here."}
                    </Text>
                  ) : (
                    pictureArtifacts.map((artifact) => {
                      const choice = pictureChoiceFromArtifact(artifact);
                      const chosen = flowState?.picture_choice === choice;
                      return (
                        <Flex direction="column" gap="2" key={artifact}>
                          <MediaPreview
                            label={chosen ? "Using this one" : `Picture ${choice ?? ""}`}
                            size="compact"
                            type="image"
                            value={artifact}
                            zoomable
                          />
                          {pictureStatus === "review" && !pictureRunning && choice ? (
                            <Button
                              disabled={runBusy}
                              type="button"
                              onClick={() => void approve("picture", choice)}
                            >
                              <Check {...iconProps} />
                              Use this one
                            </Button>
                          ) : null}
                        </Flex>
                      );
                    })
                  )}
                  {!pictureRunning &&
                  (pictureStatus === "review" ||
                    pictureStatus === "approved" ||
                    picturesNodeStatus === "failed") ? (
                    <Button
                      color="red"
                      disabled={runBusy}
                      type="button"
                      variant="soft"
                      onClick={() => void retry("picture")}
                    >
                      <RotateCcw {...iconProps} />
                      Try again
                    </Button>
                  ) : null}
                </Flex>
              ),
            },
            {
              id: "moving",
              title: "Moving clip",
              status: movingNodeStatus,
              body: (
                <Flex direction="column" gap="3">
                  {movingClip ? (
                    <MediaPreview label="Moving clip" size="compact" type="video" value={movingClip} />
                  ) : (
                    <Text color="gray" size="2">
                      {backgroundRunning ? "Making the clip…" : "The clip shows up here."}
                    </Text>
                  )}
                  {backgroundStatus === "review" && !backgroundRunning ? (
                    <Button disabled={runBusy} type="button" onClick={() => void approve("background")}>
                      <Check {...iconProps} />
                      Looks good
                    </Button>
                  ) : null}
                  {!backgroundRunning &&
                  (backgroundStatus === "review" ||
                    backgroundStatus === "approved" ||
                    movingNodeStatus === "failed") ? (
                    <Button
                      color="red"
                      disabled={runBusy}
                      type="button"
                      variant="soft"
                      onClick={() => void retry("background")}
                    >
                      <RotateCcw {...iconProps} />
                      Try again
                    </Button>
                  ) : null}
                </Flex>
              ),
            },
            {
              id: "outfit",
              title: "Outfit",
              status: outfitNodeStatus,
              body: (
                <Flex direction="column" gap="3">
                  <FilePathPicker
                    accept="image/*"
                    placeholder="Costume photo"
                    preview="image"
                    previewLabel="Costume"
                    previewSize="compact"
                    value={costume}
                    onChange={setCostume}
                    onError={setError}
                  />
                  {outfitClip ? (
                    <MediaPreview label="Outfit" size="compact" type="video" value={outfitClip} />
                  ) : (
                    <Text color="gray" size="2">
                      {dressRunning ? "Making the outfit…" : "The outfit shows up here."}
                    </Text>
                  )}
                  {dressStatus === "review" && !dressRunning ? (
                    <Button disabled={runBusy} type="button" onClick={() => void approve("dress")}>
                      <Check {...iconProps} />
                      Looks good
                    </Button>
                  ) : null}
                  {!dressRunning &&
                  (dressStatus === "review" ||
                    dressStatus === "approved" ||
                    outfitNodeStatus === "failed") ? (
                    <Button
                      color="red"
                      disabled={runBusy}
                      type="button"
                      variant="soft"
                      onClick={() => void retry("dress")}
                    >
                      <RotateCcw {...iconProps} />
                      Try again
                    </Button>
                  ) : null}
                </Flex>
              ),
            },
            {
              id: "mesh",
              title: "Mesh",
              status: meshNodeStatus,
              body: (
                <Flex direction="column" gap="3">
                  <Text color="gray" size="2">
                    {meshNodeStatus === "running"
                      ? "Tracking the outfit…"
                      : meshStatus === "approved"
                        ? "The outfit is tracked."
                        : "Mesh runs after the outfit."}
                  </Text>
                  {meshNodeStatus !== "running" &&
                  (meshStatus === "approved" || meshNodeStatus === "failed") ? (
                    <Button
                      color="red"
                      disabled={runBusy}
                      type="button"
                      variant="soft"
                      onClick={() => void retry("mesh")}
                    >
                      <RotateCcw {...iconProps} />
                      Try again
                    </Button>
                  ) : null}
                </Flex>
              ),
            },
            {
              id: "symbols",
              title: "Symbols",
              status: symbolsNodeStatus,
              wide: meshStatus === "approved" && Boolean(cardId.trim()),
              body: (
                <Flex direction="column" gap="3">
                  <Text color="gray" size="2">
                    {symbolsNodeStatus === "running"
                      ? "Placing 12 symbols…"
                      : symbolsStatus === "approved"
                        ? "12 symbols are on the outfit."
                        : "Symbols go on the mesh."}
                  </Text>
                  {symbolsNodeStatus !== "running" &&
                  (symbolsStatus === "approved" || symbolsNodeStatus === "failed") ? (
                    <Button
                      color="red"
                      disabled={runBusy}
                      type="button"
                      variant="soft"
                      onClick={() => {
                        const id = cardId.trim();
                        if (!id) return;
                        liteHeld.delete(`${id}:symbols`);
                        void placeSymbols().catch(() => {
                          setPendingStep(null);
                          setError("Something went wrong.");
                        });
                      }}
                    >
                      <RotateCcw {...iconProps} />
                      Try again
                    </Button>
                  ) : null}
                  {meshStatus === "approved" && cardId.trim() ? (
                    <>
                      <MaskEditor
                        meshFile={`${cardId.trim()}.json`}
                        meshUrl={`/mesh/${encodeURIComponent(cardId.trim())}.json`}
                        title="MASK"
                        videoSrc={`/cards/${encodeURIComponent(cardId.trim())}/foreground.mp4`}
                        onError={setError}
                      />
                      <SymbolPointPicker
                        cardId={cardId.trim()}
                        foregroundVideo={`/cards/${encodeURIComponent(cardId.trim())}/foreground.mp4`}
                        meshJsonPath={`/mesh/${encodeURIComponent(cardId.trim())}.json`}
                        onSaved={() => {
                          void refresh().catch((caught) => setError(errorText(caught)));
                        }}
                        onError={setError}
                      />
                    </>
                  ) : null}
                </Flex>
              ),
            },
            {
              id: "game",
              title: "Game",
              status: gameNodeStatus,
              body: (
                <Flex direction="column" gap="3">
                  {flowState?.complete && cardClip ? (
                    <MediaPreview label="Game" size="compact" type="video" value={cardClip} />
                  ) : (
                    <Text color="gray" size="2">
                      {gameNodeStatus === "running"
                        ? "Making the game…"
                        : "The game shows up here."}
                    </Text>
                  )}
                  {flowState?.complete && modelId.trim() ? (
                    <Button asChild type="button">
                      <a
                        href={`/?model=${encodeURIComponent(modelId.trim())}&card=${encodeURIComponent(cardId)}`}
                      >
                        <Play {...iconProps} />
                        Play
                      </a>
                    </Button>
                  ) : null}
                  {gameNodeStatus === "failed" ? (
                    <Button
                      color="red"
                      disabled={runBusy}
                      type="button"
                      variant="soft"
                      onClick={() => {
                        const step = latestJob?.command[1];
                        if (
                          step === "boomerang" ||
                          step === "card" ||
                          step === "mesh" ||
                          step === "compress"
                        ) {
                          void retry(step);
                        } else {
                          const id = cardId.trim();
                          if (!id) return;
                          liteHeld.delete(`${id}:symbols`);
                          void placeSymbols().catch(() => {
                            setPendingStep(null);
                            setError("Something went wrong.");
                          });
                        }
                      }}
                    >
                      <RotateCcw {...iconProps} />
                      Try again
                    </Button>
                  ) : null}
                </Flex>
              ),
            },
          ]}
        />
      )}
    </VideoFlowShell>
  );
}
