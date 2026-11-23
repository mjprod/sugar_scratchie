"""Influencer catalog status: published, unpublished, deprecated

Revision ID: 0030_models_status
Revises: 0029_theme_session_acronym_two
Create Date: 2026-11-23

Existing influencers stay published. Unpublished hides them from players.
Deprecated keeps them out of the store while players who already bought
her packs and cards can still open what they own.
"""

from alembic import op

revision = "0030_models_status"
down_revision = "0029_theme_session_acronym_two"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE models
            ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
        ALTER TABLE models
            ADD CONSTRAINT models_status_chk
            CHECK (status IN ('published', 'unpublished', 'deprecated'));
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE models DROP CONSTRAINT IF EXISTS models_status_chk;
        ALTER TABLE models DROP COLUMN IF EXISTS status;
        """
    )
