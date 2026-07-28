from __future__ import annotations

import io
import json
import re
import time
import zipfile
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException, UploadFile
from pydantic import BaseModel, Field

SYMBOL_COUNT = 12
SYMBOL_ID_PATTERN = re.compile(r"^(0[1-9]|1[0-2])$")
LOTTIE_EXTENSIONS = {".lottie"}
JSON_EXTENSIONS = {".json"}

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


class SymbolInfo(BaseModel):
    id: str
    file: str
    label: str
    src: str
    updated_at: float = 0


class UpdateSymbolRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)


class RewriteSymbolJsonRequest(BaseModel):
    json_text: str = Field(min_length=2)


class SymbolJsonPayload(BaseModel):
    id: str
    path: str
    json_text: str


def safe_symbol_id(value: str) -> str:
    symbol_id = value.strip()
    if not SYMBOL_ID_PATTERN.match(symbol_id):
        raise HTTPException(status_code=400, detail="Symbol id must be 01–12")
    return symbol_id


def _index_path(lotties_dir: Path) -> Path:
    return lotties_dir / "index.json"


def public_src(file_name: str, updated_at: float = 0) -> str:
    encoded = quote(file_name, safe="")
    base = f"/lotties/{encoded}"
    if updated_at and updated_at > 0:
        return f"{base}?v={int(updated_at)}"
    return base


def _parse_symbol(entry: dict) -> SymbolInfo | None:
    symbol_id = entry.get("id")
    file_name = entry.get("file")
    label = entry.get("label")
    if not isinstance(symbol_id, str) or not isinstance(file_name, str) or not isinstance(label, str):
        return None
    symbol_id = symbol_id.strip()
    file_name = Path(file_name.strip()).name
    label = label.strip()
    if not SYMBOL_ID_PATTERN.match(symbol_id) or not file_name or not label:
        return None
    updated_at = entry.get("updated_at")
    stamp = float(updated_at) if isinstance(updated_at, (int, float)) else 0.0
    return SymbolInfo(
        id=symbol_id,
        file=file_name,
        label=label,
        src=public_src(file_name, stamp),
        updated_at=stamp,
    )


def _write_index(lotties_dir: Path, symbols: list[SymbolInfo]) -> None:
    lotties_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "symbols": [
            {
                "id": symbol.id,
                "file": symbol.file,
                "label": symbol.label,
                "updated_at": symbol.updated_at,
            }
            for symbol in symbols
        ]
    }
    _index_path(lotties_dir).write_text(json.dumps(payload, indent=2) + "\n")


def write_symbols_index(lotties_dir: Path) -> list[SymbolInfo]:
    """Ensure index exists with all 12 slots; fill gaps from defaults."""
    path = _index_path(lotties_dir)
    by_id: dict[str, SymbolInfo] = {}
    if path.exists():
        try:
            data = json.loads(path.read_text())
            raw = data.get("symbols") if isinstance(data, dict) else None
            if isinstance(raw, list):
                for entry in raw:
                    if isinstance(entry, dict):
                        parsed = _parse_symbol(entry)
                        if parsed:
                            by_id[parsed.id] = parsed
        except Exception:
            by_id = {}

    symbols: list[SymbolInfo] = []
    for symbol_id, file_name, label in DEFAULT_SYMBOLS:
        existing = by_id.get(symbol_id)
        if existing:
            symbols.append(existing)
        else:
            symbols.append(
                SymbolInfo(
                    id=symbol_id,
                    file=file_name,
                    label=label,
                    src=public_src(file_name, 0),
                    updated_at=0,
                )
            )
    _write_index(lotties_dir, symbols)
    return symbols


def list_symbols(lotties_dir: Path) -> list[SymbolInfo]:
    return write_symbols_index(lotties_dir)


def update_symbol(lotties_dir: Path, symbol_id: str, request: UpdateSymbolRequest) -> SymbolInfo:
    safe_id = safe_symbol_id(symbol_id)
    label = request.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Label is required")
    symbols = list_symbols(lotties_dir)
    updated: SymbolInfo | None = None
    next_symbols: list[SymbolInfo] = []
    for symbol in symbols:
        if symbol.id == safe_id:
            updated = SymbolInfo(
                id=symbol.id,
                file=symbol.file,
                label=label,
                src=public_src(symbol.file, symbol.updated_at),
                updated_at=symbol.updated_at,
            )
            next_symbols.append(updated)
        else:
            next_symbols.append(symbol)
    if updated is None:
        raise HTTPException(status_code=404, detail=f"Symbol not found: {safe_id}")
    _write_index(lotties_dir, next_symbols)
    return updated


def _sanitize_lottie_name(original: str, fallback: str) -> str:
    name = Path(original or "").name.strip()
    if not name:
        return fallback
    stem = re.sub(r"[^\w\- .]+", "", Path(name).stem).strip(" .") or Path(fallback).stem
    return f"{stem}.lottie"


def _touch_symbol(lotties_dir: Path, current: SymbolInfo, file_name: str | None = None) -> SymbolInfo:
    symbols = list_symbols(lotties_dir)
    stamp = time.time()
    new_file = file_name or current.file
    updated = SymbolInfo(
        id=current.id,
        file=new_file,
        label=current.label,
        src=public_src(new_file, stamp),
        updated_at=stamp,
    )
    next_symbols = [updated if symbol.id == current.id else symbol for symbol in symbols]
    _write_index(lotties_dir, next_symbols)
    return updated


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


def read_symbol_json(lotties_dir: Path, symbol_id: str) -> SymbolJsonPayload:
    safe_id = safe_symbol_id(symbol_id)
    current = next((symbol for symbol in list_symbols(lotties_dir) if symbol.id == safe_id), None)
    if current is None:
        raise HTTPException(status_code=404, detail=f"Symbol not found: {safe_id}")
    path = lotties_dir / current.file
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Symbol file missing: {current.file}")

    suffix = path.suffix.lower()
    if suffix in JSON_EXTENSIONS:
        text = path.read_text(encoding="utf-8")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid JSON file: {exc}") from exc
        return SymbolJsonPayload(
            id=safe_id,
            path=current.file,
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
                id=safe_id,
                path=f"{current.file}:{member}",
                json_text=json.dumps(parsed, indent=2, ensure_ascii=False),
            )
    except HTTPException:
        raise
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="Corrupt .lottie file") from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid animation JSON: {exc}") from exc


def rewrite_symbol_json(
    lotties_dir: Path,
    symbol_id: str,
    request: RewriteSymbolJsonRequest,
) -> SymbolInfo:
    safe_id = safe_symbol_id(symbol_id)
    current = next((symbol for symbol in list_symbols(lotties_dir) if symbol.id == safe_id), None)
    if current is None:
        raise HTTPException(status_code=404, detail=f"Symbol not found: {safe_id}")

    try:
        parsed = json.loads(request.json_text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="Animation JSON must be an object")

    pretty = json.dumps(parsed, indent=2, ensure_ascii=False)
    path = lotties_dir / current.file
    suffix = path.suffix.lower() if path.exists() else Path(current.file).suffix.lower()

    if suffix in JSON_EXTENSIONS or not path.exists():
        json_name = Path(current.file).with_suffix(".json").name
        if not json_name.startswith(safe_id):
            json_name = f"{safe_id}-{Path(current.file).stem}.json"
        target = lotties_dir / json_name
        target.write_text(pretty + "\n", encoding="utf-8")
        if current.file != json_name and path.exists() and path.resolve() != target.resolve():
            try:
                path.unlink()
            except OSError:
                pass
        return _touch_symbol(lotties_dir, current, json_name)

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

    return _touch_symbol(lotties_dir, current)


async def upload_symbol_lottie(
    lotties_dir: Path,
    symbol_id: str,
    upload: UploadFile,
) -> SymbolInfo:
    safe_id = safe_symbol_id(symbol_id)
    symbols = list_symbols(lotties_dir)
    current = next((symbol for symbol in symbols if symbol.id == safe_id), None)
    if current is None:
        raise HTTPException(status_code=404, detail=f"Symbol not found: {safe_id}")

    original = Path(upload.filename or "").name
    ext = Path(original).suffix.lower()
    if ext not in LOTTIE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="File must be a .lottie animation")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded lottie is empty")

    new_name = current.file
    if original and original.lower() != "blob" and Path(original).stem:
        candidate = _sanitize_lottie_name(original, current.file)
        if candidate.startswith(f"{safe_id}-") or candidate.startswith(f"{safe_id} "):
            new_name = candidate
        elif Path(current.file).suffix.lower() in JSON_EXTENSIONS:
            new_name = _sanitize_lottie_name(
                f"{safe_id}-{Path(original).stem}.lottie",
                f"{safe_id}-symbol.lottie",
            )
        else:
            new_name = current.file

    lotties_dir.mkdir(parents=True, exist_ok=True)
    target = lotties_dir / new_name
    target.write_bytes(data)

    if current.file != new_name:
        old = lotties_dir / current.file
        if old.exists() and old.resolve() != target.resolve():
            try:
                old.unlink()
            except OSError:
                pass

    return _touch_symbol(lotties_dir, current, new_name)
