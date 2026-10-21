import { setWasmUrl } from "@lottiefiles/dotlottie-react";
import { DOTLOTTIE_WASM_PATH } from "./wasmPath";

// Self-hosted (see scripts/copy-dotlottie-wasm.mjs) so Lotties never depend on
// cdn.jsdelivr.net. Also covers direct @lottiefiles/dotlottie-web imports only
// while package.json pins the same dotlottie-web version dotlottie-react uses.
// Import this module (side effect) from every Lottie consumer.
if (typeof window !== "undefined") {
  setWasmUrl(new URL(DOTLOTTIE_WASM_PATH, window.location.origin).href);
}
