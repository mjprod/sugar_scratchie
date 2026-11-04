from __future__ import annotations

import base64
import io
import uuid

from PIL import Image

from backend.services.model_gallery import add_gallery_image, delete_gallery_image, list_gallery


def _png_data_uri() -> str:
    buf = io.BytesIO()
    Image.new("RGB", (32, 48), (180, 40, 60)).save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def test_gallery_saves_png_dedupes_and_deletes(tmp_path):
    root = tmp_path
    models = root / "public" / "models"
    src = _png_data_uri()

    saved = add_gallery_image(models_dir=models, model_id="anna", src=src, prompt="  red   dress  ")
    assert saved["created"] is True
    assert saved["prompt"] == "red dress"
    assert saved["path"] == f"public/models/anna/gallery/{saved['id']}.png"
    assert saved["url"] == f"/models/anna/gallery/{saved['id']}.png"
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
        assert (models / model_id / "gallery" / f"{body['id']}.png").is_file()

        listed = client.get(f"/api/models/{model_id}/gallery")
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()["images"]] == [body["id"]]

        removed = client.delete(
            f"/api/models/{model_id}/gallery/{body['id']}",
            headers=dashboard_headers,
        )
        assert removed.status_code == 200
        assert client.get(f"/api/models/{model_id}/gallery").json()["images"] == []
    finally:
        client.delete(f"/api/models/{model_id}", headers=dashboard_headers)
