import { Badge, Button, Flex, Select, Text, TextField } from "@radix-ui/themes";
import { useEffect, useState } from "react";
import { CARD_PRICE_MAX, type CardPricing, type CardTier } from "./shared/models";

const TIER_LABELS: Record<CardTier, string> = {
  standard: "Standard",
  premium: "Premium (1 per theme)",
  ultra: "Ultra (1 per model)",
};

const TIER_BADGE_COLORS: Record<CardTier, "gray" | "amber" | "purple"> = {
  standard: "gray",
  premium: "amber",
  ultra: "purple",
};

const PRICE_FIELD_WIDTH = 92;

type PriceKey = "price" | "replay_price" | "max_win";

type Draft = { tier: CardTier } & Record<PriceKey, string>;

function toDraft(pricing: CardPricing): Draft {
  return {
    tier: pricing.tier,
    price: String(pricing.price),
    replay_price: String(pricing.replay_price),
    max_win: String(pricing.max_win),
  };
}

function parseDiamonds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed <= CARD_PRICE_MAX ? parsed : null;
}

function PriceField({
  busy,
  label,
  value,
  onChange,
}: {
  busy: boolean;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <Text as="div" color="gray" size="1">
        {label}
      </Text>
      <TextField.Root
        disabled={busy}
        inputMode="numeric"
        size="1"
        style={{ width: PRICE_FIELD_WIDTH }}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <TextField.Slot side="right">💎</TextField.Slot>
      </TextField.Root>
    </label>
  );
}

/** Tier + diamond prices for one published motion card. */
export function CardPricingControl({
  busy,
  pricing,
  onSave,
}: {
  busy: boolean;
  pricing: CardPricing;
  onSave: (pricing: CardPricing) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(pricing));

  useEffect(() => {
    setDraft(toDraft(pricing));
  }, [pricing.tier, pricing.price, pricing.replay_price, pricing.max_win]);

  const isTiered = draft.tier !== "standard";
  // Standard cards have no replay price or max win; hidden drafts must not leak into the save.
  const parsed = {
    price: parseDiamonds(draft.price),
    replay_price: isTiered ? parseDiamonds(draft.replay_price) : 0,
    max_win: isTiered ? parseDiamonds(draft.max_win) : 0,
  };
  const valid = parsed.price !== null && parsed.replay_price !== null && parsed.max_win !== null;
<<<<<<< Updated upstream
const dirty =
  draft.tier !== pricing.tier ||
  draft.price.trim() !== String(pricing.price) ||
  draft.replay_price.trim() !== String(pricing.replay_price) ||
  draft.max_win.trim() !== String(pricing.max_win);
  const isTiered = draft.tier !== "standard";
=======
  const dirty =
    draft.tier !== pricing.tier ||
    parsed.price !== pricing.price ||
    parsed.replay_price !== pricing.replay_price ||
    parsed.max_win !== pricing.max_win;
>>>>>>> Stashed changes

  function setField(key: PriceKey, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <Flex align="end" gap="2" wrap="wrap">
      <label>
        <Text as="div" color="gray" size="1">
          Tier
        </Text>
        <Select.Root
          disabled={busy}
          size="1"
          value={draft.tier}
          onValueChange={(value) => { const tier = value as CardTier; setDraft((current) => (tier === "standard" ? { ...current, tier, replay_price: "0", max_win: "0" } : { ...current, tier })); }}
        >
          <Select.Trigger />
          <Select.Content>
            {(Object.keys(TIER_LABELS) as CardTier[]).map((tier) => (
              <Select.Item key={tier} value={tier}>
                {TIER_LABELS[tier]}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </label>
      <PriceField
        busy={busy}
        label={isTiered ? "Unlock price" : "Price"}
        value={draft.price}
        onChange={(value) => setField("price", value)}
      />
      {isTiered ? (
        <>
          <PriceField
            busy={busy}
            label="Replay price"
            value={draft.replay_price}
            onChange={(value) => setField("replay_price", value)}
          />
          <PriceField
            busy={busy}
            label="Max win"
            value={draft.max_win}
            onChange={(value) => setField("max_win", value)}
          />
        </>
      ) : null}
      <Button
        disabled={busy || !dirty || !valid}
        size="1"
        onClick={() =>
          onSave({
            tier: draft.tier,
            price: parsed.price ?? 0,
            replay_price: parsed.replay_price ?? 0,
            max_win: parsed.max_win ?? 0,
          })
        }
      >
        Save pricing
      </Button>
      {!valid ? (
        <Text color="red" size="1">
          Whole diamonds only
        </Text>
      ) : dirty ? (
        <Text color="gray" size="1">
          Unsaved
        </Text>
      ) : null}
    </Flex>
  );
}

export function CardTierBadge({ tier }: { tier: CardTier | undefined }) {
  if (!tier || tier === "standard") return null;
  return (
    <Badge color={TIER_BADGE_COLORS[tier]} size="1" variant="soft">
      {tier}
    </Badge>
  );
}
