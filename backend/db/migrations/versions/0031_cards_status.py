"""Motion and photo card status: published or unpublished

Revision ID: 0031_cards_status
Revises: 0030_models_status
Create Date: 2026-11-24

Existing cards stay published. Unpublished takes a card off the store while
players who already own or have played it can still open it.
"""

from alembic import op

revision = "0031_cards_status"
down_revision = "0030_models_status"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE cards
            ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
        ALTER TABLE cards
            ADD CONSTRAINT cards_status_chk
            CHECK (status IN ('published', 'unpublished'));

        ALTER TABLE photo_scratch_cards
            ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
        ALTER TABLE photo_scratch_cards
            ADD CONSTRAINT photo_scratch_cards_status_chk
            CHECK (status IN ('published', 'unpublished'));
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE photo_scratch_cards
            DROP CONSTRAINT IF EXISTS photo_scratch_cards_status_chk;
        ALTER TABLE photo_scratch_cards DROP COLUMN IF EXISTS status;

        ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_status_chk;
        ALTER TABLE cards DROP COLUMN IF EXISTS status;
        """
    )
