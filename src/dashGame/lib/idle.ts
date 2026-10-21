type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

/**
 * Run `callback` once the main thread is idle (or after `timeoutMs` at the
 * latest). Without `requestIdleCallback` (Safari) there is no idle signal, so
 * it runs at `timeoutMs`. Returns a cancel function.
 */
export function runWhenIdle(callback: () => void, timeoutMs = 2000): () => void {
  if (typeof window === "undefined") return () => {};
  const w = window as IdleWindow;
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(callback, { timeout: timeoutMs });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(callback, timeoutMs);
  return () => window.clearTimeout(id);
}

/** Wait for the first paint, then idle — for work that must not compete with LCP. */
export function runAfterPaintIdle(callback: () => void, timeoutMs = 2000): () => void {
  if (typeof window === "undefined") return () => {};
  let cancelIdle: (() => void) | null = null;
  const raf = window.requestAnimationFrame(() => {
    cancelIdle = runWhenIdle(callback, timeoutMs);
  });
  return () => {
    window.cancelAnimationFrame(raf);
    cancelIdle?.();
  };
}
