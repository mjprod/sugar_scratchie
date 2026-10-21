/**
 * Game video quality preference (profile Game Settings → "HD Videos").
 *
 * Per device, not per account: HD is for phones with the screen and bandwidth
 * for it. Read when the scratch game loads its cards, so a change applies to
 * the next game rather than mid-round.
 */
const HD_VIDEO_KEY = "sugar.v8.video.hd";

export function getHdVideoEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(HD_VIDEO_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { enabled?: boolean };
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

export function setHdVideoEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(HD_VIDEO_KEY, JSON.stringify({ enabled }));
  } catch {
    /* storage unavailable */
  }
}
