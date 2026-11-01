"""Operator prompt tokens for the still-image generator.

@image1 is the uploaded main photo.
@image2 is the bikini (the swimsuit photo while making bikinis, then the bikini still).
@image3 is the picture the operator picked with Use this picture.
@image4 is the theme uniform. It is required for the dress step.

Grok reads ``<IMAGE_0>`` in attachment order. Seedream reads ``Figure 1``.
The numbers in the prompt stay the operator's names; each model only sees its own tokens.
"""

from __future__ import annotations

import re
from pathlib import Path

_TOKEN = re.compile(r"@image(\d+)", re.IGNORECASE)

SLOT_NAMES = {
    1: "main image (@image1)",
    2: "bikini (@image2)",
    3: "picked picture (@image3)",
    4: "theme uniform (@image4)",
}


def image_slots(prompt: str) -> list[int]:
    """@image numbers in first-seen order, starting at 1."""
    found: list[int] = []
    for match in _TOKEN.finditer(prompt or ""):
        number = int(match.group(1))
        if number >= 1 and number not in found:
            found.append(number)
    return found


def rewrite_image_tokens(prompt: str, *, style: str) -> str:
    """Replace @imageN with the token for that image's place in the attachment list.

    Attachments are the mentioned slots in numeric order, so @image1 then @image3
    become the first and second image.
    """
    order = sorted(image_slots(prompt))
    index = {slot: position for position, slot in enumerate(order)}

    def replace(match: re.Match[str]) -> str:
        number = int(match.group(1))
        position = index.get(number)
        if position is None:
            return match.group(0)
        if style == "grok":
            return f"<IMAGE_{position}>"
        if style == "seedream":
            return f"Figure {position + 1}"
        if style == "at-image":
            return f"@Image {position + 1}"
        return f"Image {position + 1}"

    return _TOKEN.sub(replace, prompt or "")


def replace_image_tokens(prompt: str, mapping: dict[int, str]) -> str:
    """Replace each @imageN with an exact phrase. Unknown numbers stay put."""

    def replace(match: re.Match[str]) -> str:
        number = int(match.group(1))
        if number not in mapping:
            return match.group(0)
        return mapping[number]

    return _TOKEN.sub(replace, prompt or "")


def _slot_path(available: dict[int, str | Path | None], slot: int) -> Path | None:
    raw = available.get(slot)
    path = raw if isinstance(raw, Path) else None
    if path is None or not path.is_file():
        return None
    return path


def drop_unbound_image_tokens(
    prompt: str,
    available: dict[int, str | Path | None],
) -> tuple[str, list[int]]:
    """Remove @imageN names that have no file yet. The rest of the prompt stays."""
    dropped: list[int] = []
    text = prompt or ""
    for slot in image_slots(text):
        if _slot_path(available, slot) is not None:
            continue
        dropped.append(slot)
        text = re.sub(rf"@image{slot}\b", "", text, flags=re.IGNORECASE)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return text.strip(), dropped


def bind_prompt_images(
    prompt: str,
    available: dict[int, str | Path | None],
) -> tuple[str, list[Path]]:
    """Return the prompt and the local files it names, in @image number order.

    Raises RuntimeError when a named slot has no file.
    """
    slots = sorted(image_slots(prompt))
    if not slots:
        raise RuntimeError("Prompt does not name an @image.")
    images: list[Path] = []
    for slot in slots:
        path = _slot_path(available, slot)
        if path is None:
            name = SLOT_NAMES.get(slot, f"@image{slot}")
            raise RuntimeError(f"Prompt uses @image{slot}, but there is no {name} yet.")
        images.append(path)
    return prompt, images
