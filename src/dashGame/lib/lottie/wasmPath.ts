/**
 * Must equal the pinned `@lottiefiles/dotlottie-web` version in package.json
 * (enforced by deferredLottie.self-check.ts). The versioned file name lets the
 * host cache the binary as immutable; scripts/copy-dotlottie-wasm.mjs writes it.
 */
export const DOTLOTTIE_WEB_VERSION = "0.79.0";

// Operator hosts the installed dotlottie-web binary as this unversioned file
// (scripts/copy-dotlottie-wasm.mjs). The player app uses a versioned name.
export const DOTLOTTIE_WASM_PATH = "/wasm/dotlottie-player.wasm";
