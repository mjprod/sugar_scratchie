import { useEffect, useState } from "react";
import { TOP_BAR_DOCK_MS } from "./InitialCountdown";
import {
  MOTION_SCRATCH_BGM_SRC,
  preloadMotionScratchBgm,
  resolveMotionScratchBgmSrc,
  setMotionScratchBgmBed,
  setMotionScratchBgmFull,
  setMotionScratchBgmSrc,
  stopMotionScratchBgm,
} from "./motionScratchBgm";
import { resolveMotionScratchBgmPlan } from "./motionScratchBgmPolicy";
import type { TopBarPhase } from "./TopSymbolBar";
import {
  fetchThemeCatalog,
  type ThemeCatalog,
} from "../shared/themes";

function themeBgmUrl(catalog: ThemeCatalog | null, themeKey: string): string | null {
  const key = themeKey.trim().toLowerCase();
  if (!catalog || !key) return null;
  for (const theme of catalog.themes) {
    const url = theme.bgm?.trim();
    if (!url) continue;
    const id = theme.id.trim().toLowerCase();
    const label = theme.label.trim().toLowerCase();
    if (id === key || label === key) return url;
  }
  return null;
}

/** Catalog default, or the theme track when this card's theme has one. */
export function useScratchBgmSrc(themeKey: string): string {
  const [catalog, setCatalog] = useState<ThemeCatalog | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchThemeCatalog()
      .then((next) => {
        if (!cancelled) setCatalog(next);
      })
      .catch(() => {
        if (!cancelled) setCatalog({ themes: [], defaultBgm: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return resolveMotionScratchBgmSrc(
    themeKey,
    themeBgmUrl(catalog, themeKey),
    catalog?.defaultBgm ?? MOTION_SCRATCH_BGM_SRC,
  );
}

/**
 * Drives the motion-scratch BGM from stage state (see
 * `resolveMotionScratchBgmPlan`). Stops without a fade on unmount.
 *
 * Only a warm → cold change fades the loop out; center → docked must not stop
 * it, so the stop lives in the plan, not in the effect cleanup.
 */
export function useMotionScratchBgm({
  warm,
  topBarPhase,
  skipToPlay = false,
  src,
}: {
  warm: boolean;
  topBarPhase: TopBarPhase;
  skipToPlay?: boolean;
  src?: string;
}) {
  useEffect(() => {
    setMotionScratchBgmSrc(src?.trim() || MOTION_SCRATCH_BGM_SRC);
  }, [src]);

  useEffect(() => {
    const plan = resolveMotionScratchBgmPlan({
      warm,
      topBarPhase,
      skipToPlay,
      dockMs: TOP_BAR_DOCK_MS,
    });
    if (plan.level === "off") {
      stopMotionScratchBgm();
      return;
    }
    preloadMotionScratchBgm();
    if (plan.level === "full") {
      setMotionScratchBgmFull();
      return;
    }
    if (plan.level !== "bed") return;
    setMotionScratchBgmBed();
    if (plan.fullAfterMs == null) return;
    const id = window.setTimeout(setMotionScratchBgmFull, plan.fullAfterMs);
    return () => window.clearTimeout(id);
  }, [warm, topBarPhase, skipToPlay]);

  useEffect(() => () => stopMotionScratchBgm({ fadeOutMs: 0 }), []);
}
