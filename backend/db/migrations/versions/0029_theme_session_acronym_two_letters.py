"""Season acronyms are exactly two letters

Revision ID: 0029_theme_session_acronym_two
Revises: 0028_theme_session_acronym
Create Date: 2026-11-23

The code tag is two letters. Default becomes DF. Longer codes keep their
first two letters; a clash leaves the later row blank so it can be set again.
"""

from alembic import op

revision = "0029_theme_session_acronym_two"
down_revision = "0028_theme_session_acronym"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TEMP TABLE theme_session_acronym_next AS
        SELECT id,
            CASE
                WHEN id = 'default' THEN 'DF'
                ELSE upper(left(regexp_replace(coalesce(nullif(btrim(acronym), ''), id), '[^A-Za-z]', '', 'g'), 2))
            END AS candidate
        FROM theme_sessions;

        UPDATE theme_sessions SET acronym = NULL;

        UPDATE theme_sessions AS seasons
        SET acronym = picked.candidate
        FROM (
            SELECT id, candidate,
                row_number() OVER (
                    PARTITION BY lower(candidate)
                    ORDER BY CASE WHEN id = 'default' THEN 0 ELSE 1 END, id
                ) AS rn
            FROM theme_session_acronym_next
            WHERE length(candidate) = 2
        ) AS picked
        WHERE seasons.id = picked.id
          AND picked.rn = 1;

        DROP TABLE theme_session_acronym_next;

        ALTER TABLE theme_sessions
            DROP CONSTRAINT IF EXISTS theme_sessions_acronym_len_chk;
        ALTER TABLE theme_sessions
            ADD CONSTRAINT theme_sessions_acronym_len_chk
            CHECK (acronym IS NULL OR acronym ~ '^[A-Z]{2}$');
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE theme_sessions
            DROP CONSTRAINT IF EXISTS theme_sessions_acronym_len_chk;
        """
    )
