"""themes catalog table

Revision ID: 0004_themes_catalog
Revises: 0003_wallet_tx_idempotency_uq
Create Date: 2026-08-18

Moves theme metadata (id, label, sort_order, card colours) from
public/themes/index.json into Postgres. Intro video files remain on disk
under public/themes/{id}/intro.{mp4,webm}.
"""

from alembic import op

revision = "0004_themes_catalog"
down_revision = "0003_wallet_tx_idempotency_uq"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE themes (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            card_overlay_color_start TEXT,
            card_overlay_color_end TEXT,
            card_light_color_1 TEXT,
            card_light_color_2 TEXT
        );
        CREATE INDEX themes_sort_order_idx ON themes (sort_order);
        CREATE UNIQUE INDEX themes_label_lower_uq ON themes (lower(label));
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS themes")
