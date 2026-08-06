/**
 * Named CTA presets for the button-test lab.
 * Add a new entry here when starting work on the next button style.
 */

export type CtaTemplateId = "squircleCTA";

export type CtaTemplateValues = {
  label: string;
  width: number;
  height: number;
  cornerRadius: number;
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
    width: 338,
    height: 69,
    cornerRadius: 11,
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

export const CTA_TEMPLATES: readonly CtaTemplate[] = [SQUIRCLE_CTA];

export const DEFAULT_CTA_TEMPLATE_ID: CtaTemplateId = "squircleCTA";

export function getCtaTemplate(id: CtaTemplateId): CtaTemplate {
  const found = CTA_TEMPLATES.find((t) => t.id === id);
  if (!found) return SQUIRCLE_CTA;
  return found;
}

export function cloneTemplateValues(id: CtaTemplateId): CtaTemplateValues {
  return { ...getCtaTemplate(id).values };
}
