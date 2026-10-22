"""S3 media URLs and client config. No live bucket calls."""

from __future__ import annotations

from unittest.mock import patch

from backend.cards import public_url, versioned_public_url
from backend.storage import client, client_kwargs, local_media_rel


def test_public_url_stays_relative_when_storage_is_off(monkeypatch) -> None:
    monkeypatch.setenv("S3_BUCKET", "")
    monkeypatch.setenv("S3_PUBLIC_BASE_URL", "")
    assert public_url("public/cards/demo/trailer.mp4") == "/cards/demo/trailer.mp4"


def test_public_url_uses_public_base_when_storage_is_on(monkeypatch) -> None:
    monkeypatch.setenv("S3_BUCKET", "sugar-scratch-staging")
    monkeypatch.setenv(
        "S3_PUBLIC_BASE_URL",
        "http://172.16.2.22:9000/sugar-scratch-staging/",
    )
    assert (
        public_url("cards/demo/trailer.mp4")
        == "http://172.16.2.22:9000/sugar-scratch-staging/cards/demo/trailer.mp4"
    )


def test_versioned_public_url_keeps_cache_bust_on_absolute_url(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("S3_BUCKET", "sugar-scratch-production")
    monkeypatch.setenv("S3_PUBLIC_BASE_URL", "https://media.example.com")
    media = tmp_path / "background.mp4"
    media.write_bytes(b"v")
    url = versioned_public_url(media, "cards/demo/background.mp4")
    assert url.startswith("https://media.example.com/cards/demo/background.mp4?v=")


def test_local_media_rel_strips_minio_and_aws_hosts(monkeypatch) -> None:
    monkeypatch.setenv("S3_BUCKET", "sugar-scratch-local")
    monkeypatch.setenv("S3_PUBLIC_BASE_URL", "http://172.16.2.22:9000/sugar-scratch-local")
    assert (
        local_media_rel("http://172.16.2.22:9000/sugar-scratch-local/cards/a/background.mp4?v=3")
        == "cards/a/background.mp4"
    )
    monkeypatch.setenv("S3_PUBLIC_BASE_URL", "https://media.example.com")
    assert (
        local_media_rel("https://bucket.s3.ap-southeast-2.amazonaws.com/mesh/demo.json")
        == "mesh/demo.json"
    )


def test_aws_client_omits_endpoint(monkeypatch) -> None:
    monkeypatch.setenv("S3_BUCKET", "sugar-scratch-production")
    monkeypatch.setenv("S3_ENDPOINT", "")
    monkeypatch.setenv("S3_REGION", "ap-southeast-2")
    monkeypatch.setenv("S3_ACCESS_KEY", "ak")
    monkeypatch.setenv("S3_SECRET_KEY", "sk")
    kwargs = client_kwargs()
    assert "endpoint_url" not in kwargs
    assert kwargs["region_name"] == "ap-southeast-2"
    with patch("boto3.client") as boto_client:
        client()
    assert "endpoint_url" not in boto_client.call_args.kwargs


def test_minio_client_sets_endpoint(monkeypatch) -> None:
    monkeypatch.setenv("S3_BUCKET", "sugar-scratch-local")
    monkeypatch.setenv("S3_ENDPOINT", "http://172.16.2.22:9000")
    monkeypatch.setenv("S3_REGION", "us-east-1")
    monkeypatch.setenv("S3_ACCESS_KEY", "admin")
    monkeypatch.setenv("S3_SECRET_KEY", "secret")
    kwargs = client_kwargs()
    assert kwargs["endpoint_url"] == "http://172.16.2.22:9000"
    with patch("boto3.client") as boto_client:
        client()
    assert boto_client.call_args.kwargs["endpoint_url"] == "http://172.16.2.22:9000"
