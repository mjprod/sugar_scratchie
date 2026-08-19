"""photo-scratch published catalog table

Revision ID: 0009_photo_scratch_catalog
Revises: 0008_symbol_groups
Create Date: 2026-08-19

Moves published photo-scratch game entries from public/photo-scratch/index.json
into Postgres. Slot images and mesh.json remain on disk under
public/cards/<card>/photo-scratch/; per-card workspace index.json stays a
pipeline artifact.
"""

from alembic import op

revision = "0009_photo_scratch_catalog"
down_revision = "0008_symbol_groups"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE photo_scratch_cards (
            id TEXT PRIMARY KEY,
            card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
            slot_id TEXT NOT NULL,
            label TEXT NOT NULL,
            model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
            theme_id TEXT REFERENCES themes(id) ON DELETE SET NULL,
            background TEXT NOT NULL,
            bikini TEXT NOT NULL,
            clothes TEXT NOT NULL,
            mesh TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT photo_scratch_cards_slot_chk CHECK (slot_id ~ '^slot_[0-9]{2}$')
        );
        CREATE UNIQUE INDEX photo_scratch_cards_card_slot_uq
            ON photo_scratch_cards (card_id, slot_id);
        CREATE INDEX photo_scratch_cards_card_idx ON photo_scratch_cards (card_id);
        CREATE INDEX photo_scratch_cards_sort_idx ON photo_scratch_cards (sort_order);
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS photo_scratch_cards")
