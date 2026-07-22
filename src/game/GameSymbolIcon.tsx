import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import { SYMBOL_TYPES } from "./matchGame";

export function GameSymbolIcon({
  typeId,
  size = 24,
}: {
  typeId: number;
  size?: number;
}) {
  const entry = SYMBOL_TYPES[typeId] ?? SYMBOL_TYPES[0];
  return (
    <DotLottieReact
      src={entry.src}
      autoplay
      loop
      aria-hidden="true"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="game-symbol-lottie"
    />
  );
}
