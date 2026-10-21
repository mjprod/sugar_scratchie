import { Check, ChevronDown, Gamepad2, ImagePlus, Loader2, Play, RotateCcw, Shuffle, Sparkles, X } from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  Code,
  Dialog,
  Flex,
  Grid,
  Heading,
  Select,
  Separator,
  Tabs,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, uploadFile } from "../shared/api";
import {
  approvePhotoScratchLayer,
  CARD_PRICE_MAX,
  defaultPhotoScratchPrompt,
  deletePhotoScratchLayer,
  fetchPhotoScratchSlots,
  fetchPhotoScratchVariationCatalog,
  savePhotoScratchVariationCatalog,
  generatePhotoScratchLayer,
  photoScratchSlotIsDone,
  rejectPhotoScratchLayer,
  setPhotoScratchClothesRef,
  setPhotoScratchSlotPrice,
  setPhotoScratchSlotPrompt,
  slotLayerPrompt,
  uploadPhotoScratchLayer,
  type PhotoScratchLayerType,
  type PhotoScratchSlot,
  type PhotoScratchVariationCatalog,
  type PhotoScratchVariationChoice,
  type PhotoScratchVariationOption,
} from "../shared/models";
import { fetchThemes, type ThemeInfo } from "../shared/themes";
import { flowStepBadge, type FlowNodeRuntime } from "./flowCanvas";
import {
  COMPRESS_PRESETS,
  nodeToStep,
  stepToNode,
  type CompressPreset,
  type FlowNodeId,
  type PictureCompareMode,
  type PictureModels,
  type PicturePrompts,
  type PictureVariationCount,
  type VideoFlowJson,
  type VideoFlowStepKey,
  normalizePicturePrompts,
} from "./schema";
import type { CompressReport } from "./projects";
import { MaskEditor } from "./MaskEditor";
import { MeshTunePanel } from "./MeshTunePanel";
import { meshTuneToApi, type MeshTuneSettings } from "./meshTune";
import { SymbolPointPicker } from "./SymbolPointPicker";
import { Field, FilePathPicker, iconProps, MediaPreview, MESH_TRACKERS, MESH_TRACKER_MODES, meshTrackerFromArtifact, meshTrackerModeLabel, previewSource, type MeshTracker, type MeshTrackerMode } from "./ui";
import { dressModelTakesReferenceImage, isWavespeedDressVideoModel, type AiProvider, type BackgroundVideoModel, type DressVideoModel, type SourceImageModel } from "./storage";
import {
  findGenerationModel,
  GenerationModelSelect,
  modelsForRole,
  useGenerationCatalog,
} from "../shared/generationModels";

function ThemeSelect({
  themes,
  value,
  onChange,
}: {
  themes: ThemeInfo[];
  value: string;
  onChange: (next: string) => void;
}) {
  const trimmed = value.trim();
  const matched = themes.find((entry) => entry.label.toLowerCase() === trimmed.toLowerCase());
  const selectValue = matched?.label ?? (trimmed || themes[0]!.label);
  const showLegacy = Boolean(trimmed && !matched);

  return (
    <>
      <Select.Root value={selectValue} onValueChange={onChange}>
        <Select.Trigger placeholder="Select a theme" />
        <Select.Content>
          {themes.map((entry) => (
            <Select.Item key={entry.id} value={entry.label}>
              {entry.label}
            </Select.Item>
          ))}
          {showLegacy ? (
            <Select.Item value={trimmed}>{trimmed} (not in catalog)</Select.Item>
          ) : null}
        </Select.Content>
      </Select.Root>
      <Text as="div" color="gray" mt="1" size="1">
        Manage themes at <a href="/dashboard/themes">Dashboard → Themes</a>.
      </Text>
    </>
  );
}

type JobInfo = {
  id: string;
  kind: string;
  command: string[];
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  logs: string[];
};

type VideoFlowStepState = {
  status: "locked" | "ready" | "review" | "approved";
  label: string;
  artifacts: string[];
};

type StepTiming = {
  started_at?: number | null;
  ended_at?: number | null;
  approved_at?: number | null;
  duration_seconds?: number | null;
};

type FlowTimings = {
  steps: Partial<Record<VideoFlowStepKey, StepTiming>>;
  flow_started_at?: number | null;
  completed_at?: number | null;
  total_duration_seconds?: number | null;
  total_elapsed_seconds?: number | null;
};

type VideoFlowState = {
  card_id: string;
  approved: VideoFlowStepKey[];
  steps: Record<VideoFlowStepKey, VideoFlowStepState>;
  complete: boolean;
  mesh_compare?: { path: string; tracker: string; active: boolean }[];
  compress_report?: CompressReport | null;
  boomerang?: BoomerangReport | null;
  timings?: FlowTimings | null;
  recovered_approvals?: boolean;
  picture_choice?: number | null;
};

type BoomerangReport = {
  seconds: number;
  fps?: number;
  forward_frames?: number;
  frames_before?: number;
  frames_after?: number;
  duration_after?: number;
  mesh_mirrored?: boolean;
  applied_at?: number;
  skipped?: boolean;
};

const BOOMERANG_DEFAULT_SECONDS = 5;
const BOOMERANG_MIN_SECONDS = 1;
const BOOMERANG_MAX_SECONDS = 30;

function formatTimingDateTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTimingDuration(seconds: number): string {
  if (seconds < 1) return "<1s";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function stepTimingLabel(timing: StepTiming | undefined): string {
  if (!timing) return "";
  const stamp = timing.ended_at ?? timing.approved_at ?? timing.started_at;
  if (typeof stamp !== "number") return "";
  const when = formatTimingDateTime(stamp);
  if (typeof timing.duration_seconds === "number") {
    return `${when} · ${formatTimingDuration(timing.duration_seconds)}`;
  }
  if (timing.started_at && !timing.ended_at) return `${when} · running…`;
  return when;
}

function CompressReportPanel({ report }: { report: CompressReport }) {
  const beforeBg = report.before?.background;
  const beforeFg = report.before?.foreground;
  const afterBg = report.after?.background;
  const afterFg = report.after?.foreground;
  const ratioPct =
    typeof report.size_ratio === "number" ? Math.round(report.size_ratio * 100) : null;
  const targetLabel =
    report.target_width && report.target_height
      ? `${report.target_width}×${report.target_height}`
      : report.target_width
        ? `${report.target_width}px`
        : "?";

  return (
    <Callout.Root color={report.aspect_ok === false ? "orange" : "green"}>
      <Callout.Text size="2">
        <strong>Last finalize:</strong> {report.preset_label ?? report.preset ?? "delivery"} ·{" "}
        {targetLabel}
        {report.aspect ? ` (${report.aspect})` : ""} · {report.fit ?? "cover-crop"} · CRF{" "}
        {report.crf ?? "?"}
        {report.write_webm ? " · WebM on" : " · WebM off"}
      </Callout.Text>
      <Box mt="2">
        <Grid columns="2" gap="3">
          <Box>
            <Text size="1" color="gray" weight="medium">
              Before
            </Text>
            <Text as="div" size="2">
              BG {beforeBg?.width ?? "?"}×{beforeBg?.height ?? "?"} · {beforeBg?.size ?? "—"}
            </Text>
            <Text as="div" size="2">
              FG {beforeFg?.width ?? "?"}×{beforeFg?.height ?? "?"} · {beforeFg?.size ?? "—"}
            </Text>
          </Box>
          <Box>
            <Text size="1" color="gray" weight="medium">
              After
            </Text>
            <Text as="div" size="2">
              BG {afterBg?.width ?? "?"}×{afterBg?.height ?? "?"} · {afterBg?.size ?? "—"}
            </Text>
            <Text as="div" size="2">
              FG {afterFg?.width ?? "?"}×{afterFg?.height ?? "?"} · {afterFg?.size ?? "—"}
            </Text>
          </Box>
        </Grid>
        <Text as="div" size="2" mt="2">
          Saved {report.saved ?? "—"}
          {ratioPct != null ? ` · now ${ratioPct}% of original` : ""}
          {typeof report.duration_delta_before === "number" && report.duration_delta_before > 0.05
            ? ` · synced ${report.duration_delta_before.toFixed(2)}s timing drift`
            : ""}
          {report.aspect_ok === false ? " · warning: output size mismatch" : ""}
        </Text>
      </Box>
    </Callout.Root>
  );
}

function flowStepFromJobCommand(command: string[]): VideoFlowStepKey | null {
  if (command[0] !== "video-flow-step") return null;
  const step = command[1];
  if (
    step === "picture" ||
    step === "background" ||
    step === "trim" ||
    step === "dress" ||
    step === "boomerang" ||
    step === "compress" ||
    step === "card" ||
    step === "mesh" ||
    step === "symbols"
  ) {
    return step;
  }
  return null;
}

function previewMediaType(path: string): "image" | "video" {
  const clean = path.split("?")[0].split("#")[0].toLowerCase();
  return /\.(png|jpe?g|webp|gif)$/.test(clean) ? "image" : "video";
}

function pictureChoiceFromArtifact(path: string): number | null {
  const name = path.split("?")[0].split("/").pop() ?? "";
  const match = /^picture-([123])\.png$/i.exec(name);
  return match ? Number(match[1]) : null;
}

const PICTURE_COUNT_OPTIONS = [
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
] as const;

function PicturePromptFields({
  prompts,
  onPromptsChange,
  variationCount,
  onVariationCountChange,
  compareMode,
  onCompareModeChange,
  pictureModels,
  onPictureModelsChange,
}: {
  prompts: PicturePrompts;
  onPromptsChange: (next: PicturePrompts) => void;
  variationCount: PictureVariationCount;
  onVariationCountChange: (count: PictureVariationCount) => void;
  compareMode: PictureCompareMode;
  onCompareModeChange: (mode: PictureCompareMode) => void;
  pictureModels: PictureModels;
  onPictureModelsChange: (next: PictureModels) => void;
}) {
  const { models } = useGenerationCatalog();
  const imageModels = modelsForRole(models, "source_image");

  return (
    <Flex direction="column" gap="3">
      <Field label="Compare">
        <Select.Root
          value={compareMode}
          onValueChange={(value) => onCompareModeChange(value as PictureCompareMode)}
        >
          <Select.Trigger />
          <Select.Content>
            <Select.Item value="prompts">Different prompts · same model</Select.Item>
            <Select.Item value="models">Same prompt · different models</Select.Item>
          </Select.Content>
        </Select.Root>
      </Field>
      <Field label="Pictures">
        <Select.Root
          value={String(variationCount)}
          onValueChange={(value) => onVariationCountChange(Number(value) as PictureVariationCount)}
        >
          <Select.Trigger />
          <Select.Content>
            {PICTURE_COUNT_OPTIONS.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </Field>
      {compareMode === "models" ? (
        <>
          <Field label="Shared prompt">
            <TextArea
              rows={8}
              value={prompts[0] ?? ""}
              onChange={(event) => {
                const text = event.currentTarget.value;
                onPromptsChange([text, text, text]);
              }}
            />
          </Field>
          {Array.from({ length: variationCount }, (_, index) => (
            <Field key={index} label={`Model ${index + 1}`}>
              <Select.Root
                value={pictureModels[index] || imageModels[0]?.id || "grok-imagine"}
                onValueChange={(value) => {
                  const next = [...pictureModels] as PictureModels;
                  next[index] = value;
                  onPictureModelsChange(next);
                }}
              >
                <Select.Trigger />
                <Select.Content>
                  {imageModels.map((model) => (
                    <Select.Item key={model.id} value={model.id}>
                      {model.label}
                    </Select.Item>
                  ))}
                  {pictureModels[index] &&
                  !imageModels.some((model) => model.id === pictureModels[index]) ? (
                    <Select.Item value={pictureModels[index]}>
                      {pictureModels[index]} (not in catalog)
                    </Select.Item>
                  ) : null}
                </Select.Content>
              </Select.Root>
            </Field>
          ))}
        </>
      ) : (
        Array.from({ length: variationCount }, (_, index) => (
          <Field key={index} label={`Prompt ${index + 1}`}>
            <TextArea
              rows={6}
              value={prompts[index] ?? ""}
              onChange={(event) => {
                const next = [...prompts] as PicturePrompts;
                next[index] = event.currentTarget.value;
                onPromptsChange(next);
              }}
            />
          </Field>
        ))
      )}
    </Flex>
  );
}

type TrimDetection = {
  frames: number;
  fps: number;
  duration: number;
  drop_start: number;
  drop_end: number;
  suggested: boolean;
};

type TrimApplied = {
  drop_start: number;
  drop_end: number;
  frames_before: number | null;
  frames_after: number | null;
  auto?: boolean;
  detected_start?: number;
  detected_end?: number;
};

type TrimStepInfo = {
  source: string;
  clip: string;
  detection: TrimDetection;
  applied: TrimApplied | null;
  status: string;
  revised_at?: number;
};

function TrimFramesPanel({
  cardId,
  busy,
  onBusy,
  onError,
  onState,
}: {
  cardId: string;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
  onState: (state: VideoFlowState) => void;
}) {
  const [info, setInfo] = useState<TrimStepInfo | null>(null);
  const [dropStart, setDropStart] = useState(0);
  const [dropEnd, setDropEnd] = useState(0);
  const [loading, setLoading] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  async function refresh() {
    if (!cardId) return;
    setLoading(true);
    onError("");
    try {
      const next = await api<TrimStepInfo>(`/api/video-flow/${encodeURIComponent(cardId)}/trim`);
      setInfo(next);
      if (next.applied) {
        setDropStart(next.applied.drop_start);
        setDropEnd(next.applied.drop_end);
      } else {
        setDropStart(next.detection.drop_start);
        setDropEnd(next.detection.drop_end);
      }
      setPreviewKey((value) => value + 1);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh when card changes
  }, [cardId]);

  async function apply(body: { drop_start?: number; drop_end?: number; auto?: boolean }) {
    onBusy(true);
    onError("");
    try {
      const next = await api<VideoFlowState & { trim?: TrimStepInfo }>(
        `/api/video-flow/${encodeURIComponent(cardId)}/trim`,
        { method: "POST", body: JSON.stringify(body) },
      );
      onState(next);
      if (next.trim) {
        setInfo(next.trim);
        setDropStart(next.trim.applied?.drop_start ?? next.trim.detection.drop_start);
        setDropEnd(next.trim.applied?.drop_end ?? next.trim.detection.drop_end);
      } else {
        await refresh();
      }
      setPreviewKey((value) => value + 1);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      onBusy(false);
    }
  }

  async function reset() {
    onBusy(true);
    onError("");
    try {
      const next = await api<VideoFlowState & { trim?: TrimStepInfo }>(
        `/api/video-flow/${encodeURIComponent(cardId)}/trim/reset`,
        { method: "POST", body: "{}" },
      );
      onState(next);
      if (next.trim) {
        setInfo(next.trim);
        setDropStart(next.trim.detection.drop_start);
        setDropEnd(next.trim.detection.drop_end);
      } else {
        await refresh();
      }
      setPreviewKey((value) => value + 1);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      onBusy(false);
    }
  }

  const clip = info?.clip || info?.source || "";
  const detection = info?.detection;

  return (
    <Flex direction="column" gap="4">
      <Callout.Root color="blue">
        <Callout.Text size="2">
          Image-to-video often flashes a white frame at the start or end. Drop those frames here
          before Video edit, or keep the clip as-is if it looks clean.
        </Callout.Text>
      </Callout.Root>

      {clip ? (
        <MediaPreview
          key={`${clip}:${previewKey}:${info?.revised_at ?? 0}`}
          label="Bikini clip (edit before dress-up)"
          type="video"
          value={clip}
          cacheBust={info?.revised_at ?? previewKey}
        />
      ) : (
        <Text color="gray" size="2">
          {loading ? "Scanning frames…" : "No background clip yet — approve step 1 first."}
        </Text>
      )}

      {detection ? (
        <Callout.Root color={detection.suggested ? "amber" : "green"}>
          <Callout.Text size="2">
            {detection.suggested ? (
              <>
                Detected a bright flash: drop <strong>{detection.drop_start}</strong> frame
                {detection.drop_start === 1 ? "" : "s"} from the start and{" "}
                <strong>{detection.drop_end}</strong> from the end (
                {detection.frames} frames · {detection.fps.toFixed(1)} fps). Click{" "}
                <strong>Delete white frames</strong> to apply.
              </>
            ) : (
              <>
                No bright flash at the edges ({detection.frames} frames ·{" "}
                {detection.fps.toFixed(1)} fps). You can still drop frames manually if the loop
                looks wrong.
              </>
            )}
          </Callout.Text>
        </Callout.Root>
      ) : null}

      <Grid columns="2" gap="3">
        <Field label="Drop start frames">
          <TextField.Root
            type="number"
            min={0}
            max={60}
            value={String(dropStart)}
            onChange={(event) => setDropStart(Math.max(0, Number(event.currentTarget.value) || 0))}
          />
        </Field>
        <Field label="Drop end frames">
          <TextField.Root
            type="number"
            min={0}
            max={60}
            value={String(dropEnd)}
            onChange={(event) => setDropEnd(Math.max(0, Number(event.currentTarget.value) || 0))}
          />
        </Field>
      </Grid>

      <Flex gap="2" wrap="wrap" align="center">
        <Button
          disabled={busy || loading || !cardId}
          type="button"
          onClick={() => void apply({ auto: true })}
        >
          Delete white frames
        </Button>
        <Button
          disabled={busy || loading || !cardId}
          type="button"
          variant="soft"
          onClick={() => void apply({ drop_start: dropStart, drop_end: dropEnd, auto: false })}
        >
          Apply trim
        </Button>
        <Button
          disabled={busy || loading || !cardId}
          type="button"
          variant="soft"
          onClick={() => void apply({ drop_start: 0, drop_end: 0, auto: false })}
        >
          Keep as-is
        </Button>
        <Button
          disabled={busy || loading || !cardId}
          type="button"
          variant="outline"
          onClick={() => void reset()}
        >
          <RotateCcw {...iconProps} />
          Reset to original
        </Button>
        <Button
          disabled={busy || loading || !cardId}
          type="button"
          variant="ghost"
          onClick={() => void refresh()}
        >
          Re-scan
        </Button>
      </Flex>

      {info?.applied ? (
        <Text color="gray" size="2">
          Applied: drop start {info.applied.drop_start}, end {info.applied.drop_end}
          {typeof info.applied.frames_before === "number" &&
          typeof info.applied.frames_after === "number"
            ? ` · ${info.applied.frames_before} → ${info.applied.frames_after} frames`
            : ""}
          . Continue when the loop looks right.
        </Text>
      ) : (
        <Text color="gray" size="2">
          Apply a trim (or Keep as-is), preview the clip, then continue to Video edit.
        </Text>
      )}
    </Flex>
  );
}

function BoomerangPanel({
  cardId,
  cardLabel,
  report,
  cardApproved,
  busy,
  onBusy,
  onError,
  onState,
  onClipsChanged,
}: {
  cardId: string;
  cardLabel: string;
  report: BoomerangReport | null;
  cardApproved: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
  onState: (state: VideoFlowState) => void;
  onClipsChanged: () => void;
}) {
  const applied = Boolean(report && !report.skipped && report.forward_frames && report.fps);
  const [seconds, setSeconds] = useState(
    String(applied && report?.seconds ? report.seconds : BOOMERANG_DEFAULT_SECONDS),
  );
  const parsedSeconds = Number(seconds);
  const secondsValid =
    Number.isFinite(parsedSeconds) &&
    parsedSeconds >= BOOMERANG_MIN_SECONDS &&
    parsedSeconds <= BOOMERANG_MAX_SECONDS;
  const disabled = busy || !cardId || !cardLabel;

  async function post(path: string, body: Record<string, unknown>) {
    onBusy(true);
    onError("");
    try {
      const next = await api<VideoFlowState>(
        `/api/video-flow/${encodeURIComponent(cardId)}/${path}`,
        { method: "POST", body: JSON.stringify({ card_label: cardLabel, ...body }) },
      );
      onState(next);
      onClipsChanged();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      onBusy(false);
    }
  }

  return (
    <Flex direction="column" gap="3">
      <Callout.Root color="blue">
        <Callout.Text size="2">
          Plays the first N seconds of the bikini clip and the dress clip forward, then the same
          frames backwards. <strong>Create card</strong> publishes the version you approve here.
          Keep the clips as-is when this card should stay a straight loop.
        </Callout.Text>
      </Callout.Root>
      <Flex align="end" gap="3" wrap="wrap">
        <Field label="Forward seconds">
          <TextField.Root
            type="number"
            min={BOOMERANG_MIN_SECONDS}
            max={BOOMERANG_MAX_SECONDS}
            step={0.5}
            value={seconds}
            onChange={(event) => setSeconds(event.currentTarget.value)}
          />
        </Field>
        <Button
          disabled={disabled || !secondsValid}
          type="button"
          onClick={() => void post("boomerang", { seconds: parsedSeconds })}
        >
          {busy ? <Loader2 {...iconProps} className="spin" /> : <RotateCcw {...iconProps} />}
          {applied ? "Re-make boomerang" : "Make boomerang"}
        </Button>
        <Button
          disabled={disabled}
          type="button"
          variant="soft"
          onClick={() => void post("boomerang", { skip: true, seconds: BOOMERANG_DEFAULT_SECONDS })}
        >
          Keep as-is
        </Button>
        {applied ? (
          <Button
            disabled={disabled}
            type="button"
            variant="outline"
            onClick={() => void post("boomerang/reset", {})}
          >
            <X {...iconProps} />
            Undo boomerang
          </Button>
        ) : null}
      </Flex>
      {applied && report?.fps && report.forward_frames && report.duration_after ? (
        <Text color="gray" size="2">
          Boomerang: first {(report.forward_frames / report.fps).toFixed(1)}s forward + reverse,{" "}
          {report.duration_after.toFixed(1)}s total ({report.frames_after} frames)
          {report.mesh_mirrored ? ", mesh mirrored" : ""}.
          {cardApproved
            ? " Published clips were replaced."
            : " Continue when the loop looks right."}
        </Text>
      ) : report?.skipped ? (
        <Text color="gray" size="2">
          {cardApproved
            ? "Clips kept as-is."
            : "Kept the clips as-is. Continue to Create card."}
        </Text>
      ) : (
        <Text color="gray" size="2">
          {cardApproved
            ? "Make a boomerang to replace the published clips, or leave them as they are."
            : "Make a boomerang or keep the clips as-is, then continue to Create card."}
        </Text>
      )}
      {cardApproved ? (
        <Callout.Root color="amber">
          <Callout.Text size="2">
            This card is already published. Making or undoing a boomerang replaces those clips, so
            run <strong>Finalize</strong> again afterwards.
          </Callout.Text>
        </Callout.Root>
      ) : null}
    </Flex>
  );
}

function nextPipelineStep(
  flow: VideoFlowJson,
  current: VideoFlowStepKey,
): VideoFlowStepKey | null {
  const index = flow.pipeline.indexOf(current);
  if (index < 0 || index >= flow.pipeline.length - 1) return null;
  return flow.pipeline[index + 1] ?? null;
}

function formatStepJobError(log: string | undefined, step: VideoFlowStepKey | null): string {
  if (!log) return "Step failed — check the Jobs tab for details.";
  const cleaned = log.replace(/^Job runner error: /, "").trim();
  const lowered = cleaned.toLowerCase();
  if (step === "dress" && lowered.includes("content moderation")) {
    if (
      lowered.includes("switch step 2") ||
      lowered.includes("wan 2.2") ||
      lowered.includes("wavespeed")
    ) {
      return cleaned;
    }
    return `${cleaned} Step 3 sends your approved bikini clip to the API — x.ai scans the video frames, not just your dress prompt. Switch to a WaveSpeed video edit model above, or upload your own dress video.`;
  }
  return cleaned;
}

function resolveFlowNodeStatuses(
  flow: VideoFlowJson,
  flowState: VideoFlowState | null,
  image: boolean,
  cardId: string,
  runningStep: VideoFlowStepKey | null,
  failedStep: VideoFlowStepKey | null,
): Record<FlowNodeId, FlowNodeRuntime> {
  const stepToNodeMap = stepToNode(flow);
  const next = Object.fromEntries(
    flow.nodes.map((node) => [node.id, "locked" as FlowNodeRuntime]),
  ) as Record<FlowNodeId, FlowNodeRuntime>;

  next.source = image && cardId ? "ready" : image ? "ready" : "idle";
  next.output = flowState?.complete ? "approved" : "idle";

  if (!cardId.trim()) {
    next.source = image ? "idle" : "idle";
    return next;
  }

  // Ignore leftover state from the previous card while the new one loads.
  const stateForCard =
    flowState && flowState.card_id === cardId.trim() ? flowState : null;

  if (!stateForCard) {
    const firstStep = flow.pipeline[0];
    const firstNode = firstStep ? stepToNodeMap[firstStep] : undefined;
    if (firstNode) next[firstNode] = image ? "ready" : "locked";
    return next;
  }

  for (const [step, nodeId] of Object.entries(stepToNodeMap) as [VideoFlowStepKey, FlowNodeId][]) {
    const stepState = stateForCard.steps[step];
    if (
      runningStep === step &&
      stepState?.status !== "locked"
    ) {
      next[nodeId] = "running";
      continue;
    }
    if (failedStep === step) {
      next[nodeId] = "failed";
      continue;
    }
    if (stepState) next[nodeId] = stepState.status;
  }

  next.output = stateForCard.complete ? "approved" : "idle";
  return next;
}

type MeshCompareEntry = { path: string; tracker: MeshTracker; active?: boolean };

function MeshTrackerComparePanel({
  artifacts,
  cardId,
  jobBusy,
  meshApproved,
  onApprove,
  onReject,
  onError,
}: {
  artifacts: MeshCompareEntry[];
  cardId: string;
  jobBusy: boolean;
  meshApproved: boolean;
  onApprove: (tracker: MeshTracker) => void;
  onReject?: () => void;
  onError: (message: string) => void;
}) {
  const activeTracker = artifacts.find((entry) => entry.active)?.tracker;
  const readyToPick = meshApproved ? artifacts.length >= 2 : artifacts.length >= 3;
  const foregroundVideo = `/cards/${encodeURIComponent(cardId)}/foreground.mp4`;

  return (
    <Callout.Root color="amber" className="flow-review-panel">
      <Callout.Text weight="bold">
        {meshApproved
          ? readyToPick
            ? "Compare scratch masks side by side — switch tracker with Use when you find a better fit."
            : "Generate another tracker above to compare with your current mesh."
          : readyToPick
            ? "Three meshes are ready — preview scratch masks and pick the best tracker."
            : `${artifacts.length}/3 mesh candidates ready — waiting for the rest…`}
      </Callout.Text>
      {artifacts.length ? (
        <Tabs.Root defaultValue={artifacts[0]?.tracker ?? "bootstapir"} mt="3">
          <Tabs.List>
            {artifacts.map(({ tracker: meshTracker, active }) => (
              <Tabs.Trigger key={meshTracker} value={meshTracker}>
                {meshTracker}
                {active ? (
                  <Badge ml="2" size="1" color="green">
                    active
                  </Badge>
                ) : null}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          {artifacts.map(({ path, tracker: meshTracker, active }) => (
            <Tabs.Content key={meshTracker} value={meshTracker}>
              <Flex direction="column" gap="3" mt="3">
                <MaskEditor
                  title={`${meshTracker} mesh`}
                  meshFile={path.split("/").pop() ?? path}
                  meshSavePath={path}
                  meshUrl={`/api/files/preview?path=${encodeURIComponent(path)}`}
                  videoSrc={foregroundVideo}
                  onError={onError}
                />
                <Flex align="center" gap="2" wrap="wrap">
                  <Button
                    disabled={jobBusy || !readyToPick || active}
                    type="button"
                    onClick={() => onApprove(meshTracker)}
                  >
                    <Check {...iconProps} />
                    Use {meshTracker}
                  </Button>
                  {onReject ? (
                    <Button
                      disabled={jobBusy}
                      type="button"
                      color="red"
                      variant="soft"
                      onClick={onReject}
                    >
                      Re-run step
                    </Button>
                  ) : null}
                </Flex>
                {meshApproved && active ? (
                  <Text color="gray" size="2">
                    This is the mesh currently published to <Code>public/mesh/</Code>. Switching
                    invalidates symbol placement and compress — re-run those steps after you pick a
                    different tracker.
                  </Text>
                ) : null}
              </Flex>
            </Tabs.Content>
          ))}
        </Tabs.Root>
      ) : null}
    </Callout.Root>
  );
}

function MeshJobProgress({ logs }: { logs: string[] }) {
  const tail = logs.slice(-14);
  return (
    <Callout.Root color="blue">
      <Callout.Text weight="bold">Mesh generation running — this can take several minutes.</Callout.Text>
      <Box
        asChild
        mt="3"
        style={{
          maxHeight: 220,
          overflow: "auto",
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
          lineHeight: 1.45,
          whiteSpace: "pre-wrap",
        }}
      >
        <pre>{tail.join("\n") || "Starting…"}</pre>
      </Box>
    </Callout.Root>
  );
}

/** Steps whose form is replaced by a loading panel while the job runs. */
const LOADING_PANEL_STEPS = new Set<VideoFlowStepKey>([
  "background",
  "dress",
  "card",
  "compress",
]);

const STEP_RUNNING_HINT: Partial<Record<VideoFlowStepKey, string>> = {
  picture: "Creating the stills.",
  background: "Animating the approved picture.",
  dress: "Editing the outfit onto the approved clip.",
  card: "Publishing the card videos.",
  compress: "Aligning and compressing both clips.",
};

function StepRunningPanel({
  label,
  hint,
  logs,
  startedAt,
}: {
  label: string;
  hint: string;
  logs: string[];
  startedAt: number | null;
}) {
  const fallbackStart = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const startMs = typeof startedAt === "number" ? startedAt * 1000 : fallbackStart.current;
  const elapsed = Math.max(0, (now - startMs) / 1000);
  const tail = logs.map((line) => line.trimEnd()).filter((line) => line.trim()).slice(-12);
  const latest = tail.at(-1) ?? "Starting…";
  const headline = latest.length > 180 ? `${latest.slice(0, 177)}…` : latest;
  return (
    <Flex align="center" direction="column" gap="3" px="4" py="7">
      <Loader2 size={32} strokeWidth={1.75} className="spin" color="var(--accent-9)" />
      <Heading size="4">{label}</Heading>
      <Text align="center" color="gray" size="2" style={{ maxWidth: 480 }}>
        {hint} {formatTimingDuration(elapsed)} so far. You can leave this page — the job keeps
        running.
      </Text>
      <Text align="center" size="2" style={{ maxWidth: 520 }}>
        {headline}
      </Text>
      {tail.length > 0 ? (
        <Box
          className="flow-job-log"
          mt="2"
          style={{
            width: "100%",
            overflow: "auto",
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
            background: "var(--gray-2)",
            borderRadius: 8,
            padding: "10px 12px",
          }}
        >
          <pre style={{ margin: 0 }}>{tail.join("\n")}</pre>
        </Box>
      ) : null}
    </Flex>
  );
}

type RunModeProps = {
  flow: VideoFlowJson;
  jobs: JobInfo[];
  canUseGrok: boolean;
  canUseSourceAi: boolean;
  canUseWavespeed: boolean;
  aiProvider: AiProvider;
  sourceImageModel: SourceImageModel;
  backgroundVideoModel: BackgroundVideoModel;
  dressVideoModel: DressVideoModel;
  enhancePrompt: boolean;
  image: string;
  theme: string;
  picturePrompts: PicturePrompts;
  pictureVariationCount: PictureVariationCount;
  pictureCompareMode: PictureCompareMode;
  pictureModels: PictureModels;
  backgroundMotionPrompt: string;
  dressPrompt: string;
  dressReferenceImage: string;
  cardId: string;
  cardLabel: string;
  modelId: string;
  writeWebm: boolean;
  compressPreset: CompressPreset;
  resolution: string;
  tracker: MeshTrackerMode;
  meshTune: MeshTuneSettings;
  faceImage: string;
  bikiniImage: string;
  onImageChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  onApplyThemeToPrompts: () => void;
  onPicturePromptsChange: (value: PicturePrompts) => void;
  onPictureVariationCountChange: (value: PictureVariationCount) => void;
  onPictureCompareModeChange: (value: PictureCompareMode) => void;
  onPictureModelsChange: (value: PictureModels) => void;
  onBackgroundMotionPromptChange: (value: string) => void;
  onDressPromptChange: (value: string) => void;
  onDressReferenceImageChange: (value: string) => void;
  onCardIdChange: (value: string) => void;
  onCardLabelChange: (value: string) => void;
  onWriteWebmChange: (value: boolean) => void;
  onCompressPresetChange: (value: CompressPreset) => void;
  onTrackerChange: (value: MeshTrackerMode) => void;
  onMeshTuneChange: (value: MeshTuneSettings) => void;
  onResolutionChange: (value: string) => void;
  onFaceImageChange: (value: string) => void;
  onBikiniImageChange: (value: string) => void;
  onBackgroundVideoModelChange: (value: BackgroundVideoModel) => void;
  onDressVideoModelChange: (value: DressVideoModel) => void;
  onEnhancePromptChange: (value: boolean) => void;
  promptsDirty: boolean;
  draftSaving: boolean;
  onSaveDraft: () => Promise<void>;
  onRefreshJobs: () => Promise<void>;
  onRefreshAssets: () => Promise<void>;
  onError: (message: string) => void;
};


const LAYER_META: Record<"background" | "bikini" | "clothes", { label: string; sub: string; color: string }> = {
  bikini: { label: "BIKINI", sub: "Mid / reveal", color: "var(--pink-9)" },
  clothes: { label: "TOP", sub: "Top / scratch", color: "var(--indigo-9)" },
  background: { label: "BACKGROUND", sub: "Room / scene", color: "var(--brown-9)" },
};

/** Slot grid columns and Generate-button order: Background → Bikini → Top. */
const PHOTO_SCRATCH_LAYER_ORDER = ["background", "bikini", "clothes"] as const;
const PHOTO_SCRATCH_SLOT_COUNT = 10;
const PHOTO_JOB_POLL_MS = 2000;
const PHOTO_JOB_POLL_GIVE_UP = 8;

const PENDING_FIELD: Record<PhotoScratchLayerType, keyof PhotoScratchSlot> = {
  background: "pending_bg",
  bikini: "pending_bikini",
  clothes: "pending_clothes",
};

/** Slots with neither approved nor pending for this layer (top-up targets). */
function slotsNeedingLayer(
  slots: PhotoScratchSlot[],
  layer: PhotoScratchLayerType,
): PhotoScratchSlot[] {
  const pendingKey = PENDING_FIELD[layer];
  return slots.filter((s) => !s[layer] && !s[pendingKey]);
}

/**
 * Empty slots that are ready to generate for this layer.
 * Bikini needs an approved background; top needs an approved bikini.
 */
function slotsEligibleForLayer(
  slots: PhotoScratchSlot[],
  layer: PhotoScratchLayerType,
): PhotoScratchSlot[] {
  return slotsNeedingLayer(slots, layer).filter((s) => {
    if (layer === "bikini") return Boolean(s.background);
    if (layer === "clothes") return Boolean(s.bikini);
    return true;
  });
}

/** Per-layer AI defaults: bikini → WaveSpeed/Seedream; background & top → x.ai. */
function defaultProviderForLayer(layer: PhotoScratchLayerType): {
  provider: AiProvider;
  imageModel: SourceImageModel;
} {
  if (layer === "bikini") {
    return { provider: "wavespeed", imageModel: "seedream-v5-lite" };
  }
  return { provider: "xai", imageModel: "grok-imagine" };
}

function photoScratchSlotStatusBadge(slot: PhotoScratchSlot): {
  color: "green" | "orange" | "gray";
  label: string;
} {
  if (photoScratchSlotIsDone(slot)) {
    return { color: "green", label: "Photo scratch done" };
  }
  if (!(slot.background && slot.bikini && slot.clothes)) {
    return { color: "gray", label: "Needs 3 layers" };
  }
  if (!slot.has_match) return { color: "orange", label: "3 layers · needs match" };
  if (!slot.has_cutout) return { color: "orange", label: "3 layers · needs cutout" };
  if (!slot.has_zoom) return { color: "orange", label: "3 layers · needs zooming" };
  if (!slot.mesh) return { color: "orange", label: "3 layers · needs mesh" };
  if (!slot.has_symbols) return { color: "orange", label: "3 layers · needs symbols" };
  return { color: "orange", label: "3 layers · Picture Flow" };
}

function SlotPriceInput({
  value,
  onCommit,
}: {
  value: number | null | undefined;
  onCommit: (next: number | null) => Promise<boolean>;
}) {
  const saved = value == null ? "" : String(value);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);

  function commit(badInput: boolean) {
    // Number inputs report partial entries like "e" or "-" as "" — revert, don't clear.
    if (badInput) {
      setDraft(saved);
      return;
    }
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? null : Math.floor(Number(trimmed));
    if (
      parsed !== null &&
      (!Number.isFinite(parsed) || parsed < 0 || parsed > CARD_PRICE_MAX)
    ) {
      setDraft(saved);
      return;
    }
    if ((parsed == null ? "" : String(parsed)) === saved) {
      setDraft(saved);
      return;
    }
    void onCommit(parsed).then((ok) => {
      if (!ok) setDraft(saved);
    });
  }

  return (
    <TextField.Root
      aria-label="Card price"
      max={CARD_PRICE_MAX}
      min={0}
      placeholder="Card price"
      size="1"
      step={1}
      style={{ width: 110 }}
      title="Saved on the slot; also updates the live catalog if this slot is already published"
      type="number"
      value={draft}
      onBlur={(event) => commit(event.currentTarget.validity.badInput)}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function shuffledTake(options: string[], count: number): string[] {
  if (count <= 0 || options.length === 0) return [];
  const picked: string[] = [];
  while (picked.length < count) {
    const batch = [...options];
    for (let index = batch.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      const current = batch[index];
      batch[index] = batch[swapIndex];
      batch[swapIndex] = current;
    }
    picked.push(...batch);
  }
  return picked.slice(0, count);
}

function photoNumber(slotId: string): string {
  const num = slotId.replace("slot_", "");
  return String(Number(num) || num);
}

function InfluencerPositionGuide() {
  return (
    <Flex align="start" gap="3">
      <img
        alt="Influencer position. Keep her head under the top band, centered, cropped around mid-thigh."
        src="/guides/influencer-position.png"
        style={{ width: 108, height: "auto", borderRadius: 8, flex: "0 0 auto", background: "#000" }}
      />
      <Box>
        <Text as="div" size="2" weight="bold">
          Influencer position
        </Text>
        <Text as="div" color="gray" size="1">
          Motion cards use this frame. Her head stays under the top band, she stands centered, and the
          crop ends around mid-thigh. Photo cards keep their own pose and position options.
        </Text>
      </Box>
    </Flex>
  );
}

type VariationDraft = {
  slotId: string;
  label: string;
  pose: string;
  scene: string;
  placement: string;
  hasClothesRef: boolean;
};

function variationRows(
  targets: PhotoScratchSlot[],
  catalog: PhotoScratchVariationCatalog,
): VariationDraft[] {
  const poses = shuffledTake(
    catalog.poses.map((option) => option.text),
    targets.length,
  );
  const scenes = shuffledTake(
    catalog.scenes.map((option) => option.text),
    targets.length,
  );
  const placements = shuffledTake(
    catalog.placements.map((option) => option.text),
    targets.length,
  );
  return targets.map((slot, index) => ({
    slotId: slot.id,
    label: slot.label,
    pose: poses[index] ?? "",
    scene: scenes[index] ?? "",
    placement: placements[index] ?? "",
    hasClothesRef: Boolean(slot.clothes_ref),
  }));
}

function VariationSelect({
  label,
  value,
  options,
  onChange,
  compact = false,
  fill = false,
}: {
  label: string;
  value: string;
  options: PhotoScratchVariationOption[];
  onChange: (next: string) => void;
  compact?: boolean;
  fill?: boolean;
}) {
  return (
    <label
      style={
        fill
          ? { display: "block", width: "100%", minWidth: 0 }
          : compact
            ? { flex: "0 0 200px" }
            : { flex: "1 1 200px", minWidth: 160 }
      }
    >
      {compact ? null : (
        <Text as="div" color="gray" mb="1" size="1">
          {label}
        </Text>
      )}
      {!value ? (
        <Text as="div" color="gray" size="1">
          Choose one.
        </Text>
      ) : null}
      {value ? (
        <Select.Root value={value} onValueChange={onChange}>
          <Select.Trigger style={{ width: "100%" }} />
          <Select.Content>
            {options.map((option) => (
              <Select.Item key={option.text} value={option.text}>
                {option.label}
              </Select.Item>
            ))}
            {!options.some((option) => option.text === value) ? (
              <Select.Item value={value}>{value}</Select.Item>
            ) : null}
          </Select.Content>
        </Select.Root>
      ) : null}
    </label>
  );
}

function SlotLayerUpload({
  cardId,
  slotId,
  layer,
  src,
  theme,
  slotPrompt,
  aiBlockedReason,
  busy,
  generating = false,
  onUpdate,
  onError,
  onAskGenerate,
  onSlotPromptBlur,
  clothesRef,
  onClothesRefChange,
}: {
  cardId: string;
  slotId: string;
  layer: "background" | "bikini" | "clothes";
  src?: string;
  theme: string;
  /** Saved per-slot override for this layer (empty = use shared layer default). */
  slotPrompt: string;
  /** Non-empty when AI generate should be disabled (e.g. missing bikini for top). */
  aiBlockedReason?: string;
  busy: boolean;
  /** Spinner on this tile. `busy` alone only disables the controls. */
  generating?: boolean;
  onUpdate: (slot: PhotoScratchSlot) => void;
  onError: (msg: string) => void;
  /** Opens the review step for this one photo. Generation starts only after Create. */
  onAskGenerate: () => void;
  onSlotPromptBlur: (slotId: string, layer: PhotoScratchLayerType, value: string) => void;
  /** Top tile only: this slot's clothes reference (empty = random themed costume). */
  clothesRef?: string;
  onClothesRefChange?: (slotId: string, image: string) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);
  const meta = LAYER_META[layer];
  const [refBusy, setRefBusy] = useState(false);

  async function handleFile(file: File) {
    onError("");
    try {
      const updated = await uploadPhotoScratchLayer(cardId, slotId, layer, file, theme);
      onUpdate(updated);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }

async function handleClothesRef(image: string) {
    if (!onClothesRefChange) return;
    setRefBusy(true);
    onError("");
    try {
      await onClothesRefChange(slotId, image);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRefBusy(false);
    }
  }

  async function handleClothesRefFile(file: File) {
    setRefBusy(true);
    onError("");
    try {
      const uploaded = await uploadFile(file);
      await handleClothesRef(uploaded.path);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRefBusy(false);
    }
  }

  async function handleDelete() {
    onError("");
    try {
      const updated = await deletePhotoScratchLayer(cardId, slotId, layer, theme);
      onUpdate(updated);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const disabled = busy;

  return (
    <Box
      style={{
        border: "1px solid var(--gray-5)",
        borderRadius: 10,
        overflow: "hidden",
        minWidth: 0,
      }}
    >
      {src ? (
        <Box style={{ position: "relative" }}>
          <img
            alt={meta.label}
            src={src}
            style={{ width: "100%", display: "block", aspectRatio: "9/16", objectFit: "cover" }}
          />
          <Button
            color="red"
            disabled={disabled}
            size="1"
            style={{ position: "absolute", top: 6, right: 6 }}
            type="button"
            variant="solid"
            onClick={() => void handleDelete()}
          >
            <X {...iconProps} />
          </Button>
          <Button
            disabled={disabled || Boolean(aiBlockedReason)}
            size="1"
            style={{ position: "absolute", top: 6, left: 6 }}
            title={aiBlockedReason || "Review pose and position, then create"}
            type="button"
            variant="soft"
            onClick={onAskGenerate}
          >
            {generating ? <Loader2 {...iconProps} className="spin" /> : <Sparkles {...iconProps} />}
            AI
          </Button>
        </Box>
      ) : (
        <Flex
          align="center"
          direction="column"
          gap="2"
          justify="center"
          style={{
            aspectRatio: "9/16",
            background: "var(--gray-2)",
            padding: 8,
          }}
        >
          {generating ? (
            <>
              <Loader2 size={22} strokeWidth={1.5} className="spin" color="var(--accent-9)" />
              <Text align="center" color="gray" size="1">
                AI generating…
              </Text>
            </>
          ) : (
            <>
              <Button
                disabled={disabled || Boolean(aiBlockedReason)}
                size="1"
                title={aiBlockedReason || `Review ${meta.label}, then create`}
                type="button"
                onClick={onAskGenerate}
              >
                <Sparkles {...iconProps} />
                AI
              </Button>
              <Button
                color="gray"
                disabled={disabled}
                size="1"
                type="button"
                variant="soft"
                onClick={() => inputRef.current?.click()}
              >
                <ImagePlus {...iconProps} />
                Upload
              </Button>
            </>
          )}
        </Flex>
      )}
      <Box px="2" py="1" style={{ background: "var(--gray-1)" }}>
        <Text size="1" weight="bold" style={{ color: meta.color, letterSpacing: "0.04em" }}>
          {meta.label}
        </Text>
        <Text as="div" color="gray" size="1">
          {meta.sub}
        </Text>
        <TextArea
          defaultValue={slotPrompt}
          disabled={disabled}
          key={`${slotId}-${layer}-prompt-${slotPrompt}`}
          mt="1"
          placeholder={`Optional ${meta.label.toLowerCase()} prompt for this card`}
          rows={2}
          size="1"
          style={{ width: "100%" }}
          onBlur={(event) => onSlotPromptBlur(slotId, layer, event.target.value)}
        />
        {onClothesRefChange ? (
          <Flex align="center" gap="2" mt="1">
            {clothesRef ? (
              <img
                alt="Clothes reference"
                src={previewSource(clothesRef)}
                title={clothesRef}
                style={{
                  width: 28,
                  height: 40,
                  objectFit: "cover",
                  borderRadius: 4,
                  flexShrink: 0,
                }}
              />
            ) : null}
            <Text color="gray" size="1" style={{ flex: 1, minWidth: 0 }}>
              {clothesRef ? "Clothes ref" : "Clothes: random"}
            </Text>
            <Button
              color="gray"
              disabled={disabled || refBusy}
              size="1"
              title="Upload a clothes reference for this card only"
              type="button"
              variant="soft"
              onClick={() => refInputRef.current?.click()}
            >
              {refBusy ? <Loader2 {...iconProps} className="spin" /> : <ImagePlus {...iconProps} />}
              Ref
            </Button>
            {clothesRef ? (
              <Button
                color="red"
                disabled={disabled || refBusy}
                size="1"
                title="Clear clothes reference (back to random costume)"
                type="button"
                variant="soft"
                onClick={() => void handleClothesRef("")}
              >
                <X {...iconProps} />
              </Button>
            ) : null}
          </Flex>
        ) : null}
      </Box>
      <input
        ref={inputRef}
        accept="image/jpeg,image/png,image/webp"
        hidden
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void handleFile(file);
        }}
      />
      {onClothesRefChange ? (
        <input
          ref={refInputRef}
          accept="image/jpeg,image/png,image/webp"
          hidden
          type="file"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void handleClothesRefFile(file);
          }}
        />
      ) : null}
    </Box>
  );
}

function CardPhotosPanel({
  cardId,
  theme,
  image,
  onError,
}: {
  cardId: string;
  theme: string;
  /** Flow Setup source image path — used so bikini/clothes match the same girl. */
  image: string;
  aiProvider?: string;
  sourceImageModel?: string;
  onError: (message: string) => void;
}) {
  const { models } = useGenerationCatalog();
  const [slots, setSlots] = useState<PhotoScratchSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [panelError, setPanelError] = useState("");
  const [layerBusy] = useState(false);
  const [showPrompts, setShowPrompts] = useState(true);
  const [catalog, setCatalog] = useState<PhotoScratchVariationCatalog | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const catalogSaveFlight = useRef<Promise<void> | null>(null);
  const catalogSaveQueued = useRef<PhotoScratchVariationCatalog | null>(null);
  const [slotConfig, setSlotConfig] = useState<VariationDraft[]>([]);
  // Local provider/model for Photo Scratch AI (independent of Video Flow Setup).
  // Defaults to x.ai; bikini batch uses WaveSpeed/Seedream unless the user overrides.
  const [psProvider, setPsProvider] = useState<AiProvider>("xai");
  const [psImageModel, setPsImageModel] = useState<SourceImageModel>("seedream-v5-lite");
  const [psProviderTouched, setPsProviderTouched] = useState(false);
  const [prompts, setPrompts] = useState<Record<PhotoScratchLayerType, string>>(() => ({
    bikini: defaultPhotoScratchPrompt("bikini", theme),
    clothes: defaultPhotoScratchPrompt("clothes", theme),
    background: defaultPhotoScratchPrompt("background", theme),
  }));
  const prevThemeRef = useRef(theme);
  const prevHasBgRef = useRef(false);
  // The default top prompt names a themed costume; send it blank so the backend can swap
  // in the clothes-reference caption (it falls back to the same themed wording otherwise).
  function requestPrompt(layer: PhotoScratchLayerType): string {
    const value = prompts[layer];
    if (layer === "clothes" && value.trim() === defaultPhotoScratchPrompt("clothes", theme).trim()) {
      return "";
    }
    return value;
  }
  const [clothesRefDraft, setClothesRefDraft] = useState("");
  const [clothesRefBusy, setClothesRefBusy] = useState(false);
  const clothesRefPrefilledRef = useRef(false);

  useEffect(() => {
    clothesRefPrefilledRef.current = false;
    setClothesRefDraft("");
    setSlotConfig([]);
  }, [cardId]);

  useEffect(() => {
    let cancelled = false;
    void fetchPhotoScratchVariationCatalog()
      .then((next) => {
        if (!cancelled) setCatalog(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) onError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);

  useEffect(() => {
    if (!catalog || slots.length === 0) return;
    setSlotConfig((prev) => {
      const same =
        prev.length === slots.length &&
        prev.every((row, index) => row.slotId === slots[index]?.id);
      if (same) {
        const changed = prev.some((row) => {
          const slot = slots.find((entry) => entry.id === row.slotId);
          return Boolean(
            slot && (slot.label !== row.label || Boolean(slot.clothes_ref) !== row.hasClothesRef),
          );
        });
        if (!changed) return prev;
        return prev.map((row) => {
          const slot = slots.find((entry) => entry.id === row.slotId);
          return slot
            ? { ...row, label: slot.label, hasClothesRef: Boolean(slot.clothes_ref) }
            : row;
        });
      }
      return variationRows(slots, catalog);
    });
  }, [catalog, slots]);

  // Show the card's existing reference in the "apply to all" picker after load.
  useEffect(() => {
    if (clothesRefPrefilledRef.current || slots.length === 0) return;
    clothesRefPrefilledRef.current = true;
    const existing = slots.find((s) => s.clothes_ref)?.clothes_ref ?? "";
    if (existing) setClothesRefDraft(existing);
  }, [slots]);

  // Keep the provider dropdown honest: show the default for the next generatable layer
  // (bikini → WaveSpeed/Seedream; background/top → x.ai) until the user overrides.
  useEffect(() => {
    if (psProviderTouched) return;
    const focus =
      PHOTO_SCRATCH_LAYER_ORDER.find((layer) => {
        if (slotsEligibleForLayer(slots, layer).length > 0) return true;
        return slots.some((s) => Boolean(s[PENDING_FIELD[layer]]));
      }) ?? "background";
    const next = defaultProviderForLayer(focus);
    setPsProvider((prev) => (prev === next.provider ? prev : next.provider));
    setPsImageModel((prev) => (prev === next.imageModel ? prev : next.imageModel));
  }, [slots, psProviderTouched]);

  // When theme changes, refresh prompts that still match the previous defaults.
  useEffect(() => {
    const prev = prevThemeRef.current;
    if (prev === theme) return;
    prevThemeRef.current = theme;
    const withBg = prevHasBgRef.current;
    setPrompts((current) => {
      const next = { ...current };
      for (const layer of ["bikini", "clothes", "background"] as const) {
        const opts = layer === "bikini" ? { withBackground: withBg } : undefined;
        if (current[layer] === defaultPhotoScratchPrompt(layer, prev, opts)) {
          next[layer] = defaultPhotoScratchPrompt(layer, theme, opts);
        }
      }
      return next;
    });
  }, [theme]);

  // When a background is approved, switch bikini prompt to scene-composite (drop pose-lock / studio defaults).
  useEffect(() => {
    const withBg = slots.some((s) => Boolean(s.background));
    if (withBg === prevHasBgRef.current) return;
    const wasWithBg = prevHasBgRef.current;
    prevHasBgRef.current = withBg;
    setPrompts((current) => {
      const oldDefault = defaultPhotoScratchPrompt("bikini", theme, {
        withBackground: wasWithBg,
      });
      const locksPose =
        /pose.*identical|body, pose|transparent-friendly|clean studio/i.test(current.bikini);
      if (current.bikini !== oldDefault && !(withBg && locksPose)) return current;
      return {
        ...current,
        bikini: defaultPhotoScratchPrompt("bikini", theme, { withBackground: withBg }),
      };
    });
  }, [slots, theme]);

  // One photo at a time. The grid refreshes after each image instead of waiting for all 10.
  type PhotoGenRun = {
    id: string;
    index: number;
    total: number;
    slotId: string;
    done: number;
  };
  const [genJobs, setGenJobs] = useState<Partial<Record<PhotoScratchLayerType, PhotoGenRun>>>({});
  const genTokenRef = useRef<Partial<Record<PhotoScratchLayerType, number>>>({});
  const genLayerRef = useRef<Partial<Record<PhotoScratchLayerType, boolean>>>({});

  useEffect(() => {
    return () => {
      const current = genTokenRef.current;
      genTokenRef.current = {
        background: (current.background ?? 0) + 1,
        bikini: (current.bikini ?? 0) + 1,
        clothes: (current.clothes ?? 0) + 1,
      };
      genLayerRef.current = {};
      setGenJobs({});
    };
  }, [cardId]);

  const PENDING_KEY: Record<PhotoScratchLayerType, keyof PhotoScratchSlot> = {
    background: "pending_bg",
    bikini: "pending_bikini",
    clothes: "pending_clothes",
  };

  const LAYER_LABEL: Record<PhotoScratchLayerType, string> = {
    bikini: "bikinis",
    clothes: "tops",
    background: "backgrounds",
  };

  function resolvePsAi(layer: PhotoScratchLayerType): {
    provider: AiProvider;
    imageModel: SourceImageModel;
  } {
    if (psProviderTouched) {
      return {
        provider: psProvider,
        imageModel: psProvider === "wavespeed" ? psImageModel : "grok-imagine",
      };
    }
    return defaultProviderForLayer(layer);
  }

  const refreshSlots = async (silent = false) => {
    const id = cardId.trim();
    if (!id) {
      setSlots([]);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const next = await fetchPhotoScratchSlots(id, theme);
      setSlots(next);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void refreshSlots();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh when card changes
  }, [cardId]);

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForPhotoJob(
    jobId: string,
    layer: PhotoScratchLayerType,
    token: number,
  ): Promise<{ status: string; detail: string }> {
    let misses = 0;
    while (genTokenRef.current[layer] === token) {
      try {
        const next = await api<{ status: string; logs: string[] }>(
          `/api/jobs/${encodeURIComponent(jobId)}`,
        );
        misses = 0;
        if (next.status === "succeeded" || next.status === "failed" || next.status === "cancelled") {
          const logs = next.logs ?? [];
          return { status: next.status, detail: logs[logs.length - 1] ?? next.status };
        }
      } catch (caught) {
        misses += 1;
        if (misses >= PHOTO_JOB_POLL_GIVE_UP) {
          const detail = caught instanceof Error ? caught.message : String(caught);
          return { status: "failed", detail };
        }
      }
      await sleep(PHOTO_JOB_POLL_MS);
    }
    return { status: "cancelled", detail: "stopped" };
  }

  function reportError(caught: unknown) {
    const msg = caught instanceof Error ? caught.message : String(caught);
    setPanelError(msg);
    onError(msg);
  }

  function slotsForPlan(layer: PhotoScratchLayerType, onlySlotId: string): PhotoScratchSlot[] {
    if (onlySlotId) {
      const slot = slots.find((entry) => entry.id === onlySlotId);
      return slot ? [slot] : [];
    }
    const hasPending = pendingByLayer(layer).length > 0;
    if (!hasPending) return slotsEligibleForLayer(slots, layer);
    return slots.filter((slot) => {
      if (layer === "bikini") return Boolean(slot.background);
      if (layer === "clothes") return Boolean(slot.bikini);
      return true;
    });
  }

  function updateSlotConfig(
    slotId: string,
    field: "pose" | "scene" | "placement",
    value: string,
  ) {
    setSlotConfig((current) =>
      current.map((row) => (row.slotId === slotId ? { ...row, [field]: value } : row)),
    );
  }

  function shuffleSlotPoses() {
    if (!catalog || slotConfig.length === 0) return;
    const nextPoses = shuffledTake(
      catalog.poses.map((option) => option.text),
      slotConfig.length,
    );
    setSlotConfig((current) =>
      current.map((row, index) => ({ ...row, pose: nextPoses[index] ?? row.pose })),
    );
  }

  function editVariationOption(
    group: keyof PhotoScratchVariationCatalog,
    index: number,
    field: "label" | "text",
    value: string,
  ) {
    const current = catalogRef.current;
    if (!current) return;
    const previous = current[group][index];
    if (!previous) return;
    const next: PhotoScratchVariationCatalog = {
      ...current,
      [group]: current[group].map((row, rowIndex) =>
        rowIndex === index ? { ...row, [field]: value } : row,
      ),
    };
    catalogRef.current = next;
    setCatalog(next);
    if (field !== "text" || previous.text === value) return;
    setSlotConfig((rows) =>
      rows.map((row) => {
        if (group === "poses" && row.pose === previous.text) return { ...row, pose: value };
        if (group === "scenes" && row.scene === previous.text) return { ...row, scene: value };
        if (group === "placements" && row.placement === previous.text) {
          return { ...row, placement: value };
        }
        return row;
      }),
    );
  }

  async function persistVariationCatalog(next: PhotoScratchVariationCatalog) {
    catalogSaveQueued.current = next;
    if (catalogSaveFlight.current) return;
    const run = (async () => {
      while (catalogSaveQueued.current) {
        const snapshot = catalogSaveQueued.current;
        catalogSaveQueued.current = null;
        try {
          const saved = await savePhotoScratchVariationCatalog(snapshot);
          if (catalogSaveQueued.current || catalogRef.current !== snapshot) continue;
          catalogRef.current = saved;
          setCatalog(saved);
        } catch (caught) {
          if (catalogSaveQueued.current) continue;
          reportError(caught);
        }
      }
    })();
    catalogSaveFlight.current = run;
    try {
      await run;
    } finally {
      catalogSaveFlight.current = null;
      const pending = catalogSaveQueued.current;
      if (pending) void persistVariationCatalog(pending);
    }
  }

  function addVariationOption(group: keyof PhotoScratchVariationCatalog) {
    const current = catalogRef.current;
    if (!current) return;
    const count = current[group].length + 1;
    const next: PhotoScratchVariationCatalog = {
      ...current,
      [group]: [
        ...current[group],
        { label: `New ${count}`, text: `Custom ${group} option ${count}` },
      ],
    };
    catalogRef.current = next;
    setCatalog(next);
    void persistVariationCatalog(next);
  }

  function deleteVariationOption(group: keyof PhotoScratchVariationCatalog, index: number) {
    const current = catalogRef.current;
    if (!current) return;
    if (current[group].length <= 1) {
      reportError("Keep at least one option.");
      return;
    }
    const next: PhotoScratchVariationCatalog = {
      ...current,
      [group]: current[group].filter((_, rowIndex) => rowIndex !== index),
    };
    catalogRef.current = next;
    setCatalog(next);
    void persistVariationCatalog(next);
  }

  async function startGenerate(layer: PhotoScratchLayerType, onlySlotId = "") {
    const id = cardId.trim();
    if (!id || genJobs[layer] || genLayerRef.current[layer]) return;
    if (slotConfig.length === 0) {
      reportError("Configure the slots first.");
      return;
    }
    if ((layer === "bikini" || layer === "clothes") && !image.trim()) {
      reportError("Set the Flow source image in Setup first — bikini/top must match that girl.");
      return;
    }
    if (!onlySlotId && layer === "bikini" && !slots.some((slot) => slot.background)) {
      reportError("Generate and approve backgrounds first, then bikinis.");
      return;
    }
    if (!onlySlotId && layer === "clothes" && !slots.some((slot) => slot.bikini)) {
      reportError("Approve bikinis first so the top matches the same pose and girl.");
      return;
    }
    if (onlySlotId && layer === "clothes") {
      const slot = slots.find((entry) => entry.id === onlySlotId);
      if (slot && !slot.bikini) {
        reportError("Generate/approve bikini on this card first.");
        return;
      }
    }
    const hasPending = pendingByLayer(layer).length > 0;
    const targets = slotsForPlan(layer, onlySlotId);
    if (!onlySlotId && !hasPending && targets.length === 0) {
      reportError(
        layer === "clothes"
          ? "No tops to generate — approve bikinis on empty slots first (or delete tops to refill)."
          : layer === "bikini"
            ? "No bikinis to generate — approve backgrounds on empty slots first (or delete bikinis to refill)."
            : "All backgrounds are already approved — delete some to generate replacements.",
      );
      return;
    }
    if (targets.length === 0) {
      reportError("No photos to generate.");
      return;
    }
    const choices: PhotoScratchVariationChoice[] = targets.map((slot) => {
      const row = slotConfig.find((entry) => entry.slotId === slot.id);
      return {
        slot_id: slot.id,
        pose: row?.pose ?? "",
        scene: row?.scene ?? "",
        placement: row?.placement ?? "",
      };
    });
    const { provider, imageModel } = resolvePsAi(layer);
    const token = (genTokenRef.current[layer] ?? 0) + 1;
    genTokenRef.current[layer] = token;
    const single = Boolean(onlySlotId);
    genLayerRef.current[layer] = true;
    setPanelError("");
    setGenJobs((prev) => ({
      ...prev,
      [layer]: {
        id: "",
        index: 1,
        total: targets.length,
        slotId: targets[0].id,
        done: 0,
      },
    }));
    const failures: string[] = [];
    try {
      for (let index = 0; index < targets.length; index += 1) {
        if (genTokenRef.current[layer] !== token) return;
        const slot = targets[index];
        setGenJobs((prev) => ({
          ...prev,
          [layer]: {
            id: "",
            index: index + 1,
            total: targets.length,
            slotId: slot.id,
            done: index,
          },
        }));
        try {
          const choice = choices.filter((entry) => entry.slot_id === slot.id);
          const job = await generatePhotoScratchLayer(
            id,
            layer,
            theme,
            provider,
            imageModel,
            image.trim(),
            slot.id,
            requestPrompt(layer),
            1,
            false,
            choice,
            single,
          );
          if (genTokenRef.current[layer] !== token) return;
          setGenJobs((prev) => ({
            ...prev,
            [layer]: {
              id: job.id,
              index: index + 1,
              total: targets.length,
              slotId: slot.id,
              done: index,
            },
          }));
          const result = await waitForPhotoJob(job.id, layer, token);
          if (genTokenRef.current[layer] !== token) return;
          if (result.status !== "succeeded") {
            failures.push(`${slot.label}: ${result.detail}`);
          }
        } catch (caught) {
          if (genTokenRef.current[layer] !== token) return;
          failures.push(
            `${slot.label}: ${caught instanceof Error ? caught.message : String(caught)}`,
          );
        }
        try {
          await refreshSlots(true);
        } catch {
          /* the pictures stay on disk; the next refresh can pick them up */
        }
      }
    } finally {
      if (genTokenRef.current[layer] === token) {
        genLayerRef.current[layer] = false;
        setGenJobs((prev) => {
          const copy = { ...prev };
          delete copy[layer];
          return copy;
        });
      }
    }
    if (genTokenRef.current[layer] !== token) return;
    if (failures.length > 0) {
      reportError(`Some ${LAYER_LABEL[layer]} failed. ${failures.join(" ")}`);
    }
  }

  async function handleGenerate(layer: PhotoScratchLayerType) {
    await startGenerate(layer);
  }

  async function handleApprove(slotId: string, layer: PhotoScratchLayerType) {
    setPanelError("");
    try {
      const updated = await approvePhotoScratchLayer(cardId.trim(), slotId, layer, theme);
      setSlots((prev) => prev.map((s) => (s.id === slotId ? updated : s)));
    } catch (caught) {
      reportError(caught);
    }
  }

  async function handleReject(slotId: string, layer: PhotoScratchLayerType) {
    setPanelError("");
    try {
      const updated = await rejectPhotoScratchLayer(cardId.trim(), slotId, layer, theme);
      setSlots((prev) => prev.map((s) => (s.id === slotId ? updated : s)));
    } catch (caught) {
      reportError(caught);
    }
  }

  function handleSlotUpdate(updated: PhotoScratchSlot) {
    setSlots((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  }

  async function handleSlotPromptBlur(
    slotId: string,
    layer: PhotoScratchLayerType,
    value: string,
  ) {
    const current = slots.find((s) => s.id === slotId);
    const next = value.trim();
    const prev = current ? slotLayerPrompt(current, layer) : "";
    if (next === prev) return;
    setPanelError("");
    try {
      const updated = await setPhotoScratchSlotPrompt(
        cardId.trim(),
        slotId,
        layer,
        next,
        theme,
      );
      handleSlotUpdate(updated);
    } catch (caught) {
      reportError(caught);
    }
  }

  /** Empty `slotId` applies to every slot; empty `image` clears. */
  async function handleClothesRefChange(image: string, slotId = "") {
    setPanelError("");
    try {
      const updated = await setPhotoScratchClothesRef(cardId.trim(), image, slotId, theme);
      const byId = new Map(updated.map((s) => [s.id, s]));
      setSlots((prev) => prev.map((s) => byId.get(s.id) ?? s));
    } catch (caught) {
      reportError(caught);
    }
  }

  async function handleClothesRefAll(image: string) {
    setClothesRefBusy(true);
    try {
      await handleClothesRefChange(image);
    } finally {
      setClothesRefBusy(false);
    }
  }

  async function handleSlotPriceCommit(slotId: string, next: number | null): Promise<boolean> {
    setPanelError("");
    try {
      const updated = await setPhotoScratchSlotPrice(cardId.trim(), slotId, next, theme);
      handleSlotUpdate(updated);
      return true;
    } catch (caught) {
      reportError(caught);
      return false;
    }
  }

  const pendingByLayer = (layer: PhotoScratchLayerType) =>
    slots.filter((s) => Boolean(s[PENDING_KEY[layer]]));

  const hasAnyPending =
    pendingByLayer("background").length > 0 ||
    pendingByLayer("bikini").length > 0 ||
    pendingByLayer("clothes").length > 0;
  const hasApprovedBikini = slots.some((s) => s.bikini);
  const hasApprovedBackground = slots.some((s) => s.background);
  const hasAnyLayer = slots.some((s) => s.background || s.bikini || s.clothes);
  const layersCompleteCount = slots.filter(
    (s) => Boolean(s.background && s.bikini && s.clothes),
  ).length;
  const photoScratchDoneCount = slots.filter((s) => photoScratchSlotIsDone(s)).length;
  const clothesRefCount = slots.filter((s) => Boolean(s.clothes_ref)).length;
  const anyGenBusy = Object.keys(genJobs).length > 0;
  const hasSourceImage = Boolean(image.trim());
  const pictureFlowHref = cardId.trim()
    ? `/dashboard/picture-flow?card=${encodeURIComponent(cardId.trim())}`
    : "/dashboard/picture-flow";

  function generateButton(layer: PhotoScratchLayerType, label: string) {
    const busy = Boolean(genJobs[layer]);
    const hasPending = pendingByLayer(layer).length > 0;
    const eligible = slotsEligibleForLayer(slots, layer);
    const needsSource = (layer === "bikini" || layer === "clothes") && !hasSourceImage;
    const needsBackground = layer === "bikini" && !hasApprovedBackground;
    const needsBikini = layer === "clothes" && !hasApprovedBikini;
    const nothingToFill = !hasPending && eligible.length === 0;
    const blocked = needsSource || needsBackground || needsBikini || nothingToFill || slotConfig.length === 0;
    let title = "";
    if (slotConfig.length === 0) title = "Configure the slots first";
    else if (needsSource) title = "Set Flow source image in Setup first";
    else if (needsBackground) title = "Approve backgrounds first, then bikinis";
    else if (needsBikini) title = "Approve bikinis first so top matches";
    else if (nothingToFill) {
      if (layer === "clothes") {
        title = "Approve bikinis on empty slots first — cannot create top without bikini";
      } else if (layer === "bikini") {
        title = "Approve backgrounds on empty slots first — or delete bikinis to refill";
      } else {
        title = "All backgrounds approved — delete some to generate replacements";
      }
    }
    let buttonLabel: string;
    const run = genJobs[layer];
    if (busy && run) buttonLabel = `Generating ${run.index}/${run.total}…`;
    else if (busy) buttonLabel = `Generating ${label}…`;
    else if (hasPending) buttonLabel = `Regenerate ${label}`;
    else if (eligible.length === 0) buttonLabel = `Generate ${label}`;
    else buttonLabel = `Generate ${eligible.length} ${label}`;
    return (
      <Button
        key={layer}
        disabled={!cardId.trim() || busy || blocked}
        size="2"
        type="button"
        title={title || undefined}
        variant={hasPending || busy || blocked ? "soft" : "solid"}
        color={hasPending || busy || blocked ? "gray" : undefined}
        onClick={() => void handleGenerate(layer)}
      >
        {busy ? <Loader2 {...iconProps} className="spin" /> : <Play {...iconProps} />}
        {buttonLabel}
      </Button>
    );
  }

  function reviewSection(layer: PhotoScratchLayerType, title: string) {
    const pendingKey = PENDING_KEY[layer];
    const approvedKey = layer as keyof PhotoScratchSlot;
    const pendingSlots = slots.filter((s) => Boolean(s[pendingKey]));
    const run = genJobs[layer];
    if (pendingSlots.length === 0 && !run) return null;
    const current = run ? slots.find((slot) => slot.id === run.slotId) : undefined;

    return (
      <Flex key={layer} direction="column" gap="3">
        {run ? (
          <Callout.Root color="blue">
            <Callout.Text weight="bold">
              {title} {run.index} of {run.total}
              {current ? ` — ${current.label}` : ""}
            </Callout.Text>
            <Callout.Text>
              {run.done} finished. Each picture shows up here as soon as it is ready.
            </Callout.Text>
          </Callout.Root>
        ) : null}

        {pendingSlots.length > 0 || run ? (
          <>
            {pendingSlots.length > 0 ? (
              <Callout.Root color="amber">
                <Callout.Text weight="bold">
                  {title} — approve or skip each one.
                </Callout.Text>
              </Callout.Root>
            ) : null}
            <Grid columns={{ initial: "2", sm: "3", md: "5" }} gap="3">
              {slots.map((slot) => {
                const pendingSrc = slot[pendingKey] as string | undefined;
                const approvedSrc = slot[approvedKey] as string | undefined;
                if (pendingSrc) {
                  return (
                    <Box key={`${layer}-${slot.id}`}>
                      <Box style={{ position: "relative", borderRadius: 8, overflow: "hidden" }}>
                        <img
                          alt={slot.label}
                          src={pendingSrc}
                          style={{
                            width: "100%",
                            display: "block",
                            aspectRatio: "9/16",
                            objectFit: "cover",
                          }}
                        />
                      </Box>
                      <Text as="div" size="1" color="gray" mt="1" mb="1">
                        {slot.label}
                      </Text>
                      <Flex gap="1">
                        <Button
                          size="1"
                          type="button"
                          style={{ flex: 1 }}
                          onClick={() => void handleApprove(slot.id, layer)}
                        >
                          <Check {...iconProps} />
                          Use
                        </Button>
                        <Button
                          color="red"
                          size="1"
                          type="button"
                          variant="soft"
                          style={{ flex: 1 }}
                          onClick={() => void handleReject(slot.id, layer)}
                        >
                          <X {...iconProps} />
                          Skip
                        </Button>
                      </Flex>
                    </Box>
                  );
                }
                if (approvedSrc) {
                  return (
                    <Box key={`${layer}-${slot.id}`}>
                      <Box style={{ borderRadius: 8, overflow: "hidden", opacity: 0.4 }}>
                        <img
                          alt={slot.label}
                          src={approvedSrc}
                          style={{
                            width: "100%",
                            display: "block",
                            aspectRatio: "9/16",
                            objectFit: "cover",
                          }}
                        />
                      </Box>
                      <Text as="div" size="1" color="gray" mt="1">
                        {slot.label} — approved
                      </Text>
                    </Box>
                  );
                }
                return (
                  <Box
                    key={`${layer}-${slot.id}`}
                    style={{
                      borderRadius: 8,
                      background: "var(--gray-3)",
                      aspectRatio: "9/16",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    {run?.slotId === slot.id ? (
                      <Loader2 size={22} strokeWidth={1.5} className="spin" color="var(--accent-9)" />
                    ) : null}
                    <Text color="gray" size="1">
                      {run?.slotId === slot.id ? "Generating…" : slot.label}
                    </Text>
                  </Box>
                );
              })}
            </Grid>
          </>
        ) : null}
      </Flex>
    );
  }

  return (
    <Card size="3">
      <Flex align="start" justify="between" mb="4" wrap="wrap" gap="3">
        <Box>
          <Heading size="3">Photo Scratch cards</Heading>
          <Text color="gray" size="2">
            Order: configure each slot, then generate. Background → Bikini → Top. The top keeps
            the bikini pose so scratch holes stay aligned.
          </Text>
          <Flex align="center" gap="2" mt="2" wrap="wrap">
            <Badge color={layersCompleteCount > 0 ? "green" : "gray"} variant="soft">
              Layers: {layersCompleteCount}/10
            </Badge>
            <Badge
              color={photoScratchDoneCount > 0 ? "green" : "gray"}
              variant="soft"
            >
              Done: {photoScratchDoneCount}/10
            </Badge>
            <Badge color={clothesRefCount > 0 ? "blue" : "gray"} variant="soft">
              Clothes ref: {clothesRefCount}/10
            </Badge>
            <Text color="gray" size="1">
              Upload 3 layers per card, then Create game → Picture Flow (cutout / mesh /
              symbols). Done = match + cutout + mesh + symbols.
            </Text>
          </Flex>
        </Box>
        <Flex gap="2" wrap="wrap">
          <Button
            color="gray"
            size="2"
            type="button"
            variant="soft"
            onClick={() => setShowPrompts((value) => !value)}
          >
            <ChevronDown
              {...iconProps}
              style={{ transform: showPrompts ? "rotate(180deg)" : undefined }}
            />
            {showPrompts ? "Hide prompts" : "Show prompts"}
          </Button>
          {layersCompleteCount > 0 ? (
            <>
              <Button asChild color="green" size="2">
                <a href={`${pictureFlowHref}&auto=1`}>
                  <Sparkles {...iconProps} />
                  Auto-approve all ({layersCompleteCount})
                </a>
              </Button>
              <Button asChild color="gray" size="2" variant="soft">
                <a href={pictureFlowHref}>
                  <Gamepad2 {...iconProps} />
                  Open Picture Flow
                </a>
              </Button>
            </>
          ) : null}
        </Flex>
      </Flex>

      {catalog ? (
        <Dialog.Root open={optionsOpen} onOpenChange={setOptionsOpen}>
          <Dialog.Content
            style={{
              maxWidth: 880,
              maxHeight: "calc(100vh - 32px)",
              overflow: "auto",
            }}
          >
            <Dialog.Title>Pose, lighting, and position options</Dialog.Title>
            <Dialog.Description size="2" mb="3">
              Add, edit, or delete choices. Changes are saved when you leave a field.
            </Dialog.Description>
            <Grid columns={{ initial: "1", md: "3" }} gap="3">
              {(
                [
                  ["poses", "Poses"],
                  ["scenes", "Lighting"],
                  ["placements", "Positions"],
                ] as const
              ).map(([group, title]) => (
                <Box key={group}>
                  <Flex align="center" justify="between" gap="2" mb="2">
                    <Text size="2" weight="bold">
                      {title}
                    </Text>
                    <Button
                      color="gray"
                      size="1"
                      type="button"
                      variant="soft"
                      onClick={() => addVariationOption(group)}
                    >
                      Add
                    </Button>
                  </Flex>
                  <Flex direction="column" gap="2">
                    {catalog[group].map((option, index) => (
                      <Flex key={`${group}-${index}`} align="center" gap="1">
                        <TextField.Root
                          style={{ flex: "0 0 110px" }}
                          value={option.label}
                          onChange={(event) =>
                            editVariationOption(group, index, "label", event.currentTarget.value)
                          }
                          onBlur={() => {
                            const next = catalogRef.current;
                            if (next) void persistVariationCatalog(next);
                          }}
                        />
                        <TextField.Root
                          style={{ flex: "1 1 auto" }}
                          value={option.text}
                          onChange={(event) =>
                            editVariationOption(group, index, "text", event.currentTarget.value)
                          }
                          onBlur={() => {
                            const next = catalogRef.current;
                            if (next) void persistVariationCatalog(next);
                          }}
                        />
                        <Button
                          color="gray"
                          size="1"
                          type="button"
                          variant="ghost"
                          onClick={() => deleteVariationOption(group, index)}
                        >
                          <X {...iconProps} />
                        </Button>
                      </Flex>
                    ))}
                  </Flex>
                </Box>
              ))}
            </Grid>
          </Dialog.Content>
        </Dialog.Root>
      ) : null}

      {catalog && slotConfig.length > 0 ? (
        <Box mb="4" style={{ overflowX: "auto" }}>
          <Flex align="center" justify="between" gap="2" mb="2" wrap="wrap">
            <Box>
              <Text as="div" size="2" weight="bold">
                Slots
              </Text>
              <Text as="div" color="gray" size="1">
                Set pose, lighting, and position first. Generate uses this list.
              </Text>
            </Box>
            <Flex gap="2" wrap="wrap">
              <Button
                color="gray"
                size="1"
                type="button"
                variant="soft"
                onClick={() => setOptionsOpen(true)}
              >
                Edit options
              </Button>
              <Button color="gray" size="1" type="button" variant="soft" onClick={shuffleSlotPoses}>
                <Shuffle {...iconProps} />
                Shuffle poses
              </Button>
            </Flex>
          </Flex>
          <Flex align="center" gap="2" mb="1">
            <Text size="1" style={{ width: 28 }} weight="bold">
              #
            </Text>
            <Text size="1" style={{ flex: "0 0 200px" }} weight="bold">
              Pose
            </Text>
            <Text size="1" style={{ flex: "1 1 auto" }} weight="bold">
              Pose text
            </Text>
            <Text size="1" style={{ flex: "0 0 180px" }} weight="bold">
              Lighting
            </Text>
            <Text size="1" style={{ flex: "0 0 180px" }} weight="bold">
              Position
            </Text>
          </Flex>
          <Flex direction="column" gap="1" mb="3">
            {slotConfig.map((row) => (
              <Flex key={row.slotId} align="center" gap="2">
                <Text size="2" style={{ width: 28 }} weight="bold">
                  {photoNumber(row.slotId)}
                </Text>
                <VariationSelect
                  compact
                  label="Pose"
                  options={catalog.poses}
                  value={row.pose}
                  onChange={(next) => updateSlotConfig(row.slotId, "pose", next)}
                />
                <TextField.Root
                  style={{ flex: "1 1 auto" }}
                  value={row.pose}
                  onChange={(event) => updateSlotConfig(row.slotId, "pose", event.currentTarget.value)}
                />
                <Box style={{ flex: "0 0 180px", minWidth: 0 }}>
                  <VariationSelect
                    compact
                    fill
                    label="Lighting"
                    options={catalog.scenes}
                    value={row.scene}
                    onChange={(next) => updateSlotConfig(row.slotId, "scene", next)}
                  />
                </Box>
                <Box style={{ flex: "0 0 180px", minWidth: 0 }}>
                  <VariationSelect
                    compact
                    fill
                    label="Position"
                    options={catalog.placements}
                    value={row.placement}
                    onChange={(next) => updateSlotConfig(row.slotId, "placement", next)}
                  />
                </Box>
              </Flex>
            ))}
          </Flex>
          <Flex gap="2" wrap="wrap">
            {generateButton("background", "backgrounds")}
            {generateButton("bikini", "bikinis")}
            {generateButton("clothes", "tops")}
          </Flex>
          <Box mt="4">
            <Flex direction="column" gap="5">
              {reviewSection("background", "Background")}
              {reviewSection("bikini", "Bikini")}
              {reviewSection("clothes", "Top")}
            </Flex>
          </Box>
        </Box>
      ) : null}

      <Flex align="end" gap="3" mb="4" wrap="wrap">
        <Box style={{ minWidth: 160 }}>
          <Text as="div" size="1" weight="medium" mb="1">
            AI provider
          </Text>
          <Select.Root
            value={psProvider}
            onValueChange={(value) => {
              const next = value as AiProvider;
              setPsProviderTouched(true);
              setPsProvider(next);
              if (next === "wavespeed") setPsImageModel("seedream-v5-lite");
            }}
          >
            <Select.Trigger />
            <Select.Content>
              <Select.Item value="xai">x.ai</Select.Item>
              <Select.Item value="wavespeed">WaveSpeed</Select.Item>
            </Select.Content>
          </Select.Root>
        </Box>
        {psProvider === "wavespeed" ? (
          <Box style={{ minWidth: 200 }}>
            <Text as="div" size="1" weight="medium" mb="1">
              Image model
            </Text>
            <GenerationModelSelect
              role="source_image"
              value={psImageModel}
              models={models}
              onValueChange={(value) => {
                setPsProviderTouched(true);
                setPsImageModel(value);
              }}
            />
          </Box>
        ) : null}
        <Text color="gray" size="1" style={{ maxWidth: 400 }}>
          Dropdown follows the next step (bikini → WaveSpeed + Seedream; backgrounds & tops →
          x.ai). Change it to override all layers. If x.ai blocks, switch to WaveSpeed.
        </Text>
      </Flex>

      <Flex align="end" gap="3" mb="4" wrap="wrap">
        <Box style={{ flex: "1 1 320px", minWidth: 0 }}>
          <Text as="div" size="1" weight="medium" mb="1">
            Clothes reference (optional)
          </Text>
          <FilePathPicker
            accept="image/*"
            placeholder="Upload a clothes photo or paste a path"
            preview="image"
            previewLabel="Clothes reference"
            previewSize="compact"
            value={clothesRefDraft}
            onChange={setClothesRefDraft}
            onError={(msg) => {
              setPanelError(msg);
              if (msg) onError(msg);
            }}
          />
        </Box>
        <Flex gap="2" wrap="wrap">
          <Button
            disabled={!cardId.trim() || !clothesRefDraft.trim() || clothesRefBusy}
            size="2"
            type="button"
            onClick={() => void handleClothesRefAll(clothesRefDraft)}
          >
            {clothesRefBusy ? <Loader2 {...iconProps} className="spin" /> : <Check {...iconProps} />}
            Apply to all cards
          </Button>
          <Button
            color="gray"
            disabled={!cardId.trim() || clothesRefCount === 0 || clothesRefBusy}
            size="2"
            type="button"
            variant="soft"
            onClick={() => void handleClothesRefAll("")}
          >
            <X {...iconProps} />
            Clear all
          </Button>
        </Flex>
        <Text color="gray" size="1" style={{ maxWidth: 400 }}>
          Tops copy this outfit (captioned by Grok vision, needs XAI_API_KEY). Use{" "}
          <strong>Ref</strong> on a card&apos;s Top tile to set one card only. No reference =
          random themed costume per card.
        </Text>
      </Flex>

      {showPrompts ? (
        <Box
          mb="4"
          style={{
            border: "1px solid var(--gray-5)",
            borderRadius: 12,
            padding: 14,
            background: "var(--gray-2)",
          }}
        >
          <Flex align="center" justify="between" mb="3" wrap="wrap" gap="2">
            <Box>
              <Text size="2" weight="bold">
                AI prompts
              </Text>
              <Text as="div" color="gray" size="1">
                Background = empty scene. Bikini = new pose in that scene (not the source wall).
                Top matches bikini pose on purpose. Click Reset if prompts still say &quot;pose
                identical&quot;.
              </Text>
            </Box>
            <Button
              color="gray"
              size="1"
              type="button"
              variant="soft"
              onClick={() => {
                const withBg = slots.some((s) => Boolean(s.background));
                setPrompts({
                  background: defaultPhotoScratchPrompt("background", theme),
                  bikini: defaultPhotoScratchPrompt("bikini", theme, {
                    withBackground: withBg,
                  }),
                  clothes: defaultPhotoScratchPrompt("clothes", theme),
                });
              }}
            >
              Reset to defaults
            </Button>
          </Flex>
          <Flex direction="column" gap="3">
            {(
              [
                ["background", "Background (scene only — no people)"],
                [
                  "bikini",
                  slots.some((s) => s.background)
                    ? "Bikini (place girl onto approved background)"
                    : "Bikini (studio; uses background once you approve one)",
                ],
                [
                  "clothes",
                  "Top (dress over bikini — keep same scene; a clothes reference replaces the costume wording)",
                ],
              ] as const
            ).map(([layer, label]) => (
              <label key={layer}>
                <Text as="div" size="1" weight="medium" mb="1">
                  {label}
                </Text>
                <TextArea
                  className="dashboard-textarea"
                  rows={3}
                  value={prompts[layer]}
                  onChange={(event) => {
                    // Read the value now. React applies this update during the
                    // next render, after currentTarget has been cleared.
                    const value = event.currentTarget.value;
                    setPrompts((prev) => ({ ...prev, [layer]: value }));
                  }}
                />
              </label>
            ))}
          </Flex>
        </Box>
      ) : null}

      {!hasSourceImage ? (
        <Callout.Root color="orange" mb="3">
          <Callout.Text>
            Bikini and top generations need the Flow <strong>source image</strong> from Setup so
            the girl stays the same.
          </Callout.Text>
        </Callout.Root>
      ) : null}

      {panelError ? (
        <Callout.Root color="red" mb="3">
          <Callout.Text>{panelError}</Callout.Text>
        </Callout.Root>
      ) : null}

      {loading ? (
        <Text color="gray" size="2">
          Loading…
        </Text>
      ) : (
        <Flex direction="column" gap="5">
          {hasAnyLayer ? (
            <Flex direction="column" gap="4">
              <Text size="2" weight="bold">
                Photo cards
                {hasAnyPending || anyGenBusy ? " (approved layers stay here while you review)" : ""}
              </Text>
              {slots.map((slot, index) => {
                const status = photoScratchSlotStatusBadge(slot);
                const done = photoScratchSlotIsDone(slot);
                const layersReady = Boolean(
                  slot.background && slot.bikini && slot.clothes,
                );
                return (
                <Box
                  key={slot.id}
                  style={{
                    border: "1px solid var(--gray-4)",
                    borderRadius: 12,
                    padding: 14,
                    background: "var(--gray-1)",
                  }}
                >
                  <Flex align="center" justify="between" gap="2" mb="2" wrap="wrap">
                    <Text size="2" weight="bold">
                      {index + 1}. {slot.label}
                    </Text>
                    <Flex align="center" gap="2" wrap="wrap">
                      <SlotPriceInput
                        value={slot.card_price}
                        onCommit={(next) => handleSlotPriceCommit(slot.id, next)}
                      />
                      <Badge color={status.color} variant="soft">
                        {status.label}
                      </Badge>
                      {layersReady ? (
                        <Button
                          asChild
                          color={done ? "gray" : "green"}
                          size="1"
                          variant={done ? "soft" : "solid"}
                        >
                          <a
                            href={`${pictureFlowHref}&slot=${encodeURIComponent(slot.id)}`}
                          >
                            <Gamepad2 {...iconProps} />
                            {done ? "Open Picture Flow" : "Create game"}
                          </a>
                        </Button>
                      ) : null}
                    </Flex>
                  </Flex>
                  <Grid columns="3" gap="2">
                    {PHOTO_SCRATCH_LAYER_ORDER.map((layer) => {
                      let aiBlockedReason = "";
                      if ((layer === "bikini" || layer === "clothes") && !image.trim()) {
                        aiBlockedReason = "Set the Flow source image in Setup first";
                      } else if (layer === "clothes" && !slot.bikini) {
                        aiBlockedReason = "Generate/approve bikini on this card first";
                      }
                      return (
                        <SlotLayerUpload
                          key={layer}
                          cardId={cardId.trim()}
                          slotId={slot.id}
                          layer={layer}
                          src={slot[layer]}
                          theme={theme}
                          slotPrompt={slotLayerPrompt(slot, layer)}
                          aiBlockedReason={aiBlockedReason}
                          busy={layerBusy || Boolean(genJobs[layer])}
                          generating={genJobs[layer]?.slotId === slot.id}
                          onUpdate={handleSlotUpdate}
                          onError={(msg) => {
                            setPanelError(msg);
                            onError(msg);
                          }}
                          onAskGenerate={() => void startGenerate(layer, slot.id)}
                          onSlotPromptBlur={(id, layerType, value) =>
                            void handleSlotPromptBlur(id, layerType, value)
                          }
                          clothesRef={layer === "clothes" ? slot.clothes_ref : undefined}
                          onClothesRefChange={
                            layer === "clothes"
                              ? (id, nextImage) => handleClothesRefChange(nextImage, id)
                              : undefined
                          }
                        />
                      );
                    })}
                  </Grid>
                </Box>
                );
              })}
            </Flex>
          ) : null}

          {!hasAnyPending && !anyGenBusy && !hasAnyLayer ? (
            <Text color="gray" size="2">
              Configure the slots above, then <strong>Generate backgrounds</strong>. Approve those,
              then generate bikinis, then tops.
            </Text>
          ) : null}
        </Flex>
      )}
    </Card>
  );
}

function PromptSaveRow({
  dirty,
  saving,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => Promise<void>;
}) {
  return (
    <Flex align="center" gap="2" wrap="wrap">
      <Button
        disabled={saving}
        size="1"
        type="button"
        variant={dirty ? "solid" : "soft"}
        onClick={() => void onSave().catch(() => undefined)}
      >
        {saving ? "Saving…" : "Save prompts"}
      </Button>
      <Text color={dirty ? "orange" : "gray"} size="1">
        {dirty
          ? "Unsaved — Save or Re-run so the next generation uses this text."
          : "Prompts saved on this card."}
      </Text>
    </Flex>
  );
}

export function RunMode(props: RunModeProps) {
  const { models } = useGenerationCatalog();
  const {
    flow,
    jobs,
    canUseGrok,
    canUseSourceAi,
    canUseWavespeed,
    aiProvider,
    sourceImageModel,
    backgroundVideoModel,
    dressVideoModel,
    enhancePrompt,
    image,
    theme,
    picturePrompts,
    pictureVariationCount,
    pictureCompareMode,
    pictureModels,
    backgroundMotionPrompt,
    dressPrompt,
    dressReferenceImage,
    cardId,
    cardLabel,
    modelId,
    writeWebm,
    compressPreset,
    resolution,
    tracker,
    meshTune,
    faceImage,
    bikiniImage,
    onImageChange,
    onThemeChange,
    onApplyThemeToPrompts,
    onPicturePromptsChange,
    onPictureVariationCountChange,
    onPictureCompareModeChange,
    onPictureModelsChange,
    onBackgroundMotionPromptChange,
    onDressPromptChange,
    onDressReferenceImageChange,
    onCardIdChange,
    onCardLabelChange,
    onWriteWebmChange,
    onCompressPresetChange,
    onTrackerChange,
    onMeshTuneChange,
    onResolutionChange,
    onFaceImageChange,
    onBikiniImageChange,
    onBackgroundVideoModelChange,
    onDressVideoModelChange,
    onEnhancePromptChange,
    promptsDirty,
    draftSaving,
    onSaveDraft,
    onRefreshJobs,
    onRefreshAssets,
    onError,
  } = props;

  const nodeToStepMap = useMemo(() => nodeToStep(flow), [flow]);
  const stepToNodeMap = useMemo(() => stepToNode(flow), [flow]);
  const reviewSteps = useMemo(() => new Set(flow.reviewSteps), [flow.reviewSteps]);

  const [activeNode, setActiveNode] = useState<FlowNodeId>("source");
  const [flowState, setFlowState] = useState<VideoFlowState | null>(null);
  const [flowBusy, setFlowBusy] = useState(false);
  const [manualBackground, setManualBackground] = useState("");
  const [manualForeground, setManualForeground] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [cardMediaRevision, setCardMediaRevision] = useState(0);
  const [manualDress, setManualDress] = useState("");
  const [showMeshAdvanced, setShowMeshAdvanced] = useState(false);
  const [compareTracker, setCompareTracker] = useState<MeshTracker>("cotracker");
  const [themes, setThemes] = useState<ThemeInfo[]>([]);

  useEffect(() => {
    const next = normalizePicturePrompts(picturePrompts, theme);
    if (next.some((text, index) => text !== picturePrompts[index])) {
      onPicturePromptsChange(next);
    }
  }, [onPicturePromptsChange, picturePrompts, theme]);

  useEffect(() => {
    let cancelled = false;
    fetchThemes()
      .then((next) => {
        if (!cancelled) setThemes(next);
      })
      .catch(() => {
        if (!cancelled) setThemes([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const stepJob = useMemo(() => {
    const scoped = jobs.filter(
      (job) => job.kind === "video-flow-step" && job.command[2] === cardId.trim(),
    );
    return (
      scoped.find((job) => job.status === "running" || job.status === "queued") ??
      scoped[0] ??
      null
    );
  }, [jobs, cardId]);

  const meshCandidateJob = useMemo(() => {
    const scoped = jobs.filter(
      (job) => job.kind === "video-flow-mesh-candidate" && job.command[2] === cardId.trim(),
    );
    return (
      scoped.find((job) => job.status === "running" || job.status === "queued") ??
      scoped[0] ??
      null
    );
  }, [jobs, cardId]);

  const meshCandidateRunning =
    meshCandidateJob?.status === "running" || meshCandidateJob?.status === "queued";

  const meshCompareCount = flowState?.mesh_compare?.length ?? 0;
  const meshStepApproved = flowState?.steps.mesh?.status === "approved";
  const meshInReview = flowState?.steps.mesh?.status === "review";
  // Only pin while the user still needs to pick a tracker. After approve, let
  // the pipeline advance to Place symbols / Compress.
  const meshComparePin = meshInReview && meshCompareCount >= 1;

  const [meshFocusOverride, setMeshFocusOverride] = useState(false);
  const shouldPinMesh = meshComparePin && !meshFocusOverride && !meshCandidateRunning;

  const handledStepJobId = useRef("");
  const handledMeshJobId = useRef("");
  // Tracks which card async flow-state fetches belong to.
  const desiredFlowCardIdRef = useRef(cardId.trim());
  // Bumped when the operator approves or rejects, so an older state fetch
  // cannot paint the clip as still waiting and ask for a second approval.
  const flowStateEpochRef = useRef(0);

  const runningStep = useMemo(() => {
    if (!stepJob || stepJob.status === "queued" || stepJob.status === "running") {
      return flowStepFromJobCommand(stepJob?.command ?? []);
    }
    return null;
  }, [stepJob]);

  const staleRunningStep = useMemo(() => {
    if (!runningStep || !flowState) return null;
    return flowState.steps[runningStep]?.status === "locked" ? runningStep : null;
  }, [runningStep, flowState]);

  const activeRunningStep = staleRunningStep ? null : runningStep;

  const effectiveRunningStep: VideoFlowStepKey | null =
    activeRunningStep ?? (meshCandidateRunning ? "mesh" : null);

  const failedStep = useMemo(() => {
    if (stepJob?.status === "failed" || stepJob?.status === "cancelled") {
      return flowStepFromJobCommand(stepJob.command);
    }
    return null;
  }, [stepJob]);

  const applyFlowState = (next: VideoFlowState) => {
    flowStateEpochRef.current += 1;
    setFlowState(next);
  };

  const refreshFlowState = async () => {
    const id = cardId.trim();
    if (!id) {
      setFlowState(null);
      return;
    }
    const epoch = flowStateEpochRef.current;
    try {
      const data = await api<VideoFlowState>(`/api/video-flow/${encodeURIComponent(id)}/state`);
      // Ignore late responses from a previous card or from before an approve.
      if (desiredFlowCardIdRef.current !== id) return;
      if (flowStateEpochRef.current !== epoch) return;
      setFlowState(data);
    } catch (caught) {
      if (desiredFlowCardIdRef.current !== id) return;
      if (flowStateEpochRef.current !== epoch) return;
      setFlowState(null);
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  useEffect(() => {
    const id = cardId.trim();
    desiredFlowCardIdRef.current = id;
    // Don't null flowState here — that flashes every step as Locked while the
    // new card's state loads. Stale responses are ignored via desiredFlowCardIdRef.
    void refreshFlowState();
  }, [cardId]);

  useEffect(() => {
    if (!stepJob) return;
    if (stepJob.status === "succeeded" || stepJob.status === "failed" || stepJob.status === "cancelled") {
      void refreshFlowState();
      const finishedStep = flowStepFromJobCommand(stepJob.command);
      if (stepJob.status === "succeeded" && (finishedStep === "card" || finishedStep === "mesh")) {
        void onRefreshAssets();
      }
      if (
        stepJob.status === "succeeded" &&
        finishedStep &&
        handledStepJobId.current !== stepJob.id
      ) {
        handledStepJobId.current = stepJob.id;
        const nodeId = stepToNodeMap[finishedStep];
        if (nodeId) {
          if (reviewSteps.has(finishedStep) || (finishedStep === "mesh" && tracker === "all")) {
            if (finishedStep === "mesh") setMeshFocusOverride(false);
            setActiveNode(nodeId);
          } else {
            const next = nextPipelineStep(flow, finishedStep);
            const nextNode = next ? stepToNodeMap[next] : undefined;
            if (nextNode) setActiveNode(nextNode);
            else setActiveNode(nodeId);
          }
        }
      }
    }
  }, [flow, reviewSteps, stepJob?.id, stepJob?.status, stepToNodeMap, tracker]);

  useEffect(() => {
    if (stepJob) return;
    if (!meshCandidateJob) return;
    if (
      meshCandidateJob.status === "succeeded" ||
      meshCandidateJob.status === "failed" ||
      meshCandidateJob.status === "cancelled"
    ) {
      void refreshFlowState();
      if (meshCandidateJob.status === "succeeded") {
        void onRefreshAssets();
        if (handledMeshJobId.current !== meshCandidateJob.id) {
          handledMeshJobId.current = meshCandidateJob.id;
          const meshNode = stepToNodeMap.mesh;
          if (meshNode) {
            setMeshFocusOverride(false);
            setActiveNode(meshNode);
          }
        }
      }
    }
  }, [meshCandidateJob?.id, meshCandidateJob?.status, stepJob?.id, stepToNodeMap]);

  useEffect(() => {
    if (!activeRunningStep && !meshCandidateRunning) return;
    const timer = window.setInterval(() => {
      void refreshFlowState();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [activeRunningStep, meshCandidateRunning, cardId]);

  // Intentionally no auto-reject on image change. Draft loads / card switches
  // used to look like edits and wipe published cards. Use Remake step instead.

  useEffect(() => {
    if (failedStep && stepToNodeMap[failedStep]) {
      setActiveNode(stepToNodeMap[failedStep]!);
      return;
    }
    if (shouldPinMesh && stepToNodeMap.mesh) {
      setActiveNode(stepToNodeMap.mesh);
    }
  }, [failedStep, shouldPinMesh, stepToNodeMap]);

  useEffect(() => {
    if (!staleRunningStep || !stepJob) return;
    void (async () => {
      try {
        await api(`/api/jobs/${encodeURIComponent(stepJob.id)}/cancel`, { method: "POST" });
        await onRefreshJobs();
      } catch {
        // Ignore — job may have finished between render and cancel.
      }
    })();
  }, [staleRunningStep, stepJob?.id, onRefreshJobs]);

  const nodeStates = useMemo(
    () =>
      resolveFlowNodeStatuses(
        flow,
        flowState,
        Boolean(image),
        cardId.trim(),
        effectiveRunningStep,
        failedStep,
      ),
    [flow, flowState, image, cardId, effectiveRunningStep, failedStep],
  );

  const activeMeta = flow.nodes.find((node) => node.id === activeNode) ?? flow.nodes[0];
  const activeStep = nodeToStepMap[activeNode];
  const jobBusy =
    ((stepJob?.status === "running" || stepJob?.status === "queued") && !staleRunningStep) ||
    meshCandidateRunning ||
    flowBusy;

  const firstActionStep = useMemo(() => {
    if (!flowState) return flow.pipeline[0] ?? null;
    for (const step of flow.pipeline) {
      const status = flowState.steps[step]?.status;
      if (status === "review" || status === "ready") return step;
    }
    return null;
  }, [flow, flowState]);

  const actionStep: VideoFlowStepKey | null = activeStep ?? firstActionStep;
  const actionStatus =
    actionStep && effectiveRunningStep === actionStep
      ? "running"
      : actionStep && failedStep === actionStep
        ? "failed"
        : actionStep
          ? (flowState?.steps[actionStep]?.status ?? "ready")
          : null;
  const actionStepState = actionStep ? flowState?.steps[actionStep] : undefined;
  const actionPreviewArtifacts = actionStepState?.artifacts ?? [];
  const backgroundModel = findGenerationModel(models, "background_video", backgroundVideoModel);
  const dressModel = findGenerationModel(models, "dress_video", dressVideoModel);
  const backgroundOnWavespeed = backgroundModel
    ? backgroundModel.provider === "wavespeed"
    : backgroundVideoModel === "wan-2.2-spicy";
  const dressOnWavespeed = dressModel
    ? dressModel.provider === "wavespeed"
    : isWavespeedDressVideoModel(dressVideoModel);
  const dressTakesReference = dressModel
    ? dressModel.takes_reference_image
    : dressModelTakesReferenceImage(dressVideoModel);
  const actionNeedsGrok =
    (actionStep === "dress" && !dressOnWavespeed) ||
    (actionStep === "background" && !backgroundOnWavespeed);
  const actionNeedsWavespeed =
    (actionStep === "dress" && dressOnWavespeed) ||
    (actionStep === "background" && backgroundOnWavespeed);
  const canUseBackgroundVideo = backgroundOnWavespeed ? canUseWavespeed : canUseGrok;
  const canUseDressVideo = dressOnWavespeed ? canUseWavespeed : canUseGrok;
  const actionIsInteractive =
    actionStep === "symbols" || actionStep === "trim" || actionStep === "boomerang";

  const meshCompareArtifacts = useMemo((): MeshCompareEntry[] => {
    if (flowState?.mesh_compare?.length) {
      return flowState.mesh_compare.flatMap((entry) => {
        const meshTracker = entry.tracker as MeshTracker;
        if (!MESH_TRACKERS.includes(meshTracker)) return [];
        return [{ path: entry.path, tracker: meshTracker, active: entry.active }];
      });
    }
    const artifacts = flowState?.steps.mesh?.artifacts ?? [];
    return artifacts.flatMap((path) => {
      const meshTracker = meshTrackerFromArtifact(path);
      return meshTracker ? [{ path, tracker: meshTracker }] : [];
    });
  }, [flowState?.mesh_compare, flowState?.steps.mesh?.artifacts]);

  const meshCompareReady = meshCompareArtifacts.length >= 1;
  const existingCompareTrackers = useMemo(
    () => new Set(meshCompareArtifacts.map((entry) => entry.tracker)),
    [meshCompareArtifacts],
  );
  const compareTrackerExists = existingCompareTrackers.has(compareTracker);

  useEffect(() => {
    if (MESH_TRACKERS.includes(compareTracker)) return;
    setCompareTracker(MESH_TRACKERS[0]!);
  }, [compareTracker]);

  const meshJobRunning =
    (activeRunningStep === "mesh" &&
      (stepJob?.status === "running" || stepJob?.status === "queued")) ||
    meshCandidateRunning;

  const showStepLoading = Boolean(
    activeStep && LOADING_PANEL_STEPS.has(activeStep) && effectiveRunningStep === activeStep,
  );
  const runningTiming =
    showStepLoading && activeStep ? flowState?.timings?.steps?.[activeStep] : undefined;
  // A finished run still has started_at. Ignore it until this run's stamp replaces it.
  const runningStartedAt =
    runningTiming && typeof runningTiming.started_at === "number" && !runningTiming.ended_at
      ? runningTiming.started_at
      : null;

  const stepPayload = {
    image,
    theme,
    picture_prompts: picturePrompts,
    picture_variation_count: pictureVariationCount,
    picture_compare_mode: pictureCompareMode,
    picture_models: pictureModels,
    background_motion_prompt: backgroundMotionPrompt,
    foreground_motion_prompt: backgroundMotionPrompt,
    dress_prompt: dressPrompt,
    dress_reference_image: dressReferenceImage,
    card_id: cardId.trim(),
    card_label: cardLabel.trim(),
    model_id: modelId.trim(),
    resolution,
    enhance_dress_prompt: enhancePrompt,
    tracker,
    write_webm: writeWebm,
    compress_preset: compressPreset,
    mesh_tune: meshTuneToApi(meshTune),
    source_mode: "upload",
    face_image: faceImage,
    bikini_image: bikiniImage,
    provider: aiProvider,
    image_model: sourceImageModel,
    background_video_model: backgroundVideoModel,
    dress_video_model: dressVideoModel,
  };

  const stepApiReady =
    actionStep === "picture"
      ? canUseSourceAi
      : actionStep === "background"
        ? canUseBackgroundVideo
        : actionStep === "dress"
          ? canUseDressVideo
          : true;

  const cardApproved = Boolean(flowState?.approved?.includes("card"));
  const cardArtifactsReady = Boolean(
    flowState?.steps.card?.artifacts?.filter(Boolean).length === 2,
  );
  const needsSourceImage =
    actionStep === "picture" || actionStep === "background" || actionStep === "dress";

  const canRunActionStep = Boolean(
    actionStep &&
      !actionIsInteractive &&
      cardId.trim() &&
      cardLabel.trim() &&
      (!needsSourceImage || image) &&
      (!actionNeedsGrok || canUseGrok) &&
      (!actionNeedsWavespeed || canUseWavespeed) &&
      stepApiReady &&
      actionStatus === "ready" &&
      !jobBusy,
  );

  const canRegenerateActionStep = Boolean(
    actionStep &&
      !actionIsInteractive &&
      cardId.trim() &&
      cardLabel.trim() &&
      (!needsSourceImage || image) &&
      (!actionNeedsWavespeed || canUseWavespeed) &&
      stepApiReady &&
      !flowBusy &&
      !jobBusy,

  const canRemakeActionStep = Boolean(
    actionStep &&
      cardId.trim() &&
      cardLabel.trim() &&
      (!needsSourceImage || image) &&
      (!actionNeedsGrok || canUseGrok) &&
      (!actionNeedsWavespeed || canUseWavespeed) &&
      stepApiReady &&
      actionStatus === "approved" &&
      !jobBusy,
  );

  const setupPictureStatus = flowState?.steps.picture?.status;
  const setupBackgroundStatus = flowState?.steps.background?.status;
  const pictureAlreadyRan =
    setupPictureStatus === "approved" ||
    setupPictureStatus === "review" ||
    setupBackgroundStatus === "approved" ||
    setupBackgroundStatus === "review";

  const canImportManualClips = Boolean(
    cardId.trim() &&
      cardLabel.trim() &&
      manualBackground.trim() &&
      manualForeground.trim() &&
      !importBusy &&
      !jobBusy,
  );

  async function importManualClips() {
    const id = cardId.trim();
    if (!id || !canImportManualClips) return;
    setImportBusy(true);
    onError("");
    try {
      const next = await api<VideoFlowState>(
        `/api/video-flow/${encodeURIComponent(id)}/import-clips`,
        {
          method: "POST",
          body: JSON.stringify({
            background: manualBackground.trim(),
            foreground: manualForeground.trim(),
            card_label: cardLabel.trim(),
            model_id: modelId.trim(),
          }),
        },
      );
      applyFlowState(next);
      setManualBackground("");
      setManualForeground("");
      await onRefreshAssets();
      selectStep("mesh");
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImportBusy(false);
    }
  }

  const dressUnlocked = Boolean(
    flowState?.steps.dress && flowState.steps.dress.status !== "locked",
  );
  const canImportManualDress = Boolean(
    cardId.trim() && manualDress.trim() && dressUnlocked && !importBusy && !jobBusy,
  );

  async function importManualDress() {
    const id = cardId.trim();
    if (!id || !canImportManualDress) return;
    setImportBusy(true);
    onError("");
    try {
      const next = await api<VideoFlowState>(
        `/api/video-flow/${encodeURIComponent(id)}/import-dress`,
        {
          method: "POST",
          body: JSON.stringify({ foreground: manualDress.trim() }),
        },
      );
      applyFlowState(next);
      setManualDress("");
      await onRefreshAssets();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImportBusy(false);
    }
  }

  async function runStep(
    step: VideoFlowStepKey,
    force = false,
    pictureCount?: PictureVariationCount,
  ) {
    setFlowBusy(true);
    onError("");
    try {
      await onSaveDraft();
      await api<JobInfo>("/api/jobs/video-flow/step", {
        method: "POST",
        body: JSON.stringify({
          ...stepPayload,
          ...(pictureCount ? { picture_variation_count: pictureCount } : {}),
          step,
          force,
        }),
      });
      await onRefreshJobs();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFlowBusy(false);
    }
  }

  function handlePictureCountChange(count: PictureVariationCount) {
    onPictureVariationCountChange(count);
    if (count === pictureVariationCount) return;
    const pictureStatus = flowState?.steps.picture?.status;
    const hasPictures = (flowState?.steps.picture?.artifacts ?? []).some(Boolean);
    if (!hasPictures && pictureStatus !== "approved" && pictureStatus !== "review") return;
    if (effectiveRunningStep === "picture") return;
    void runStep("picture", true, count);
  }

  async function generateMeshCandidate() {
    const id = cardId.trim();
    if (!id) return;
    setFlowBusy(true);
    onError("");
    try {
      await api<JobInfo>("/api/jobs/video-flow/mesh-candidate", {
        method: "POST",
        body: JSON.stringify({
          card_id: id,
          card_label: cardLabel.trim(),
          tracker: compareTracker,
          mesh_tune: meshTuneToApi(meshTune),
          force: true,
        }),
      });
      await onRefreshJobs();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFlowBusy(false);
    }
  }

  async function approveStep(
    step: VideoFlowStepKey,
    meshTracker?: MeshTracker,
    pictureChoice?: number,
  ) {
    if (!cardId.trim()) return;
    setFlowBusy(true);
    onError("");
    try {
      const data = await api<VideoFlowState>(
        `/api/video-flow/${encodeURIComponent(cardId.trim())}/approve`,
        {
          method: "POST",
          body: JSON.stringify({
            step,
            ...(meshTracker ? { mesh_tracker: meshTracker } : {}),
            ...(pictureChoice ? { picture_choice: pictureChoice } : {}),
          }),
        },
      );
      applyFlowState(data);
      const next = nextPipelineStep(flow, step);
      if (next && data.steps[next]?.status === "ready") {
        const nodeId = stepToNodeMap[next];
        if (nodeId) {
          // Leaving mesh after approve — don't let compare-pin yank us back.
          if (step === "mesh") setMeshFocusOverride(true);
          setActiveNode(nodeId);
        }
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFlowBusy(false);
    }
  }

  async function approveFocusClip() {
    if (!actionStep) return;
    await approveStep(actionStep);
  }

  async function rejectStep(step: VideoFlowStepKey) {
    if (!cardId.trim()) return;
    setFlowBusy(true);
    onError("");
    try {
      const data = await api<VideoFlowState>(
        `/api/video-flow/${encodeURIComponent(cardId.trim())}/reject`,
        { method: "POST", body: JSON.stringify({ step }) },
      );
      applyFlowState(data);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFlowBusy(false);
    }
  }

  function stepListStatus(step: VideoFlowStepKey): FlowNodeRuntime {
    const nodeId = stepToNodeMap[step];
    return nodeId ? nodeStates[nodeId] ?? "locked" : "locked";
  }

  function selectStep(step: VideoFlowStepKey | "source") {
    if (step === "source") {
      setMeshFocusOverride(true);
      setActiveNode("source");
      return;
    }
    if (flowState?.steps[step]?.status === "locked") return;
    if (step !== "mesh" && meshComparePin) setMeshFocusOverride(true);
    else if (step === "mesh") setMeshFocusOverride(false);
    const nodeId = stepToNodeMap[step];
    if (nodeId) setActiveNode(nodeId);
  }

  return (
    <Flex direction="column" gap="4">
      <div className="video-flow-run-layout">
        <aside className="video-flow-run-steps">
          <Text size="2" weight="bold" mb="3">
            Pipeline
          </Text>
          <button
            type="button"
            className={["video-flow-run-step", activeNode === "source" ? "is-active" : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={() => selectStep("source")}
          >
            <span className="video-flow-run-step-num">0</span>
            <span className="video-flow-run-step-body">
              <strong>Setup</strong>
              <span>Source image & card id</span>
            </span>
          </button>
          {flow.pipeline.map((step, index) => {
            const status = stepListStatus(step);
            const node = flow.nodes.find((entry) => entry.step === step);
            const badge = flowStepBadge(status);
            const timingLabel = stepTimingLabel(flowState?.timings?.steps?.[step]);
            return (
              <button
                key={step}
                type="button"
                className={[
                  "video-flow-run-step",
                  `is-${status}`,
                  activeStep === step ? "is-active" : "",
                  status === "locked" && step !== "card" ? "is-disabled" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={status === "locked" && step !== "card"}
                onClick={() => selectStep(step)}
              >
                <span className="video-flow-run-step-num">{index + 1}</span>
                <span className="video-flow-run-step-body">
                  <strong>{node?.title ?? step}</strong>
                  <span>{node?.subtitle ?? step}</span>
                  {timingLabel ? (
                    <span className="video-flow-run-step-time">{timingLabel}</span>
                  ) : null}
                </span>
                <Badge color={badge.color} size="1">
                  {badge.label}
                </Badge>
              </button>
            );
          })}
          {typeof flowState?.timings?.total_duration_seconds === "number" ? (
            <div className="video-flow-run-total-time">
              <Text size="1" color="gray" weight="medium">
                {flowState.complete ? "Card created in" : "Time spent so far"}
              </Text>
              <Text size="2" weight="bold">
                {formatTimingDuration(flowState.timings.total_duration_seconds)}
                <Text size="1" color="gray" weight="regular">
                  {" "}
                  active step time
                </Text>
              </Text>
              {typeof flowState.timings.flow_started_at === "number" ? (
                <Text size="1" color="gray">
                  Started {formatTimingDateTime(flowState.timings.flow_started_at)}
                </Text>
              ) : null}
              {typeof flowState.timings.completed_at === "number" ? (
                <Text size="1" color="gray">
                  Finished {formatTimingDateTime(flowState.timings.completed_at)}
                  {typeof flowState.timings.total_elapsed_seconds === "number"
                    ? ` · ${formatTimingDuration(flowState.timings.total_elapsed_seconds)} start to finish`
                    : ""}
                </Text>
              ) : null}
            </div>
          ) : null}
        </aside>

        <section className="video-flow-run-detail">
          {staleRunningStep && stepJob ? (
            <Callout.Root color="orange" mb="4">
              <Callout.Text>
                A background job for{" "}
                <strong>{flowState?.steps[staleRunningStep]?.label ?? staleRunningStep}</strong> is
                out of date — finish approving the earlier steps first. Cancelling it…
              </Callout.Text>
            </Callout.Root>
          ) : null}
          {actionStatus === "review" &&
          actionStep &&
          reviewSteps.has(actionStep) &&
          actionStep !== "trim" &&
          actionStep !== "boomerang" ? (
            <Callout.Root color="amber" className="flow-review-panel" mb="4">
              <Callout.Text weight="bold">
                {actionStep === "picture"
                  ? "Pick one picture."
                  : "Approve this clip before the next step runs."}
              </Callout.Text>
              <Flex direction="column" gap="3" mt="3">
                {actionStep === "picture" &&
                (actionPreviewArtifacts.length > 0
                  ? actionPreviewArtifacts
                  : flowState?.steps.picture?.artifacts ?? []
                ).some((artifact) => pictureChoiceFromArtifact(artifact) != null) ? null : (
                  (actionPreviewArtifacts.length > 0
                    ? actionPreviewArtifacts
                    : flowState?.steps[actionStep]?.artifacts ?? []
                  ).map((artifact) => (
                    <MediaPreview
                      key={artifact}
                      label={artifact.split("/").pop() ?? "Generated clip"}
                      type={previewMediaType(artifact)}
                      value={artifact}
                      zoomable={previewMediaType(artifact) === "image"}
                    />
                  ))
                )}
                <Flex align="center" gap="2" wrap="wrap">
                  {actionStep === "picture" &&
                  (flowState?.steps.picture?.artifacts ?? []).some(
                    (artifact) => pictureChoiceFromArtifact(artifact) != null,
                  ) ? null : (
                    <Button disabled={flowBusy} type="button" onClick={() => void approveFocusClip()}>
                      <Check {...iconProps} />
                      {actionStep === "picture" ? "Use this picture" : "Use this clip"}
                    </Button>
                  )}
                  <Button
                    disabled={!canRegenerateActionStep}
                    type="button"
                    color="red"
                    variant="soft"
                    onClick={() => actionStep && void runStep(actionStep, true)}
                  >
                    {actionStep === "picture" ? "Generate again" : "Re-run step"}
                  </Button>
                </Flex>
              </Flex>
            </Callout.Root>
          ) : null}

          {flowState?.recovered_approvals ? (
            <Callout.Root color="green" mb="4">
              <Callout.Text>
                Your bikini clip, dress edit, and card were still on disk — pipeline approvals
                were restored automatically. You only need to retry the step that failed.
              </Callout.Text>
            </Callout.Root>
          ) : null}

          {actionStatus === "failed" && stepJob?.logs.length ? (
            <Callout.Root color="red" mb="4">
              <Callout.Text>
                {formatStepJobError(stepJob.logs[stepJob.logs.length - 1], actionStep)}
              </Callout.Text>
            </Callout.Root>
          ) : null}

          <div className="flow-editor">
            <div className="flow-editor-head">
              <Flex align="center" gap="2">
                <Badge color="gray">{activeMeta.kind}</Badge>
                <Heading size="4">{activeMeta.title}</Heading>
              </Flex>
              <Text color="gray" size="2">
                {activeMeta.description}
              </Text>
            </div>

        {!showStepLoading && activeStep && flowState?.steps[activeStep]?.status === "approved" ? (
          <Callout.Root color="blue" mb="4">
            <Callout.Text>
              {activeStep === "boomerang" ? (
                <>
                  This step is finished. Use the controls below to make a boomerang or keep the
                  clips as-is.
                  {cardApproved ? " Changing the clips means you should run Finalize again." : null}
                </>
              ) : activeStep === "picture" ? (
                <>
                  Pick one of the pictures below. Each card has <strong>Use this picture</strong>.
                  Remake only if you want a new set.
                </>
              ) : (
                <>
                  This step is finished. Edit the prompt above if you want a different result, then
                  click <strong>Remake step</strong>. Steps after this one will need to run again.
                </>
              )}
            </Callout.Text>
          </Callout.Root>
        ) : null}

        {showStepLoading && activeStep ? (
          <StepRunningPanel
            hint={STEP_RUNNING_HINT[activeStep] ?? "This step is running."}
            label={flowState?.steps[activeStep]?.label ?? activeMeta.title}
            logs={stepJob?.logs ?? []}
            startedAt={runningStartedAt}
          />
        ) : null}

        {activeNode === "source" ? (
          <Flex direction="column" gap="4">
            <InfluencerPositionGuide />
            <Field label="Source image path or URL">
              <FilePathPicker
                accept="image/*"
                placeholder="Pick an image or paste a path/URL"
                preview="image"
                previewLabel="Source image"
                previewSize="compact"
                previewZoomable
                value={image}
                onChange={onImageChange}
                onError={onError}
              />
            </Field>

            <Field label="Bikini model (optional — dress her in this swimsuit)">
              <Flex direction="column" gap="1">
                <FilePathPicker
                  accept="image/*"
                  placeholder="Pick a bikini photo or paste a path/URL"
                  preview="image"
                  previewLabel="Bikini model"
                  previewSize="compact"
                  previewZoomable
                  value={bikiniImage}
                  onChange={onBikiniImageChange}
                  onError={onError}
                />
                <Text color="gray" size="1">
                  If the source photo is already the bikini you want, leave this empty. Otherwise
                  Create picture dresses her in this swimsuit before you approve it, and
                  photo-scratch bikinis use it too.
                </Text>
              </Flex>
            </Field>

            <Field label="Her face — identity reference (used by all AI generations)">
              <Flex direction="column" gap="1">
                <FilePathPicker
                  accept="image/*"
                  placeholder="Pick a clear face photo or paste a path/URL"
                  preview="image"
                  previewLabel="Face reference"
                  previewSize="compact"
                  previewZoomable
                  value={faceImage}
                  onChange={onFaceImageChange}
                  onError={onError}
                />
                <Text color="gray" size="1">
                  Create picture and every photo-scratch generation send this photo as a face
                  reference and face-lock the result, so her face stays the same across all cards
                  and slots.
                </Text>
              </Flex>
            </Field>

            {pictureAlreadyRan ? (
              <Callout.Root color="blue">
                <Callout.Text>
                  A picture already exists. Open Create picture to change the variations, then
                  remake it and approve it before image-to-video runs again.
                </Callout.Text>
              </Callout.Root>
            ) : null}

            <Grid columns={{ initial: "1", md: "2" }} gap="3">
              <Field label="Card id (work folder)">
                <TextField.Root
                  placeholder="janja_1"
                  value={cardId}
                  onChange={(event) => onCardIdChange(event.currentTarget.value)}
                />
              </Field>
              <Field label="Card label">
                <TextField.Root
                  placeholder="Janja 1"
                  value={cardLabel}
                  onChange={(event) => onCardLabelChange(event.currentTarget.value)}
                />
              </Field>
            </Grid>
            <Field label="Theme (scenery + dress-up costume)">
              {themes.length > 0 ? (
                <ThemeSelect themes={themes} value={theme} onChange={onThemeChange} />
              ) : (
                <Text color="gray" size="2">
                  Loading themes… or create one at{" "}
                  <a href="/dashboard/themes">Dashboard → Themes</a>.
                </Text>
              )}
            </Field>
            <Flex gap="2" align="center" wrap="wrap">
              <Button type="button" size="1" variant="soft" onClick={onApplyThemeToPrompts}>
                Apply theme to prompts
              </Button>
              <Text color="gray" size="2">
                Rewrites the three picture prompts, background scenery, and dress costume from the theme.
                With a dress reference image attached, the dress prompt matches that reference.
                Hand-edited prompts stay until you click Apply.
              </Text>
            </Flex>
            <Flex>
              <Button
                disabled={!cardId.trim() || !image}
                type="button"
                onClick={() => {
                  const nodeId = stepToNodeMap.picture;
                  if (nodeId) setActiveNode(nodeId);
                }}
              >
                Create picture
              </Button>
            </Flex>
          </Flex>
        ) : null}

        {!showStepLoading && activeNode === "picture" ? (
          <Flex direction="column" gap="4">
            <InfluencerPositionGuide />
            <Text color="gray" size="2">
              Choose 1, 2, or 3. Compare different prompts on one model, or the same prompt on
              different image models. Pick one as soon as it appears — you do not have to wait for
              the rest. Every still keeps the influencer position.
            </Text>
            {effectiveRunningStep === "picture" ? (
              <Callout.Root color="blue">
                <Callout.Text>
                  Making {pictureVariationCount} picture{pictureVariationCount === 1 ? "" : "s"}
                  {pictureCompareMode === "models" ? " across models" : ""}. Use a picture as soon
                  as it shows up.
                </Callout.Text>
              </Callout.Root>
            ) : null}
            <PicturePromptFields
              prompts={picturePrompts}
              onPromptsChange={onPicturePromptsChange}
              variationCount={pictureVariationCount}
              onVariationCountChange={handlePictureCountChange}
              compareMode={pictureCompareMode}
              onCompareModeChange={onPictureCompareModeChange}
              pictureModels={pictureModels}
              onPictureModelsChange={onPictureModelsChange}
            />
            <PromptSaveRow dirty={promptsDirty} saving={draftSaving} onSave={onSaveDraft} />
            {flowState?.steps.picture?.status === "approved" &&
            !(flowState.steps.picture.artifacts ?? []).some(Boolean) ? (
              <Callout.Root color="blue">
                <Callout.Text>
                  This card was animated before the picture step existed. Remake to generate three
                  stills, pick one, then run image-to-video again.
                </Callout.Text>
              </Callout.Root>
            ) : null}
            {!canUseSourceAi ? (
              <Text color="gray" size="2">
                Add XAI_API_KEY or WAVESPEED_API_KEY to .env before generating the picture.
              </Text>
            ) : null}
          </Flex>
        ) : null}

        {!showStepLoading && activeNode === "background" ? (
          <Flex direction="column" gap="4">
            <Callout.Root color="blue">
              <Callout.Text>
                Image to video animates the approved picture. To change bikini, face, or scenery,
                remake <strong>Create picture</strong> and approve it first.
              </Callout.Text>
            </Callout.Root>
            <Field label="Video model">
              <GenerationModelSelect
                role="background_video"
                value={backgroundVideoModel}
                models={models}
                onValueChange={onBackgroundVideoModelChange}
              />
            </Field>
            <Field label="Video resolution">
              <Select.Root
                value={resolution || "default"}
                onValueChange={(value) => onResolutionChange(value === "default" ? "" : value)}
              >
                <Select.Trigger />
                <Select.Content>
                  <Select.Item value="720p">720p</Select.Item>
                  <Select.Item value="480p">480p</Select.Item>
                  {!backgroundOnWavespeed ? (
                    <Select.Item value="default">Default</Select.Item>
                  ) : null}
                </Select.Content>
              </Select.Root>
            </Field>
            <Field label="Bikini background prompt (animates the approved picture — approve before fix frames)">
              <TextArea
                className="dashboard-textarea"
                value={backgroundMotionPrompt}
                onChange={(event) => onBackgroundMotionPromptChange(event.currentTarget.value)}
              />
            </Field>
            <PromptSaveRow dirty={promptsDirty} saving={draftSaving} onSave={onSaveDraft} />
            <Text color="gray" size="2">
              Theme scenery is baked in Create picture. This step only animates that approved
              still. Locked camera + skin continuity are enhanced when XAI_API_KEY is set. Click
              Apply theme on Setup if the prompt still looks like the old blank-wall wording.
            </Text>
          </Flex>
        ) : null}

        {activeNode === "trim" ? (
          <TrimFramesPanel
            cardId={cardId.trim()}
            busy={jobBusy}
            onBusy={setFlowBusy}
            onError={onError}
            onState={applyFlowState}
          />
        ) : null}

        {!showStepLoading && activeNode === "dress" ? (
          <Flex direction="column" gap="4">
            <Callout.Root color="orange">
              <Callout.Text size="2">
                Step 3 edits your approved (trimmed) bikini clip in place. x.ai Grok scans every
                frame of that video for moderation — a modest dress prompt can still fail. Use a{" "}
                <strong>WaveSpeed</strong> video edit model to avoid that scan, or upload your own
                dress video below.
              </Callout.Text>
            </Callout.Root>
            <Field label="Step 3 video model">
              <GenerationModelSelect
                role="dress_video"
                value={dressVideoModel}
                models={models}
                onValueChange={onDressVideoModelChange}
              />
            </Field>
            <Text color="gray" size="1">
              <a href="/dashboard/ai-models">Manage AI models</a> to rename one or add a provider model.
            </Text>
            {!canUseDressVideo ? (
              <Text color="gray" size="2">
                {dressOnWavespeed
                  ? "Add WAVESPEED_API_KEY to .env first."
                  : "Add XAI_API_KEY to .env first."}
              </Text>
            ) : null}
            <Field label="Dress-up edit prompt (video edit on approved background — same scenery)">
              <TextArea
                className="dashboard-textarea"
                value={dressPrompt}
                onChange={(event) => onDressPromptChange(event.currentTarget.value)}
              />
            </Field>
            <PromptSaveRow dirty={promptsDirty} saving={draftSaving} onSave={onSaveDraft} />
            <Button type="button" size="1" variant="soft" onClick={onApplyThemeToPrompts}>
              Apply theme to dress prompt
            </Button>
            <Field
              label={
                dressTakesReference
                  ? `Dress reference image (optional — sent to the model as ${dressModel?.reference_token || "Image 1"})`
                  : "Dress reference image (optional — captioned into prompt for WAN 2.2 & Grok)"
              }
            >
              <FilePathPicker
                accept="image/*"
                placeholder="Pick a dress photo or paste a path/URL"
                preview="image"
                previewLabel="Dress reference"
                previewSize="compact"
                value={dressReferenceImage}
                onChange={onDressReferenceImageChange}
                onError={onError}
              />
            </Field>
            {dressReferenceImage.trim() ? (
              <Text color="gray" size="2">
                {dressModelTakesReferenceImage(dressVideoModel)
                  ? "The image is attached to the edit and the prompt tells the model to copy that outfit."
                  : "Reference is captioned and appended after prompt enhance so the outfit match wins."}{" "}
                Click Apply theme if the dress prompt still looks generic.
              </Text>
            ) : null}
            <label className="checkbox-label">
              <Checkbox
                checked={enhancePrompt}
                disabled={dressOnWavespeed && !canUseGrok}
                onCheckedChange={(checked) => onEnhancePromptChange(checked === true)}
              />
              Enhance dress prompt with Grok chat before video edit
            </label>
            <Text color="gray" size="2">
              Edits the approved background clip frame-for-frame — same scenery, motion, and
              subject scale; only the outfit changes.
              {dressOnWavespeed
                ? enhancePrompt && canUseGrok
                  ? " The WaveSpeed edit uses a Grok-enhanced prompt (locked framing)."
                  : " The WaveSpeed edit uses your prompt as written unless Grok enhancement is on with XAI_API_KEY."
                : ` Prompt enhancement is ${enhancePrompt ? "on" : "off"}.`}
            </Text>

            <Separator size="4" />
            <Heading as="h3" size="3">
              Or upload your own dress video
            </Heading>
            <Text color="gray" size="2">
              Use a hand-made foreground clip instead of an AI edit. It is aligned to the approved
              bikini clip (size and duration), then lands in review — approve it like an AI result.
              Uploading replaces any current step 3 result and resets the later steps.
            </Text>
            <Field label="Foreground video (dress / scratch layer)">
              <FilePathPicker
                accept="video/*"
                placeholder="Pick a dress video or paste a path"
                preview="video"
                previewLabel="foreground"
                previewSize="compact"
                value={manualDress}
                onChange={setManualDress}
                onError={onError}
              />
            </Field>
            <Flex align="center" gap="3" wrap="wrap">
              <Button
                disabled={!canImportManualDress}
                type="button"
                variant="soft"
                onClick={() => void importManualDress()}
              >
                {importBusy ? <Loader2 {...iconProps} className="spin" /> : <Play {...iconProps} />}
                Use this video for step 3
              </Button>
              {!dressUnlocked ? (
                <Text color="gray" size="2">
                  Approve Fix frames first.
                </Text>
              ) : null}
            </Flex>
          </Flex>
        ) : null}

        {activeNode === "boomerang" ? (
          <BoomerangPanel
            cardId={cardId.trim()}
            cardLabel={cardLabel.trim()}
            report={flowState?.boomerang ?? null}
            cardApproved={cardApproved}
            busy={importBusy || jobBusy}
            onBusy={setImportBusy}
            onError={onError}
            onState={applyFlowState}
            onClipsChanged={() => setCardMediaRevision(Date.now())}
          />
        ) : null}

        {!showStepLoading && activeNode === "compress" ? (
          <Flex direction="column" gap="4">
            <Callout.Root color="blue">
              <Callout.Text size="2">
                Finalize aligns foreground timing to the bikini motion clip, backs up the raw card
                videos, then <strong>cover-crops both clips to a fixed 390∶672 canvas</strong> (same
                aspect as the scratch prototype). Every card gets the same frame size — no more
                540×822 vs 540×706 mismatches.
              </Callout.Text>
            </Callout.Root>
            <Field label="Delivery preset">
              <Select.Root
                value={compressPreset}
                onValueChange={(value) => onCompressPresetChange(value as CompressPreset)}
              >
                <Select.Trigger />
                <Select.Content>
                  {COMPRESS_PRESETS.map((entry) => (
                    <Select.Item key={entry.id} value={entry.id}>
                      {entry.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Field>
            <Text color="gray" size="2">
              {COMPRESS_PRESETS.find((entry) => entry.id === compressPreset)?.detail}
            </Text>
            <label className="checkbox-label">
              <Checkbox
                checked={writeWebm}
                onCheckedChange={(checked) => onWriteWebmChange(checked === true)}
              />
              Also write VP9 WebM sidecars (better browser fallback)
            </label>
            <Text color="gray" size="2">
              Originals are copied to <Code>.video-backups/</Code> before overwrite. A size report is
              saved under the project work folder after each run.
            </Text>
            {flowState?.compress_report ? (
              <CompressReportPanel report={flowState.compress_report} />
            ) : null}
          </Flex>
        ) : null}

        {!showStepLoading && activeNode === "card" ? (
          <Flex direction="column" gap="4">
            <Text size="2">
              Skip Setup through Create card by uploading both clips yourself. They are copied to{" "}
              <Code>public/cards/{cardId || "<id>"}/</Code> and mesh unlocks next.
            </Text>
            <Callout.Root color="blue">
              <Callout.Text>
                <strong>background.mp4</strong> is the revealed bikini layer.{" "}
                <strong>foreground.mp4</strong> is the dress layer you scratch through.
              </Callout.Text>
            </Callout.Root>
            <Field label="Background video (bikini / revealed)">
              <FilePathPicker
                accept="video/*"
                placeholder="Pick background.mp4 or paste a path"
                preview="video"
                previewLabel="background.mp4"
                previewSize="compact"
                value={manualBackground}
                onChange={setManualBackground}
                onError={onError}
              />
            </Field>
            <Field label="Foreground video (dress / scratch layer)">
              <FilePathPicker
                accept="video/*"
                placeholder="Pick foreground.mp4 or paste a path"
                preview="video"
                previewLabel="foreground.mp4"
                previewSize="compact"
                value={manualForeground}
                onChange={setManualForeground}
                onError={onError}
              />
            </Field>
            <Flex align="center" gap="3" wrap="wrap">
              <Button
                disabled={!canImportManualClips}
                type="button"
                onClick={() => void importManualClips()}
              >
                {importBusy ? <Loader2 {...iconProps} className="spin" /> : <Play {...iconProps} />}
                {cardApproved && cardArtifactsReady
                  ? "Replace clips & unlock mesh"
                  : "Import clips & unlock mesh"}
              </Button>
              {!cardId.trim() || !cardLabel.trim() ? (
                <Text color="gray" size="2">
                  Set card id and label in Setup first.
                </Text>
              ) : null}
            </Flex>
            {cardApproved && cardArtifactsReady ? (
              <>
                <Text color="gray" size="2">
                  Card already published. Re-importing replaces both videos and keeps mesh ready.
                  Change the loop on the Boomerang step.
                </Text>
              </>
            ) : cardApproved && !cardArtifactsReady ? (
              <Callout.Root color="amber">
                <Callout.Text>
                  Card is marked done but <Code>public/cards/{cardId || "<id>"}/</Code> is missing
                  the videos. Click <strong>Run step</strong> to republish from the approved
                  clips, or import both files above.
                </Callout.Text>
              </Callout.Root>
            ) : (
              <Text color="gray" size="2">
                Or run the AI pipeline (Setup → Create picture → image to video → dress →
                Boomerang → Create card)
                instead.
              </Text>
            )}
          </Flex>
        ) : null}

        {activeNode === "mesh" ? (
          <Flex direction="column" gap="4">
            <Field label="Mesh tracker">
              <Select.Root value={tracker} onValueChange={(value) => onTrackerChange(value as MeshTrackerMode)}>
                <Select.Trigger />
                <Select.Content>
                  {MESH_TRACKER_MODES.map((entry) => (
                    <Select.Item key={entry} value={entry}>
                      {meshTrackerModeLabel(entry)}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Field>

            <button
              type="button"
              className="video-flow-advanced-toggle"
              onClick={() => setShowMeshAdvanced((value) => !value)}
            >
              <ChevronDown
                {...iconProps}
                style={{ transform: showMeshAdvanced ? "rotate(180deg)" : undefined }}
              />
              Advanced options — mesh quality tuning
            </button>

            {showMeshAdvanced ? (
              <Box pt="3">
                <MeshTunePanel value={meshTune} onChange={onMeshTuneChange} />
              </Box>
            ) : null}

            <Callout.Root color="blue">
              <Callout.Text size="2">
                <strong>Two things you can change:</strong> (1) Tuning sliders in{" "}
                <strong>Advanced options</strong> → then <strong>Remake step</strong> or{" "}
                <strong>Regenerate</strong> below. (2) Scratch mask → <strong>Erase</strong> brush on
                bad zones, then <strong>Save mask</strong>. You cannot drag mesh points — folded
                triangles are tracking limits on this clip.
              </Callout.Text>
            </Callout.Root>

            {meshJobRunning ? (
              <MeshJobProgress logs={(meshCandidateRunning ? meshCandidateJob : stepJob)?.logs ?? []} />
            ) : null}

            {meshCompareReady && flowState?.steps.mesh?.status === "review" ? (
              <MeshTrackerComparePanel
                artifacts={meshCompareArtifacts}
                cardId={cardId.trim()}
                jobBusy={jobBusy}
                meshApproved={false}
                onApprove={(meshTracker) => void approveStep("mesh", meshTracker)}
                onReject={() => void rejectStep("mesh")}
                onError={onError}
              />
            ) : null}

            {meshStepApproved ? (
              <>
                {meshCompareArtifacts.length < 2 ? (
                  <>
                    <Separator size="4" />
                    <MaskEditor
                      title="Scratch mask"
                      meshFile={`${cardId.trim()}.json`}
                      meshUrl={`/mesh/${encodeURIComponent(cardId.trim())}.json`}
                      videoSrc={`/cards/${encodeURIComponent(cardId.trim())}/foreground.mp4`}
                      onError={onError}
                    />
                  </>
                ) : null}

                <Separator size="4" />
                <Field label="Regenerate a tracker (uses tuning above)">
                  <Flex align="center" gap="3" wrap="wrap">
                    <Select.Root
                      value={compareTracker}
                      onValueChange={(value) => setCompareTracker(value as MeshTracker)}
                      disabled={meshCandidateRunning}
                    >
                      <Select.Trigger />
                      <Select.Content>
                        {MESH_TRACKERS.map((entry) => (
                          <Select.Item key={entry} value={entry}>
                            {entry}
                            {existingCompareTrackers.has(entry) ? " (exists)" : ""}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                    <Button
                      disabled={jobBusy || meshCandidateRunning}
                      type="button"
                      onClick={() => void generateMeshCandidate()}
                    >
                      <Play {...iconProps} />
                      {compareTrackerExists ? "Regenerate" : "Generate compare"}
                    </Button>
                  </Flex>
                </Field>
                <Text color="gray" size="2">
                  Pick a tracker and run — overwrites that candidate with your current tuning. Use the
                  compare tabs below to preview, <strong>Erase</strong> bad scratch zones, save, then{" "}
                  <strong>Use …</strong> to publish.
                </Text>

                {meshCompareArtifacts.length >= 2 ? (
                  <MeshTrackerComparePanel
                    artifacts={meshCompareArtifacts}
                    cardId={cardId.trim()}
                    jobBusy={jobBusy}
                    meshApproved
                    onApprove={(meshTracker) => void approveStep("mesh", meshTracker)}
                    onError={onError}
                  />
                ) : null}
              </>
            ) : null}

            {!meshJobRunning &&
            !meshCompareReady &&
            flowState?.steps.mesh?.status !== "approved" ? (
              <Callout.Root color="blue">
                <Callout.Text>
                  Choose <strong>All (compare &amp; pick)</strong>, then generate the mesh — it
                  usually takes several minutes and logs will appear here.
                </Callout.Text>
                <Flex mt="3">
                  <Button
                    disabled={!canRunActionStep}
                    type="button"
                    onClick={() => void runStep("mesh", false)}
                  >
                    <Play {...iconProps} />
                    Generate mesh
                  </Button>
                </Flex>
              </Callout.Root>
            ) : null}
          </Flex>
        ) : null}

        {activeNode === "symbols" ? (
          <SymbolPointPicker
            cardId={cardId.trim()}
            foregroundVideo={`/cards/${encodeURIComponent(cardId.trim())}/foreground.mp4`}
            meshJsonPath={`/mesh/${encodeURIComponent(cardId.trim())}.json`}
            onSaved={(nextState) => {
              applyFlowState(nextState as VideoFlowState);
              const next = nextPipelineStep(flow, "symbols");
              if (next && (nextState.steps[next]?.status === "ready" || nextState.steps[next]?.status === "approved")) {
                const nodeId = stepToNodeMap[next];
                if (nodeId) setActiveNode(nodeId);
              }
            }}
            onError={onError}
          />
        ) : null}

        {(() => {
          if (showStepLoading) return null;
          if (!activeStep || activeStep === "symbols" || activeStep === "mesh" || activeStep === "trim") {
            return null;
          }
          const stepStatus = flowState?.steps[activeStep]?.status;
          const fromState = (flowState?.steps[activeStep]?.artifacts ?? []).filter(Boolean);
          const id = cardId.trim();
          // Only fall back to published card videos after a step has produced
          // something (approved/review). "Ready" means not run yet — don't show
          // a missing public/cards/... path as a failed player.
          const fallback =
            fromState.length === 0 &&
            id &&
            (stepStatus === "approved" || stepStatus === "review")
              ? activeStep === "background"
                ? [`public/cards/${id}/background.mp4`]
                : activeStep === "dress"
                  ? [`public/cards/${id}/foreground.mp4`]
                  : activeStep === "card" || activeStep === "compress"
                    ? [
                        `public/cards/${id}/background.mp4`,
                        `public/cards/${id}/foreground.mp4`,
                      ]
                    : []
              : [];
          const artifacts = fromState.length ? fromState : fallback;
          if (!artifacts.length) return null;
          const pictureLabel = (artifact: string) => {
            const choice = pictureChoiceFromArtifact(artifact);
            if (choice == null) return artifact.split("/").pop() ?? "Result";
            if (pictureCompareMode === "models") {
              const modelId = pictureModels[choice - 1] || sourceImageModel;
              const model = findGenerationModel(models, "source_image", modelId);
              return model?.label || modelId || `Picture ${choice}`;
            }
            return `Prompt ${choice}`;
          };
          const pictureChoices =
            activeStep === "picture"
              ? artifacts.filter((artifact) => pictureChoiceFromArtifact(artifact) != null)
              : [];
          const otherArtifacts =
            activeStep === "picture"
              ? artifacts.filter((artifact) => pictureChoiceFromArtifact(artifact) == null)
              : artifacts;
          const preview = (artifact: string) => (
            <MediaPreview
              key={`${artifact}:${cardMediaRevision}`}
              label={activeStep === "picture" ? pictureLabel(artifact) : (artifact.split("/").pop() ?? "Result")}
              type={previewMediaType(artifact)}
              value={artifact}
              zoomable={previewMediaType(artifact) === "image"}
              cacheBust={cardMediaRevision || flowState?.boomerang?.applied_at}
              headerAction={
                activeStep === "picture" && pictureChoiceFromArtifact(artifact) != null ? (
                  <Button
                    disabled={flowBusy || flowState?.picture_choice === pictureChoiceFromArtifact(artifact)}
                    size="1"
                    type="button"
                    onClick={() => {
                      const choice = pictureChoiceFromArtifact(artifact);
                      if (choice) void approveStep("picture", undefined, choice);
                    }}
                  >
                    <Check {...iconProps} />
                    {flowState?.picture_choice === pictureChoiceFromArtifact(artifact)
                      ? "In use"
                      : "Use this picture"}
                  </Button>
                ) : null
              }
            />
          );
          return (
            <Flex direction="column" gap="3" mt="3">
              {pictureChoices.length ? (
                <div className="picture-pick-grid">
                  {pictureChoices.map((artifact) => (
                    <div className="picture-pick-card" key={artifact}>
                      {preview(artifact)}
                    </div>
                  ))}
                </div>
              ) : null}
              {otherArtifacts.map((artifact) =>
                artifact.endsWith("compress-report.json") ? (
                  <Text key={artifact} size="2">
                    Delivery report: <Code className="dashboard-code">{artifact}</Code>
                  </Text>
                ) : artifact.endsWith(".json") ? (
                  <Text key={artifact} size="2">
                    Mesh written to <Code className="dashboard-code">{artifact}</Code>
                  </Text>
                ) : (
                  preview(artifact)
                ),
              )}
            </Flex>
          );
        })()}
      </div>

      <div className="flow-run-bar">
        <Flex direction="column" gap="3" style={{ flex: 1 }}>
          {activeNode === "source" ? (
            <Text size="2">
              Setup — open Create picture, choose 1, 2, or 3 variations, then make the stills.
            </Text>
          ) : actionStep && flowState ? (
            <Text size="2" weight="medium">
              {flowState.steps[actionStep].label}
              {actionStatus === "review" && reviewSteps.has(actionStep)
                ? actionStep === "picture"
                  ? " — pick one of the three pictures"
                  : actionStep === "trim"
                    ? " — drop white frames or keep the clip, then continue"
                    : actionStep === "boomerang"
                      ? " — make a boomerang or keep the clips, then continue"
                      : " — watch the clip, then continue"
                : actionStatus === "review" && actionStep === "mesh"
                  ? " — compare trackers and pick one"
                  : actionStatus === "ready"
                  ? actionStep === "trim"
                    ? " — delete white frames (or keep as-is) in the Fix frames panel"
                    : actionStep === "boomerang"
                      ? " — make a boomerang or keep the clips as-is"
                      : actionIsInteractive
                      ? " — place points on the mesh, then save"
                      : " — ready to run"
                  : actionStatus === "approved"
                    ? actionStep === "boomerang"
                      ? " — done"
                      : " — done (remake to regenerate)"
                    : actionStatus === "running" || jobBusy
                      ? " — running…"
                      : ""}
            </Text>
          ) : activeNode === "card" ? (
            <Text size="2">
              Create card — upload both videos to skip the AI steps, or run after Boomerang is
              approved.
            </Text>
          ) : (
            <Text size="2">Select a pipeline step to run or remake.</Text>
          )}
        </Flex>

        <Flex align="center" gap="2" wrap="wrap">
          {actionStatus === "review" &&
          actionStep &&
          (!reviewSteps.has(actionStep) || actionStep === "trim" || actionStep === "boomerang") ? (
            <Button disabled={flowBusy} type="button" onClick={() => void approveFocusClip()}>
              {actionStep === "trim" || actionStep === "boomerang" ? <Check {...iconProps} /> : null}
              Continue
            </Button>
          ) : null}

          {activeNode !== "source" &&
          actionStatus === "ready" &&
          actionStep === "compress" &&
          flowState?.compress_report ? (
            <Button disabled={jobBusy} type="button" onClick={() => void approveFocusClip()}>
              <Check {...iconProps} />
              Mark complete
            </Button>
          ) : null}

          {activeNode !== "source" && actionStatus === "ready" && actionIsInteractive && actionStep ? (
            activeStep === actionStep ? null : (
              <Button
                disabled={jobBusy}
                type="button"
                onClick={() => {
                  const nodeId = stepToNodeMap[actionStep];
                  if (nodeId) setActiveNode(nodeId);
                }}
              >
                Open {flowState?.steps[actionStep]?.label ?? actionStep}
              </Button>
            )
          ) : actionStatus === "ready" && activeNode !== "source" ? (
            <Button
              disabled={!canRunActionStep}
              type="button"
              onClick={() => actionStep && void runStep(actionStep, false)}
            >
              <Play {...iconProps} />
              {actionStep === "picture"
                ? "Make picture"
                : actionStep === "compress" && flowState?.compress_report
                  ? "Re-run finalize"
                  : "Run step"}
            </Button>
          ) : null}

          {activeNode !== "source" && actionStatus === "approved" && actionStep && actionStep !== "boomerang" ? (
            <Button
              disabled={!canRemakeActionStep}
              type="button"
              onClick={() => void runStep(actionStep, true)}
            >
              <RotateCcw {...iconProps} />
              Remake step
            </Button>
          ) : null}

          {activeNode !== "source" && actionStatus === "failed" && actionStep ? (
            <Button disabled={jobBusy} type="button" onClick={() => void runStep(actionStep, true)}>
              Retry
            </Button>
          ) : null}

          {flowState?.complete ? <Badge color="green">Flow complete</Badge> : null}
        </Flex>
      </div>
        </section>
      </div>

      {cardId.trim() ? (
        <CardPhotosPanel
          cardId={cardId.trim()}
          theme={theme}
          image={image}
          aiProvider={aiProvider}
          sourceImageModel={sourceImageModel}
          onError={onError}
        />
      ) : null}
    </Flex>
  );
}
