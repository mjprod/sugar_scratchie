import { Select } from "@radix-ui/themes";
import { useEffect, useState } from "react";
import { api } from "./api";
import {
  BACKGROUND_VIDEO_MODELS,
  DRESS_VIDEO_MODELS,
  SOURCE_IMAGE_MODELS,
} from "../videoFlow/storage";

export type GenerationModelRole = "source_image" | "background_video" | "dress_video";

export type GenerationAdapter = {
  id: string;
  label: string;
  roles: GenerationModelRole[];
  provider: "xai" | "wavespeed";
  needs_endpoint: boolean;
  needs_reference_token: boolean;
  needs_variant: boolean;
  endpoint_hint: string;
};

export type GenerationModelInfo = {
  id: string;
  role: GenerationModelRole;
  label: string;
  provider: "xai" | "wavespeed";
  adapter: string;
  endpoint_path: string;
  reference_token: string;
  variant: string;
  takes_reference_image: boolean;
  enabled: boolean;
  sort_order: number;
  builtin: boolean;
};

export type GenerationModelInput = {
  id: string;
  role: GenerationModelRole;
  label: string;
  adapter: string;
  endpoint_path: string;
  reference_token: string;
  variant: string;
  enabled: boolean;
};

type Catalog = {
  models: GenerationModelInfo[];
  adapters: GenerationAdapter[];
};

const FALLBACK_MODELS: GenerationModelInfo[] = [
  ...SOURCE_IMAGE_MODELS.map((entry, index) =>
    fallbackModel(entry, "source_image", index, entry.id === "seedream-v5-lite" ? "seedream_image" : "grok_image"),
  ),
  ...BACKGROUND_VIDEO_MODELS.map((entry, index) =>
    fallbackModel(entry, "background_video", index, entry.id === "wan-2.2-spicy" ? "wan_spicy_i2v" : "grok_i2v"),
  ),
  ...DRESS_VIDEO_MODELS.map((entry, index) =>
    fallbackModel(
      entry,
      "dress_video",
      index,
      entry.id === "wan-2.2-video-edit"
        ? "prompt_video_edit"
        : entry.id === "grok-imagine"
          ? "grok_video_edit"
          : "reference_video_edit",
    ),
  ),
];

function fallbackModel(
  entry: { id: string; label: string; wavespeed: boolean },
  role: GenerationModelRole,
  sortOrder: number,
  adapter: string,
): GenerationModelInfo {
  return {
    id: entry.id,
    role,
    label: entry.label,
    provider: entry.wavespeed ? "wavespeed" : "xai",
    adapter,
    endpoint_path: "",
    reference_token: entry.id === "seedance-2.0-video-edit" ? "@Image 1" : entry.id === "wan-3.0-video-edit" ? "Image 1" : "",
    variant: entry.id === "seedance-2.0-video-edit" ? "seedance" : entry.id === "wan-3.0-video-edit" ? "wan30" : "",
    takes_reference_image: entry.id === "wan-3.0-video-edit" || entry.id === "seedance-2.0-video-edit",
    enabled: true,
    sort_order: sortOrder,
    builtin: true,
  };
}

let catalogRequest: Promise<Catalog> | null = null;

export function loadGenerationCatalog(force = false): Promise<Catalog> {
  if (force) catalogRequest = null;
  if (!catalogRequest) {
    catalogRequest = fetchGenerationCatalog().catch((error) => {
      catalogRequest = null;
      throw error;
    });
  }
  return catalogRequest;
}

export async function fetchGenerationCatalog(): Promise<Catalog> {
  const data = await api<{ models?: GenerationModelInfo[]; adapters?: GenerationAdapter[] }>(
    "/api/generation-models",
  );
  return {
    models: Array.isArray(data.models) ? data.models : [],
    adapters: Array.isArray(data.adapters) ? data.adapters : [],
  };
}

export async function createGenerationModel(input: GenerationModelInput): Promise<GenerationModelInfo> {
  const created = await api<GenerationModelInfo>("/api/generation-models", {
    method: "POST",
    body: JSON.stringify(input),
  });
  catalogRequest = null;
  return created;
}

export async function updateGenerationModel(
  role: GenerationModelRole,
  modelId: string,
  input: Omit<GenerationModelInput, "id" | "role"> & { sort_order?: number },
): Promise<GenerationModelInfo> {
  const updated = await api<GenerationModelInfo>(
    `/api/generation-models/${encodeURIComponent(role)}/${encodeURIComponent(modelId)}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
  catalogRequest = null;
  return updated;
}

export async function deleteGenerationModel(role: GenerationModelRole, modelId: string): Promise<void> {
  await api(`/api/generation-models/${encodeURIComponent(role)}/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
  });
  catalogRequest = null;
}

export type RemoteProviderModel = {
  provider: "xai" | "wavespeed";
  model_id: string;
  name: string;
  kind: string;
  suggested_role: GenerationModelRole;
  suggested_adapter: string;
  variant: string;
  reference_token: string;
};

export async function lookupProviderModels(input: {
  provider: "xai" | "wavespeed";
  query?: string;
  role?: GenerationModelRole | "";
}): Promise<RemoteProviderModel[]> {
  const data = await api<{ models?: RemoteProviderModel[] }>("/api/generation-models/lookup", {
    method: "POST",
    body: JSON.stringify({
      provider: input.provider,
      query: input.query ?? "",
      role: input.role ?? "",
    }),
  });
  return Array.isArray(data.models) ? data.models : [];
}

export async function checkProviderModel(input: {
  provider: "xai" | "wavespeed";
  model_id: string;
}): Promise<RemoteProviderModel> {
  return api<RemoteProviderModel>("/api/generation-models/check", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function useGenerationCatalog(): {
  models: GenerationModelInfo[];
  adapters: GenerationAdapter[];
  loaded: boolean;
  refresh: () => Promise<void>;
} {
  const [catalog, setCatalog] = useState<Catalog>({ models: [], adapters: [] });
  const [loaded, setLoaded] = useState(false);

  const refresh = async () => {
    const next = await loadGenerationCatalog(true);
    setCatalog(next);
    setLoaded(true);
  };

  useEffect(() => {
    let cancelled = false;
    loadGenerationCatalog()
      .then((next) => {
        if (cancelled) return;
        setCatalog(next);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setCatalog({ models: FALLBACK_MODELS, adapters: [] });
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { models: catalog.models, adapters: catalog.adapters, loaded, refresh };
}

export function modelsForRole(
  models: GenerationModelInfo[],
  role: GenerationModelRole,
  options?: { enabledOnly?: boolean },
): GenerationModelInfo[] {
  const enabledOnly = options?.enabledOnly !== false;
  const source = models.length > 0 ? models : FALLBACK_MODELS;
  return source
    .filter((model) => model.role === role && (!enabledOnly || model.enabled))
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label));
}

export function findGenerationModel(
  models: GenerationModelInfo[],
  role: GenerationModelRole,
  id: string,
): GenerationModelInfo | undefined {
  return models.find((model) => model.role === role && model.id === id);
}

export function GenerationModelSelect({
  role,
  value,
  models,
  onValueChange,
}: {
  role: GenerationModelRole;
  value: string;
  models: GenerationModelInfo[];
  onValueChange: (value: string) => void;
}) {
  const options = modelsForRole(models, role);
  const known = options.some((model) => model.id === value);
  return (
    <Select.Root value={value} onValueChange={onValueChange}>
      <Select.Trigger />
      <Select.Content>
        {!known && value ? <Select.Item value={value}>{value} (not in catalog)</Select.Item> : null}
        {options.map((model) => (
          <Select.Item key={model.id} value={model.id}>
            {model.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}
