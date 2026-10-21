import { lazy, Suspense, useSyncExternalStore, type ReactNode } from "react";
import type { DotLottieReactProps } from "@lottiefiles/dotlottie-react";
import { ChunkErrorBoundary } from "@/components/ui/ChunkErrorBoundary";
import { runWhenIdle } from "@/lib/idle";
import { createLottieGate, type LottieGate } from "./deferredLottieGate";

const LazyDotLottie = lazy(() => import("./DotLottieLazy"));

const INTERACTION_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;
/**
 * `load` fires before API-driven media (posters, feed clips) is requested, so
 * wait a little longer before the 1.2 MB wasm can compete with LCP.
 */
const AFTER_LOAD_DELAY_MS = 3000;

let browserGate: LottieGate | null = null;

function getBrowserGate(): LottieGate {
  if (browserGate) return browserGate;
  browserGate = createLottieGate({
    whenLoaded(onLoaded) {
      let timer = 0;
      const arm = () => {
        timer = window.setTimeout(onLoaded, AFTER_LOAD_DELAY_MS);
      };
      if (document.readyState === "complete") arm();
      else window.addEventListener("load", arm, { once: true });
      return () => {
        window.removeEventListener("load", arm);
        window.clearTimeout(timer);
      };
    },
    whenIdle: (onIdle) => runWhenIdle(onIdle, 3000),
    onFirstInteraction(onInteract) {
      for (const type of INTERACTION_EVENTS) {
        window.addEventListener(type, onInteract, { once: true, passive: true });
      }
      return () => {
        for (const type of INTERACTION_EVENTS) {
          window.removeEventListener(type, onInteract);
        }
      };
    },
  });
  return browserGate;
}

/** Open the gate now (e.g. an effect is about to play). */
export function openDeferredLotties(): void {
  if (typeof window === "undefined") return;
  getBrowserGate().open();
}

function useLottieGateOpen(): boolean {
  return useSyncExternalStore(
    (listener) =>
      typeof window === "undefined" ? () => {} : getBrowserGate().subscribe(listener),
    () => getBrowserGate().isOpen(),
    () => false,
  );
}

/**
 * DotLottieReact that renders `fallback` until the deferral gate opens, then
 * lazy-loads the player (and its wasm). Use for first-load decorative icons.
 */
export function DeferredLottie({
  fallback = null,
  ...props
}: DotLottieReactProps & { fallback?: ReactNode }) {
  const open = useLottieGateOpen();
  if (!open) return <>{fallback}</>;
  return (
    <ChunkErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <LazyDotLottie {...props} />
      </Suspense>
    </ChunkErrorBoundary>
  );
}
