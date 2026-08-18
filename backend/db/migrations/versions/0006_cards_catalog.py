"""cards catalog table

Revision ID: 0006_cards_catalog
Revises: 0005_models_catalog
Create Date: 2026-08-18

Moves motion-card metadata (id, label, model_id, theme_id, sort_order, photos)
from public/cards/*/meta.json into Postgres. Videos, mesh, trailers, and
photo-scratch assets remain on disk.
"""

from alembic import op

revision = "0006_cards_catalog"
down_revision = "0005_models_catalog"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE cards (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            model_id TEXT REFERENCES models(id) ON DELETE CASCADE,
            theme_id TEXT REFERENCES themes(id) ON DELETE SET NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            photos JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX cards_model_sort_idx ON cards (model_id, sort_order);
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS cards")
