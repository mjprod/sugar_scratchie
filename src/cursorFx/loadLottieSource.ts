// Simplified port of sugar-scratch-cursor-test-main's loadLottieFile: reads a
// .json or .lottie (dotLottie zip) file into the raw source that
// @lottiefiles/dotlottie-web's `DotLottie` can consume directly via its
// `data` config — a JSON string for .json, or the raw zip ArrayBuffer for
// .lottie (its WASM core unzips dotLottie archives itself), so no separate
// unzip/jszip dependency is needed like the original project used.
export type LoadedLottieSource = {
  name: string;
  source: string | ArrayBuffer;
};

function assertLooksLikeLottieJson(text: string, name: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${name} is not a valid Lottie JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!("layers" in obj) && !("assets" in obj) && !("fr" in obj)) {
    throw new Error(`${name} does not look like Lottie animation data`);
  }
}

export async function loadLottieFileSource(file: File): Promise<LoadedLottieSource> {
  const name = file.name;
  const lower = name.toLowerCase();

  if (lower.endsWith(".lottie")) {
    return { name, source: await file.arrayBuffer() };
  }

  const text = await file.text();
  assertLooksLikeLottieJson(text, name);
  return { name, source: text };
}

export async function loadLottieUrlSource(url: string, displayName?: string): Promise<LoadedLottieSource> {
  const name = displayName || url.split("/").pop() || "animation.lottie";
  const lower = name.toLowerCase();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url} (${response.status})`);
  }

  if (lower.endsWith(".lottie")) {
    return { name, source: await response.arrayBuffer() };
  }

  const text = await response.text();
  return { name, source: text };
}
