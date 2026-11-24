import { useEffect, useRef, useState } from "react";
import {
  clampFrame,
  cropImage,
  frameForAspect,
} from "../sugarDress/lib/extractFrame";
import {
  resizeLocked,
  type Box,
  type Corner,
} from "../sugarDress/lib/resizeItem";

type Props = {
  src: string;
  fileName: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (file: File) => void;
};

/** Square face crop — same drag/resize pattern as sugar-dress ExtractPopup. */
export function LeoFaceCropDialog({
  src,
  fileName,
  busy = false,
  onCancel,
  onConfirm,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [frame, setFrame] = useState<Box | null>(null);
  const [view, setView] = useState({ scale: 1, ox: 0, oy: 0 });
  const [working, setWorking] = useState(false);
  const dragRef = useRef<{
    kind: "move" | Corner;
    pointerId: number;
    startX: number;
    startY: number;
    box: Box;
  } | null>(null);
  const naturalRef = useRef(natural);
  naturalRef.current = natural;
  const scaleRef = useRef(view.scale);
  scaleRef.current = view.scale;

  const measure = () => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage || !img.naturalWidth) return;
    const scale = Math.min(
      stage.clientWidth / img.naturalWidth,
      stage.clientHeight / img.naturalHeight,
    );
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    setView({
      scale,
      ox: (stage.clientWidth - dw) / 2,
      oy: (stage.clientHeight - dh) / 2,
    });
    setNatural({ w: img.naturalWidth, h: img.naturalHeight });
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [src]);

  useEffect(() => {
    if (!natural) return;
    setFrame(frameForAspect(natural.w, natural.h, 1, 1));
  }, [natural]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const size = naturalRef.current;
      if (!size || (e.buttons & 1) === 0) {
        dragRef.current = null;
        return;
      }
      const scale = scaleRef.current || 1;
      const dx = (e.clientX - drag.startX) / scale;
      const dy = (e.clientY - drag.startY) / scale;
      const next =
        drag.kind === "move"
          ? { ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy }
          : resizeLocked(drag.box, drag.kind, dx, dy);
      setFrame(clampFrame(next, size.w, size.h));
    };
    const onUp = (e: PointerEvent) => {
      if (dragRef.current?.pointerId !== e.pointerId) return;
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // closedby="any" polyfill for Safari — backdrop click closes.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onPointerDown = (e: PointerEvent) => {
      if (busy || working) return;
      if (e.target === dialog) onCancelRef.current();
    };
    dialog.addEventListener("pointerdown", onPointerDown);
    return () => dialog.removeEventListener("pointerdown", onPointerDown);
  }, [busy, working]);

  async function confirmCrop() {
    if (!frame || busy || working) return;
    setWorking(true);
    try {
      const dataUrl = await cropImage(src, {
        x: frame.x,
        y: frame.y,
        w: frame.width,
        h: frame.height,
      });
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const base = fileName.replace(/\.[^.]+$/, "") || "face";
      onConfirm(new File([blob], `${base}-square.jpg`, { type: "image/jpeg" }));
    } catch {
      onCancel();
    } finally {
      setWorking(false);
    }
  }

  const locked = busy || working;

  return (
    <dialog
      ref={dialogRef}
      className="leo-ui__face-crop"
      aria-labelledby="leo-face-crop-title"
      closedby="any"
      onCancel={(e) => {
        e.preventDefault();
        if (!locked) onCancel();
      }}
    >
      <div className="leo-ui__face-crop-panel">
        <h2 id="leo-face-crop-title" className="leo-ui__face-crop-title">
          Crop face
        </h2>
        <p className="leo-ui__face-crop-sub">
          Drag the square to frame the face. Corners resize; everything outside
          is cut.
        </p>
        <div ref={stageRef} className="leo-ui__face-crop-stage">
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            onLoad={measure}
            style={
              natural
                ? {
                    position: "absolute",
                    left: view.ox,
                    top: view.oy,
                    width: natural.w * view.scale,
                    height: natural.h * view.scale,
                  }
                : undefined
            }
          />
          {frame ? (
            <div
              className="leo-ui__face-crop-frame"
              style={{
                left: view.ox + frame.x * view.scale,
                top: view.oy + frame.y * view.scale,
                width: frame.width * view.scale,
                height: frame.height * view.scale,
              }}
              onPointerDown={(e) => {
                if (e.button !== 0 || locked) return;
                e.preventDefault();
                dragRef.current = {
                  kind: "move",
                  pointerId: e.pointerId,
                  startX: e.clientX,
                  startY: e.clientY,
                  box: frame,
                };
              }}
            >
              {(["nw", "ne", "se", "sw"] as const).map((corner) => (
                <button
                  key={corner}
                  type="button"
                  className={`leo-ui__face-crop-handle leo-ui__face-crop-handle--${corner}`}
                  aria-label="Resize square"
                  disabled={locked}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || locked) return;
                    e.preventDefault();
                    e.stopPropagation();
                    dragRef.current = {
                      kind: corner,
                      pointerId: e.pointerId,
                      startX: e.clientX,
                      startY: e.clientY,
                      box: frame,
                    };
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>
        <div className="leo-ui__face-crop-actions">
          <button
            type="button"
            className="leo-ui__btn leo-ui__btn--back"
            disabled={locked}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="leo-ui__btn leo-ui__btn--next"
            disabled={locked || !frame}
            autoFocus
            onClick={() => void confirmCrop()}
          >
            {working ? "Cropping…" : "Use crop"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
