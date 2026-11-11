"""promoter invite ref on users and sale report time on store purchases

Revision ID: 0020_promoter_ref
Revises: 0019_evolink_provider
Create Date: 2026-11-11

The invite code a manager sent is stored on the player. A confirmed diamond
purchase records when that sale was reported to MJ Promoter.
"""

from alembic import op

revision = "0020_promoter_ref"
down_revision = "0019_evolink_provider"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN promoter_ref TEXT")
    op.execute("ALTER TABLE store_purchases ADD COLUMN promoter_reported_at TIMESTAMPTZ")


def downgrade() -> None:
    op.execute("ALTER TABLE store_purchases DROP COLUMN promoter_reported_at")
    op.execute("ALTER TABLE users DROP COLUMN promoter_ref")
