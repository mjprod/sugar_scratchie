import { useEffect, useRef, useState } from "react";
import { Flex, Text } from "@radix-ui/themes";
import { COSPLAY_THEMES, matchCosplayTheme } from "../sugarDress/lib/dressEdit";
import { api } from "../shared/api";
import { DEFAULT_THEME } from "./schema";

type GalleryKind = "bikini" | "cosplay" | "";

type GalleryImage = {
  id: string;
  path: string;
  url: string;
  prompt: string;
  kind?: GalleryKind;
  theme?: string;
};

/** Stills saved from Dress for the card's girl. */
export function DressGalleryPicker({
  modelId,
  hint,
  kind,
  theme,
  autoPick,
  selectedPath,
  onPick,
}: {
  modelId: string;
  hint: string;
  /** Limit the strip to bikini stills or cosplay stills. */
  kind?: "bikini" | "cosplay";
  /** Card theme label. Cosplay strips show that costume when Dress has it. */
  theme?: string;
  /** When the field is empty and the strip has one still, use that still. */
  autoPick?: boolean;
  /** Current field value. Replaced only when that gallery file is gone. */
  selectedPath?: string;
  onPick: (path: string) => void;
}) {
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [error, setError] = useState("");
  const [active, setActive] = useState("");
  const autoPicked = useRef("");

  useEffect(() => {
    setActive("");
    if (!modelId) {
      setImages([]);
      setError("");
      return;
    }
    let cancelled = false;
    autoPicked.current = "";
    setImages([]);
    setError("");
    api<{ images: GalleryImage[] }>(`/api/models/${encodeURIComponent(modelId)}/gallery`)
      .then((data) => {
        if (!cancelled) setImages(data.images ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setImages([]);
          setError(err instanceof Error ? err.message : "Could not load the Dress gallery");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [modelId]);

  const chosenTheme =
    theme?.trim() && theme.trim().toLowerCase() !== DEFAULT_THEME.toLowerCase() ? theme.trim() : "";
  const costumeId = kind === "cosplay" && chosenTheme ? matchCosplayTheme(chosenTheme) : "";
  const costumeLabel = COSPLAY_THEMES.find((entry) => entry.id === costumeId)?.label ?? "";
  const shown = images.filter((image) => {
    if (!kind) return true;
    if (image.kind !== kind) return false;
    if (costumeId) return image.theme === costumeId;
    return true;
  });
  const onlyId = shown.length === 1 ? shown[0]?.id ?? "" : "";
  const onlyPath = shown.length === 1 ? shown[0]?.path ?? "" : "";
  const current = selectedPath?.trim() ?? "";
  const currentIsGallery = Boolean(modelId) && current.includes(`/models/${modelId}/gallery/`);
  const currentStillSaved = images.some((image) => current.includes(`${image.id}.png`));
  const replacement =
    currentIsGallery && images.length > 0 && !currentStillSaved && shown[0] ? shown[0] : undefined;
  useEffect(() => {
    if (!autoPick || !onlyId || !onlyPath) return;
    if (autoPicked.current === onlyId) return;
    autoPicked.current = onlyId;
    onPick(onlyPath);
  }, [autoPick, onlyId, onlyPath, onPick]);
  useEffect(() => {
    if (!replacement) return;
    if (autoPicked.current === replacement.id) return;
    autoPicked.current = replacement.id;
    onPick(replacement.path);
  }, [replacement, onPick]);

  if (!modelId) {
    return (
      <Text color="gray" size="2">
        Choose a girl to see her Dress gallery. Girls are created on{" "}
        <a href="/dashboard/models">Models</a>.
      </Text>
    );
  }

  const dressHref = `/dashboard/video-flow/dress?model=${encodeURIComponent(modelId)}`;
  const empty =
    kind === "bikini"
      ? "No bikini stills yet. Use Auto Bikini in Dress and they show up here."
      : kind === "cosplay" && costumeLabel
        ? `No ${costumeLabel} stills yet. Generate that costume in Dress.`
        : kind === "cosplay"
          ? "No cosplay stills yet. Generate a costume in Dress."
          : "No stills yet. Generate some in Dress and they show up here.";

  return (
    <Flex direction="column" gap="2">
      <Text color="gray" size="2">
        {hint}{" "}
        {costumeLabel ? <>Showing {costumeLabel}. </> : null}
        {kind === "cosplay" && chosenTheme && !costumeId ? (
          <>This theme has no Dress costume, so every cosplay still is listed. </>
        ) : null}
        <a href={dressHref}>Open Dress</a>
      </Text>
      {error ? (
        <Text color="red" size="1">
          {error}
        </Text>
      ) : null}
      {!error && shown.length === 0 ? (
        <Text color="gray" size="1">
          {empty}
        </Text>
      ) : null}
      {shown.length > 0 ? (
        <div className="dress-gallery-strip">
          {shown.map((image) => (
            <button
              key={image.id}
              type="button"
              className={active === image.id ? "is-active" : ""}
              title={image.prompt || "Use this still"}
              onClick={() => {
                setActive(image.id);
                onPick(image.path);
              }}
            >
              <img src={image.url} alt="" />
            </button>
          ))}
        </div>
      ) : null}
    </Flex>
  );
}
