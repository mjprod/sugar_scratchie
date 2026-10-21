/**
 * Game audio preferences.
 *
 * - Sound Effect / Background Music: the per-channel switches owned by the
 *   profile Game Settings screen. Sound Effect shares the scratch game's
 *   storage key.
 * - Muted: the in-game master mute. It silences every channel without
 *   touching the switches, so muting in the pause menu never rewrites the
 *   user's Settings choices. Turning a switch on in Settings clears it —
 *   otherwise that switch would appear to do nothing.
 *
 * Playback must go through `effectiveSoundEffect` / `effectiveBackgroundMusic`
 * rather than reading the switches directly.
 *
 * This is also the live store for those prefs: the in-game pause modal and the
 * profile settings screen both write here, and the scratch components
 * subscribe, so flipping a switch in one place takes effect in the others
 * without a reload.
 *
 * Listeners run synchronously on write, which matters — a subscriber that
 * needs to unlock an AudioContext has to do it inside the click that flipped
 * the switch, since Safari only allows that from a user gesture.
 */
const SOUND_EFFECT_KEY = "sugar-scratchie:sound";
const BACKGROUND_MUSIC_KEY = "sugar.v8.gameAudio.bgm";
const MUTED_KEY = "sugar.v8.gameAudio.muted";

export type GameAudioPrefs = {
  soundEffect: boolean;
  backgroundMusic: boolean;
  muted: boolean;
};

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { enabled?: boolean };
    return typeof parsed.enabled === "boolean" ? parsed.enabled : fallback;
  } catch {
    return fallback;
  }
}

function writeBool(key: string, enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify({ enabled }));
  } catch {
    /* storage unavailable */
  }
}

let cached: GameAudioPrefs | null = null;
const listeners = new Set<() => void>();

/** Identity is stable between writes, so it is safe to hold as a snapshot. */
export function getGameAudioPrefs(): GameAudioPrefs {
  cached ??= {
    soundEffect: readBool(SOUND_EFFECT_KEY, true),
    backgroundMusic: readBool(BACKGROUND_MUSIC_KEY, true),
    muted: readBool(MUTED_KEY, false),
  };
  return cached;
}

export function effectiveSoundEffect(
  prefs: GameAudioPrefs = getGameAudioPrefs(),
): boolean {
  return prefs.soundEffect && !prefs.muted;
}

export function effectiveBackgroundMusic(
  prefs: GameAudioPrefs = getGameAudioPrefs(),
): boolean {
  return prefs.backgroundMusic && !prefs.muted;
}

export function subscribeGameAudioPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: GameAudioPrefs) {
  cached = next;
  // Copy first: a listener may unsubscribe while being notified.
  for (const listener of [...listeners]) listener();
}

export function setSoundEffectEnabled(enabled: boolean) {
  const prefs = getGameAudioPrefs();
  const unmute = enabled && prefs.muted;
  if (prefs.soundEffect === enabled && !unmute) return;
  writeBool(SOUND_EFFECT_KEY, enabled);
  if (unmute) writeBool(MUTED_KEY, false);
  commit({ ...prefs, soundEffect: enabled, muted: unmute ? false : prefs.muted });
}

export function setBackgroundMusicEnabled(enabled: boolean) {
  const prefs = getGameAudioPrefs();
  const unmute = enabled && prefs.muted;
  if (prefs.backgroundMusic === enabled && !unmute) return;
  writeBool(BACKGROUND_MUSIC_KEY, enabled);
  if (unmute) writeBool(MUTED_KEY, false);
  commit({
    ...prefs,
    backgroundMusic: enabled,
    muted: unmute ? false : prefs.muted,
  });
}

export function setGameAudioMuted(muted: boolean) {
  const prefs = getGameAudioPrefs();
  if (prefs.muted === muted) return;
  writeBool(MUTED_KEY, muted);
  commit({ ...prefs, muted });
}

/**
 * In-game mute button. Muting only sets the master flag. Unmuting clears it,
 * and if both Settings switches are off it turns them back on — an explicit
 * unmute that stays silent would look broken.
 */
export function setGameSoundOn(on: boolean) {
  const prefs = getGameAudioPrefs();
  if (!on) {
    setGameAudioMuted(true);
    return;
  }
  const enableBoth = !prefs.soundEffect && !prefs.backgroundMusic;
  if (!prefs.muted && !enableBoth) return;
  writeBool(MUTED_KEY, false);
  if (enableBoth) {
    writeBool(SOUND_EFFECT_KEY, true);
    writeBool(BACKGROUND_MUSIC_KEY, true);
  }
  commit({
    soundEffect: enableBoth ? true : prefs.soundEffect,
    backgroundMusic: enableBoth ? true : prefs.backgroundMusic,
    muted: false,
  });
}
