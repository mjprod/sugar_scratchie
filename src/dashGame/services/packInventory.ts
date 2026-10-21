/**
 * Persistent pack ownership. Purchase creates unopened instances immediately;
 * Tear Completion is the only path to opened (cards live in readyToScratch).
 */
import { apiFetch } from "../lib/api";
import { isDemoMode } from "../lib/demo";
import { resolveInventoryCoverUrl } from "../lib/photos";
import type { UnopenedPack } from "./collection";
import type { PackInstanceApi } from "./purchase";

export type PackStatus = "unopened" | "opened";

export type OwnedPackInstance = {
  instanceId: string;
  catalogPackId: string;
  packName: string;
  creator: string;
  creatorId: string;
  themeName: string;
  coverUrl: string;
  status: PackStatus;
  purchaseId: string;
  savedAt: number;
};

const KEY = "sugar.v8.packInventory";

/** Client/demo inventory rows — not issued by POST /api/packs/.../purchase. */
export function isLocalPackInstanceId(instanceId: string): boolean {
  const id = instanceId.trim();
  return id.startsWith("pack-") || id.startsWith("demo-pack-");
}

/**
 * Retired prototype catalog ids (ep1 "Neon Rain" and the other fixture packs).
 * They are not in GET /api/packs, but older accounts still have them owned.
 */
const RETIRED_CATALOG_PACK_IDS = new Set([
  "ep1",
  "ep2",
  "ep3",
  "en1",
  "en2",
  "em1",
  "eb1",
  "eb2",
  "al1",
  "al2",
  "sw1",
  "nl1",
  "nl2",
  "np1",
  "aa1",
  "jp1",
  "jg1",
  "jf1",
]);

export function isRetiredCatalogPackId(
  catalogPackId: string | null | undefined,
): boolean {
  return RETIRED_CATALOG_PACK_IDS.has((catalogPackId ?? "").trim().toLowerCase());
}

function readAll(): OwnedPackInstance[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const packs = parsed.filter(isValid);
    const live = packs.filter((pack) => !isRetiredCatalogPackId(pack.catalogPackId));
    if (live.length !== packs.length) writeAll(live);
    return live;
  } catch {
    return [];
  }
}

function writeAll(packs: OwnedPackInstance[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(packs));
  } catch {
    /* storage unavailable */
  }
}

function isValid(value: unknown): value is OwnedPackInstance {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<OwnedPackInstance>;
  return (
    typeof data.instanceId === "string" &&
    typeof data.catalogPackId === "string" &&
    typeof data.packName === "string" &&
    typeof data.creator === "string" &&
    typeof data.purchaseId === "string" &&
    (data.status === "unopened" || data.status === "opened")
  );
}

function slugId(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, "-") || "creator";
}

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** True when this purchaseId already created inventory (duplicate prevention). */
export function purchaseAlreadyOwned(purchaseId: string) {
  return readAll().some((pack) => pack.purchaseId === purchaseId);
}

/**
 * Persist N unopened packs for a successful purchase.
 * No-ops (returns existing) if purchaseId was already processed.
 */
export function addUnopenedFromPurchase(input: {
  purchaseId: string;
  catalogPackId: string;
  packName: string;
  creator: string;
  count: number;
  coverUrl?: string;
  themeName?: string;
}): OwnedPackInstance[] {
  if (input.count < 1) return [];
  const existing = readAll();
  if (existing.some((pack) => pack.purchaseId === input.purchaseId)) {
    return existing.filter(
      (pack) =>
        pack.purchaseId === input.purchaseId && pack.status === "unopened",
    );
  }

  const coverUrl = resolveInventoryCoverUrl({
    coverUrl: input.coverUrl,
    packId: input.catalogPackId,
    themeName: input.themeName ?? input.packName,
    creator: input.creator,
  });
  const creatorId = slugId(input.creator);
  const themeName = input.themeName ?? input.packName;
  const created: OwnedPackInstance[] = Array.from(
    { length: input.count },
    () => ({
      instanceId: newId("pack"),
      catalogPackId: input.catalogPackId,
      packName: input.packName,
      creator: input.creator,
      creatorId,
      themeName,
      coverUrl,
      status: "unopened",
      purchaseId: input.purchaseId,
      savedAt: Date.now(),
    }),
  );

  writeAll([...created, ...existing]);
  return created;
}

function apiInstanceToOwned(instance: PackInstanceApi): OwnedPackInstance {
  const creatorId =
    instance.creatorId?.trim() || slugId(instance.creator);
  const themeName = instance.themeName || instance.packName;
  return {
    instanceId: instance.instanceId,
    catalogPackId: instance.catalogPackId,
    packName: instance.packName,
    creator: instance.creator,
    creatorId,
    themeName,
    coverUrl: resolveInventoryCoverUrl({
      coverUrl: instance.coverUrl,
      packId: instance.catalogPackId,
      themeName,
      creator: instance.creator,
    }),
    status: instance.status === "opened" ? "opened" : "unopened",
    purchaseId: instance.purchaseId,
    savedAt: instance.savedAt || Date.now(),
  };
}

/**
 * Persist server-issued pack instances from a purchase or open response.
 * Inserts new rows ahead of existing inventory; updates known instanceIds in place
 * (e.g. unopened → opened after POST /api/me/packs/:id/open).
 */
export function upsertInstancesFromApi(
  instances: PackInstanceApi[],
): OwnedPackInstance[] {
  if (!instances.length) return [];
  const existing = readAll();
  const indexById = new Map(
    existing.map((pack, index) => [pack.instanceId, index]),
  );
  const touched: OwnedPackInstance[] = [];
  const prepended: OwnedPackInstance[] = [];
  const updated = [...existing];
  let changed = false;

  for (const instance of instances) {
    if (isRetiredCatalogPackId(instance.catalogPackId)) continue;
    const owned = apiInstanceToOwned(instance);
    touched.push(owned);
    const index = indexById.get(owned.instanceId);
    if (index === undefined) {
      prepended.push(owned);
      changed = true;
      continue;
    }
    if (updated[index] !== owned) {
      updated[index] = owned;
      changed = true;
    }
  }

  if (changed) {
    writeAll([...prepended, ...updated]);
  }
  return touched;
}

/** Replace local inventory with the server list (server wins). */
export function replaceInventoryFromApi(
  instances: PackInstanceApi[],
): OwnedPackInstance[] {
  const owned = instances
    .filter((instance) => !isRetiredCatalogPackId(instance.catalogPackId))
    .map(apiInstanceToOwned);
  writeAll(owned);
  return owned;
}

/**
 * Hydrate pack inventory from GET /api/me/packs.
 * Returns false when demo mode, unauthenticated, or API unreachable — keeps last cache.
 * Optional beforeWrite runs after fetch; skip persisting when it returns false (stale auth).
 */
export async function syncMyPacks(options?: {
  beforeWrite?: () => boolean;
}): Promise<boolean> {
  if (isDemoMode()) return false;
  const data = await apiFetch<{ packs: PackInstanceApi[] }>("/api/me/packs");
  if (!data?.packs) return false;
  if (options?.beforeWrite && !options.beforeWrite()) return false;
  replaceInventoryFromApi(data.packs);
  return true;
}

/** All owned pack instances (unopened + opened). */
export function listOwnedPacks(): OwnedPackInstance[] {
  return readAll();
}

export function countOwnedPacks(): number {
  return readAll().length;
}

export function getPackInstance(instanceId: string): OwnedPackInstance | null {
  return readAll().find((pack) => pack.instanceId === instanceId) ?? null;
}

export function listUnopenedInstances(): OwnedPackInstance[] {
  return readAll().filter((pack) => pack.status === "unopened");
}

/** Group unopened packs for My Collection (catalog + theme). */
export function listUnopenedGroups(): UnopenedPack[] {
  const groups = new Map<string, UnopenedPack & { instanceIds: string[] }>();
  for (const pack of listUnopenedInstances()) {
    const key = `${pack.catalogPackId}::${pack.themeName}::${pack.creatorId}`;
    const current = groups.get(key);
    if (current) {
      current.count += 1;
      current.instanceIds.push(pack.instanceId);
      continue;
    }
    groups.set(key, {
      id: key,
      name: pack.themeName,
      creator: pack.creator,
      creatorId: pack.creatorId,
      count: 1,
      coverUrl: resolveInventoryCoverUrl({
        coverUrl: pack.coverUrl,
        packId: pack.catalogPackId,
        themeName: pack.themeName,
        creator: pack.creator,
      }),
      catalogPackId: pack.catalogPackId,
      instanceIds: [pack.instanceId],
    });
  }
  return [...groups.values()].map(({ instanceIds: _, ...group }) => group);
}

/** First unopened instance for a bag group id (or catalog pack id). */
export function peekUnopenedInstance(
  groupOrCatalogId: string,
): OwnedPackInstance | null {
  const unopened = listUnopenedInstances();
  const byGroup = unopened.find((pack) => {
    const key = `${pack.catalogPackId}::${pack.themeName}::${pack.creatorId}`;
    return key === groupOrCatalogId || pack.catalogPackId === groupOrCatalogId;
  });
  return byGroup ?? null;
}

/** Newest unopened instance for a catalog pack id (e.g. after redeem). */
export function peekNewestUnopenedInstance(
  catalogPackId: string,
): OwnedPackInstance | null {
  const matches = listUnopenedInstances().filter(
    (pack) => pack.catalogPackId === catalogPackId,
  );
  if (!matches.length) return null;
  return matches.reduce((latest, pack) =>
    pack.savedAt >= latest.savedAt ? pack : latest,
  );
}

export function countUnopened(): number {
  return listUnopenedInstances().length;
}

/** Tear Completion boundary — pack never returns to unopened. */
export function markPackOpened(instanceId: string): OwnedPackInstance | null {
  const packs = readAll();
  const index = packs.findIndex((pack) => pack.instanceId === instanceId);
  if (index === -1) return null;
  if (packs[index].status === "opened") return packs[index];
  packs[index] = {
    ...packs[index],
    status: "opened",
    savedAt: Date.now(),
  };
  writeAll(packs);
  return packs[index];
}

export function nextUnopenedInPurchase(
  purchaseId: string,
): OwnedPackInstance | null {
  return (
    listUnopenedInstances().find((pack) => pack.purchaseId === purchaseId) ??
    null
  );
}

export function clearPackInventory() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
