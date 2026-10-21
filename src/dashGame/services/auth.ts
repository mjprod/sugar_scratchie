/**
 * v8 Authentication — identity + session + pending protected actions only.
 * Recommendation lives in ./recommendation.ts (independent system).
 */

import { apiGet, apiMutate, ApiError } from "../lib/api";
import type { AppTab } from "@/types/app";
import type { PurchaseFlowPack } from "./purchase";

export type AuthUser = {
  id: string;
  email: string;
  provider: AuthProvider;
  emailVerified: boolean;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  genderInterest: "male" | "female" | "both" | null;
  referralCode: string;
  welcomeClaimed: boolean;
  homeTutorialDone: boolean;
  recommendationStatus: string | null;
};

const AUTH_KEY = "sugar.v8.authenticated";
const EMAIL_KEY = "sugar.v8.authEmail";
const USER_ID_KEY = "sugar.v8.authUserId";
const EMAIL_VERIFIED_KEY = "sugar.v8.emailVerified";
const PROVIDER_KEY = "sugar.v8.authProvider";
const HAS_LOGGED_IN_COOKIE = "sugar.v8.hasLoggedIn";
const HAS_LOGGED_IN_MAX_AGE = 60 * 60 * 24 * 365;

export type ProtectedActionType =
  | "like-creator"
  | "follow-creator"
  | "buy-pack"
  | "open-pack"
  | "scratch-card"
  | "view-collection"
  | "view-rewards"
  | "view-profile"
  | "open-store"
  | "redeem-code"
  | "claim-reward"
  | "session-expired";

export type ProtectedAction =
  | { type: "buy"; pack: PurchaseFlowPack; kind?: "buy-pack" | "open-pack" }
  | { type: "like"; feedItemId: string }
  | {
      type: "follow";
      creatorId: string;
      displayName?: string;
      avatarUrl?: string;
    }
  | { type: "tab"; tab: AppTab }
  | { type: "scratch"; pack: PurchaseFlowPack }
  | { type: "photo-scratch"; packId?: string }
  | { type: "store" }
  | { type: "inbox" }
  | { type: "unopened-packs" }
  | { type: "cart" }
  | { type: "add-to-cart"; pack: import("./cart").CartAddInput }
  | { type: "claim" }
  | { type: "collection"; creatorId: string }
  /** SoftGate / deep-link: return to this path after login. */
  | { type: "resume"; path: string }
  | { type: "session-expired" };

export type AuthenticationSheetMode =
  | "login"
  | "create-account"
  | "forgot-password"
  | "reset-sent";

export type AuthProvider = "google" | "apple" | "email";

export type AuthSuccessResult = {
  email: string;
  provider: AuthProvider;
  /** Server user from login/register/oauth when available. */
  user?: AuthUser;
  /** Which auth entry produced this session. */
  source?: "login" | "register" | "oauth";
};

export function isAuthenticated() {
  try {
    return sessionStorage.getItem(AUTH_KEY) === "1";
  } catch {
    return false;
  }
}

export function getAuthEmail() {
  try {
    return sessionStorage.getItem(EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

function readCookie(name: string) {
  if (typeof document === "undefined") return "";
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
  }
  return "";
}

export function hasLoggedInBefore() {
  try {
    if (readCookie(HAS_LOGGED_IN_COOKIE) === "1") return true;
    return localStorage.getItem(HAS_LOGGED_IN_COOKIE) === "1";
  } catch {
    return false;
  }
}

export function markHasLoggedIn() {
  try {
    document.cookie = `${HAS_LOGGED_IN_COOKIE}=1; path=/; max-age=${HAS_LOGGED_IN_MAX_AGE}; SameSite=Lax`;
    localStorage.setItem(HAS_LOGGED_IN_COOKIE, "1");
  } catch {
    /* ignore */
  }
}

export function clearHasLoggedIn() {
  try {
    document.cookie = `${HAS_LOGGED_IN_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
    localStorage.removeItem(HAS_LOGGED_IN_COOKIE);
  } catch {
    /* ignore */
  }
}

/** Returns a live session, logged-out, or unreachable (timeout/network/5xx). */
export async function fetchAuthSession(): Promise<
  | { state: "ok"; authenticated: boolean; user: AuthUser | null }
  | { state: "unreachable"; reason: "unauthorized" | "timeout" | "network" | "http" }
> {
  const result = await apiGet<{ authenticated: boolean; user: AuthUser | null }>(
    "/api/auth/session",
  );
  if (result.ok) {
    return { state: "ok", authenticated: result.data.authenticated, user: result.data.user };
  }
  return { state: "unreachable", reason: result.reason };
}

export async function loginWithEmail(email: string, password: string) {
  return apiMutate<{ ok: boolean; user: AuthUser }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function registerWithEmail(email: string, password: string) {
  return apiMutate<{ ok: boolean; user: AuthUser }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function loginWithOAuth(
  provider: "google" | "apple",
  email: string,
) {
  return apiMutate<{ ok: boolean; user: AuthUser }>(
    `/api/auth/oauth/${provider}`,
    {
      method: "POST",
      body: JSON.stringify({ email }),
    },
  );
}

/** Exchange a Google Identity Services auth code for a server session. */
export async function loginWithGoogle(code: string) {
  return apiMutate<{ ok: boolean; user: AuthUser }>("/api/auth/google", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export function googleAuthFailureMessage() {
  return "We couldn’t sign you in with Google. Please try again.";
}

/** Exchange a Sign in with Apple ID token (+ raw nonce) for a server session. */
export async function loginWithApple(input: {
  idToken: string;
  nonce: string;
  name: string | null;
}) {
  return apiMutate<{ ok: boolean; user: AuthUser }>("/api/auth/apple", {
    method: "POST",
    body: JSON.stringify({
      id_token: input.idToken,
      nonce: input.nonce,
      name: input.name,
    }),
  });
}

export function appleAuthFailureMessage() {
  return "We couldn’t sign you in with Apple. Please try again.";
}

export async function logoutRemote() {
  try {
    await apiMutate("/api/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
}

export async function requestPasswordReset(email: string) {
  await apiMutate("/api/auth/password/forgot", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function resetPasswordWithToken(token: string, password: string) {
  await apiMutate("/api/auth/password/reset", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
}

export function resetPasswordFailureMessage() {
  return "This reset link is invalid or has expired. Request a new one.";
}

/** Ask the server to (re)send the verification email for the current session. */
export async function requestVerificationEmail(): Promise<{ ok: boolean }> {
  try {
    const result = await apiMutate<{ ok?: boolean }>(
      "/api/auth/verify-email/send",
      { method: "POST" },
    );
    // Email may already be out; only treat an explicit ok:false as failure.
    if (result && typeof result === "object" && result.ok === false) {
      return { ok: false };
    }
    return { ok: true };
  } catch (error) {
    // Timeouts can mean the mail was queued but the HTTP response never
    // arrived — fail open so the user can still enter a code they received.
    // Real network/HTTP failures should surface so we don't start cooldown.
    const timedOut =
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError");
    return { ok: timedOut };
  }
}

/** Confirm the email with the one-time code from the verification message. */
export async function confirmVerificationCode(
  code: string,
): Promise<{ ok: boolean; message?: string }> {
  // Strip spaces / dashes so pasted codes from email still match.
  const trimmed = code.trim().replace(/[\s-]/g, "");
  if (!trimmed) return { ok: false, message: "Enter the verification code." };
  try {
    const result = await apiMutate<{ ok?: boolean; detail?: string }>(
      "/api/auth/verify-email/confirm",
      {
        method: "POST",
        body: JSON.stringify({ code: trimmed }),
      },
    );
    if (result && typeof result === "object" && result.ok === false) {
      return {
        ok: false,
        message:
          typeof result.detail === "string" && result.detail.trim()
            ? result.detail
            : undefined,
      };
    }
    return { ok: true };
  } catch (error) {
    const message =
      error instanceof ApiError && error.message.trim()
        ? error.message
        : undefined;
    return { ok: false, message };
  }
}

export function verificationCodeFailureMessage() {
  return "That code is invalid or has expired. Try again or resend.";
}

export function verificationSendFailureMessage() {
  return "We’re having a technical issue right now. Please try again in a little while.";
}

/** AC-VE-003/005: idle "Resend"; cooldown "Resend in {X}s". */
export function resendCooldownLabel(secondsRemaining: number): string {
  if (secondsRemaining > 0) return `Resend in ${secondsRemaining}s`;
  return "Resend";
}

export function createSession(
  email: string,
  provider: AuthProvider = "email",
  userId?: string,
) {
  const normalized = email.trim().toLowerCase();
  try {
    sessionStorage.setItem(AUTH_KEY, "1");
    sessionStorage.setItem(EMAIL_KEY, normalized);
    sessionStorage.setItem(PROVIDER_KEY, provider);
    localStorage.setItem(PROVIDER_KEY, provider);
    if (userId) sessionStorage.setItem(USER_ID_KEY, userId);
    else sessionStorage.removeItem(USER_ID_KEY);
  } catch {
    /* ignore */
  }
  markHasLoggedIn();
  if (provider === "google" || provider === "apple") {
    markEmailVerified();
  }
}

export function getAuthUserId(): string | null {
  try {
    const id = sessionStorage.getItem(USER_ID_KEY);
    return id?.trim() || null;
  } catch {
    return null;
  }
}

export function destroySession() {
  try {
    sessionStorage.removeItem(AUTH_KEY);
    sessionStorage.removeItem(EMAIL_KEY);
    sessionStorage.removeItem(USER_ID_KEY);
    sessionStorage.removeItem(PROVIDER_KEY);
  } catch {
    /* ignore */
  }
}

export function getAuthProvider(): AuthProvider {
  try {
    const raw =
      sessionStorage.getItem(PROVIDER_KEY) ??
      localStorage.getItem(PROVIDER_KEY);
    if (raw === "google" || raw === "apple" || raw === "email") return raw;
  } catch {
    /* ignore */
  }
  return "email";
}

export function needsEmailVerification() {
  return getAuthProvider() === "email" && !isEmailVerified();
}

export function isEmailVerified() {
  try {
    return localStorage.getItem(EMAIL_VERIFIED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markEmailVerified() {
  try {
    localStorage.setItem(EMAIL_VERIFIED_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function clearEmailVerified() {
  try {
    localStorage.removeItem(EMAIL_VERIFIED_KEY);
  } catch {
    /* ignore */
  }
}

/** Prototype rule: at least this many characters. */
export const AUTH_PASSWORD_MIN_LENGTH = 8;

export function isValidAuthPassword(pw: string) {
  return pw.length >= AUTH_PASSWORD_MIN_LENGTH;
}

export function authFailureMessage() {
  return "Incorrect email or password.";
}

export function createAccountFailureMessage() {
  return "Unable to create account. Please try again.";
}

export function duplicateEmailMessage() {
  return "An account with this email already exists.";
}

/** True when /api/auth/register failed because the email is taken. */
export function isDuplicateEmailRegisterError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const hay =
    `${error.message} ${typeof error.body === "string" ? error.body : JSON.stringify(error.body ?? "")}`.toLowerCase();
  if (error.status === 409) return true;
  if (error.status === 400 || error.status === 422) {
    return (
      hay.includes("already") ||
      hay.includes("exist") ||
      hay.includes("taken") ||
      hay.includes("duplicate") ||
      hay.includes("registered")
    );
  }
  return false;
}

export function forgotPasswordSuccessMessage() {
  return "If an account exists for this email, password-reset instructions have been sent.";
}

export type ChangePasswordError =
  | "incorrect_current"
  | "invalid_new"
  | "generic";

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; error: ChangePasswordError };

/**
 * Authenticated password update — prototype.
 * Demo incorrect current: enter `wrong` as the current password.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<ChangePasswordResult> {
  if (!currentPassword.trim()) {
    return { ok: false, error: "incorrect_current" };
  }
  if (!isValidAuthPassword(newPassword)) {
    return { ok: false, error: "invalid_new" };
  }
  try {
    await apiMutate("/api/auth/password/change", {
      method: "POST",
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiError && error.message === "incorrect_current") {
      return { ok: false, error: "incorrect_current" };
    }
    return { ok: false, error: "generic" };
  }
}

export function changePasswordErrorMessage(error: ChangePasswordError) {
  if (error === "incorrect_current") {
    return "Current password is incorrect.";
  }
  if (error === "invalid_new") {
    return `Use at least ${AUTH_PASSWORD_MIN_LENGTH} characters.`;
  }
  return "We couldn't change your password. Please try again.";
}

/** Display-name rules from Complete Profile (min 2, max 24). */
export const DISPLAY_NAME_MAX_LENGTH = 24;

export function normalizeDisplayName(value: string) {
  return value.trim().slice(0, DISPLAY_NAME_MAX_LENGTH);
}

export function displayNameValidationMessage(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Display name is required.";
  if (trimmed.length < 2) return "Display name must be at least 2 characters.";
  return null;
}

/** Username rules from Create Username (4–20, a-z0-9_). */
export const USERNAME_MIN_LENGTH = 4;
export const USERNAME_MAX_LENGTH = 20;

export function normalizeUsername(value: string) {
  return value
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, USERNAME_MAX_LENGTH)
    .toLowerCase();
}

export function usernameValidationMessage(
  value: string,
  opts?: { currentUsername?: string },
): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "Enter a valid username.";
  if (trimmed.length < USERNAME_MIN_LENGTH) {
    return `Username must be at least ${USERNAME_MIN_LENGTH} characters.`;
  }
  if (!/^[a-z0-9_]+$/.test(trimmed)) {
    return "Only letters, numbers, and underscores.";
  }
  const current = (opts?.currentUsername ?? "").trim().toLowerCase();
  if (trimmed !== current && TAKEN_USERNAMES.has(trimmed)) {
    return "This username is already taken.";
  }
  return null;
}

const TAKEN_USERNAMES = new Set(["taken", "admin", "sugar", "test"]);

export type UpdateProfileInput = {
  displayName: string;
  username: string;
  avatarUrl: string | null;
  /** Existing handle — used to skip “taken” when unchanged. */
  currentUsername?: string;
};

export type UpdateProfileResult =
  | { ok: true; user: AuthUser | null }
  | { ok: false };

/**
 * Authenticated profile identity update → `PATCH /api/me/profile`.
 */
export async function updateProfile(
  input: UpdateProfileInput,
): Promise<UpdateProfileResult> {
  const displayName = normalizeDisplayName(input.displayName);
  const username = normalizeUsername(input.username);
  if (displayNameValidationMessage(displayName)) return { ok: false };
  if (
    usernameValidationMessage(username, {
      currentUsername: input.currentUsername,
    })
  ) {
    return { ok: false };
  }

  try {
    const result = await apiMutate<{ user: AuthUser }>(
      "/api/me/profile",
      {
        method: "PATCH",
        body: JSON.stringify({
          display_name: displayName,
          username,
          avatar_url: input.avatarUrl,
        }),
      },
    );
    return { ok: true, user: result.user ?? null };
  } catch {
    return { ok: false };
  }
}

export function updateProfileErrorMessage() {
  return "We couldn't update your profile. Please try again.";
}

export function triggerFromAction(
  action: ProtectedAction | null,
): ProtectedActionType | undefined {
  if (!action) return undefined;
  if (action.type === "like") return "like-creator";
  if (action.type === "follow") return "follow-creator";
  if (action.type === "scratch" || action.type === "photo-scratch") {
    return "scratch-card";
  }
  if (action.type === "store") return "open-store";
  if (action.type === "session-expired") return "session-expired";
  if (action.type === "inbox") return "view-rewards";
  if (action.type === "unopened-packs") return "view-collection";
  if (action.type === "cart" || action.type === "add-to-cart") return "buy-pack";
  if (action.type === "claim") return "claim-reward";
  if (action.type === "collection") return "view-collection";
  if (action.type === "buy") {
    return action.kind === "open-pack" || action.pack.entry === "open"
      ? "open-pack"
      : "buy-pack";
  }
  if (action.type === "resume") {
    const path = action.path.split("?")[0] ?? action.path;
    if (path.startsWith("/collection")) return "view-collection";
    if (path.startsWith("/rewards")) return "view-rewards";
    if (path.startsWith("/profile")) return "view-profile";
    if (path.startsWith("/inbox")) return "view-rewards";
    if (path.startsWith("/pack-pocket") || path.startsWith("/cart")) {
      return "buy-pack";
    }
    return "view-profile";
  }
  if (action.type === "tab") {
    if (action.tab === "hub") return "view-collection";
    if (action.tab === "profile") return "view-profile";
  }
  return undefined;
}

export function supportingCopyForTrigger(
  trigger?: ProtectedActionType,
): string {
  switch (trigger) {
    case "like-creator":
      return "Log in to save creators you like.";
    case "follow-creator":
      return "Log in to follow this creator.";
    case "buy-pack":
      return "Log in to purchase this pack and save it to your account.";
    case "open-pack":
      return "Log in to open this pack and save it to your account.";
    case "view-collection":
      return "Log in to view and continue your collection.";
    case "view-rewards":
    case "claim-reward":
    case "redeem-code":
      return "Log in to view and claim your rewards.";
    case "open-store":
      return "Log in to buy Diamonds.";
    case "scratch-card":
      return "Log in to save the cards you reveal.";
    case "view-profile":
      return "Log in or create an account to save your collection and continue where you left off.";
    case "session-expired":
      return "Your session expired. Log in to continue.";
    default:
      return "Log in or create an account to save your collection and continue where you left off.";
  }
}
