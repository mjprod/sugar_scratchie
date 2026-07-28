import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import {
  AlertTriangle,
  Braces,
  ExternalLink,
  Home,
  LoaderCircle,
  Pencil,
  Sparkles,
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
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchSymbolJson,
  fetchSymbols,
  rewriteSymbolJson,
  updateSymbolLabel,
  uploadSymbolLottie,
  type SymbolInfo,
} from "./shared/symbols";
import { applySymbolCatalog, loadSymbolTypes } from "./game/matchGame";

const iconProps = { size: 16, strokeWidth: 2 } as const;

export function SymbolsPage() {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editingLabel, setEditingLabel] = useState("");
  const [rewriteId, setRewriteId] = useState("");
  const [rewritePath, setRewritePath] = useState("");
  const [rewriteText, setRewriteText] = useState("");
  const [rewriteBusy, setRewriteBusy] = useState(false);
  const fileInputs = useRef<Map<string, HTMLInputElement>>(new Map());

  const refresh = useCallback(async () => {
    const next = await fetchSymbols();
    setSymbols(next);
    applySymbolCatalog(next);
  }, []);

  useEffect(() => {
    refresh().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    loadSymbolTypes().catch(() => undefined);
  }, [refresh]);

  function patchSymbol(updated: SymbolInfo) {
    setSymbols((prev) => {
      const next = prev.map((entry) => (entry.id === updated.id ? updated : entry));
      applySymbolCatalog(next);
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
      const updated = await updateSymbolLabel(symbolId, label);
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
      const updated = await uploadSymbolLottie(symbol.id, file);
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
      const payload = await fetchSymbolJson(symbol.id);
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
      const updated = await rewriteSymbolJson(rewriteId, rewriteText);
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
                Replace uploads a new .lottie. Rewrite edits the animation JSON. Preview updates
                immediately.
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

          <Grid columns={{ initial: "1", sm: "2", md: "3" }} gap="3">
            {symbols.map((symbol) => {
              const busy = busyId === symbol.id;
              const editing = editingId === symbol.id;
              return (
                <Card key={symbol.id} size="2">
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
                        key={`${symbol.id}-${symbol.updated_at}-${symbol.src}`}
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
