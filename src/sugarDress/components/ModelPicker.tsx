import { dressModelName, type DressModel } from "../lib/modelGallery";

type Props = {
  models: DressModel[];
  error: string;
  selectedId?: string;
  onPick: (id: string) => void;
  onClose?: () => void;
};

export function ModelPicker({ models, error, selectedId, onPick, onClose }: Props) {
  return (
    <div className="model-gate" role="dialog" aria-modal="true" aria-labelledby="model-gate-title">
      <div className="model-gate-card">
        <div className="model-gate-head">
          <div>
            <p className="model-gate-kicker">Sugar Dress</p>
            <h1 id="model-gate-title">Which girl is this gallery for?</h1>
            <p className="model-gate-copy">
              Stills you generate are saved on her. Video Flow can use them as her photo or as the
              picture for a card.
            </p>
          </div>
          {onClose ? (
            <button type="button" className="model-gate-close" onClick={onClose}>
              Cancel
            </button>
          ) : null}
        </div>
        {error ? <p className="model-gate-error">{error}</p> : null}
        {models.length === 0 ? (
          <p className="model-gate-copy">
            No girls yet. Add one on <a href="/dashboard/models">Models</a> first.
          </p>
        ) : (
          <ul className="model-gate-grid">
            {models.map((model) => {
              const name = dressModelName(model);
              const active = model.id === selectedId;
              return (
                <li key={model.id}>
                  <button
                    type="button"
                    className={active ? "model-gate-item is-active" : "model-gate-item"}
                    onClick={() => onPick(model.id)}
                  >
                    {model.avatar ? (
                      <img src={model.avatar} alt="" />
                    ) : (
                      <span className="model-gate-fallback" aria-hidden>
                        {name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="model-gate-name">{name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
