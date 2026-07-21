"""Cut the performer out of a photo-scratch still (girl without background).

Uses rembg BiRefNet for the matte (far cleaner arm / sleeve edges than the
SegFormer clothes parser), then punches hands-on-hips arm gaps with SegFormer
background labels + a color pocket erase (BiRefNet often fills those). Cover-
crops RGBA to OUTPUT_SCALE × (390×672) so phones keep sharp pixels. Light rim
choke + color defringe remove the pale wall halo on light fabric. Mesh Mask
Editor erase still works for any leftovers.

Paired bikini/clothes cutouts share one matte so hair/skin edges match.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

from backend.services.photo_canvas import CANVAS_HEIGHT, CANVAS_WIDTH

ROOT = Path(__file__).resolve().parents[2]

# rembg session name — BiRefNet keeps sleeve curves without the SegFormer stair-steps.
REMBG_MODEL = "birefnet-general"
# Choke soft matte by this many canvas-equivalent px (kills pale fringe).
# Keep small — large choke eats fingers / thin wrists / arm silhouette.
RIM_CHOKE = 1.15
# Pull fill colors this many px inside the person.
DEFRINGE_PULL = 5
# Drop rim pixels this much brighter than interior (wall spill on sleeves).
# 22 → only strips obvious white-wall halo; leaves darker outfit fabrics intact.
BRIGHT_SPILL_LUMA = 22.0
# Gaussian sigma (px at canvas resolution) for the silhouette edge feather.
# 1.0 = barely-visible soft anti-alias; 0 = hard edge.
EDGE_FEATHER_SIGMA = 1.0
# Cap input so huge AI stills stay fast (still >> 390×672).
MAX_SEG_SIDE = 1280
# Max fraction of the frame a single filled dropout may cover. Sleeve cracks are
# tiny; hands-on-hips arm gaps are large — never refill those after we punch them.
MAX_HOLE_FILL_FRAC = 0.002
# Ship cutouts at 3× logical canvas so DPR-2/3 phones stay sharp. Mesh/game
# coordinates stay in 390×672 space (cover_to_canvas downscales for mesh).
OUTPUT_SCALE = 3
OUTPUT_WIDTH = CANVAS_WIDTH * OUTPUT_SCALE
OUTPUT_HEIGHT = CANVAS_HEIGHT * OUTPUT_SCALE

_rembg_session = None


def _load_generator():
    """SegFormer helper — still used by photo_match for silhouettes."""
    path = ROOT / "scripts" / "generate-mesh-tracking.py"
    spec = importlib.util.spec_from_file_location("photo_cutout_gen", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load mesh generator: {path}")
    module = importlib.util.module_from_spec(spec)
    os.environ.setdefault("DEVICE", "cpu")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    spec.loader.exec_module(module)
    return module


def _resize_max_side(rgb: np.ndarray, max_side: int) -> tuple[np.ndarray, float]:
    h, w = rgb.shape[:2]
    long = max(h, w)
    if long <= max_side:
        return rgb, 1.0
    scale = max_side / long
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    resized = np.asarray(
        Image.fromarray(rgb).resize((new_w, new_h), Image.Resampling.LANCZOS),
        dtype=np.uint8,
    )
    return resized, scale


def _person_mask_keep_holes(rgb: np.ndarray, gen) -> np.ndarray:
    """Binary person mask for match / fallback (SegFormer clothes parse)."""
    small, scale = _resize_max_side(rgb, MAX_SEG_SIDE)
    seg = gen._segment(small)
    mask = seg != 0
    mask = ndimage.binary_closing(mask, structure=np.ones((3, 3), bool), iterations=1)
    labels, count = ndimage.label(mask)
    if count == 0:
        return np.zeros(rgb.shape[:2], dtype=bool)
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    mask = labels == int(counts.argmax())
    if scale != 1.0:
        h, w = rgb.shape[:2]
        mask = (
            np.asarray(
                Image.fromarray(mask.astype(np.uint8) * 255).resize(
                    (w, h), Image.Resampling.NEAREST
                ),
                dtype=np.uint8,
            )
            > 127
        )
    return mask


def _get_rembg_session():
    global _rembg_session
    if _rembg_session is None:
        from rembg import new_session

        _rembg_session = new_session(REMBG_MODEL)
    return _rembg_session


def _rembg_rgba(rgb: Image.Image) -> Image.Image:
    from rembg import remove

    # Work at capped long-side for speed; rembg returns soft alpha.
    arr = np.asarray(rgb.convert("RGB"), dtype=np.uint8)
    small, scale = _resize_max_side(arr, MAX_SEG_SIDE)
    cut = remove(Image.fromarray(small), session=_get_rembg_session())
    cut = cut.convert("RGBA")
    if scale != 1.0:
        cut = cut.resize(rgb.size, Image.Resampling.LANCZOS)
    return cut


def _fill_alpha_holes(rgb: np.ndarray, alpha: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Fill sleeve / arm dropouts without closing the intentional arm-hip gap.

    Two-step strategy:
    1. MICRO-CLOSE (≤2 % of short side, 1 iter): seals tiny cracks at sleeve
       edges so BiRefNet dropouts that are nearly-enclosed become truly enclosed.
    2. binary_fill_holes on the micro-closed mask: fills every fully enclosed
       void (sleeve dropouts, interior gaps).

    The arm-body gap (hands-on-hips triangle) is WIDE and connects to the
    exterior on both sides — micro-close cannot bridge it, so fill_holes
    leaves it transparent.  A large closing kernel would bridge it, so we
    deliberately avoid that.
    """
    hard = alpha >= 0.4
    if not hard.any():
        return alpha, rgb

    # Step 1 — tiny closing to turn near-enclosed sleeve dropout into closed region.
    # ~1.5 % of short side (≈6 px at 390 canvas, ≈17 px at 1170 match plate).
    k = max(7, int(round(min(hard.shape) * 0.015)) | 1)
    micro = ndimage.binary_closing(
        hard, structure=np.ones((k, k), dtype=bool), iterations=1
    )

    # Step 2 — fill holes that are now fully enclosed after micro-close.
    filled = ndimage.binary_fill_holes(micro)

    # Only allow additions inside the person bounding box (don't grow limbs).
    rows = np.where(hard.any(axis=1))[0]
    cols = np.where(hard.any(axis=0))[0]
    if rows.size and cols.size:
        pad = k * 2
        r0 = max(0, int(rows.min()) - pad)
        r1 = min(hard.shape[0], int(rows.max()) + pad)
        c0 = max(0, int(cols.min()) - pad)
        c1 = min(hard.shape[1], int(cols.max()) + pad)
        allow = np.zeros_like(hard)
        allow[r0:r1, c0:c1] = True
    else:
        allow = ndimage.binary_dilation(hard, iterations=k * 2)

    add = filled & allow & ~hard
    if not add.any():
        return alpha, rgb

    # Drop large enclosed voids (arm–hip triangles). Only seal tiny sleeve cracks.
    labels, count = ndimage.label(add)
    if count > 0:
        counts = np.bincount(labels.ravel())
        max_px = max(64, int(hard.size * MAX_HOLE_FILL_FRAC))
        keep = np.zeros(count + 1, dtype=bool)
        keep[1:] = counts[1:] <= max_px
        add = keep[labels]

    if not add.any():
        return alpha, rgb

    out_a = alpha.copy()
    out_a[add] = 1.0
    out_rgb = rgb.copy()
    _, (iy, ix) = ndimage.distance_transform_edt(~hard, return_indices=True)
    out_rgb[add] = rgb[iy[add], ix[add]]
    return out_a, out_rgb


def _choke_alpha(alpha: np.ndarray, px: float) -> np.ndarray:
    """Shrink the matte slightly so pale wall pixels drop out of the rim."""
    if px <= 0:
        return alpha
    hard = alpha >= 0.5
    if not hard.any():
        return alpha
    dist_in = ndimage.distance_transform_edt(hard)
    # Pixels within `px` of the exterior get a linear fade from the choked edge.
    faded = np.clip((dist_in - px) / max(px, 0.5), 0.0, 1.0)
    out = alpha * faded
    out[~hard] = 0.0
    return out


def _strip_bright_rim(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Zero alpha on outer rim pixels brighter than the interior (wall halo)."""
    hard = alpha >= 0.4
    if not hard.any():
        return alpha
    pull = max(2, DEFRINGE_PULL)
    deep = ndimage.binary_erosion(hard, iterations=pull)
    if not deep.any():
        return alpha
    _, (iy, ix) = ndimage.distance_transform_edt(~deep, return_indices=True)
    rim = hard & ndimage.binary_dilation(~hard, iterations=3)
    if not rim.any():
        return alpha
    luma = rgb.astype(np.float32).mean(axis=2)
    interior_luma = luma[iy, ix]
    bright = rim & ((luma - interior_luma) >= BRIGHT_SPILL_LUMA)
    out = alpha.copy()
    out[bright] = 0.0
    return out


def _defringe_rgb(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Replace fringe RGB with colors pulled from deep inside the person."""
    hard = alpha >= 0.5
    if not hard.any():
        out = rgb.copy()
        out[alpha <= 0] = 0
        return out
    pull = max(1, DEFRINGE_PULL)
    deep = ndimage.binary_erosion(hard, iterations=pull)
    if not deep.any():
        deep = hard
    _, (iy, ix) = ndimage.distance_transform_edt(~deep, return_indices=True)
    rim = hard & ndimage.binary_dilation(~hard, iterations=max(2, pull))
    fringe = (alpha > 0.0) & ((alpha < 0.97) | rim)
    out = rgb.copy()
    if fringe.any():
        out[fringe] = rgb[iy[fringe], ix[fringe]]
    out[alpha <= 0.0] = 0
    return out


def _sample_wall_color(
    source_rgb: np.ndarray, hard: np.ndarray, margin: int = 8
) -> tuple[np.ndarray, float]:
    """Median pink/beige wall color from outside the matte (+ mid-height side strips)."""
    h, w = source_rgb.shape[:2]
    outside = ~ndimage.binary_dilation(hard, iterations=margin)
    if not outside.any():
        outside = np.zeros((h, w), dtype=bool)
        outside[:6, :] = outside[-6:, :] = outside[:, :6] = outside[:, -6:] = True

    # Arm gaps open toward mid-torso sides — bias the sample there.
    y0, y1 = int(h * 0.28), int(h * 0.62)
    side = np.zeros((h, w), dtype=bool)
    band = max(6, w // 20)
    side[y0:y1, :band] = True
    side[y0:y1, -band:] = True
    sample = outside | (side & ~hard)
    pixels = source_rgb[sample].astype(np.float32)
    if pixels.size == 0:
        pixels = source_rgb[outside].astype(np.float32)
    bg_color = np.median(pixels, axis=0)
    bg_mad = float(np.median(np.abs(pixels - bg_color).mean(axis=1)))
    return bg_color, bg_mad


def _wall_color_mask(
    source_rgb: np.ndarray, bg_color: np.ndarray, threshold: float
) -> np.ndarray:
    """Pixels matching the pink/beige wall (tight — avoids skin/fabric)."""
    diff = np.linalg.norm(source_rgb.astype(np.float32) - bg_color, axis=2)
    return diff < threshold


def _flood_from_border(passable: np.ndarray) -> np.ndarray:
    """True for components of `passable` that touch the frame border."""
    labels, count = ndimage.label(passable)
    if count == 0:
        return np.zeros(passable.shape, dtype=bool)
    h, w = passable.shape
    border = np.zeros((h, w), dtype=bool)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    border_labels = set(int(x) for x in np.unique(labels[border]) if x)
    if not border_labels:
        return np.zeros(passable.shape, dtype=bool)
    return np.isin(labels, list(border_labels))


def _erase_background_pockets(
    source_rgb: np.ndarray,
    alpha: np.ndarray,
    body_protect: np.ndarray | None = None,
    margin: int = 8,
) -> np.ndarray:
    """Zero matte pixels that match the real scene background (arm-hip gaps).

    BiRefNet often paints the hands-on-hips triangles as opaque. Sample the wall
    from the *original* still (rembg clears RGB under alpha=0 to black). Erase
    wall-colored matte pixels; protect SegFormer body pixels (not an erosion of
    the BiRefNet mask — that erosion treats filled arm gaps as "core" and skips
    them). Flood from the frame border through wall-colored pixels so open or
    barely-open bays clear too.
    """
    hard = alpha >= 0.35
    if not hard.any():
        return alpha

    # Protect true body (SegFormer) — lightly eroded so sleeve fringes can still
    # be color-punched. Fall back to a mild BiRefNet erosion only if missing.
    if body_protect is not None and body_protect.any():
        protect = ndimage.binary_erosion(body_protect, iterations=1)
        if not protect.any():
            protect = body_protect
    else:
        protect = ndimage.binary_erosion(hard, iterations=max(3, DEFRINGE_PULL))
        if not protect.any():
            protect = hard

    bg_color, bg_mad = _sample_wall_color(source_rgb, hard, margin=margin)
    person_pixels = source_rgb[protect].astype(np.float32)
    person_color = np.median(person_pixels, axis=0)
    # Loose enough for warm studio walls; still below typical skin/fabric delta.
    threshold = max(52.0, bg_mad * 3.5)

    rgb_f = source_rgb.astype(np.float32)
    diff_bg = np.linalg.norm(rgb_f - bg_color, axis=2)
    diff_person = np.linalg.norm(rgb_f - person_color, axis=2)
    match_bg = diff_bg < threshold
    nearer_bg = (diff_bg + 10.0) < diff_person

    # Wall-colored matte that is NOT SegFormer body.
    bg_pocket = hard & ~protect & (match_bg | nearer_bg)

    # Flood from the frame border through wall-colored pixels (open arm bays).
    passable = (~hard) | (match_bg & ~protect)
    exterior = _flood_from_border(passable)
    bg_pocket |= hard & ~protect & match_bg & exterior

    if not bg_pocket.any():
        return alpha

    out = alpha.copy()
    out[bg_pocket] = 0.0
    print(
        f"Background pocket erase: bg_color={bg_color.astype(int).tolist()}, "
        f"thresh={threshold:.1f}, erased={int(bg_pocket.sum())} px",
        flush=True,
    )
    return out


def _erase_arm_wall_gaps(source_rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Mask pink/beige wall between the arms, then make it transparent.

    Recipe (same as manual cleanup):
      1. Paint a selection on the arm-bay wall (not the body)
      2. Remove / zero alpha — "remove the pink/beige wall background between the arms"
      3. Clean edges, no artifacts — thin rim choke on the punched hole

    Skin and wall are close in this theme, so we protect a torso skin core, require
    mild wallpaper texture, flood from the frame border, and refuse oversized
    selections (those would eat arms/waist).
    """
    hard = alpha >= 0.35
    if not hard.any():
        return alpha

    bg_color, _bg_mad = _sample_wall_color(source_rgb, hard, margin=10)
    diff_bg = np.linalg.norm(source_rgb.astype(np.float32) - bg_color, axis=2)

    ys, xs = np.where(hard)
    cy = int(np.median(ys))
    cx = int(np.median(xs))
    y0, y1 = max(0, cy - 40), min(hard.shape[0], cy + 40)
    x0, x1 = max(0, cx - 30), min(hard.shape[1], cx + 30)
    skin_patch = source_rgb[y0:y1, x0:x1].reshape(-1, 3).astype(np.float32)
    if skin_patch.size == 0:
        return alpha
    skin_color = np.median(skin_patch, axis=0)
    diff_skin = np.linalg.norm(source_rgb.astype(np.float32) - skin_color, axis=2)

    # Confident torso skin — never punch these (or a dilated halo around them).
    skin_protect = ndimage.binary_dilation(
        hard & (diff_skin < 32.0), iterations=5
    )

    # Mild local variance — wallpaper icons vs smooth skin.
    gray = source_rgb.astype(np.float32).mean(axis=2)
    mean = ndimage.uniform_filter(gray, size=7)
    var = np.clip(ndimage.uniform_filter(gray * gray, size=7) - mean * mean, 0, None)

    wall = (diff_bg < 48.0) & ~skin_protect & (var > 18.0)
    selection = hard & wall & _flood_from_border((diff_bg < 48.0) | ~hard)
    if not selection.any():
        return alpha

    labels, count = ndimage.label(selection)
    if count == 0:
        return alpha
    counts = np.bincount(labels.ravel())
    min_px = max(100, int(hard.sum() * 0.0008))
    max_px = max(min_px + 1, int(hard.sum() * 0.025))
    keep = np.zeros(count + 1, dtype=bool)
    keep[1:] = (counts[1:] >= min_px) & (counts[1:] <= max_px)
    selection = keep[labels]
    if not selection.any():
        return alpha

    # Abort if the selection is suspiciously large (would carve the body).
    if float(selection.sum()) > hard.sum() * 0.04:
        print(
            f"Arm-wall gap erase skipped: selection too large "
            f"({int(selection.sum())} px / {int(hard.sum())} hard)",
            flush=True,
        )
        return alpha

    out = alpha.copy()
    out[selection] = 0.0
    rim = (
        ndimage.binary_dilation(selection, iterations=2)
        & (out >= 0.35)
        & (diff_bg < 54.0)
        & ~skin_protect
    )
    out[rim] = 0.0

    print(
        f"Arm-wall gap erase: wall={bg_color.astype(int).tolist()}, "
        f"erased={int(selection.sum())} px (+{int(rim.sum())} rim) — "
        f"clean edges, no artifacts",
        flush=True,
    )
    return out


def _arm_gap_hole_mask(alpha: np.ndarray, close_px: int = 9) -> np.ndarray:
    """Binary mask of hands-on-hips arm gaps from a cutout alpha channel."""
    hard = alpha >= 128
    if not hard.any():
        return np.zeros(alpha.shape, dtype=bool)

    # Seal tiny hand/hip openings so arm bays become true holes, then keep only
    # pixels that were transparent on the reference (not invented by closing).
    k = max(3, int(close_px) | 1)
    closed = ndimage.binary_closing(
        hard, structure=np.ones((k, k), dtype=bool), iterations=1
    )
    holes = ndimage.binary_fill_holes(closed) & ~hard
    if not holes.any():
        return holes

    labels, count = ndimage.label(holes)
    if count > 0:
        counts = np.bincount(labels.ravel())
        min_px = max(30, int(hard.size * 0.0004))
        keep = np.zeros(count + 1, dtype=bool)
        keep[1:] = counts[1:] >= min_px
        holes = keep[labels]

    if not holes.any():
        return holes

    # Grow holes a couple px to clear soft fringe, but stay inside the sealed body.
    return ndimage.binary_dilation(holes, iterations=2) & closed


def apply_cutout_holes(cutout_path: Path, holes: np.ndarray) -> int:
    """Zero alpha (and RGB) where `holes` is set. Returns punched pixel count."""
    if not holes.any():
        return 0
    img = Image.open(cutout_path).convert("RGBA")
    arr = np.asarray(img).copy()
    if holes.shape != arr.shape[:2]:
        holes = (
            np.asarray(
                Image.fromarray(holes.astype(np.uint8) * 255).resize(
                    (arr.shape[1], arr.shape[0]), Image.Resampling.NEAREST
                ),
                dtype=np.uint8,
            )
            > 127
        )
    arr[holes, 3] = 0
    arr[holes, :3] = 0
    Image.fromarray(arr, mode="RGBA").save(cutout_path, format="PNG", optimize=True)
    return int(holes.sum())


def sync_pose_matched_cutout_holes(
    bikini_path: Path,
    clothes_path: Path,
    close_px: int = 21,
) -> None:
    """Punch clothes pixels that sit in the bikini's arm–hip bays.

    Prefer open-bay transfer: clothes still opaque where bikini is already clear
    (pink/beige wall the top edit left between the arms). Envelope close is a
    fallback when layers align but bays are only topological holes.
    """
    del close_px  # kept for call-site compatibility
    if not bikini_path.is_file() or not clothes_path.is_file():
        return
    bikini_a = np.asarray(Image.open(bikini_path).convert("RGBA"))[..., 3]
    clothes_a = np.asarray(Image.open(clothes_path).convert("RGBA"))[..., 3]
    if bikini_a.shape != clothes_a.shape:
        bikini_a = np.asarray(
            Image.fromarray(bikini_a).resize(
                (clothes_a.shape[1], clothes_a.shape[0]), Image.Resampling.NEAREST
            )
        )

    clothes_rgba = np.asarray(Image.open(clothes_path).convert("RGBA"))
    clothes_rgb = clothes_rgba[..., :3]

    # 1) Direct: remove pink/beige wall on clothes where bikini already shows through.
    #    Arm-height band only — never punch the skirt / thigh crotch.
    gaps = (bikini_a < 90) & (clothes_a >= 128)
    h = gaps.shape[0]
    band = np.zeros_like(gaps)
    band[int(h * 0.20) : int(h * 0.58), :] = True
    gaps &= band

    # Skip open-bay when candidates are saturated outfit fabric (pose drift),
    # not pink/beige wall. Low-chroma warm neutrals are the wall leftovers.
    if gaps.any():
        chroma = clothes_rgb.astype(np.float32).max(axis=2) - clothes_rgb.astype(
            np.float32
        ).min(axis=2)
        if float(np.median(chroma[gaps])) > 48.0:
            gaps = np.zeros_like(gaps)
        else:
            wall_color = np.median(clothes_rgb[gaps].astype(np.float32), axis=0)
            wallish = (
                np.linalg.norm(clothes_rgb.astype(np.float32) - wall_color, axis=2)
                < 50.0
            )
            gaps &= wallish & (chroma < 55.0)

    labels, count = ndimage.label(gaps)
    if count > 0:
        counts = np.bincount(labels.ravel())
        min_px = max(30, int(gaps.size * 0.0002))
        max_px = int(gaps.size * 0.035)
        keep = np.zeros(count + 1, dtype=bool)
        keep[1:] = (counts[1:] >= min_px) & (counts[1:] <= max_px)
        gaps = keep[labels]

    method = "open-bay"
    if not gaps.any():
        # 2) Fallback: seal bikini silhouette, take interior transparent bays.
        hard = bikini_a >= 128
        if not hard.any():
            print("Hole sync: no arm-gap bays found on bikini cutout", flush=True)
            return
        k = 21
        closed = ndimage.binary_closing(
            hard, structure=np.ones((k, k), dtype=bool), iterations=1
        )
        envelope = ndimage.binary_fill_holes(closed)
        gaps = envelope & (bikini_a < 48) & band
        labels, count = ndimage.label(gaps)
        if count > 0:
            counts = np.bincount(labels.ravel())
            min_px = max(40, int(hard.size * 0.0004))
            max_px = int(hard.size * 0.04)
            keep = np.zeros(count + 1, dtype=bool)
            keep[1:] = (counts[1:] >= min_px) & (counts[1:] <= max_px)
            gaps = keep[labels]
        gaps = ndimage.binary_dilation(gaps, iterations=1) & envelope
        method = "envelope"
        if not gaps.any():
            print("Hole sync: no arm-gap bays found on bikini cutout", flush=True)
            return
    else:
        # Clean edges on the punched rim — one px only so skirt hems stay intact.
        gaps = ndimage.binary_dilation(gaps, iterations=1)

    n_c = apply_cutout_holes(clothes_path, gaps)
    print(
        f"Hole sync: clothes punched {n_c} px ({method}, bikini unchanged)",
        flush=True,
    )


def transfer_cutout_holes(
    reference_path: Path,
    target_path: Path,
    close_px: int = 9,
) -> Path:
    """Punch arm-gap holes from a reference cutout into a pose-matched target."""
    ref_a = np.asarray(Image.open(reference_path).convert("RGBA"))[..., 3]
    holes = _arm_gap_hole_mask(ref_a, close_px=close_px)
    punched = apply_cutout_holes(target_path, holes)
    if punched:
        print(
            f"Hole transfer: {reference_path.name} → {target_path.name} "
            f"(punched {punched} px)",
            flush=True,
        )
    return target_path


def clear_cutout_holes(cutout_path: Path, close_px: int = 9) -> Path:
    """Widen topological arm-gap holes on a single cutout (clears fringe)."""
    return transfer_cutout_holes(cutout_path, cutout_path, close_px=close_px)


def _keep_largest_component(alpha: np.ndarray) -> np.ndarray:
    """Zero out all but the biggest connected blob in the matte.

    BiRefNet sometimes includes props / bags / accessories that touch the person.
    Keeping only the largest blob removes most of them without touching the
    person silhouette.
    """
    hard = alpha >= 0.4
    if not hard.any():
        return alpha
    labels, count = ndimage.label(hard)
    if count <= 1:
        return alpha
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    biggest = int(counts.argmax())
    out = alpha.copy()
    out[labels != biggest] = 0.0
    return out


def _constrain_to_person_mask(alpha: np.ndarray, person_mask: np.ndarray, dilate: int = 8) -> np.ndarray:
    """Zero alpha outside a dilated SegFormer body mask.

    Props that touch the body silhouette survive largest-component but are
    outside the body region — this clips them.
    """
    allow = ndimage.binary_dilation(person_mask, iterations=dilate)
    out = alpha.copy()
    out[~allow] = 0.0
    return out


# SegFormer classes for the cutout constraint (mattmdjaga/segformer_b2_clothes / ATR).
# Body = everything that is part of the person's body/clothing.
# Props = objects that may be held but are not the person (bags, shoes).
_BODY_KEEP_LABELS = frozenset({1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 17})
_PROP_LABELS = frozenset({9, 10, 16})  # left-shoe, right-shoe, bag


def _segformer_allow_mask(rgb: np.ndarray, gen, body_dilate: int = 6) -> np.ndarray:
    """Build an allow mask: dilated body labels MINUS hard prop labels.

    Strategy:
    - Dilate body pixels by `body_dilate` px so BiRefNet sleeve/collar edges
      (which are slightly outside the SegFormer boundary) are not clipped.
    - Hard-subtract prop pixels (bags=16, shoes=9/10) WITHOUT dilation — this
      removes bags touching the hands even when the hand dilation would otherwise
      bleed into them.
    """
    h, w = rgb.shape[:2]
    small, scale = _resize_max_side(rgb, MAX_SEG_SIDE)
    seg = gen._segment(small)

    body_small = np.isin(seg, list(_BODY_KEEP_LABELS))
    prop_small = np.isin(seg, list(_PROP_LABELS))

    def _to_full(mask_small: np.ndarray) -> np.ndarray:
        if scale == 1.0:
            return mask_small
        return (
            np.asarray(
                Image.fromarray(mask_small.astype(np.uint8) * 255).resize(
                    (w, h), Image.Resampling.NEAREST
                ),
                dtype=np.uint8,
            )
            > 127
        )

    body = _to_full(body_small)
    prop = _to_full(prop_small)

    if int(body.sum()) < 200:
        return np.ones((h, w), dtype=bool)  # no segmentation — don't clip anything

    # Dilate body generously for edge accuracy, then subtract props hard.
    allow = ndimage.binary_dilation(body, iterations=body_dilate)
    allow &= ~prop
    return allow


def _feather_edge(alpha: np.ndarray, sigma: float) -> np.ndarray:
    """Soften the silhouette rim by `sigma` px without touching the solid interior."""
    if sigma <= 0:
        return alpha
    blurred = ndimage.gaussian_filter(alpha.astype(np.float32), sigma=sigma)
    # Erode a few px to define the solid interior — those pixels stay at 1.0.
    hard = alpha >= 0.5
    interior = ndimage.binary_erosion(hard, iterations=max(1, int(sigma * 2 + 1)))
    out = blurred.copy()
    out[interior] = alpha[interior]
    return np.clip(out, 0.0, 1.0)


def _cover_rgba_to_canvas(
    rgba: Image.Image,
    *,
    width: int = OUTPUT_WIDTH,
    height: int = OUTPUT_HEIGHT,
) -> Image.Image:
    """Cover-crop RGBA the same way RGB plates are cropped."""
    src_w, src_h = rgba.size
    if src_w <= 0 or src_h <= 0:
        raise ValueError("Image has empty dimensions")
    scale = max(width / src_w, height / src_h)
    new_w = max(width, int(round(src_w * scale)))
    new_h = max(height, int(round(src_h * scale)))
    resized = rgba.resize((new_w, new_h), Image.Resampling.LANCZOS)
    left = max(0, (new_w - width) // 2)
    top = max(0, (new_h - height) // 2)
    cropped = resized.crop((left, top, left + width, top + height))
    arr = np.asarray(cropped).copy()
    a = arr[..., 3].astype(np.float32)
    # Hard-zero anything BiRefNet is less than ~20 % confident about (arm-hip gap
    # semi-transparent fringe, dark chair/wall bleed-through).  Keep a soft ramp
    # only in the 50-250 band for the 1 px feather AA.
    a = np.where(a >= 250, 255.0, a)
    a = np.where(a <= 50, 0.0, a)
    arr[..., 3] = a.astype(np.uint8)
    arr[arr[..., 3] == 0, :3] = 0
    return Image.fromarray(arr, mode="RGBA")


def _matte_person(
    image_path: Path,
) -> tuple[np.ndarray, np.ndarray, tuple[int, int]]:
    """Run BiRefNet + cleanup; return ``(rgb_u8, alpha_f, source_size)``."""
    if not image_path.is_file():
        raise FileNotFoundError(f"Image not found: {image_path}")

    source = Image.open(image_path).convert("RGB")
    source_rgb = np.asarray(source, dtype=np.uint8)
    rgba = _rembg_rgba(source)
    arr = np.asarray(rgba)
    rgb = arr[..., :3].copy()
    alpha_f = arr[..., 3].astype(np.float32) / 255.0

    if float(alpha_f.sum()) < 200:
        raise RuntimeError(
            f"Could not find a person in {image_path.name} — "
            "approve bikini/top layers that clearly show the girl first"
        )

    # 1) Drop disconnected blobs (props / bags that don't touch the person).
    alpha_f = _keep_largest_component(alpha_f)

    # 2) Fill tiny enclosed dropouts in sleeves (area-capped so arm–hip triangles
    #    are never refilled).
    alpha_f, rgb = _fill_alpha_holes(rgb, alpha_f)

    # 3) Punch intentional holes BiRefNet filled in (hands-on-hips arm gaps).
    #    Must use the *source* still: rembg zeros RGB under transparency, which
    #    breaks both SegFormer and wall-color sampling.
    body_protect = None
    try:
        gen = _load_generator()
        body_protect = _segformer_allow_mask(source_rgb, gen, body_dilate=0)
        allow = ndimage.binary_dilation(body_protect, iterations=2)
        before = int((alpha_f >= 0.35).sum())
        alpha_f = _constrain_to_person_mask(alpha_f, allow, dilate=0)
        punched = before - int((alpha_f >= 0.35).sum())
        if punched > 0:
            print(f"SegFormer hole punch: erased {punched} px", flush=True)
    except Exception as exc:  # noqa: BLE001 — cutout must still finish
        print(f"SegFormer hole punch skipped: {exc}", flush=True)
    alpha_f = _erase_background_pockets(source_rgb, alpha_f, body_protect=body_protect)

    # 4) Choke pale wall halo from the rim.
    choke = min(2.0, RIM_CHOKE * max(1.0, max(source.size) / 672.0))
    alpha_f = _choke_alpha(alpha_f, choke)
    alpha_f = _strip_bright_rim(rgb, alpha_f)
    alpha_f = np.clip(alpha_f, 0.0, 1.0)

    # 5) Hard-zero uncertain pixels (< 20 % alpha).
    alpha_f = np.where(alpha_f < 0.20, 0.0, alpha_f)

    # 6) Defringe + edge feather.
    clean_rgb = _defringe_rgb(rgb, alpha_f)
    feather_sigma = EDGE_FEATHER_SIGMA * max(1.0, max(source.size) / 672.0)
    alpha_f = _feather_edge(alpha_f, feather_sigma)
    return clean_rgb, alpha_f, source.size


def _write_cutout_png(
    rgb: np.ndarray,
    alpha_f: np.ndarray,
    output_path: Path,
    *,
    src_size: tuple[int, int],
    label: str = "",
) -> Path:
    alpha = (np.clip(alpha_f, 0.0, 1.0) * 255.0).astype(np.uint8)
    rgba_full = Image.fromarray(np.dstack([rgb, alpha]), mode="RGBA")
    rgba_out = _cover_rgba_to_canvas(
        rgba_full, width=OUTPUT_WIDTH, height=OUTPUT_HEIGHT
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    rgba_out.save(output_path, format="PNG", optimize=True)
    a = np.asarray(rgba_out.getchannel("A"))
    tag = f"{label} " if label else ""
    print(
        f"Cutout written: {output_path} "
        f"({OUTPUT_WIDTH}x{OUTPUT_HEIGHT}, src={src_size[0]}x{src_size[1]}, "
        f"model={REMBG_MODEL}, {tag}opaque={(a > 250).mean() * 100:.1f}%)",
        flush=True,
    )
    return output_path


def cutout_person_rgba(image_path: Path, output_path: Path) -> Path:
    """Write an OUTPUT_SCALE×(390×672) RGBA PNG of the person (BiRefNet matte)."""
    rgb, alpha_f, src_size = _matte_person(image_path)
    return _write_cutout_png(rgb, alpha_f, output_path, src_size=src_size)


def _load_garment_alpha(
    garment_mask_path: Path | None, shape: tuple[int, int]
) -> np.ndarray | None:
    """Load match-step garment mask resized to ``shape`` (H, W), float 0..1."""
    if garment_mask_path is None or not garment_mask_path.is_file():
        return None
    mask = Image.open(garment_mask_path).convert("L")
    if mask.size != (shape[1], shape[0]):
        mask = mask.resize((shape[1], shape[0]), Image.Resampling.BILINEAR)
    return np.asarray(mask, dtype=np.float32) / 255.0


def cutout_matched_pair(
    bikini_path: Path,
    clothes_path: Path,
    bikini_out: Path,
    clothes_out: Path,
    garment_mask_path: Path | None = None,
) -> None:
    """Shared-matte cutouts for pose-matched bikini + clothes plates.

    Bikini alpha is the source of truth for hair/skin silhouette. Clothes alpha
    equals bikini alpha everywhere except where the garment grows past that
    silhouette (skirts / loose sleeves), taken from a clothes BiRefNet pass.
    """
    b_rgb, b_a, b_size = _matte_person(bikini_path)
    c_rgb, c_a, c_size = _matte_person(clothes_path)

    if b_a.shape != c_a.shape:
        # Matched plates should already share canvas size; resize clothes → bikini.
        c_rgba = Image.fromarray(
            np.dstack(
                [c_rgb, (np.clip(c_a, 0.0, 1.0) * 255.0).astype(np.uint8)]
            ),
            mode="RGBA",
        ).resize((b_a.shape[1], b_a.shape[0]), Image.Resampling.LANCZOS)
        c_arr = np.asarray(c_rgba)
        c_rgb = c_arr[..., :3].copy()
        c_a = c_arr[..., 3].astype(np.float32) / 255.0

    g_a = _load_garment_alpha(garment_mask_path, b_a.shape)
    if g_a is not None:
        g_hard = g_a >= 0.35
        g_hard = ndimage.binary_dilation(g_hard, iterations=2)
        # Extend only where fabric sticks out past the bikini person.
        extend = g_hard & (c_a >= 0.35) & (b_a < 0.40)
        clothes_a = b_a.copy()
        clothes_a[extend] = np.maximum(clothes_a[extend], c_a[extend])
        # Soft garment rim: blend clothes matte into shared alpha on fabric.
        soft = (g_a > 0.05) & (c_a > 0.05)
        clothes_a[soft] = np.maximum(
            clothes_a[soft], c_a[soft] * np.clip(g_a[soft], 0.0, 1.0)
        )
        print(
            f"Shared matte: garment extend={(extend.sum())} px "
            f"(mask={garment_mask_path.name})",
            flush=True,
        )
    else:
        # No garment mask — still lock hair/skin to bikini; grow only where the
        # clothes matte is solid outside the bikini silhouette.
        extend = (c_a >= 0.50) & (b_a < 0.35)
        extend = ndimage.binary_opening(extend, iterations=1)
        clothes_a = b_a.copy()
        clothes_a[extend] = np.maximum(clothes_a[extend], c_a[extend])
        print(
            f"Shared matte: no garment_mask — silhouette extend={extend.sum()} px",
            flush=True,
        )

    clothes_a = np.clip(clothes_a, 0.0, 1.0)
    # Outside garment, force exact bikini alpha so edges never pop while scratching.
    if g_a is not None:
        lock = g_a < 0.05
        clothes_a[lock] = b_a[lock]

    _write_cutout_png(
        b_rgb, b_a, bikini_out, src_size=b_size, label="bikini"
    )
    _write_cutout_png(
        c_rgb, clothes_a, clothes_out, src_size=c_size, label="clothes"
    )

    # Safety: punch any leftover wall in arm–hip bays (shared alpha usually
    # already handles this; cheap no-op when clean).
    sync_pose_matched_cutout_holes(bikini_out, clothes_out)
