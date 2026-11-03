"""Dress a person with FASHN VTON v1.5.

The model takes two pictures: the person and a garment. It does not take
text. Output is the official 576×864 frame.

ponytail: every Run starts a new process and loads the weights again.
Upgrade path is one long-lived worker. MPS is used when this Mac has it;
DWPose and the human parser stay on CPU inside the official pipeline.
"""

from __future__ import annotations

import sys
from pathlib import Path

WEIGHTS = Path.home() / ".local/share/fashn-vton-1.5/weights"
CATEGORIES = ("tops", "bottoms", "one-pieces")
PHOTOS = ("model", "flat-lay")


def sample_settings(steps: int) -> dict:
    """Mask the old outfit so the garment photo fills it, and use the quality step count.

    guidance stays at the official 1.5. Raising it also clamps the person
    photo and saturates color. ponytail: a much longer garment can still be
    limited by the original clothing outline. Upgrade path is segmentation-free
    plus a garment-only composite.
    """
    return {
        "num_timesteps": steps,
        "guidance_scale": 1.5,
        "segmentation_free": False,
    }


def checked(category: str, photo: str) -> tuple[str, str]:
    if category not in CATEGORIES:
        raise SystemExit(f"衣服種類不對：{category}")
    if photo not in PHOTOS:
        raise SystemExit(f"衣服照片種類不對：{photo}")
    return category, photo


def pick_device() -> str:
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_pipeline(device: str):
    from fashn_vton import TryOnPipeline

    return TryOnPipeline(weights_dir=str(WEIGHTS), device=device)


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-check":
        checked("tops", "model")
        checked("one-pieces", "flat-lay")
        settings = sample_settings(50)
        if settings["segmentation_free"] or settings["guidance_scale"] != 1.5 or settings["num_timesteps"] != 50:
            raise SystemExit(f"sample settings drifted: {settings}")
        try:
            checked("hat", "model")
        except SystemExit:
            print("fashn-tryon self-check ok")
            return
        raise SystemExit("bad category was accepted")
    if len(sys.argv) not in (6, 7):
        raise SystemExit(
            "usage: fashn_tryon.py person garment out category photo [steps] | --self-check"
        )
    person, garment, out = (Path(p) for p in sys.argv[1:4])
    category, photo = checked(sys.argv[4], sys.argv[5])
    steps = int(sys.argv[6]) if len(sys.argv) == 7 else 50
    if not WEIGHTS.joinpath("model.safetensors").is_file():
        raise SystemExit("FASHN 權重還沒裝好")

    from PIL import Image

    device = pick_device()
    print(f"fashn: device {device}", flush=True)
    try:
        pipe = load_pipeline(device)
    except Exception as err:
        if device != "mps":
            raise
        print(f"fashn: mps load failed, using cpu: {err}", flush=True)
        device = "cpu"
        pipe = load_pipeline(device)

    def run(model):
        return model(
            person_image=Image.open(person).convert("RGB"),
            garment_image=Image.open(garment).convert("RGB"),
            category=category,
            garment_photo_type=photo,
            **sample_settings(steps),
        )

    try:
        result = run(pipe)
    except Exception as err:
        if device != "mps":
            raise
        print(f"fashn: mps run failed, using cpu: {err}", flush=True)
        del pipe
        import torch

        torch.mps.empty_cache()
        result = run(load_pipeline("cpu"))
    image = result.images[0]
    image.save(out)
    print(f"fashn: wrote {image.size[0]}x{image.size[1]}", flush=True)


if __name__ == "__main__":
    main()
