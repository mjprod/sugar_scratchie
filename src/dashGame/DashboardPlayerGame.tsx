import { useEffect, useLayoutEffect, useState } from "react";
import { WalletProvider } from "@/contexts/WalletContext";
import { ScratchPrototype } from "@/features/game/scratch/ScratchPrototype";
import scratchCss from "./features/game/scratch/styles.css?inline";
import {
  isGameModeUrl,
  loadGameSession,
  persistGameProgress,
  startMotionSession,
} from "@/features/game/modules/gameSession";
import { bindGameNavigate } from "@/services/gameSessionStore";
import { loadGameCatalog } from "@/features/game/modules/session";
import { DashboardAuthProvider } from "./DashboardAuthProvider";
import "@/features/game/game.css";
import "./dashboardPlayerGame.css";

const boots = new Map<string, Promise<void>>();

function leaveToPicker() {
  persistGameProgress();
  const next = "/";
  if (`${window.location.pathname}${window.location.search}` !== next) {
    window.history.pushState(null, "", next);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * `/?model=` plays that girl's motion cards in playlist order.
 * `/?model=&card=` plays that one card. Both use the same game hand as `?game=1`.
 */
function writeGameUrl(modelId: string, cardId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("model", modelId);
  url.searchParams.set("card", cardId);
  url.searchParams.set("game", "1");
  const next = `${url.pathname}?${url.searchParams.toString()}`;
  const current = `${window.location.pathname}${window.location.search}`;
  if (next !== current) window.history.replaceState(null, "", next);
}

function cardsInPlaylistOrder<T extends { id: string; sort_order?: number }>(
  cards: T[],
): T[] {
  return [...cards].sort((a, b) => {
    const orderA = a.sort_order ?? 0;
    const orderB = b.sort_order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return a.id.localeCompare(b.id);
  });
}

async function ensureMotionHand(modelId: string, cardId: string) {
  const existing = loadGameSession();
  const resume =
    isGameModeUrl() &&
    existing?.phase === "motion" &&
    existing.modelId === modelId &&
    existing.motionCardIds.length > 0 &&
    (!cardId || existing.motionCardIds.includes(cardId));
  if (resume && existing) {
    const playId =
      (cardId && existing.motionCardIds.includes(cardId) ? cardId : "") ||
      existing.motionCardIds.find(
        (id) => !existing.completedMotionIds.includes(id),
      ) ||
      existing.motionCardIds[0] ||
      "";
    if (playId) writeGameUrl(modelId, playId);
    return;
  }
  try {
    const catalog = await loadGameCatalog();
    const forModel = cardsInPlaylistOrder(
      catalog.motion.filter((card) => card.model_id === modelId),
    );
    const hand = cardId
      ? forModel.filter((card) => card.id === cardId)
      : forModel;
    const picked =
      hand.length > 0
        ? hand
        : cardId
          ? catalog.motion.filter((card) => card.id === cardId)
          : [];
    const first = picked[0];
    if (!first) return;
    startMotionSession(
      picked.map((card) => ({
        ...card,
        model_id: card.model_id || modelId,
      })),
    );
    writeGameUrl(modelId, first.id);
  } catch {
    // ScratchPrototype still loads the catalog itself.
    return;
  }
}

function bootHand(modelId: string, cardId: string) {
  const key = `${modelId}\0${cardId}`;
  let pending = boots.get(key);
  if (!pending) {
    pending = ensureMotionHand(modelId, cardId).finally(() => {
      boots.delete(key);
    });
    boots.set(key, pending);
  }
  return pending;
}

function GameStage({ modelId, cardId }: { modelId: string; cardId: string }) {
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    document.documentElement.dataset.scratchGame = "1";
    return () => {
      delete document.documentElement.dataset.scratchGame;
    };
  }, []);

  useEffect(() => {
    const style = document.createElement("style");
    style.setAttribute("data-scratch-game", "1");
    style.textContent = scratchCss;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  useEffect(() => {
    bindGameNavigate((href) => {
      const url = new URL(href, window.location.origin);
      const path =
        url.pathname === "/game" || url.pathname === "/collection"
          ? "/"
          : `${url.pathname}${url.search}${url.hash}`;
      if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== path) {
        window.history.pushState(null, "", path);
      }
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    return () => bindGameNavigate(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void bootHand(modelId, cardId).finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [modelId, cardId]);

  return (
    <div className="dashboard-player-game">
      <div className="app-shell app-shell--game">
        <div className="stage-game">
          {ready ? (
            <ScratchPrototype
              key={`${modelId}-${cardId}`}
              onLeave={leaveToPicker}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function DashboardPlayerGame() {
  const params = new URLSearchParams(window.location.search);
  const modelId = params.get("model")?.trim() || "";
  const cardId = params.get("card")?.trim() || "";
  if (!modelId) return null;

  return (
    <DashboardAuthProvider>
      <WalletProvider>
        <GameStage modelId={modelId} cardId={cardId} />
      </WalletProvider>
    </DashboardAuthProvider>
  );
}
