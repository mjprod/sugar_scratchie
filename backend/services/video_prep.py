from __future__ import annotations

import json
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Literal

from backend.services.grok import probe_video

CompressPreset = Literal["mobile", "hd", "master"]

# Prototype canvas is 390×672 — every delivery encode must match this aspect.
DELIVERY_ASPECT_W = 390
DELIVERY_ASPECT_H = 672

DEFAULT_CRF = 23
DEFAULT_WEBM_CRF = 32
DEFAULT_PRESET: CompressPreset = "mobile"

PRESET_SPECS: dict[CompressPreset, dict] = {
    "mobile": {
        "label": "Mobile delivery",
        "description": "390×672 (exact prototype canvas) · CRF 23 — default for scratching.",
        "width": 390,
        "crf": 23,
        "webm_crf": 32,
    },
    "hd": {
        "label": "HD delivery",
        "description": "540×930 (same 390∶672 crop) · CRF 20 — sharper on desktop.",
        "width": 540,
        "crf": 20,
        "webm_crf": 30,
    },
    "master": {
        "label": "Master archive",
        "description": "720×1240 (same 390∶672 crop) · CRF 18 — keep quality for re-edits.",
        "width": 720,
        "crf": 18,
        "webm_crf": 28,
    },
}

# Player "HD videos" twin written beside every delivery clip. Same 390∶672
# cover-crop and timing as the delivery encode, so the tracked mesh (canvas +
# UV coordinates) lines up unchanged. Never upscaled from a smaller source.
HD_VARIANT_WIDTH = 720
HD_VARIANT_CRF = 20
HD_VARIANT_SUFFIX = ".hd"

# Same-footage check: tiny grayscale cover-cropped frames sampled across the
# shared timeline. Re-encodes/rescales of one clip differ by ≲12 mean luma;
# different cards (even same performer + set) differ by ≳38.
CLIP_SIGNATURE_WIDTH = 30
CLIP_SIGNATURE_HEIGHT = 52
CLIP_SIGNATURE_FRAMES = 5
CLIP_MATCH_MAX_LUMA_DIFF = 20.0

# Boomerang: play the first N seconds forward, then the same frames in reverse.
BOOMERANG_DEFAULT_SECONDS = 5.0
BOOMERANG_MIN_FORWARD_FRAMES = 3


def normalize_compress_preset(value: str | None) -> CompressPreset:
    if value in PRESET_SPECS:
        return value  # type: ignore[return-value]
    return DEFAULT_PRESET


def delivery_size(preset: CompressPreset) -> tuple[int, int]:
    """Return even (width, height) for the delivery canvas at the prototype aspect."""
    preset = normalize_compress_preset(preset)
    width = int(PRESET_SPECS[preset]["width"])
    height = int(round(width * DELIVERY_ASPECT_H / DELIVERY_ASPECT_W))
    # yuv420 requires even dimensions
    width -= width % 2
    height -= height % 2
    return width, height


def cover_crop_filter(width: int, height: int) -> str:
    """Scale to cover the target frame, then center-crop — no letterboxing."""
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={width}:{height}"
    )


def run_ffmpeg(cmd: list[str]) -> None:
    result = subprocess.run(cmd, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed:\n{result.stderr or result.stdout}")


def format_size(path: Path) -> str:
    size = path.stat().st_size
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def file_size_bytes(path: Path) -> int:
    return path.stat().st_size if path.is_file() else 0


def _format_bytes(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def log_video(label: str, path: Path) -> None:
    meta = probe_video(path)
    print(
        f"{label}: {path} "
        f"({meta['width']}x{meta['height']}, {meta.get('codec', '?')}, {format_size(path)})"
    )


def _video_width(path: Path) -> int | None:
    try:
        return int(probe_video(path)["width"])
    except Exception:
        return None


def _luma_thumbnail(path: Path, at: float) -> bytes:
    result = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-ss",
            f"{at:.3f}",
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-vf",
            f"{cover_crop_filter(CLIP_SIGNATURE_WIDTH, CLIP_SIGNATURE_HEIGHT)},format=gray",
            "-f",
            "rawvideo",
            "-",
        ],
        check=False,
        capture_output=True,
    )
    if result.returncode != 0 or len(result.stdout) != CLIP_SIGNATURE_WIDTH * CLIP_SIGNATURE_HEIGHT:
        raise RuntimeError(f"Could not sample {path} at {at:.3f}s")
    return result.stdout


def clips_look_alike(a: Path, b: Path) -> bool:
    """True when both files show the same footage on the same timeline,
    whatever their resolution, 390∶672 cover-crop or encode quality."""
    try:
        duration = min(float(probe_video(a)["duration"]), float(probe_video(b)["duration"]))
        for i in range(CLIP_SIGNATURE_FRAMES):
            at = (i + 0.5) / CLIP_SIGNATURE_FRAMES * duration
            thumb_a, thumb_b = _luma_thumbnail(a, at), _luma_thumbnail(b, at)
            diff = sum(abs(x - y) for x, y in zip(thumb_a, thumb_b)) / len(thumb_a)
            if diff > CLIP_MATCH_MAX_LUMA_DIFF:
                return False
    except Exception:
        return False
    return True


def backup_video(src: Path, backup_dir: Path | str = ".video-backups") -> Path | None:
    """Copy `src` into the backup dir, unless the existing backup is a wider
    copy of the same footage.

    Backups are the full-resolution sources for HD twins, so re-compressing an
    already-downscaled delivery clip must not replace them — but a leftover
    from a replaced clip or a reused card id must be.
    """
    if not src.is_file():
        return None
    root = Path(backup_dir)
    root.mkdir(parents=True, exist_ok=True)
    backup = root / f"{src.parent.name}_{src.name}"
    if backup.resolve() == src.resolve():
        backup = root / f"{src.stem}-{src.parent.name}{src.suffix}"
    if backup.is_file():
        backup_width, src_width = _video_width(backup), _video_width(src)
        if (
            backup_width is not None
            and src_width is not None
            and backup_width > src_width
            and clips_look_alike(backup, src)
        ):
            print(
                f"Kept {backup} ({backup_width}px wide) instead of backing up "
                f"{src} ({src_width}px wide)"
            )
            return backup
    shutil.copy2(src, backup)
    print(f"Backed up {src} -> {backup}")
    return backup


def align_clip_to_reference(reference: Path, clip: Path, out: Path) -> Path:
    """Trim and scale a clip to match the shared motion reference timing + pixel size."""
    ref = probe_video(reference)
    clip_meta = probe_video(clip)
    out.parent.mkdir(parents=True, exist_ok=True)
    duration = min(float(ref["duration"]), float(clip_meta["duration"]))
    print(
        f"Aligning {clip.name} to motion reference "
        f"({ref['width']}x{ref['height']} {duration:.2f}s)"
    )
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(clip),
            "-t",
            f"{duration:.3f}",
            "-vf",
            f"scale={ref['width']}:{ref['height']}:force_original_aspect_ratio=decrease,"
            f"pad={ref['width']}:{ref['height']}:(ow-iw)/2:(oh-ih)/2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            str(out),
        ]
    )
    log_video("Aligned", out)
    return out


def probe_video_timing(path: Path) -> dict[str, float | int]:
    """Return fps, frame count, and duration."""
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            "stream=r_frame_rate,nb_read_frames,nb_frames:format=duration",
            "-of",
            "json",
            str(path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed:\n{result.stderr or result.stdout}")
    info = json.loads(result.stdout)
    stream = (info.get("streams") or [{}])[0]
    rate_raw = str(stream.get("r_frame_rate") or "0/1")
    try:
        fps = float(Fraction(rate_raw))
    except (ValueError, ZeroDivisionError):
        fps = 0.0
    frames = 0
    for key in ("nb_read_frames", "nb_frames"):
        raw = stream.get(key)
        if raw not in (None, "N/A", "0", 0):
            try:
                frames = int(raw)
                break
            except (TypeError, ValueError):
                pass
    duration = float((info.get("format") or {}).get("duration") or 0.0)
    if frames <= 0 and fps > 0 and duration > 0:
        frames = max(1, int(round(duration * fps)))
    if fps <= 0 and frames > 0 and duration > 0:
        fps = frames / duration
    if frames <= 0:
        raise RuntimeError(f"Could not determine frame count for {path}")
    if fps <= 0:
        fps = 24.0
    return {"fps": fps, "frames": frames, "duration": duration}


def make_boomerang(
    src: Path,
    dst: Path,
    *,
    seconds: float = BOOMERANG_DEFAULT_SECONDS,
) -> dict:
    """Write the first `seconds` of src forward, then the same frames reversed.

    The reversed half skips only the turnaround frame (already shown at the end
    of the forward half) and runs back to frame 0, so the result has 2K-1
    frames and ends on the same frame it starts with.
    """
    if seconds <= 0:
        raise RuntimeError("Boomerang seconds must be > 0")
    timing = probe_video_timing(src)
    frames = int(timing["frames"])
    fps = float(timing["fps"])
    forward = min(frames, int(round(seconds * fps)))
    if forward < BOOMERANG_MIN_FORWARD_FRAMES:
        raise RuntimeError(
            f"Clip too short for a boomerang: {forward} frames in the first {seconds:.2f}s."
        )
    rate = Fraction(fps).limit_denominator(1001)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f".{dst.stem}.boomerang-tmp{dst.suffix}")
    print(
        f"Boomerang {src.name}: frames 0..{forward - 1} forward + reverse "
        f"({forward / fps:.2f}s → {(2 * forward - 1) / fps:.2f}s)"
    )
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-filter_complex",
            f"[0:v]select=lt(n\\,{forward}),setpts=N/({fps})/TB,split[fwd][rev];"
            f"[rev]reverse,trim=start_frame=1,"
            f"setpts=N/({fps})/TB[back];"
            f"[fwd][back]concat=n=2:v=1:a=0,setpts=N/({fps})/TB[out]",
            "-map",
            "[out]",
            "-r",
            f"{rate.numerator}/{rate.denominator}",
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(tmp),
        ]
    )
    tmp.replace(dst)
    after = probe_video_timing(dst)
    log_video("Boomerang", dst)
    return {
        "fps": fps,
        "frames_before": frames,
        "forward_frames": forward,
        "frames_after": int(after["frames"]),
        "duration_after": float(after["duration"]),
    }


# --- background/foreground pair reconciliation -------------------------------
#
# The prototype plays the pair in two free-running <video> elements, so both
# clips must carry the same fps stamp and the same frame count. Generators
# sometimes return the same content frames with a different fps (the pair then
# drifts apart linearly, ~1/fps seconds per second of playback, resetting at
# each loop) or with extra padding frames on one clip (the pair then desyncs
# around the loop point). Both defects are invisible to duration-only checks.

# Frames are considered paired only if their motion-energy signals correlate at
# least this strongly at the best integer offset.
PAIR_MOTION_CORR_MIN = 0.6
# How many frames of start offset to scan for when pairing the clips.
PAIR_OFFSET_SCAN = 12
_PAIR_PROBE_W = 48
_PAIR_PROBE_H = 84


def _motion_energy(path: Path):
    """Per-frame motion energy: mean |frame[i] - frame[i-1]| over a tiny gray decode."""
    import numpy as np

    result = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-vf",
            f"scale={_PAIR_PROBE_W}:{_PAIR_PROBE_H}",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "pipe:1",
        ],
        check=False,
        capture_output=True,
    )
    frame_bytes = _PAIR_PROBE_W * _PAIR_PROBE_H
    if result.returncode != 0 or len(result.stdout) < frame_bytes * 2:
        raise RuntimeError(
            f"Failed to decode {path.name} for motion analysis: "
            f"{(result.stderr or b'').decode('utf-8', errors='replace')}"
        )
    count = len(result.stdout) // frame_bytes
    frames = (
        np.frombuffer(result.stdout[: count * frame_bytes], dtype=np.uint8)
        .reshape(count, _PAIR_PROBE_H, _PAIR_PROBE_W)
        .astype(np.float32)
    )
    energy = np.abs(np.diff(frames, axis=0)).mean(axis=(1, 2))
    return (energy - energy.mean()) / (energy.std() + 1e-6)


_PAIR_GRID_HZ = 200  # common time grid for cross-fps correlation


def _motion_on_grid(path: Path, native_fps: float) -> tuple:
    """Return (motion_energy_on_200Hz_grid, duration_s).

    Decodes at native rate (no resampling artifacts), computes per-frame motion
    energy, then interpolates onto a 200Hz time grid so clips at different fps
    can be compared at aligned time positions.
    """
    import numpy as np

    result = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-vf",
            f"scale={_PAIR_PROBE_W}:{_PAIR_PROBE_H}",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "pipe:1",
        ],
        check=False,
        capture_output=True,
    )
    frame_bytes = _PAIR_PROBE_W * _PAIR_PROBE_H
    if result.returncode != 0 or len(result.stdout) < frame_bytes * 2:
        raise RuntimeError(
            f"Failed to decode {path.name} for motion analysis: "
            f"{(result.stderr or b'').decode('utf-8', errors='replace')}"
        )
    count = len(result.stdout) // frame_bytes
    frames = (
        np.frombuffer(result.stdout[: count * frame_bytes], dtype=np.uint8)
        .reshape(count, _PAIR_PROBE_H, _PAIR_PROBE_W)
        .astype(np.float32)
    )
    energy = np.abs(np.diff(frames, axis=0)).mean(axis=(1, 2))
    energy = (energy - energy.mean()) / (energy.std() + 1e-6)
    # motion sample i is between frames i and i+1 → mid-point time (i+0.5)/fps
    t = (np.arange(len(energy)) + 0.5) / native_fps
    dur = count / native_fps
    grid = np.arange(0, dur, 1.0 / _PAIR_GRID_HZ)
    return np.interp(grid, t, energy), dur


def _best_time_offset(
    background: Path,
    bg_fps: float,
    foreground: Path,
    fg_fps: float,
) -> tuple[float, float]:
    """Best time offset in seconds (bg leads fg by this amount) and its correlation.

    Uses a 200Hz interpolated motion-energy grid so that clips at different fps
    are compared at matched wall-clock times rather than matched frame indices.
    Searches offsets up to ±0.5s in 5ms steps.
    """
    import numpy as np

    bg_grid, bg_dur = _motion_on_grid(background, bg_fps)
    fg_grid, fg_dur = _motion_on_grid(foreground, fg_fps)

    step_s = 1.0 / _PAIR_GRID_HZ
    span = int(0.5 * _PAIR_GRID_HZ)
    win = int(min(1.5 * _PAIR_GRID_HZ, min(len(bg_grid), len(fg_grid)) // 2))

    # Global best: slide over the full clip in 1.5s windows, take the median offset
    # of the top-corr windows so a single bad window doesn't dominate.
    window_bests: list[tuple[int, float]] = []
    w_step = _PAIR_GRID_HZ // 2
    for lo in range(0, len(fg_grid) - win, w_step):
        hi = lo + win
        best_k, best_c = 0, -9.0
        for k in range(-span, span + 1):
            if lo + k < 0 or hi + k > len(bg_grid):
                continue
            c = float(np.corrcoef(fg_grid[lo:hi], bg_grid[lo + k : hi + k])[0, 1])
            if c > best_c:
                best_k, best_c = k, c
        if best_c > 0:
            window_bests.append((best_k, best_c))

    if not window_bests:
        return 0.0, 0.0

    # Weighted median offset
    window_bests.sort(key=lambda x: x[1], reverse=True)
    top = window_bests[: max(1, len(window_bests) // 2 + 1)]
    offsets = sorted(x[0] for x in top)
    best_k = offsets[len(offsets) // 2]
    best_c = float(np.mean([x[1] for x in top]))
    return best_k * step_s, best_c


def ensure_pair_fps_match(background: Path, foreground: Path) -> dict:
    """Conform the background clip to the foreground's fps stamp and frame count.

    The foreground is what the tracked mesh (and the scratch layer) follows, so
    it is never touched. When the pair disagrees on fps or frame count, motion
    correlation first verifies that the clips really are the same content (at
    matched wall-clock times, tolerating different fps); the background is then
    converted to the foreground's fps and trimmed to the same frame count.

    Two cases are handled:
    - Same fps, different frame count: one-to-one frame remap (no interpolation).
    - Different fps (e.g. 24 vs 30): proper fps conversion via the ffmpeg `fps`
      filter (temporal interpolation), then trim to the foreground's frame count.

    If motion correlation is too low at every offset the pair is likely unrelated
    content; nothing is modified and the report explains the problem.
    """
    bg_timing = probe_video_timing(background)
    fg_timing = probe_video_timing(foreground)
    bg_fps = float(bg_timing["fps"])
    fg_fps = float(fg_timing["fps"])
    bg_frames = int(bg_timing["frames"])
    fg_frames = int(fg_timing["frames"])

    bg_dur = float(bg_timing["duration"])
    fg_dur = float(fg_timing["duration"])

    report: dict = {
        "background": str(background),
        "foreground": str(foreground),
        "bg_fps": bg_fps,
        "fg_fps": fg_fps,
        "bg_frames": bg_frames,
        "fg_frames": fg_frames,
        "bg_duration": round(bg_dur, 4),
        "fg_duration": round(fg_dur, 4),
        "modified": False,
        "ok": True,
    }
    if abs(bg_fps - fg_fps) < 0.01 and bg_frames == fg_frames:
        return report

    # Clips with very different durations are almost certainly not the same
    # content — a 5s background cannot be a valid pair for a 7.5s foreground.
    max_dur = max(bg_dur, fg_dur)
    if max_dur > 0 and abs(bg_dur - fg_dur) / max_dur > 0.15:
        report["ok"] = False
        report["reason"] = (
            f"duration mismatch too large to auto-retime "
            f"(bg {bg_dur:.2f}s vs fg {fg_dur:.2f}s, "
            f"{abs(bg_dur - fg_dur) / max_dur:.0%} apart). "
            "Regenerate this pair."
        )
        print(f"Warning: {report['reason']}")
        return report

    fps_mismatch = abs(bg_fps - fg_fps) >= 0.5
    offset_s, corr = _best_time_offset(background, bg_fps, foreground, fg_fps)
    report["time_offset_s"] = round(offset_s, 4)
    report["motion_corr"] = round(corr, 4)

    if corr < PAIR_MOTION_CORR_MIN:
        report["ok"] = False
        report["reason"] = (
            f"fps/frame-count mismatch (bg {bg_fps:g}fps/{bg_frames}f vs "
            f"fg {fg_fps:g}fps/{fg_frames}f) but motion correlation is only "
            f"{corr:.2f} — clips don't look like the same content, refusing to retime. "
            "Regenerate this pair."
        )
        print(f"Warning: {report['reason']}")
        return report

    tmp = background.with_name(f".{background.stem}.fps-tmp{background.suffix}")

    if fps_mismatch:
        # Different fps: use the fps filter for proper temporal conversion, then
        # trim to the foreground's frame count. A start-frame offset is applied
        # before the fps filter by seeking with -ss so the bg aligns in time.
        start_s = max(0.0, offset_s)
        print(
            f"Pair fps mismatch: bg {bg_fps:g}fps/{bg_frames}f vs "
            f"fg {fg_fps:g}fps/{fg_frames}f "
            f"(time offset {offset_s:+.3f}s, corr {corr:.2f}) — "
            f"converting background to {fg_fps:g}fps, keeping {fg_frames} frames"
        )
        run_ffmpeg(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-ss",
                f"{start_s:.6f}",
                "-i",
                str(background),
                "-vf",
                f"fps={fg_fps},select=between(n\\,0\\,{fg_frames - 1}),setpts=N/{fg_fps}/TB",
                "-r",
                f"{fg_fps}",
                "-an",
                "-c:v",
                "libx264",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(tmp),
            ]
        )
    else:
        # Same fps, different frame count: one-to-one remap, skip offset frames.
        offset_frames = round(offset_s * bg_fps)
        start = max(0, offset_frames)
        end = min(bg_frames, start + fg_frames)
        print(
            f"Pair frame-count mismatch: bg {bg_fps:g}fps/{bg_frames}f vs "
            f"fg {fg_fps:g}fps/{fg_frames}f "
            f"(offset {offset_frames:+d} frames, corr {corr:.2f}) — "
            f"keeping frames {start}..{end - 1}"
        )
        run_ffmpeg(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(background),
                "-vf",
                f"select=between(n\\,{start}\\,{end - 1}),setpts=N/{fg_fps}/TB",
                "-r",
                f"{fg_fps}",
                "-an",
                "-c:v",
                "libx264",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(tmp),
            ]
        )

    tmp.replace(background)
    after = probe_video_timing(background)
    report["modified"] = True
    report["bg_fps_after"] = float(after["fps"])
    report["bg_frames_after"] = int(after["frames"])
    log_video("Pair-synced", background)
    return report


def target_width_for_preset(preset: CompressPreset, source_width: int | None = None) -> int:
    del source_width
    return delivery_size(preset)[0]


def compress_video(
    src: Path,
    dst: Path,
    *,
    width: int | None = None,
    height: int | None = None,
    crf: int = DEFAULT_CRF,
    preset: CompressPreset | None = None,
) -> Path:
    """Encode to a fixed prototype-aspect frame with cover-crop (no letterbox)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    before = probe_video(src)
    if preset is not None:
        preset = normalize_compress_preset(preset)
        spec = PRESET_SPECS[preset]
        width, height = delivery_size(preset)
        crf = int(spec["crf"])
    else:
        if width is None:
            width = DELIVERY_ASPECT_W
        if height is None:
            height = int(round(width * DELIVERY_ASPECT_H / DELIVERY_ASPECT_W))
            height -= height % 2
            width -= width % 2
    assert width is not None and height is not None
    print(
        f"Compressing {src.name}: {before['width']}x{before['height']} "
        f"({format_size(src)}) -> {width}x{height} cover-crop H.264 CRF {crf}"
    )
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-vf",
            cover_crop_filter(width, height),
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            "-level:v",
            "4.0",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            str(crf),
            "-preset",
            "slow",
            "-movflags",
            "+faststart",
            "-an",
            str(dst),
        ]
    )
    after = probe_video(dst)
    if int(after["width"]) != width or int(after["height"]) != height:
        raise RuntimeError(
            f"Delivery encode produced {after['width']}x{after['height']}, "
            f"expected {width}x{height}"
        )
    log_video("Compressed", dst)
    return dst


def compress_video_webm(
    src: Path,
    dst: Path,
    *,
    crf: int = DEFAULT_WEBM_CRF,
    preset: CompressPreset | None = None,
) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if preset is not None:
        crf = int(PRESET_SPECS[normalize_compress_preset(preset)]["webm_crf"])
    # Source is already at delivery size; re-encode only.
    print(f"Writing WebM sidecar: {dst.name} (VP9 CRF {crf})")
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "0",
            "-crf",
            str(crf),
            "-row-mt",
            "1",
            "-an",
            str(dst),
        ]
    )
    log_video("WebM", dst)
    return dst


def _clip_report(path: Path, *, role: str) -> dict:
    if not path.is_file():
        return {"role": role, "path": str(path), "exists": False}
    meta = probe_video(path)
    return {
        "role": role,
        "path": str(path),
        "exists": True,
        "width": int(meta["width"]),
        "height": int(meta["height"]),
        "duration": round(float(meta["duration"]), 3),
        "codec": str(meta.get("codec") or ""),
        "bytes": file_size_bytes(path),
        "size": format_size(path),
        "aspect": round(int(meta["width"]) / max(1, int(meta["height"])), 4),
    }


def hd_variant_path(clip: Path) -> Path:
    """`background.mp4` → `background.hd.mp4` (sibling of the delivery clip)."""
    return clip.with_name(f"{clip.stem}{HD_VARIANT_SUFFIX}{clip.suffix}")


def hd_variant_size() -> tuple[int, int]:
    width = HD_VARIANT_WIDTH - HD_VARIANT_WIDTH % 2
    height = int(round(width * DELIVERY_ASPECT_H / DELIVERY_ASPECT_W))
    return width, height - height % 2


def remove_hd_variants(*clips: Path) -> None:
    for clip in clips:
        hd_variant_path(clip).unlink(missing_ok=True)


def write_hd_variants(
    *,
    background_src: Path,
    foreground_src: Path,
    background_dst: Path,
    foreground_dst: Path,
    work_dir: Path,
) -> dict:
    """Encode the HD twins of a delivery pair from full-resolution sources.

    Leaves existing twins untouched when either source is narrower than the HD
    width — call `drop_out_of_sync_hd_variants` afterwards to discard stale ones.
    """
    width, height = hd_variant_size()
    for src in (background_src, foreground_src):
        src_width = int(probe_video(src)["width"])
        if src_width < width:
            reason = f"{src.name} is {src_width}px wide (< {width}px), not upscaling"
            print(f"HD variants skipped: {reason}")
            return {"written": False, "reason": reason}
    work_dir.mkdir(parents=True, exist_ok=True)
    pairs = ((background_src, background_dst), (foreground_src, foreground_dst))
    tmps: list[tuple[Path, Path]] = []
    for src, dst in pairs:
        tmp = work_dir / f"hd-{dst.stem}-tmp.mp4"
        compress_video(src, tmp, width=width, height=height, crf=HD_VARIANT_CRF)
        tmps.append((tmp, hd_variant_path(dst)))
    for tmp, out in tmps:
        shutil.move(str(tmp), str(out))
    return {
        "written": True,
        "width": width,
        "height": height,
        "crf": HD_VARIANT_CRF,
        "background": _clip_report(hd_variant_path(background_dst), role="background_hd"),
        "foreground": _clip_report(hd_variant_path(foreground_dst), role="foreground_hd"),
    }


def drop_out_of_sync_hd_variants(background: Path, foreground: Path) -> bool:
    """Delete the HD twins unless both exist, match their delivery clip's
    fps + frame count (the mesh is timed against the delivery foreground) and
    show the same footage (a stale source can share the timing).

    Returns True when a usable HD pair remains.
    """
    hd_bg, hd_fg = hd_variant_path(background), hd_variant_path(foreground)
    if not hd_bg.is_file() and not hd_fg.is_file():
        return False
    in_sync = hd_bg.is_file() and hd_fg.is_file()
    for clip, twin in ((background, hd_bg), (foreground, hd_fg)):
        if not in_sync:
            break
        base = probe_video_timing(clip)
        hd = probe_video_timing(twin)
        in_sync = (
            int(base["frames"]) == int(hd["frames"])
            and abs(float(base["fps"]) - float(hd["fps"])) < 0.01
            and clips_look_alike(clip, twin)
        )
    if not in_sync:
        print(f"Removing out-of-sync HD variants for {background.parent.name}")
        remove_hd_variants(background, foreground)
    return in_sync


def finalize_card_videos(
    *,
    background_src: Path,
    foreground_src: Path,
    background_dst: Path,
    foreground_dst: Path,
    motion_reference: Path,
    work_dir: Path,
    backup_dir: Path,
    preset: CompressPreset = DEFAULT_PRESET,
    write_webm: bool = False,
    write_hd: bool = True,
    report_path: Path | None = None,
) -> dict:
    """Align FG to BG, cover-crop both to a fixed prototype-aspect canvas, optional WebM.

    Also writes the player's HD twins (`*.hd.mp4`) from the same sources."""
    preset = normalize_compress_preset(preset)
    spec = PRESET_SPECS[preset]
    target_w, target_h = delivery_size(preset)
    work_dir.mkdir(parents=True, exist_ok=True)

    before = {
        "background": _clip_report(background_dst, role="background"),
        "foreground": _clip_report(foreground_dst, role="foreground"),
    }

    # Prefer work-dir motion/source clips; fall back to published card videos when
    # the work dir was cleaned up (common after remake / recovery).
    motion_ref = (
        motion_reference
        if motion_reference.is_file()
        else background_src
        if background_src.is_file()
        else background_dst
    )
    fg_source = foreground_src if foreground_src.is_file() else foreground_dst
    bg_meta = probe_video(motion_ref)
    fg_meta = probe_video(fg_source)
    pair_sync = ensure_pair_fps_match(background_dst, foreground_dst)

    card_bg_meta = probe_video(background_dst)
    card_fg_meta = probe_video(foreground_dst)
    duration_delta = abs(float(card_bg_meta["duration"]) - float(card_fg_meta["duration"]))
    print(
        "Finalize sync check: "
        f"motion_ref={bg_meta['duration']:.2f}s "
        f"fg_source={fg_meta['duration']:.2f}s "
        f"card_bg={card_bg_meta['duration']:.2f}s "
        f"card_fg={card_fg_meta['duration']:.2f}s "
        f"delta={duration_delta:.3f}s"
    )
    if duration_delta > 0.08:
        print(
            f"Warning: card background/foreground durations differ by {duration_delta:.3f}s — "
            "aligning foreground to the motion reference."
        )

    aligned_fg = work_dir / "foreground-aligned-for-compress.mp4"
    align_clip_to_reference(
        motion_ref,
        foreground_dst,
        aligned_fg,
    )

    bg_tmp = work_dir / "compress-bg-tmp.mp4"
    fg_tmp = work_dir / "compress-fg-tmp.mp4"
    print(
        f"Delivery preset: {preset} ({spec['label']}) — "
        f"{target_w}x{target_h} cover-crop (390∶672), CRF {spec['crf']}"
        + (", WebM sidecars on" if write_webm else ", WebM off")
    )

    # Encode BG first from the card file, then FG from the aligned twin so both
    # share the same pixel grid before the identical cover-crop.
    compress_video(background_dst, bg_tmp, preset=preset)
    compress_video(aligned_fg, fg_tmp, preset=preset)
    hd_report = (
        write_hd_variants(
            background_src=background_dst,
            foreground_src=aligned_fg,
            background_dst=background_dst,
            foreground_dst=foreground_dst,
            work_dir=work_dir,
        )
        if write_hd
        else {"written": False, "reason": "disabled"}
    )
    backup_video(background_dst, backup_dir)
    backup_video(foreground_dst, backup_dir)
    shutil.move(str(bg_tmp), str(background_dst))
    shutil.move(str(fg_tmp), str(foreground_dst))
    hd_report["available"] = drop_out_of_sync_hd_variants(background_dst, foreground_dst)

    webm_paths: list[str] = []
    if write_webm:
        bg_webm = background_dst.with_suffix(".webm")
        fg_webm = foreground_dst.with_suffix(".webm")
        compress_video_webm(background_dst, bg_webm, preset=preset)
        compress_video_webm(foreground_dst, fg_webm, preset=preset)
        webm_paths = [str(bg_webm), str(fg_webm)]

    after = {
        "background": _clip_report(background_dst, role="background"),
        "foreground": _clip_report(foreground_dst, role="foreground"),
    }
    if write_webm:
        after["background_webm"] = _clip_report(
            background_dst.with_suffix(".webm"), role="background_webm"
        )
        after["foreground_webm"] = _clip_report(
            foreground_dst.with_suffix(".webm"), role="foreground_webm"
        )

    before_bytes = sum(int(entry.get("bytes") or 0) for entry in before.values())
    after_bytes = sum(
        int(entry.get("bytes") or 0)
        for key, entry in after.items()
        if key in ("background", "foreground")
    )
    ratio = (after_bytes / before_bytes) if before_bytes else 1.0
    aspect_ok = (
        after["background"].get("width") == target_w
        and after["background"].get("height") == target_h
        and after["foreground"].get("width") == target_w
        and after["foreground"].get("height") == target_h
    )
    report = {
        "preset": preset,
        "preset_label": spec["label"],
        "write_webm": write_webm,
        "target_width": target_w,
        "target_height": target_h,
        "aspect": f"{DELIVERY_ASPECT_W}:{DELIVERY_ASPECT_H}",
        "fit": "cover-crop",
        "crf": int(spec["crf"]),
        "duration_delta_before": round(duration_delta, 3),
        "pair_sync": pair_sync,
        "aspect_ok": aspect_ok,
        "before": before,
        "after": after,
        "before_bytes": before_bytes,
        "after_bytes": after_bytes,
        "size_ratio": round(ratio, 3),
        "saved_bytes": max(0, before_bytes - after_bytes),
        "saved": _format_bytes(max(0, before_bytes - after_bytes)),
        "webm_paths": webm_paths,
        "hd": hd_report,
        "backups": [
            str(backup_dir / f"{background_dst.parent.name}_{background_dst.name}"),
            str(backup_dir / f"{foreground_dst.parent.name}_{foreground_dst.name}"),
        ],
    }
    print(
        f"Finalize complete: {target_w}x{target_h} H.264 cover-crop — "
        f"{format_size(background_dst)} + {format_size(foreground_dst)} "
        f"(was {_format_bytes(before_bytes)}, saved {report['saved']}, ratio {ratio:.0%})"
    )
    if report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote compress report: {report_path}")
    return report
