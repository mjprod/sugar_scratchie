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

export function ThemesPage() {
  const [themes, setThemes] = useState<ThemeInfo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editingLabel, setEditingLabel] = useState("");

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
      await createTheme(id, label);
      setNewId("");
      setNewLabel("");
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
      await updateTheme(themeId, { label });
      setEditingId("");
      setEditingLabel("");
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
      <Container size="3">
        <Flex direction="column" gap="4" py="6">
          <Flex align="center" justify="between" wrap="wrap" gap="3">
            <Box>
              <Text className="eyebrow" size="2">
                Sugar Scratchie
              </Text>
              <Heading size="7">Themes</Heading>
              <Text color="gray" size="2">
                Categories for motion cards and photo scratch. Pick one in Video Flow Setup.
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
            <Flex
              align={{ initial: "stretch", sm: "end" }}
              direction={{ initial: "column", sm: "row" }}
              gap="2"
              wrap="wrap"
            >
              <label style={{ flex: 1, minWidth: 140 }}>
                <Text as="div" mb="1" size="1" weight="medium">
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
              <label style={{ flex: 1, minWidth: 140 }}>
                <Text as="div" mb="1" size="1" weight="medium">
                  Label
                </Text>
                <TextField.Root
                  disabled={busy}
                  placeholder="Police"
                  value={newLabel}
                  onChange={(event) => setNewLabel(event.currentTarget.value)}
                />
              </label>
              <Button disabled={busy || !newId.trim()} onClick={() => void handleCreate()}>
                <Plus {...iconProps} />
                Create theme
              </Button>
            </Flex>
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
                {themes.map((theme, index) => (
                  <Flex
                    key={theme.id}
                    align="center"
                    gap="2"
                    justify="between"
                    wrap="wrap"
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid var(--gray-5)",
                      background: "var(--gray-2)",
                    }}
                  >
                    <Box style={{ minWidth: 0, flex: 1 }}>
                      {editingId === theme.id ? (
                        <Flex align="end" gap="2" wrap="wrap">
                          <label style={{ flex: 1, minWidth: 160 }}>
                            <Text as="div" mb="1" size="1" weight="medium">
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
                            }}
                          >
                            Cancel
                          </Button>
                        </Flex>
                      ) : (
                        <>
                          <Flex align="center" gap="2" wrap="wrap">
                            <Text size="3" weight="medium">
                              {theme.label}
                            </Text>
                            <Badge color="iris" size="1" variant="soft">
                              {theme.id}
                            </Badge>
                          </Flex>
                        </>
                      )}
                    </Box>
                    {editingId === theme.id ? null : (
                      <Flex gap="1">
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
                ))}
              </Flex>
            )}
          </Card>
        </Flex>
      </Container>
    </main>
  );
}
