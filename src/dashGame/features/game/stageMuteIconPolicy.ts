/**
 * Pure policy for the stage mute icon — whether it should look "sound on".
 *
 * Countdown unlock (hub Play / Continue) is not a theme-intro video gesture.
 * If the intro is still autoplay-muted, show muted so the first tap unlocks
 * the clip instead of flipping prefs off.
 */
export function stageMuteIconShowsSoundOn(input: {
  liveAudioOn: boolean;
  prefsSoundOn: boolean;
  introNeedsGestureUnlock: boolean;
}): boolean {
  if (input.liveAudioOn) return true;
  if (!input.prefsSoundOn) return false;
  if (input.introNeedsGestureUnlock) return false;
  return true;
}
