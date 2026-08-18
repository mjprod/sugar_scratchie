import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import {
  AlertTriangle,
  Braces,
  ExternalLink,
  Home,
  LoaderCircle,
  Pencil,
  Plus,
  Sparkles,
  Star,
  Trash2,
  Upload,
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
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSymbolGroup,
  deleteSymbolGroup,
  fetchSymbolGroups,
  fetchSymbolJson,
  fetchSymbols,
  rewriteSymbolJson,
  setDefaultSymbolGroup,
  updateSymbolGroupLabel,
  updateSymbolLabel,
  uploadSymbolLottie,
  type SymbolGroupInfo,
  type SymbolInfo,
} from "./shared/symbols";
import { applySymbolCatalog, loadSymbolTypes } from "./game/matchGame";

const iconProps = { size: 16, strokeWidth: 2 } as const;

export function SymbolsPage() {
  const [groups, setGroups] = useState<SymbolGroupInfo[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [groupBusy, setGroupBusy] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [editingLabel, setEditingLabel] = useState("");
  const [rewriteId, setRewriteId] = useState("");
  const [rewritePath, setRewritePath] = useState("");
  const [rewriteText, setRewriteText] = useState("");
  const [rewriteBusy, setRewriteBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createId, setCreateId] = useState("");
  const [createLabel, setCreateLabel] = useState("");
  const [renameGroupOpen, setRenameGroupOpen] = useState(false);
  const [renameGroupLabel, setRenameGroupLabel] = useState("");
  const fileInputs = useRef<Map<string, HTMLInputElement>>(new Map());
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const loadSeq = useRef(0);

  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;
  const selectValue = groups.some((group) => group.id === selectedGroupId)
    ? selectedGroupId
    : groups.find((group) => group.is_default)?.id || groups[0]?.id || "";

  const loadSymbolsForGroup = useCallback(async (groupId: string) => {
    if (!groupId) {
      return;
    }
    const seq = ++loadSeq.current;
    const next = await fetchSymbols(groupId);
    if (seq !== loadSeq.current) return;
    setSymbols(next);
    const defaultId = groupsRef.current.find((group) => group.is_default)?.id;
    if (!defaultId || defaultId === groupId) {
      applySymbolCatalog(next);
    }
  }, []);

  const refresh = useCallback(async (preferId?: string) => {
    const nextGroups = await fetchSymbolGroups();
    setGroups(nextGroups);
    const active =
      (preferId && nextGroups.some((group) => group.id === preferId) ? preferId : "") ||
      (selectedGroupId && nextGroups.some((group) => group.id === selectedGroupId)
        ? selectedGroupId
        : "") ||
      nextGroups.find((group) => group.is_default)?.id ||
      nextGroups[0]?.id ||
      "";
    setSelectedGroupId(active);
    if (active) {
      await loadSymbolsForGroup(active);
    }
  }, [loadSymbolsForGroup, selectedGroupId]);

  useEffect(() => {
    let cancelled = false;
    refresh()
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    loadSymbolTypes().catch(() => undefined);
    return () => {
      cancelled = true;
      loadSeq.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!selectValue) return;
    if (selectValue !== selectedGroupId) {
      setSelectedGroupId(selectValue);
      return;
    }
    loadSymbolsForGroup(selectValue).catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [selectValue, selectedGroupId, loadSymbolsForGroup]);

  function patchSymbol(updated: SymbolInfo) {
    setSymbols((prev) => {
      const next = prev.map((entry) => (entry.id === updated.id ? updated : entry));
      if (selectedGroup?.is_default) {
        applySymbolCatalog(next);
      }
      return next;
    });
  }

  async function handleRename(symbolId: string) {
    const label = editingLabel.trim();
    if (!label) {
      setError("Label is required.");
      return;
    }
    setBusyId(symbolId);
    setError("");
    try {
      const updated = await updateSymbolLabel(symbolId, label, selectedGroupId);
      patchSymbol(updated);
      setEditingId("");
      setEditingLabel("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId("");
    }
  }

  async function handleReplace(symbol: SymbolInfo, file: File | null) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".lottie")) {
      setError("Replace needs a .lottie file.");
      return;
    }
    setBusyId(symbol.id);
    setError("");
    try {
      const updated = await uploadSymbolLottie(symbol.id, file, selectedGroupId);
      patchSymbol(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId("");
      const input = fileInputs.current.get(symbol.id);
      if (input) input.value = "";
    }
  }

  async function openRewrite(symbol: SymbolInfo) {
    setBusyId(symbol.id);
    setError("");
    try {
      const payload = await fetchSymbolJson(symbol.id, selectedGroupId);
      setRewriteId(symbol.id);
      setRewritePath(payload.path);
      setRewriteText(payload.json_text);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId("");
    }
  }

  async function saveRewrite() {
    if (!rewriteId) return;
    setRewriteBusy(true);
    setError("");
    try {
      const updated = await rewriteSymbolJson(rewriteId, rewriteText, selectedGroupId);
      patchSymbol(updated);
      setRewriteId("");
      setRewritePath("");
      setRewriteText("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRewriteBusy(false);
    }
  }

  async function handleCreateGroup() {
    const id = createId.trim();
    const label = createLabel.trim();
    if (!id || !label) {
      setError("Group id and label are required.");
      return;
    }
    setGroupBusy(true);
    setError("");
    try {
      const created = await createSymbolGroup(id, label, selectedGroupId || undefined);
      setCreateOpen(false);
      setCreateId("");
      setCreateLabel("");
      await refresh(created.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setGroupBusy(false);
    }
  }

  async function handleSetDefault() {
    if (!selectedGroupId) return;
    setGroupBusy(true);
    setError("");
    try {
      await setDefaultSymbolGroup(selectedGroupId);
      await refresh(selectedGroupId);
      await loadSymbolTypes();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setGroupBusy(false);
    }
  }

  async function handleRenameGroup() {
    if (!selectedGroupId) return;
    const label = renameGroupLabel.trim();
    if (!label) {
      setError("Group label is required.");
      return;
    }
    setGroupBusy(true);
    setError("");
    try {
      await updateSymbolGroupLabel(selectedGroupId, label);
      setRenameGroupOpen(false);
      await refresh(selectedGroupId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setGroupBusy(false);
    }
  }

  async function handleDeleteGroup() {
    if (!selectedGroup || selectedGroup.is_default) {
      setError("Cannot delete the default symbol group.");
      return;
    }
    if (!window.confirm(`Delete symbol group “${selectedGroup.label}”? This cannot be undone.`)) {
      return;
    }
    setGroupBusy(true);
    setError("");
    try {
      const fallbackId =
        groups.find((group) => group.is_default)?.id ||
        groups.find((group) => group.id !== selectedGroup.id)?.id ||
        "";
      await deleteSymbolGroup(selectedGroup.id);
      await refresh(fallbackId || undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setGroupBusy(false);
    }
  }

  const rewriteSymbol = symbols.find((entry) => entry.id === rewriteId) ?? null;

  return (
    <main className="dashboard-root">
      <Container size="3">
        <Flex direction="column" gap="4" py="6">
          <Flex align="center" justify="between" wrap="wrap" gap="3">
            <Box>
              <Text className="eyebrow" size="2">
                Sugar Scratchie
              </Text>
              <Heading size="7">Symbols</Heading>
              <Text color="gray" size="2">
                Groups are packs of 12 symbols. Set one as default for the game. Replace uploads a
                new .lottie; Rewrite edits the animation JSON.
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

          <Card size="2">
            <Flex direction="column" gap="3">
              <Flex align="center" justify="between" wrap="wrap" gap="2">
                <Text weight="medium">Symbol group</Text>
                {selectedGroup?.is_default ? (
                  <Badge color="amber" variant="soft">
                    Default for game
                  </Badge>
                ) : null}
              </Flex>
              <Flex gap="2" wrap="wrap" align="end">
                <Box style={{ minWidth: 200, flex: 1 }}>
                  <Text size="1" color="gray" mb="1">
                    Active group
                  </Text>
                  <Select.Root
                    value={selectValue || undefined}
                    onValueChange={(value) => {
                      if (groups.some((group) => group.id === value)) {
                        setSelectedGroupId(value);
                      }
                    }}
                    disabled={groups.length === 0}
                  >
                    <Select.Trigger placeholder="Select group" style={{ width: "100%" }} />
                    <Select.Content>
                      {groups.map((group) => (
                        <Select.Item key={group.id} value={group.id}>
                          {group.label}
                          {group.is_default ? " (default)" : ""}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </Box>
                <Button
                  variant="soft"
                  disabled={groupBusy || !selectedGroupId}
                  onClick={() => {
                    setRenameGroupLabel(selectedGroup?.label ?? "");
                    setRenameGroupOpen(true);
                  }}
                >
                  <Pencil {...iconProps} />
                  Rename
                </Button>
                <Button
                  variant="soft"
                  color="amber"
                  disabled={groupBusy || !selectedGroupId || Boolean(selectedGroup?.is_default)}
                  onClick={() => handleSetDefault().catch(() => undefined)}
                >
                  <Star {...iconProps} />
                  Set default
                </Button>
                <Button
                  variant="soft"
                  disabled={groupBusy}
                  onClick={() => {
                    setCreateId("");
                    setCreateLabel("");
                    setCreateOpen(true);
                  }}
                >
                  <Plus {...iconProps} />
                  New group
                </Button>
                <Button
                  variant="soft"
                  color="red"
                  disabled={groupBusy || !selectedGroup || selectedGroup.is_default}
                  onClick={() => handleDeleteGroup().catch(() => undefined)}
                >
                  <Trash2 {...iconProps} />
                  Delete
                </Button>
              </Flex>
            </Flex>
          </Card>

          <Grid columns={{ initial: "1", sm: "2", md: "3" }} gap="3">
            {symbols.map((symbol) => {
              const busy = busyId === symbol.id;
              const editing = editingId === symbol.id;
              return (
                <Card key={`${symbol.group_id}-${symbol.id}`} size="2">
                  <Flex direction="column" gap="3">
                    <Flex align="center" justify="between" gap="2">
                      <Badge color="gray" variant="soft">
                        {symbol.id}
                      </Badge>
                      <Text size="1" color="gray" style={{ fontFamily: "monospace" }}>
                        {symbol.file}
                      </Text>
                    </Flex>

                    <Flex
                      align="center"
                      justify="center"
                      style={{
                        minHeight: 120,
                        background: "var(--gray-2)",
                        borderRadius: "var(--radius-3)",
                      }}
                    >
                      <DotLottieReact
                        key={`${symbol.group_id}-${symbol.id}-${symbol.updated_at}-${symbol.src}`}
                        src={symbol.src}
                        autoplay
                        loop
                        aria-label={symbol.label}
                        width={96}
                        height={96}
                        style={{ width: 96, height: 96 }}
                      />
                    </Flex>

                    {editing ? (
                      <Flex gap="2" align="end">
                        <Box style={{ flex: 1 }}>
                          <TextField.Root
                            value={editingLabel}
                            onChange={(event) => setEditingLabel(event.target.value)}
                            placeholder="Label"
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                handleRename(symbol.id).catch(() => undefined);
                              }
                            }}
                          />
                        </Box>
                        <Button
                          size="1"
                          disabled={busy}
                          onClick={() => handleRename(symbol.id).catch(() => undefined)}
                        >
                          Save
                        </Button>
                        <Button
                          size="1"
                          variant="soft"
                          color="gray"
                          disabled={busy}
                          onClick={() => {
                            setEditingId("");
                            setEditingLabel("");
                          }}
                        >
                          Cancel
                        </Button>
                      </Flex>
                    ) : (
                      <Flex align="center" justify="between" gap="2">
                        <Text weight="medium">{symbol.label}</Text>
                        <Button
                          size="1"
                          variant="soft"
                          color="gray"
                          disabled={busy}
                          onClick={() => {
                            setEditingId(symbol.id);
                            setEditingLabel(symbol.label);
                          }}
                        >
                          <Pencil {...iconProps} />
                          Rename
                        </Button>
                      </Flex>
                    )}

                    <input
                      ref={(node) => {
                        if (node) fileInputs.current.set(symbol.id, node);
                        else fileInputs.current.delete(symbol.id);
                      }}
                      type="file"
                      accept=".lottie,application/zip,application/octet-stream"
                      hidden
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null;
                        handleReplace(symbol, file).catch(() => undefined);
                      }}
                    />
                    <Flex gap="2">
                      <Button
                        style={{ flex: 1 }}
                        variant="soft"
                        disabled={busy}
                        onClick={() => fileInputs.current.get(symbol.id)?.click()}
                      >
                        {busy ? <LoaderCircle {...iconProps} /> : <Upload {...iconProps} />}
                        Replace
                      </Button>
                      <Button
                        style={{ flex: 1 }}
                        variant="soft"
                        color="gray"
                        disabled={busy}
                        onClick={() => openRewrite(symbol).catch(() => undefined)}
                      >
                        <Braces {...iconProps} />
                        Rewrite
                      </Button>
                    </Flex>
                  </Flex>
                </Card>
              );
            })}
          </Grid>

          {symbols.length === 0 ? (
            <Callout.Root color="gray">
              <Callout.Icon>
                <Sparkles {...iconProps} />
              </Callout.Icon>
              <Callout.Text>No symbols loaded yet.</Callout.Text>
            </Callout.Root>
          ) : null}
        </Flex>
      </Container>

      <Dialog.Root
        open={createOpen}
        onOpenChange={(open) => {
          if (!groupBusy) setCreateOpen(open);
        }}
      >
        <Dialog.Content maxWidth="420px">
          <Dialog.Title>New symbol group</Dialog.Title>
          <Dialog.Description size="2" color="gray" mb="3">
            Copies the 12 symbols from the currently selected group
            {selectedGroup ? ` (“${selectedGroup.label}”)` : ""}. You can edit them after.
          </Dialog.Description>
          <Flex direction="column" gap="3">
            <Box>
              <Text size="1" color="gray" mb="1">
                Id (slug)
              </Text>
              <TextField.Root
                value={createId}
                onChange={(event) => setCreateId(event.target.value)}
                placeholder="premium"
              />
            </Box>
            <Box>
              <Text size="1" color="gray" mb="1">
                Label
              </Text>
              <TextField.Root
                value={createLabel}
                onChange={(event) => setCreateLabel(event.target.value)}
                placeholder="Premium"
              />
            </Box>
          </Flex>
          <Flex gap="2" mt="4" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray" disabled={groupBusy}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              disabled={groupBusy || !createId.trim() || !createLabel.trim()}
              onClick={() => handleCreateGroup().catch(() => undefined)}
            >
              {groupBusy ? <LoaderCircle {...iconProps} /> : <Plus {...iconProps} />}
              Create
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root
        open={renameGroupOpen}
        onOpenChange={(open) => {
          if (!groupBusy) setRenameGroupOpen(open);
        }}
      >
        <Dialog.Content maxWidth="420px">
          <Dialog.Title>Rename group</Dialog.Title>
          <Box mt="3">
            <TextField.Root
              value={renameGroupLabel}
              onChange={(event) => setRenameGroupLabel(event.target.value)}
              placeholder="Label"
            />
          </Box>
          <Flex gap="2" mt="4" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray" disabled={groupBusy}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              disabled={groupBusy || !renameGroupLabel.trim()}
              onClick={() => handleRenameGroup().catch(() => undefined)}
            >
              Save
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root
        open={Boolean(rewriteId)}
        onOpenChange={(open) => {
          if (!open && !rewriteBusy) {
            setRewriteId("");
            setRewritePath("");
            setRewriteText("");
          }
        }}
      >
        <Dialog.Content maxWidth="720px">
          <Dialog.Title>
            Rewrite {rewriteSymbol ? `“${rewriteSymbol.label}”` : "symbol"} JSON
          </Dialog.Title>
          <Dialog.Description size="2" color="gray" mb="3">
            Edit the animation JSON
            {rewritePath ? (
              <>
                {" "}
                (<Text style={{ fontFamily: "monospace" }}>{rewritePath}</Text>)
              </>
            ) : null}
            . Save writes it back into the .lottie and refreshes the preview.
          </Dialog.Description>
          <TextArea
            value={rewriteText}
            onChange={(event) => setRewriteText(event.target.value)}
            rows={18}
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}
          />
          <Flex gap="2" mt="4" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray" disabled={rewriteBusy}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button disabled={rewriteBusy || !rewriteText.trim()} onClick={() => saveRewrite()}>
              {rewriteBusy ? <LoaderCircle {...iconProps} /> : <Braces {...iconProps} />}
              {rewriteBusy ? "Saving…" : "Save JSON"}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </main>
  );
}
