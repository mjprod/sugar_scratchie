import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pause, X } from "lucide-react";
import { setMotionScratchBgmDucked } from "./modules/motionScratchBgm";
import { ScratchZoomButton } from "./ScratchZoomButton";
import { StageMuteButton } from "./StageMuteButton";

/**
 * Pause control for the scratch stage: opens an overlay with mute / resume / leave.
 * Mute is a master mute over SFX and background music; Settings switches stay put.
 *
 * Layout: sit inside `.stage-game__top-chrome-side` so the button is flex-
 * centered in the gutter between the frame edge and the middle symbol bar.
 * Panel is solid (no backdrop-filter / glass).
 */
export function GamePauseButton({ onLeave }: { onLeave: () => void }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setMotionScratchBgmDucked(open);
    return () => setMotionScratchBgmDucked(false);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="stage-game__pause"
        aria-label="Pause game"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Pause aria-hidden="true" size={17} strokeWidth={2.4} />
      </button>
      {open ? (
        <GamePauseModal onResume={() => setOpen(false)} onLeave={onLeave} />
      ) : null}
    </>
  );
}

const PAUSE_LEAVE_MS = 320;

function GamePauseModal({
  onResume,
  onLeave,
}: {
  onResume: () => void;
  onLeave: () => void;
}) {
  const titleId = useId();
  const resumeRef = useRef<HTMLButtonElement>(null);
  const [leaving, setLeaving] = useState(false);
  const resumeAfterLeaveRef = useRef(false);
  const leaveDoneRef = useRef(false);

  function finishLeave() {
    if (leaveDoneRef.current) return;
    leaveDoneRef.current = true;
    if (resumeAfterLeaveRef.current) onResume();
  }

  function requestClose(resume = true) {
    if (leaving) return;
    resumeAfterLeaveRef.current = resume;
    leaveDoneRef.current = false;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      if (resume) onResume();
      return;
    }
    setLeaving(true);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") requestClose(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    resumeRef.current?.focus();
  }, []);

  // Fallback if animationend is skipped (tab backgrounded, reduced motion race).
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(finishLeave, PAUSE_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={["game-pause", leaving ? "is-leaving" : ""].filter(Boolean).join(" ")}
      role="presentation"
    >
      <button
        type="button"
        className="game-pause__scrim"
        aria-label="Resume game"
        onClick={() => requestClose(true)}
      />
      <div
        className="game-pause__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onAnimationEnd={(event) => {
          if (!leaving) return;
          if (event.target !== event.currentTarget) return;
          if (!event.animationName.split(", ").includes("game-pause-panel-out")) {
            return;
          }
          finishLeave();
        }}
      >
        <button
          type="button"
          className="game-pause__close"
          aria-label="Close"
          onClick={() => requestClose(true)}
        >
          <X aria-hidden="true" strokeWidth={2.5} />
        </button>
        <img
          src="/svg/logoSugarScratch.svg"
          alt=""
          className="game-pause__logo"
          draggable={false}
          aria-hidden="true"
        />
        <h2 id={titleId} className="game-pause__title">
          Game Paused
        </h2>
        <StageMuteButton className="game-pause__mute" showLabel />
        <ScratchZoomButton />
        <button
          ref={resumeRef}
          type="button"
          className="game-pause__resume"
          onClick={() => requestClose(true)}
        >
          Resume
        </button>
        <button
          type="button"
          className="game-pause__leave"
          onClick={() => {
            // Leave should go immediately; no need to reverse-animate out first.
            onLeave();
          }}
        >
          Leave Game
        </button>
      </div>
    </div>,
    document.body,
  );
}
