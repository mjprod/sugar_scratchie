"""wallet reason: coin_exchange

Revision ID: 0015_coin_exchange_reason
Revises: 0014_card_tiers_and_socials
Create Date: 2026-10-09

Coins -> Diamonds exchange (`POST /api/store/exchange`) writes one coin debit
and one diamond credit, both with reason `coin_exchange`.
"""

from alembic import op

revision = "0015_coin_exchange_reason"
down_revision = "0014_card_tiers_and_socials"
branch_labels = None
depends_on = None

_REASONS_OLD = (
    "'welcome_bonus','store_purchase','pack_purchase','pack_reward',"
    "'scratch_reward','daily_reward','redeem_code','refund','admin_adjust',"
    "'card_purchase','card_replay'"
)
_REASONS_NEW = _REASONS_OLD + ",'coin_exchange'"


def _replace_reason_check(reasons: str) -> str:
    return f"""
        ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_tx_reason_chk;
        ALTER TABLE wallet_transactions
            ADD CONSTRAINT wallet_tx_reason_chk CHECK (reason IN ({reasons})) NOT VALID;
    """


def upgrade() -> None:
    op.execute(_replace_reason_check(_REASONS_NEW))


def downgrade() -> None:
    op.execute("DELETE FROM wallet_transactions WHERE reason = 'coin_exchange'")
    op.execute(_replace_reason_check(_REASONS_OLD))
