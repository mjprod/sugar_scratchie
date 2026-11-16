"""pre_influencers.model_id for the operator catalog model

Revision ID: 0023_pre_influencers_model_id
Revises: 0022_pre_influencers_live_status
Create Date: 2026-11-16

Ordering a landing page creates an empty models row for the invitee so the
operator app can run Send influencer to n8n. The id is stored here so a
second order reuses the same model.
"""

from alembic import op

revision = "0023_pre_influencers_model_id"
down_revision = "0022_pre_influencers_live_status"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE pre_influencers
            ADD COLUMN IF NOT EXISTS model_id TEXT;
        CREATE INDEX IF NOT EXISTS pre_influencers_model_id_idx
            ON pre_influencers (model_id);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS pre_influencers_model_id_idx;
        ALTER TABLE pre_influencers DROP COLUMN IF EXISTS model_id;
        """
    )
