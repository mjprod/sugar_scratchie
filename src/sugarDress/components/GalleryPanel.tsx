import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
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
  onPlace: (url: string) => void;
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
      onClick={() => onPlace(image.url)}
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

type Props = {
  modelId: string;
  modelLabel: string;
  canSave: boolean;
  note: string;
  onSaveSelected: () => void;
  onPlace: (url: string) => void;
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
        Generated stills stay with this girl. Click one to put it on the canvas. Video Flow can use
        the same stills.
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
      {!loading && images.length === 0 ? (
        <p className="gallery-panel-copy">Nothing saved yet. Generate a still and it lands here.</p>
      ) : (
        <ul className="gallery-grid">
          {images.map((image) => (
            <li key={image.id}>
              <GalleryThumb image={image} onPlace={onPlace} />
              <button
                type="button"
                className="gallery-remove"
                onClick={() => void remove(image)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
