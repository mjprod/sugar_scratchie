/**
 * @lottiefiles/dotlottie-web defaults to `1 + (dpr - 1) * 0.75`, which leaves
 * canvases soft on retina. Pass this value as `renderConfig.devicePixelRatio`.
 *
 * `extraScale` covers CSS transforms that enlarge the bitmap after render
 * (peel pop, swipe stamp, match-fly). Applied after the screen-DPR cap so a
 * 2.2× animation on a 2× display is not crushed back down to 3.
 */
const MAX_SCREEN_DPR = 3;

export function lottieDevicePixelRatio(extraScale = 1): number {
  if (typeof window === "undefined") return Math.max(1, extraScale);
  const screen = Math.min(MAX_SCREEN_DPR, Math.max(1, window.devicePixelRatio || 1));
  return Math.max(1, screen * extraScale);
}

export function lottieRenderConfig(options?: {
  extraScale?: number;
  autoResize?: boolean;
  freezeOnOffscreen?: boolean;
}) {
  return {
    devicePixelRatio: lottieDevicePixelRatio(options?.extraScale ?? 1),
    autoResize: options?.autoResize ?? true,
    freezeOnOffscreen: options?.freezeOnOffscreen ?? true,
    quality: 100,
  };
}
