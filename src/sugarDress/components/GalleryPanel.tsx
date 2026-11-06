import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { COSPLAY_THEMES } from "../lib/dressEdit";
import {
  GALLERY_CHANGED_EVENT,
  deleteGalleryImage,
  fetchGallery,
  notifyGalleryChanged,
  type GalleryImage,
} from "../lib/modelGallery";

const GALLERY_THUMB_RETRIES = 5;

function GalleryThumb({
  image,
  onPlace,
}: {
  image: GalleryImage;
  onPlace: (image: GalleryImage) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const wait = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (wait.current != null) window.clearTimeout(wait.current);
    },
    [],
  );

  const src = attempt === 0 ? image.url : `${image.url}?v=${attempt}`;
  return (
    <button
      type="button"
      className="gallery-thumb"
      title={image.prompt || "Place on the canvas"}
      aria-label={image.prompt || "Gallery still"}
      onClick={() => onPlace(image)}
    >
      <img
        src={src}
        alt=""
        onError={() => {
          if (attempt >= GALLERY_THUMB_RETRIES || wait.current != null) return;
          wait.current = window.setTimeout(() => {
            wait.current = null;
            setAttempt((current) => current + 1);
          }, 200);
        }}
      />
    </button>
  );
}

function GalleryGrid({
  images,
  empty,
  onPlace,
  onRemove,
}: {
  images: GalleryImage[];
  empty: string;
  onPlace: (image: GalleryImage) => void;
  onRemove: (image: GalleryImage) => void;
}) {
  if (images.length === 0) return <p className="gallery-panel-copy">{empty}</p>;
  return (
    <ul className="gallery-grid">
      {images.map((image) => (
        <li key={image.id}>
          <GalleryThumb image={image} onPlace={onPlace} />
          <button type="button" className="gallery-remove" onClick={() => onRemove(image)}>
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}

function cosplayGroups(images: GalleryImage[]): { id: string; label: string; images: GalleryImage[] }[] {
  const buckets = new Map<string, GalleryImage[]>();
  for (const image of images) {
    const id = image.theme || "";
    const rows = buckets.get(id) ?? [];
    rows.push(image);
    buckets.set(id, rows);
  }
  const groups: { id: string; label: string; images: GalleryImage[] }[] = [];
  for (const theme of COSPLAY_THEMES) {
    const rows = buckets.get(theme.id);
    if (!rows?.length) continue;
    groups.push({ id: theme.id, label: theme.label, images: rows });
    buckets.delete(theme.id);
  }
  for (const [id, rows] of buckets) {
    if (!rows.length) continue;
    groups.push({ id: id || "none", label: id || "No theme", images: rows });
  }
  return groups;
}

type Props = {
  modelId: string;
  modelLabel: string;
  canSave: boolean;
  note: string;
  onSaveSelected: () => void;
  onPlace: (image: GalleryImage) => void;
  onClose: () => void;
};

export function GalleryPanel({
  modelId,
  modelLabel,
  canSave,
  note,
  onSaveSelected,
  onPlace,
  onClose,
}: Props) {
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setError("");
    try {
      setImages(await fetchGallery(modelId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the gallery");
    } finally {
      setLoading(false);
    }
  }, [modelId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ modelId?: string }>).detail;
      if (detail?.modelId && detail.modelId !== modelId) return;
      void reload();
    };
    window.addEventListener(GALLERY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(GALLERY_CHANGED_EVENT, onChanged);
  }, [modelId, reload]);

  const remove = async (image: GalleryImage) => {
    if (!window.confirm("Remove this still from her gallery?")) return;
    setError("");
    try {
      await deleteGalleryImage(modelId, image.id);
      setImages((prev) => prev.filter((item) => item.id !== image.id));
      notifyGalleryChanged(modelId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that still");
    }
  };

  return (
    <aside
      className="gallery-panel"
      aria-label={`${modelLabel} gallery`}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="gallery-panel-head">
        <div>
          <p className="gallery-panel-kicker">{modelLabel}</p>
          <h2>Gallery</h2>
        </div>
        <button type="button" className="tool-btn" onClick={onClose} title="Close gallery">
          <X size={16} />
        </button>
      </header>
      <p className="gallery-panel-copy">
        Auto Bikini and Cosplay save here on their own. Run uses a bikini still as her photo.
      </p>
      <button
        type="button"
        className="gallery-save"
        disabled={!canSave}
        onClick={onSaveSelected}
        title={canSave ? "Save the selected image into her gallery" : "Select one image first"}
      >
        Save selected
      </button>
      {note ? <p className="gallery-panel-note">{note}</p> : null}
      {error ? <p className="gallery-panel-error">{error}</p> : null}
      {loading ? <p className="gallery-panel-copy">Loading…</p> : null}
      {!loading ? (
        <>
          <section className="gallery-section">
            <h3>Bikini</h3>
            <GalleryGrid
              images={images.filter((image) => image.kind === "bikini")}
              empty="None yet. Auto Bikini saves into this group."
              onPlace={onPlace}
              onRemove={(image) => void remove(image)}
            />
          </section>
          <section className="gallery-section">
            <h3>Cosplay</h3>
            {images.some((image) => image.kind === "cosplay") ? (
              cosplayGroups(images.filter((image) => image.kind === "cosplay")).map((group) => (
                <div key={group.id} className="gallery-theme">
                  <h4>{group.label}</h4>
                  <GalleryGrid images={group.images} empty="" onPlace={onPlace} onRemove={(image) => void remove(image)} />
                </div>
              ))
            ) : (
              <p className="gallery-panel-copy">None yet. Cosplay saves into this group, under its theme.</p>
            )}
          </section>
          {images.some((image) => image.kind !== "bikini" && image.kind !== "cosplay") ? (
            <section className="gallery-section">
              <h3>Other</h3>
              <GalleryGrid
                images={images.filter((image) => image.kind !== "bikini" && image.kind !== "cosplay")}
                empty=""
                onPlace={onPlace}
                onRemove={(image) => void remove(image)}
              />
            </section>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}
