import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import { DotLottieWorker } from "@lottiefiles/dotlottie-web";
import type { DotLottie } from "@lottiefiles/dotlottie-web";
import { useEffect, useRef, useState } from "react";
import { SYMBOL_TYPES } from "./matchGame";
import { joinSymbolRotation, type SymbolTurn } from "./symbolPlaybackRotation";

// Every symbol player shares this one worker thread. Up to eighteen of these are
// on screen at once and they dominate the CPU profile; keeping them off the main
// thread is what stops them competing with video decode, which is what pulls the
// two clips out of sync during a long scratch.
const SYMBOL_WORKER_ID = "game-symbols";

// The worker renders through OffscreenCanvas (Safari 16.4+, Chrome, Firefox
// 105+). Falling back rather than assuming support matters here: an unsupported
// browser would show nothing at all, which is the same silent-blank failure the
// self-hosted WASM URL in main.tsx exists to prevent.
const SUPPORTS_OFFSCREEN =
  typeof HTMLCanvasElement !== "undefined" &&
  typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function";

/**
 * Worker-backed player.
 *
 * This drives `DotLottieWorker` directly instead of using `DotLottieWorkerReact`
 * because that component reuses one canvas element across ref attachments, and
 * `transferControlToOffscreen` may only ever run once per element. Under
 * StrictMode React attaches, detaches and re-attaches in development, so the
 * second attach throws and every symbol renders blank. Creating the canvas here
 * means each attach gets a fresh, never-transferred element.
 */
function WorkerSymbolIcon({
  src,
  size,
  paused,
}: {
  src: string;
  size: number;
  paused: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<DotLottieWorker | null>(null);
  const turnRef = useRef<SymbolTurn | null>(null);
  // Read at load time, which can land after any number of renders, so the
  // latest value has to be reachable from outside the mount effect.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    // Bitmap starts at CSS size; DotLottieWorker then raises the backing store
    // to size×DPR. Chrome lays transferred OffscreenCanvas out at buffer
    // pixels unless CSS width/height are locked to `size` with !important —
    // percentage sizing is ignored on those placeholders, so icons go ~2×.
    canvas.width = size;
    canvas.height = size;
    const lockCssSize = () => {
      canvas.style.setProperty("width", `${size}px`, "important");
      canvas.style.setProperty("height", `${size}px`, "important");
    };
    lockCssSize();
    host.appendChild(canvas);
    const player = new DotLottieWorker({
      canvas,
      // Must be absolute: the worker fetches this itself, and a worker's base
      // URL cannot resolve a root-relative path — it fails with "Failed to
      // parse URL" and the symbol silently renders blank.
      src: new URL(src, window.location.href).href,
      // The rotation decides when this plays, and it plays a single pass per
      // turn rather than looping on its own.
      autoplay: false,
      loop: false,
      // See the note on the non-worker path below.
      useFrameInterpolation: false,
      workerId: SYMBOL_WORKER_ID,
      // Keep DPR for sharpness, but never auto-grow the DOM box.
      renderConfig: {
        autoResize: false,
        freezeOnOffscreen: true,
      },
    });
    const turn = joinSymbolRotation(() => {
      void player.play();
    });
    const onLoad = () => {
      lockCssSize();
      // stop() renders the first frame, so an icon waiting its turn shows its
      // designed pose rather than an empty canvas.
      void player.stop();
      if (pausedRef.current) {
        // Desaturated / hidden icons stay on frame 0 and leave the rotation —
        // freeze() parks the worker so they don't keep burning CPU/memory.
        void player.freeze();
        turn.setReady(false);
      } else {
        turn.setReady(true);
      }
    };
    const onComplete = () => {
      lockCssSize();
      void player.stop();
      turn.finish();
    };
    player.addEventListener("load", onLoad);
    player.addEventListener("complete", onComplete);
    playerRef.current = player;
    turnRef.current = turn;
    lockCssSize();
    // Worker may bump canvas.width to size×DPR asynchronously — re-lock CSS.
    const sizeLock = window.setInterval(lockCssSize, 250);
    const sizeLockStop = window.setTimeout(() => window.clearInterval(sizeLock), 3000);
    return () => {
      window.clearInterval(sizeLock);
      window.clearTimeout(sizeLockStop);
      playerRef.current = null;
      turnRef.current = null;
      turn.dispose();
      player.removeEventListener("load", onLoad);
      player.removeEventListener("complete", onComplete);
      void player.destroy();
      canvas.remove();
    };
  }, [src, size]);

  useEffect(() => {
    const player = playerRef.current;
    const turn = turnRef.current;
    // Before load the load handler owns readiness, using pausedRef.
    if (!turn || !player?.isLoaded) return;
    if (paused) {
      void player.stop();
      void player.freeze();
      turn.setReady(false);
      return;
    }
    void player.unfreeze();
    turn.setReady(true);
  }, [paused]);

  return (
    <div
      ref={hostRef}
      className="game-symbol-lottie"
      aria-hidden="true"
      style={{ width: size, height: size }}
    />
  );
}

// NOTE: renderConfig must be a full-enough object — the library merges only
// what you pass, but omitting autoResize previously defaulted in ways that
// fought our fixed CSS box. We always pass autoResize: false here so the
// worker keeps the host's inline `size` instead of growing with DPR.
export function GameSymbolIcon({
  typeId,
  size = 24,
  paused = false,
}: {
  typeId: number;
  size?: number;
  /**
   * Hold on the first frame and leave the playback rotation. Also freezes the
   * worker so desaturated / hidden icons (dormant top-bar slots, missed body
   * finds) do not keep animating or burning CPU. Clear it when the icon should
   * play again (e.g. a top slot that just matched).
   */
  paused?: boolean;
}) {
  const entry = SYMBOL_TYPES[typeId] ?? SYMBOL_TYPES[0];
  const [player, setPlayer] = useState<DotLottie | null>(null);
  const turnRef = useRef<SymbolTurn | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Mirrors the worker path above; see the comments there.
  useEffect(() => {
    if (!player) return;
    const turn = joinSymbolRotation(() => player.play());
    const onLoad = () => {
      player.stop();
      if (pausedRef.current) {
        player.freeze();
        turn.setReady(false);
      } else {
        turn.setReady(true);
      }
    };
    const onComplete = () => {
      player.stop();
      turn.finish();
    };
    player.addEventListener("load", onLoad);
    player.addEventListener("complete", onComplete);
    turnRef.current = turn;
    // Unlike the worker path, the ref callback can arrive after the player has
    // already loaded, in which case the load event is never seen here.
    if (player.isLoaded) onLoad();
    return () => {
      turnRef.current = null;
      turn.dispose();
      player.removeEventListener("load", onLoad);
      player.removeEventListener("complete", onComplete);
    };
  }, [player]);

  useEffect(() => {
    const turn = turnRef.current;
    if (!turn || !player?.isLoaded) return;
    if (paused) {
      player.stop();
      player.freeze();
      turn.setReady(false);
      return;
    }
    player.unfreeze();
    turn.setReady(true);
  }, [player, paused]);

  if (SUPPORTS_OFFSCREEN) {
    return (
      <WorkerSymbolIcon key={entry.src} src={entry.src} size={size} paused={paused} />
    );
  }

  return (
    <DotLottieReact
      key={entry.src}
      src={entry.src}
      autoplay={false}
      loop={false}
      // Interpolation makes each player emit a freshly interpolated frame on
      // every display refresh — 120/s here — for source animations that only
      // hold ~30fps of real motion. At icon size the frame-stepping is
      // invisible. This is a Config prop, not renderConfig, so it avoids the
      // autoResize trap described above. It is read when the player is
      // constructed, so a hot reload will not apply a change to it.
      useFrameInterpolation={false}
      dotLottieRefCallback={setPlayer}
      aria-hidden="true"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="game-symbol-lottie"
    />
  );
}
