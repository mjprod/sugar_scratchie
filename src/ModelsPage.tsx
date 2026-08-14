import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Gamepad2,
  Home,
  Images,
  Import,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Container,
  Dialog,
  Flex,
  Grid,
  Heading,
  Popover,
  Select,
  Table,
  Text,
  TextField,
} from "@radix-ui/themes";
import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "./shared/api";
import {
  COUNTRY_FLAG_OPTIONS,
  countryFlagSvgUrl,
  fetchCountryFlagFile,
} from "./shared/countryFlags";
import { suggestCardId } from "./shared/groupCards";
import { inferThemeFromLabel, themeKey } from "./game/session";
import {
  assignCardToModel,
  createModel,
  createMotionCardDraft,
  deleteCard,
  deleteModel,
  deleteModelFlagSvg,
  fetchModels,
  fetchPhotoScratchSlots,
  photoScratchPlayHref,
  publishPhotoScratchGame,
  reorderModelCards,
  updateModel,
  uploadCardTrailer,
  uploadModelAvatar,
  uploadModelFlagSvg,
  uploadModelThemeAvatar,
  uploadModelVideo,
  type ModelInfo,
  type ModelVideoKind,
  type PhotoInfo,
  type PhotoScratchSlot,
} from "./shared/models";
import { fetchThemes, uploadThemeIntro, type ThemeInfo } from "./shared/themes";
import {
  labelFromProjectId,
  PROJECT_ID_PATTERN,
  slugifyProjectId,
  type VideoFlowProject,
} from "./videoFlow/projects";
import { previewSource } from "./videoFlow/ui";

type CardInfo = {
  id: string;
  label: string;
  model_id?: string | null;
  sort_order?: number;
  /** Workspace-relative or public path to background.mp4 (from /api/cards). */
  background?: string;
  /** Workspace-relative or public path to foreground.mp4 (from /api/cards). */
  foreground?: string;
  photos?: PhotoInfo[];
  /** Slots with 3 layers + per-slot photo mesh + symbols. */
  photo_scratch_done?: number;
  /** Slots with any layer present but not fully done. */
  photo_scratch_draft?: number;
  /** Slots that have a photo-scratch mesh.json (not motion-card). */
  photo_scratch_mesh_count?: number;
  /** Slots that have 12 symbol points on their photo mesh. */
  photo_scratch_symbols_count?: number;
  /** True when this row is a Video Flow draft that has not been published as a card yet. */
  draft?: boolean;
  /** Theme from the card's Video Flow draft (scenery + costume), when one exists. */
  theme?: string;
  /** Catalog theme id persisted on card meta (e.g. "police"). */
  theme_id?: string | null;
  /** Collection trailer preview URL when uploaded. */
  trailer?: string | null;
};

function slotLayersComplete(slot: PhotoScratchSlot): boolean {
  return Boolean(slot.background && slot.bikini && slot.clothes);
}

function slotHasAnyLayer(slot: PhotoScratchSlot): boolean {
  return Boolean(
    slot.background ||
      slot.bikini ||
      slot.clothes ||
      slot.pending_bg ||
      slot.pending_bikini ||
      slot.pending_clothes,
  );
}

function slotIsDone(slot: PhotoScratchSlot): boolean {
  return Boolean(
    slotLayersComplete(slot) &&
      slot.has_match &&
      slot.has_cutout &&
      slot.has_zoom &&
      slot.mesh &&
      slot.has_symbols,
  );
}

function photoScratchCountsFromSlots(slots: PhotoScratchSlot[]): {
  photo_scratch_done: number;
  photo_scratch_draft: number;
  photo_scratch_mesh_count: number;
  photo_scratch_symbols_count: number;
} {
  let done = 0;
  let draft = 0;
  let mesh = 0;
  let symbols = 0;
  for (const slot of slots) {
    if (slot.mesh) mesh += 1;
    if (slot.has_symbols) symbols += 1;
    if (!slotHasAnyLayer(slot)) continue;
    if (slotIsDone(slot)) done += 1;
    else draft += 1;
  }
  return {
    photo_scratch_done: done,
    photo_scratch_draft: draft,
    photo_scratch_mesh_count: mesh,
    photo_scratch_symbols_count: symbols,
  };
}

const iconProps = { size: 16, strokeWidth: 2 } as const;

function playCardHref(modelId: string, cardId: string): string {
  return `/?model=${encodeURIComponent(modelId)}&card=${encodeURIComponent(cardId)}`;
}

function playAllHref(modelId: string): string {
  return `/?model=${encodeURIComponent(modelId)}`;
}

function editCardHref(cardId: string): string {
  return `/dashboard/video-flow/run?card=${encodeURIComponent(cardId)}`;
}

function pictureFlowHref(cardId: string, slotId?: string): string {
  const base = `/dashboard/picture-flow?card=${encodeURIComponent(cardId)}`;
  return slotId ? `${base}&slot=${encodeURIComponent(slotId)}` : base;
}

function slotThumbSrc(slot: PhotoScratchSlot): string {
  // Prefer the dressed full-scene plate over cutouts / bikini-only.
  return (
    slot.clothes ||
    slot.pending_clothes ||
    slot.bikini ||
    slot.pending_bikini ||
    slot.background ||
    slot.pending_bg ||
    slot.clothes_cutout ||
    slot.bikini_cutout ||
    ""
  );
}

type SlotPreviewLayers = {
  background: string;
  bikini: string;
  clothes: string;
};

function slotPreviewLayers(slot: PhotoScratchSlot): SlotPreviewLayers {
  const background = previewSource(slot.background || slot.pending_bg || "");
  // RGBA cutouts need the room underneath to read as a full picture.
  if (slot.clothes_cutout || slot.bikini_cutout) {
    return {
      background,
      bikini: previewSource(slot.bikini_cutout || ""),
      clothes: previewSource(slot.clothes_cutout || ""),
    };
  }
  // Full-scene plates (pending JPGs) already include background + girl.
  const clothes = previewSource(slot.clothes || slot.pending_clothes || "");
  if (clothes) return { background: "", bikini: "", clothes };
  const bikini = previewSource(slot.bikini || slot.pending_bikini || "");
  if (bikini) return { background: "", bikini, clothes: "" };
  return { background, bikini: "", clothes: "" };
}

function slotHasPreview(layers: SlotPreviewLayers): boolean {
  return Boolean(layers.background || layers.bikini || layers.clothes);
}

function motionCardVideoSrc(card: CardInfo): string {
  // Prefer foreground (the moving performer) for the motion-card miniature.
  const raw = card.foreground?.trim() || card.background?.trim() || "";
  return raw ? previewSource(raw) : "";
}

function modelDetailHref(modelId: string): string {
  return `/dashboard/models?model=${encodeURIComponent(modelId)}`;
}

function readSelectedModelId(): string {
  return new URLSearchParams(window.location.search).get("model")?.trim() ?? "";
}

function modelInitial(label: string, id: string): string {
  const source = (label.trim() || id.trim() || "?").charAt(0);
  return source.toLowerCase();
}

function modelDisplayTitle(model: ModelInfo): string {
  return model.influencerName?.trim() || model.label;
}

/** Plain-text title with emoji flag for selects / strings (no SVG). */
function modelDisplayTitleWithFlag(model: ModelInfo): string {
  const name = modelDisplayTitle(model);
  if (model.influencerFlagSvg) return name;
  const flag = model.influencerFlag?.trim();
  return flag ? `${flag} ${name}` : name;
}

function modelLocationLine(model: ModelInfo): string {
  const city = model.influencerCity?.trim() ?? "";
  const country = model.influencerCountry?.trim() ?? "";
  if (city && country) return `${city}, ${country}`;
  return city || country;
}

function parseTagInput(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(",")) {
    const tag = part.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function formatTagsInput(tags: string[] | null | undefined): string {
  return (tags ?? []).join(", ");
}

function modelTags(model: ModelInfo): string[] {
  return model.tags ?? [];
}

const PRESET_MODEL_TAGS = ["featured", "new", "vip", "exclusive", "latina"];

const TAG_COLORS = [
  "crimson",
  "pink",
  "plum",
  "violet",
  "indigo",
  "cyan",
  "teal",
  "amber",
  "orange",
] as const;

function tagColor(tag: string): (typeof TAG_COLORS)[number] {
  let hash = 0;
  for (let i = 0; i < tag.length; i += 1) {
    hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
  }
  return TAG_COLORS[hash % TAG_COLORS.length]!;
}

function mergeTagSuggestions(existing: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [...PRESET_MODEL_TAGS, ...existing]) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function modelGradientCss(
  startRaw: string | null | undefined,
  endRaw: string | null | undefined,
): string {
  const start = startRaw?.trim() ?? "";
  const end = endRaw?.trim() ?? "";
  if (!start && !end) return "";
  if (start && end) return `linear-gradient(90deg, ${start}, ${end})`;
  return start || end;
}

function normalizeHexColor(value: string): string {
  const raw = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const [, a, b, c] = raw;
    return `#${a}${a}${b}${b}${c}${c}`.toLowerCase();
  }
  return "#000000";
}

function ColorField({
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
  const pickerValue = normalizeHexColor(value || "#000000");
  return (
    <label>
      <Text as="div" mb="1" size="1" weight="medium">
        {label}
      </Text>
      <Flex align="center" gap="2">
        <input
          disabled={busy}
          type="color"
          value={pickerValue}
          onChange={(event) => onChange(event.currentTarget.value)}
          style={{
            width: 36,
            height: 32,
            padding: 0,
            border: "1px solid var(--gray-a6)",
            borderRadius: 6,
            background: "transparent",
            cursor: busy ? "not-allowed" : "pointer",
          }}
        />
        <TextField.Root
          disabled={busy}
          placeholder="#ff8fab"
          style={{ flex: 1 }}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </Flex>
    </label>
  );
}

function sortModelCards(cards: CardInfo[]): CardInfo[] {
  return [...cards].sort((a, b) => {
    // Published cards keep sort_order; drafts sort after them by id.
    if (Boolean(a.draft) !== Boolean(b.draft)) return a.draft ? 1 : -1;
    const orderA = a.sort_order ?? 0;
    const orderB = b.sort_order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return a.id.localeCompare(b.id);
  });
}

const PREFERRED_THEME_ORDER = ["Police", "Teacher", "Nurse", "Gym", "Firegirl"] as const;
const UNTHEMED_LABEL = "Unthemed";

/** Resolve a card's THEME category for grouping (draft theme → label hints → Unthemed). */
function resolveCardTheme(card: CardInfo): string {
  const fromDraft = card.theme?.trim();
  if (fromDraft) return fromDraft;
  return inferThemeFromLabel(card.label) ?? UNTHEMED_LABEL;
}

function resolveThemeCatalogId(themeLabel: string, catalog: ThemeInfo[]): string | null {
  const key = themeKey(themeLabel);
  const match = catalog.find(
    (theme) => theme.id === key || themeKey(theme.label) === key,
  );
  return match?.id ?? null;
}

type ThemeCardGroup = {
  theme: string;
  cards: CardInfo[];
};

function groupCardsByTheme(
  cards: CardInfo[],
  preferredOrder: string[] = [...PREFERRED_THEME_ORDER],
): ThemeCardGroup[] {
  const groups = new Map<string, ThemeCardGroup>();
  const order: string[] = [];

  for (const card of cards) {
    const theme = resolveCardTheme(card);
    const key = themeKey(theme);
    let group = groups.get(key);
    if (!group) {
      group = { theme, cards: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.cards.push(card);
  }

  const preferredKeys = preferredOrder.map((theme) => themeKey(theme));
  const preferredRank = new Map(preferredKeys.map((key, index) => [key, index]));

  order.sort((a, b) => {
    const unthemedKey = themeKey(UNTHEMED_LABEL);
    if (a === unthemedKey) return 1;
    if (b === unthemedKey) return -1;
    const rankA = preferredRank.get(a);
    const rankB = preferredRank.get(b);
    if (rankA != null && rankB != null) return rankA - rankB;
    if (rankA != null) return -1;
    if (rankB != null) return 1;
    return (groups.get(a)?.theme ?? a).localeCompare(groups.get(b)?.theme ?? b);
  });

  return order.map((key) => groups.get(key)!);
}

function draftCardsFromFlows(flows: VideoFlowProject[], publishedIds: Set<string>): CardInfo[] {
  const drafts: CardInfo[] = [];
  for (const flow of flows) {
    if (publishedIds.has(flow.card_id)) continue;
    const modelId = flow.draft?.model_id?.trim();
    if (!modelId) continue;
    drafts.push({
      id: flow.card_id,
      label: flow.draft?.card_label?.trim() || labelFromProjectId(flow.card_id),
      model_id: modelId,
      draft: true,
      photos: [],
      photo_scratch_done: 0,
      photo_scratch_draft: 0,
      photo_scratch_mesh_count: 0,
      photo_scratch_symbols_count: 0,
      theme: flow.draft?.theme?.trim() || undefined,
    });
  }
  return drafts;
}

async function enrichDraftPhotoScratchCounts(drafts: CardInfo[]): Promise<CardInfo[]> {
  if (drafts.length === 0) return drafts;
  return Promise.all(
    drafts.map(async (card) => {
      try {
        const slots = await fetchPhotoScratchSlots(card.id, card.theme ?? "");
        return {
          ...card,
          ...photoScratchCountsFromSlots(slots),
        };
      } catch {
        return card;
      }
    }),
  );
}

function themesByCardId(flows: VideoFlowProject[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const flow of flows) {
    const theme = flow.draft?.theme?.trim();
    if (theme) map.set(flow.card_id, theme);
  }
  return map;
}

function formatLoadError(caught: unknown): string {
  if (caught instanceof Error) {
    const message = caught.message.trim();
    if (!message || message === "Error") {
      return "Could not reach the API. Try Refresh — the server may still be starting.";
    }
    if (/failed to fetch|networkerror|load failed|etimedout|econnrefused/i.test(message)) {
      return "Could not reach the API. Try Refresh — the server may still be starting.";
    }
    return message;
  }
  const text = String(caught).trim();
  return text && text !== "Error"
    ? text
    : "Could not reach the API. Try Refresh — the server may still be starting.";
}

export function ModelsPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [cards, setCards] = useState<CardInfo[]>([]);
  const [draftCards, setDraftCards] = useState<CardInfo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newModelId, setNewModelId] = useState("");
  const [newModelLabel, setNewModelLabel] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editingLabel, setEditingLabel] = useState("");
  const [editingName, setEditingName] = useState("");
  const [editingCity, setEditingCity] = useState("");
  const [editingCountry, setEditingCountry] = useState("");
  const [editingFlag, setEditingFlag] = useState("");
  const [editingColorStart, setEditingColorStart] = useState("");
  const [editingColorEnd, setEditingColorEnd] = useState("");
  const [editingLightColor1, setEditingLightColor1] = useState("");
  const [editingLightColor2, setEditingLightColor2] = useState("");
  const [newModelName, setNewModelName] = useState("");
  const [newModelCity, setNewModelCity] = useState("");
  const [newModelCountry, setNewModelCountry] = useState("");
  const [newModelFlagFile, setNewModelFlagFile] = useState<File | null>(null);
  const [newModelColorStart, setNewModelColorStart] = useState("");
  const [newModelColorEnd, setNewModelColorEnd] = useState("");
  const [newModelLightColor1, setNewModelLightColor1] = useState("");
  const [newModelLightColor2, setNewModelLightColor2] = useState("");
  const [newModelTags, setNewModelTags] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [creatingCardFor, setCreatingCardFor] = useState("");
  const [newCardId, setNewCardId] = useState("");
  const [newCardLabel, setNewCardLabel] = useState("");
  const [themeCatalog, setThemeCatalog] = useState<ThemeInfo[]>([]);
  const [createModelOpen, setCreateModelOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState(readSelectedModelId);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const themeAvatarInputRef = useRef<HTMLInputElement>(null);
  const trailerInputRef = useRef<HTMLInputElement>(null);
  const introInputRef = useRef<HTMLInputElement>(null);
  const flagInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [avatarTargetId, setAvatarTargetId] = useState("");
  const [themeAvatarTarget, setThemeAvatarTarget] = useState<{
    modelId: string;
    themeId: string;
  } | null>(null);
  const [trailerTargetId, setTrailerTargetId] = useState("");
  const [introTargetId, setIntroTargetId] = useState("");
  const [flagTargetId, setFlagTargetId] = useState("");
  const [videoTarget, setVideoTarget] = useState<{
    modelId: string;
    kind: ModelVideoKind;
  } | null>(null);

  useEffect(() => {
    const sync = () => setSelectedModelId(readSelectedModelId());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  async function refresh() {
    const [nextModels, assets, flowData, nextThemes] = await Promise.all([
      fetchModels(),
      api<{ cards: CardInfo[] }>("/api/cards"),
      api<{ flows: VideoFlowProject[] }>("/api/video-flow").catch(() => ({ flows: [] as VideoFlowProject[] })),
      fetchThemes().catch(() => [] as ThemeInfo[]),
    ]);
    const themes = themesByCardId(flowData.flows);
    const themeLabelById = new Map(nextThemes.map((theme) => [theme.id, theme.label]));
    const published = assets.cards.map((card) => ({
      ...card,
      theme:
        card.theme ??
        (card.theme_id ? themeLabelById.get(card.theme_id) : undefined) ??
        themes.get(card.id),
      photo_scratch_done: card.photo_scratch_done ?? 0,
      photo_scratch_draft: card.photo_scratch_draft ?? 0,
      photo_scratch_mesh_count: card.photo_scratch_mesh_count ?? 0,
      photo_scratch_symbols_count: card.photo_scratch_symbols_count ?? 0,
    }));
    const drafts = await enrichDraftPhotoScratchCounts(
      draftCardsFromFlows(flowData.flows, new Set(published.map((card) => card.id))),
    );
    setModels(nextModels);
    setCards(published);
    setDraftCards(drafts);
    setThemeCatalog(nextThemes);
    setError("");
  }

  useEffect(() => {
    refresh().catch((caught) => setError(formatLoadError(caught)));
  }, []);

  const allKnownCardIds = useMemo(
    () => [...cards.map((card) => card.id), ...draftCards.map((card) => card.id)],
    [cards, draftCards],
  );

  const cardsByModel = useMemo(() => {
    const map = new Map<string, CardInfo[]>();
    for (const card of [...cards, ...draftCards]) {
      if (!card.model_id) continue;
      const bucket = map.get(card.model_id) ?? [];
      bucket.push(card);
      map.set(card.model_id, bucket);
    }
    for (const [modelId, bucket] of map) {
      map.set(modelId, sortModelCards(bucket));
    }
    return map;
  }, [cards, draftCards]);

  const importableCards = useMemo(
    () => cards.filter((card) => card.id !== "original"),
    [cards],
  );

  const unassignedCards = useMemo(
    () =>
      sortModelCards(
        cards.filter((card) => card.id !== "original" && !card.model_id),
      ),
    [cards],
  );

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? null,
    [models, selectedModelId],
  );

  const allModelTags = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const model of models) {
      for (const tag of modelTags(model)) {
        if (seen.has(tag)) continue;
        seen.add(tag);
        out.push(tag);
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [models]);

  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return models.filter((model) => {
      const tags = modelTags(model);
      if (selectedTags.length > 0 && !selectedTags.every((tag) => tags.includes(tag))) {
        return false;
      }
      if (!query) return true;
      const haystack = [
        model.id,
        model.label,
        model.influencerName ?? "",
        model.influencerCity ?? "",
        model.influencerCountry ?? "",
        ...tags,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [modelSearch, models, selectedTags]);

  async function handleNewModelFlagCountrySelect(countryCode: string) {
    setError("");
    try {
      const file = await fetchCountryFlagFile(countryCode);
      setNewModelFlagFile(file);
      if (!newModelCountry.trim()) {
        const option = COUNTRY_FLAG_OPTIONS.find((item) => item.code === countryCode);
        if (option) setNewModelCountry(option.name);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function clearNewModelForm() {
    setNewModelId("");
    setNewModelLabel("");
    setNewModelName("");
    setNewModelCity("");
    setNewModelCountry("");
    setNewModelFlagFile(null);
    setNewModelColorStart("");
    setNewModelColorEnd("");
    setNewModelLightColor1("");
    setNewModelLightColor2("");
    setNewModelTags("");
  }

  async function handleCreateModel() {
    setBusy(true);
    setError("");
    try {
      const created = await createModel(
        newModelId.trim(),
        newModelLabel.trim() || newModelId.trim(),
        {
          influencerName: newModelName.trim() || null,
          influencerCity: newModelCity.trim() || null,
          influencerCountry: newModelCountry.trim() || null,
          cardOverlayColorStart: newModelColorStart.trim() || null,
          cardOverlayColorEnd: newModelColorEnd.trim() || null,
          cardLightColor1: newModelLightColor1.trim() || null,
          cardLightColor2: newModelLightColor2.trim() || null,
          tags: parseTagInput(newModelTags),
        },
      );
      if (newModelFlagFile) {
        await uploadModelFlagSvg(created.id, newModelFlagFile);
      }
      clearNewModelForm();
      setCreateModelOpen(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRenameModel(modelId: string) {
    setBusy(true);
    setError("");
    try {
      await updateModel(modelId, {
        label: editingLabel.trim(),
        influencerName: editingName.trim(),
        influencerCity: editingCity.trim(),
        influencerCountry: editingCountry.trim(),
        influencerFlag: editingFlag.trim(),
        cardOverlayColorStart: editingColorStart.trim(),
        cardOverlayColorEnd: editingColorEnd.trim(),
        cardLightColor1: editingLightColor1.trim(),
        cardLightColor2: editingLightColor2.trim(),
      });
      setEditingId("");
      setEditingLabel("");
      setEditingName("");
      setEditingCity("");
      setEditingCountry("");
      setEditingFlag("");
      setEditingColorStart("");
      setEditingColorEnd("");
      setEditingLightColor1("");
      setEditingLightColor2("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveTags(modelId: string, tags: string[]) {
    setBusy(true);
    setError("");
    try {
      await updateModel(modelId, { tags });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleSavePackNames(
    modelId: string,
    cardPackName: string,
    cardPackName2: string,
  ) {
    setBusy(true);
    setError("");
    try {
      await updateModel(modelId, {
        cardPackName: cardPackName.trim(),
        cardPackName2: cardPackName2.trim(),
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteModel(modelId: string) {
    const linked = cardsByModel.get(modelId) ?? [];
    const cardNote =
      linked.length > 0
        ? ` This will also permanently delete ${linked.length} motion card${linked.length === 1 ? "" : "s"} (videos, photo-scratch, mesh, video-flow).`
        : "";
    if (!window.confirm(`Delete model “${modelId}”?${cardNote}`)) return;
    setBusy(true);
    setError("");
    try {
      await deleteModel(modelId);
      if (selectedModelId === modelId) {
        window.history.pushState(null, "", "/dashboard/models");
        setSelectedModelId("");
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteCard(card: CardInfo) {
    const kind = card.draft ? "draft motion card" : "motion card";
    if (
      !window.confirm(
        `Delete ${kind} “${card.label}” (${card.id})?\n\nThis permanently removes videos, photo-scratch slots, mesh, video-flow work, and published photo games.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await deleteCard(card.id);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleAssignCard(cardId: string, modelId: string) {
    setBusy(true);
    setError("");
    try {
      await assignCardToModel(cardId, modelId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handlePublishGame(cardId: string) {
    setBusy(true);
    setError("");
    try {
      const result = await publishPhotoScratchGame(cardId);
      if (result.published === 0) {
        setError("No fully done photo-scratch slots to publish.");
        return;
      }
      window.open(photoScratchPlayHref(cardId, result.first_id), "_blank", "noopener,noreferrer");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleMoveCard(modelId: string, cardId: string, direction: -1 | 1) {
    const modelCards = (cardsByModel.get(modelId) ?? []).filter((card) => !card.draft);
    const index = modelCards.findIndex((card) => card.id === cardId);
    if (index < 0) return;
    const theme = themeKey(resolveCardTheme(modelCards[index]!));
    const themeIndexes = modelCards
      .map((card, cardIndex) => ({ card, cardIndex }))
      .filter(({ card }) => themeKey(resolveCardTheme(card)) === theme)
      .map(({ cardIndex }) => cardIndex);
    const posInTheme = themeIndexes.indexOf(index);
    const swapWith = themeIndexes[posInTheme + direction];
    if (posInTheme < 0 || swapWith == null) return;
    const nextIds = modelCards.map((card) => card.id);
    const tmp = nextIds[index]!;
    nextIds[index] = nextIds[swapWith]!;
    nextIds[swapWith] = tmp;
    setBusy(true);
    setError("");
    try {
      await reorderModelCards(modelId, nextIds);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleAvatarUpload(modelId: string, file: File) {
    setBusy(true);
    setError("");
    try {
      await uploadModelAvatar(modelId, file);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleThemeAvatarUpload(modelId: string, themeId: string, file: File) {
    setBusy(true);
    setError("");
    try {
      await uploadModelThemeAvatar(modelId, themeId, file);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleTrailerUpload(cardId: string, file: File) {
    setBusy(true);
    setError("");
    try {
      await uploadCardTrailer(cardId, file);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleIntroUpload(themeId: string, file: File) {
    setBusy(true);
    setError("");
    try {
      await uploadThemeIntro(themeId, file);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleFlagUpload(modelId: string, file: File) {
    setBusy(true);
    setError("");
    try {
      await uploadModelFlagSvg(modelId, file);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleFlagCountrySelect(modelId: string, countryCode: string) {
    setBusy(true);
    setError("");
    try {
      const file = await fetchCountryFlagFile(countryCode);
      await uploadModelFlagSvg(modelId, file);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleFlagDelete(modelId: string) {
    if (!window.confirm("Remove this flag SVG? The emoji fallback will be used instead.")) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await deleteModelFlagSvg(modelId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleVideoUpload(modelId: string, kind: ModelVideoKind, file: File) {
    setBusy(true);
    setError("");
    try {
      await uploadModelVideo(modelId, kind, file);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function openCreateCard(modelId: string) {
    const suggested = suggestCardId(modelId, allKnownCardIds);
    setCreatingCardFor(modelId);
    setNewCardId(suggested);
    setNewCardLabel(labelFromProjectId(suggested));
    setError("");
  }

  function closeCreateCard() {
    setCreatingCardFor("");
    setNewCardId("");
    setNewCardLabel("");
  }

  async function handleCreateCard(modelId: string) {
    const id = slugifyProjectId(newCardId);
    if (!PROJECT_ID_PATTERN.test(id)) {
      setError("Card id must be lowercase letters, numbers, and underscores.");
      return;
    }
    if (allKnownCardIds.includes(id)) {
      setError(`Card “${id}” already exists.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createMotionCardDraft(id, newCardLabel.trim() || labelFromProjectId(id), modelId);
      closeCreateCard();
      window.location.href = editCardHref(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  return (
    <main className="dashboard-root">
      <Container size="4">
        <Flex direction="column" gap="4" py="6">
          <Flex align="center" justify="between" wrap="wrap" gap="3">
            <Box>
              <Text className="eyebrow" size="2">
                Sugar Scratchie
              </Text>
              <Heading size="7">Models</Heading>
              <Text color="gray" size="2">
                A model is a girl/persona. Each model owns motion cards and their PhotoScratch photos.
              </Text>
            </Box>
            <Flex gap="2" wrap="wrap">
              <Button
                color="gray"
                variant="soft"
                onClick={() => refresh().catch((caught) => setError(formatLoadError(caught)))}
              >
                <LoaderCircle {...iconProps} />
                Refresh
              </Button>
              <Button asChild variant="soft">
                <a href="/dashboard/themes">Themes</a>
              </Button>
              <Button asChild variant="soft">
                <a href="/symbols">Symbols</a>
              </Button>
              <Button asChild variant="soft">
                <a href="/dashboard">
                  <ExternalLink {...iconProps} />
                  Dashboard
                </a>
              </Button>
              <Button asChild>
                <a href="/">
                  <Home {...iconProps} />
                  Home
                </a>
              </Button>
            </Flex>
          </Flex>

          {error ? (
            <Callout.Root color="red">
              <Callout.Icon>
                <AlertTriangle {...iconProps} />
              </Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          ) : null}

          {selectedModel ? (
            <ModelDetail
              busy={busy}
              creatingCardFor={creatingCardFor}
              editingCity={editingCity}
              editingColorEnd={editingColorEnd}
              editingColorStart={editingColorStart}
              editingLightColor1={editingLightColor1}
              editingLightColor2={editingLightColor2}
              editingCountry={editingCountry}
              editingFlag={editingFlag}
              editingId={editingId}
              editingLabel={editingLabel}
              editingName={editingName}
              importableCards={importableCards}
              model={selectedModel}
              modelCards={cardsByModel.get(selectedModel.id) ?? []}
              models={models}
              newCardId={newCardId}
              newCardLabel={newCardLabel}
              preferredThemeOrder={
                themeCatalog.length > 0
                  ? themeCatalog.map((theme) => theme.label)
                  : [...PREFERRED_THEME_ORDER]
              }
              suggestedTags={allModelTags}
              themeCatalog={themeCatalog}
              onAssignCard={(cardId, modelId) => void handleAssignCard(cardId, modelId)}
              onAvatarClick={() => {
                setAvatarTargetId(selectedModel.id);
                avatarInputRef.current?.click();
              }}
              onThemeAvatarClick={(themeId) => {
                setThemeAvatarTarget({ modelId: selectedModel.id, themeId });
                themeAvatarInputRef.current?.click();
              }}
              onTrailerClick={(cardId) => {
                setTrailerTargetId(cardId);
                trailerInputRef.current?.click();
              }}
              onIntroClick={(themeId) => {
                setIntroTargetId(themeId);
                introInputRef.current?.click();
              }}
              onFlagClick={() => {
                setFlagTargetId(selectedModel.id);
                flagInputRef.current?.click();
              }}
              onFlagDelete={() => void handleFlagDelete(selectedModel.id)}
              onFlagCountrySelect={(countryCode) =>
                void handleFlagCountrySelect(selectedModel.id, countryCode)
              }
              onVideoClick={(kind) => {
                setVideoTarget({ modelId: selectedModel.id, kind });
                videoInputRef.current?.click();
              }}
              onSavePackNames={(cardPackName, cardPackName2) =>
                void handleSavePackNames(selectedModel.id, cardPackName, cardPackName2)
              }
              onSaveTags={(tags) => void handleSaveTags(selectedModel.id, tags)}
              onCancelCreateCard={closeCreateCard}
              onCancelRename={() => {
                setEditingId("");
                setEditingLabel("");
                setEditingName("");
                setEditingCity("");
                setEditingCountry("");
                setEditingFlag("");
                setEditingColorStart("");
                setEditingColorEnd("");
                setEditingLightColor1("");
                setEditingLightColor2("");
              }}
              onCardIdChange={setNewCardId}
              onCardLabelChange={setNewCardLabel}
              onCreateCard={() => void handleCreateCard(selectedModel.id)}
              onDeleteCard={(card) => void handleDeleteCard(card)}
              onDeleteModel={() => void handleDeleteModel(selectedModel.id)}
              onDetachCard={(cardId) => void handleAssignCard(cardId, "")}
              onEditingCityChange={setEditingCity}
              onEditingColorEndChange={setEditingColorEnd}
              onEditingColorStartChange={setEditingColorStart}
              onEditingLightColor1Change={setEditingLightColor1}
              onEditingLightColor2Change={setEditingLightColor2}
              onEditingCountryChange={setEditingCountry}
              onEditingFlagChange={setEditingFlag}
              onEditingLabelChange={setEditingLabel}
              onEditingNameChange={setEditingName}
              onMoveCard={(cardId, direction) => void handleMoveCard(selectedModel.id, cardId, direction)}
              onOpenCreateCard={() => openCreateCard(selectedModel.id)}
              onPublishGame={(cardId) => void handlePublishGame(cardId)}
              onRename={() => void handleRenameModel(selectedModel.id)}
              onStartRename={() => {
                setEditingId(selectedModel.id);
                setEditingLabel(selectedModel.label);
                setEditingName(selectedModel.influencerName ?? "");
                setEditingCity(selectedModel.influencerCity ?? "");
                setEditingCountry(selectedModel.influencerCountry ?? "");
                setEditingFlag(selectedModel.influencerFlag ?? "");
                setEditingColorStart(selectedModel.cardOverlayColorStart ?? "");
                setEditingColorEnd(selectedModel.cardOverlayColorEnd ?? "");
                setEditingLightColor1(selectedModel.cardLightColor1 ?? "");
                setEditingLightColor2(selectedModel.cardLightColor2 ?? "");
              }}
            />
          ) : (
            <>
              <Dialog.Root open={createModelOpen} onOpenChange={setCreateModelOpen}>
                <Dialog.Trigger>
                  <Button size="3" variant="soft">
                    <Plus {...iconProps} />
                    Create model
                  </Button>
                </Dialog.Trigger>
                <Dialog.Content style={{ maxWidth: 520 }}>
                  <Dialog.Title>Create model</Dialog.Title>
                  <Dialog.Description size="2" mb="3">
                    Add a girl/persona. You can attach motion cards after.
                  </Dialog.Description>
                  <CreateModelFields
                    busy={busy}
                    modelCity={newModelCity}
                    modelColorEnd={newModelColorEnd}
                    modelColorStart={newModelColorStart}
                    modelLightColor1={newModelLightColor1}
                    modelLightColor2={newModelLightColor2}
                    modelCountry={newModelCountry}
                    modelFlagFile={newModelFlagFile}
                    modelId={newModelId}
                    modelLabel={newModelLabel}
                    modelName={newModelName}
                    modelTags={newModelTags}
                    stacked
                    onModelCityChange={setNewModelCity}
                    onModelColorEndChange={setNewModelColorEnd}
                    onModelColorStartChange={setNewModelColorStart}
                    onModelLightColor1Change={setNewModelLightColor1}
                    onModelLightColor2Change={setNewModelLightColor2}
                    onModelCountryChange={setNewModelCountry}
                    onModelFlagCountrySelect={(countryCode) =>
                      void handleNewModelFlagCountrySelect(countryCode)
                    }
                    onModelFlagFileChange={setNewModelFlagFile}
                    onModelIdChange={setNewModelId}
                    onModelLabelChange={setNewModelLabel}
                    onModelNameChange={setNewModelName}
                    onModelTagsChange={setNewModelTags}
                    suggestedTags={allModelTags}
                    onSubmit={() => void handleCreateModel()}
                  />
                  <Flex gap="2" mt="3" justify="end">
                    <Dialog.Close>
                      <Button color="gray" disabled={busy} variant="soft">
                        Cancel
                      </Button>
                    </Dialog.Close>
                  </Flex>
                </Dialog.Content>
              </Dialog.Root>

              {models.length > 0 ? (
                <Flex direction="column" gap="3">
                  <Heading size="4">Models</Heading>
                  <TextField.Root
                    placeholder="Search name, city, country, or tag"
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.currentTarget.value)}
                  >
                    <TextField.Slot>
                      <Search {...iconProps} />
                    </TextField.Slot>
                  </TextField.Root>
                  {allModelTags.length > 0 ? (
                    <Flex gap="2" wrap="wrap">
                      {allModelTags.map((tag) => {
                        const active = selectedTags.includes(tag);
                        return (
                          <Button
                            key={tag}
                            color={tagColor(tag)}
                            size="1"
                            variant={active ? "solid" : "soft"}
                            onClick={() =>
                              setSelectedTags((current) =>
                                current.includes(tag)
                                  ? current.filter((item) => item !== tag)
                                  : [...current, tag],
                              )
                            }
                          >
                            {tag}
                          </Button>
                        );
                      })}
                    </Flex>
                  ) : null}
                  {filteredModels.length > 0 ? (
                    filteredModels.map((model) => {
                    const count = (cardsByModel.get(model.id) ?? []).length;
                    const location = modelLocationLine(model);
                    const tags = modelTags(model);
                    return (
                      <a key={model.id} className="models-list-card" href={modelDetailHref(model.id)}>
                        <ModelAvatar model={model} size={44} />
                        <Box style={{ minWidth: 0 }}>
                          <Text as="div" size="3" weight="bold" truncate>
                            <Flex align="center" gap="2" asChild>
                              <span>
                                <ModelFlagMark model={model} size={16} />
                                {modelDisplayTitle(model)}
                              </span>
                            </Flex>
                          </Text>
                          <Text as="div" color="gray" size="2">
                            {location || `${count} motion card${count === 1 ? "" : "s"}`}
                          </Text>
                          {location ? (
                            <Text as="div" color="gray" size="1">
                              {count} motion card{count === 1 ? "" : "s"}
                            </Text>
                          ) : null}
                          {tags.length > 0 ? (
                            <Flex gap="1" mt="1" wrap="wrap">
                              {tags.map((tag) => (
                                <Badge
                                  key={tag}
                                  color={tagColor(tag)}
                                  size="1"
                                  variant={selectedTags.includes(tag) ? "solid" : "soft"}
                                  role="button"
                                  tabIndex={0}
                                  aria-pressed={selectedTags.includes(tag)}
                                  style={{ cursor: "pointer" }}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setSelectedTags((current) =>
                                      current.includes(tag)
                                        ? current.filter((item) => item !== tag)
                                        : [...current, tag],
                                    );
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key !== "Enter" && event.key !== " ") return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setSelectedTags((current) =>
                                      current.includes(tag)
                                        ? current.filter((item) => item !== tag)
                                        : [...current, tag],
                                    );
                                  }}
                                >
                                  {tag}
                                </Badge>
                              ))}
                            </Flex>
                          ) : null}
                        </Box>
                      </a>
                    );
                  })
                  ) : (
                    <Text color="gray" size="2">
                      No models match this search.
                    </Text>
                  )}
                </Flex>
              ) : (
                <Card size="3">
                  <Text color="gray">No models yet. Create your first model above.</Text>
                </Card>
              )}

              {unassignedCards.length > 0 ? (
                <Card size="3">
                  <Heading size="4" mb="1">
                    Unassigned motion cards
                  </Heading>
                  <Text color="gray" mb="3" size="2">
                    Cards with no girl yet — assign one below.
                  </Text>
                  <Table.Root size="1" variant="surface">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeaderCell>Motion card</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Assign to girl</Table.ColumnHeaderCell>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {unassignedCards.map((card) => (
                        <Table.Row key={card.id}>
                          <Table.Cell>
                            {card.label} <CodeInline>{card.id}</CodeInline>
                            {card.theme ? (
                              <Badge color="iris" ml="2" variant="soft" title="Theme">
                                {card.theme}
                              </Badge>
                            ) : null}
                          </Table.Cell>
                          <Table.Cell>
                            <Flex align="center" gap="2" wrap="wrap">
                              <Select.Root
                                disabled={busy || models.length === 0}
                                value=""
                                onValueChange={(value) => void handleAssignCard(card.id, value)}
                              >
                                <Select.Trigger placeholder="Choose girl…" style={{ minWidth: 180 }} />
                                <Select.Content>
                                  {models.map((model) => (
                                    <Select.Item key={model.id} value={model.id}>
                                      {modelDisplayTitleWithFlag(model)}
                                      {(cardsByModel.get(model.id) ?? []).length === 0 ? " (empty)" : ""}
                                    </Select.Item>
                                  ))}
                                </Select.Content>
                              </Select.Root>
                              <Button asChild size="1" variant="soft">
                                <a href={editCardHref(card.id)} title={`Edit ${card.label} in Video Flow`}>
                                  <Pencil {...iconProps} />
                                  Edit
                                </a>
                              </Button>
                              <Button
                                color="red"
                                disabled={busy}
                                size="1"
                                title="Delete motion card"
                                variant="soft"
                                onClick={() => void handleDeleteCard(card)}
                              >
                                <Trash2 {...iconProps} />
                                Delete
                              </Button>
                            </Flex>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Root>
                </Card>
              ) : null}
            </>
          )}

          {selectedModelId && !selectedModel && models.length > 0 ? (
            <Callout.Root color="amber">
              <Callout.Icon>
                <AlertTriangle {...iconProps} />
              </Callout.Icon>
              <Callout.Text>
                Model “{selectedModelId}” was not found.{" "}
                <a href="/dashboard/models">Back to models</a>
              </Callout.Text>
            </Callout.Root>
          ) : null}
        </Flex>
      </Container>

      <input
        ref={avatarInputRef}
        accept="image/jpeg,image/png,image/webp"
        hidden
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file && avatarTargetId) void handleAvatarUpload(avatarTargetId, file);
        }}
      />
      <input
        ref={themeAvatarInputRef}
        accept="image/jpeg,image/png,image/webp"
        hidden
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file && themeAvatarTarget) {
            void handleThemeAvatarUpload(
              themeAvatarTarget.modelId,
              themeAvatarTarget.themeId,
              file,
            );
          }
        }}
      />
      <input
        ref={trailerInputRef}
        accept="video/mp4,video/webm,.mp4,.webm"
        hidden
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file && trailerTargetId) void handleTrailerUpload(trailerTargetId, file);
        }}
      />
      <input
        ref={introInputRef}
        accept="video/mp4,video/webm,.mp4,.webm"
        hidden
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file && introTargetId) void handleIntroUpload(introTargetId, file);
        }}
      />
      <input
        ref={flagInputRef}
        accept="image/svg+xml,.svg"
        hidden
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file && flagTargetId) void handleFlagUpload(flagTargetId, file);
        }}
      />
      <input
        ref={videoInputRef}
        accept="video/mp4,video/webm,.mp4,.webm"
        hidden
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file && videoTarget) {
            void handleVideoUpload(videoTarget.modelId, videoTarget.kind, file);
          }
        }}
      />
    </main>
  );
}

function CodeInline({ children }: { children: ReactNode }) {
  return (
    <Text as="span" color="gray" size="1">
      <code>{children}</code>
    </Text>
  );
}

function ModelFlagMark({ model, size = 18 }: { model: ModelInfo; size?: number }) {
  if (model.influencerFlagSvg) {
    return (
      <img
        alt=""
        src={model.influencerFlagSvg}
        style={{
          width: size,
          height: size,
          objectFit: "contain",
          display: "block",
          flexShrink: 0,
        }}
      />
    );
  }
  const emoji = model.influencerFlag?.trim();
  if (!emoji) return null;
  return (
    <Text as="span" size="3" style={{ lineHeight: 1 }}>
      {emoji}
    </Text>
  );
}

function CountryFlagPicker({
  busy,
  size = "1",
  triggerLabel = "Pick a country flag…",
  onSelect,
}: {
  busy: boolean;
  size?: "1" | "2";
  triggerLabel?: string;
  onSelect: (countryCode: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return COUNTRY_FLAG_OPTIONS;
    return COUNTRY_FLAG_OPTIONS.filter((option) => option.name.toLowerCase().includes(normalized));
  }, [query]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Popover.Trigger>
        <Button disabled={busy} size={size} type="button" variant="soft">
          <Search {...iconProps} />
          {triggerLabel}
        </Button>
      </Popover.Trigger>
      <Popover.Content align="start" style={{ width: 260, padding: 8 }}>
        <Flex direction="column" gap="2">
          <TextField.Root
            autoFocus
            placeholder="Search countries…"
            size="1"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          >
            <TextField.Slot>
              <Search {...iconProps} />
            </TextField.Slot>
          </TextField.Root>
          <Box style={{ maxHeight: 260, overflowY: "auto" }}>
            {filteredOptions.length === 0 ? (
              <Text color="gray" size="1">
                No countries found
              </Text>
            ) : (
              <Flex direction="column" gap="1">
                {filteredOptions.map((option) => (
                  <Button
                    key={option.code}
                    size="1"
                    style={{ justifyContent: "flex-start" }}
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      onSelect(option.code);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <img
                      alt=""
                      src={countryFlagSvgUrl(option.code)}
                      style={{
                        width: 20,
                        height: 15,
                        objectFit: "cover",
                        borderRadius: 2,
                        border: "1px solid var(--gray-a5)",
                        flexShrink: 0,
                      }}
                    />
                    <Text truncate>{option.name}</Text>
                  </Button>
                ))}
              </Flex>
            )}
          </Box>
        </Flex>
      </Popover.Content>
    </Popover.Root>
  );
}

function ModelAvatar({ model, size }: { model: ModelInfo; size: number }) {
  return (
    <Box
      className="models-list-avatar"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.22),
      }}
    >
      {model.avatar ? (
        <img alt="" src={model.avatar} />
      ) : (
        <span aria-hidden>{modelInitial(model.label, model.id)}</span>
      )}
    </Box>
  );
}

function ModelVideoSlot({
  busy,
  label,
  pathHint,
  url,
  onUpload,
  packName,
  onPackNameChange,
}: {
  busy: boolean;
  label: string;
  pathHint: string;
  url?: string | null;
  onUpload: () => void;
  packName?: string;
  onPackNameChange?: (value: string) => void;
}) {
  const src = url?.trim() || "";
  return (
    <Box
      style={{
        border: "1px solid var(--gray-a6)",
        borderRadius: 12,
        padding: 12,
        background: "var(--gray-a2)",
      }}
    >
      <Text as="div" mb="2" size="1" weight="medium">
        {label}
      </Text>
      {src ? (
        <video
          key={src}
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          src={src}
          style={{
            width: 72,
            height: 128,
            objectFit: "cover",
            borderRadius: 8,
            background: "#111",
            display: "block",
            marginBottom: 8,
          }}
        />
      ) : (
        <Box
          style={{
            width: 72,
            height: 128,
            borderRadius: 8,
            background: "var(--gray-a3)",
            display: "grid",
            placeItems: "center",
            marginBottom: 8,
          }}
        >
          <Text color="gray" size="1">
            —
          </Text>
        </Box>
      )}
      <Text as="div" color="gray" mb="2" size="1" style={{ wordBreak: "break-all" }}>
        {src || `Saves to public/${pathHint}`}
      </Text>
      {onPackNameChange ? (
        <label style={{ display: "block", marginBottom: 8 }}>
          <Text as="div" mb="1" size="1" weight="medium">
            Card pack name
          </Text>
          <TextField.Root
            disabled={busy}
            value={packName ?? ""}
            onChange={(event) => onPackNameChange(event.currentTarget.value)}
          />
        </label>
      ) : null}
      <Button disabled={busy} size="1" variant="soft" onClick={onUpload}>
        <Upload {...iconProps} />
        {src ? "Replace" : "Upload"}
      </Button>
    </Box>
  );
}

function ModelDetail({
  busy,
  creatingCardFor,
  editingCity,
  editingColorEnd,
  editingColorStart,
  editingLightColor1,
  editingLightColor2,
  editingCountry,
  editingFlag,
  editingId,
  editingLabel,
  editingName,
  importableCards,
  model,
  modelCards,
  models,
  newCardId,
  newCardLabel,
  preferredThemeOrder,
  suggestedTags,
  themeCatalog,
  onAssignCard,
  onAvatarClick,
  onThemeAvatarClick,
  onTrailerClick,
  onIntroClick,
  onCancelCreateCard,
  onCancelRename,
  onCardIdChange,
  onCardLabelChange,
  onCreateCard,
  onDeleteCard,
  onDeleteModel,
  onDetachCard,
  onEditingCityChange,
  onEditingColorEndChange,
  onEditingColorStartChange,
  onEditingLightColor1Change,
  onEditingLightColor2Change,
  onEditingCountryChange,
  onEditingFlagChange,
  onEditingLabelChange,
  onEditingNameChange,
  onFlagClick,
  onFlagCountrySelect,
  onFlagDelete,
  onMoveCard,
  onOpenCreateCard,
  onPublishGame,
  onRename,
  onStartRename,
  onVideoClick,
  onSavePackNames,
  onSaveTags,
}: {
  busy: boolean;
  creatingCardFor: string;
  editingCity: string;
  editingColorEnd: string;
  editingColorStart: string;
  editingLightColor1: string;
  editingLightColor2: string;
  editingCountry: string;
  editingFlag: string;
  editingId: string;
  editingLabel: string;
  editingName: string;
  importableCards: CardInfo[];
  model: ModelInfo;
  modelCards: CardInfo[];
  models: ModelInfo[];
  newCardId: string;
  newCardLabel: string;
  preferredThemeOrder: string[];
  suggestedTags: string[];
  themeCatalog: ThemeInfo[];
  onAssignCard: (cardId: string, modelId: string) => void;
  onAvatarClick: () => void;
  onThemeAvatarClick: (themeId: string) => void;
  onTrailerClick: (cardId: string) => void;
  onIntroClick: (themeId: string) => void;
  onCancelCreateCard: () => void;
  onCancelRename: () => void;
  onCardIdChange: (value: string) => void;
  onCardLabelChange: (value: string) => void;
  onCreateCard: () => void;
  onDeleteCard: (card: CardInfo) => void;
  onDeleteModel: () => void;
  onDetachCard: (cardId: string) => void;
  onEditingCityChange: (value: string) => void;
  onEditingColorEndChange: (value: string) => void;
  onEditingColorStartChange: (value: string) => void;
  onEditingLightColor1Change: (value: string) => void;
  onEditingLightColor2Change: (value: string) => void;
  onEditingCountryChange: (value: string) => void;
  onEditingFlagChange: (value: string) => void;
  onEditingLabelChange: (value: string) => void;
  onEditingNameChange: (value: string) => void;
  onFlagClick: () => void;
  onFlagCountrySelect: (countryCode: string) => void;
  onFlagDelete: () => void;
  onMoveCard: (cardId: string, direction: -1 | 1) => void;
  onOpenCreateCard: () => void;
  onPublishGame: (cardId: string) => void;
  onRename: () => void;
  onStartRename: () => void;
  onVideoClick: (kind: ModelVideoKind) => void;
  onSavePackNames: (cardPackName: string, cardPackName2: string) => void;
  onSaveTags: (tags: string[]) => void;
}) {
  const candidates = importableCards.filter((card) => card.model_id !== model.id);
  const publishedCards = modelCards.filter((entry) => !entry.draft);
  const locationLine = modelLocationLine(model);
  const gradientCss = modelGradientCss(
    model.cardOverlayColorStart,
    model.cardOverlayColorEnd,
  );
  const lightGradientCss = modelGradientCss(
    model.cardLightColor1,
    model.cardLightColor2,
  );
  const [packNameDraft, setPackNameDraft] = useState(model.cardPackName ?? "");
  const [packName2Draft, setPackName2Draft] = useState(model.cardPackName2 ?? "");
  const [tagsDraft, setTagsDraft] = useState(formatTagsInput(model.tags));
  const tagsSaveTimer = useRef<number | null>(null);

  useEffect(() => {
    setPackNameDraft(model.cardPackName ?? "");
    setPackName2Draft(model.cardPackName2 ?? "");
    setTagsDraft(formatTagsInput(model.tags));
  }, [model.id, model.cardPackName, model.cardPackName2, model.tags]);

  useEffect(() => {
    return () => {
      if (tagsSaveTimer.current != null) window.clearTimeout(tagsSaveTimer.current);
    };
  }, [model.id]);

  const packNamesDirty =
    packNameDraft.trim() !== (model.cardPackName ?? "").trim() ||
    packName2Draft.trim() !== (model.cardPackName2 ?? "").trim();
  const savedTagsKey = formatTagsInput(model.tags);
  const tagsDirty = formatTagsInput(parseTagInput(tagsDraft)) !== savedTagsKey;

  function commitTags(nextValue: string) {
    setTagsDraft(nextValue);
    const nextTags = parseTagInput(nextValue);
    if (formatTagsInput(nextTags) === savedTagsKey) return;
    if (tagsSaveTimer.current != null) window.clearTimeout(tagsSaveTimer.current);
    tagsSaveTimer.current = window.setTimeout(() => {
      onSaveTags(nextTags);
    }, 250);
  }

  return (
    <Flex direction="column" gap="3">
      <Button asChild color="gray" size="2" variant="soft" style={{ alignSelf: "flex-start" }}>
        <a href="/dashboard/models">
          <ArrowLeft {...iconProps} />
          All models
        </a>
      </Button>

      <Card size="3">
        <Flex align="start" gap="3" mb="3">
          <ModelAvatar model={model} size={72} />
          <Box style={{ flex: 1 }}>
            {editingId === model.id ? (
              <Flex direction="column" gap="2">
                <Grid columns={{ initial: "1", sm: "2" }} gap="2">
                  <label>
                    <Text as="div" mb="1" size="1" weight="medium">
                      Label
                    </Text>
                    <TextField.Root
                      disabled={busy}
                      value={editingLabel}
                      onChange={(event) => onEditingLabelChange(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    <Text as="div" mb="1" size="1" weight="medium">
                      Influencer name
                    </Text>
                    <TextField.Root
                      disabled={busy}
                      placeholder="Juliana"
                      value={editingName}
                      onChange={(event) => onEditingNameChange(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    <Text as="div" mb="1" size="1" weight="medium">
                      City
                    </Text>
                    <TextField.Root
                      disabled={busy}
                      placeholder="Buenos Aires"
                      value={editingCity}
                      onChange={(event) => onEditingCityChange(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    <Text as="div" mb="1" size="1" weight="medium">
                      Country
                    </Text>
                    <TextField.Root
                      disabled={busy}
                      placeholder="Argentina"
                      value={editingCountry}
                      onChange={(event) => onEditingCountryChange(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    <Text as="div" mb="1" size="1" weight="medium">
                      Flag emoji (optional fallback)
                    </Text>
                    <TextField.Root
                      disabled={busy}
                      placeholder="🇦🇷"
                      value={editingFlag}
                      onChange={(event) => onEditingFlagChange(event.currentTarget.value)}
                    />
                  </label>
                  <Box>
                    <Text as="div" mb="1" size="1" weight="medium">
                      Flag SVG
                    </Text>
                    <Flex align="center" gap="2" wrap="wrap">
                      {model.influencerFlagSvg ? (
                        <img
                          alt=""
                          src={model.influencerFlagSvg}
                          style={{
                            width: 36,
                            height: 27,
                            objectFit: "cover",
                            borderRadius: 4,
                            border: "1px solid var(--gray-a6)",
                            background: "var(--gray-a2)",
                            flexShrink: 0,
                          }}
                        />
                      ) : (
                        <Text color="gray" size="1">
                          No SVG yet
                        </Text>
                      )}
                      <CountryFlagPicker busy={busy} size="1" onSelect={onFlagCountrySelect} />
                      <Button disabled={busy} size="1" variant="soft" onClick={onFlagClick}>
                        <Upload {...iconProps} />
                        Upload SVG
                      </Button>
                      {model.influencerFlagSvg ? (
                        <Button
                          color="red"
                          disabled={busy}
                          size="1"
                          variant="soft"
                          onClick={onFlagDelete}
                        >
                          <Trash2 {...iconProps} />
                          Remove
                        </Button>
                      ) : null}
                    </Flex>
                  </Box>
                </Grid>
                <Box>
                  <Text as="div" mb="2" size="1" weight="bold">
                    Card overlay
                  </Text>
                  <Grid columns={{ initial: "1", sm: "2" }} gap="2">
                    <ColorField
                      busy={busy}
                      label="Start"
                      value={editingColorStart}
                      onChange={onEditingColorStartChange}
                    />
                    <ColorField
                      busy={busy}
                      label="End"
                      value={editingColorEnd}
                      onChange={onEditingColorEndChange}
                    />
                  </Grid>
                </Box>
                <Box>
                  <Text as="div" mb="2" size="1" weight="bold">
                    Card light
                  </Text>
                  <Grid columns={{ initial: "1", sm: "2" }} gap="2">
                    <ColorField
                      busy={busy}
                      label="Light 1"
                      value={editingLightColor1}
                      onChange={onEditingLightColor1Change}
                    />
                    <ColorField
                      busy={busy}
                      label="Light 2"
                      value={editingLightColor2}
                      onChange={onEditingLightColor2Change}
                    />
                  </Grid>
                </Box>
                <Flex align="center" gap="2" wrap="wrap">
                  <Button disabled={busy} size="1" onClick={onRename}>
                    Save
                  </Button>
                  <Button disabled={busy} size="1" variant="soft" onClick={onCancelRename}>
                    Cancel
                  </Button>
                </Flex>
              </Flex>
            ) : (
              <>
                <Flex align="center" gap="2" wrap="wrap">
                  <ModelFlagMark model={model} size={22} />
                  <Heading size="4">{modelDisplayTitle(model)}</Heading>
                  <Badge color="plum" variant="soft">
                    {model.id}
                  </Badge>
                  {modelTags(model).map((tag) => (
                    <Badge key={tag} color={tagColor(tag)} variant="soft">
                      {tag}
                    </Badge>
                  ))}
                  {gradientCss ? (
                    <Box
                      aria-hidden
                      style={{
                        width: 56,
                        height: 18,
                        borderRadius: 999,
                        background: gradientCss,
                        border: "1px solid var(--gray-a6)",
                      }}
                      title={
                        model.cardOverlayColorStart && model.cardOverlayColorEnd
                          ? `Overlay ${model.cardOverlayColorStart} → ${model.cardOverlayColorEnd}`
                          : `Overlay ${model.cardOverlayColorStart ?? model.cardOverlayColorEnd ?? ""}`
                      }
                    />
                  ) : null}
                  {lightGradientCss ? (
                    <Box
                      aria-hidden
                      style={{
                        width: 56,
                        height: 18,
                        borderRadius: 999,
                        background: lightGradientCss,
                        border: "1px solid var(--gray-a6)",
                      }}
                      title={`Light ${model.cardLightColor1} → ${model.cardLightColor2}`}
                    />
                  ) : null}
                </Flex>
              </>
            )}
            <Text as="div" color="gray" mt="1" size="2">
              {[
                editingId === model.id ? null : locationLine || null,
                `${publishedCards.length} published`,
                modelCards.some((card) => card.draft)
                  ? `${modelCards.filter((card) => card.draft).length} draft`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </Box>
        </Flex>

        <Flex gap="2" mb="3" wrap="wrap">
          {publishedCards.length > 0 ? (
            <Button asChild size="1">
              <a href={playAllHref(model.id)}>
                <Play {...iconProps} />
                Play all
              </a>
            </Button>
          ) : null}
          {creatingCardFor === model.id ? null : (
            <Button disabled={busy} size="1" variant="soft" onClick={onOpenCreateCard}>
              <Plus {...iconProps} />
              New motion card
            </Button>
          )}
          <Button disabled={busy} size="1" variant="soft" onClick={onStartRename}>
            Edit profile
          </Button>
          <Button disabled={busy} size="1" variant="soft" onClick={onAvatarClick}>
            <Upload {...iconProps} />
            Avatar
          </Button>
          <Button disabled={busy} size="1" variant="soft" onClick={onFlagClick}>
            <Upload {...iconProps} />
            Flag SVG
          </Button>
          <Button color="red" disabled={busy} size="1" variant="soft" onClick={onDeleteModel}>
            <Trash2 {...iconProps} />
            Delete
          </Button>
        </Flex>

        <Box mb="3">
          <div className="model-tags-section">
          <Flex align="center" justify="between" gap="2" mb="2" wrap="wrap">
            <Box>
              <Text as="div" size="2" weight="bold">
                Tags
              </Text>
              <Text as="div" color="gray" size="1">
                Click a suggestion or type your own. Saves as you add or remove.
              </Text>
            </Box>
            {tagsDirty ? (
              <Badge color="amber" variant="soft">
                Saving…
              </Badge>
            ) : (
              <Badge color="gray" variant="soft">
                Saved
              </Badge>
            )}
          </Flex>
          <TagsEditor
            busy={busy}
            suggestions={suggestedTags}
            value={tagsDraft}
            onChange={commitTags}
          />
        </div>
        </Box>

        <Box mb="3">
          <Text as="div" mb="1" size="2" weight="bold">
            Global media
          </Text>
          <Text as="div" color="gray" mb="2" size="1">
            Foil pack and home swipe videos for this model — served to the product app via{" "}
            <CodeInline>/api/models</CodeInline>. Card pack names replace “Pack Nº …” under the
            foil packs in the product app.
          </Text>
          <Grid columns={{ initial: "1", sm: "3" }} gap="3">
            <ModelVideoSlot
              busy={busy}
              label="Foil 3D pack video"
              pathHint={`models/${model.id}/pack-face.*`}
              url={model.packFaceVideoUrl}
              packName={packNameDraft}
              onPackNameChange={setPackNameDraft}
              onUpload={() => onVideoClick("pack-face")}
            />
            <ModelVideoSlot
              busy={busy}
              label="Foil 3D pack video 2"
              pathHint={`models/${model.id}/pack-face-2.*`}
              url={model.packFaceVideoUrl2}
              packName={packName2Draft}
              onPackNameChange={setPackName2Draft}
              onUpload={() => onVideoClick("pack-face-2")}
            />
            <ModelVideoSlot
              busy={busy}
              label="Swipe motion video"
              pathHint={`models/${model.id}/swipe.*`}
              url={model.swipeVideoUrl}
              onUpload={() => onVideoClick("swipe")}
            />
          </Grid>
          <Flex align="center" gap="2" mt="2" wrap="wrap">
            <Button
              disabled={busy || !packNamesDirty}
              size="1"
              onClick={() => onSavePackNames(packNameDraft, packName2Draft)}
            >
              Save pack names
            </Button>
            {packNamesDirty ? (
              <Text color="gray" size="1">
                Unsaved name changes
              </Text>
            ) : null}
          </Flex>
        </Box>

        {creatingCardFor === model.id ? (
          <Box mb="3">
            <CreateCardForm
              busy={busy}
              cardId={newCardId}
              cardLabel={newCardLabel}
              onCancel={onCancelCreateCard}
              onCardIdChange={onCardIdChange}
              onCardLabelChange={onCardLabelChange}
              onSubmit={onCreateCard}
            />
          </Box>
        ) : null}

        {modelCards.length > 0 ? (
          <Box className="models-card-list">
            {groupCardsByTheme(modelCards, preferredThemeOrder).map((group) => {
              const publishedInTheme = group.cards.filter((card) => !card.draft);
              const themeId =
                group.cards.find((card) => card.theme_id)?.theme_id ??
                resolveThemeCatalogId(group.theme, themeCatalog);
              const themeAvatarUrl =
                themeId && model.theme_avatars ? model.theme_avatars[themeId] : undefined;
              const themeIntroUrl =
                themeId
                  ? themeCatalog.find((theme) => theme.id === themeId)?.intro?.trim() || ""
                  : "";
              return (
                <div key={themeKey(group.theme)} className="models-theme-group">
                  <div className="models-theme-group-header">
                    <Text className="models-theme-group-eyebrow" color="gray" size="1" weight="medium">
                      Theme
                    </Text>
                    <Flex align="center" gap="3" justify="between" wrap="wrap">
                      <Flex align="center" gap="2" wrap="wrap">
                        <Heading as="h3" size="3">
                          {group.theme}
                        </Heading>
                        <Badge color="iris" size="1" variant="soft">
                          {group.cards.length}
                        </Badge>
                        {themeIntroUrl ? (
                          <Badge color="blue" size="1" variant="soft">
                            intro
                          </Badge>
                        ) : null}
                      </Flex>
                      <Flex align="center" gap="2">
                        {themeId ? (
                          <ThemeIntroControl
                            busy={busy}
                            label={`${group.theme} intro`}
                            src={themeIntroUrl ? previewSource(themeIntroUrl) : ""}
                            onUpload={() => onIntroClick(themeId)}
                          />
                        ) : null}
                        {themeId ? (
                          <button
                            aria-label={themeAvatarUrl ? "Replace theme avatar" : "Upload theme avatar"}
                            className="models-theme-avatar-btn"
                            disabled={busy}
                            title={themeAvatarUrl ? "Replace theme avatar" : "Upload theme avatar"}
                            type="button"
                            onClick={() => onThemeAvatarClick(themeId)}
                          >
                            {themeAvatarUrl ? (
                              <img alt="" className="models-theme-avatar" src={themeAvatarUrl} />
                            ) : (
                              <span className="models-theme-avatar models-theme-avatar--empty">
                                <Upload size={14} strokeWidth={2} />
                              </span>
                            )}
                          </button>
                        ) : null}
                      </Flex>
                    </Flex>
                  </div>
                  {group.cards.map((card, index) => {
                    const publishedIndex = publishedInTheme.findIndex((entry) => entry.id === card.id);
                    return (
                      <MotionCardRow
                        key={card.id}
                        busy={busy}
                        card={card}
                        index={index}
                        modelId={model.id}
                        publishedIndex={publishedIndex}
                        publishedCount={publishedInTheme.length}
                        onDelete={() => onDeleteCard(card)}
                        onDetach={() => onDetachCard(card.id)}
                        onMoveDown={() => onMoveCard(card.id, 1)}
                        onMoveUp={() => onMoveCard(card.id, -1)}
                        onPublishGame={() => onPublishGame(card.id)}
                        onTrailerClick={() => onTrailerClick(card.id)}
                      />
                    );
                  })}
                </div>
              );
            })}
          </Box>
        ) : (
          <Text color="gray" size="2">
            No motion cards yet. Create one above or import an existing card below.
          </Text>
        )}

        {candidates.length > 0 ? (
          <Flex align="center" gap="2" mt="3" wrap="wrap">
            <Import {...iconProps} />
            <Select.Root disabled={busy} value="" onValueChange={(value) => onAssignCard(value, model.id)}>
              <Select.Trigger placeholder="Import an existing motion card…" style={{ minWidth: 240 }} />
              <Select.Content>
                {candidates
                  .slice()
                  .sort((a, b) => Number(Boolean(a.model_id)) - Number(Boolean(b.model_id)))
                  .map((card) => {
                    const owner = card.model_id
                      ? (() => {
                          const entry = models.find((item) => item.id === card.model_id);
                          return entry ? modelDisplayTitleWithFlag(entry) : card.model_id;
                        })()
                      : null;
                    return (
                      <Select.Item key={card.id} value={card.id}>
                        {card.label} ({card.id})
                        {owner ? ` — from ${owner}` : " — unassigned"}
                      </Select.Item>
                    );
                  })}
              </Select.Content>
            </Select.Root>
          </Flex>
        ) : null}
      </Card>
    </Flex>
  );
}

function PhotoScratchStatus({ card }: { card: CardInfo }) {
  const draft = card.photo_scratch_draft ?? 0;
  const done = card.photo_scratch_done ?? 0;
  const mesh = card.photo_scratch_mesh_count ?? 0;
  const symbols = card.photo_scratch_symbols_count ?? 0;
  const empty = draft === 0 && done === 0 && mesh === 0 && symbols === 0;

  if (empty) {
    return (
      <Text color="gray" size="1">
        No photo-scratch yet
      </Text>
    );
  }

  return (
    <Flex align="center" className="models-card-status" gap="1">
      {draft > 0 ? (
        <Badge color="yellow" size="1" variant="soft">
          {draft} draft
        </Badge>
      ) : null}
      {done > 0 ? (
        <Badge color="green" size="1" variant="soft">
          {done} done
        </Badge>
      ) : null}
      <Badge
        color={mesh > 0 ? "green" : "gray"}
        size="1"
        title="Photo-scratch meshes (per slot), not motion-card"
        variant="soft"
      >
        Mesh {mesh}
      </Badge>
      <Badge
        color={symbols > 0 ? "green" : "gray"}
        size="1"
        title="Slots with 12 photo-scratch symbols"
        variant="soft"
      >
        Sym {symbols}
      </Badge>
    </Flex>
  );
}

const TOUCH_LONG_PRESS_MS = 450;
const PEEK_WIDTH_PX = 148;

type PeekPoint = { x: number; y: number };

function peekPosition(point: PeekPoint): { top: number; left: number; width: number } {
  const width = PEEK_WIDTH_PX;
  const height = width * (16 / 9);
  const margin = 10;
  const offset = 14;
  // Prefer above-right of the pointer; flip so the full peek stays on-screen.
  let left = point.x + offset;
  let top = point.y - height - offset;
  if (left + width > window.innerWidth - margin) left = point.x - width - offset;
  if (top < margin) top = point.y + offset;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - height - margin);
  }
  left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
  top = Math.min(Math.max(margin, top), window.innerHeight - height - margin);
  return { top, left, width };
}

/** Instagram-style peek: hold to view at pointer, release to close. */
function useInstagramPeek(onOpen: (point: PeekPoint) => void, onClose: () => void) {
  const timerRef = useRef<number | null>(null);
  const peekingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const pointRef = useRef<PeekPoint>({ x: 0, y: 0 });

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const startPeek = () => {
    if (peekingRef.current) return;
    peekingRef.current = true;
    suppressClickRef.current = true;
    onOpen({ ...pointRef.current });
  };

  const endPeek = () => {
    clearTimer();
    if (!peekingRef.current) return;
    peekingRef.current = false;
    onClose();
  };

  useEffect(
    () => () => {
      clearTimer();
    },
    [],
  );

  return {
    consumeSuppressClick: () => {
      if (!suppressClickRef.current) return false;
      suppressClickRef.current = false;
      return true;
    },
    bind: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        if (event.pointerType === "pen" && event.button !== 0) return;
        pointRef.current = { x: event.clientX, y: event.clientY };
        const el = event.currentTarget;
        el.setPointerCapture(event.pointerId);
        clearTimer();
        if (event.pointerType === "touch") {
          peekingRef.current = false;
          timerRef.current = window.setTimeout(startPeek, TOUCH_LONG_PRESS_MS);
          return;
        }
        startPeek();
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        pointRef.current = { x: event.clientX, y: event.clientY };
        // Keep peek glued to the pointer while held (helps after scroll).
        if (peekingRef.current) onOpen({ ...pointRef.current });
      },
      onPointerUp: (event: PointerEvent<HTMLElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        endPeek();
      },
      onPointerCancel: (event: PointerEvent<HTMLElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        endPeek();
      },
      onLostPointerCapture: () => {
        endPeek();
      },
      onContextMenu: (event: MouseEvent) => {
        if (peekingRef.current || timerRef.current != null) event.preventDefault();
      },
      onDragStart: (event: DragEvent) => {
        event.preventDefault();
      },
    },
  };
}

function MiniMediaOverlay({
  point,
  label,
  layers,
  src,
  type,
}: {
  point: PeekPoint;
  label: string;
  layers?: SlotPreviewLayers;
  src?: string;
  type: "image" | "video" | "layers";
}) {
  const pos = peekPosition(point);

  return createPortal(
    <div
      aria-label={`${label} preview`}
      className="models-media-peek"
      role="dialog"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
    >
      {type === "video" && src ? (
        <video autoPlay className="models-media-peek-media" muted playsInline src={src} />
      ) : type === "layers" && layers ? (
        <div className="models-media-peek-stack">
          {layers.background ? (
            <img alt="" className="models-media-peek-layer" src={layers.background} />
          ) : null}
          {layers.bikini ? (
            <img alt="" className="models-media-peek-layer" src={layers.bikini} />
          ) : null}
          {layers.clothes ? (
            <img alt="" className="models-media-peek-layer" src={layers.clothes} />
          ) : null}
        </div>
      ) : src ? (
        <img alt={label} className="models-media-peek-media" src={src} />
      ) : null}
    </div>,
    document.body,
  );
}

function SlotPictureStack({
  layers,
  className,
}: {
  layers: SlotPreviewLayers;
  className?: string;
}) {
  const fallback = layers.clothes || layers.bikini || layers.background;
  const stacked = Boolean(layers.background && (layers.clothes || layers.bikini));

  if (!fallback) return null;

  if (!stacked) {
    return <img alt="" className={className} src={fallback} draggable={false} />;
  }

  return (
    <span className={`models-slot-stack${className ? ` ${className}` : ""}`}>
      {layers.background ? <img alt="" src={layers.background} draggable={false} /> : null}
      {layers.bikini ? <img alt="" src={layers.bikini} draggable={false} /> : null}
      {layers.clothes ? <img alt="" src={layers.clothes} draggable={false} /> : null}
    </span>
  );
}

function ActionSlot({ children }: { children?: ReactNode }) {
  return <span className="models-card-action-slot">{children}</span>;
}

function MotionCardThumb({ card }: { card: CardInfo }) {
  return <CardVideoThumb label={card.label} src={motionCardVideoSrc(card)} />;
}

function TrailerThumb({ card }: { card: CardInfo }) {
  const raw = card.trailer?.trim() || "";
  return (
    <CardVideoThumb
      label={`${card.label} trailer`}
      src={raw ? previewSource(raw) : ""}
    />
  );
}

function ThemeIntroControl({
  busy,
  label,
  src,
  onUpload,
}: {
  busy: boolean;
  label: string;
  src: string;
  onUpload: () => void;
}) {
  return (
    <Flex align="center" gap="1">
      <CardVideoThumb label={label} src={src} />
      <Button
        disabled={busy}
        size="1"
        title={src ? "Replace intro video" : "Upload intro video"}
        variant="soft"
        onClick={onUpload}
      >
        <Upload size={14} strokeWidth={2} />
        {src ? "Replace" : "Intro"}
      </Button>
    </Flex>
  );
}

function CardVideoThumb({ label, src }: { label: string; src: string }) {
  const [peek, setPeek] = useState<{ point: PeekPoint } | null>(null);
  const peekHandlers = useInstagramPeek(
    (point) => setPeek({ point }),
    () => setPeek(null),
  );

  if (!src) {
    return <div aria-hidden className="models-card-thumb models-card-thumb--empty" />;
  }

  return (
    <>
      <button
        aria-label={`Hold to preview ${label}`}
        className="models-card-thumb models-card-thumb--button"
        type="button"
        title="Hold to preview · release to close"
        onClick={(event) => {
          if (peekHandlers.consumeSuppressClick()) event.preventDefault();
        }}
        {...peekHandlers.bind}
      >
        <video
          aria-hidden
          className="models-card-thumb-media"
          muted
          playsInline
          preload="metadata"
          src={src}
          onLoadedData={(event) => {
            const video = event.currentTarget;
            if (video.readyState >= 2 && video.currentTime < 0.05) {
              try {
                video.currentTime = Math.min(0.15, (video.duration || 1) * 0.08);
              } catch {
                /* ignore seek failures */
              }
            }
          }}
        />
      </button>
      {peek ? (
        <MiniMediaOverlay label={label} point={peek.point} src={src} type="video" />
      ) : null}
    </>
  );
}

function PhotoScratchThumbs({ card }: { card: CardInfo }) {
  const [thumbs, setThumbs] = useState<
    Array<{ id: string; layers: SlotPreviewLayers; done: boolean }>
  >([]);
  const [peek, setPeek] = useState<{
    label: string;
    layers: SlotPreviewLayers;
    point: PeekPoint;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const hasAny =
      (card.photo_scratch_draft ?? 0) > 0 ||
      (card.photo_scratch_done ?? 0) > 0 ||
      (card.photo_scratch_mesh_count ?? 0) > 0;
    if (!hasAny) {
      setThumbs([]);
      return;
    }
    fetchPhotoScratchSlots(card.id, card.theme ?? "")
      .then((slots) => {
        if (cancelled) return;
        const next = slots
          .map((slot) => {
            const layers = slotPreviewLayers(slot);
            if (!slotHasPreview(layers) && !slotThumbSrc(slot)) return null;
            if (!slotHasPreview(layers)) {
              const src = previewSource(slotThumbSrc(slot));
              layers.clothes = src;
            }
            return { id: slot.id, layers, done: slotIsDone(slot) };
          })
          .filter(
            (entry): entry is { id: string; layers: SlotPreviewLayers; done: boolean } =>
              entry != null,
          );
        setThumbs(next);
      })
      .catch(() => {
        if (!cancelled) setThumbs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [
    card.id,
    card.theme,
    card.photo_scratch_draft,
    card.photo_scratch_done,
    card.photo_scratch_mesh_count,
  ]);

  if (thumbs.length === 0) return null;

  return (
    <>
      <div className="models-card-ps-thumbs">
        {thumbs.map((thumb) => (
          <PhotoScratchThumbLink
            key={thumb.id}
            done={thumb.done}
            href={pictureFlowHref(card.id, thumb.id)}
            label={thumb.id}
            layers={thumb.layers}
            onClosePeek={() => setPeek(null)}
            onOpenPeek={(point) =>
              setPeek({ label: thumb.id, layers: thumb.layers, point })
            }
          />
        ))}
      </div>
      {peek ? (
        <MiniMediaOverlay
          label={peek.label}
          layers={peek.layers}
          point={peek.point}
          type="layers"
        />
      ) : null}
    </>
  );
}

function PhotoScratchThumbLink({
  done,
  href,
  label,
  layers,
  onOpenPeek,
  onClosePeek,
}: {
  done: boolean;
  href: string;
  label: string;
  layers: SlotPreviewLayers;
  onOpenPeek: (point: PeekPoint) => void;
  onClosePeek: () => void;
}) {
  const peekHandlers = useInstagramPeek(onOpenPeek, onClosePeek);

  return (
    <a
      className={`models-card-ps-thumb${done ? " is-done" : ""}`}
      href={href}
      title={`${label}${done ? " (done)" : ""} · hold to preview`}
      onClick={(event) => {
        if (peekHandlers.consumeSuppressClick()) event.preventDefault();
      }}
      {...peekHandlers.bind}
    >
      <SlotPictureStack layers={layers} />
    </a>
  );
}

function MotionCardRow({
  busy,
  card,
  index,
  modelId,
  publishedCount,
  publishedIndex,
  onDelete,
  onDetach,
  onMoveDown,
  onMoveUp,
  onPublishGame,
  onTrailerClick,
}: {
  busy: boolean;
  card: CardInfo;
  index: number;
  modelId: string;
  publishedCount: number;
  publishedIndex: number;
  onDelete: () => void;
  onDetach: () => void;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onPublishGame: () => void;
  onTrailerClick: () => void;
}) {
  const hasPicture =
    (card.photo_scratch_draft ?? 0) > 0 || (card.photo_scratch_done ?? 0) > 0;
  const hasGame = (card.photo_scratch_done ?? 0) > 0;
  const isDraft = Boolean(card.draft);
  const hasTrailer = Boolean(card.trailer?.trim());

  return (
    <div className="models-card-list-row">
      <div className="models-card-list-line models-card-list-line--motion">
        <div className="models-card-list-identity">
          <MotionCardThumb card={card} />
          <div className="models-card-list-identity-text">
            <Text className="models-card-list-line-label" color="gray" size="1" weight="medium">
              Motion card
            </Text>
            <Flex align="baseline" gap="2" wrap="wrap">
              <Text size="2" weight="medium">
                {index + 1}. {card.label}
              </Text>
              {isDraft ? (
                <Badge color="amber" size="1" variant="soft">
                  draft
                </Badge>
              ) : null}
              {!isDraft && hasTrailer ? (
                <Badge color="green" size="1" variant="soft">
                  trailer
                </Badge>
              ) : null}
            </Flex>
            <CodeInline>{card.id}</CodeInline>
          </div>
        </div>

        <div className="models-card-list-actions">
          <Flex align="center" gap="1" justify="end">
            {isDraft ? (
              <>
                <ActionSlot />
                <ActionSlot />
                <ActionSlot />
              </>
            ) : (
              <>
                <ActionSlot>
                  <Button
                    color="gray"
                    disabled={busy || publishedIndex <= 0}
                    size="1"
                    title="Move up"
                    variant="ghost"
                    onClick={onMoveUp}
                  >
                    <ChevronUp {...iconProps} />
                  </Button>
                </ActionSlot>
                <ActionSlot>
                  <Button
                    color="gray"
                    disabled={busy || publishedIndex < 0 || publishedIndex >= publishedCount - 1}
                    size="1"
                    title="Move down"
                    variant="ghost"
                    onClick={onMoveDown}
                  >
                    <ChevronDown {...iconProps} />
                  </Button>
                </ActionSlot>
                <ActionSlot>
                  <Button asChild size="1" variant="soft">
                    <a href={playCardHref(modelId, card.id)} title={`Play ${card.label}`}>
                      <Play {...iconProps} />
                    </a>
                  </Button>
                </ActionSlot>
              </>
            )}
            <ActionSlot>
              <Button asChild size="1" variant="soft">
                <a href={editCardHref(card.id)} title={`Edit ${card.label} in Video Flow`}>
                  <Pencil {...iconProps} />
                </a>
              </Button>
            </ActionSlot>
            <ActionSlot>
              {isDraft ? null : (
                <Button
                  color="gray"
                  disabled={busy}
                  size="1"
                  title="Detach card from this model"
                  variant="ghost"
                  onClick={onDetach}
                >
                  <X {...iconProps} />
                </Button>
              )}
            </ActionSlot>
            <ActionSlot>
              <Button
                color="red"
                disabled={busy}
                size="1"
                title={isDraft ? "Delete draft motion card" : "Delete motion card"}
                variant="ghost"
                onClick={onDelete}
              >
                <Trash2 {...iconProps} />
              </Button>
            </ActionSlot>
          </Flex>
        </div>
      </div>

      {!isDraft ? (
        <div className="models-card-list-line models-card-list-line--trailer">
          {hasTrailer ? (
            <div className="models-card-list-identity">
              <TrailerThumb card={card} />
              <div className="models-card-list-identity-text">
                <Text as="div" className="models-card-list-line-label" color="gray" size="1" weight="medium">
                  Trailer
                </Text>
                <Text as="div" color="gray" size="1">
                  Ready for collection preview
                </Text>
              </div>
            </div>
          ) : (
            <div className="models-card-list-identity-text">
              <Text as="div" className="models-card-list-line-label" color="gray" size="1" weight="medium">
                Trailer
              </Text>
            </div>
          )}
          <div className="models-card-list-actions">
            <Button disabled={busy} size="1" variant="soft" onClick={onTrailerClick}>
              <Upload {...iconProps} />
              {hasTrailer ? "Replace trailer" : "Upload trailer"}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="models-card-list-line models-card-list-line--photos">
        <div className="models-card-list-photos">
          <Text className="models-card-list-line-label" color="gray" size="1" weight="medium">
            Photo Scratch
          </Text>
          <PhotoScratchThumbs card={card} />
          <PhotoScratchStatus card={card} />
        </div>

        <div className="models-card-list-actions">
          <Flex align="center" gap="1" justify="end">
            <ActionSlot>
              {hasPicture ? (
                <Button asChild color="green" size="1" variant="soft">
                  <a href={pictureFlowHref(card.id)} title="Picture Flow">
                    <Images {...iconProps} />
                  </a>
                </Button>
              ) : null}
            </ActionSlot>
            <ActionSlot>
              {hasGame ? (
                <Button
                  color="green"
                  disabled={busy}
                  size="1"
                  title="Publish photo-scratch game"
                  variant="soft"
                  onClick={onPublishGame}
                >
                  <Gamepad2 {...iconProps} />
                </Button>
              ) : null}
            </ActionSlot>
          </Flex>
        </div>
      </div>
    </div>
  );
}

function TagsEditor({
  busy,
  suggestions = [],
  value,
  onChange,
}: {
  busy: boolean;
  suggestions?: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const tags = parseTagInput(value);
  const query = draft.trim().toLowerCase();
  const availableSuggestions = mergeTagSuggestions(suggestions)
    .filter((tag) => !tags.includes(tag))
    .filter((tag) => !query || tag.includes(query));

  function setTags(next: string[]) {
    onChange(formatTagsInput(next));
  }

  function addTags(raw: string) {
    const incoming = parseTagInput(raw);
    if (incoming.length === 0) {
      setDraft("");
      return;
    }
    const next = [...tags];
    const seen = new Set(next);
    let added = false;
    for (const tag of incoming) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      next.push(tag);
      added = true;
    }
    setDraft("");
    if (added) setTags(next);
  }

  return (
    <Flex direction="column" gap="2">
      <div className="model-tags-well">
        {tags.map((tag) => (
          <Badge key={tag} className="model-tags-chip" color={tagColor(tag)} size="2" variant="soft">
            {tag}
            <button
              aria-label={`Remove ${tag}`}
              className="model-tags-chip-remove"
              disabled={busy}
              type="button"
              onClick={() => setTags(tags.filter((item) => item !== tag))}
            >
              <X size={12} strokeWidth={2.5} />
            </button>
          </Badge>
        ))}
        <input
          className="model-tags-input"
          aria-label="Add tag"
          disabled={busy}
          placeholder={tags.length === 0 ? "Type a tag and press Enter" : "Add another…"}
          value={draft}
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (next.includes(",")) {
              addTags(next);
              return;
            }
            setDraft(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && !draft && tags.length > 0) {
              setTags(tags.slice(0, -1));
              return;
            }
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (availableSuggestions.length === 1 && query) {
              addTags(availableSuggestions[0]!);
              return;
            }
            addTags(draft);
          }}
        />
      </div>
      {availableSuggestions.length > 0 ? (
        <div className="model-tags-suggest">
          {availableSuggestions.map((tag) => (
            <Button
              key={tag}
              color={tagColor(tag)}
              disabled={busy}
              size="1"
              variant="soft"
              onClick={() => addTags(tag)}
            >
              <Plus size={12} strokeWidth={2.5} />
              {tag}
            </Button>
          ))}
        </div>
      ) : null}
    </Flex>
  );
}

function FlagSvgFilePreview({ file, size = 28 }: { file: File; size?: number }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  if (!src) return null;
  return (
    <img
      alt=""
      src={src}
      style={{
        width: size,
        height: Math.round((size * 3) / 4),
        objectFit: "cover",
        display: "block",
        flexShrink: 0,
        borderRadius: 4,
        border: "1px solid var(--gray-a6)",
        background: "var(--gray-a2)",
      }}
    />
  );
}

function CreateModelFields({
  busy,
  modelCity,
  modelColorEnd,
  modelColorStart,
  modelLightColor1,
  modelLightColor2,
  modelCountry,
  modelFlagFile,
  modelId,
  modelLabel,
  modelName,
  modelTags,
  stacked = false,
  suggestedTags = [],
  onModelCityChange,
  onModelColorEndChange,
  onModelColorStartChange,
  onModelLightColor1Change,
  onModelLightColor2Change,
  onModelCountryChange,
  onModelFlagCountrySelect,
  onModelFlagFileChange,
  onModelIdChange,
  onModelLabelChange,
  onModelNameChange,
  onModelTagsChange,
  onSubmit,
}: {
  busy: boolean;
  modelCity: string;
  modelColorEnd: string;
  modelColorStart: string;
  modelLightColor1: string;
  modelLightColor2: string;
  modelCountry: string;
  modelFlagFile: File | null;
  modelId: string;
  modelLabel: string;
  modelName: string;
  modelTags: string;
  stacked?: boolean;
  suggestedTags?: string[];
  onModelCityChange: (value: string) => void;
  onModelColorEndChange: (value: string) => void;
  onModelColorStartChange: (value: string) => void;
  onModelLightColor1Change: (value: string) => void;
  onModelLightColor2Change: (value: string) => void;
  onModelCountryChange: (value: string) => void;
  onModelFlagCountrySelect: (countryCode: string) => void;
  onModelFlagFileChange: (file: File | null) => void;
  onModelIdChange: (value: string) => void;
  onModelLabelChange: (value: string) => void;
  onModelNameChange: (value: string) => void;
  onModelTagsChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <Flex direction="column" gap="3">
      <Grid columns={stacked ? "1" : { initial: "1", md: "2" }} gap="3">
        <label>
          <Text as="div" mb="1" size="2" weight="medium">
            Model id
          </Text>
          <TextField.Root
            disabled={busy}
            placeholder="janja"
            value={modelId}
            onChange={(event) => onModelIdChange(event.currentTarget.value)}
          />
        </label>
        <label>
          <Text as="div" mb="1" size="2" weight="medium">
            Label
          </Text>
          <TextField.Root
            disabled={busy}
            placeholder="janja"
            value={modelLabel}
            onChange={(event) => onModelLabelChange(event.currentTarget.value)}
          />
        </label>
        <label>
          <Text as="div" mb="1" size="2" weight="medium">
            Influencer name
          </Text>
          <TextField.Root
            disabled={busy}
            placeholder="Juliana"
            value={modelName}
            onChange={(event) => onModelNameChange(event.currentTarget.value)}
          />
        </label>
        <Box>
          <Text as="div" mb="1" size="2" weight="medium">
            Flag SVG
          </Text>
          <Flex align="center" gap="2" wrap="wrap">
            {modelFlagFile ? <FlagSvgFilePreview file={modelFlagFile} size={32} /> : null}
            <CountryFlagPicker busy={busy} size="2" onSelect={onModelFlagCountrySelect} />
            <Button asChild disabled={busy} size="2" variant="soft">
              <label style={{ cursor: busy ? "not-allowed" : "pointer" }}>
                <Upload {...iconProps} />
                {modelFlagFile ? "Change SVG" : "Choose SVG"}
                <input
                  accept="image/svg+xml,.svg"
                  disabled={busy}
                  hidden
                  type="file"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0] ?? null;
                    event.currentTarget.value = "";
                    onModelFlagFileChange(file);
                  }}
                />
              </label>
            </Button>
            {modelFlagFile ? (
              <>
                <Text color="gray" size="1" truncate style={{ maxWidth: 160 }}>
                  {modelFlagFile.name}
                </Text>
                <Button
                  color="gray"
                  disabled={busy}
                  size="1"
                  variant="ghost"
                  onClick={() => onModelFlagFileChange(null)}
                >
                  Clear
                </Button>
              </>
            ) : null}
          </Flex>
        </Box>
        <label>
          <Text as="div" mb="1" size="2" weight="medium">
            City
          </Text>
          <TextField.Root
            disabled={busy}
            placeholder="Buenos Aires"
            value={modelCity}
            onChange={(event) => onModelCityChange(event.currentTarget.value)}
          />
        </label>
        <label>
          <Text as="div" mb="1" size="2" weight="medium">
            Country
          </Text>
          <TextField.Root
            disabled={busy}
            placeholder="Argentina"
            value={modelCountry}
            onChange={(event) => onModelCountryChange(event.currentTarget.value)}
          />
        </label>
      </Grid>
      <Box>
        <Text as="div" mb="1" size="2" weight="medium">
          Tags
        </Text>
        <TagsEditor
          busy={busy}
          suggestions={suggestedTags}
          value={modelTags}
          onChange={onModelTagsChange}
        />
      </Box>
      <Box>
        <Text as="div" mb="2" size="2" weight="bold">
          Card overlay
        </Text>
        <Grid columns={stacked ? "1" : { initial: "1", md: "2" }} gap="3">
          <ColorField
            busy={busy}
            label="Start"
            value={modelColorStart}
            onChange={onModelColorStartChange}
          />
          <ColorField
            busy={busy}
            label="End"
            value={modelColorEnd}
            onChange={onModelColorEndChange}
          />
        </Grid>
      </Box>
      <Box>
        <Text as="div" mb="2" size="2" weight="bold">
          Card light
        </Text>
        <Grid columns={stacked ? "1" : { initial: "1", md: "2" }} gap="3">
          <ColorField
            busy={busy}
            label="Light 1"
            value={modelLightColor1}
            onChange={onModelLightColor1Change}
          />
          <ColorField
            busy={busy}
            label="Light 2"
            value={modelLightColor2}
            onChange={onModelLightColor2Change}
          />
        </Grid>
      </Box>
      <Flex align={stacked ? "stretch" : "end"}>
        <Button
          disabled={busy || !modelId.trim()}
          style={stacked ? { width: "100%" } : undefined}
          onClick={onSubmit}
        >
          <UserRound {...iconProps} />
          Create model
        </Button>
      </Flex>
    </Flex>
  );
}

function CreateCardForm({
  busy,
  cardId,
  cardLabel,
  onCancel,
  onCardIdChange,
  onCardLabelChange,
  onSubmit,
}: {
  busy: boolean;
  cardId: string;
  cardLabel: string;
  onCancel: () => void;
  onCardIdChange: (value: string) => void;
  onCardLabelChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <Flex
      align={{ initial: "stretch", md: "end" }}
      direction={{ initial: "column", md: "row" }}
      gap="2"
      wrap="wrap"
      style={{
        padding: 12,
        borderRadius: 10,
        background: "var(--gray-2)",
        border: "1px solid var(--gray-5)",
      }}
    >
      <label style={{ flex: 1, minWidth: 140 }}>
        <Text as="div" mb="1" size="1" weight="medium">
          Card id
        </Text>
        <TextField.Root
          disabled={busy}
          placeholder="shine_5"
          value={cardId}
          onChange={(event) => onCardIdChange(event.currentTarget.value)}
        />
      </label>
      <label style={{ flex: 1, minWidth: 140 }}>
        <Text as="div" mb="1" size="1" weight="medium">
          Label
        </Text>
        <TextField.Root
          disabled={busy}
          placeholder="Shine 5"
          value={cardLabel}
          onChange={(event) => onCardLabelChange(event.currentTarget.value)}
        />
      </label>
      <Flex gap="2">
        <Button disabled={busy || !cardId.trim()} onClick={onSubmit}>
          <Plus {...iconProps} />
          Create & edit
        </Button>
        <Button color="gray" disabled={busy} variant="soft" onClick={onCancel}>
          Cancel
        </Button>
      </Flex>
    </Flex>
  );
}
