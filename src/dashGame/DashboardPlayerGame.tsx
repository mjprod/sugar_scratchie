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
 * `/?model=&card=` on the operator app plays one motion card as a game hand,
 * the same scratch game the player app opens with `?game=1`.
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

async function ensureMotionHand(modelId: string, cardId: string) {
  const existing = loadGameSession();
  const resume =
    isGameModeUrl() &&
    existing?.phase === "motion" &&
    existing.motionCardIds.includes(cardId);
  if (resume) {
    writeGameUrl(modelId, cardId);
    return;
  }
  try {
    const catalog = await loadGameCatalog();
    const entry = catalog.motion.find((card) => card.id === cardId);
    if (!entry) return;
    startMotionSession([
      {
        ...entry,
        model_id: entry.model_id || modelId,
      },
    ]);
  } catch {
    // ScratchPrototype still loads the catalog itself.
    return;
  }
  writeGameUrl(modelId, cardId);
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
  if (!modelId || !cardId) return null;

  return (
    <DashboardAuthProvider>
      <WalletProvider>
        <GameStage modelId={modelId} cardId={cardId} />
      </WalletProvider>
    </DashboardAuthProvider>
  );
}
