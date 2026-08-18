"""symbols catalog table

Revision ID: 0007_symbols_catalog
Revises: 0006_cards_catalog
Create Date: 2026-08-18

Moves fixed-slot symbol metadata (id 01–12, file, label, timestamps) from
public/lotties/index.json into Postgres. .lottie / JSON animation files remain
on disk under public/lotties/.
"""

from alembic import op

revision = "0007_symbols_catalog"
down_revision = "0006_cards_catalog"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE symbols (
            id TEXT PRIMARY KEY,
            file TEXT NOT NULL,
            label TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT symbols_id_chk CHECK (id ~ '^(0[1-9]|1[0-2])$')
        );
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS symbols")
