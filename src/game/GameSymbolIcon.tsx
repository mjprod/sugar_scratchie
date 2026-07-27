import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import { SYMBOL_TYPES } from "./matchGame";

/**
 * Color treatment for body icons whose type is NOT in the top bar.
 * Change this in code to recolor unmatched icons — keep the drop-shadows
 * so silhouettes stay readable on both light and dark clothes.
 *
 * Examples:
 *   black:  "grayscale(1) brightness(0)"
 *   charcoal: "grayscale(1) brightness(0.22) contrast(1.15)"
 *   gray:   "grayscale(1) brightness(0.55)"
 */
export const UNMATCHED_SYMBOL_COLOR =
  "grayscale(1) brightness(0) contrast(1.05)";

const UNMATCHED_OUTLINE =
  "drop-shadow(0 0 0.6px rgba(255,255,255,0.95)) drop-shadow(0 0 2px rgba(255,255,255,0.55)) drop-shadow(0 1px 2px rgba(0,0,0,0.35))";

const MATCHED_GLOW =
  "drop-shadow(0 1px 2px rgba(0,0,0,0.4)) drop-shadow(0 0 5px rgba(255,210,120,0.55))";

export function GameSymbolIcon({
  typeId,
  size = 24,
  matched = true,
}: {
  typeId: number;
  size?: number;
  /** When false, icon renders as a black silhouette (see UNMATCHED_SYMBOL_COLOR). */
  matched?: boolean;
}) {
  const entry = SYMBOL_TYPES[typeId] ?? SYMBOL_TYPES[0];
  return (
    // Wrap so the CSS filter hits the Lottie canvas (inline style on DotLottie is unreliable).
    <span
      className={`game-symbol-wrap${matched ? " is-matched" : " is-unmatched"}`}
      style={{
        display: "inline-flex",
        width: size,
        height: size,
        // Unmatched tint — edit UNMATCHED_SYMBOL_COLOR above to change it.
        filter: matched
          ? MATCHED_GLOW
          : `${UNMATCHED_SYMBOL_COLOR} ${UNMATCHED_OUTLINE}`,
        transform: matched ? "scale(1.06)" : "scale(0.9)",
        opacity: matched ? 1 : 0.9,
      }}
    >
      <DotLottieReact
        src={entry.src}
        autoplay={matched}
        loop={matched}
        aria-hidden="true"
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="game-symbol-lottie"
      />
    </span>
  );
}
