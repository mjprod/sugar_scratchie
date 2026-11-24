import { useEffect, useLayoutEffect, useState } from "react";
import { WalletProvider } from "@/contexts/WalletContext";
import { ScratchPrototype } from "@/features/game/scratch/ScratchPrototype";
import scratchCss from "@/features/game/scratch/styles.css?inline";
import {
  getGameAudioPrefs,
  setGameAudioMuted,
} from "@/services/gameAudioPrefs";
import { DashboardAuthProvider } from "../dashGame/DashboardAuthProvider";
import "@/features/game/game.css";

/**
 * Placeholder motion-card scratch game for Leo "Try Motion Card".
 * Uses the lab skipToPlay path (julianaval / juliana_1) so we don't need a
 * published draft or URL handoff that would remount /leo-ui.
 */
export function LeoTryMotionGame({
  onReady,
  onClose,
  onAccept,
}: {
  onReady?: () => void;
  /** X — dismiss try, stay on Game Created. */
  onClose?: () => void;
  /** Check — publish card and leave for Models. */
  onAccept?: () => void;
}) {
  const [cssReady, setCssReady] = useState(false);

  useLayoutEffect(() => {
    document.documentElement.dataset.scratchGame = "1";
    return () => {
      delete document.documentElement.dataset.scratchGame;
    };
  }, []);

  // Force master mute for the try overlay; restore the prior pref on leave.
  useEffect(() => {
    const wasMuted = getGameAudioPrefs().muted;
    setGameAudioMuted(true);
    return () => {
      setGameAudioMuted(wasMuted);
    };
  }, []);

  useEffect(() => {
    const style = document.createElement("style");
    style.setAttribute("data-leo-try-scratch", "1");
    style.textContent = scratchCss;
    document.head.appendChild(style);
    setCssReady(true);
    return () => {
      style.remove();
    };
  }, []);

  if (!cssReady) return null;

  return (
    <div className="leo-ui__try-motion-game">
      <DashboardAuthProvider>
        <WalletProvider>
          <div className="app-shell app-shell--game">
            <div className="stage-game">
              <ScratchPrototype
                skipToPlay
                tryChrome
                onPlayReady={onReady}
                onLeave={onClose}
                onFinish={onAccept ?? onClose}
              />
            </div>
          </div>
        </WalletProvider>
      </DashboardAuthProvider>
    </div>
  );
}
