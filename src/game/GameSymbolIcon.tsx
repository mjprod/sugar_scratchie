import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import type { DotLottie } from "@lottiefiles/dotlottie-web";
import { useEffect, useState } from "react";
import { SYMBOL_TYPES } from "./matchGame";

// NOTE: do not pass a `renderConfig` here without measuring first. Capping
// devicePixelRatio looks like an easy win — up to eighteen of these play at
// once and they dominate the CPU profile — but the library only defaults
// devicePixelRatio and freezeOnOffscreen, so any config you supply must also
// carry autoResize, and enabling that grows the body icons' backing store
// (~84x84 to ~114x114) and costs more than the DPR cap saves.
export function GameSymbolIcon({
  typeId,
  size = 24,
  paused = false,
}: {
  typeId: number;
  size?: number;
  /**
   * Hold the animation on its current frame. The entrance "pop" is a CSS
   * keyframe on `.body-symbol-icon`, not part of the Lottie, so a held symbol
   * still appears normally — it just stops burning frames.
   */
  paused?: boolean;
}) {
  const entry = SYMBOL_TYPES[typeId] ?? SYMBOL_TYPES[0];
  const [player, setPlayer] = useState<DotLottie | null>(null);

  useEffect(() => {
    // The ref callback fires before the animation finishes loading, and
    // isLoaded is not reactive. Skipping while it loads is deliberate: a symbol
    // revealed mid-scratch gets to run its loop for the rest of that stroke
    // rather than freezing on a frame it has never drawn.
    if (!player?.isLoaded) return;
    if (paused) player.pause();
    else player.play();
  }, [player, paused]);

  return (
    <DotLottieReact
      key={entry.src}
      src={entry.src}
      autoplay
      loop
      // Interpolation makes each player emit a freshly interpolated frame on
      // every display refresh — 120/s here — for source animations that only
      // hold ~30fps of real motion. At icon size the frame-stepping is
      // invisible. This is a Config prop, not renderConfig, so it avoids the
      // autoResize trap described above.
      useFrameInterpolation={false}
      dotLottieRefCallback={setPlayer}
      aria-hidden="true"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="game-symbol-lottie"
    />
  );
}
