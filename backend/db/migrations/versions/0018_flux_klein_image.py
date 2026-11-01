"""FLUX 3 Image Klein source-image model

Revision ID: 0018_flux_klein_image
Revises: 0017_generation_models
Create Date: 2026-10-31

Adds the Black Forest Labs provider and adapter, then inserts the built-in
row on databases that already have a catalog. An empty table stays empty so
the first API start can still seed every built-in together.
"""

from alembic import op

revision = "0018_flux_klein_image"
down_revision = "0017_generation_models"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE generation_models DROP CONSTRAINT generation_models_provider_chk")
    op.execute(
        """
        ALTER TABLE generation_models
            ADD CONSTRAINT generation_models_provider_chk
            CHECK (provider IN ('xai','wavespeed','bfl'))
        """
    )
    op.execute("ALTER TABLE generation_models DROP CONSTRAINT generation_models_adapter_chk")
    op.execute(
        """
        ALTER TABLE generation_models
            ADD CONSTRAINT generation_models_adapter_chk
            CHECK (adapter IN (
                'grok_image','seedream_image','grok_i2v','wan_spicy_i2v',
                'grok_video_edit','prompt_video_edit','reference_video_edit',
                'flux_klein_image'
            ))
        """
    )
    op.execute(
        """
        INSERT INTO generation_models (
            id, role, label, provider, adapter, endpoint_path,
            reference_token, variant, enabled, sort_order
        )
        SELECT
            'flux-3-image-klein', 'source_image', 'FLUX 3 Image Klein',
            'bfl', 'flux_klein_image', '', '', '', TRUE, 2
        WHERE EXISTS (SELECT 1 FROM generation_models)
        ON CONFLICT (id, role) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DELETE FROM generation_models
        WHERE id = 'flux-3-image-klein' AND role = 'source_image'
        """
    )
    op.execute("ALTER TABLE generation_models DROP CONSTRAINT generation_models_adapter_chk")
    op.execute(
        """
        ALTER TABLE generation_models
            ADD CONSTRAINT generation_models_adapter_chk
            CHECK (adapter IN (
                'grok_image','seedream_image','grok_i2v','wan_spicy_i2v',
                'grok_video_edit','prompt_video_edit','reference_video_edit'
            ))
        """
    )
    op.execute("ALTER TABLE generation_models DROP CONSTRAINT generation_models_provider_chk")
    op.execute(
        """
        ALTER TABLE generation_models
            ADD CONSTRAINT generation_models_provider_chk
            CHECK (provider IN ('xai','wavespeed'))
        """
    )
