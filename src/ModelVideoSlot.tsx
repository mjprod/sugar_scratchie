import { Images, LoaderCircle, Play, Search, Upload } from "lucide-react";
import { Box, Button, Dialog, Flex, Text, TextField } from "@radix-ui/themes";
import { useEffect, useRef, useState } from "react";
import { FoilPackN8nButton } from "./FoilPackN8nDialog";
import { captureVideoSrcFirstFrame } from "./shared/media";

const iconProps = { size: 16, strokeWidth: 2 } as const;

const MODEL_MEDIA_THUMB = {
  width: 72,
  height: 128,
  borderRadius: 8,
  marginBottom: 8,
} as const;

const MODEL_MEDIA_CARD_STYLE = {
  border: "1px solid var(--gray-a6)",
  borderRadius: 12,
  padding: 12,
  background: "var(--gray-a2)",
  height: "100%",
  display: "flex",
  flexDirection: "column",
} as const;

function mediaPathBasename(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return "";
  return trimmed.split("/").pop()?.split("?")[0] ?? trimmed;
}

export function ModelVideoSlot({
  busy,
  label,
  pathHint,
  posterPathHint,
  photoLabel = "Poster",
  url,
  savedPosterUrl,
  uploadPosterUrl,
  onUpload,
  onPosterUpload,
  onGeneratePoster,
  packName,
  onPackNameChange,
  foilN8n,
}: {
  busy: boolean;
  label: string;
  pathHint: string;
  posterPathHint: string;
  photoLabel?: string;
  url?: string | null;
  savedPosterUrl?: string | null;
  uploadPosterUrl?: string;
  onUpload: () => void;
  onPosterUpload: () => void;
  onGeneratePoster?: () => void;
  packName?: string;
  onPackNameChange?: (value: string) => void;
  foilN8n?: {
    modelId: string;
    kind: "pack-face" | "pack-face-2";
    name: string;
    code: string;
    onSaved: () => void;
  };
}) {
  const src = url?.trim() || "";
  const savedPoster = savedPosterUrl?.trim() || "";
  const uploadPoster = uploadPosterUrl?.trim() || "";
  const showPackVideo = Boolean(foilN8n);
  const [srcPoster, setSrcPoster] = useState("");
  const [foilBusy, setFoilBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dialogPlaying, setDialogPlaying] = useState(false);
  const dialogVideoRef = useRef<HTMLVideoElement>(null);

  function handlePreviewOpenChange(open: boolean) {
    setPreviewOpen(open);
    if (!open) setDialogPlaying(false);
    else if (showPackVideo && src) setDialogPlaying(true);
  }

  useEffect(() => {
    setSrcPoster("");
    if (!src || (!showPackVideo && (savedPoster || uploadPoster))) return;

    let cancelled = false;
    void captureVideoSrcFirstFrame(src)
      .then((frame) => {
        if (!cancelled) setSrcPoster(frame);
      })
      .catch(() => {
        // Keep the idle placeholder when capture fails.
      });

    return () => {
      cancelled = true;
    };
  }, [src, savedPoster, uploadPoster, showPackVideo]);

  useEffect(() => {
    if (!previewOpen || !dialogPlaying || !src) return;
    const video = dialogVideoRef.current;
    if (!video) return;
    try {
      video.currentTime = 0;
    } catch {
      // ignore
    }
    void video.play().catch(() => undefined);
  }, [previewOpen, dialogPlaying, src]);

  const previewFrame = showPackVideo && src ? srcPoster : savedPoster || uploadPoster || srcPoster;
  const thumbShellStyle = {
    position: "relative" as const,
    ...MODEL_MEDIA_THUMB,
    overflow: "hidden" as const,
    background: "var(--gray-a3)",
  };

  return (
    <Box style={MODEL_MEDIA_CARD_STYLE}>
      <Text as="div" mb="2" size="1" weight="medium">
        {label}
      </Text>
      {previewFrame ? (
        <button
          type="button"
          aria-label={`Enlarge ${label} preview`}
          title="Click preview to enlarge · play video inside preview"
          onClick={() => handlePreviewOpenChange(true)}
          style={{
            ...thumbShellStyle,
            display: "block",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        >
          <img
            alt={`${label} poster`}
            src={previewFrame}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
          {foilBusy ? (
            <Flex
              align="center"
              justify="center"
              style={{
                position: "absolute",
                inset: 0,
                background: "oklch(0 0 0 / 0.45)",
              }}
            >
              <LoaderCircle {...iconProps} className="spin" style={{ color: "white" }} />
            </Flex>
          ) : null}
          <Box
            aria-hidden="true"
            style={{
              position: "absolute",
              right: 6,
              bottom: 6,
              width: 22,
              height: 22,
              borderRadius: 999,
              background: "oklch(1 0 0 / 0.92)",
              display: "grid",
              placeItems: "center",
              boxShadow: "0 2px 8px oklch(0 0 0 / 0.22)",
            }}
          >
            <Search {...iconProps} style={{ width: 12, height: 12 }} />
          </Box>
        </button>
      ) : src ? (
        <Box style={thumbShellStyle}>
          <Flex align="center" justify="center" height="100%">
            <LoaderCircle
              {...iconProps}
              style={{ animation: "spin 1s linear infinite", opacity: 0.45 }}
            />
          </Flex>
        </Box>
      ) : (
        <Box
          style={{
            ...thumbShellStyle,
            display: "grid",
            placeItems: "center",
          }}
        >
          <Text color="gray" size="1">
            —
          </Text>
        </Box>
      )}
      <Text as="div" color="gray" mb="2" size="1" style={{ wordBreak: "break-all" }}>
        {src || `Saves to public/${pathHint}`}
      </Text>
      <Box mb="2" style={{ minHeight: 52 }}>
        <Text as="div" mb="1" size="1" weight="medium">
          {photoLabel}
        </Text>
        <Text as="div" color="gray" size="1" style={{ wordBreak: "break-all", lineHeight: 1.35 }}>
          {savedPoster
            ? mediaPathBasename(savedPoster)
            : `Saves to public/${posterPathHint}`}
        </Text>
      </Box>
      {onPackNameChange ? (
        <label style={{ display: "block", marginBottom: 8 }}>
          <Text as="div" mb="1" size="1" weight="medium">
            Card pack name
          </Text>
          <TextField.Root
            disabled={busy}
            value={packName ?? ""}
            onChange={(event) => onPackNameChange(event.currentTarget.value)}
          />
        </label>
      ) : null}
      <Flex direction="column" gap="2" style={{ marginTop: "auto" }}>
        <Button disabled={busy} size="1" variant="soft" onClick={onPosterUpload}>
          <Images {...iconProps} />
          {savedPoster ? "Replace photo" : "Upload photo"}
        </Button>
        {onGeneratePoster && src && !savedPoster ? (
          <Button disabled={busy} size="1" variant="soft" onClick={onGeneratePoster}>
            Generate poster
          </Button>
        ) : null}
        <Button disabled={busy} size="1" variant="soft" onClick={onUpload}>
          <Upload {...iconProps} />
          {src ? "Replace video" : "Upload video"}
        </Button>
        {foilN8n ? (
          <FoilPackN8nButton
            busy={busy}
            kind={foilN8n.kind}
            label={label}
            modelId={foilN8n.modelId}
            name={foilN8n.name}
            code={foilN8n.code}
            videoUrl={src}
            onSaved={foilN8n.onSaved}
            onBusyChange={setFoilBusy}
          />
        ) : null}
      </Flex>

      {previewFrame ? (
        <Dialog.Root open={previewOpen} onOpenChange={handlePreviewOpenChange}>
          <Dialog.Content style={{ maxWidth: 420, padding: 0, overflow: "hidden" }}>
            <Box p="4" pb="3">
              <Dialog.Title mb="1">{label}</Dialog.Title>
              <Dialog.Description size="1" color="gray">
                {dialogPlaying && src ? src : savedPoster || `${photoLabel} preview`}
              </Dialog.Description>
            </Box>
            {dialogPlaying && src ? (
              <video
                ref={dialogVideoRef}
                key={src}
                controls
                autoPlay
                loop
                muted
                playsInline
                preload="auto"
                src={src}
                style={{
                  width: "100%",
                  display: "block",
                  aspectRatio: "9 / 16",
                  objectFit: "cover",
                  background: "#111",
                }}
              />
            ) : (
              <img
                alt={`${label} enlarged photo`}
                src={previewFrame}
                style={{
                  width: "100%",
                  display: "block",
                  aspectRatio: "9 / 16",
                  objectFit: "cover",
                  background: "#111",
                }}
              />
            )}
            <Flex justify="between" align="center" gap="2" p="3" pt="2" wrap="wrap">
              <Flex gap="2" wrap="wrap">
                {dialogPlaying ? (
                  <Button
                    size="2"
                    variant="soft"
                    onClick={() => {
                      const video = dialogVideoRef.current;
                      try {
                        video?.pause();
                        if (video) video.currentTime = 0;
                      } catch {
                        // ignore
                      }
                      setDialogPlaying(false);
                    }}
                  >
                    Show photo
                  </Button>
                ) : (
                  <Button
                    size="2"
                    variant="solid"
                    disabled={!src}
                    onClick={() => setDialogPlaying(true)}
                  >
                    <Play {...iconProps} />
                    Play video
                  </Button>
                )}
              </Flex>
              <Dialog.Close>
                <Button size="2" variant="soft">
                  Close
                </Button>
              </Dialog.Close>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
      ) : null}
    </Box>
  );
}
