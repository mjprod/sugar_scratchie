import type { AppTab } from "@/types/app";

export const Paths = {
  loading: "/loading",
  preLoader: "/pre-loader",
  /**
   * Store tab (pack browse) lives at root.
   * Home tab (creator reel) lives at /discover.
   * Rank tab (leaderboard) lives at /rank.
   */
  home: "/",
  discover: "/discover",
  rank: "/rank",
  /**
   * Opens the global search overlay on the current page.
   * Prefer `openSearch()` from SearchContext; this query is a deep-link fallback.
   */
  homeSearch: "/?library=1",
  /** Deep-link that opens the global search overlay. */
  search: "/search",
  /** @deprecated Use Paths.home — kept for older imports / redirects. */
  browse: "/",
  creator: (id: string) => `/creator/${id}`,
  creatorPattern: "/creator/:id",
  /** Unlocked motion card detail (Figma 93:590 Keep Playing). */
  motionCard: (creatorId: string, cardId: string) =>
    `/creator/${encodeURIComponent(creatorId)}/motion/${encodeURIComponent(cardId)}`,
  motionCardPattern: "/creator/:id/motion/:cardId",
  collection: "/collection",
  /** Collection hub opened on Unopened Packs. */
  collectionPacks: "/collection?reveal=packs",
  rewards: "/rewards",
  profile: "/profile",
  editProfile: "/profile/edit",
  /** Diamond shop (Get Diamonds). */
  store: "/get-diamonds",
  settings: "/settings",
  changePassword: "/profile/change-password",
  following: "/profile/following",
  gameSettings: "/profile/game-settings",
  contentPreferences: "/profile/content-preferences",
  /** Wallet / purchase ledger (Profile → History). */
  transactions: "/profile/transactions",
  /** Completed scratch/reveal results (Profile → History). */
  gameHistory: "/profile/game-history",
  inbox: "/inbox",
  /** Packs ready to check out — not the Store. */
  packPocket: "/pack-pocket",
  /** @deprecated Use Paths.packPocket */
  cart: "/pack-pocket",
  purchase: (packId: string) => `/purchase/${packId}`,
  purchasePattern: "/purchase/:packId",
  /** Shared tear-open stage — not tied to one influencer pack id. */
  purchaseTearOpen: "/purchase/tear-open",
  purchaseTearOpenSlug: "tear-open",
  game: "/game",
  /** Lab sandbox for iterative game UI work (Juliana motion scratch). */
  gameUi: "/game-ui",
  /** Isolated workshop for assembling Figma pieces one at a time. */
  componentLab: "/component-lab",
  /** Scratch card that replays from the intro, for mixing sound levels. */
  audioTest: "/audio-test",
  photoScratch: "/photo-scratch",
  /** Motion scratch — same query HoloCard uses by default. */
  gamePlay: (
    modelId: string,
    cardId: string,
    extra?: { creatorId?: string; themeId?: string; freePlay?: boolean },
  ) => {
    const params = new URLSearchParams();
    params.set("model", modelId);
    params.set("card", cardId);
    if (extra?.creatorId) params.set("creator", extra.creatorId);
    if (extra?.themeId) params.set("theme", extra.themeId);
    if (extra?.freePlay) params.set("freeplay", "1");
    return `/game?${params.toString()}`;
  },
  /** Static photo scratch from collection PHOTO CARDS (no game=1 → exit to collection / motion page). */
  photoScratchPlay: (
    photoCardId: string,
    extra?: { modelId?: string; creatorId?: string; freePlay?: boolean },
  ) => {
    const params = new URLSearchParams();
    params.set("card", photoCardId);
    const model = extra?.modelId?.trim();
    if (model) params.set("model", model);
    const creator = extra?.creatorId?.trim();
    if (creator) params.set("creator", creator);
    if (extra?.freePlay) params.set("freeplay", "1");
    return `/photo-scratch?${params.toString()}`;
  },
  recommend: "/recommend",
  recommendSwipe: "/recommend/swipe",
  welcome: "/welcome",
  resetPassword: "/reset-password",
  lpBuild: "/join",
  coverflowV2: "/coverflow-v2",
  mobileCarousel: "/mobile-carousel",
  /** @deprecated Design is now the logged-in home at Paths.home. */
  homeVersion2: "/home-version2",
} as const;

/** Tabs guests can open without auth (Store is browseable; purchase still gates). */
export const PUBLIC_TABS: AppTab[] = ["home", "feed", "hub"];

export function pathForTab(tab: AppTab, authed = false): string {
  if (authed) {
    switch (tab) {
      case "home":
        return Paths.rank;
      case "feed":
        return Paths.home;
      case "bag":
        return Paths.discover;
      case "hub":
        return Paths.collection;
      case "profile":
        return Paths.profile;
      default:
        return Paths.discover;
    }
  }
  switch (tab) {
    case "home":
      return Paths.discover;
    case "feed":
      return Paths.home;
    case "bag":
      return Paths.collection;
    case "hub":
      return Paths.store;
    case "profile":
      return Paths.profile;
    default:
      return Paths.home;
  }
}

export function tabFromPathname(
  pathname: string,
  authed = false,
): AppTab | null {
  // Creator pages are a subpage of Collect, so the indicator stays there.
  if (pathname.startsWith("/creator")) {
    return authed ? "hub" : "bag";
  }
  if (
    pathname.startsWith("/profile") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/inbox")
  ) {
    return "profile";
  }

  if (authed) {
    if (pathname.startsWith("/rank")) return "home";
    if (pathname.startsWith("/discover")) return "bag";
    if (
      pathname === "/" ||
      pathname.startsWith("/browse") ||
      pathname.startsWith("/search") ||
      pathname.startsWith("/home-version2")
    ) {
      return "feed";
    }
    if (pathname.startsWith("/collection")) return "hub";
    if (
      pathname.startsWith("/rewards") ||
      pathname.startsWith("/store") ||
      pathname.startsWith("/get-diamonds")
    ) {
      return null;
    }
    return "feed";
  }

  if (pathname.startsWith("/discover")) return "home";
  if (
    pathname === "/" ||
    pathname.startsWith("/browse") ||
    pathname.startsWith("/search") ||
    pathname.startsWith("/home-version2")
  ) {
    return "feed";
  }
  if (pathname.startsWith("/collection")) return "bag";
  if (
    pathname.startsWith("/rewards") ||
    pathname.startsWith("/store") ||
    pathname.startsWith("/get-diamonds")
  ) {
    return "hub";
  }
  return "feed";
}
