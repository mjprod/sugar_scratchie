"""photo-scratch card price

Revision ID: 0011_photo_scratch_card_price
Revises: 0010_scratch_coin_hands
Create Date: 2026-09-30

Adds an optional whole-number price to published photo-scratch cards so the
game UI can show it (exposed as `cardPrice` by the client catalog parser).
"""

from alembic import op

revision = "0011_photo_scratch_card_price"
down_revision = "0010_scratch_coin_hands"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE photo_scratch_cards
            ADD COLUMN card_price INTEGER,
            ADD CONSTRAINT photo_scratch_cards_price_chk
                CHECK (card_price IS NULL OR card_price >= 0);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE photo_scratch_cards
            DROP CONSTRAINT IF EXISTS photo_scratch_cards_price_chk,
            DROP COLUMN IF EXISTS card_price;
        """
    )
