import {
  STAGE_WIDTH,
  channelsToStripKeyframes,
  defaultChannelTracks,
  defaultEasing,
  defaultMotionFx,
  DEFAULT_DURATION_MS,
  DEFAULT_END_X,
} from "./engine";
import type {
  ChannelTracks,
  TransitionPreset,
  TransitionTemplate,
  TransitionTemplateId,
} from "./types";

const DEFAULT_CARD_A_ID = "original";
const DEFAULT_CARD_B_ID = "asia_gym";

export function buildShiftLeftPreset(): TransitionPreset {
  const channels = defaultChannelTracks();
  return {
    version: 3,
    pattern: "mirror-slide-strip",
    durationMs: DEFAULT_DURATION_MS,
    cardAId: DEFAULT_CARD_A_ID,
    cardBId: DEFAULT_CARD_B_ID,
    stageWidth: STAGE_WIDTH,
    easing: defaultEasing(),
    motionFx: defaultMotionFx(),
    channels,
    keyframes: channelsToStripKeyframes(channels),
  };
}

/** Shift-left slide with mid-transition Y bounce + scale/brightness pulse. */
export function buildBounceOutPreset(): TransitionPreset {
  const channels: ChannelTracks = {
    x: [
      { t: 0, value: 0 },
      { t: 1, value: DEFAULT_END_X },
    ],
    y: [
      { t: 0, value: 0 },
      { t: 0.1, value: 0 },
      { t: 0.2627, value: -19.64 },
      { t: 0.302, value: 26.79 },
      { t: 0.3415, value: -19.64 },
      { t: 0.4094, value: 32.12 },
      { t: 0.4998, value: -27.59 },
      { t: 0.6, value: 0 },
      { t: 1, value: 0 },
    ],
    scale: [
      { t: 0, value: 1 },
      { t: 0.1004, value: 1 },
      { t: 0.2389, value: 1.11 },
      { t: 0.5011, value: 1.11 },
      { t: 0.7029, value: 1 },
      { t: 1, value: 1 },
    ],
    blur: [
      { t: 0, value: 0 },
      { t: 1, value: 0 },
    ],
    brightness: [
      { t: 0, value: 1 },
      { t: 0.0785, value: 1.004 },
      { t: 0.2136, value: 1.111 },
      { t: 0.5598, value: 1.648 },
      { t: 0.8625, value: 1 },
      { t: 1, value: 1 },
    ],
    opacity: [
      { t: 0, value: 1 },
      { t: 1, value: 1 },
    ],
  };
  return {
    version: 3,
    pattern: "mirror-slide-strip",
    durationMs: 750,
    cardAId: DEFAULT_CARD_A_ID,
    cardBId: DEFAULT_CARD_B_ID,
    stageWidth: STAGE_WIDTH,
    easing: defaultEasing(),
    motionFx: {
      ...defaultMotionFx(),
      blurPeak: 4,
    },
    channels,
    keyframes: channelsToStripKeyframes(channels),
  };
}

/** Hold, then slide left with a mid-transition scale punch. */
export function buildZoomUpPreset(): TransitionPreset {
  const channels: ChannelTracks = {
    x: [
      { t: 0, value: 0 },
      { t: 0.1606, value: 0 },
      { t: 1, value: DEFAULT_END_X },
    ],
    y: [
      { t: 0, value: 0 },
      { t: 1, value: 0 },
    ],
    scale: [
      { t: 0, value: 1 },
      { t: 0.3007, value: 1 },
      { t: 0.5985, value: 1.385 },
      { t: 0.7833, value: 1 },
      { t: 1, value: 1 },
    ],
    blur: [
      { t: 0, value: 0 },
      { t: 1, value: 0 },
    ],
    brightness: [
      { t: 0, value: 1 },
      { t: 1, value: 1 },
    ],
    opacity: [
      { t: 0, value: 1 },
      { t: 1, value: 1 },
    ],
  };
  return {
    version: 3,
    pattern: "mirror-slide-strip",
    durationMs: 850,
    cardAId: DEFAULT_CARD_A_ID,
    cardBId: DEFAULT_CARD_B_ID,
    stageWidth: STAGE_WIDTH,
    easing: {
      x1: 0.793,
      y1: -0.013,
      x2: 0.44,
      y2: 1.14,
    },
    motionFx: {
      ...defaultMotionFx(),
      blurPeak: 3.5,
      blur: { startPct: 19, stopPct: 99 },
    },
    channels,
    keyframes: channelsToStripKeyframes(channels),
  };
}

export const TRANSITION_TEMPLATES: TransitionTemplate[] = [
  {
    id: "shift-left",
    label: "Shift left",
    preset: buildShiftLeftPreset(),
  },
  {
    id: "bounceout",
    label: "Bounce out",
    preset: buildBounceOutPreset(),
  },
  {
    id: "zoomup",
    label: "Zoom up",
    preset: buildZoomUpPreset(),
  },
];

/** Cycle order for between-game advances. */
export const GAME_TRANSITION_CYCLE: TransitionTemplateId[] = [
  "shift-left",
  "bounceout",
  "zoomup",
];

export function getTemplate(
  id: string,
): TransitionTemplate | null {
  return TRANSITION_TEMPLATES.find((entry) => entry.id === id) ?? null;
}

export function nextTemplateId(
  index: number,
): { id: TransitionTemplateId; nextIndex: number } {
  const safe = ((index % GAME_TRANSITION_CYCLE.length) + GAME_TRANSITION_CYCLE.length) %
    GAME_TRANSITION_CYCLE.length;
  return {
    id: GAME_TRANSITION_CYCLE[safe],
    nextIndex: (safe + 1) % GAME_TRANSITION_CYCLE.length,
  };
}
