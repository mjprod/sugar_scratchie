"""Add acronym on theme sessions

Revision ID: 0028_theme_session_acronym
Revises: 0027_theme_sessions
Create Date: 2026-11-23

Sessions have an id, a name (label), and a short acronym shown as the code tag.
"""

from alembic import op

revision = "0028_theme_session_acronym"
down_revision = "0027_theme_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE theme_sessions
            ADD COLUMN IF NOT EXISTS acronym TEXT;

        UPDATE theme_sessions
        SET acronym = upper(left(regexp_replace(id, '[^a-zA-Z0-9]', '', 'g'), 12))
        WHERE id <> 'default'
          AND (acronym IS NULL OR btrim(acronym) = '');

        CREATE UNIQUE INDEX IF NOT EXISTS theme_sessions_acronym_lower_uq
            ON theme_sessions (lower(acronym))
            WHERE acronym IS NOT NULL;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS theme_sessions_acronym_lower_uq;
        ALTER TABLE theme_sessions DROP COLUMN IF EXISTS acronym;
        """
    )
