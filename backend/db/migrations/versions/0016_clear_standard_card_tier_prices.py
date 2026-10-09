"""clear replay_price / max_win on standard cards

Revision ID: 0016_clear_standard_tier_prices
Revises: 0015_coin_exchange_reason
Create Date: 2026-10-09

Downgrading a premium / ultra card to standard used to keep its replay price,
which kept charging replays. Standard cards carry neither value.
"""

from alembic import op

revision = "0016_clear_standard_tier_prices"
down_revision = "0015_coin_exchange_reason"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE cards SET replay_price = 0, max_win = 0 "
        "WHERE tier = 'standard' AND (replay_price <> 0 OR max_win <> 0)"
    )


def downgrade() -> None:
    pass
