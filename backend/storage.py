"""S3-compatible media storage.

Local and staging set ``S3_ENDPOINT`` (MinIO). Production leaves it empty so
boto3 talks to AWS. Object keys match site paths (``cards/<id>/background.mp4``).
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

PUBLIC_ROOT = Path(__file__).resolve().parents[1] / "public"

# First path segment of a published file under public/.
MEDIA_ROOTS = (
    "cards",
    "mesh",
    "models",
    "themes",
    "photo-scratch",
    "lotties",
    "sounds",
    "symbols",
    "scratch",
    "cursor-fx",
    "guides",
    "flags",
)

CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".mp3": "audio/mpeg",
    ".lottie": "application/zip",
}


def enabled() -> bool:
    return bool(os.environ.get("S3_BUCKET", "").strip())


def bucket() -> str:
    return os.environ.get("S3_BUCKET", "").strip()


def public_base() -> str:
    return os.environ.get("S3_PUBLIC_BASE_URL", "").strip().rstrip("/")


def client_kwargs() -> dict[str, str]:
    """boto3 client kwargs. ``endpoint_url`` is set only for MinIO."""
    region = os.environ.get("S3_REGION", "").strip() or "us-east-1"
    kwargs = {
        "aws_access_key_id": os.environ.get("S3_ACCESS_KEY", "").strip(),
        "aws_secret_access_key": os.environ.get("S3_SECRET_KEY", "").strip(),
        "region_name": region,
    }
    endpoint = os.environ.get("S3_ENDPOINT", "").strip()
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    return kwargs


def client():
    import boto3
    from botocore.config import Config

    kwargs: dict = client_kwargs()
    if kwargs.get("endpoint_url"):
        kwargs["config"] = Config(s3={"addressing_style": "path"})
    return boto3.client("s3", **kwargs)


def content_type_for(key: str) -> str | None:
    return CONTENT_TYPES.get(Path(key).suffix.lower())


def object_key(path: Path) -> str | None:
    """Site key for a file under ``public/``, or None for work-dir paths."""
    try:
        relative = path.resolve().relative_to(PUBLIC_ROOT.resolve())
    except ValueError:
        return None
    key = relative.as_posix()
    if not key or key == ".":
        return None
    return key


def public_media_url(key: str, suffix: str = "") -> str:
    """Browser URL for an object key. Relative when storage is off."""
    cleaned = key.strip().lstrip("/")
    if enabled() and public_base():
        return f"{public_base()}/{cleaned}{suffix}"
    return f"/{cleaned}{suffix}"


def local_media_rel(src: str) -> str:
    """Turn a site path or absolute media URL into a ``public/``-relative key."""
    raw = src.strip()
    base = public_base()
    if base and raw.startswith(base):
        raw = raw[len(base) :]
    elif raw.startswith(("http://", "https://")):
        raw = urlparse(raw).path
    raw = raw.split("?", 1)[0].split("#", 1)[0].strip().lstrip("/")
    if raw.startswith("public/"):
        raw = raw[len("public/") :]
    for root_name in MEDIA_ROOTS:
        marker = f"{root_name}/"
        if raw == root_name or raw.startswith(marker):
            return raw
        index = raw.find(f"/{marker}")
        if index >= 0:
            return raw[index + 1 :]
    return raw


def put_file(key: str, path: Path, content_type: str | None = None) -> None:
    if not enabled():
        return
    extra: dict[str, str] = {}
    ctype = content_type or content_type_for(key)
    if ctype:
        extra["ContentType"] = ctype
    client().upload_file(
        str(path),
        bucket(),
        key.lstrip("/"),
        ExtraArgs=extra or None,
    )


def publish_file(path: Path) -> None:
    """Upload a finished file that lives under ``public/``."""
    if not enabled() or not path.is_file():
        return
    key = object_key(path)
    if key:
        put_file(key, path)


def delete_prefix(key: str) -> None:
    """Delete one object, or every object under a prefix that ends with ``/``."""
    if not enabled():
        return
    key = key.strip().lstrip("/")
    if not key:
        return
    s3 = client()
    name = bucket()
    if not key.endswith("/"):
        s3.delete_object(Bucket=name, Key=key)
        return
    token: str | None = None
    while True:
        page_kwargs: dict = {"Bucket": name, "Prefix": key}
        if token:
            page_kwargs["ContinuationToken"] = token
        page = s3.list_objects_v2(**page_kwargs)
        objects = [{"Key": item["Key"]} for item in page.get("Contents", [])]
        if objects:
            s3.delete_objects(Bucket=name, Delete={"Objects": objects})
        if not page.get("IsTruncated"):
            return
        token = page.get("NextContinuationToken")


def delete_public(path: Path) -> None:
    """Delete the object for a file, or every object under a directory."""
    key = object_key(path)
    if not key:
        return
    if path.is_dir():
        delete_prefix(key.rstrip("/") + "/")
    else:
        delete_prefix(key)
