/** CSS-style cubic-bezier control points. */
export type CubicBezier = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type StripProps = {
  x: number;
  y: number;
  scale: number;
  blur: number;
  /** CSS brightness multiplier (1 = normal). */
  brightness: number;
  opacity: number;
};

export type FxWindow = {
  /** 0–100: % of transition duration when this FX begins. */
  startPct: number;
  /** 0–100: % of transition duration when this FX fully ends. */
  stopPct: number;
};

export type MotionFxSettings = {
  enabled: boolean;
  blurPeak: number;
  blur: FxWindow;
  /** Peak uniform scale (1 = none). Pulses up then back to 1. */
  scalePeak: number;
  scale: FxWindow;
};

/** Legacy combined strip keyframe (v1/v2 export + import). */
export type TransitionKeyframe = {
  t: number;
  strip: StripProps;
};

/** Independent scalar key on one transform channel. */
export type ChannelKeyframe = {
  t: number;
  value: number;
};

export type StripChannelKey = keyof StripProps;
export type ChannelKey = StripChannelKey;
export type ChannelTracks = Record<ChannelKey, ChannelKeyframe[]>;

export type TransitionPattern = "mirror-slide-strip";

export type TransitionPreset = {
  version: 2 | 3;
  pattern: TransitionPattern;
  durationMs: number;
  cardAId: string;
  cardBId: string;
  stageWidth: number;
  easing?: CubicBezier;
  motionFx?: MotionFxSettings;
  /** Preferred v3: independent channel tracks. */
  channels?: ChannelTracks;
  /** Legacy v2 combined strip keys (still exported for compatibility). */
  keyframes: TransitionKeyframe[];
};

export type TransitionTemplateId = "shift-left" | "bounceout" | "zoomup";

export type TransitionTemplate = {
  id: TransitionTemplateId;
  label: string;
  preset: TransitionPreset;
};
