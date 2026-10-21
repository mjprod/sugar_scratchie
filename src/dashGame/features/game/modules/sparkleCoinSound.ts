/**
 * Sparkle-coin milestone SFX — one preloaded HTMLAudio per band clip.
 * Gated by game soundEffect prefs; rapid milestones overlap (extra voices are
 * clones of the cached clip, capped by MAX_OVERLAPPING_COIN_VOICES).
 */

import { effectiveSoundEffect } from "@/services/gameAudioPrefs";
import { getGameAudioContext } from "../shared/gameAudioContext";
import { soundMixOutput } from "../shared/soundMix";
import { SPARKLE_COIN_BANDS } from "./sparkleCoinAward";

/**
 * Runaway guard only — above the 10 milestones a card can award, so coin
 * clips pile up freely and are never dropped in normal play.
 */
const MAX_OVERLAPPING_COIN_VOICES = 12;

const audioBySrc = new Map<string, HTMLAudioElement>();
const overlapVoices = new Set<HTMLAudioElement>();

function soundUrl(src: string) {
  if (typeof document === "undefined") return src;
  return new URL(src, document.location.href).href;
}

function ensureCoinGain(): AudioNode | null {
  return soundMixOutput("coins");
}

/** iOS ignores HTMLAudio.volume, so the element stays at 1 and the mix is a GainNode. */
function routeThroughMix(audio: HTMLAudioElement) {
  const gain = ensureCoinGain();
  const ctx = getGameAudioContext();
  if (!gain || !ctx) return;
  const node = (
    audio as HTMLAudioElement & { __coinSource?: MediaElementAudioSourceNode }
  ).__coinSource ?? ctx.createMediaElementSource(audio);
  (audio as HTMLAudioElement & { __coinSource?: MediaElementAudioSourceNode }).__coinSource =
    node;
  try {
    node.disconnect();
  } catch {
    // not yet connected
  }
  node.connect(gain);
}

function getBandAudio(src: string): HTMLAudioElement | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  let audio = audioBySrc.get(src);
  if (audio) return audio;
  audio = new Audio(soundUrl(src));
  audio.preload = "auto";
  audio.muted = false;
  audio.volume = 1;
  audio.setAttribute("playsinline", "true");
  audio.style.display = "none";
  document.body.appendChild(audio);
  audioBySrc.set(src, audio);
  return audio;
}

function isPlaying(audio: HTMLAudioElement) {
  return !audio.paused && !audio.ended;
}

function activeVoiceCount() {
  let count = overlapVoices.size;
  for (const audio of audioBySrc.values()) {
    if (isPlaying(audio)) count += 1;
  }
  return count;
}

function spawnOverlapVoice(base: HTMLAudioElement): HTMLAudioElement {
  const voice = base.cloneNode(true) as HTMLAudioElement;
  voice.muted = false;
  voice.volume = base.volume;
  const release = () => {
    overlapVoices.delete(voice);
    voice.removeEventListener("ended", release);
    voice.removeEventListener("error", release);
  };
  voice.addEventListener("ended", release);
  voice.addEventListener("error", release);
  overlapVoices.add(voice);
  return voice;
}

/** Pause + rewind every coin clip, including overlapping voices (mute). */
export function stopSparkleCoinSounds(): void {
  for (const audio of audioBySrc.values()) {
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {
      // Ignore decode / seek races on iOS.
    }
  }
  for (const voice of overlapVoices) {
    try {
      voice.pause();
    } catch {
      // Ignore decode races on iOS.
    }
  }
  overlapVoices.clear();
}

/** Warm the three band clips so the first 10% beat isn't silent on cold start. */
export function preloadSparkleCoinSounds() {
  for (const band of SPARKLE_COIN_BANDS) {
    getBandAudio(band.soundSrc);
  }
}

/**
 * Play the MP3 for a sparkle award. No-op when SFX are muted.
 * Overlaps any coin clip already playing; the same clip re-triggered mid-play
 * gets a cloned voice instead of rewinding the one in flight.
 */
export function playSparkleCoinSound(soundSrc: string): void {
  if (!soundSrc) return;
  if (!effectiveSoundEffect()) return;
  const base = getBandAudio(soundSrc);
  if (!base) return;
  if (activeVoiceCount() >= MAX_OVERLAPPING_COIN_VOICES) return;
  try {
    let target = base;
    if (isPlaying(base)) {
      target = spawnOverlapVoice(base);
    } else {
      base.currentTime = 0;
    }
    routeThroughMix(target);
    void target.play().catch(() => {
      overlapVoices.delete(target);
      // Autoplay / gesture lock — ignore; next gesture unlocks prefs path.
    });
  } catch {
    // Ignore decode / play races on iOS.
  }
}
