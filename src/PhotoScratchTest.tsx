import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  GarmentGLRenderer,
  MAX_PIXEL_RATIO,
  PRESENT_ZOOM,
  type ImageLayerCameras,
} from "./glRenderer";
import { GameSymbolIcon } from "./game/GameSymbolIcon";
import {
  buildBodySymbols,
  buildTopSymbols,
  matchResultDetail,
  resolveMatchGame,
  SYMBOL_TYPE_COUNT,
  type MatchGameOutcome,
} from "./game/matchGame";
import { TopSymbolBar, type TopBarPhase } from "./game/TopSymbolBar";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  SYMBOL_POINT_COUNT,
  parseTrackedMesh,
  sampleMeshUvToWorld,
  sampleTrackedMesh,
  trackedWorldToUv,
  type TrackedMesh,
  type TrackedMeshSample,
  type Vec2,
} from "./meshGeometry";
import { useDeviceParallax, type ParallaxState } from "./useDeviceParallax";

const BACK_LAYER_SRC = "/photo-scratch/background.jpg";
const MID_LAYER_SRC = "/photo-scratch/mid.png";
const FRONT_LAYER_SRC = "/photo-scratch/foreground.png";
const MESH_SRC = "/photo-scratch/mesh.json";

type PhotoScratchCardEntry = {
  id: string;
  label: string;
  background: string;
  bikini: string;
  clothes: string;
  mesh: string;
  model_id?: string;
};

function readCardIdFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("card")?.trim() || "";
}

async function fetchPhotoScratchIndex(): Promise<PhotoScratchCardEntry[]> {
  const response = await fetch("/photo-scratch/index.json", {
    cache: "no-store",
  });
  if (!response.ok) return [];
  const data = (await response.json()) as { cards?: PhotoScratchCardEntry[] };
  return data.cards ?? [];
}

const SCRATCH_RADIUS = 0.045;
const MANUAL_SCRATCH_PATH_STEP = SCRATCH_RADIUS * 0.65 * CANVAS_HEIGHT;
const MANUAL_SCRATCH_MAX_POINTS = 40;
const AUTO_SCRATCH_STORAGE_KEY = "sugar-scratchie:auto-scratch";
const SOUND_STORAGE_KEY = "sugar-scratchie:sound";
const AUTO_SCRATCH_RADIUS = 0.092;
const AUTO_SCRATCH_DIAGONAL_LINES = 18;
const AUTO_SCRATCH_PATH_STEP_UV = AUTO_SCRATCH_RADIUS * 0.72;
const AUTO_SCRATCH_FILL_BATCH = 36;
const AUTO_SCRATCH_MAX_PER_FRAME = 32;
const SYMBOL_NOTE_BASE_HZ = 523.25;
const SYMBOL_NOTE_DURATION_S = 0.32;
const FULL_REVEAL_MANUAL_THRESHOLD = 0.7;
const GAME_OUTCOME_OVERLAY_PAD_MS = 300;
const GAME_OUTCOME_SILENT_DELAY_MS = 1500;
const FOREGROUND_CHROMA = false;
// Room bg needs extra overscan beyond PRESENT_ZOOM so tilt + finger parallax
// never reveals the stage letterboxing.
const PARALLAX_MAX_X = 22;
const PARALLAX_MAX_Y = 16;
// Opposite room drift while scratching — girl layers stay locked.
const PARALLAX_FINGER_MAX = 16;
const PARALLAX_FINGER_GAIN = 0.22;
const BG_OVERSCAN = Math.max(
  PRESENT_ZOOM,
  1 + (2 * (PARALLAX_MAX_X + PARALLAX_FINGER_MAX)) / CANVAS_WIDTH,
  1 + (2 * (PARALLAX_MAX_Y + PARALLAX_FINGER_MAX)) / CANVAS_HEIGHT,
);
// Idle “alive” sway for synced bikini + clothes before the first scratch.
// Soft motion after load — mostly up/down with a slight right drift.
const IDLE_SWAY_AMP_X = 2.8;
const IDLE_SWAY_AMP_Y = 5.5;
const IDLE_SWAY_PERIOD_MS = 4200;
const IDLE_SWAY_EASE = 0.04;
// Softly ease girl cam toward lock (center) / unlock — no hard snap.
const GIRL_CAM_EASE = 0.085;
// Room blur/zoom ease slower than girl lock; keep blur subtle.
const BG_FX_EASE = 0.035;
const BG_BLUR_PX = 7;
const BG_BRIGHTNESS_DIM = 0.8;

type ScratchMark = { u: number; v: number; radius: number };

const SYMBOL_REVEAL_UV_RADIUS = 0.06;

function clamp(value: number, lo: number, hi: number) {
  return value < lo ? lo : value > hi ? hi : value;
}

type AutoScratchSettings = {
  enabled: boolean;
  speed: number;
};

const AUTO_SCRATCH_DEFAULTS: AutoScratchSettings = {
  enabled: false,
  speed: 58,
};

type SymbolAudioState = {
  ctx: AudioContext | null;
};

type GameResult = "win" | "lose";

function buildSessionSymbols(): number[] {
  return buildBodySymbols();
}

function isGarmentFullyRevealed(
  revealedCount: number,
  sampleCount: number,
  autoMode: boolean,
) {
  if (sampleCount === 0) return false;
  if (autoMode) return revealedCount >= sampleCount;
  return (
    revealedCount >= Math.ceil(sampleCount * FULL_REVEAL_MANUAL_THRESHOLD)
  );
}

/** asian_2_slot_01 → asian_2; bare ids pass through. */
function parentMotionCardId(entryId: string): string {
  const match = entryId.trim().match(/^(.*)_slot_\d+$/i);
  return match ? match[1] : entryId.trim();
}

function playlistForParent(
  cards: PhotoScratchCardEntry[],
  parentId: string,
): PhotoScratchCardEntry[] {
  const parent = parentId.trim();
  if (!parent) return [];
  const prefix = `${parent}_slot_`;
  return cards
    .filter((card) => card.id === parent || card.id.startsWith(prefix))
    .sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" }),
    );
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

function loadAutoScratchSettings(): AutoScratchSettings {
  if (typeof window === "undefined") return AUTO_SCRATCH_DEFAULTS;
  try {
    const raw = localStorage.getItem(AUTO_SCRATCH_STORAGE_KEY);
    if (!raw) return AUTO_SCRATCH_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AutoScratchSettings>;
    return {
      enabled: parsed.enabled ?? AUTO_SCRATCH_DEFAULTS.enabled,
      speed: clamp(
        Number(parsed.speed) || AUTO_SCRATCH_DEFAULTS.speed,
        1,
        120,
      ),
    };
  } catch {
    return AUTO_SCRATCH_DEFAULTS;
  }
}

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
  return SYMBOL_NOTE_BASE_HZ * 2 ** (slotIndex / SYMBOL_POINT_COUNT);
}

function playSymbolSlotNote(state: SymbolAudioState, slotIndex: number) {
  const ctx = ensureSymbolAudio(state);
  if (!ctx || slotIndex < 0 || slotIndex >= SYMBOL_POINT_COUNT) return;
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

  scheduleSlide(ctx, now, 340, 190, 0.52, 0.2, "sawtooth");
  scheduleSlide(ctx, now + 0.62, 290, 130, 0.58, 0.18, "sawtooth");
  scheduleSlide(ctx, now + 1.28, 220, 95, 0.72, 0.16, "triangle");
  return 2.05 * 1000 + GAME_OUTCOME_OVERLAY_PAD_MS;
}

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

function isGarmentUv(mesh: TrackedMesh | null, u: number, v: number) {
  const garment = mesh?.garment ?? null;
  const cols = mesh?.cols ?? 0;
  const rows = mesh?.rows ?? 0;
  if (!garment || cols <= 0 || rows <= 0) return true;
  const col = Math.round(clamp(u, 0, 1) * (cols - 1));
  const row = Math.round(clamp(v, 0, 1) * (rows - 1));
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

function worldPointToStage(
  worldPoint: Vec2,
  canvas: HTMLCanvasElement,
  stage: HTMLElement,
  camera: { x: number; y: number },
): Vec2 {
  const canvasRect = canvas.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  const refClipX = (worldPoint.x / CANVAS_WIDTH) * 2 - 1;
  const refClipY = 1 - (worldPoint.y / CANVAS_HEIGHT) * 2;
  const presentX =
    ((refClipX * PRESENT_ZOOM + camera.x + 1) / 2) * CANVAS_WIDTH;
  const presentY =
    ((1 - (refClipY * PRESENT_ZOOM + camera.y)) / 2) * CANVAS_HEIGHT;
  const clientX =
    canvasRect.left + (presentX / CANVAS_WIDTH) * canvasRect.width;
  const clientY =
    canvasRect.top + (presentY / CANVAS_HEIGHT) * canvasRect.height;
  return { x: clientX - stageRect.left, y: clientY - stageRect.top };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    // Bust HTTP cache so rematched cutouts show up without a hard refresh war.
    const join = src.includes("?") ? "&" : "?";
    img.src = `${src}${join}t=${Date.now()}`;
  });
}

function workCardPreviewPath(cardId: string, file: string) {
  return `/api/files/preview?path=${encodeURIComponent(`.tmp/photo-flow/${cardId}/${file}`)}`;
}

async function loadWorkCardAssets(cardId: string) {
  const [back, mid, front, meshRes] = await Promise.all([
    loadImage(workCardPreviewPath(cardId, "background.png")),
    loadImage(workCardPreviewPath(cardId, "bikini.png")),
    loadImage(workCardPreviewPath(cardId, "clothes.png")),
    fetch(workCardPreviewPath(cardId, "mesh.json"), { cache: "no-store" }),
  ]);
  if (!meshRes.ok)
    throw new Error(`Work-folder mesh missing (${meshRes.status})`);
  const meshData = await meshRes.json();
  const mesh = parseTrackedMesh(meshData);
  if (!mesh) throw new Error(`Invalid work-folder mesh for ${cardId}`);
  return { back, mid, front, mesh, label: `${cardId} (unpublished preview)` };
}

async function loadSampleAssets() {
  const [back, mid, front, meshRes] = await Promise.all([
    loadImage(BACK_LAYER_SRC),
    loadImage(MID_LAYER_SRC),
    loadImage(FRONT_LAYER_SRC),
    fetch(MESH_SRC),
  ]);
  if (!meshRes.ok) throw new Error(`Failed to load mesh (${meshRes.status})`);
  const meshData = await meshRes.json();
  const mesh = parseTrackedMesh(meshData);
  if (!mesh) throw new Error("Invalid photo-scratch mesh.json");
  return { back, mid, front, mesh, label: "Sample assets" };
}

function resolvePublishedEntry(
  cards: PhotoScratchCardEntry[],
  cardId: string,
): PhotoScratchCardEntry | undefined {
  const exact = cards.find((card) => card.id === cardId);
  if (exact) return exact;
  // Motion-card id → first published photo-scratch slot (asian_2 → asian_2_slot_01).
  const prefix = `${cardId}_`;
  return cards.find((card) => card.id.startsWith(prefix));
}

async function loadCardAssets(cardId: string) {
  const cards = await fetchPhotoScratchIndex();
  const entry = resolvePublishedEntry(cards, cardId);
  if (!entry) throw new Error(`Photo card not found: ${cardId}`);
    const [back, mid, front, meshRes] = await Promise.all([
    loadImage(entry.background),
    loadImage(entry.bikini),
    loadImage(entry.clothes),
    fetch(`${entry.mesh}${entry.mesh.includes("?") ? "&" : "?"}t=${Date.now()}`, {
      cache: "no-store",
    }),
  ]);
  if (!meshRes.ok) throw new Error(`Failed to load mesh (${meshRes.status})`);
  const meshData = await meshRes.json();
  const mesh = parseTrackedMesh(meshData);
  if (!mesh) throw new Error(`Invalid mesh for card ${cardId}`);
  return { back, mid, front, mesh, label: entry.label };
}

async function loadCardAssetsWithFallback(cardId: string) {
  try {
    return await loadCardAssets(cardId);
  } catch (publishedError) {
    try {
      return await loadWorkCardAssets(cardId);
    } catch {
      throw publishedError;
    }
  }
}

function densifyStrokeSegment(
  from: Vec2,
  to: Vec2,
  maxStep: number,
  maxPoints: number,
): Vec2[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= maxStep) return [from, to];
  const steps = Math.ceil(dist / maxStep);
  const points: Vec2[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push({ x: from.x + dx * t, y: from.y + dy * t });
  }
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

function toGlSample(
  sample: TrackedMeshSample,
  garment: number[] | null = null,
) {
  return {
    cols: sample.cols,
    rows: sample.rows,
    uv: sample.uv,
    verts: sample.verts,
    vis: sample.vis,
    garment,
  };
}

function pxToClipX(px: number, cssWidth: number) {
  return clamp((px / cssWidth) * 2, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1);
}

function pxToClipY(px: number, cssHeight: number) {
  return clamp((px / cssHeight) * 2, -(PRESENT_ZOOM - 1), PRESENT_ZOOM - 1);
}

function groupCamerasFromParallax(
  state: ParallaxState | null,
  cssWidth: number,
  cssHeight: number,
): ImageLayerCameras {
  const group = state?.group ?? { x: 0, y: 0 };
  const cam = {
    x: pxToClipX(group.x, cssWidth),
    y: pxToClipY(group.y, cssHeight),
  };
  return { back: cam, mid: cam, front: cam };
}

function motionStatusLabel(status: string) {
  switch (status) {
    case "active":
      return "motion active";
    case "pending":
      return "requesting…";
    case "denied":
      return "permission denied";
    case "insecure":
      return "needs HTTPS";
    case "unsupported":
      return "unsupported";
    default:
      return "idle";
  }
}

export function PhotoScratchTest() {
  const bgImageRef = useRef<HTMLImageElement>(null);
  const fgCanvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fgRendererRef = useRef<GarmentGLRenderer | null>(null);
  const trackedMeshRef = useRef<TrackedMesh | null>(null);
  const trackedSampleRef = useRef<TrackedMeshSample | null>(null);
  const backImageRef = useRef<HTMLImageElement | null>(null);
  const midImageRef = useRef<HTMLImageElement | null>(null);
  const frontImageRef = useRef<HTMLImageElement | null>(null);
  const marksRef = useRef<ScratchMark[]>([]);
  const bodyMarkerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const revealedPointsRef = useRef<boolean[]>(
    Array.from({ length: SYMBOL_POINT_COUNT }, () => false),
  );
  const lastScratchWorldRef = useRef<Vec2 | null>(null);
  const isScratchingRef = useRef(false);
  const scratchStartedRef = useRef(false);
  const idleSwayRef = useRef<Vec2>({ x: 0, y: 0 });
  const girlCamRef = useRef<Vec2>({ x: 0, y: 0 });
  const bgBlurRef = useRef(0);
  const bgBrightnessRef = useRef(1);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const revealSamplesRef = useRef<Vec2[]>([]);
  const revealedRef = useRef<boolean[]>([]);
  const revealedCountRef = useRef(0);
  const autoPathRef = useRef<Vec2[]>([]);
  const autoPathIndexRef = useRef(0);
  const autoPathProgressRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const symbolAudioRef = useRef<SymbolAudioState>({ ctx: null });
  const claimedRef = useRef(false);
  const gameResultPendingRef = useRef<GameResult | null>(null);
  const gameResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tryResolveGameRef = useRef<() => void>(() => undefined);
  const advanceAfterScratchRef = useRef<() => void>(() => undefined);
  const completedCardIdsRef = useRef<string[]>([]);
  const applyScratchAtUvRef = useRef<
    (u: number, v: number, radius: number) => void
  >(() => {});
  const parallaxStateRef = useRef<ParallaxState | null>({
    fg: { x: 0, y: 0 },
    bg: { x: 0, y: 0 },
    group: { x: 0, y: 0 },
  });

  const parallax = useDeviceParallax({
    stageRef,
    stateOutRef: parallaxStateRef,
    maxX: PARALLAX_MAX_X,
    maxY: PARALLAX_MAX_Y,
    // Smaller rangeDeg = more travel per degree of tilt (compass feels livelier).
    rangeDeg: 12,
    bgGain: 1.15,
    fingerGain: PARALLAX_FINGER_GAIN,
    fingerMax: PARALLAX_FINGER_MAX,
    fingerMovesGroup: false,
    smooth: 0.12,
  });

  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [showMesh, setShowMesh] = useState(false);
  const [scratchCount, setScratchCount] = useState(0);
  const [isScratching, setIsScratching] = useState(false);
  const [pageOrigin, setPageOrigin] = useState("");
  const [usingSample, setUsingSample] = useState(true);
  const [uploadLabel, setUploadLabel] = useState("Sample assets");
  const [backSrc, setBackSrc] = useState(BACK_LAYER_SRC);
  const [midSrc, setMidSrc] = useState(MID_LAYER_SRC);
  const [frontSrc, setFrontSrc] = useState(FRONT_LAYER_SRC);
  const [showLayerBg, setShowLayerBg] = useState(true);
  const [showLayerMid, setShowLayerMid] = useState(true);
  const [showLayerClothes, setShowLayerClothes] = useState(true);
  const showLayersRef = useRef({
    bg: true,
    mid: true,
    clothes: true,
  });
  showLayersRef.current = {
    bg: showLayerBg,
    mid: showLayerMid,
    clothes: showLayerClothes,
  };
  const [sessionSymbols, setSessionSymbols] =
    useState<number[]>(buildSessionSymbols);
  const sessionSymbolsRef = useRef(sessionSymbols);
  sessionSymbolsRef.current = sessionSymbols;
  const [topSymbols, setTopSymbols] = useState(buildTopSymbols);
  const topSymbolsRef = useRef(topSymbols);
  topSymbolsRef.current = topSymbols;
  const [topBarPhase, setTopBarPhase] = useState<TopBarPhase>("center");
  const topBarPhaseRef = useRef(topBarPhase);
  topBarPhaseRef.current = topBarPhase;
  const [topBarRound, setTopBarRound] = useState(0);
  const [matchOutcome, setMatchOutcome] = useState<MatchGameOutcome | null>(
    null,
  );
  const [revealedSymbols, setRevealedSymbols] = useState(0);
  const [hasBodySymbols, setHasBodySymbols] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(loadSoundEnabled);
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const [autoScratch, setAutoScratch] = useState<AutoScratchSettings>(
    loadAutoScratchSettings,
  );
  const autoScratchRef = useRef(autoScratch);
  autoScratchRef.current = autoScratch;
  const revealedSymbolsRef = useRef(0);
  revealedSymbolsRef.current = revealedSymbols;
  const hasBodySymbolsRef = useRef(false);
  hasBodySymbolsRef.current = hasBodySymbols;
  const [claimed, setClaimed] = useState(false);
  const [gameResult, setGameResult] = useState<GameResult | null>(null);
  const [playlist, setPlaylist] = useState<PhotoScratchCardEntry[]>([]);
  const [selectedCardId, setSelectedCardId] = useState("");
  const [completedCardIds, setCompletedCardIds] = useState<string[]>([]);
  completedCardIdsRef.current = completedCardIds;

  function trackObjectUrl(url: string) {
    objectUrlsRef.current.push(url);
    return url;
  }

  function revokeObjectUrls() {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    objectUrlsRef.current = [];
  }

  function loadImageFromFile(file: File): Promise<HTMLImageElement> {
    return loadImage(trackObjectUrl(URL.createObjectURL(file)));
  }

  function clearGameResultTimer() {
    if (gameResultTimerRef.current !== null) {
      window.clearTimeout(gameResultTimerRef.current);
      gameResultTimerRef.current = null;
    }
  }

  function resetGameOutcome() {
    clearGameResultTimer();
    gameResultPendingRef.current = null;
    setGameResult(null);
    setMatchOutcome(null);
  }

  function resetMatchRound() {
    setTopSymbols(buildTopSymbols());
    setTopBarPhase("center");
    topBarPhaseRef.current = "center";
    setTopBarRound((n) => n + 1);
    setSessionSymbols(buildBodySymbols());
    setMatchOutcome(null);
  }

  function onTopBarAllRevealed() {
    setTopBarPhase("docked");
    topBarPhaseRef.current = "docked";
  }

  function applyMesh(mesh: TrackedMesh) {
    trackedMeshRef.current = mesh;
    trackedSampleRef.current = sampleTrackedMesh(mesh, 0);
    revealedPointsRef.current = Array.from(
      { length: SYMBOL_POINT_COUNT },
      () => false,
    );
    revealSamplesRef.current = buildRevealSamples(mesh);
    revealedRef.current = new Array(revealSamplesRef.current.length).fill(
      false,
    );
    revealedCountRef.current = 0;
    autoPathRef.current = buildAutoScratchPath(mesh);
    autoPathIndexRef.current = 0;
    autoPathProgressRef.current = 0;
    claimedRef.current = false;
    setClaimed(false);
    resetGameOutcome();
    resetMatchRound();
    setRevealedSymbols(0);
    setHasBodySymbols(mesh.symbolPoints?.length === SYMBOL_POINT_COUNT);
    setAutoScratch((current) =>
      current.enabled ? { ...current, enabled: false } : current,
    );
  }

  async function applyLoadedAssets(assets: {
    back: HTMLImageElement;
    mid: HTMLImageElement;
    front: HTMLImageElement;
    mesh: TrackedMesh;
    label: string;
  }) {
    backImageRef.current = assets.back;
    midImageRef.current = assets.mid;
    frontImageRef.current = assets.front;
    applyMesh(assets.mesh);
    marksRef.current = [];
    lastScratchWorldRef.current = null;
    scratchStartedRef.current = false;
    fgRendererRef.current?.clearScratch();
    setScratchCount(0);
    setBackSrc(assets.back.src);
    setMidSrc(assets.mid.src);
    setFrontSrc(assets.front.src);
    setUploadLabel(assets.label);
    setReady(true);
    setLoadError(null);
  }

  async function loadAssetsFromSample() {
    revokeObjectUrls();
    const cardId = readCardIdFromLocation();
    if (!cardId) {
      const assets = await loadSampleAssets();
      setPlaylist([]);
      setSelectedCardId("");
      setCompletedCardIds([]);
      setUsingSample(true);
      await applyLoadedAssets(assets);
      return;
    }

    const index = await fetchPhotoScratchIndex();
    const entry = resolvePublishedEntry(index, cardId);
    const parentId = parentMotionCardId(entry?.id ?? cardId);
    const siblings = playlistForParent(index, parentId);
    setPlaylist(siblings);
    setCompletedCardIds([]);

    if (entry) {
      setSelectedCardId(entry.id);
      const url = new URL(window.location.href);
      url.searchParams.set("card", entry.id);
      window.history.replaceState({}, "", url.toString());
      const assets = await loadCardAssets(entry.id);
      setUsingSample(false);
      await applyLoadedAssets(assets);
      return;
    }

    const assets = await loadCardAssetsWithFallback(cardId);
    setSelectedCardId(cardId);
    setUsingSample(false);
    await applyLoadedAssets(assets);
  }

  async function applyUploadedLayer(
    slot: "back" | "mid" | "front",
    file: File,
  ) {
    const img = await loadImageFromFile(file);
    if (slot === "back") {
      backImageRef.current = img;
      setBackSrc(img.src);
    }
    if (slot === "mid") {
      midImageRef.current = img;
      setMidSrc(img.src);
    }
    if (slot === "front") {
      frontImageRef.current = img;
      setFrontSrc(img.src);
    }
    if (!trackedMeshRef.current) {
      const meshRes = await fetch(MESH_SRC);
      if (!meshRes.ok)
        throw new Error(`Failed to load mesh (${meshRes.status})`);
      const mesh = parseTrackedMesh(await meshRes.json());
      if (!mesh) throw new Error("Invalid photo-scratch mesh.json");
      applyMesh(mesh);
    }
    setUsingSample(false);
    setUploadLabel(file.name);
    setReady(true);
    resetScratches();
    setLoadError(null);
  }

  async function applyFullPhoto(file: File) {
    revokeObjectUrls();
    const img = await loadImageFromFile(file);
    backImageRef.current = img;
    midImageRef.current = img;
    frontImageRef.current = img;
    setBackSrc(img.src);
    setMidSrc(img.src);
    setFrontSrc(img.src);
    if (!trackedMeshRef.current) {
      const meshRes = await fetch(MESH_SRC);
      if (!meshRes.ok)
        throw new Error(`Failed to load mesh (${meshRes.status})`);
      const mesh = parseTrackedMesh(await meshRes.json());
      if (!mesh) throw new Error("Invalid photo-scratch mesh.json");
      applyMesh(mesh);
    }
    setUsingSample(false);
    setUploadLabel(file.name);
    resetScratches();
    setReady(true);
    setLoadError(null);
  }

  useEffect(() => {
    setPageOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.style.setProperty("--bg-base-scale", String(BG_OVERSCAN));
    stage.style.setProperty("--bg-base-x", "0px");
    stage.style.setProperty("--bg-base-y", "0px");
    stage.style.setProperty("--bg-blur", "0px");
    stage.style.setProperty("--bg-brightness", "1");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        await loadAssetsFromSample();
        if (cancelled) return;
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Failed to load assets",
          );
        }
      }
    }

    void boot();
    return () => {
      cancelled = true;
      revokeObjectUrls();
    };
  }, []);

  useEffect(() => {
    const fgCanvas = fgCanvasRef.current;
    if (!fgCanvas || !ready) return;

    let fgRenderer: GarmentGLRenderer;
    try {
      const pixelRatio = Math.min(
        MAX_PIXEL_RATIO,
        typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      );
      fgRenderer = new GarmentGLRenderer(
        fgCanvas,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
        {
          alpha: true,
          preserveDrawingBuffer: true,
          pixelRatio,
        },
      );
      fgRendererRef.current = fgRenderer;
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "WebGL2 unavailable",
      );
      return;
    }

    let frameId = 0;
    lastFrameTimeRef.current = performance.now();
    const render = () => {
      const now = performance.now();
      const dt = Math.min(
        0.05,
        Math.max(0, (now - lastFrameTimeRef.current) / 1000),
      );
      lastFrameTimeRef.current = now;

      const sample = trackedSampleRef.current;
      const rect = fgCanvas.getBoundingClientRect();
      const cameras = groupCamerasFromParallax(
        parallaxStateRef.current,
        rect.width || CANVAS_WIDTH,
        rect.height || CANVAS_HEIGHT,
      );

      const autoSettings = autoScratchRef.current;
      const huntComplete =
        !hasBodySymbolsRef.current ||
        revealedSymbolsRef.current >= SYMBOL_POINT_COUNT;
      if (
        autoSettings.enabled &&
        huntComplete &&
        sample &&
        gameResultPendingRef.current === null &&
        !claimedRef.current
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
            applyScratchAtUvRef.current(pt.x, pt.y, AUTO_SCRATCH_RADIUS);
            autoPathIndexRef.current += 1;
            scratched += 1;
          }
        }

        const pathDone =
          path.length === 0 || autoPathIndexRef.current >= path.length;
        const sampleCount = revealSamplesRef.current.length;
        const garmentComplete =
          sampleCount > 0 && revealedCountRef.current >= sampleCount;
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
            applyScratchAtUvRef.current(pt.x, pt.y, AUTO_SCRATCH_RADIUS);
            filled += 1;
          }
        }
      }

      // Synced bikini + clothes idle sway (up/down + diagonal to the right).
      // Active whenever the finger is up — same gentle motion as after load.
      const phase = (now / IDLE_SWAY_PERIOD_MS) * Math.PI * 2;
      const wantIdle = !isScratchingRef.current;
      const wave = Math.sin(phase);
      // Same phase on X/Y → diagonal; bias X positive so the drift leans right.
      const targetIdleX = wantIdle
        ? wave * IDLE_SWAY_AMP_X + Math.abs(wave) * 1.2
        : 0;
      const targetIdleY = wantIdle ? wave * IDLE_SWAY_AMP_Y : 0;
      const idle = idleSwayRef.current;
      idle.x += (targetIdleX - idle.x) * IDLE_SWAY_EASE;
      idle.y += (targetIdleY - idle.y) * IDLE_SWAY_EASE;

      // Ease girl cam toward center while scratching; ease back to tilt/idle after.
      // Hard-locking to {0,0} felt like a dry snap to the middle.
      const scratching = isScratchingRef.current;
      const liveCam = {
        x: cameras.front.x + pxToClipX(idle.x, rect.width || CANVAS_WIDTH),
        y: cameras.front.y + pxToClipY(idle.y, rect.height || CANVAS_HEIGHT),
      };
      const targetCam = scratching ? { x: 0, y: 0 } : liveCam;
      const girlCam = girlCamRef.current;
      girlCam.x += (targetCam.x - girlCam.x) * GIRL_CAM_EASE;
      girlCam.y += (targetCam.y - girlCam.y) * GIRL_CAM_EASE;
      const groupCam = { x: girlCam.x, y: girlCam.y };

      // Ease room blur + brightness in/out with scratch.
      const blurTarget = scratching ? BG_BLUR_PX : 0;
      const brightnessTarget = scratching ? BG_BRIGHTNESS_DIM : 1;
      bgBlurRef.current += (blurTarget - bgBlurRef.current) * BG_FX_EASE;
      bgBrightnessRef.current +=
        (brightnessTarget - bgBrightnessRef.current) * BG_FX_EASE;
      if (stageRef.current) {
        stageRef.current.style.setProperty(
          "--bg-blur",
          `${bgBlurRef.current.toFixed(2)}px`,
        );
        stageRef.current.style.setProperty(
          "--bg-brightness",
          bgBrightnessRef.current.toFixed(3),
        );
      }

      const sampleCount = revealSamplesRef.current.length;
      const autoMode = autoScratchRef.current.enabled;
      const canClaim =
        !hasBodySymbolsRef.current ||
        revealedSymbolsRef.current >= SYMBOL_POINT_COUNT;
      const hideClothes =
        claimedRef.current ||
        (canClaim &&
          isGarmentFullyRevealed(
            revealedCountRef.current,
            sampleCount,
            autoMode,
          ));
      if (hideClothes && !claimedRef.current) {
        claimedRef.current = true;
        setClaimed(true);
        tryResolveGameRef.current();
      }

      const layers = showLayersRef.current;
      fgRenderer.renderPhotoForeground(
        layers.mid ? midImageRef.current : null,
        layers.clothes && !hideClothes ? frontImageRef.current : null,
        sample
          ? toGlSample(sample, trackedMeshRef.current?.garment ?? null)
          : null,
        showMesh,
        groupCam,
        FOREGROUND_CHROMA,
      );

      // Pin revealed Lottie symbols to their mesh-UV anchors.
      const bodyPoints = trackedMeshRef.current?.symbolPoints;
      const stage = stageRef.current;
      if (
        bodyPoints &&
        bodyPoints.length === SYMBOL_POINT_COUNT &&
        sample &&
        stage
      ) {
        const frontCam = fgRenderer.getFrontPresentCamera();
        for (let index = 0; index < SYMBOL_POINT_COUNT; index += 1) {
          const marker = bodyMarkerRefs.current[index];
          if (!marker) continue;
          const revealed = revealedPointsRef.current[index];
          const world = sampleMeshUvToWorld(
            sample,
            bodyPoints[index].u,
            bodyPoints[index].v,
          );
          const stagePos = worldPointToStage(world, fgCanvas, stage, frontCam);
          marker.style.display = revealed ? "flex" : "none";
          marker.style.transform = `translate(${stagePos.x}px, ${stagePos.y}px)`;
          marker.classList.toggle("is-revealed", revealed);
        }
      }
      frameId = requestAnimationFrame(render);
    };
    frameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frameId);
      fgRendererRef.current = null;
    };
  }, [ready, showMesh]);

  useEffect(() => {
    const fgCanvas = fgCanvasRef.current;
    if (!fgCanvas || !ready) return;

    const blockTouchScroll = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    };
    fgCanvas.addEventListener("touchstart", blockTouchScroll, {
      passive: false,
    });
    fgCanvas.addEventListener("touchmove", blockTouchScroll, {
      passive: false,
    });

    return () => {
      fgCanvas.removeEventListener("touchstart", blockTouchScroll);
      fgCanvas.removeEventListener("touchmove", blockTouchScroll);
    };
  }, [ready]);

  function getCanvasPoint(clientX: number, clientY: number): Vec2 | null {
    const canvas = fgCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const presentX = ((clientX - rect.left) / rect.width) * CANVAS_WIDTH;
    const presentY = ((clientY - rect.top) / rect.height) * CANVAS_HEIGHT;
    const frontCam = fgRendererRef.current?.getFrontPresentCamera() ?? {
      x: 0,
      y: 0,
    };
    const refClipX =
      ((presentX / CANVAS_WIDTH) * 2 - 1 - frontCam.x) / PRESENT_ZOOM;
    const refClipY =
      (1 - (presentY / CANVAS_HEIGHT) * 2 - frontCam.y) / PRESENT_ZOOM;
    return {
      x: ((refClipX + 1) / 2) * CANVAS_WIDTH,
      y: ((1 - refClipY) / 2) * CANVAS_HEIGHT,
    };
  }

  function applyScratchAtUv(u: number, v: number, radius: number) {
    if (gameResultPendingRef.current !== null || claimedRef.current) return;
    if (hasBodySymbolsRef.current && topBarPhaseRef.current === "center") {
      return;
    }

    marksRef.current = [...marksRef.current, { u, v, radius }].slice(-180);
    fgRendererRef.current?.paintScratch(u, v, radius);
    setScratchCount(marksRef.current.length);

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

    const bodyPoints = trackedMeshRef.current?.symbolPoints;
    if (bodyPoints && bodyPoints.length === SYMBOL_POINT_COUNT) {
      let changed = false;
      for (let index = 0; index < bodyPoints.length; index += 1) {
        if (revealedPointsRef.current[index]) continue;
        const distance = Math.hypot(
          u - bodyPoints[index].u,
          v - bodyPoints[index].v,
        );
        if (distance <= SYMBOL_REVEAL_UV_RADIUS) {
          revealedPointsRef.current[index] = true;
          changed = true;
        }
      }
      if (changed) {
        const nextSymbolCount = revealedPointsRef.current.filter(Boolean).length;
        const prevCount = revealedSymbolsRef.current;
        revealedSymbolsRef.current = nextSymbolCount;
        setRevealedSymbols(nextSymbolCount);
        playNewSymbolNotes(
          symbolAudioRef.current,
          prevCount,
          nextSymbolCount,
          soundEnabledRef.current,
        );
        if (nextSymbolCount >= SYMBOL_POINT_COUNT) {
          beginFinishAutoScratch();
        }
      }
    }

    const canClaim =
      !hasBodySymbolsRef.current ||
      revealedSymbolsRef.current >= SYMBOL_POINT_COUNT;
    if (
      canClaim &&
      isGarmentFullyRevealed(
        revealedCountRef.current,
        samples.length,
        autoScratchRef.current.enabled,
      )
    ) {
      if (!claimedRef.current) {
        claimedRef.current = true;
        setClaimed(true);
      }
      tryResolveGameRef.current();
    }
  }
  applyScratchAtUvRef.current = applyScratchAtUv;

  function addScratch(clientX: number, clientY: number) {
    const point = getCanvasPoint(clientX, clientY);
    const sample = trackedSampleRef.current;
    if (!point || !sample) return;

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
    for (const strokePoint of strokePoints) {
      const uv = trackedWorldToUv(sample, strokePoint);
      if (!uv) continue;
      applyScratchAtUv(uv.x, uv.y, SCRATCH_RADIUS);
      applied = true;
    }
    if (applied) lastScratchWorldRef.current = point;
  }

  function updateSoundEnabled(enabled: boolean) {
    if (enabled) ensureSymbolAudio(symbolAudioRef.current);
    setSoundEnabled(enabled);
  }

  function updateAutoScratch(patch: Partial<AutoScratchSettings>) {
    if (
      patch.enabled &&
      hasBodySymbolsRef.current &&
      (revealedSymbolsRef.current < SYMBOL_POINT_COUNT ||
        topBarPhaseRef.current === "center")
    ) {
      return;
    }
    if (patch.enabled && soundEnabledRef.current) {
      ensureSymbolAudio(symbolAudioRef.current);
    }
    setAutoScratch((current) => ({ ...current, ...patch }));
  }

  function beginFinishAutoScratch() {
    autoPathIndexRef.current = 0;
    autoPathProgressRef.current = 0;
    if (soundEnabledRef.current) ensureSymbolAudio(symbolAudioRef.current);
    autoScratchRef.current = { ...autoScratchRef.current, enabled: true };
    setAutoScratch((current) =>
      current.enabled ? current : { ...current, enabled: true },
    );
  }

  function tryResolveGame() {
    if (gameResultPendingRef.current !== null) return;
    const sampleCount = revealSamplesRef.current.length;
    if (
      !isGarmentFullyRevealed(
        revealedCountRef.current,
        sampleCount,
        autoScratchRef.current.enabled,
      )
    ) {
      return;
    }
    if (
      hasBodySymbolsRef.current &&
      revealedSymbolsRef.current < SYMBOL_POINT_COUNT
    ) {
      return;
    }
    let outcome: GameResult;
    let match: MatchGameOutcome | null = null;
    if (hasBodySymbolsRef.current) {
      match = resolveMatchGame(
        topSymbolsRef.current,
        sessionSymbolsRef.current,
      );
      outcome = match.result;
    } else {
      const counts = new Array(SYMBOL_TYPE_COUNT).fill(0);
      outcome = "lose";
      for (const id of sessionSymbolsRef.current) {
        counts[id] += 1;
        if (counts[id] >= 3) {
          outcome = "win";
          break;
        }
      }
    }
    gameResultPendingRef.current = outcome;
    setMatchOutcome(match);
    setAutoScratch((current) =>
      current.enabled ? { ...current, enabled: false } : current,
    );
    const overlayDelayMs = playGameOutcomeSound(
      symbolAudioRef.current,
      outcome,
      soundEnabledRef.current,
    );
    clearGameResultTimer();
    gameResultTimerRef.current = window.setTimeout(() => {
      gameResultTimerRef.current = null;
      setGameResult(outcome);
    }, overlayDelayMs);
  }
  tryResolveGameRef.current = tryResolveGame;

  function advanceAfterScratch() {
    const finishedId = selectedCardId;
    if (!finishedId) {
      resetScratches();
      return;
    }
    if (!completedCardIdsRef.current.includes(finishedId)) {
      const nextCompleted = [...completedCardIdsRef.current, finishedId];
      completedCardIdsRef.current = nextCompleted;
      setCompletedCardIds(nextCompleted);
    }
    const done = completedCardIdsRef.current;
    const nextCard = playlist.find(
      (entry) => entry.id !== finishedId && !done.includes(entry.id),
    );
    resetGameOutcome();
    claimedRef.current = false;
    setClaimed(false);
    if (!nextCard) {
      setSelectedCardId("");
      return;
    }
    setSelectedCardId(nextCard.id);
    const url = new URL(window.location.href);
    url.searchParams.set("card", nextCard.id);
    window.history.replaceState({}, "", url.toString());
    void loadCardAssets(nextCard.id)
      .then((assets) => {
        revokeObjectUrls();
        return applyLoadedAssets(assets);
      })
      .catch((error) => {
        setLoadError(
          error instanceof Error ? error.message : "Failed to load next card",
        );
      });
  }
  advanceAfterScratchRef.current = advanceAfterScratch;

  function resetScratches() {
    marksRef.current = [];
    lastScratchWorldRef.current = null;
    scratchStartedRef.current = false;
    idleSwayRef.current = { x: 0, y: 0 };
    fgRendererRef.current?.clearScratch();
    setScratchCount(0);
    revealedPointsRef.current = Array.from(
      { length: SYMBOL_POINT_COUNT },
      () => false,
    );
    revealedRef.current = new Array(revealSamplesRef.current.length).fill(
      false,
    );
    revealedCountRef.current = 0;
    autoPathIndexRef.current = 0;
    autoPathProgressRef.current = 0;
    claimedRef.current = false;
    setClaimed(false);
    resetGameOutcome();
    resetMatchRound();
    setRevealedSymbols(0);
    setAutoScratch((current) => ({ ...current, enabled: false }));
  }

  useEffect(() => () => clearGameResultTimer(), []);

  useEffect(() => {
    try {
      localStorage.setItem(
        SOUND_STORAGE_KEY,
        JSON.stringify({ enabled: soundEnabled }),
      );
    } catch {
      // Ignore storage write failures (e.g. private mode / quota).
    }
  }, [soundEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem(
        AUTO_SCRATCH_STORAGE_KEY,
        JSON.stringify(autoScratch),
      );
    } catch {
      // Ignore storage write failures (e.g. private mode / quota).
    }
  }, [autoScratch]);

  async function enableMotion() {
    const ok = await parallax.requestPermission();
    if (!ok) {
      if (parallax.isInsecure) {
        setLoadError(
          "Open https:// on your phone (not http://) and accept the certificate warning.",
        );
      } else if (parallax.isDenied) {
        setLoadError(
          "Motion permission denied — allow Motion & Orientation in Safari settings.",
        );
      } else {
        setLoadError("Could not enable motion sensors.");
      }
      return;
    }
    setLoadError(null);
  }

  function trackFingerParallax(clientX: number, clientY: number) {
    const last = lastPointerRef.current;
    lastPointerRef.current = { x: clientX, y: clientY };
    if (!last) return;
    parallax.addFingerDelta(clientX - last.x, clientY - last.y);
  }

  function onPointerDown(clientX: number, clientY: number) {
    if (soundEnabledRef.current) ensureSymbolAudio(symbolAudioRef.current);
    if (hasBodySymbolsRef.current && topBarPhaseRef.current === "center") {
      return;
    }
    isScratchingRef.current = true;
    scratchStartedRef.current = true;
    setIsScratching(true);
    lastScratchWorldRef.current = null;
    lastPointerRef.current = { x: clientX, y: clientY };
    addScratch(clientX, clientY);
  }

  function onPointerMove(clientX: number, clientY: number) {
    trackFingerParallax(clientX, clientY);
    if (!isScratchingRef.current) return;
    addScratch(clientX, clientY);
  }

  function onPointerUp() {
    isScratchingRef.current = false;
    setIsScratching(false);
    lastScratchWorldRef.current = null;
    lastPointerRef.current = null;
    parallax.releaseFinger();
  }

  const parallaxState = parallaxStateRef.current;
  const symbolsHuntComplete =
    hasBodySymbols && revealedSymbols >= SYMBOL_POINT_COUNT;
  const autoScratchLocked =
    hasBodySymbols &&
    (!symbolsHuntComplete || topBarPhase === "center");
  const remainingCards = playlist.filter(
    (entry) => !completedCardIds.includes(entry.id),
  );
  const activePlaylistLabel =
    playlist.find((entry) => entry.id === selectedCardId)?.label ?? uploadLabel;

  return (
    <main className="app-shell photo-scratch-page">
      <section className="prototype photo-scratch-prototype">
        <aside className="panel photo-scratch-panel">
          <header className="photo-scratch-header">
            <h1>Photo scratch test</h1>
            <p>
              {playlist.length > 0
                ? `${activePlaylistLabel} · ${remainingCards.length}/${playlist.length} left`
                : "Upload pictures, scratch the clothes layer, and drag or tilt to move the scene."}
            </p>
          </header>

          <section className="photo-scratch-flow" aria-label="Scratch flow">
            <h2>Flow</h2>
            <ol>
              <li>
                Upload background, bikini, and clothes — or open with{" "}
                <code>?card=</code>.
              </li>
              <li>Click and drag on the canvas to scratch the clothes off.</li>
              <li>Tap Enable motion for tilt parallax (top bar on phone).</li>
            </ol>
          </section>

          <section
            className="photo-scratch-uploads"
            aria-label="Make from picture"
          >
            <h2>Make from picture</h2>
            <p className="photo-scratch-upload-note">
              Current: <strong>{uploadLabel}</strong>
              {usingSample ? " (room + separated bikini/clothes PNGs)" : ""}
            </p>
            <div className="photo-scratch-upload-grid">
              <label className="photo-scratch-upload-field">
                <span>Full photo (quick test)</span>
                <input
                  accept="image/jpeg,image/png,image/webp"
                  type="file"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (!file) return;
                    void applyFullPhoto(file).catch((error) => {
                      setLoadError(
                        error instanceof Error
                          ? error.message
                          : "Upload failed",
                      );
                    });
                  }}
                />
              </label>
              <label className="photo-scratch-upload-field">
                <span>Background</span>
                <input
                  accept="image/jpeg,image/png,image/webp"
                  type="file"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (!file) return;
                    void applyUploadedLayer("back", file).catch((error) => {
                      setLoadError(
                        error instanceof Error
                          ? error.message
                          : "Upload failed",
                      );
                    });
                  }}
                />
              </label>
              <label className="photo-scratch-upload-field">
                <span>Reveal (bikini)</span>
                <input
                  accept="image/png,image/webp"
                  type="file"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (!file) return;
                    void applyUploadedLayer("mid", file).catch((error) => {
                      setLoadError(
                        error instanceof Error
                          ? error.message
                          : "Upload failed",
                      );
                    });
                  }}
                />
              </label>
              <label className="photo-scratch-upload-field">
                <span>Scratch layer (clothes)</span>
                <input
                  accept="image/png,image/webp"
                  type="file"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (!file) return;
                    void applyUploadedLayer("front", file).catch((error) => {
                      setLoadError(
                        error instanceof Error
                          ? error.message
                          : "Upload failed",
                      );
                    });
                  }}
                />
              </label>
            </div>
            <button
              type="button"
              className="photo-scratch-sample-btn"
              onClick={() => {
                void loadAssetsFromSample()
                  .then(() => resetScratches())
                  .catch((error) => {
                    setLoadError(
                      error instanceof Error
                        ? error.message
                        : "Failed to load sample",
                    );
                  });
              }}
            >
              Load sample assets
            </button>
          </section>

          <section
            className="photo-scratch-layers"
            aria-label="Layer stack"
          >
            <h2>Layers</h2>
            <p className="photo-scratch-upload-note">
              Stack bottom → top. Toggle one off to see what sits underneath.
            </p>
            <div className="photo-scratch-layer-grid">
              {(
                [
                  {
                    id: "bg",
                    label: "1. Background",
                    hint: "room",
                    src: backSrc,
                    on: showLayerBg,
                    set: setShowLayerBg,
                  },
                  {
                    id: "mid",
                    label: "2. Bikini",
                    hint: "mid / reveal",
                    src: midSrc,
                    on: showLayerMid,
                    set: setShowLayerMid,
                  },
                  {
                    id: "clothes",
                    label: "3. Clothes",
                    hint: "top / scratch",
                    src: frontSrc,
                    on: showLayerClothes,
                    set: setShowLayerClothes,
                  },
                ] as const
              ).map((layer) => (
                <label
                  key={layer.id}
                  className={`photo-scratch-layer-card${layer.on ? " is-on" : " is-off"}`}
                >
                  <span className="photo-scratch-layer-thumb">
                    <img src={layer.src} alt="" draggable={false} />
                  </span>
                  <span className="photo-scratch-layer-meta">
                    <span className="photo-scratch-layer-title">
                      {layer.label}
                    </span>
                    <span className="photo-scratch-layer-hint">{layer.hint}</span>
                    <span className="photo-scratch-layer-toggle">
                      <input
                        type="checkbox"
                        checked={layer.on}
                        onChange={(event) => layer.set(event.target.checked)}
                      />
                      {layer.on ? "visible" : "hidden"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="photo-scratch-layer-actions">
              <button
                type="button"
                onClick={() => {
                  setShowLayerBg(true);
                  setShowLayerMid(true);
                  setShowLayerClothes(true);
                }}
              >
                Show all
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowLayerBg(true);
                  setShowLayerMid(false);
                  setShowLayerClothes(false);
                }}
              >
                Solo bg
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowLayerBg(false);
                  setShowLayerMid(true);
                  setShowLayerClothes(false);
                }}
              >
                Solo bikini
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowLayerBg(false);
                  setShowLayerMid(false);
                  setShowLayerClothes(true);
                }}
              >
                Solo clothes
              </button>
            </div>
          </section>

          <div className="photo-scratch-controls">
            {parallax.showEnableButton ? (
              <button
                type="button"
                onClick={() => void enableMotion()}
                disabled={parallax.isPending}
              >
                {parallax.isPending ? "Enabling…" : "Enable motion"}
              </button>
            ) : null}
            {parallax.isActive ? (
              <button type="button" onClick={() => parallax.recalibrate()}>
                Recalibrate
              </button>
            ) : null}
            <button type="button" onClick={() => setShowMesh((v) => !v)}>
              {showMesh ? "Hide mesh" : "Mesh"}
            </button>
            <button type="button" onClick={resetScratches}>
              Reset scratches
            </button>
            <span className="photo-scratch-count">Marks: {scratchCount}</span>
            {hasBodySymbols ? (
              <span className="photo-scratch-count">
                Symbols: {revealedSymbols}/{SYMBOL_POINT_COUNT}
              </span>
            ) : null}
            {playlist.length > 0 ? (
              <span className="photo-scratch-count">
                Left {remainingCards.length}/{playlist.length}
                {claimed ? " · claimed" : ""}
              </span>
            ) : null}
          </div>

          <fieldset className="photo-scratch-settings">
            <legend>Sound</legend>
            <label className="checkbox-label">
              <input
                checked={soundEnabled}
                onChange={(event) =>
                  updateSoundEnabled(event.currentTarget.checked)
                }
                type="checkbox"
              />
              Game sounds
            </label>
          </fieldset>

          <fieldset className="photo-scratch-settings">
            <legend>Auto scratch</legend>
            {autoScratchLocked ? (
              <p className="auto-scratch-hint">
                {topBarPhase === "center"
                  ? "Scratch the top symbols first, then find all symbols on the dress — auto scratch finishes the reveal."
                  : `Find all ${SYMBOL_POINT_COUNT} symbols on the dress first — auto scratch finishes the reveal.`}
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
          </fieldset>

          {loadError ? (
            <p className="photo-scratch-error">{loadError}</p>
          ) : null}

          <div className="photo-scratch-meta">
            <div>
              Phone URL:{" "}
              <code>{pageOrigin ? `${pageOrigin}/photo-scratch` : "…"}</code>
            </div>
            <div>
              Parallax: {motionStatusLabel(parallax.status)} · secure:{" "}
              {typeof window !== "undefined" && window.isSecureContext
                ? "yes"
                : "no"}
            </div>
            {parallax.isActive && parallaxState ? (
              <div>
                group ({parallaxState.group.x.toFixed(1)},{" "}
                {parallaxState.group.y.toFixed(1)})
              </div>
            ) : null}
            {parallax.isInsecure ? (
              <div className="photo-scratch-warn">
                Motion needs HTTPS on your phone.
              </div>
            ) : null}
          </div>
        </aside>

        <div
          ref={stageRef}
          className={`stage photo-scratch-stage${ready ? " is-ready" : ""}${isScratching ? " is-finger-dragging is-scratching" : ""}${showLayerBg ? "" : " is-bg-hidden"}${gameResult ? " is-game-over" : ""}${
            hasBodySymbols && topBarPhase === "center" ? " is-bar-phase" : ""
          }`}
        >
          {hasBodySymbols ? (
            <TopSymbolBar
              symbols={topSymbols}
              phase={topBarPhase}
              roundKey={topBarRound}
              onAllRevealed={onTopBarAllRevealed}
            />
          ) : null}
          <div
            className={`bg-drag-scale${isScratching ? " is-bg-blurred" : ""}`}
            aria-hidden="true"
          >
            <img
              ref={bgImageRef}
              className="layer-bg photo-scratch-bg-layer"
              src={backSrc}
              alt=""
              draggable={false}
            />
          </div>
          <div className="photo-scratch-fg-drag-scale">
            <canvas
              ref={fgCanvasRef}
              className="photo-scratch-fg-layer"
              // Drawing-buffer size is set by GarmentGLRenderer from devicePixelRatio;
              // CSS (width/height 100%) keeps the logical 390×672 stage size.
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              style={{ touchAction: "none", cursor: "crosshair" }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                onPointerDown(event.clientX, event.clientY);
              }}
              onPointerMove={(event) => {
                event.preventDefault();
                onPointerMove(event.clientX, event.clientY);
              }}
              onPointerUp={(event) => {
                event.preventDefault();
                onPointerUp();
              }}
              onPointerCancel={onPointerUp}
            />
            {hasBodySymbols
              ? sessionSymbols.map((typeId, index) => (
                  <div
                    key={`body-symbol-${index}`}
                    ref={(el) => {
                      bodyMarkerRefs.current[index] = el;
                    }}
                    className="body-symbol-marker"
                    style={{ display: "none" }}
                  >
                    <span className="body-symbol-icon">
                      <GameSymbolIcon typeId={typeId} size={42} />
                    </span>
                  </div>
                ))
              : null}
          </div>
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
          {gameResult ? (
            <div
              className={`game-result game-result--${gameResult}`}
              role="status"
              aria-live="polite"
            >
              <p className="game-result-title">
                {gameResult === "win" ? "You win!" : "No luck this time"}
              </p>
              <p className="game-result-detail">
                {matchOutcome
                  ? matchResultDetail(matchOutcome, "diamonds")
                  : gameResult === "win"
                    ? "Three matching symbols — nice!"
                    : "No three-of-a-kind — try again."}
              </p>
              <button
                type="button"
                className="game-result-button"
                onClick={() => advanceAfterScratchRef.current()}
              >
                {remainingCards.length > 1 ? "Next card" : "Done"}
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
