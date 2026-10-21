import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import {
  effectiveBackgroundMusic,
  effectiveSoundEffect,
  getGameAudioPrefs,
  setGameSoundOn,
  subscribeGameAudioPrefs,
} from "@/services/gameAudioPrefs";
import {
  applyBoundThemeIntroSound,
  introNeedsGestureUnlock,
  introVideoIsAudible,
} from "./shared/media";
import {
  isCountdownAudioPlaying,
  resumeCountdownAudioIfActive,
  stopCountdownAudio,
  unlockCountdownSound,
} from "./modules/InitialCountdown";
import {
  isMotionScratchBgmPlaying,
  unlockMotionScratchBgm,
} from "./modules/motionScratchBgm";
import { stageMuteIconShowsSoundOn } from "./stageMuteIconPolicy";

function prefsSoundOn() {
  const prefs = getGameAudioPrefs();
  return effectiveSoundEffect(prefs) || effectiveBackgroundMusic(prefs);
}

function liveAudioOn() {
  return (
    introVideoIsAudible() ||
    isCountdownAudioPlaying() ||
    isMotionScratchBgmPlaying()
  );
}

/**
 * Icon follows what the user can hear. If intro/countdown audio is already
 * playing, show unmuted so the first tap mutes.
 *
 * Hub Play unlocks countdown only — the theme intro may still be autoplay-
 * muted. Treat that as muted so the first tap unlocks the clip.
 */
function audibleSoundOn() {
  return stageMuteIconShowsSoundOn({
    liveAudioOn: liveAudioOn(),
    prefsSoundOn: prefsSoundOn(),
    introNeedsGestureUnlock: introNeedsGestureUnlock(),
  });
}

/**
 * Master mute for SFX and background music. Never rewrites the per-channel
 * Settings switches (see `setGameSoundOn`).
 * Lives in the pause menu (the stage chrome no longer has its own button).
 */
export function StageMuteButton({
  className = "stage-game__pause stage-game__mute",
  showLabel = false,
  icon = "volume",
}: {
  className?: string;
  showLabel?: boolean;
  /** Free Play toggle shows the mark instead of the volume control. */
  icon?: "volume" | "freeplay";
} = {}) {
  const [soundOn, setSoundOn] = useState(() => audibleSoundOn());

  useEffect(
    () =>
      subscribeGameAudioPrefs(() => {
        setSoundOn(audibleSoundOn());
      }),
    [],
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      setSoundOn((prev) => {
        const next = audibleSoundOn();
        return next === prev ? prev : next;
      });
    }, 200);
    return () => window.clearInterval(id);
  }, []);

  function toggle() {
    // If audio is already playing, the first tap must mute — even when the
    // icon was still showing muted from autoplay/prefs lag.
    const next = liveAudioOn() ? false : !soundOn;
    applyBoundThemeIntroSound(next);
    if (next) {
      unlockCountdownSound();
      // Sync resume + silent tick before any await (Safari gesture token).
      unlockMotionScratchBgm();
      resumeCountdownAudioIfActive();
    } else {
      stopCountdownAudio();
    }
    // Master mute only — the Settings switches stay as the user left them.
    setGameSoundOn(next);
    setSoundOn(next);
  }

  return (
    <button
      type="button"
      className={`${className}${soundOn ? "" : " is-muted"}${
        icon === "freeplay" ? " is-freeplay" : ""
      }`}
      aria-label={soundOn ? "Mute sounds" : "Unmute sounds"}
      aria-pressed={!soundOn}
      onClick={toggle}
    >
      {icon === "freeplay" ? (
        <svg
          className="stage-game__freeplay-mark"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 41 41"
          fill="none"
          aria-hidden="true"
        >
          <path fill="currentColor" d="M7.69 11.43h3.88V9.51H7.69V7.51h4.3V5.59H5.33v9.77h2.36V11.43z" />
          <path fill="currentColor" d="M15 12.02h1.21l1.79 3.34h2.58l-2.03-3.72c.54-.25.96-.6 1.25-1.07.3-.47.44-1.05.44-1.72s-.14-1.25-.43-1.73c-.29-.49-.7-.86-1.23-1.13-.53-.26-1.16-.39-1.9-.39h-4.04v9.77h2.36v-3.34zm1.16-4.53c.35 0 .65.05.89.15.24.1.42.25.55.45.12.2.19.45.19.75s-.06.55-.19.74c-.12.19-.31.34-.55.43-.24.09-.54.14-.89.14h-1.16V7.49h1.16z" />
          <path fill="currentColor" d="M27.8 13.44h-4.45v-2.01h4.11V9.51h-4.11V7.51h4.45V5.59h-6.81v9.77h6.81v-1.92z" />
          <path fill="currentColor" d="M35.56 13.44h-4.45v-2.01h4.1V9.51h-4.1V7.51h4.45V5.59h-6.81v9.77h6.81v-1.92z" />
          <path fill="currentColor" d="M7.43 23.14h1.47c.69 0 1.28-.13 1.78-.38.5-.25.88-.61 1.15-1.08.27-.46.41-1 .41-1.62s-.13-1.16-.4-1.62c-.27-.47-.64-.83-1.13-1.09s-1.07-.39-1.74-.39h-3.7v8.97h2.17v-2.78zm1.07-4.43c.32 0 .6.06.82.17.22.11.39.27.5.47.11.2.17.44.17.72s-.06.51-.17.72c-.11.21-.28.37-.5.48-.22.11-.49.17-.82.17H7.43v-2.73h1.07z" />
          <path fill="currentColor" d="M12.81 16.96v8.97h5.9v-1.76h-3.73v-7.21h-2.17z" />
          <path fill="currentColor" d="M22.09 16.96l-3.03 8.97h2.33l.59-1.88h3.1l.59 1.88h2.33l-3.03-8.97h-2.89zm.41 5.44 1-3.18h.07l1 3.18h-2.07z" />
          <path fill="currentColor" d="M32.55 25.93v-3l3.28-5.97h-2.42l-1.9 3.75h-.08l-1.89-3.75h-2.42l3.28 5.97v3h2.15z" />
          <path fill="currentColor" d="M9.58 32.64h-.09l-1.98-4.84H5.17v7.82h1.84v-4.83h.06l1.88 4.78h1.17l1.88-4.75h.07v4.8h1.83v-7.82h-2.33l-1.99 4.84z" />
          <path fill="currentColor" d="M20.19 28.16c-.56-.31-1.19-.46-1.89-.46s-1.33.16-1.9.46c-.56.31-1.01.76-1.34 1.36-.33.6-.49 1.33-.49 2.19s.16 1.58.49 2.18c.33.6.77 1.05 1.34 1.36.56.31 1.19.47 1.9.47s1.33-.15 1.89-.46c.56-.31 1.01-.76 1.34-1.36s.5-1.33.5-2.19-.17-1.59-.5-2.19c-.33-.6-.78-1.05-1.34-1.36zm-.31 4.84c-.14.35-.35.62-.62.8-.27.18-.59.27-.97.27s-.7-.09-.96-.27c-.27-.18-.48-.45-.62-.8-.14-.35-.22-.78-.22-1.29s.07-.94.22-1.29c.14-.35.35-.62.62-.8.27-.18.59-.27.96-.27s.7.09.97.27c.27.18.47.45.62.8.14.35.22.78.22 1.29s-.07.94-.22 1.29z" />
          <path fill="currentColor" d="M27.64 28.27c-.58-.31-1.26-.47-2.06-.47h-2.88v7.81h2.89c.79 0 1.48-.16 2.06-.47.58-.31 1.02-.76 1.33-1.34.31-.58.47-1.28.47-2.1s-.16-1.51-.47-2.09c-.31-.58-.76-1.03-1.33-1.34zm-.33 4.78c-.16.34-.39.58-.69.73-.3.15-.67.22-1.11.22h-.93v-4.59h.9c.45 0 .82.07 1.13.22s.54.39.7.72c.16.33.24.78.24 1.34s-.08 1.01-.23 1.35z" />
          <path fill="currentColor" d="M30.11 35.62h5.45v-1.54H32v-1.6h3.28v-1.54H32v-1.6h3.56v-1.54h-5.45v7.82z" />
          <path fill="currentColor" d="M39.14 0H29.68v1.86h9.46v37.28H29.68V41h9.46H41V0H39.14z" />
          <path fill="currentColor" d="M1.86 0h9.46v1.86H1.86v37.28h9.46V41H1.86H0V0h1.86z" />
        </svg>
      ) : soundOn ? (
        <Volume2 aria-hidden="true" size={17} strokeWidth={2.4} />
      ) : (
        <VolumeX aria-hidden="true" size={17} strokeWidth={2.4} />
      )}
      {showLabel ? (soundOn ? "Mute" : "Unmute") : null}
    </button>
  );
}
