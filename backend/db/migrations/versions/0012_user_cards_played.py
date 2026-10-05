"""user x cards played

Revision ID: 0012_user_cards_played
Revises: 0011_photo_scratch_card_price
Create Date: 2026-10-02

One row per (user, card). The first play is the purchase (charged once via the
`card_purchase` wallet reason) and binds the single scratch hand allowed to
mint rewards; every later hand for that card is free play with rewards off.
"""

from alembic import op

revision = "0012_user_cards_played"
down_revision = "0011_photo_scratch_card_price"
branch_labels = None
depends_on = None

_REASONS_OLD = (
    "'welcome_bonus','store_purchase','pack_purchase','pack_reward',"
    "'scratch_reward','daily_reward','redeem_code','refund','admin_adjust'"
)
_REASONS_NEW = _REASONS_OLD + ",'card_purchase'"


def _replace_reason_check(reasons: str) -> str:
    # 0001 created the reason CHECK inline, so its name is Postgres's default.
    # NOT VALID: some databases hold legacy reasons; only new rows are checked.
    return f"""
        DO $$
        DECLARE c record;
        BEGIN
          FOR c IN
            SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.wallet_transactions'::regclass
              AND contype = 'c'
              AND position('reason' in pg_get_constraintdef(oid)) > 0
          LOOP
            EXECUTE 'ALTER TABLE wallet_transactions DROP CONSTRAINT ' || quote_ident(c.conname);
          END LOOP;
        END $$;
        ALTER TABLE wallet_transactions
            ADD CONSTRAINT wallet_tx_reason_chk CHECK (reason IN ({reasons})) NOT VALID;
    """


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE scratch_coin_hands
            ADD COLUMN rewards_enabled BOOLEAN NOT NULL DEFAULT TRUE;

        CREATE TABLE user_cards_played (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id),
            card_kind TEXT NOT NULL,
            card_id TEXT NOT NULL,
            price_paid INTEGER NOT NULL DEFAULT 0,
            rewarded_hand_id UUID REFERENCES scratch_coin_hands(id),
            play_count INTEGER NOT NULL DEFAULT 1,
            first_played_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_played_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            completed_at TIMESTAMPTZ,
            CONSTRAINT user_cards_played_kind_chk CHECK (card_kind IN ('motion','photo')),
            CONSTRAINT user_cards_played_price_chk CHECK (price_paid >= 0),
            CONSTRAINT user_cards_played_user_card_uq UNIQUE (user_id, card_kind, card_id)
        );
        CREATE INDEX user_cards_played_user_idx ON user_cards_played (user_id);
        """
    )
    op.execute(_replace_reason_check(_REASONS_NEW))


def downgrade() -> None:
    op.execute("DELETE FROM wallet_transactions WHERE reason = 'card_purchase'")
    op.execute(_replace_reason_check(_REASONS_OLD))
    op.execute(
        """
        DROP TABLE IF EXISTS user_cards_played;
        ALTER TABLE scratch_coin_hands DROP COLUMN IF EXISTS rewards_enabled;
        """
    )
