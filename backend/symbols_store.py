from __future__ import annotations

import io
import json
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from backend.db.models import Symbol, SymbolGroup

SYMBOL_COUNT = 12
DEFAULT_GROUP_ID = "default"
SYMBOL_ID_PATTERN = re.compile(r"^(0[1-9]|1[0-2])$")
GROUP_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
LOTTIE_EXTENSIONS = {".lottie"}
JSON_EXTENSIONS = {".json"}
# Non-catalog assets that must never be deleted with a group folder.
PROTECTED_LOTTIE_NAMES = {"Peel.lottie", "lottieInitialCountdown.json", "index.json"}

DEFAULT_SYMBOLS: list[tuple[str, str, str]] = [
    ("01", "01-Heart.lottie", "Heart"),
    ("02", "02-Lock.lottie", "Lock"),
    ("03", "03-GemDiamond.lottie", "Gem"),
    ("04", "04-Star.lottie", "Star"),
    ("05", "05-Diamond.lottie", "Diamond"),
    ("06", "06-Magnet.lottie", "Magnet"),
    ("07", "07-Crown.lottie", "Crown"),
    ("08", "08-Gold Coins.lottie", "Gold Coins"),
    ("09", "09-Key.lottie", "Key"),
    ("10", "10-Treasure Chest.lottie", "Treasure Chest"),
    ("11", "11-Diamond Cards.lottie", "Diamond Cards"),
    ("12", "12-WinnerTrophy.lottie", "Trophy"),
]


class SymbolGroupInfo(BaseModel):
    id: str
    label: str
    is_default: bool = False
    sort_order: int = 0


class SymbolInfo(BaseModel):
    id: str
    group_id: str
    file: str
    label: str
    src: str
    updated_at: float = 0


class CreateSymbolGroupRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    copy_from: str | None = Field(default=None, max_length=64)


class UpdateSymbolGroupRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)


class UpdateSymbolRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)


class RewriteSymbolJsonRequest(BaseModel):
    json_text: str = Field(min_length=2)


class SymbolJsonPayload(BaseModel):
    id: str
    group_id: str
    path: str
    json_text: str


def safe_symbol_id(value: str) -> str:
    symbol_id = value.strip()
    if not SYMBOL_ID_PATTERN.match(symbol_id):
        raise HTTPException(status_code=400, detail="Symbol id must be 01–12")
    return symbol_id


def safe_group_id(value: str) -> str:
    slug = re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_")
    if not slug or not GROUP_ID_PATTERN.match(slug):
        raise HTTPException(
            status_code=400,
            detail="Group id must start with a letter and contain only lowercase letters, numbers, and underscores",
        )
    return slug


def _index_path(lotties_dir: Path) -> Path:
    return lotties_dir / "index.json"


def public_src(file_name: str, updated_at: float = 0) -> str:
    # Encode each path segment so nested group folders stay as /lotties/group/file.
    encoded = "/".join(quote(part, safe="") for part in Path(file_name).parts)
    base = f"/lotties/{encoded}"
    if updated_at and updated_at > 0:
        return f"{base}?v={int(updated_at)}"
    return base


def _updated_at_unix(value: datetime | None) -> float:
    if value is None:
        return 0.0
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    stamp = value.timestamp()
    return stamp if stamp > 1 else 0.0


def _parse_legacy_updated_at(value: object) -> datetime:
    if isinstance(value, (int, float)) and float(value) > 0:
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    return datetime.fromtimestamp(0, tz=timezone.utc)


def _epoch() -> datetime:
    return datetime.fromtimestamp(0, tz=timezone.utc)


def _asset_path(lotties_dir: Path, file_name: str) -> Path:
    path = (lotties_dir / file_name).resolve()
    root = lotties_dir.resolve()
    if path != root and root not in path.parents:
        raise HTTPException(status_code=400, detail="Invalid symbol file path")
    return path


def _group_dir(lotties_dir: Path, group_id: str) -> Path:
    return lotties_dir / group_id


def _row_to_info(row: Symbol) -> SymbolInfo:
    stamp = _updated_at_unix(row.updated_at)
    return SymbolInfo(
        id=row.id,
        group_id=row.group_id,
        file=row.file,
        label=row.label,
        src=public_src(row.file, stamp),
        updated_at=stamp,
    )


def _group_to_info(row: SymbolGroup) -> SymbolGroupInfo:
    return SymbolGroupInfo(
        id=row.id,
        label=row.label,
        is_default=bool(row.is_default),
        sort_order=int(row.sort_order),
    )


def _write_index_mirror(lotties_dir: Path, symbols: list[SymbolInfo]) -> None:
    """No-op: symbols catalog is Postgres; clients read `/api/symbols`.

    Stale `public/lotties/index.json` may still exist as a read-only fallback.
    """
    del lotties_dir, symbols


def _group_count(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(SymbolGroup)) or 0)


def _require_group(db: Session, group_id: str) -> SymbolGroup:
    if group_id.strip() == DEFAULT_GROUP_ID:
        safe_id = DEFAULT_GROUP_ID
    else:
        safe_id = safe_group_id(group_id)
    row = db.get(SymbolGroup, safe_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Symbol group not found: {safe_id}")
    return row


def get_default_group(db: Session) -> SymbolGroup:
    row = db.scalar(select(SymbolGroup).where(SymbolGroup.is_default.is_(True)).limit(1))
    if row is None:
        row = db.get(SymbolGroup, DEFAULT_GROUP_ID)
    if row is None:
        raise HTTPException(status_code=500, detail="No default symbol group configured")
    return row


def resolve_group_id(db: Session, group_id: str | None) -> str:
    if group_id is None or not group_id.strip():
        return get_default_group(db).id
    return _require_group(db, group_id.strip()).id


def write_symbols_index(db: Session, lotties_dir: Path) -> list[SymbolInfo]:
    """Return default-group symbols (static JSON mirror is no longer updated)."""
    default_id = get_default_group(db).id
    return list_symbols(db, lotties_dir, group_id=default_id, write_mirror=False)


def _maybe_write_mirror(db: Session, lotties_dir: Path, group_id: str) -> None:
    """No-op: symbols catalog mirror is no longer written."""
    del db, lotties_dir, group_id


def _read_legacy_index(lotties_dir: Path) -> dict[str, SymbolInfo]:
    path = _index_path(lotties_dir)
    by_id: dict[str, SymbolInfo] = {}
    if not path.exists():
        return by_id
    try:
        data = json.loads(path.read_text())
        raw = data.get("symbols") if isinstance(data, dict) else None
        if not isinstance(raw, list):
            return by_id
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            symbol_id = entry.get("id")
            file_name = entry.get("file")
            label = entry.get("label")
            if not isinstance(symbol_id, str) or not isinstance(file_name, str) or not isinstance(label, str):
                continue
            symbol_id = symbol_id.strip()
            file_name = str(Path(file_name.strip()))
            if file_name.startswith(".."):
                continue
            label = label.strip()
            if not SYMBOL_ID_PATTERN.match(symbol_id) or not file_name or not label:
                continue
            updated_at = entry.get("updated_at")
            stamp = float(updated_at) if isinstance(updated_at, (int, float)) else 0.0
            by_id[symbol_id] = SymbolInfo(
                id=symbol_id,
                group_id=DEFAULT_GROUP_ID,
                file=file_name,
                label=label,
                src=public_src(file_name, stamp),
                updated_at=stamp,
            )
    except Exception:
        return {}
    return by_id


def _ensure_group_slots(
    db: Session,
    lotties_dir: Path,
    group_id: str,
    *,
    legacy: dict[str, SymbolInfo] | None = None,
) -> None:
    existing = {
        row.id: row
        for row in db.scalars(select(Symbol).where(Symbol.group_id == group_id)).all()
    }
    for symbol_id, file_name, label in DEFAULT_SYMBOLS:
        if symbol_id in existing:
            continue
        legacy_hit = (legacy or {}).get(symbol_id) if group_id == DEFAULT_GROUP_ID else None
        if legacy_hit:
            db.add(
                Symbol(
                    group_id=group_id,
                    id=legacy_hit.id,
                    file=legacy_hit.file,
                    label=legacy_hit.label,
                    created_at=_parse_legacy_updated_at(legacy_hit.updated_at),
                    updated_at=_parse_legacy_updated_at(legacy_hit.updated_at),
                )
            )
        else:
            stored_file = file_name if group_id == DEFAULT_GROUP_ID else f"{group_id}/{file_name}"
            db.add(
                Symbol(
                    group_id=group_id,
                    id=symbol_id,
                    file=stored_file,
                    label=label,
                    created_at=_epoch(),
                    updated_at=_epoch(),
                )
            )
    db.flush()


def ensure_symbols_bootstrapped(db: Session, lotties_dir: Path) -> list[SymbolInfo]:
    """Ensure default group + 12 slots exist; write game mirror."""
    if _group_count(db) == 0:
        db.add(
            SymbolGroup(
                id=DEFAULT_GROUP_ID,
                label="Default",
                is_default=True,
                sort_order=0,
                created_at=_epoch(),
                updated_at=_epoch(),
            )
        )
        db.flush()
    else:
        default = db.scalar(select(SymbolGroup).where(SymbolGroup.is_default.is_(True)).limit(1))
        if default is None:
            fallback = db.get(SymbolGroup, DEFAULT_GROUP_ID) or db.scalars(select(SymbolGroup).limit(1)).first()
            if fallback is None:
                db.add(
                    SymbolGroup(
                        id=DEFAULT_GROUP_ID,
                        label="Default",
                        is_default=True,
                        sort_order=0,
                    )
                )
                db.flush()
            else:
                fallback.is_default = True
                db.flush()

    default_id = get_default_group(db).id
    symbol_count = int(
        db.scalar(select(func.count()).select_from(Symbol).where(Symbol.group_id == default_id)) or 0
    )
    legacy = _read_legacy_index(lotties_dir) if symbol_count == 0 and default_id == DEFAULT_GROUP_ID else {}
    _ensure_group_slots(db, lotties_dir, default_id, legacy=legacy)
    return write_symbols_index(db, lotties_dir)


def list_symbol_groups(db: Session, lotties_dir: Path) -> list[SymbolGroupInfo]:
    if _group_count(db) == 0:
        ensure_symbols_bootstrapped(db, lotties_dir)
    rows = db.scalars(
        select(SymbolGroup).order_by(SymbolGroup.sort_order, SymbolGroup.id)
    ).all()
    return [_group_to_info(row) for row in rows]


def create_symbol_group(
    db: Session,
    lotties_dir: Path,
    request: CreateSymbolGroupRequest,
) -> SymbolGroupInfo:
    ensure_symbols_bootstrapped(db, lotties_dir)
    group_id = safe_group_id(request.id)
    if db.get(SymbolGroup, group_id) is not None:
        raise HTTPException(status_code=409, detail=f"Group id already exists: {group_id}")

    label = request.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Label is required")

    source_id = resolve_group_id(db, request.copy_from)
    source_rows = list(
        db.scalars(select(Symbol).where(Symbol.group_id == source_id).order_by(Symbol.id)).all()
    )
    if len(source_rows) < SYMBOL_COUNT:
        _ensure_group_slots(db, lotties_dir, source_id)
        source_rows = list(
            db.scalars(select(Symbol).where(Symbol.group_id == source_id).order_by(Symbol.id)).all()
        )

    max_sort = db.scalar(select(func.max(SymbolGroup.sort_order))) or 0
    group = SymbolGroup(
        id=group_id,
        label=label,
        is_default=False,
        sort_order=int(max_sort) + 1,
    )
    db.add(group)
    db.flush()

    dest_dir = _group_dir(lotties_dir, group_id)
    dest_dir.mkdir(parents=True, exist_ok=True)

    for src_row in source_rows:
        basename = Path(src_row.file).name
        dest_rel = f"{group_id}/{basename}"
        dest_path = _asset_path(lotties_dir, dest_rel)
        src_path = _asset_path(lotties_dir, src_row.file)
        if src_path.exists() and src_path.is_file():
            shutil.copy2(src_path, dest_path)
        elif not dest_path.exists():
            root_fallback = lotties_dir / basename
            if root_fallback.exists():
                shutil.copy2(root_fallback, dest_path)

        db.add(
            Symbol(
                group_id=group_id,
                id=src_row.id,
                file=dest_rel,
                label=src_row.label,
                created_at=_epoch(),
                updated_at=_epoch(),
            )
        )
    db.flush()
    return _group_to_info(group)


def update_symbol_group(
    db: Session,
    lotties_dir: Path,
    group_id: str,
    request: UpdateSymbolGroupRequest,
) -> SymbolGroupInfo:
    row = _require_group(db, group_id)
    label = request.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Label is required")
    row.label = label
    db.flush()
    return _group_to_info(row)


def set_default_symbol_group(db: Session, lotties_dir: Path, group_id: str) -> SymbolGroupInfo:
    row = _require_group(db, group_id)
    db.execute(update(SymbolGroup).where(SymbolGroup.id != row.id).values(is_default=False))
    row.is_default = True
    db.flush()
    write_symbols_index(db, lotties_dir)
    return _group_to_info(row)


def delete_symbol_group(db: Session, lotties_dir: Path, group_id: str) -> None:
    row = _require_group(db, group_id)
    if row.is_default:
        raise HTTPException(status_code=400, detail="Cannot delete the default symbol group")
    if _group_count(db) <= 1:
        raise HTTPException(status_code=400, detail="Cannot delete the last symbol group")

    files = [r.file for r in db.scalars(select(Symbol).where(Symbol.group_id == row.id)).all()]
    db.delete(row)
    db.flush()

    for file_name in files:
        if Path(file_name).name in PROTECTED_LOTTIE_NAMES:
            continue
        if not file_name.startswith(f"{row.id}/"):
            continue
        path = _asset_path(lotties_dir, file_name)
        if path.exists() and path.is_file():
            try:
                path.unlink()
            except OSError:
                pass
    group_dir = _group_dir(lotties_dir, row.id)
    if group_dir.exists() and group_dir.is_dir():
        try:
            shutil.rmtree(group_dir)
        except OSError:
            pass


def list_symbols(
    db: Session,
    lotties_dir: Path,
    *,
    group_id: str | None = None,
    write_mirror: bool = True,
) -> list[SymbolInfo]:
    if _group_count(db) == 0:
        ensure_symbols_bootstrapped(db, lotties_dir)

    resolved = resolve_group_id(db, group_id)
    _ensure_group_slots(db, lotties_dir, resolved)

    rows = db.scalars(
        select(Symbol).where(Symbol.group_id == resolved).order_by(Symbol.id)
    ).all()
    by_id = {row.id: row for row in rows}
    symbols = [_row_to_info(by_id[symbol_id]) for symbol_id, _, _ in DEFAULT_SYMBOLS if symbol_id in by_id]

    if write_mirror:
        _maybe_write_mirror(db, lotties_dir, resolved)
    return symbols


def _require_symbol(db: Session, group_id: str | None, symbol_id: str) -> Symbol:
    resolved = resolve_group_id(db, group_id)
    safe_id = safe_symbol_id(symbol_id)
    row = db.get(Symbol, {"group_id": resolved, "id": safe_id})
    if row is None:
        raise HTTPException(status_code=404, detail=f"Symbol not found: {resolved}/{safe_id}")
    return row


def update_symbol(
    db: Session,
    lotties_dir: Path,
    symbol_id: str,
    request: UpdateSymbolRequest,
    *,
    group_id: str | None = None,
) -> SymbolInfo:
    row = _require_symbol(db, group_id, symbol_id)
    label = request.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Label is required")
    row.label = label
    db.flush()
    _maybe_write_mirror(db, lotties_dir, row.group_id)
    return _row_to_info(row)


def _touch_symbol(
    db: Session,
    lotties_dir: Path,
    row: Symbol,
    file_name: str | None = None,
) -> SymbolInfo:
    if file_name:
        row.file = file_name
    row.updated_at = datetime.now(timezone.utc)
    db.flush()
    _maybe_write_mirror(db, lotties_dir, row.group_id)
    return _row_to_info(row)


def _sanitize_lottie_name(original: str, fallback: str) -> str:
    name = Path(original or "").name.strip()
    if not name:
        return fallback
    stem = re.sub(r"[^\w\- .]+", "", Path(name).stem).strip(" .") or Path(fallback).stem
    return f"{stem}.lottie"


def _animation_member_from_zip(zf: zipfile.ZipFile) -> str:
    names = zf.namelist()
    manifest_name = next((name for name in names if Path(name).name == "manifest.json"), None)
    if manifest_name:
        try:
            manifest = json.loads(zf.read(manifest_name))
            animations = manifest.get("animations")
            if isinstance(animations, list) and animations:
                first = animations[0]
                anim_id = first.get("id") if isinstance(first, dict) else None
                if isinstance(anim_id, str) and anim_id.strip():
                    candidates = [
                        f"a/{anim_id}.json",
                        f"animations/{anim_id}.json",
                        anim_id if anim_id.endswith(".json") else f"{anim_id}.json",
                    ]
                    for candidate in candidates:
                        if candidate in names:
                            return candidate
        except Exception:
            pass
    for name in names:
        lowered = name.lower()
        if not lowered.endswith(".json"):
            continue
        if Path(name).name == "manifest.json":
            continue
        if lowered.startswith("a/") or "animation" in lowered or "scene" in lowered:
            return name
    for name in names:
        if name.lower().endswith(".json") and Path(name).name != "manifest.json":
            return name
    raise HTTPException(status_code=400, detail="No animation JSON found inside .lottie")


def read_symbol_json(
    db: Session,
    lotties_dir: Path,
    symbol_id: str,
    *,
    group_id: str | None = None,
) -> SymbolJsonPayload:
    row = _require_symbol(db, group_id, symbol_id)
    path = _asset_path(lotties_dir, row.file)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Symbol file missing: {row.file}")

    suffix = path.suffix.lower()
    if suffix in JSON_EXTENSIONS:
        text = path.read_text(encoding="utf-8")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid JSON file: {exc}") from exc
        return SymbolJsonPayload(
            id=row.id,
            group_id=row.group_id,
            path=row.file,
            json_text=json.dumps(parsed, indent=2, ensure_ascii=False),
        )

    if suffix not in LOTTIE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Symbol file is not .lottie or .json")

    try:
        with zipfile.ZipFile(path, "r") as zf:
            member = _animation_member_from_zip(zf)
            raw = zf.read(member)
            parsed = json.loads(raw.decode("utf-8"))
            return SymbolJsonPayload(
                id=row.id,
                group_id=row.group_id,
                path=f"{row.file}:{member}",
                json_text=json.dumps(parsed, indent=2, ensure_ascii=False),
            )
    except HTTPException:
        raise
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="Corrupt .lottie file") from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid animation JSON: {exc}") from exc


def rewrite_symbol_json(
    db: Session,
    lotties_dir: Path,
    symbol_id: str,
    request: RewriteSymbolJsonRequest,
    *,
    group_id: str | None = None,
) -> SymbolInfo:
    row = _require_symbol(db, group_id, symbol_id)

    try:
        parsed = json.loads(request.json_text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="Animation JSON must be an object")

    pretty = json.dumps(parsed, indent=2, ensure_ascii=False)
    path = _asset_path(lotties_dir, row.file)
    suffix = path.suffix.lower() if path.exists() else Path(row.file).suffix.lower()

    if suffix in JSON_EXTENSIONS or not path.exists():
        basename = Path(row.file).with_suffix(".json").name
        if not basename.startswith(row.id):
            basename = f"{row.id}-{Path(row.file).stem}.json"
        if "/" in row.file:
            rel = f"{row.group_id}/{basename}"
        else:
            rel = basename
        target = _asset_path(lotties_dir, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(pretty + "\n", encoding="utf-8")
        if row.file != rel and path.exists() and path.resolve() != target.resolve():
            try:
                path.unlink()
            except OSError:
                pass
        return _touch_symbol(db, lotties_dir, row, rel)

    if suffix not in LOTTIE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Cannot rewrite this file type")

    try:
        with zipfile.ZipFile(path, "r") as zf:
            member = _animation_member_from_zip(zf)
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as out:
                for info in zf.infolist():
                    data = pretty.encode("utf-8") if info.filename == member else zf.read(info.filename)
                    out.writestr(info, data)
        path.write_bytes(buffer.getvalue())
    except HTTPException:
        raise
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="Corrupt .lottie file") from exc

    return _touch_symbol(db, lotties_dir, row)


async def upload_symbol_lottie(
    db: Session,
    lotties_dir: Path,
    symbol_id: str,
    upload: UploadFile,
    *,
    group_id: str | None = None,
) -> SymbolInfo:
    row = _require_symbol(db, group_id, symbol_id)

    original = Path(upload.filename or "").name
    ext = Path(original).suffix.lower()
    if ext not in LOTTIE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="File must be a .lottie animation")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded lottie is empty")

    current_basename = Path(row.file).name
    new_basename = current_basename
    if original and original.lower() != "blob" and Path(original).stem:
        candidate = _sanitize_lottie_name(original, current_basename)
        if candidate.startswith(f"{row.id}-") or candidate.startswith(f"{row.id} "):
            new_basename = candidate
        elif Path(current_basename).suffix.lower() in JSON_EXTENSIONS:
            new_basename = _sanitize_lottie_name(
                f"{row.id}-{Path(original).stem}.lottie",
                f"{row.id}-symbol.lottie",
            )

    if "/" in row.file or row.group_id != DEFAULT_GROUP_ID:
        new_rel = f"{row.group_id}/{new_basename}"
        _group_dir(lotties_dir, row.group_id).mkdir(parents=True, exist_ok=True)
    else:
        new_rel = new_basename
        lotties_dir.mkdir(parents=True, exist_ok=True)

    target = _asset_path(lotties_dir, new_rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)

    if row.file != new_rel:
        old = _asset_path(lotties_dir, row.file)
        if old.exists() and old.resolve() != target.resolve():
            try:
                old.unlink()
            except OSError:
                pass

    return _touch_symbol(db, lotties_dir, row, new_rel)
