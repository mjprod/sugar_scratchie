from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, INET, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.db.base import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("auth_provider IN ('google','apple','email')", name="users_auth_provider_chk"),
        CheckConstraint(
            "gender_interest IS NULL OR gender_interest IN ('male','female','both')",
            name="users_gender_interest_chk",
        ),
        CheckConstraint("status IN ('active','banned','deleted')", name="users_status_chk"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(CITEXT, unique=True, nullable=False)
    password_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    auth_provider: Mapped[str] = mapped_column(Text, nullable=False, default="email")
    provider_subject: Mapped[str | None] = mapped_column(Text, nullable=True)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    username: Mapped[str | None] = mapped_column(Text, unique=True, nullable=True)
    display_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    gender_interest: Mapped[str | None] = mapped_column(Text, nullable=True)
    referral_code: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    referred_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    home_tutorial_done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    recommendation_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    welcome_claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    wallet: Mapped[Wallet | None] = relationship(back_populates="user", uselist=False)


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip: Mapped[str | None] = mapped_column(INET, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class EmailToken(Base):
    __tablename__ = "email_tokens"
    __table_args__ = (
        CheckConstraint("kind IN ('verify_email','reset_password')", name="email_tokens_kind_chk"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class UserCreatorPref(Base):
    __tablename__ = "user_creator_prefs"
    __table_args__ = (
        CheckConstraint("stance IN ('liked','passed')", name="user_creator_prefs_stance_chk"),
        CheckConstraint("source IN ('feed','onboarding_swipe')", name="user_creator_prefs_source_chk"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), primary_key=True)
    model_id: Mapped[str] = mapped_column(Text, primary_key=True)
    stance: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False, default="feed")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class Wallet(Base):
    __tablename__ = "wallets"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), primary_key=True)
    diamonds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    coins: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)

    user: Mapped[User] = relationship(back_populates="wallet")


class WalletTransaction(Base):
    __tablename__ = "wallet_transactions"
    __table_args__ = (
        CheckConstraint("currency IN ('diamonds','coins')", name="wallet_tx_currency_chk"),
        CheckConstraint(
            "reason IN ('welcome_bonus','store_purchase','pack_purchase','pack_reward','scratch_reward','daily_reward','redeem_code','refund','admin_adjust')",
            name="wallet_tx_reason_chk",
        ),
        UniqueConstraint("idempotency_key", name="wallet_tx_idempotency_key_uq"),
        Index("wallet_tx_user_created_idx", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    currency: Mapped[str] = mapped_column(Text, nullable=False)
    delta: Mapped[int] = mapped_column(BigInteger, nullable=False)
    balance_after: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    ref_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    ref_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class StoreProduct(Base):
    __tablename__ = "store_products"
    __table_args__ = (
        CheckConstraint("kind IN ('rewarded-ad','diamonds')", name="store_products_kind_chk"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    subtitle: Mapped[str | None] = mapped_column(Text, nullable=True)
    price_label: Mapped[str] = mapped_column(Text, nullable=False)
    price_amount_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    currency: Mapped[str] = mapped_column(Text, nullable=False, default="USD")
    diamonds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    coins: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    badge: Mapped[str | None] = mapped_column(Text, nullable=True)
    artwork_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Theme(Base):
    """Admin catalog of motion-card / photo-scratch themes (metadata only; intros stay on disk)."""

    __tablename__ = "themes"
    __table_args__ = (Index("themes_sort_order_idx", "sort_order"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)
    card_overlay_color_start: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_overlay_color_end: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_light_color_1: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_light_color_2: Mapped[str | None] = mapped_column(Text, nullable=True)


class Creator(Base):
    """Admin catalog of creators / models (metadata only; avatars/flags/videos stay on disk)."""

    __tablename__ = "models"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)
    influencer_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    influencer_city: Mapped[str | None] = mapped_column(Text, nullable=True)
    influencer_country: Mapped[str | None] = mapped_column(Text, nullable=True)
    influencer_flag: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_overlay_color_start: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_overlay_color_end: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_light_color_1: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_light_color_2: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_pack_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    card_pack_name_2: Mapped[str | None] = mapped_column(Text, nullable=True)
    tags: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)


class MotionCard(Base):
    """Admin catalog of motion cards (metadata only; videos/mesh/photos stay on disk)."""

    __tablename__ = "cards"
    __table_args__ = (Index("cards_model_sort_idx", "model_id", "sort_order"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    model_id: Mapped[str | None] = mapped_column(Text, ForeignKey("models.id", ondelete="CASCADE"), nullable=True)
    theme_id: Mapped[str | None] = mapped_column(Text, ForeignKey("themes.id", ondelete="SET NULL"), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    photos: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class PhotoScratchCard(Base):
    """Published photo-scratch game entries (metadata + media URLs; files stay on disk)."""

    __tablename__ = "photo_scratch_cards"
    __table_args__ = (
        CheckConstraint("slot_id ~ '^slot_[0-9]{2}$'", name="photo_scratch_cards_slot_chk"),
        UniqueConstraint("card_id", "slot_id", name="photo_scratch_cards_card_slot_uq"),
        Index("photo_scratch_cards_card_idx", "card_id"),
        Index("photo_scratch_cards_sort_idx", "sort_order"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    card_id: Mapped[str] = mapped_column(Text, ForeignKey("cards.id", ondelete="CASCADE"), nullable=False)
    slot_id: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    model_id: Mapped[str | None] = mapped_column(Text, ForeignKey("models.id", ondelete="SET NULL"), nullable=True)
    theme_id: Mapped[str | None] = mapped_column(Text, ForeignKey("themes.id", ondelete="SET NULL"), nullable=True)
    background: Mapped[str] = mapped_column(Text, nullable=False)
    bikini: Mapped[str] = mapped_column(Text, nullable=False)
    clothes: Mapped[str] = mapped_column(Text, nullable=False)
    mesh: Mapped[str] = mapped_column(Text, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class SymbolGroup(Base):
    """Named pack of 12 match-game symbols; one row is the global default."""

    __tablename__ = "symbol_groups"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class Symbol(Base):
    """Admin catalog of match-game symbols (metadata only; .lottie files stay on disk)."""

    __tablename__ = "symbols"
    __table_args__ = (
        CheckConstraint("id ~ '^(0[1-9]|1[0-2])$'", name="symbols_id_chk"),
        Index("symbols_group_id_idx", "group_id"),
    )

    group_id: Mapped[str] = mapped_column(
        Text, ForeignKey("symbol_groups.id", ondelete="CASCADE"), primary_key=True
    )
    id: Mapped[str] = mapped_column(Text, primary_key=True)
    file: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class StorePurchase(Base):
    __tablename__ = "store_purchases"
    __table_args__ = (
        CheckConstraint(
            "gateway_outcome IS NULL OR gateway_outcome IN ('completed','cancelled','closed','failed','pending')",
            name="store_purchases_gateway_outcome_chk",
        ),
        CheckConstraint(
            "verified_status IS NULL OR verified_status IN ('confirmed','pending','failed','cancelled')",
            name="store_purchases_verified_status_chk",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    product_id: Mapped[str] = mapped_column(Text, ForeignKey("store_products.id"), nullable=False)
    price_label: Mapped[str] = mapped_column(Text, nullable=False)
    diamonds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    coins: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    gateway: Mapped[str | None] = mapped_column(Text, nullable=True)
    gateway_outcome: Mapped[str | None] = mapped_column(Text, nullable=True)
    verified_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    gateway_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    credited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class Pack(Base):
    __tablename__ = "packs"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    model_id: Mapped[str | None] = mapped_column(Text, nullable=True, index=True)
    theme_id: Mapped[str | None] = mapped_column(Text, nullable=True, index=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    pack_title: Mapped[str] = mapped_column(Text, nullable=False)
    cover_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    diamond_cost: Mapped[int] = mapped_column(Integer, nullable=False, default=80)
    price_amount_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    card_count: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    rarity_weights: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    is_new: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_limited: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_hot: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    accent_colors: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class PackPurchase(Base):
    __tablename__ = "pack_purchases"
    __table_args__ = (UniqueConstraint("idempotency_key", name="pack_purchases_idempotency_key_uq"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    pack_id: Mapped[str] = mapped_column(Text, ForeignKey("packs.id"), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    diamond_cost: Mapped[int] = mapped_column(Integer, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class PackInstance(Base):
    __tablename__ = "pack_instances"
    __table_args__ = (CheckConstraint("status IN ('unopened','opened')", name="pack_instances_status_chk"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    pack_id: Mapped[str] = mapped_column(Text, ForeignKey("packs.id"), nullable=False, index=True)
    pack_purchase_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("pack_purchases.id"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, default="unopened")
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class PackOpening(Base):
    __tablename__ = "pack_openings"
    __table_args__ = (
        CheckConstraint(
            "stage IN ('ready','reveal','cards-ready','preview','grid','scratch','complete')",
            name="pack_openings_stage_chk",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pack_instance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("pack_instances.id"), unique=True, nullable=False
    )
    stage: Mapped[str] = mapped_column(Text, nullable=False, default="ready")
    card_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    foil_face_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    foil_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    diamond_cost: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class PackOpeningCard(Base):
    __tablename__ = "pack_opening_cards"
    __table_args__ = (
        CheckConstraint("card_kind IN ('motion','photo')", name="pack_opening_cards_kind_chk"),
        CheckConstraint(
            "rarity IN ('Rare','Super Rare','Ultra Rare')",
            name="pack_opening_cards_rarity_chk",
        ),
        CheckConstraint(
            "reveal_status IN ('unscratched','scratch-in-progress','revealed')",
            name="pack_opening_cards_reveal_chk",
        ),
        Index("pack_opening_cards_opening_idx", "opening_id", "slot_index"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    opening_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("pack_openings.id"), nullable=False)
    slot_index: Mapped[int] = mapped_column(Integer, nullable=False)
    card_kind: Mapped[str] = mapped_column(Text, nullable=False)
    card_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    photo_slot_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    rarity: Mapped[str] = mapped_column(Text, nullable=False)
    reward_diamonds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    face_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    reveal_status: Mapped[str] = mapped_column(Text, nullable=False, default="unscratched")
    revealed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class UserCard(Base):
    __tablename__ = "user_cards"
    __table_args__ = (
        CheckConstraint("card_kind IN ('motion','photo')", name="user_cards_kind_chk"),
        UniqueConstraint("user_id", "card_kind", "card_id", "photo_slot_id", name="user_cards_unique_owned"),
        Index("user_cards_user_model_idx", "user_id", "model_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    card_kind: Mapped[str] = mapped_column(Text, nullable=False)
    card_id: Mapped[str] = mapped_column(Text, nullable=False)
    photo_slot_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    model_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    theme_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    rarity: Mapped[str | None] = mapped_column(Text, nullable=True)
    first_acquired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    duplicates: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    source_opening_card_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("pack_opening_cards.id"), nullable=True
    )


class ScratchSession(Base):
    __tablename__ = "scratch_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    user_card_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("user_cards.id"), nullable=False, index=True)
    reveal_pct: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    symbols_found: Mapped[Any] = mapped_column(JSONB, nullable=True)
    claimed_reward_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class GameSession(Base):
    __tablename__ = "game_sessions"
    __table_args__ = (
        CheckConstraint(
            "phase IN ('motion','photo_reveal','photo','done')",
            name="game_sessions_phase_chk",
        ),
        Index("game_sessions_user_model_idx", "user_id", "model_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    model_id: Mapped[str] = mapped_column(Text, nullable=False)
    phase: Mapped[str] = mapped_column(Text, nullable=False)
    motion_card_ids: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list)
    themes: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list)
    completed_motion_ids: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list)
    photo_prize_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    won_photo_ids: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list)
    completed_photo_ids: Mapped[Any] = mapped_column(JSONB, nullable=False, default=list)
    diamond_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    wallet_credited: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)


class DailyRewardClaim(Base):
    __tablename__ = "daily_reward_claims"
    __table_args__ = (UniqueConstraint("user_id", "claim_date", name="daily_reward_claims_user_date_uq"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    claim_date: Mapped[date] = mapped_column(Date, nullable=False)
    day_index: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    diamonds: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    coins: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class RedeemCode(Base):
    __tablename__ = "redeem_codes"
    __table_args__ = (CheckConstraint("reward_kind IN ('diamonds','free_pack')", name="redeem_codes_kind_chk"),)

    code: Mapped[str] = mapped_column(Text, primary_key=True)
    reward_kind: Mapped[str] = mapped_column(Text, nullable=False)
    diamonds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    pack_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    max_redemptions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    redemption_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class RedeemRedemption(Base):
    __tablename__ = "redeem_redemptions"
    __table_args__ = (UniqueConstraint("user_id", "code", name="redeem_redemptions_user_code_uq"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    code: Mapped[str] = mapped_column(Text, ForeignKey("redeem_codes.code"), nullable=False)
    reward: Mapped[Any] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class InboxMessage(Base):
    __tablename__ = "inbox_messages"
    __table_args__ = (
        CheckConstraint(
            "type IN ('creator_drop','limited_expiring','account_system','payment_failure')",
            name="inbox_messages_type_chk",
        ),
        Index("inbox_messages_user_created_idx", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    subtitle: Mapped[str] = mapped_column(Text, nullable=False, default="")
    thumbnail: Mapped[Any] = mapped_column(JSONB, nullable=True)
    cta: Mapped[Any] = mapped_column(JSONB, nullable=True)
    creator_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class InboxRead(Base):
    __tablename__ = "inbox_reads"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), primary_key=True)
    message_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("inbox_messages.id"), primary_key=True)
    read_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
