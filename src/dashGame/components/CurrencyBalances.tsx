import { useEffect, useRef, useState, type RefObject } from "react";
import { DiamondLottie } from "@/components/ui/DiamondLottie";
import { WalletBalancesPopover } from "@/components/WalletBalancesPopover";
import { useWallet } from "@/contexts/WalletContext";
import { formatBalance } from "@/lib/formatBalance";
import {
  WALLET_REVEAL_EVENT,
  type WalletRevealDetail,
} from "@/services/coinReceipt";
import {
  exchangeCoinsForDiamonds,
  type CoinExchangeOption,
} from "@/services/store";

export { formatBalance, formatCompactBalance } from "@/lib/formatBalance";

/** How long the post-game coin receipt popover stays open on its own. */
const WALLET_RECEIPT_AUTO_CLOSE_MS = 4000;

/**
 * The inactive desktop/mobile HUD stays laid out but is hidden with
 * `visibility: hidden` / `opacity: 0` on an ancestor, so rects alone lie.
 * Early `checkVisibility` builds only honour `checkOpacity` /
 * `checkVisibilityCSS` and silently ignore the newer option names, so it is
 * only trusted to reject; the computed-style walk always runs.
 */
function isRenderedVisible(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false;
  const check = (
    el as HTMLElement & {
      checkVisibility?: (opts: {
        opacityProperty?: boolean;
        visibilityProperty?: boolean;
        checkOpacity?: boolean;
        checkVisibilityCSS?: boolean;
      }) => boolean;
    }
  ).checkVisibility;
  if (
    typeof check === "function" &&
    !check.call(el, {
      opacityProperty: true,
      visibilityProperty: true,
      checkOpacity: true,
      checkVisibilityCSS: true,
    })
  ) {
    return false;
  }
  if (window.getComputedStyle(el).visibility !== "visible") return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === "none" || Number(style.opacity) === 0) return false;
  }
  return true;
}

/** Inline diamond HUD counter (TopNav, mobile HUD, and subpage headers).
 * Dust lives in the Diamonds wallet popover. */
export function CurrencyBalances({
  coins,
  diamonds,
  onOpenStore: _onOpenStore,
  storeActive = false,
  interactive = true,
  compact = false,
  diamondsOnly = false,
}: {
  coins: number | null;
  diamonds: number | null;
  /** Kept for call-site compatibility; Dust tap moved into the wallet popover. */
  onOpenStore?: () => void;
  /** Subtle contextual highlight while Store is open. */
  storeActive?: boolean;
  /** False keeps the count visible without the wallet / conversion popup. */
  interactive?: boolean;
  /** Icon only — used by the game HUD. */
  compact?: boolean;
  /** Popup shows the diamond balance only, no dust or convert. */
  diamondsOnly?: boolean;
}) {
  const { coins: walletCoins, diamonds: walletDiamonds, applyWallet } =
    useWallet();
  const diamondLabel = formatBalance(diamonds);
  const diamondAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletLeaving, setWalletLeaving] = useState(false);
  const leaveTimerRef = useRef<number | null>(null);
  /** Bumped on open / reopen so a stale leave timer or animationend cannot close. */
  const leaveEpochRef = useRef(0);
  const activeLeaveEpochRef = useRef<number | null>(null);
  /** Coins shown as "+N" while the popover was opened by a post-game receipt. */
  const [receiptCoins, setReceiptCoins] = useState(0);
  const receiptTimerRef = useRef<number | null>(null);
  const closeWalletRef = useRef<() => void>(() => undefined);
  const openWalletRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    return () => {
      if (leaveTimerRef.current != null) {
        window.clearTimeout(leaveTimerRef.current);
      }
      if (receiptTimerRef.current != null) {
        window.clearTimeout(receiptTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    function onWalletReveal(event: Event) {
      if (!interactive) return;
      const detail = (event as CustomEvent<WalletRevealDetail>).detail;
      const coins = detail?.coins ?? 0;
      if (!detail || detail.handled || !(coins > 0)) return;
      // Desktop + mobile navs are both mounted; only the visible one opens.
      const anchor = diamondAnchorRef.current;
      if (!anchor || !isRenderedVisible(anchor)) return;
      detail.handled = true;
      clearReceiptTimer();
      setReceiptCoins(coins);
      openWalletRef.current();
      receiptTimerRef.current = window.setTimeout(() => {
        receiptTimerRef.current = null;
        closeWalletRef.current();
      }, WALLET_RECEIPT_AUTO_CLOSE_MS);
    }
    window.addEventListener(WALLET_REVEAL_EVENT, onWalletReveal);
    return () => {
      window.removeEventListener(WALLET_REVEAL_EVENT, onWalletReveal);
    };
  }, [interactive]);

  function clearReceiptTimer() {
    if (receiptTimerRef.current != null) {
      window.clearTimeout(receiptTimerRef.current);
      receiptTimerRef.current = null;
    }
  }

  function clearLeaveTimer() {
    if (leaveTimerRef.current != null) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  }

  function completeLeave(epoch: number) {
    if (activeLeaveEpochRef.current !== epoch) return;
    activeLeaveEpochRef.current = null;
    clearLeaveTimer();
    setWalletOpen(false);
    setWalletLeaving(false);
    setReceiptCoins(0);
  }

  function closeWallet() {
    if (!walletOpen || walletLeaving) return;
    clearReceiptTimer();
    const epoch = ++leaveEpochRef.current;
    activeLeaveEpochRef.current = epoch;
    setWalletLeaving(true);
    clearLeaveTimer();
    leaveTimerRef.current = window.setTimeout(() => {
      completeLeave(epoch);
    }, 420);
  }

  function openWallet() {
    // Invalidate any in-flight leave so its timer/animationend cannot re-close.
    leaveEpochRef.current += 1;
    activeLeaveEpochRef.current = null;
    clearLeaveTimer();
    setWalletLeaving(false);
    setWalletOpen(true);
  }

  closeWalletRef.current = closeWallet;
  openWalletRef.current = openWallet;

  function toggleWallet() {
    if (walletOpen && !walletLeaving) {
      closeWallet();
    } else {
      clearReceiptTimer();
      setReceiptCoins(0);
      openWallet();
    }
  }

  async function handleConvertDust(
    option: CoinExchangeOption,
  ): Promise<boolean> {
    const result = await exchangeCoinsForDiamonds(option, {
      diamonds: walletDiamonds,
      coins: walletCoins,
    });
    if (result.status !== "success") return false;
    applyWallet({ diamonds: result.diamonds, coins: result.coins });
    return true;
  }

  const diamondInner = (
    <>
      <DiamondLottie
        className="top-nav-resource-icon top-nav-resource-icon--diamond shrink-0"
        size={14}
        animated
        loop
        autoplay
        aria-hidden
      />
      {compact ? null : (
        <span className="top-nav-resource-value text-[13px] font-semibold tabular-nums">
          {diamondLabel}
        </span>
      )}
    </>
  );

  const diamondActionClass = [
    "top-nav-resource top-nav-resource--action top-nav-resource--diamond inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-md px-1.5 transition active:scale-95",
    compact ? "is-compact" : "",
    storeActive ? "top-nav-resource--store-active" : "",
    walletOpen && !walletLeaving ? "is-wallet-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className="top-nav-resources flex min-w-0 shrink-0 items-center gap-2"
      aria-live="polite"
    >
      {interactive ? (
        <button
          type="button"
          ref={diamondAnchorRef as RefObject<HTMLButtonElement>}
          onClick={toggleWallet}
          aria-label={
            diamondsOnly
              ? `${diamondLabel} Diamonds`
              : `${diamondLabel} Diamonds, wallet details`
          }
          aria-haspopup="dialog"
          aria-expanded={walletOpen && !walletLeaving}
          aria-controls="top-nav-wallet-balances"
          className={diamondActionClass}
        >
          {diamondInner}
        </button>
      ) : (
        <span
          className={diamondActionClass}
          aria-label={`${diamondLabel} Diamonds`}
        >
          {diamondInner}
        </span>
      )}

      {interactive ? (
        <WalletBalancesPopover
          open={walletOpen}
          leaving={walletLeaving}
          diamonds={diamonds}
          coins={coins}
          coinReceipt={receiptCoins}
          anchorRef={diamondAnchorRef}
          onClose={closeWallet}
          onLeaveEnd={() => {
            const epoch = activeLeaveEpochRef.current;
            if (epoch == null) return;
            completeLeave(epoch);
          }}
          onConvertDust={diamondsOnly ? undefined : handleConvertDust}
          diamondsOnly={diamondsOnly}
        />
      ) : null}
    </div>
  );
}

