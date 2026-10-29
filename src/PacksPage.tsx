import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Home,
  LoaderCircle,
  Search,
} from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Container,
  Flex,
  Grid,
  Heading,
  Text,
  TextField,
} from "@radix-ui/themes";
import { useEffect, useMemo, useRef, useState } from "react";
import { FoilPackagesPanel } from "./FoilPackagesPanel";
import { ModelVideoSlot } from "./ModelVideoSlot";
import { captureVideoFirstFrame, captureVideoSrcFirstFrame, dataUrlToFile } from "./shared/media";
import {
  fetchModels,
  MODEL_VIDEO_POSTER_KIND,
  updateModel,
  uploadModelPoster,
  uploadModelVideo,
  type ModelInfo,
  type ModelVideoKind,
} from "./shared/models";

const iconProps = { size: 16, strokeWidth: 2 } as const;

type PackVideoKind = Extract<ModelVideoKind, "pack-face" | "pack-face-2">;

function packHref(modelId: string): string {
  return `/dashboard/packs?model=${encodeURIComponent(modelId)}`;
}

function readSelectedModelId(): string {
  return new URLSearchParams(window.location.search).get("model")?.trim() ?? "";
}

function modelTitle(model: ModelInfo): string {
  return model.influencerName?.trim() || model.label;
}

function modelInitial(model: ModelInfo): string {
  return (modelTitle(model).trim() || model.id).charAt(0).toLowerCase();
}

function posterKey(modelId: string, kind: PackVideoKind): string {
  return `${modelId}:${kind}`;
}

export function PacksPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const selectedModelId = readSelectedModelId();

  async function refresh() {
    const next = await fetchModels();
    setModels(next);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void refresh()
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = models.find((model) => model.id === selectedModelId) ?? null;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((model) => {
      const haystack = [model.id, model.label, model.influencerName ?? ""].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }, [models, query]);

  return (
    <main className="dashboard-root">
      <Container size="4">
        <Flex direction="column" gap="4" py="6">
          <Flex align="center" justify="between" wrap="wrap" gap="3">
            <Box>
              <Text className="eyebrow" size="2">
                Sugar Scratchie
              </Text>
              <Heading size="7">Packs</Heading>
              <Text color="gray" size="2">
                Foil pack videos, names, and n8n packages for each model.
              </Text>
            </Box>
            <Flex gap="2" wrap="wrap">
              <Button
                color="gray"
                variant="soft"
                onClick={() => {
                  setError("");
                  void refresh().catch((caught: unknown) => {
                    setError(caught instanceof Error ? caught.message : String(caught));
                  });
                }}
              >
                <LoaderCircle {...iconProps} />
                Refresh
              </Button>
              <Button asChild variant="soft">
                <a href="/dashboard/models">Models</a>
              </Button>
              <Button asChild variant="soft">
                <a href="/dashboard/themes">Themes</a>
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

          {loading ? (
            <Text color="gray" size="2">
              Loading models…
            </Text>
          ) : selectedModelId && !selected ? (
            <Callout.Root color="amber">
              <Callout.Icon>
                <AlertTriangle {...iconProps} />
              </Callout.Icon>
              <Callout.Text>
                Model “{selectedModelId}” was not found. <a href="/dashboard/packs">Back to packs</a>
              </Callout.Text>
            </Callout.Root>
          ) : selected ? (
            <PackEditor
              model={selected}
              onError={setError}
              onSaved={() => {
                void refresh().catch((caught: unknown) => {
                  setError(caught instanceof Error ? caught.message : String(caught));
                });
              }}
            />
          ) : (
            <PackModelList models={filtered} query={query} onQueryChange={setQuery} />
          )}
        </Flex>
      </Container>
    </main>
  );
}

function PackModelList({
  models,
  query,
  onQueryChange,
}: {
  models: ModelInfo[];
  query: string;
  onQueryChange: (value: string) => void;
}) {
  return (
    <Flex direction="column" gap="3">
      <TextField.Root
        placeholder="Search name or id"
        value={query}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
      >
        <TextField.Slot>
          <Search {...iconProps} />
        </TextField.Slot>
      </TextField.Root>
      {models.length === 0 ? (
        <Text color="gray" size="2">
          {query.trim() ? "No models match this search." : "No models yet. Create one on Models first."}
        </Text>
      ) : (
        models.map((model) => {
          const packs = [model.packFaceVideoUrl, model.packFaceVideoUrl2].filter((url) => url?.trim()).length;
          return (
            <a key={model.id} className="models-list-card" href={packHref(model.id)}>
              <Box
                className="models-list-avatar"
                style={{ width: 44, height: 44, borderRadius: 10 }}
              >
                {model.avatar ? <img alt="" src={model.avatar} /> : <span aria-hidden>{modelInitial(model)}</span>}
              </Box>
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Text as="div" size="3" weight="bold" truncate>
                  {modelTitle(model)}
                </Text>
                <Text as="div" color="gray" size="1">
                  {model.id}
                </Text>
              </Box>
              <Badge color={packs > 0 ? "green" : "gray"} variant="soft">
                {packs === 0 ? "No foil video" : `${packs} foil video${packs === 1 ? "" : "s"}`}
              </Badge>
            </a>
          );
        })
      )}
    </Flex>
  );
}

function PackEditor({
  model,
  onError,
  onSaved,
}: {
  model: ModelInfo;
  onError: (message: string) => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [packNameDraft, setPackNameDraft] = useState(model.cardPackName ?? "");
  const [packName2Draft, setPackName2Draft] = useState(model.cardPackName2 ?? "");
  const [videoPosters, setVideoPosters] = useState<Record<string, string>>({});
  const [videoTarget, setVideoTarget] = useState<PackVideoKind | null>(null);
  const [posterTarget, setPosterTarget] = useState<PackVideoKind | null>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const posterInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPackNameDraft(model.cardPackName ?? "");
    setPackName2Draft(model.cardPackName2 ?? "");
  }, [model.id, model.cardPackName, model.cardPackName2]);

  const packNamesDirty =
    packNameDraft.trim() !== (model.cardPackName ?? "").trim() ||
    packName2Draft.trim() !== (model.cardPackName2 ?? "").trim();
  const displayName = model.influencerName?.trim() || model.label;

  async function savePackNames() {
    setBusy(true);
    onError("");
    try {
      await updateModel(model.id, {
        cardPackName: packNameDraft.trim(),
        cardPackName2: packName2Draft.trim(),
      });
      onSaved();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleVideoUpload(kind: PackVideoKind, file: File) {
    setBusy(true);
    onError("");
    const key = posterKey(model.id, kind);
    const posterKind = MODEL_VIDEO_POSTER_KIND[kind];
    try {
      const poster = await captureVideoFirstFrame(file).catch(() => null);
      if (poster) setVideoPosters((prev) => ({ ...prev, [key]: poster }));
      await uploadModelVideo(model.id, kind, file);
      onSaved();
      if (poster) {
        try {
          await uploadModelPoster(model.id, posterKind, dataUrlToFile(poster, `${posterKind}.webp`));
          onSaved();
        } catch (caughtPoster) {
          onError(caughtPoster instanceof Error ? caughtPoster.message : String(caughtPoster));
        }
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handlePosterUpload(kind: PackVideoKind, file: File) {
    setBusy(true);
    onError("");
    try {
      await uploadModelPoster(model.id, MODEL_VIDEO_POSTER_KIND[kind], file);
      onSaved();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleGeneratePoster(kind: PackVideoKind, videoUrl: string) {
    setBusy(true);
    onError("");
    const key = posterKey(model.id, kind);
    const posterKind = MODEL_VIDEO_POSTER_KIND[kind];
    try {
      const poster = await captureVideoSrcFirstFrame(videoUrl);
      setVideoPosters((prev) => ({ ...prev, [key]: poster }));
      await uploadModelPoster(model.id, posterKind, dataUrlToFile(poster, `${posterKind}.webp`));
      onSaved();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Flex direction="column" gap="3">
      <Flex gap="2" wrap="wrap">
        <Button asChild color="gray" size="2" variant="soft">
          <a href="/dashboard/packs">
            <ArrowLeft {...iconProps} />
            All packs
          </a>
        </Button>
        <Button asChild size="2" variant="soft">
          <a href={`/dashboard/models?model=${encodeURIComponent(model.id)}`}>Open model</a>
        </Button>
      </Flex>

      <Box>
        <Flex align="center" gap="2" wrap="wrap" mb="1">
          <Heading size="5">{modelTitle(model)}</Heading>
          <Badge color="plum" variant="soft">
            {model.id}
          </Badge>
        </Flex>
        <Text as="div" color="gray" size="2">
          Card pack names replace “Pack Nº …” under the foil packs in the product app. Create with
          n8n sends the pack video to the foil flow and saves a package you can apply below.
        </Text>
      </Box>

      <Grid columns={{ initial: "1", sm: "2" }} gap="3" style={{ alignItems: "stretch" }}>
        <ModelVideoSlot
          busy={busy}
          label="Foil 3D pack video"
          pathHint={`models/${model.id}/pack-face.*`}
          posterPathHint={`models/${model.id}/pack-face-poster.webp`}
          photoLabel="Pack poster"
          url={model.packFaceVideoUrl}
          savedPosterUrl={model.packFacePosterUrl}
          uploadPosterUrl={videoPosters[posterKey(model.id, "pack-face")]}
          packName={packNameDraft}
          onPackNameChange={setPackNameDraft}
          onUpload={() => {
            setVideoTarget("pack-face");
            videoInputRef.current?.click();
          }}
          onPosterUpload={() => {
            setPosterTarget("pack-face");
            posterInputRef.current?.click();
          }}
          onGeneratePoster={
            model.packFaceVideoUrl
              ? () => void handleGeneratePoster("pack-face", model.packFaceVideoUrl!)
              : undefined
          }
          foilN8n={{
            modelId: model.id,
            kind: "pack-face",
            name: displayName,
            code: model.id,
            onSaved,
          }}
        />
        <ModelVideoSlot
          busy={busy}
          label="Foil 3D pack video 2"
          pathHint={`models/${model.id}/pack-face-2.*`}
          posterPathHint={`models/${model.id}/pack-face-2-poster.webp`}
          photoLabel="Pack poster"
          url={model.packFaceVideoUrl2}
          savedPosterUrl={model.packFacePosterUrl2}
          uploadPosterUrl={videoPosters[posterKey(model.id, "pack-face-2")]}
          packName={packName2Draft}
          onPackNameChange={setPackName2Draft}
          onUpload={() => {
            setVideoTarget("pack-face-2");
            videoInputRef.current?.click();
          }}
          onPosterUpload={() => {
            setPosterTarget("pack-face-2");
            posterInputRef.current?.click();
          }}
          onGeneratePoster={
            model.packFaceVideoUrl2
              ? () => void handleGeneratePoster("pack-face-2", model.packFaceVideoUrl2!)
              : undefined
          }
          foilN8n={{
            modelId: model.id,
            kind: "pack-face-2",
            name: displayName,
            code: model.id,
            onSaved,
          }}
        />
      </Grid>

      <Flex align="center" gap="2" wrap="wrap">
        <Button disabled={busy || !packNamesDirty} size="1" onClick={() => void savePackNames()}>
          Save pack names
        </Button>
        {packNamesDirty ? (
          <Text color="gray" size="1">
            Unsaved name changes
          </Text>
        ) : null}
      </Flex>

      <FoilPackagesPanel modelId={model.id} onApplied={onSaved} />

      <input
        ref={videoInputRef}
        accept="video/mp4,video/webm,.mp4,.webm"
        hidden
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file && videoTarget) void handleVideoUpload(videoTarget, file);
        }}
      />
      <input
        ref={posterInputRef}
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        hidden
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file && posterTarget) void handlePosterUpload(posterTarget, file);
        }}
      />
    </Flex>
  );
}
