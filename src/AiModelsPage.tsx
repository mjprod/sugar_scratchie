import { ChevronDown, ChevronUp, Pencil, Plus, Search, Trash2 } from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  Container,
  Flex,
  Heading,
  Select,
  Text,
  TextField,
} from "@radix-ui/themes";
import { useMemo, useState } from "react";
import {
  createGenerationModel,
  deleteGenerationModel,
  lookupProviderModels,
  modelsForRole,
  updateGenerationModel,
  useGenerationCatalog,
  type GenerationAdapter,
  type GenerationModelInfo,
  type GenerationModelRole,
  type RemoteProviderModel,
} from "./shared/generationModels";

const iconProps = { size: 16, strokeWidth: 2 } as const;

const ROLE_TITLES: Record<GenerationModelRole, string> = {
  background_video: "Step 1 · Photo to video",
  dress_video: "Step 3 · Outfit change",
  source_image: "Source photo",
};

const ROLE_HELP: Record<GenerationModelRole, string> = {
  background_video: "Turns the still into the clip the player scratches.",
  dress_video: "Changes her clothes on that clip.",
  source_image: "The starting portrait, when Video Flow generates one.",
};

const ROLES: GenerationModelRole[] = ["background_video", "dress_video", "source_image"];

type ProviderName = "wavespeed" | "xai";

type FormState = {
  id: string;
  role: GenerationModelRole;
  label: string;
  adapter: string;
  endpoint_path: string;
  reference_token: string;
  variant: string;
  enabled: boolean;
  idTouched: boolean;
};

function emptyForm(adapters: GenerationAdapter[], provider: ProviderName): FormState {
  const role: GenerationModelRole = "dress_video";
  const adapter = adapterFor(adapters, role, provider);
  return {
    id: "",
    role,
    label: "",
    adapter: adapter?.id ?? "reference_video_edit",
    endpoint_path: "",
    reference_token: adapter?.needs_reference_token ? "@Image 1" : "",
    variant: adapter?.needs_variant ? "seedance" : "",
    enabled: true,
    idTouched: false,
  };
}

function formFromModel(model: GenerationModelInfo): FormState {
  return {
    id: model.id,
    role: model.role,
    label: model.label,
    adapter: model.adapter,
    endpoint_path: model.endpoint_path,
    reference_token: model.reference_token,
    variant: model.variant || "wan30",
    enabled: model.enabled,
    idTouched: true,
  };
}

function adapterFor(
  adapters: GenerationAdapter[],
  role: GenerationModelRole,
  provider: ProviderName,
): GenerationAdapter | undefined {
  return (
    adapters.find((item) => item.roles.includes(role) && item.provider === provider) ??
    adapters.find((item) => item.roles.includes(role))
  );
}

function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64);
}

function prettyModelName(raw: string): string {
  const parts = raw.replace(/^\//, "").split("/").filter(Boolean);
  const body = (parts.length > 1 ? parts.slice(1) : parts).join(" ");
  const words = body.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return raw;
  return words.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function errorMessage(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught);
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    // The API sometimes returns plain text.
  }
  return raw;
}

function toPayload(form: FormState, adapter: GenerationAdapter | undefined) {
  return {
    id: form.id.trim(),
    role: form.role,
    label: form.label.trim(),
    adapter: form.adapter,
    endpoint_path:
      adapter?.needs_endpoint || adapter?.provider === "xai" ? form.endpoint_path.trim() : "",
    reference_token: adapter?.needs_reference_token ? form.reference_token.trim() : "",
    variant: adapter?.needs_variant ? form.variant : "",
    enabled: form.enabled,
  };
}

function providerLabel(provider: ProviderName): string {
  return provider === "xai" ? "x.ai" : "WaveSpeed";
}

export function AiModelsPage() {
  const { models, adapters, loaded, refresh } = useGenerationCatalog();
  const [form, setForm] = useState<FormState | null>(null);
  const [editing, setEditing] = useState<GenerationModelInfo | null>(null);
  const [provider, setProvider] = useState<ProviderName>("wavespeed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupResults, setLookupResults] = useState<RemoteProviderModel[]>([]);
  const [lookupNote, setLookupNote] = useState("");
  const [picked, setPicked] = useState<RemoteProviderModel | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const roleAdapters = useMemo(
    () => adapters.filter((adapter) => form && adapter.roles.includes(form.role) && adapter.provider === provider),
    [adapters, form, provider],
  );
  const selectedAdapter =
    adapters.find((adapter) => adapter.id === form?.adapter) ?? roleAdapters[0];
  const readyToSave = Boolean(form && form.label.trim() && form.id.trim() && (editing || form.endpoint_path.trim()));

  function clearLookup() {
    setLookupQuery("");
    setLookupResults([]);
    setLookupNote("");
    setPicked(null);
    setAdvanced(false);
  }

  function startCreate() {
    setEditing(null);
    setProvider("wavespeed");
    setError("");
    clearLookup();
    setForm(emptyForm(adapters, "wavespeed"));
  }

  function startEdit(model: GenerationModelInfo) {
    setEditing(model);
    setProvider(model.provider);
    setError("");
    clearLookup();
    setForm(formFromModel(model));
  }

  function chooseProvider(next: ProviderName) {
    setProvider(next);
    setLookupResults([]);
    setLookupNote("");
    setPicked(null);
    setForm((current) => {
      if (!current || editing) return current;
      const adapter = adapterFor(adapters, current.role, next);
      return {
        ...current,
        adapter: adapter?.id ?? current.adapter,
        endpoint_path: "",
        reference_token: adapter?.needs_reference_token ? current.reference_token || "@Image 1" : "",
        variant: adapter?.needs_variant ? current.variant || "seedance" : "",
      };
    });
  }

  function changeRole(role: GenerationModelRole) {
    setForm((current) => {
      if (!current) return current;
      const adapter = adapterFor(adapters, role, provider);
      return {
        ...current,
        role,
        adapter: adapter?.id ?? current.adapter,
        reference_token: adapter?.needs_reference_token ? current.reference_token || "@Image 1" : "",
        variant: adapter?.needs_variant ? current.variant || "wan30" : "",
      };
    });
  }

  function applyRemote(row: RemoteProviderModel) {
    const displayName = prettyModelName(row.name);
    setPicked(row);
    setProvider(row.provider);
    setForm((current) => {
      if (!current) return current;
      const next: FormState = { ...current, endpoint_path: row.model_id };
      if (editing) {
        const fits =
          row.suggested_role === current.role &&
          adapters.some((adapter) => adapter.id === row.suggested_adapter && adapter.roles.includes(current.role));
        if (fits) {
          next.adapter = row.suggested_adapter;
          next.variant = row.variant || current.variant;
          next.reference_token = row.reference_token || current.reference_token;
        }
        if (!current.label.trim()) next.label = displayName;
        return next;
      }
      const adapter = adapters.find((item) => item.id === row.suggested_adapter);
      next.label = displayName;
      next.role = row.suggested_role;
      next.adapter = row.suggested_adapter;
      next.variant = row.variant || (adapter?.needs_variant ? "seedance" : "");
      next.reference_token = row.reference_token;
      if (!current.idTouched) next.id = slugify(displayName);
      return next;
    });
  }

  async function lookUp() {
    setBusy(true);
    setError("");
    setLookupNote("");
    try {
      const rows = await lookupProviderModels({
        provider,
        query: lookupQuery,
      });
      setLookupResults(rows);
      setLookupNote(
        rows.length === 0
          ? `Nothing named “${lookupQuery.trim() || "that"}” is on your ${providerLabel(provider)} account.`
          : "",
      );
    } catch (caught) {
      setLookupResults([]);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    setError("");
    try {
      const payload = toPayload(form, selectedAdapter);
      if (editing) {
        await updateGenerationModel(editing.role, editing.id, payload);
      } else {
        await createGenerationModel(payload);
      }
      setForm(null);
      setEditing(null);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(model: GenerationModelInfo) {
    if (
      !window.confirm(
        `Remove “${model.label}” from ${ROLE_TITLES[model.role]}? Drafts that still name it fall back to the default model.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await deleteGenerationModel(model.role, model.id);
      if (editing?.id === model.id && editing.role === model.role) {
        setEditing(null);
        setForm(null);
      }
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function move(model: GenerationModelInfo, direction: -1 | 1) {
    const siblings = modelsForRole(models, model.role, { enabledOnly: false });
    const index = siblings.findIndex((item) => item.id === model.id);
    const neighbor = siblings[index + direction];
    if (!neighbor) return;
    setBusy(true);
    setError("");
    try {
      await updateGenerationModel(model.role, model.id, { ...model, sort_order: neighbor.sort_order });
      await updateGenerationModel(neighbor.role, neighbor.id, { ...neighbor, sort_order: model.sort_order });
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="dashboard-root">
      <Container size="3">
        <Flex direction="column" gap="5" py="6">
          <Flex align="center" justify="between" wrap="wrap" gap="3">
            <Box style={{ maxWidth: 560 }}>
              <Text className="eyebrow" size="2">
                Sugar Scratchie
              </Text>
              <Heading size="7">AI models</Heading>
              <Text color="gray" size="2">
                These are the choices in the Video Flow dropdowns. To add one, search your WaveSpeed or
                x.ai account and pick a model that is actually there.
              </Text>
            </Box>
            <Flex gap="2" wrap="wrap">
              <Button onClick={startCreate} disabled={!loaded || adapters.length === 0}>
                <Plus {...iconProps} />
                Add a model
              </Button>
              <Button asChild variant="soft">
                <a href="/dashboard/video-flow/run">Video Flow</a>
              </Button>
              <Button asChild color="gray" variant="soft">
                <a href="/dashboard">Dashboard</a>
              </Button>
            </Flex>
          </Flex>

          {error ? (
            <Callout.Root color="red">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          ) : null}

          {form ? (
            <Card size="3">
              <Flex direction="column" gap="4">
                <Box>
                  <Heading size="4">{editing ? `Edit “${editing.label}”` : "Add a model"}</Heading>
                  <Text color="gray" size="2">
                    {editing
                      ? "Change the name, or search if you want to point this choice at a different model."
                      : "Choose the company, search, then name it for the dropdown."}
                  </Text>
                </Box>

                {editing ? null : (
                  <Flex gap="3" wrap="wrap">
                    <button
                      type="button"
                      className={provider === "wavespeed" ? "ai-model-choice is-selected" : "ai-model-choice"}
                      onClick={() => chooseProvider("wavespeed")}
                    >
                      <Text as="div" weight="bold">
                        WaveSpeed
                      </Text>
                      <Text as="div" color="gray" size="2">
                        WAN, Seedance, Seedream
                      </Text>
                    </button>
                    <button
                      type="button"
                      className={provider === "xai" ? "ai-model-choice is-selected" : "ai-model-choice"}
                      onClick={() => chooseProvider("xai")}
                    >
                      <Text as="div" weight="bold">
                        x.ai
                      </Text>
                      <Text as="div" color="gray" size="2">
                        Grok Imagine image and video
                      </Text>
                    </button>
                  </Flex>
                )}

                <Flex direction="column" gap="2">
                  <Text size="2" weight="medium">
                    Search {providerLabel(provider)}
                  </Text>
                  <Flex gap="2" wrap="wrap">
                    <Box style={{ flex: "1 1 240px" }}>
                      <TextField.Root
                        value={lookupQuery}
                        placeholder={provider === "xai" ? "grok imagine video" : "seedance or wan"}
                        onChange={(event) => setLookupQuery(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void lookUp();
                          }
                        }}
                      />
                    </Box>
                    <Button disabled={busy} onClick={() => void lookUp()}>
                      <Search {...iconProps} />
                      {busy ? "Searching…" : "Search"}
                    </Button>
                  </Flex>
                  <Text color="gray" size="1">
                    Only models on your {providerLabel(provider)} account show up. Saving checks again.
                  </Text>
                  {lookupNote ? (
                    <Callout.Root color="amber">
                      <Callout.Text>{lookupNote}</Callout.Text>
                    </Callout.Root>
                  ) : null}
                  {lookupResults.length > 0 ? (
                    <div className="ai-model-results">
                      {lookupResults.map((row) => {
                        const selected = picked?.model_id === row.model_id && picked.provider === row.provider;
                        return (
                          <button
                            key={`${row.provider}:${row.model_id}`}
                            type="button"
                            className={selected ? "ai-model-result is-selected" : "ai-model-result"}
                            onClick={() => applyRemote(row)}
                          >
                            <Text as="div" size="2" weight="medium">
                              {prettyModelName(row.name)}
                            </Text>
                            <Text as="div" size="1" color="gray">
                              {ROLE_TITLES[row.suggested_role]}
                              {row.kind ? ` · ${row.kind.replace(/-/g, " ")}` : ""}
                            </Text>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </Flex>

                {picked || editing ? (
                  <Flex direction="column" gap="3">
                    {picked ? (
                      <Callout.Root color="green">
                        <Callout.Text>
                          {prettyModelName(picked.name)} is on your {providerLabel(picked.provider)} account.
                        </Callout.Text>
                      </Callout.Root>
                    ) : editing?.endpoint_path ? (
                      <Text color="gray" size="2">
                        Currently {editing.endpoint_path}
                      </Text>
                    ) : editing?.provider === "xai" ? (
                      <Text color="gray" size="2">
                        This built-in uses the x.ai model from the server settings. Search if you want to pin a
                        specific one.
                      </Text>
                    ) : null}

                    <label>
                      <Text as="div" mb="1" size="2" weight="medium">
                        Name in the dropdown
                      </Text>
                      <TextField.Root
                        value={form.label}
                        placeholder="Seedance 2.5 outfit video"
                        onChange={(event) => {
                          const label = event.currentTarget.value;
                          setForm((current) =>
                            current
                              ? {
                                  ...current,
                                  label,
                                  id: current.idTouched ? current.id : slugify(label),
                                }
                              : current,
                          );
                        }}
                      />
                    </label>

                    {editing ? (
                      <Text size="2" color="gray">
                        Shows up in {ROLE_TITLES[form.role]}
                      </Text>
                    ) : (
                      <label>
                        <Text as="div" mb="1" size="2" weight="medium">
                          Shows up in
                        </Text>
                        <Select.Root value={form.role} onValueChange={(value) => changeRole(value as GenerationModelRole)}>
                          <Select.Trigger />
                          <Select.Content>
                            {ROLES.map((role) => (
                              <Select.Item key={role} value={role}>
                                {ROLE_TITLES[role]}
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Root>
                        <Text as="div" mt="1" size="1" color="gray">
                          {ROLE_HELP[form.role]}
                        </Text>
                      </label>
                    )}

                    {picked && picked.suggested_role !== form.role ? (
                      <Text size="1" color="gray">
                        {providerLabel(picked.provider)} lists this as {ROLE_TITLES[picked.suggested_role]}. You can
                        still place it on another step.
                      </Text>
                    ) : null}

                    <Flex align="center" gap="2">
                      <Checkbox
                        checked={form.enabled}
                        onCheckedChange={(checked) =>
                          setForm((current) => (current ? { ...current, enabled: checked === true } : current))
                        }
                      />
                      <Text size="2">Show in the Video Flow dropdown</Text>
                    </Flex>

                    <Button
                      color="gray"
                      variant="ghost"
                      style={{ alignSelf: "flex-start" }}
                      onClick={() => setAdvanced((open) => !open)}
                    >
                      {advanced ? "Hide technical details" : "Technical details"}
                    </Button>
                    {advanced ? (
                      <Flex direction="column" gap="3">
                        <label>
                          <Text as="div" mb="1" size="1" weight="medium" color="gray">
                            How Video Flow calls it
                          </Text>
                          <Select.Root
                            value={form.adapter}
                            onValueChange={(value) =>
                              setForm((current) => (current ? { ...current, adapter: value } : current))
                            }
                          >
                            <Select.Trigger />
                            <Select.Content>
                              {(roleAdapters.length ? roleAdapters : adapters.filter((item) => item.roles.includes(form.role))).map(
                                (adapter) => (
                                  <Select.Item key={adapter.id} value={adapter.id}>
                                    {adapter.label}
                                  </Select.Item>
                                ),
                              )}
                            </Select.Content>
                          </Select.Root>
                        </label>
                        <label>
                          <Text as="div" mb="1" size="1" weight="medium" color="gray">
                            {provider === "xai" ? "x.ai model id" : "WaveSpeed path"}
                          </Text>
                          <TextField.Root
                            value={form.endpoint_path}
                            onChange={(event) => {
                              setPicked(null);
                              setForm((current) =>
                                current ? { ...current, endpoint_path: event.currentTarget.value } : current,
                              );
                            }}
                          />
                        </label>
                        {editing ? null : (
                          <label>
                            <Text as="div" mb="1" size="1" weight="medium" color="gray">
                              Internal id
                            </Text>
                            <TextField.Root
                              value={form.id}
                              onChange={(event) =>
                                setForm((current) =>
                                  current ? { ...current, id: event.currentTarget.value, idTouched: true } : current,
                                )
                              }
                            />
                          </label>
                        )}
                        {selectedAdapter?.needs_variant ? (
                          <label>
                            <Text as="div" mb="1" size="1" weight="medium" color="gray">
                              Outfit reference style
                            </Text>
                            <Select.Root
                              value={form.variant || "wan30"}
                              onValueChange={(value) =>
                                setForm((current) => (current ? { ...current, variant: value } : current))
                              }
                            >
                              <Select.Trigger />
                              <Select.Content>
                                <Select.Item value="wan30">WAN — say “Image 1”</Select.Item>
                                <Select.Item value="seedance">Seedance — say “@Image 1”</Select.Item>
                              </Select.Content>
                            </Select.Root>
                          </label>
                        ) : null}
                        {selectedAdapter?.needs_reference_token ? (
                          <label>
                            <Text as="div" mb="1" size="1" weight="medium" color="gray">
                              Words the prompt uses for the outfit photo
                            </Text>
                            <TextField.Root
                              value={form.reference_token}
                              onChange={(event) =>
                                setForm((current) =>
                                  current ? { ...current, reference_token: event.currentTarget.value } : current,
                                )
                              }
                            />
                          </label>
                        ) : null}
                      </Flex>
                    ) : null}
                  </Flex>
                ) : (
                  <Text color="gray" size="2">
                    Search, then choose a model. The name and dropdown step fill in from that choice.
                  </Text>
                )}

                <Flex gap="2">
                  <Button disabled={busy || !readyToSave} onClick={() => void save()}>
                    {editing ? "Save" : "Add to Video Flow"}
                  </Button>
                  <Button
                    color="gray"
                    variant="soft"
                    disabled={busy}
                    onClick={() => {
                      setForm(null);
                      setEditing(null);
                    }}
                  >
                    Cancel
                  </Button>
                </Flex>
              </Flex>
            </Card>
          ) : null}

          {!loaded ? (
            <Text color="gray">Loading models…</Text>
          ) : (
            ROLES.map((role) => {
              const rows = modelsForRole(models, role, { enabledOnly: false });
              return (
                <Box key={role}>
                  <Heading size="4">{ROLE_TITLES[role]}</Heading>
                  <Text as="p" color="gray" size="2" mb="2">
                    {ROLE_HELP[role]}
                  </Text>
                  <Flex direction="column" gap="2">
                    {rows.length === 0 ? (
                      <Text color="gray" size="2">
                        Nothing here yet.
                      </Text>
                    ) : (
                      rows.map((model, index) => (
                        <Card key={`${model.role}:${model.id}`}>
                          <Flex align="center" justify="between" gap="3" wrap="wrap">
                            <Box>
                              <Flex align="center" gap="2" wrap="wrap">
                                <Text weight="medium">{model.label}</Text>
                                <Badge color={model.provider === "wavespeed" ? "orange" : "cyan"} variant="soft">
                                  {providerLabel(model.provider)}
                                </Badge>
                                {!model.enabled ? (
                                  <Badge color="gray" variant="soft">
                                    Hidden
                                  </Badge>
                                ) : null}
                              </Flex>
                              <Text color="gray" size="1">
                                {model.endpoint_path || "Uses the account default"}
                              </Text>
                            </Box>
                            <Flex gap="1">
                              <Button
                                aria-label="Move up"
                                color="gray"
                                size="1"
                                variant="soft"
                                disabled={busy || index === 0}
                                onClick={() => void move(model, -1)}
                              >
                                <ChevronUp {...iconProps} />
                              </Button>
                              <Button
                                aria-label="Move down"
                                color="gray"
                                size="1"
                                variant="soft"
                                disabled={busy || index === rows.length - 1}
                                onClick={() => void move(model, 1)}
                              >
                                <ChevronDown {...iconProps} />
                              </Button>
                              <Button color="gray" size="1" variant="soft" disabled={busy} onClick={() => startEdit(model)}>
                                <Pencil {...iconProps} />
                                Rename
                              </Button>
                              <Button color="red" size="1" variant="soft" disabled={busy} onClick={() => void remove(model)}>
                                <Trash2 {...iconProps} />
                                Remove
                              </Button>
                            </Flex>
                          </Flex>
                        </Card>
                      ))
                    )}
                  </Flex>
                </Box>
              );
            })
          )}
        </Flex>
      </Container>
    </main>
  );
}
