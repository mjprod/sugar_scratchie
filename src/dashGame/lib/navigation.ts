/**
 * App navigation classification — primary vs secondary vs immersive vs auth.
 * Secondary pages must show Back; primary never; immersive/auth keep flow controls.
 */
import type { AppOverlay, AppTab } from "@/types/app";

export type NavSurfaceKind =
  | "primary"
  | "secondary"
  | "immersive"
  | "auth";

export type SecondarySurface = {
  id: AppOverlay | "creator";
  kind: "secondary";
  /** Parent when no valid previous in-app context (direct entry / preview). */
  fallbackTab: AppTab;
  title: string;
  backLabel: string;
};

export const PRIMARY_TABS: readonly AppTab[] = [
  "home",
  "feed",
  "hub",
  "bag",
  "profile",
] as const;

/** Route / surface inventory for consistency audits. */
export const SURFACE_KIND: Record<string, NavSurfaceKind> = {
  home: "primary",
  feed: "primary",
  hub: "primary",
  bag: "primary",
  profile: "primary",
  inbox: "secondary",
  cart: "secondary",
  "pack-pocket": "secondary",
  store: "secondary",
  settings: "secondary",
  "change-password": "secondary",
  creator: "secondary",
  "purchase-flow": "immersive",
  game: "immersive",
  "game-ui": "immersive",
  "photo-scratch": "immersive",
  "recommend-intro": "immersive",
  "personalize-swipe": "immersive",
  "personalize-complete": "immersive",
  "sign-in": "auth",
  "create-account": "auth",
  "forgot-password": "auth",
  "reset-password": "auth",
  "verify-email": "auth",
};

export const SECONDARY_SURFACES: Record<string, SecondarySurface> = {
  inbox: {
    id: "inbox",
    kind: "secondary",
    fallbackTab: "profile",
    title: "Inbox",
    backLabel: "Back to Profile",
  },
  cart: {
    id: "cart",
    kind: "secondary",
    fallbackTab: "feed",
    title: "Pack Pocket",
    backLabel: "Back",
  },
  store: {
    id: "store",
    kind: "secondary",
    fallbackTab: "feed",
    title: "Store",
    backLabel: "Back",
  },
  settings: {
    id: "settings",
    kind: "secondary",
    fallbackTab: "profile",
    title: "Settings",
    backLabel: "Back to Profile",
  },
  "change-password": {
    id: "settings",
    kind: "secondary",
    fallbackTab: "profile",
    title: "Change Password",
    backLabel: "Back to Profile",
  },
  creator: {
    id: "creator",
    kind: "secondary",
    fallbackTab: "feed",
    title: "Creator",
    backLabel: "Back",
  },
};

export function isPrimaryTab(tab: AppTab) {
  return PRIMARY_TABS.includes(tab);
}

export function surfaceKind(id: string): NavSurfaceKind | undefined {
  return SURFACE_KIND[id];
}

/** Resolve Back destination: prefer previous tab, else configured fallback. */
export function resolveSecondaryBack(
  previousTab: AppTab | null | undefined,
  surfaceId: keyof typeof SECONDARY_SURFACES,
): AppTab {
  const surface = SECONDARY_SURFACES[surfaceId];
  const fallback = surface?.fallbackTab ?? "home";
  if (previousTab && isPrimaryTab(previousTab)) {
    return previousTab;
  }
  return fallback;
}
