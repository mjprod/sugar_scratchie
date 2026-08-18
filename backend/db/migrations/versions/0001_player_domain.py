"""player domain schema

Revision ID: 0001_player_domain
Revises:
Create Date: 2026-08-15
"""

from alembic import op

revision = "0001_player_domain"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    op.execute(
        """
        CREATE TABLE users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email CITEXT NOT NULL UNIQUE,
            password_hash TEXT,
            auth_provider TEXT NOT NULL DEFAULT 'email'
                CHECK (auth_provider IN ('google','apple','email')),
            provider_subject TEXT,
            email_verified_at TIMESTAMPTZ,
            username TEXT UNIQUE,
            display_name TEXT,
            avatar_url TEXT,
            gender_interest TEXT CHECK (gender_interest IS NULL OR gender_interest IN ('male','female','both')),
            referral_code TEXT NOT NULL UNIQUE,
            referred_by_user_id UUID REFERENCES users(id),
            home_tutorial_done BOOLEAN NOT NULL DEFAULT TRUE,
            recommendation_status TEXT,
            welcome_claimed_at TIMESTAMPTZ,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned','deleted')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_seen_at TIMESTAMPTZ
        );

        CREATE TABLE sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id),
            token_hash TEXT NOT NULL UNIQUE,
            user_agent TEXT,
            ip INET,
            expires_at TIMESTAMPTZ NOT NULL,
            revoked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX sessions_user_id_idx ON sessions(user_id);

        CREATE TABLE email_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id),
            kind TEXT NOT NULL CHECK (kind IN ('verify_email','reset_password')),
            token_hash TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            consumed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX email_tokens_user_id_idx ON email_tokens(user_id);
        CREATE INDEX email_tokens_token_hash_idx ON email_tokens(token_hash);

        CREATE TABLE user_creator_prefs (
            user_id UUID NOT NULL REFERENCES users(id),
            model_id TEXT NOT NULL,
            stance TEXT NOT NULL CHECK (stance IN ('liked','passed')),
            source TEXT NOT NULL DEFAULT 'feed' CHECK (source IN ('feed','onboarding_swipe')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (user_id, model_id)
        );

        CREATE TABLE wallets (
            user_id UUID PRIMARY KEY REFERENCES users(id),
            diamonds INTEGER NOT NULL DEFAULT 0,
            coins INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE wallet_transactions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id),
            currency TEXT NOT NULL CHECK (currency IN ('diamonds','coins')),
            delta BIGINT NOT NULL,
            balance_after BIGINT NOT NULL,
            reason TEXT NOT NULL CHECK (reason IN (
                'welcome_bonus','store_purchase','pack_purchase','pack_reward',
                'scratch_reward','daily_reward','redeem_code','refund','admin_adjust'
            )),
            ref_type TEXT,
            ref_id TEXT,
            idempotency_key TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT wallet_tx_idempotency_key_uq UNIQUE (idempotency_key)
        );
        CREATE INDEX wallet_tx_user_created_idx ON wallet_transactions(user_id, created_at);

        CREATE TABLE store_products (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('rewarded-ad','diamonds')),
            title TEXT NOT NULL,
            subtitle TEXT,
            price_label TEXT NOT NULL,
            price_amount_cents INTEGER,
            currency TEXT NOT NULL DEFAULT 'USD',
            diamonds INTEGER NOT NULL DEFAULT 0,
            coins INTEGER NOT NULL DEFAULT 0,
            badge TEXT,
            artwork_url TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            available BOOLEAN NOT NULL DEFAULT TRUE
        );

        CREATE TABLE store_purchases (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id),
            product_id TEXT NOT NULL REFERENCES store_products(id),
            price_label TEXT NOT NULL,
            diamonds INTEGER NOT NULL DEFAULT 0,
            coins INTEGER NOT NULL DEFAULT 0,
            gateway TEXT,
            gateway_outcome TEXT CHECK (
                gateway_outcome IS NULL OR gateway_outcome IN ('completed','cancelled','closed','failed','pending')
            ),
            verified_status TEXT CHECK (
                verified_status IS NULL OR verified_status IN ('confirmed','pending','failed','cancelled')
            ),
            gateway_ref TEXT,
            credited_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX store_purchases_user_id_idx ON store_purchases(user_id);

        CREATE TABLE packs (
            id TEXT PRIMARY KEY,
            model_id TEXT,
            theme_id TEXT,
            name TEXT NOT NULL,
            pack_title TEXT NOT NULL,
            cover_url TEXT,
            diamond_cost INTEGER NOT NULL DEFAULT 80,
            price_amount_cents INTEGER,
            card_count INTEGER NOT NULL DEFAULT 3,
            rarity_weights JSONB,
            is_new BOOLEAN NOT NULL DEFAULT FALSE,
            is_limited BOOLEAN NOT NULL DEFAULT FALSE,
            is_hot BOOLEAN NOT NULL DEFAULT FALSE,
            accent_colors JSONB,
            expires_at TIMESTAMPTZ,
            available BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX packs_model_id_idx ON packs(model_id);
        CREATE INDEX packs_theme_id_idx ON packs(theme_id);

        CREATE TABLE pack_purchases (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id),
            pack_id TEXT NOT NULL REFERENCES packs(id),
            quantity INTEGER NOT NULL,
            diamond_cost INTEGER NOT NULL,
            idempotency_key TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT pack_purchases_idempotency_key_uq UNIQUE (idempotency_key)
        );
        CREATE INDEX pack_purchases_user_id_idx ON pack_purchases(user_id);

        CREATE TABLE pack_instances (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id),
            pack_id TEXT NOT NULL REFERENCES packs(id),
            pack_purchase_id UUID NOT NULL REFERENCES pack_purchases(id),
            status TEXT NOT NULL DEFAULT 'unopened' CHECK (status IN ('unopened','opened')),
            opened_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX pack_instances_user_id_idx ON pack_instances(user_id);
        CREATE INDEX pack_instances_pack_id_idx ON pack_instances(pack_id);
        CREATE INDEX pack_instances_purchase_id_idx ON pack_instances(pack_purchase_id);

        CREATE TABLE pack_openings (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            pack_instance_id UUID NOT NULL UNIQUE REFERENCES pack_instances(id),
            stage TEXT NOT NULL DEFAULT 'ready' CHECK (
                stage IN ('ready','reveal','cards-ready','preview','grid','scratch','complete')
            ),
            card_index INTEGER NOT NULL DEFAULT 0,
            foil_face_url TEXT,
            foil_label TEXT,
            diamond_cost INTEGER NOT NULL DEFAULT 0,
            completed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE pack_opening_cards (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            opening_id UUID NOT NULL REFERENCES pack_openings(id),
            slot_index INTEGER NOT NULL,
            card_kind TEXT NOT NULL CHECK (card_kind IN ('motion','photo')),
            card_id TEXT NOT NULL,
            photo_slot_id TEXT,
            rarity TEXT NOT NULL CHECK (rarity IN ('Rare','Super Rare','Ultra Rare')),
            reward_diamonds INTEGER NOT NULL DEFAULT 0,
            face_url TEXT,
            reveal_status TEXT NOT NULL DEFAULT 'unscratched' CHECK (
                reveal_status IN ('unscratched','scratch-in-progress','revealed')
            ),
            revealed_at TIMESTAMPTZ
        );
        CREATE INDEX pack_opening_cards_opening_idx ON pack_opening_cards(opening_id, slot_index);
        CREATE INDEX pack_opening_cards_card_id_idx ON pack_opening_cards(card_id);

        CREATE TABLE user_cards (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id),
            card_kind TEXT NOT NULL CHECK (card_kind IN ('motion','photo')),
            card_id TEXT NOT NULL,
            photo_slot_id TEXT,
            model_id TEXT,
            theme_id TEXT,
            rarity TEXT,
            first_acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            duplicates INTEGER NOT NULL DEFAULT 0,
            seen_at TIMESTAMPTZ,
            source_opening_card_id UUID REFERENCES pack_opening_cards(id),
            CONSTRAINT user_cards_unique_owned UNIQUE (user_id, card_kind, card_id, photo_slot_id)
        );
        CREATE INDEX user_cards_user_model_idx ON user_cards(user_id, model_id);

        CREATE TABLE scratch_sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id),
            user_card_id UUID NOT NULL REFERENCES user_cards(id),
            reveal_pct REAL NOT NULL DEFAULT 0,
            symbols_found JSONB,
            claimed_reward_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX scratch_sessions_user_id_idx ON scratch_sessions(user_id);
        CREATE INDEX scratch_sessions_user_card_id_idx ON scratch_sessions(user_card_id);

        CREATE TABLE game_sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id),
            model_id TEXT NOT NULL,
            phase TEXT NOT NULL CHECK (phase IN ('motion','photo_reveal','photo','done')),
            motion_card_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            themes JSONB NOT NULL DEFAULT '[]'::jsonb,
            completed_motion_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            photo_prize_total INTEGER NOT NULL DEFAULT 0,
            won_photo_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            completed_photo_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            diamond_total INTEGER NOT NULL DEFAULT 0,
            wallet_credited BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX game_sessions_user_model_idx ON game_sessions(user_id, model_id);

        CREATE TABLE daily_reward_claims (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id),
            claim_date DATE NOT NULL,
            day_index INTEGER NOT NULL DEFAULT 1,
            diamonds INTEGER NOT NULL DEFAULT 10,
            coins INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT daily_reward_claims_user_date_uq UNIQUE (user_id, claim_date)
        );

        CREATE TABLE redeem_codes (
            code TEXT PRIMARY KEY,
            reward_kind TEXT NOT NULL CHECK (reward_kind IN ('diamonds','free_pack')),
            diamonds INTEGER NOT NULL DEFAULT 0,
            pack_id TEXT,
            max_redemptions INTEGER,
            redemption_count INTEGER NOT NULL DEFAULT 0,
            expires_at TIMESTAMPTZ,
            active BOOLEAN NOT NULL DEFAULT TRUE
        );

        CREATE TABLE redeem_redemptions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id),
            code TEXT NOT NULL REFERENCES redeem_codes(code),
            reward JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT redeem_redemptions_user_code_uq UNIQUE (user_id, code)
        );

        CREATE TABLE inbox_messages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID REFERENCES users(id),
            type TEXT NOT NULL CHECK (type IN ('creator_drop','limited_expiring','account_system','payment_failure')),
            title TEXT NOT NULL,
            subtitle TEXT NOT NULL DEFAULT '',
            thumbnail JSONB,
            cta JSONB,
            creator_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ
        );
        CREATE INDEX inbox_messages_user_created_idx ON inbox_messages(user_id, created_at);

        CREATE TABLE inbox_reads (
            user_id UUID NOT NULL REFERENCES users(id),
            message_id UUID NOT NULL REFERENCES inbox_messages(id),
            read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (user_id, message_id)
        );
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP TABLE IF EXISTS inbox_reads;
        DROP TABLE IF EXISTS inbox_messages;
        DROP TABLE IF EXISTS redeem_redemptions;
        DROP TABLE IF EXISTS redeem_codes;
        DROP TABLE IF EXISTS daily_reward_claims;
        DROP TABLE IF EXISTS game_sessions;
        DROP TABLE IF EXISTS scratch_sessions;
        DROP TABLE IF EXISTS user_cards;
        DROP TABLE IF EXISTS pack_opening_cards;
        DROP TABLE IF EXISTS pack_openings;
        DROP TABLE IF EXISTS pack_instances;
        DROP TABLE IF EXISTS pack_purchases;
        DROP TABLE IF EXISTS packs;
        DROP TABLE IF EXISTS store_purchases;
        DROP TABLE IF EXISTS store_products;
        DROP TABLE IF EXISTS wallet_transactions;
        DROP TABLE IF EXISTS wallets;
        DROP TABLE IF EXISTS user_creator_prefs;
        DROP TABLE IF EXISTS email_tokens;
        DROP TABLE IF EXISTS sessions;
        DROP TABLE IF EXISTS users;
        """
    )
