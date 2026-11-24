import { Theme } from "@radix-ui/themes";
import gsap from "gsap";
import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MaskEditor,
  type MaskEditorHandle,
} from "../videoFlow/MaskEditor";
import brushPlusUrl from "./assets/mask-edit/iconBrushPlus.svg";
import brushRemoveUrl from "./assets/mask-edit/iconBrushRemove.svg";
import chevronUrl from "./assets/mask-edit/chevron.svg";
import minusUrl from "./assets/mask-edit/minus.svg";
import plusUrl from "./assets/mask-edit/plus.svg";
import saveUrl from "./assets/mask-edit/save.svg";
import xLineAUrl from "./assets/mask-edit/x-line-a.svg";
import xLineBUrl from "./assets/mask-edit/x-line-b.svg";

const BRUSH_MIN = 8;
const BRUSH_MAX = 80;
const BRUSH_STEP = 2;
const OPEN_DURATION = 0.55;
const TARGET_WIDTH = 288;
const TARGET_HEIGHT = 512;
const SAVE_CHECK_MS = 2000;

type FromRect = { left: number; top: number; width: number; height: number };

type Props = {
  open: boolean;
  fromRect: FromRect | null;
  videoSrc: string;
  meshFile: string;
  meshUrl: string;
  onClose: () => void;
  onError: (message: string) => void;
};

function preferReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Figma 418:335 — black overlay, scaled video, close X, openable mesh tools. */
export function LeoMaskEditOverlay({
  open,
  fromRect,
  videoSrc,
  meshFile,
  meshUrl,
  onClose,
  onError,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const toolsRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<MaskEditorHandle | null>(null);
  const busyRef = useRef(false);
  const brushReelRef = useRef<HTMLSpanElement | null>(null);
  const brushSlotRef = useRef(0); // 0 = add, 1 = erase, 2 = add (wrap)
  const brushSpinBusyRef = useRef(false);
  const saveReelRef = useRef<HTMLSpanElement | null>(null);
  const saveSlotRef = useRef(0); // 0 = save, 1 = check, 2 = save (wrap)
  const [toolsOpen, setToolsOpen] = useState(false);
  const [brushMode, setBrushMode] = useState<"add" | "erase">("add");
  const [brushRadius, setBrushRadius] = useState(28);
  const [editorReady, setEditorReady] = useState(false);
  const [toolsSettled, setToolsSettled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const saveOkTimerRef = useRef(0);

  function clearSaveOkTimer() {
    if (saveOkTimerRef.current) {
      window.clearTimeout(saveOkTimerRef.current);
      saveOkTimerRef.current = 0;
    }
  }

  /** Sibling order: 0 = tools, 1 = X — stagger uses index so tools leave first. */
  function chromeSiblings() {
    const root = chromeRef.current;
    if (!root) return [] as HTMLElement[];
    return Array.from(root.children) as HTMLElement[];
  }

  function hideChromeInstant() {
    const nodes = chromeSiblings();
    setToolsSettled(false);
    setToolsOpen(false);
    if (nodes.length === 0) return;
    gsap.killTweensOf(nodes);
    nodes.forEach((el, i) => {
      el.classList.remove("is-settled");
      gsap.set(el, {
        // index 0 (tools) keeps xPercent centering
        xPercent: i === 0 ? -50 : 0,
        y: i === 0 ? -36 : -28,
        opacity: 0,
        visibility: "hidden",
        pointerEvents: "none",
      });
    });
  }

  /** Exit: siblings stagger — tools (0) leave slightly before X (1), then scale-down. */
  function dismissChromeThen(after: () => void) {
    const nodes = chromeSiblings();
    const reduce = preferReducedMotion();
    setToolsOpen(false);
    setToolsSettled(false);
    if (nodes.length === 0 || reduce) {
      hideChromeInstant();
      after();
      return;
    }
    gsap.killTweensOf(nodes);
    gsap.to(nodes, {
      y: (i) => (i === 0 ? -40 : -32),
      opacity: 0,
      // Preserve tools centering while tweening y.
      xPercent: (i) => (i === 0 ? -50 : 0),
      duration: 0.28,
      ease: "power2.in",
      stagger: {
        each: 0.1,
        from: "start", // sibling index 0 (tools) first
      },
      onComplete: () => {
        gsap.set(nodes, { visibility: "hidden", pointerEvents: "none" });
        after();
      },
    });
  }

  function revealChromeAfterScale() {
    const nodes = chromeSiblings();
    const reduce = preferReducedMotion();
    setToolsSettled(true);
    if (nodes.length === 0) return;
    gsap.killTweensOf(nodes);
    if (reduce) {
      nodes.forEach((el, i) => {
        gsap.set(el, {
          xPercent: i === 0 ? -50 : 0,
          y: 0,
          opacity: 1,
          visibility: "visible",
          pointerEvents: "auto",
        });
        el.classList.add("is-settled");
      });
      return;
    }
    // Enter: X (end) then tools — reverse of exit feel; still index-based.
    gsap.fromTo(
      nodes,
      {
        xPercent: (i) => (i === 0 ? -50 : 0),
        y: (i) => (i === 0 ? -36 : -28),
        opacity: 0,
        visibility: "visible",
      },
      {
        xPercent: (i) => (i === 0 ? -50 : 0),
        y: 0,
        opacity: 1,
        duration: 0.38,
        ease: "power2.out",
        stagger: {
          each: 0.08,
          from: "end", // X (last sibling) lands first, tools follow
        },
        onComplete: () => {
          gsap.set(nodes, { pointerEvents: "auto" });
          nodes.forEach((el) => el.classList.add("is-settled"));
        },
      },
    );
  }

  useEffect(() => {
    if (!open) {
      setToolsOpen(false);
      setEditorReady(false);
      setToolsSettled(false);
      setBrushMode("add");
      setBrushRadius(28);
      setSaveOk(false);
      clearSaveOkTimer();
    }
  }, [open]);

  useEffect(() => () => clearSaveOkTimer(), []);

  useEffect(() => {
    if (!editorReady) return;
    editorRef.current?.setBrushMode(brushMode);
    editorRef.current?.setBrushRadius(brushRadius);
  }, [editorReady, brushMode, brushRadius]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const stage = stageRef.current;
    if (!open || !dialog || !stage) return;

    if (!dialog.open) dialog.showModal();
    busyRef.current = true;
    setEditorReady(false);
    hideChromeInstant();

    const reduce = preferReducedMotion();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const toW = Math.min(TARGET_WIDTH, vw * 0.72);
    const toH = Math.min(TARGET_HEIGHT, vh * 0.62);
    const toLeft = (vw - toW) / 2;
    const toTop = (vh - toH) / 2 - 24;

    gsap.killTweensOf([dialog, stage]);
    dialog.classList.remove("is-open");

    if (reduce || !fromRect) {
      gsap.set(stage, {
        left: toLeft,
        top: toTop,
        width: toW,
        height: toH,
        borderRadius: 11,
        clearProps: "transform",
      });
      requestAnimationFrame(() => dialog.classList.add("is-open"));
      busyRef.current = false;
      setEditorReady(true);
      revealChromeAfterScale();
      return;
    }

    gsap.set(stage, {
      left: fromRect.left,
      top: fromRect.top,
      width: fromRect.width,
      height: fromRect.height,
      borderRadius: 11,
      x: 0,
      y: 0,
    });

    requestAnimationFrame(() => dialog.classList.add("is-open"));
    gsap.to(stage, {
      left: toLeft,
      top: toTop,
      width: toW,
      height: toH,
      duration: OPEN_DURATION,
      ease: "power3.inOut",
      onComplete: () => {
        busyRef.current = false;
        setEditorReady(true);
        revealChromeAfterScale();
      },
    });

    return () => {
      gsap.killTweensOf(
        [dialog, stage, ...chromeSiblings()].filter(Boolean),
      );
    };
  }, [open, fromRect]);

  function closeOverlay() {
    if (busyRef.current) return;
    const dialog = dialogRef.current;
    const stage = stageRef.current;
    if (!dialog?.open) {
      onClose();
      return;
    }

    const reduce = preferReducedMotion();
    const finish = () => {
      busyRef.current = false;
      dialog.classList.remove("is-open");
      gsap.set(stage, { clearProps: "left,top,width,height,borderRadius,transform" });
      dialog.close();
      onClose();
    };

    busyRef.current = true;

    const scaleDown = () => {
      setEditorReady(false);
      dialog.classList.remove("is-open");

      if (!stage || reduce || !fromRect) {
        finish();
        return;
      }

      gsap.killTweensOf(stage);
      gsap.to(stage, {
        left: fromRect.left,
        top: fromRect.top,
        width: fromRect.width,
        height: fromRect.height,
        duration: OPEN_DURATION * 0.85,
        ease: "power2.inOut",
        onComplete: finish,
      });
    };

    dismissChromeThen(scaleDown);
  }

  function nudgeBrush(delta: number) {
    const next = Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, brushRadius + delta));
    setBrushRadius(next);
    editorRef.current?.setBrushRadius(next);
  }

  const BRUSH_SLOT_PX = 24;

  function setBrushReelSlot(slot: number, animate: boolean) {
    const reel = brushReelRef.current;
    if (!reel) return;
    gsap.killTweensOf(reel);
    const y = -slot * BRUSH_SLOT_PX;
    if (!animate || preferReducedMotion()) {
      gsap.set(reel, { y });
      brushSlotRef.current = slot === 2 ? 0 : slot;
      brushSpinBusyRef.current = false;
      return;
    }
    brushSpinBusyRef.current = true;
    gsap.to(reel, {
      y,
      duration: 0.34,
      ease: "power2.inOut",
      onComplete: () => {
        // Slot 2 is a duplicate add — snap back to 0 so the next spin stays upward.
        if (slot === 2) {
          gsap.set(reel, { y: 0 });
          brushSlotRef.current = 0;
        } else {
          brushSlotRef.current = slot;
        }
        brushSpinBusyRef.current = false;
      },
    });
  }

  useLayoutEffect(() => {
    if (!toolsOpen) return;
    const slot = brushMode === "add" ? 0 : 1;
    brushSlotRef.current = slot;
    setBrushReelSlot(slot, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- park on drawer open only
  }, [toolsOpen]);

  function toggleBrushMode() {
    if (brushSpinBusyRef.current) return;
    const next = brushMode === "add" ? "erase" : "add";
    // Always advance down the reel so the current icon exits up and the next rises in.
    const target = brushMode === "add" ? 1 : 2;
    setBrushMode(next);
    editorRef.current?.setBrushMode(next);
    setBrushReelSlot(target, true);
  }

  const SAVE_SLOT_PX = 16;

  function setSaveReelSlot(slot: number, animate: boolean, onDone?: () => void) {
    const reel = saveReelRef.current;
    if (!reel) {
      onDone?.();
      return;
    }
    gsap.killTweensOf(reel);
    const y = -slot * SAVE_SLOT_PX;
    if (!animate || preferReducedMotion()) {
      gsap.set(reel, { y });
      saveSlotRef.current = slot === 2 ? 0 : slot;
      onDone?.();
      return;
    }
    gsap.to(reel, {
      y,
      duration: 0.34,
      ease: "power2.inOut",
      onComplete: () => {
        if (slot === 2) {
          gsap.set(reel, { y: 0 });
          saveSlotRef.current = 0;
        } else {
          saveSlotRef.current = slot;
        }
        onDone?.();
      },
    });
  }

  async function saveMask() {
    if (saving) return;
    setSaving(true);
    setSaveOk(false);
    clearSaveOkTimer();
    // Reset reel to save if a previous check was showing.
    if (saveSlotRef.current !== 0) setSaveReelSlot(0, false);
    try {
      const ok = (await editorRef.current?.save()) ?? false;
      if (!ok) return;
      setSaveOk(true);
      setSaveReelSlot(1, true);
      saveOkTimerRef.current = window.setTimeout(() => {
        saveOkTimerRef.current = 0;
        // Check exits up; save rises from below, then snap to slot 0.
        setSaveReelSlot(2, true, () => setSaveOk(false));
      }, SAVE_CHECK_MS);
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="leo-ui__mask-edit"
      aria-label="Edit mask"
      onCancel={(e) => {
        e.preventDefault();
        closeOverlay();
      }}
    >
      <div className="leo-ui__mask-edit-stage" ref={stageRef}>
        {!editorReady ? (
          <video
            className="leo-ui__mask-edit-video"
            src={videoSrc}
            autoPlay
            loop
            muted
            playsInline
          />
        ) : (
          <Theme appearance="dark" accentColor="crimson" grayColor="sand" radius="medium">
            <MaskEditor
              ref={editorRef}
              embedded
              meshFile={meshFile}
              meshUrl={meshUrl}
              videoSrc={videoSrc}
              title="Mask"
              onError={onError}
            />
          </Theme>
        )}
      </div>

      {/* Sibling order matters: tools (0) then X (1) for stagger exit. */}
      <div className="leo-ui__mask-edit-chrome" ref={chromeRef}>
      <div
        ref={toolsRef}
        className={`leo-ui__mask-edit-tools${toolsOpen ? " is-open" : ""}${toolsSettled ? " is-settled" : ""}`}
        aria-hidden={!toolsSettled}
      >
        <button
          type="button"
          className="leo-ui__mask-edit-chip leo-ui__mask-edit-tools-toggle"
          aria-expanded={toolsOpen}
          aria-label={toolsOpen ? "Hide mesh tools" : "Show mesh tools"}
          tabIndex={toolsSettled ? 0 : -1}
          onClick={() => setToolsOpen((v) => !v)}
        >
          <img
            src={chevronUrl}
            alt=""
            width={24}
            height={24}
            className="leo-ui__mask-edit-tools-chevron"
          />
        </button>

        <div className="leo-ui__mask-edit-drawer" aria-hidden={!toolsOpen}>
          <button
            type="button"
            className="leo-ui__mask-edit-chip leo-ui__mask-edit-brush"
            aria-label={
              brushMode === "add" ? "Brush add" : "Brush remove"
            }
            aria-pressed={brushMode === "add"}
            onClick={toggleBrushMode}
          >
            <span className="leo-ui__mask-edit-brush-window" aria-hidden>
              <span className="leo-ui__mask-edit-brush-reel" ref={brushReelRef}>
                <img src={brushPlusUrl} alt="" width={24} height={24} />
                <img src={brushRemoveUrl} alt="" width={24} height={24} />
                <img src={brushPlusUrl} alt="" width={24} height={24} />
              </span>
            </span>
          </button>

          <div className="leo-ui__mask-edit-size">
            <button
              type="button"
              className="leo-ui__mask-edit-chip"
              aria-label="Smaller brush"
              onClick={() => nudgeBrush(-BRUSH_STEP)}
            >
              <img src={minusUrl} alt="" width={18} height={18} />
            </button>
            <span className="leo-ui__mask-edit-size-value">{brushRadius}px</span>
            <button
              type="button"
              className="leo-ui__mask-edit-chip"
              aria-label="Larger brush"
              onClick={() => nudgeBrush(BRUSH_STEP)}
            >
              <img src={plusUrl} alt="" width={18} height={18} />
            </button>
          </div>

          <button
            type="button"
            className={`leo-ui__mask-edit-save${saveOk ? " is-saved" : ""}`}
            aria-label={
              saving ? "Saving" : saveOk ? "Saved" : "Save mask"
            }
            disabled={saving}
            onClick={() => void saveMask()}
          >
            <span className="leo-ui__mask-edit-save-window" aria-hidden>
              <span className="leo-ui__mask-edit-save-reel" ref={saveReelRef}>
                <img src={saveUrl} alt="" width={16} height={16} />
                <span className="leo-ui__mask-edit-save-check">
                  <Check size={16} strokeWidth={2.6} />
                </span>
                <img src={saveUrl} alt="" width={16} height={16} />
              </span>
            </span>
          </button>
        </div>
      </div>

      <button
        ref={closeRef}
        type="button"
        className={`leo-ui__mask-edit-close${toolsSettled ? " is-settled" : ""}`}
        aria-label="Close"
        tabIndex={toolsSettled ? 0 : -1}
        onClick={closeOverlay}
      >
        <span className="leo-ui__mask-edit-close-mark" aria-hidden>
          <img src={xLineAUrl} alt="" width={35} height={7} />
          <img src={xLineBUrl} alt="" width={35} height={7} />
        </span>
      </button>
      </div>
    </dialog>
  );
}
