import { AlertTriangle, ExternalLink, Home, LoaderCircle, Trash2 } from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  Code,
  Container,
  Flex,
  Grid,
  Heading,
  Text,
  TextField,
} from "@radix-ui/themes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchThemes, type ThemeInfo } from "./shared/themes";
import {
  createThemeSession,
  deleteThemeSession,
  fetchThemeSessions,
  updateThemeSession,
  setThemeSessionThemes,
  setThemeSessionWindow,
  type ThemeSessionInfo,
  type ThemeSessionStatus,
} from "./shared/themeSessions";

const iconProps = { size: 16, strokeWidth: 2 } as const;
const SESSION_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const ACRONYM_PATTERN = /^[A-Za-z]{2}$/;

const STATUS_LABEL: Record<ThemeSessionStatus, string> = {
  fallback: "Fallback",
  draft: "Draft",
  scheduled: "Scheduled",
  running: "Running",
  ended: "Ended",
};

function statusColor(status: ThemeSessionStatus): "green" | "blue" | "gray" | "orange" {
  if (status === "running") return "green";
  if (status === "scheduled") return "blue";
  if (status === "ended") return "orange";
  return "gray";
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** datetime-local is the operator's wall clock. Store the absolute instant. */
function localInputToIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Enter a valid date and time");
  }
  return date.toISOString();
}

function isoToLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function SessionsPage() {
  const [sessions, setSessions] = useState<ThemeSessionInfo[]>([]);
  const [themes, setThemes] = useState<ThemeInfo[]>([]);
  const [selectedId, setSelectedId] = useState("default");
  const [checked, setChecked] = useState<string[]>([]);
  const [createId, setCreateId] = useState("");
  const [createLabel, setCreateLabel] = useState("");
  const [createAcronym, setCreateAcronym] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selected = sessions.find((session) => session.id === selectedId) ?? null;
  const editing = !creating && selected != null;

  const checkedKey = useMemo(() => checked.slice().sort().join("\n"), [checked]);
  const savedKey = useMemo(
    () => (selected?.theme_ids ?? []).slice().sort().join("\n"),
    [selected],
  );
  const themesDirty = selected != null && !selected.is_default && checkedKey !== savedKey;

  const applySessions = useCallback((next: ThemeSessionInfo[], preferId?: string) => {
    setSessions(next);
    setSelectedId((current) => {
      const wanted = preferId || current;
      if (next.some((session) => session.id === wanted)) return wanted;
      return next.find((session) => session.is_running)?.id || next[0]?.id || "default";
    });
  }, []);

  const refresh = useCallback(async () => {
    const [nextSessions, nextThemes] = await Promise.all([fetchThemeSessions(), fetchThemes()]);
    setThemes(nextThemes);
    applySessions(nextSessions);
  }, [applySessions]);

  useEffect(() => {
    refresh().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [refresh]);

  useEffect(() => {
    setChecked(selected?.theme_ids ?? []);
    setStartAt(isoToLocalInput(selected?.starts_at));
    setEndAt(isoToLocalInput(selected?.ends_at));
    if (creating || !selected) return;
    setCreateId(selected.id);
    setCreateLabel(selected.label);
    setCreateAcronym(selected.acronym ?? "");
  }, [creating, selected?.id, selected?.label, selected?.acronym, selected?.starts_at, selected?.ends_at, selected?.theme_ids]);

  function toggleTheme(themeId: string, on: boolean) {
    setChecked((current) => {
      if (on) return current.includes(themeId) ? current : [...current, themeId];
      return current.filter((id) => id !== themeId);
    });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
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
              <Heading size="7">Seasons</Heading>
              <Text color="gray" size="2">
                Default is the normal theme list. A season replaces it only between its start
                and end. Outside those times, players see Default again.
              </Text>
            </Box>
            <Flex gap="2" wrap="wrap">
              <Button color="gray" variant="soft" onClick={() => refresh().catch((caught) => setError(String(caught)))}>
                <LoaderCircle {...iconProps} />
                Refresh
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
            <Callout.Root color="red" role="alert">
              <Callout.Icon>
                <AlertTriangle {...iconProps} />
              </Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          ) : null}

          <Grid columns={{ initial: "1", md: "2" }} gap="4">
            <Card>
              <Heading as="h2" size="4" mb="3">
                {editing ? "Update season" : "Add season"}
              </Heading>
              <Flex direction="column" gap="2">
                <label>
                  <Text as="div" mb="1" size="1" weight="medium" color="gray">
                    Id
                  </Text>
                  <TextField.Root
                    value={createId}
                    placeholder="summer"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={Boolean(editing && selected?.is_default)}
                    onChange={(event) => setCreateId(event.target.value)}
                  />
                </label>
                <label>
                  <Text as="div" mb="1" size="1" weight="medium" color="gray">
                    Name
                  </Text>
                  <TextField.Root
                    value={createLabel}
                    placeholder="Summer"
                    onChange={(event) => setCreateLabel(event.target.value)}
                  />
                </label>
                <label>
                  <Text as="div" mb="1" size="1" weight="medium" color="gray">
                    Acronym
                  </Text>
                  <TextField.Root
                    value={createAcronym}
                    placeholder="SM"
                    maxLength={2}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(event) =>
                      setCreateAcronym(
                        event.target.value.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 2),
                      )
                    }
                  />
                </label>
                <Button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const id = createId.trim().toLowerCase();
                      const label = createLabel.trim();
                      const acronym = createAcronym.trim();
                      const keepingDefault = Boolean(editing && selected?.is_default);
                      if (!keepingDefault && (!SESSION_ID_PATTERN.test(id) || id === "default")) {
                        throw new Error(
                          "Id must start with a letter and use only lowercase letters, numbers, and underscores.",
                        );
                      }
                      if (!label) throw new Error("Name is required.");
                      if (!ACRONYM_PATTERN.test(acronym)) {
                        throw new Error("Acronym must be 2 letters.");
                      }
                      if (editing && selected) {
                        const updated = await updateThemeSession(selected.id, {
                          id: selected.is_default ? "default" : id,
                          label,
                          acronym,
                        });
                        const next = await fetchThemeSessions();
                        applySessions(next, updated.id);
                        return;
                      }
                      const created = await createThemeSession(id, label, acronym);
                      setCreating(false);
                      const next = await fetchThemeSessions();
                      applySessions(next, created.id);
                    })
                  }
                >
                  {editing ? "Update season" : "Create season"}
                </Button>
              </Flex>
            </Card>

            <Card>
              <Flex align="center" justify="between" mb="3">
                <Heading as="h2" size="4">
                  All seasons
                </Heading>
                <Button
                  variant="soft"
                  disabled={busy}
                  onClick={() => {
                    setCreating(true);
                    setSelectedId("");
                    setCreateId("");
                    setCreateLabel("");
                    setCreateAcronym("");
                  }}
                >
                  New season
                </Button>
              </Flex>
              {sessions.length === 0 ? (
                <Text color="gray" size="2">
                  Loading seasons…
                </Text>
              ) : (
                <Flex direction="column" gap="2">
                  {sessions.map((session) => (
                    <Button
                      key={session.id}
                      type="button"
                      variant={session.id === selectedId ? "solid" : "soft"}
                      color={session.is_running ? "green" : "gray"}
                      onClick={() => {
                        setCreating(false);
                        setSelectedId(session.id);
                      }}
                      style={{ justifyContent: "space-between" }}
                    >
                      <Flex align="center" gap="2">
                        {session.acronym ? (
                          <Code size="2" variant="soft" color="gray">
                            {session.acronym}
                          </Code>
                        ) : null}
                        <span>{session.label}</span>
                      </Flex>
                      <Badge color={statusColor(session.status)} variant="soft">
                        {session.is_running ? "Live" : STATUS_LABEL[session.status]}
                      </Badge>
                    </Button>
                  ))}
                </Flex>
              )}
            </Card>
          </Grid>

          {selected ? (
            <Card>
              <Flex align="center" justify="between" wrap="wrap" gap="3" mb="3">
                <Box>
                  <Flex align="center" gap="2">
                    <Heading as="h2" size="4">
                      {selected.label}
                    </Heading>
                    {selected.acronym ? (
                      <Code size="3" variant="soft">
                        {selected.acronym}
                      </Code>
                    ) : null}
                  </Flex>
                  <Text color="gray" size="2">
                    {selected.is_default
                      ? "All themes, as usual. This is what players see outside any season dates."
                      : `Id ${selected.id} · Start ${formatWhen(selected.starts_at)} · End ${formatWhen(selected.ends_at)}`}
                  </Text>
                </Box>
                <Badge color={statusColor(selected.status)}>{STATUS_LABEL[selected.status]}</Badge>
              </Flex>

              {selected.is_default ? (
                <Text size="2">All themes. No dates. Players see this whenever no season is inside its start and end.</Text>
              ) : (
                <Flex direction="column" gap="4">
                  <Box>
                    <Heading as="h3" size="3" mb="2">
                      Themes in this season
                    </Heading>
                    {themes.length === 0 ? (
                      <Text color="gray" size="2">
                        No themes yet. Create them on the Themes page.
                      </Text>
                    ) : (
                      <Flex direction="column" gap="2">
                        {themes.map((theme) => (
                          <Text as="label" key={theme.id} size="2">
                            <Flex align="center" gap="2">
                              <Checkbox
                                checked={checked.includes(theme.id)}
                                disabled={busy}
                                onCheckedChange={(value) => toggleTheme(theme.id, value === true)}
                              />
                              {theme.label}
                            </Flex>
                          </Text>
                        ))}
                      </Flex>
                    )}
                    <Button
                      mt="3"
                      disabled={busy || !themesDirty}
                      onClick={() =>
                        run(async () => {
                          const updated = await setThemeSessionThemes(selected.id, checked);
                          setSessions((current) =>
                            current.map((session) => (session.id === updated.id ? updated : session)),
                          );
                        })
                      }
                    >
                      Save themes
                    </Button>
                  </Box>

                  <Box>
                    <Heading as="h3" size="3" mb="2">
                      Dates
                    </Heading>
                    <Text as="p" color="gray" size="2" mb="2">
                      Players see this season’s themes from the start until the end. Outside those
                      times, they see Default.
                    </Text>
                    <Flex align="end" gap="2" wrap="wrap">
                      <label>
                        <Text as="div" mb="1" size="1" weight="medium" color="gray">
                          Start
                        </Text>
                        <TextField.Root
                          type="datetime-local"
                          value={startAt}
                          onChange={(event) => setStartAt(event.target.value)}
                        />
                      </label>
                      <label>
                        <Text as="div" mb="1" size="1" weight="medium" color="gray">
                          End
                        </Text>
                        <TextField.Root
                          type="datetime-local"
                          value={endAt}
                          onChange={(event) => setEndAt(event.target.value)}
                        />
                      </label>
                      <Button
                        disabled={busy || !startAt.trim() || !endAt.trim() || checked.length === 0 || themesDirty}
                        onClick={() =>
                          run(async () => {
                            const next = await setThemeSessionWindow(
                              selected.id,
                              localInputToIso(startAt.trim()),
                              localInputToIso(endAt.trim()),
                            );
                            applySessions(next, selected.id);
                          })
                        }
                      >
                        Save dates
                      </Button>
                    </Flex>
                  </Box>

                  {selected.status !== "running" ? (
                    <Button
                      color="red"
                      variant="soft"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          if (!window.confirm(`Delete season “${selected.label}”?`)) return;
                          const next = await deleteThemeSession(selected.id);
                          applySessions(next, "default");
                        })
                      }
                    >
                      <Trash2 {...iconProps} />
                      Delete season
                    </Button>
                  ) : null}
                </Flex>
              )}
            </Card>
          ) : null}
        </Flex>
      </Container>
    </main>
  );
}
