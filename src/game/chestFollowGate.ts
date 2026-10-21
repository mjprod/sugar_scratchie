/**
 * Chest-follow gate while scratching (Phase 8).
 * Continuous pan forces GL presents via camMoved; freeze the camera while the
 * finger is down. Body markers stay live — freezing them made symbols look stuck.
 */
export function shouldUpdateChestFollow(opts: {
  isScratching: boolean;
}): boolean {
  return !opts.isScratching;
}

/** Body markers always track the mesh (UX). Kept for call-site clarity. */
export function shouldUpdateBodyMarkers(_opts: {
  isScratching: boolean;
}): boolean {
  return true;
}
