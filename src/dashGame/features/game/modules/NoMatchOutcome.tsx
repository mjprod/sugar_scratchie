import { useEffect, useRef } from "react";
import { GalleryVerticalEnd } from "lucide-react";

type NoMatchOutcomeProps = {
  onComplete: () => void;
};

/* Entrance timing for .no-match__* in game.css; hold ends via TOTAL_MS. */
const CONTENT_IN_MS = 780;
/** Per-card result hold before auto-advance to the next card. */
export const CARD_NO_MATCH_RESULT_MS = 2000;
const TOTAL_MS = CONTENT_IN_MS + CARD_NO_MATCH_RESULT_MS;

/**
 * Resolved "this card produced nothing" beat. Sits over the scratched card so
 * the player still sees what they just played — an outcome, not an error modal.
 * Auto-advances after ~2s (or Skip); navigation is handled by the parent.
 */
export function NoMatchOutcome({ onComplete }: NoMatchOutcomeProps) {
  const completedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  function finish() {
    if (completedRef.current) return;
    completedRef.current = true;
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    onCompleteRef.current();
  }

  useEffect(() => {
    completedRef.current = false;
    timerRef.current = window.setTimeout(finish, TOTAL_MS);
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot hold per mount
  }, []);

  return (
    <div
      className="no-match no-match--manual"
      role="status"
      aria-live="polite"
      aria-label="No match. No symbol found on this card."
    >
      <div className="no-match__overlay" aria-hidden="true" />
      <div className="no-match__content">
        <GalleryVerticalEnd
          className="no-match__icon"
          aria-hidden="true"
          size={36}
          strokeWidth={1.4}
        />
        <h2 className="no-match__title">NO MATCH</h2>
        <p className="no-match__subtitle">No symbol found</p>
      </div>
      <div className="no-match__actions">
        <button type="button" className="no-match__skip" onClick={finish}>
          Skip
        </button>
      </div>
    </div>
  );
}
