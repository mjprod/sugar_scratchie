import { LoaderCircle, Sparkles, Upload } from "lucide-react";
import { Box, Button, Callout, Dialog, Flex, Select, Text, TextField } from "@radix-ui/themes";
import { useEffect, useRef, useState } from "react";
import { api, operatorFetch } from "./shared/api";

const iconProps = { size: 16, strokeWidth: 2 } as const;

type JobInfo = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  logs: string[];
};

type Props = {
  busy: boolean;
  modelId: string;
  name: string;
};

function errorText(text: string): string {
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail.trim()) return body.detail;
  } catch {
    // Response was not JSON.
  }
  return text.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatElapsed(startedAt: number | null, now: number): string {
  if (startedAt == null) return "<1s";
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 1) return "<1s";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${seconds}s`;
}

export function InfluencerN8nButton({ busy, modelId, name }: Props) {
  const [open, setOpen] = useState(false);
  const [influencerName, setInfluencerName] = useState(name);
  const [cardId, setCardId] = useState(modelId);
  const [file, setFile] = useState<File | null>(null);
  const [keyer, setKeyer] = useState("byebg");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setInfluencerName(name);
    setCardId(modelId);
  }, [open, name, modelId]);

  useEffect(() => {
    if (!sending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sending]);

  useEffect(() => {
    const box = logRef.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  }, [logs]);

  function handleOpenChange(next: boolean) {
    if (!next && sending) return;
    setOpen(next);
    if (!next) {
      setFile(null);
      setStatus("");
      setError("");
      setLogs([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function waitForJob(jobId: string): Promise<JobInfo> {
    for (;;) {
      const job = await api<JobInfo>(`/api/jobs/${encodeURIComponent(jobId)}`);
      setLogs(job.logs.slice(-12));
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        return job;
      }
      await sleep(800);
    }
  }

  async function handleSend() {
    if (!file || sending) return;
    const nextName = influencerName.trim();
    const nextId = cardId.trim();
    if (!nextName || !nextId) {
      setError("Name and id are required.");
      return;
    }
    setSending(true);
    setStartedAt(Date.now());
    setError("");
    setStatus("Sending the influencer name, id, and clip…");
    setLogs([]);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("name", nextName);
      form.append("card_id", nextId);
      form.append("keyer", keyer);
      const response = await operatorFetch(
        `/api/jobs/models/${encodeURIComponent(modelId)}/influencer-n8n`,
        { method: "POST", body: form },
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(errorText(text) || response.statusText);
      }
      const queued = (await response.json()) as JobInfo;
      const job = await waitForJob(queued.id);
      if (job.status !== "succeeded") {
        const detail =
          [...job.logs].reverse().find((line) => line.trim()) || "The influencer job failed.";
        throw new Error(detail.replace(/^Job runner error:\s*/, ""));
      }
      const folder = [...job.logs].reverse().find((line) => line.includes("influencer-n8n-result:"));
      setStatus(folder ? folder.replace(/^.*influencer-n8n-result:\s*/, "Folder ready: ") : "Influencer folder ready.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("");
    } finally {
      setSending(false);
      setStartedAt(null);
    }
  }

  return (
    <>
      <Button disabled={busy || sending} size="1" variant="soft" onClick={() => setOpen(true)}>
        <Sparkles {...iconProps} />
        Send influencer to n8n
      </Button>
      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Content style={{ maxWidth: 440, maxHeight: "calc(100vh - 32px)", overflow: "auto" }}>
          <Dialog.Title mb="1">Send influencer to n8n</Dialog.Title>
          {sending ? null : (
            <Dialog.Description size="2" color="gray" mb="3">
              Sends the name, the id, and the clip through every creator step: background
              removal, copy the template, write the name and id, then open After Effects.
              Quit After Effects before you send.
            </Dialog.Description>
          )}

          {sending ? (
            <Flex align="center" direction="column" gap="3" py="6">
              <LoaderCircle className="spin" size={32} strokeWidth={1.75} />
              <Text size="4" weight="bold">
                Waiting for n8n
              </Text>
              <Text align="center" color="gray" size="2" style={{ maxWidth: 360 }}>
                {status || "Sending the influencer name, id, and clip…"}{" "}
                {formatElapsed(startedAt, now)} so far. Live lines from n8n show below. Keep this
                open.
              </Text>
              <Box
                ref={logRef}
                mt="2"
                p="2"
                style={{
                  width: "100%",
                  background: "var(--gray-a3)",
                  borderRadius: 8,
                  maxHeight: 180,
                  overflow: "auto",
                }}
              >
                {(logs.length > 0 ? logs : ["Starting…"]).map((line, index) => (
                  <Text key={`${index}-${line}`} as="div" size="1" style={{ whiteSpace: "pre-wrap" }}>
                    {line}
                  </Text>
                ))}
              </Box>
            </Flex>
          ) : (
            <Flex direction="column" gap="3">
              <label>
                <Text as="div" mb="1" size="1" weight="medium">
                  Name
                </Text>
                <TextField.Root
                  value={influencerName}
                  onChange={(event) => setInfluencerName(event.currentTarget.value)}
                />
              </label>
              <label>
                <Text as="div" mb="1" size="1" weight="medium">
                  Id
                </Text>
                <TextField.Root
                  value={cardId}
                  onChange={(event) => setCardId(event.currentTarget.value)}
                />
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/mp4,video/quicktime,.mp4,.mov"
                hidden
                onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
              />
              <Flex align="center" gap="2">
                <Button size="1" variant="soft" onClick={() => fileInputRef.current?.click()}>
                  <Upload {...iconProps} />
                  {file ? "Replace clip" : "Upload clip"}
                </Button>
                {file ? (
                  <Text color="gray" size="1">
                    {file.name}
                  </Text>
                ) : null}
              </Flex>
              <label>
                <Text as="div" mb="1" size="1" weight="medium">
                  Background removal
                </Text>
                <Select.Root value={keyer} onValueChange={setKeyer}>
                  <Select.Trigger />
                  <Select.Content>
                    <Select.Item value="byebg">ByeBg</Select.Item>
                    <Select.Item value="greenkey">Greenkey</Select.Item>
                  </Select.Content>
                </Select.Root>
              </label>
            </Flex>
          )}

          {!sending && status ? (
            <Text as="div" mt="3" size="2">
              {status}
            </Text>
          ) : null}
          {error ? (
            <Callout.Root color="red" mt="3">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          ) : null}

          <Flex justify="end" gap="2" mt="4">
            <Dialog.Close>
              <Button disabled={sending} size="2" variant="soft">
                Close
              </Button>
            </Dialog.Close>
            {sending ? null : (
              <Button
                disabled={!file || !influencerName.trim() || !cardId.trim()}
                size="2"
                onClick={() => void handleSend()}
              >
                Send
              </Button>
            )}
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
