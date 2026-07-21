"""Align photo-scratch TOP (clothes) onto the bikini pose before cutout.

Default registration (clothes → bikini coordinates):
  1. Cover-crop both to the match canvas
  2. ORB + RANSAC similarity (scale/rotate/translate) — face-boosted keypoints
  3. Face-centroid translation polish

Optional ``full`` mode adds non-rigid silhouette/flow warps when limbs diverge.
Clothes is the playable scratch layer after warp; bikini stays the reveal.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

from backend.services.photo_canvas import CANVAS_HEIGHT, CANVAS_WIDTH, cover_to_canvas
from backend.services.photo_cutout import (
    MAX_SEG_SIDE,
    _load_generator,
    _person_mask_keep_holes,
    _resize_max_side,
)

MATCH_SCALE = 3
MATCH_WIDTH = CANVAS_WIDTH * MATCH_SCALE
MATCH_HEIGHT = CANVAS_HEIGHT * MATCH_SCALE

POSE_WIDTH_RATIO_MIN = 0.72
POSE_WIDTH_RATIO_MAX = 1.38
GOOD_PEEK = 0.004
GOOD_EDGE_MAE = 2.5  # px at match resolution
FACE_BAND_TOP = 0.05
FACE_BAND_BOTTOM = 0.38
ORB_FEATURES = 4000
ORB_MATCH_KEEP = 240
MIN_ORB_INLIERS = 24
# After ORB lock, grow the top slightly about the person centroid so fabric
# covers thin bikini / skin rims the AI often leaves around sleeves and hems.
CLOTHES_OVERSCALE = 1.035
# If person heights still differ after ORB, snap clothes height to bikini and
# reapply the cover overscale so there is always a 3.5 % safety margin.
HEIGHT_NORM_TOLERANCE = 0.01  # skip if within 1 %

# SegFormer clothes labels (mattmdjaga/segformer_b2_clothes / ATR).
# Upper-clothes, Skirt, Pants, Dress, Belt, Scarf — not skin/hair/face/arms.
GARMENT_LABELS = frozenset({4, 5, 6, 7, 8, 17})
# L2 RGB distance: below this, treat as "unchanged" and keep bikini pixels.
GARMENT_DIFF_THRESHOLD = 14.0
# Grow SegFormer garment a few px so hems/sleeves cover the bikini rim.
GARMENT_DILATE = 4
# Soft paste edge at match resolution (~3× canvas).
GARMENT_FEATHER_SIGMA = 2.5
# Extra high-diff ring around the garment (loose fabric the parser missed).
GARMENT_NEAR_DILATE = 10
GARMENT_NEAR_DIFF = 36.0


def relock_clothes_from_bikini(
    bikini_path: Path,
    clothes_path: Path,
    output_path: Path,
    *,
    provider: str = "xai",
    image_model: str = "grok-imagine",
    theme: str = "",
) -> Path:
    """Re-dress the bikini still into the top's outfit (same pose by construction).

    This is the real fix when two AI gens diverge — geometric warp cannot move
    a raised arm onto an arms-down body.
    """
    from backend.services.ai_provider import (
        edit_photo_scratch_layer,
        normalize_provider,
        normalize_source_image_model,
    )
    from backend.services.grok import (
        api_key,
        describe_outfit,
        photo_scratch_clothes_pose_locks,
        photo_scratch_clothes_prompt,
    )

    outfit = ""
    try:
        outfit = describe_outfit(clothes_path, api_key()) or ""
    except Exception as exc:
        print(f"Outfit caption failed ({exc})", flush=True)

    if outfit.strip():
        prompt = (
            "Using this exact same woman, pose, framing, hands, camera angle, and "
            "background, change ONLY her outfit to: "
            f"{outfit.strip()}. "
            "Keep face, identity, hair, skin tone, body pose, and limb positions "
            f"identical — do not move her arms or legs. {photo_scratch_clothes_pose_locks()} "
            "FACE LOCK — keep her face identical to the reference: no horizontal seams, "
            "smears, double mouths, or sliced nose. "
            "Only replace the clothing fabric. "
            "Photorealistic, 9:16. Do not invent a different woman."
        )
    else:
        prompt = photo_scratch_clothes_prompt(theme or "stylish")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Prefer jpg sidecar; edit APIs often write png — normalize after.
    tmp_out = output_path.with_suffix(".png")
    print(f"AI pose-lock: re-dressing bikini → {tmp_out.name} …", flush=True)
    edit_photo_scratch_layer(
        provider=normalize_provider(provider),
        image_model=normalize_source_image_model(image_model, provider=provider),
        prompt=prompt,
        out=tmp_out,
        source_image=bikini_path,
        background_image=None,
        aspect_ratio="9:16",
    )
    if not tmp_out.is_file():
        raise RuntimeError("AI pose-lock did not write an image")
    rgb = Image.open(tmp_out).convert("RGB")
    rgb.save(output_path, format="JPEG", quality=95, optimize=True)
    if tmp_out.resolve() != output_path.resolve():
        tmp_out.unlink(missing_ok=True)
    print(f"AI pose-lock written: {output_path}", flush=True)
    return output_path


def match_clothes_to_bikini(
    bikini_path: Path,
    clothes_path: Path,
    output_path: Path,
    overlay_path: Path | None = None,
    bikini_matched_path: Path | None = None,
    blend_path: Path | None = None,
    garment_mask_path: Path | None = None,
    *,
    mode: str = "register",
    nudge_scale: float = 1.0,
    nudge_tx: float = 0.0,
    nudge_ty: float = 0.0,
    garment_composite: bool = True,
) -> dict:
    """Register bikini + top on the same canvas for cutout.

    Default ``register``: ORB similarity + face polish. Tops are edited from the
    bikini but AI reframing still drifts (~scale/translation); cover-crop alone
    leaves a doubled face in the overlay.

    ``passthrough``: cover-crop only. ``full``: non-rigid warp after register.

    Optional ``nudge_scale`` / ``nudge_tx`` / ``nudge_ty`` apply a final manual
    affine on the matched clothes (scale about person centroid, then translate).

    When ``garment_composite`` is True (default), the final clothes plate is the
    bikini image with only SegFormer garment pixels from the aligned top pasted
    in — face/hair/skin/background stay byte-identical between layers.
    """
    if not bikini_path.is_file():
        raise FileNotFoundError(f"Bikini image not found: {bikini_path}")
    if not clothes_path.is_file():
        raise FileNotFoundError(f"Clothes image not found: {clothes_path}")

    bikini = cover_to_canvas(
        Image.open(bikini_path), width=MATCH_WIDTH, height=MATCH_HEIGHT
    )
    clothes = cover_to_canvas(
        Image.open(clothes_path), width=MATCH_WIDTH, height=MATCH_HEIGHT
    )
    bikini_rgb = np.asarray(bikini, dtype=np.uint8)
    clothes_rgb = np.asarray(clothes, dtype=np.uint8)

    gen = _load_generator()
    bikini_mask = _person_mask_keep_holes(bikini_rgb, gen)
    clothes_mask = _person_mask_keep_holes(clothes_rgb, gen)
    if int(bikini_mask.sum()) < 200:
        raise RuntimeError("Could not find a person in the bikini layer")
    if int(clothes_mask.sum()) < 200:
        raise RuntimeError("Could not find a person in the top layer")

    pose_mismatch = _arm_pose_mismatch(bikini_mask, clothes_mask)
    mode_key = (mode or "register").strip().lower()
    if mode_key == "light":
        mode_key = "register"

    register_info: dict = {}
    if mode_key == "passthrough":
        aligned_clothes = clothes_rgb
        method = "passthrough (same canvas)"
    elif mode_key == "full":
        registered, register_info = _register_similarity(
            clothes_rgb, bikini_rgb, bikini_mask, clothes_mask
        )
        registered = _overscale_about_person(registered, bikini_mask, CLOTHES_OVERSCALE)
        register_info["overscale"] = CLOTHES_OVERSCALE
        registered_mask = _person_mask_keep_holes(registered, gen)
        warped = _align_clothes_to_bikini(
            registered, registered_mask, bikini_rgb, bikini_mask
        )
        # Composite warped top onto bikini plate so bg/framing match.
        aligned_clothes = bikini_rgb.copy()
        warped_mask = _person_mask_keep_holes(warped, gen)
        cover = bikini_mask | (
            ndimage.binary_erosion(warped_mask, iterations=1)
            if warped_mask.any()
            else warped_mask
        )
        aligned_clothes[cover] = warped[cover]
        method = "register+row+dt-flow+gray-flow (clothes→bikini)"
    else:
        # ORB similarity only — no dress-transfer.
        # The top is generated from the bikini so poses already match; pasting
        # bikini pixels at the collar zone causes color shifts on sheer necklines.
        registered, register_info = _register_similarity(
            clothes_rgb, bikini_rgb, bikini_mask, clothes_mask
        )
        # After ORB, check person heights and apply a corrective scale so that
        # the clothes character's bounding-box height matches the bikini's.
        # ORB matches faces but the original images can have different framing
        # (one tighter, one wider), so the bodies end up at different scales.
        reg_mask = _person_mask_keep_holes(registered, gen)
        b_h = _person_height_px(bikini_mask)
        c_h = _person_height_px(reg_mask)
        height_scale = CLOTHES_OVERSCALE
        if b_h > 50 and c_h > 50:
            # Scale clothes so its person height equals bikini person height,
            # then apply the normal overscale margin on top.
            raw_ratio = b_h / c_h
            height_scale = raw_ratio * CLOTHES_OVERSCALE
            if abs(raw_ratio - 1.0) > HEIGHT_NORM_TOLERANCE:
                print(
                    f"Height-norm: bikini={b_h:.0f}px clothes={c_h:.0f}px "
                    f"ratio={raw_ratio:.4f} → height_scale={height_scale:.4f}",
                    flush=True,
                )
        aligned_clothes = _overscale_about_person(
            registered, bikini_mask, height_scale
        )
        register_info["overscale"] = round(height_scale, 4)
        method = "orb-person (clothes→bikini)"

    aligned_clothes, nudge_info = _apply_manual_nudge(
        aligned_clothes,
        bikini_mask,
        scale=nudge_scale,
        tx=nudge_tx,
        ty=nudge_ty,
    )
    register_info.update(nudge_info)

    garment_alpha: np.ndarray | None = None
    if garment_composite:
        aligned_clothes, garment_alpha = _garment_composite(
            bikini_rgb, aligned_clothes, gen
        )
        register_info["garment_composite"] = True
        register_info["garment_px"] = int((garment_alpha >= 0.5).sum())
        method = f"{method}+garment-composite"

    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(aligned_clothes, mode="RGB").save(
        output_path, format="JPEG", quality=95, optimize=True
    )

    if bikini_matched_path is None:
        bikini_matched_path = output_path.parent / "bikini_matched.jpg"
    Image.fromarray(bikini_rgb, mode="RGB").save(
        bikini_matched_path, format="JPEG", quality=95, optimize=True
    )

    if garment_mask_path is not None and garment_alpha is not None:
        garment_mask_path.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(
            (np.clip(garment_alpha, 0.0, 1.0) * 255.0).astype(np.uint8), mode="L"
        ).save(garment_mask_path, format="PNG", optimize=True)

    if overlay_path is not None or blend_path is not None:
        _write_match_previews(
            bikini_rgb,
            aligned_clothes,
            difference_path=overlay_path,
            blend_path=blend_path,
        )

    final_mask = _person_mask_keep_holes(aligned_clothes, gen)
    peek = float((bikini_mask & ~final_mask).mean())
    iou = _iou(final_mask, bikini_mask)
    edge = _edge_mae(bikini_mask, final_mask)
    # Outfit masks never fully overlap (sleeves/skirt). Pose OK = limbs agree.
    pose_ok = not pose_mismatch

    stats = {
        "iou": round(float(iou), 3),
        "peek": round(peek, 4),
        "edge_mae": round(float(edge), 2),
        "pose_ok": pose_ok,
        "pose_mismatch": pose_mismatch,
        "method": method,
        **{
            k: register_info[k]
            for k in (
                "inliers",
                "scale",
                "tx",
                "ty",
                "garment_composite",
                "garment_px",
            )
            if k in register_info
        },
    }
    print(
        f"Matched top → bikini: {output_path} "
        f"({MATCH_WIDTH}x{MATCH_HEIGHT}, iou={stats['iou']}, "
        f"peek={stats['peek']}, edge={stats['edge_mae']}px, pose_ok={pose_ok}"
        + (
            f", scale={stats.get('scale')}, inliers={stats.get('inliers')}"
            if "scale" in stats
            else ""
        )
        + (
            f", garment_px={stats.get('garment_px')}"
            if "garment_px" in stats
            else ""
        )
        + ")",
        flush=True,
    )
    return stats


def _garment_seg_mask(rgb: np.ndarray, gen) -> np.ndarray:
    """Binary SegFormer garment mask (fabric only) at full resolution."""
    small, scale = _resize_max_side(rgb, MAX_SEG_SIDE)
    seg = gen._segment(small)
    mask = np.isin(seg, list(GARMENT_LABELS))
    mask = ndimage.binary_closing(mask, structure=np.ones((3, 3), bool), iterations=1)
    labels, count = ndimage.label(mask)
    if count == 0:
        return np.zeros(rgb.shape[:2], dtype=bool)
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    # Keep every garment blob above a tiny area (skirt + top can be separate).
    min_px = max(40, int(mask.size * 0.00015))
    keep = np.zeros(count + 1, dtype=bool)
    keep[1:] = counts[1:] >= min_px
    mask = keep[labels]
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


def _garment_composite(
    bikini_rgb: np.ndarray,
    clothes_rgb: np.ndarray,
    gen,
) -> tuple[np.ndarray, np.ndarray]:
    """Bikini plate + feathered garment paste from the aligned top.

    Returns ``(composite_rgb, garment_alpha)`` where alpha is float32 0..1.
    Outside the garment, composite pixels are identical to ``bikini_rgb``.
    """
    gmask = _garment_seg_mask(clothes_rgb, gen)
    if not gmask.any():
        print(
            "Garment composite: no SegFormer fabric labels — leaving registered top",
            flush=True,
        )
        return clothes_rgb, None

    diff = np.linalg.norm(
        clothes_rgb.astype(np.float32) - bikini_rgb.astype(np.float32), axis=2
    )
    gmask_d = ndimage.binary_dilation(gmask, iterations=GARMENT_DILATE)
    near = ndimage.binary_dilation(gmask, iterations=GARMENT_NEAR_DILATE)
    # Fabric the parser found that actually changed, plus a high-diff ring for
    # loose hems/sleeves SegFormer often under-segments.
    paste = (gmask_d & (diff > GARMENT_DIFF_THRESHOLD)) | (
        near & (diff > GARMENT_NEAR_DIFF)
    )
    if not paste.any():
        # Fallback: trust the dilated garment labels even if colour is close
        # (dark swimsuit → dark dress can sit under the threshold).
        paste = gmask_d
        print(
            "Garment composite: low RGB diff — using SegFormer mask alone",
            flush=True,
        )

    alpha = paste.astype(np.float32)
    if GARMENT_FEATHER_SIGMA > 0:
        alpha = ndimage.gaussian_filter(alpha, sigma=GARMENT_FEATHER_SIGMA)
    alpha = np.clip(alpha, 0.0, 1.0)

    out = (
        bikini_rgb.astype(np.float32) * (1.0 - alpha[..., None])
        + clothes_rgb.astype(np.float32) * alpha[..., None]
    )
    out_u8 = np.clip(out, 0, 255).astype(np.uint8)
    # Exact identity outside the soft paste — kill float bleed on "untouched" px.
    hard = alpha < 1e-4
    out_u8[hard] = bikini_rgb[hard]
    print(
        f"Garment composite: pasted {(alpha >= 0.5).sum()} px "
        f"(soft={(alpha > 1e-4).sum()})",
        flush=True,
    )
    return out_u8, alpha


def _person_height_px(mask: np.ndarray) -> float:
    """Vertical extent of the person bounding box in pixels."""
    ys = np.where(mask.any(axis=1))[0]
    return float(ys.max() - ys.min()) if ys.size >= 2 else 0.0


def _overscale_about_person(
    rgb: np.ndarray, person_mask: np.ndarray, scale: float
) -> np.ndarray:
    """Uniform scale about the person centroid (grow or shrink fabric)."""
    if abs(scale - 1.0) < 1e-4:
        return rgb
    h, w = rgb.shape[:2]
    ys, xs = np.where(person_mask)
    if ys.size < 50:
        cx, cy = w * 0.5, h * 0.5
    else:
        cx, cy = float(xs.mean()), float(ys.mean())
    matrix = cv2.getRotationMatrix2D((cx, cy), 0.0, float(scale))
    return cv2.warpAffine(
        rgb,
        matrix,
        (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )


def _apply_manual_nudge(
    rgb: np.ndarray,
    person_mask: np.ndarray,
    *,
    scale: float = 1.0,
    tx: float = 0.0,
    ty: float = 0.0,
) -> tuple[np.ndarray, dict]:
    """Optional final scale + translation after automatic registration."""
    info: dict = {}
    out = rgb
    if abs(scale - 1.0) >= 1e-4:
        out = _overscale_about_person(out, person_mask, scale)
        info["nudge_scale"] = round(float(scale), 4)
    if abs(tx) >= 1e-3 or abs(ty) >= 1e-3:
        h, w = out.shape[:2]
        matrix = np.array(
            [[1.0, 0.0, float(tx)], [0.0, 1.0, float(ty)]], dtype=np.float32
        )
        out = cv2.warpAffine(
            out,
            matrix,
            (w, h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE,
        )
        info["nudge_tx"] = round(float(tx), 2)
        info["nudge_ty"] = round(float(ty), 2)
    return out, info


def _register_similarity(
    clothes_rgb: np.ndarray,
    bikini_rgb: np.ndarray,
    bikini_mask: np.ndarray,
    clothes_mask: np.ndarray | None = None,
) -> tuple[np.ndarray, dict]:
    """Similarity warp of clothes → bikini via person-masked ORB only.

    Background keypoints are ignored — shared scene texture can dominate RANSAC
    and leave the body drifted. Do not stamp bikini face pixels onto clothes:
    that creates a frankenstein neck tear when the body is still off.
    """
    h, w = bikini_rgb.shape[:2]
    bikini_g = cv2.cvtColor(bikini_rgb, cv2.COLOR_RGB2GRAY)
    clothes_g = cv2.cvtColor(clothes_rgb, cv2.COLOR_RGB2GRAY)

    if clothes_mask is None:
        clothes_mask = _quick_luma_person(clothes_rgb)

    b_mask = ndimage.binary_dilation(bikini_mask, iterations=2)
    c_mask = ndimage.binary_dilation(clothes_mask, iterations=2)
    b_u8 = b_mask.astype(np.uint8) * 255
    c_u8 = c_mask.astype(np.uint8) * 255

    orb = cv2.ORB_create(ORB_FEATURES, scaleFactor=1.2, nlevels=8)
    kp1, des1 = orb.detectAndCompute(bikini_g, b_u8)
    kp2, des2 = orb.detectAndCompute(clothes_g, c_u8)
    info: dict = {"inliers": 0, "scale": 1.0, "tx": 0.0, "ty": 0.0}

    if des1 is None or des2 is None or len(kp1) < 8 or len(kp2) < 8:
        print("ORB register: too few person keypoints; leaving cover-crop", flush=True)
        return clothes_rgb, info

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = sorted(matcher.match(des1, des2), key=lambda m: m.distance)
    matches = matches[:ORB_MATCH_KEEP]
    if len(matches) < 8:
        print("ORB register: too few matches; leaving cover-crop", flush=True)
        return clothes_rgb, info

    src = np.float32([kp2[m.trainIdx].pt for m in matches])
    dst = np.float32([kp1[m.queryIdx].pt for m in matches])
    warp, inlier_mask = cv2.estimateAffinePartial2D(
        src,
        dst,
        method=cv2.RANSAC,
        ransacReprojThreshold=4.0,
        maxIters=4000,
        confidence=0.995,
    )
    if warp is None or inlier_mask is None:
        print("ORB register: RANSAC failed; leaving cover-crop", flush=True)
        return clothes_rgb, info

    inliers = int(inlier_mask.sum())
    scale = float(np.hypot(warp[0, 0], warp[1, 0]))
    info.update(
        {
            "inliers": inliers,
            "scale": round(scale, 4),
            "tx": round(float(warp[0, 2]), 2),
            "ty": round(float(warp[1, 2]), 2),
        }
    )
    if inliers < MIN_ORB_INLIERS:
        print(
            f"ORB register: weak inliers ({inliers}); leaving cover-crop",
            flush=True,
        )
        return clothes_rgb, info

    aligned = cv2.warpAffine(
        clothes_rgb,
        warp,
        (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )
    return aligned, info


def _dress_transfer(
    aligned_clothes: np.ndarray,
    bikini_rgb: np.ndarray,
    gen,
) -> tuple[np.ndarray, dict]:
    """Bikini head/bg stay; hard-paste the full clothed body below the neck.

    Soft garment paste left bikini arms ghosting beside sleeves. Below the neck
    we fully replace with the aligned top body, erase bikini-only limb leftovers,
    and only feather the collar seam.
    """
    clothes_person = _person_mask_keep_holes(aligned_clothes, gen)
    bikini_person = _person_mask_keep_holes(bikini_rgb, gen)
    if int(clothes_person.sum()) < 200:
        return aligned_clothes, {"dress_transfer": False, "garment_px": 0}

    h, w = bikini_rgb.shape[:2]
    ys = np.where(bikini_person | clothes_person)[0]
    y_top = int(ys.min())
    y_bot = int(ys.max())
    y_neck = int(y_top + max(70, (y_bot - y_top) * 0.20))

    clothes_body = clothes_person.copy()
    clothes_body[:y_neck, :] = False
    if int(clothes_body.sum()) < 500:
        return aligned_clothes, {"dress_transfer": False, "garment_px": 0}

    out = bikini_rgb.astype(np.float32).copy()

    # 1) Hard paste uniform body (no soft holes for bikini arms to show through).
    out[clothes_body] = aligned_clothes[clothes_body].astype(np.float32)

    # 2) Erase bikini limbs that stick out past the uniform silhouette.
    clothes_dilated = ndimage.binary_dilation(clothes_person, iterations=4)
    orphan = bikini_person & ~clothes_dilated
    orphan[:y_neck, :] = False
    if orphan.any():
        bg = _estimate_plate_background(bikini_rgb, bikini_person)
        out[orphan] = bg

    # 3) Soft collar blend so the head doesn't look pasted on.
    band = max(12, int((y_bot - y_top) * 0.05))
    y0 = max(0, y_neck - band)
    y1 = min(h, y_neck + band)
    neck = np.zeros((h, w), dtype=bool)
    neck[y0:y1, :] = True
    neck &= clothes_person | bikini_person
    if neck.any():
        # Vertical ramp: bikini on top → clothes below.
        ramp = np.zeros(h, dtype=np.float32)
        ramp[y0:y1] = np.linspace(0.0, 1.0, y1 - y0, dtype=np.float32)
        # Prefer clothes where the uniform actually exists.
        neck_alpha = ramp[:, None] * clothes_person.astype(np.float32)
        neck_alpha = cv2.GaussianBlur(neck_alpha, (0, 0), sigmaX=2.5)
        neck_alpha = np.clip(neck_alpha, 0.0, 1.0)
        na = neck_alpha[..., None]
        blend = (
            aligned_clothes.astype(np.float32) * na
            + bikini_rgb.astype(np.float32) * (1.0 - na)
        )
        out[neck] = blend[neck]

    info = {
        "dress_transfer": True,
        "garment_px": int(clothes_body.sum()),
        "neck_y": y_neck,
        "orphans_cleared": int(orphan.sum()),
    }
    print(
        f"Dress-transfer: hard body below y={y_neck} ({info['garment_px']} px), "
        f"cleared {info['orphans_cleared']} bikini orphans",
        flush=True,
    )
    return np.clip(out, 0, 255).astype(np.uint8), info


def _estimate_plate_background(rgb: np.ndarray, person: np.ndarray) -> np.ndarray:
    """Median color from non-person pixels — fill erased limb leftovers."""
    outside = ~ndimage.binary_dilation(person, iterations=6)
    samples = rgb[outside]
    if samples.size < 100:
        samples = np.concatenate(
            [
                rgb[0, :, :].reshape(-1, 3),
                rgb[-1, :, :].reshape(-1, 3),
                rgb[:, 0, :].reshape(-1, 3),
                rgb[:, -1, :].reshape(-1, 3),
            ],
            axis=0,
        )
    return np.median(samples.astype(np.float32), axis=0)


def _face_centroid_polish(
    clothes_rgb: np.ndarray,
    bikini_mask: np.ndarray,
    clothes_mask: np.ndarray | None,
) -> np.ndarray:
    """Nudge residual face offset after similarity (translation only)."""
    h, w = bikini_mask.shape
    ys, xs = np.where(bikini_mask)
    if ys.size < 40:
        return clothes_rgb
    y0 = int(ys.min())
    y1 = int(min(h, y0 + max(80, int((ys.max() - y0) * 0.28))))
    if clothes_mask is None:
        clothes_mask = _quick_luma_person(clothes_rgb)
    b_cent = _mask_centroid(bikini_mask[y0:y1])
    c_cent = _mask_centroid(clothes_mask[y0:y1])
    if b_cent is None or c_cent is None:
        return clothes_rgb
    dx = float(b_cent[0] - c_cent[0])
    dy = float(b_cent[1] - c_cent[1])
    # Ignore huge jumps (wrong mask); allow a modest face lock.
    if abs(dx) > 40 or abs(dy) > 40:
        return clothes_rgb
    if abs(dx) < 0.4 and abs(dy) < 0.4:
        return clothes_rgb
    polish = np.array([[1.0, 0.0, dx], [0.0, 1.0, dy]], dtype=np.float32)
    return cv2.warpAffine(
        clothes_rgb,
        polish,
        (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )


def _quick_luma_person(rgb: np.ndarray) -> np.ndarray:
    """Fast stand-in person mask for polish (avoids a second BiRefNet pass)."""
    border = np.concatenate(
        [
            rgb[0, :, :].reshape(-1, 3),
            rgb[-1, :, :].reshape(-1, 3),
            rgb[:, 0, :].reshape(-1, 3),
            rgb[:, -1, :].reshape(-1, 3),
        ],
        axis=0,
    )
    bg = np.median(border, axis=0).astype(np.float32)
    dist = np.linalg.norm(rgb.astype(np.float32) - bg, axis=2)
    mask = dist > max(28.0, float(np.percentile(dist, 55)))
    mask = ndimage.binary_fill_holes(mask)
    mask = ndimage.binary_opening(mask, iterations=1)
    return mask


def _mask_centroid(mask: np.ndarray) -> tuple[float, float] | None:
    ys, xs = np.where(mask)
    if ys.size < 40:
        return None
    return float(xs.mean()), float(ys.mean())


def _masked_gray(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    gray[~mask] = 0.0
    return gray


def _align_clothes_to_bikini(
    clothes_rgb: np.ndarray,
    clothes_mask: np.ndarray,
    bikini_rgb: np.ndarray,
    bikini_mask: np.ndarray,
) -> np.ndarray:
    """Multi-pass non-rigid warp of clothes into bikini coordinates."""
    warped = _row_silhouette_warp(clothes_rgb, clothes_mask, bikini_mask)
    warped = _flow_by_shape_field(warped, bikini_mask)
    warped = _flow_by_appearance(warped, bikini_rgb, bikini_mask)
    return warped


def _row_silhouette_warp(
    source_rgb: np.ndarray,
    source_mask: np.ndarray,
    target_mask: np.ndarray,
) -> np.ndarray:
    """Map each target row's person span onto the source row's span."""
    h, w = target_mask.shape
    sl, sr, _ = _row_spans(source_mask)
    tl, tr, _ = _row_spans(target_mask)
    sl, sr = _fill_and_smooth(sl), _fill_and_smooth(sr)
    tl, tr = _fill_and_smooth(tl), _fill_and_smooth(tr)

    sys = np.where(source_mask.any(axis=1))[0]
    tys = np.where(target_mask.any(axis=1))[0]
    if sys.size < 2 or tys.size < 2:
        return source_rgb.copy()
    s0, s1 = float(sys.min()), float(sys.max())
    t0, t1 = float(tys.min()), float(tys.max())

    map_x = np.zeros((h, w), np.float32)
    map_y = np.zeros((h, w), np.float32)
    xs = np.arange(w, dtype=np.float32)
    for y in range(h):
        t = (y - t0) / max(1e-3, (t1 - t0))
        y_src = float(np.clip(s0 + t * (s1 - s0), 0, h - 1))
        yi = int(round(y_src))
        tw = max(1e-3, tr[y] - tl[y])
        sw = max(1e-3, sr[yi] - sl[yi])
        map_x[y] = sl[yi] + (xs - tl[y]) * (sw / tw)
        map_y[y] = y_src

    return cv2.remap(
        source_rgb,
        map_x,
        map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )


def _shape_field(mask: np.ndarray) -> np.ndarray:
    """Normalized distance-transform + soft edges — comparable across outfits."""
    dt = ndimage.distance_transform_edt(mask).astype(np.float32)
    if dt.max() > 0:
        dt /= dt.max()
    sx = ndimage.sobel(mask.astype(np.float32), axis=1)
    sy = ndimage.sobel(mask.astype(np.float32), axis=0)
    edge = np.sqrt(sx * sx + sy * sy)
    if edge.max() > 0:
        edge /= edge.max()
    field = 0.65 * dt + 0.35 * edge
    return field


def _flow_by_shape_field(src_rgb: np.ndarray, dst_mask: np.ndarray) -> np.ndarray:
    """Dense flow aligning src person shape onto dst_mask via DT fields."""
    # Approximate src mask from non-bg heuristic after prior warp: use remask via
    # luminance variance inside dilated dst — cheaper than SegFormer mid-pass.
    src_mask = _rough_person_mask(src_rgb, dst_mask)
    src_f = _shape_field(src_mask)
    dst_f = _shape_field(dst_mask)
    return _farneback_remap(src_rgb, dst_f, src_f, dst_mask, winsize=45, levels=5)


def _flow_by_appearance(
    src_rgb: np.ndarray, dst_rgb: np.ndarray, dst_mask: np.ndarray
) -> np.ndarray:
    """Refine with masked grayscale (face/hair/skin cues)."""
    src_g = cv2.cvtColor(src_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    dst_g = cv2.cvtColor(dst_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    # Match contrast inside the body so outfit color doesn't dominate flow.
    region = ndimage.binary_dilation(dst_mask, iterations=8)
    src_g = _hist_match_region(src_g, dst_g, region)
    src_g = src_g / 255.0
    dst_g = dst_g / 255.0
    src_g[~region] = 0.0
    dst_g[~region] = 0.0
    return _farneback_remap(src_rgb, dst_g, src_g, dst_mask, winsize=31, levels=4)


def _farneback_remap(
    src_rgb: np.ndarray,
    dst_field: np.ndarray,
    src_field: np.ndarray,
    weight_mask: np.ndarray,
    *,
    winsize: int,
    levels: int,
) -> np.ndarray:
    """prev=dst, next=src → remap src at (x+fx,y+fy) into dst coordinates."""
    flow = cv2.calcOpticalFlowFarneback(
        dst_field.astype(np.float32),
        src_field.astype(np.float32),
        None,
        pyr_scale=0.5,
        levels=levels,
        winsize=winsize,
        iterations=6,
        poly_n=7,
        poly_sigma=1.5,
        flags=0,
    )
    weight = cv2.GaussianBlur(weight_mask.astype(np.float32), (0, 0), sigmaX=6)
    weight = np.clip(weight, 0.0, 1.0)
    flow = flow * weight[..., None]
    h, w = weight_mask.shape
    grid_x, grid_y = np.meshgrid(
        np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32)
    )
    return cv2.remap(
        src_rgb,
        grid_x + flow[..., 0],
        grid_y + flow[..., 1],
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )


def _rough_person_mask(rgb: np.ndarray, hint: np.ndarray) -> np.ndarray:
    """Fast person mask near `hint` without reloading SegFormer."""
    region = ndimage.binary_dilation(hint, iterations=20)
    # Chroma distance from median background outside hint.
    bg_samples = rgb[~ndimage.binary_dilation(hint, iterations=4)]
    if bg_samples.size == 0:
        return hint.copy()
    ref = np.median(bg_samples.astype(np.float32), axis=0)
    dist = np.linalg.norm(rgb.astype(np.float32) - ref, axis=2)
    mask = (dist > 28.0) & region
    mask = ndimage.binary_opening(mask, iterations=1)
    mask = ndimage.binary_closing(mask, iterations=2)
    labels, n = ndimage.label(mask)
    if n == 0:
        return hint.copy()
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    return labels == int(counts.argmax())


def _hist_match_region(
    src: np.ndarray, ref: np.ndarray, region: np.ndarray
) -> np.ndarray:
    """Match src luminance mean/std to ref inside region."""
    out = src.copy()
    s = src[region]
    r = ref[region]
    if s.size < 32 or r.size < 32:
        return out
    s_std = float(s.std()) + 1e-6
    r_std = float(r.std()) + 1e-6
    out[region] = (s - float(s.mean())) * (r_std / s_std) + float(r.mean())
    return np.clip(out, 0.0, 255.0)


def _row_spans(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    h, _w = mask.shape
    left = np.full(h, np.nan, dtype=np.float64)
    right = np.full(h, np.nan, dtype=np.float64)
    mid = np.full(h, np.nan, dtype=np.float64)
    for y in range(h):
        xs = np.where(mask[y])[0]
        if xs.size:
            left[y] = float(xs.min())
            right[y] = float(xs.max())
            mid[y] = float(xs.mean())
    return left, right, mid


def _fill_and_smooth(a: np.ndarray, k: int = 31) -> np.ndarray:
    out = a.copy()
    idx = np.arange(len(out))
    good = np.isfinite(out)
    if int(good.sum()) < 2:
        return np.nan_to_num(out, nan=0.0)
    out[~good] = np.interp(idx[~good], idx[good], out[good])
    pad = np.pad(out, (k // 2, k // 2), mode="edge")
    kernel = np.ones(k, dtype=np.float64) / k
    return np.convolve(pad, kernel, mode="valid")


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    inter = int((a & b).sum())
    union = int((a | b).sum()) or 1
    return inter / union


def _edge_mae(a: np.ndarray, b: np.ndarray) -> float:
    ea = a ^ ndimage.binary_erosion(a)
    if not ea.any():
        return 0.0
    db = ndimage.distance_transform_edt(~b)
    return float(db[ea].mean())


def _arm_pose_mismatch(bikini_mask: np.ndarray, clothes_mask: np.ndarray) -> bool:
    bw = _upper_body_mean_width(bikini_mask)
    cw = _upper_body_mean_width(clothes_mask)
    if bw < 1 or cw < 1:
        return False
    ratio = cw / bw
    if ratio < POSE_WIDTH_RATIO_MIN or ratio > POSE_WIDTH_RATIO_MAX:
        return True
    return abs(_upper_lr_asymmetry(bikini_mask) - _upper_lr_asymmetry(clothes_mask)) > 0.28


def _upper_body_mean_width(mask: np.ndarray) -> float:
    h = mask.shape[0]
    band = mask[int(0.18 * h) : int(0.48 * h)]
    if band.size == 0:
        return 0.0
    widths = band.sum(axis=1).astype(np.float32)
    widths = widths[widths > 0]
    return float(widths.mean()) if widths.size else 0.0


def _upper_lr_asymmetry(mask: np.ndarray) -> float:
    h, w = mask.shape
    band = mask[int(0.18 * h) : int(0.48 * h)]
    left = float(band[:, : w // 2].sum())
    right = float(band[:, w // 2 :].sum())
    total = left + right
    if total < 1:
        return 0.0
    return abs(left - right) / total


def _write_match_previews(
    bikini_rgb: np.ndarray,
    clothes_rgb: np.ndarray,
    *,
    difference_path: Path | None = None,
    blend_path: Path | None = None,
) -> None:
    """Write Match QA previews: difference (|a−b|) and 50/50 blend."""
    bikini_f = bikini_rgb.astype(np.float32)
    clothes_f = clothes_rgb.astype(np.float32)

    if difference_path is not None:
        # Same math as CSS mix-blend-mode: difference.
        _save_match_preview(
            np.abs(bikini_f - clothes_f),
            difference_path,
        )
    if blend_path is not None:
        _save_match_preview(0.5 * bikini_f + 0.5 * clothes_f, blend_path)


def _save_match_preview(rgb: np.ndarray, path: Path) -> None:
    canvas = cover_to_canvas(
        Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)),
        width=CANVAS_WIDTH,
        height=CANVAS_HEIGHT,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path, format="JPEG", quality=92, optimize=True)
