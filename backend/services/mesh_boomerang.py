from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# Frames closer than this (seconds) to the turnaround count as landing on it.
PIVOT_EPSILON = 1e-3
TIME_DECIMALS = 3


def _lerp_frame(a: dict[str, Any], b: dict[str, Any], t: float) -> dict[str, Any]:
    ta, tb = float(a["t"]), float(b["t"])
    w = 0.0 if tb <= ta else (t - ta) / (tb - ta)
    verts = [
        [round(ax + (bx - ax) * w, 1), round(ay + (by - ay) * w, 1)]
        for (ax, ay), (bx, by) in zip(a["verts"], b["verts"])
    ]
    nearer = a if w < 0.5 else b
    return {"t": t, "verts": verts, "vis": list(nearer["vis"])}


def mirror_frames_in_time(frames: list[dict[str, Any]], pivot_t: float) -> list[dict[str, Any]]:
    """Frames for a boomerang clip: [0, pivot_t] forward, then mirrored back.

    The mirrored half skips only the pivot itself and runs back to t=0,
    matching the video's 2K-1 frame layout (last frame == first frame).
    """
    ordered = sorted(frames, key=lambda frame: float(frame["t"]))
    if not ordered:
        raise ValueError("Mesh has no frames to mirror")
    forward = [frame for frame in ordered if float(frame["t"]) <= pivot_t + PIVOT_EPSILON]
    if not forward:
        raise ValueError(f"Mesh has no frames before the boomerang pivot ({pivot_t:.3f}s)")
    last = forward[-1]
    if abs(float(last["t"]) - pivot_t) > PIVOT_EPSILON:
        after = next((frame for frame in ordered if float(frame["t"]) > pivot_t), None)
        pivot = _lerp_frame(last, after, pivot_t) if after else {**last, "t": pivot_t}
        forward.append(pivot)
    else:
        forward[-1] = {**last, "t": pivot_t}

    out = [{**frame, "t": round(float(frame["t"]), TIME_DECIMALS)} for frame in forward]
    for frame in reversed(forward[:-1]):
        out.append(
            {**frame, "t": round(2 * pivot_t - float(frame["t"]), TIME_DECIMALS)}
        )
    return out


def mirror_mesh_in_time(
    src: Path,
    dst: Path,
    *,
    pivot_t: float,
    total_duration: float,
) -> None:
    """Rewrite a tracked mesh for a boomerang version of its video.

    UV-space data (uv, garment mask, symbol points) has no time component and
    is kept as-is, so symbols and the scratch mask survive the boomerang.
    """
    data = json.loads(src.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("frames"), list):
        raise ValueError(f"Invalid mesh JSON: {src}")
    data["frames"] = mirror_frames_in_time(data["frames"], pivot_t)
    data["durationSeconds"] = round(total_duration, TIME_DECIMALS)
    data["boomerangPivotSeconds"] = round(pivot_t, TIME_DECIMALS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f".{dst.name}.tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")
    tmp.replace(dst)
