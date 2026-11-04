import { useEffect, useState } from "react";
import { InfiniteCanvas } from "./components/InfiniteCanvas";
import { ModelPicker } from "./components/ModelPicker";
import { readSavedModelId } from "../shared/currentModel";
import {
  dressModelName,
  fetchDressModels,
  readLinkedModelId,
  writeLinkedModelId,
  type DressModel,
} from "./lib/modelGallery";
import "./sugar-dress.css";

/** Full-bleed clothes canvas on the operator app (:5080). */
export function SugarDressPage() {
  const [models, setModels] = useState<DressModel[] | null>(null);
  const [modelId, setModelId] = useState(readLinkedModelId);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchDressModels()
      .then((rows) => {
        if (!cancelled) setModels(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setModels([]);
        setError(err instanceof Error ? err.message : "Could not load girls");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const model = models?.find((item) => item.id === modelId) ?? null;

  useEffect(() => {
    if (!models) return;
    const saved = readSavedModelId();
    if (saved && saved !== modelId && models.some((item) => item.id === saved)) {
      setModelId(saved);
      return;
    }
    if (modelId && !models.some((item) => item.id === modelId)) {
      setModelId("");
      setPicking(true);
      setError("That girl is not on Models anymore. Pick another.");
      return;
    }
    if (model) writeLinkedModelId(model.id);
  }, [models, modelId, model]);

  const showPicker = Boolean(models) && (picking || !model);

  return (
    <div className="sugar-dress-root" id="sugar-dress-root">
      {!models ? <div className="model-gate">Loading girls…</div> : null}
      {model ? (
        <InfiniteCanvas
          model={model}
          modelLabel={dressModelName(model)}
          onSwitchModel={() => {
            setError("");
            setPicking(true);
          }}
        />
      ) : null}
      {showPicker ? (
        <ModelPicker
          models={models ?? []}
          error={error}
          selectedId={model?.id}
          onPick={(id) => {
            setModelId(id);
            writeLinkedModelId(id);
            setPicking(false);
            setError("");
          }}
          onClose={
            model
              ? () => {
                  setPicking(false);
                  setError("");
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
