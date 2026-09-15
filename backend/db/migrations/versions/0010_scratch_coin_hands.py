"""Server-issued scratch coin hands

Revision ID: 0010_scratch_coin_hands
Revises: 0009_photo_scratch_catalog
Create Date: 2026-09-15

Binds scratch coin claims to server-issued hand IDs so clients cannot mint
unbounded coins by inventing handId values.
"""

from alembic import op

revision = "0010_scratch_coin_hands"
down_revision = "0009_photo_scratch_catalog"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE scratch_coin_hands (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id),
            card_id TEXT,
            claimed_milestones JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX scratch_coin_hands_user_created_idx
            ON scratch_coin_hands (user_id, created_at);
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS scratch_coin_hands")
