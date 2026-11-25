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

/** Finalize delivery, then track once — Mask/Symbols edit that lattice. */
const MESH_PREFIX_STEPS = ["boomerang", "card", "compress", "mesh"] as const;
const FINISH_STEPS = [...MESH_PREFIX_STEPS, "symbols"] as const;

type MeshPrefixStep = (typeof MESH_PREFIX_STEPS)[number];
type FinishStep = (typeof FINISH_STEPS)[number];

/** Survives leaving /leo-ui so publish can finish after navigating to Models. */
const running = new Set<string>();
/** In-page mesh prefix (boomerang → card → mesh) — separate from background publish. */
const meshPrefixRunning = new Set<string>();

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
  force = false,
): Promise<void> {
  await api("/api/jobs/video-flow/step", {
    method: "POST",
    body: JSON.stringify({
      ...liteRequestBody({ ...fields, cardId }),
      step,
      force,
    }),
  });
}

/**
 * Run boomerang → card → compress → mesh so Mask/Symbols use the delivery mesh.
 * Skips steps already approved. Safe to await on the Meshing screen.
 */
export async function runThroughMesh(
  cardId: string,
  fields: LiteDraftInput,
  opts?: {
    force?: boolean;
    onState?: (state: LiteFlowState) => void;
    onStep?: (step: MeshPrefixStep) => void;
  },
): Promise<LiteFlowState> {
  const id = cardId.trim();
  if (!id) throw new Error("Missing card.");
  if (meshPrefixRunning.has(id)) {
    // Another call is already driving this card — poll until mesh lands.
    for (let i = 0; i < 180; i += 1) {
      const state = await loadState(id);
      opts?.onState?.(state);
      if (state.steps.mesh?.status === "approved") return state;
      await sleep(2000);
    }
    throw new Error("Timed out waiting for mesh.");
  }
  meshPrefixRunning.add(id);
  try {
    await api(`/api/video-flow/${encodeURIComponent(id)}/draft`, {
      method: "POST",
      body: JSON.stringify(liteRequestBody({ ...fields, cardId: id })),
    });

    let state = await loadState(id);
    opts?.onState?.(state);

    for (const step of ["picture", "background", "dress"] as const) {
      if (state.steps[step]?.status === "review") {
        state = await approveStep(id, step);
        opts?.onState?.(state);
      }
    }

    const forceMesh = Boolean(opts?.force);
    for (const step of MESH_PREFIX_STEPS) {
      state = await loadState(id);
      opts?.onState?.(state);
      // Remake mesh: re-run compress (clears mesh) then track the delivery clip once.
      const forceStep = forceMesh && (step === "mesh" || step === "compress");
      if (state.steps[step]?.status === "approved" && !forceStep) {
        continue;
      }
      opts?.onStep?.(step);
      await enqueueStep(id, step, fields, forceStep);
      state = await waitApproved(id, step);
      opts?.onState?.(state);
    }
    return state;
  } finally {
    meshPrefixRunning.delete(id);
  }
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
 * Background finish: boomerang → card → compress → mesh → symbols.
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
