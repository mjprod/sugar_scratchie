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
  auroraC: string;
  auroraSpeed: number;
  auroraBlend: number;
  auroraAmplitude: number;
  auroraBandHeight: number;
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
    label: "Claim reward",
    width: 240,
    height: 64,
    cornerRadius: 18,
    strokeWidth: 1,
    strokeColor: "rgba(255, 255, 255, 0.22)",
    auroraA: "#aa3c6b",
    auroraB: "#e16060",
    auroraC: "#66004d",
    auroraSpeed: 1.2,
    auroraBlend: 0.37,
    auroraAmplitude: 0.8,
    auroraBandHeight: 1.35,
    auroraBaseColor: "#42001b",
    particleCount: 10,
    particleSize: 0.029,
    particleSpeed: 1.5,
    particleOpacity: 0.37,
    particleColor: "#dd8187",
    particleTwinkle: 0.24,
    labelColor: "#ffffff",
    fontSize: 18,
    glowEnabled: true,
    glowAlwaysOn: true,
    glowEdgeSensitivity: 12,
    glowColor: "40 80 80",
    glowRadius: 18,
    glowIntensity: 0.4,
    glowConeSpread: 22,
    glowFillOpacity: 0.13,
    glowOrbitSpeed: 69,
    glowAlwaysOnProximity: 94,
    glowA: "#e5616e",
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
