#!/usr/bin/env python3
"""Local stand-in for the MAXMAC CLI. Not the live Klein service.

Sugar Scratchie calls the service at FLUX_KLEIN_URL
(POST /generate, then GET /jobs/{id} and GET /jobs/{id}/image).
That service already runs at https://flux.mxjprod.work and on
127.0.0.1:8790. This script only shells out to flux-klein for a
one-shot PNG and speaks a different path.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.environ.get("FLUX_KLEIN_HOST", "127.0.0.1")
PORT = int(os.environ.get("FLUX_KLEIN_PORT", "8091"))
MODEL_DIR = os.environ.get("FLUX_KLEIN_MODEL_DIR", "").strip()
PRESET = os.environ.get("FLUX_KLEIN_PRESET", "q8-quality-16").strip() or "q8-quality-16"
BIN = os.environ.get("FLUX_KLEIN_BIN", "flux-klein").strip() or "flux-klein"
GENERATE_TIMEOUT_S = int(os.environ.get("FLUX_KLEIN_TIMEOUT_S", "600"))

# Multiples of 16, the MLX CLI's size rule. 9:16 matches the card frame.
ASPECT_SIZES: dict[str, tuple[int, int]] = {
    "9:16": (768, 1344),
    "16:9": (1344, 768),
    "1:1": (1024, 1024),
    "3:4": (768, 1024),
    "4:3": (1024, 768),
    "2:3": (832, 1248),
    "3:2": (1248, 832),
    "4:5": (960, 1200),
    "5:4": (1200, 960),
    "21:9": (1792, 768),
    "9:21": (768, 1792),
}

_LOCK = threading.Lock()


def aspect_size(aspect_ratio: str) -> tuple[int, int]:
    return ASPECT_SIZES.get((aspect_ratio or "").strip(), ASPECT_SIZES["9:16"])


def build_command(
    *,
    prompt_file: Path,
    out: Path,
    images: list[Path],
    aspect_ratio: str,
    seed: int | None,
) -> list[str]:
    width, height = aspect_size(aspect_ratio)
    command = [
        BIN,
        "--model-dir",
        MODEL_DIR,
        "--preset",
        PRESET,
        "--prompt-file",
        str(prompt_file),
        "--width",
        str(width),
        "--height",
        str(height),
        "--out",
        str(out),
    ]
    if seed is not None:
        command.extend(["--seed", str(seed)])
    for image in images[:10]:
        command.extend(["--image", str(image)])
    return command


def _materialize_images(raw_images: list, directory: Path) -> list[Path]:
    paths: list[Path] = []
    for index, item in enumerate(raw_images[:10]):
        text = str(item or "").strip()
        if not text or text.startswith(("http://", "https://")):
            raise RuntimeError("The MAXMAC sidecar needs raw base64 images, not URLs.")
        if text.startswith("data:"):
            comma = text.find(",")
            text = text[comma + 1 :] if comma >= 0 else ""
        try:
            blob = base64.b64decode(text, validate=True)
        except Exception as exc:
            raise RuntimeError(f"Reference image {index + 1} is not base64.") from exc
        if not blob:
            raise RuntimeError(f"Reference image {index + 1} is empty.")
        path = directory / f"ref-{index + 1}.png"
        path.write_bytes(blob)
        paths.append(path)
    return paths


def render(payload: dict) -> bytes:
    if not MODEL_DIR:
        raise RuntimeError("Set FLUX_KLEIN_MODEL_DIR to the q8-quality weights directory.")
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise RuntimeError("Prompt is empty.")
    seed_raw = payload.get("seed")
    seed = int(seed_raw) if seed_raw is not None and str(seed_raw).strip() != "" else None
    aspect = str(payload.get("aspect_ratio") or "9:16")
    images_raw = payload.get("images") or []
    if not isinstance(images_raw, list):
        raise RuntimeError("images must be a list.")
    with tempfile.TemporaryDirectory(prefix="flux-klein-") as tmp:
        work = Path(tmp)
        prompt_file = work / "prompt.json"
        prompt_file.write_text(json.dumps({"prompt": prompt}), encoding="utf-8")
        refs = _materialize_images(images_raw, work)
        out = work / "out.png"
        command = build_command(
            prompt_file=prompt_file,
            out=out,
            images=refs,
            aspect_ratio=aspect,
            seed=seed,
        )
        with _LOCK:
            completed = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=GENERATE_TIMEOUT_S,
            )
        if completed.returncode != 0 or not out.is_file():
            detail = (completed.stderr or completed.stdout or "flux-klein failed").strip()
            raise RuntimeError(detail[-2000:])
        return out.read_bytes()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f"[flux-klein] {self.address_string()} {fmt % args}")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/health":
            self._json(200, {"ok": True, "preset": PRESET, "model_dir": MODEL_DIR})
            return
        self._json(404, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/v1/flux-3-image-klein":
            self._json(404, {"error": "Not found"})
            return
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
            if not isinstance(payload, dict):
                raise RuntimeError("JSON body must be an object.")
            image = render(payload)
        except Exception as exc:
            self._json(500, {"error": str(exc)})
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(image)))
        self.end_headers()
        self.wfile.write(image)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"FLUX 3 Image Klein sidecar on http://{HOST}:{PORT} preset={PRESET}")
    server.serve_forever()


if __name__ == "__main__":
    main()
