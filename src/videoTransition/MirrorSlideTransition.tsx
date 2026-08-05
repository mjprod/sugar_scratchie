import { useEffect, useRef, useState, type CSSProperties } from "react";
import { loadVideoSrc, releaseMediaElement } from "../shared/media";
import {
  STAGE_HEIGHT,
  STAGE_WIDTH,
  applyMotionFx,
  clamp,
  defaultChannelTracks,
  defaultEasing,
  defaultMotionFx,
  drawFlippedVideo,
  fxLayerStyle,
  sampleChannelTracks,
  stripTravelStyle,
} from "./engine";
import { getTemplate } from "./presets";
import type { StripProps, TransitionTemplateId } from "./types";

const LOAD_TIMEOUT_MS = 1500;

export type MirrorSlideTransitionProps = {
  fromSrc: string;
  toSrc: string;
  templateId: TransitionTemplateId;
  onComplete: () => void;
  onError?: () => void;
  className?: string;
  style?: CSSProperties;
};

async function loadLoopingVideo(
  video: HTMLVideoElement,
  src: string,
): Promise<void> {
  await loadVideoSrc(video, src);
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => undefined);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Full-bleed mirror-slide strip player for between-card transitions.
 * Plays one of the lab templates (Shift left / Bounce out / Zoom up).
 */
export function MirrorSlideTransition({
  fromSrc,
  toSrc,
  templateId,
  onComplete,
  onError,
  className,
  style,
}: MirrorSlideTransitionProps) {
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);
  const mirrorACanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mirrorBCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const mirrorRafRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  onCompleteRef.current = onComplete;
  onErrorRef.current = onError;

  const template = getTemplate(templateId);
  const preset = template?.preset;
  const channels = preset?.channels ?? defaultChannelTracks();
  const easing = preset?.easing ?? defaultEasing();
  const motionFx = preset?.motionFx ?? defaultMotionFx();
  const durationMs = preset?.durationMs ?? 500;

  const [pose, setPose] = useState<StripProps>(() =>
    applyMotionFx(sampleChannelTracks(channels, 0, easing), 0, motionFx),
  );

  useEffect(() => {
    finishedRef.current = false;
    const videoA = videoARef.current;
    const videoB = videoBRef.current;
    if (!videoA || !videoB || !preset) {
      onErrorRef.current?.();
      return;
    }

    let cancelled = false;

    const finish = (ok: boolean) => {
      if (cancelled || finishedRef.current) return;
      finishedRef.current = true;
      if (ok) onCompleteRef.current();
      else onErrorRef.current?.() ?? onCompleteRef.current();
    };

    const run = async () => {
      try {
        await withTimeout(
          Promise.all([
            loadLoopingVideo(videoA, fromSrc),
            loadLoopingVideo(videoB, toSrc),
          ]),
          LOAD_TIMEOUT_MS,
        );
        if (cancelled) return;

        drawFlippedVideo(mirrorACanvasRef.current, videoA);
        drawFlippedVideo(mirrorBCanvasRef.current, videoB);

        const startedAt = performance.now();
        const tick = (now: number) => {
          if (cancelled) return;
          const t = clamp((now - startedAt) / Math.max(durationMs, 1), 0, 1);
          const base = sampleChannelTracks(channels, t, easing);
          setPose(applyMotionFx(base, t, motionFx));
          if (t >= 1) {
            rafRef.current = null;
            finish(true);
            return;
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        if (!cancelled) finish(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // Intentionally keyed on srcs + template only — preset objects are stable per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromSrc, toSrc, templateId]);

  // Paint flipped mirrors from the two source videos.
  useEffect(() => {
    const videoA = videoARef.current;
    const videoB = videoBRef.current;
    if (!videoA || !videoB) return;

    let stopped = false;
    const paint = () => {
      if (stopped) return;
      drawFlippedVideo(mirrorACanvasRef.current, videoA);
      drawFlippedVideo(mirrorBCanvasRef.current, videoB);
    };

    const loop = () => {
      if (stopped) return;
      paint();
      mirrorRafRef.current = requestAnimationFrame(loop);
    };
    mirrorRafRef.current = requestAnimationFrame(loop);

    return () => {
      stopped = true;
      if (mirrorRafRef.current !== null) {
        cancelAnimationFrame(mirrorRafRef.current);
        mirrorRafRef.current = null;
      }
    };
  }, [fromSrc, toSrc]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (mirrorRafRef.current !== null) {
        cancelAnimationFrame(mirrorRafRef.current);
      }
      releaseMediaElement(videoARef.current);
      releaseMediaElement(videoBRef.current);
    };
  }, []);

  return (
    <div
      className={["game-card-transition", className].filter(Boolean).join(" ")}
      style={style}
      aria-hidden="true"
    >
      <div
        className="transition-lab-stage game-card-transition-stage"
        style={{ aspectRatio: `${STAGE_WIDTH} / ${STAGE_HEIGHT}` }}
      >
        <div className="transition-lab-fx-layer" style={fxLayerStyle(pose)}>
          <div
            className="transition-lab-strip"
            style={stripTravelStyle(pose)}
          >
            <div className="transition-lab-tile">
              <video
                ref={videoARef}
                className="transition-lab-video"
                muted
                loop
                playsInline
                preload="auto"
              />
            </div>
            <div className="transition-lab-tile">
              <canvas
                ref={mirrorACanvasRef}
                className="transition-lab-video transition-lab-mirror"
              />
            </div>
            <div className="transition-lab-tile">
              <canvas
                ref={mirrorBCanvasRef}
                className="transition-lab-video transition-lab-mirror"
              />
            </div>
            <div className="transition-lab-tile">
              <video
                ref={videoBRef}
                className="transition-lab-video"
                muted
                loop
                playsInline
                preload="auto"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
