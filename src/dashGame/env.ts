/** Public env — optional absolute API origin for production builds. */
const viteEnv =
  typeof import.meta !== "undefined"
    ? (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    : undefined;

export const API_BASE_URL = viteEnv?.VITE_API_BASE_URL ?? "";
export const STUB_OAUTH_ENABLED = viteEnv?.VITE_STUB_OAUTH === "1";
export const GOOGLE_CLIENT_ID = (viteEnv?.VITE_GOOGLE_CLIENT_ID ?? "").trim();
export const APPLE_CLIENT_ID = (viteEnv?.VITE_APPLE_CLIENT_ID ?? "").trim();
export const APPLE_REDIRECT_URI = (viteEnv?.VITE_APPLE_REDIRECT_URI ?? "").trim();
