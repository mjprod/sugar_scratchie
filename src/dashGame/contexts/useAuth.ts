import { createContext, useContext, type Dispatch, type SetStateAction } from "react";
import type {
  AuthenticationSheetMode,
  AuthSuccessResult,
  ProtectedAction,
} from "@/services/auth";
import type { CartAddInput } from "@/services/cart";
import type { PurchaseFlowPack } from "@/services/purchase";
import type { SECONDARY_SURFACES } from "@/lib/navigation";
import type { AppTab, OnboardingData } from "@/types/app";

export type SecondarySurfaceId = keyof typeof SECONDARY_SURFACES;

export type AuthContextValue = {
  /** False until the initial `/api/auth/session` probe finishes. */
  authReady: boolean;
  authed: boolean;
  guest: boolean;
  hasLoggedInBefore: boolean;
  guestAuthLabel: "Sign in";
  profile: Omit<OnboardingData, "coins" | "diamonds">;
  setProfile: Dispatch<
    SetStateAction<Omit<OnboardingData, "coins" | "diamonds">>
  >;
  authOpen: boolean;
  authSheetMode: AuthenticationSheetMode;
  authSheetEmail: string;
  pending: ProtectedAction | null;
  emailVerified: boolean;
  verifyOpen: boolean;
  resumeLikeId: string | null;
  navNotice: string;
  purchasedPacks: number;
  setPurchasedPacks: Dispatch<SetStateAction<number>>;
  requireAuth: (action: ProtectedAction) => boolean;
  requestTab: (tab: AppTab) => void;
  openStore: () => void;
  openInbox: () => void;
  openUnopenedPacks: () => void;
  openCart: () => void;
  addToCart: (pack: CartAddInput) => void;
  openCreator: (id: string, themeId?: string) => void;
  openPurchase: (pack: PurchaseFlowPack, kind?: "buy-pack" | "open-pack") => void;
  openSettings: () => void;
  openPasswordReset: () => void;
  /** Open auth sheet on Create Account (guest onboarding CTA). */
  openCreateAccount: () => void;
  closeSecondary: (surface: SecondarySurfaceId) => void;
  inventoryRevision: number;
  bumpInventoryRevision: () => void;
  /** Drop in-flight login pack syncs before writing claim/purchase inventory. */
  invalidatePackSync: () => void;
  inboxUnread: number;
  setInboxUnread: Dispatch<SetStateAction<number>>;
  completeAuth: (result: AuthSuccessResult) => void;
  dismissAuth: () => void;
  onVerified: () => void;
  onVerifyLater: () => void;
  onVerifyBack: () => void;
  /** True when verify was opened from Create Account (affects back affordance). */
  verifyFromRegister: boolean;
  onEmailChanged: (email: string) => void;
  notePackPurchaseSeed: (creatorName?: string) => void;
  finishRecommendationAndResume: () => void;
  setPendingAfterRecFromSwipe: (
    liked: string[],
    passed: string[],
  ) => void;
  logout: () => void;
  restart: () => void;
  setNavNotice: (msg: string) => void;
  consumeResumeLike: () => void;
  applyRecommendationDecision: (action: ProtectedAction | null) => void;
  invalidateRemoteSession: () => void;
  verifyEmail: string;
};

/** Session flags only — feed cards subscribe here instead of the full bag. */
export type AuthSessionContextValue = {
  authReady: boolean;
  authed: boolean;
  guest: boolean;
  hasLoggedInBefore: boolean;
  emailVerified: boolean;
};

/** Stable-ish action callbacks — separate so profile/inventory churn won't re-render cards. */
export type AuthActionsContextValue = {
  requireAuth: (action: ProtectedAction) => boolean;
  requestTab: (tab: AppTab) => void;
  openStore: () => void;
  openInbox: () => void;
  openUnopenedPacks: () => void;
  openCart: () => void;
  addToCart: (pack: CartAddInput) => void;
  openCreator: (id: string, themeId?: string) => void;
  openPurchase: (pack: PurchaseFlowPack, kind?: "buy-pack" | "open-pack") => void;
  openSettings: () => void;
  openPasswordReset: () => void;
  openCreateAccount: () => void;
  closeSecondary: (surface: SecondarySurfaceId) => void;
  bumpInventoryRevision: () => void;
  invalidatePackSync: () => void;
  completeAuth: (result: AuthSuccessResult) => void;
  dismissAuth: () => void;
  onVerified: () => void;
  onVerifyLater: () => void;
  onVerifyBack: () => void;
  onEmailChanged: (email: string) => void;
  notePackPurchaseSeed: (creatorName?: string) => void;
  finishRecommendationAndResume: () => void;
  setPendingAfterRecFromSwipe: (
    liked: string[],
    passed: string[],
  ) => void;
  logout: () => void;
  restart: () => void;
  setNavNotice: (msg: string) => void;
  setPurchasedPacks: Dispatch<SetStateAction<number>>;
  consumeResumeLike: () => void;
  applyRecommendationDecision: (action: ProtectedAction | null) => void;
  invalidateRemoteSession: () => void;
};

export const AuthContext = createContext<AuthContextValue | null>(null);
export const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);
export const AuthActionsContext = createContext<AuthActionsContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/** Session flags only — prefer this in feed cards / hot lists. */
export function useAuthSession() {
  const ctx = useContext(AuthSessionContext);
  if (!ctx) throw new Error("useAuthSession must be used within AuthProvider");
  return ctx;
}

/** Auth actions only — avoids re-renders from profile / inventory / sheet state. */
export function useAuthActions() {
  const ctx = useContext(AuthActionsContext);
  if (!ctx) throw new Error("useAuthActions must be used within AuthProvider");
  return ctx;
}
