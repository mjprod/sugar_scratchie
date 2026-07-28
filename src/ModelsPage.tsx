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
  Select,
  Table,
  Text,
  TextField,
} from "@radix-ui/themes";
import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "./shared/api";
import { suggestCardId } from "./shared/groupCards";
import {
  assignCardToModel,
  createModel,
  createMotionCardDraft,
  deleteCard,
  deleteModel,
  fetchModels,
  fetchPhotoScratchSlots,
  photoScratchPlayHref,
  publishPhotoScratchGame,
  reorderModelCards,
  updateModel,
  uploadModelAvatar,
  uploadModelFlagSvg,
  type ModelInfo,
  type PhotoInfo,
  type PhotoScratchSlot,
} from "./shared/models";
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

function modelGradientCss(model: Pick<ModelInfo, "cardOverlayColorStart" | "cardOverlayColorEnd">): string {
  const start = model.cardOverlayColorStart?.trim() ?? "";
  const end = model.cardOverlayColorEnd?.trim() ?? "";
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
  const [newModelName, setNewModelName] = useState("");
  const [newModelCity, setNewModelCity] = useState("");
  const [newModelCountry, setNewModelCountry] = useState("");
  const [newModelFlag, setNewModelFlag] = useState("");
  const [newModelColorStart, setNewModelColorStart] = useState("");
  const [newModelColorEnd, setNewModelColorEnd] = useState("");
  const [creatingCardFor, setCreatingCardFor] = useState("");
  const [newCardId, setNewCardId] = useState("");
  const [newCardLabel, setNewCardLabel] = useState("");
  const [createModelOpen, setCreateModelOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState(readSelectedModelId);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const flagInputRef = useRef<HTMLInputElement>(null);
  const [avatarTargetId, setAvatarTargetId] = useState("");
  const [flagTargetId, setFlagTargetId] = useState("");

  useEffect(() => {
    const sync = () => setSelectedModelId(readSelectedModelId());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  async function refresh() {
    const [nextModels, assets, flowData] = await Promise.all([
      fetchModels(),
      api<{ cards: CardInfo[] }>("/api/cards"),
      api<{ flows: VideoFlowProject[] }>("/api/video-flow").catch(() => ({ flows: [] as VideoFlowProject[] })),
    ]);
    const themes = themesByCardId(flowData.flows);
    const published = assets.cards.map((card) => ({
      ...card,
      theme: card.theme ?? themes.get(card.id),
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
  }

  useEffect(() => {
    refresh().catch((caught) => setError(String(caught)));
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

  function clearNewModelForm() {
    setNewModelId("");
    setNewModelLabel("");
    setNewModelName("");
    setNewModelCity("");
    setNewModelCountry("");
    setNewModelFlag("");
    setNewModelColorStart("");
    setNewModelColorEnd("");
  }

  async function handleCreateModel() {
    setBusy(true);
    setError("");
    try {
      await createModel(newModelId.trim(), newModelLabel.trim() || newModelId.trim(), {
        influencerName: newModelName.trim() || null,
        influencerCity: newModelCity.trim() || null,
        influencerCountry: newModelCountry.trim() || null,
        influencerFlag: newModelFlag.trim() || null,
        cardOverlayColorStart: newModelColorStart.trim() || null,
        cardOverlayColorEnd: newModelColorEnd.trim() || null,
      });
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
      });
      setEditingId("");
      setEditingLabel("");
      setEditingName("");
      setEditingCity("");
      setEditingCountry("");
      setEditingFlag("");
      setEditingColorStart("");
      setEditingColorEnd("");
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
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= modelCards.length) return;
    const nextIds = modelCards.map((card) => card.id);
    const [moved] = nextIds.splice(index, 1);
    nextIds.splice(nextIndex, 0, moved!);
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
                onClick={() => refresh().catch((caught) => setError(String(caught)))}
              >
                <LoaderCircle {...iconProps} />
                Refresh
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
              onAssignCard={(cardId, modelId) => void handleAssignCard(cardId, modelId)}
              onAvatarClick={() => {
                setAvatarTargetId(selectedModel.id);
                avatarInputRef.current?.click();
              }}
              onFlagClick={() => {
                setFlagTargetId(selectedModel.id);
                flagInputRef.current?.click();
              }}
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
              }}
            />
          ) : (
            <>
              <Card size="3" className="models-create-inline">
                <Heading size="4" mb="3">
                  Create model
                </Heading>
                <CreateModelFields
                  busy={busy}
                  modelCity={newModelCity}
                  modelColorEnd={newModelColorEnd}
                  modelColorStart={newModelColorStart}
                  modelCountry={newModelCountry}
                  modelFlag={newModelFlag}
                  modelId={newModelId}
                  modelLabel={newModelLabel}
                  modelName={newModelName}
                  onModelCityChange={setNewModelCity}
                  onModelColorEndChange={setNewModelColorEnd}
                  onModelColorStartChange={setNewModelColorStart}
                  onModelCountryChange={setNewModelCountry}
                  onModelFlagChange={setNewModelFlag}
                  onModelIdChange={setNewModelId}
                  onModelLabelChange={setNewModelLabel}
                  onModelNameChange={setNewModelName}
                  onSubmit={() => void handleCreateModel()}
                />
              </Card>

              <Box className="models-create-mobile">
                <Dialog.Root open={createModelOpen} onOpenChange={setCreateModelOpen}>
                  <Dialog.Trigger>
                    <Button size="3" style={{ width: "100%" }} variant="soft">
                      <Plus {...iconProps} />
                      Create model
                    </Button>
                  </Dialog.Trigger>
                  <Dialog.Content style={{ maxWidth: 420 }}>
                    <Dialog.Title>Create model</Dialog.Title>
                    <Dialog.Description size="2" mb="3">
                      Add a girl/persona. You can attach motion cards after.
                    </Dialog.Description>
                    <CreateModelFields
                      busy={busy}
                      modelCity={newModelCity}
                      modelColorEnd={newModelColorEnd}
                      modelColorStart={newModelColorStart}
                      modelCountry={newModelCountry}
                      modelFlag={newModelFlag}
                      modelId={newModelId}
                      modelLabel={newModelLabel}
                      modelName={newModelName}
                      stacked
                      onModelCityChange={setNewModelCity}
                      onModelColorEndChange={setNewModelColorEnd}
                      onModelColorStartChange={setNewModelColorStart}
                      onModelCountryChange={setNewModelCountry}
                      onModelFlagChange={setNewModelFlag}
                      onModelIdChange={setNewModelId}
                      onModelLabelChange={setNewModelLabel}
                      onModelNameChange={setNewModelName}
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
              </Box>

              {models.length > 0 ? (
                <Flex direction="column" gap="3">
                  <Heading size="4">Models</Heading>
                  {models.map((model) => {
                    const count = (cardsByModel.get(model.id) ?? []).length;
                    const location = modelLocationLine(model);
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
                        </Box>
                      </a>
                    );
                  })}
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

function ModelDetail({
  busy,
  creatingCardFor,
  editingCity,
  editingColorEnd,
  editingColorStart,
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
  onAssignCard,
  onAvatarClick,
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
  onEditingCountryChange,
  onEditingFlagChange,
  onEditingLabelChange,
  onEditingNameChange,
  onFlagClick,
  onMoveCard,
  onOpenCreateCard,
  onPublishGame,
  onRename,
  onStartRename,
}: {
  busy: boolean;
  creatingCardFor: string;
  editingCity: string;
  editingColorEnd: string;
  editingColorStart: string;
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
  onAssignCard: (cardId: string, modelId: string) => void;
  onAvatarClick: () => void;
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
  onEditingCountryChange: (value: string) => void;
  onEditingFlagChange: (value: string) => void;
  onEditingLabelChange: (value: string) => void;
  onEditingNameChange: (value: string) => void;
  onFlagClick: () => void;
  onMoveCard: (cardId: string, direction: -1 | 1) => void;
  onOpenCreateCard: () => void;
  onPublishGame: (cardId: string) => void;
  onRename: () => void;
  onStartRename: () => void;
}) {
  const candidates = importableCards.filter((card) => card.model_id !== model.id);
  const publishedCards = modelCards.filter((entry) => !entry.draft);
  const locationLine = modelLocationLine(model);
  const gradientCss = modelGradientCss(model);

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
                    <Flex align="center" gap="2">
                      {model.influencerFlagSvg ? (
                        <img
                          alt=""
                          src={model.influencerFlagSvg}
                          style={{ width: 28, height: 28, objectFit: "contain" }}
                        />
                      ) : (
                        <Text color="gray" size="1">
                          No SVG yet
                        </Text>
                      )}
                      <Button disabled={busy} size="1" variant="soft" onClick={onFlagClick}>
                        <Upload {...iconProps} />
                        Upload SVG
                      </Button>
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
                      title={`${model.cardOverlayColorStart} → ${model.cardOverlayColorEnd}`}
                    />
                  ) : null}
                </Flex>
                <Text as="div" color="gray" mt="1" size="2">
                  {[
                    locationLine || null,
                    `${publishedCards.length} published`,
                    modelCards.some((card) => card.draft)
                      ? `${modelCards.filter((card) => card.draft).length} draft`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </>
            )}
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
            {modelCards.map((card, index) => {
              const publishedIndex = publishedCards.findIndex((entry) => entry.id === card.id);
              return (
                <MotionCardRow
                  key={card.id}
                  busy={busy}
                  card={card}
                  index={index}
                  modelId={model.id}
                  publishedIndex={publishedIndex}
                  publishedCount={publishedCards.length}
                  onDelete={() => onDeleteCard(card)}
                  onDetach={() => onDetachCard(card.id)}
                  onMoveDown={() => onMoveCard(card.id, 1)}
                  onMoveUp={() => onMoveCard(card.id, -1)}
                  onPublishGame={() => onPublishGame(card.id)}
                />
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
  const videoSrc = motionCardVideoSrc(card);
  const [peek, setPeek] = useState<{ point: PeekPoint } | null>(null);
  const peekHandlers = useInstagramPeek(
    (point) => setPeek({ point }),
    () => setPeek(null),
  );

  if (!videoSrc) {
    return <div aria-hidden className="models-card-thumb models-card-thumb--empty" />;
  }

  return (
    <>
      <button
        aria-label={`Hold to preview ${card.label}`}
        className="models-card-thumb models-card-thumb--button"
        type="button"
        title="Hold to preview motion card · release to close"
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
          src={videoSrc}
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
        <MiniMediaOverlay label={card.label} point={peek.point} src={videoSrc} type="video" />
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
}) {
  const hasPicture =
    (card.photo_scratch_draft ?? 0) > 0 || (card.photo_scratch_done ?? 0) > 0;
  const hasGame = (card.photo_scratch_done ?? 0) > 0;
  const isDraft = Boolean(card.draft);

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
              {card.theme ? (
                <Badge color="iris" size="1" title="Theme" variant="soft">
                  {card.theme}
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

function CreateModelFields({
  busy,
  modelCity,
  modelColorEnd,
  modelColorStart,
  modelCountry,
  modelFlag,
  modelId,
  modelLabel,
  modelName,
  stacked = false,
  onModelCityChange,
  onModelColorEndChange,
  onModelColorStartChange,
  onModelCountryChange,
  onModelFlagChange,
  onModelIdChange,
  onModelLabelChange,
  onModelNameChange,
  onSubmit,
}: {
  busy: boolean;
  modelCity: string;
  modelColorEnd: string;
  modelColorStart: string;
  modelCountry: string;
  modelFlag: string;
  modelId: string;
  modelLabel: string;
  modelName: string;
  stacked?: boolean;
  onModelCityChange: (value: string) => void;
  onModelColorEndChange: (value: string) => void;
  onModelColorStartChange: (value: string) => void;
  onModelCountryChange: (value: string) => void;
  onModelFlagChange: (value: string) => void;
  onModelIdChange: (value: string) => void;
  onModelLabelChange: (value: string) => void;
  onModelNameChange: (value: string) => void;
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
        <label>
          <Text as="div" mb="1" size="2" weight="medium">
            Flag emoji (optional)
          </Text>
          <TextField.Root
            disabled={busy}
            placeholder="🇦🇷"
            value={modelFlag}
            onChange={(event) => onModelFlagChange(event.currentTarget.value)}
          />
        </label>
        <Text color="gray" size="1" style={{ alignSelf: "end", paddingBottom: 8 }}>
          Upload a flag SVG after creating the model.
        </Text>
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
