import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  beginPhotoPhase,
  clearGameSession,
  firstMissingMotionCardId,
  loadGameSession,
  motionPlayHref,
  navigateTo,
  photoPlayHref,
  startMotionSession,
  type GameSession,
} from "./game/gameSession";
import { unlockCountdownSound } from "./game/InitialCountdown";
import {
  buildDealtRound,
  loadGameCatalog,
  type PhotoCard,
  type ThemedMotionCard,
} from "./game/session";
import { releaseMediaElement } from "./shared/media";

type Phase =
  | "loading"
  | "idle"
  | "dealing"
  | "ready"
  | "photo_reveal"
  | "done";

const DEAL_STEP_MS = 520;
const PRIZE_REVEAL_MS = 420;

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function themeAccent(theme: string): string {
  const key = theme.toLowerCase();
  if (key.includes("police") || key.includes("cop")) return "#3b6ea8";
  if (key.includes("teacher")) return "#8b5a2b";
  if (key.includes("nurse")) return "#c45c7a";
  if (key.includes("fire")) return "#d4552a";
  if (key.includes("gym")) return "#2f7d5a";
  return "#a86b3b";
}

function MotionPreview({ card }: { card: ThemedMotionCard }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Hub cards show the dressed foreground clip, not the under-layer bottom video.
    video.src = card.foreground;
    video.load();
    const play = () => {
      void video.play().catch(() => undefined);
    };
    video.addEventListener("loadeddata", play);
    // Safari often suspends background <video>s in a row of five — nudge them.
    const keepAlive = window.setInterval(() => {
      if (video.paused) play();
    }, 1200);
    if (video.readyState >= 2) play();
    return () => {
      video.removeEventListener("loadeddata", play);
      window.clearInterval(keepAlive);
      releaseMediaElement(video);
    };
  }, [card.foreground, card.id]);

  return (
    <video
      ref={videoRef}
      className="game-hub-card-media"
      muted
      playsInline
      loop
      autoPlay
      preload="auto"
    />
  );
}

function PhotoLayers({ photo }: { photo: PhotoCard }) {
  return (
    <div className="game-hub-photo-layers">
      <img alt="" src={photo.background} />
      <img alt="" src={photo.bikini} />
      <img alt="" src={photo.clothes} />
    </div>
  );
}

export function GamePage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [motionPool, setMotionPool] = useState<ThemedMotionCard[]>([]);
  const [photoPool, setPhotoPool] = useState<PhotoCard[]>([]);
  const [hand, setHand] = useState<ThemedMotionCard[]>([]);
  const [session, setSession] = useState<GameSession | null>(null);
  const [wonPhotos, setWonPhotos] = useState<PhotoCard[]>([]);
  const [revealedSlots, setRevealedSlots] = useState(0);
  const [prizeRevealed, setPrizeRevealed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runIdRef = useRef(0);
  const resumedRef = useRef(false);
  const handRef = useRef<HTMLDivElement | null>(null);

  const themeCount = useMemo(() => {
    const keys = new Set(motionPool.map((card) => card.theme.toLowerCase()));
    return keys.size;
  }, [motionPool]);

  // Prime countdown AudioContext on the first hub tap so Play → navigate →
  // 3-2-1 can use a already-running context (Safari won't start HTMLAudio later).
  useEffect(() => {
    const warm = () => unlockCountdownSound();
    window.addEventListener("pointerdown", warm, { capture: true, once: true });
    return () => window.removeEventListener("pointerdown", warm, true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const catalog = await loadGameCatalog();
        if (cancelled) return;
        setMotionPool(catalog.motion);
        setPhotoPool(catalog.photos);

        const existing = loadGameSession();
        if (existing?.phase === "photo_reveal" || existing?.phase === "done") {
          setSession(existing);
          const photos = existing.wonPhotoIds
            .map((id) => catalog.photos.find((photo) => photo.id === id))
            .filter((photo): photo is PhotoCard => Boolean(photo));
          setWonPhotos(photos);
          const dealt = existing.motionCardIds
            .map((id) => catalog.motion.find((card) => card.id === id))
            .filter((card): card is ThemedMotionCard => Boolean(card));
          setHand(dealt);
          setRevealedSlots(dealt.length);
          setPhase(existing.phase === "done" ? "done" : "photo_reveal");
          return;
        }

        if (existing?.phase === "motion" || existing?.phase === "photo") {
          setSession(existing);
          const dealt = existing.motionCardIds
            .map((id) => catalog.motion.find((card) => card.id === id))
            .filter((card): card is ThemedMotionCard => Boolean(card));
          setHand(dealt);
          setRevealedSlots(dealt.length);
          setPhase("ready");
          return;
        }

        setPhase("idle");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load cards");
        setPhase("idle");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (phase !== "photo_reveal" || resumedRef.current || wonPhotos.length === 0) {
      return;
    }
    resumedRef.current = true;
    let cancelled = false;
    void (async () => {
      setPrizeRevealed(0);
      for (let i = 0; i < wonPhotos.length; i += 1) {
        if (cancelled) return;
        await wait(PRIZE_REVEAL_MS);
        if (cancelled) return;
        setPrizeRevealed(i + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, wonPhotos]);

  useEffect(() => {
    if (revealedSlots <= 0) return;
    const root = handRef.current;
    if (!root) return;
    const card = root.children[revealedSlots - 1] as HTMLElement | undefined;
    card?.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [revealedSlots]);

  // Lock New Game only while a motion/photo scratch run is mid-flight.
  // On photo_reveal (and done), remake is allowed — abandon prizes and re-deal.
  const handLocked =
    Boolean(session) &&
    (session!.phase === "motion" || session!.phase === "photo");
  const canDeal =
    !busy &&
    (phase === "idle" ||
      phase === "done" ||
      phase === "photo_reveal" ||
      (phase === "ready" && !handLocked));
  const showHand =
    hand.length > 0 && (phase === "dealing" || phase === "ready");
  const inProgressSession =
    session && (session.phase === "motion" || session.phase === "photo");
  const playLabel =
    session?.phase === "photo"
      ? "Continue"
      : session?.phase === "motion" && session.completedMotionIds.length > 0
        ? "Continue"
        : "Play";
  const walletLabel =
    session?.phase === "photo" || session?.phase === "photo_reveal"
      ? `Game in progress · ${session.completedPhotoIds.length}/${session.wonPhotoIds.length || session.photoPrizeTotal} photos`
      : handLocked
        ? `Game in progress · ${session!.completedMotionIds.length}/${session!.motionCardIds.length} cards`
        : "1 game available";

  async function startNewGame() {
    if (!canDeal) return;
    if (motionPool.length === 0) {
      setError("No motion cards available.");
      return;
    }
    const next = buildDealtRound(motionPool, photoPool);
    if (!next) {
      setError("Need motion cards with distinct themes to deal a hand.");
      return;
    }
    clearGameSession();
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setBusy(true);
    setError(null);
    setSession(null);
    setWonPhotos([]);
    setHand(next.cards);
    setRevealedSlots(0);
    setPrizeRevealed(0);
    resumedRef.current = false;
    setPhase("dealing");

    for (let i = 0; i < next.cards.length; i += 1) {
      if (runIdRef.current !== runId) return;
      await wait(DEAL_STEP_MS);
      if (runIdRef.current !== runId) return;
      setRevealedSlots(i + 1);
    }
    await wait(380);
    if (runIdRef.current !== runId) return;
    setPhase("ready");
    setBusy(false);
  }

  function playMotionHand() {
    if (busy || hand.length === 0) return;
    // Unlock 3-2-1 AudioContext inside the click. navigateTo is SPA so this
    // context survives into the scratch screen (a full reload would kill it).
    unlockCountdownSound();
    const existing = loadGameSession();
    if (existing?.phase === "motion" || existing?.phase === "photo") {
      if (existing.phase === "photo") {
        const started = beginPhotoPhase() ?? existing;
        navigateTo(photoPlayHref(started));
        return;
      }
      navigateTo(motionPlayHref(existing, firstMissingMotionCardId(existing)));
      return;
    }
    const created = startMotionSession(hand);
    setSession(created);
    navigateTo(motionPlayHref(created));
  }

  function playPhotoHand() {
    const current = loadGameSession();
    if (!current || current.wonPhotoIds.length === 0) {
      setError("No photo scratches won this round.");
      return;
    }
    unlockCountdownSound();
    const started = beginPhotoPhase() ?? current;
    setSession(started);
    navigateTo(photoPlayHref(started));
  }

  function deleteGame() {
    if (busy) return;
    const hasProgress =
      Boolean(session) || hand.length > 0 || phase === "photo_reveal" || phase === "done";
    if (!hasProgress) return;
    if (
      !window.confirm(
        "Delete this game? Your hand and any scratch progress will be lost.",
      )
    ) {
      return;
    }
    runIdRef.current += 1;
    clearGameSession();
    setSession(null);
    setHand([]);
    setWonPhotos([]);
    setRevealedSlots(0);
    setPrizeRevealed(0);
    resumedRef.current = false;
    setError(null);
    setBusy(false);
    setPhase("idle");
  }

  const canDelete =
    !busy &&
    phase !== "loading" &&
    phase !== "dealing" &&
    (Boolean(session) || hand.length > 0);

  return (
    <main className={`game-hub game-hub--${phase}`}>
      <div className="game-hub-glow" aria-hidden="true" />
      <div className="game-hub-glow game-hub-glow--alt" aria-hidden="true" />

      <header className="game-hub-header">
        <p className="eyebrow">Sugar Scratchie</p>
        <h1>GAME</h1>
        <p className="game-hub-copy">
          Deal five motion cards — one theme each. Scratch them for photo
          prizes, then scratch photos for diamonds.
        </p>
        <p className="game-hub-copy game-hub-copy--mobile">
          5 themes → scratch for photos → photos for diamonds
        </p>
        <div className="game-hub-wallet" aria-live="polite">
          <span className="game-hub-wallet-label">Wallet</span>
          <strong>{walletLabel}</strong>
        </div>
        <div className="game-hub-meta">
          <span>
            {motionPool.length} motion · {themeCount} themes · {photoPool.length}{" "}
            photos
          </span>
          <nav className="game-hub-nav">
            <a href="/">Home</a>
            <a href="/dashboard/models">Models</a>
          </nav>
        </div>
      </header>

      {error ? <p className="game-hub-error">{error}</p> : null}

      <section className="game-hub-stage" aria-live="polite">
        {phase === "loading" ? (
          <p className="game-hub-status">Loading cards…</p>
        ) : null}

        {phase === "idle" ? (
          <div className="game-hub-idle">
            <div className="game-hub-idle-stack" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className={`game-hub-idle-card game-hub-idle-card--${i}`}
                />
              ))}
            </div>
            <p className="game-hub-status">Press New Game to deal your hand</p>
          </div>
        ) : null}

        {showHand ? (
          <div className="game-hub-hand" ref={handRef}>
            {hand.map((card, index) => {
              const revealed = index < revealedSlots;
              const done = Boolean(
                session?.completedMotionIds.includes(card.id),
              );
              return (
                <article
                  key={card.id}
                  className={[
                    "game-hub-card",
                    revealed ? "is-revealed" : "is-hidden",
                    done ? "is-played is-win" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={
                    {
                      "--theme-accent": themeAccent(card.theme),
                      animationDelay: `${index * 60}ms`,
                    } as CSSProperties
                  }
                >
                  <div className="game-hub-card-inner">
                    <div className="game-hub-card-face game-hub-card-face--back">
                      <span>SCRATCH</span>
                    </div>
                    <div className="game-hub-card-face game-hub-card-face--front">
                      <div className="game-hub-card-media-wrap">
                        {revealed ? <MotionPreview card={card} /> : null}
                      </div>
                      <div className="game-hub-card-info">
                        <span
                          className="game-hub-theme"
                          style={{ background: themeAccent(card.theme) }}
                        >
                          {card.theme}
                        </span>
                        <strong>{card.label}</strong>
                      </div>
                      {done ? (
                        <div className="game-hub-card-result">
                          <span>Scratched</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}

        {phase === "photo_reveal" && session ? (
          <div className="game-hub-prizes">
            <div className="game-hub-round-strip">
              {hand.map((card) => (
                <div
                  key={card.id}
                  className="game-hub-strip-chip is-win"
                  style={{ borderColor: themeAccent(card.theme) }}
                >
                  <span style={{ background: themeAccent(card.theme) }}>
                    {card.theme}
                  </span>
                  <strong>✓</strong>
                </div>
              ))}
            </div>
            <div className="game-hub-prizes-header">
              <h2>
                {session.photoPrizeTotal > 0
                  ? `You won ${session.photoPrizeTotal} photocard${session.photoPrizeTotal === 1 ? "" : "s"}!`
                  : "No photocards this round"}
              </h2>
              <p>
                {session.photoPrizeTotal > 0
                  ? "Random picks from the photo pool — scratch them next for diamonds."
                  : "Deal again for another shot."}
              </p>
            </div>
            {wonPhotos.length > 0 ? (
              <div className="game-hub-prize-grid">
                {wonPhotos.map((photo, index) => {
                  const shown = index < prizeRevealed;
                  return (
                    <article
                      key={photo.id}
                      className={`game-hub-prize${shown ? " is-shown" : ""}`}
                      style={{ animationDelay: `${index * 80}ms` }}
                    >
                      <div className="game-hub-prize-inner">
                        <div className="game-hub-prize-back">?</div>
                        <div className="game-hub-prize-front">
                          <PhotoLayers photo={photo} />
                          <span>{photo.label}</span>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        {phase === "done" && session ? (
          <div className="game-hub-tally" role="status">
            <p className="game-hub-tally-label">Diamonds won</p>
            <p className="game-hub-tally-value">{session.diamondTotal}</p>
            <p className="game-hub-status">
              From {session.wonPhotoIds.length} photo scratch
              {session.wonPhotoIds.length === 1 ? "" : "es"}
            </p>
          </div>
        ) : null}
      </section>

      <footer className="game-hub-actions">
        <button
          type="button"
          className="game-hub-new"
          disabled={!canDeal}
          onClick={() => void startNewGame()}
        >
          New Game
        </button>
        {phase === "ready" ? (
          <button
            type="button"
            className="game-hub-play"
            disabled={busy || hand.length === 0}
            onClick={playMotionHand}
          >
            {playLabel}
          </button>
        ) : null}
        {phase === "photo_reveal" && session && session.photoPrizeTotal > 0 ? (
          <button
            type="button"
            className="game-hub-play"
            onClick={playPhotoHand}
          >
            Scratch photos for diamonds
          </button>
        ) : null}
        {canDelete ? (
          <button
            type="button"
            className="game-hub-delete"
            onClick={deleteGame}
          >
            Delete Game
          </button>
        ) : null}
        {phase === "dealing" ? (
          <p className="game-hub-status-inline">Dealing unique themes…</p>
        ) : null}
        {inProgressSession && phase === "ready" ? (
          <p className="game-hub-status-inline">
            {session.phase === "photo"
              ? `${session.completedPhotoIds.length}/${session.wonPhotoIds.length} photos done`
              : `${session.completedMotionIds.length}/${session.motionCardIds.length} motion done · ${session.photoPrizeTotal} photos banked`}
          </p>
        ) : null}
      </footer>
    </main>
  );
}
