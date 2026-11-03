"""Cut the worn clothes out of a photo. The pixels stay where they are.

SCHP (MIT) labels the person. Only cloth classes are kept. Face, skin,
hair, and the room become transparent. This is not a flat lay.
"""
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

LEFFA_PY = Path.home() / ".local/share/Leffa/.venv/bin/python"
SCHP_ROOT = Path.home() / ".local/share/Leffa/preprocess/humanparsing"
ONNX = Path.home() / ".local/share/Leffa/ckpts/humanparsing/parsing_atr.onnx"

# ATR label order. Cloth is what is worn, not the body under it.
LABELS = (
    "Background",
    "Hat",
    "Hair",
    "Sunglasses",
    "Upper-clothes",
    "Skirt",
    "Pants",
    "Dress",
    "Belt",
    "Left-shoe",
    "Right-shoe",
    "Face",
    "Left-leg",
    "Right-leg",
    "Left-arm",
    "Right-arm",
    "Bag",
    "Scarf",
)
CLOTH = {LABELS.index(name) for name in ("Upper-clothes", "Skirt", "Pants", "Dress", "Belt", "Scarf")}
BODY = {
    LABELS.index(name)
    for name in ("Face", "Hair", "Hat", "Sunglasses", "Left-arm", "Right-arm", "Left-leg", "Right-leg")
}


def use_leffa_python() -> None:
    if not LEFFA_PY.is_file():
        raise SystemExit("SCHP 還沒裝好")
    if Path(sys.executable).resolve() == LEFFA_PY.resolve():
        return
    os.execv(str(LEFFA_PY), [str(LEFFA_PY), *sys.argv])


def _odd(n: int) -> int:
    n = max(3, n)
    return n if n % 2 else n + 1


def _skin(rgb: np.ndarray) -> np.ndarray:
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    return (r > 95) & (g > 40) & (b > 20) & (r > g) & (r > b) & ((r - g) > 15) & ((r - b) > 15)


def refine_mask(rgb: np.ndarray, labels: np.ndarray) -> np.ndarray:
    """Snap the coarse parse to the garment edge and drop leftover skin.

    ponytail: one GrabCut pass inside the dilated parse. A skin-coloured
    garment (more than half the mask) is left alone. Upgrade path is a
    higher-res parser, not a bigger kernel.
    """
    cloth = np.isin(labels, list(CLOTH)).astype(np.uint8)
    if int(cloth.sum()) < 30 or min(rgb.shape[:2]) < 64:
        return np.where(cloth, 255, 0).astype(np.uint8)
    import cv2

    step = _odd(int(round(min(rgb.shape[:2]) / 100)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (step, step))
    core = cv2.erode(cloth, kernel)
    if int(core.sum()) < 30:
        core = cloth
    outer = cv2.dilate(cloth, kernel)
    gc = np.full(cloth.shape, cv2.GC_BGD, np.uint8)
    gc[outer > 0] = cv2.GC_PR_BGD
    gc[cloth > 0] = cv2.GC_PR_FGD
    gc[core > 0] = cv2.GC_FGD
    body = np.isin(labels, list(BODY))
    gc[body] = cv2.GC_BGD
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    cv2.grabCut(np.ascontiguousarray(rgb), gc, None, bgd, fgd, 2, cv2.GC_INIT_WITH_MASK)
    keep = np.where((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD), np.uint8(255), np.uint8(0))
    keep[outer == 0] = 0
    keep[body] = 0
    small = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    keep = cv2.morphologyEx(keep, cv2.MORPH_CLOSE, small)
    keep = cv2.morphologyEx(keep, cv2.MORPH_OPEN, small)
    skin = _skin(rgb) & (keep > 0)
    cloth_n = int((keep > 0).sum())
    if cloth_n and int(skin.sum()) <= cloth_n * 0.45:
        count, parts, stats, _ = cv2.connectedComponentsWithStats(skin.astype(np.uint8), 8)
        for i in range(1, count):
            if stats[i, cv2.CC_STAT_AREA] >= 80:
                keep[parts == i] = 0
    count, parts, stats, _ = cv2.connectedComponentsWithStats((keep > 0).astype(np.uint8), 8)
    if count > 1:
        areas = stats[1:, cv2.CC_STAT_AREA]
        keep_ids = 1 + np.flatnonzero(areas >= max(30, int(areas.max() * 0.02)))
        keep = np.where(np.isin(parts, keep_ids), np.uint8(255), np.uint8(0))
    # One-pixel ramp so the parse stairs don't read as a cut.
    soft = cv2.GaussianBlur(keep, (0, 0), 1.0)
    band = cv2.dilate(keep, np.ones((3, 3), np.uint8))
    soft[band == 0] = 0
    soft[cv2.erode(keep, np.ones((3, 3), np.uint8)) > 0] = 255
    return soft


def cut_clothes(rgb: np.ndarray, labels: np.ndarray) -> Image.Image:
    if rgb.shape[:2] != labels.shape[:2]:
        raise SystemExit(f"mask {labels.shape} != image {rgb.shape[:2]}")
    alpha = refine_mask(rgb, labels)
    if int((alpha > 0).sum()) < 30:
        raise SystemExit("這張圖沒有分出衣服")
    return Image.fromarray(np.dstack([rgb, alpha]), "RGBA")


def parse(rgb: Image.Image) -> np.ndarray:
    import onnxruntime as ort
    import torch
    import torchvision.transforms as transforms

    sys.path.insert(0, str(SCHP_ROOT))
    from datasets.simple_extractor_dataset import SimpleFolderDataset
    from utils.transforms import transform_logits

    if not ONNX.is_file():
        raise SystemExit("SCHP 權重不在")
    transform = transforms.Compose(
        [
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.406, 0.456, 0.485], std=[0.225, 0.224, 0.229]),
        ]
    )
    image, meta = SimpleFolderDataset(rgb.convert("RGB"), [512, 512], transform)[0]
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    session = ort.InferenceSession(
        str(ONNX),
        sess_options=opts,
        providers=["CoreMLExecutionProvider", "CPUExecutionProvider"],
    )
    output = session.run(None, {"input.1": image.unsqueeze(0).numpy().astype(np.float32)})
    logits = torch.nn.functional.interpolate(
        torch.from_numpy(output[1][0]).unsqueeze(0),
        size=(512, 512),
        mode="bilinear",
        align_corners=True,
    )
    logits = logits.squeeze(0).permute(1, 2, 0).numpy()
    restored = transform_logits(
        logits,
        meta["center"],
        meta["scale"],
        int(meta["width"]),
        int(meta["height"]),
        input_size=[512, 512],
    )
    return np.argmax(restored, axis=2).astype(np.uint8)


def self_check() -> None:
    labels = np.zeros((16, 16), np.uint8)
    labels[1:9, 1:9] = LABELS.index("Upper-clothes")
    labels[1, 12] = LABELS.index("Face")
    rgb = np.full((16, 16, 3), 20, np.uint8)
    rgb[1:9, 1:9] = (24, 36, 72)
    out = cut_clothes(rgb, labels)
    if out.getpixel((2, 2)) != (24, 36, 72, 255):
        raise SystemExit("cloth pixel dropped")
    if out.getpixel((12, 1))[3] != 0 or out.getpixel((0, 0))[3] != 0:
        raise SystemExit("face or room was kept")
    big = np.full((96, 96, 3), 20, np.uint8)
    big[20:70, 25:70] = (24, 36, 90)
    big[40:60, 40:60] = (210, 140, 120)
    big_labels = np.zeros((96, 96), np.uint8)
    big_labels[20:70, 25:70] = LABELS.index("Upper-clothes")
    big_labels[5, 5] = LABELS.index("Face")
    cleaned = cut_clothes(big, big_labels)
    if cleaned.getpixel((34, 26))[3] < 250:
        raise SystemExit("cloth core was dropped")
    if cleaned.getpixel((50, 50))[3] != 0:
        raise SystemExit("skin inside the garment was kept")
    if cleaned.getpixel((2, 2))[3] != 0:
        raise SystemExit("room was pulled into the garment")
    if not ONNX.is_file():
        raise SystemExit("SCHP 權重不在")
    blank = Image.new("RGB", (64, 96), (8, 30, 80))
    parsed = parse(blank)
    if parsed.shape != (96, 64):
        raise SystemExit(f"parse shape {parsed.shape}")
    print("extract-clothes self-check ok")


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-check":
        use_leffa_python()
        self_check()
        return
    use_leffa_python()
    if len(sys.argv) != 3:
        raise SystemExit("usage: extract_clothes.py src out | --self-check")
    src, dest = Path(sys.argv[1]), Path(sys.argv[2])
    rgb = np.asarray(Image.open(src).convert("RGB"))
    cut_clothes(rgb, parse(Image.fromarray(rgb, "RGB"))).save(dest)
    print("extract: clothes", flush=True)


if __name__ == "__main__":
    main()
