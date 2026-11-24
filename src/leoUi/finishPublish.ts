import { api } from "../shared/api";
import {
  parseTrackedMesh,
  randomSymbolPoints,
  sampleTrackedMesh,
  SYMBOL_POINT_COUNT,
} from "../meshGeometry";
import {
  liteRequestBody,
  type LiteDraftInput,
} from "../videoFlow/lite/defaults";
import type { VideoFlowStepKey } from "../videoFlow/schema";

type LiteStepState = {
  status: "locked" | "ready" | "review" | "approved";
  artifacts: string[];
};

type LiteFlowState = {
  card_id: string;
  steps: Partial<Record<VideoFlowStepKey, LiteStepState>>;
  complete: boolean;
};

const FINISH_STEPS = [
  "boomerang",
  "card",
  "mesh",
  "symbols",
  "compress",
] as const;

type FinishStep = (typeof FINISH_STEPS)[number];

/** Survives leaving /leo-ui so publish can finish after navigating to Models. */
const running = new Set<string>();

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function loadState(cardId: string): Promise<LiteFlowState> {
  return api<LiteFlowState>(
    `/api/video-flow/${encodeURIComponent(cardId)}/state`,
  );
}

async function approveStep(
  cardId: string,
  step: VideoFlowStepKey,
): Promise<LiteFlowState> {
  return api<LiteFlowState>(
    `/api/video-flow/${encodeURIComponent(cardId)}/approve`,
    { method: "POST", body: JSON.stringify({ step }) },
  );
}

async function placeSymbols(cardId: string): Promise<LiteFlowState> {
  const url = `/mesh/${encodeURIComponent(cardId)}.json`;
  let mesh = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(url, { cache: "no-store" });
    if (response.ok) {
      mesh = parseTrackedMesh(await response.json());
      if (mesh) break;
    }
    await sleep(1000);
  }
  if (!mesh) throw new Error("Mesh not ready for symbols.");
  const points = randomSymbolPoints(
    sampleTrackedMesh(mesh, 0),
    SYMBOL_POINT_COUNT,
    mesh.garment,
  );
  if (points.length !== SYMBOL_POINT_COUNT) {
    throw new Error("Could not place symbols.");
  }
  return api<LiteFlowState>(
    `/api/video-flow/${encodeURIComponent(cardId)}/symbol-points`,
    { method: "POST", body: JSON.stringify({ points }) },
  );
}

async function enqueueStep(
  cardId: string,
  step: FinishStep,
  fields: LiteDraftInput,
): Promise<void> {
  await api("/api/jobs/video-flow/step", {
    method: "POST",
    body: JSON.stringify({
      ...liteRequestBody({ ...fields, cardId }),
      step,
      force: false,
    }),
  });
}

async function waitApproved(
  cardId: string,
  step: FinishStep,
): Promise<LiteFlowState> {
  for (let i = 0; i < 180; i += 1) {
    const state = await loadState(cardId);
    if (state.complete) return state;
    const status = state.steps[step]?.status;
    if (status === "approved") return state;
    if (status === "review") {
      // Finish steps shouldn't review, but clear the gate if they do.
      return approveStep(cardId, step);
    }
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${step}.`);
}

/**
 * Background finish: boomerang → publish card → mesh → symbols → compress.
 * Safe to call after leaving Leo — does not touch React state.
 */
export function finishAndPublishCard(
  cardId: string,
  fields: LiteDraftInput,
): Promise<void> {
  const id = cardId.trim();
  if (!id || running.has(id)) return Promise.resolve();
  running.add(id);

  return (async () => {
    try {
      await api(`/api/video-flow/${encodeURIComponent(id)}/draft`, {
        method: "POST",
        body: JSON.stringify(liteRequestBody({ ...fields, cardId: id })),
      });

      let state = await loadState(id);
      if (state.complete) return;

      // Unlock the finish chain if dress/background are still sitting in review.
      for (const step of ["picture", "background", "dress"] as const) {
        if (state.steps[step]?.status === "review") {
          state = await approveStep(id, step);
        }
      }

      for (const step of FINISH_STEPS) {
        state = await loadState(id);
        if (state.complete) return;
        if (state.steps[step]?.status === "approved") continue;

        if (step === "symbols") {
          state = await placeSymbols(id);
          continue;
        }

        await enqueueStep(id, step, fields);
        state = await waitApproved(id, step);
      }
    } finally {
      running.delete(id);
    }
  })();
}
