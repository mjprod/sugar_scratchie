from __future__ import annotations

import base64
import io
import json
import uuid

from PIL import Image

import pytest
from fastapi import HTTPException

from backend.services.model_gallery import add_gallery_image, delete_gallery_image, list_gallery


def _png_data_uri(color: tuple[int, int, int] = (180, 40, 60)) -> str:
    buf = io.BytesIO()
    Image.new("RGB", (32, 48), color).save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def test_gallery_saves_png_dedupes_and_deletes(tmp_path):
    root = tmp_path
    models = root / "public" / "models"
    src = _png_data_uri()

    saved = add_gallery_image(models_dir=models, model_id="anna", src=src, prompt="  red   dress  ")
    assert saved["created"] is True
    assert saved["prompt"] == "red dress"
    assert saved["kind"] == ""
    assert saved["theme"] == ""
    assert saved["path"] == f"public/models/anna/gallery/{saved['id']}.png"
    assert saved["url"] == f"/api/models/anna/gallery/{saved['id']}.png"
    file = root / saved["path"]
    assert file.is_file()
    with Image.open(file) as image:
        assert image.format == "PNG"
        assert image.size == (32, 48)

    again = add_gallery_image(models_dir=models, model_id="anna", src=src, prompt="red dress")
    assert again["created"] is False
    assert again["id"] == saved["id"]
    assert len(list_gallery(models, "anna")) == 1

    delete_gallery_image(models_dir=models, model_id="anna", image_id=saved["id"])
    assert list_gallery(models, "anna") == []
    assert not file.exists()


def test_gallery_splits_bikini_and_cosplay_and_reads_old_prompts(tmp_path):
    models = tmp_path / "public" / "models"
    bikini = add_gallery_image(
        models_dir=models,
        model_id="anna",
        src=_png_data_uri((20, 80, 180)),
        prompt="Bikini · red",
        kind="Bikini",
    )
    assert bikini["kind"] == "bikini"
    assert bikini["theme"] == ""

    cosplay = add_gallery_image(
        models_dir=models,
        model_id="anna",
        src=_png_data_uri((20, 140, 40)),
        prompt="Cosplay · Police",
        kind="cosplay",
        theme="Police",
    )
    assert cosplay["kind"] == "cosplay"
    assert cosplay["theme"] == "police"

    with pytest.raises(HTTPException):
        add_gallery_image(
            models_dir=models,
            model_id="anna",
            src=_png_data_uri((1, 2, 3)),
            kind="dress",
        )

    folder = models / "anna" / "gallery"
    legacy_id = "abc123abc123"
    Image.new("RGB", (8, 8), (9, 9, 9)).save(folder / f"{legacy_id}.png", format="PNG")
    index = folder / "index.json"
    rows = json.loads(index.read_text(encoding="utf-8"))
    rows["images"].append({"id": legacy_id, "prompt": "Cosplay · old", "created_at": 1, "sha256": "x"})
    index.write_text(json.dumps(rows), encoding="utf-8")

    listed = {row["id"]: row for row in list_gallery(models, "anna")}
    assert listed[bikini["id"]]["kind"] == "bikini"
    assert listed[cosplay["id"]]["theme"] == "police"
    assert listed[legacy_id]["kind"] == "cosplay"
    assert listed[legacy_id]["theme"] == ""


def test_gallery_api_requires_operator_and_a_real_model(client, dashboard_headers, monkeypatch, tmp_path):
    import backend.app as app_module

    models = tmp_path / "public" / "models"
    monkeypatch.setattr(app_module, "MODELS_DIR", models)

    model_id = f"g{uuid.uuid4().hex[:8]}"
    created = client.post(
        "/api/models",
        json={"id": model_id, "label": model_id},
        headers=dashboard_headers,
    )
    assert created.status_code == 200
    try:
        denied = client.post(
            f"/api/models/{model_id}/gallery",
            json={"src": _png_data_uri(), "prompt": "beach"},
        )
        assert denied.status_code == 401

        added = client.post(
            f"/api/models/{model_id}/gallery",
            json={"src": _png_data_uri(), "prompt": "beach"},
            headers=dashboard_headers,
        )
        assert added.status_code == 200
        body = added.json()
        assert body["created"] is True
        assert body["kind"] == ""
        assert body["theme"] == ""
        assert (models / model_id / "gallery" / f"{body['id']}.png").is_file()

        listed = client.get(f"/api/models/{model_id}/gallery")
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()["images"]] == [body["id"]]
        assert listed.json()["images"][0]["url"] == f"/api/models/{model_id}/gallery/{body['id']}.png"

        image = client.get(listed.json()["images"][0]["url"])
        assert image.status_code == 200
        assert image.headers["content-type"].startswith("image/png")
        assert image.content[:8] == b"\x89PNG\r\n\x1a\n"
        missing = client.get(f"/api/models/{model_id}/gallery/abc123abc123.png")
        assert missing.status_code == 404

        removed = client.delete(
            f"/api/models/{model_id}/gallery/{body['id']}",
            headers=dashboard_headers,
        )
        assert removed.status_code == 200
        assert client.get(f"/api/models/{model_id}/gallery").json()["images"] == []
    finally:
        client.delete(f"/api/models/{model_id}", headers=dashboard_headers)
