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
    canvas.width = size;
    canvas.height = size;
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
    });
    const turn = joinSymbolRotation(() => {
      void player.play();
    });
    const onLoad = () => {
      // stop() renders the first frame, so an icon waiting its turn shows its
      // designed pose rather than an empty canvas.
      void player.stop();
      turn.setReady(!pausedRef.current);
    };
    const onComplete = () => {
      void player.stop();
      turn.finish();
    };
    player.addEventListener("load", onLoad);
    player.addEventListener("complete", onComplete);
    playerRef.current = player;
    turnRef.current = turn;
    return () => {
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
    // Give the turn back rather than freezing mid-pose; the rotation comes
    // round again once this icon is released.
    if (paused) void player.stop();
    turn.setReady(!paused);
  }, [paused]);

  return <div ref={hostRef} className="game-symbol-lottie" aria-hidden="true" />;
}

// NOTE: do not pass a `renderConfig` here without measuring first. Capping
// devicePixelRatio looks like an easy win — up to eighteen of these play at
// once and they dominate the CPU profile — but the library only defaults
// devicePixelRatio and freezeOnOffscreen, so any config you supply must also
// carry autoResize, and enabling that grows the body icons' backing store
// (~84x84 to ~114x114) and costs more than the DPR cap saves.
export function GameSymbolIcon({
  typeId,
  size = 24,
  paused = false,
}: {
  typeId: number;
  size?: number;
  /**
   * Take this icon out of the playback rotation and hold it on its first
   * frame. Set it while the icon is not visible yet — the top bar builds all
   * six slots under the scratch coating — so turns are not spent unseen. The
   * entrance "pop" is a CSS keyframe on `.body-symbol-icon`, not part of the
   * Lottie, so a held symbol still appears normally.
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
      turn.setReady(!pausedRef.current);
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
    if (paused) player.stop();
    turn.setReady(!paused);
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
