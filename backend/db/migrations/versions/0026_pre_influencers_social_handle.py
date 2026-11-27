"""Add social_handle on pre_influencers

Revision ID: 0026_pre_influencers_handle
Revises: 0025_models_default_modal
Create Date: 2026-11-19

Stores the social handle from the invite landing-page form (Forms step).
"""

from alembic import op

revision = "0026_pre_influencers_handle"
down_revision = "0025_models_default_modal"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE pre_influencers
            ADD COLUMN IF NOT EXISTS social_handle TEXT;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE pre_influencers
            DROP COLUMN IF EXISTS social_handle;
        """
    )
