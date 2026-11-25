import { useGSAP } from "@gsap/react";
import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import gsap from "gsap";
import { Check, RotateCcw, SquarePen, Upload } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, uploadFile } from "../shared/api";
import { createMotionCardDraft, fetchModels, type ModelInfo } from "../shared/models";
import { fetchThemes, type ThemeInfo } from "../shared/themes";
import {
  modelsForRole,
  useGenerationCatalog,
  type GenerationModelInfo,
  type GenerationModelRole,
} from "../shared/generationModels";
import {
  liteBackgroundVideoModel,
  liteDressVideoModel,
  liteRequestBody,
  type LiteDraftInput,
} from "../videoFlow/lite/defaults";
import { PROJECT_ID_PATTERN, slugifyProjectId } from "../videoFlow/projects";
import type { VideoFlowStepKey } from "../videoFlow/schema";
import { previewSource } from "../videoFlow/ui";
import chevronUrl from "./assets/icon-chevron.svg";
import providerEvolinkUrl from "./assets/icon-evolink.svg";
import providerWavespeedUrl from "./assets/icon-wavespeed.svg";
import providerXaiUrl from "./assets/icon-xai.svg";
import searchUrl from "./assets/icon-search.svg";
import logoUrl from "./assets/logo-sugar-scratch.svg";
import { Theme } from "@radix-ui/themes";
import { SymbolPointPicker } from "../videoFlow/SymbolPointPicker";
import { LeoFaceCropDialog } from "./LeoFaceCropDialog";
import { LeoMaskEditOverlay } from "./LeoMaskEditOverlay";
import { finishAndPublishCard, runThroughMesh } from "./finishPublish";
import "./leo-cta-css.css";
import "./leo-ui.css";

const LeoTryMotionGame = lazy(() =>
  import("./LeoTryMotionGame").then((m) => ({ default: m.LeoTryMotionGame })),
);

gsap.registerPlugin(useGSAP);

type LeoScreen =
  | "influencer"
  | "theme"
  | "photo"
  | "swimwear"
  | "processing"
  | "confirm"
  | "animating"
  | "animated"
  | "outfit"
  | "dressing"
  | "dressed"
  | "meshing"
  | "mask"
  | "symbols"
  | "created";

type JobInfo = {
  id: string;
  kind: string;
  command: string[];
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
};

type LiteStepState = {
  status: "locked" | "ready" | "review" | "approved";
  artifacts: string[];
};

type LiteFlowState = {
  card_id: string;
  steps: Partial<Record<VideoFlowStepKey, LiteStepState>>;
  complete: boolean;
};

type HealthResponse = {
  xai_key_loaded?: boolean;
  wavespeed_key_loaded?: boolean;
};

type GalleryImage = {
  id: string;
  path: string;
  url: string;
  kind?: string;
};

type SavedDraft = {
  image?: string;
  bikini_image?: string;
  face_image?: string;
  theme?: string;
  card_label?: string;
  model_id?: string;
};

/** Main nav sections (progress dots). Sub-screens share a parent phase. */
const PHASE_COUNT = 9;
const PHASE_DOT_PX = 8;
const PHASE_PILL_W_PX = 30;
const PHASE_PILL_DURATION = 0.5;
/** Wind-up before the slide (squash + slight reverse). */
const PHASE_PILL_ANTICIPATE = 0.12;
const PHASE_PILL_ANTICIPATE_PX = 5;
const PROVIDER_ICONS: Record<string, string> = {
  xai: providerXaiUrl,
  wavespeed: providerWavespeedUrl,
  evolink: providerEvolinkUrl,
};
const SCREEN_ORDER: LeoScreen[] = [
  "influencer",
  "theme",
  "photo",
  "swimwear",
  "processing",
  "confirm",
  "animating",
  "animated",
  "outfit",
  "dressing",
  "dressed",
  "meshing",
  "mask",
  "symbols",
  "created",
];
const PROCESSING_MIN_DWELL_MS = 1200;
/** Auto-advance past processing once the first picture exists (after the reveal beat). */
const PROCESSING_AUTO_ADVANCE = true;
/** Confirm / multi-option pick — set true to auto-use picture-1 and jump to Animating. */
const SKIP_CONFIRM = false;
const PROCESSING_PHOTO_FILTER =
  "grayscale(1) saturate(0) blur(12px) brightness(0.75)";
const PROCESSING_PHOTO_FILTER_CLEAR =
  "grayscale(0) saturate(1) blur(0px) brightness(1)";
/** Meshing preview — color stays, soft blur + half opacity.
 *  Same filter fn list as CLEAR so GSAP can tween blur ↔ sharp. */
const MESHING_PHOTO_FILTER =
  "grayscale(0) saturate(1) blur(12px) brightness(1)";
const MESHING_PHOTO_OPACITY = 0.5;
/** Desaturate + blur beat on enter processing. */
const PROCESSING_BLUR_DURATION = 0.4;
const PROCESSING_HANGER_LOTTIE = "/leo-ui/lottieClothesHanger.lottie";
const ANIMATING_VIDEO_LOTTIE = "/leo-ui/lottieMakeVideo.lottie";
const MESHING_LOTTIE = "/leo-ui/lottieMeshLoad.lottie";
/** Game Created ↔ try-motion: preview out, then game in (and reverse on close). */
const TRY_MOTION_PREVIEW_OUT = 0.34;
const TRY_MOTION_PREVIEW_IN = 0.38;
const TRY_MOTION_STAGE_IN = 0.48;
const TRY_MOTION_STAGE_OUT = 0.36;
/** Max wait for scratch videos before revealing anyway. */
const TRY_MOTION_READY_FALLBACK_MS = 6000;
/** Animating subtitle — slot-machine reel copy. */
const ANIMATING_SLOT_LINES = [
  "Waking up the pixels...",
  "Teaching stillness to dance...",
  "Stitching motion into reality...",
  "Convincing physics to cooperate...",
  "Adding a little cinematic chaos...",
  "Bringing your imagination to life..",
] as const;
const DRESSING_SLOT_LINES = [
  "Trying the outfit on for size...",
  "Smoothing every fold into place...",
  "Matching fabric to the motion...",
  "Keeping the silhouette honest...",
  "One last tug at the hem...",
  "Locking the look into the clip...",
] as const;
const MESHING_SLOT_LINES = [
  "Reading the silhouette...",
  "Pinning points to the fabric...",
  "Weaving the UV lattice...",
  "Tracking every fold...",
  "Smoothing the mesh field...",
  "Almost ready to scratch...",
] as const;
const ANIMATING_SLOT_SPIN = 0.55;
const ANIMATING_SLOT_HOLD = 1.45;
const leoHeld = new Set<string>();

function phaseFor(screen: LeoScreen): number {
  switch (screen) {
    case "influencer":
      return 0;
    case "theme":
      return 1;
    case "photo":
      return 2;
    case "swimwear":
    case "processing":
    case "confirm":
      return 3;
    case "animating":
    case "animated":
      return 4;
    case "outfit":
    case "dressing":
    case "dressed":
      return 5;
    case "meshing":
      return 6;
    case "mask":
    case "symbols":
      return 7;
    case "created":
      return 8;
    default:
      return 0;
  }
}

/** Landing screen when jumping via a progress dot. */
const PHASE_SCREENS: LeoScreen[] = [
  "influencer",
  "theme",
  "photo",
  "swimwear",
  "animated",
  "outfit",
  "meshing",
  "symbols",
  "created",
];
const PHASE_LABELS = [
  "Influencer pick",
  "Theme Card",
  "Add Photo",
  "Swimwear",
  "Animating Image",
  "Choose Outfit",
  "Generating Mesh",
  "Place Symbols",
  "Game Created!",
] as const;

function screenDir(from: LeoScreen, to: LeoScreen): 1 | -1 {
  const a = SCREEN_ORDER.indexOf(from);
  const b = SCREEN_ORDER.indexOf(to);
  if (a < 0 || b < 0) return 1;
  return b >= a ? 1 : -1;
}

function modelLocation(model: ModelInfo): string {
  const bits = [model.influencerCity?.trim(), model.influencerCountry?.trim()].filter(Boolean);
  return bits.length ? bits.join(", ") : "—";
}

function modelName(model: ModelInfo): string {
  return model.influencerName?.trim() || model.label;
}

function errorText(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught);
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    /* plain text */
  }
  return raw;
}

function pictureChoiceFromArtifact(path: string): number | null {
  const name = path.split("?")[0].split("/").pop() ?? "";
  const match = /^picture-([123])\.png$/i.exec(name);
  if (match) return Number(match[1]);
  // Published winner (after approve) or single still — treat as take 1.
  if (/^picture\.png$/i.test(name)) return 1;
  return null;
}

function readyPaths(paths: string[] | undefined): string[] {
  return (paths ?? []).filter((path) => path.trim());
}

const THEME_PREFIX: Record<string, string> = {
  Police: "POL",
  Teacher: "TCH",
  Nurse: "NRS",
  Gym: "GYM",
  Firegirl: "FIR",
};

function themePrefix(themeLabel: string): string {
  return THEME_PREFIX[themeLabel.trim()] ?? "";
}

function cardNameDigits(value: string): string {
  const prefixes = Object.values(THEME_PREFIX);
  let rest = value.trim();
  for (const prefix of prefixes) {
    if (rest.toUpperCase().startsWith(prefix)) {
      rest = rest.slice(prefix.length);
      break;
    }
  }
  return rest.replace(/\D/g, "").slice(0, 3);
}

function buildCardName(themeLabel: string, digits: string, pad: boolean): string {
  const prefix = themePrefix(themeLabel);
  if (!prefix) return "";
  const cleaned = digits.replace(/\D/g, "").slice(0, 3);
  if (!cleaned) return pad ? "" : prefix;
  return `${prefix}${pad ? cleaned.padStart(3, "0") : cleaned}`;
}

function isCompleteCardName(value: string, themeLabel: string): boolean {
  const prefix = themePrefix(themeLabel);
  if (!prefix) return false;
  return new RegExp(`^${prefix}\\d{3}$`).test(value.trim());
}

export function LeoUiPage() {
  const bootCard = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("card")?.trim() ?? "";
  }, []);

  const rootRef = useRef<HTMLElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const modelListRef = useRef<HTMLUListElement | null>(null);
  const phasesRef = useRef<HTMLDivElement | null>(null);
  const phasePillRef = useRef<HTMLSpanElement | null>(null);
  const backBtnRef = useRef<HTMLButtonElement | null>(null);
  const nextBtnRef = useRef<HTMLButtonElement | null>(null);
  const nextLabelRef = useRef<HTMLSpanElement | null>(null);
  const nextIconRef = useRef<HTMLSpanElement | null>(null);
  const cardNameRef = useRef<HTMLInputElement | null>(null);
  const cardNameChipRef = useRef<HTMLDivElement | null>(null);
  const cardNameEditSlotRef = useRef<HTMLDivElement | null>(null);
  const cardNameCardSlotRef = useRef<HTMLDivElement | null>(null);
  const cardNameFlipFromRef = useRef<DOMRect | null>(null);
  const cardNameFlippingRef = useRef(false);
  const cardShellRef = useRef<HTMLDivElement | null>(null);
  const cardShellEditSlotRef = useRef<HTMLDivElement | null>(null);
  const cardShellCardSlotRef = useRef<HTMLDivElement | null>(null);
  const cardShellFlipFromRef = useRef<DOMRect | null>(null);
  const cardShellFlippingRef = useRef(false);
  const cardShellModeRef = useRef<"edit" | "card" | "hidden">("hidden");
  /** Photo → Swimwear: thumb rect to grow into the shell. Swimwear → Photo: reverse. */
  const photoShellFromRef = useRef<DOMRect | null>(null);
  const photoShellGrowingRef = useRef(false);
  const photoFlyRef = useRef<HTMLDivElement | null>(null);
  /** Confirm hero slot — fly docks here from processing. */
  const confirmHeroRef = useRef<HTMLDivElement | null>(null);
  /** Animating preview slot — fly docks here from confirm. */
  const animatingPreviewRef = useRef<HTMLDivElement | null>(null);
  /** Animated preview slot — video fly docks here from animating. */
  const animatedPreviewRef = useRef<HTMLDivElement | null>(null);
  /** Choose Outfit hero — video fly docks here from animated. */
  const outfitHeroRef = useRef<HTMLDivElement | null>(null);
  /** Dressing preview — video fly docks here from outfit. */
  const dressingPreviewRef = useRef<HTMLDivElement | null>(null);
  /** Dressed preview — video fly docks here from dressing. */
  const dressedPreviewRef = useRef<HTMLDivElement | null>(null);
  /** Meshing preview — video fly docks here from dressed (full color). */
  const meshingPreviewRef = useRef<HTMLDivElement | null>(null);
  /** Adjust Mask hero — video fly docks here from meshing. */
  const maskHeroRef = useRef<HTMLDivElement | null>(null);
  const [maskEditOpen, setMaskEditOpen] = useState(false);
  const [maskEditFrom, setMaskEditFrom] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  /** Place Symbols stage — video fly docks here from mask. */
  const symbolsHeroRef = useRef<HTMLDivElement | null>(null);
  /** Game Created preview — video fly docks here from symbols (centered). */
  const createdPreviewRef = useRef<HTMLButtonElement | null>(null);
  /** Full-viewport try-motion dialog (Figma Step08 / 391:2643). */
  const tryMotionRef = useRef<HTMLDialogElement | null>(null);
  const tryMotionStageRef = useRef<HTMLDivElement | null>(null);
  const tryMotionCoverRef = useRef<HTMLDivElement | null>(null);
  const tryMotionBusyRef = useRef(false);
  /** True after dialog is parked at preview scale, waiting for game videos. */
  const tryMotionAwaitingReadyRef = useRef(false);
  const tryMotionReadyFallbackRef = useRef(0);
  const tryMotionFromRectRef = useRef<DOMRect | null>(null);
  /** URL before skipToPlay rewrites ?model=&card= — restored on close. */
  const tryMotionUrlRef = useRef("");
  const [tryMotionOpen, setTryMotionOpen] = useState(false);
  const animatingSlotsRef = useRef<HTMLDivElement | null>(null);
  const dressingSlotsRef = useRef<HTMLDivElement | null>(null);
  const meshingSlotsRef = useRef<HTMLDivElement | null>(null);
  const shellPhotoRef = useRef<HTMLImageElement | null>(null);
  /** Last image seen while on Add Photo — distinguishes fresh select vs return. */
  const photoImageOnScreenRef = useRef("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const previewWrapRef = useRef<HTMLDivElement | null>(null);
  const previewThumbRef = useRef<HTMLDivElement | null>(null);
  const previewClearRef = useRef<HTMLButtonElement | null>(null);
  const uploadDashedRef = useRef<HTMLButtonElement | null>(null);
  const uploadMediaRef = useRef<HTMLDivElement | null>(null);
  const galleryRef = useRef<HTMLDivElement | null>(null);
  const navDirRef = useRef<1 | -1>(1);
  const pendingEnterRef = useRef(false);
  const cardNameChipModeRef = useRef<"edit" | "card" | "hidden">("hidden");
  const navBusyRef = useRef(false);
  const backReadyRef = useRef(false);
  const nextLabelReadyRef = useRef(false);
  const bikiniRef = useRef<HTMLInputElement | null>(null);
  const faceRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetRef = useRef<"photo" | "bikini" | "face" | "confirm" | "outfit">("photo");
  /** User-uploaded stand-in on Confirm; clear restores the generated option. */
  const [confirmOverride, setConfirmOverride] = useState("");
  /** Holds upload src through the exit scale/fade before unmount. */
  const [confirmUploadExitSrc, setConfirmUploadExitSrc] = useState("");
  /** User-uploaded outfit reference on Choose Outfit (thumb only — hero stays the video). */
  const [outfitOverride, setOutfitOverride] = useState("");
  /** Keeps the outfit thumb mounted while exit scales it out. */
  const [outfitPanelSrc, setOutfitPanelSrc] = useState("");
  const outfitUploadBtnRef = useRef<HTMLButtonElement | null>(null);
  const outfitThumbRef = useRef<HTMLButtonElement | null>(null);
  const outfitClearRef = useRef<HTMLButtonElement | null>(null);
  const outfitSlotRef = useRef<HTMLDivElement | null>(null);
  const outfitOnScreenRef = useRef("");
  const outfitReadyRef = useRef(false);
  /** Extra picture direction from Confirm → Change Prompt dialog. */
  const [picturePromptExtra, setPicturePromptExtra] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const promptDialogRef = useRef<HTMLDialogElement | null>(null);
  const promptDialogBusyRef = useRef(false);
  /** Image→video / dress model for Try Again dialog. */
  const [backgroundVideoModel, setBackgroundVideoModel] = useState("");
  const [dressVideoModel, setDressVideoModel] = useState("");
  const [retryModelRole, setRetryModelRole] =
    useState<GenerationModelRole>("background_video");
  const [bgModelDraft, setBgModelDraft] = useState("");
  const bgModelDialogRef = useRef<HTMLDialogElement | null>(null);
  const bgModelDialogBusyRef = useRef(false);
  const bikiniGalleryRef = useRef<HTMLDialogElement | null>(null);
  const bikiniGalleryBusyRef = useRef(false);
  const { models: generationModels } = useGenerationCatalog();

  const [screen, setScreen] = useState<LeoScreen>("influencer");
  const [viewScreen, setViewScreen] = useState<LeoScreen>("influencer");
  const [navBusy, setNavBusy] = useState(false);
  /** Furthest progress-dot index reached — stays unlocked for jump-back. */
  const [maxPhaseReached, setMaxPhaseReached] = useState(0);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [themes, setThemes] = useState<ThemeInfo[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [gallery, setGallery] = useState<GalleryImage[]>([]);
  const [query, setQuery] = useState("");
  const [modelId, setModelId] = useState("");
  const [cardLabel, setCardLabel] = useState("");
  const [cardId, setCardId] = useState("");
  const [image, setImage] = useState("");
  /** Host/shell photo fill only after grow settles — never under the entrance fly. */
  const [photoFillReady, setPhotoFillReady] = useState(false);
  const [bikini, setBikini] = useState("");
  /** Keeps the thumb mounted while the select-column closes. */
  const [bikiniPanelSrc, setBikiniPanelSrc] = useState("");
  const bikiniSelectReadyRef = useRef(false);
  const bikiniColsProxyRef = useRef({ sel: 0, gap: 0 });
  const [face, setFace] = useState("");
  /** Keeps the face thumb mounted while exit scales it out. */
  const [facePanelSrc, setFacePanelSrc] = useState("");
  /** Local object URL + name while the square face crop dialog is open. */
  const [faceCrop, setFaceCrop] = useState<{ src: string; name: string } | null>(
    null,
  );
  const faceBtnRef = useRef<HTMLButtonElement | null>(null);
  const faceThumbRef = useRef<HTMLButtonElement | null>(null);
  const faceClearRef = useRef<HTMLButtonElement | null>(null);
  /** Skip re-entrance when returning to Swimwear with a face already set. */
  const faceOnScreenRef = useRef("");
  const faceReadyRef = useRef(false);
  /** Wall-clock when processing view mounted — gates min dwell before confirm. */
  const processingEnteredAtRef = useRef(0);
  /** True after picture options land and we swap to the processed photo. */
  const [processingRevealed, setProcessingRevealed] = useState(false);
  const processingRevealStartedRef = useRef(false);
  /** Which photo-fly handoff the enter hook should run. */
  const photoTravelKindRef = useRef<
    | "grow"
    | "shrink"
    | "to-processing"
    | "to-swimwear"
    | "to-confirm"
    | "to-animating"
    | "to-animated"
    | "to-outfit"
    | "to-dressing"
    | "to-dressed"
    | "to-meshing"
    | "to-mask"
    | "to-mask-back"
    | "to-symbols"
    | "to-created"
    | null
  >(null);
  const [theme, setTheme] = useState("");
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeSelectRef = useRef<HTMLDivElement | null>(null);
  const [pictureChoice, setPictureChoice] = useState(1);
  const [flowState, setFlowState] = useState<LiteFlowState | null>(null);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [pendingStep, setPendingStep] = useState<string | null>(null);
  /** Wall-clock when pendingStep was set — timeout must not reset on every poll. */
  const pendingSinceRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [catalogReady, setCatalogReady] = useState(false);
  const [selectedExiting, setSelectedExiting] = useState(false);
  const [shownSelectedId, setShownSelectedId] = useState("");
  const [cardNameFocused, setCardNameFocused] = useState(false);
  const [modelListScroll, setModelListScroll] = useState<
    "start" | "middle" | "end" | "none"
  >("start");
  const [listScroll, setListScroll] = useState<"start" | "middle" | "end" | "none">(
    "start",
  );

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
    picturePromptExtra: "",
  });

  const hasXaiKey = Boolean(health?.xai_key_loaded);
  const hasWavespeedKey = Boolean(health?.wavespeed_key_loaded);
  const resolvedBackgroundVideoModel =
    backgroundVideoModel.trim() || liteBackgroundVideoModel(hasXaiKey, hasWavespeedKey);
  const resolvedDressVideoModel =
    dressVideoModel.trim() || liteDressVideoModel(hasXaiKey, hasWavespeedKey);

  fieldsRef.current = {
    cardId,
    cardLabel,
    modelId,
    image,
    bikini,
    face,
    theme,
    costume: outfitOverride,
    hasXai: hasXaiKey,
    hasWavespeed: hasWavespeedKey,
    picturePromptExtra,
    backgroundVideoModel: resolvedBackgroundVideoModel,
    dressVideoModel: resolvedDressVideoModel,
  };

  const filterAiModelsForKeys = useCallback(
    (listed: GenerationModelInfo[]) =>
      listed.filter((entry) => {
        if (entry.provider === "wavespeed") return hasWavespeedKey || !hasXaiKey;
        if (entry.provider === "xai") return hasXaiKey || !hasWavespeedKey;
        return true;
      }),
    [hasXaiKey, hasWavespeedKey],
  );

  const backgroundAiModels = useMemo(
    () => filterAiModelsForKeys(modelsForRole(generationModels, "background_video")),
    [filterAiModelsForKeys, generationModels],
  );

  const dressAiModels = useMemo(
    () => filterAiModelsForKeys(modelsForRole(generationModels, "dress_video")),
    [filterAiModelsForKeys, generationModels],
  );

  const retryAiModels =
    retryModelRole === "dress_video" ? dressAiModels : backgroundAiModels;

  const selectedModel =
    models.find((m) => m.id === (shownSelectedId || modelId)) ?? null;
  // Pill tracks the destination step so it slides during exit, not after swap.
  const phase = phaseFor(screen);
  useEffect(() => {
    setMaxPhaseReached((prev) => Math.max(prev, phase));
  }, [phase]);
  // Back expands toward destination while content exits (same chain as phase pill).
  const showBack = screen !== "influencer";
  const showNextCheck =
    viewScreen === "confirm" ||
    viewScreen === "animated" ||
    viewScreen === "outfit" ||
    viewScreen === "dressed" ||
    viewScreen === "mask" ||
    viewScreen === "symbols" ||
    viewScreen === "created";
  const nextLabel =
    viewScreen === "confirm"
      ? "Use This Image"
      : viewScreen === "animated"
        ? "Use This Video"
        : viewScreen === "outfit"
          ? "Use This Outfit"
          : viewScreen === "dressed"
            ? "Use This Video"
            : viewScreen === "mask"
              ? "Use This Mask"
              : viewScreen === "symbols"
                ? "Create Game"
                : viewScreen === "created"
                  ? "Try Motion Card"
                  : "Next";

  useEffect(() => {
    if (!modelId) return;
    setSelectedExiting(false);
    setShownSelectedId(modelId);
  }, [modelId]);

  const syncScrollFade = useCallback(
    (
      el: HTMLElement | null,
      setFade: (value: "start" | "middle" | "end" | "none") => void,
    ) => {
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 2) {
        setFade("none");
        return;
      }
      const top = el.scrollTop <= 2;
      const bottom = el.scrollTop >= max - 2;
      if (top && bottom) setFade("none");
      else if (top) setFade("start");
      else if (bottom) setFade("end");
      else setFade("middle");
    },
    [],
  );

  const syncListScrollFade = useCallback(() => {
    syncScrollFade(listRef.current, setListScroll);
  }, [syncScrollFade]);

  const syncModelListScrollFade = useCallback(() => {
    syncScrollFade(modelListRef.current, setModelListScroll);
  }, [syncScrollFade]);

  function clearSelection() {
    if (selectedExiting || !shownSelectedId) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setModelId("");
    if (reduce) {
      setShownSelectedId("");
      setSelectedExiting(false);
      return;
    }
    setSelectedExiting(true);
  }

  function finishClearSelection() {
    setShownSelectedId("");
    setSelectedExiting(false);
  }

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...models].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    if (!q) return sorted;
    return sorted.filter((model) => {
      const hay = `${modelName(model)} ${modelLocation(model)} ${model.id}`.toLowerCase();
      return hay.includes(q);
    });
  }, [models, query]);

  useEffect(() => {
    if (viewScreen !== "influencer") return;
    const el = listRef.current;
    if (!el) return;
    syncListScrollFade();
    const onScroll = () => syncListScrollFade();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncListScrollFade) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  }, [viewScreen, filteredModels.length, catalogReady, syncListScrollFade]);

  useEffect(() => {
    const el = modelListRef.current;
    if (!el) return;
    syncModelListScrollFade();
    const onScroll = () => syncModelListScrollFade();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(syncModelListScrollFade)
        : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  }, [retryAiModels.length, syncModelListScrollFade]);

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
    if (!themeMenuOpen) return;
    const onPointer = (event: PointerEvent) => {
      const root = themeSelectRef.current;
      if (root && !root.contains(event.target as Node)) setThemeMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThemeMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [themeMenuOpen]);

  useEffect(() => {
    if (viewScreen !== "theme") setThemeMenuOpen(false);
  }, [viewScreen]);

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
          setPictureChoice(1);
          setScreen(SKIP_CONFIRM ? "processing" : "confirm");
        } catch {
          // Missing card in ?card= — drop the query so we don't keep 404ing draft.
          if (bootCard) {
            window.history.replaceState(null, "", window.location.pathname);
          }
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
    if (!modelId) {
      setGallery([]);
      return;
    }
    let cancelled = false;
    api<{ images: GalleryImage[] }>(`/api/models/${encodeURIComponent(modelId)}/gallery`)
      .then((data) => {
        if (!cancelled) setGallery(data.images ?? []);
      })
      .catch(() => {
        if (!cancelled) setGallery([]);
      });
    return () => {
      cancelled = true;
    };
  }, [modelId]);

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
    () => jobs.filter((job) => job.kind === "video-flow-step" && job.command[2] === cardId),
    [jobs, cardId],
  );
  const runningJob = cardJobs.find((job) => job.status === "queued" || job.status === "running");

  useEffect(() => {
    if (!pendingStep) {
      pendingSinceRef.current = 0;
      return;
    }
    if (!pendingSinceRef.current) pendingSinceRef.current = Date.now();
    const job = cardJobs.find((entry) => entry.command[1] === pendingStep);
    const status = flowState?.steps[pendingStep as VideoFlowStepKey]?.status;
    if (job?.status === "queued" || job?.status === "running") return;
    if (
      job?.status === "failed" ||
      job?.status === "succeeded" ||
      job?.status === "cancelled" ||
      status === "review" ||
      status === "approved" ||
      // No live job and step already has artifacts — clear the busy flag.
      (job == null &&
        readyPaths(flowState?.steps[pendingStep as VideoFlowStepKey]?.artifacts)
          .length > 0)
    ) {
      pendingSinceRef.current = 0;
      setPendingStep(null);
      return;
    }
    // Job vanished while still "ready". Use elapsed time from when we set
    // pending — do not restart the clock on every 2.5s state poll.
    if (job == null) {
      const remaining = Math.max(
        0,
        8000 - (Date.now() - pendingSinceRef.current),
      );
      const timer = window.setTimeout(() => {
        pendingSinceRef.current = 0;
        setPendingStep(null);
      }, remaining);
      return () => window.clearTimeout(timer);
    }
  }, [cardJobs, flowState, pendingStep]);

  const saveDraft = useCallback(async (id: string) => {
    const fields = fieldsRef.current;
    await api(`/api/video-flow/${encodeURIComponent(id)}/draft`, {
      method: "POST",
      body: JSON.stringify(liteRequestBody({ ...fields, cardId: id })),
    });
  }, []);

  const enqueue = useCallback(
    async (step: VideoFlowStepKey, force: boolean) => {
      const id = fieldsRef.current.cardId.trim();
      if (!id) return;
      pendingSinceRef.current = Date.now();
      setPendingStep(step);
      setError("");
      try {
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
      } catch (caught) {
        // Don't leave the Confirm/Processing screens stuck on "Generating…".
        pendingSinceRef.current = 0;
        setPendingStep(null);
        throw caught;
      }
    },
    [refresh, saveDraft],
  );

  // Auto-start background once picture is approved.
  useEffect(() => {
    if (!cardId || !flowState || pendingStep || runningJob) return;
    if (flowState.steps.picture?.status !== "approved") return;
    if (flowState.steps.background?.status !== "ready") return;
    const token = `${cardId}:background`;
    if (leoHeld.has(token)) return;
    leoHeld.add(token);
    setScreen("animating");
    void enqueue("background", false).catch((caught) => {
      leoHeld.delete(token);
      setPendingStep(null);
      setError(errorText(caught));
    });
  }, [cardId, enqueue, flowState, pendingStep, runningJob]);

  // Leave animating once the background clip is ready (don't require the job
  // to still be in /api/jobs — it may already have been pruned). Wait for any
  // in-flight confirm→animating morph so the fly layer isn't left stranded.
  useEffect(() => {
    if (screen !== "animating") return;
    const bgBusy =
      pendingStep === "background" || runningJob?.command[1] === "background";
    if (bgBusy) return;
    const status = flowState?.steps.background?.status;
    if (status !== "review" && status !== "approved") return;
    const clip = readyPaths(flowState?.steps.background?.artifacts)[0];
    if (!clip) return;
    if (!photoShellGrowingRef.current) {
      setScreen("animated");
      return;
    }
    const timer = window.setInterval(() => {
      if (photoShellGrowingRef.current) return;
      window.clearInterval(timer);
      setScreen((current) => (current === "animating" ? "animated" : current));
    }, 50);
    return () => window.clearInterval(timer);
  }, [flowState, pendingStep, runningJob, screen]);

  // Leave dressing once the dress clip is ready.
  useEffect(() => {
    if (screen !== "dressing") return;
    const busy =
      pendingStep === "dress" || runningJob?.command[1] === "dress";
    if (busy) return;
    const status = flowState?.steps.dress?.status;
    if (status !== "review" && status !== "approved") return;
    const clip = readyPaths(flowState?.steps.dress?.artifacts)[0];
    if (!clip) return;
    setScreen("dressed");
  }, [flowState, pendingStep, runningJob, screen]);

  // Drop custom confirm / outfit uploads when leaving those steps.
  useEffect(() => {
    if (screen !== "confirm") {
      setConfirmOverride("");
      setConfirmUploadExitSrc("");
    }
    if (
      screen !== "outfit" &&
      screen !== "dressing" &&
      screen !== "dressed" &&
      screen !== "meshing" &&
      screen !== "mask" &&
      screen !== "symbols" &&
      screen !== "created"
    ) {
      setOutfitOverride("");
      setOutfitPanelSrc("");
      outfitOnScreenRef.current = "";
      outfitReadyRef.current = false;
    }
  }, [screen]);

  // Processing done → swap to processed photo once real artifacts exist.
  useEffect(() => {
    if (screen !== "processing") {
      processingRevealStartedRef.current = false;
      setProcessingRevealed(false);
      return;
    }
    if (viewScreen !== "processing" || processingRevealStartedRef.current) return;
    const artifacts = readyPaths(flowState?.steps.picture?.artifacts).filter(
      (path) => pictureChoiceFromArtifact(path) != null,
    );
    const busy =
      pendingStep === "picture" || runningJob?.command[1] === "picture";
    if (busy || artifacts.length === 0) return;
    const started = processingEnteredAtRef.current || Date.now();
    const wait = Math.max(0, PROCESSING_MIN_DWELL_MS - (Date.now() - started));
    const timer = window.setTimeout(() => {
      processingRevealStartedRef.current = true;
      const img = screenRef.current?.querySelector<HTMLElement>(
        ".leo-ui__host-photo.is-processing img",
      );
      if (img) gsap.set(img, { filter: PROCESSING_PHOTO_FILTER });
      setProcessingRevealed(true);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [screen, viewScreen, flowState, pendingStep, runningJob]);

  function cardNameChipMode(forScreen: LeoScreen): "edit" | "card" | "hidden" {
    if (forScreen === "theme") return "edit";
    if (forScreen === "photo" || forScreen === "swimwear") return "card";
    return "hidden";
  }

  function cardShellMode(forScreen: LeoScreen): "edit" | "card" | "hidden" {
    if (forScreen === "theme") return "edit";
    if (forScreen === "photo" || forScreen === "swimwear" || forScreen === "processing") {
      return "card";
    }
    return "hidden";
  }

  const SHELL_BLUR = "blur(8px)";
  const SHELL_SHARP = "blur(0px)";
  /** Thumb = solid mask (fully visible); settle = swimwear bg mask. */
  const SHELL_MASK_THUMB = {
    "--shell-mask-0": "#000000",
    "--shell-mask-1": "#000000",
    "--shell-mask-2": "#000000",
  } as gsap.TweenVars;
  const SHELL_MASK_FILL = {
    "--shell-mask-0": "#0000002b",
    "--shell-mask-1": "#0000007d",
    "--shell-mask-2": "#00000000",
  } as gsap.TweenVars;

  function stageEl() {
    return cardShellRef.current?.closest(".leo-ui__stage") as HTMLElement | null;
  }

  function shellHasPhotoFill() {
    return Boolean(cardShellRef.current?.classList.contains("is-photo-fill"));
  }

  function bikiniBlockEl() {
    return screenRef.current?.querySelector<HTMLElement>(".leo-ui__bikini-block") ?? null;
  }

  function hideBikiniBlock() {
    const block = bikiniBlockEl();
    if (!block) return;
    gsap.killTweensOf(block);
    gsap.set(block, { opacity: 0, y: 18 });
  }

  /** Fade/slide bikini chrome in after the photo grow has settled. */
  function revealBikiniBlock() {
    const block = bikiniBlockEl();
    if (!block) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    gsap.killTweensOf(block);
    if (reduce) {
      gsap.set(block, { opacity: 1, y: 0, clearProps: "transform" });
      return;
    }
    gsap.fromTo(
      block,
      { opacity: 0, y: 18 },
      {
        opacity: 1,
        y: 0,
        duration: 0.48,
        delay: 0.55,
        ease: "power3.out",
        clearProps: "transform",
        overwrite: true,
      },
    );
  }

  // Thumb column width/gap in px — tweened via proxy so grid tracks lerp cleanly.
  const BIKINI_SEL_PX = 100; /* 6.25rem */
  const BIKINI_GAP_PX = 12; /* 0.75rem */

  // Selected swimwear: animate col1 shrink + selected column in (and reverse).
  useGSAP(
    () => {
      if (viewScreen !== "swimwear") {
        bikiniSelectReadyRef.current = false;
        return;
      }
      const block = bikiniBlockEl();
      if (!block) return;
      const selected = block.querySelector<HTMLElement>(".leo-ui__bikini-selected");
      const thumb = selected?.querySelector<HTMLElement>(".leo-ui__preview") ?? null;
      const clear = selected?.querySelector<HTMLElement>(".leo-ui__preview-clear") ?? null;
      const labels = block.querySelectorAll<HTMLElement>(
        ".leo-ui__dashed, .leo-ui__bikini-row .leo-ui__section-label",
      );
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const open = Boolean(bikini.trim());

      if (open) setBikiniPanelSrc(bikini);

      const applyCols = (selPx: number, gapPx: number) => {
        block.style.setProperty("--bikini-sel", `${selPx}px`);
        block.style.setProperty("--bikini-gap", `${gapPx}px`);
      };
      const readSelPx = () => {
        const raw = getComputedStyle(block).getPropertyValue("--bikini-sel").trim();
        const n = Number.parseFloat(raw);
        return Number.isFinite(n) ? n : 0;
      };

      const cols = bikiniColsProxyRef.current;

      if (!bikiniSelectReadyRef.current) {
        bikiniSelectReadyRef.current = true;
        cols.sel = open ? BIKINI_SEL_PX : 0;
        cols.gap = open ? BIKINI_GAP_PX : 0;
        applyCols(cols.sel, cols.gap);
        if (selected) {
          gsap.set(selected, {
            opacity: open ? 1 : 0,
            overflow: open ? "visible" : "hidden",
          });
        }
        if (thumb) gsap.set(thumb, { opacity: 1, scale: 1, y: 0, clearProps: "transform" });
        if (clear) gsap.set(clear, { scale: 1, clearProps: "transform" });
        return;
      }

      gsap.killTweensOf(
        [cols, block, selected, thumb, clear, ...Array.from(labels)].filter(Boolean),
      );

      if (reduce) {
        cols.sel = open ? BIKINI_SEL_PX : 0;
        cols.gap = open ? BIKINI_GAP_PX : 0;
        applyCols(cols.sel, cols.gap);
        if (selected) {
          gsap.set(selected, {
            opacity: open ? 1 : 0,
            overflow: open ? "visible" : "hidden",
          });
        }
        if (thumb) gsap.set(thumb, { opacity: 1, scale: 1, y: 0, clearProps: "transform" });
        if (clear) gsap.set(clear, { scale: 1, clearProps: "transform" });
        if (!open) setBikiniPanelSrc("");
        return;
      }

      cols.sel = readSelPx();
      if (cols.sel <= 0) cols.gap = 0;
      else if (cols.sel >= BIKINI_SEL_PX) cols.gap = BIKINI_GAP_PX;

      if (open) {
        if (selected) gsap.set(selected, { overflow: "hidden", opacity: 1 });
        // Same as Add Photo: scale + slight rise — no horizontal slide.
        if (thumb) {
          gsap.set(thumb, { opacity: 0, scale: 0.86, y: 14, transformOrigin: "50% 50%" });
        }
        if (clear) gsap.set(clear, { scale: 0.5, transformOrigin: "50% 50%" });
        gsap.to(cols, {
          sel: BIKINI_SEL_PX,
          gap: BIKINI_GAP_PX,
          duration: 0.5,
          ease: "power3.inOut",
          overwrite: true,
          onUpdate: () => applyCols(cols.sel, cols.gap),
          onComplete: () => {
            applyCols(BIKINI_SEL_PX, BIKINI_GAP_PX);
            if (selected) gsap.set(selected, { overflow: "visible" });
          },
        });
        if (thumb) {
          gsap.to(thumb, {
            opacity: 1,
            scale: 1,
            y: 0,
            duration: 0.4,
            ease: "power2.out",
            delay: 0.12,
            clearProps: "transform",
            overwrite: true,
          });
        }
        if (clear) {
          gsap.to(clear, {
            scale: 1,
            duration: 0.3,
            ease: "back.out(1.7)",
            delay: 0.28,
            clearProps: "transform",
            overwrite: true,
          });
        }
        if (labels.length) {
          gsap.fromTo(
            labels,
            { opacity: 0.35 },
            { opacity: 1, duration: 0.32, ease: "power2.out", overwrite: true },
          );
        }
      } else {
        if (selected) gsap.set(selected, { overflow: "hidden" });
        if (clear) {
          gsap.to(clear, {
            scale: 0.5,
            duration: 0.22,
            ease: "power2.in",
            transformOrigin: "50% 50%",
            overwrite: true,
          });
        }
        if (thumb) {
          gsap.to(thumb, {
            opacity: 0,
            scale: 0.86,
            y: 14,
            duration: 0.32,
            ease: "power2.in",
            transformOrigin: "50% 50%",
            overwrite: true,
          });
        }
        gsap.to(selected, {
          opacity: 0,
          duration: 0.28,
          ease: "power2.in",
          delay: 0.08,
          overwrite: true,
        });
        gsap.to(cols, {
          sel: 0,
          gap: 0,
          duration: 0.45,
          ease: "power3.inOut",
          delay: 0.04,
          overwrite: true,
          onUpdate: () => applyCols(cols.sel, cols.gap),
          onComplete: () => {
            applyCols(0, 0);
            setBikiniPanelSrc("");
          },
        });
        if (labels.length) {
          gsap.fromTo(
            labels,
            { opacity: 0.35 },
            { opacity: 1, duration: 0.32, ease: "power2.out", delay: 0.08, overwrite: true },
          );
        }
      }
    },
    { dependencies: [bikini, viewScreen], scope: rootRef },
  );

  // Face: anticipate → scale Add Face out → thumb in; reverse on remove.
  useGSAP(
    () => {
      if (viewScreen !== "swimwear") {
        faceOnScreenRef.current = "";
        faceReadyRef.current = false;
        return;
      }
      const btn = faceBtnRef.current;
      const thumb = faceThumbRef.current;
      const clear = faceClearRef.current;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const open = Boolean(face.trim());

      if (open) setFacePanelSrc(face);

      if (!faceReadyRef.current) {
        faceReadyRef.current = true;
        if (open) {
          faceOnScreenRef.current = face;
          if (btn) {
            gsap.set(btn, {
              opacity: 0,
              scale: 0,
              visibility: "hidden",
              pointerEvents: "none",
            });
          }
          if (thumb) gsap.set(thumb, { opacity: 1, scale: 1, y: 0, clearProps: "transform" });
          if (clear) gsap.set(clear, { scale: 1, clearProps: "transform" });
        } else if (btn) {
          gsap.set(btn, {
            opacity: 1,
            scale: 1,
            visibility: "visible",
            pointerEvents: "auto",
            clearProps: "transform",
          });
        }
        return;
      }

      gsap.killTweensOf([btn, thumb, clear].filter(Boolean));

      if (reduce) {
        if (open) {
          faceOnScreenRef.current = face;
          if (btn) {
            gsap.set(btn, {
              opacity: 0,
              scale: 0,
              visibility: "hidden",
              pointerEvents: "none",
            });
          }
          if (thumb) gsap.set(thumb, { opacity: 1, scale: 1, y: 0, clearProps: "transform" });
          if (clear) gsap.set(clear, { scale: 1, clearProps: "transform" });
        } else {
          faceOnScreenRef.current = "";
          if (btn) {
            gsap.set(btn, {
              opacity: 1,
              scale: 1,
              visibility: "visible",
              pointerEvents: "auto",
              clearProps: "transform",
            });
          }
          setFacePanelSrc("");
        }
        return;
      }

      if (open) {
        if (!btn || !thumb || !clear) return;
        const returning = Boolean(faceOnScreenRef.current);
        faceOnScreenRef.current = face;
        if (returning) {
          gsap.set(btn, {
            opacity: 0,
            scale: 0,
            visibility: "hidden",
            pointerEvents: "none",
          });
          gsap.set(thumb, { opacity: 1, scale: 1, y: 0, clearProps: "transform" });
          gsap.set(clear, { scale: 1, clearProps: "transform" });
          return;
        }

        gsap.set(btn, {
          opacity: 1,
          scale: 1,
          visibility: "visible",
          pointerEvents: "none",
          transformOrigin: "50% 50%",
        });
        gsap.set(thumb, { opacity: 0, scale: 0.86, y: 14, transformOrigin: "50% 50%" });
        gsap.set(clear, { scale: 0.5, transformOrigin: "50% 50%" });

        const tl = gsap.timeline({ defaults: { overwrite: "auto" } });
        // Anticipation — brief swell before the commit.
        tl.to(btn, { scale: 1.08, duration: 0.12, ease: "power2.out" });
        tl.to(btn, {
          scale: 0,
          opacity: 0,
          duration: 0.22,
          ease: "power2.in",
          onComplete: () => {
            gsap.set(btn, { visibility: "hidden" });
          },
        });
        tl.to(
          thumb,
          {
            opacity: 1,
            scale: 1,
            y: 0,
            duration: 0.4,
            ease: "power2.out",
            clearProps: "transform",
          },
          "-=0.04",
        );
        tl.to(
          clear,
          { scale: 1, duration: 0.3, ease: "back.out(1.7)", clearProps: "transform" },
          "-=0.28",
        );
      } else {
        // Reverse: thumb out → Add Face scales back in.
        faceOnScreenRef.current = "";
        if (!btn) {
          setFacePanelSrc("");
          return;
        }
        if (!thumb || !clear) {
          gsap.set(btn, {
            opacity: 1,
            scale: 1,
            visibility: "visible",
            pointerEvents: "auto",
            clearProps: "transform",
          });
          setFacePanelSrc("");
          return;
        }

        gsap.set(btn, {
          opacity: 0,
          scale: 0,
          visibility: "visible",
          pointerEvents: "none",
          transformOrigin: "50% 50%",
        });
        gsap.set(thumb, { opacity: 1, scale: 1, y: 0, transformOrigin: "50% 50%" });
        gsap.set(clear, { scale: 1, transformOrigin: "50% 50%" });

        const tl = gsap.timeline({
          defaults: { overwrite: "auto" },
          onComplete: () => setFacePanelSrc(""),
        });
        tl.to(clear, { scale: 0.5, duration: 0.18, ease: "power2.in" });
        tl.to(
          thumb,
          { opacity: 0, scale: 0.86, y: 14, duration: 0.28, ease: "power2.in" },
          0,
        );
        tl.to(btn, { scale: 1.08, opacity: 1, duration: 0.2, ease: "power2.out" }, "-=0.06");
        tl.to(btn, {
          scale: 1,
          duration: 0.16,
          ease: "power2.inOut",
          clearProps: "transform",
          onComplete: () => {
            gsap.set(btn, { pointerEvents: "auto", visibility: "visible" });
          },
        });
      }
    },
    { dependencies: [face, viewScreen], scope: rootRef },
  );

  /** Photo fill sits behind screen content; glass shell stays above. */
  function setShellPhotoFill(on: boolean) {
    const shell = cardShellRef.current;
    const stage = stageEl();
    const fill = shellPhotoRef.current;
    if (!shell || !stage) return;
    shell.classList.toggle("is-photo-fill", on);
    stage.classList.toggle("has-photo-shell", on);
    if (fill) {
      // Image lives on .leo-ui__host-photo (masked). Shell keeps border only.
      if (on && image.trim()) fill.src = previewSource(image);
      gsap.set(fill, { opacity: 0 });
    }
    setPhotoFillReady(on);
    if (on) revealBikiniBlock();
    else hideBikiniBlock();
  }

  /** Shell is `position:absolute` in `.leo-ui__stage` — convert viewport rect → stage-local. */
  function shellPoseFromSlot(slot: HTMLElement) {
    const shell = cardShellRef.current;
    // Don't use offsetParent — it's null while `display: none`.
    const stage = stageEl();
    const box = slot.getBoundingClientRect();
    if (!stage || box.width < 8 || box.height < 4) return null;
    const origin = stage.getBoundingClientRect();
    return {
      left: box.left - origin.left,
      top: box.top - origin.top,
      width: box.width,
      height: box.height,
      box,
    };
  }

  function stageLocalFromRect(box: DOMRect) {
    const stage = stageEl();
    if (!stage || box.width < 1 || box.height < 1) return null;
    const origin = stage.getBoundingClientRect();
    return {
      left: box.left - origin.left,
      top: box.top - origin.top,
      width: box.width,
      height: box.height,
    };
  }

  function hidePhotoFly() {
    const fly = photoFlyRef.current;
    if (!fly) return;
    gsap.killTweensOf(fly);
    const flyVideo = fly.querySelector("video");
    if (flyVideo) flyVideo.pause();
    gsap.set(fly, {
      display: "none",
      clearProps:
        "transform,filter,opacity,borderRadius,boxShadow,--shell-mask-0,--shell-mask-1,--shell-mask-2",
    });
    photoShellGrowingRef.current = false;
  }

  /** Park the fly layer at a viewport rect (stage-local left/top/size). */
  function placePhotoFly(box: DOMRect, src: string) {
    const fly = photoFlyRef.current;
    const img = fly?.querySelector("img");
    const video = fly?.querySelector("video");
    const local = stageLocalFromRect(box);
    if (!fly || !img || !local) return null;
    if (video) {
      video.pause();
      gsap.set(video, { display: "none" });
    }
    gsap.set(img, { display: "block" });
    img.src = previewSource(src);
    gsap.killTweensOf(fly);
    gsap.set(fly, {
      display: "block",
      left: local.left,
      top: local.top,
      width: local.width,
      height: local.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      transformOrigin: "0% 0%",
    });
    return local;
  }

  /** Same fly layer, but with a looping video (Animating → Animated). */
  function placeVideoFly(box: DOMRect, src: string, filter = PROCESSING_PHOTO_FILTER_CLEAR) {
    const fly = photoFlyRef.current;
    const img = fly?.querySelector("img");
    const video = fly?.querySelector("video");
    const local = stageLocalFromRect(box);
    if (!fly || !video || !local) return null;
    if (img) gsap.set(img, { display: "none" });
    const url = previewSource(src);
    if (video.getAttribute("src") !== url) video.src = url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    gsap.set(video, { display: "block" });
    void video.play().catch(() => undefined);
    gsap.killTweensOf(fly);
    gsap.set(fly, {
      display: "block",
      left: local.left,
      top: local.top,
      width: local.width,
      height: local.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      filter,
      transformOrigin: "0% 0%",
      ...SHELL_MASK_THUMB,
    });
    return local;
  }

  /**
   * Persistent glass shell across Theme ↔ Add Photo.
   * Edit resting = always blurred (GSAP inline, not CSS-only — first landing
   * from Influencer was skipping CSS blur). Next FLIP unblurs + moves.
   */
  function placeCardShell(mode: "edit" | "card" | "hidden", animate: boolean) {
    const shell = cardShellRef.current;
    if (!shell) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const motion = animate && !reduce;

    if (mode === "hidden") {
      cardShellModeRef.current = "hidden";
      shell.classList.remove("is-edit", "is-card");
      setShellPhotoFill(false);
      gsap.killTweensOf(shell);
      gsap.set(shell, { display: "none", opacity: 0, clearProps: "transform" });
      return;
    }

    const slot =
      mode === "edit" ? cardShellEditSlotRef.current : cardShellCardSlotRef.current;
    if (!slot) return;
    const local = shellPoseFromSlot(slot);
    if (!local) return;

    const prev = cardShellModeRef.current;
    cardShellModeRef.current = mode;
    shell.classList.toggle("is-edit", mode === "edit");
    shell.classList.toggle("is-card", mode === "card");
    gsap.killTweensOf(shell);

    const photoFill = mode === "card" && shellHasPhotoFill();
    const blurred = mode === "edit" && !photoFill;
    const pose = {
      display: "block",
      left: local.left,
      top: local.top,
      width: local.width,
      height: local.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      filter: photoFill ? "none" : blurred ? SHELL_BLUR : SHELL_SHARP,
      opacity: photoFill ? 1 : blurred ? 0.55 : 1,
    };

    if (!motion) {
      gsap.set(shell, pose);
      return;
    }
    if (prev === "hidden") {
      // First arrival (Influencer → Theme): already blurred, fade opacity only.
      gsap.set(shell, { ...pose, opacity: 0 });
      gsap.to(shell, {
        opacity: pose.opacity,
        duration: 0.28,
        ease: "power2.out",
        overwrite: true,
      });
      return;
    }
    gsap.to(shell, {
      left: pose.left,
      top: pose.top,
      width: pose.width,
      height: pose.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      filter: pose.filter,
      opacity: pose.opacity,
      duration: 0.35,
      ease: "power2.out",
      overwrite: true,
    });
  }

  /** Next/Back: same shell moves + unblurs/reblurs via GSAP. */
  function flipCardShell(from: DOMRect, mode: "edit" | "card") {
    const shell = cardShellRef.current;
    const slot =
      mode === "edit" ? cardShellEditSlotRef.current : cardShellCardSlotRef.current;
    if (!shell || !slot) {
      placeCardShell(mode, false);
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    gsap.set(slot, { y: 0, clearProps: "transform" });
    const local = shellPoseFromSlot(slot);
    if (!local) {
      placeCardShell(mode, false);
      return;
    }

    cardShellModeRef.current = mode;
    shell.classList.toggle("is-edit", mode === "edit");
    shell.classList.toggle("is-card", mode === "card");
    gsap.killTweensOf(shell);
    gsap.set(shell, {
      display: "block",
      left: local.left,
      top: local.top,
      width: local.width,
      height: local.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      transformOrigin: "0% 0%",
      filter: mode === "card" ? SHELL_SHARP : SHELL_BLUR,
      opacity: mode === "card" ? 1 : 0.55,
    });
    const to = shell.getBoundingClientRect();
    if (to.width < 1 || to.height < 1) return;

    if (reduce) {
      cardShellFlippingRef.current = false;
      placeCardShell(mode, false);
      return;
    }

    cardShellFlippingRef.current = true;
    gsap.fromTo(
      shell,
      {
        x: from.left - to.left,
        y: from.top - to.top,
        scaleX: from.width / to.width,
        scaleY: from.height / to.height,
        transformOrigin: "0% 0%",
        filter: mode === "card" ? SHELL_BLUR : SHELL_SHARP,
        opacity: mode === "card" ? 0.55 : 1,
      },
      {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        filter: mode === "card" ? SHELL_SHARP : SHELL_BLUR,
        opacity: mode === "card" ? 1 : 0.55,
        duration: 0.85,
        ease: "power3.inOut",
        overwrite: true,
        onComplete: () => {
          cardShellFlippingRef.current = false;
          gsap.set(shell, { clearProps: "transform" });
          placeCardShell(mode, false);
        },
      },
    );
  }

  /** Selected thumb grows to shell bounds — looks like it replaces the glass. */
  function growPhotoIntoShell(from: DOMRect) {
    const shell = cardShellRef.current;
    const fly = photoFlyRef.current;
    const src = image.trim();
    if (!shell || !fly || !src) {
      placeCardShell("card", false);
      if (src) setShellPhotoFill(true);
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Glass only during the fly — no settled photo / bikini chrome under the entrance.
    setShellPhotoFill(false);
    hideBikiniBlock();
    placeCardShell("card", false);
    const to = shell.getBoundingClientRect();
    if (to.width < 1 || to.height < 1) {
      setShellPhotoFill(true);
      return;
    }

    if (reduce) {
      setShellPhotoFill(true);
      gsap.set(fly, { display: "none" });
      return;
    }

    const dest = placePhotoFly(to, src);
    if (!dest) {
      setShellPhotoFill(true);
      return;
    }

    photoShellGrowingRef.current = true;
    gsap.fromTo(
      fly,
      {
        x: from.left - to.left,
        y: from.top - to.top,
        scaleX: from.width / to.width,
        scaleY: from.height / to.height,
        transformOrigin: "0% 0%",
        ...SHELL_MASK_THUMB,
      },
      {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        ...SHELL_MASK_FILL,
        duration: 0.85,
        ease: "power3.inOut",
        overwrite: true,
        onComplete: () => {
          gsap.set(fly, {
            display: "none",
            clearProps: "transform,--shell-mask-0,--shell-mask-1,--shell-mask-2",
          });
          photoShellGrowingRef.current = false;
          placeCardShell("card", false);
          // Fill + bikini reveal (setShellPhotoFill → revealBikiniBlock).
          setShellPhotoFill(true);
        },
      },
    );
  }

  /** Swimwear → processing: keep fly visible, dock to new slot, blur into host. */
  function settleFlyIntoProcessing() {
    const fly = photoFlyRef.current;
    const shell = cardShellRef.current;
    const src = image.trim();
    if (!fly || !shell || !src) {
      placeCardShell("card", false);
      if (src) setShellPhotoFill(true);
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    hideBikiniBlock();
    placeCardShell("card", false);
    setShellPhotoFill(true);
    const to = shell.getBoundingClientRect();
    const local = stageLocalFromRect(to);
    const clearFlyProps =
      "transform,filter,opacity,--shell-mask-0,--shell-mask-1,--shell-mask-2";
    if (!local || to.width < 1) {
      gsap.set(fly, { display: "none", clearProps: clearFlyProps });
      return;
    }

    const host = screenRef.current?.querySelector<HTMLElement>(
      ".leo-ui__host-photo.is-processing",
    );
    const img = host?.querySelector<HTMLElement>("img");

    if (reduce) {
      if (img) gsap.set(img, { filter: PROCESSING_PHOTO_FILTER });
      if (host) gsap.set(host, { opacity: 1, ...SHELL_MASK_FILL });
      gsap.set(fly, { display: "none", clearProps: clearFlyProps });
      return;
    }

    photoShellGrowingRef.current = true;
    gsap.killTweensOf(fly);
    // Soft bottom mask fades back in while we blur + dock (fly starts solid on lift).
    gsap.to(fly, {
      left: local.left,
      top: local.top,
      width: local.width,
      height: local.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      filter: PROCESSING_PHOTO_FILTER,
      ...SHELL_MASK_FILL,
      duration: PROCESSING_BLUR_DURATION,
      ease: "power2.out",
      overwrite: true,
      onComplete: () => {
        if (img) gsap.set(img, { filter: PROCESSING_PHOTO_FILTER });
        if (host) gsap.set(host, { opacity: 1, ...SHELL_MASK_FILL });
        // Crossfade off the fly so the settled host mask doesn't pop.
        gsap.to(fly, {
          opacity: 0,
          duration: 0.25,
          ease: "power2.out",
          overwrite: true,
          onComplete: () => {
            gsap.set(fly, { display: "none", clearProps: clearFlyProps });
            photoShellGrowingRef.current = false;
            placeCardShell("card", false);
          },
        });
      },
    });
  }

  /** Processing → confirm: same fly layer morphs into the confirm hero slot. */
  function settleFlyIntoConfirm() {
    const fly = photoFlyRef.current;
    const hero = confirmHeroRef.current;
    placeCardShell("hidden", false);
    placeCardNameChip("hidden", true);
    if (!fly) return;

    const clearFlyProps =
      "transform,filter,opacity,borderRadius,boxShadow,--shell-mask-0,--shell-mask-1,--shell-mask-2";
    const revealHero = () => {
      if (hero) gsap.set(hero, { opacity: 1, visibility: "visible" });
      gsap.set(fly, { display: "none", clearProps: clearFlyProps });
      photoShellGrowingRef.current = false;
    };

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Keep the hero invisible until the traveling photo lands on it.
    if (hero) gsap.set(hero, { opacity: 0, visibility: "hidden" });

    if (!hero) {
      revealHero();
      return;
    }

    // Measure after layout — screen is at rest (x:0) before this runs.
    const to = hero.getBoundingClientRect();
    const local = stageLocalFromRect(to);
    if (!local || to.width < 8 || to.height < 4) {
      revealHero();
      return;
    }

    if (reduce) {
      revealHero();
      return;
    }

    photoShellGrowingRef.current = true;
    gsap.killTweensOf(fly);
    gsap.to(fly, {
      left: local.left,
      top: local.top,
      width: local.width,
      height: local.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      borderRadius: 11,
      boxShadow: "0 0 0 0 transparent",
      filter: PROCESSING_PHOTO_FILTER_CLEAR,
      // Soft processing mask → solid cover so the hero handoff is seamless.
      ...SHELL_MASK_THUMB,
      duration: 0.75,
      ease: "power3.inOut",
      overwrite: true,
      onComplete: revealHero,
    });
  }

  /** Confirm → animating: morph hero into the center preview and blur/desaturate. */
  function settleFlyIntoAnimating() {
    const fly = photoFlyRef.current;
    const preview = animatingPreviewRef.current;
    placeCardShell("hidden", false);
    placeCardNameChip("hidden", true);
    if (!fly) return;

    const clearFlyProps =
      "transform,filter,opacity,borderRadius,boxShadow,--shell-mask-0,--shell-mask-1,--shell-mask-2";
    const media = preview?.querySelector<HTMLElement>("video, img");
    const revealPreview = () => {
      if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER, opacity: 1 });
      gsap.set(fly, { display: "none", clearProps: clearFlyProps });
      photoShellGrowingRef.current = false;
    };

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Keep the frame; hide only the settled media until the fly lands over it.
    if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER, opacity: 0 });

    if (!preview) {
      revealPreview();
      return;
    }

    const to = preview.getBoundingClientRect();
    const local = stageLocalFromRect(to);
    if (!local || to.width < 8 || to.height < 4) {
      revealPreview();
      return;
    }

    if (reduce) {
      revealPreview();
      return;
    }

    photoShellGrowingRef.current = true;
    gsap.killTweensOf(fly);
    gsap.to(fly, {
      left: local.left,
      top: local.top,
      width: local.width,
      height: local.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      borderRadius: 16,
      boxShadow: "0 0 0 0 transparent",
      filter: PROCESSING_PHOTO_FILTER,
      ...SHELL_MASK_THUMB,
      duration: 0.75,
      ease: "power3.inOut",
      overwrite: true,
      onComplete: () => {
        if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER, opacity: 1 });
        gsap.to(fly, {
          opacity: 0,
          duration: 0.22,
          ease: "power2.out",
          overwrite: true,
          onComplete: () => {
            gsap.set(fly, { display: "none", clearProps: clearFlyProps });
            photoShellGrowingRef.current = false;
          },
        });
      },
    });
  }

  /** Animating → Animated / Dressing → Dressed: morph blurred clip into clear result. */
  function settleFlyIntoClearPreview(preview: HTMLElement | null) {
    const fly = photoFlyRef.current;
    placeCardShell("hidden", false);
    placeCardNameChip("hidden", true);
    if (!fly) return;

    const clearFlyProps =
      "transform,filter,opacity,borderRadius,boxShadow,--shell-mask-0,--shell-mask-1,--shell-mask-2";
    const media = preview?.querySelector<HTMLElement>("video, img");
    const revealPreview = () => {
      if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER_CLEAR, opacity: 1 });
      if (preview) gsap.set(preview, { opacity: 1, visibility: "visible" });
      const flyVideo = fly.querySelector("video");
      if (flyVideo) flyVideo.pause();
      gsap.set(fly, { display: "none", clearProps: clearFlyProps });
      photoShellGrowingRef.current = false;
    };

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER_CLEAR, opacity: 0 });
    if (preview) gsap.set(preview, { opacity: 0, visibility: "hidden" });

    if (!preview) {
      revealPreview();
      return;
    }

    const to = preview.getBoundingClientRect();
    const local = stageLocalFromRect(to);
    if (!local || to.width < 8 || to.height < 4) {
      revealPreview();
      return;
    }

    if (reduce) {
      revealPreview();
      return;
    }

    photoShellGrowingRef.current = true;
    gsap.killTweensOf(fly);
    gsap.to(fly, {
      left: local.left,
      top: local.top,
      width: local.width,
      height: local.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      borderRadius: 16,
      boxShadow: "0 0 0 0 transparent",
      filter: PROCESSING_PHOTO_FILTER_CLEAR,
      ...SHELL_MASK_THUMB,
      duration: 0.75,
      ease: "power3.inOut",
      overwrite: true,
      onComplete: () => {
        if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER_CLEAR, opacity: 1 });
        if (preview) gsap.set(preview, { opacity: 1, visibility: "visible" });
        gsap.to(fly, {
          opacity: 0,
          duration: 0.22,
          ease: "power2.out",
          overwrite: true,
          onComplete: () => {
            const flyVideo = fly.querySelector("video");
            if (flyVideo) flyVideo.pause();
            gsap.set(fly, { display: "none", clearProps: clearFlyProps });
            photoShellGrowingRef.current = false;
          },
        });
      },
    });
  }

  function settleFlyIntoAnimated() {
    settleFlyIntoClearPreview(animatedPreviewRef.current);
  }

  function settleFlyIntoDressed() {
    settleFlyIntoClearPreview(dressedPreviewRef.current);
  }

  /** Dressed → Meshing: morph into center preview, blur + fade (keep color). */
  function settleFlyIntoMeshing() {
    const fly = photoFlyRef.current;
    const preview = meshingPreviewRef.current;
    placeCardShell("hidden", false);
    placeCardNameChip("hidden", true);
    if (!fly) return;

    const clearFlyProps =
      "transform,filter,opacity,borderRadius,boxShadow,--shell-mask-0,--shell-mask-1,--shell-mask-2";
    const media = preview?.querySelector<HTMLElement>("video, img");
    const revealPreview = () => {
      if (media) {
        gsap.set(media, {
          filter: MESHING_PHOTO_FILTER,
          opacity: MESHING_PHOTO_OPACITY,
        });
      }
      if (preview) gsap.set(preview, { opacity: 1, visibility: "visible" });
      const flyVideo = fly.querySelector("video");
      if (flyVideo) flyVideo.pause();
      gsap.set(fly, { display: "none", clearProps: clearFlyProps });
      photoShellGrowingRef.current = false;
    };

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (media) gsap.set(media, { filter: MESHING_PHOTO_FILTER, opacity: 0 });
    if (preview) gsap.set(preview, { opacity: 0, visibility: "hidden" });

    if (!preview) {
      revealPreview();
      return;
    }

    const to = preview.getBoundingClientRect();
    const local = stageLocalFromRect(to);
    if (!local || to.width < 8 || to.height < 4) {
      revealPreview();
      return;
    }

    if (reduce) {
      revealPreview();
      return;
    }

    photoShellGrowingRef.current = true;
    gsap.killTweensOf(fly);
    gsap.to(fly, {
      left: local.left,
      top: local.top,
      width: local.width,
      height: local.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      borderRadius: 16,
      boxShadow: "0 0 0 0 transparent",
      filter: MESHING_PHOTO_FILTER,
      opacity: MESHING_PHOTO_OPACITY,
      ...SHELL_MASK_THUMB,
      duration: 0.75,
      ease: "power3.inOut",
      overwrite: true,
      onComplete: () => {
        if (media) {
          gsap.set(media, {
            filter: MESHING_PHOTO_FILTER,
            opacity: MESHING_PHOTO_OPACITY,
          });
        }
        if (preview) gsap.set(preview, { opacity: 1, visibility: "visible" });
        gsap.to(fly, {
          opacity: 0,
          duration: 0.22,
          ease: "power2.out",
          overwrite: true,
          onComplete: () => {
            const flyVideo = fly.querySelector("video");
            if (flyVideo) flyVideo.pause();
            gsap.set(fly, { display: "none", clearProps: clearFlyProps });
            photoShellGrowingRef.current = false;
          },
        });
      },
    });
  }

  /** Outfit → Dressing: morph hero into the center preview and blur/desaturate. */
  function settleFlyIntoDressing() {
    const fly = photoFlyRef.current;
    const preview = dressingPreviewRef.current;
    placeCardShell("hidden", false);
    placeCardNameChip("hidden", true);
    if (!fly) return;

    const clearFlyProps =
      "transform,filter,opacity,borderRadius,boxShadow,--shell-mask-0,--shell-mask-1,--shell-mask-2";
    const media = preview?.querySelector<HTMLElement>("video, img");
    const revealPreview = () => {
      if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER, opacity: 1 });
      if (preview) gsap.set(preview, { opacity: 1, visibility: "visible" });
      const flyVideo = fly.querySelector("video");
      if (flyVideo) flyVideo.pause();
      gsap.set(fly, { display: "none", clearProps: clearFlyProps });
      photoShellGrowingRef.current = false;
    };

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER, opacity: 0 });
    if (preview) gsap.set(preview, { opacity: 0, visibility: "hidden" });

    if (!preview) {
      revealPreview();
      return;
    }

    const to = preview.getBoundingClientRect();
    const local = stageLocalFromRect(to);
    if (!local || to.width < 8 || to.height < 4) {
      revealPreview();
      return;
    }

    if (reduce) {
      revealPreview();
      return;
    }

    photoShellGrowingRef.current = true;
    gsap.killTweensOf(fly);
    gsap.to(fly, {
      left: local.left,
      top: local.top,
      width: local.width,
      height: local.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      borderRadius: 16,
      boxShadow: "0 0 0 0 transparent",
      filter: PROCESSING_PHOTO_FILTER,
      ...SHELL_MASK_THUMB,
      duration: 0.75,
      ease: "power3.inOut",
      overwrite: true,
      onComplete: () => {
        if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER, opacity: 1 });
        if (preview) gsap.set(preview, { opacity: 1, visibility: "visible" });
        gsap.to(fly, {
          opacity: 0,
          duration: 0.22,
          ease: "power2.out",
          overwrite: true,
          onComplete: () => {
            const flyVideo = fly.querySelector("video");
            if (flyVideo) flyVideo.pause();
            gsap.set(fly, { display: "none", clearProps: clearFlyProps });
            photoShellGrowingRef.current = false;
          },
        });
      },
    });
  }

  /** Morph a flying clip into a confirm-style hero (Outfit / Adjust Mask). */
  function settleFlyIntoHero(hero: HTMLDivElement | null) {
    const fly = photoFlyRef.current;
    placeCardShell("hidden", false);
    placeCardNameChip("hidden", true);
    if (!fly) return;

    const clearFlyProps =
      "transform,filter,opacity,borderRadius,boxShadow,--shell-mask-0,--shell-mask-1,--shell-mask-2";
    const media = hero?.querySelector<HTMLElement>("video, img");
    const revealHero = () => {
      if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER_CLEAR, opacity: 1 });
      if (hero) gsap.set(hero, { opacity: 1, visibility: "visible" });
      const flyVideo = fly.querySelector("video");
      if (flyVideo) flyVideo.pause();
      gsap.set(fly, { display: "none", clearProps: clearFlyProps });
      photoShellGrowingRef.current = false;
    };

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (hero) gsap.set(hero, { opacity: 0, visibility: "hidden" });
    if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER_CLEAR, opacity: 0 });

    if (!hero) {
      revealHero();
      return;
    }

    const to = hero.getBoundingClientRect();
    const local = stageLocalFromRect(to);
    if (!local || to.width < 8 || to.height < 4) {
      revealHero();
      return;
    }

    if (reduce) {
      revealHero();
      return;
    }

    photoShellGrowingRef.current = true;
    gsap.killTweensOf(fly);
    gsap.to(fly, {
      left: local.left,
      top: local.top,
      width: local.width,
      height: local.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      borderRadius: 11,
      boxShadow: "0 0 0 0 transparent",
      filter: PROCESSING_PHOTO_FILTER_CLEAR,
      opacity: 1,
      ...SHELL_MASK_THUMB,
      duration: 0.75,
      ease: "power3.inOut",
      overwrite: true,
      onComplete: () => {
        if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER_CLEAR, opacity: 1 });
        if (hero) gsap.set(hero, { opacity: 1, visibility: "visible" });
        gsap.to(fly, {
          opacity: 0,
          duration: 0.22,
          ease: "power2.out",
          overwrite: true,
          onComplete: () => {
            const flyVideo = fly.querySelector("video");
            if (flyVideo) flyVideo.pause();
            gsap.set(fly, { display: "none", clearProps: clearFlyProps });
            photoShellGrowingRef.current = false;
          },
        });
      },
    });
  }

  function settleFlyIntoOutfit() {
    settleFlyIntoHero(outfitHeroRef.current);
  }

  /** Meshing → Adjust Mask: unblur + full opacity while flying into the hero. */
  function settleFlyIntoSymbols() {
    settleFlyIntoHero(symbolsHeroRef.current);
  }

  function settleFlyIntoCreated() {
    settleFlyIntoClearPreview(createdPreviewRef.current);
  }

  function settleFlyIntoMask() {
    const fly = photoFlyRef.current;
    const hero = maskHeroRef.current;
    placeCardShell("hidden", false);
    placeCardNameChip("hidden", true);
    if (!fly) return;

    const clearFlyProps =
      "transform,filter,opacity,borderRadius,boxShadow,--shell-mask-0,--shell-mask-1,--shell-mask-2";
    const media = hero?.querySelector<HTMLElement>("video, img");
    const revealHero = () => {
      if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER_CLEAR, opacity: 1 });
      if (hero) gsap.set(hero, { opacity: 1, visibility: "visible" });
      const flyVideo = fly.querySelector("video");
      if (flyVideo) flyVideo.pause();
      gsap.set(fly, { display: "none", clearProps: clearFlyProps });
      photoShellGrowingRef.current = false;
    };

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (hero) gsap.set(hero, { opacity: 0, visibility: "hidden" });
    if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER_CLEAR, opacity: 0 });

    if (!hero) {
      revealHero();
      return;
    }

    const to = hero.getBoundingClientRect();
    const local = stageLocalFromRect(to);
    if (!local || to.width < 8 || to.height < 4) {
      revealHero();
      return;
    }

    if (reduce) {
      revealHero();
      return;
    }

    photoShellGrowingRef.current = true;
    gsap.killTweensOf(fly);
    gsap.set(fly, {
      display: "block",
      filter: MESHING_PHOTO_FILTER,
      opacity: MESHING_PHOTO_OPACITY,
      ...SHELL_MASK_THUMB,
    });
    gsap.to(fly, {
      left: local.left,
      top: local.top,
      width: local.width,
      height: local.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      borderRadius: 11,
      boxShadow: "0 0 0 0 transparent",
      filter: PROCESSING_PHOTO_FILTER_CLEAR,
      opacity: 1,
      ...SHELL_MASK_THUMB,
      duration: 0.85,
      ease: "power3.inOut",
      overwrite: true,
      onComplete: () => {
        if (media) gsap.set(media, { filter: PROCESSING_PHOTO_FILTER_CLEAR, opacity: 1 });
        if (hero) gsap.set(hero, { opacity: 1, visibility: "visible" });
        gsap.to(fly, {
          opacity: 0,
          duration: 0.22,
          ease: "power2.out",
          overwrite: true,
          onComplete: () => {
            const flyVideo = fly.querySelector("video");
            if (flyVideo) flyVideo.pause();
            gsap.set(fly, { display: "none", clearProps: clearFlyProps });
            photoShellGrowingRef.current = false;
          },
        });
      },
    });
  }

  /** Processing → swimwear: clear filter on fly, hand back to host + bikini. */
  function settleFlyIntoSwimwear() {
    const fly = photoFlyRef.current;
    const shell = cardShellRef.current;
    const src = image.trim();
    if (!fly || !shell || !src) {
      placeCardShell("card", false);
      if (src) setShellPhotoFill(true);
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    placeCardShell("card", false);
    setShellPhotoFill(true);
    const to = shell.getBoundingClientRect();
    const local = stageLocalFromRect(to);
    if (!local || to.width < 1) {
      gsap.set(fly, { display: "none", clearProps: "transform,filter" });
      return;
    }

    if (reduce) {
      gsap.set(fly, { display: "none", clearProps: "transform,filter" });
      return;
    }

    photoShellGrowingRef.current = true;
    gsap.killTweensOf(fly);
    gsap.to(fly, {
      left: local.left,
      top: local.top,
      width: local.width,
      height: local.height,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      filter: PROCESSING_PHOTO_FILTER_CLEAR,
      duration: 0.55,
      ease: "power2.out",
      overwrite: true,
      onComplete: () => {
        gsap.set(fly, { display: "none", clearProps: "transform,filter" });
        photoShellGrowingRef.current = false;
        placeCardShell("card", false);
        setShellPhotoFill(true);
      },
    });
  }

  /** Reverse: photo-filled shell shrinks back to the Add Photo thumb. */
  function shrinkPhotoToThumb(from: DOMRect) {
    const shell = cardShellRef.current;
    const fly = photoFlyRef.current;
    const thumb = previewThumbRef.current;
    const clear = previewClearRef.current;
    const src = image.trim();
    if (!shell || !fly || !thumb || !src) {
      setShellPhotoFill(false);
      placeCardShell("card", false);
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Fly takes over the fill so the glass shell can return underneath.
    setShellPhotoFill(false);
    placeCardShell("card", false);
    // Remounted Add Photo still has the dashed upload at full height — collapse
    // it first so the thumb rect is the resting selected slot (higher up).
    snapPhotoSelectedLayout({ hideThumb: true });
    const to = thumb.getBoundingClientRect();
    if (to.width < 1 || to.height < 1 || reduce) {
      gsap.set(fly, { display: "none" });
      gsap.set([thumb, clear].filter(Boolean), { opacity: 1, clearProps: "opacity" });
      return;
    }

    // Park at thumb size, then invert from the shell rect (same FLIP as grow).
    if (!placePhotoFly(to, src)) {
      gsap.set([thumb, clear].filter(Boolean), { opacity: 1, clearProps: "opacity" });
      return;
    }

    photoShellGrowingRef.current = true;
    gsap.fromTo(
      fly,
      {
        x: from.left - to.left,
        y: from.top - to.top,
        scaleX: from.width / to.width,
        scaleY: from.height / to.height,
        transformOrigin: "0% 0%",
        ...SHELL_MASK_FILL,
      },
      {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        ...SHELL_MASK_THUMB,
        duration: 0.85,
        ease: "power3.inOut",
        overwrite: true,
        onComplete: () => {
          gsap.set(fly, {
            display: "none",
            clearProps: "transform,--shell-mask-0,--shell-mask-1,--shell-mask-2",
          });
          gsap.set([thumb, clear].filter(Boolean), { opacity: 1, clearProps: "opacity" });
          photoShellGrowingRef.current = false;
        },
      },
    );
  }

  /** Tight text chip coords — width is always max-content, never the slot. */
  function cardNameChipPose(
    mode: "edit" | "card",
  ): { left: number; top: number; fontSize: string; color: string; opacity: number } | null {
    const chip = cardNameChipRef.current;
    const slot =
      mode === "edit" ? cardNameEditSlotRef.current : cardNameCardSlotRef.current;
    if (!chip || !slot) return null;

    const fontSize = mode === "edit" ? "1rem" : "0.8rem";
    const color = mode === "edit" ? "#fff" : "rgba(255, 255, 255, 0.55)";
    const label = cardLabel.trim();

    gsap.set(chip, {
      display: "flex",
      width: "max-content",
      maxWidth: "max-content",
      height: "auto",
      padding: 0,
      fontSize,
      color,
      justifyContent: "flex-start",
      whiteSpace: "nowrap",
      x: 0,
      y: 0,
      scale: 1,
    });
    const text = chip.getBoundingClientRect();
    const box = slot.getBoundingClientRect();
    if (box.width < 8 || box.height < 4 || text.width < 1) return null;

    if (mode === "edit") {
      return {
        left: box.left + 16,
        top: box.top + (box.height - text.height) / 2,
        fontSize,
        color,
        opacity: label ? 1 : 0,
      };
    }

    // Land on the card label corner (~ stage pad + card pad ≈ 2rem from viewport).
    const rightEdge = box.right;
    return {
      left: rightEdge - text.width,
      top: box.top + (box.height - text.height) / 2,
      fontSize,
      color,
      opacity: 1,
    };
  }

  function placeCardNameChip(mode: "edit" | "card" | "hidden", animate: boolean) {
    const chip = cardNameChipRef.current;
    if (!chip) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const motion = animate && !reduce;

    if (mode === "hidden") {
      cardNameChipModeRef.current = "hidden";
      if (motion) {
        gsap.to(chip, {
          opacity: 0,
          duration: 0.2,
          overwrite: true,
          onComplete: () => {
            gsap.set(chip, { display: "none" });
          },
        });
      } else {
        gsap.set(chip, { display: "none", opacity: 0 });
      }
      return;
    }

    const pose = cardNameChipPose(mode);
    if (!pose) return;
    const prev = cardNameChipModeRef.current;
    cardNameChipModeRef.current = mode;
    gsap.killTweensOf(chip);
    const target = {
      display: "flex",
      left: pose.left,
      top: pose.top,
      width: "max-content",
      maxWidth: "max-content",
      height: "auto",
      padding: 0,
      fontSize: pose.fontSize,
      color: pose.color,
      opacity: pose.opacity,
      x: 0,
      y: 0,
      scale: 1,
    };
    if (!motion) {
      gsap.set(chip, target);
      return;
    }
    if (prev === "hidden") {
      gsap.set(chip, { ...target, opacity: 0 });
      gsap.to(chip, {
        opacity: pose.opacity,
        duration: 0.28,
        ease: "power2.out",
        overwrite: true,
      });
      return;
    }
    gsap.to(chip, { ...target, duration: 0.35, ease: "power2.out", overwrite: true });
  }

  /**
   * Manual FLIP: final font/pose first, then invert with x/y/scale from top-left.
   * Scaling from 0% 0% keeps the right edge between from.right and to.right — no viewport kiss.
   */
  function flipCardNameChip(from: DOMRect, mode: "edit" | "card") {
    const chip = cardNameChipRef.current;
    const slot =
      mode === "edit" ? cardNameEditSlotRef.current : cardNameCardSlotRef.current;
    if (!chip || !slot) {
      placeCardNameChip(mode, false);
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const card = slot.closest(".leo-ui__upload-card");
    if (card) gsap.set(card, { y: 0, clearProps: "transform" });

    placeCardNameChip(mode, false);
    gsap.set(chip, {
      transformOrigin: "0% 0%",
      x: 0,
      y: 0,
      scale: 1,
      width: "max-content",
      maxWidth: "max-content",
    });
    const to = chip.getBoundingClientRect();
    if (to.width < 1 || to.height < 1) return;

    if (reduce) {
      cardNameFlippingRef.current = false;
      return;
    }

    const sx = from.width / to.width;
    const endColor = mode === "card" ? "rgba(255, 255, 255, 0.55)" : "#fff";
    const startColor = mode === "card" ? "#fff" : "rgba(255, 255, 255, 0.55)";
    cardNameFlippingRef.current = true;
    gsap.fromTo(
      chip,
      {
        x: from.left - to.left,
        y: from.top - to.top,
        scale: sx,
        transformOrigin: "0% 0%",
        color: startColor,
      },
      {
        x: 0,
        y: 0,
        scale: 1,
        color: endColor,
        duration: 0.85,
        ease: "power3.inOut",
        overwrite: true,
        onComplete: () => {
          cardNameFlippingRef.current = false;
          gsap.set(chip, { clearProps: "transform" });
          placeCardNameChip(mode, false);
        },
      },
    );
  }

  // Exit current step → swap content → enter next (one continuous chain).
  useGSAP(
    () => {
      if (screen === viewScreen) return;
      const el = screenRef.current;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const dir = screenDir(viewScreen, screen);
      navDirRef.current = dir;

      const fromMode = cardNameChipMode(viewScreen);
      const toMode = cardNameChipMode(screen);
      cardNameFlipFromRef.current = null;
      cardShellFlipFromRef.current = null;
      photoShellFromRef.current = null;
      if (
        (fromMode === "edit" && toMode === "card") ||
        (fromMode === "card" && toMode === "edit")
      ) {
        placeCardNameChip(fromMode, false);
        placeCardShell(fromMode, false);
        const chip = cardNameChipRef.current;
        if (chip && getComputedStyle(chip).display !== "none") {
          cardNameFlipFromRef.current = chip.getBoundingClientRect();
        }
        const shell = cardShellRef.current;
        if (shell && getComputedStyle(shell).display !== "none") {
          cardShellFlipFromRef.current = shell.getBoundingClientRect();
        }
      }

      photoTravelKindRef.current = null;
      // Lift the selected thumb into the fly layer before the screen fades out.
      if (viewScreen === "photo" && screen === "swimwear" && image.trim()) {
        const thumb = previewThumbRef.current;
        const clear = previewClearRef.current;
        if (thumb) {
          const box = thumb.getBoundingClientRect();
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "grow";
          placePhotoFly(box, image);
          gsap.set([thumb, clear].filter(Boolean), { opacity: 0 });
        }
      } else if (viewScreen === "swimwear" && screen === "photo" && image.trim()) {
        const shell = cardShellRef.current;
        if (shell && shellHasPhotoFill()) {
          photoShellFromRef.current = shell.getBoundingClientRect();
          photoTravelKindRef.current = "shrink";
          setShellPhotoFill(false);
          placePhotoFly(photoShellFromRef.current, image);
        }
      } else if (viewScreen === "swimwear" && screen === "processing" && image.trim()) {
        // Lift host photo into the fly layer so it stays while the screen fades.
        const host = screenRef.current?.querySelector<HTMLElement>(".leo-ui__host-photo");
        const shell = cardShellRef.current;
        const box = (host ?? shell)?.getBoundingClientRect();
        if (box && box.width > 8 && box.height > 4) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-processing";
          placePhotoFly(box, image);
          const fly = photoFlyRef.current;
          // Solid mask for travel — soft fill fades back in during settle.
          if (fly) {
            gsap.set(fly, {
              filter: PROCESSING_PHOTO_FILTER_CLEAR,
              opacity: 1,
              ...SHELL_MASK_THUMB,
            });
          }
          if (host) gsap.set(host, { opacity: 0 });
          hideBikiniBlock();
        }
      } else if (viewScreen === "processing" && screen === "swimwear" && image.trim()) {
        const host = screenRef.current?.querySelector<HTMLElement>(".leo-ui__host-photo");
        const shell = cardShellRef.current;
        const box = (host ?? shell)?.getBoundingClientRect();
        if (box && box.width > 8 && box.height > 4) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-swimwear";
          placePhotoFly(box, image);
          const fly = photoFlyRef.current;
          if (fly) {
            gsap.set(fly, {
              filter: PROCESSING_PHOTO_FILTER,
              opacity: 1,
              ...SHELL_MASK_FILL,
            });
          }
          if (host) gsap.set(host, { opacity: 0 });
        }
      } else if (viewScreen === "processing" && screen === "confirm") {
        const host = screenRef.current?.querySelector<HTMLElement>(".leo-ui__host-photo");
        const shell = cardShellRef.current;
        // Prefer the processing-card rect — that's what the user sees morphing away.
        const box = (host ?? shell)?.getBoundingClientRect()
          ?? screenRef.current
            ?.querySelector<HTMLElement>(".leo-ui__processing-card")
            ?.getBoundingClientRect();
        const artifacts = readyPaths(flowState?.steps.picture?.artifacts).filter(
          (path) => pictureChoiceFromArtifact(path) != null,
        );
        const resultSrc =
          artifacts[pictureChoice - 1] ||
          artifacts[0] ||
          image;
        if (box && box.width > 8 && box.height > 4 && resultSrc.trim()) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-confirm";
          placePhotoFly(box, resultSrc);
          const fly = photoFlyRef.current;
          if (fly) {
            gsap.set(fly, {
              filter: PROCESSING_PHOTO_FILTER_CLEAR,
              opacity: 1,
              scale: 1,
              ...SHELL_MASK_FILL,
            });
          }
          if (host) gsap.set(host, { opacity: 0 });
        }
        setShellPhotoFill(false);
      } else if (viewScreen === "processing" && screen === "animating") {
        // Skip Confirm: processing host morphs straight into Animating preview.
        const host = screenRef.current?.querySelector<HTMLElement>(".leo-ui__host-photo");
        const shell = cardShellRef.current;
        const box = (host ?? shell)?.getBoundingClientRect()
          ?? screenRef.current
            ?.querySelector<HTMLElement>(".leo-ui__processing-card")
            ?.getBoundingClientRect();
        const artifacts = readyPaths(flowState?.steps.picture?.artifacts).filter(
          (path) => pictureChoiceFromArtifact(path) != null,
        );
        const resultSrc = artifacts[0] || image;
        if (box && box.width > 8 && box.height > 4 && resultSrc.trim()) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-animating";
          placePhotoFly(box, resultSrc);
          const fly = photoFlyRef.current;
          if (fly) {
            gsap.set(fly, {
              filter: PROCESSING_PHOTO_FILTER_CLEAR,
              opacity: 1,
              scale: 1,
              ...SHELL_MASK_THUMB,
            });
          }
          if (host) gsap.set(host, { opacity: 0 });
        }
        setShellPhotoFill(false);
      } else if (viewScreen === "confirm" && screen === "processing") {
        // Re-Run: hero flies back into the processing card and re-blurs.
        const hero = confirmHeroRef.current;
        const artifacts = readyPaths(flowState?.steps.picture?.artifacts).filter(
          (path) => pictureChoiceFromArtifact(path) != null,
        );
        const resultSrc =
          confirmOverride ||
          artifacts[pictureChoice - 1] ||
          artifacts[0] ||
          image;
        const box = hero?.getBoundingClientRect();
        if (box && box.width > 8 && box.height > 4 && resultSrc.trim()) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-processing";
          placePhotoFly(box, resultSrc);
          const fly = photoFlyRef.current;
          if (fly) {
            gsap.set(fly, {
              filter: PROCESSING_PHOTO_FILTER_CLEAR,
              opacity: 1,
              ...SHELL_MASK_THUMB,
            });
          }
          if (hero) gsap.set(hero, { opacity: 0 });
        }
        setConfirmOverride("");
        setConfirmUploadExitSrc("");
      } else if (viewScreen === "confirm" && screen === "animating") {
        // Approve → Animating: hero morphs into the center preview and blurs.
        hidePhotoFly();
        const hero = confirmHeroRef.current;
        const artifacts = readyPaths(flowState?.steps.picture?.artifacts).filter(
          (path) => pictureChoiceFromArtifact(path) != null,
        );
        const resultSrc =
          confirmOverride ||
          artifacts[pictureChoice - 1] ||
          artifacts[0] ||
          image;
        const box = hero?.getBoundingClientRect();
        if (box && box.width > 8 && box.height > 4 && resultSrc.trim()) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-animating";
          placePhotoFly(box, resultSrc);
          const fly = photoFlyRef.current;
          if (fly) {
            gsap.set(fly, {
              filter: PROCESSING_PHOTO_FILTER_CLEAR,
              opacity: 1,
              scale: 1,
              ...SHELL_MASK_THUMB,
            });
          }
          if (hero) gsap.set(hero, { opacity: 0 });
        }
      } else if (viewScreen === "confirm" && screen === "animated") {
        // Clip already ready — morph confirm hero straight into Animated.
        hidePhotoFly();
        const hero = confirmHeroRef.current;
        const box = hero?.getBoundingClientRect();
        const clip = readyPaths(flowState?.steps.background?.artifacts)[0] || "";
        const artifacts = readyPaths(flowState?.steps.picture?.artifacts).filter(
          (path) => pictureChoiceFromArtifact(path) != null,
        );
        const still =
          confirmOverride ||
          artifacts[pictureChoice - 1] ||
          artifacts[0] ||
          image;
        if (box && box.width > 8 && box.height > 4) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-animated";
          if (clip) placeVideoFly(box, clip, PROCESSING_PHOTO_FILTER_CLEAR);
          else if (still.trim()) placePhotoFly(box, still);
          if (hero) gsap.set(hero, { opacity: 0 });
        }
      } else if (viewScreen === "animating" && screen === "animated") {
        // Blurred clip morphs into the clear Animated preview.
        const preview = animatingPreviewRef.current;
        const video = preview?.querySelector("video");
        const img = preview?.querySelector("img");
        const box = preview?.getBoundingClientRect();
        const src =
          video?.currentSrc ||
          video?.getAttribute("src") ||
          readyPaths(flowState?.steps.background?.artifacts)[0] ||
          "";
        if (box && box.width > 8 && box.height > 4 && src.trim()) {
          hidePhotoFly();
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-animated";
          placeVideoFly(box, src, PROCESSING_PHOTO_FILTER);
          if (preview) gsap.set(preview, { opacity: 0 });
        } else if (box && box.width > 8 && box.height > 4) {
          // Still waiting on video element — fly the hero still instead of
          // abandoning a mid-morph confirm→animating fly.
          const pics = readyPaths(flowState?.steps.picture?.artifacts);
          const still =
            img?.currentSrc ||
            img?.getAttribute("src") ||
            pics[0] ||
            image;
          hidePhotoFly();
          if (still.trim()) {
            photoShellFromRef.current = box;
            photoTravelKindRef.current = "to-animated";
            placePhotoFly(box, still);
            if (preview) gsap.set(preview, { opacity: 0 });
          }
        }
      } else if (viewScreen === "animated" && screen === "outfit") {
        // Result clip morphs into the Choose Outfit hero.
        const preview = animatedPreviewRef.current;
        const video = preview?.querySelector("video");
        const box = preview?.getBoundingClientRect();
        const src =
          video?.currentSrc ||
          video?.getAttribute("src") ||
          "";
        if (box && box.width > 8 && box.height > 4 && src.trim()) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-outfit";
          placeVideoFly(box, src, PROCESSING_PHOTO_FILTER_CLEAR);
          if (preview) gsap.set(preview, { opacity: 0 });
        }
      } else if (viewScreen === "outfit" && screen === "dressing") {
        // Outfit hero morphs into the Dressing preview and blurs.
        const hero = outfitHeroRef.current;
        const video = hero?.querySelector("video");
        const box = hero?.getBoundingClientRect();
        const src =
          video?.currentSrc ||
          video?.getAttribute("src") ||
          "";
        if (box && box.width > 8 && box.height > 4 && src.trim()) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-dressing";
          placeVideoFly(box, src, PROCESSING_PHOTO_FILTER_CLEAR);
          if (hero) gsap.set(hero, { opacity: 0 });
        }
      } else if (viewScreen === "dressing" && screen === "dressed") {
        // Blurred clip morphs into the clear Dressed preview.
        const preview = dressingPreviewRef.current;
        const video = preview?.querySelector("video");
        const box = preview?.getBoundingClientRect();
        const src =
          video?.currentSrc ||
          video?.getAttribute("src") ||
          "";
        if (box && box.width > 8 && box.height > 4 && src.trim()) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-dressed";
          placeVideoFly(box, src, PROCESSING_PHOTO_FILTER);
          if (preview) gsap.set(preview, { opacity: 0 });
        }
      } else if (viewScreen === "dressed" && screen === "meshing") {
        // Clear Dressed clip morphs into center Meshing preview (stay full color).
        const preview = dressedPreviewRef.current;
        const video = preview?.querySelector("video");
        const box = preview?.getBoundingClientRect();
        const src =
          video?.currentSrc ||
          video?.getAttribute("src") ||
          "";
        if (box && box.width > 8 && box.height > 4 && src.trim()) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-meshing";
          placeVideoFly(box, src, PROCESSING_PHOTO_FILTER_CLEAR);
          if (preview) gsap.set(preview, { opacity: 0 });
        }
      } else if (viewScreen === "meshing" && screen === "mask") {
        // Meshing clip lifts into the fly layer (still blurred), then settles into Adjust Mask hero.
        const preview = meshingPreviewRef.current;
        const video = preview?.querySelector("video");
        const box = preview?.getBoundingClientRect();
        const src =
          video?.getAttribute("src") ||
          video?.currentSrc ||
          "";
        if (box && box.width > 8 && box.height > 4 && src.trim()) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-mask";
          placeVideoFly(box, src, MESHING_PHOTO_FILTER);
          const fly = photoFlyRef.current;
          if (fly) {
            gsap.set(fly, {
              display: "block",
              opacity: MESHING_PHOTO_OPACITY,
              filter: MESHING_PHOTO_FILTER,
              ...SHELL_MASK_THUMB,
            });
            const flyVideo = fly.querySelector("video");
            if (flyVideo && video && !flyVideo.paused) {
              try {
                flyVideo.currentTime = video.currentTime;
              } catch {
                /* seek optional */
              }
            }
          }
          // Hide source media + lottie; keep the fly as the only visible clip.
          if (video) gsap.set(video, { opacity: 0 });
          const mark = preview?.querySelector<HTMLElement>(".leo-ui__play-mark");
          if (mark) gsap.set(mark, { opacity: 0 });
        }
      } else if (viewScreen === "mask" && screen === "symbols") {
        // Adjust Mask hero morphs into the Place Symbols hero.
        const hero = maskHeroRef.current;
        const video = hero?.querySelector("video");
        const box = hero?.getBoundingClientRect();
        const src =
          video?.getAttribute("src") ||
          video?.currentSrc ||
          "";
        if (box && box.width > 8 && box.height > 4 && src.trim()) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-symbols";
          placeVideoFly(box, src, PROCESSING_PHOTO_FILTER_CLEAR);
          if (hero) gsap.set(hero, { opacity: 0 });
        }
      } else if (viewScreen === "symbols" && screen === "mask") {
        // Back: centered Place Symbols hero flies into Adjust Mask (left column).
        const hero = symbolsHeroRef.current;
        const video = hero?.querySelector("video");
        const box = hero?.getBoundingClientRect();
        const src =
          video?.getAttribute("src") ||
          video?.currentSrc ||
          "";
        if (box && box.width > 8 && box.height > 4 && src.trim()) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-mask-back";
          placeVideoFly(box, src, PROCESSING_PHOTO_FILTER_CLEAR);
          if (hero) gsap.set(hero, { opacity: 0 });
        }
      } else if (viewScreen === "symbols" && screen === "created") {
        // Place Symbols hero morphs into the centered Game Created preview.
        const hero = symbolsHeroRef.current;
        const video = hero?.querySelector("video");
        const box = hero?.getBoundingClientRect();
        const src =
          video?.getAttribute("src") ||
          video?.currentSrc ||
          "";
        if (box && box.width > 8 && box.height > 4 && src.trim()) {
          photoShellFromRef.current = box;
          photoTravelKindRef.current = "to-created";
          placeVideoFly(box, src, PROCESSING_PHOTO_FILTER_CLEAR);
          if (hero) gsap.set(hero, { opacity: 0 });
        }
      } else if (viewScreen === "swimwear" && screen !== "photo") {
        setShellPhotoFill(false);
        const fly = photoFlyRef.current;
        if (fly) gsap.set(fly, { display: "none", clearProps: "transform" });
      } else if (
        viewScreen === "processing" &&
        screen !== "swimwear" &&
        screen !== "confirm" &&
        screen !== "animating"
      ) {
        setShellPhotoFill(false);
        const fly = photoFlyRef.current;
        if (fly) gsap.set(fly, { display: "none", clearProps: "transform" });
      }

      if (!el || reduce) {
        const fly = photoFlyRef.current;
        if (fly) gsap.set(fly, { display: "none", clearProps: "transform,filter" });
        if (
          (screen === "swimwear" || screen === "processing") &&
          image.trim()
        ) {
          setShellPhotoFill(true);
        } else {
          setShellPhotoFill(false);
        }
        if (screen === "processing") processingEnteredAtRef.current = Date.now();
        photoShellFromRef.current = null;
        photoTravelKindRef.current = null;
        setViewScreen(screen);
        setNavBusy(false);
        navBusyRef.current = false;
        return;
      }

      navBusyRef.current = true;
      setNavBusy(true);
      gsap.killTweensOf(el);
      gsap.to(el, {
        opacity: 0,
        x: dir * -32,
        duration: 0.28,
        ease: "power2.in",
        onComplete: () => {
          pendingEnterRef.current = true;
          setViewScreen(screen);
        },
      });
    },
    { dependencies: [screen], scope: rootRef },
  );

  // Enter the newly swapped step.
  useGSAP(
    () => {
      const el = screenRef.current;
      if (!el || !pendingEnterRef.current) return;
      pendingEnterRef.current = false;
      const dir = navDirRef.current;
      const flipFrom = cardNameFlipFromRef.current;
      const shellFrom = cardShellFlipFromRef.current;
      const photoFrom = photoShellFromRef.current;
      cardNameFlipFromRef.current = null;
      cardShellFlipFromRef.current = null;
      photoShellFromRef.current = null;
      const chipMode = cardNameChipMode(viewScreen);
      const shellMode = cardShellMode(viewScreen);
      const travel = photoTravelKindRef.current;
      photoTravelKindRef.current = null;
      const photoGrow = travel === "grow" && Boolean(photoFrom) && Boolean(image.trim());
      const photoShrink = travel === "shrink" && Boolean(photoFrom) && Boolean(image.trim());
      const photoToProcessing =
        travel === "to-processing" && Boolean(photoFrom) && Boolean(image.trim());
      const photoFromProcessing =
        travel === "to-swimwear" && Boolean(photoFrom) && Boolean(image.trim());
      const photoToConfirm = travel === "to-confirm" && Boolean(photoFrom);
      const photoToAnimating = travel === "to-animating" && Boolean(photoFrom);
      const photoToAnimated = travel === "to-animated" && Boolean(photoFrom);
      const photoToOutfit = travel === "to-outfit" && Boolean(photoFrom);
      const photoToDressing = travel === "to-dressing" && Boolean(photoFrom);
      const photoToDressed = travel === "to-dressed" && Boolean(photoFrom);
      const photoToMeshing = travel === "to-meshing" && Boolean(photoFrom);
      const photoToMask = travel === "to-mask" && Boolean(photoFrom);
      const photoToMaskBack = travel === "to-mask-back" && Boolean(photoFrom);
      const photoToSymbols = travel === "to-symbols" && Boolean(photoFrom);
      const photoToCreated = travel === "to-created" && Boolean(photoFrom);
      const flipping =
        (Boolean(flipFrom || shellFrom) && chipMode !== "hidden") ||
        photoGrow ||
        photoShrink ||
        photoToProcessing ||
        photoFromProcessing ||
        photoToConfirm ||
        photoToAnimating ||
        photoToAnimated ||
        photoToOutfit ||
        photoToDressing ||
        photoToDressed ||
        photoToMeshing ||
        photoToMask ||
        photoToMaskBack ||
        photoToSymbols ||
        photoToCreated;

      gsap.killTweensOf(el);
      // Measure destinations at rest — slide-in would skew slot rects by ~36px.
      gsap.set(el, { x: 0 });
      if (flipFrom && chipMode !== "hidden") {
        flipCardNameChip(flipFrom, chipMode);
      } else {
        placeCardNameChip(chipMode, true);
      }
      if (photoGrow && photoFrom) {
        hideBikiniBlock();
        growPhotoIntoShell(photoFrom);
      } else if (photoShrink && photoFrom) {
        shrinkPhotoToThumb(photoFrom);
      } else if (photoToProcessing) {
        settleFlyIntoProcessing();
      } else if (photoFromProcessing) {
        settleFlyIntoSwimwear();
      } else if (photoToConfirm) {
        settleFlyIntoConfirm();
      } else if (photoToAnimating) {
        settleFlyIntoAnimating();
      } else if (photoToAnimated) {
        settleFlyIntoAnimated();
      } else if (photoToOutfit) {
        settleFlyIntoOutfit();
      } else if (photoToDressing) {
        settleFlyIntoDressing();
      } else if (photoToDressed) {
        settleFlyIntoDressed();
      } else if (photoToMeshing) {
        settleFlyIntoMeshing();
      } else if (photoToMask) {
        settleFlyIntoMask();
      } else if (photoToMaskBack) {
        // Clear clip — same settle as Outfit/Symbols hero landings (no meshing blur).
        settleFlyIntoHero(maskHeroRef.current);
      } else if (photoToSymbols) {
        settleFlyIntoSymbols();
      } else if (photoToCreated) {
        settleFlyIntoCreated();
      } else if (shellFrom && shellMode !== "hidden") {
        flipCardShell(shellFrom, shellMode);
      } else if (shellMode !== "hidden") {
        if (
          (viewScreen === "swimwear" || viewScreen === "processing") &&
          image.trim()
        ) {
          setShellPhotoFill(true);
        }
        placeCardShell(shellMode, true);
      } else {
        placeCardShell("hidden", false);
      }
      if (viewScreen === "processing") {
        processingEnteredAtRef.current = Date.now();
      }
      gsap.fromTo(
        el,
        { opacity: 0, x: dir * 36 },
        {
          opacity: 1,
          x: 0,
          duration: 0.42,
          ease: "power3.out",
          // Clear both — leftover opacity/transform makes a backdrop root.
          clearProps: "transform,opacity",
          onComplete: () => {
            navBusyRef.current = false;
            setNavBusy(false);
          },
        },
      );

      // Keep upload-card / confirm hero / animating preview still while the photo fly morphs.
      const bits = el.querySelectorAll(
        photoToConfirm
          ? ".leo-ui__title, .leo-ui__sub, .leo-ui__confirm-side, .leo-ui__confirm-thumbs"
          : photoToAnimating || photoToDressing || photoToMeshing
            ? ".leo-ui__title, .leo-ui__sub, .leo-ui__play-mark, .leo-ui__busy"
            : photoToAnimated || photoToDressed || photoToCreated
              ? ".leo-ui__title, .leo-ui__sub"
              : photoToOutfit || photoToMask || photoToSymbols
                ? ".leo-ui__title, .leo-ui__sub, .leo-ui__confirm-side"
                : flipping
                  ? ".leo-ui__title, .leo-ui__sub, .leo-ui__search, .leo-ui__section-label, .leo-ui__list, .leo-ui__stack, .leo-ui__choices, .leo-ui__preview, .leo-ui__selected-panel, .leo-ui__ghost-btn"
                  : ".leo-ui__title, .leo-ui__sub, .leo-ui__search, .leo-ui__section-label, .leo-ui__list, .leo-ui__stack, .leo-ui__upload-card, .leo-ui__choices, .leo-ui__confirm, .leo-ui__preview, .leo-ui__selected-panel, .leo-ui__ghost-btn",
      );
      if (bits.length) {
        gsap.fromTo(
          bits,
          { opacity: 0, y: 14 },
          {
            opacity: 1,
            y: 0,
            duration: 0.36,
            stagger: 0.045,
            ease: "power2.out",
            clearProps: "transform",
            delay: 0.04,
          },
        );
      }
      // Try Again slides up from under the preview bottom after the video lands.
      if (viewScreen === "animated" || viewScreen === "dressed") {
        const tryAgain = el.querySelector<HTMLElement>(
          ".leo-ui__preview--animated .leo-ui__ghost-btn",
        );
        if (tryAgain) {
          const reduceMotion =
            typeof window !== "undefined" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          gsap.killTweensOf(tryAgain);
          if (reduceMotion) {
            gsap.set(tryAgain, { opacity: 1, y: 0, clearProps: "transform" });
          } else {
            gsap.fromTo(
              tryAgain,
              { opacity: 0, y: "100%" },
              {
                opacity: 1,
                y: 0,
                duration: 0.45,
                ease: "power3.out",
                delay: photoToAnimated || photoToDressed ? 0.9 : 0.12,
                clearProps: "transform",
              },
            );
          }
        }
      }
      if (flipping) {
        const card = el.querySelector<HTMLElement>(".leo-ui__upload-card--host");
        if (card) {
          gsap.fromTo(
            card.querySelectorAll<HTMLElement>(":scope > *"),
            { opacity: 0 },
            {
              opacity: 1,
              duration: 0.4,
              ease: "power2.out",
              delay: 0.04,
              // Don't leave inline opacity on the slot — it fights gallery thumb opacity.
              clearProps: "opacity",
            },
          );
        }
      }

    },
    { dependencies: [viewScreen], scope: rootRef },
  );

  // Re-dock shared chip + shell when idle.
  useGSAP(
    () => {
      if (
        navBusy ||
        cardNameFlippingRef.current ||
        cardShellFlippingRef.current ||
        photoShellGrowingRef.current
      ) {
        return;
      }
      placeCardNameChip(cardNameChipMode(viewScreen), false);
      placeCardShell(cardShellMode(viewScreen), false);
    },
    { dependencies: [cardLabel, viewScreen, navBusy], scope: rootRef },
  );

  // Phase pill slides across; slot widths tween so dots make room.
  useGSAP(
    () => {
      const track = phasesRef.current;
      const pill = phasePillRef.current;
      if (!track || !pill) return;
      const dots = Array.from(track.querySelectorAll<HTMLElement>(".leo-ui__phase"));
      if (dots.length === 0) return;

      const styles = getComputedStyle(track);
      const gap =
        Number.parseFloat(styles.columnGap || styles.gap) || 4.5;
      const padL = Number.parseFloat(styles.paddingLeft) || 0;
      const slotLeft = (index: number, activeIdx: number) => {
        let x = padL;
        for (let i = 0; i < index; i += 1) {
          x += (i === activeIdx ? PHASE_PILL_W_PX : PHASE_DOT_PX) + gap;
        }
        return x;
      };
      const targetX = slotLeft(phase, phase);
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (!pill.dataset.ready || reduce) {
        dots.forEach((dot, i) => {
          gsap.set(dot, {
            width: i === phase ? PHASE_PILL_W_PX : PHASE_DOT_PX,
          });
        });
        gsap.set(pill, {
          x: targetX,
          width: PHASE_PILL_W_PX,
          scaleX: 1,
          scaleY: 1,
          transformOrigin: "50% 50%",
        });
        pill.dataset.ready = "1";
        return;
      }

      const fromX = Number(gsap.getProperty(pill, "x")) || 0;
      const dir = Math.sign(targetX - fromX) || 1;
      gsap.killTweensOf([pill, ...dots]);

      const tl = gsap.timeline();
      // Anticipation: pull opposite + jelly squash, then launch.
      tl.to(pill, {
        x: fromX - dir * PHASE_PILL_ANTICIPATE_PX,
        scaleX: 0.82,
        scaleY: 1.18,
        duration: PHASE_PILL_ANTICIPATE,
        ease: "power2.out",
      });
      tl.to(
        pill,
        {
          x: targetX,
          width: PHASE_PILL_W_PX,
          scaleX: 1.06,
          scaleY: 0.94,
          duration: PHASE_PILL_DURATION,
          ease: "power3.inOut",
        },
        "travel",
      );
      dots.forEach((dot, i) => {
        tl.to(
          dot,
          {
            width: i === phase ? PHASE_PILL_W_PX : PHASE_DOT_PX,
            duration: PHASE_PILL_DURATION,
            ease: "power3.inOut",
          },
          "travel",
        );
      });
      tl.to(pill, {
        scaleX: 1,
        scaleY: 1,
        duration: 0.18,
        ease: "power2.out",
      });
    },
    { dependencies: [phase], scope: rootRef },
  );

  // Back ↔ Next morph: same footer nodes; Next flexes as Back opens/closes.
  useGSAP(
    () => {
      const back = backBtnRef.current;
      if (!back) return;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const open = {
        width: 110,
        opacity: 1,
        paddingLeft: 16,
        paddingRight: 16,
        marginRight: 12,
      };
      const closed = {
        width: 0,
        opacity: 0,
        paddingLeft: 0,
        paddingRight: 0,
        marginRight: 0,
      };
      const target = showBack ? open : closed;
      back.tabIndex = showBack ? 0 : -1;
      back.setAttribute("aria-hidden", showBack ? "false" : "true");
      if (!backReadyRef.current || reduce) {
        gsap.set(back, target);
        backReadyRef.current = true;
        return;
      }
      gsap.to(back, {
        ...target,
        duration: 0.45,
        ease: "power3.inOut",
        overwrite: true,
      });
    },
    { dependencies: [showBack], scope: rootRef },
  );

  // Next button breathes with each stage change (same node, not a remount).
  useGSAP(
    () => {
      const next = nextBtnRef.current;
      if (!next || !backReadyRef.current) return;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) return;
      gsap.fromTo(
        next,
        { scale: 1, filter: "brightness(1)" },
        {
          scale: 1.025,
          filter: "brightness(1.12)",
          duration: 0.24,
          yoyo: true,
          repeat: 1,
          ease: "power2.out",
          clearProps: "transform,filter",
        },
      );
    },
    { dependencies: [screen], scope: rootRef },
  );

  const UPLOAD_DASHED_H = 127;

  /** Collapse the dashed upload so the thumb sits in its resting slot (no morph). */
  function snapPhotoSelectedLayout(opts?: { hideThumb?: boolean }) {
    const media = uploadMediaRef.current;
    const dashed = uploadDashedRef.current;
    const thumb = previewThumbRef.current;
    const clear = previewClearRef.current;
    gsap.killTweensOf([media, dashed, thumb, clear].filter(Boolean));
    if (dashed) {
      gsap.set(dashed, {
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        width: "100%",
        height: 0,
        minHeight: 0,
        opacity: 0,
        borderWidth: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 2,
      });
    }
    if (media) gsap.set(media, { clearProps: "height,overflow" });
    if (thumb) {
      gsap.set(thumb, {
        opacity: opts?.hideThumb ? 0 : 1,
        scale: 1,
        y: 0,
        transformOrigin: "50% 50%",
      });
    }
    if (clear) {
      gsap.set(clear, {
        opacity: opts?.hideThumb ? 0 : 1,
        scale: 1,
        transformOrigin: "50% 50%",
      });
    }
  }

  // Photo added: morph media height (no layout snap) → thumbnail in → close ×.
  // Returning from Swimwear with image already set: snap only (dashed stays gone).
  useGSAP(
    () => {
      if (viewScreen !== "photo") return;

      const media = uploadMediaRef.current;
      const dashed = uploadDashedRef.current;
      const wrap = previewWrapRef.current;
      const thumb = previewThumbRef.current;
      const clear = previewClearRef.current;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (!image) {
        photoImageOnScreenRef.current = "";
        if (dashed) {
          gsap.killTweensOf(dashed);
          gsap.set(dashed, {
            height: UPLOAD_DASHED_H,
            minHeight: UPLOAD_DASHED_H,
            opacity: 1,
            borderWidth: 2,
            overflow: "hidden",
            pointerEvents: "auto",
            clearProps: "position,left,right,top,width,zIndex",
          });
        }
        if (media) {
          gsap.killTweensOf(media);
          gsap.set(media, { clearProps: "height,overflow" });
        }
        return;
      }

      if (!media || !dashed || !wrap || !thumb || !clear) return;

      const returning = Boolean(photoImageOnScreenRef.current);
      photoImageOnScreenRef.current = image;

      // Already had a photo on this step (e.g. back from Swimwear) — don't reopen Upload.
      if (returning) {
        snapPhotoSelectedLayout({
          hideThumb: photoShellGrowingRef.current || Boolean(photoShellFromRef.current),
        });
        return;
      }

      gsap.killTweensOf([media, dashed, wrap, thumb, clear]);

      const toH = Math.max(wrap.offsetHeight, 1);

      if (reduce) {
        snapPhotoSelectedLayout();
        return;
      }

      // Lock media height, pull dashed out of flow — then ease height to the thumb.
      gsap.set(media, { height: UPLOAD_DASHED_H, overflow: "hidden" });
      gsap.set(dashed, {
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        width: "100%",
        overflow: "hidden",
        zIndex: 2,
      });
      gsap.set(thumb, { opacity: 0, scale: 0.86, y: 14, transformOrigin: "50% 50%" });
      gsap.set(clear, { scale: 0.5, transformOrigin: "50% 50%" });

      const tl = gsap.timeline({
        defaults: { overwrite: "auto" },
        onComplete: () => {
          gsap.set(media, { clearProps: "height", overflow: "visible" });
        },
      });
      tl.to(media, { height: toH, duration: 0.42, ease: "power2.inOut" }, 0);
      tl.to(
        dashed,
        {
          height: 0,
          minHeight: 0,
          opacity: 0,
          borderWidth: 0,
          duration: 0.42,
          ease: "power2.inOut",
          pointerEvents: "none",
        },
        0,
      );
      tl.to(thumb, { opacity: 1, scale: 1, y: 0, duration: 0.4, ease: "power2.out" }, 0.12);
      tl.to(clear, { scale: 1, duration: 0.3, ease: "back.out(1.7)" }, 0.28);
    },
    { dependencies: [image, viewScreen], scope: rootRef },
  );

  function clearPhoto() {
    const media = uploadMediaRef.current;
    const dashed = uploadDashedRef.current;
    const thumb = previewThumbRef.current;
    const clear = previewClearRef.current;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !thumb || !clear) {
      setImage("");
      return;
    }
    gsap.killTweensOf([media, dashed, thumb, clear].filter(Boolean));
    gsap.set(clear, { scale: 1, transformOrigin: "50% 50%" });
    if (media) {
      gsap.set(media, { height: media.offsetHeight, overflow: "hidden" });
    }
    if (dashed) {
      gsap.set(dashed, {
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        width: "100%",
        overflow: "hidden",
        zIndex: 2,
      });
    }
    const tl = gsap.timeline({
      defaults: { overwrite: "auto" },
      onComplete: () => setImage(""),
    });
    tl.to(clear, { scale: 0.5, duration: 0.22, ease: "power2.in" });
    tl.to(
      thumb,
      { opacity: 0, scale: 0.86, y: 14, duration: 0.32, ease: "power2.in" },
      "-=0.04",
    );
    if (media) {
      tl.to(media, { height: UPLOAD_DASHED_H, duration: 0.42, ease: "power2.inOut" }, 0.08);
    }
    if (dashed) {
      tl.to(
        dashed,
        {
          height: UPLOAD_DASHED_H,
          minHeight: UPLOAD_DASHED_H,
          opacity: 1,
          borderWidth: 2,
          duration: 0.42,
          ease: "power2.inOut",
          pointerEvents: "auto",
        },
        0.08,
      );
    }
  }

  // Next label/icon crossfade when the step content swaps in.
  useGSAP(
    () => {
      const label = nextLabelRef.current;
      const icon = nextIconRef.current;
      if (!label) return;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!nextLabelReadyRef.current || reduce) {
        label.textContent = nextLabel;
        if (icon) gsap.set(icon, { width: showNextCheck ? "auto" : 0, opacity: showNextCheck ? 1 : 0 });
        nextLabelReadyRef.current = true;
        return;
      }
      const tl = gsap.timeline({ defaults: { overwrite: "auto" } });
      tl.to(label, { opacity: 0, y: -6, duration: 0.14, ease: "power2.in" }, 0);
      if (icon) {
        tl.to(
          icon,
          {
            opacity: 0,
            width: 0,
            duration: 0.14,
            ease: "power2.in",
          },
          0,
        );
      }
      tl.add(() => {
        label.textContent = nextLabel;
      });
      tl.fromTo(
        label,
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: 0.22, ease: "power2.out", clearProps: "transform" },
      );
      if (icon) {
        tl.to(
          icon,
          {
            opacity: showNextCheck ? 1 : 0,
            width: showNextCheck ? "auto" : 0,
            duration: 0.22,
            ease: "power2.out",
          },
          "<",
        );
      }
    },
    { dependencies: [nextLabel, showNextCheck], scope: rootRef },
  );

  function closeFaceCrop() {
    setFaceCrop((prev) => {
      if (prev?.src.startsWith("blob:")) URL.revokeObjectURL(prev.src);
      return null;
    });
  }

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    // Face uploads go through a square crop before hitting the API.
    if (uploadTargetRef.current === "face") {
      setError("");
      setFaceCrop((prev) => {
        if (prev?.src.startsWith("blob:")) URL.revokeObjectURL(prev.src);
        return { src: URL.createObjectURL(file), name: file.name };
      });
      return;
    }
    setUploading(true);
    setError("");
    try {
      const uploaded = await uploadFile(file);
      const target = uploadTargetRef.current;
      if (target === "photo") setImage(uploaded.path);
      if (target === "bikini") setBikini(uploaded.path);
      if (target === "confirm") {
        setConfirmUploadExitSrc("");
        setConfirmOverride(uploaded.path);
      }
      if (target === "outfit") {
        setOutfitOverride(uploaded.path);
        setOutfitPanelSrc(uploaded.path);
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setUploading(false);
    }
  }

  async function confirmFaceCrop(file: File) {
    closeFaceCrop();
    setUploading(true);
    setError("");
    try {
      const uploaded = await uploadFile(file);
      setFace(uploaded.path);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setUploading(false);
    }
  }

  function openUpload(target: "photo" | "bikini" | "face" | "confirm" | "outfit") {
    uploadTargetRef.current = target;
    const input =
      target === "bikini"
        ? bikiniRef.current
        : target === "face"
          ? faceRef.current
          : fileRef.current;
    input?.click();
  }

  async function ensureCardAndRunPicture(force: boolean) {
    const girl = modelId.trim();
    const name = cardLabel.trim();
    if (!girl) throw new Error("Choose an influencer.");
    if (!name) throw new Error("Enter a card name.");
    if (!image.trim()) throw new Error("Add a photo.");
    if (!bikini.trim()) throw new Error("Add swimwear.");
    if (!face.trim()) throw new Error("Add a face photo.");
    if (!theme.trim()) throw new Error("Choose a theme.");

    const id = slugifyProjectId(name).slice(0, 64).replace(/_+$/g, "");
    if (!PROJECT_ID_PATTERN.test(id)) throw new Error("Use a name with letters.");

    let nextId = cardId.trim();
    if (!nextId) {
      let taken = false;
      try {
        await api(`/api/video-flow/${encodeURIComponent(id)}/draft`);
        taken = true;
      } catch {
        taken = false;
      }
      if (taken) throw new Error("That name is already used.");
      await createMotionCardDraft(id, name, girl);
      nextId = id;
      setCardId(id);
      fieldsRef.current = { ...fieldsRef.current, cardId: id, cardLabel: name, modelId: girl };
      window.history.replaceState(null, "", `/leo-ui?card=${encodeURIComponent(id)}`);
    }
    leoHeld.delete(`${nextId}:picture`);
    leoHeld.delete(`${nextId}:background`);
    await enqueue("picture", force);
  }

  async function goNext() {
    if (navBusyRef.current || navBusy) return;
    setError("");
    try {
      if (screen === "influencer") {
        if (!modelId) {
          setError("Pick an influencer.");
          return;
        }
        setScreen("theme");
        return;
      }
      if (screen === "theme") {
        if (!theme.trim()) {
          setError("Choose a theme and enter a card name.");
          return;
        }
        const digits = cardNameDigits(cardLabel);
        if (!digits) {
          setError("Enter a number for the card name.");
          return;
        }
        const formatted = buildCardName(theme, digits, true);
        setCardLabel(formatted);
        if (!isCompleteCardName(formatted, theme)) {
          setError("Card name needs 3 digits, e.g. 001.");
          return;
        }
        setScreen("photo");
        return;
      }
      if (screen === "photo") {
        if (!image.trim()) {
          setError("Add a photo first.");
          return;
        }
        setScreen("swimwear");
        return;
      }
      if (screen === "swimwear") {
        setError("");
        setScreen("processing");
        try {
          await ensureCardAndRunPicture(false);
        } catch (caught) {
          // Picture already in review/approved — load artifacts and stay on processing.
          if (/already exists/i.test(errorText(caught))) {
            setPendingStep(null);
            await refresh().catch(() => undefined);
            return;
          }
          // Don't leave the user parked on Processing with a hidden error.
          setPendingStep(null);
          setScreen("swimwear");
          throw caught;
        }
        return;
      }
      if (screen === "processing") {
        const artifacts = readyPaths(flowState?.steps.picture?.artifacts).filter(
          (path) => pictureChoiceFromArtifact(path) != null,
        );
        if (!processingRevealed || artifacts.length === 0) {
          setError("Wait for the picture to finish.");
          return;
        }
        setError("");
        setPictureChoice(1);
        if (!SKIP_CONFIRM) {
          // Morph processing card → Confirm hero (approve happens on Use This Image).
          setScreen("confirm");
          return;
        }
        const id = cardId.trim();
        if (pictureStatus === "review" && id) {
          const data = await api<LiteFlowState>(
            `/api/video-flow/${encodeURIComponent(id)}/approve`,
            {
              method: "POST",
              body: JSON.stringify({ step: "picture", picture_choice: 1 }),
            },
          );
          commitState(data);
        }
        setScreen("animating");
        return;
      }
      if (screen === "confirm") {
        setError("");
        const id = cardId.trim();
        const artifacts = readyPaths(flowState?.steps.picture?.artifacts).filter(
          (path) => pictureChoiceFromArtifact(path) != null,
        );
        if (!confirmOverride.trim() && artifacts.length === 0) {
          setError("Wait for the picture to finish.");
          return;
        }
        if (pictureStatus === "review" && id) {
          const data = await api<LiteFlowState>(
            `/api/video-flow/${encodeURIComponent(id)}/approve`,
            {
              method: "POST",
              body: JSON.stringify({
                step: "picture",
                picture_choice: pictureChoice,
              }),
            },
          );
          commitState(data);
        }
        // Clip already exists (re-run / resumed card) — skip the wait screen.
        const bgStatus = flowState?.steps.background?.status;
        const bgClip = readyPaths(flowState?.steps.background?.artifacts)[0];
        if (
          bgClip &&
          (bgStatus === "review" || bgStatus === "approved")
        ) {
          setScreen("animated");
        } else {
          setScreen("animating");
        }
        return;
      }
      if (screen === "animating") {
        const busy =
          pendingStep === "background" ||
          runningJob?.command[1] === "background";
        const status = flowState?.steps.background?.status;
        if (
          busy ||
          (status !== "review" && status !== "approved")
        ) {
          setError("Wait for the clip to finish.");
          return;
        }
        setError("");
        setScreen("animated");
        return;
      }
      if (screen === "animated") {
        setError("");
        const id = cardId.trim();
        if (id && flowState?.steps.background?.status === "review") {
          const data = await api<LiteFlowState>(
            `/api/video-flow/${encodeURIComponent(id)}/approve`,
            { method: "POST", body: JSON.stringify({ step: "background" }) },
          );
          commitState(data);
        }
        setScreen("outfit");
        return;
      }
      if (screen === "outfit") {
        const id = cardId.trim();
        if (!outfitOverride.trim()) {
          setError("Add an outfit reference.");
          return;
        }
        if (!id) {
          setError("Missing card.");
          return;
        }
        setError("");
        setScreen("dressing");
        leoHeld.delete(`${id}:dress`);
        await enqueue("dress", false);
        return;
      }
      if (screen === "dressing") {
        const busy =
          pendingStep === "dress" || runningJob?.command[1] === "dress";
        const status = flowState?.steps.dress?.status;
        if (busy || (status !== "review" && status !== "approved")) {
          setError("Wait for the outfit clip to finish.");
          return;
        }
        setError("");
        setScreen("dressed");
        return;
      }
      if (screen === "dressed") {
        setError("");
        const id = cardId.trim();
        if (id && flowState?.steps.dress?.status === "review") {
          const data = await api<LiteFlowState>(
            `/api/video-flow/${encodeURIComponent(id)}/approve`,
            { method: "POST", body: JSON.stringify({ step: "dress" }) },
          );
          commitState(data);
        }
        setScreen("meshing");
        if (id) {
          const token = `${id}:mesh-prefix`;
          leoHeld.delete(token);
          leoHeld.add(token);
          try {
            const state = await runThroughMesh(id, fieldsRef.current, {
              onState: commitState,
              onStep: (step) => setPendingStep(step),
            });
            commitState(state);
            setPendingStep(null);
          } catch (caught) {
            leoHeld.delete(token);
            setPendingStep(null);
            throw caught;
          }
        }
        return;
      }
      if (screen === "meshing") {
        if (flowState?.steps.mesh?.status !== "approved") {
          setError("Wait for the mesh to finish.");
          return;
        }
        setError("");
        setScreen("mask");
        return;
      }
      if (screen === "mask") {
        setError("");
        setScreen("symbols");
        return;
      }
      if (screen === "symbols") {
        if (flowState?.steps.symbols?.status !== "approved") {
          setError("Save symbol points first.");
          return;
        }
        setError("");
        setScreen("created");
        return;
      }
      if (screen === "created") {
        openTryMotion();
      }
    } catch (caught) {
      setPendingStep(null);
      setError(errorText(caught));
    }
  }

  function goBack() {
    if (navBusyRef.current || navBusy) return;
    setError("");
    if (screen === "theme") setScreen("influencer");
    else if (screen === "photo") setScreen("theme");
    else if (screen === "swimwear") setScreen("photo");
    else if (screen === "processing") setScreen("swimwear");
    else if (screen === "confirm") setScreen(SKIP_CONFIRM ? "processing" : "swimwear");
    else if (screen === "animating") setScreen(SKIP_CONFIRM ? "processing" : "confirm");
    else if (screen === "animated") setScreen("animating");
    else if (screen === "outfit") setScreen("animated");
    else if (screen === "dressing") setScreen("outfit");
    else if (screen === "dressed") setScreen("dressing");
    else if (screen === "meshing") setScreen("dressed");
    else if (screen === "mask") setScreen("meshing");
    else if (screen === "symbols") setScreen("mask");
    else if (screen === "created") setScreen("symbols");
  }

  /** Jump to an unlocked main section via the progress dots. */
  function goToPhase(target: number) {
    if (navBusyRef.current || navBusy) return;
    if (target < 0 || target >= PHASE_COUNT) return;
    if (target > maxPhaseReached || target === phase) return;
    const next = PHASE_SCREENS[target];
    if (!next || next === screen) return;
    setError("");
    setScreen(next);
  }

  function preferReducedMotion() {
    return (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function createdPreviewMedia(): HTMLElement | null {
    return (
      createdPreviewRef.current?.querySelector<HTMLElement>("video, img") ?? null
    );
  }

  function resetCreatedPreview() {
    const preview = createdPreviewRef.current;
    if (preview) {
      gsap.killTweensOf(preview);
      gsap.set(preview, { clearProps: "transform,opacity,filter" });
    }
    const media = createdPreviewMedia();
    if (media) {
      gsap.killTweensOf(media);
      gsap.set(media, { clearProps: "filter,opacity,transform" });
    }
  }

  function finishTryMotionOpen() {
    tryMotionAwaitingReadyRef.current = false;
    if (tryMotionReadyFallbackRef.current) {
      window.clearTimeout(tryMotionReadyFallbackRef.current);
      tryMotionReadyFallbackRef.current = 0;
    }
    const stage = tryMotionStageRef.current;
    const cover = tryMotionCoverRef.current;
    if (stage) {
      gsap.set(stage, {
        clearProps: "transform,transformOrigin,borderRadius,filter",
        opacity: 1,
      });
    }
    if (cover) {
      gsap.set(cover, {
        opacity: 0,
        pointerEvents: "none",
        visibility: "hidden",
      });
      cover.setAttribute("aria-hidden", "true");
    }
    tryMotionBusyRef.current = false;
    stage
      ?.querySelector<HTMLButtonElement>(".stage-game__pause")
      ?.focus();
  }

  /** After Game Created preview is gone — fade/scale the scratch stage in. */
  function revealTryMotion() {
    if (!tryMotionAwaitingReadyRef.current) return;
    tryMotionAwaitingReadyRef.current = false;
    if (tryMotionReadyFallbackRef.current) {
      window.clearTimeout(tryMotionReadyFallbackRef.current);
      tryMotionReadyFallbackRef.current = 0;
    }

    const stage = tryMotionStageRef.current;
    const cover = tryMotionCoverRef.current;
    if (!stage) {
      finishTryMotionOpen();
      return;
    }

    tryMotionBusyRef.current = true;
    const reduce = preferReducedMotion();
    const targets = [stage, cover].filter(Boolean) as HTMLElement[];
    gsap.killTweensOf(targets);

    if (reduce) {
      finishTryMotionOpen();
      return;
    }

    gsap.set(stage, {
      opacity: 0,
      scale: 0.92,
      transformOrigin: "50% 50%",
      borderRadius: 0,
      filter: "none",
    });
    if (cover) {
      gsap.set(cover, {
        opacity: 1,
        visibility: "visible",
        pointerEvents: "auto",
      });
    }

    const tl = gsap.timeline({
      defaults: { ease: "power2.out" },
      onComplete: finishTryMotionOpen,
    });
    tl.to(
      stage,
      {
        opacity: 1,
        scale: 1,
        duration: TRY_MOTION_STAGE_IN,
      },
      0,
    );
    if (cover) {
      tl.to(
        cover,
        {
          opacity: 0,
          duration: 0.32,
          onComplete: () => {
            gsap.set(cover, { pointerEvents: "none", visibility: "hidden" });
          },
        },
        0.08,
      );
    }
  }

  function openTryMotion() {
    const dialog = tryMotionRef.current;
    const stage = tryMotionStageRef.current;
    const cover = tryMotionCoverRef.current;
    const preview = createdPreviewRef.current;
    if (!dialog || !stage || tryMotionBusyRef.current) return;
    if (dialog.open) return;
    setError("");

    const from = preview?.getBoundingClientRect() ?? null;
    const reduce = preferReducedMotion();
    tryMotionFromRectRef.current = from;
    tryMotionBusyRef.current = true;

    const startDialog = () => {
      tryMotionUrlRef.current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      setTryMotionOpen(true);
      dialog.showModal();
      dialog.classList.add("is-open");
      // Allow X while videos load.
      tryMotionBusyRef.current = false;
      tryMotionAwaitingReadyRef.current = true;

      gsap.killTweensOf([stage, cover].filter(Boolean));
      // Park invisible — revealTryMotion fades the game in once ready.
      gsap.set(stage, {
        opacity: 0,
        scale: 0.92,
        transformOrigin: "50% 50%",
        borderRadius: 0,
        filter: "none",
      });
      if (cover) {
        gsap.set(cover, {
          opacity: 1,
          visibility: "visible",
          pointerEvents: "auto",
        });
        cover.removeAttribute("aria-hidden");
      }

      if (tryMotionReadyFallbackRef.current) {
        window.clearTimeout(tryMotionReadyFallbackRef.current);
      }
      tryMotionReadyFallbackRef.current = window.setTimeout(() => {
        revealTryMotion();
      }, TRY_MOTION_READY_FALLBACK_MS);
    };

    // 1) Game Created clip scales down + fades out, then 2) dialog opens.
    if (!preview || reduce) {
      if (preview) gsap.set(preview, { opacity: 0, scale: 0.86 });
      startDialog();
      return;
    }

    gsap.killTweensOf(preview);
    gsap.set(preview, { transformOrigin: "50% 50%" });
    gsap.to(preview, {
      opacity: 0,
      scale: 0.86,
      duration: TRY_MOTION_PREVIEW_OUT,
      ease: "power2.in",
      onComplete: startDialog,
    });
  }

  function closeTryMotion(options?: {
    restoreUrl?: boolean;
    onClosed?: () => void;
  }) {
    const dialog = tryMotionRef.current;
    const stage = tryMotionStageRef.current;
    const cover = tryMotionCoverRef.current;
    const preview = createdPreviewRef.current;
    if (!dialog?.open) {
      options?.onClosed?.();
      return;
    }
    // Block only mid-tween; allow dismiss while the card is still loading.
    if (tryMotionBusyRef.current && !tryMotionAwaitingReadyRef.current) return;

    const reduce = preferReducedMotion();
    const restoreUrl = options?.restoreUrl !== false;
    tryMotionBusyRef.current = true;
    tryMotionAwaitingReadyRef.current = false;
    if (tryMotionReadyFallbackRef.current) {
      window.clearTimeout(tryMotionReadyFallbackRef.current);
      tryMotionReadyFallbackRef.current = 0;
    }

    const restorePreview = () => {
      if (!preview || reduce) {
        resetCreatedPreview();
        tryMotionBusyRef.current = false;
        if (!options?.onClosed) nextBtnRef.current?.focus();
        options?.onClosed?.();
        return;
      }
      gsap.killTweensOf(preview);
      gsap.set(preview, {
        opacity: 0,
        scale: 0.86,
        transformOrigin: "50% 50%",
      });
      gsap.to(preview, {
        opacity: 1,
        scale: 1,
        duration: TRY_MOTION_PREVIEW_IN,
        ease: "power2.out",
        onComplete: () => {
          gsap.set(preview, { clearProps: "transform,opacity" });
          tryMotionBusyRef.current = false;
          if (!options?.onClosed) nextBtnRef.current?.focus();
          options?.onClosed?.();
        },
      });
    };

    const finishClose = () => {
      dialog.classList.remove("is-open");
      dialog.close();
      setTryMotionOpen(false);
      if (restoreUrl) {
        const restore = tryMotionUrlRef.current;
        if (
          restore &&
          `${window.location.pathname}${window.location.search}${window.location.hash}` !==
            restore
        ) {
          window.history.replaceState(null, "", restore);
        }
      }
      tryMotionUrlRef.current = "";
      tryMotionFromRectRef.current = null;
      if (stage) {
        gsap.set(stage, {
          clearProps: "transform,transformOrigin,borderRadius,filter,opacity",
        });
      }
      if (cover) {
        gsap.set(cover, {
          clearProps: "opacity,pointerEvents,visibility",
        });
        cover.removeAttribute("aria-hidden");
      }
      // 2) After the game is gone, scale the Game Created clip back in.
      restorePreview();
    };

    if (!stage || reduce) {
      finishClose();
      return;
    }

    // 1) Scratch game scales down + fades out first.
    const targets = [stage, cover].filter(Boolean) as HTMLElement[];
    gsap.killTweensOf(targets);
    if (cover) {
      gsap.set(cover, {
        opacity: 0,
        pointerEvents: "none",
        visibility: "hidden",
      });
    }
    gsap.to(stage, {
      opacity: 0,
      scale: 0.88,
      transformOrigin: "50% 50%",
      duration: TRY_MOTION_STAGE_OUT,
      ease: "power2.in",
      onComplete: finishClose,
    });
  }

  /** Check: accept card, kick publish pipeline, go to that model's Models page. */
  function acceptTryMotionCard() {
    const id = cardId.trim() || fieldsRef.current.cardId.trim();
    const girl = modelId.trim() || fieldsRef.current.modelId.trim();
    if (id) {
      void finishAndPublishCard(id, {
        ...fieldsRef.current,
        cardId: id,
        modelId: girl || fieldsRef.current.modelId,
      }).catch((caught) => {
        console.error(errorText(caught));
      });
    }

    const next = girl
      ? `/dashboard/models?model=${encodeURIComponent(girl)}`
      : "/dashboard/models";
    // Hard navigate so we leave /leo-ui cleanly and Models reads ?model=.
    window.location.assign(next);
  }

  function openPromptDialog() {
    const dialog = promptDialogRef.current;
    if (!dialog || promptDialogBusyRef.current) return;
    setPromptDraft(picturePromptExtra);
    setError("");
    dialog.showModal();
    const panel = dialog.querySelector<HTMLElement>(".leo-ui__prompt-dialog-panel");
    const reduce = preferReducedMotion();
    requestAnimationFrame(() => dialog.classList.add("is-open"));
    if (!panel || reduce) return;
    gsap.killTweensOf(panel);
    gsap.fromTo(
      panel,
      { y: 56, opacity: 0, filter: "blur(14px)" },
      {
        y: 0,
        opacity: 1,
        filter: "blur(0px)",
        duration: 0.42,
        ease: "power3.out",
        overwrite: true,
      },
    );
  }

  function closePromptDialog(after?: () => void) {
    const dialog = promptDialogRef.current;
    if (!dialog?.open || promptDialogBusyRef.current) {
      after?.();
      return;
    }
    const panel = dialog.querySelector<HTMLElement>(".leo-ui__prompt-dialog-panel");
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finish = () => {
      promptDialogBusyRef.current = false;
      dialog.classList.remove("is-open");
      gsap.set(panel, { clearProps: "transform,opacity,filter" });
      dialog.close();
      after?.();
    };
    dialog.classList.remove("is-open");
    if (!panel || reduce) {
      finish();
      return;
    }
    promptDialogBusyRef.current = true;
    gsap.killTweensOf(panel);
    gsap.to(panel, {
      y: 56,
      opacity: 0,
      filter: "blur(14px)",
      duration: 0.32,
      ease: "power2.in",
      overwrite: true,
      onComplete: finish,
    });
  }

  function savePromptDialog() {
    closePromptDialog(() => setPicturePromptExtra(promptDraft.trim()));
  }

  function openRetryModelDialog(role: GenerationModelRole) {
    const dialog = bgModelDialogRef.current;
    if (!dialog || bgModelDialogBusyRef.current) return;
    const options =
      role === "dress_video" ? dressAiModels : backgroundAiModels;
    const current =
      role === "dress_video"
        ? resolvedDressVideoModel
        : resolvedBackgroundVideoModel;
    const first = options[0]?.id ?? current;
    const known = options.some((entry) => entry.id === current);
    setRetryModelRole(role);
    setBgModelDraft(known ? current : first);
    setError("");
    dialog.showModal();
    const panel = dialog.querySelector<HTMLElement>(".leo-ui__prompt-dialog-panel");
    const reduce = preferReducedMotion();
    requestAnimationFrame(() => {
      dialog.classList.add("is-open");
      syncModelListScrollFade();
    });
    if (!panel || reduce) return;
    gsap.killTweensOf(panel);
    gsap.fromTo(
      panel,
      { y: 56, opacity: 0, filter: "blur(14px)" },
      {
        y: 0,
        opacity: 1,
        filter: "blur(0px)",
        duration: 0.42,
        ease: "power3.out",
        overwrite: true,
      },
    );
  }

  function closeBgModelDialog(after?: () => void) {
    const dialog = bgModelDialogRef.current;
    if (!dialog?.open || bgModelDialogBusyRef.current) {
      after?.();
      return;
    }
    const panel = dialog.querySelector<HTMLElement>(".leo-ui__prompt-dialog-panel");
    const reduce = preferReducedMotion();
    const finish = () => {
      bgModelDialogBusyRef.current = false;
      dialog.classList.remove("is-open");
      gsap.set(panel, { clearProps: "transform,opacity,filter" });
      dialog.close();
      after?.();
    };
    dialog.classList.remove("is-open");
    if (!panel || reduce) {
      finish();
      return;
    }
    bgModelDialogBusyRef.current = true;
    gsap.killTweensOf(panel);
    gsap.to(panel, {
      y: 56,
      opacity: 0,
      filter: "blur(14px)",
      duration: 0.32,
      ease: "power2.in",
      overwrite: true,
      onComplete: finish,
    });
  }

  function confirmBgModelDialog() {
    const next = bgModelDraft.trim();
    if (!next) {
      setError("Pick an AI model first.");
      return;
    }
    const role = retryModelRole;
    closeBgModelDialog(() => {
      if (role === "dress_video") {
        setDressVideoModel(next);
        void retryDressing(next);
        return;
      }
      setBackgroundVideoModel(next);
      void retryBackground(next);
    });
  }
  function openBikiniGallery() {
    const dialog = bikiniGalleryRef.current;
    if (!dialog || dialog.open || bikiniGalleryBusyRef.current) return;
    setError("");
    dialog.showModal();
    const panel = dialog.querySelector<HTMLElement>(".leo-ui__gallery-dialog-panel");
    const reduce = preferReducedMotion();
    requestAnimationFrame(() => dialog.classList.add("is-open"));
    if (!panel || reduce) return;
    gsap.killTweensOf(panel);
    gsap.fromTo(
      panel,
      { y: 56, opacity: 0, filter: "blur(14px)" },
      {
        y: 0,
        opacity: 1,
        filter: "blur(0px)",
        duration: 0.42,
        ease: "power3.out",
        overwrite: true,
      },
    );
  }

  function closeBikiniGallery(after?: () => void) {
    const dialog = bikiniGalleryRef.current;
    if (!dialog?.open || bikiniGalleryBusyRef.current) {
      after?.();
      return;
    }
    const panel = dialog.querySelector<HTMLElement>(".leo-ui__gallery-dialog-panel");
    const reduce = preferReducedMotion();
    const finish = () => {
      bikiniGalleryBusyRef.current = false;
      dialog.classList.remove("is-open");
      gsap.set(panel, { clearProps: "transform,opacity,filter" });
      dialog.close();
      after?.();
    };
    dialog.classList.remove("is-open");
    if (!panel || reduce) {
      finish();
      return;
    }
    bikiniGalleryBusyRef.current = true;
    gsap.killTweensOf(panel);
    gsap.to(panel, {
      y: 56,
      opacity: 0,
      filter: "blur(14px)",
      duration: 0.32,
      ease: "power2.in",
      overwrite: true,
      onComplete: finish,
    });
  }

  function pickBikiniFromGallery(src: string) {
    closeBikiniGallery(() => setBikini(src));
  }

  async function retryPicture() {
    setError("");
    setConfirmOverride("");
    setConfirmUploadExitSrc("");
    processingRevealStartedRef.current = false;
    setProcessingRevealed(false);
    // Hero flies back into processing; job runs there.
    setScreen("processing");
    try {
      await ensureCardAndRunPicture(true);
    } catch (caught) {
      setPendingStep(null);
      setError(errorText(caught));
    }
  }

  async function retryBackground(modelOverride?: string) {
    const id = cardId.trim();
    if (!id) return;
    const picked = modelOverride?.trim();
    if (picked) {
      setBackgroundVideoModel(picked);
      fieldsRef.current = {
        ...fieldsRef.current,
        backgroundVideoModel: picked,
      };
    }
    setError("");
    leoHeld.delete(`${id}:background`);
    setScreen("animating");
    try {
      await enqueue("background", true);
    } catch (caught) {
      setPendingStep(null);
      setError(errorText(caught));
    }
  }

  async function retryDressing(modelOverride?: string) {
    const id = cardId.trim();
    const picked = modelOverride?.trim();
    if (picked) {
      setDressVideoModel(picked);
      fieldsRef.current = {
        ...fieldsRef.current,
        dressVideoModel: picked,
      };
    }
    setError("");
    setScreen("dressing");
    if (!id) return;
    leoHeld.delete(`${id}:dress`);
    try {
      await enqueue("dress", true);
    } catch (caught) {
      setPendingStep(null);
      setError(errorText(caught));
    }
  }

  async function retryMeshing() {
    const id = cardId.trim();
    setError("");
    setScreen("meshing");
    if (!id) return;
    const token = `${id}:mesh-prefix`;
    leoHeld.delete(token);
    leoHeld.add(token);
    try {
      const state = await runThroughMesh(id, fieldsRef.current, {
        force: true,
        onState: commitState,
        onStep: (step) => setPendingStep(step),
      });
      commitState(state);
      setPendingStep(null);
    } catch (caught) {
      leoHeld.delete(token);
      setPendingStep(null);
      setError(errorText(caught));
    }
  }

  function openMaskEdit() {
    const hero = maskHeroRef.current;
    const box = hero?.getBoundingClientRect();
    setMaskEditFrom(
      box
        ? { left: box.left, top: box.top, width: box.width, height: box.height }
        : null,
    );
    setMaskEditOpen(true);
  }

  function closeMaskEdit() {
    setMaskEditOpen(false);
    setMaskEditFrom(null);
  }

  const photoGallery = gallery;
  const isGalleryImage = (value: string, item: GalleryImage) =>
    Boolean(value) && (value === item.path || value === item.url);
  const hasGallerySelection = photoGallery.some((item) => isGalleryImage(image, item));
  const hasBikiniGallerySelection = photoGallery.some((item) =>
    isGalleryImage(bikini, item),
  );

  // Processing cold-enter: blur host when no fly handoff is in progress.
  useGSAP(
    () => {
      if (viewScreen !== "processing" || processingRevealed) return;
      const fly = photoFlyRef.current;
      if (fly && getComputedStyle(fly).display !== "none") return;
      if (photoShellGrowingRef.current) return;
      const img = screenRef.current?.querySelector<HTMLElement>(
        ".leo-ui__host-photo.is-processing img",
      );
      if (!img) return;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      gsap.killTweensOf(img);
      if (reduce) {
        gsap.set(img, { filter: PROCESSING_PHOTO_FILTER });
        return;
      }
      gsap.fromTo(
        img,
        { filter: PROCESSING_PHOTO_FILTER_CLEAR },
        {
          filter: PROCESSING_PHOTO_FILTER,
          duration: PROCESSING_BLUR_DURATION,
          ease: "power2.out",
          delay: 0.04,
          overwrite: true,
        },
      );
    },
    { dependencies: [viewScreen, photoFillReady, image, processingRevealed], scope: rootRef },
  );

  // Animating / Dressing cold-enter: blur/desaturate when no fly handoff is in progress.
  useGSAP(
    () => {
      if (viewScreen !== "animating" && viewScreen !== "dressing") return;
      const fly = photoFlyRef.current;
      if (fly && getComputedStyle(fly).display !== "none") return;
      const media = (
        viewScreen === "dressing" ? dressingPreviewRef : animatingPreviewRef
      ).current?.querySelector<HTMLElement>("video, img");
      if (!media) return;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      gsap.killTweensOf(media);
      if (reduce) {
        gsap.set(media, { filter: PROCESSING_PHOTO_FILTER });
        return;
      }
      gsap.fromTo(
        media,
        { filter: PROCESSING_PHOTO_FILTER_CLEAR },
        {
          filter: PROCESSING_PHOTO_FILTER,
          duration: PROCESSING_BLUR_DURATION,
          ease: "power2.out",
          delay: 0.04,
          overwrite: true,
        },
      );
    },
    { dependencies: [viewScreen], scope: rootRef },
  );

  // Animating / Dressing / Meshing subtitle: slot-machine reel through status lines.
  useGSAP(
    () => {
      if (
        viewScreen !== "animating" &&
        viewScreen !== "dressing" &&
        viewScreen !== "meshing"
      ) {
        return;
      }
      const reel = (
        viewScreen === "meshing"
          ? meshingSlotsRef
          : viewScreen === "dressing"
            ? dressingSlotsRef
            : animatingSlotsRef
      ).current;
      if (!reel) return;
      const lines = reel.querySelectorAll<HTMLElement>(".leo-ui__sub-slots-line");
      if (lines.length < 2) return;
      const lineH = lines[0].offsetHeight || 20;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      gsap.killTweensOf(reel);
      gsap.set(reel, { y: 0 });
      if (reduce) return;

      // Last line duplicates the first so the loop can snap without a jump.
      const steps = lines.length - 1;
      const tl = gsap.timeline({ repeat: -1, defaults: { overwrite: "auto" } });
      for (let i = 1; i <= steps; i++) {
        tl.to(reel, {
          y: -i * lineH,
          duration: ANIMATING_SLOT_SPIN,
          ease: "power4.inOut",
        });
        if (i < steps) {
          tl.to({}, { duration: ANIMATING_SLOT_HOLD });
        } else {
          tl.to({}, { duration: ANIMATING_SLOT_HOLD * 0.6 });
          tl.set(reel, { y: 0 });
        }
      }
      return () => {
        tl.kill();
        gsap.set(reel, { clearProps: "transform" });
      };
    },
    { dependencies: [viewScreen], scope: rootRef },
  );

  // Processing finished: re-saturate the swapped processed photo + fade the hanger.
  useGSAP(
    () => {
      if (viewScreen !== "processing" || !processingRevealed) return;
      const img = screenRef.current?.querySelector<HTMLElement>(
        ".leo-ui__host-photo.is-processing img",
      );
      const lottie = screenRef.current?.querySelector<HTMLElement>(
        ".leo-ui__processing-lottie",
      );
      if (!img) return;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      gsap.killTweensOf([img, lottie].filter(Boolean));
      if (reduce) {
        gsap.set(img, { filter: PROCESSING_PHOTO_FILTER_CLEAR });
        if (lottie) gsap.set(lottie, { opacity: 0 });
        if (PROCESSING_AUTO_ADVANCE) setScreen(SKIP_CONFIRM ? "animating" : "confirm");
        return;
      }
      gsap.set(img, { filter: PROCESSING_PHOTO_FILTER });
      if (lottie) {
        gsap.to(lottie, { opacity: 0, duration: 0.35, ease: "power2.out", overwrite: true });
      }
      gsap.to(img, {
        filter: PROCESSING_PHOTO_FILTER_CLEAR,
        duration: 0.85,
        ease: "power2.out",
        overwrite: true,
        onComplete: () => {
          if (PROCESSING_AUTO_ADVANCE) setScreen(SKIP_CONFIRM ? "animating" : "confirm");
        },
      });
    },
    { dependencies: [viewScreen, processingRevealed], scope: rootRef },
  );

  // Confirm hero: scale/fade processed ↔ uploaded (and reverse on remove).
  useGSAP(
    () => {
      if (viewScreen !== "confirm") return;
      const hero = confirmHeroRef.current;
      if (!hero) return;
      const gen = hero.querySelector<HTMLElement>(".leo-ui__confirm-hero-layer--gen");
      const up = hero.querySelector<HTMLElement>(".leo-ui__confirm-hero-layer--up");
      if (!gen) return;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      gsap.killTweensOf([gen, up].filter(Boolean));

      if (confirmOverride && up) {
        if (reduce) {
          gsap.set(gen, { opacity: 0, scale: 0.9 });
          gsap.set(up, { opacity: 1, scale: 1 });
          return;
        }
        gsap.set(gen, { transformOrigin: "50% 50%", opacity: 1, scale: 1 });
        gsap.set(up, { transformOrigin: "50% 50%", opacity: 0, scale: 1.08 });
        gsap
          .timeline({ defaults: { overwrite: "auto" } })
          .to(gen, { opacity: 0, scale: 0.9, duration: 0.28, ease: "power2.in" })
          .to(up, { opacity: 1, scale: 1, duration: 0.36, ease: "power2.out" }, 0.1);
        return;
      }

      if (confirmUploadExitSrc && up) {
        if (reduce) {
          gsap.set(up, { opacity: 0, scale: 0.9 });
          gsap.set(gen, { opacity: 1, scale: 1 });
          setConfirmUploadExitSrc("");
          return;
        }
        gsap.set(up, { transformOrigin: "50% 50%", opacity: 1, scale: 1 });
        gsap.set(gen, { transformOrigin: "50% 50%", opacity: 0, scale: 1.08 });
        gsap
          .timeline({
            defaults: { overwrite: "auto" },
            onComplete: () => setConfirmUploadExitSrc(""),
          })
          .to(up, { opacity: 0, scale: 0.9, duration: 0.28, ease: "power2.in" })
          .to(gen, { opacity: 1, scale: 1, duration: 0.36, ease: "power2.out" }, 0.1);
        return;
      }

      gsap.set(gen, { opacity: 1, scale: 1, clearProps: "transform" });
    },
    { dependencies: [viewScreen, confirmOverride, confirmUploadExitSrc], scope: rootRef },
  );

  // Outfit upload thumb: scale in on add, scale out on × (same beat as Add Face).
  // Slot height square ↔ 9∶16 is GSAP-tweened so remove doesn't snap.
  useGSAP(
    () => {
      if (viewScreen !== "outfit") {
        outfitOnScreenRef.current = "";
        outfitReadyRef.current = false;
        return;
      }
      const btn = outfitUploadBtnRef.current;
      const thumb = outfitThumbRef.current;
      const clear = outfitClearRef.current;
      const slot = outfitSlotRef.current;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const open = Boolean(outfitOverride.trim());
      const slotSquare = "5.8125rem";
      const slotPortrait = `${(5.8125 * 16) / 9}rem`;

      if (open) setOutfitPanelSrc(outfitOverride);

      if (!outfitReadyRef.current) {
        outfitReadyRef.current = true;
        if (open) {
          outfitOnScreenRef.current = outfitOverride;
          if (slot) gsap.set(slot, { height: slotPortrait });
          if (btn) {
            gsap.set(btn, {
              opacity: 0,
              scale: 0,
              visibility: "hidden",
              pointerEvents: "none",
            });
          }
          if (thumb) gsap.set(thumb, { opacity: 1, scale: 1, y: 0, clearProps: "transform" });
          if (clear) gsap.set(clear, { scale: 1, clearProps: "transform" });
        } else {
          if (slot) gsap.set(slot, { height: slotSquare });
          if (btn) {
            gsap.set(btn, {
              opacity: 1,
              scale: 1,
              visibility: "visible",
              pointerEvents: "auto",
              clearProps: "transform",
            });
          }
        }
        return;
      }

      gsap.killTweensOf([btn, thumb, clear, slot].filter(Boolean));

      if (reduce) {
        if (open) {
          outfitOnScreenRef.current = outfitOverride;
          if (slot) gsap.set(slot, { height: slotPortrait });
          if (btn) {
            gsap.set(btn, {
              opacity: 0,
              scale: 0,
              visibility: "hidden",
              pointerEvents: "none",
            });
          }
          if (thumb) gsap.set(thumb, { opacity: 1, scale: 1, y: 0, clearProps: "transform" });
          if (clear) gsap.set(clear, { scale: 1, clearProps: "transform" });
        } else {
          outfitOnScreenRef.current = "";
          if (slot) gsap.set(slot, { height: slotSquare });
          if (btn) {
            gsap.set(btn, {
              opacity: 1,
              scale: 1,
              visibility: "visible",
              pointerEvents: "auto",
              clearProps: "transform",
            });
          }
          setOutfitPanelSrc("");
        }
        return;
      }

      if (open) {
        if (!btn || !thumb || !clear) return;
        const returning = Boolean(outfitOnScreenRef.current);
        outfitOnScreenRef.current = outfitOverride;
        if (returning) {
          if (slot) gsap.set(slot, { height: slotPortrait });
          gsap.set(btn, {
            opacity: 0,
            scale: 0,
            visibility: "hidden",
            pointerEvents: "none",
          });
          gsap.set(thumb, { opacity: 1, scale: 1, y: 0, clearProps: "transform" });
          gsap.set(clear, { scale: 1, clearProps: "transform" });
          return;
        }
        gsap.set(btn, {
          opacity: 1,
          scale: 1,
          visibility: "visible",
          pointerEvents: "none",
          transformOrigin: "50% 50%",
        });
        gsap.set(thumb, { opacity: 0, scale: 0.86, y: 14, transformOrigin: "50% 50%" });
        gsap.set(clear, { scale: 0.5, transformOrigin: "50% 50%" });
        if (slot) gsap.set(slot, { height: slotSquare });
        const tl = gsap.timeline({ defaults: { overwrite: "auto" } });
        tl.to(btn, { scale: 1.08, duration: 0.12, ease: "power2.out" });
        tl.to(btn, {
          scale: 0,
          opacity: 0,
          duration: 0.22,
          ease: "power2.in",
          onComplete: () => {
            gsap.set(btn, { visibility: "hidden" });
          },
        });
        if (slot) {
          tl.to(
            slot,
            { height: slotPortrait, duration: 0.4, ease: "power2.inOut" },
            "-=0.12",
          );
        }
        tl.to(
          thumb,
          {
            opacity: 1,
            scale: 1,
            y: 0,
            duration: 0.4,
            ease: "power2.out",
            clearProps: "transform",
          },
          "-=0.36",
        );
        tl.to(
          clear,
          { scale: 1, duration: 0.3, ease: "back.out(1.7)", clearProps: "transform" },
          "-=0.28",
        );
      } else {
        outfitOnScreenRef.current = "";
        if (!btn) {
          setOutfitPanelSrc("");
          return;
        }
        if (!thumb || !clear) {
          if (slot) gsap.set(slot, { height: slotSquare });
          gsap.set(btn, {
            opacity: 1,
            scale: 1,
            visibility: "visible",
            pointerEvents: "auto",
            clearProps: "transform",
          });
          setOutfitPanelSrc("");
          return;
        }
        gsap.set(btn, {
          opacity: 0,
          scale: 0,
          visibility: "visible",
          pointerEvents: "none",
          transformOrigin: "50% 50%",
        });
        gsap.set(thumb, { opacity: 1, scale: 1, y: 0, transformOrigin: "50% 50%" });
        gsap.set(clear, { scale: 1, transformOrigin: "50% 50%" });
        if (slot) gsap.set(slot, { height: slotPortrait });
        const tl = gsap.timeline({
          defaults: { overwrite: "auto" },
          onComplete: () => setOutfitPanelSrc(""),
        });
        tl.to(clear, { scale: 0.5, duration: 0.18, ease: "power2.in" });
        tl.to(
          thumb,
          { opacity: 0, scale: 0.86, y: 14, duration: 0.28, ease: "power2.in" },
          0,
        );
        if (slot) {
          tl.to(
            slot,
            { height: slotSquare, duration: 0.36, ease: "power2.inOut" },
            0.06,
          );
        }
        tl.to(btn, { scale: 1.08, opacity: 1, duration: 0.2, ease: "power2.out" }, "-=0.12");
        tl.to(btn, {
          scale: 1,
          duration: 0.16,
          ease: "power2.inOut",
          clearProps: "transform",
          onComplete: () => {
            gsap.set(btn, { pointerEvents: "auto", visibility: "visible" });
          },
        });
      }
    },
    { dependencies: [outfitOverride, viewScreen], scope: rootRef },
  );

  // Gallery select/deselect: ease opacity + scale (not an instant class toggle).
  useGSAP(
    () => {
      const root = galleryRef.current;
      if (!root || viewScreen !== "photo") return;
      const buttons = root.querySelectorAll<HTMLElement>(":scope > button");
      if (!buttons.length) return;
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      buttons.forEach((btn) => {
        const selected = btn.classList.contains("is-selected");
        const pose =
          !hasGallerySelection
            ? { opacity: 1, scale: 1 }
            : selected
              ? { opacity: 1, scale: 1 }
              : { opacity: 0.2, scale: 0.98 };
        gsap.killTweensOf(btn);
        if (reduce) {
          gsap.set(btn, { ...pose, transformOrigin: "50% 50%" });
          return;
        }
        gsap.to(btn, {
          ...pose,
          transformOrigin: "50% 50%",
          duration: 0.3,
          ease: "power2.out",
          overwrite: true,
        });
      });
    },
    { dependencies: [image, hasGallerySelection, photoGallery, viewScreen], scope: rootRef },
  );

  const pictureArtifacts = readyPaths(flowState?.steps.picture?.artifacts).filter(
    (path) => pictureChoiceFromArtifact(path) != null,
  );
  const displayPictures = pictureArtifacts;
  const processedSrc =
    displayPictures[pictureChoice - 1] || displayPictures[0] || image;
  const movingClip =
    readyPaths(flowState?.steps.background?.artifacts)[0] || "";
  const dressClip =
    readyPaths(flowState?.steps.dress?.artifacts)[0] || "";
  const playClip = dressClip || movingClip;
  const pictureStatus = flowState?.steps.picture?.status;
  const backgroundStatus = flowState?.steps.background?.status;
  const dressStatus = flowState?.steps.dress?.status;
  const meshStatus = flowState?.steps.mesh?.status;
  const symbolsStatus = flowState?.steps.symbols?.status;
  const pictureBusy =
    pendingStep === "picture" || runningJob?.command[1] === "picture";
  const backgroundBusy =
    pendingStep === "background" || runningJob?.command[1] === "background";
  const dressBusy =
    pendingStep === "dress" || runningJob?.command[1] === "dress";
  const meshBusy =
    pendingStep === "boomerang" ||
    pendingStep === "card" ||
    pendingStep === "mesh" ||
    runningJob?.command[1] === "boomerang" ||
    runningJob?.command[1] === "card" ||
    runningJob?.command[1] === "mesh";
  const canNextInfluencer = Boolean(modelId);
  const canNextTheme = Boolean(
    theme.trim() && themePrefix(theme) && cardNameDigits(cardLabel).length > 0,
  );
  const canNextPhoto = Boolean(image.trim());
  const canNextSwimwear = Boolean(bikini.trim() && face.trim());
  const canLeaveProcessing =
    !pictureBusy && processingRevealed && pictureArtifacts.length > 0;
  const canLeaveAnimating =
    !backgroundBusy &&
    (backgroundStatus === "review" || backgroundStatus === "approved");
  const canLeaveDressing =
    !dressBusy && (dressStatus === "review" || dressStatus === "approved");
  const canLeaveMeshing = !meshBusy && meshStatus === "approved";
  const canLeaveSymbols = symbolsStatus === "approved";
  const nextDisabled =
    navBusy ||
    (screen === "influencer" && !canNextInfluencer) ||
    (screen === "theme" && !canNextTheme) ||
    (screen === "photo" && !canNextPhoto) ||
    (screen === "swimwear" && (!canNextSwimwear || uploading)) ||
    (screen === "processing" && !canLeaveProcessing) ||
    (screen === "confirm" &&
      (pictureBusy ||
        (pictureArtifacts.length === 0 && !confirmOverride.trim()))) ||
    (screen === "animating" && !canLeaveAnimating) ||
    (screen === "outfit" && (!outfitOverride.trim() || uploading)) ||
    (screen === "dressing" && !canLeaveDressing) ||
    (screen === "meshing" && !canLeaveMeshing) ||
    (screen === "symbols" && !canLeaveSymbols);

  return (
    <main className="leo-ui" ref={rootRef}>
      <div className="leo-ui__stage">
        <header className="leo-ui__header">
          <img className="leo-ui__logo" src={logoUrl} alt="Sugar Scratch" />
        </header>

        <div className="leo-ui__body">
          <div className="leo-ui__screen" ref={screenRef}>
            {viewScreen === "influencer" ? (
              <>
                <h1 className="leo-ui__title">Which influencer are you working on today?</h1>
                <label className={`leo-ui__search${query.trim() ? " has-clear" : ""}`}>
                  <img src={searchUrl} alt="" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search"
                    aria-label="Search influencers"
                  />
                  {query.trim() ? (
                    <button
                      type="button"
                      className="leo-ui__clear leo-ui__field-clear"
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                    >
                      ×
                    </button>
                  ) : null}
                </label>
                <p className="leo-ui__section-label">Recently Added</p>
                <div
                  className="leo-ui__list"
                  ref={listRef}
                  data-scroll={listScroll}
                >
                  {!catalogReady ? (
                    <p className="leo-ui__busy">Loading…</p>
                  ) : (
                    filteredModels.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        className={`leo-ui__card${modelId === model.id ? " is-selected" : ""}`}
                        onClick={() => {
                          if (modelId === model.id) {
                            clearSelection();
                            return;
                          }
                          setModelId(model.id);
                        }}
                      >
                        <span className="leo-ui__card-glow" aria-hidden />
                        <img
                          className="leo-ui__avatar"
                          src={previewSource(model.avatar || "") || undefined}
                          alt=""
                        />
                        <span className="leo-ui__card-text">
                          <p className="leo-ui__card-name">{modelName(model)}</p>
                          <p className="leo-ui__card-meta">{modelLocation(model)}</p>
                        </span>
                        <span className="leo-ui__chev" aria-hidden>
                          <img src={chevronUrl} alt="" />
                        </span>
                      </button>
                    ))
                  )}
                </div>
                {selectedModel ? (
                  <div
                    className={`leo-ui__selected-panel${selectedExiting ? " is-exiting" : ""}`}
                    key={selectedModel.id}
                    onAnimationEnd={(event) => {
                      if (
                        selectedExiting &&
                        event.target === event.currentTarget &&
                        event.animationName === "leo-selected-panel-out"
                      ) {
                        finishClearSelection();
                      }
                    }}
                  >
                    <p className="leo-ui__section-label leo-ui__selected-item">
                      Selected Influencer
                    </p>
                    <div className="leo-ui__selected-pill leo-ui__selected-item">
                      <span className="leo-ui__card-glow leo-ui__card-glow--green" aria-hidden />
                      <img
                        className="leo-ui__avatar"
                        src={previewSource(selectedModel.avatar || "") || undefined}
                        alt=""
                      />
                      <span className="leo-ui__card-text">
                        <p className="leo-ui__card-name">{modelName(selectedModel)}</p>
                        <p className="leo-ui__card-meta">{modelLocation(selectedModel)}</p>
                      </span>
                      <button
                        type="button"
                        className="leo-ui__clear"
                        aria-label="Clear selection"
                        disabled={selectedExiting}
                        onClick={clearSelection}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            {viewScreen === "theme" ? (
              <>
                <h1 className="leo-ui__title">Theme & Card Name</h1>
                <p className="leo-ui__sub">
                  Name is something related to the theme the card will be part of eg. Police001,
                  Gym001 etc.
                </p>
                <div className="leo-ui__stack leo-ui__stack--fill">
                  <div
                    className={`leo-ui__select-wrap${themeMenuOpen ? " is-open" : ""}`}
                    ref={themeSelectRef}
                  >
                    <button
                      type="button"
                      className={`leo-ui__field leo-ui__select-trigger${!theme ? " is-placeholder" : ""}`}
                      aria-haspopup="listbox"
                      aria-expanded={themeMenuOpen}
                      aria-label="Select theme"
                      onClick={() => setThemeMenuOpen((open) => !open)}
                    >
                      {theme || "Select Theme"}
                    </button>
                    {themeMenuOpen ? (
                      <ul className="leo-ui__select-menu" role="listbox" aria-label="Themes">
                        {themes.map((entry) => {
                          const selected = theme === entry.label;
                          return (
                            <li key={entry.id} role="presentation">
                              <button
                                type="button"
                                role="option"
                                aria-selected={selected}
                                className={`leo-ui__select-option${selected ? " is-selected" : ""}`}
                                onClick={() => {
                                  const nextTheme = entry.label;
                                  setTheme(nextTheme);
                                  setThemeMenuOpen(false);
                                  const digits = cardNameDigits(cardLabel);
                                  const next = buildCardName(
                                    nextTheme,
                                    digits,
                                    Boolean(digits),
                                  );
                                  setCardLabel(next);
                                  setCardNameFocused(true);
                                  requestAnimationFrame(() => {
                                    const el = cardNameRef.current;
                                    if (!el) return;
                                    el.focus();
                                    const pos = next.length;
                                    el.setSelectionRange(pos, pos);
                                  });
                                }}
                              >
                                {selected ? <Check size={16} aria-hidden /> : null}
                                <span>{entry.label}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                  <div className="leo-ui__stack-center">
                    <div className="leo-ui__card-name-stage">
                      <div
                        className="leo-ui__upload-card--ghost-slot"
                        ref={cardShellEditSlotRef}
                        aria-hidden
                      />
                      <div
                        className={`leo-ui__field-wrap${cardLabel.trim() ? " is-chip-active" : ""}`}
                        ref={cardNameEditSlotRef}
                      >
                        <input
                          ref={cardNameRef}
                          className="leo-ui__field leo-ui__field--with-clear"
                          value={cardLabel}
                          inputMode="numeric"
                          autoComplete="off"
                          onChange={(e) => {
                            if (!themePrefix(theme)) {
                              setError("Choose a theme first.");
                              return;
                            }
                            const digits = cardNameDigits(e.target.value);
                            setCardLabel(buildCardName(theme, digits, false));
                          }}
                          onFocus={() => {
                            setCardNameFocused(true);
                            if (!themePrefix(theme)) return;
                            const digits = cardNameDigits(cardLabel);
                            const next = buildCardName(theme, digits, false);
                            setCardLabel(next);
                            // setCardLabel remounts/replaces the input — e.currentTarget goes null.
                            requestAnimationFrame(() => {
                              const el = cardNameRef.current;
                              if (!el) return;
                              const pos = next.length;
                              el.setSelectionRange(pos, pos);
                            });
                          }}
                          onBlur={() => {
                            setCardNameFocused(false);
                            const digits = cardNameDigits(cardLabel);
                            setCardLabel(
                              digits
                                ? buildCardName(theme, digits, true)
                                : buildCardName(theme, "", false),
                            );
                          }}
                          placeholder=""
                          aria-label="Card name"
                        />
                        {!cardLabel.trim() && !cardNameFocused ? (
                          <span className="leo-ui__field-placeholder" aria-hidden>
                            Enter Card Name
                            <span className="leo-ui__field-caret">|</span>
                          </span>
                        ) : null}
                        {cardLabel.trim() ? (
                          <button
                            type="button"
                            className="leo-ui__clear leo-ui__field-clear"
                            aria-label="Clear card name"
                            onClick={() => setCardLabel("")}
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            {viewScreen === "photo" ? (
              <>
                <h1 className="leo-ui__title">Add Photo</h1>
                <p className="leo-ui__sub">
                  Add a photo where you can clearly see the influencer’s top of their head to
                  mid-thigh.
                </p>
                <div className="leo-ui__upload-card leo-ui__upload-card--host" ref={cardShellCardSlotRef}>
                  <div
                    className="leo-ui__upload-card-top leo-ui__upload-card-top--slot"
                    ref={cardNameCardSlotRef}
                    aria-hidden
                  />
                  <div className="leo-ui__upload-slot">
                    <div className="leo-ui__upload-media" ref={uploadMediaRef}>
                      <button
                        ref={uploadDashedRef}
                        type="button"
                        className="leo-ui__dashed"
                        disabled={uploading || Boolean(image)}
                        aria-hidden={Boolean(image)}
                        tabIndex={image ? -1 : 0}
                        onClick={() => openUpload("photo")}
                      >
                        <Upload size={18} />
                        Upload Photo
                      </button>
                      {image ? (
                        <div className="leo-ui__preview-wrap" ref={previewWrapRef}>
                          <div className="leo-ui__preview" ref={previewThumbRef}>
                            <img src={previewSource(image)} alt="Selected photo" />
                          </div>
                          <button
                            ref={previewClearRef}
                            type="button"
                            className="leo-ui__clear leo-ui__preview-clear"
                            aria-label="Remove photo"
                            onClick={clearPhoto}
                          >
                            {/* Fake glass: real backdrop-filter dies under screen transforms. */}
                            <span className="leo-ui__preview-clear-glass" aria-hidden>
                              <img src={previewSource(image)} alt="" />
                            </span>
                            <span className="leo-ui__preview-clear-mark" aria-hidden>
                              ×
                            </span>
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <div className="leo-ui__or">
                      <span>or</span>
                    </div>
                    <p className="leo-ui__section-label">Choose from Influencer Gallery</p>
                    <div className="leo-ui__gallery-scroll">
                      <div
                        ref={galleryRef}
                        className={`leo-ui__gallery${hasGallerySelection ? " has-selection" : ""}`}
                      >
                        {photoGallery.map((item) => {
                          const src = item.path || item.url;
                          const selected = isGalleryImage(image, item);
                          return (
                            <button
                              key={item.id}
                              type="button"
                              className={selected ? "is-selected" : ""}
                              onClick={() => {
                                if (selected) clearPhoto();
                                else setImage(src);
                              }}
                            >
                              <img src={previewSource(item.url || item.path)} alt="" />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            {viewScreen === "swimwear" ? (
              <>
                <h1 className="leo-ui__title">Swimwear</h1>
                <p className="leo-ui__sub">
                  Influencer not in swimwear? You can upload swimwear to add to the image or choose
                  from gallery.
                </p>
                <div className="leo-ui__upload-card leo-ui__upload-card--host" ref={cardShellCardSlotRef}>
                  {/* Same-context photo for bikini backdrop-filter — only after grow settles. */}
                  {photoFillReady && image ? (
                    <div className="leo-ui__host-photo" aria-hidden>
                      <img src={previewSource(image)} alt="" />
                    </div>
                  ) : null}
                  <div
                    className="leo-ui__upload-card-top leo-ui__upload-card-top--slot"
                    ref={cardNameCardSlotRef}
                    aria-hidden
                  />
                  <div className="leo-ui__stack">
                    <div className="leo-ui__face-slot">
                      <button
                        ref={faceBtnRef}
                        type="button"
                        className="leo-ui__face-btn"
                        onClick={() => openUpload("face")}
                        aria-hidden={Boolean(face)}
                        tabIndex={face ? -1 : 0}
                      >
                        <span className="leo-ui__face-btn-label">Add Face?</span>
                        <Upload size={24} aria-hidden />
                      </button>
                      {/* facePanelSrc holds the thumb through the remove exit. */}
                      {facePanelSrc || face ? (
                        <div className="leo-ui__preview-wrap leo-ui__face-preview-wrap">
                          <button
                            ref={faceThumbRef}
                            type="button"
                            className="leo-ui__face-preview"
                            onClick={() => openUpload("face")}
                            aria-label="Replace face photo"
                            tabIndex={face ? 0 : -1}
                          >
                            <img
                              src={previewSource(facePanelSrc || face)}
                              alt="Selected face"
                            />
                          </button>
                          <button
                            ref={faceClearRef}
                            type="button"
                            className="leo-ui__clear leo-ui__preview-clear"
                            aria-label="Remove face"
                            tabIndex={face ? 0 : -1}
                            onClick={() => setFace("")}
                          >
                            <span className="leo-ui__preview-clear-glass" aria-hidden>
                              <img src={previewSource(facePanelSrc || face)} alt="" />
                            </span>
                            <span className="leo-ui__preview-clear-mark" aria-hidden>
                              ×
                            </span>
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <div
                      className={`leo-ui__bikini-block${bikini ? " has-selection" : ""}`}
                    >
                      <div className="leo-ui__bikini-col">
                        <div className="leo-ui__bikini-row">
                          <button
                            type="button"
                            className="leo-ui__dashed"
                            disabled={uploading}
                            onClick={() => openUpload("bikini")}
                          >
                            <Upload size={18} />
                            {bikini ? "Upload" : "Upload Swimwear"}
                          </button>
                        </div>
                        <div className="leo-ui__bikini-row">
                          <div className="leo-ui__or">
                            <span>or</span>
                          </div>
                        </div>
                        <div className="leo-ui__bikini-row">
                          <button
                            type="button"
                            className="leo-ui__section-label"
                            onClick={openBikiniGallery}
                          >
                            {bikini ? "+ Gallery" : "Select from Gallery"}
                          </button>
                        </div>
                      </div>
                      <div
                        className="leo-ui__bikini-selected"
                        aria-live="polite"
                        aria-hidden={!(bikiniPanelSrc || bikini)}
                      >
                        {/* bikini keeps thumb mounted on select; bikiniPanelSrc holds it through close. */}
                        {bikiniPanelSrc || bikini ? (
                          <div className="leo-ui__preview-wrap">
                            <div className="leo-ui__preview">
                              <img
                                src={previewSource(bikiniPanelSrc || bikini)}
                                alt="Selected swimwear"
                              />
                            </div>
                            <button
                              type="button"
                              className="leo-ui__clear leo-ui__preview-clear"
                              aria-label="Remove swimwear"
                              onClick={() => setBikini("")}
                            >
                              <span className="leo-ui__preview-clear-glass" aria-hidden>
                                <img src={previewSource(bikiniPanelSrc || bikini)} alt="" />
                              </span>
                              <span className="leo-ui__preview-clear-mark" aria-hidden>
                                ×
                              </span>
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            {viewScreen === "processing" ? (
              <>
                <h1 className="leo-ui__title">Processing…</h1>
                <p className="leo-ui__sub">
                  Creating photo options from your swimwear and face picks.
                </p>
                <div
                  className="leo-ui__upload-card leo-ui__upload-card--host leo-ui__processing-card"
                  ref={cardShellCardSlotRef}
                >
                  <div className="leo-ui__host-photo is-processing" aria-hidden>
                    <img
                      src={previewSource(
                        processingRevealed
                          ? processedSrc
                          : image.trim(),
                      )}
                      alt=""
                    />
                  </div>
                  <div className="leo-ui__processing-lottie" aria-hidden>
                    <DotLottieReact
                      src={PROCESSING_HANGER_LOTTIE}
                      autoplay
                      loop
                      mode="reverse"
                      className="leo-ui__processing-lottie-player"
                      style={{ width: 140, height: 140, pointerEvents: "none" }}
                    />
                  </div>
                </div>
                {pictureBusy ? (
                  <p className="leo-ui__busy">Generating picture options…</p>
                ) : pictureArtifacts.length === 0 ? (
                  <p className="leo-ui__busy">Waiting for picture options…</p>
                ) : null}
              </>
            ) : null}

            {viewScreen === "confirm" ? (
              <>
                <h1 className="leo-ui__title">Confirm Photo?</h1>
                <p className="leo-ui__sub">
                  Does the influencer have the same facial and body features as before? Is the theme
                  correct?
                </p>
                {pictureBusy && pictureArtifacts.length === 0 ? (
                  <p className="leo-ui__busy">Generating picture options…</p>
                ) : (
                  <div className="leo-ui__confirm">
                    <div className="leo-ui__confirm-row">
                      <div
                        className={`leo-ui__confirm-hero${
                          confirmOverride || confirmUploadExitSrc ? " has-clear" : ""
                        }`}
                        ref={confirmHeroRef}
                      >
                        <img
                          className="leo-ui__confirm-hero-layer leo-ui__confirm-hero-layer--gen"
                          src={previewSource(processedSrc)}
                          alt="Selected photo option"
                        />
                        {confirmOverride || confirmUploadExitSrc ? (
                          <img
                            className="leo-ui__confirm-hero-layer leo-ui__confirm-hero-layer--up"
                            src={previewSource(confirmOverride || confirmUploadExitSrc)}
                            alt="Uploaded photo"
                          />
                        ) : null}
                        {confirmOverride ? (
                          <button
                            type="button"
                            className="leo-ui__clear leo-ui__preview-clear leo-ui__confirm-hero-clear"
                            aria-label="Remove uploaded photo"
                            onClick={() => {
                              setConfirmUploadExitSrc(confirmOverride);
                              setConfirmOverride("");
                            }}
                          >
                            <span className="leo-ui__preview-clear-glass" aria-hidden>
                              <img src={previewSource(confirmOverride)} alt="" />
                            </span>
                            <span className="leo-ui__preview-clear-mark" aria-hidden>
                              ×
                            </span>
                          </button>
                        ) : null}
                      </div>
                      <aside className="leo-ui__confirm-side">
                        <button
                          type="button"
                          className="leo-ui__confirm-card"
                          onClick={openPromptDialog}
                        >
                          <span>Change Prompt?</span>
                          <SquarePen size={22} strokeWidth={1.5} aria-hidden />
                        </button>
                        <div className="leo-cta-css-wrap leo-cta-css-wrap--fill leo-ui__confirm-rerun-wrap">
                          <button
                            type="button"
                            className="leo-cta-css leo-cta-css--fill"
                            onClick={() => void retryPicture()}
                          >
                            <span className="leo-cta-css__title-row">
                              <RotateCcw size={15} aria-hidden />
                              <span className="leo-cta-css__label">Re-Run</span>
                            </span>
                          </button>
                        </div>
                        <div className="leo-ui__confirm-or" aria-hidden>
                          <span className="leo-ui__confirm-or-line" />
                          <span className="leo-ui__confirm-or-label">or</span>
                          <span className="leo-ui__confirm-or-line" />
                        </div>
                        <div className="leo-ui__confirm-card leo-ui__confirm-card--upload">
                          <p>Upload your own image?</p>
                          {confirmOverride ? (
                            <div className="leo-ui__confirm-upload-preview">
                              <div className="leo-ui__confirm-upload is-filled">
                                <img src={previewSource(confirmOverride)} alt="" />
                              </div>
                              <button
                                type="button"
                                className="leo-ui__clear leo-ui__preview-clear"
                                aria-label="Remove uploaded photo"
                                onClick={() => {
                                  setConfirmUploadExitSrc(confirmOverride);
                                  setConfirmOverride("");
                                }}
                              >
                                <span className="leo-ui__preview-clear-glass" aria-hidden>
                                  <img src={previewSource(confirmOverride)} alt="" />
                                </span>
                                <span className="leo-ui__preview-clear-mark" aria-hidden>
                                  ×
                                </span>
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="leo-ui__confirm-upload"
                              onClick={() => openUpload("confirm")}
                              disabled={uploading}
                            >
                              <span>Upload</span>
                              <Upload size={22} strokeWidth={1.75} aria-hidden />
                            </button>
                          )}
                        </div>
                      </aside>
                    </div>
                    {pictureArtifacts.length > 1 ? (
                      <div className="leo-ui__confirm-thumbs" role="listbox" aria-label="Photo options">
                        {pictureArtifacts.map((path) => {
                          const choice = pictureChoiceFromArtifact(path) ?? 1;
                          return (
                            <button
                              key={path}
                              type="button"
                              role="option"
                              aria-selected={!confirmOverride && pictureChoice === choice}
                              className={`leo-ui__confirm-thumb${
                                !confirmOverride && pictureChoice === choice ? " is-selected" : ""
                              }`}
                              onClick={() => {
                                if (confirmOverride) {
                                  setConfirmUploadExitSrc(confirmOverride);
                                  setConfirmOverride("");
                                }
                                setPictureChoice(choice);
                              }}
                            >
                              <img src={previewSource(path)} alt={`Option ${choice}`} />
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                )}
              </>
            ) : null}

            {viewScreen === "animating" ? (
              <>
                <h1 className="leo-ui__title">Animating Image</h1>
                <div
                  className="leo-ui__sub leo-ui__sub--slots"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <div className="leo-ui__sub-slots-window">
                    <div className="leo-ui__sub-slots-reel" ref={animatingSlotsRef}>
                      {ANIMATING_SLOT_LINES.map((line) => (
                        <p key={line} className="leo-ui__sub-slots-line">
                          {line}
                        </p>
                      ))}
                      <p className="leo-ui__sub-slots-line" aria-hidden>
                        {ANIMATING_SLOT_LINES[0]}
                      </p>
                    </div>
                  </div>
                </div>
                <div
                  className="leo-ui__preview leo-ui__preview--animating is-blurred"
                  ref={animatingPreviewRef}
                >
                  {movingClip ? (
                    <video
                      src={previewSource(movingClip)}
                      autoPlay
                      loop
                      muted
                      playsInline
                      aria-hidden
                    />
                  ) : (
                    <img
                      src={previewSource(
                        confirmOverride.trim() || processedSrc || image,
                      )}
                      alt=""
                      aria-hidden
                    />
                  )}
                  <div className="leo-ui__play-mark" aria-hidden>
                    <div className="leo-ui__play-mark-lottie">
                      <DotLottieReact
                        src={ANIMATING_VIDEO_LOTTIE}
                        autoplay
                        loop
                        className="leo-ui__play-mark-lottie-player"
                        style={{ width: "100%", height: "100%", pointerEvents: "none" }}
                      />
                    </div>
                  </div>
                </div>
                {backgroundBusy ? <p className="leo-ui__busy">Working on the clip…</p> : null}
              </>
            ) : null}

            {viewScreen === "animated" ? (
              <>
                <h1 className="leo-ui__title">Image Animated!</h1>
                <p className="leo-ui__sub">Does the video look good, does it have any issues?</p>
                <div
                  className="leo-ui__preview leo-ui__preview--animated"
                  ref={animatedPreviewRef}
                >
                  {movingClip ? (
                    <video
                      src={previewSource(movingClip)}
                      autoPlay
                      loop
                      muted
                      playsInline
                    />
                  ) : null}
                  <div className="leo-ui__preview-overlay">
                    <button
                      type="button"
                      className="leo-ui__ghost-btn"
                      onClick={() => openRetryModelDialog("background_video")}
                    >
                      <RotateCcw size={16} />
                      Try Again?
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {viewScreen === "outfit" ? (
              <>
                <h1 className="leo-ui__title">Choose Outfit</h1>
                <p className="leo-ui__sub">
                  Pick a reference look for the dress-up step — upload your own image.
                </p>
                <div className="leo-ui__confirm">
                  <div className="leo-ui__confirm-row">
                    <div className="leo-ui__confirm-hero" ref={outfitHeroRef}>
                      <video
                        className="leo-ui__confirm-hero-layer leo-ui__confirm-hero-layer--gen"
                        src={previewSource(movingClip)}
                        autoPlay
                        loop
                        muted
                        playsInline
                      />
                    </div>
                    <aside className="leo-ui__confirm-side leo-ui__confirm-side--bottom">
                      <div className="leo-ui__confirm-card leo-ui__confirm-card--upload">
                        <p>Upload your own outfit?</p>
                        <div className="leo-ui__confirm-upload-slot" ref={outfitSlotRef}>
                          <button
                            ref={outfitUploadBtnRef}
                            type="button"
                            className="leo-ui__confirm-upload"
                            onClick={() => openUpload("outfit")}
                            disabled={uploading}
                            aria-hidden={Boolean(outfitOverride)}
                            tabIndex={outfitOverride ? -1 : 0}
                          >
                            <span>Upload</span>
                            <Upload size={22} strokeWidth={1.75} aria-hidden />
                          </button>
                          {outfitPanelSrc || outfitOverride ? (
                            <div className="leo-ui__confirm-upload-preview">
                              <button
                                ref={outfitThumbRef}
                                type="button"
                                className="leo-ui__confirm-upload is-filled"
                                onClick={() => openUpload("outfit")}
                                aria-label="Replace outfit"
                                tabIndex={outfitOverride ? 0 : -1}
                              >
                                <img
                                  src={previewSource(outfitPanelSrc || outfitOverride)}
                                  alt=""
                                />
                              </button>
                              <button
                                ref={outfitClearRef}
                                type="button"
                                className="leo-ui__clear leo-ui__preview-clear"
                                aria-label="Remove uploaded outfit"
                                tabIndex={outfitOverride ? 0 : -1}
                                onClick={() => setOutfitOverride("")}
                              >
                                <span className="leo-ui__preview-clear-glass" aria-hidden>
                                  <img
                                    src={previewSource(outfitPanelSrc || outfitOverride)}
                                    alt=""
                                  />
                                </span>
                                <span className="leo-ui__preview-clear-mark" aria-hidden>
                                  ×
                                </span>
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </aside>
                  </div>
                </div>
              </>
            ) : null}

            {viewScreen === "dressing" ? (
              <>
                <h1 className="leo-ui__title">Dressing Outfit</h1>
                <div
                  className="leo-ui__sub leo-ui__sub--slots"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <div className="leo-ui__sub-slots-window">
                    <div className="leo-ui__sub-slots-reel" ref={dressingSlotsRef}>
                      {DRESSING_SLOT_LINES.map((line) => (
                        <p key={line} className="leo-ui__sub-slots-line">
                          {line}
                        </p>
                      ))}
                      <p className="leo-ui__sub-slots-line" aria-hidden>
                        {DRESSING_SLOT_LINES[0]}
                      </p>
                    </div>
                  </div>
                </div>
                <div
                  className="leo-ui__preview leo-ui__preview--animating is-blurred"
                  ref={dressingPreviewRef}
                >
                  {dressClip ? (
                    <video
                      src={previewSource(dressClip)}
                      autoPlay
                      loop
                      muted
                      playsInline
                      aria-hidden
                    />
                  ) : (
                    <img
                      src={previewSource(processedSrc || image)}
                      alt=""
                      aria-hidden
                    />
                  )}
                  <div className="leo-ui__play-mark" aria-hidden>
                    <div className="leo-ui__play-mark-lottie">
                      <DotLottieReact
                        src={ANIMATING_VIDEO_LOTTIE}
                        autoplay
                        loop
                        className="leo-ui__play-mark-lottie-player"
                        style={{ width: "100%", height: "100%", pointerEvents: "none" }}
                      />
                    </div>
                  </div>
                </div>
                {dressBusy ? (
                  <p className="leo-ui__busy">Working on the outfit…</p>
                ) : dressClip ? null : (
                  <p className="leo-ui__busy">Waiting for the outfit clip…</p>
                )}
              </>
            ) : null}

            {viewScreen === "dressed" ? (
              <>
                <h1 className="leo-ui__title">Outfit Dressed!</h1>
                <p className="leo-ui__sub">Does the video look good, does it have any issues?</p>
                <div
                  className="leo-ui__preview leo-ui__preview--animated"
                  ref={dressedPreviewRef}
                >
                  {dressClip ? (
                    <video
                      src={previewSource(dressClip)}
                      autoPlay
                      loop
                      muted
                      playsInline
                    />
                  ) : null}
                  <div className="leo-ui__preview-overlay">
                    <button
                      type="button"
                      className="leo-ui__ghost-btn"
                      onClick={() => openRetryModelDialog("dress_video")}
                    >
                      <RotateCcw size={16} />
                      Try Again?
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {viewScreen === "meshing" ? (
              <>
                <h1 className="leo-ui__title">Generating Mesh</h1>
                <div
                  className="leo-ui__sub leo-ui__sub--slots"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <div className="leo-ui__sub-slots-window">
                    <div className="leo-ui__sub-slots-reel" ref={meshingSlotsRef}>
                      {MESHING_SLOT_LINES.map((line) => (
                        <p key={line} className="leo-ui__sub-slots-line">
                          {line}
                        </p>
                      ))}
                      <p className="leo-ui__sub-slots-line" aria-hidden>
                        {MESHING_SLOT_LINES[0]}
                      </p>
                    </div>
                  </div>
                </div>
                <div
                  className="leo-ui__preview leo-ui__preview--animating leo-ui__preview--meshing"
                  ref={meshingPreviewRef}
                >
                  {playClip ? (
                    <video
                      src={previewSource(playClip)}
                      autoPlay
                      loop
                      muted
                      playsInline
                      aria-hidden
                    />
                  ) : null}
                  <div className="leo-ui__play-mark" aria-hidden>
                    <div className="leo-ui__play-mark-lottie leo-ui__play-mark-lottie--wide">
                      <DotLottieReact
                        src={MESHING_LOTTIE}
                        autoplay
                        loop
                        className="leo-ui__play-mark-lottie-player"
                        style={{ width: 160, height: 160, pointerEvents: "none" }}
                        layout={{ fit: "contain", align: [0.5, 0.5] }}
                        // autoResize measures subpixel boxes (e.g. 399×400) and
                        // trips DotLottie's persistent buffer size check.
                        renderConfig={{ autoResize: false }}
                      />
                    </div>
                  </div>
                </div>
                {meshBusy ? <p className="leo-ui__busy">Building the mesh…</p> : null}
              </>
            ) : null}

            {viewScreen === "mask" ? (
              <>
                <h1 className="leo-ui__title">Adjust Mask</h1>
                <p className="leo-ui__sub">
                  Fine-tune the scratch mask — tweak the prompt if you need to.
                </p>
                <div className="leo-ui__confirm">
                  <div className="leo-ui__confirm-row">
                    <div
                      className="leo-ui__confirm-hero"
                      ref={maskHeroRef}
                      style={maskEditOpen ? { opacity: 0 } : undefined}
                    >
                      {playClip ? (
                        <video
                          className="leo-ui__confirm-hero-layer leo-ui__confirm-hero-layer--gen"
                          src={previewSource(playClip)}
                          autoPlay
                          loop
                          muted
                          playsInline
                        />
                      ) : null}
                    </div>
                    <aside className="leo-ui__confirm-side leo-ui__confirm-side--top">
                      <button
                        type="button"
                        className="leo-ui__confirm-card"
                        onClick={openMaskEdit}
                      >
                        <span>Edit Mask</span>
                        <SquarePen size={22} strokeWidth={1.5} aria-hidden />
                      </button>
                      <div className="leo-cta-css-wrap leo-cta-css-wrap--fill leo-ui__confirm-rerun-wrap">
                        <button
                          type="button"
                          className="leo-cta-css leo-cta-css--fill"
                          onClick={() => void retryMeshing()}
                        >
                          <span className="leo-cta-css__title-row">
                            <RotateCcw size={15} aria-hidden />
                            <span className="leo-cta-css__label">Re-Run</span>
                          </span>
                        </button>
                      </div>
                    </aside>
                  </div>
                </div>
              </>
            ) : null}

            {viewScreen === "symbols" ? (
              <>
                <h1 className="leo-ui__title">Place Symbols</h1>
                <p className="leo-ui__sub">
                  Place all points on the garment, then save before continuing.
                </p>
                <div className="leo-ui__confirm leo-ui__confirm--solo">
                  <div className="leo-ui__symbols-stage" ref={symbolsHeroRef}>
                    {cardId.trim() ? (
                      <Theme appearance="dark" accentColor="amber" radius="large">
                        <SymbolPointPicker
                          cardId={cardId.trim()}
                          foregroundVideo={
                            cardId.trim()
                              ? `/cards/${encodeURIComponent(cardId.trim())}/foreground.mp4`
                              : previewSource(playClip)
                          }
                          meshJsonPath={`/mesh/${encodeURIComponent(cardId.trim())}.json`}
                          onSaved={() => {
                            void refresh().catch(() => undefined);
                            setError("");
                          }}
                          onError={(message) => {
                            if (message) setError(message);
                          }}
                        />
                      </Theme>
                    ) : (
                      <p className="leo-ui__busy">Missing card for symbols.</p>
                    )}
                  </div>
                </div>
              </>
            ) : null}

            {viewScreen === "created" ? (
              <>
                <h1 className="leo-ui__title">Game Created!</h1>
                <p className="leo-ui__sub">
                  Give it a go by tapping the video below to start.
                </p>
                <button
                  type="button"
                  className="leo-ui__preview leo-ui__preview--animated leo-ui__preview--try"
                  ref={createdPreviewRef}
                  aria-label="Try motion card"
                  onClick={() => openTryMotion()}
                >
                  {playClip ? (
                    <video
                      src={previewSource(playClip)}
                      autoPlay
                      loop
                      muted
                      playsInline
                    />
                  ) : null}
                </button>
              </>
            ) : null}
          </div>
        </div>

        {error ? <p className="leo-ui__error">{error}</p> : null}

        <div className="leo-ui__upload-card-shell" ref={cardShellRef} aria-hidden>
          <img className="leo-ui__shell-photo" ref={shellPhotoRef} alt="" />
        </div>
        <div className="leo-ui__photo-fly" ref={photoFlyRef} aria-hidden>
          <img alt="" />
          <video muted loop playsInline />
        </div>
        <div
          className="leo-ui__upload-card-top leo-ui__card-name-chip"
          ref={cardNameChipRef}
          aria-hidden
        >
          {cardLabel.trim() || "Card"}
        </div>

        <footer className="leo-ui__footer">
          <div className="leo-ui__actions">
            <button
              ref={backBtnRef}
              type="button"
              className="leo-ui__btn leo-ui__btn--back"
              disabled={navBusy || !showBack}
              onClick={goBack}
            >
              Back
            </button>
            <div
              className={`leo-cta-css-wrap leo-cta-css-wrap--fill${
                nextDisabled ? " is-disabled" : ""
              }`}
            >
              <button
                ref={nextBtnRef}
                type="button"
                className={`leo-cta-css leo-cta-css--fill${
                  nextDisabled ? " is-disabled" : ""
                }`}
                disabled={nextDisabled}
                onClick={() => void goNext()}
              >
                <span className="leo-cta-css__title-row">
                  <span className="leo-ui__btn-icon" ref={nextIconRef} aria-hidden>
                    <Check size={16} />
                  </span>
                  <span
                    className="leo-cta-css__label leo-ui__btn-label"
                    ref={nextLabelRef}
                  >
                    {nextLabel}
                  </span>
                </span>
              </button>
            </div>
          </div>
          <div className="leo-ui__phases" ref={phasesRef} aria-label="Progress">
            <span className="leo-ui__phase-pill" ref={phasePillRef} aria-hidden />
            {Array.from({ length: PHASE_COUNT }, (_, index) => {
              const unlocked = index <= maxPhaseReached;
              const active = index === phase;
              const clickable = unlocked && !active && !navBusy;
              return (
                <button
                  key={index}
                  type="button"
                  className={`leo-ui__phase${active ? " is-active" : ""}${unlocked && !active ? " is-unlocked" : ""}`}
                  aria-label={PHASE_LABELS[index]}
                  aria-current={active ? "step" : undefined}
                  disabled={!clickable}
                  onClick={() => goToPhase(index)}
                />
              );
            })}
          </div>
        </footer>
      </div>

      <input
        ref={fileRef}
        className="leo-ui__hidden"
        type="file"
        accept="image/*"
        onChange={(e) => {
          void handleUpload(e.currentTarget.files?.[0]);
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={bikiniRef}
        className="leo-ui__hidden"
        type="file"
        accept="image/*"
        onChange={(e) => {
          void handleUpload(e.currentTarget.files?.[0]);
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={faceRef}
        className="leo-ui__hidden"
        type="file"
        accept="image/*"
        onChange={(e) => {
          void handleUpload(e.currentTarget.files?.[0]);
          e.currentTarget.value = "";
        }}
      />

      <dialog
        ref={tryMotionRef}
        className="leo-ui__try-motion"
        aria-label="Try motion card"
        closedby="closerequest"
        onCancel={(e) => {
          e.preventDefault();
          closeTryMotion();
        }}
      >
        <div className="leo-ui__try-motion-stage" ref={tryMotionStageRef}>
          {tryMotionOpen ? (
            <Suspense fallback={null}>
              <LeoTryMotionGame
                onReady={revealTryMotion}
                onClose={() => closeTryMotion()}
                onAccept={acceptTryMotionCard}
              />
            </Suspense>
          ) : null}
          <div
            className="leo-ui__try-motion-cover"
            ref={tryMotionCoverRef}
            aria-hidden
          >
            {playClip ? (
              <video
                src={previewSource(playClip)}
                autoPlay
                loop
                muted
                playsInline
              />
            ) : null}
          </div>
        </div>
      </dialog>

      {faceCrop ? (
        <LeoFaceCropDialog
          src={faceCrop.src}
          fileName={faceCrop.name}
          busy={uploading}
          onCancel={closeFaceCrop}
          onConfirm={(file) => void confirmFaceCrop(file)}
        />
      ) : null}

      {maskEditOpen ? (
        <LeoMaskEditOverlay
          open={maskEditOpen}
          fromRect={maskEditFrom}
          videoSrc={
            cardId.trim()
              ? `/cards/${encodeURIComponent(cardId.trim())}/foreground.mp4`
              : previewSource(playClip)
          }
          meshFile={cardId.trim() ? `${cardId.trim()}.json` : "draft.json"}
          meshUrl={
            cardId.trim()
              ? `/mesh/${encodeURIComponent(cardId.trim())}.json`
              : ""
          }
          onClose={closeMaskEdit}
          onError={(message) => setError(message)}
        />
      ) : null}

      <dialog
        ref={bikiniGalleryRef}
        className="leo-ui__gallery-dialog"
        aria-labelledby="leo-bikini-gallery-title"
        onCancel={(e) => {
          e.preventDefault();
          closeBikiniGallery();
        }}
        onPointerDown={(e) => {
          // Light-dismiss via our close tween (same as Cancel / Esc) — not closedby,
          // which would snap shut and skip the exit animation.
          if (e.target === e.currentTarget) closeBikiniGallery();
        }}
      >
        <div className="leo-ui__gallery-dialog-panel">
          <button
            type="button"
            className="leo-ui__clear leo-ui__gallery-dialog-close"
            aria-label="Close"
            onClick={() => closeBikiniGallery()}
          >
            ×
          </button>
          <h2 id="leo-bikini-gallery-title" className="leo-ui__gallery-dialog-title">
            Choose from Influencer Gallery
          </h2>
          <div className="leo-ui__gallery-scroll leo-ui__gallery-dialog-scroll">
            <div
              className={`leo-ui__gallery${hasBikiniGallerySelection ? " has-selection" : ""}`}
            >
              {photoGallery.map((item) => {
                const src = item.path || item.url;
                const selected = isGalleryImage(bikini, item);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={selected ? "is-selected" : ""}
                    onClick={() => {
                      if (selected) closeBikiniGallery(() => setBikini(""));
                      else pickBikiniFromGallery(src);
                    }}
                  >
                    <img src={previewSource(item.url || item.path)} alt="" />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </dialog>

      <dialog
        ref={promptDialogRef}
        className="leo-ui__prompt-dialog"
        onCancel={(e) => {
          e.preventDefault();
          closePromptDialog();
        }}
      >
        <div className="leo-ui__prompt-dialog-panel">
          <button
            type="button"
            className="leo-ui__clear leo-ui__prompt-dialog-close"
            aria-label="Close"
            onClick={() => closePromptDialog()}
          >
            ×
          </button>
          <h2 className="leo-ui__prompt-dialog-title">Change Prompt</h2>
          <p className="leo-ui__prompt-dialog-sub">
            Add direction for the next picture run. Save, then press Re-Run.
          </p>
          <textarea
            className="leo-ui__prompt-dialog-input"
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            rows={5}
            placeholder="e.g. warmer light, soft smile, keep the same pose…"
          />
          <div className="leo-ui__prompt-dialog-actions">
            <button
              type="button"
              className="leo-ui__btn leo-ui__btn--back"
              onClick={() => closePromptDialog()}
            >
              Cancel
            </button>
            <div className="leo-cta-css-wrap leo-cta-css-wrap--fill">
              <button
                type="button"
                className="leo-cta-css leo-cta-css--fill"
                onClick={savePromptDialog}
              >
                <span className="leo-cta-css__title-row">
                  <span className="leo-cta-css__label">Save</span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </dialog>

      <dialog
        ref={bgModelDialogRef}
        className="leo-ui__prompt-dialog"
        aria-labelledby="leo-bg-model-title"
        onCancel={(e) => {
          e.preventDefault();
          closeBgModelDialog();
        }}
      >
        <div className="leo-ui__prompt-dialog-panel">
          <button
            type="button"
            className="leo-ui__clear leo-ui__prompt-dialog-close"
            aria-label="Close"
            onClick={() => closeBgModelDialog()}
          >
            ×
          </button>
          <h2 id="leo-bg-model-title" className="leo-ui__prompt-dialog-title">
            Try Again
          </h2>
          <p className="leo-ui__prompt-dialog-sub">
            {retryModelRole === "dress_video"
              ? "Pick an AI model for the next dress run, then Re-Run."
              : "Pick an AI model for the next image-to-video run, then Re-Run."}
          </p>
          <ul
            className="leo-ui__model-list"
            ref={modelListRef}
            role="listbox"
            aria-label="AI models"
            data-scroll={modelListScroll}
          >
            {retryAiModels.length === 0 ? (
              <li className="leo-ui__model-list-empty">
                {retryModelRole === "dress_video"
                  ? "No dress video models available."
                  : "No background video models available."}
              </li>
            ) : (
              retryAiModels.map((entry: GenerationModelInfo) => {
                const selected = bgModelDraft === entry.id;
                const providerIcon = PROVIDER_ICONS[entry.provider];
                return (
                  <li key={entry.id} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`leo-ui__card${selected ? " is-selected" : ""}`}
                      onClick={() => setBgModelDraft(entry.id)}
                    >
                      <span
                        className={`leo-ui__card-glow${selected ? " leo-ui__card-glow--green" : ""}`}
                        aria-hidden
                      />
                      <span
                        className={`leo-ui__avatar leo-ui__avatar--provider${providerIcon ? "" : " is-empty"}`}
                        aria-hidden
                      >
                        {providerIcon ? <img src={providerIcon} alt="" /> : null}
                      </span>
                      <span className="leo-ui__card-text">
                        <p className="leo-ui__card-name">{entry.label}</p>
                      </span>
                      <span className="leo-ui__chev" aria-hidden>
                        <img src={chevronUrl} alt="" />
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          <div className="leo-ui__prompt-dialog-actions">
            <button
              type="button"
              className="leo-ui__btn leo-ui__btn--back"
              onClick={() => closeBgModelDialog()}
            >
              Cancel
            </button>
            <div className="leo-cta-css-wrap leo-cta-css-wrap--fill">
              <button
                type="button"
                className="leo-cta-css leo-cta-css--fill"
                onClick={confirmBgModelDialog}
                disabled={!bgModelDraft.trim() || retryAiModels.length === 0}
              >
                <span className="leo-cta-css__title-row">
                  <span className="leo-cta-css__label">Re-Run</span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </dialog>
    </main>
  );
}
