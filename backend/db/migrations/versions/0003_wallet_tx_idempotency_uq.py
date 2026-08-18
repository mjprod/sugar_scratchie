"""ensure wallet_transactions.idempotency_key unique exists under expected name

Revision ID: 0003_wallet_tx_idempotency_uq
Revises: 0002_named_unique_constraints
Create Date: 2026-08-18

Prod signup failed with:
  constraint "wallet_tx_idempotency_key_uq" for table "wallet_transactions" does not exist

0002 only renames the default Postgres name; if the unique was never created
(or lives under another name), rename is a no-op and ON CONFLICT still breaks.
This migration creates the unique when missing and renames when present under
the default name. apply_delta now also uses index_elements so either name works.
"""

from alembic import op

revision = "0003_wallet_tx_idempotency_uq"
down_revision = "0002_named_unique_constraints"
branch_labels = None
depends_on = None


def upgrade() -> None:
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
          ELSIF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'wallet_tx_idempotency_key_uq'
              AND conrelid = 'public.wallet_transactions'::regclass
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'public.wallet_transactions'::regclass
              AND contype = 'u'
              AND pg_get_constraintdef(oid) = 'UNIQUE (idempotency_key)'
          ) THEN
            ALTER TABLE wallet_transactions
              ADD CONSTRAINT wallet_tx_idempotency_key_uq UNIQUE (idempotency_key);
          END IF;

          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'pack_purchases_idempotency_key_key'
              AND conrelid = 'public.pack_purchases'::regclass
          ) THEN
            ALTER TABLE pack_purchases
              RENAME CONSTRAINT pack_purchases_idempotency_key_key
              TO pack_purchases_idempotency_key_uq;
          ELSIF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'pack_purchases_idempotency_key_uq'
              AND conrelid = 'public.pack_purchases'::regclass
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'public.pack_purchases'::regclass
              AND contype = 'u'
              AND pg_get_constraintdef(oid) = 'UNIQUE (idempotency_key)'
          ) THEN
            ALTER TABLE pack_purchases
              ADD CONSTRAINT pack_purchases_idempotency_key_uq UNIQUE (idempotency_key);
          END IF;
        END $$;
        """
    )


def downgrade() -> None:
    # Do not drop the unique: it is required for correct wallet/pack idempotency.
    # 0002's downgrade already renames the expected names back to Postgres defaults.
    pass
