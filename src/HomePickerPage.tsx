import { Button, Card, Flex, Heading, Text } from "@radix-ui/themes";
import { useEffect, useMemo, useState } from "react";
import { OperatorFrame } from "./OperatorNav";
import { fetchCatalogMotionCards, type CatalogMotionCard } from "./shared/catalog";
import { fetchModels, type ModelInfo } from "./shared/models";

type LoadStatus = "loading" | "ready" | "error";

function cardsForModel(cards: CatalogMotionCard[], modelId: string): CatalogMotionCard[] {
  return cards
    .filter((entry) => entry.model_id === modelId)
    .sort((a, b) => {
      const orderA = a.sort_order ?? 0;
      const orderB = b.sort_order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      return a.id.localeCompare(b.id);
    });
}

function playHref(modelId: string): string {
  return `/?model=${encodeURIComponent(modelId)}`;
}

export function HomePickerPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [cards, setCards] = useState<CatalogMotionCard[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchModels(), fetchCatalogMotionCards()])
      .then(([loadedModels, loadedCards]) => {
        if (cancelled) return;
        setModels(loadedModels);
        setCards(loadedCards);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const playable = useMemo(
    () =>
      models.flatMap((model) => {
        const playlist = cardsForModel(cards, model.id);
        const first = playlist[0];
        if (!first) return [];
        return [{ model, count: playlist.length }];
      }),
    [cards, models],
  );

  const empty = status === "ready" && playable.length === 0;
  const centered = empty || status !== "ready";

  return (
    <OperatorFrame>
    <main className={`girl-picker${centered ? " girl-picker--empty" : ""}`} aria-busy={status === "loading"}>
      <div className="girl-picker-inner">
        <header className="girl-picker-header">
          <p className="girl-picker-eyebrow">Sugar Scratchie</p>
          <Heading as="h1" size="8">
            Choose a girl
          </Heading>
          <Text as="p" color="gray" size="3">
            Play only her motion cards, in the order you set on Models.
          </Text>
        </header>

        {status === "loading" ? <Text color="gray">Loading models…</Text> : null}

        {status === "error" ? (
          <Card>
            <Flex direction="column" gap="3" align="center">
              <Text>Models could not be loaded.</Text>
              <Button
                type="button"
                onClick={() => {
                  window.location.reload();
                }}
              >
                Try again
              </Button>
            </Flex>
          </Card>
        ) : null}

        {empty ? (
          <Card>
            <Flex direction="column" gap="3" align="center">
              <Heading as="h2" size="4">
                No motion cards yet
              </Heading>
              <Text as="p" color="gray" align="center">
                Add a girl on Models, then attach at least one motion card. She shows up here when
                there is something to play.
              </Text>
              <Button asChild>
                <a href="/dashboard/models">Go to Models</a>
              </Button>
            </Flex>
          </Card>
        ) : null}

        {status === "ready" && playable.length > 0 ? (
          <ul className="girl-picker-grid">
            {playable.map(({ model, count }, index) => (
              <li key={model.id}>
                <a href={playHref(model.id)}>
                  <article className="girl-picker-card">
                    {model.avatar ? (
                      <img
                        className="girl-picker-avatar"
                        alt=""
                        src={model.avatar}
                        width={72}
                        height={72}
                        loading={index === 0 ? "eager" : "lazy"}
                        decoding="async"
                      />
                    ) : (
                      <span className="girl-picker-fallback" aria-hidden="true">
                        {model.label.trim().slice(0, 1).toUpperCase() || "?"}
                      </span>
                    )}
                    <h2>{model.label}</h2>
                    <p>
                      {count} motion card{count === 1 ? "" : "s"}
                    </p>
                  </article>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </main>
    </OperatorFrame>
  );
}
