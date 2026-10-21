/**
 * Touch-zoom on motion and photo scratch cards.
 * Default on. The pause menu writes here; both cards read it.
 */
const KEY = "sugar.v8.scratchZoom.enabled";

let cached: boolean | null = null;
const listeners = new Set<() => void>();

function read(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { enabled?: boolean };
    return typeof parsed.enabled === "boolean" ? parsed.enabled : true;
  } catch {
    return true;
  }
}

export function getScratchZoomEnabled(): boolean {
  cached ??= read();
  return cached;
}

export function subscribeScratchZoom(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** CSS reads this so a mid-stroke toggle drops the photo scale immediately. */
export function syncScratchZoomDataset(enabled = getScratchZoomEnabled()) {
  if (typeof document === "undefined") return;
  if (enabled) delete document.documentElement.dataset.scratchZoom;
  else document.documentElement.dataset.scratchZoom = "off";
}

export function setScratchZoomEnabled(enabled: boolean) {
  if (getScratchZoomEnabled() === enabled) return;
  cached = enabled;
  syncScratchZoomDataset(enabled);
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(KEY, JSON.stringify({ enabled }));
    } catch {
      /* storage unavailable */
    }
  }
  for (const listener of [...listeners]) listener();
}

if (typeof document !== "undefined") syncScratchZoomDataset();
