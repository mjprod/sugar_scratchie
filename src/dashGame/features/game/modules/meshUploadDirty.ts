/**
 * Skip GPU mesh-position uploads when verts haven't moved enough (Phase 6).
 * Mesh is often ~10fps while FG video is ~30fps; sub-pixel interpolations
 * between tracked frames don't need a fresh bufferSubData.
 */

/** CSS pixels — below this, reuse the last uploaded punch lattice. */
export const MESH_UPLOAD_EPS_PX = 0.5;

/**
 * Returns true when any of the first `vertCount` xy pairs moved more than eps.
 * `pos` / `prev` are interleaved [x0,y0,x1,y1,…].
 */
export function meshPositionsNeedUpload(
  pos: ArrayLike<number>,
  prev: ArrayLike<number> | null,
  vertCount: number,
  epsPx = MESH_UPLOAD_EPS_PX,
): boolean {
  if (!prev || prev.length < vertCount * 2) return true;
  const n = vertCount * 2;
  for (let i = 0; i < n; i += 1) {
    if (Math.abs(pos[i]! - prev[i]!) > epsPx) return true;
  }
  return false;
}

/** Copy interleaved positions into a reusable buffer (grows if needed). */
export function copyMeshPositions(
  dest: Float32Array | null,
  src: ArrayLike<number>,
  vertCount: number,
): Float32Array {
  const n = vertCount * 2;
  const out =
    dest && dest.length >= n ? dest : new Float32Array(Math.max(n, dest?.length ?? 0));
  for (let i = 0; i < n; i += 1) out[i] = src[i]!;
  return out;
}
