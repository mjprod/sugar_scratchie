"""Local FLUX 3 Image Klein worker. Keep weights outside the website repo.

The checkpoint is step-distilled: 16 flow-map jumps, not a 4-step model.
Cutting steps changes the jump schedule, so speed comes from skipping the
Qwen3.5 prompt upsampler and keeping the weights on the GPU.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

# 192GB unified memory. The default MPS watermark flushes the cache mid-step.
os.environ["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MARKER = "FLUX3_JSON:"
# Distilled schedule. Do not lower this to "go faster".
STEPS = 16
# Upsampler is greedy and usually stops well under this. The library default
# is 3584, which lets a runaway caption dominate the whole job.
QUALITY_MAX_NEW_TOKENS = 768

_upsampler_block = None


def device() -> str:
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def tune(torch) -> None:
    torch.set_float32_matmul_precision("high")


def load_pipe():
    import torch
    from diffusers import ModularPipeline

    tune(torch)
    repo = "black-forest-labs/flux-3-image-klein"
    pipe = ModularPipeline.from_pretrained(repo)
    pipe.load_components(dtype=torch.bfloat16)
    pipe.to(device())
    return pipe


def use_upsampler(pipe, enabled: bool) -> None:
    """Pop or restore the prompt-upsampler block. Components stay loaded.

    `pipe.blocks` is a deepcopy, so the live graph is `pipe._blocks`.
    """
    global _upsampler_block
    blocks = pipe._blocks.sub_blocks
    if enabled:
        if "prompt_upsampler" not in blocks and _upsampler_block is not None:
            blocks.insert("prompt_upsampler", _upsampler_block, 0)
        return
    if "prompt_upsampler" in blocks:
        _upsampler_block = blocks.pop("prompt_upsampler")


def fit_cover(im, width: int, height: int):
    """Uniform scale, then a center crop. A different output frame must not stretch the person."""
    from PIL import Image

    w, h = im.size
    if w == width and h == height:
        return im
    scale = max(width / w, height / h)
    nw = max(width, int(round(w * scale)))
    nh = max(height, int(round(h * scale)))
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    left = max(0, (nw - width) // 2)
    top = max(0, (nh - height) // 2)
    return im.crop((left, top, left + width, top + height))


def generate(pipe, job: dict) -> str:
    import torch
    from PIL import Image

    use_upsampler(pipe, bool(job.get("upsample")))
    kwargs = {
        "prompt": job["prompt"],
        "width": int(job["width"]),
        "height": int(job["height"]),
        "num_inference_steps": STEPS,
        "output": "images",
    }
    if job.get("upsample"):
        kwargs["max_new_tokens"] = int(job.get("max_new_tokens") or QUALITY_MAX_NEW_TOKENS)
    paths = job.get("images") or []
    if paths:
        images = []
        width = int(job["width"])
        height = int(job["height"])
        for index, path in enumerate(paths):
            im = Image.open(path).convert("RGB")
            if index == 0:
                im = fit_cover(im, width, height)
            images.append(im)
        kwargs["image"] = images
    with torch.inference_mode():
        image = pipe(**kwargs)[0]
    out = Path(tempfile.mkdtemp(prefix="flux3-klein-out-")) / "out.png"
    image.save(out, compress_level=1)
    return str(out)


def reply(payload: dict) -> None:
    sys.stdout.write(MARKER + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def serve() -> None:
    sys.stderr.write("loading weights\n")
    sys.stderr.flush()
    pipe = load_pipe()
    sys.stderr.write("FLUX3_READY\n")
    sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            path = generate(pipe, json.loads(line))
            reply({"ok": True, "path": path})
        except Exception as err:
            reply({"ok": False, "error": str(err)})


def check_blocks() -> None:
    os.environ["HF_HUB_OFFLINE"] = "1"
    from diffusers import ModularPipeline

    pipe = ModularPipeline.from_pretrained(
        "black-forest-labs/flux-3-image-klein",
        local_files_only=True,
    )
    assert list(pipe._blocks.sub_blocks)[0] == "prompt_upsampler"
    use_upsampler(pipe, False)
    assert "prompt_upsampler" not in pipe._blocks.sub_blocks
    use_upsampler(pipe, True)
    assert list(pipe._blocks.sub_blocks)[0] == "prompt_upsampler"
    use_upsampler(pipe, False)
    assert "prompt_upsampler" not in pipe._blocks.sub_blocks
    print("flux3 block toggle ok")


if __name__ == "__main__":
    if "--check-cover" in sys.argv:
        from PIL import Image

        im = Image.new("RGB", (200, 100), (0, 0, 255))
        im.paste(Image.new("RGB", (40, 100), (255, 0, 0)), (80, 0))
        fitted = fit_cover(im, 50, 50)
        if fitted.size != (50, 50):
            raise SystemExit(f"cover size {fitted.size}")
        if fitted.getpixel((25, 25))[0] < 200 or fitted.getpixel((2, 25))[2] < 200:
            raise SystemExit(f"cover stretched {fitted.getpixel((25, 25))} {fitted.getpixel((2, 25))}")
        print("flux3 cover ok")
    elif "--check-blocks" in sys.argv:
        check_blocks()
    elif "--serve" in sys.argv:
        serve()
    else:
        sys.stderr.write("usage: flux3_klein.py --serve | --check-blocks\n")
        sys.exit(2)
