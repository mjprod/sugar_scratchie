"""Assemble the product collection catalog for GET /api/collection."""

from __future__ import annotations

import re
from pathlib import Path

from backend.cards import CardInfo, list_photo_scratch_thumb_urls, public_url
from backend.cards_store import list_cards_standalone
from backend.models_store import ModelInfo, list_models_standalone
from backend.themes_store import list_themes_standalone, resolve_theme_id_standalone

CARDS_PER_GROUP = 3

# Aliases so ?theme=cop matches theme_id=police (card ids like julianaval_cop).
_THEME_FILTER_CANONICAL: dict[str, str] = {
    "police": "police",
    "cop": "police",
    "nurse": "nurse",
    "teacher": "teacher",
    "gym": "gym",
    "firefighter": "firegirl",
    "firegirl": "firegirl",
    "fire": "firegirl",
}


def _safe_id_part(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-")
    return slug or "motion"


def _normalize_media_url(value: str | None) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    if raw.startswith(("http://", "https://", "/", "blob:", "data:")):
        return raw
    if raw.startswith("public/"):
        return public_url(raw)
    return public_url(raw) if "/" in raw else raw


def _photo_urls_for_card(cards_dir: Path, card: CardInfo, theme_label: str) -> list[str]:
    del theme_label  # kept for call-site compatibility
    return [
        _normalize_media_url(url)
        for url in list_photo_scratch_thumb_urls(cards_dir, card.id)
    ]


def _normalize_theme_filter(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").strip().lower())


def _canonical_theme_key(value: str | None) -> str:
    needle = _normalize_theme_filter(value)
    if not needle:
        return ""
    return _THEME_FILTER_CANONICAL.get(needle, needle)


def _theme_filter_matches(
    theme_id: str | None,
    theme_label: str,
    theme_filter: str,
) -> bool:
    """True when theme_filter is empty or matches this card's theme id/label."""
    needle = _canonical_theme_key(theme_filter)
    if not needle:
        return True
    card_keys = {
        _canonical_theme_key(theme_id),
        _canonical_theme_key(theme_label),
    }
    card_keys.discard("")
    return needle in card_keys


def _display_model_name(model: ModelInfo) -> str:
    name = (model.influencerName or "").strip()
    if name:
        return name
    label = (model.label or "").strip()
    return label or model.id


def _format_group_title(theme_label: str, model_name: str, part: int) -> str:
    role = theme_label.strip() or "Motion"
    if part > 1:
        role = f"{role} {part}"
    girl = model_name.strip()
    if not girl:
        return role
    if not role:
        return girl
    if role.lower() == girl.lower():
        return girl
    if role.lower().startswith(f"{girl.lower()} "):
        return role
    return f"{girl} {role}"


def _theme_label_for_card(
    card: CardInfo,
    *,
    themes_by_id: dict[str, str],
    draft_themes: dict[str, str],
    themes_dir: Path,
) -> tuple[str | None, str]:
    """Return (theme_id, theme_label) for grouping."""
    if card.theme_id and card.theme_id in themes_by_id:
        return card.theme_id, themes_by_id[card.theme_id]

    draft = (draft_themes.get(card.id) or "").strip()
    if draft:
        resolved = resolve_theme_id_standalone(draft)
        if resolved and resolved in themes_by_id:
            return resolved, themes_by_id[resolved]
        return resolved, draft

    return None, "Motion"


def build_collection_catalog(
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    models_dir: Path,
    themes_dir: Path,
    *,
    draft_themes: dict[str, str] | None = None,
    model_filter: str | None = None,
    theme_filter: str | None = None,
) -> dict:
    models = list_models_standalone(models_dir)
    cards = list_cards_standalone(root, cards_dir, mesh_dir)
    themes = list_themes_standalone(themes_dir)
    themes_by_id = {theme.id: theme.label for theme in themes}
    themes_info = {theme.id: theme for theme in themes}
    drafts = draft_themes or {}

    filter_id = (model_filter or "").strip()
    if filter_id:
        models = [model for model in models if model.id == filter_id]

    theme_needle = (theme_filter or "").strip()
    groups: list[dict] = []
    theme_index: list[dict] = []
    seen_theme_keys: set[str] = set()

    for model in models:
        model_cards = [
            card
            for card in cards
            if card.model_id == model.id and card.id != "original"
        ]
        model_cards.sort(
            key=lambda card: (card.sort_order, card.label.lower(), card.id)
        )

        cards_by_theme: dict[str, list[tuple[str | None, str, CardInfo]]] = {}
        theme_order: list[str] = []
        for card in model_cards:
            theme_id, theme_label = _theme_label_for_card(
                card,
                themes_by_id=themes_by_id,
                draft_themes=drafts,
                themes_dir=themes_dir,
            )
            key = theme_id or theme_label.lower()
            if key not in cards_by_theme:
                cards_by_theme[key] = []
                theme_order.append(key)
            cards_by_theme[key].append((theme_id, theme_label, card))

        model_name = _display_model_name(model)
        for key in theme_order:
            themed = cards_by_theme[key]
            theme_id = themed[0][0]
            theme_label = themed[0][1]
            index_key = theme_id or key
            if index_key not in seen_theme_keys:
                seen_theme_keys.add(index_key)
                theme_index.append(
                    {
                        "id": theme_id or key,
                        "label": theme_label,
                        "modelId": model.id,
                    }
                )

            if not _theme_filter_matches(theme_id, theme_label, theme_needle):
                continue

            avatar_url = ""
            if theme_id:
                avatar_url = model.theme_avatars.get(theme_id, "")
            theme_info = themes_info.get(theme_id) if theme_id else None

            for offset in range(0, len(themed), CARDS_PER_GROUP):
                part = offset // CARDS_PER_GROUP + 1
                chunk = themed[offset : offset + CARDS_PER_GROUP]
                title = _format_group_title(theme_label, model_name, part)
                group_cards = []
                for _, label, card in chunk:
                    photo_urls = _photo_urls_for_card(cards_dir, card, label)
                    filled = sum(1 for url in photo_urls if url)
                    foreground = _normalize_media_url(card.foreground)
                    background = _normalize_media_url(card.background)
                    trailer = _normalize_media_url(card.trailer)
                    motion = foreground or background
                    group_cards.append(
                        {
                            "id": card.id,
                            "label": card.label,
                            "trailerUrl": trailer or None,
                            # Collection face: uploaded trailer when present, else motion clip.
                            "videoUrl": trailer or motion,
                            "photoScratchDone": max(
                                0,
                                min(
                                    10,
                                    int(round(card.photo_scratch_done or filled)),
                                ),
                            ),
                            "photoUrls": photo_urls,
                        }
                    )
                groups.append(
                    {
                        "id": f"{_safe_id_part(model.id)}-{_safe_id_part(theme_id or theme_label)}-{part}",
                        "modelId": model.id,
                        "themeId": theme_id,
                        "themeName": theme_label,
                        "title": title,
                        "avatarUrl": avatar_url or None,
                        "cardOverlayColorStart": theme_info.cardOverlayColorStart if theme_info else None,
                        "cardOverlayColorEnd": theme_info.cardOverlayColorEnd if theme_info else None,
                        "cardLightColor1": theme_info.cardLightColor1 if theme_info else None,
                        "cardLightColor2": theme_info.cardLightColor2 if theme_info else None,
                        "cards": group_cards,
                    }
                )

    return {
        "groups": groups,
        "themes": theme_index,
        "model": filter_id or None,
        "theme": theme_needle or None,
    }
