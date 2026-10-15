from __future__ import annotations

import uuid

from backend.services.ai_provider import (
    edit_image_scenery,
    edit_video,
    generate_portrait_image,
    image_to_video,
    normalize_background_video_model,
    normalize_dress_video_model,
    normalize_source_image_model,
    source_image_route,
    swap_face_on_image,
)
from backend.generation_models_store import resolve_spec


def test_generation_models_lists_builtins(client):
    response = client.get("/api/generation-models")
    assert response.status_code == 200
    body = response.json()
    labels = {(row["role"], row["label"]) for row in body["models"]}
    assert ("background_video", "x.ai Grok Imagine") in labels
    assert ("background_video", "WaveSpeed WAN 2.2 Spicy") in labels
    assert ("dress_video", "WaveSpeed ByteDance Seedance 2.0 Video Edit") in labels
    assert ("dress_video", "WaveSpeed Alibaba WAN 3.0 Video Edit") in labels
    assert ("dress_video", "WaveSpeed WAN 2.2 Video Edit") in labels
    assert ("dress_video", "x.ai Grok Imagine") in labels
    assert any(adapter["id"] == "wan_spicy_i2v" for adapter in body["adapters"])


def test_generation_model_crud_and_dispatch(client, dashboard_headers, monkeypatch, tmp_path):
    monkeypatch.setattr(
        "backend.services.provider_models.ensure_remote_model",
        lambda provider, model_id: None,
    )
    model_id = f"wan-test-{uuid.uuid4().hex[:8]}"
    created = client.post(
        "/api/generation-models",
        headers=dashboard_headers,
        json={
            "id": model_id,
            "role": "background_video",
            "label": f"WaveSpeed WAN Test {model_id}",
            "adapter": "wan_spicy_i2v",
            "endpoint_path": "/wavespeed-ai/wan-2.6-spicy/image-to-video",
        },
    )
    assert created.status_code == 200, created.text
    assert created.json()["endpoint_path"] == "/wavespeed-ai/wan-2.6-spicy/image-to-video"
    assert normalize_background_video_model(model_id) == model_id

    renamed = client.put(
        f"/api/generation-models/background_video/{model_id}",
        headers=dashboard_headers,
        json={
            "label": f"WaveSpeed WAN Test renamed {model_id}",
            "adapter": "wan_spicy_i2v",
            "endpoint_path": "/wavespeed-ai/wan-2.7-spicy/image-to-video",
            "enabled": True,
        },
    )
    assert renamed.status_code == 200, renamed.text
    spec = resolve_spec("background_video", model_id)
    assert spec.endpoint_path == "/wavespeed-ai/wan-2.7-spicy/image-to-video"
    assert spec.label == f"WaveSpeed WAN Test renamed {model_id}"

    called: dict = {}

    def fake_spicy(**kwargs):
        called.update(kwargs)

    monkeypatch.setattr("backend.services.wavespeed.image_to_video_wan_spicy", fake_spicy)
    image_to_video(
        provider="wavespeed",
        image=tmp_path / "still.png",
        prompt="locked camera",
        out=tmp_path / "out.mp4",
        model="grok-imagine-video-1.5",
        resolution="720p",
        image_field="image",
        endpoint="/v1/videos/generations",
        background_video_model=model_id,
        enhance_motion_prompt=False,
    )
    assert called["path"] == "/wavespeed-ai/wan-2.7-spicy/image-to-video"

    removed = client.delete(
        f"/api/generation-models/background_video/{model_id}",
        headers=dashboard_headers,
    )
    assert removed.status_code == 200, removed.text
    assert normalize_background_video_model(model_id) == "grok-imagine"


def test_generation_model_validation(client, dashboard_headers):
    denied = client.post(
        "/api/generation-models",
        json={
            "id": "no-auth",
            "role": "dress_video",
            "label": "No auth",
            "adapter": "prompt_video_edit",
            "endpoint_path": "/wavespeed-ai/wan-2.2/video-edit",
        },
    )
    assert denied.status_code == 401

    missing_path = client.post(
        "/api/generation-models",
        headers=dashboard_headers,
        json={
            "id": "missing-path",
            "role": "dress_video",
            "label": "Missing path",
            "adapter": "prompt_video_edit",
        },
    )
    assert missing_path.status_code == 400

    wrong_style = client.post(
        "/api/generation-models",
        headers=dashboard_headers,
        json={
            "id": "wrong-style",
            "role": "dress_video",
            "label": "Wrong style",
            "adapter": "wan_spicy_i2v",
            "endpoint_path": "/wavespeed-ai/wan-2.2-spicy/image-to-video",
        },
    )
    assert wrong_style.status_code == 400


def test_custom_dress_model_uses_seedance_payload(client, dashboard_headers, monkeypatch, tmp_path):
    monkeypatch.setattr(
        "backend.services.provider_models.ensure_remote_model",
        lambda provider, model_id: None,
    )
    model_id = f"seedance-test-{uuid.uuid4().hex[:8]}"
    created = client.post(
        "/api/generation-models",
        headers=dashboard_headers,
        json={
            "id": model_id,
            "role": "dress_video",
            "label": f"Seedance test {model_id}",
            "adapter": "reference_video_edit",
            "endpoint_path": "/bytedance/seedance-2.0-fast/video-edit",
            "reference_token": "@Image 1",
            "variant": "seedance",
        },
    )
    assert created.status_code == 200, created.text
    assert normalize_dress_video_model(model_id) == model_id

    called: dict = {}

    def fake_seedance(**kwargs):
        called.update(kwargs)

    monkeypatch.setattr("backend.services.wavespeed.edit_video_seedance2", fake_seedance)
    edit_video(
        provider="wavespeed",
        video=tmp_path / "in.mp4",
        prompt="red dress",
        out=tmp_path / "out.mp4",
        model="grok-imagine-video",
        resolution="720p",
        video_field="video",
        enhance=False,
        prepare_compatible=False,
        dress_video_model=model_id,
        reference_image="outfit.png",
    )
    assert called["path"] == "/bytedance/seedance-2.0-fast/video-edit"
    assert "@Image 1" in called["prompt"]

    client.delete(
        f"/api/generation-models/dress_video/{model_id}",
        headers=dashboard_headers,
    )


def test_builtin_xai_edit_skips_live_check(client, dashboard_headers, monkeypatch):
    def boom(provider, model_id):
        raise AssertionError(f"live check {provider} {model_id}")

    monkeypatch.setattr("backend.services.provider_models.ensure_remote_model", boom)
    response = client.put(
        "/api/generation-models/background_video/grok-imagine",
        headers=dashboard_headers,
        json={
            "label": "x.ai Grok Imagine",
            "adapter": "grok_i2v",
            "endpoint_path": "",
            "enabled": True,
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["endpoint_path"] == ""


def test_unknown_provider_model_is_rejected(client, dashboard_headers, monkeypatch):
    from backend.services.provider_models import RemoteModel

    catalog = [
        RemoteModel(
            provider="wavespeed",
            model_id="/wavespeed-ai/wan-2.2/video-edit",
            name="WAN 2.2 Video Edit",
            kind="video-edit",
            suggested_role="dress_video",
            suggested_adapter="prompt_video_edit",
        )
    ]
    monkeypatch.setattr("backend.services.provider_models._cached", lambda provider: catalog)

    missing = client.post(
        "/api/generation-models",
        headers=dashboard_headers,
        json={
            "id": f"missing-{uuid.uuid4().hex[:8]}",
            "role": "dress_video",
            "label": f"Missing {uuid.uuid4().hex[:6]}",
            "adapter": "prompt_video_edit",
            "endpoint_path": "/wavespeed-ai/does-not-exist/video-edit",
        },
    )
    assert missing.status_code == 400
    assert "not on your WaveSpeed key" in missing.json()["detail"]

    model_id = f"listed-{uuid.uuid4().hex[:8]}"
    found = client.post(
        "/api/generation-models",
        headers=dashboard_headers,
        json={
            "id": model_id,
            "role": "dress_video",
            "label": f"Listed {model_id}",
            "adapter": "prompt_video_edit",
            "endpoint_path": "/wavespeed-ai/wan-2.2/video-edit",
        },
    )
    assert found.status_code == 200, found.text
    client.delete(
        f"/api/generation-models/dress_video/{model_id}",
        headers=dashboard_headers,
    )


def test_lookup_suggests_role_and_requires_operator(client, dashboard_headers, monkeypatch):
    from backend.services.provider_models import RemoteModel, _suggest_wavespeed, _suggest_xai, _wavespeed_path

    assert _wavespeed_path(
        {
            "model_id": "alibaba/wan-2.7/video-edit",
            "api_schema": {"api_schemas": [{"api_path": "/api/v3/alibaba/wan-2.7/video-edit"}]},
        }
    ) == "/alibaba/wan-2.7/video-edit"
    assert _suggest_wavespeed("/bytedance/seedance-2.0/video-edit", "video-edit") == (
        "dress_video",
        "reference_video_edit",
        "seedance",
        "@Image 1",
    )
    assert _suggest_wavespeed("/alibaba/wan-2.7/video-edit", "")[2:] == ("wan30", "Image 1")
    assert _suggest_wavespeed("/wavespeed-ai/wan-2.2-spicy/image-to-video", "")[:2] == (
        "background_video",
        "wan_spicy_i2v",
    )
    assert _suggest_xai(
        "grok-imagine-video",
        {"output_modalities": ["video"], "input_modalities": ["image"]},
    ) == ("background_video", "grok_i2v")
    assert _suggest_xai(
        "grok-imagine-video",
        {"output_modalities": ["video"], "input_modalities": ["video"]},
    ) == ("dress_video", "grok_video_edit")

    denied = client.post("/api/generation-models/lookup", json={"provider": "wavespeed", "query": "wan"})
    assert denied.status_code == 401

    monkeypatch.setattr(
        "backend.services.provider_models._cached",
        lambda provider: [
            RemoteModel(
                provider="wavespeed",
                model_id="/bytedance/seedance-2.0/video-edit",
                name="Seedance 2.0 Video Edit",
                kind="video-edit",
                suggested_role="dress_video",
                suggested_adapter="reference_video_edit",
                variant="seedance",
                reference_token="@Image 1",
            )
        ],
    )
    listed = client.post(
        "/api/generation-models/lookup",
        headers=dashboard_headers,
        json={"provider": "wavespeed", "query": "seedance"},
    )
    assert listed.status_code == 200, listed.text
    row = listed.json()["models"][0]
    assert row["model_id"] == "/bytedance/seedance-2.0/video-edit"
    assert row["suggested_adapter"] == "reference_video_edit"
    assert row["reference_token"] == "@Image 1"

    checked = client.post(
        "/api/generation-models/check",
        headers=dashboard_headers,
        json={"provider": "wavespeed", "model_id": "bytedance/seedance-2.0/video-edit"},
    )
    assert checked.status_code == 200, checked.text
    assert checked.json()["model_id"] == "/bytedance/seedance-2.0/video-edit"


def test_new_xai_model_requires_a_listed_id(client, dashboard_headers, monkeypatch, tmp_path):
    empty = client.post(
        "/api/generation-models",
        headers=dashboard_headers,
        json={
            "id": f"grok-empty-{uuid.uuid4().hex[:8]}",
            "role": "background_video",
            "label": f"Empty Grok {uuid.uuid4().hex[:6]}",
            "adapter": "grok_i2v",
            "endpoint_path": "",
        },
    )
    assert empty.status_code == 400

    from backend.services.provider_models import RemoteModel

    monkeypatch.setattr(
        "backend.services.provider_models._cached",
        lambda provider: [
            RemoteModel(
                provider="xai",
                model_id="grok-imagine-video-9",
                name="grok-imagine-video-9",
                kind="video",
                suggested_role="background_video",
                suggested_adapter="grok_i2v",
            )
        ],
    )
    model_id = f"grok-custom-{uuid.uuid4().hex[:8]}"
    created = client.post(
        "/api/generation-models",
        headers=dashboard_headers,
        json={
            "id": model_id,
            "role": "background_video",
            "label": f"Grok custom {model_id}",
            "adapter": "grok_i2v",
            "endpoint_path": "grok-imagine-video-9",
        },
    )
    assert created.status_code == 200, created.text

    called: dict = {}

    def fake_i2v(**kwargs):
        called.update(kwargs)

    monkeypatch.setattr("backend.services.grok.image_to_video", fake_i2v)
    image_to_video(
        provider="xai",
        image=tmp_path / "still.png",
        prompt="locked camera",
        out=tmp_path / "out.mp4",
        model="grok-imagine-video-1.5",
        resolution="720p",
        image_field="image",
        endpoint="/v1/videos/generations",
        background_video_model=model_id,
        enhance_motion_prompt=False,
    )
    assert called["model"] == "grok-imagine-video-9"

    cleared = client.put(
        f"/api/generation-models/background_video/{model_id}",
        headers=dashboard_headers,
        json={
            "label": f"Grok custom {model_id}",
            "adapter": "grok_i2v",
            "endpoint_path": "",
            "enabled": True,
        },
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["endpoint_path"] == ""

    called.clear()
    image_to_video(
        provider="xai",
        image=tmp_path / "still.png",
        prompt="locked camera",
        out=tmp_path / "out.mp4",
        model="grok-imagine-video-1.5",
        resolution="720p",
        image_field="image",
        endpoint="/v1/videos/generations",
        background_video_model=model_id,
        enhance_motion_prompt=False,
    )
    assert called["model"] == "grok-imagine-video-1.5"
    client.delete(
        f"/api/generation-models/background_video/{model_id}",
        headers=dashboard_headers,
    )


def test_xai_provider_routes_stills_off_leftover_seedream(monkeypatch, tmp_path):
    assert source_image_route("xai", "seedream-v5-lite") == "xai"
    assert source_image_route("xai", "grok-imagine") == "xai"
    assert source_image_route("wavespeed", "seedream-v5-lite") == "seedream-v5-lite"
    assert source_image_route("wavespeed", "grok-imagine") == "wavespeed"

    def refuse_seedream(**kwargs):
        raise AssertionError(f"seedream still used: {kwargs.get('out')}")

    calls: list[str] = []

    def record(name):
        def fake(**kwargs):
            calls.append(name)
            return kwargs.get("out")

        return fake

    monkeypatch.setattr("backend.services.wavespeed.generate_portrait_image_seedream", refuse_seedream)
    monkeypatch.setattr("backend.services.wavespeed.swap_face_on_image_seedream", refuse_seedream)
    monkeypatch.setattr("backend.services.wavespeed.edit_image_scenery_seedream", refuse_seedream)
    monkeypatch.setattr("backend.services.grok.generate_portrait_image", record("portrait"))
    monkeypatch.setattr("backend.services.grok.swap_face_on_image", record("face"))
    monkeypatch.setattr("backend.services.grok.edit_image_scenery", record("scenery"))

    out = tmp_path / "out.png"
    generate_portrait_image(
        provider="xai",
        image_model="seedream-v5-lite",
        prompt="portrait",
        out=out,
    )
    swap_face_on_image(
        provider="xai",
        image_model="seedream-v5-lite",
        base_image=tmp_path / "base.png",
        face_image=tmp_path / "face.png",
        out=out,
    )
    edit_image_scenery(
        provider="xai",
        image_model="seedream-v5-lite",
        image=tmp_path / "still.png",
        theme="beach",
        out=out,
    )
    assert calls == ["portrait", "face", "scenery"]


def test_disabled_seedream_is_remapped(monkeypatch):
    assert normalize_source_image_model("seedream-v5-lite") == "seedream-v5-lite"
    assert normalize_source_image_model("seedream-v5.0-lite") == "seedream-v5-lite"
    assert normalize_source_image_model("grok-imagine", provider="seedream-v5-lite") == "seedream-v5-lite"
    assert normalize_source_image_model("", provider="seedream-v5.0-lite") == "seedream-v5-lite"

    monkeypatch.setattr(
        "backend.generation_models_store.enabled_ids",
        lambda role: {"grok-imagine"} if role == "source_image" else set(),
    )
    assert normalize_source_image_model("seedream-v5-lite") == "grok-imagine"
    assert normalize_source_image_model("seedream-v5.0-lite") == "grok-imagine"
    assert normalize_source_image_model("grok-imagine", provider="seedream-v5-lite") == "grok-imagine"
    assert normalize_source_image_model("", provider="seedream-v5.0-lite") == "grok-imagine"
    assert normalize_source_image_model("grok-imagine") == "grok-imagine"
