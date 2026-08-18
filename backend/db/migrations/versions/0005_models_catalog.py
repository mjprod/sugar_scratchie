"""models catalog table

Revision ID: 0005_models_catalog
Revises: 0004_themes_catalog
Create Date: 2026-08-18

Moves model/creator metadata (id, label, influencer fields, card colours,
pack names, tags) from public/models/*/meta.json into Postgres. Media files
(avatar, flag, pack-face/swipe videos, theme avatars) remain on disk under
public/models/{id}/.
"""

from alembic import op

revision = "0005_models_catalog"
down_revision = "0004_themes_catalog"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE models (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            influencer_name TEXT,
            influencer_city TEXT,
            influencer_country TEXT,
            influencer_flag TEXT,
            card_overlay_color_start TEXT,
            card_overlay_color_end TEXT,
            card_light_color_1 TEXT,
            card_light_color_2 TEXT,
            card_pack_name TEXT,
            card_pack_name_2 TEXT,
            tags JSONB NOT NULL DEFAULT '[]'::jsonb
        );
        CREATE UNIQUE INDEX models_label_lower_uq ON models (lower(label));
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS models")
