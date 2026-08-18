"""name unique constraints to match SQLAlchemy models

Revision ID: 0002_named_unique_constraints
Revises: 0001_player_domain
Create Date: 2026-08-18
"""

from alembic import op

revision = "0002_named_unique_constraints"
down_revision = "0001_player_domain"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 originally used inline UNIQUE, so Postgres named the constraints
    # {table}_{columns}_key. Align names with SQLAlchemy UniqueConstraint names.
    # See 0003 if the unique is missing entirely (rename alone is a no-op).
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'wallet_transactions_idempotency_key_key'
              AND conrelid = 'public.wallet_transactions'::regclass
          ) THEN
            ALTER TABLE wallet_transactions
              RENAME CONSTRAINT wallet_transactions_idempotency_key_key
              TO wallet_tx_idempotency_key_uq;
          END IF;

          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'pack_purchases_idempotency_key_key'
              AND conrelid = 'public.pack_purchases'::regclass
          ) THEN
            ALTER TABLE pack_purchases
              RENAME CONSTRAINT pack_purchases_idempotency_key_key
              TO pack_purchases_idempotency_key_uq;
          END IF;

          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'user_cards_user_id_card_kind_card_id_photo_slot_id_key'
              AND conrelid = 'public.user_cards'::regclass
          ) THEN
            ALTER TABLE user_cards
              RENAME CONSTRAINT user_cards_user_id_card_kind_card_id_photo_slot_id_key
              TO user_cards_unique_owned;
          END IF;

          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'daily_reward_claims_user_id_claim_date_key'
              AND conrelid = 'public.daily_reward_claims'::regclass
          ) THEN
            ALTER TABLE daily_reward_claims
              RENAME CONSTRAINT daily_reward_claims_user_id_claim_date_key
              TO daily_reward_claims_user_date_uq;
          END IF;

          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'redeem_redemptions_user_id_code_key'
              AND conrelid = 'public.redeem_redemptions'::regclass
          ) THEN
            ALTER TABLE redeem_redemptions
              RENAME CONSTRAINT redeem_redemptions_user_id_code_key
              TO redeem_redemptions_user_code_uq;
          END IF;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'wallet_tx_idempotency_key_uq'
              AND conrelid = 'public.wallet_transactions'::regclass
          ) THEN
            ALTER TABLE wallet_transactions
              RENAME CONSTRAINT wallet_tx_idempotency_key_uq
              TO wallet_transactions_idempotency_key_key;
          END IF;

          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'pack_purchases_idempotency_key_uq'
              AND conrelid = 'public.pack_purchases'::regclass
          ) THEN
            ALTER TABLE pack_purchases
              RENAME CONSTRAINT pack_purchases_idempotency_key_uq
              TO pack_purchases_idempotency_key_key;
          END IF;

          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'user_cards_unique_owned'
              AND conrelid = 'public.user_cards'::regclass
          ) THEN
            ALTER TABLE user_cards
              RENAME CONSTRAINT user_cards_unique_owned
              TO user_cards_user_id_card_kind_card_id_photo_slot_id_key;
          END IF;

          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'daily_reward_claims_user_date_uq'
              AND conrelid = 'public.daily_reward_claims'::regclass
          ) THEN
            ALTER TABLE daily_reward_claims
              RENAME CONSTRAINT daily_reward_claims_user_date_uq
              TO daily_reward_claims_user_id_claim_date_key;
          END IF;

          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'redeem_redemptions_user_code_uq'
              AND conrelid = 'public.redeem_redemptions'::regclass
          ) THEN
            ALTER TABLE redeem_redemptions
              RENAME CONSTRAINT redeem_redemptions_user_code_uq
              TO redeem_redemptions_user_id_code_key;
          END IF;
        END $$;
        """
    )
