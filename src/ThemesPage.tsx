import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Home,
  LoaderCircle,
  Pencil,
  Plus,
  Tags,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Container,
  Flex,
  Grid,
  Heading,
  Text,
  TextField,
} from "@radix-ui/themes";
import { useCallback, useEffect, useState } from "react";
import {
  createTheme,
  deleteTheme,
  fetchThemes,
  reorderThemes,
  updateTheme,
  type ThemeInfo,
} from "./shared/themes";
import { labelFromProjectId, PROJECT_ID_PATTERN, slugifyProjectId } from "./videoFlow/projects";

const iconProps = { size: 16, strokeWidth: 2 } as const;

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
  const trimmed = value.trim();
  const hasValue = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed);
  const pickerValue = normalizeHexColor(trimmed || "#ffffff");
  return (
    <label style={{ minWidth: 0 }}>
      <Text as="div" mb="1" size="1" weight="medium" color="gray">
        {label}
      </Text>
      <Flex align="center" gap="2">
        <input
          disabled={busy}
          type="color"
          value={pickerValue}
          onChange={(event) => onChange(event.currentTarget.value)}
          style={{
            width: 32,
            height: 32,
            flexShrink: 0,
            padding: 0,
            border: "1px solid var(--gray-a6)",
            borderRadius: 6,
            background: hasValue ? pickerValue : "var(--gray-3)",
            cursor: busy ? "not-allowed" : "pointer",
            opacity: hasValue ? 1 : 0.55,
          }}
        />
        <TextField.Root
          disabled={busy}
          placeholder="#ff8fab"
          size="2"
          style={{ flex: 1, minWidth: 0 }}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </Flex>
    </label>
  );
}

function CardColorFields({
  busy,
  overlayStart,
  overlayEnd,
  light1,
  light2,
  onOverlayStart,
  onOverlayEnd,
  onLight1,
  onLight2,
}: {
  busy: boolean;
  overlayStart: string;
  overlayEnd: string;
  light1: string;
  light2: string;
  onOverlayStart: (value: string) => void;
  onOverlayEnd: (value: string) => void;
  onLight1: (value: string) => void;
  onLight2: (value: string) => void;
}) {
  return (
    <Grid columns={{ initial: "1", sm: "2", md: "4" }} gap="2">
      <ColorField busy={busy} label="Overlay start" value={overlayStart} onChange={onOverlayStart} />
      <ColorField busy={busy} label="Overlay end" value={overlayEnd} onChange={onOverlayEnd} />
      <ColorField busy={busy} label="Light 1" value={light1} onChange={onLight1} />
      <ColorField busy={busy} label="Light 2" value={light2} onChange={onLight2} />
    </Grid>
  );
}

function CollapsibleCardColors({
  busy,
  open,
  onOpenChange,
  overlayStart,
  overlayEnd,
  light1,
  light2,
  onOverlayStart,
  onOverlayEnd,
  onLight1,
  onLight2,
}: {
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  overlayStart: string;
  overlayEnd: string;
  light1: string;
  light2: string;
  onOverlayStart: (value: string) => void;
  onOverlayEnd: (value: string) => void;
  onLight1: (value: string) => void;
  onLight2: (value: string) => void;
}) {
  return (
    <Box>
      <Flex align="center" gap="3" wrap="wrap">
        <Button
          color="gray"
          size="1"
          type="button"
          variant="soft"
          onClick={() => onOpenChange(!open)}
        >
          {open ? <ChevronUp {...iconProps} /> : <ChevronDown {...iconProps} />}
          Card colours
        </Button>
        {open ? null : (
          <Flex align="center" gap="4" wrap="wrap">
            <ThemeColorChip label="Overlay" start={overlayStart} end={overlayEnd} />
            <ThemeColorChip label="Light" start={light1} end={light2} />
          </Flex>
        )}
      </Flex>
      {open ? (
        <Box mt="3">
          <CardColorFields
            busy={busy}
            overlayStart={overlayStart}
            overlayEnd={overlayEnd}
            light1={light1}
            light2={light2}
            onOverlayStart={onOverlayStart}
            onOverlayEnd={onOverlayEnd}
            onLight1={onLight1}
            onLight2={onLight2}
          />
        </Box>
      ) : null}
    </Box>
  );
}

function gradientCss(start?: string | null, end?: string | null): string {
  const a = (start ?? "").trim();
  const b = (end ?? "").trim();
  if (!a && !b) return "";
  if (a && b) return `linear-gradient(90deg, ${a}, ${b})`;
  return a || b;
}

function ThemeColorChip({
  label,
  start,
  end,
}: {
  label: string;
  start?: string | null;
  end?: string | null;
}) {
  const fill = gradientCss(start, end);
  return (
    <Flex align="center" gap="2" style={{ flexShrink: 0 }}>
      <Text size="1" color="gray">
        {label}
      </Text>
      <Box
        aria-hidden
        title={
          start && end ? `${start} → ${end}` : start || end || `${label} unset`
        }
        style={{
          width: 72,
          height: 18,
          borderRadius: 999,
          background: fill || "var(--gray-4)",
          border: "1px solid var(--gray-a6)",
          boxShadow: fill ? `inset 0 0 0 1px ${start || end}` : undefined,
        }}
      />
    </Flex>
  );
}

export function ThemesPage() {
  const [themes, setThemes] = useState<ThemeInfo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newOverlayStart, setNewOverlayStart] = useState("");
  const [newOverlayEnd, setNewOverlayEnd] = useState("");
  const [newLight1, setNewLight1] = useState("");
  const [newLight2, setNewLight2] = useState("");
  const [showNewColors, setShowNewColors] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [editingLabel, setEditingLabel] = useState("");
  const [editingOverlayStart, setEditingOverlayStart] = useState("");
  const [editingOverlayEnd, setEditingOverlayEnd] = useState("");
  const [editingLight1, setEditingLight1] = useState("");
  const [editingLight2, setEditingLight2] = useState("");
  const [showEditColors, setShowEditColors] = useState(false);

  const refresh = useCallback(async () => {
    const next = await fetchThemes();
    setThemes(next);
  }, []);

  useEffect(() => {
    refresh().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [refresh]);

  async function handleCreate() {
    const id = slugifyProjectId(newId);
    const label = newLabel.trim() || labelFromProjectId(id);
    if (!PROJECT_ID_PATTERN.test(id)) {
      setError("Theme id must be lowercase letters, numbers, and underscores.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createTheme(id, label, {
        cardOverlayColorStart: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(newOverlayStart.trim()) ? newOverlayStart.trim() : null,
        cardOverlayColorEnd: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(newOverlayEnd.trim()) ? newOverlayEnd.trim() : null,
        cardLightColor1: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(newLight1.trim()) ? newLight1.trim() : null,
        cardLightColor2: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(newLight2.trim()) ? newLight2.trim() : null,
      });
      setNewId("");
      setNewLabel("");
      setNewOverlayStart("");
      setNewOverlayEnd("");
      setNewLight1("");
      setNewLight2("");
      setShowNewColors(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(themeId: string) {
    const label = editingLabel.trim();
    if (!label) {
      setError("Theme label is required.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await updateTheme(themeId, {
        label,
        cardOverlayColorStart: editingOverlayStart.trim(),
        cardOverlayColorEnd: editingOverlayEnd.trim(),
        cardLightColor1: editingLight1.trim(),
        cardLightColor2: editingLight2.trim(),
      });
      setEditingId("");
      setEditingLabel("");
      setEditingOverlayStart("");
      setEditingOverlayEnd("");
      setEditingLight1("");
      setEditingLight2("");
      setShowEditColors(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(theme: ThemeInfo) {
    if (!window.confirm(`Delete theme “${theme.label}”? Existing cards keep their theme text.`)) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await deleteTheme(theme.id);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleMove(themeId: string, direction: -1 | 1) {
    const index = themes.findIndex((theme) => theme.id === themeId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= themes.length) return;
    const nextIds = themes.map((theme) => theme.id);
    const tmp = nextIds[index]!;
    nextIds[index] = nextIds[nextIndex]!;
    nextIds[nextIndex] = tmp;
    setBusy(true);
    setError("");
    try {
      const next = await reorderThemes(nextIds);
      setThemes(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
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
              <Heading size="7">Themes</Heading>
              <Text color="gray" size="2">
                Categories for motion cards and photo scratch. Pick one in Video Flow Setup.
                Upload intro videos on the model page under each theme header.
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
                <a href="/dashboard/models">Models</a>
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

          <Card>
            <Flex align="center" gap="2" mb="3">
              <Tags {...iconProps} />
              <Heading as="h2" size="4">
                Add theme
              </Heading>
            </Flex>
            <Grid columns={{ initial: "1", sm: "2", md: "3" }} gap="2" mb="3">
              <label>
                <Text as="div" mb="1" size="1" weight="medium" color="gray">
                  Id
                </Text>
                <TextField.Root
                  disabled={busy}
                  placeholder="police"
                  value={newId}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setNewId(value);
                    if (!newLabel || newLabel === labelFromProjectId(slugifyProjectId(newId))) {
                      setNewLabel(labelFromProjectId(slugifyProjectId(value)));
                    }
                  }}
                />
              </label>
              <label>
                <Text as="div" mb="1" size="1" weight="medium" color="gray">
                  Label
                </Text>
                <TextField.Root
                  disabled={busy}
                  placeholder="Police"
                  value={newLabel}
                  onChange={(event) => setNewLabel(event.currentTarget.value)}
                />
              </label>
              <Flex align="end">
                <Button
                  disabled={busy || !newId.trim()}
                  style={{ width: "100%" }}
                  onClick={() => void handleCreate()}
                >
                  <Plus {...iconProps} />
                  Create theme
                </Button>
              </Flex>
            </Grid>
            <CollapsibleCardColors
              busy={busy}
              open={showNewColors}
              onOpenChange={setShowNewColors}
              overlayStart={newOverlayStart}
              overlayEnd={newOverlayEnd}
              light1={newLight1}
              light2={newLight2}
              onOverlayStart={setNewOverlayStart}
              onOverlayEnd={setNewOverlayEnd}
              onLight1={setNewLight1}
              onLight2={setNewLight2}
            />
          </Card>

          <Card>
            <Heading as="h2" mb="3" size="4">
              All themes
            </Heading>
            {themes.length === 0 ? (
              <Text color="gray" size="2">
                No themes yet. Create one above.
              </Text>
            ) : (
              <Flex direction="column" gap="2">
                {themes.map((theme, index) => {
                  const stripe = gradientCss(
                    theme.cardOverlayColorStart,
                    theme.cardOverlayColorEnd,
                  );
                  const editing = editingId === theme.id;
                  return (
                  <Flex
                    key={theme.id}
                    align={editing ? "stretch" : "center"}
                    gap="3"
                    style={{
                      padding: editing ? 12 : "8px 10px 8px 8px",
                      borderRadius: 10,
                      border: "1px solid var(--gray-5)",
                      background: "var(--gray-2)",
                    }}
                  >
                    {editing ? null : (
                      <Box
                        aria-hidden
                        style={{
                          width: 8,
                          alignSelf: "stretch",
                          minHeight: 28,
                          borderRadius: 6,
                          background: stripe || "var(--gray-5)",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <Box style={{ minWidth: 0, flex: 1 }}>
                      {editing ? (
                        <Flex direction="column" gap="3">
                          <Flex align="end" gap="2" wrap="wrap">
                            <label style={{ flex: 1, minWidth: 160 }}>
                              <Text as="div" mb="1" size="1" weight="medium" color="gray">
                                Label
                              </Text>
                              <TextField.Root
                                disabled={busy}
                                value={editingLabel}
                                onChange={(event) => setEditingLabel(event.currentTarget.value)}
                              />
                            </label>
                            <Button disabled={busy} onClick={() => void handleRename(theme.id)}>
                              Save
                            </Button>
                            <Button
                              color="gray"
                              disabled={busy}
                              variant="soft"
                              onClick={() => {
                                setEditingId("");
                                setEditingLabel("");
                                setShowEditColors(false);
                              }}
                            >
                              Cancel
                            </Button>
                          </Flex>
                          <CollapsibleCardColors
                            busy={busy}
                            open={showEditColors}
                            onOpenChange={setShowEditColors}
                            overlayStart={editingOverlayStart}
                            overlayEnd={editingOverlayEnd}
                            light1={editingLight1}
                            light2={editingLight2}
                            onOverlayStart={setEditingOverlayStart}
                            onOverlayEnd={setEditingOverlayEnd}
                            onLight1={setEditingLight1}
                            onLight2={setEditingLight2}
                          />
                        </Flex>
                      ) : (
                        <Flex align="center" gap="3" wrap="wrap">
                          <Flex align="center" gap="2" wrap="wrap" style={{ flex: 1, minWidth: 160 }}>
                            <Text size="3" weight="medium">
                              {theme.label}
                            </Text>
                            <Badge color="iris" size="1" variant="soft">
                              {theme.id}
                            </Badge>
                            {theme.intro?.trim() ? (
                              <Badge color="blue" size="1" variant="soft">
                                intro
                              </Badge>
                            ) : null}
                          </Flex>
                          <Flex align="center" gap="4" wrap="wrap">
                            <ThemeColorChip
                              label="Overlay"
                              start={theme.cardOverlayColorStart}
                              end={theme.cardOverlayColorEnd}
                            />
                            <ThemeColorChip
                              label="Light"
                              start={theme.cardLightColor1}
                              end={theme.cardLightColor2}
                            />
                          </Flex>
                        </Flex>
                      )}
                    </Box>
                    {editing ? null : (
                      <Flex gap="1" style={{ flexShrink: 0 }}>
                        <Button
                          color="gray"
                          disabled={busy || index <= 0}
                          size="1"
                          variant="ghost"
                          onClick={() => void handleMove(theme.id, -1)}
                        >
                          <ChevronUp {...iconProps} />
                        </Button>
                        <Button
                          color="gray"
                          disabled={busy || index >= themes.length - 1}
                          size="1"
                          variant="ghost"
                          onClick={() => void handleMove(theme.id, 1)}
                        >
                          <ChevronDown {...iconProps} />
                        </Button>
                        <Button
                          color="gray"
                          disabled={busy}
                          size="1"
                          variant="soft"
                          onClick={() => {
                            setEditingId(theme.id);
                            setEditingLabel(theme.label);
                            setEditingOverlayStart(theme.cardOverlayColorStart ?? "");
                            setEditingOverlayEnd(theme.cardOverlayColorEnd ?? "");
                            setEditingLight1(theme.cardLightColor1 ?? "");
                            setEditingLight2(theme.cardLightColor2 ?? "");
                            setShowEditColors(false);
                          }}
                        >
                          <Pencil {...iconProps} />
                        </Button>
                        <Button
                          color="red"
                          disabled={busy}
                          size="1"
                          variant="soft"
                          onClick={() => void handleDelete(theme)}
                        >
                          <Trash2 {...iconProps} />
                        </Button>
                      </Flex>
                    )}
                  </Flex>
                  );
                })}
              </Flex>
            )}
          </Card>
        </Flex>
      </Container>
    </main>
  );
}
