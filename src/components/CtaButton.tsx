import type { ButtonHTMLAttributes, CSSProperties } from "react";

import Aurora from "./Aurora";
import BorderGlow from "./BorderGlow";

export type CtaShape = "squircle" | "hex";

export type CtaButtonProps = {
  label?: string;
  /** Optional secondary cost row under the title. Empty / null hides the row. */
  costAmount?: string | number | null;
  /** Shown after costAmount (emoji or short glyph). */
  costIcon?: string;
  /** Clip silhouette. Default soft rounded rect. */
  shape?: CtaShape;
  width?: number;
  height?: number;
  /** Squircle corner roundness (ignored by hex silhouette). */
  cornerRadius?: number;
  /**
   * Hex only: tip depth as a fraction of height (higher = longer points).
   * Default 0.27.
   */
  hexTip?: number;
  strokeWidth?: number;
  strokeColor?: string;
  /** Four aurora ramp stops: A, B, mid (between B & C), C. */
  auroraColorStops?: [string, string, string, string];
  auroraSpeed?: number;
  auroraBlend?: number;
  auroraAmplitude?: number;
  /** Vertical fill of aurora bands (1 = stock, higher = fills more of the button). */
  auroraBandHeight?: number;
  /** Rotate the aurora field in degrees (e.g. 45 for a diagonal look). */
  auroraRotation?: number;
  /** Color behind transparent aurora pixels (the “black” plate). */
  auroraBaseColor?: string;
  /** Soft circle particles inside the aurora shader pass. */
  particleCount?: number;
  particleSize?: number;
  particleSpeed?: number;
  particleOpacity?: number;
  particleColor?: string;
  particleTwinkle?: number;
  labelColor?: string;
  fontSize?: number;
  forceHover?: boolean;
  forcePressed?: boolean;
  /** Border glow (mesh rim + outer bloom). */
  glowEnabled?: boolean;
  /** Continuous orbit — no hover required. */
  glowAlwaysOn?: boolean;
  glowEdgeSensitivity?: number;
  glowColor?: string;
  glowRadius?: number;
  glowIntensity?: number;
  glowConeSpread?: number;
  glowFillOpacity?: number;
  glowOrbitSpeed?: number;
  glowAlwaysOnProximity?: number;
  glowColors?: [string, string, string];
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;

const DEFAULT_AURORA: [string, string, string, string] = [
  "#aa3c6b",
  "#ea2e89",
  "#42001b",
  "#933e4c",
];
const DEFAULT_GLOW_COLORS: [string, string, string] = ["#8c2c3f", "#ce3e78", "#aa3c6b"];

export function CtaButton({
  label = "Start Playing",
  costAmount = null,
  costIcon = "💎",
  shape = "squircle",
  width = 338,
  height = 69,
  cornerRadius = 11,
  hexTip = 0.27,
  strokeWidth = 1,
  strokeColor = "rgba(255, 255, 255, 0.22)",
  auroraColorStops = DEFAULT_AURORA,
  auroraSpeed = 0.7,
  auroraBlend = 1,
  auroraAmplitude = 1.7,
  auroraBandHeight = 1.2,
  auroraRotation = 17,
  auroraBaseColor = "#42001b",
  particleCount = 12,
  particleSize = 0.03,
  particleSpeed = 1.55,
  particleOpacity = 0.37,
  particleColor = "#fb4b97",
  particleTwinkle = 0.24,
  labelColor = "#ffe0e8",
  fontSize = 18,
  forceHover = false,
  forcePressed = false,
  glowEnabled = true,
  glowAlwaysOn = true,
  glowEdgeSensitivity = 15,
  glowColor = "326 90 30",
  glowRadius = 40,
  glowIntensity = 0.95,
  glowConeSpread = 28,
  glowFillOpacity = 0.13,
  glowOrbitSpeed = 103,
  glowAlwaysOnProximity = 94,
  glowColors = DEFAULT_GLOW_COLORS,
  disabled = false,
  className,
  type = "button",
  style,
  ...buttonProps
}: CtaButtonProps) {
  const stroke = Math.max(0, strokeWidth);
  const radius = Math.max(0, Math.min(cornerRadius, Math.min(width, height) / 2));
  // Keep inner corners concentric with the outer shape after the stroke inset.
  const innerRadius = Math.max(0, radius - stroke);
  const tipRatio = Math.max(0.12, Math.min(0.55, hexTip));
  const tipPx = height * tipRatio;
  const innerTipPx = Math.max(0, tipPx - stroke * 0.85);
  const showCost =
    costAmount != null && costAmount !== "" && !(typeof costAmount === "number" && Number.isNaN(costAmount));
  const costText = showCost ? String(costAmount) : "";

  const cssVars = {
    "--cta-w": `${width}px`,
    "--cta-h": `${height}px`,
    "--cta-r": `${radius}px`,
    "--cta-inner-r": `${innerRadius}px`,
    "--cta-tip": `${tipPx}px`,
    "--cta-inner-tip": `${innerTipPx}px`,
    "--cta-stroke": `${stroke}px`,
    "--cta-stroke-color": strokeColor,
    "--cta-aurora-base": auroraBaseColor,
    "--cta-label-color": labelColor,
    "--cta-font-size": `${fontSize}px`,
  } as CSSProperties;

  const classes = [
    "cta-button",
    `cta-button--${shape}`,
    glowEnabled ? "is-glow-on" : "is-glow-off",
    forceHover ? "is-force-hover" : "",
    forcePressed ? "is-force-pressed" : "",
    disabled ? "is-disabled" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const button = (
    <button
      {...buttonProps}
      type={type}
      disabled={disabled}
      className={classes}
      style={{ ...cssVars, ...style }}
      // Extra iOS guard: prevent long-press selection / callout on the control.
      onContextMenu={(event) => {
        event.preventDefault();
        buttonProps.onContextMenu?.(event);
      }}
    >
      <span className="cta-button__inner">
        <span className="cta-button__aurora" aria-hidden="true">
          <Aurora
            colorStops={auroraColorStops}
            speed={disabled ? 0 : auroraSpeed}
            blend={auroraBlend}
            amplitude={auroraAmplitude}
            bandHeight={auroraBandHeight}
            rotation={auroraRotation}
            particleCount={disabled ? 0 : particleCount}
            particleSize={particleSize}
            particleSpeed={disabled ? 0 : particleSpeed}
            particleOpacity={particleOpacity}
            particleColor={particleColor}
            particleTwinkle={disabled ? 0 : particleTwinkle}
            paused={disabled}
          />
        </span>
        <span className="cta-button__face" aria-hidden="true" />
        <span className="cta-button__label">
          <span className="cta-button__title">{label}</span>
          {showCost ? (
            <span className="cta-button__cost">
              <span className="cta-button__cost-amount">{costText}</span>
              {costIcon ? (
                <span className="cta-button__cost-icon" aria-hidden="true">
                  {costIcon}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );

  if (!glowEnabled) return button;

  return (
    <BorderGlow
      bare
      className={[
        "cta-button-glow",
        `cta-button-glow--${shape}`,
        disabled ? "is-disabled" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      alwaysOn={glowAlwaysOn && !disabled}
      disabled={disabled}
      edgeSensitivity={glowEdgeSensitivity}
      glowColor={glowColor}
      backgroundColor="transparent"
      borderRadius={radius}
      glowRadius={glowRadius}
      glowIntensity={disabled ? 0 : glowIntensity}
      coneSpread={glowConeSpread}
      fillOpacity={disabled ? 0 : glowFillOpacity}
      orbitSpeed={disabled ? 0 : glowOrbitSpeed}
      alwaysOnProximity={disabled ? 0 : glowAlwaysOnProximity}
      colors={glowColors}
      animated={false}
      shape={shape === "hex" ? "hex" : "rounded-rect"}
      shapeWidth={width}
      shapeHeight={height}
      hexTip={tipRatio}
    >
      {button}
    </BorderGlow>
  );
}
