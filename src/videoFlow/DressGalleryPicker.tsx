import { useEffect, useState } from "react";
import { Flex, Text } from "@radix-ui/themes";
import { api } from "../shared/api";

type GalleryImage = {
  id: string;
  path: string;
  url: string;
  prompt: string;
};

/** Stills saved from Dress for the card's girl. */
export function DressGalleryPicker({
  modelId,
  hint,
  onPick,
}: {
  modelId: string;
  hint: string;
  onPick: (path: string) => void;
}) {
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [error, setError] = useState("");
  const [active, setActive] = useState("");

  useEffect(() => {
    setActive("");
    if (!modelId) {
      setImages([]);
      setError("");
      return;
    }
    let cancelled = false;
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

  if (!modelId) {
    return (
      <Text color="gray" size="2">
        This card is not linked to a girl, so her Dress gallery is hidden. Open the card from{" "}
        <a href="/dashboard/models">Models</a>.
      </Text>
    );
  }

  const dressHref = `/dashboard/video-flow/dress?model=${encodeURIComponent(modelId)}`;

  return (
    <Flex direction="column" gap="2">
      <Text color="gray" size="2">
        {hint}{" "}
        <a href={dressHref}>Open Dress</a>
      </Text>
      {error ? (
        <Text color="red" size="1">
          {error}
        </Text>
      ) : null}
      {!error && images.length === 0 ? (
        <Text color="gray" size="1">
          No stills yet. Generate some in Dress and they show up here.
        </Text>
      ) : null}
      {images.length > 0 ? (
        <div className="dress-gallery-strip">
          {images.map((image) => (
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
