#!/usr/bin/env python3
"""Rematch (and optionally cutout) photo-scratch slots — one, one card, or all.

Examples:
  # Rematch every slot that has bikini + clothes, then cutout
  .venv/bin/python scripts/adjust_photo_match.py --all --cutout

  # Rematch one card
  .venv/bin/python scripts/adjust_photo_match.py --card asia_gym --cutout

  # Rematch everything with an extra +4% clothes scale and -8px vertical nudge
  .venv/bin/python scripts/adjust_photo_match.py --all --cutout --scale 1.04 --ty -8
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.cards import (  # noqa: E402
    cutout_photo_scratch_slot,
    list_photo_scratch_slots,
    match_photo_scratch_slot,
)

CARDS_DIR = ROOT / "public" / "cards"


def _iter_targets(card_id: str | None, slot_id: str | None) -> list[tuple[str, str]]:
    cards = sorted(p.name for p in CARDS_DIR.iterdir() if p.is_dir())
    if card_id:
        cards = [card_id]
    out: list[tuple[str, str]] = []
    for cid in cards:
        if cid == "original":
            continue
        try:
            slots = list_photo_scratch_slots(CARDS_DIR, cid)
        except Exception:
            continue
        for slot in slots:
            if slot_id and slot.id != slot_id:
                continue
            if not (slot.bikini and slot.clothes):
                continue
            out.append((cid, slot.id))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Adjust photo-scratch match alignment for one/all slots"
    )
    parser.add_argument("--all", action="store_true", help="Process every ready slot")
    parser.add_argument("--card", help="Limit to one card id")
    parser.add_argument("--slot", help="Limit to one slot id (slot_01 …)")
    parser.add_argument(
        "--cutout",
        action="store_true",
        help="Regenerate bikini.png / clothes.png after match",
    )
    parser.add_argument(
        "--scale",
        type=float,
        default=1.0,
        help="Extra clothes scale after auto match (1.04 = +4%%)",
    )
    parser.add_argument(
        "--tx",
        type=float,
        default=0.0,
        help="Extra X translate in match pixels (+right)",
    )
    parser.add_argument(
        "--ty",
        type=float,
        default=0.0,
        help="Extra Y translate in match pixels (+down)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List targets only",
    )
    args = parser.parse_args()

    if not args.all and not args.card and not args.slot:
        parser.error("Pass --all, or --card / --slot")

    targets = _iter_targets(args.card, args.slot)
    if not targets:
        print("No slots with bikini + clothes found.", flush=True)
        return 1

    print(f"Targets: {len(targets)} slot(s)", flush=True)
    for cid, sid in targets:
        print(f"  - {cid}/{sid}", flush=True)

    if args.dry_run:
        return 0

    ok = 0
    failed: list[str] = []
    for cid, sid in targets:
        label = f"{cid}/{sid}"
        try:
            print(f"\n=== match {label} ===", flush=True)
            match_photo_scratch_slot(
                ROOT,
                CARDS_DIR,
                cid,
                sid,
                nudge_scale=args.scale,
                nudge_tx=args.tx,
                nudge_ty=args.ty,
                confirm_adjust=True,
            )
            if args.cutout:
                print(f"=== cutout {label} ===", flush=True)
                cutout_photo_scratch_slot(ROOT, CARDS_DIR, cid, sid)
            ok += 1
        except Exception as exc:
            print(f"FAILED {label}: {exc}", flush=True)
            failed.append(label)

    print(f"\nDone: {ok}/{len(targets)} ok", flush=True)
    if failed:
        print("Failed:", ", ".join(failed), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
