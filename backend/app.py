from __future__ import annotations

import os
import re
import shutil
import sys
import threading
import time
import uuid
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass, field
from io import TextIOBase
from pathlib import Path
from typing import Annotated, Callable, Literal
from urllib.parse import unquote

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.db.engine import get_engine, get_session, ping_db
from backend.auth.operator import OperatorAuthMiddleware
from backend.logging_config import configure_logging
from backend.middleware.request_timing import RequestTimingMiddleware
from backend.routers import auth as auth_router
from backend.routers import collection as collection_router
from backend.routers import inbox as inbox_router
from backend.routers import me as me_router
from backend.routers import packs as packs_router
from backend.routers import rewards as rewards_router
from backend.routers import store as store_router
from backend.routers import wallet as wallet_router

from backend.cards_store import (
    ensure_cards_bootstrapped,
    create_card,
    delete_card,
    delete_card_photo,
    delete_card_trailer,
    list_cards,
    reorder_model_cards,
    update_card,
    upload_card_photo,
    upload_card_trailer,
)
from backend.cards import (
    CardInfo,
    CreateCardRequest,
    PhotoInfo,
    PhotoScratchSlot,
    ReorderCardsRequest,
    UpdateCardRequest,
    approve_photo_scratch_bg,
    approve_photo_scratch_layer,
    compress_card,
    delete_photo_scratch_layer,
    list_photo_scratch_slots,
    confirm_photo_scratch_slot_adjust,
    cutout_photo_scratch_slot,
    generate_photo_scratch_slot_mesh,
    match_photo_scratch_slot,
    publish_photo_scratch_game,
    read_photo_scratch_slot_symbols,
    reject_photo_scratch_bg,
    reject_photo_scratch_layer,
    set_photo_scratch_slot_prompt,
    upload_photo_scratch_layer,
    write_photo_scratch_slot_symbols,
    zoom_photo_scratch_slot,
)
from backend.collection import build_collection_catalog
from backend.models_store import (
    CreateModelRequest,
    ModelInfo,
    UpdateModelRequest,
    create_model,
    delete_model,
    delete_model_flag_svg,
    delete_model_theme_avatar,
    ensure_models_bootstrapped,
    list_models,
    model_exists,
    update_model,
    upload_model_avatar,
    upload_model_flag_svg,
    upload_model_swipe_poster,
    upload_model_theme_avatar,
    upload_model_video,
)
from backend.themes_store import (
    CreateThemeRequest,
    ReorderThemesRequest,
    UpdateThemeRequest,
    create_theme,
    delete_theme,
    delete_theme_intro,
    ensure_themes_bootstrapped,
    list_themes,
    reorder_themes,
    update_theme,
    upload_theme_intro,
)
from backend.photo_scratch_store import ensure_photo_scratch_bootstrapped, list_photo_scratch_cards
from backend.symbols_store import (
    CreateSymbolGroupRequest,
    RewriteSymbolJsonRequest,
    UpdateSymbolGroupRequest,
    UpdateSymbolRequest,
    create_symbol_group,
    delete_symbol_group,
    ensure_symbols_bootstrapped,
    list_symbol_groups,
    list_symbols,
    read_symbol_json,
    rewrite_symbol_json,
    set_default_symbol_group,
    update_symbol,
    update_symbol_group,
    upload_symbol_lottie,
)
from backend.services.ai_provider import AiProvider, BackgroundVideoModel, DressVideoModel, SourceImageModel
from backend.services.grok import edit_video, image_dress_flow as run_image_dress_flow, image_to_video as run_image_to_video
from backend.services.garment_mask import generate_garment_mask as run_generate_garment_mask
from backend.services.mesh_symbols import (
    SYMBOL_POINT_COUNT,
    read_symbol_points,
    write_symbol_points,
)
from backend.services.mesh_tracking import default_mesh_device, generate_mesh as run_generate_mesh
from backend.services.mesh_tune import MeshTuneOptions, build_mesh_tracking_env, mesh_tune_from_dict
from backend.services.video_flow import (
    VideoFlowStep,
    STEP_ORDER,
    apply_trim_step,
    approve_flow_step,
    flow_state,
    import_manual_clips,
    list_flows,
    patch_flow_draft_model,
    read_flow_draft,
    reject_flow_step,
    reset_trim_step,
    run_generate_photo_scratch_backgrounds,
    run_generate_photo_scratch_layer,
    run_generate_source_image,
    run_mesh_candidate_generation,
    run_video_flow_step,
    save_flow_draft,
    trim_step_info,
    validate_step_enqueue,
    video_flow as run_video_flow,
)


ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
CARDS_DIR = PUBLIC / "cards"
MESH_DIR = PUBLIC / "mesh"
MODELS_DIR = PUBLIC / "models"
THEMES_DIR = PUBLIC / "themes"
LOTTIES_DIR = PUBLIC / "lotties"
UPLOADS_DIR = ROOT / ".tmp" / "uploads"
PYTHON = ROOT / ".venv" / "bin" / "python"
PYTHON_CMD = str(PYTHON if PYTHON.exists() else Path(sys.executable))


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line.removeprefix("export ").strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or key in os.environ:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        os.environ[key] = value


load_env_file(ROOT / ".env")
load_env_file(ROOT / "backend" / ".env")


def now() -> float:
    return round(time.time(), 3)


def workspace_path(value: str, *, must_exist: bool = False) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = ROOT / path
    resolved = path.resolve()
    if ROOT not in resolved.parents and resolved != ROOT:
        raise HTTPException(status_code=400, detail=f"Path is outside the project: {value}")
    if must_exist and not resolved.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {value}")
    return resolved


def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


class MeshInfo(BaseModel):
    file: str
    path: str
    source: str | None = None
    tracker: str | None = None
    generator: str | None = None
    frames: int | None = None
    cols: int | None = None
    rows: int | None = None
    size_bytes: int
    modified_at: float


class GenerateMeshRequest(BaseModel):
    input_video: str
    output_json: str
    tracker: Literal["cotracker", "bootstapir", "blend"] = "bootstapir"
    debug_overlay: bool = False
    compare_trackers: bool = False
    fps: float | None = Field(default=None, gt=0)
    grid_cols: int | None = Field(default=None, ge=2)
    grid_rows: int | None = Field(default=None, ge=2)
    loop_close: float | None = Field(default=None, ge=0)
    extra_driver_points: int | None = Field(default=None, ge=0)


class GrokEditRequest(BaseModel):
    video: str
    prompt: str = Field(min_length=1)
    out: str
    enhance: bool = False
    prepare_compatible: bool = True
    model: str = "grok-imagine-video"
    resolution: str = "720p"
    video_field: str = "video"


class ImageToVideoRequest(BaseModel):
    image: str
    prompt: str = Field(min_length=1)
    out: str = ".tmp/image-to-video.mp4"
    model: str = "grok-imagine-video-1.5"
    resolution: str = "720p"
    image_field: str = "image"
    endpoint: str = "/v1/videos/generations"


class ImageDressFlowRequest(BaseModel):
    image: str
    motion_prompt: str = Field(min_length=1)
    dress_prompt: str = Field(min_length=1)
    base_video_out: str = ".tmp/image-video-base.mp4"
    out: str = ".tmp/image-dress-video.mp4"
    enhance_dress_prompt: bool = True
    model: str = "grok-imagine-video-1.5"
    resolution: str = "720p"
    image_field: str = "image"
    video_field: str = "video"
    endpoint: str = "/v1/videos/generations"


class VideoFlowRequest(BaseModel):
    image: str = ""
    theme: str = ""
    background_motion_prompt: str = Field(min_length=1)
    foreground_motion_prompt: str = ""
    dress_prompt: str = Field(min_length=1)
    dress_reference_image: str = ""
    card_id: str = Field(min_length=1, max_length=64)
    card_label: str = Field(min_length=1, max_length=120)
    model_id: str = ""
    resolution: str = "720p"
    enhance_dress_prompt: bool = True
    tracker: Literal["cotracker", "bootstapir", "blend", "all"] = "all"
    write_webm: bool = False
    compress_preset: Literal["mobile", "hd", "master"] = "mobile"
    mesh_tune: MeshTuneOptions = Field(default_factory=MeshTuneOptions)
    model: str = "grok-imagine-video-1.5"
    image_field: str = "image"
    video_field: str = "video"
    endpoint: str = "/v1/videos/generations"
    source_mode: Literal["upload", "prompt", "face_swap"] = "upload"
    source_prompt: str = ""
    face_image: str = ""
    base_image: str = ""
    provider: AiProvider = "xai"
    image_model: SourceImageModel = "grok-imagine"
    background_video_model: BackgroundVideoModel = "grok-imagine"
    dress_video_model: DressVideoModel = "wan-2.2-video-edit"


class GenerateSourceImageRequest(BaseModel):
    mode: Literal["prompt", "face_swap"]
    card_id: str = Field(min_length=1, max_length=64)
    prompt: str = ""
    face_image: str = ""
    base_image: str = ""
    aspect_ratio: str = "9:16"
    provider: AiProvider = "xai"
    image_model: SourceImageModel = "grok-imagine"


class VideoFlowStepRequest(VideoFlowRequest):
    step: VideoFlowStep
    force: bool = False


class VideoFlowStepAction(BaseModel):
    step: VideoFlowStep
    mesh_tracker: Literal["bootstapir", "cotracker", "blend"] | None = None


class VideoFlowTrimRequest(BaseModel):
    drop_start: int | None = Field(default=None, ge=0, le=60)
    drop_end: int | None = Field(default=None, ge=0, le=60)
    auto: bool = False


class VideoFlowImportClipsRequest(BaseModel):
    background: str = Field(min_length=1)
    foreground: str = Field(min_length=1)
    card_label: str = Field(min_length=1, max_length=120)
    model_id: str = ""


class MeshCandidateRequest(BaseModel):
    card_id: str = Field(min_length=1, max_length=64)
    card_label: str = Field(min_length=1, max_length=120)
    tracker: Literal["bootstapir", "cotracker", "blend"]
    mesh_tune: MeshTuneOptions = Field(default_factory=MeshTuneOptions)
    force: bool = False


class SymbolPointInput(BaseModel):
    u: float = Field(ge=0, le=1)
    v: float = Field(ge=0, le=1)


class SymbolPointsRequest(BaseModel):
    points: list[SymbolPointInput] = Field(min_length=SYMBOL_POINT_COUNT, max_length=SYMBOL_POINT_COUNT)


class CompressCardRequest(BaseModel):
    write_webm: bool = False
    compress_preset: Literal["mobile", "hd", "master"] = "mobile"


class UploadedFileInfo(BaseModel):
    path: str
    size_bytes: int


class SaveGarmentRequest(BaseModel):
    file: str
    garment: list[int]


class AutoGarmentMaskRequest(BaseModel):
    file: str
    union_existing: bool = False
    # Optional overrides — defaults live in garment_mask.py
    mask_source: Literal["garment", "body"] = "garment"
    threshold: float = Field(default=0.22, ge=0.05, le=0.9)
    pixel_dilate: int = Field(default=3, ge=0, le=8)
    grid_dilate: int = Field(default=3, ge=0, le=5)


def resolve_mesh_json_path(file: str) -> Path:
    """Resolve a mesh JSON for read/write — public/mesh, or work-dir compare candidates."""
    name = Path(file).name
    if not name.endswith(".json") or name == "index.json":
        raise HTTPException(status_code=400, detail=f"Invalid mesh file: {file}")

    if "/" in file.replace("\\", "/"):
        target = workspace_path(file, must_exist=True)
        if target.suffix != ".json":
            raise HTTPException(status_code=400, detail=f"Not a mesh JSON: {file}")
        return target

    published = MESH_DIR / name
    if published.exists():
        return published

    work_root = ROOT / ".tmp" / "video-flow"
    if work_root.exists():
        for work in work_root.iterdir():
            if not work.is_dir():
                continue
            candidate = work / name
            if candidate.exists():
                return candidate

    raise HTTPException(status_code=404, detail=f"Mesh not found: {name}")


@dataclass
class Job:
    id: str
    kind: str
    command: list[str]
    action: Callable[[], None]
    status: str = "queued"
    created_at: float = field(default_factory=now)
    started_at: float | None = None
    ended_at: float | None = None
    return_code: int | None = None
    logs: list[str] = field(default_factory=list)

    def public(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "command": self.command,
            "status": self.status,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "return_code": self.return_code,
            "logs": self.logs[-500:],
        }


jobs: dict[str, Job] = {}
jobs_lock = threading.Lock()


def cors_origins() -> list[str]:
    raw = os.environ.get("CORS_ORIGINS", "").strip()
    if raw:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]
    return [
        "http://localhost:5080",
        "http://127.0.0.1:5080",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "https://localhost:5173",
        "https://127.0.0.1:5173",
        "https://localhost:5080",
        "https://127.0.0.1:5080",
    ]


configure_logging()
logger = __import__("logging").getLogger("sugar.jobs")

app = FastAPI(title="Sugar Scratchie Dashboard API")
app.add_middleware(OperatorAuthMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RequestTimingMiddleware)
app.include_router(auth_router.router)
app.include_router(me_router.router)
app.include_router(wallet_router.router)
app.include_router(store_router.router)
app.include_router(packs_router.router)
app.include_router(collection_router.router)
app.include_router(rewards_router.router)
app.include_router(inbox_router.router)


@app.on_event("startup")
def ensure_indexes() -> None:
    # Catalog metadata lives in Postgres; seed from on-disk legacy files if empty.
    import backend.db.engine as db_engine

    db_engine.get_engine()
    assert db_engine.SessionLocal is not None
    session = db_engine.SessionLocal()
    try:
        ensure_themes_bootstrapped(session, THEMES_DIR)
        ensure_models_bootstrapped(session, MODELS_DIR)
        ensure_cards_bootstrapped(session, ROOT, CARDS_DIR, MESH_DIR)
        ensure_symbols_bootstrapped(session, LOTTIES_DIR)
        ensure_photo_scratch_bootstrapped(session, ROOT)
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


class JobLogWriter(TextIOBase):
    def __init__(self, job: Job) -> None:
        self.job = job
        self.buffer = ""

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        self.buffer += text
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            with jobs_lock:
                self.job.logs.append(line)
        return len(text)

    def flush(self) -> None:
        if self.buffer:
            with jobs_lock:
                self.job.logs.append(self.buffer)
            self.buffer = ""


def cancel_stale_video_flow_jobs(card_id: str) -> None:
    """Cancel queued/running step jobs that no longer match pipeline approvals."""
    try:
        state = flow_state(card_id)
    except Exception:
        return
    with jobs_lock:
        for job in jobs.values():
            if job.kind != "video-flow-step" or job.status not in ("queued", "running"):
                continue
            if len(job.command) < 3 or job.command[2] != card_id:
                continue
            step = job.command[1]
            if step not in STEP_ORDER:
                continue
            if state["steps"][step]["status"] == "locked":
                job.status = "cancelled"
                job.logs.append("Cancelled — earlier pipeline steps changed.")


def run_job(job: Job) -> None:
    logger.info("job %s (%s) started", job.id, job.kind)
    with jobs_lock:
        job.status = "running"
        job.started_at = now()
    writer = JobLogWriter(job)
    try:
        with redirect_stdout(writer), redirect_stderr(writer):
            job.action()
        writer.flush()
        with jobs_lock:
            job.return_code = 0
            if job.status != "cancelled":
                job.status = "succeeded"
            job.ended_at = now()
        logger.info("job %s (%s) finished with status=%s", job.id, job.kind, job.status)
    except Exception as exc:  # pragma: no cover - last-resort job reporting
        writer.flush()
        with jobs_lock:
            job.status = "failed"
            job.logs.append(f"Job runner error: {exc}")
            job.return_code = 1
            job.ended_at = now()
        logger.exception("job %s (%s) failed", job.id, job.kind)


def enqueue(kind: str, command: list[str], action: Callable[[], None]) -> Job:
    job = Job(id=uuid.uuid4().hex[:12], kind=kind, command=command, action=action)
    with jobs_lock:
        jobs[job.id] = job
    logger.info("job %s (%s) queued", job.id, kind)
    thread = threading.Thread(target=run_job, args=(job,), daemon=True)
    thread.start()
    return job


def job_stats() -> dict:
    with jobs_lock:
        by_status: dict[str, int] = {}
        for job in jobs.values():
            by_status[job.status] = by_status.get(job.status, 0) + 1
        return {"total": len(jobs), "by_status": by_status}


_MIGRATION_CACHE_TTL_S = 30.0
_migration_cache: tuple[float, dict] | None = None


def migration_at_head() -> dict:
    global _migration_cache
    now_ts = time.time()
    if _migration_cache is not None and (now_ts - _migration_cache[0]) < _MIGRATION_CACHE_TTL_S:
        return _migration_cache[1]

    try:
        from alembic.config import Config
        from alembic.runtime.migration import MigrationContext
        from alembic.script import ScriptDirectory

        cfg = Config(str(ROOT / "backend" / "alembic.ini"))
        script = ScriptDirectory.from_config(cfg)
        head = script.get_heads()
        with get_engine().connect() as conn:
            ctx = MigrationContext.configure(conn)
            current = ctx.get_current_heads()
        ok = len(head) == 1 and set(current) == set(head)
        result = {"ok": ok, "current": current, "head": head}
    except Exception as exc:
        result = {"ok": False, "error": str(exc)}

    _migration_cache = (now_ts, result)
    return result


def read_mesh_info(path: Path) -> MeshInfo:
    source = tracker = generator = None
    frames = cols = rows = None
    try:
        import json

        data = json.loads(path.read_text())
        source = data.get("source")
        tracker = data.get("tracker")
        generator = data.get("generator")
        if isinstance(data.get("frames"), list):
            frames = len(data["frames"])
        mesh = data.get("mesh") or {}
        cols = mesh.get("cols")
        rows = mesh.get("rows")
    except Exception:
        pass
    stat = path.stat()
    return MeshInfo(
        file=path.name,
        path=relative(path),
        source=source,
        tracker=tracker,
        generator=generator,
        frames=frames,
        cols=cols,
        rows=rows,
        size_bytes=stat.st_size,
        modified_at=stat.st_mtime,
    )


@app.get("/api/health/live")
def health_live() -> dict:
    return {"ok": True, "live": True}


@app.get("/api/health/ready")
def health_ready() -> dict:
    db = ping_db()
    migrations = migration_at_head()
    ok = db.get("ok") is True and migrations.get("ok") is True
    return {"ok": ok, "db": db, "migrations": migrations}


@app.get("/api/health")
def health() -> dict:
    env_files = {
        ".env": (ROOT / ".env").exists(),
        "backend/.env": (ROOT / "backend" / ".env").exists(),
    }
    db = ping_db()
    migrations = migration_at_head()
    return {
        "ok": db.get("ok") is True,
        "root": str(ROOT),
        "env_files": env_files,
        "db": db,
        "migrations": migrations,
        "jobs": job_stats(),
        "xai_key_loaded": bool(os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")),
        "wavespeed_key_loaded": bool(os.environ.get("WAVESPEED_API_KEY")),
        "ffmpeg_available": shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None,
        "python": PYTHON_CMD,
    }


@app.get("/api/assets")
def assets(db: Annotated[Session, Depends(get_session)]) -> dict:
    meshes = sorted(MESH_DIR.glob("*.json"))
    cards = list_cards(db, ROOT, CARDS_DIR, MESH_DIR)
    return {
        "cards": [card.dict() for card in cards],
        "meshes": [read_mesh_info(path).dict() for path in meshes if path.name != "index.json"],
    }


@app.get("/api/cards")
def get_cards(db: Annotated[Session, Depends(get_session)]) -> dict:
    cards = list_cards(db, ROOT, CARDS_DIR, MESH_DIR)
    return {"cards": [card.dict() for card in cards]}


@app.post("/api/cards")
def post_card(
    request: CreateCardRequest,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    card = create_card(db, ROOT, CARDS_DIR, MESH_DIR, request)
    return card.dict()


@app.put("/api/cards/{card_id}")
def put_card(
    card_id: str,
    request: UpdateCardRequest,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    card = update_card(db, ROOT, CARDS_DIR, MESH_DIR, card_id, request)
    if request.model_id is not None:
        patch_flow_draft_model(card_id, request.model_id)
    return card.dict()


@app.put("/api/models/{model_id}/cards/order")
def put_model_card_order(
    model_id: str,
    request: ReorderCardsRequest,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    cards = reorder_model_cards(db, ROOT, CARDS_DIR, MESH_DIR, model_id, request.card_ids)
    return {"cards": [card.dict() for card in cards]}


@app.delete("/api/cards/{card_id}")
def remove_card(
    card_id: str,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    delete_card(db, ROOT, CARDS_DIR, MESH_DIR, card_id)
    return {"ok": True, "id": card_id}


@app.post("/api/cards/{card_id}/photos")
async def post_card_photo(
    card_id: str,
    db: Annotated[Session, Depends(get_session)],
    file: UploadFile = File(...),
) -> dict:
    photo = await upload_card_photo(db, ROOT, CARDS_DIR, MESH_DIR, card_id, file)
    return photo.dict()


@app.delete("/api/cards/{card_id}/photos/{photo_id}")
def remove_card_photo(
    card_id: str,
    photo_id: str,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    delete_card_photo(db, ROOT, CARDS_DIR, MESH_DIR, card_id, photo_id)
    return {"ok": True, "id": photo_id}


@app.post("/api/cards/{card_id}/trailer")
async def post_card_trailer(
    card_id: str,
    db: Annotated[Session, Depends(get_session)],
    file: UploadFile = File(...),
) -> dict:
    card = await upload_card_trailer(db, ROOT, CARDS_DIR, MESH_DIR, card_id, file)
    return card.dict()


@app.delete("/api/cards/{card_id}/trailer")
def remove_card_trailer(
    card_id: str,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    card = delete_card_trailer(db, ROOT, CARDS_DIR, MESH_DIR, card_id)
    return card.dict()


@app.get("/api/photo-scratch")
def get_published_photo_scratch(db: Annotated[Session, Depends(get_session)]) -> dict:
    cards = list_photo_scratch_cards(db, ROOT)
    return {"cards": [card.dict() for card in cards]}


# ── Photo-scratch slot endpoints ──────────────────────────────────────────────

class GeneratePhotoScratchRequest(BaseModel):
    theme: str = ""
    count: int = Field(default=10, ge=1, le=10)
    provider: str = "xai"
    image_model: str = "grok-imagine"
    layer: Literal["background", "bikini", "clothes"] = "background"
    image: str = ""  # Flow source image path — required for bikini/clothes
    slot_id: str = ""  # When set, generate only this one slot (one-by-one)
    prompt: str = ""  # Optional override; empty = built-in default for the layer
    # When True (batch default), only fill slots missing approved+pending for the layer.
    fill_empty_only: bool = True


class SetSlotPromptRequest(BaseModel):
    layer: Literal["background", "bikini", "clothes"]
    prompt: str = ""


@app.get("/api/cards/{card_id}/photo-scratch")
def get_photo_scratch_slots(card_id: str, theme: str = "") -> dict:
    slots = list_photo_scratch_slots(CARDS_DIR, card_id, theme)
    return {"slots": [slot.dict() for slot in slots]}


@app.post("/api/cards/{card_id}/photo-scratch/publish-game")
def publish_photo_scratch_game_endpoint(card_id: str, slot_id: str = "") -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    if slot_id and not re.fullmatch(r"slot_\d{2}", slot_id):
        raise HTTPException(status_code=400, detail="Invalid slot_id")
    return publish_photo_scratch_game(
        ROOT,
        CARDS_DIR,
        card_id,
        MESH_DIR,
        slot_id=slot_id or None,
        themes_dir=THEMES_DIR,
    )


class PhotoScratchSymbolPointsRequest(BaseModel):
    points: list[dict[str, float]] = Field(min_length=SYMBOL_POINT_COUNT, max_length=SYMBOL_POINT_COUNT)


@app.post("/api/cards/{card_id}/photo-scratch/{slot_id}/match")
def create_photo_scratch_slot_match(
    card_id: str,
    slot_id: str,
    theme: str = "",
    relock: bool = False,
    scale: float = 1.0,
    tx: float = 0.0,
    ty: float = 0.0,
    confirm_adjust: bool = False,
) -> dict:
    """Register bikini + top on the game canvas (optional AI re-dress / manual nudge)."""
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    if not re.fullmatch(r"slot_\d{2}", slot_id):
        raise HTTPException(status_code=400, detail="Invalid slot_id")
    if scale <= 0.1 or scale > 3.0:
        raise HTTPException(status_code=400, detail="scale must be between 0.1 and 3.0")
    if abs(tx) > 500 or abs(ty) > 500:
        raise HTTPException(status_code=400, detail="tx/ty must be within ±500 px")

    def _run_match() -> None:
        match_photo_scratch_slot(
            ROOT,
            CARDS_DIR,
            card_id,
            slot_id,
            theme,
            relock=relock,
            nudge_scale=scale,
            nudge_tx=tx,
            nudge_ty=ty,
            confirm_adjust=confirm_adjust,
        )

    job = enqueue(
        "photo-scratch-match",
        ["photo-scratch-match", card_id, slot_id, "relock" if relock else "pass"],
        _run_match,
    )
    return job.public()


@app.post("/api/cards/{card_id}/photo-scratch/{slot_id}/confirm-adjust")
def confirm_photo_scratch_adjust(
    card_id: str, slot_id: str, theme: str = ""
) -> PhotoScratchSlot:
    """Mark Match alignment as good (Picture Flow Adjust step → Cutout)."""
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    if not re.fullmatch(r"slot_\d{2}", slot_id):
        raise HTTPException(status_code=400, detail="Invalid slot_id")
    return confirm_photo_scratch_slot_adjust(CARDS_DIR, card_id, slot_id, theme)


@app.post("/api/cards/{card_id}/photo-scratch/{slot_id}/cutout")
def create_photo_scratch_slot_cutout(card_id: str, slot_id: str, theme: str = "") -> dict:
    """Cut bikini + top to RGBA (girl without background) for the playable game."""
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    if not re.fullmatch(r"slot_\d{2}", slot_id):
        raise HTTPException(status_code=400, detail="Invalid slot_id")

    def _run_cutout() -> None:
        cutout_photo_scratch_slot(ROOT, CARDS_DIR, card_id, slot_id, theme)

    job = enqueue(
        "photo-scratch-cutout",
        ["photo-scratch-cutout", card_id, slot_id],
        _run_cutout,
    )
    return job.public()


@app.post("/api/cards/{card_id}/photo-scratch/{slot_id}/zoom")
def create_photo_scratch_slot_zoom(
    card_id: str,
    slot_id: str,
    theme: str = "",
    scale: float = 1.0,
    tx: float = 0.0,
    ty: float = 0.0,
    confirm: bool = False,
    apply: bool = False,
) -> PhotoScratchSlot:
    """Scale cutouts about canvas center (Picture Flow Zooming → Mesh)."""
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    if not re.fullmatch(r"slot_\d{2}", slot_id):
        raise HTTPException(status_code=400, detail="Invalid slot_id")
    if scale <= 0.1 or scale > 3.0:
        raise HTTPException(status_code=400, detail="scale must be between 0.1 and 3.0")
    if abs(tx) > 500 or abs(ty) > 500:
        raise HTTPException(status_code=400, detail="tx/ty must be within ±500 px")
    return zoom_photo_scratch_slot(
        CARDS_DIR,
        card_id,
        slot_id,
        theme,
        scale=scale,
        tx=tx,
        ty=ty,
        confirm=confirm,
        apply=apply,
    )


@app.post("/api/cards/{card_id}/photo-scratch/{slot_id}/mesh")
def create_photo_scratch_slot_mesh(card_id: str, slot_id: str, theme: str = "") -> dict:
    """Generate a static photo-scratch mesh for one slot (from TOP/bikini still)."""
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    if not re.fullmatch(r"slot_\d{2}", slot_id):
        raise HTTPException(status_code=400, detail="Invalid slot_id")
    def _run_mesh() -> None:
        generate_photo_scratch_slot_mesh(ROOT, CARDS_DIR, card_id, slot_id, theme)

    job = enqueue(
        "photo-scratch-mesh",
        ["photo-scratch-mesh", card_id, slot_id],
        _run_mesh,
    )
    return job.public()


@app.get("/api/cards/{card_id}/photo-scratch/{slot_id}/symbol-points")
def get_photo_scratch_slot_symbols(card_id: str, slot_id: str) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    if not re.fullmatch(r"slot_\d{2}", slot_id):
        raise HTTPException(status_code=400, detail="Invalid slot_id")
    points = read_photo_scratch_slot_symbols(CARDS_DIR, card_id, slot_id)
    return {
        "points": points,
        "required": SYMBOL_POINT_COUNT,
        "complete": len(points) == SYMBOL_POINT_COUNT,
    }


@app.post("/api/cards/{card_id}/photo-scratch/{slot_id}/symbol-points")
def save_photo_scratch_slot_symbols(
    card_id: str, slot_id: str, request: PhotoScratchSymbolPointsRequest
) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    if not re.fullmatch(r"slot_\d{2}", slot_id):
        raise HTTPException(status_code=400, detail="Invalid slot_id")
    slot = write_photo_scratch_slot_symbols(CARDS_DIR, card_id, slot_id, request.points)
    return slot.dict()


@app.patch("/api/cards/{card_id}/photo-scratch/{slot_id}/prompt")
def patch_photo_scratch_slot_prompt(
    card_id: str, slot_id: str, request: SetSlotPromptRequest, theme: str = ""
) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    if not re.fullmatch(r"slot_\d{2}", slot_id):
        raise HTTPException(status_code=400, detail="Invalid slot_id")
    slot = set_photo_scratch_slot_prompt(
        CARDS_DIR, card_id, slot_id, request.layer, request.prompt, theme
    )
    return slot.dict()


@app.post("/api/cards/{card_id}/photo-scratch/generate")
def generate_photo_scratch(card_id: str, request: GeneratePhotoScratchRequest) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    layer = request.layer
    source_image = request.image.strip()
    slot_id = request.slot_id.strip()
    if slot_id and not re.fullmatch(r"slot_\d{2}", slot_id):
        raise HTTPException(status_code=400, detail="Invalid slot_id")
    if layer in ("bikini", "clothes") and source_image:
        if not source_image.startswith(("http://", "https://")):
            # Validate early so the job queue doesn't silently fail.
            workspace_path(source_image, must_exist=True)
    custom_prompt = request.prompt.strip()
    job = enqueue(
        "generate-photo-scratch-layer",
        ["generate-photo-scratch-layer", card_id, layer, slot_id or "all"],
        lambda: run_generate_photo_scratch_layer(
            card_id=card_id,
            layer_type=layer,
            theme=request.theme,
            count=1 if slot_id else request.count,
            provider=request.provider,
            image_model=request.image_model,
            source_image=source_image,
            slot_id=slot_id,
            prompt=custom_prompt,
            fill_empty_only=False if slot_id else request.fill_empty_only,
        ),
    )
    return job.public()


# Static action routes MUST come before the dynamic {layer} route so FastAPI
# does not swallow "approve-layer" / "reject-layer" as a layer parameter value.
@app.post("/api/cards/{card_id}/photo-scratch/{slot_id}/approve-layer")
def approve_photo_scratch_layer_endpoint(
    card_id: str,
    slot_id: str,
    layer: Literal["background", "bikini", "clothes"] = "background",
    theme: str = "",
) -> dict:
    slot = approve_photo_scratch_layer(CARDS_DIR, card_id, slot_id, layer, theme)
    return slot.dict()


@app.post("/api/cards/{card_id}/photo-scratch/{slot_id}/reject-layer")
def reject_photo_scratch_layer_endpoint(
    card_id: str,
    slot_id: str,
    layer: Literal["background", "bikini", "clothes"] = "background",
    theme: str = "",
) -> dict:
    slot = reject_photo_scratch_layer(CARDS_DIR, card_id, slot_id, layer, theme)
    return slot.dict()


# Keep old bg endpoints as aliases for backwards compatibility.
@app.post("/api/cards/{card_id}/photo-scratch/{slot_id}/approve-bg")
def approve_photo_scratch_bg_endpoint(card_id: str, slot_id: str, theme: str = "") -> dict:
    slot = approve_photo_scratch_bg(CARDS_DIR, card_id, slot_id, theme)
    return slot.dict()


@app.post("/api/cards/{card_id}/photo-scratch/{slot_id}/reject-bg")
def reject_photo_scratch_bg_endpoint(card_id: str, slot_id: str, theme: str = "") -> dict:
    slot = reject_photo_scratch_bg(CARDS_DIR, card_id, slot_id, theme)
    return slot.dict()


@app.post("/api/cards/{card_id}/photo-scratch/{slot_id}/{layer}")
async def upload_photo_scratch_layer_endpoint(
    card_id: str,
    slot_id: str,
    layer: str,
    theme: str = "",
    file: UploadFile = File(...),
) -> dict:
    slot = await upload_photo_scratch_layer(ROOT, CARDS_DIR, card_id, slot_id, layer, file, theme)
    return slot.dict()


@app.delete("/api/cards/{card_id}/photo-scratch/{slot_id}/{layer}")
def delete_photo_scratch_layer_endpoint(
    card_id: str, slot_id: str, layer: str, theme: str = ""
) -> dict:
    slot = delete_photo_scratch_layer(CARDS_DIR, card_id, slot_id, layer, theme)
    return slot.dict()


@app.get("/api/models")
def get_models(db: Annotated[Session, Depends(get_session)]) -> dict:
    models = list_models(db, MODELS_DIR)
    return {"models": [model.dict() for model in models]}


@app.post("/api/models")
def post_model(
    request: CreateModelRequest,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    model = create_model(db, MODELS_DIR, request)
    return model.dict()


@app.put("/api/models/{model_id}")
def put_model(
    model_id: str,
    request: UpdateModelRequest,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    model = update_model(db, MODELS_DIR, model_id, request)
    return model.dict()


@app.delete("/api/models/{model_id}")
def remove_model(
    model_id: str,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    delete_model(db, ROOT, MODELS_DIR, CARDS_DIR, MESH_DIR, model_id)
    return {"ok": True, "id": model_id}


@app.post("/api/models/{model_id}/avatar")
async def post_model_avatar(
    model_id: str,
    db: Annotated[Session, Depends(get_session)],
    file: UploadFile = File(...),
) -> dict:
    model = await upload_model_avatar(db, MODELS_DIR, model_id, file)
    return model.dict()


@app.post("/api/models/{model_id}/flag")
async def post_model_flag(
    model_id: str,
    db: Annotated[Session, Depends(get_session)],
    file: UploadFile = File(...),
) -> dict:
    model = await upload_model_flag_svg(db, MODELS_DIR, model_id, file)
    return model.dict()


@app.delete("/api/models/{model_id}/flag")
def remove_model_flag(
    model_id: str,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    model = delete_model_flag_svg(db, MODELS_DIR, model_id)
    return model.dict()


@app.post("/api/models/{model_id}/pack-face")
async def post_model_pack_face(
    model_id: str,
    db: Annotated[Session, Depends(get_session)],
    file: UploadFile = File(...),
) -> dict:
    model = await upload_model_video(db, MODELS_DIR, model_id, "pack-face", file)
    return model.dict()


@app.post("/api/models/{model_id}/pack-face-2")
async def post_model_pack_face_2(
    model_id: str,
    db: Annotated[Session, Depends(get_session)],
    file: UploadFile = File(...),
) -> dict:
    model = await upload_model_video(db, MODELS_DIR, model_id, "pack-face-2", file)
    return model.dict()


@app.post("/api/models/{model_id}/swipe")
async def post_model_swipe(
    model_id: str,
    db: Annotated[Session, Depends(get_session)],
    file: UploadFile = File(...),
) -> dict:
    model = await upload_model_video(db, MODELS_DIR, model_id, "swipe", file)
    return model.dict()


@app.post("/api/models/{model_id}/swipe-poster")
async def post_model_swipe_poster(
    model_id: str,
    db: Annotated[Session, Depends(get_session)],
    file: UploadFile = File(...),
) -> dict:
    model = await upload_model_swipe_poster(db, MODELS_DIR, model_id, file)
    return model.dict()


@app.post("/api/models/{model_id}/themes/{theme_id}/avatar")
async def post_model_theme_avatar(
    model_id: str,
    theme_id: str,
    db: Annotated[Session, Depends(get_session)],
    file: UploadFile = File(...),
) -> dict:
    model = await upload_model_theme_avatar(db, MODELS_DIR, model_id, theme_id, file)
    return model.dict()


@app.delete("/api/models/{model_id}/themes/{theme_id}/avatar")
def remove_model_theme_avatar(
    model_id: str,
    theme_id: str,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    model = delete_model_theme_avatar(db, MODELS_DIR, model_id, theme_id)
    return model.dict()


@app.get("/api/collection")
def get_collection(model: str = "", theme: str = "") -> dict:
    draft_themes: dict[str, str] = {}
    for flow in list_flows():
        card_id = str(flow.get("card_id") or "").strip()
        draft = flow.get("draft")
        theme_name = ""
        if isinstance(draft, dict):
            theme_name = str(draft.get("theme") or "").strip()
        if card_id and theme_name:
            draft_themes[card_id] = theme_name
    return build_collection_catalog(
        ROOT,
        CARDS_DIR,
        MESH_DIR,
        MODELS_DIR,
        THEMES_DIR,
        draft_themes=draft_themes,
        model_filter=model or None,
        theme_filter=theme or None,
    )


@app.get("/api/themes")
def get_themes(db: Annotated[Session, Depends(get_session)]) -> dict:
    themes = list_themes(db, THEMES_DIR)
    return {"themes": [theme.dict() for theme in themes]}


@app.post("/api/themes")
def post_theme(
    request: CreateThemeRequest,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    theme = create_theme(db, THEMES_DIR, request)
    return theme.dict()


@app.put("/api/themes/order")
def put_themes_order(
    request: ReorderThemesRequest,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    themes = reorder_themes(db, THEMES_DIR, request.theme_ids)
    return {"themes": [theme.dict() for theme in themes]}


@app.put("/api/themes/{theme_id}")
def put_theme(
    theme_id: str,
    request: UpdateThemeRequest,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    theme = update_theme(db, THEMES_DIR, theme_id, request)
    return theme.dict()


@app.delete("/api/themes/{theme_id}")
def remove_theme(
    theme_id: str,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    delete_theme(db, THEMES_DIR, theme_id)
    return {"ok": True, "id": theme_id}


@app.post("/api/themes/{theme_id}/intro")
async def post_theme_intro(
    theme_id: str,
    db: Annotated[Session, Depends(get_session)],
    file: UploadFile = File(...),
) -> dict:
    theme = await upload_theme_intro(db, THEMES_DIR, theme_id, file)
    return theme.dict()


@app.delete("/api/themes/{theme_id}/intro")
def remove_theme_intro(
    theme_id: str,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    theme = delete_theme_intro(db, THEMES_DIR, theme_id)
    return theme.dict()


@app.get("/api/symbol-groups")
def get_symbol_groups(db: Annotated[Session, Depends(get_session)]) -> dict:
    groups = list_symbol_groups(db, LOTTIES_DIR)
    return {"groups": [group.dict() for group in groups]}


@app.post("/api/symbol-groups")
def post_symbol_group(
    request: CreateSymbolGroupRequest,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    group = create_symbol_group(db, LOTTIES_DIR, request)
    return group.dict()


@app.put("/api/symbol-groups/{group_id}")
def put_symbol_group(
    group_id: str,
    request: UpdateSymbolGroupRequest,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    group = update_symbol_group(db, LOTTIES_DIR, group_id, request)
    return group.dict()


@app.post("/api/symbol-groups/{group_id}/default")
def post_default_symbol_group(
    group_id: str,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    group = set_default_symbol_group(db, LOTTIES_DIR, group_id)
    return group.dict()


@app.delete("/api/symbol-groups/{group_id}")
def remove_symbol_group(
    group_id: str,
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    delete_symbol_group(db, LOTTIES_DIR, group_id)
    return {"ok": True, "id": group_id}


@app.get("/api/symbols")
def get_symbols(
    db: Annotated[Session, Depends(get_session)],
    group_id: str | None = None,
) -> dict:
    symbols = list_symbols(db, LOTTIES_DIR, group_id=group_id)
    return {"symbols": [symbol.dict() for symbol in symbols]}


@app.put("/api/symbols/{symbol_id}")
def put_symbol(
    symbol_id: str,
    request: UpdateSymbolRequest,
    db: Annotated[Session, Depends(get_session)],
    group_id: str | None = None,
) -> dict:
    symbol = update_symbol(db, LOTTIES_DIR, symbol_id, request, group_id=group_id)
    return symbol.dict()


@app.post("/api/symbols/{symbol_id}/lottie")
async def post_symbol_lottie(
    symbol_id: str,
    db: Annotated[Session, Depends(get_session)],
    file: UploadFile = File(...),
    group_id: str | None = None,
) -> dict:
    symbol = await upload_symbol_lottie(db, LOTTIES_DIR, symbol_id, file, group_id=group_id)
    return symbol.dict()


@app.get("/api/symbols/{symbol_id}/json")
def get_symbol_json(
    symbol_id: str,
    db: Annotated[Session, Depends(get_session)],
    group_id: str | None = None,
) -> dict:
    payload = read_symbol_json(db, LOTTIES_DIR, symbol_id, group_id=group_id)
    return payload.dict()


@app.put("/api/symbols/{symbol_id}/json")
def put_symbol_json(
    symbol_id: str,
    request: RewriteSymbolJsonRequest,
    db: Annotated[Session, Depends(get_session)],
    group_id: str | None = None,
) -> dict:
    symbol = rewrite_symbol_json(db, LOTTIES_DIR, symbol_id, request, group_id=group_id)
    return symbol.dict()


@app.post("/api/jobs/cards/{card_id}/compress")
def compress_card_videos(card_id: str, request: CompressCardRequest) -> dict:
    def action(
        card_id: str = card_id,
        write_webm: bool = request.write_webm,
        compress_preset: str = request.compress_preset,
    ) -> None:
        compress_card(
            ROOT,
            CARDS_DIR,
            card_id,
            write_webm=write_webm,
            compress_preset=compress_preset,
        )

    job = enqueue(
        "compress-card",
        ["backend.cards.compress_card", card_id, request.compress_preset],
        action,
    )
    return job.public()


@app.post("/api/files/upload")
async def upload_file(
    request: Request,
    x_file_name: str | None = Header(default=None),
) -> UploadedFileInfo:
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    original_name = Path(unquote(x_file_name or "")).name
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", original_name).strip("._")
    if not safe_name:
        safe_name = "upload.bin"

    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    target = UPLOADS_DIR / f"{uuid.uuid4().hex[:8]}-{safe_name}"
    target.write_bytes(data)
    return UploadedFileInfo(path=relative(target), size_bytes=len(data))


@app.get("/api/files/preview")
def preview_file(path: str) -> FileResponse:
    target = workspace_path(path, must_exist=True)
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    # Work-dir clips are rewritten in place during trim — never let the browser
    # keep a stale first frame after Fix frames.
    headers = (
        {"Cache-Control": "no-store, max-age=0"}
        if target.suffix.lower() in {".mp4", ".webm", ".mov"}
        else None
    )
    return FileResponse(target, headers=headers)


@app.post("/api/mesh/garment")
def save_garment_mask(request: SaveGarmentRequest) -> dict:
    """Persist a hand-edited per-vertex scratchable mask back into a mesh JSON.

    The app stores scratchability as a static per-vertex `garment` array
    (cols*rows) that parseTrackedMesh ANDs into per-frame visibility. The
    dashboard mask editor paints this array, so saving only rewrites that field
    and leaves the tracked geometry untouched.
    """
    import json

    name = Path(request.file).name
    if not name.endswith(".json") or name == "index.json":
        raise HTTPException(status_code=400, detail=f"Invalid mesh file: {request.file}")
    path = resolve_mesh_json_path(request.file)

    data = json.loads(path.read_text())
    mesh = data.get("mesh") or {}
    cols = int(mesh.get("cols") or 0)
    rows = int(mesh.get("rows") or 0)
    expected = cols * rows
    if expected <= 0:
        raise HTTPException(status_code=400, detail="Mesh is missing grid dimensions")
    if len(request.garment) != expected:
        raise HTTPException(
            status_code=400,
            detail=f"garment length {len(request.garment)} does not match grid {cols}x{rows} ({expected})",
        )

    data["garment"] = [1 if int(flag) else 0 for flag in request.garment]
    data["garmentSource"] = "dashboard-editor"
    data["garmentEditedAt"] = now()
    # Static photo meshes store vis = garment so Fix mesh updates the drawn lattice.
    if data.get("generator") == "photo-scratch-static":
        for frame in data.get("frames") or []:
            if isinstance(frame, dict):
                frame["vis"] = list(data["garment"])
    path.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    return {
        "ok": True,
        "file": name,
        "sum": int(sum(data["garment"])),
        "total": expected,
    }


@app.post("/api/jobs/mesh/auto-garment")
def auto_garment_mask_job(request: AutoGarmentMaskRequest) -> dict:
    """SegFormer auto-detect of scratchable body/clothes cells for a mesh JSON."""
    path = resolve_mesh_json_path(request.file)
    job = enqueue(
        "auto-garment-mask",
        ["auto-garment-mask", path.name],
        lambda path=path, request=request: run_generate_garment_mask(
            path,
            mask_source=request.mask_source,
            threshold=request.threshold,
            pixel_dilate=request.pixel_dilate,
            grid_dilate=request.grid_dilate,
            union_existing=request.union_existing,
        ),
    )
    return job.public()


@app.post("/api/jobs/generate-mesh")
def generate_mesh(request: GenerateMeshRequest) -> dict:
    input_video = workspace_path(request.input_video, must_exist=True)
    output_json = workspace_path(request.output_json)
    output_json.parent.mkdir(parents=True, exist_ok=True)

    env = {
        "PYTORCH_ENABLE_MPS_FALLBACK": "1",
        # Use the locally cached SegFormer / tracker weights. Without these the
        # in-process job tries to reach huggingface.co and fails when offline.
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        # Match CLI mesh defaults (MPS on Apple Silicon). Set MESH_DEVICE=cpu in
        # .env if Metal crashes on your hardware (generic DEVICE is ignored).
        "DEVICE": default_mesh_device(),
        "INPUT_VIDEO": relative(input_video),
        "OUTPUT_JSON": relative(output_json),
        "TRACKER": request.tracker,
        "DEBUG_OVERLAY": "1" if request.debug_overlay else "",
        "COMPARE_TRACKERS": "1" if request.compare_trackers else "0",
    }
    optional = {
        "FPS": request.fps,
        "GRID_COLS": request.grid_cols,
        "GRID_ROWS": request.grid_rows,
        "LOOP_CLOSE": request.loop_close,
        "EXTRA_DRIVER_POINTS": request.extra_driver_points,
    }
    env.update({key: str(value) for key, value in optional.items() if value is not None})
    job = enqueue(
        "generate-mesh",
        ["backend.services.mesh_tracking.generate_mesh"],
        lambda env=env: run_generate_mesh(env),
    )
    return job.public()


@app.post("/api/jobs/grok-edit")
def grok_edit(request: GrokEditRequest) -> dict:
    video = request.video if request.video.startswith(("http://", "https://")) else workspace_path(request.video, must_exist=True)
    out = workspace_path(request.out)
    job = enqueue(
        "grok-edit",
        ["backend.services.grok.edit_video"],
        lambda video=video, out=out, request=request: edit_video(
            video=video,
            prompt=request.prompt,
            out=out,
            model=request.model,
            resolution=request.resolution,
            video_field=request.video_field,
            enhance=request.enhance,
            prepare_compatible=request.prepare_compatible,
        ),
    )
    return job.public()


@app.post("/api/jobs/image-to-video")
def image_to_video(request: ImageToVideoRequest) -> dict:
    image = request.image if request.image.startswith(("http://", "https://")) else workspace_path(request.image, must_exist=True)
    out = workspace_path(request.out)
    job = enqueue(
        "image-to-video",
        ["backend.services.grok.image_to_video"],
        lambda image=image, out=out, request=request: run_image_to_video(
            image=image,
            prompt=request.prompt,
            out=out,
            model=request.model,
            resolution=request.resolution,
            image_field=request.image_field,
            endpoint=request.endpoint,
        ),
    )
    return job.public()


@app.post("/api/jobs/image-dress-flow")
def image_dress_flow(request: ImageDressFlowRequest) -> dict:
    image = request.image if request.image.startswith(("http://", "https://")) else workspace_path(request.image, must_exist=True)
    base_out = workspace_path(request.base_video_out)
    out = workspace_path(request.out)
    job = enqueue(
        "image-dress-flow",
        ["backend.services.grok.image_dress_flow"],
        lambda image=image, base_out=base_out, out=out, request=request: run_image_dress_flow(
            image=image,
            motion_prompt=request.motion_prompt,
            dress_prompt=request.dress_prompt,
            base_video_out=base_out,
            out=out,
            enhance_dress_prompt=request.enhance_dress_prompt,
            model=request.model,
            resolution=request.resolution,
            image_field=request.image_field,
            video_field=request.video_field,
            endpoint=request.endpoint,
        ),
    )
    return job.public()


def video_flow_draft_kwargs(request: VideoFlowRequest, *, image: Path | str) -> dict:
    return {
        "image": image,
        "theme": request.theme,
        "background_motion_prompt": request.background_motion_prompt,
        "foreground_motion_prompt": request.foreground_motion_prompt,
        "dress_prompt": request.dress_prompt,
        "dress_reference_image": request.dress_reference_image,
        "card_id": request.card_id,
        "card_label": request.card_label,
        "model_id": request.model_id,
        "model": request.model,
        "resolution": request.resolution,
        "image_field": request.image_field,
        "endpoint": request.endpoint,
        "video_field": request.video_field,
        "enhance_dress_prompt": request.enhance_dress_prompt,
        "tracker": request.tracker,
        "write_webm": request.write_webm,
        "compress_preset": request.compress_preset,
        "source_mode": request.source_mode,
        "source_prompt": request.source_prompt,
        "face_image": request.face_image,
        "base_image": request.base_image,
        "mesh_tune": request.mesh_tune.model_dump(),
        "ai_provider": request.provider,
        "source_image_model": request.image_model,
        "background_video_model": request.background_video_model,
        "dress_video_model": request.dress_video_model,
    }


@app.post("/api/jobs/generate-source-image")
def generate_source_image_job(request: GenerateSourceImageRequest) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", request.card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    if request.mode == "face_swap":
        if not request.base_image.strip() or not request.face_image.strip():
            raise HTTPException(status_code=400, detail="Face swap requires base_image and face_image")
        base_image = (
            request.base_image
            if request.base_image.startswith(("http://", "https://"))
            else workspace_path(request.base_image, must_exist=True)
        )
        face_image = (
            request.face_image
            if request.face_image.startswith(("http://", "https://"))
            else workspace_path(request.face_image, must_exist=True)
        )
    else:
        base_image = ""
        face_image = (
            workspace_path(request.face_image, must_exist=True)
            if request.face_image.strip()
            and not request.face_image.startswith(("http://", "https://"))
            else request.face_image.strip()
        )
    job = enqueue(
        "generate-source-image",
        ["generate-source-image", request.card_id, request.mode],
        lambda request=request, base_image=base_image, face_image=face_image: run_generate_source_image(
            card_id=request.card_id,
            mode=request.mode,
            prompt=request.prompt,
            face_image=face_image,
            base_image=base_image,
            aspect_ratio=request.aspect_ratio,
            provider=request.provider,
            image_model=request.image_model,
        ),
    )
    return job.public()


@app.get("/api/video-flow")
def get_video_flows() -> dict:
    return {"flows": list_flows()}


@app.get("/api/video-flow/{card_id}/state")
def get_video_flow_state(card_id: str) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    return flow_state(card_id)


@app.post("/api/video-flow/{card_id}/draft")
def save_video_flow_draft(card_id: str, request: VideoFlowRequest) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    if request.card_id != card_id:
        raise HTTPException(status_code=400, detail="card_id in body must match URL")
    image = request.image if request.image.startswith(("http://", "https://")) else workspace_path(request.image, must_exist=False)
    draft = save_flow_draft(**video_flow_draft_kwargs(request, image=image))
    return {"draft": draft}


@app.get("/api/video-flow/{card_id}/draft")
def get_video_flow_draft(card_id: str) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    draft = read_flow_draft(card_id)
    if not draft:
        raise HTTPException(status_code=404, detail="No saved draft for this flow")
    return {"draft": draft}


@app.post("/api/video-flow/{card_id}/import-clips")
def import_video_flow_clips(card_id: str, request: VideoFlowImportClipsRequest) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    background = workspace_path(request.background, must_exist=True)
    foreground = workspace_path(request.foreground, must_exist=True)
    try:
        result = import_manual_clips(
            card_id=card_id,
            card_label=request.card_label,
            background=background,
            foreground=foreground,
            model_id=request.model_id.strip() or None,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    cancel_stale_video_flow_jobs(card_id)
    return result


@app.post("/api/video-flow/{card_id}/approve")
def approve_video_flow_step(card_id: str, request: VideoFlowStepAction) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    try:
        result = approve_flow_step(
            card_id,
            request.step,
            mesh_tracker=request.mesh_tracker,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    cancel_stale_video_flow_jobs(card_id)
    return result


@app.post("/api/video-flow/{card_id}/reject")
def reject_video_flow_step(card_id: str, request: VideoFlowStepAction) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    result = reject_flow_step(card_id, request.step)
    cancel_stale_video_flow_jobs(card_id)
    return result


@app.get("/api/video-flow/{card_id}/trim")
def get_video_flow_trim(card_id: str) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    try:
        return trim_step_info(card_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/video-flow/{card_id}/trim")
def post_video_flow_trim(card_id: str, request: VideoFlowTrimRequest) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    try:
        result = apply_trim_step(
            card_id,
            drop_start=request.drop_start,
            drop_end=request.drop_end,
            auto=request.auto,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    cancel_stale_video_flow_jobs(card_id)
    return result


@app.post("/api/video-flow/{card_id}/trim/reset")
def post_video_flow_trim_reset(card_id: str) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    try:
        result = reset_trim_step(card_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    cancel_stale_video_flow_jobs(card_id)
    return result


@app.get("/api/video-flow/{card_id}/symbol-points")
def get_symbol_points(card_id: str) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    mesh_path = MESH_DIR / f"{card_id}.json"
    if not mesh_path.exists():
        raise HTTPException(status_code=404, detail="Mesh not found")
    points = read_symbol_points(mesh_path)
    return {
        "points": points,
        "required": SYMBOL_POINT_COUNT,
        "complete": len(points) == SYMBOL_POINT_COUNT,
    }


@app.post("/api/video-flow/{card_id}/symbol-points")
def save_symbol_points(card_id: str, request: SymbolPointsRequest) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    mesh_path = MESH_DIR / f"{card_id}.json"
    if not mesh_path.exists():
        raise HTTPException(status_code=404, detail="Mesh not found — generate mesh first")
    try:
        write_symbol_points(
            mesh_path,
            [{"u": point.u, "v": point.v} for point in request.points],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        return approve_flow_step(card_id, "symbols")
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/jobs/video-flow/step")
def video_flow_step_job(request: VideoFlowStepRequest) -> dict:
    try:
        validate_step_enqueue(request.card_id, request.step, force=request.force, image=request.image)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # Mesh / symbols / compress only need the published card — source image is optional.
    image_required = request.step in ("background", "dress", "card")
    if request.image.strip():
        image = (
            request.image
            if request.image.startswith(("http://", "https://"))
            else workspace_path(request.image, must_exist=image_required)
        )
    elif image_required:
        raise HTTPException(status_code=400, detail="Source image is required for this step")
    else:
        image = ""
    dress_reference = request.dress_reference_image.strip()
    if dress_reference and not dress_reference.startswith(("http://", "https://")):
        dress_reference = str(workspace_path(dress_reference, must_exist=True))
    save_flow_draft(**video_flow_draft_kwargs(request, image=image or request.image))
    job = enqueue(
        "video-flow-step",
        ["video-flow-step", request.step, request.card_id],
        lambda image=image, dress_reference=dress_reference, request=request: run_video_flow_step(
            step=request.step,
            image=image,
            theme=request.theme,
            background_motion_prompt=request.background_motion_prompt,
            foreground_motion_prompt=request.foreground_motion_prompt,
            dress_prompt=request.dress_prompt,
            card_id=request.card_id,
            card_label=request.card_label,
            model=request.model,
            resolution=request.resolution,
            image_field=request.image_field,
            endpoint=request.endpoint,
            video_field=request.video_field,
            enhance_dress_prompt=request.enhance_dress_prompt,
            tracker=request.tracker,
            write_webm=request.write_webm,
            dress_reference_image=dress_reference,
            mesh_tune=request.mesh_tune.model_dump(),
            force=request.force,
            provider=request.provider,
            background_video_model=request.background_video_model,
            dress_video_model=request.dress_video_model,
            compress_preset=request.compress_preset,
            model_id=request.model_id,
        ),
    )
    return job.public()


@app.post("/api/jobs/video-flow/mesh-candidate")
def video_flow_mesh_candidate_job(request: MeshCandidateRequest) -> dict:
    if not re.fullmatch(r"[a-z0-9_]+", request.card_id):
        raise HTTPException(status_code=400, detail="Invalid card id")
    job = enqueue(
        "video-flow-mesh-candidate",
        ["video-flow-mesh-candidate", request.tracker, request.card_id],
        lambda request=request: run_mesh_candidate_generation(
            card_id=request.card_id,
            card_label=request.card_label,
            tracker=request.tracker,
            mesh_tune=request.mesh_tune.model_dump(),
            force=request.force,
        ),
    )
    return job.public()


@app.post("/api/jobs/video-flow")
def video_flow_job(request: VideoFlowRequest) -> dict:
    image = request.image if request.image.startswith(("http://", "https://")) else workspace_path(request.image, must_exist=True)
    job = enqueue(
        "video-flow",
        ["backend.services.video_flow.video_flow"],
        lambda image=image, request=request: run_video_flow(
            image=image,
            background_motion_prompt=request.background_motion_prompt,
            foreground_motion_prompt=request.foreground_motion_prompt,
            dress_prompt=request.dress_prompt,
            card_id=request.card_id,
            card_label=request.card_label,
            model=request.model,
            resolution=request.resolution,
            image_field=request.image_field,
            endpoint=request.endpoint,
            video_field=request.video_field,
            enhance_dress_prompt=request.enhance_dress_prompt,
            tracker=request.tracker,
            write_webm=request.write_webm,
        ),
    )
    return job.public()


@app.get("/api/jobs")
def list_jobs() -> dict:
    with jobs_lock:
        ordered = sorted(jobs.values(), key=lambda item: item.created_at, reverse=True)
        return {"jobs": [job.public() for job in ordered]}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return job.public()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        job.status = "cancelled"
    return job.public()
