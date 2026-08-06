import { useEffect, useMemo, useRef, useState } from "react";

import { CtaButton } from "./components/CtaButton";
import {
  cloneTemplateValues,
  CTA_TEMPLATES,
  DEFAULT_CTA_TEMPLATE_ID,
  getCtaTemplate,
  type CtaTemplateId,
  type CtaTemplateValues,
} from "./components/ctaTemplates";

type CtaDebugState = CtaTemplateValues & {
  forceHover: boolean;
  forcePressed: boolean;
  disabled: boolean;
};

function stateFromTemplate(id: CtaTemplateId): CtaDebugState {
  return {
    ...cloneTemplateValues(id),
    forceHover: false,
    forcePressed: false,
    disabled: false,
  };
}

function formatTsValue(value: string | number | boolean): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/** Paste into ctaTemplates.ts values block for the active template. */
function formatTemplateValuesSnippet(templateId: CtaTemplateId, state: CtaDebugState): string {
  const { forceHover: _h, forcePressed: _p, disabled: _d, ...values } = state;
  void _h;
  void _p;
  void _d;
  const lines = Object.entries(values).map(
    ([key, value]) => `    ${key}: ${formatTsValue(value as string | number | boolean)},`,
  );
  return `// ${templateId} values\n{\n${lines.join("\n")}\n}`;
}

/** Paste into CtaButton default parameter values + DEFAULT_AURORA / DEFAULT_GLOW_COLORS */
function formatCtaButtonDefaultsSnippet(state: CtaDebugState): string {
  return [
    `const DEFAULT_AURORA: [string, string, string] = [${JSON.stringify(state.auroraA)}, ${JSON.stringify(state.auroraB)}, ${JSON.stringify(state.auroraC)}];`,
    `const DEFAULT_GLOW_COLORS: [string, string, string] = [${JSON.stringify(state.glowA)}, ${JSON.stringify(state.glowB)}, ${JSON.stringify(state.glowC)}];`,
    "",
    "// CtaButton default params:",
    `label = ${JSON.stringify(state.label)},`,
    `width = ${state.width},`,
    `height = ${state.height},`,
    `cornerRadius = ${state.cornerRadius},`,
    `strokeWidth = ${state.strokeWidth},`,
    `strokeColor = ${JSON.stringify(state.strokeColor)},`,
    `auroraColorStops = DEFAULT_AURORA,`,
    `auroraSpeed = ${state.auroraSpeed},`,
    `auroraBlend = ${state.auroraBlend},`,
    `auroraAmplitude = ${state.auroraAmplitude},`,
    `auroraBandHeight = ${state.auroraBandHeight},`,
    `auroraBaseColor = ${JSON.stringify(state.auroraBaseColor)},`,
    `labelColor = ${JSON.stringify(state.labelColor)},`,
    `fontSize = ${state.fontSize},`,
    `glowEnabled = ${state.glowEnabled},`,
    `glowAlwaysOn = ${state.glowAlwaysOn},`,
    `glowEdgeSensitivity = ${state.glowEdgeSensitivity},`,
    `glowColor = ${JSON.stringify(state.glowColor)},`,
    `glowRadius = ${state.glowRadius},`,
    `glowIntensity = ${state.glowIntensity},`,
    `glowConeSpread = ${state.glowConeSpread},`,
    `glowFillOpacity = ${state.glowFillOpacity},`,
    `glowOrbitSpeed = ${state.glowOrbitSpeed},`,
    `glowAlwaysOnProximity = ${state.glowAlwaysOnProximity},`,
    `glowColors = DEFAULT_GLOW_COLORS,`,
  ].join("\n");
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

type NumberSlider = {
  key: keyof CtaDebugState;
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
};

const SIZE_SLIDERS: NumberSlider[] = [
  { key: "width", label: "Width", min: 120, max: 420, step: 1, format: (v) => `${v}px` },
  { key: "height", label: "Height", min: 40, max: 120, step: 1, format: (v) => `${v}px` },
  { key: "cornerRadius", label: "Corner radius", min: 0, max: 60, step: 1, format: (v) => `${v}px` },
  { key: "strokeWidth", label: "Stroke width", min: 0, max: 10, step: 0.5, format: (v) => `${v}px` },
];

const AURORA_SLIDERS: NumberSlider[] = [
  { key: "auroraSpeed", label: "Speed", min: 0, max: 3, step: 0.05, format: (v) => v.toFixed(2) },
  { key: "auroraBlend", label: "Blend", min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "auroraAmplitude", label: "Amplitude", min: 0, max: 2.5, step: 0.05, format: (v) => v.toFixed(2) },
  {
    key: "auroraBandHeight",
    label: "Band height",
    min: 0.4,
    max: 4,
    step: 0.05,
    format: (v) => `${v.toFixed(2)}×`,
  },
];

const LABEL_SLIDERS: NumberSlider[] = [
  { key: "fontSize", label: "Font size", min: 12, max: 32, step: 1, format: (v) => `${v}px` },
];

const GLOW_SLIDERS: NumberSlider[] = [
  {
    key: "glowEdgeSensitivity",
    label: "Edge sensitivity",
    min: 0,
    max: 80,
    step: 1,
    format: (v) => String(v),
  },
  {
    key: "glowRadius",
    label: "Glow radius",
    min: 0,
    max: 80,
    step: 1,
    format: (v) => `${v}px`,
  },
  {
    key: "glowIntensity",
    label: "Intensity",
    min: 0.1,
    max: 3,
    step: 0.05,
    format: (v) => v.toFixed(2),
  },
  {
    key: "glowConeSpread",
    label: "Cone spread",
    min: 5,
    max: 45,
    step: 1,
    format: (v) => String(v),
  },
  {
    key: "glowFillOpacity",
    label: "Fill opacity",
    min: 0,
    max: 1,
    step: 0.01,
    format: (v) => v.toFixed(2),
  },
  {
    key: "glowOrbitSpeed",
    label: "Orbit speed",
    min: 0,
    max: 180,
    step: 1,
    format: (v) => `${v}°/s`,
  },
  {
    key: "glowAlwaysOnProximity",
    label: "Always-on proximity",
    min: 50,
    max: 100,
    step: 1,
    format: (v) => String(v),
  },
];

function SliderRow({
  def,
  value,
  onChange,
}: {
  def: NumberSlider;
  value: number;
  onChange: (value: number) => void;
}) {
  const display = def.format ? def.format(value) : String(value);
  return (
    <label className="button-test-slider">
      <span className="button-test-slider-label">
        <span>{def.label}</span>
        <strong>{display}</strong>
      </span>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function ButtonTestPage() {
  const [templateId, setTemplateId] = useState<CtaTemplateId>(DEFAULT_CTA_TEMPLATE_ID);
  const [state, setState] = useState<CtaDebugState>(() => stateFromTemplate(DEFAULT_CTA_TEMPLATE_ID));
  const [clickCount, setClickCount] = useState(0);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const activeTemplate = useMemo(() => getCtaTemplate(templateId), [templateId]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const patch = <K extends keyof CtaDebugState>(key: K, value: CtaDebugState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }));
  };

  const applyTemplate = (id: CtaTemplateId) => {
    setTemplateId(id);
    setState(stateFromTemplate(id));
    setClickCount(0);
  };

  const flashCopyStatus = (message: string) => {
    setCopyStatus(message);
    if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setCopyStatus(null);
      copyTimerRef.current = null;
    }, 2200);
  };

  const handleCopyTemplateValues = async () => {
    const ok = await copyText(formatTemplateValuesSnippet(templateId, state));
    flashCopyStatus(ok ? `Copied ${templateId} values` : "Copy failed");
  };

  const handleCopyCtaDefaults = async () => {
    const ok = await copyText(formatCtaButtonDefaultsSnippet(state));
    flashCopyStatus(ok ? "Copied CtaButton defaults" : "Copy failed");
  };

  const handleCopyJson = async () => {
    const ok = await copyText(JSON.stringify(state, null, 2));
    flashCopyStatus(ok ? "Copied JSON values" : "Copy failed");
  };

  const auroraStops = useMemo(
    () => [state.auroraA, state.auroraB, state.auroraC] as [string, string, string],
    [state.auroraA, state.auroraB, state.auroraC],
  );

  const glowStops = useMemo(
    () => [state.glowA, state.glowB, state.glowC] as [string, string, string],
    [state.glowA, state.glowB, state.glowC],
  );

  const status = state.disabled
    ? "disabled"
    : state.forcePressed
      ? "force pressed"
      : state.forceHover
        ? "force hover"
        : clickCount > 0
          ? `clicked ×${clickCount}`
          : "idle";

  return (
    <main className="button-test-page">
      <div className="button-test">
        <section className="button-test-main">
          <header className="button-test-header">
            <div>
              <p className="button-test-kicker">Desktop lab · CTA</p>
              <h1>Button test</h1>
              <p className="button-test-template-label">{activeTemplate.name}</p>
            </div>
            <p className="button-test-status">{copyStatus ?? status}</p>
          </header>

          <div className="button-test-stage-wrap">
            <div className="button-test-stage">
              <CtaButton
                label={state.label}
                width={state.width}
                height={state.height}
                cornerRadius={state.cornerRadius}
                strokeWidth={state.strokeWidth}
                strokeColor={state.strokeColor}
                auroraColorStops={auroraStops}
                auroraSpeed={state.auroraSpeed}
                auroraBlend={state.auroraBlend}
                auroraAmplitude={state.auroraAmplitude}
                auroraBandHeight={state.auroraBandHeight}
                auroraBaseColor={state.auroraBaseColor}
                labelColor={state.labelColor}
                fontSize={state.fontSize}
                glowEnabled={state.glowEnabled}
                glowAlwaysOn={state.glowAlwaysOn}
                glowEdgeSensitivity={state.glowEdgeSensitivity}
                glowColor={state.glowColor}
                glowRadius={state.glowRadius}
                glowIntensity={state.glowIntensity}
                glowConeSpread={state.glowConeSpread}
                glowFillOpacity={state.glowFillOpacity}
                glowOrbitSpeed={state.glowOrbitSpeed}
                glowAlwaysOnProximity={state.glowAlwaysOnProximity}
                glowColors={glowStops}
                forceHover={state.forceHover}
                forcePressed={state.forcePressed}
                disabled={state.disabled}
                onClick={() => setClickCount((n) => n + 1)}
              />
            </div>
          </div>
        </section>

        <aside className="panel button-test-panel">
          <section className="button-test-section">
            <h3>Template</h3>
            <p className="button-test-hint">{activeTemplate.description}</p>
            <label>
              Preset
              <select
                value={templateId}
                onChange={(event) => applyTemplate(event.target.value as CtaTemplateId)}
              >
                {CTA_TEMPLATES.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="button-row">
              <button type="button" onClick={() => applyTemplate(templateId)}>
                Reset template
              </button>
              <a className="secondary-button" href="/dashboard">
                Back to dashboard
              </a>
            </div>
          </section>

          <section className="button-test-section">
            <h3>Copy defaults</h3>
            <p className="button-test-hint">
              Copy the current slider values as paste-ready code for `ctaTemplates.ts` or
              `CtaButton` defaults.
            </p>
            <div className="button-row">
              <button type="button" onClick={() => void handleCopyTemplateValues()}>
                Copy template values
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleCopyCtaDefaults()}
              >
                Copy CTA defaults
              </button>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleCopyJson()}
              >
                Copy JSON
              </button>
            </div>
            {copyStatus ? <p className="button-test-copy-status">{copyStatus}</p> : null}
          </section>

          <section className="button-test-section">
            <h3>Size & shape</h3>
            <div className="button-test-sliders">
              {SIZE_SLIDERS.map((def) => (
                <SliderRow
                  key={def.key}
                  def={def}
                  value={state[def.key] as number}
                  onChange={(value) => patch(def.key, value)}
                />
              ))}
            </div>
            <label>
              Stroke color
              <input
                type="color"
                value={toColorInputValue(state.strokeColor)}
                onChange={(event) => patch("strokeColor", event.target.value)}
              />
            </label>
          </section>

          <section className="button-test-section">
            <h3>Label</h3>
            <label>
              Text
              <input
                type="text"
                value={state.label}
                onChange={(event) => patch("label", event.target.value)}
              />
            </label>
            <div className="button-test-sliders">
              {LABEL_SLIDERS.map((def) => (
                <SliderRow
                  key={def.key}
                  def={def}
                  value={state[def.key] as number}
                  onChange={(value) => patch(def.key, value)}
                />
              ))}
            </div>
            <label>
              Label color
              <input
                type="color"
                value={toColorInputValue(state.labelColor)}
                onChange={(event) => patch("labelColor", event.target.value)}
              />
            </label>
          </section>

          <section className="button-test-section">
            <h3>Aurora</h3>
            <div className="button-test-color-row">
              <label>
                Stop A
                <input
                  type="color"
                  value={toColorInputValue(state.auroraA)}
                  onChange={(event) => patch("auroraA", event.target.value)}
                />
              </label>
              <label>
                Stop B
                <input
                  type="color"
                  value={toColorInputValue(state.auroraB)}
                  onChange={(event) => patch("auroraB", event.target.value)}
                />
              </label>
              <label>
                Stop C
                <input
                  type="color"
                  value={toColorInputValue(state.auroraC)}
                  onChange={(event) => patch("auroraC", event.target.value)}
                />
              </label>
            </div>
            <label>
              Base color (behind transparent areas)
              <input
                type="color"
                value={toColorInputValue(state.auroraBaseColor)}
                onChange={(event) => patch("auroraBaseColor", event.target.value)}
              />
            </label>
            <div className="button-test-sliders">
              {AURORA_SLIDERS.map((def) => (
                <SliderRow
                  key={def.key}
                  def={def}
                  value={state[def.key] as number}
                  onChange={(value) => patch(def.key, value)}
                />
              ))}
            </div>
          </section>

          <section className="button-test-section">
            <h3>Border glow</h3>
            <p className="button-test-hint">
              Mesh rim + outer bloom. With Always on, the cone orbits continuously — no hover
              needed.
            </p>
            <label className="button-test-check">
              <input
                type="checkbox"
                checked={state.glowEnabled}
                onChange={(event) => patch("glowEnabled", event.target.checked)}
              />
              Enabled
            </label>
            <label className="button-test-check">
              <input
                type="checkbox"
                checked={state.glowAlwaysOn}
                onChange={(event) => patch("glowAlwaysOn", event.target.checked)}
              />
              Always on (animated)
            </label>
            <label>
              Glow HSL (H S L)
              <input
                type="text"
                value={state.glowColor}
                onChange={(event) => patch("glowColor", event.target.value)}
                placeholder="40 80 80"
              />
            </label>
            <div className="button-test-color-row">
              <label>
                Mesh A
                <input
                  type="color"
                  value={toColorInputValue(state.glowA)}
                  onChange={(event) => patch("glowA", event.target.value)}
                />
              </label>
              <label>
                Mesh B
                <input
                  type="color"
                  value={toColorInputValue(state.glowB)}
                  onChange={(event) => patch("glowB", event.target.value)}
                />
              </label>
              <label>
                Mesh C
                <input
                  type="color"
                  value={toColorInputValue(state.glowC)}
                  onChange={(event) => patch("glowC", event.target.value)}
                />
              </label>
            </div>
            <div className="button-test-sliders">
              {GLOW_SLIDERS.map((def) => (
                <SliderRow
                  key={def.key}
                  def={def}
                  value={state[def.key] as number}
                  onChange={(value) => patch(def.key, value)}
                />
              ))}
            </div>
          </section>

          <section className="button-test-section">
            <h3>States</h3>
            <label className="button-test-check">
              <input
                type="checkbox"
                checked={state.forceHover}
                onChange={(event) => patch("forceHover", event.target.checked)}
              />
              Force hover
            </label>
            <label className="button-test-check">
              <input
                type="checkbox"
                checked={state.forcePressed}
                onChange={(event) => patch("forcePressed", event.target.checked)}
              />
              Force pressed
            </label>
            <label className="button-test-check">
              <input
                type="checkbox"
                checked={state.disabled}
                onChange={(event) => patch("disabled", event.target.checked)}
              />
              Disabled
            </label>
          </section>
        </aside>
      </div>
    </main>
  );
}

/** Best-effort hex for <input type="color">; falls back to white for rgba/named. */
function toColorInputValue(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  const rgba = trimmed.match(
    /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i,
  );
  if (rgba) {
    const r = Math.round(Number(rgba[1]));
    const g = Math.round(Number(rgba[2]));
    const b = Math.round(Number(rgba[3]));
    return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
  }
  return "#ffffff";
}

function toHexByte(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
}
