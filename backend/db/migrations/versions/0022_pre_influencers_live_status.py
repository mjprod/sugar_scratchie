"""Allow pre_influencers.status = live once the player LP URL is set

Revision ID: 0022_pre_influencers_live_status
Revises: 0021_pre_influencers
Create Date: 2026-11-15

Ordering a landing page publishes the player /join freeplay URL immediately,
so the row can move to live (not only building).
"""

from alembic import op

revision = "0022_pre_influencers_live_status"
down_revision = "0021_pre_influencers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE pre_influencers DROP CONSTRAINT IF EXISTS pre_influencers_status_chk;
        ALTER TABLE pre_influencers ADD CONSTRAINT pre_influencers_status_chk
            CHECK (status IN ('pending', 'confirmed', 'building', 'live'));
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE pre_influencers SET status = 'building' WHERE status = 'live';
        ALTER TABLE pre_influencers DROP CONSTRAINT IF EXISTS pre_influencers_status_chk;
        ALTER TABLE pre_influencers ADD CONSTRAINT pre_influencers_status_chk
            CHECK (status IN ('pending', 'confirmed', 'building'));
        """
    )
