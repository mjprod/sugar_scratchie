import { BODY_SYMBOL_COUNT } from "./matchGame";

export type StageCoachPhase = "bar" | "hunt" | "hidden";

export function resolveStageCoachPhase(options: {
  active: boolean;
  topBarPhase: "center" | "docked";
  found: number;
  total?: number;
}): StageCoachPhase {
  const total = options.total ?? BODY_SYMBOL_COUNT;
  if (!options.active) return "hidden";
  if (options.topBarPhase === "center") return "bar";
  if (options.found >= total) return "hidden";
  return "hunt";
}

export function stageCoachLabel(
  phase: StageCoachPhase,
  found: number,
  total = BODY_SYMBOL_COUNT,
): string {
  if (phase === "bar") return "Scratch the foil to reveal";
  if (phase === "hunt") {
    if (found <= 0) return "Match the symbols on her";
    return `${found} of ${total} found — keep scratching`;
  }
  return "";
}

type StageCoachHintProps = {
  phase: StageCoachPhase;
  found: number;
  total?: number;
};

/** On-stage coaching pill — bar reveal, then body-symbol hunt. */
export function StageCoachHint({
  phase,
  found,
  total = BODY_SYMBOL_COUNT,
}: StageCoachHintProps) {
  if (phase === "hidden") return null;
  const label = stageCoachLabel(phase, found, total);
  if (!label) return null;

  return (
    <p className={`stage-coach stage-coach--${phase}`} aria-live="polite">
      <span key={`${phase}-${found}`} className="stage-coach-label">
        {label}
      </span>
    </p>
  );
}
