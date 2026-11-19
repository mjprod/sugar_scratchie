"""Flag catalog models used as invite-landing demos

Revision ID: 0025_models_default_modal
Revises: 0024_pre_influencers_step3
Create Date: 2026-11-19

Adds ``default_modal`` and ``default_modal_card_id`` on ``models`` so the
operator Default Modals page can mark which catalog models (and which of
their cards) are used when an invitee has no motion card of their own.
"""

from alembic import op

revision = "0025_models_default_modal"
down_revision = "0024_pre_influencers_step3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE models
            ADD COLUMN default_modal BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN default_modal_card_id TEXT
                REFERENCES cards(id) ON DELETE SET NULL;
        CREATE INDEX models_default_modal_idx
            ON models (id)
            WHERE default_modal;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS models_default_modal_idx;
        ALTER TABLE models
            DROP COLUMN IF EXISTS default_modal_card_id,
            DROP COLUMN IF EXISTS default_modal;
        """
    )
