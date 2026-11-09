"""EvoLink generation provider

Revision ID: 0019_evolink_provider
Revises: 0018_flux_klein_image
Create Date: 2026-11-09

Adds the EvoLink provider and adapters, then inserts built-in catalog rows on
databases that already have a catalog. An empty table stays empty so the first
API start can still seed every built-in together.
"""

from alembic import op

revision = "0019_evolink_provider"
down_revision = "0018_flux_klein_image"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE generation_models DROP CONSTRAINT generation_models_provider_chk")
    op.execute(
        """
        ALTER TABLE generation_models
            ADD CONSTRAINT generation_models_provider_chk
            CHECK (provider IN ('xai','wavespeed','bfl','evolink'))
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
                'flux_klein_image','evolink_image','evolink_i2v','evolink_reference_video'
            ))
        """
    )
    op.execute(
        """
        INSERT INTO generation_models (
            id, role, label, provider, adapter, endpoint_path,
            reference_token, variant, enabled, sort_order
        )
        SELECT * FROM (VALUES
            (
                'evolink-seedream-5.0-lite', 'source_image', 'EvoLink Seedream 5.0 Lite',
                'evolink', 'evolink_image', 'doubao-seedream-5.0-lite',
                '', '', TRUE, 3
            ),
            (
                'evolink-seedance-2.0-i2v', 'background_video',
                'EvoLink Seedance 2.0 Image-to-Video',
                'evolink', 'evolink_i2v', 'seedance-2.0-image-to-video',
                '', '', TRUE, 2
            ),
            (
                'evolink-seedance-2.0-reference', 'dress_video',
                'EvoLink Seedance 2.0 Reference-to-Video',
                'evolink', 'evolink_reference_video', 'seedance-2.0-reference-to-video',
                '@image1', '', TRUE, 4
            ),
            (
                'evolink-wan3.0-reference', 'dress_video',
                'EvoLink WAN 3.0 Reference-to-Video',
                'evolink', 'evolink_reference_video', 'wan3.0-reference-video',
                '@image1', '', TRUE, 5
            )
        ) AS v(id, role, label, provider, adapter, endpoint_path, reference_token, variant, enabled, sort_order)
        WHERE EXISTS (SELECT 1 FROM generation_models)
        ON CONFLICT (id, role) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DELETE FROM generation_models
        WHERE provider = 'evolink'
           OR id IN (
                'evolink-seedream-5.0-lite',
                'evolink-seedance-2.0-i2v',
                'evolink-seedance-2.0-reference',
                'evolink-wan3.0-reference'
           )
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
    op.execute("ALTER TABLE generation_models DROP CONSTRAINT generation_models_provider_chk")
    op.execute(
        """
        ALTER TABLE generation_models
            ADD CONSTRAINT generation_models_provider_chk
            CHECK (provider IN ('xai','wavespeed','bfl'))
        """
    )
