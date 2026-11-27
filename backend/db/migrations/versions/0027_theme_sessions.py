"""theme sessions

Revision ID: 0027_theme_sessions
Revises: 0026_pre_influencers_handle
Create Date: 2026-11-23

Operators group catalog themes into sessions. Default means every theme.
A custom session starts when an operator starts it and gets an end only
when the next session is set to take over.
"""

from alembic import op

revision = "0027_theme_sessions"
down_revision = "0026_pre_influencers_handle"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE theme_sessions (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            starts_at TIMESTAMPTZ,
            ends_at TIMESTAMPTZ,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT theme_sessions_default_times_chk CHECK (
                id <> 'default' OR (starts_at IS NULL AND ends_at IS NULL)
            ),
            CONSTRAINT theme_sessions_window_chk CHECK (
                ends_at IS NULL OR (starts_at IS NOT NULL AND ends_at > starts_at)
            )
        );

        CREATE INDEX theme_sessions_sort_order_idx ON theme_sessions (sort_order);

        CREATE UNIQUE INDEX theme_sessions_one_open_uq
            ON theme_sessions ((true))
            WHERE id <> 'default' AND starts_at IS NOT NULL AND ends_at IS NULL;

        INSERT INTO theme_sessions (id, label, sort_order)
        VALUES ('default', 'Default', 0);

        CREATE TABLE theme_session_themes (
            session_id TEXT NOT NULL REFERENCES theme_sessions (id) ON DELETE CASCADE,
            theme_id TEXT NOT NULL REFERENCES themes (id) ON DELETE CASCADE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_id, theme_id)
        );

        CREATE INDEX theme_session_themes_theme_idx ON theme_session_themes (theme_id);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP TABLE IF EXISTS theme_session_themes;
        DROP TABLE IF EXISTS theme_sessions;
        """
    )
