import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  FairyDustCursor,
  fairyDustPerf,
  resetFairyDustPerfPeak,
  type ParticleType,
} from "./cursorFx/FairyDustCursor";
import { loadLottieUrlSource } from "./cursorFx/loadLottieSource";
import { fetchModels, type ModelInfo } from "./shared/models";
import {
  loadVideoSrc,
  playThemeIntro,
  releaseMediaElement,
} from "./shared/media";
import { GarmentGLRenderer, PRESENT_ZOOM } from "./glRenderer";
import { GameSymbolIcon } from "./game/GameSymbolIcon";
import {
  buildBodySymbols,
  buildTopSymbols,
  loadSymbolTypes,
  matchedTopSlots,
  matchResultDetail,
  resolveMatchGame,
  SYMBOL_TYPES,
  SYMBOL_TYPE_COUNT,
  type MatchGameOutcome,
} from "./game/matchGame";
import {
  resolveStageCoachPhase,
  StageCoachHint,
} from "./game/StageCoachHint";
import {
  finishMotionHand,
  isGameModeUrl,
  loadGameSession,
  navigateTo,
  recordMotionCardResult,
  themeForMotionCard,
  type GameSession,
} from "./game/gameSession";
import {
  InitialCountdown,
  isCountdownSoundUnlocked,
  TOP_BAR_DOCK_MS,
  unlockCountdownSound,
} from "./game/InitialCountdown";
import { TopSymbolBar, type TopBarPhase } from "./game/TopSymbolBar";
import { fetchThemes } from "./shared/themes";
import {
  MirrorSlideTransition,
  nextTemplateId,
  type TransitionTemplateId,
} from "./videoTransition";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  parseTrackedMesh,
  sampleMeshUvToWorld,
  sampleTrackedMesh,
  SYMBOL_POINT_COUNT,
  trackedWorldToUv,
  type TrackedMesh,
  type TrackedMeshSample,
  type Vec2,
} from "./meshGeometry";

// On-screen diagnostics (FPS, layer drift, raw video state) shown only when the
// page is opened with ?debug=1. Self-contained: it polls the DOM/video elements
// directly so it adds no coupling to the render loop. Used to debug Safari, which
// can't be driven from the dev tooling here.
function DebugHud() {
  const [lines, setLines] = useState<string[]>(["debug: starting…"]);

  useEffect(() => {
    let frames = 0;
    let rafId = 0;
    // Per-video: how many distinct currentTime values we saw (= delivered video
    // frames) and the last value, so we can report the *effective* playback fps
    // separately from the render fps. A low video fps while render fps stays high
    // is the signature of decode stutter (the canvas redraws fine, but it's
    // showing the same decoded frame repeatedly).
    const vstate = new Map<HTMLVideoElement, { last: number; count: number }>();
    const tick = () => {
      frames += 1;
      for (const v of document.querySelectorAll<HTMLVideoElement>(
        ".source-video",
      )) {
        const s = vstate.get(v);
        if (!s) {
          vstate.set(v, { last: v.currentTime, count: 0 });
        } else if (v.currentTime !== s.last) {
          s.last = v.currentTime;
          s.count += 1;
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    let last = performance.now();
    let peakHeap = 0;
    const intervalId = window.setInterval(() => {
      const now = performance.now();
      const elapsed = Math.max(1, now - last);
      const fps = Math.round((frames * 1000) / elapsed);
      frames = 0;
      last = now;

      const vids = Array.from(
        document.querySelectorAll<HTMLVideoElement>(".source-video"),
      );
      const [bottom, foreground] = vids;
      const out: string[] = [`render ${fps}fps`];

      // Cursor FX cost: concurrent particles drive drawImage count; fadeSpeed
      // and particles-per-move are the main knobs that grow this under load.
      const fx = fairyDustPerf;
      out.push(
        `fx ${fx.active} particles (peak ${fx.peak}) ${fx.avgFrameMs.toFixed(2)}ms avg`,
      );

      // JS heap usage. performance.memory is non-standard (Chromium only) but
      // works on plain http/localhost — unlike measureUserAgentSpecificMemory,
      // which needs cross-origin isolation. Safari exposes neither, so we note
      // it as unavailable there.
      const mem = (
        performance as Performance & {
          memory?: {
            usedJSHeapSize: number;
            totalJSHeapSize: number;
            jsHeapSizeLimit: number;
          };
        }
      ).memory;
      const mb = (n: number) => (n / 1048576).toFixed(1);
      if (mem) {
        // Show one decimal + running peak so small allocations are visible; the
        // whole-MB rounding before made it look frozen. NOTE: this is only the JS
        // heap — GPU textures and video decode buffers (what actually grows while
        // scratching) live outside it, so use Chrome's Task Manager for true RAM.
        if (mem.usedJSHeapSize > peakHeap) peakHeap = mem.usedJSHeapSize;
        out.push(
          `heap ${mb(mem.usedJSHeapSize)}MB peak ${mb(peakHeap)} (lim ${mb(mem.jsHeapSizeLimit)})`,
        );
      } else {
        out.push("heap n/a (no perf.memory)");
      }
      const deviceMemory = (navigator as Navigator & { deviceMemory?: number })
        .deviceMemory;
      if (deviceMemory) out.push(`devMem ~${deviceMemory}GB`);

      if (bottom && foreground) {
        const drift = bottom.currentTime - foreground.currentTime;
        out.push(
          `drift ${drift.toFixed(3)}s  fgRate ${foreground.playbackRate.toFixed(3)}`,
        );
      }
      vids.forEach((v, i) => {
        const tag = i === 0 ? "btm" : "fg ";
        const s = vstate.get(v);
        const vfps = s ? Math.round((s.count * 1000) / elapsed) : 0;
        if (s) s.count = 0;
        out.push(
          `${tag} ${vfps}vfps rs${v.readyState} ${v.paused ? "PAUSED" : "play"}${v.seeking ? " SEEK" : ""} t${v.currentTime.toFixed(2)}${v.error ? ` ERR${v.error.code}` : ""}`,
        );
      });
      setLines(out);
    }, 500);

    return () => {
      cancelAnimationFrame(rafId);
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        top: 6,
        left: 6,
        zIndex: 50,
        padding: "6px 8px",
        background: "rgba(0,0,0,0.72)",
        color: "#7CFC00",
        font: "11px/1.35 ui-monospace, Menlo, monospace",
        whiteSpace: "pre",
        borderRadius: 6,
        pointerEvents: "none",
        maxWidth: "92%",
      }}
    >
      {lines.join("\n")}
    </div>
  );
}

type ScratchMark = {
  u: number;
  v: number;
  radius: number;
};

// A coin that animates from the scratch origin up to a symbol slot in the top
// bar each time a new symbol ("coin") is earned. Positions are stage-relative
// pixels; the CSS keyframe arcs the coin from `from*` to `to*`.
type FlyingCoin = {
  id: number;
  typeId: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  midX: number;
  midY: number;
  delayMs: number;
};

const COIN_FLIGHT_DURATION_MS = 620;
const COIN_FLIGHT_STAGGER_MS = 80;
// A card pairs the reveal (bottom) video, the green-screen foreground video, and
// the tracked mesh generated from that foreground. Switching cards swaps all
// three together so the scratch holes line up with the right clip.
type Card = {
  id: string;
  label: string;
  bottom: string;
  foreground: string;
  mesh: string;
  chromaKey: boolean;
  model_id?: string;
  sort_order?: number;
  photos?: Array<{ id: string; src: string }>;
};

const CARDS_INDEX_SRC = "/cards/index.json";

const DEFAULT_CARDS: Card[] = [
  {
    id: "original",
    label: "Original",
    bottom: "/cards/ai%20girl%202.mp4",
    foreground: "/cards/Green%20bg%20sample%202%20swap.mp4",
    mesh: "tracked-mesh.json",
    chromaKey: true,
  },
  {
    id: "girl_1",
    label: "Girl 1",
    bottom: "/cards/girl_1/background.mp4",
    foreground: "/cards/girl_1/foreground.mp4",
    mesh: "girl_1.json",
    chromaKey: false,
  },
  {
    id: "girl_2",
    label: "Girl 2",
    bottom: "/cards/girl_2/background.mp4",
    foreground: "/cards/girl_2/foreground.mp4",
    mesh: "girl_2.json",
    chromaKey: false,
  },
  {
    id: "juliana_1",
    label: "Julianaval Cop 2",
    bottom: "/cards/juliana_1/background.mp4",
    foreground: "/cards/juliana_1/foreground.mp4",
    mesh: "juliana_1.json",
    chromaKey: false,
  },
  {
    id: "juliana_2",
    label: "Julianaval Nurse",
    bottom: "/cards/juliana_2/background.mp4",
    foreground: "/cards/juliana_2/foreground.mp4",
    mesh: "juliana_2.json",
    chromaKey: false,
  },
  {
    id: "chinese_1",
    label: "Chinese 1",
    bottom: "/cards/chinese_1/background.mp4",
    foreground: "/cards/chinese_1/foreground.mp4",
    mesh: "chinese_1.json",
    chromaKey: false,
  },
];

type CardsIndexResponse = {
  cards?: Array<{
    id: string;
    label: string;
    bottom: string;
    foreground: string;
    mesh: string;
    chroma_key?: boolean;
    model_id?: string;
    sort_order?: number;
    photos?: Array<{ id: string; src: string }>;
  }>;
};

function cardUsesChromaKey(id: string, chromaKey: boolean | undefined): boolean {
  if (typeof chromaKey === "boolean") return chromaKey;
  return id === "original";
}

function parseCardsIndex(data: CardsIndexResponse): Card[] | null {
  if (!Array.isArray(data.cards) || data.cards.length === 0) return null;
  const cards: Card[] = [];
  for (const entry of data.cards) {
    if (
      typeof entry.id !== "string" ||
      typeof entry.label !== "string" ||
      typeof entry.bottom !== "string" ||
      typeof entry.foreground !== "string" ||
      typeof entry.mesh !== "string"
    ) {
      continue;
    }
    cards.push({
      id: entry.id,
      label: entry.label,
      bottom: entry.bottom,
      foreground: entry.foreground,
      mesh: entry.mesh,
      chromaKey: cardUsesChromaKey(entry.id, entry.chroma_key),
      model_id: entry.model_id,
      sort_order: typeof entry.sort_order === "number" ? entry.sort_order : 0,
      photos: entry.photos,
    });
  }
  return cards.length > 0 ? cards : null;
}

function playlistCardsForModel(cards: Card[], modelId: string): Card[] {
  return cards
    .filter((entry) => entry.model_id === modelId)
    .sort((a, b) => {
      const orderA = a.sort_order ?? 0;
      const orderB = b.sort_order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      return a.id.localeCompare(b.id);
    });
}

function playlistCardsForGameSession(
  cards: Card[],
  session: GameSession,
): Card[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const ordered: Card[] = [];
  for (const id of session.motionCardIds) {
    const card = byId.get(id);
    if (card) ordered.push(card);
  }
  return ordered;
}

async function loadCards(): Promise<Card[]> {
  try {
    const response = await fetch(CARDS_INDEX_SRC, { cache: "no-store" });
    if (!response.ok) return DEFAULT_CARDS;
    const data = (await response.json()) as CardsIndexResponse;
    return parseCardsIndex(data) ?? DEFAULT_CARDS;
  } catch {
    return DEFAULT_CARDS;
  }
}

const MESH_INDEX_SRC = "/mesh/index.json";
const MESH_DIRECTORY_SRC = "/mesh";
const DEFAULT_MESH_FILE = "tracked-mesh.json";
const SYMBOL_SLOT_COUNT = SYMBOL_POINT_COUNT;
const SYMBOL_REVEAL_STEP_MANUAL = 0.056;
const SYMBOL_REVEAL_STEP_AUTO = 0.083;
const FULL_REVEAL_MANUAL_THRESHOLD = 0.7;
const GAME_OUTCOME_OVERLAY_PAD_MS = 300;
const GAME_OUTCOME_SILENT_DELAY_MS = 1500;
const UI_STATE_UPDATE_INTERVAL_MS = 250;
/** Brief hold→dissolve so the scratch-to-start bar can be the hero beat. */
const INTRO_REVEAL_MS = 380;
const SCRATCH_ZOOM_STORAGE_KEY = "sugar-scratchie:scratch-zoom-v2";
const LEGACY_SCRATCH_ZOOM_STORAGE_KEYS = ["sugar-scratchie:scratch-zoom"];
const SOUND_STORAGE_KEY = "sugar-scratchie:sound";
// Slightly larger than the manual brush so a scratch that covers the mark counts.
/** Skip GPU sample when the stroke is nowhere near the symbol. */
const SYMBOL_REVEAL_UV_RADIUS = 0.06;
/** Require the scratch map itself to be clear at the symbol UV — stops icons
 * floating over still-opaque clothing just because a stroke passed nearby. */
const SYMBOL_SCRATCH_REVEAL_THRESHOLD = 0.55;
/** Lottie backing store matches the CSS marker so the find-bounce doesn't
 * upscale a soft 42px canvas. */
const BODY_SYMBOL_ICON_PX = 72;

type ScratchZoomSettings = {
  enabled: boolean;
  scale: number;
  durationMs: number;
  bounce: boolean;
};

const SCRATCH_ZOOM_DEFAULTS: ScratchZoomSettings = {
  enabled: false,
  scale: 1.35,
  durationMs: 180,
  bounce: false,
};

function buildSessionSymbols(): number[] {
  return buildBodySymbols();
}

function revealedSymbolCount(progress: number, autoMode: boolean) {
  const step = autoMode ? SYMBOL_REVEAL_STEP_AUTO : SYMBOL_REVEAL_STEP_MANUAL;
  return Math.min(SYMBOL_SLOT_COUNT, Math.floor(progress / step));
}

function isGarmentFullyRevealed(
  progress: number,
  revealedCount: number,
  sampleCount: number,
  autoMode: boolean,
) {
  if (sampleCount === 0) return false;
  if (autoMode) {
    return revealedCount >= sampleCount;
  }
  return (
    progress >= FULL_REVEAL_MANUAL_THRESHOLD ||
    revealedCount >= Math.ceil(sampleCount * FULL_REVEAL_MANUAL_THRESHOLD)
  );
}

type GameResult = "win" | "lose";

const DESKTOP_SETTINGS_TABS = [
  { id: "scratch-zoom", label: "Scratch zoom" },
  { id: "sound", label: "Sound" },
  { id: "auto-scratch", label: "Auto scratch" },
  { id: "cursor-fx", label: "Cursor FX" },
] as const;

type DesktopSettingsTab = (typeof DESKTOP_SETTINGS_TABS)[number]["id"];

// One chromatic note per symbol slot (C5 → B5); slot index always maps to the same pitch.
const SYMBOL_NOTE_BASE_HZ = 523.25;
const SYMBOL_NOTE_DURATION_S = 0.32;

type SymbolAudioState = {
  ctx: AudioContext | null;
};

function ensureSymbolAudio(state: SymbolAudioState) {
  if (typeof window === "undefined") return null;
  if (!state.ctx) {
    const AudioCtor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtor) return null;
    state.ctx = new AudioCtor();
  }
  if (state.ctx.state === "suspended") void state.ctx.resume();
  return state.ctx;
}

function symbolSlotFrequency(slotIndex: number) {
  return SYMBOL_NOTE_BASE_HZ * 2 ** (slotIndex / SYMBOL_SLOT_COUNT);
}

function playSymbolSlotNote(state: SymbolAudioState, slotIndex: number) {
  const ctx = ensureSymbolAudio(state);
  if (!ctx || slotIndex < 0 || slotIndex >= SYMBOL_SLOT_COUNT) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(symbolSlotFrequency(slotIndex), now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + SYMBOL_NOTE_DURATION_S);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + SYMBOL_NOTE_DURATION_S + 0.02);
}

function playNewSymbolNotes(
  state: SymbolAudioState,
  prevCount: number,
  nextCount: number,
  enabled: boolean,
) {
  if (!enabled) return;
  for (let slot = prevCount; slot < nextCount; slot += 1) {
    playSymbolSlotNote(state, slot);
  }
}

function scheduleTone(
  ctx: AudioContext,
  startAt: number,
  frequency: number,
  durationS: number,
  volume: number,
  type: OscillatorType = "triangle",
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationS);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + durationS + 0.02);
}

function scheduleSlide(
  ctx: AudioContext,
  startAt: number,
  fromHz: number,
  toHz: number,
  durationS: number,
  volume: number,
  type: OscillatorType = "triangle",
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(fromHz, startAt);
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(toHz, 1),
    startAt + durationS,
  );
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationS);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + durationS + 0.02);
}

function playGameOutcomeSound(
  state: SymbolAudioState,
  outcome: GameResult,
  enabled: boolean,
): number {
  if (!enabled) return GAME_OUTCOME_SILENT_DELAY_MS;

  const ctx = ensureSymbolAudio(state);
  if (!ctx) return 1800;

  const now = ctx.currentTime;

  if (outcome === "win") {
    const sparkle = [
      523.25, 587.33, 659.25, 698.46, 783.99, 880, 987.77, 1174.66, 1318.51,
      1567.98, 1760, 2093,
    ];
    const sparkleStep = 0.048;
    sparkle.forEach((freq, index) => {
      scheduleTone(ctx, now + index * sparkleStep, freq, 0.09, 0.17, "sine");
      if (index % 2 === 0) {
        scheduleTone(
          ctx,
          now + index * sparkleStep + 0.012,
          freq * 2,
          0.055,
          0.09,
          "triangle",
        );
      }
    });

    const fanfareStart = now + sparkle.length * sparkleStep + 0.06;
    const fanfare = [523.25, 659.25, 783.99, 987.77, 1174.66];
    fanfare.forEach((freq, index) => {
      const t = fanfareStart + index * 0.1;
      scheduleTone(ctx, t, freq, 0.15, 0.3, "square");
      scheduleTone(ctx, t, freq * 0.5, 0.15, 0.14, "sawtooth");
      scheduleTone(ctx, t + 0.04, freq * 1.5, 0.08, 0.08, "triangle");
    });

    const chordAt = fanfareStart + fanfare.length * 0.1 + 0.1;
    const chord = [261.63, 392, 523.25, 659.25, 783.99, 1046.5, 1318.51];
    chord.forEach((freq, index) => {
      const type: OscillatorType = index < 2 ? "sawtooth" : "triangle";
      scheduleTone(ctx, chordAt, freq, 0.78, index < 2 ? 0.11 : 0.13, type);
    });

    const glitterStart = chordAt + 0.12;
    const glitter = [2093, 2349, 2637, 2793, 3136, 3520];
    glitter.forEach((freq, index) => {
      scheduleTone(ctx, glitterStart + index * 0.045, freq, 0.11, 0.11, "sine");
    });

    const shimmerStart = glitterStart + glitter.length * 0.045 + 0.08;
    for (let i = 0; i < 6; i += 1) {
      scheduleTone(
        ctx,
        shimmerStart + i * 0.06,
        1760 + i * 110,
        0.07,
        0.09,
        "sine",
      );
    }

    const endTime = shimmerStart + 6 * 0.06 + 0.35;
    return (endTime - now) * 1000 + GAME_OUTCOME_OVERLAY_PAD_MS;
  }

  // Sad descending "wah wah" for a loss.
  scheduleSlide(ctx, now, 340, 190, 0.52, 0.2, "sawtooth");
  scheduleSlide(ctx, now + 0.62, 290, 130, 0.58, 0.18, "sawtooth");
  scheduleSlide(ctx, now + 1.28, 220, 95, 0.72, 0.16, "triangle");
  return 2.05 * 1000 + GAME_OUTCOME_OVERLAY_PAD_MS;
}

function scratchZoomEasing(bounce: boolean) {
  return bounce ? "cubic-bezier(0.34, 1.56, 0.64, 1)" : "ease-out";
}

function loadSoundEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(SOUND_STORAGE_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { enabled?: boolean };
    return parsed.enabled ?? true;
  } catch {
    return true;
  }
}

// Rect-taking variant, for callers that project several points per frame: the
// two getBoundingClientRect reads are identical for every point, so hoisting
// them out of the loop turns 2N layout reads into 2.
function worldPointToStageWithRects(
  worldPoint: Vec2,
  canvasRect: DOMRect,
  stageRect: DOMRect,
  camera: { x: number; y: number },
): Vec2 {
  const refClipX = (worldPoint.x / CANVAS_WIDTH) * 2 - 1;
  const refClipY = 1 - (worldPoint.y / CANVAS_HEIGHT) * 2;
  const presentX = ((refClipX * PRESENT_ZOOM + camera.x + 1) / 2) * CANVAS_WIDTH;
  const presentY =
    ((1 - (refClipY * PRESENT_ZOOM + camera.y)) / 2) * CANVAS_HEIGHT;
  const clientX =
    canvasRect.left + (presentX / CANVAS_WIDTH) * canvasRect.width;
  const clientY =
    canvasRect.top + (presentY / CANVAS_HEIGHT) * canvasRect.height;
  return { x: clientX - stageRect.left, y: clientY - stageRect.top };
}

function worldPointToStage(
  worldPoint: Vec2,
  canvas: HTMLCanvasElement,
  stage: HTMLElement,
  camera: { x: number; y: number },
): Vec2 {
  return worldPointToStageWithRects(
    worldPoint,
    canvas.getBoundingClientRect(),
    stage.getBoundingClientRect(),
    camera,
  );
}

function loadScratchZoomSettings(): ScratchZoomSettings {
  if (typeof window === "undefined") return SCRATCH_ZOOM_DEFAULTS;
try {
  for (const key of LEGACY_SCRATCH_ZOOM_STORAGE_KEYS) {
    localStorage.removeItem(key);
  }
} catch {
  // ignore
}
  try {
    const raw = localStorage.getItem(SCRATCH_ZOOM_STORAGE_KEY);
    if (!raw) return SCRATCH_ZOOM_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<ScratchZoomSettings>;
    return {
      enabled: parsed.enabled ?? SCRATCH_ZOOM_DEFAULTS.enabled,
      scale: clampValue(
        Number(parsed.scale) || SCRATCH_ZOOM_DEFAULTS.scale,
        1,
        2,
      ),
      durationMs: clampValue(
        Number(parsed.durationMs) || SCRATCH_ZOOM_DEFAULTS.durationMs,
        50,
        800,
      ),
      bounce: parsed.bounce ?? SCRATCH_ZOOM_DEFAULTS.bounce,
    };
  } catch {
    return SCRATCH_ZOOM_DEFAULTS;
  }
}

const AUTO_SCRATCH_STORAGE_KEY = "sugar-scratchie:auto-scratch";
const SCRATCH_RADIUS = 0.045;
// Max canvas-space step between manual scratch stamps so fast swipes stay continuous.
const MANUAL_SCRATCH_PATH_STEP = SCRATCH_RADIUS * 0.65 * CANVAS_HEIGHT;
const MANUAL_SCRATCH_MAX_POINTS = 40;
const AUTO_SCRATCH_RADIUS = 0.092;
const AUTO_SCRATCH_DIAGONAL_LINES = 18;
// Step along each ↘ stroke (top-left → bottom-right) so brush circles overlap.
const AUTO_SCRATCH_PATH_STEP_UV = AUTO_SCRATCH_RADIUS * 0.72;
const AUTO_SCRATCH_FILL_BATCH = 36;
const AUTO_SCRATCH_MAX_PER_FRAME = 32;

type AutoScratchSettings = {
  enabled: boolean;
  speed: number;
  flakes: boolean;
};

const AUTO_SCRATCH_DEFAULTS: AutoScratchSettings = {
  enabled: false,
  speed: 58,
  flakes: false,
};

function loadAutoScratchSettings(): AutoScratchSettings {
  if (typeof window === "undefined") return AUTO_SCRATCH_DEFAULTS;
  try {
    const raw = localStorage.getItem(AUTO_SCRATCH_STORAGE_KEY);
    if (!raw) return AUTO_SCRATCH_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AutoScratchSettings>;
    return {
      enabled: parsed.enabled ?? AUTO_SCRATCH_DEFAULTS.enabled,
      speed: clampValue(
        Number(parsed.speed) || AUTO_SCRATCH_DEFAULTS.speed,
        1,
        120,
      ),
      flakes: parsed.flakes ?? AUTO_SCRATCH_DEFAULTS.flakes,
    };
  } catch {
    return AUTO_SCRATCH_DEFAULTS;
  }
}

const CURSOR_FX_STORAGE_KEY = "sugar-scratchie:cursor-fx-v6";
const LEGACY_CURSOR_FX_STORAGE_KEYS = [
  "sugar-scratchie:cursor-fx",
  "sugar-scratchie:cursor-fx-v1",
  "sugar-scratchie:cursor-fx-v2",
  "sugar-scratchie:cursor-fx-v3",
  "sugar-scratchie:cursor-fx-v4",
  "sugar-scratchie:cursor-fx-v5",
];

type CursorFxSettings = {
  fairyDust: boolean;
  particleSize: number;
  particleCount: number;
  gravity: number;
  fadeSpeed: number;
};

const CURSOR_FX_DEFAULTS: CursorFxSettings = {
  fairyDust: true,
  particleSize: 64,
  particleCount: 2,
  gravity: 0.1,
  // 0.98 looks lush but ~9× concurrent vs 0.91; 0.94 keeps a denser trail
  // (~1.1s life) without sitting on the 400-particle cap during hard scratches.
  fadeSpeed: 0.94,
};

const CURSOR_FX_INITIAL_VELOCITY = { min: 0.5, max: 1.5 };

const CURSOR_FX_LOTTIE_PRESETS: { url: string; name: string }[] = [
  { url: "/cursor-fx/Shining Effect.lottie", name: "Shining Effect.lottie" },
  { url: "/cursor-fx/Shining Effect.lottie", name: "Shining Effect.lottie" },
  { url: "/cursor-fx/Diamond Coin.lottie", name: "Diamond Coin.lottie" },
  { url: "/cursor-fx/Diamond Coin.lottie", name: "Diamond Coin.lottie" },
];

function loadCursorFxSettings(): CursorFxSettings {
  if (typeof window === "undefined") return CURSOR_FX_DEFAULTS;
  for (const key of LEGACY_CURSOR_FX_STORAGE_KEYS) {
    localStorage.removeItem(key);
  }
  try {
    const raw = localStorage.getItem(CURSOR_FX_STORAGE_KEY);
    if (!raw) return CURSOR_FX_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<CursorFxSettings>;
    return {
      fairyDust: parsed.fairyDust ?? CURSOR_FX_DEFAULTS.fairyDust,
      particleSize: clampValue(
        Number(parsed.particleSize) || CURSOR_FX_DEFAULTS.particleSize,
        10,
        64,
      ),
      particleCount: clampValue(
        Number(parsed.particleCount) || CURSOR_FX_DEFAULTS.particleCount,
        1,
        8,
      ),
      gravity: clampValue(
        Number(parsed.gravity) || CURSOR_FX_DEFAULTS.gravity,
        0,
        0.1,
      ),
      fadeSpeed: clampValue(
        Number(parsed.fadeSpeed) || CURSOR_FX_DEFAULTS.fadeSpeed,
        0.9,
        0.99,
      ),
    };
  } catch {
    return CURSOR_FX_DEFAULTS;
  }
}

function clampValue(value: number, lo: number, hi: number) {
  return value < lo ? lo : value > hi ? hi : value;
}

function foregroundTimeFromBottom(
  source: HTMLVideoElement,
  target: HTMLVideoElement,
) {
  const srcT = source.currentTime;
  const srcDur = source.duration;
  const tgtDur = target.duration;
  if (!Number.isFinite(srcT) || !Number.isFinite(tgtDur) || tgtDur <= 0)
    return srcT;
  if (
    Number.isFinite(srcDur) &&
    srcDur > 0 &&
    Math.abs(srcDur - tgtDur) <= 0.25
  ) {
    return Math.min(Math.max(0, srcT), tgtDur - 0.001);
  }
  return srcT % tgtDur;
}

// Subtle virtual camera that keeps the performer's chest near a fixed framing
// point. The chest anchor is a mesh-UV coordinate (roughly center, upper torso);
// each frame we sample where it lands and pan the presented shot toward the
// target. Pan is clamped small (and < PRESENT_ZOOM-1 so no edge shows) and
// smoothed so the move stays gentle.
const CHEST_ANCHOR_UV = { x: 0.5, y: 0.4 };
const CHEST_TARGET_UV = { x: 0.5, y: 0.4 };
const CHEST_FOLLOW_STRENGTH = 0.7;
const CHEST_CAM_MAX = Math.min(0.05, PRESENT_ZOOM - 1);
const CHEST_SMOOTH = 0.08;

// Bilinearly interpolate the deformed mesh at a fractional UV grid position to
// get its current canvas-pixel location (the mesh UV grid is regular 0..1).
// sampleMeshUvToWorld lives in meshGeometry.ts

// Drift past this (seconds) is a genuine discontinuity (loop wrap) and is
// corrected immediately with a hard seek. Seeks stall the decoder, and on
// Safari, whose currentTime is coarse, a low threshold makes us seek constantly
// (every stale reading crosses it) which reads as continuous lag — so keep it
// high.
const HARD_SEEK_DRIFT = 0.45;

// Smaller but persistent drift (a startup offset between the two play() calls,
// a decode stall, tab-suspend catch-up) is closed with a rare one-shot seek:
// drift must hold past SOFT_SEEK_DRIFT for SOFT_SEEK_CONFIRM_MS before we act,
// and corrections are spaced by SOFT_SEEK_COOLDOWN_MS so a single stale
// currentTime reading (Safari updates at ~4 Hz) can't cause a seek storm.
// 0.05s catches a 2-frame offset at 24fps (2×0.042=0.083s) and at 30fps
// (2×0.033=0.067s), which 0.09s would silently ignore.
// 150ms confirm is long enough to outlast one Safari polling interval (~250ms)
// while still snapping within the first visible loop.
const SOFT_SEEK_DRIFT = 0.05;
const SOFT_SEEK_CONFIRM_MS = 150;
const SOFT_SEEK_COOLDOWN_MS = 2000;

const videoSyncState = new WeakMap<
  HTMLVideoElement,
  { driftSince: number; lastSeekAt: number }
>();

function syncVideoTime(source: HTMLVideoElement, target: HTMLVideoElement) {
  if (source.paused && !target.paused) {
    target.pause();
  }

  if (!source.paused && target.paused) {
    void target.play().catch(() => undefined);
  }

  if (
    !Number.isFinite(source.currentTime) ||
    !Number.isFinite(target.duration) ||
    target.duration <= 0
  ) {
    return;
  }

  // A seek hasn't landed yet (Safari resolves seeks asynchronously, and its
  // currentTime lags during one). Acting now would compare against a stale time
  // and pile on more seeks — a seek storm that looks like a hard stutter.
  if (target.seeking) return;

  // Let the foreground free-run at 1×. Continuously steering playbackRate
  // knocks Safari's video decoder off its smooth-decode path, which starves the
  // foreground to a few fps and makes it fall behind — the opposite of what the
  // steering is trying to do. Corrections below are seeks only, and rare.
  if (target.playbackRate !== 1) target.playbackRate = 1;

  const targetTime = foregroundTimeFromBottom(source, target);
  const drift = targetTime - target.currentTime;
  const now = performance.now();
  let state = videoSyncState.get(target);
  if (!state) {
    state = { driftSince: 0, lastSeekAt: 0 };
    videoSyncState.set(target, state);
  }

  // A genuine discontinuity (loop wrap): snap immediately.
  if (Math.abs(drift) > HARD_SEEK_DRIFT) {
    target.currentTime = targetTime;
    state.driftSince = 0;
    state.lastSeekAt = now;
    return;
  }

  // Sub-wrap drift: require it to persist before correcting, and never correct
  // more often than the cooldown, so coarse/stale readings can't cause a storm.
  if (Math.abs(drift) > SOFT_SEEK_DRIFT) {
    if (state.driftSince === 0) {
      state.driftSince = now;
    } else if (
      now - state.driftSince >= SOFT_SEEK_CONFIRM_MS &&
      now - state.lastSeekAt >= SOFT_SEEK_COOLDOWN_MS
    ) {
      target.currentTime = targetTime;
      state.driftSince = 0;
      state.lastSeekAt = now;
    }
  } else {
    state.driftSince = 0;
  }
}

function parseMeshIndex(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { files?: unknown }).files)
  ) {
    return [];
  }

  return (value as { files: unknown[] }).files
    .filter((file): file is string => {
      return (
        typeof file === "string" &&
        file.toLowerCase().endsWith(".json") &&
        !file.includes("/")
      );
    })
    .sort((a, b) => a.localeCompare(b));
}

// The fixed UV grid used to measure reveal progress. With a garment mask we keep
// only samples that land on clothing, so progress means "how much of the dress is
// scratched" (and can reach 100%), not how much of the whole screen.
function buildRevealSamples(mesh: TrackedMesh | null): Vec2[] {
  const samplesAcross = 13;
  const samplesDown = 18;
  const garment = mesh?.garment ?? null;
  const cols = mesh?.cols ?? 0;
  const rows = mesh?.rows ?? 0;
  const points: Vec2[] = [];

  for (let yIndex = 0; yIndex <= samplesDown; yIndex += 1) {
    for (let xIndex = 0; xIndex <= samplesAcross; xIndex += 1) {
      const u = xIndex / samplesAcross;
      const v = yIndex / samplesDown;
      if (garment && cols > 0 && rows > 0) {
        const col = Math.round(u * (cols - 1));
        const row = Math.round(v * (rows - 1));
        if (!garment[row * cols + col]) continue;
      }
      points.push({ x: u, y: v });
    }
  }

  return points;
}

function densifyScratchPath(points: Vec2[], maxStep: number): Vec2[] {
  if (points.length === 0) return [];
  const out: Vec2[] = [{ x: points[0].x, y: points[0].y }];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= maxStep) {
      out.push(b);
      continue;
    }
    const steps = Math.ceil(dist / maxStep);
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      out.push({ x: a.x + dx * t, y: a.y + dy * t });
    }
  }
  return out;
}

function densifyStrokeSegment(
  from: Vec2,
  to: Vec2,
  maxStep: number,
  maxPoints: number,
): Vec2[] {
  const points = densifyScratchPath([from, to], maxStep);
  if (points.length <= maxPoints) return points;
  const kept: Vec2[] = [points[0]];
  const lastIndex = points.length - 1;
  for (let i = 1; i < maxPoints - 1; i += 1) {
    const idx = Math.round((i / (maxPoints - 1)) * lastIndex);
    kept.push(points[idx]);
  }
  kept.push(points[lastIndex]);
  return kept;
}

function isGarmentUv(mesh: TrackedMesh | null, u: number, v: number) {
  const garment = mesh?.garment ?? null;
  const cols = mesh?.cols ?? 0;
  const rows = mesh?.rows ?? 0;
  if (!garment || cols <= 0 || rows <= 0) return true;
  const col = Math.round(clampValue(u, 0, 1) * (cols - 1));
  const row = Math.round(clampValue(v, 0, 1) * (rows - 1));
  return Boolean(garment[row * cols + col]);
}

// Parallel ↙ strokes (u+v = const): top → bottom on each line; lines sweep top-left → bottom-right.
function buildAutoScratchPath(mesh: TrackedMesh | null): Vec2[] {
  const lineCount = AUTO_SCRATCH_DIAGONAL_LINES;
  const lines: { startU: number; startV: number; points: Vec2[] }[] = [];

  for (let i = 0; i <= lineCount; i += 1) {
    const s = (i / lineCount) * 2;
    let startU: number;
    let startV: number;
    let endU: number;
    let endV: number;
    if (s <= 1) {
      // ↙ along u+v=s: top (high u, low v) → bottom (low u, high v)
      startU = s;
      startV = 0;
      endU = 0;
      endV = s;
    } else {
      const t = s - 1;
      startU = 1;
      startV = 1 - t;
      endU = 1 - t;
      endV = 1;
    }

    const span = Math.hypot(endU - startU, endV - startV);
    if (span < 1e-6) continue;

    const linePoints: Vec2[] = [];
    const stepsAlong = Math.max(
      2,
      Math.ceil(span / (AUTO_SCRATCH_PATH_STEP_UV * 1.8)),
    );
    for (let j = 0; j <= stepsAlong; j += 1) {
      const f = j / stepsAlong;
      const u = startU + (endU - startU) * f;
      const v = startV + (endV - startV) * f;
      if (!isGarmentUv(mesh, u, v)) continue;
      linePoints.push({ x: u, y: v });
    }
    if (linePoints.length === 0) continue;
    lines.push({
      startU: linePoints[0].x,
      startV: linePoints[0].y,
      points: linePoints,
    });
  }

  lines.sort((a, b) => {
    if (Math.abs(a.startV - b.startV) > 1e-4) return a.startV - b.startV;
    return a.startU - b.startU;
  });

  const sparse: Vec2[] = [];
  for (const line of lines) {
    sparse.push(...densifyScratchPath(line.points, AUTO_SCRATCH_PATH_STEP_UV));
  }
  return sparse;
}

export function ScratchPrototype() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const symbolSlotRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Most recent pointer position in viewport coords; used as the origin of the
  // flying-coin animation for manual scratches.
  const lastPointerClientRef = useRef<Vec2 | null>(null);
  const coinIdRef = useRef(0);
  const [flyingCoins, setFlyingCoins] = useState<FlyingCoin[]>([]);
  const [, setSymbolCatalogTick] = useState(0);

  useEffect(() => {
    loadSymbolTypes()
      .then((ok) => {
        if (ok) setSymbolCatalogTick((n) => n + 1);
      })
      .catch(() => undefined);
  }, []);
  const bottomVideoRef = useRef<HTMLVideoElement | null>(null);
  const foregroundVideoRef = useRef<HTMLVideoElement | null>(null);
  const glRendererRef = useRef<GarmentGLRenderer | null>(null);
  const marksRef = useRef<ScratchMark[]>([]);
  const hoverPointRef = useRef<Vec2 | null>(null);
  const lastScratchWorldRef = useRef<Vec2 | null>(null);
  const drawingRef = useRef(false);
  // Reveal progress is measured against a fixed UV sample grid. We track which
  // samples have *ever* been scratched (monotonic), so the percentage matches
  // the permanent scratch texture and never drops — even after marksRef is
  // capped or the fabric moves.
  const revealSamplesRef = useRef<Vec2[]>([]);
  const revealedRef = useRef<boolean[]>([]);
  const revealedCountRef = useRef(0);
  const [trackedMesh, setTrackedMesh] = useState<TrackedMesh | null>(null);
  const trackedSampleRef = useRef<TrackedMeshSample | null>(null);
  const trackedMeshRef = useRef<TrackedMesh | null>(null);
  trackedMeshRef.current = trackedMesh;
  // Smoothed chest-follow camera offset, in clip units. Read by getCanvasPoint
  // to invert the pan when mapping a tap back to fabric UV.
  const cameraRef = useRef({ x: 0, y: 0 });
  const [meshFiles, setMeshFiles] = useState<string[]>([]);
  const [cards, setCards] = useState<Card[]>(DEFAULT_CARDS);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [cardsReady, setCardsReady] = useState(false);
  const [selectedMeshFile, setSelectedMeshFile] = useState(DEFAULT_CARDS[1].mesh);
  const [meshReloadToken, setMeshReloadToken] = useState(0);
  const [activeModelId, setActiveModelId] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("model")?.trim() || "";
  });
  const [selectedCardId, setSelectedCardId] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("card")?.trim() || "";
  });
  const [gameSession, setGameSession] = useState<GameSession | null>(() => {
    if (typeof window === "undefined" || !isGameModeUrl()) return null;
    const session = loadGameSession();
    return session?.phase === "motion" ? session : null;
  });
  const gameMode = Boolean(gameSession);
  const modelCards = useMemo(() => {
    if (gameSession) return playlistCardsForGameSession(cards, gameSession);
    return activeModelId ? playlistCardsForModel(cards, activeModelId) : [];
  }, [activeModelId, cards, gameSession]);
  const [completedCardIds, setCompletedCardIds] = useState<string[]>(() =>
    gameSession?.completedMotionIds ?? [],
  );
  const completedCardIdsRef = useRef<string[]>([]);
  completedCardIdsRef.current = completedCardIds;
  const remainingCards = useMemo(
    () => modelCards.filter((entry) => !completedCardIds.includes(entry.id)),
    [modelCards, completedCardIds],
  );
  const activeModel = models.find((entry) => entry.id === activeModelId) ?? null;
  // Never fall back to another girl's card — only play cards owned by the active model
  // (or the curated game-session hand).
  const card = useMemo(() => {
    if (modelCards.length === 0) return null;
    if (!gameMode && !activeModelId) return null;
    return (
      remainingCards.find((entry) => entry.id === selectedCardId) ??
      remainingCards[0] ??
      null
    );
  }, [activeModelId, gameMode, modelCards.length, remainingCards, selectedCardId]);
  const showModelPicker =
    !cardsReady ||
    (!gameMode && (!activeModelId || modelCards.length === 0));
  const playlistFinished =
    (gameMode || Boolean(activeModelId)) &&
    modelCards.length > 0 &&
    remainingCards.length === 0;
  const chromaKeyRef = useRef(card?.chromaKey ?? false);
  chromaKeyRef.current = card?.chromaKey ?? false;
  const advanceAfterScratchRef = useRef<() => void>(() => undefined);
  const transitionTemplateIndexRef = useRef(0);
  const cardTransitionActiveRef = useRef(false);
  type CardTransitionState = {
    fromBottom: string;
    toBottom: string;
    templateId: TransitionTemplateId;
    nextCardId: string;
    finishedId: string;
    prize: number;
  };
  const [cardTransition, setCardTransition] =
    useState<CardTransitionState | null>(null);
  // Mesh lattice is a dev overlay — start hidden; toggle with "Show mesh".
  const [showMesh, setShowMesh] = useState(false);
  const showMeshRef = useRef(showMesh);
  showMeshRef.current = showMesh;
  const bodyMarkerRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Last styles written to each body marker, so the render loop can skip
  // redundant DOM writes. See the marker loop in render() for why.
  const bodyMarkerStyleRef = useRef<
    ({ el: HTMLDivElement; transform: string; revealed: boolean | null } | null)[]
  >([]);
  const useBodySymbolsRef = useRef(false);
  const revealedPointsRef = useRef<boolean[]>(
    Array.from({ length: SYMBOL_SLOT_COUNT }, () => false),
  );
  const useBodySymbols =
    trackedMesh?.symbolPoints?.length === SYMBOL_SLOT_COUNT;
  useBodySymbolsRef.current = useBodySymbols;
  const [progress, setProgress] = useState(0);
  // Mirrors drawingRef for the body-symbol icons, which hold their animation
  // while a stroke is in progress — that is exactly the window where the two
  // videos compete with Lottie for the main thread. Flips twice per stroke, not
  // per move, so it does not add render churn to the drag itself.
  const [isScratching, setIsScratching] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [gameResult, setGameResult] = useState<GameResult | null>(null);
  const [gameResultLeaving, setGameResultLeaving] = useState(false);
  const [matchOutcome, setMatchOutcome] = useState<MatchGameOutcome | null>(
    null,
  );
  const matchOutcomeRef = useRef<MatchGameOutcome | null>(null);
  const [topSymbols, setTopSymbols] = useState(buildTopSymbols);
  const [topBarPhase, setTopBarPhase] = useState<TopBarPhase>("center");
  const [topBarRound, setTopBarRound] = useState(0);
  /** Locks body scratch / video from dock through countdown end. */
  const [introGateActive, setIntroGateActive] = useState(false);
  const [showIntroCountdown, setShowIntroCountdown] = useState(false);
  /** Theme intro clip for the current Play/Continue visit (game mode only). */
  const [introVideoUrl, setIntroVideoUrl] = useState("");
  /** Intro owns the decoder; game clips stay unloaded while this is true. */
  const [introActive, setIntroActive] = useState(false);
  /** Overlay still covers the stage (playing, holding last frame, or fading). */
  const [introCover, setIntroCover] = useState(false);
  /** Crossfading the frozen intro out over the live game stage. */
  const [introLeaving, setIntroLeaving] = useState(false);
  /** Starts muted for autoplay policy; may unmute after playThemeIntro succeeds. */
  const [introMuted, setIntroMuted] = useState(true);
  const introActiveRef = useRef(false);
  introActiveRef.current = introActive;
  const introCoverRef = useRef(false);
  introCoverRef.current = introCover;
  const introLeavingRef = useRef(false);
  introLeavingRef.current = introLeaving;
  const introVideoElRef = useRef<HTMLVideoElement | null>(null);
  const introFreezeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const introFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handStartIntroDoneRef = useRef(false);
  /** True when 3-2-1 already played over the hand-start theme intro. */
  const handStartCountdownOverIntroRef = useRef(false);
  /** One 3-2-1 per hand — later cards skip straight to play after the top bar. */
  const handCountdownDoneRef = useRef(false);
  /** Keeps match locked until that over-intro countdown finishes. */
  const [handStartCountdownPending, setHandStartCountdownPending] = useState(false);
  const themeIntroByKeyRef = useRef<Map<string, string>>(new Map());
  const [themeIntrosReady, setThemeIntrosReady] = useState(false);
  /** True once we've decided whether to show a hand-start intro (or skipped it). */
  const [handStartIntroResolved, setHandStartIntroResolved] = useState(
    () => !isGameModeUrl(),
  );
  /**
   * Game-mode: don't unlock the scratch bar until the card clips have a frame.
   * Avoids the black stage that shows if the bar appears while Safari is still
   * attaching decoders after the theme intro.
   */
  const [gameVideosReady, setGameVideosReady] = useState(() => !isGameModeUrl());
  /**
   * Cold refresh has no audio gesture — wait for Tap to play. Play/Continue
   * already called unlockCountdownSound(), so this starts true then.
   */
  const [entryReady, setEntryReady] = useState(
    () => !isGameModeUrl() || !loadSoundEnabled() || isCountdownSoundUnlocked(),
  );
  const entryReadyRef = useRef(entryReady);
  entryReadyRef.current = entryReady;
  const [sessionSymbols, setSessionSymbols] = useState(buildSessionSymbols);
  const [revealedSymbols, setRevealedSymbols] = useState(0);
  const [bodyRevealed, setBodyRevealed] = useState<boolean[]>(() =>
    Array.from({ length: SYMBOL_SLOT_COUNT }, () => false),
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(18.8);
  const [isPaused, setIsPaused] = useState(false);
  const progressRef = useRef(progress);
  const claimedRef = useRef(claimed);
  const gameResultRef = useRef<GameResult | null>(gameResult);
  gameResultRef.current = gameResult;
  const gameResultPendingRef = useRef<GameResult | null>(null);
  const gameResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameResultLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const introDockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const topSymbolsRef = useRef(topSymbols);
  topSymbolsRef.current = topSymbols;
  const topBarPhaseRef = useRef(topBarPhase);
  topBarPhaseRef.current = topBarPhase;
  const introGateActiveRef = useRef(introGateActive);
  introGateActiveRef.current = introGateActive;
  const showIntroCountdownRef = useRef(showIntroCountdown);
  showIntroCountdownRef.current = showIntroCountdown;
  const sessionSymbolsRef = useRef(sessionSymbols);
  sessionSymbolsRef.current = sessionSymbols;
  const revealedSymbolsRef = useRef(revealedSymbols);
  revealedSymbolsRef.current = revealedSymbols;
  const uiStateRef = useRef({
    currentTime,
    duration,
    isPaused,
    lastUpdatedAt: 0,
  });
  const [scratchZoom, setScratchZoom] = useState<ScratchZoomSettings>(
    loadScratchZoomSettings,
  );
  const scratchZoomRef = useRef(scratchZoom);
  scratchZoomRef.current = scratchZoom;
  const [autoScratch, setAutoScratch] = useState<AutoScratchSettings>(
    loadAutoScratchSettings,
  );
  const autoScratchRef = useRef(autoScratch);
  autoScratchRef.current = autoScratch;
  const [cursorFx, setCursorFx] = useState<CursorFxSettings>(
    loadCursorFxSettings,
  );
  const [cursorFxParticleTypes, setCursorFxParticleTypes] = useState<
    ParticleType[]
  >([]);
  const [cursorFxPerf, setCursorFxPerf] = useState({
    active: 0,
    peak: 0,
    avgFrameMs: 0,
  });
  const [soundEnabled, setSoundEnabled] = useState(loadSoundEnabled);
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const autoPathRef = useRef<Vec2[]>([]);
  const autoPathIndexRef = useRef(0);
  const autoPathProgressRef = useRef(0);
  const applyScratchAtUvRef = useRef<
    (u: number, v: number, radius: number, worldPoint?: Vec2 | null) => void
  >(() => undefined);
  const tryResolveGameRef = useRef<() => void>(() => undefined);
  const resetScratchRef = useRef<() => void>(() => undefined);
  const symbolAudioRef = useRef<SymbolAudioState>({ ctx: null });
  // Phones hide the side panel, so the scratch-zoom config lives behind a gear
  // button that opens this sheet.
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [desktopSettingsTab, setDesktopSettingsTab] =
    useState<DesktopSettingsTab>("scratch-zoom");
  const [glError, setGlError] = useState<string | null>(null);

  function clearGameResultTimer() {
    if (gameResultTimerRef.current !== null) {
      window.clearTimeout(gameResultTimerRef.current);
      gameResultTimerRef.current = null;
    }
  }

  function clearIntroDockTimer() {
    if (introDockTimerRef.current !== null) {
      window.clearTimeout(introDockTimerRef.current);
      introDockTimerRef.current = null;
    }
  }

  function clearIntroFadeTimer() {
    if (introFadeTimerRef.current !== null) {
      window.clearTimeout(introFadeTimerRef.current);
      introFadeTimerRef.current = null;
    }
  }

  function captureIntroFreezeFrame(): boolean {
    const intro = introVideoElRef.current;
    const freeze = introFreezeCanvasRef.current;
    if (!intro || !freeze) return false;
    if (intro.videoWidth < 2 || intro.videoHeight < 2) return false;
    freeze.width = intro.videoWidth;
    freeze.height = intro.videoHeight;
    const ctx = freeze.getContext("2d");
    if (!ctx) return false;
    try {
      ctx.drawImage(intro, 0, 0);
      return true;
    } catch {
      return false;
    }
  }

  function finishIntroCover() {
    clearIntroFadeTimer();
    const intro = introVideoElRef.current;
    if (intro) releaseMediaElement(intro);
    const freeze = introFreezeCanvasRef.current;
    if (freeze) {
      freeze.width = 0;
      freeze.height = 0;
    }
    setIntroLeaving(false);
    introLeavingRef.current = false;
    setIntroCover(false);
    introCoverRef.current = false;
    setIntroVideoUrl("");
    setIntroMuted(true);
  }

  function isBodyScratchLocked() {
    if (gameMode && !entryReadyRef.current) return true;
    if (introActiveRef.current || introCoverRef.current) return true;
    if (gameMode && !handStartIntroDoneRef.current) return true;
    return (
      useBodySymbolsRef.current &&
      (topBarPhaseRef.current === "center" || introGateActiveRef.current)
    );
  }

  function onMatchEntryTap() {
    unlockCountdownSound();
    setEntryReady(true);
  }

  function scheduleIntroCountdown() {
    clearIntroDockTimer();
    introDockTimerRef.current = window.setTimeout(() => {
      introDockTimerRef.current = null;
      setShowIntroCountdown(true);
      showIntroCountdownRef.current = true;
    }, TOP_BAR_DOCK_MS);
  }

  function kickGameVideos() {
    if (uiStateRef.current.isPaused) return;
    const bottomVideo = bottomVideoRef.current;
    const foregroundVideo = foregroundVideoRef.current;
    if (!bottomVideo || !foregroundVideo) return;
    // Safari sometimes keeps readyState high but stops presenting frames after
    // the theme-intro decoder is torn down — a tiny seek nudges a fresh frame.
    for (const video of [bottomVideo, foregroundVideo]) {
      try {
        if (video.readyState >= 2 && !video.seeking) {
          const t = video.currentTime;
          if (Number.isFinite(t) && t > 0) {
            video.currentTime = Math.max(0, t - 0.001);
          }
        }
      } catch {
        // ignore seek failures
      }
    }
    void Promise.all([bottomVideo.play(), foregroundVideo.play()]).catch(
      () => undefined,
    );
  }

  function dismissThemeIntro(options?: { immediate?: boolean }) {
    if (!introActiveRef.current && !introCoverRef.current) return;
    if (introLeavingRef.current && !options?.immediate) return;

    const intro = introVideoElRef.current;
    if (intro) {
      try {
        intro.pause();
      } catch {
        // ignore
      }
    }

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const captured = !options?.immediate && captureIntroFreezeFrame();

    // Free the intro decoder before attaching the game pair (Safari).
    if (intro) releaseMediaElement(intro);
    setIntroActive(false);
    introActiveRef.current = false;
    setIntroVideoUrl("");

    if (options?.immediate || reduceMotion || !captured) {
      finishIntroCover();
      requestAnimationFrame(() => kickGameVideos());
      return;
    }

    // Hold the frozen last frame until the game stage has a decoded frame, then
    // crossfade — avoids the hard cut to black while Safari attaches decoders.
    setIntroCover(true);
    introCoverRef.current = true;
    setIntroLeaving(false);
    introLeavingRef.current = false;
    requestAnimationFrame(() => kickGameVideos());
  }

  function armHandStartIntro(cardId: string, session: GameSession) {
    if (handStartIntroDoneRef.current) return;
    handStartIntroDoneRef.current = true;
    const themeLabel = themeForMotionCard(session, cardId)?.trim();
    const url = themeLabel
      ? themeIntroByKeyRef.current.get(themeLabel.toLowerCase()) ?? ""
      : "";
    clearIntroDockTimer();
    clearIntroFadeTimer();
    setShowIntroCountdown(false);
    showIntroCountdownRef.current = false;
    setHandStartCountdownPending(false);
    handStartCountdownOverIntroRef.current = false;
    setIntroLeaving(false);
    introLeavingRef.current = false;
    if (!url) {
      setIntroVideoUrl("");
      setIntroActive(false);
      introActiveRef.current = false;
      setIntroCover(false);
      introCoverRef.current = false;
      setHandStartIntroResolved(true);
      return;
    }
    setIntroVideoUrl(url);
    setIntroActive(true);
    introActiveRef.current = true;
    setIntroCover(true);
    introCoverRef.current = true;
    setGameVideosReady(false);
    setHandStartIntroResolved(true);
    // 3-2-1 plays on top of the theme intro (once for this hand-start visit).
    handStartCountdownOverIntroRef.current = true;
    setHandStartCountdownPending(true);
    setIntroGateActive(true);
    introGateActiveRef.current = true;
    setShowIntroCountdown(true);
    showIntroCountdownRef.current = true;
  }

  function resetGameOutcome() {
    clearGameResultTimer();
    if (gameResultLeaveTimerRef.current !== null) {
      window.clearTimeout(gameResultLeaveTimerRef.current);
      gameResultLeaveTimerRef.current = null;
    }
    gameResultPendingRef.current = null;
    gameResultRef.current = null;
    matchOutcomeRef.current = null;
    setGameResult(null);
    setGameResultLeaving(false);
    setMatchOutcome(null);
  }

  function beginLeaveGameResult() {
    if (gameResultLeaving) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      advanceAfterScratchRef.current();
      return;
    }
    setGameResultLeaving(true);
    if (gameResultLeaveTimerRef.current !== null) {
      window.clearTimeout(gameResultLeaveTimerRef.current);
    }
    // Don't rely only on animationend — some browsers skip it when the
    // leave animation replaces an in-flight open animation.
    gameResultLeaveTimerRef.current = window.setTimeout(() => {
      gameResultLeaveTimerRef.current = null;
      advanceAfterScratchRef.current();
    }, 760);
  }

  function resetMatchRound() {
    clearIntroDockTimer();
    setTopSymbols(buildTopSymbols());
    setTopBarPhase("center");
    topBarPhaseRef.current = "center";
    // Card-load effect runs after armHandStartIntro in the same commit. Don't
    // wipe a hand-start 3-2-1 that was just armed (or the over-intro flag stays
    // set and the post-dock countdown is skipped forever).
    const preserveHandStartCountdown =
      handStartCountdownOverIntroRef.current || handStartCountdownPending;
    if (!preserveHandStartCountdown) {
      setIntroGateActive(false);
      introGateActiveRef.current = false;
      setShowIntroCountdown(false);
      showIntroCountdownRef.current = false;
    }
    setTopBarRound((n) => n + 1);
    setSessionSymbols(buildBodySymbols());
    setMatchOutcome(null);
  }

  function unlockPlayAfterDock() {
    clearIntroDockTimer();
    introDockTimerRef.current = window.setTimeout(() => {
      introDockTimerRef.current = null;
      setIntroGateActive(false);
      introGateActiveRef.current = false;
    }, TOP_BAR_DOCK_MS);
  }

  function onTopBarAllRevealed() {
    setTopBarPhase("docked");
    topBarPhaseRef.current = "docked";
    setIntroGateActive(true);
    introGateActiveRef.current = true;
    clearIntroDockTimer();
    // Later cards in the hand: no 3-2-1, just open play after the bar docks.
    if (handCountdownDoneRef.current) {
      unlockPlayAfterDock();
      return;
    }
    // Already ran / still running 3-2-1 over the theme intro — no second copy.
    if (handStartCountdownOverIntroRef.current) {
      handStartCountdownOverIntroRef.current = false;
      if (showIntroCountdownRef.current) {
        // Still playing; unlock when InitialCountdown completes.
        return;
      }
      // Armed for intro but not visible (e.g. wiped by a race) — play it now.
      if (handStartCountdownPending) {
        scheduleIntroCountdown();
        return;
      }
      handCountdownDoneRef.current = true;
      unlockPlayAfterDock();
      return;
    }
    // First card, no over-intro path — one countdown for the whole hand.
    setShowIntroCountdown(false);
    showIntroCountdownRef.current = false;
    scheduleIntroCountdown();
  }

  function onIntroCountdownComplete() {
    handCountdownDoneRef.current = true;
    setShowIntroCountdown(false);
    showIntroCountdownRef.current = false;
    setIntroGateActive(false);
    introGateActiveRef.current = false;
    setHandStartCountdownPending(false);
    // Countdown often ends before the theme intro — if the intro already
    // finished (or never painted), make sure the stage clips are running.
    if (!introActiveRef.current) kickGameVideos();
  }

  useEffect(
    () => () => {
      clearGameResultTimer();
      clearIntroDockTimer();
      clearIntroFadeTimer();
    },
    [],
  );

  useEffect(() => {
    if (!gameMode) {
      setThemeIntrosReady(false);
      themeIntroByKeyRef.current = new Map();
      handStartIntroDoneRef.current = false;
      handCountdownDoneRef.current = false;
      setHandStartIntroResolved(true);
      return;
    }
    handStartIntroDoneRef.current = false;
    handCountdownDoneRef.current = false;
    setHandStartIntroResolved(false);
    setThemeIntrosReady(false);
    let cancelled = false;
    void fetchThemes()
      .then((themes) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const theme of themes) {
          const url = theme.intro?.trim();
          if (!url) continue;
          map.set(theme.id.toLowerCase(), url);
          map.set(theme.label.toLowerCase(), url);
        }
        themeIntroByKeyRef.current = map;
        setThemeIntrosReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        themeIntroByKeyRef.current = new Map();
        setThemeIntrosReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [gameMode]);

  useEffect(() => {
    if (
      !gameMode ||
      !gameSession ||
      !selectedCardId ||
      !themeIntrosReady ||
      !entryReady
    ) {
      return;
    }
    armHandStartIntro(selectedCardId, gameSession);
  }, [gameMode, gameSession, selectedCardId, themeIntrosReady, entryReady]);

  // Android/iOS block unmuted autoplay after refresh or async mount — kick
  // playback with a muted fallback so the intro still runs.
  // Game clips stay unloaded while introActive (Safari can't decode three
  // videos). On end we hold the last intro frame as a cover until the game
  // pair has a frame, then crossfade the overlay away.
  useEffect(() => {
    if (!introActive || !introVideoUrl) {
      setIntroMuted(true);
      return;
    }
    const video = introVideoElRef.current;
    if (!video) return;
    let cancelled = false;
    void playThemeIntro(video, soundEnabled).then((result) => {
      if (cancelled) return;
      if (!result.playing) {
        dismissThemeIntro({ immediate: true });
        return;
      }
      setIntroMuted(result.muted);
    });
    // Stuck/black intro (no ended event) — don't cover the stage forever.
    const safetyId = window.setTimeout(() => {
      if (!cancelled && introActiveRef.current) dismissThemeIntro();
    }, 20_000);
    return () => {
      cancelled = true;
      window.clearTimeout(safetyId);
    };
  }, [introActive, introVideoUrl, soundEnabled]);

  // Once the intro has ended and game clips have a frame, run the reveal.
  useEffect(() => {
    if (!introCover || introActive || introLeaving) return;
    if (!gameVideosReady) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      finishIntroCover();
      return;
    }

    setIntroLeaving(true);
    introLeavingRef.current = true;
    clearIntroFadeTimer();
    introFadeTimerRef.current = window.setTimeout(() => {
      introFadeTimerRef.current = null;
      finishIntroCover();
    }, INTRO_REVEAL_MS);
  }, [introCover, introActive, introLeaving, gameVideosReady]);

  useEffect(() => {
    if (introActive) return;
    kickGameVideos();
  }, [introActive]);

  // / showMesh changes (those are read live via refs).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: GarmentGLRenderer;
    try {
      renderer = new GarmentGLRenderer(canvas, CANVAS_WIDTH, CANVAS_HEIGHT);
      setGlError(null);
    } catch (error) {
      console.error("WebGL init failed", error);
      setGlError(
        error instanceof Error ? error.message : "WebGL2 not available",
      );
      return;
    }
    glRendererRef.current = renderer;

    let animationId = 0;
    const startedAt = performance.now();
    let lastFrameTime = performance.now();

    const render = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
      lastFrameTime = now;
      const time = (now - startedAt) / 1000;
      const bottomVideo = bottomVideoRef.current;
      const foregroundVideo = foregroundVideoRef.current;
      const trackedMeshNow = trackedMeshRef.current;
      // Sample the mesh on the FOREGROUND clock — the mesh was tracked from the
      // foreground (performer) clip, so this keeps scratch holes glued to the
      // body regardless of any residual drift between the two free-running
      // videos. The bottom video is just the revealed image underneath, where a
      // few frames of offset is invisible. Fall back to the bottom clock, then
      // wall-clock, before either video has a valid currentTime.
      const meshTime =
        foregroundVideo?.currentTime ?? bottomVideo?.currentTime ?? time;
      const trackedSample = trackedMeshNow
        ? sampleTrackedMesh(trackedMeshNow, meshTime)
        : null;
      trackedSampleRef.current = trackedSample;
      const videoTime = bottomVideo?.currentTime ?? time;

      // Subtle chest-follow camera: pan toward keeping the chest anchor at its
      // target framing point, clamped + smoothed.
      const camera = cameraRef.current;
      let targetCamX = 0;
      let targetCamY = 0;
      if (trackedSample) {
        const chest = sampleMeshUvToWorld(
          trackedSample,
          CHEST_ANCHOR_UV.x,
          CHEST_ANCHOR_UV.y,
        );
        const targetPx = CANVAS_WIDTH * CHEST_TARGET_UV.x;
        const targetPy = CANVAS_HEIGHT * CHEST_TARGET_UV.y;
        const shiftX = (targetPx - chest.x) * CHEST_FOLLOW_STRENGTH;
        const shiftY = (targetPy - chest.y) * CHEST_FOLLOW_STRENGTH;
        targetCamX = clampValue(
          shiftX / (CANVAS_WIDTH / 2),
          -CHEST_CAM_MAX,
          CHEST_CAM_MAX,
        );
        targetCamY = clampValue(
          -shiftY / (CANVAS_HEIGHT / 2),
          -CHEST_CAM_MAX,
          CHEST_CAM_MAX,
        );
      }
      camera.x += (targetCamX - camera.x) * CHEST_SMOOTH;
      camera.y += (targetCamY - camera.y) * CHEST_SMOOTH;

      const autoSettings = autoScratchRef.current;
      // Never auto-finish while body-symbol hunt is still in progress — otherwise a
      // persisted "enabled" flag (or premature toggle) wipes the dress before the player finds them all.
      const huntComplete =
        !useBodySymbolsRef.current ||
        revealedSymbolsRef.current >= SYMBOL_SLOT_COUNT;
      if (
        autoSettings.enabled &&
        huntComplete &&
        !isBodyScratchLocked() &&
        trackedSample &&
        gameResultPendingRef.current === null
      ) {
        const path = autoPathRef.current;
        if (path.length > 0 && autoPathIndexRef.current < path.length) {
          autoPathProgressRef.current += autoSettings.speed * dt;
          let scratched = 0;
          while (
            autoPathProgressRef.current >= 1 &&
            autoPathIndexRef.current < path.length &&
            scratched < AUTO_SCRATCH_MAX_PER_FRAME
          ) {
            autoPathProgressRef.current -= 1;
            const pt = path[autoPathIndexRef.current];
            const worldPos = sampleMeshUvToWorld(trackedSample, pt.x, pt.y);
            applyScratchAtUvRef.current(
              pt.x,
              pt.y,
              AUTO_SCRATCH_RADIUS,
              worldPos,
            );
            autoPathIndexRef.current += 1;
            scratched += 1;
          }
        }

        const pathDone =
          path.length === 0 || autoPathIndexRef.current >= path.length;
        const sampleCount = revealSamplesRef.current.length;
        const garmentComplete = isGarmentFullyRevealed(
          progressRef.current,
          revealedCountRef.current,
          sampleCount,
          true,
        );
        if (!garmentComplete && sampleCount > 0 && pathDone) {
          const samples = revealSamplesRef.current;
          const revealed = revealedRef.current;
          let filled = 0;
          for (
            let i = 0;
            i < samples.length && filled < AUTO_SCRATCH_FILL_BATCH;
            i += 1
          ) {
            if (revealed[i]) continue;
            const pt = samples[i];
            const worldPos = sampleMeshUvToWorld(trackedSample, pt.x, pt.y);
            applyScratchAtUvRef.current(
              pt.x,
              pt.y,
              AUTO_SCRATCH_RADIUS,
              worldPos,
            );
            filled += 1;
          }
        }
      }

      if (
        bottomVideo &&
        foregroundVideo &&
        bottomVideo.readyState >= 2 &&
        foregroundVideo.readyState >= 2
      ) {
        syncVideoTime(bottomVideo, foregroundVideo);
      }

      if (bottomVideo) {
        const now = performance.now();
        const nextDuration =
          bottomVideo.duration || uiStateRef.current.duration;
        const nextPaused = bottomVideo.paused;
        const shouldUpdateUi =
          now - uiStateRef.current.lastUpdatedAt >=
            UI_STATE_UPDATE_INTERVAL_MS ||
          nextPaused !== uiStateRef.current.isPaused ||
          Math.abs(videoTime - uiStateRef.current.currentTime) > 1;

        if (shouldUpdateUi) {
          uiStateRef.current = {
            currentTime: videoTime,
            duration: nextDuration,
            isPaused: nextPaused,
            lastUpdatedAt: now,
          };
          setCurrentTime(videoTime);
          setDuration(nextDuration);
          setIsPaused(nextPaused);
        }
      }

      const sampleCount = revealSamplesRef.current.length;
      const autoMode = autoScratchRef.current.enabled;
      const canClaim =
        !useBodySymbolsRef.current ||
        revealedSymbolsRef.current >= SYMBOL_SLOT_COUNT;
      const hideForeground =
        claimedRef.current ||
        (canClaim &&
          isGarmentFullyRevealed(
            progressRef.current,
            revealedCountRef.current,
            sampleCount,
            autoMode,
          ));
      if (hideForeground && !claimedRef.current) {
        claimedRef.current = true;
        setClaimed(true);
        tryResolveGameRef.current();
      }

      renderer.render(
        bottomVideo,
        foregroundVideo,
        trackedSample,
        showMeshRef.current,
        camera,
        hideForeground,
        chromaKeyRef.current,
      );

      // Skip body-marker transforms while the intro countdown covers the stage —
      // markers aren't visible under the overlay, and recomputing 12 DOM styles
      // every frame stacks on top of video decode + WebGL + the countdown Lottie.
      const bodyPoints = trackedMeshNow?.symbolPoints;
      const stage = stageRef.current;
      const canvas = canvasRef.current;
      if (
        !showIntroCountdownRef.current &&
        bodyPoints &&
        bodyPoints.length === SYMBOL_SLOT_COUNT &&
        trackedSample &&
        stage &&
        canvas
      ) {
        const canvasRect = canvas.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        for (let index = 0; index < SYMBOL_SLOT_COUNT; index += 1) {
          const marker = bodyMarkerRefs.current[index];
          if (!marker) continue;
          const revealed = revealedPointsRef.current[index];
          // Writing an unchanged style value still dirties style for that
          // element. Blindly re-assigning display + transform on all six markers
          // cost ~1440 style recalcs/second even with nothing revealed, so track
          // what was last written. Keyed on the element so a remount (new card,
          // new session symbols) re-applies instead of trusting a stale cache.
          let applied = bodyMarkerStyleRef.current[index];
          if (!applied || applied.el !== marker) {
            applied = { el: marker, transform: "", revealed: null };
            bodyMarkerStyleRef.current[index] = applied;
          }
          if (applied.revealed !== revealed) {
            marker.style.display = revealed ? "flex" : "none";
            marker.classList.toggle("is-revealed", revealed);
            applied.revealed = revealed;
          }
          // A hidden marker has no box — positioning it is invisible work.
          if (!revealed) continue;
          const world = sampleMeshUvToWorld(
            trackedSample,
            bodyPoints[index].u,
            bodyPoints[index].v,
          );
          const stagePos = worldPointToStageWithRects(
            world,
            canvasRect,
            stageRect,
            camera,
          );
          const transform = `translate(${stagePos.x}px, ${stagePos.y}px)`;
          if (applied.transform !== transform) {
            marker.style.transform = transform;
            applied.transform = transform;
          }
        }
      }

      animationId = requestAnimationFrame(render);
    };

    animationId = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(animationId);
      // Dispose only when the stage goes away — never mid-card.
      glRendererRef.current?.dispose();
      glRendererRef.current = null;
      releaseMediaElement(bottomVideoRef.current);
      releaseMediaElement(foregroundVideoRef.current);
    };
    // Re-init when the player stage mounts after the girl picker (canvas is absent until then).
  }, [showModelPicker]);

  useEffect(() => {
    let isCancelled = false;
    Promise.all([loadCards(), fetchModels()])
      .then(([loaded, loadedModels]) => {
        if (isCancelled) return;
        setCards(loaded);
        setModels(loadedModels);
        setCardsReady(true);
        const params = new URLSearchParams(window.location.search);
        const fromUrl = params.get("card")?.trim() || "";
        let modelFromUrl = params.get("model")?.trim() || "";
        if (fromUrl) {
          const cardModel = loaded.find((entry) => entry.id === fromUrl)?.model_id?.trim() || "";
          // Card wins over a stale ?model= so Shine never opens Brazilian.
          if (cardModel) modelFromUrl = cardModel;
        }

        if (isGameModeUrl()) {
          const session = loadGameSession();
          if (session?.phase === "motion") {
            setGameSession(session);
            setCompletedCardIds(session.completedMotionIds);
            completedCardIdsRef.current = session.completedMotionIds;
            const ordered = playlistCardsForGameSession(loaded, session);
            const modelId =
              modelFromUrl ||
              session.modelId ||
              ordered[0]?.model_id?.trim() ||
              "";
            setActiveModelId(modelId);
            if (ordered.length === 0) {
              setSelectedCardId("");
              return;
            }
            const remaining = ordered.filter(
              (entry) => !session.completedMotionIds.includes(entry.id),
            );
            const startId =
              fromUrl && remaining.some((entry) => entry.id === fromUrl)
                ? fromUrl
                : remaining[0]?.id ?? ordered[0]!.id;
            setSelectedCardId(startId);
            return;
          }
        }

        if (!modelFromUrl) {
          setActiveModelId("");
          setSelectedCardId("");
          return;
        }
        const ordered = playlistCardsForModel(loaded, modelFromUrl);
        setActiveModelId(modelFromUrl);
        if (ordered.length === 0) {
          setSelectedCardId("");
          return;
        }
        const startId =
          fromUrl && ordered.some((entry) => entry.id === fromUrl)
            ? fromUrl
            : ordered[0]!.id;
        setSelectedCardId(startId);
      })
      .catch(() => undefined);
    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !cardsReady) return;
    const url = new URL(window.location.href);
    if (activeModelId) url.searchParams.set("model", activeModelId);
    else url.searchParams.delete("model");
    if (selectedCardId && modelCards.some((entry) => entry.id === selectedCardId)) {
      url.searchParams.set("card", selectedCardId);
    } else {
      url.searchParams.delete("card");
    }
    if (gameMode) url.searchParams.set("game", "1");
    else url.searchParams.delete("game");
    url.searchParams.delete("playlist");
    const next = `${url.pathname}${url.searchParams.toString() ? `?${url.searchParams}` : ""}`;
    window.history.replaceState(null, "", next);
  }, [activeModelId, cardsReady, gameMode, modelCards, selectedCardId]);

  useEffect(() => {
    if (gameMode) return;
    setCompletedCardIds([]);
    completedCardIdsRef.current = [];
  }, [activeModelId, gameMode]);

  useEffect(() => {
    if (!cardsReady) return;
    if (!gameMode && !activeModelId) return;
    if (modelCards.length === 0) {
      if (selectedCardId) setSelectedCardId("");
      return;
    }
    const belongs =
      Boolean(selectedCardId) &&
      modelCards.some((entry) => entry.id === selectedCardId) &&
      !completedCardIds.includes(selectedCardId);
    if (belongs) return;
    setSelectedCardId(remainingCards[0]?.id ?? modelCards[0]?.id ?? "");
  }, [
    activeModelId,
    cardsReady,
    completedCardIds,
    gameMode,
    modelCards,
    remainingCards,
    selectedCardId,
  ]);

  useEffect(() => {
    let isCancelled = false;

    fetch(`${MESH_INDEX_SRC}?v=${meshReloadToken}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (isCancelled || !data) return;
        const files = parseMeshIndex(data);
        setMeshFiles(files);
        setSelectedMeshFile(
          (currentFile) =>
            currentFile ||
            (files.includes(DEFAULT_MESH_FILE)
              ? DEFAULT_MESH_FILE
              : files[0]) ||
            "",
        );
      })
      .catch(() => undefined);

    return () => {
      isCancelled = true;
    };
  }, [meshReloadToken]);

  useEffect(() => {
    if (!selectedMeshFile) {
      setTrackedMesh(null);
      return;
    }

    let isCancelled = false;

    fetch(
      `${MESH_DIRECTORY_SRC}/${encodeURIComponent(selectedMeshFile)}?v=${meshReloadToken}`,
      { cache: "no-store" },
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (isCancelled || !data) return;
        setTrackedMesh(parseTrackedMesh(data));
      })
      .catch(() => undefined);

    return () => {
      isCancelled = true;
    };
  }, [meshReloadToken, selectedMeshFile]);

  // Switching cards: load that card's mesh and clear scratches/progress so holes
  // from the previous clip don't carry over onto the new fabric.
  useEffect(() => {
    if (!card) {
      setSelectedMeshFile("");
      return;
    }
    setSelectedMeshFile(card.mesh);
    marksRef.current = [];
    glRendererRef.current?.clearScratch();
    glRendererRef.current?.clearFlakes();
    glRendererRef.current?.resetForeground();
    revealSamplesRef.current = [];
    revealedRef.current = [];
    revealedCountRef.current = 0;
    progressRef.current = 0;
    claimedRef.current = false;
    resetGameOutcome();
    revealedSymbolsRef.current = 0;
    revealedPointsRef.current = Array.from(
      { length: SYMBOL_SLOT_COUNT },
      () => false,
    );
    autoPathIndexRef.current = 0;
    autoPathProgressRef.current = 0;
    resetMatchRound();
    setProgress(0);
    setClaimed(false);
    setRevealedSymbols(0);
    setBodyRevealed(Array.from({ length: SYMBOL_SLOT_COUNT }, () => false));
    setFlyingCoins([]);
    setGameResult(null);
    setAutoScratch((current) => ({ ...current, enabled: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCardId, card?.id, card?.mesh]);

  // Rebuild the reveal sample grid whenever the mesh changes, recomputing which
  // samples are already revealed from the current marks (usually empty after a
  // card switch / reset). Keeps the percentage consistent across mesh reloads.
  useEffect(() => {
    const samples = buildRevealSamples(trackedMesh);
    revealSamplesRef.current = samples;
    const revealed = samples.map((p) =>
      marksRef.current.some(
        (m) => Math.hypot((m.u - p.x) / m.radius, (m.v - p.y) / m.radius) <= 1,
      ),
    );
    revealedRef.current = revealed;
    revealedCountRef.current = revealed.reduce((n, r) => n + (r ? 1 : 0), 0);
    const next = samples.length ? revealedCountRef.current / samples.length : 0;
    progressRef.current = next;
    setProgress(next);
    const hasBodySymbols = trackedMesh?.symbolPoints?.length === SYMBOL_SLOT_COUNT;
    const nextSymbolCount = hasBodySymbols
      ? revealedPointsRef.current.filter(Boolean).length
      : revealedSymbolCount(next, autoScratchRef.current.enabled);
    revealedSymbolsRef.current = nextSymbolCount;
    setRevealedSymbols(nextSymbolCount);
    if (hasBodySymbols && nextSymbolCount < SYMBOL_SLOT_COUNT) {
      setAutoScratch((current) =>
        current.enabled ? { ...current, enabled: false } : current,
      );
    }
    const nextClaimed = hasBodySymbols
      ? false
      : isGarmentFullyRevealed(
          next,
          revealedCountRef.current,
          samples.length,
          autoScratchRef.current.enabled,
        );
    claimedRef.current = nextClaimed;
    setClaimed(nextClaimed);
    if (nextClaimed) tryResolveGameRef.current();
  }, [trackedMesh]);

  useEffect(() => {
    autoPathRef.current = buildAutoScratchPath(trackedMesh);
    autoPathIndexRef.current = 0;
    autoPathProgressRef.current = 0;
  }, [trackedMesh]);

  useEffect(() => {
    const bottomVideo = bottomVideoRef.current;
    const foregroundVideo = foregroundVideoRef.current;
    if (!bottomVideo || !foregroundVideo || !card) return;

    // Theme intro + two game clips = three decoders. Safari/iOS often starves
    // the game pair and leaves a black WebGL stage after 3-2-1. While the
    // intro is up, fully unload the card clips so only the intro decodes.
    if (introActiveRef.current) {
      releaseMediaElement(bottomVideo);
      releaseMediaElement(foregroundVideo);
      glRendererRef.current?.resetForeground();
      setGameVideosReady(false);
      return;
    }

    let cancelled = false;
    uiStateRef.current = { ...uiStateRef.current, isPaused: false };
    setIsPaused(false);
    setGameVideosReady(false);

    const kickPlayback = () => {
      if (cancelled) return;
      // Wait until BOTH videos have at least HAVE_CURRENT_DATA so their first
      // decoded frame is ready. Firing play() on one while the other is still
      // buffering creates a startup offset that the soft-seek must then chase.
      if (bottomVideo.readyState < 2 || foregroundVideo.readyState < 2) return;
      if (bottomVideo.videoWidth < 2 || foregroundVideo.videoWidth < 2) return;
      const nextDuration = bottomVideo.duration || uiStateRef.current.duration;
      uiStateRef.current = {
        ...uiStateRef.current,
        duration: nextDuration,
        isPaused: false,
      };
      setDuration(nextDuration);
      void Promise.all([
        bottomVideo.play(),
        foregroundVideo.play(),
      ])
        .then(() => {
          if (!cancelled) setGameVideosReady(true);
        })
        .catch(() => undefined);
    };

    // Reuse the same two <video> elements and swap src (no React key remount).
    // Safari releases the previous decoder only when we unload before load.
    void (async () => {
      try {
        await Promise.all([
          loadVideoSrc(bottomVideo, card.bottom),
          loadVideoSrc(foregroundVideo, card.foreground),
        ]);
      } catch {
        if (!cancelled) setGameVideosReady(true);
        return;
      }
      if (cancelled) return;
      bottomVideo.addEventListener("canplay", kickPlayback);
      foregroundVideo.addEventListener("canplay", kickPlayback);
      kickPlayback();
    })();

    // Don't leave game-mode locked on the intro cover forever if decode stalls.
    const readySafetyId = window.setTimeout(() => {
      if (!cancelled) setGameVideosReady(true);
    }, 8_000);

    return () => {
      cancelled = true;
      window.clearTimeout(readySafetyId);
      bottomVideo.removeEventListener("canplay", kickPlayback);
      foregroundVideo.removeEventListener("canplay", kickPlayback);
      try {
        bottomVideo.pause();
        foregroundVideo.pause();
      } catch {
        // ignore
      }
    };
  }, [card?.id, card?.bottom, card?.foreground, introActive]);

  // Mobile browsers (notably iOS Safari) will suspend a second, simultaneously
  // playing <video> after a few seconds to save power — which here drops the
  // foreground below readyState 2 and leaves only the bottom video on screen.
  // This watchdog nudges both clips back to playing whenever they get paused
  // out from under us (and on tab re-focus), as long as the user hasn't paused.
  useEffect(() => {
    const keepPlaying = () => {
      if (uiStateRef.current.isPaused) return;
      // Don't steal the decoder from the theme intro (causes black stage after
      // 3-2-1 on Safari / Android when three <video>s fight).
      if (introActiveRef.current) return;
      const bottomVideo = bottomVideoRef.current;
      const foregroundVideo = foregroundVideoRef.current;
      if (bottomVideo?.paused) void bottomVideo.play().catch(() => undefined);
      if (foregroundVideo?.paused)
        void foregroundVideo.play().catch(() => undefined);
    };

    const intervalId = window.setInterval(keepPlaying, 1000);
    document.addEventListener("visibilitychange", keepPlaying);
    window.addEventListener("focus", keepPlaying);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", keepPlaying);
      window.removeEventListener("focus", keepPlaying);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SCRATCH_ZOOM_STORAGE_KEY, JSON.stringify(scratchZoom));
  }, [scratchZoom]);

  useEffect(() => {
    localStorage.setItem(AUTO_SCRATCH_STORAGE_KEY, JSON.stringify(autoScratch));
  }, [autoScratch]);

  useEffect(() => {
    localStorage.setItem(CURSOR_FX_STORAGE_KEY, JSON.stringify(cursorFx));
  }, [cursorFx]);

  useEffect(() => {
    if (!cursorFx.fairyDust) return;
    const id = window.setInterval(() => {
      const active = fairyDustPerf.active;
      const peak = fairyDustPerf.peak;
      const avgFrameMs = Math.round(fairyDustPerf.avgFrameMs * 100) / 100;
      setCursorFxPerf((current) =>
        current.active === active &&
        current.peak === peak &&
        current.avgFrameMs === avgFrameMs
          ? current
          : { active, peak, avgFrameMs },
      );
    }, 250);
    return () => window.clearInterval(id);
  }, [cursorFx.fairyDust]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await Promise.all(
          CURSOR_FX_LOTTIE_PRESETS.map(async (preset, i) => {
            const result = await loadLottieUrlSource(preset.url, preset.name);
            return {
              id: `cursor-fx-lottie-${i}`,
              kind: "lottie" as const,
              name: result.name,
              source: result.source,
            };
          }),
        );
        if (!cancelled) setCursorFxParticleTypes(loaded);
      } catch {
        if (!cancelled) setCursorFxParticleTypes([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(
      SOUND_STORAGE_KEY,
      JSON.stringify({ enabled: soundEnabled }),
    );
  }, [soundEnabled]);

  function syncScratchZoomTransition(
    canvas: HTMLCanvasElement,
    settings = scratchZoomRef.current,
  ) {
    canvas.style.setProperty(
      "--scratch-zoom-duration",
      `${settings.durationMs}ms`,
    );
    canvas.style.setProperty(
      "--scratch-zoom-easing",
      scratchZoomEasing(settings.bounce),
    );
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) syncScratchZoomTransition(canvas);
  }, [scratchZoom]);

  function updateScratchZoom(patch: Partial<ScratchZoomSettings>) {
    setScratchZoom((current) => ({ ...current, ...patch }));
  }

  function updateAutoScratch(patch: Partial<AutoScratchSettings>) {
    if (
      patch.enabled &&
      (isBodyScratchLocked() ||
        (useBodySymbolsRef.current &&
          revealedSymbolsRef.current < SYMBOL_SLOT_COUNT))
    ) {
      return;
    }
    if (patch.enabled && soundEnabledRef.current)
      ensureSymbolAudio(symbolAudioRef.current);
    setAutoScratch((current) => ({ ...current, ...patch }));
  }

  function updateCursorFx(patch: Partial<CursorFxSettings>) {
    if (
      patch.particleCount !== undefined ||
      patch.fadeSpeed !== undefined ||
      patch.particleSize !== undefined ||
      patch.gravity !== undefined
    ) {
      resetFairyDustPerfPeak();
    }
    setCursorFx((current) => ({ ...current, ...patch }));
  }

  function beginFinishAutoScratch() {
    autoPathIndexRef.current = 0;
    autoPathProgressRef.current = 0;
    if (soundEnabledRef.current) ensureSymbolAudio(symbolAudioRef.current);
    // Sync the ref immediately — setState alone would leave this frame's auto path off.
    autoScratchRef.current = { ...autoScratchRef.current, enabled: true };
    setAutoScratch((current) =>
      current.enabled ? current : { ...current, enabled: true },
    );
  }

  // Hold top-bar until theme intro playback ends and card clips have a frame.
  // While the intro cover is dissolving (`introLeaving`), unlock early so the
  // scratch-to-start bar can spring in over the live stage — that's the beat.
  const matchStartUnlocked =
    !gameMode ||
    (handStartIntroResolved &&
      !introActive &&
      (!introCover || introLeaving) &&
      !handStartCountdownPending &&
      gameVideosReady);
  const symbolsHuntComplete =
    useBodySymbols && revealedSymbols >= SYMBOL_SLOT_COUNT;
  const topMatchedSlots = useMemo(
    () => matchedTopSlots(topSymbols, sessionSymbols, bodyRevealed),
    [topSymbols, sessionSymbols, bodyRevealed],
  );
  const stageCoachPhase = resolveStageCoachPhase({
    active:
      useBodySymbols &&
      matchStartUnlocked &&
      !introGateActive &&
      !introActive &&
      !introCover &&
      !gameResult,
    topBarPhase,
    found: revealedSymbols,
    total: SYMBOL_SLOT_COUNT,
  });
  const autoScratchLocked =
    !matchStartUnlocked ||
    introActive ||
    introCover ||
    (useBodySymbols &&
      (!symbolsHuntComplete || topBarPhase === "center" || introGateActive));
  // Sparkles only during the hunt play window (after countdown, before all
  // symbols found); cards without body symbols have no countdown gate.
  const cursorFxPlayWindow =
    matchStartUnlocked &&
    !introActive &&
    !introCover &&
    (!useBodySymbols ||
      (topBarPhase !== "center" && !introGateActive && !symbolsHuntComplete));
  // Also require an active scratch stroke so idle cursor movement is quiet.
  const cursorFxSpawnActive = cursorFxPlayWindow && isScratching;

  // Drop a persisted/stale auto-scratch enable while the hunt is still locked.
  useEffect(() => {
    if (!autoScratchLocked) return;
    if (!autoScratch.enabled) return;
    autoScratchRef.current = { ...autoScratchRef.current, enabled: false };
    setAutoScratch((current) =>
      current.enabled ? { ...current, enabled: false } : current,
    );
  }, [autoScratchLocked, autoScratch.enabled]);

  function updateSoundEnabled(enabled: boolean) {
    if (enabled) {
      ensureSymbolAudio(symbolAudioRef.current);
      unlockCountdownSound();
    }
    setSoundEnabled(enabled);
  }

  function isPhoneLayout() {
    return (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 700px)").matches
    );
  }

  function resetScratch() {
    marksRef.current = [];
    lastScratchWorldRef.current = null;
    glRendererRef.current?.clearScratch();
    glRendererRef.current?.clearFlakes();
    revealedRef.current = new Array(revealSamplesRef.current.length).fill(
      false,
    );
    revealedCountRef.current = 0;
    progressRef.current = 0;
    claimedRef.current = false;
    resetGameOutcome();
    revealedSymbolsRef.current = 0;
    revealedPointsRef.current = Array.from(
      { length: SYMBOL_SLOT_COUNT },
      () => false,
    );
    autoPathIndexRef.current = 0;
    autoPathProgressRef.current = 0;
    resetMatchRound();
    setProgress(0);
    setClaimed(false);
    setRevealedSymbols(0);
    setFlyingCoins([]);
    setAutoScratch((current) => ({ ...current, enabled: false }));
  }
  resetScratchRef.current = resetScratch;

  function finishCardTransition(transition: CardTransitionState) {
    cardTransitionActiveRef.current = false;
    setCardTransition(null);

    if (gameMode) {
      const updated = recordMotionCardResult(
        transition.finishedId,
        transition.prize,
      );
      if (updated) setGameSession(updated);
    }

    const nextCompleted = [
      ...completedCardIdsRef.current,
      transition.finishedId,
    ];
    completedCardIdsRef.current = nextCompleted;
    setCompletedCardIds(nextCompleted);
    resetGameOutcome();
    setClaimed(false);
    claimedRef.current = false;
    setSelectedCardId(transition.nextCardId);
  }

  function advanceAfterScratch() {
    const finishedId = selectedCardId;
    if (!finishedId || completedCardIdsRef.current.includes(finishedId)) return;
    if (cardTransitionActiveRef.current) return;

    const match = matchOutcomeRef.current ?? matchOutcome;
    // Pending is set by tryResolveGame and not wiped by the render-time
    // gameResultRef sync (overlay is skipped, so gameResult stays null).
    const result =
      gameResultPendingRef.current ?? gameResultRef.current ?? gameResult;
    let prize = 0;
    if (match) {
      prize = match.prize;
    } else if (result === "win") {
      prize = 1;
    }

    const nextCompleted = [...completedCardIdsRef.current, finishedId];
    const nextCard = modelCards.find(
      (entry) => entry.id !== finishedId && !nextCompleted.includes(entry.id),
    );
    const finishedCard =
      modelCards.find((entry) => entry.id === finishedId) ?? card;

    if (
      nextCard &&
      finishedCard?.bottom &&
      nextCard.bottom
    ) {
      const { id: templateId, nextIndex } = nextTemplateId(
        transitionTemplateIndexRef.current,
      );
      transitionTemplateIndexRef.current = nextIndex;
      cardTransitionActiveRef.current = true;
      setCardTransition({
        fromBottom: finishedCard.bottom,
        toBottom: nextCard.bottom,
        templateId,
        nextCardId: nextCard.id,
        finishedId,
        prize,
      });
      return;
    }

    if (gameMode) {
      const updated = recordMotionCardResult(finishedId, prize);
      if (updated) setGameSession(updated);
    }

    completedCardIdsRef.current = nextCompleted;
    setCompletedCardIds(nextCompleted);
    resetGameOutcome();
    setClaimed(false);
    claimedRef.current = false;
    if (nextCard) {
      setSelectedCardId(nextCard.id);
      return;
    }
    setSelectedCardId("");
    if (gameMode) {
      void finishMotionHand().then((finished) => {
        if (finished) setGameSession(finished);
        navigateTo("/game");
      });
    }
  }
  advanceAfterScratchRef.current = advanceAfterScratch;

  function tryResolveGame() {
    if (gameResultPendingRef.current !== null) return;
    const autoMode = autoScratchRef.current.enabled;
    const sampleCount = revealSamplesRef.current.length;
    if (
      !isGarmentFullyRevealed(
        progressRef.current,
        revealedCountRef.current,
        sampleCount,
        autoMode,
      )
    ) {
      return;
    }
    // Symbol hunt cards wait for all symbols; plain scratch cards advance on full reveal.
    if (
      useBodySymbolsRef.current &&
      revealedSymbolsRef.current < SYMBOL_SLOT_COUNT
    ) {
      return;
    }
    let outcome: GameResult;
    let match: MatchGameOutcome | null = null;
    if (useBodySymbolsRef.current) {
      match = resolveMatchGame(
        topSymbolsRef.current,
        sessionSymbolsRef.current,
      );
      outcome = match.result;
    } else {
      // Legacy path (no body anchors): any type appearing ≥3 times wins.
      const LEGACY_WIN_MATCH_COUNT = 3;
      const counts = new Array(SYMBOL_TYPE_COUNT).fill(0);
      outcome = "lose";
      for (const id of sessionSymbolsRef.current) {
        counts[id] += 1;
        if (counts[id] >= LEGACY_WIN_MATCH_COUNT) {
          outcome = "win";
          break;
        }
      }
    }
    gameResultPendingRef.current = outcome;
    matchOutcomeRef.current = match;
    gameResultRef.current = outcome;
    setMatchOutcome(match);
    setAutoScratch((current) =>
      current.enabled ? { ...current, enabled: false } : current,
    );
    // Play the outcome sting, then skip the win/lose overlay and go next.
    const advanceDelayMs = playGameOutcomeSound(
      symbolAudioRef.current,
      outcome,
      soundEnabledRef.current,
    );
    clearGameResultTimer();
    gameResultTimerRef.current = window.setTimeout(() => {
      gameResultTimerRef.current = null;
      advanceAfterScratchRef.current();
    }, advanceDelayMs);
  }
  tryResolveGameRef.current = tryResolveGame;

  // On phones the canvas is centered with a translate that fills the screen, so
  // the magnify scale has to be composed on top of it rather than replacing it.
  const canvasBaseTransform = () =>
    isPhoneLayout() ? "translate(-50%, -50%) " : "";

  function applyScratchZoom(point: Vec2) {
    const settings = scratchZoomRef.current;
    if (!settings.enabled) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    syncScratchZoomTransition(canvas, settings);
    canvas.style.transformOrigin = `${(point.x / CANVAS_WIDTH) * 100}% ${(point.y / CANVAS_HEIGHT) * 100}%`;
    canvas.style.transform = `${canvasBaseTransform()}scale(${settings.scale})`;
  }

  function clearScratchZoom() {
    const settings = scratchZoomRef.current;
    if (!settings.enabled) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    syncScratchZoomTransition(canvas, settings);
    canvas.style.transform = `${canvasBaseTransform()}scale(1)`;
  }

  function getCanvasPoint(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    // Screen -> presented canvas pixels.
    const presentX = ((clientX - rect.left) / rect.width) * CANVAS_WIDTH;
    const presentY = ((clientY - rect.top) / rect.height) * CANVAS_HEIGHT;
    // Invert the chest-follow camera (overscan + clip-space pan) so a tap maps to
    // the reference-frame fabric coordinate the mesh/holes live in.
    const cam = cameraRef.current;
    const refClipX = ((presentX / CANVAS_WIDTH) * 2 - 1 - cam.x) / PRESENT_ZOOM;
    const refClipY =
      (1 - (presentY / CANVAS_HEIGHT) * 2 - cam.y) / PRESENT_ZOOM;
    return {
      x: ((refClipX + 1) / 2) * CANVAS_WIDTH,
      y: ((1 - refClipY) / 2) * CANVAS_HEIGHT,
    };
  }

  // Fly a coin from the scratch origin up to each newly revealed symbol slot.
  // Auto scratch starts the flight from the stage center; manual scratch starts
  // it from the user's finger. Coordinates are resolved against the live stage
  // and symbol-bar layout so the coins land on the correct slots.
  // Convert a canvas reference-frame point (the space scratches live in) to a
  // stage-relative pixel. Applies the same chest-follow camera + present-zoom
  // forward transform the GL renderer uses, then maps presented canvas pixels
  // through the live canvas rect so it lands where the point visually appears.
  function worldToStagePoint(worldPoint: Vec2): Vec2 | null {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return null;
    return worldPointToStage(worldPoint, canvas, stage, cameraRef.current);
  }

  function spawnSymbolCoins(
    prevCount: number,
    nextCount: number,
    worldPoint?: Vec2 | null,
  ) {
    const stage = stageRef.current;
    if (!stage || nextCount <= prevCount) return;
    const stageRect = stage.getBoundingClientRect();

    const autoMode = autoScratchRef.current.enabled;
    let originX: number;
    let originY: number;
    const autoOrigin =
      autoMode && worldPoint ? worldToStagePoint(worldPoint) : null;
    if (autoOrigin) {
      originX = autoOrigin.x;
      originY = autoOrigin.y;
    } else if (autoMode || !lastPointerClientRef.current) {
      originX = stageRect.width / 2;
      originY = stageRect.height / 2;
    } else {
      originX = lastPointerClientRef.current.x - stageRect.left;
      originY = lastPointerClientRef.current.y - stageRect.top;
    }

    const symbols = sessionSymbolsRef.current;
    const coins: FlyingCoin[] = [];
    for (let slot = prevCount; slot < nextCount; slot += 1) {
      const slotEl = symbolSlotRefs.current[slot];
      if (!slotEl) continue;
      const slotRect = slotEl.getBoundingClientRect();
      const toX = slotRect.left - stageRect.left + slotRect.width / 2;
      const toY = slotRect.top - stageRect.top + slotRect.height / 2;
      // Lift the midpoint above the straight line for a gentle arc toward the bar.
      const midX = (originX + toX) / 2;
      const midY = Math.min(originY, toY) - 56;
      coins.push({
        id: (coinIdRef.current += 1),
        typeId: symbols[slot] ?? 0,
        fromX: originX,
        fromY: originY,
        toX,
        toY,
        midX,
        midY,
        delayMs: (slot - prevCount) * COIN_FLIGHT_STAGGER_MS,
      });
    }
    if (coins.length > 0) {
      setFlyingCoins((current) => [...current, ...coins]);
    }
  }

  function removeFlyingCoin(id: number) {
    setFlyingCoins((current) => current.filter((coin) => coin.id !== id));
  }

  function applyScratchAtUv(
    u: number,
    v: number,
    radius: number,
    worldPoint?: Vec2 | null,
    finalize = true,
  ) {
    if (gameResultPendingRef.current !== null) return;
    if (isBodyScratchLocked()) {
      return;
    }

    marksRef.current = [...marksRef.current, { u, v, radius }].slice(-180);
    glRendererRef.current?.paintScratch(u, v, radius);

    const samples = revealSamplesRef.current;
    const revealed = revealedRef.current;
    for (let i = 0; i < samples.length; i += 1) {
      if (revealed[i]) continue;
      const distance = Math.hypot(
        (u - samples[i].x) / radius,
        (v - samples[i].y) / radius,
      );
      if (distance <= 1) {
        revealed[i] = true;
        revealedCountRef.current += 1;
      }
    }
    if (!finalize) return;

    if (autoScratchRef.current.flakes && worldPoint) {
      glRendererRef.current?.spawnFlakes(worldPoint.x, worldPoint.y);
    }

    const nextProgress = samples.length
      ? revealedCountRef.current / samples.length
      : 0;
    progressRef.current = nextProgress;
    setProgress(nextProgress);
    const autoMode = autoScratchRef.current.enabled;
    if (useBodySymbolsRef.current && trackedMeshRef.current?.symbolPoints) {
      const bodyPoints = trackedMeshRef.current.symbolPoints;
      let changed = false;
      const renderer = glRendererRef.current;
      for (let index = 0; index < bodyPoints.length; index += 1) {
        if (revealedPointsRef.current[index]) continue;
        const distance = Math.hypot(
          u - bodyPoints[index].u,
          v - bodyPoints[index].v,
        );
        if (distance > SYMBOL_REVEAL_UV_RADIUS) continue;
        // Must have actually punched the clothing at this UV — proximity alone
        // used to pop icons on top of still-blue foil.
        if (
          !renderer ||
          renderer.scratchAmountAt(bodyPoints[index].u, bodyPoints[index].v) <
            SYMBOL_SCRATCH_REVEAL_THRESHOLD
        ) {
          continue;
        }
        revealedPointsRef.current[index] = true;
        changed = true;
      }
      if (changed) {
        const nextSymbolCount = revealedPointsRef.current.filter(Boolean).length;
        const prevCount = revealedSymbolsRef.current;
        revealedSymbolsRef.current = nextSymbolCount;
        setRevealedSymbols(nextSymbolCount);
        setBodyRevealed(revealedPointsRef.current.slice());
        playNewSymbolNotes(
          symbolAudioRef.current,
          prevCount,
          nextSymbolCount,
          soundEnabledRef.current,
        );
        if (nextSymbolCount >= SYMBOL_SLOT_COUNT) {
          beginFinishAutoScratch();
        }
      }
    } else {
      const nextSymbolCount = revealedSymbolCount(nextProgress, autoMode);
      if (nextSymbolCount !== revealedSymbolsRef.current) {
        const prevCount = revealedSymbolsRef.current;
        revealedSymbolsRef.current = nextSymbolCount;
        setRevealedSymbols(nextSymbolCount);
        playNewSymbolNotes(
          symbolAudioRef.current,
          prevCount,
          nextSymbolCount,
          soundEnabledRef.current,
        );
        spawnSymbolCoins(prevCount, nextSymbolCount, worldPoint);
      }
    }
    const canClaimGarment =
      !useBodySymbolsRef.current ||
      revealedSymbolsRef.current >= SYMBOL_SLOT_COUNT;
    if (
      canClaimGarment &&
      isGarmentFullyRevealed(
        nextProgress,
        revealedCountRef.current,
        samples.length,
        autoMode,
      )
    ) {
      claimedRef.current = true;
      setClaimed(true);
    }
    tryResolveGame();
  }
  applyScratchAtUvRef.current = applyScratchAtUv;

  function addScratch(clientX: number, clientY: number) {
    if (isBodyScratchLocked()) {
      return;
    }
    const point = getCanvasPoint(clientX, clientY);
    if (!point) return;

    const trackedSample = trackedSampleRef.current;
    if (!trackedSample) return;

    const last = lastScratchWorldRef.current;
    const strokePoints =
      last !== null
        ? densifyStrokeSegment(
            last,
            point,
            MANUAL_SCRATCH_PATH_STEP,
            MANUAL_SCRATCH_MAX_POINTS,
          )
        : [point];

    let applied = false;
    for (let i = 0; i < strokePoints.length; i += 1) {
      const strokePoint = strokePoints[i];
      const uv = trackedWorldToUv(trackedSample, strokePoint);
      if (!uv) continue;
      const isLast = i === strokePoints.length - 1;
      applyScratchAtUv(
        uv.x,
        uv.y,
        SCRATCH_RADIUS,
        isLast ? point : null,
        isLast,
      );
      applied = true;
    }

    if (applied) lastScratchWorldRef.current = point;
  }

  function setVideoTime(time: number) {
    const bottomVideo = bottomVideoRef.current;
    const foregroundVideo = foregroundVideoRef.current;
    const nextTime = Math.max(0, Math.min(duration || 0, time));

    if (bottomVideo) bottomVideo.currentTime = nextTime;
    if (
      foregroundVideo &&
      Number.isFinite(foregroundVideo.duration) &&
      foregroundVideo.duration > 0 &&
      bottomVideo
    ) {
      foregroundVideo.currentTime = foregroundTimeFromBottom(
        bottomVideo,
        foregroundVideo,
      );
    }
    uiStateRef.current = {
      ...uiStateRef.current,
      currentTime: nextTime,
      lastUpdatedAt: performance.now(),
    };
    setCurrentTime(nextTime);
  }

  function togglePlayback() {
    const bottomVideo = bottomVideoRef.current;
    const foregroundVideo = foregroundVideoRef.current;
    if (!bottomVideo || !foregroundVideo) return;

    if (bottomVideo.paused) {
      void bottomVideo.play();
      void foregroundVideo.play();
      uiStateRef.current = { ...uiStateRef.current, isPaused: false };
      setIsPaused(false);
    } else {
      bottomVideo.pause();
      foregroundVideo.pause();
      uiStateRef.current = { ...uiStateRef.current, isPaused: true };
      setIsPaused(true);
    }
  }

  const scratchZoomControls = (
    <fieldset className="scratch-zoom-settings">
      <legend>Scratch zoom</legend>
      <label className="checkbox-label">
        <input
          checked={scratchZoom.enabled}
          onChange={(event) =>
            updateScratchZoom({ enabled: event.currentTarget.checked })
          }
          type="checkbox"
        />
        Enable zoom while scratching
      </label>
      <label>
        Range ({scratchZoom.scale.toFixed(2)}×)
        <input
          disabled={!scratchZoom.enabled}
          max={2}
          min={1}
          onChange={(event) =>
            updateScratchZoom({ scale: Number(event.currentTarget.value) })
          }
          step={0.05}
          type="range"
          value={scratchZoom.scale}
        />
      </label>
      <label>
        Animation ({scratchZoom.durationMs} ms)
        <input
          disabled={!scratchZoom.enabled}
          max={800}
          min={50}
          onChange={(event) =>
            updateScratchZoom({ durationMs: Number(event.currentTarget.value) })
          }
          step={10}
          type="range"
          value={scratchZoom.durationMs}
        />
      </label>
      <label className="checkbox-label">
        <input
          checked={scratchZoom.bounce}
          disabled={!scratchZoom.enabled}
          onChange={(event) =>
            updateScratchZoom({ bounce: event.currentTarget.checked })
          }
          type="checkbox"
        />
        Bounce easing
      </label>
    </fieldset>
  );

  const soundControls = (
    <fieldset className="scratch-zoom-settings">
      <legend>Sound</legend>
      <label className="checkbox-label">
        <input
          checked={soundEnabled}
          onChange={(event) => updateSoundEnabled(event.currentTarget.checked)}
          type="checkbox"
        />
        Game sounds
      </label>
    </fieldset>
  );

  const autoScratchControls = (
    <fieldset className="scratch-zoom-settings">
      <legend>Auto scratch</legend>
      {autoScratchLocked ? (
        <p className="auto-scratch-hint">
          {introActive || introCover
            ? "Intro + countdown — play unlocks when both finish."
            : topBarPhase === "center"
              ? "Scratch the foil, then match symbols on her — auto scratch finishes the reveal."
              : introGateActive
                ? "Get ready — play starts after the countdown."
                : `Find all ${SYMBOL_SLOT_COUNT} matches first — auto scratch finishes the reveal.`}
        </p>
      ) : null}
      <label className="checkbox-label">
        <input
          checked={autoScratch.enabled}
          disabled={autoScratchLocked}
          onChange={(event) =>
            updateAutoScratch({ enabled: event.currentTarget.checked })
          }
          type="checkbox"
        />
        Enable auto scratch
      </label>
      <label>
        Speed ({autoScratch.speed.toFixed(0)} pts/s)
        <input
          disabled={!autoScratch.enabled}
          max={120}
          min={1}
          onChange={(event) =>
            updateAutoScratch({ speed: Number(event.currentTarget.value) })
          }
          step={1}
          type="range"
          value={autoScratch.speed}
        />
      </label>
      <label className="checkbox-label">
        <input
          checked={autoScratch.flakes}
          onChange={(event) =>
            updateAutoScratch({ flakes: event.currentTarget.checked })
          }
          type="checkbox"
        />
        Flying flakes
      </label>
    </fieldset>
  );

  const cursorFxControls = (
    <fieldset className="scratch-zoom-settings">
      <legend>Cursor FX</legend>
      {cursorFx.fairyDust && !cursorFxPlayWindow ? (
        <p className="auto-scratch-hint">
          {introActive || introCover
            ? "Intro + countdown — cursor FX starts when play unlocks."
            : topBarPhase === "center"
              ? "Scratch the foil first — cursor FX starts after the countdown."
              : introGateActive
                ? "Get ready — cursor FX starts after the countdown."
                : "Cursor FX pauses once all symbols are found."}
        </p>
      ) : null}
      <label className="checkbox-label">
        <input
          checked={cursorFx.fairyDust}
          onChange={(event) =>
            updateCursorFx({ fairyDust: event.currentTarget.checked })
          }
          type="checkbox"
        />
        Fairy Dust
      </label>
      <label>
        Particle size ({cursorFx.particleSize})
        <input
          disabled={!cursorFx.fairyDust}
          max={64}
          min={10}
          onChange={(event) =>
            updateCursorFx({ particleSize: Number(event.currentTarget.value) })
          }
          step={1}
          type="range"
          value={cursorFx.particleSize}
        />
      </label>
      <label>
        Particles per move ({cursorFx.particleCount})
        <input
          disabled={!cursorFx.fairyDust}
          max={8}
          min={1}
          onChange={(event) =>
            updateCursorFx({ particleCount: Number(event.currentTarget.value) })
          }
          step={1}
          type="range"
          value={cursorFx.particleCount}
        />
      </label>
      <label>
        Gravity ({cursorFx.gravity.toFixed(3)})
        <input
          disabled={!cursorFx.fairyDust}
          max={0.1}
          min={0}
          onChange={(event) =>
            updateCursorFx({ gravity: Number(event.currentTarget.value) })
          }
          step={0.005}
          type="range"
          value={cursorFx.gravity}
        />
      </label>
      <label>
        Fade speed ({cursorFx.fadeSpeed.toFixed(2)})
        <input
          disabled={!cursorFx.fairyDust}
          max={0.99}
          min={0.9}
          onChange={(event) =>
            updateCursorFx({ fadeSpeed: Number(event.currentTarget.value) })
          }
          step={0.01}
          type="range"
          value={cursorFx.fadeSpeed}
        />
      </label>
      {cursorFx.fairyDust ? (
        <p className="auto-scratch-hint">
          Active {cursorFxPerf.active} · peak {cursorFxPerf.peak} ·{" "}
          {cursorFxPerf.avgFrameMs.toFixed(2)}ms/frame
          {cursorFxPerf.peak >= 220 ? " — near cap (250)" : ""}
        </p>
      ) : null}
    </fieldset>
  );

  const desktopSettingsTabs = (
    <div className="panel-settings-tabs">
      <div
        className="panel-settings-tablist"
        role="tablist"
        aria-label="Settings"
      >
        {DESKTOP_SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`panel-tab-${tab.id}`}
            aria-selected={desktopSettingsTab === tab.id}
            aria-controls={`panel-tabpanel-${tab.id}`}
            className={`panel-settings-tab${desktopSettingsTab === tab.id ? " is-active" : ""}`}
            onClick={() => setDesktopSettingsTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id="panel-tabpanel-scratch-zoom"
        role="tabpanel"
        aria-labelledby="panel-tab-scratch-zoom"
        hidden={desktopSettingsTab !== "scratch-zoom"}
        className="panel-settings-tabpanel"
      >
        {scratchZoomControls}
      </div>
      <div
        id="panel-tabpanel-sound"
        role="tabpanel"
        aria-labelledby="panel-tab-sound"
        hidden={desktopSettingsTab !== "sound"}
        className="panel-settings-tabpanel"
      >
        {soundControls}
      </div>
      <div
        id="panel-tabpanel-auto-scratch"
        role="tabpanel"
        aria-labelledby="panel-tab-auto-scratch"
        hidden={desktopSettingsTab !== "auto-scratch"}
        className="panel-settings-tabpanel"
      >
        {autoScratchControls}
      </div>
      <div
        id="panel-tabpanel-cursor-fx"
        role="tabpanel"
        aria-labelledby="panel-tab-cursor-fx"
        hidden={desktopSettingsTab !== "cursor-fx"}
        className="panel-settings-tabpanel"
      >
        {cursorFxControls}
      </div>
    </div>
  );

  function openModel(modelId: string) {
    const ordered = playlistCardsForModel(cards, modelId);
    setCompletedCardIds([]);
    completedCardIdsRef.current = [];
    setSelectedCardId("");
    setActiveModelId(modelId);
    setSelectedCardId(ordered[0]?.id ?? "");
  }

  if (showModelPicker) {
    const playableModels = models.filter(
      (model) => playlistCardsForModel(cards, model.id).length > 0,
    );
    return (
      <main className="app-shell home-picker">
        <section className="home-picker-panel">
          <p className="eyebrow">Sugar Scratchie</p>
          <h1>Choose a girl</h1>
          <p className="home-picker-copy">
            Play only her motion cards, in the order you set on Models.
          </p>
          <div className="home-picker-grid">
            {playableModels.map((model) => {
              const count = playlistCardsForModel(cards, model.id).length;
              return (
                <button
                  key={model.id}
                  type="button"
                  className="home-picker-card"
                  onClick={() => openModel(model.id)}
                >
                  <span className="home-picker-avatar">
                    {model.avatar ? (
                      <img alt="" src={model.avatar} />
                    ) : (
                      model.label.slice(0, 1)
                    )}
                  </span>
                  <span className="home-picker-meta">
                    <strong>{model.label}</strong>
                    <span>
                      {count} motion card{count === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {playableModels.length === 0 ? (
            <p className="home-picker-empty">
              No models with motion cards yet.{" "}
              <a href="/dashboard/models">Go to Models</a>
            </p>
          ) : null}
          <div className="home-picker-links">
            <a href="/game">Game</a>
            <a href="/dashboard/models">Models</a>
            <a href="/dashboard">Dashboard</a>
          </div>
        </section>
      </main>
    );
  }

  if (!card) {
    return (
      <main className="app-shell home-picker">
        <section className="home-picker-panel">
          <p className="eyebrow">Sugar Scratchie</p>
          <h1>{activeModel?.label ?? "No cards"}</h1>
          <p className="home-picker-copy">
            {playlistFinished
              ? "All her motion cards are scratched — none left to repeat."
              : "This girl has no motion cards yet."}
          </p>
          <div className="home-picker-links">
            <button
              type="button"
              className="linkish"
              onClick={() => {
                setActiveModelId("");
                setSelectedCardId("");
                setCompletedCardIds([]);
                completedCardIdsRef.current = [];
              }}
            >
              Choose another girl
            </button>
            <a href="/dashboard/models">Models</a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      {cursorFx.fairyDust ? (
        <FairyDustCursor
          particleTypes={cursorFxParticleTypes}
          particleSize={cursorFx.particleSize}
          particleCount={cursorFx.particleCount}
          gravity={cursorFx.gravity}
          fadeSpeed={cursorFx.fadeSpeed}
          initialVelocity={CURSOR_FX_INITIAL_VELOCITY}
          spawnEnabled={cursorFxSpawnActive}
        />
      ) : null}
      <section className="prototype">
        <div
          ref={stageRef}
          className={`stage${gameResult ? " is-game-over" : ""}${
            useBodySymbols &&
            matchStartUnlocked &&
            topBarPhase === "center" &&
            !introGateActive
              ? " is-bar-phase"
              : ""
          }${useBodySymbols && introGateActive ? " is-countdown-phase" : ""}${
            introCover ? " is-intro-video-phase" : ""
          }${introLeaving ? " is-intro-revealing" : ""}`}
        >
          {glError ? (
            <div
              className="game-result game-result--static"
              role="alert"
              style={{ pointerEvents: "auto" }}
            >
              <div className="game-result-iris">
                <div className="game-result-surface">
                  <div className="game-result-card">
                    <p className="game-result-title">WebGL2 required</p>
                    <p className="game-result-detail">
                      {glError}. Open this page in Chrome or Safari (not
                      Cursor's Simple Browser), and make sure hardware
                      acceleration is on.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {typeof window !== "undefined" &&
          new URLSearchParams(window.location.search).has("debug") ? (
            <DebugHud />
          ) : null}
          {gameMode && !entryReady ? (
            <div
              className="match-audio-gate"
              role="button"
              tabIndex={0}
              aria-label="Tap to play"
              onClick={onMatchEntryTap}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onMatchEntryTap();
                }
              }}
            >
              <span className="match-audio-gate-label">Tap to play</span>
            </div>
          ) : null}
          {introCover ? (
            <div
              className={`photo-scratch-intro-video${introLeaving ? " is-leaving" : ""}`}
              aria-hidden="true"
            >
              <div className="photo-scratch-intro-media">
                {introActive && introVideoUrl ? (
                  <video
                    ref={introVideoElRef}
                    autoPlay
                    muted={introMuted}
                    playsInline
                    preload="auto"
                    src={introVideoUrl}
                    onEnded={() => dismissThemeIntro()}
                    onError={() => dismissThemeIntro({ immediate: true })}
                  />
                ) : null}
                <canvas
                  ref={introFreezeCanvasRef}
                  className={`photo-scratch-intro-freeze${introActive ? "" : " is-visible"}`}
                />
              </div>
              <div className="photo-scratch-intro-flash" />
              <div className="photo-scratch-intro-ring" />
            </div>
          ) : null}
          {useBodySymbols && matchStartUnlocked ? (
            <TopSymbolBar
              symbols={topSymbols}
              phase={topBarPhase}
              roundKey={topBarRound}
              matchedSlots={topMatchedSlots}
              onAllRevealed={onTopBarAllRevealed}
            />
          ) : null}
          <StageCoachHint
            key={stageCoachPhase}
            phase={stageCoachPhase}
            found={revealedSymbols}
            total={SYMBOL_SLOT_COUNT}
          />
          {!useBodySymbols && matchStartUnlocked ? (
            <div
              className={`symbol-bar${revealedSymbols >= SYMBOL_SLOT_COUNT ? " is-symbols-complete" : ""}${claimed ? " is-fully-revealed" : ""}`}
              aria-label="Game symbols"
            >
              {sessionSymbols.map((typeId, index) => (
                <div
                  key={index}
                  ref={(el) => {
                    symbolSlotRefs.current[index] = el;
                  }}
                  className={`symbol-slot${index < revealedSymbols ? " is-revealed" : ""}`}
                  title={
                    index < revealedSymbols
                      ? SYMBOL_TYPES[typeId]?.label
                      : undefined
                  }
                >
                  {index < revealedSymbols ? (
                    <GameSymbolIcon typeId={typeId} />
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {showIntroCountdown ? (
            <InitialCountdown
              onComplete={onIntroCountdownComplete}
              soundEnabled={soundEnabled}
            />
          ) : null}
          {useBodySymbols
            ? sessionSymbols.map((typeId, index) => (
                <div
                  key={`body-symbol-${index}`}
                  ref={(el) => {
                    bodyMarkerRefs.current[index] = el;
                  }}
                  className="body-symbol-marker"
                  style={{ display: "none" }}
                >
                  {bodyRevealed[index] ? (
                    <span className="body-symbol-icon">
                      <GameSymbolIcon
                        typeId={typeId}
                        size={BODY_SYMBOL_ICON_PX}
                        paused={isScratching}
                      />
                    </span>
                  ) : null}
                </div>
              ))
            : null}
          {!useBodySymbols
            ? flyingCoins.map((coin) => (
            <div
              key={coin.id}
              className="flying-coin"
              style={
                {
                  "--coin-from-x": `${coin.fromX}px`,
                  "--coin-from-y": `${coin.fromY}px`,
                  "--coin-mid-x": `${coin.midX}px`,
                  "--coin-mid-y": `${coin.midY}px`,
                  "--coin-to-x": `${coin.toX}px`,
                  "--coin-to-y": `${coin.toY}px`,
                  animationDuration: `${COIN_FLIGHT_DURATION_MS}ms`,
                  animationDelay: `${coin.delayMs}ms`,
                } as CSSProperties
              }
              onAnimationEnd={() => removeFlyingCoin(coin.id)}
              aria-hidden="true"
            >
              <GameSymbolIcon typeId={coin.typeId} />
            </div>
          ))
            : null}
          <video
            ref={bottomVideoRef}
            className="source-video"
            muted
            loop
            playsInline
            preload="auto"
          />
          <video
            ref={foregroundVideoRef}
            className="source-video"
            muted
            loop
            playsInline
            preload="auto"
          />
          <canvas
            ref={canvasRef}
            className="game-stage-canvas"
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            style={cardTransition ? { pointerEvents: "none" } : undefined}
            onPointerDown={(event) => {
              if (cardTransitionActiveRef.current) return;
              if (soundEnabledRef.current)
                ensureSymbolAudio(symbolAudioRef.current);
              const bottomVideo = bottomVideoRef.current;
              const foregroundVideo = foregroundVideoRef.current;
              if (bottomVideo?.paused)
                void bottomVideo.play().catch(() => undefined);
              if (foregroundVideo?.paused)
                void foregroundVideo.play().catch(() => undefined);
              drawingRef.current = true;
              setIsScratching(true);
              lastScratchWorldRef.current = null;
              lastPointerClientRef.current = {
                x: event.clientX,
                y: event.clientY,
              };
              const point = getCanvasPoint(event.clientX, event.clientY);
              hoverPointRef.current = point;
              event.currentTarget.setPointerCapture(event.pointerId);
              if (point) applyScratchZoom(point);
              addScratch(event.clientX, event.clientY);
            }}
            onPointerMove={(event) => {
              lastPointerClientRef.current = {
                x: event.clientX,
                y: event.clientY,
              };
              hoverPointRef.current = getCanvasPoint(
                event.clientX,
                event.clientY,
              );
              if (!drawingRef.current) return;
              addScratch(event.clientX, event.clientY);
            }}
            onPointerUp={() => {
              drawingRef.current = false;
              setIsScratching(false);
              lastScratchWorldRef.current = null;
              clearScratchZoom();
            }}
            onPointerLeave={() => {
              drawingRef.current = false;
              setIsScratching(false);
              lastScratchWorldRef.current = null;
              hoverPointRef.current = null;
              clearScratchZoom();
            }}
            onPointerCancel={() => {
              drawingRef.current = false;
              setIsScratching(false);
              lastScratchWorldRef.current = null;
              hoverPointRef.current = null;
              clearScratchZoom();
            }}
          />
          {cardTransition ? (
            <MirrorSlideTransition
              fromSrc={cardTransition.fromBottom}
              toSrc={cardTransition.toBottom}
              templateId={cardTransition.templateId}
              onComplete={() => finishCardTransition(cardTransition)}
              onError={() => finishCardTransition(cardTransition)}
            />
          ) : null}
          <div className="mobile-sound-wrap">
            <button
              type="button"
              className={`mobile-reset mobile-sound-toggle${soundEnabled ? "" : " is-muted"}`}
              aria-label={soundEnabled ? "Mute sounds" : "Unmute sounds"}
              aria-pressed={soundEnabled}
              onClick={() => updateSoundEnabled(!soundEnabled)}
            >
              {soundEnabled ? (
                <Volume2 aria-hidden="true" size={20} strokeWidth={2.2} />
              ) : (
                <VolumeX aria-hidden="true" size={20} strokeWidth={2.2} />
              )}
            </button>
          </div>
          {gameMode ? (
            <a className="mobile-game-badge" href="/game">
              GAME {completedCardIds.length + (card ? 1 : 0)}/{modelCards.length}
              {gameSession ? ` · ${gameSession.photoPrizeTotal} photos` : ""}
            </a>
          ) : null}
          {/* Phones hide the dev panel, so surface compact controls on the stage
              itself. Hidden on desktop where the panel is used. */}
          <div className="mobile-controls-wrap">
            <button
              type="button"
              className={`mobile-reset mobile-controls-toggle${mobileControlsOpen ? " is-open" : ""}`}
              aria-label={
                mobileControlsOpen ? "Hide controls" : "Show controls"
              }
              aria-expanded={mobileControlsOpen}
              onClick={() => {
                setMobileControlsOpen((current) => {
                  if (current) setMobileSettingsOpen(false);
                  return !current;
                });
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {mobileControlsOpen && (
              <div className="mobile-controls">
                {gameMode ? (
                  <a className="mobile-reset mobile-game-link" href="/game">
                    Game
                  </a>
                ) : null}
                <label className="mobile-card-switch">
                  <span className="visually-hidden">Card</span>
                  <select
                    aria-label="Card clip"
                    onChange={(event) =>
                      setSelectedCardId(event.currentTarget.value)
                    }
                    value={card.id}
                  >
                    {remainingCards.map((entry, index) => (
                      <option key={entry.id} value={entry.id}>
                        {index + 1}. {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="mobile-reset"
                  aria-label="Reset scratch"
                  onClick={resetScratch}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`mobile-reset${autoScratch.enabled ? " is-active" : ""}${symbolsHuntComplete ? " is-symbols-complete" : ""}`}
                  disabled={autoScratchLocked}
                  aria-label={
                    autoScratchLocked
                      ? `Find all ${SYMBOL_SLOT_COUNT} matches first`
                      : autoScratch.enabled
                        ? "Auto scratch running"
                        : "Enable auto scratch"
                  }
                  aria-pressed={autoScratch.enabled}
                  onClick={() =>
                    updateAutoScratch({ enabled: !autoScratch.enabled })
                  }
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="mobile-reset mobile-settings-toggle"
                  aria-label="Animation settings"
                  aria-expanded={mobileSettingsOpen}
                  onClick={() => setMobileSettingsOpen((current) => !current)}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
              </div>
            )}
            {mobileControlsOpen && mobileSettingsOpen && (
              <div
                className="mobile-settings-sheet"
                role="dialog"
                aria-label="Animation settings"
              >
                {scratchZoomControls}
                {autoScratchControls}
                {cursorFxControls}
              </div>
            )}
          </div>
          {gameResult ? (
            <div
              className={`game-result game-result--${gameResult}${
                gameResultLeaving ? " is-leaving" : ""
              }`}
              role="status"
              aria-live="polite"
            >
              <div className="game-result-iris">
                <div className="game-result-surface">
                  <div className="game-result-card">
                    <p className="game-result-title">
                      {gameResult === "win" ? "You win!" : "No luck this time"}
                    </p>
                    <p className="game-result-detail">
                      {matchOutcome
                        ? matchResultDetail(matchOutcome, "photo_scratches")
                        : gameResult === "win"
                          ? "Three matching symbols — nice!"
                          : "No three-of-a-kind — try again."}
                    </p>
                    <button
                      type="button"
                      className="game-result-button"
                      onClick={beginLeaveGameResult}
                    >
                      {remainingCards.length > 1
                        ? "Next card"
                        : gameMode
                          ? "Claim photo scratches"
                          : "Done"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <aside className="panel">
          <div>
            <p className="eyebrow">
              {gameMode
                ? "GAME · motion hand"
                : (activeModel?.label ?? "Sugar Scratchie")}
            </p>
            <h1>{card.label}</h1>
            <p className="eyebrow">
              Left {remainingCards.length}/{modelCards.length}
              {completedCardIds.length > 0
                ? ` · scratched ${completedCardIds.length}`
                : ""}
              {gameMode && gameSession
                ? ` · photos banked ${gameSession.photoPrizeTotal}`
                : ""}
            </p>
          </div>
          <div className="button-row">
            {gameMode ? (
              <a className="secondary-button" href="/game">
                Game
              </a>
            ) : (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setActiveModelId("");
                  setSelectedCardId("");
                  setCompletedCardIds([]);
                  completedCardIdsRef.current = [];
                }}
              >
                Girls
              </button>
            )}
            <a className="secondary-button" href="/dashboard/models">
              Models
            </a>
          </div>
          <label>
            Card
            <select
              aria-label="Card clip"
              onChange={(event) => setSelectedCardId(event.currentTarget.value)}
              value={card.id}
            >
              {remainingCards.map((entry, index) => (
                <option key={entry.id} value={entry.id}>
                  {index + 1}. {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mesh
            <select
              aria-label="Mesh keyframe JSON"
              disabled={meshFiles.length === 0}
              onChange={(event) =>
                setSelectedMeshFile(event.currentTarget.value)
              }
              value={selectedMeshFile}
            >
              {meshFiles.length === 0 ? (
                <option value="">No mesh JSON files</option>
              ) : (
                meshFiles.map((file) => (
                  <option key={file} value={file}>
                    {file}
                  </option>
                ))
              )}
            </select>
          </label>
          <div className="timeline-controls">
            <input
              aria-label="Video timeline"
              max={duration || 0}
              min={0}
              onChange={(event) =>
                setVideoTime(Number(event.currentTarget.value))
              }
              step={0.05}
              type="range"
              value={Math.min(currentTime, duration || currentTime)}
            />
          </div>
          <div className="button-row">
            <button type="button" onClick={togglePlayback}>
              {isPaused ? "Play video" : "Pause video"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={resetScratch}
            >
              Reset scratch
            </button>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setShowMesh((current) => !current)}
            >
              {showMesh ? "Hide mesh" : "Show mesh"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setMeshReloadToken((current) => current + 1)}
            >
              Reload mesh
            </button>
          </div>
          {desktopSettingsTabs}
        </aside>
      </section>
    </main>
  );
}
