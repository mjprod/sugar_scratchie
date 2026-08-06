/**
 * Named CTA presets for the button-test lab.
 * Add a new entry here when starting work on the next button style.
 */

import type { CtaShape } from "./CtaButton";

export type CtaTemplateId = "squircleCTA" | "hexGoldCTA";

export type CtaTemplateValues = {
  label: string;
  /** Empty string hides the cost row. */
  costAmount: string;
  costIcon: string;
  shape: CtaShape;
  width: number;
  height: number;
  cornerRadius: number;
  /** Hex tip depth as a fraction of height. */
  hexTip: number;
  strokeWidth: number;
  strokeColor: string;
  auroraA: string;
  auroraB: string;
  /** Extra stop between B and C. */
  auroraMid: string;
  auroraC: string;
  auroraSpeed: number;
  auroraBlend: number;
  auroraAmplitude: number;
  auroraBandHeight: number;
  auroraRotation: number;
  auroraBaseColor: string;
  particleCount: number;
  particleSize: number;
  particleSpeed: number;
  particleOpacity: number;
  particleColor: string;
  particleTwinkle: number;
  labelColor: string;
  fontSize: number;
  glowEnabled: boolean;
  glowAlwaysOn: boolean;
  glowEdgeSensitivity: number;
  glowColor: string;
  glowRadius: number;
  glowIntensity: number;
  glowConeSpread: number;
  glowFillOpacity: number;
  glowOrbitSpeed: number;
  glowAlwaysOnProximity: number;
  glowA: string;
  glowB: string;
  glowC: string;
};

export type CtaTemplate = {
  id: CtaTemplateId;
  name: string;
  description: string;
  values: CtaTemplateValues;
};

/** Soft rounded rect + aurora face + always-on border glow. */
export const SQUIRCLE_CTA: CtaTemplate = {
  id: "squircleCTA",
  name: "Squircle CTA",
  description: "Soft rounded rect with aurora fill and orbiting border glow.",
  values: {
    label: "Start Playing",
    costAmount: "",
    costIcon: "💎",
    shape: "squircle",
    width: 338,
    height: 69,
    cornerRadius: 16,
    hexTip: 0.27,
    strokeWidth: 1,
    strokeColor: "rgba(255, 255, 255, 0.22)",
    auroraA: "#aa3c6b",
    auroraB: "#ea2e89",
    auroraMid: "#42001b",
    auroraC: "#933e4c",
    auroraSpeed: 0.7,
    auroraBlend: 1,
    auroraAmplitude: 1.7,
    auroraBandHeight: 1.2,
    auroraRotation: 17,
    auroraBaseColor: "#42001b",
    particleCount: 12,
    particleSize: 0.03,
    particleSpeed: 1.55,
    particleOpacity: 0.37,
    particleColor: "#fb4b97",
    particleTwinkle: 0.24,
    labelColor: "#ffe0e8",
    fontSize: 18,
    glowEnabled: true,
    glowAlwaysOn: true,
    glowEdgeSensitivity: 15,
    glowColor: "326 90 30",
    glowRadius: 40,
    glowIntensity: 0.95,
    glowConeSpread: 28,
    glowFillOpacity: 0.13,
    glowOrbitSpeed: 103,
    glowAlwaysOnProximity: 94,
    glowA: "#8c2c3f",
    glowB: "#ce3e78",
    glowC: "#aa3c6b",
  },
};

/** Pointed hex badge + gold aurora — Open Pack style. */
export const HEX_GOLD_CTA: CtaTemplate = {
  id: "hexGoldCTA",
  name: "Hex Gold CTA",
  description: "Pointed hexagon badge with gold aurora fill, cost row, and warm border glow.",
  values: {
    label: "OPEN PACK",
    costAmount: "10",
    costIcon: "💎",
    shape: "hex",
    width: 280,
    height: 95,
    cornerRadius: 0,
    hexTip: 0.27,
    strokeWidth: 3,
    strokeColor: "rgba(255, 236, 180, 0.55)",
    auroraA: "#ffd080",
    auroraB: "#3d2808",
    auroraMid: "#3d2808",
    auroraC: "#ffbc70",
    auroraSpeed: 0.95,
    auroraBlend: 0.58,
    auroraAmplitude: 0.8,
    auroraBandHeight: 1.4,
    auroraRotation: 16,
    auroraBaseColor: "#3d2808",
    particleCount: 10,
    particleSize: 0.025,
    particleSpeed: 2.95,
    particleOpacity: 0.48,
    particleColor: "#fff1c2",
    particleTwinkle: 0.62,
    labelColor: "#fff8e6",
    fontSize: 17,
    glowEnabled: true,
    glowAlwaysOn: true,
    glowEdgeSensitivity: 51,
    glowColor: "42 95 58",
    glowRadius: 24,
    glowIntensity: 0.9,
    glowConeSpread: 28,
    glowFillOpacity: 0,
    glowOrbitSpeed: 74,
    glowAlwaysOnProximity: 92,
    glowA: "#d37217",
    glowB: "#ff9c66",
    glowC: "#ff9f1a",
  },
};

export const CTA_TEMPLATES: readonly CtaTemplate[] = [SQUIRCLE_CTA, HEX_GOLD_CTA];

export const DEFAULT_CTA_TEMPLATE_ID: CtaTemplateId = "squircleCTA";

export function getCtaTemplate(id: CtaTemplateId): CtaTemplate {
  const found = CTA_TEMPLATES.find((t) => t.id === id);
  if (!found) return SQUIRCLE_CTA;
  return found;
}

export function cloneTemplateValues(id: CtaTemplateId): CtaTemplateValues {
  return { ...getCtaTemplate(id).values };
}
