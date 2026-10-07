"""users.apple_subject

Revision ID: 0013_users_apple_subject
Revises: 0012_user_cards_played
Create Date: 2026-10-07

Sign in with Apple identity (`sub`) kept apart from `provider_subject` (Google),
so one account can link both providers.
"""

from alembic import op

revision = "0013_users_apple_subject"
down_revision = "0012_user_cards_played"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE users ADD COLUMN apple_subject TEXT;
        ALTER TABLE users ADD CONSTRAINT users_apple_subject_uq UNIQUE (apple_subject);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_apple_subject_uq;
        ALTER TABLE users DROP COLUMN IF EXISTS apple_subject;
        """
    )
