/**
 * Theme Collection Completion Rewards — claim ledger + eligibility.
 * Progress comes from ownership (caller). Claimed state persists locally until
 * a backend reward service replaces this ledger.
 */
export type ThemeRewardStatus = "locked" | "claimable" | "claimed";

export type ThemeCompletionRewardView = {
  id: string;
  themeId: string;
  creatorId: string;
  status: ThemeRewardStatus;
  title: string;
  description: string;
  isMystery: boolean;
  /** Diamonds granted on successful claim. */
  diamondAmount: number;
  claimedAt?: number;
};

type ClaimLedger = {
  claimed: Record<string, number>;
};

const KEY = "sugar.v8.themeCompletionRewards";

/** Default known diamond grant until a reward catalog exists. */
const DEFAULT_DIAMONDS = 50;

/** In-memory fallback when localStorage is missing (tests / private mode). */
let memoryLedger: ClaimLedger | null = null;

/** Clears persisted + memory claim ledger. */
export function clearThemeCompletionRewards() {
  memoryLedger = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Test helper — clears persisted + memory claim ledger. */
export function resetThemeCompletionRewardsForTests() {
  clearThemeCompletionRewards();
}

function emptyLedger(): ClaimLedger {
  return { claimed: {} };
}

function readLedger(): ClaimLedger {
  if (memoryLedger) return memoryLedger;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyLedger();
    const parsed = JSON.parse(raw) as Partial<ClaimLedger>;
    return {
      claimed:
        parsed.claimed && typeof parsed.claimed === "object"
          ? parsed.claimed
          : {},
    };
  } catch {
    return memoryLedger ?? emptyLedger();
  }
}

function writeLedger(ledger: ClaimLedger) {
  memoryLedger = ledger;
  try {
    localStorage.setItem(KEY, JSON.stringify(ledger));
  } catch {
    /* keep memory ledger */
  }
}

export function themeCompletionRewardId(
  creatorId: string,
  themeId: string,
): string {
  return `theme-complete:${creatorId.trim()}:${themeId.trim()}`;
}

export function isThemeCompletionClaimed(
  creatorId: string,
  themeId: string,
): boolean {
  const id = themeCompletionRewardId(creatorId, themeId);
  return Boolean(readLedger().claimed[id]);
}

/** Theme ids already claimed for this creator (`theme-complete:creator:theme`). */
export function listClaimedThemeIdsForCreator(creatorId: string): string[] {
  const prefix = `theme-complete:${creatorId.trim()}:`;
  return Object.keys(readLedger().claimed)
    .filter((id) => id.startsWith(prefix))
    .map((id) => id.slice(prefix.length))
    .filter(Boolean);
}

export function creatorHasAnyThemeCompletionClaim(creatorId: string): boolean {
  return listClaimedThemeIdsForCreator(creatorId).length > 0;
}

/**
 * True when at least one listed theme is complete and still unclaimed.
 * Prefer this over checking a fake `"primary"` theme id.
 */
export function creatorHasClaimableThemeReward(
  creatorId: string,
  themes: readonly { id: string; collected: number; total: number }[],
): boolean {
  return themes.some(
    (theme) =>
      theme.total > 0 &&
      theme.collected >= theme.total &&
      !isThemeCompletionClaimed(creatorId, theme.id),
  );
}

export function resolveThemeRewardStatus(
  collected: number,
  total: number,
  claimed: boolean,
): ThemeRewardStatus {
  if (claimed) return "claimed";
  if (total > 0 && collected >= total) return "claimable";
  return "locked";
}

export function getThemeCompletionReward(input: {
  creatorId: string;
  themeId: string;
  themeName: string;
  collected: number;
  total: number;
}): ThemeCompletionRewardView {
  const id = themeCompletionRewardId(input.creatorId, input.themeId);
  const claimedAt = readLedger().claimed[id];
  const claimed = typeof claimedAt === "number";
  const status = resolveThemeRewardStatus(
    input.collected,
    input.total,
    claimed,
  );
  const theme = input.themeName.trim() || "Theme";
  return {
    id,
    themeId: input.themeId,
    creatorId: input.creatorId,
    status,
    title: `${theme} Completion Reward`,
    description:
      status === "claimed"
        ? "Reward Claimed"
        : status === "claimable"
          ? "Claim your exclusive Theme Reward"
          : "Complete the collection to unlock the reward.",
    isMystery: false,
    diamondAmount: DEFAULT_DIAMONDS,
    claimedAt: claimed ? claimedAt : undefined,
  };
}

export type ClaimThemeRewardResult =
  | { ok: true; alreadyClaimed: boolean; diamondAmount: number }
  | { ok: false; message: string };

/**
 * Idempotent claim. Persists claimed state before returning success so a
 * retry after a partial grant cannot double-issue.
 */
export function claimThemeCompletionReward(input: {
  creatorId: string;
  themeId: string;
  themeName: string;
  collected: number;
  total: number;
}): ClaimThemeRewardResult {
  const reward = getThemeCompletionReward(input);
  if (reward.status === "claimed") {
    return {
      ok: true,
      alreadyClaimed: true,
      diamondAmount: 0,
    };
  }
  if (reward.status !== "claimable") {
    return {
      ok: false,
      message: "Complete the collection before claiming this reward.",
    };
  }

  const ledger = readLedger();
  if (ledger.claimed[reward.id]) {
    return { ok: true, alreadyClaimed: true, diamondAmount: 0 };
  }
  ledger.claimed[reward.id] = Date.now();
  writeLedger(ledger);

  return {
    ok: true,
    alreadyClaimed: false,
    diamondAmount: reward.diamondAmount,
  };
}
