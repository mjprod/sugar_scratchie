"""symbol groups (switchable 12-slot packs)

Revision ID: 0008_symbol_groups
Revises: 0007_symbols_catalog
Create Date: 2026-08-18

Adds symbol_groups and scopes symbols to a group via composite PK
(group_id, id). Existing rows land in the seeded `default` group.
"""

from alembic import op

revision = "0008_symbol_groups"
down_revision = "0007_symbols_catalog"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE symbol_groups (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            is_default BOOLEAN NOT NULL DEFAULT false,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE UNIQUE INDEX symbol_groups_one_default_uq
            ON symbol_groups (is_default)
            WHERE is_default = true;

        INSERT INTO symbol_groups (id, label, is_default, sort_order)
        VALUES ('default', 'Default', true, 0);

        ALTER TABLE symbols ADD COLUMN group_id TEXT;

        UPDATE symbols SET group_id = 'default' WHERE group_id IS NULL;

        ALTER TABLE symbols ALTER COLUMN group_id SET NOT NULL;

        ALTER TABLE symbols DROP CONSTRAINT symbols_pkey;

        ALTER TABLE symbols
            ADD CONSTRAINT symbols_pkey PRIMARY KEY (group_id, id);

        ALTER TABLE symbols
            ADD CONSTRAINT symbols_group_id_fkey
            FOREIGN KEY (group_id) REFERENCES symbol_groups(id) ON DELETE CASCADE;

        CREATE INDEX symbols_group_id_idx ON symbols (group_id);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DELETE FROM symbols WHERE group_id <> 'default';

        ALTER TABLE symbols DROP CONSTRAINT IF EXISTS symbols_group_id_fkey;
        DROP INDEX IF EXISTS symbols_group_id_idx;
        ALTER TABLE symbols DROP CONSTRAINT symbols_pkey;
        ALTER TABLE symbols DROP COLUMN group_id;
        ALTER TABLE symbols ADD CONSTRAINT symbols_pkey PRIMARY KEY (id);

        DROP INDEX IF EXISTS symbol_groups_one_default_uq;
        DROP TABLE IF EXISTS symbol_groups;
        """
    )
