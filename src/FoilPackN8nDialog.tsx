import { LoaderCircle, Pause, Play, Sparkles, Upload } from "lucide-react";
import { Box, Button, Callout, Code, Dialog, Flex, Select, Text } from "@radix-ui/themes";
import { useEffect, useRef, useState } from "react";
import { api, operatorFetch } from "./shared/api";

const FOIL_SECONDS = 4;
const iconProps = { size: 16, strokeWidth: 2 } as const;

export type FoilPackKind = "pack-face" | "pack-face-2";

type JobInfo = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  logs: string[];
};

type Props = {
  busy: boolean;
  modelId: string;
  kind: FoilPackKind;
  label: string;
  /** Influencer name sent with the trimmed clip. */
  name: string;
  /** Model code sent with the trimmed clip. */
  code: string;
  /** Pack video already on this card. The dialog sends this file to n8n. */
  videoUrl?: string | null;
  onSaved: () => void;
  onBusyChange?: (busy: boolean) => void;
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

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
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

export function FoilPackN8nButton({
  busy,
  modelId,
  kind,
  label,
  name,
  code,
  videoUrl,
  onSaved,
  onBusyChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [duration, setDuration] = useState(0);
  const [durationKnown, setDurationKnown] = useState(false);
  const [start, setStart] = useState(0);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [localN8n, setLocalN8n] = useState(false);
  const [aspect, setAspect] = useState(9 / 16);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loadingCardVideo, setLoadingCardVideo] = useState(false);
  const [keyer, setKeyer] = useState("byebg");
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const startRef = useRef(0);
  const dragRef = useRef<{ pointerId: number; originX: number; originStart: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api<{ configured: boolean; local?: boolean }>("/api/jobs/foil-n8n/status")
      .then((body) => {
        if (!cancelled) {
          setConfigured(body.configured);
          setLocalN8n(Boolean(body.local));
        }
      })
      .catch(() => {
        if (!cancelled) setConfigured(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  startRef.current = start;
  const maxStart = duration >= FOIL_SECONDS ? Math.max(0, duration - FOIL_SECONDS) : 0;
  const windowReady = duration + 0.05 >= FOIL_SECONDS;

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function setFoilSending(next: boolean) {
    setSending(next);
    onBusyChange?.(next);
  }

  useEffect(() => {
    if (!sending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sending]);

  function resetClip() {
    setFile(null);
    setDuration(0);
    setDurationKnown(false);
    setStart(0);
    setAspect(9 / 16);
    setPlaying(false);
    setPlayhead(0);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return "";
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleOpenChange(next: boolean) {
    if (!next && sending) return;
    setOpen(next);
    if (!next) {
      resetClip();
      setStatus("");
      setError("");
      setLogs([]);
    }
  }

  useEffect(() => {
    if (!open) return;
    const source = videoUrl?.trim() || "";
    if (!source) return;
    let cancelled = false;
    setLoadingCardVideo(true);
    setError("");
    void operatorFetch(source)
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load the video on this card");
        const blob = await response.blob();
        if (cancelled) return;
        const name = source.split("?")[0]?.split("/").pop() || `${kind}.mp4`;
        const next = new File([blob], name, { type: blob.type || "video/mp4" });
        setDuration(0);
        setDurationKnown(false);
        setStart(0);
        setAspect(9 / 16);
        setPlaying(false);
        setPlayhead(0);
        setFile(next);
        setPreviewUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return URL.createObjectURL(next);
        });
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCardVideo(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, videoUrl, kind]);

  function handleFile(next: File | null) {
    setError("");
    setStatus("");
    setLogs([]);
    setDuration(0);
    setDurationKnown(false);
    setStart(0);
    setAspect(9 / 16);
    setPlaying(false);
    setPlayhead(0);
    setFile(next);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return next ? URL.createObjectURL(next) : "";
    });
  }

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video || !windowReady) return;
    const end = startRef.current + FOIL_SECONDS;
    if (video.currentTime >= end - 0.04) {
      video.currentTime = startRef.current;
      setPlayhead(startRef.current);
      return;
    }
    setPlayhead(video.currentTime);
  }

  function moveSection(next: number) {
    const clamped = Math.min(Math.max(0, next), maxStart);
    setStart(clamped);
    setPlayhead(clamped);
    const video = videoRef.current;
    if (video && Math.abs(video.currentTime - clamped) > 0.03) {
      video.currentTime = clamped;
    }
  }

  function timeAt(clientX: number): number {
    const track = trackRef.current;
    if (!track || duration <= 0) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.min(Math.max(0, ratio * duration), maxStart);
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video || !windowReady) return;
    if (video.paused) {
      const end = start + FOIL_SECONDS;
      if (video.currentTime < start || video.currentTime >= end - 0.04) {
        video.currentTime = start;
      }
      void video.play();
      return;
    }
    video.pause();
  }

  async function waitForJob(jobId: string): Promise<JobInfo> {
    for (;;) {
      const job = await api<JobInfo>(`/api/jobs/${encodeURIComponent(jobId)}`);
      setLogs(job.logs.slice(-8));
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        return job;
      }
      await sleep(800);
    }
  }

  async function handleSend() {
    if (!file || !windowReady || sending) return;
    setFoilSending(true);
    setStartedAt(Date.now());
    setError("");
    setStatus("Trimming to 4 seconds and sending to n8n…");
    setLogs([]);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", kind);
      form.append("start", start.toFixed(3));
      form.append("name", name.trim());
      form.append("code", code.trim());
      form.append("keyer", keyer);
      const response = await operatorFetch(
        `/api/jobs/models/${encodeURIComponent(modelId)}/foil-n8n`,
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
          [...job.logs].reverse().find((line) => line.trim()) || "The n8n job failed.";
        throw new Error(detail.replace(/^Job runner error:\s*/, ""));
      }
      const finished = [...job.logs]
        .reverse()
        .find((line) => line.includes("influencer-n8n-result:") || line.includes("foil-n8n-result:"));
      onSaved();
      setStatus(finished?.trim() || "The n8n foil flow finished.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("");
    } finally {
      setFoilSending(false);
      setStartedAt(null);
    }
  }

  return (
    <>
      <Button disabled={busy || sending} size="1" variant="soft" onClick={() => setOpen(true)}>
        <Sparkles {...iconProps} />
        Create with n8n
      </Button>
      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Content style={{ maxWidth: 440, maxHeight: "calc(100vh - 32px)", overflow: "auto" }}>
          <Dialog.Title mb="1">Create {label.toLowerCase()}</Dialog.Title>
          {sending ? null : (
            <Dialog.Description size="2" color="gray" mb="3">
              This uses the video on the card. Drag the highlighted section to choose 4 seconds.
              That clip is sent to n8n with the name and the code. The video n8n returns replaces
              this card.
            </Dialog.Description>
          )}

          {sending ? (
            <Flex align="center" direction="column" gap="3" py="6">
              <LoaderCircle className="spin" size={32} strokeWidth={1.75} />
              <Text size="4" weight="bold">
                Creating the foil pack
              </Text>
              <Text align="center" color="gray" size="2" style={{ maxWidth: 360 }}>
                {status || "Trimming to 4 seconds and sending to n8n…"}{" "}
                {formatElapsed(startedAt, now)} so far. The foil video comes back from n8n. Keep
                this open until it finishes.
              </Text>
              <Box
                mt="2"
                p="2"
                style={{
                  width: "100%",
                  background: "var(--gray-a3)",
                  borderRadius: 8,
                  maxHeight: 160,
                  overflow: "auto",
                }}
              >
                {(logs.length > 0 ? logs : ["Starting…"]).map((line, index) => (
                  <Text
                    key={`${index}-${line}`}
                    as="div"
                    size="1"
                    style={{ whiteSpace: "pre-wrap" }}
                  >
                    {line}
                  </Text>
                ))}
              </Box>
            </Flex>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v"
            hidden
            onChange={(event) => handleFile(event.currentTarget.files?.[0] ?? null)}
          />

          {!sending && loadingCardVideo ? (
            <Flex align="center" gap="2" mb="3">
              <LoaderCircle className="spin" size={16} strokeWidth={2} />
              <Text color="gray" size="2">
                Loading the video on this card…
              </Text>
            </Flex>
          ) : null}

          {!sending && previewUrl ? (
            <video
              ref={videoRef}
              src={previewUrl}
              muted
              playsInline
              onClick={togglePlay}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onLoadedMetadata={(event) => {
                const next = event.currentTarget.duration;
                const readable = Number.isFinite(next) && next > 0;
                const width = event.currentTarget.videoWidth;
                const height = event.currentTarget.videoHeight;
                setDuration(readable ? next : 0);
                setDurationKnown(true);
                setStart(0);
                setPlayhead(0);
                if (width > 0 && height > 0) setAspect(width / height);
                if (readable) event.currentTarget.currentTime = 0;
              }}
              onTimeUpdate={handleTimeUpdate}
              style={{
                display: "block",
                margin: "0 auto",
                width: aspect < 1 ? "auto" : "100%",
                height: aspect < 1 ? "min(46vh, 400px)" : "auto",
                maxWidth: "100%",
                maxHeight: aspect < 1 ? "min(46vh, 400px)" : 240,
                aspectRatio: String(aspect),
                background: "#111",
                borderRadius: 12,
                cursor: windowReady ? "pointer" : "default",
              }}
            />
          ) : !sending ? (
            <Box
              mb="3"
              style={{
                height: 160,
                borderRadius: 8,
                display: "grid",
                placeItems: "center",
                background: "var(--gray-a3)",
              }}
            >
              <Text color="gray" size="2">
                No video yet
              </Text>
            </Box>
          ) : null}

          {!sending && file && durationKnown && duration <= 0 ? (
            <Callout.Root color="red" mt="3">
              <Callout.Text>Could not read this video’s length.</Callout.Text>
            </Callout.Root>
          ) : null}

          {!sending && file && duration > 0 ? (
            <Box mt="3">
              {windowReady ? (
                <>
                  <Flex align="center" justify="between" gap="2" mb="2">
                    <Button
                      disabled={sending}
                      size="1"
                      variant="soft"
                      onClick={togglePlay}
                    >
                      {playing ? <Pause {...iconProps} /> : <Play {...iconProps} />}
                      {playing ? "Pause" : "Play section"}
                    </Button>
                    <Text color="gray" size="1">
                      {formatClock(start)} – {formatClock(Math.min(start + FOIL_SECONDS, duration))}
                    </Text>
                  </Flex>
                  <div
                    ref={trackRef}
                    role="slider"
                    aria-label="4 second section"
                    aria-valuemin={0}
                    aria-valuemax={Math.round(maxStart * 10) / 10}
                    aria-valuenow={Math.round(Math.min(start, maxStart) * 10) / 10}
                    aria-valuetext={`${formatClock(start)} to ${formatClock(start + FOIL_SECONDS)}`}
                    tabIndex={sending || maxStart <= 0 ? -1 : 0}
                    onKeyDown={(event) => {
                      if (sending || maxStart <= 0) return;
                      if (event.key === "ArrowLeft") {
                        event.preventDefault();
                        moveSection(start - 0.1);
                      } else if (event.key === "ArrowRight") {
                        event.preventDefault();
                        moveSection(start + 0.1);
                      }
                    }}
                    onPointerDown={(event) => {
                      if (sending || maxStart <= 0) return;
                      const rect = event.currentTarget.getBoundingClientRect();
                      const x = event.clientX - rect.left;
                      const left = (start / duration) * rect.width;
                      const width = (FOIL_SECONDS / duration) * rect.width;
                      const onSection = x >= left && x <= left + width;
                      const originStart = onSection ? start : timeAt(event.clientX);
                      dragRef.current = {
                        pointerId: event.pointerId,
                        originX: event.clientX,
                        originStart,
                      };
                      event.currentTarget.setPointerCapture(event.pointerId);
                      if (!onSection) moveSection(originStart);
                    }}
                    onPointerMove={(event) => {
                      const drag = dragRef.current;
                      const track = trackRef.current;
                      if (!drag || drag.pointerId !== event.pointerId || !track || duration <= 0) {
                        return;
                      }
                      const width = track.getBoundingClientRect().width;
                      if (width <= 0) return;
                      const delta = ((event.clientX - drag.originX) / width) * duration;
                      moveSection(drag.originStart + delta);
                    }}
                    onPointerUp={() => {
                      dragRef.current = null;
                    }}
                    onPointerCancel={() => {
                      dragRef.current = null;
                    }}
                    style={{
                      position: "relative",
                      height: 36,
                      borderRadius: 8,
                      background: "var(--gray-a4)",
                      touchAction: "none",
                      cursor: sending || maxStart <= 0 ? "default" : "pointer",
                      userSelect: "none",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: `${(start / duration) * 100}%`,
                        width: `${(FOIL_SECONDS / duration) * 100}%`,
                        background: "var(--blue-9)",
                        borderRadius: 8,
                        cursor: sending || maxStart <= 0 ? "default" : "grab",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          position: "absolute",
                          left: "50%",
                          top: "50%",
                          display: "flex",
                          gap: 3,
                          transform: "translate(-50%, -50%)",
                          pointerEvents: "none",
                        }}
                      >
                        <span style={{ width: 2, height: 14, borderRadius: 1, background: "#fff" }} />
                        <span style={{ width: 2, height: 14, borderRadius: 1, background: "#fff" }} />
                      </span>
                    </div>
                    <div
                      aria-hidden
                      style={{
                        position: "absolute",
                        top: 4,
                        bottom: 4,
                        left: `${(Math.min(playhead, duration) / duration) * 100}%`,
                        width: 2,
                        marginLeft: -1,
                        borderRadius: 1,
                        background: "#fff",
                        boxShadow: "0 0 0 1px rgba(0,0,0,0.45)",
                        pointerEvents: "none",
                      }}
                    />
                  </div>
                  {maxStart <= 0 ? (
                    <Text as="div" color="gray" mt="1" size="1">
                      The whole clip is 4 seconds, so the section starts at the beginning.
                    </Text>
                  ) : null}
                </>
              ) : (
                <Callout.Root color="red" mt="2">
                  <Callout.Text>
                    This video is {duration.toFixed(1)}s. It needs to be at least 4 seconds.
                  </Callout.Text>
                </Callout.Root>
              )}
            </Box>
          ) : null}

          {!sending ? (
          <Flex align="center" justify="between" gap="2" mt="3" wrap="wrap">
            <Button
              disabled={sending}
              size="1"
              variant="soft"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload {...iconProps} />
              {file ? "Replace video" : "Upload video"}
            </Button>
            {file ? (
              <Text
                color="gray"
                size="1"
                title={file.name}
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {file.name}
              </Text>
            ) : null}
          </Flex>
          ) : null}

          {!sending ? (
            <label>
              <Text as="div" mb="1" mt="3" size="1" weight="medium">
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
          ) : null}

          {!sending && configured === false ? (
            <Callout.Root color="amber" mt="3">
              <Callout.Text>
                N8N_FOIL_PACK_WEBHOOK_URL is empty. Remove it to use local n8n, or set a webhook
                URL and restart the API.
              </Callout.Text>
            </Callout.Root>
          ) : null}
          {!sending && localN8n ? (
            <Text as="div" color="gray" mt="3" size="1">
              Sends the 4-second clip to local n8n at http://127.0.0.1:5678. Start it with{" "}
              <Code>./scripts/manage.sh n8n-up</Code>.
            </Text>
          ) : null}

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
          {!sending && logs.length > 0 ? (
            <Box
              mt="3"
              p="2"
              style={{
                background: "var(--gray-a3)",
                borderRadius: 8,
                maxHeight: 120,
                overflow: "auto",
              }}
            >
              {logs.map((line, index) => (
                <Text
                  key={`${index}-${line}`}
                  as="div"
                  color="gray"
                  size="1"
                  style={{ whiteSpace: "pre-wrap" }}
                >
                  {line}
                </Text>
              ))}
            </Box>
          ) : null}

          <Flex justify="end" gap="2" mt="4">
            <Dialog.Close>
              <Button disabled={sending} size="2" variant="soft">
                Close
              </Button>
            </Dialog.Close>
            {sending ? null : (
              <Button
                disabled={!file || !windowReady || configured === false}
                size="2"
                onClick={() => void handleSend()}
              >
                Trim 4s and send
              </Button>
            )}
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}

