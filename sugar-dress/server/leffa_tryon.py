"""Leffa virtual try-on. Run with the Leffa venv, not the Klein one.

DensePose stays on CPU (detectron2 has no MPS path). The diffusion UNet uses
MPS. float32: Leffa's float16 path is the CUDA default and is skipped here.
"""

import sys
from pathlib import Path

ROOT = Path.home() / ".local/share/Leffa"

PLAN = {
    "tops": ("viton_hd", "upper_body", "virtual_tryon.pth"),
    "bottoms": ("viton_hd", "lower_body", "virtual_tryon.pth"),
    "one-pieces": ("dress_code", "dresses", "virtual_tryon_dc.pth"),
}


def plan(category: str):
    item = PLAN.get(category)
    if item is None:
        raise SystemExit(f"unknown category {category}")
    return item


def self_check() -> None:
    assert plan("tops") == ("viton_hd", "upper_body", "virtual_tryon.pth")
    assert plan("bottoms")[1] == "lower_body"
    assert plan("one-pieces")[0] == "dress_code"
    try:
        plan("shoes")
    except SystemExit:
        pass
    else:
        raise SystemExit("bad category was accepted")
    print("leffa-tryon self-check ok")


def run(person: str, garment: str, out: str, category: str) -> None:
    import os

    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

    model_type, garment_type, ckpt_name = plan(category)
    ckpt = ROOT / "ckpts" / ckpt_name
    if not ckpt.is_file():
        raise SystemExit(f"Leffa 權重還沒好：{ckpt_name}")

    import numpy as np
    from PIL import Image

    from leffa.inference import LeffaInference
    from leffa.model import LeffaModel
    from leffa.transform import LeffaTransform
    from leffa_utils.densepose_predictor import DensePosePredictor
    from leffa_utils.utils import (
        get_agnostic_mask_dc,
        get_agnostic_mask_hd,
        resize_and_center,
    )
    from preprocess.humanparsing.run_parsing import Parsing
    from preprocess.openpose.run_openpose import OpenPose

    parsing = Parsing(
        atr_path="./ckpts/humanparsing/parsing_atr.onnx",
        lip_path="./ckpts/humanparsing/parsing_lip.onnx",
    )
    openpose = OpenPose(body_model_path="./ckpts/openpose/body_pose_model.pth")
    densepose = DensePosePredictor(
        config_path="./ckpts/densepose/densepose_rcnn_R_50_FPN_s1x.yaml",
        weights_path="./ckpts/densepose/model_final_162be9.pkl",
    )
    # float32 on this Mac. CUDA builds use float16; MPS is not that path.
    model = LeffaModel(
        pretrained_model_name_or_path="./ckpts/stable-diffusion-inpainting",
        pretrained_model=str(ckpt),
        dtype="float32",
    )
    inference = LeffaInference(model=model)

    src_image = resize_and_center(Image.open(person), 768, 1024)
    ref_image = resize_and_center(Image.open(garment), 768, 1024)
    src_image_array = np.array(src_image)
    src_image = src_image.convert("RGB")
    model_parse, _ = parsing(src_image.resize((384, 512)))
    keypoints = openpose(src_image.resize((384, 512)))
    if model_type == "viton_hd":
        mask = get_agnostic_mask_hd(model_parse, keypoints, garment_type)
    else:
        mask = get_agnostic_mask_dc(model_parse, keypoints, garment_type)
    mask = mask.resize((768, 1024))
    if model_type == "viton_hd":
        seg = densepose.predict_seg(src_image_array)[:, :, ::-1]
    else:
        iuv = densepose.predict_iuv(src_image_array)
        seg = np.concatenate([iuv[:, :, 0:1]] * 3, axis=-1)
    dense = Image.fromarray(seg)

    data = LeffaTransform()(
        {
            "src_image": [src_image],
            "ref_image": [ref_image],
            "mask": [mask],
            "densepose": [dense],
        }
    )
    output = inference(
        data,
        ref_acceleration=False,
        num_inference_steps=30,
        guidance_scale=2.5,
        seed=42,
        repaint=False,
    )
    gen = output["generated_image"][0]
    if not isinstance(gen, Image.Image):
        gen = Image.fromarray(np.asarray(gen))
    gen.save(out)
    print(f"leffa: wrote {gen.size[0]}x{gen.size[1]}", flush=True)


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--self-check":
        self_check()
        return
    if len(sys.argv) != 5:
        raise SystemExit("usage: leffa_tryon.py person garment out category")
    run(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])


if __name__ == "__main__":
    main()
