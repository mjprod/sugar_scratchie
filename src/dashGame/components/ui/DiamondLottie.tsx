import type { CSSProperties } from "react";
import { DeferredLottie } from "@/lib/lottie/DeferredLottie";
import { lottieRenderConfig } from "@/utils/lottieRender";

export const DIAMOND_LOTTIE_SRC = "/lottie/lottieDiamond.lottie";
/** Still mark — 512² export from the Lottie (was a 31² thumbnail). */
export const DIAMOND_MARK_WEBP = "/images/diamond_min.webp?v=512";
export const DIAMOND_MARK_PNG = "/images/diamond_min.png?v=512";

type DiamondLottieProps = {
  className?: string;
  /** Square edge length in CSS px (or any CSS length). Default 1em so it tracks text. */
  size?: number | string;
  loop?: boolean;
  autoplay?: boolean;
  /** Playback multiplier. Default 1.25. */
  speed?: number;
  /** Mount the wasm player. Default false — static WebP/PNG mark. */
  animated?: boolean;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
};

function StaticDiamondMark() {
  return (
    <picture>
      <source srcSet={DIAMOND_MARK_WEBP} type="image/webp" />
      <img
        src={DIAMOND_MARK_PNG}
        alt=""
        draggable={false}
        style={{ width: "100%", height: "100%", display: "block", objectFit: "contain" }}
      />
    </picture>
  );
}

/**
 * Inline diamond mark. Decorative icons use WebP (PNG fallback);
 * pass `animated` for the looping Lottie (top nav).
 */
export function DiamondLottie({
  className,
  size = "1em",
  loop = true,
  autoplay = true,
  speed = 1.25,
  animated = false,
  style,
  "aria-hidden": ariaHidden = true,
}: DiamondLottieProps) {
  const edge =
    typeof size === "number" ? `${size * 1.3}px` : `calc(${size} * 1.3)`;

  return (
    <span
      className={["diamond-lottie", className].filter(Boolean).join(" ")}
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: edge,
        height: edge,
        flex: "0 0 auto",
        lineHeight: 0,
        verticalAlign: "middle",
        ...style,
      }}
      aria-hidden={ariaHidden}
    >
      {animated ? (
        <DeferredLottie
          fallback={<StaticDiamondMark />}
          src={DIAMOND_LOTTIE_SRC}
          autoplay={autoplay}
          loop={loop}
          speed={speed}
          renderConfig={lottieRenderConfig()}
          style={{ width: "100%", height: "100%" }}
        />
      ) : (
        <StaticDiamondMark />
      )}
    </span>
  );
}
