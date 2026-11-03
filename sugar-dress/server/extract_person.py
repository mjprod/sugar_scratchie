"""Crop a frame out of the source and drop the background.

The crop is a view of the original pixels. CorridorKey (MLX) or MODNet builds
the matte. Saved RGB stays the crop; only the alpha comes from the model.

ponytail: CorridorKey is a green-screen keyer (despill only on a green plate).
MODNet is the photographic portrait checkpoint at the official 512 ref size,
so a full-body or non-portrait crop is coarser. Upgrade path is a larger
ref size or a full-body matting checkpoint.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

PERSON = 1


def crop_pixels(im: Image.Image, x: float, y: float, w: float, h: float) -> Image.Image:
    iw, ih = im.size
    x0 = max(0, min(iw - 1, int(round(x))))
    y0 = max(0, min(ih - 1, int(round(y))))
    x1 = max(x0 + 1, min(iw, int(round(x + w))))
    y1 = max(y0 + 1, min(ih, int(round(y + h))))
    return im.crop((x0, y0, x1, y1))


def drop_backdrop(rgb: Image.Image, mask: np.ndarray, band: int = 36, thresh: int = 110) -> np.ndarray:
    """Drop a band of backdrop colour stuck to the silhouette.

    The median is taken from pixels already outside the mask, so a garment
    the same colour as the backdrop can lose its outer edge.
    ponytail: one median, not a matte. Upgrade path is a hair matte.
    """
    import torch
    import torch.nn.functional as F

    arr = np.asarray(rgb.convert("RGB")).astype(np.int16)
    keep = np.array(mask, dtype=bool, copy=True)
    if keep.shape != arr.shape[:2] or int((~keep).sum()) < 40:
        return keep
    med = np.median(arr[~keep], axis=0)
    dist = np.abs(arr - med).sum(axis=2)
    h, w = keep.shape
    k = min(band * 2 + 1, h if h % 2 else h - 1, w if w % 2 else w - 1)
    k = max(1, k)
    outside = torch.from_numpy((~keep).astype(np.float32))[None, None]
    near = F.max_pool2d(outside, k, stride=1, padding=k // 2)[0, 0].numpy() > 0.5
    keep[near & (dist < thresh)] = False
    return keep


def trim_halo(rgb: Image.Image, mask: np.ndarray, limit: int = 36, thresh: int = 80) -> np.ndarray:
    """Peel mask pixels that still match the colour just outside the cut.

    ponytail: colour distance only, so a garment the same colour as the
    backdrop can lose its edge. Upgrade path is a real matte model.
    """
    arr = np.asarray(rgb.convert("RGB")).astype(np.int16)
    keep = np.array(mask, dtype=bool, copy=True)
    if keep.shape != arr.shape[:2]:
        return keep
    h, w = keep.shape
    for _ in range(limit):
        bg = ~keep
        total = np.zeros_like(arr)
        count = np.zeros(keep.shape, dtype=np.int16)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            ys = slice(max(dy, 0), h + min(dy, 0))
            xs = slice(max(dx, 0), w + min(dx, 0))
            yd = slice(max(-dy, 0), h + min(-dy, 0))
            xd = slice(max(-dx, 0), w + min(-dx, 0))
            taken = bg[ys, xs]
            count[yd, xd] += taken.astype(np.int16)
            total[yd, xd] += arr[ys, xs] * taken[:, :, None]
        edge = keep & (count > 0)
        if not edge.any():
            break
        mean = total / np.maximum(count, 1)[:, :, None]
        drop = edge & (np.abs(arr - mean).sum(axis=2) < thresh)
        if not drop.any():
            break
        keep[drop] = False
    return keep


def coarse_hint(mask: np.ndarray) -> np.ndarray:
    """Shrink the hint. CorridorKey fills edges; a fat hint leaves the backdrop in."""
    import torch
    import torch.nn.functional as F

    h, w = mask.shape
    radius = max(4, round(min(h, w) * 0.012))
    k = min(radius * 2 + 1, h if h % 2 else h - 1, w if w % 2 else w - 1)
    k = max(1, k)
    t = torch.from_numpy(mask.astype(np.float32))[None, None]
    eroded = -F.max_pool2d(-t, k, stride=1, padding=k // 2)
    return eroded[0, 0].clamp(0, 1).numpy().astype(np.float32)


def key_with_corridor(frame: Image.Image, mask: np.ndarray) -> Image.Image:
    root = Path.home() / ".local/share/CorridorKey"
    sys.path.insert(0, str(root))
    os.chdir(root)
    from CorridorKeyModule.backend import create_engine

    rgb = np.asarray(frame.convert("RGB"))
    hint = coarse_hint(mask)
    bg = rgb[hint < 0.25]
    despill = 0.0
    if bg.shape[0] > 40:
        med = np.median(bg.astype(np.float32), axis=0)
        if med[1] > med[0] + 12 and med[1] >= med[2]:
            despill = 1.0
    engine = create_engine(backend="mlx", img_size=2048, tile_size=None)
    result = engine.process_frame(rgb, hint, despill_strength=despill, auto_despeckle=False)
    fg = np.clip(result["fg"], 0, 1)
    alpha = np.clip(result["alpha"], 0, 1)
    if alpha.ndim == 3:
        alpha = alpha[..., 0]
    rgba = np.dstack([(fg * 255).round().astype(np.uint8), (alpha * 255).round().astype(np.uint8)])
    return Image.fromarray(rgba, "RGBA")


def apply_matte(rgb: Image.Image, matte: np.ndarray) -> Image.Image:
    """Keep the crop's RGB. The matte is only the alpha."""
    im = rgb.convert("RGB")
    alpha = np.clip(np.asarray(matte, dtype=np.float32), 0, 1)
    if alpha.shape != (im.size[1], im.size[0]):
        raise ValueError(f"matte {alpha.shape} != image {im.size}")
    rgba = np.dstack([np.asarray(im), (alpha * 255).round().astype(np.uint8)])
    return Image.fromarray(rgba, "RGBA")


def key_with_modnet(frame: Image.Image) -> Image.Image:
    """Official photographic portrait checkpoint. RGB of `frame` is not resized into the PNG."""
    root = Path.home() / ".local/share/MODNet"
    ckpt = root / "pretrained/modnet_photographic_portrait_matting.ckpt"
    if not ckpt.is_file():
        raise FileNotFoundError("MODNet 還沒裝好")
    sys.path.insert(0, str(root))
    import torch
    import torch.nn.functional as F
    from src.models.modnet import MODNet

    model = MODNet(backbone_pretrained=False)
    state = torch.load(ckpt, map_location="cpu", weights_only=True)
    if any(str(k).startswith("module.") for k in state):
        state = {str(k).removeprefix("module."): v for k, v in state.items()}
    model.load_state_dict(state)
    model.eval()

    im = frame.convert("RGB")
    w, h = im.size
    ref = 512
    if max(h, w) < ref or min(h, w) > ref:
        if w >= h:
            rh, rw = ref, int(w / h * ref)
        else:
            rw, rh = ref, int(h / w * ref)
    else:
        rh, rw = h, w
    rw, rh = max(32, rw - rw % 32), max(32, rh - rh % 32)
    tensor = torch.from_numpy(np.asarray(im).astype(np.float32) / 255.0).permute(2, 0, 1)[None]
    tensor = (tensor - 0.5) / 0.5
    tensor = F.interpolate(tensor, size=(rh, rw), mode="area")
    with torch.inference_mode():
        _, _, matte = model(tensor, True)
    matte = F.interpolate(matte, size=(h, w), mode="bilinear", align_corners=False)[0, 0]
    return apply_matte(im, matte.numpy())


def engine_name(raw: str | None) -> str:
    """MODNet is the only extractor. Older clients may still say corridor."""
    name = (raw or "modnet").strip().lower()
    if name == "corridor":
        return "modnet"
    if name != "modnet":
        raise SystemExit(f"extract: unknown engine {raw}")
    return name


def apply_alpha(rgb: Image.Image, mask: np.ndarray) -> Image.Image:
    out = rgb.convert("RGBA")
    alpha = Image.fromarray(np.where(mask, 255, 0).astype(np.uint8), mode="L")
    if alpha.size != out.size:
        alpha = alpha.resize(out.size, Image.Resampling.NEAREST)
    out.putalpha(alpha)
    return out


def person_mask(rgb: Image.Image) -> np.ndarray | None:
    import torch
    import torch.nn.functional as F
    from torchvision.models.detection import (
        MaskRCNN_ResNet50_FPN_V2_Weights,
        maskrcnn_resnet50_fpn_v2,
    )

    # CPU so this does not sit on the same GPU memory as Klein.
    weights = MaskRCNN_ResNet50_FPN_V2_Weights.DEFAULT
    model = maskrcnn_resnet50_fpn_v2(weights=weights).to("cpu").eval()
    im = rgb.convert("RGB")
    w, h = im.size
    long_side = max(w, h)
    scale = min(1.0, 1280 / long_side)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = im.resize((nw, nh), Image.Resampling.BILINEAR)
    tensor = torch.from_numpy(np.asarray(resized).astype(np.float32) / 255.0).permute(2, 0, 1)
    with torch.inference_mode():
        pred = model([tensor])[0]
    keep = (pred["labels"] == PERSON) & (pred["scores"] >= 0.5)
    if not bool(keep.any()):
        return None
    chosen = pred["masks"][keep, 0]
    areas = chosen.flatten(1).sum(1)
    chosen = chosen[areas >= areas.max() * 0.2]
    soft = chosen.amax(0)
    if soft.shape != (h, w):
        soft = F.interpolate(soft[None, None], size=(h, w), mode="bilinear", align_corners=False)[0, 0]
    return (soft >= 0.65).numpy()


def self_check() -> None:
    im = Image.new("RGB", (40, 80), (10, 10, 10))
    im.putpixel((5, 5), (255, 0, 0))
    cropped = crop_pixels(im, 2, 2, 10, 12)
    if cropped.getpixel((3, 3)) != (255, 0, 0):
        raise SystemExit(f"crop missed the pixel: {cropped.getpixel((3, 3))}")
    if cropped.size != (10, 12):
        raise SystemExit(f"crop size {cropped.size}")
    mask = np.zeros((12, 10), dtype=bool)
    mask[3, 3] = True
    cut = apply_alpha(cropped, mask)
    if cut.getpixel((3, 3))[3] != 255 or cut.getpixel((0, 0))[3] != 0:
        raise SystemExit("alpha mask missed")
    if cut.getpixel((3, 3))[:3] != (255, 0, 0):
        raise SystemExit("person pixel was resampled")
    plate = Image.new("RGB", (12, 12), (0, 160, 40))
    for y in range(4, 8):
        for x in range(4, 8):
            plate.putpixel((x, y), (210, 160, 140))
    halo = np.zeros((12, 12), dtype=bool)
    halo[3:9, 3:9] = True
    peeled = trim_halo(plate, halo)
    if peeled[3, 3] or not peeled[5, 5] or peeled.sum() != 16:
        raise SystemExit(f"halo trim {int(peeled.sum())}")
    stuck = np.zeros((12, 12), dtype=bool)
    stuck[2:10, 2:10] = True
    cut = drop_backdrop(plate, stuck, band=6, thresh=110)
    if cut[2, 2] or not cut[5, 5]:
        raise SystemExit("backdrop peel missed the ring")
    matte = np.zeros((12, 10), dtype=np.float32)
    matte[3, 3] = 1
    keyed = apply_matte(cropped, matte)
    if keyed.getpixel((3, 3)) != (255, 0, 0, 255) or keyed.getpixel((0, 0))[3] != 0:
        raise SystemExit("matte changed the crop pixel")
    if engine_name(None) != "modnet" or engine_name("corridor") != "modnet" or engine_name("MODNet") != "modnet":
        raise SystemExit("engine name")
    print("extract-person self-check ok")


def use_corridor_python() -> None:
    ck = Path.home() / ".local/share/CorridorKey/.venv/bin/python"
    if not ck.is_file():
        print("CorridorKey 還沒裝好", file=sys.stderr)
        raise SystemExit(1)
    if Path(sys.executable).resolve() == ck.resolve():
        return
    os.execv(str(ck), [str(ck), *sys.argv])


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-check":
        self_check()
        return
    use_corridor_python()
    if len(sys.argv) not in (7, 8):
        raise SystemExit("usage: extract_person.py src out x y w h [corridor|modnet] | --self-check")
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    x, y, w, h = (float(v) for v in sys.argv[3:7])
    method = engine_name(sys.argv[7] if len(sys.argv) == 8 else None)
    im = Image.open(src).convert("RGB")
    frame = crop_pixels(im, x, y, w, h)
    if method == "modnet":
        try:
            key_with_modnet(frame).save(out)
        except Exception as err:
            print(f"extract: modnet {err}", file=sys.stderr, flush=True)
            raise SystemExit(1) from err
        print("extract: modnet key", flush=True)
        return
    try:
        mask = person_mask(frame)
    except Exception as err:
        print(f"extract: crop only, mask {err}", flush=True)
        frame.save(out)
        return
    if mask is None or int(mask.sum()) < 30:
        print("extract: no person, kept frame", flush=True)
        frame.save(out)
        return
    peeled = drop_backdrop(frame, mask)
    if int(peeled.sum()) >= 30:
        mask = peeled
    try:
        key_with_corridor(frame, mask).save(out)
    except Exception as err:
        print(f"extract: corridor {err}", file=sys.stderr, flush=True)
        raise SystemExit(1) from err
    print("extract: corridor key", flush=True)


if __name__ == "__main__":
    main()
