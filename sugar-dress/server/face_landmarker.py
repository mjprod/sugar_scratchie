"""Face oval from MediaPipe Face Landmarker. Own venv, not Klein's.

ponytail: one process per request, so the first call pays the import.
Upgrade path is a resident worker.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

MODEL = Path.home() / ".local/share/sugar-dress-face/face_landmarker.task"


def oval_order() -> list[int]:
    from mediapipe.tasks.python.vision.face_landmarker import FaceLandmarksConnections

    conns = FaceLandmarksConnections.FACE_LANDMARKS_FACE_OVAL
    nxt = {c.start: c.end for c in conns}
    start = conns[0].start
    order = [start]
    seen = {start}
    while True:
        nxt_i = nxt[order[-1]]
        if nxt_i == start or nxt_i in seen:
            break
        order.append(nxt_i)
        seen.add(nxt_i)
    if nxt[order[-1]] != start:
        raise SystemExit("face oval did not close")
    return order


def landmarker():
    import mediapipe as mp
    from mediapipe.tasks import python as mpt
    from mediapipe.tasks.python import vision

    if not MODEL.is_file():
        raise SystemExit("Face Landmarker 模型還沒下載")
    options = vision.FaceLandmarkerOptions(
        base_options=mpt.BaseOptions(model_asset_path=str(MODEL)),
        num_faces=1,
    )
    return mp, vision.FaceLandmarker.create_from_options(options)


def detect(path: str) -> list[list[float]]:
    mp, detector = landmarker()
    image = mp.Image.create_from_file(path)
    result = detector.detect(image)
    if not result.face_landmarks:
        return []
    lm = result.face_landmarks[0]
    w, h = image.width, image.height
    return [[round(lm[i].x * w, 2), round(lm[i].y * h, 2)] for i in oval_order()]


def self_check() -> None:
    from PIL import Image

    order = oval_order()
    if len(order) < 30:
        raise SystemExit(f"oval too short {len(order)}")
    blank = Path("/tmp/sugar-face-blank.png")
    Image.new("RGB", (96, 96), (180, 140, 120)).save(blank)
    if detect(str(blank)):
        raise SystemExit("blank image grew a face")
    print("face-landmarker self-check ok")


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-check":
        self_check()
        return
    if len(sys.argv) != 2:
        raise SystemExit("usage: face_landmarker.py image | --self-check")
    print(json.dumps({"points": detect(sys.argv[1])}), flush=True)


if __name__ == "__main__":
    main()
