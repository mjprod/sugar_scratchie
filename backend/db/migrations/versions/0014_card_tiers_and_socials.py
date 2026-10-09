"""card tiers, prices, creator socials, diamond scratch payouts

Revision ID: 0014_card_tiers_and_socials
Revises: 0013_users_apple_subject
Create Date: 2026-10-09

- `models`: creator social links (Instagram, TikTok, X, OnlyFans).
- `cards`: `price` (first play / unlock), `tier` (standard | premium | ultra),
  `replay_price` and `max_win` (diamonds). At most one premium card per
  creator x theme and one ultra card per creator.
- `scratch_coin_hands`: `currency` + `payout_cap` + `paid_total` so premium /
  ultra hands pay diamonds up to the card's max win.
- `wallet_transactions`: new `card_replay` reason for paid replays.
"""

from alembic import op

revision = "0014_card_tiers_and_socials"
down_revision = "0013_users_apple_subject"
branch_labels = None
depends_on = None

_REASONS_OLD = (
    "'welcome_bonus','store_purchase','pack_purchase','pack_reward',"
    "'scratch_reward','daily_reward','redeem_code','refund','admin_adjust','card_purchase'"
)
_REASONS_NEW = _REASONS_OLD + ",'card_replay'"


def _replace_reason_check(reasons: str) -> str:
    return f"""
        ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_tx_reason_chk;
        ALTER TABLE wallet_transactions
            ADD CONSTRAINT wallet_tx_reason_chk CHECK (reason IN ({reasons})) NOT VALID;
    """


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE models
            ADD COLUMN instagram_url TEXT,
            ADD COLUMN tiktok_url TEXT,
            ADD COLUMN x_url TEXT,
            ADD COLUMN onlyfans_url TEXT;

        ALTER TABLE cards
            ADD COLUMN price INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN tier TEXT NOT NULL DEFAULT 'standard',
            ADD COLUMN replay_price INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN max_win INTEGER NOT NULL DEFAULT 0,
            ADD CONSTRAINT cards_tier_chk CHECK (tier IN ('standard','premium','ultra')),
            ADD CONSTRAINT cards_prices_chk CHECK (price >= 0 AND replay_price >= 0 AND max_win >= 0);
        CREATE UNIQUE INDEX cards_premium_model_theme_uq ON cards (model_id, theme_id)
            WHERE tier = 'premium';
        CREATE UNIQUE INDEX cards_ultra_model_uq ON cards (model_id)
            WHERE tier = 'ultra';

        ALTER TABLE scratch_coin_hands
            ADD COLUMN currency TEXT NOT NULL DEFAULT 'coins',
            ADD COLUMN payout_cap INTEGER,
            ADD COLUMN paid_total INTEGER NOT NULL DEFAULT 0,
            ADD CONSTRAINT scratch_coin_hands_currency_chk CHECK (currency IN ('coins','diamonds'));
        """
    )
    op.execute(_replace_reason_check(_REASONS_NEW))


def downgrade() -> None:
    op.execute("DELETE FROM wallet_transactions WHERE reason = 'card_replay'")
    op.execute(_replace_reason_check(_REASONS_OLD))
    op.execute(
        """
        ALTER TABLE scratch_coin_hands
            DROP CONSTRAINT IF EXISTS scratch_coin_hands_currency_chk,
            DROP COLUMN IF EXISTS paid_total,
            DROP COLUMN IF EXISTS payout_cap,
            DROP COLUMN IF EXISTS currency;

        DROP INDEX IF EXISTS cards_ultra_model_uq;
        DROP INDEX IF EXISTS cards_premium_model_theme_uq;
        ALTER TABLE cards
            DROP CONSTRAINT IF EXISTS cards_prices_chk,
            DROP CONSTRAINT IF EXISTS cards_tier_chk,
            DROP COLUMN IF EXISTS max_win,
            DROP COLUMN IF EXISTS replay_price,
            DROP COLUMN IF EXISTS tier,
            DROP COLUMN IF EXISTS price;

        ALTER TABLE models
            DROP COLUMN IF EXISTS onlyfans_url,
            DROP COLUMN IF EXISTS x_url,
            DROP COLUMN IF EXISTS tiktok_url,
            DROP COLUMN IF EXISTS instagram_url;
        """
    )
