"""generation models catalog

Revision ID: 0017_generation_models
Revises: 0016_clear_standard_tier_prices
Create Date: 2026-10-15

Operator-editable image and video models for Video Flow. Rows are seeded
when the table is empty (see generation_models_store).
"""

from alembic import op

revision = "0017_generation_models"
down_revision = "0016_clear_standard_tier_prices"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE generation_models (
            id TEXT NOT NULL,
            role TEXT NOT NULL,
            label TEXT NOT NULL,
            provider TEXT NOT NULL,
            adapter TEXT NOT NULL,
            endpoint_path TEXT NOT NULL DEFAULT '',
            reference_token TEXT NOT NULL DEFAULT '',
            variant TEXT NOT NULL DEFAULT '',
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (id, role),
            CONSTRAINT generation_models_role_chk
                CHECK (role IN ('source_image','background_video','dress_video')),
            CONSTRAINT generation_models_provider_chk
                CHECK (provider IN ('xai','wavespeed')),
            CONSTRAINT generation_models_adapter_chk
                CHECK (adapter IN (
                    'grok_image','seedream_image','grok_i2v','wan_spicy_i2v',
                    'grok_video_edit','prompt_video_edit','reference_video_edit'
                )),
            CONSTRAINT generation_models_variant_chk
                CHECK (variant IN ('','wan30','seedance'))
        );
        CREATE INDEX generation_models_role_sort_idx
            ON generation_models (role, sort_order);
        CREATE UNIQUE INDEX generation_models_label_role_uq
            ON generation_models (role, lower(label));
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS generation_models")
