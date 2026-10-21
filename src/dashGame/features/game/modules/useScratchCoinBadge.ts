import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type AnimationEvent,
  type MutableRefObject,
} from "react";
import { COIN_BADGE_IDLE_HIDE_MS } from "./sparkleCoinAward";

/** Keyframe name of the bottom-left shell exit (`scratch/styles.css`). */
export const COIN_BADGE_LEAVE_ANIMATION = "pack-progress-leave-bl";

/** True when an animationend should finish the badge exit (empty name = unknown, accept). */
export function isCoinBadgeLeaveAnimation(name: string | null | undefined) {
  const value = name || "";
  return !value || value.includes(COIN_BADGE_LEAVE_ANIMATION);
}

/**
 * Initial StageCoinCount state. The badge shell remounts (enterKey) in the same
 * batch as popNonce + addCoins, so a mount carrying an award must start at the
 * pre-credit total and treat popNonce as unseen — else no +N / pop / count-up.
 */
export function coinCountMountState(
  target: number,
  popNonce: number,
  awardAmount: number,
) {
  const onAward = popNonce > 0 && awardAmount > 0;
  return {
    display: onAward ? Math.max(0, target - awardAmount) : target,
    prevPopNonce: onAward ? popNonce - 1 : popNonce,
  };
}

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Bottom-left StageCoinCount badge for 10% scratch coin awards: hidden until
 * an award, then animates away 3s after the finger lifts. Replays enter on
 * the next award.
 */
export function useScratchCoinBadge({
  isScratchingRef,
}: {
  isScratchingRef: MutableRefObject<boolean>;
}) {
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);
  /** Remount shell so enter-bl replays when re-showing from hidden. */
  const [enterKey, setEnterKey] = useState(0);
  /** Bumps StageCoinCount scale-pop on each award. */
  const [popNonce, setPopNonce] = useState(0);
  /** Last award amount — floating +N chip on StageCoinCount. */
  const [awardFlash, setAwardFlash] = useState(0);
  const shownRef = useRef(false);
  const leavingRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const hideNow = useCallback(() => {
    shownRef.current = false;
    leavingRef.current = false;
    setShown(false);
    setLeaving(false);
  }, []);

  const beginIdleLeave = useCallback(() => {
    if (!shownRef.current || leavingRef.current) return;
    if (isScratchingRef.current) return;
    if (prefersReducedMotion()) {
      hideNow();
      return;
    }
    leavingRef.current = true;
    setLeaving(true);
  }, [hideNow, isScratchingRef]);

  const scheduleIdleHide = useCallback(
    (holdMs: number = COIN_BADGE_IDLE_HIDE_MS) => {
      clearIdleTimer();
      if (!shownRef.current || leavingRef.current) return;
      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null;
        if (isScratchingRef.current) return;
        beginIdleLeave();
      }, holdMs);
    },
    [beginIdleLeave, clearIdleTimer, isScratchingRef],
  );

  const award = useCallback(
    (amount: number) => {
      clearIdleTimer();
      if (!shownRef.current || leavingRef.current) {
        setEnterKey((k) => k + 1);
      }
      // Sync refs now so a same-tick scheduleIdleHide sees the badge as shown.
      shownRef.current = true;
      leavingRef.current = false;
      setShown(true);
      setLeaving(false);
      setAwardFlash(amount);
      setPopNonce((n) => n + 1);
    },
    [clearIdleTimer],
  );

  const onLeaveEnd = useCallback(
    (event: AnimationEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (!leavingRef.current) return;
      if (!isCoinBadgeLeaveAnimation(event.animationName)) return;
      hideNow();
    },
    [hideNow],
  );

  const reset = useCallback(() => {
    clearIdleTimer();
    leavingRef.current = false;
    setLeaving(false);
    setPopNonce(0);
    setAwardFlash(0);
    shownRef.current = false;
    setShown(false);
  }, [clearIdleTimer]);

  useEffect(() => clearIdleTimer, [clearIdleTimer]);

  return {
    shown,
    leaving,
    enterKey,
    popNonce,
    awardFlash,
    award,
    scheduleIdleHide,
    onLeaveEnd,
    reset,
  };
}
