/**
 * Anchored wallet snapshot dialog for the top-nav Diamonds control.
 * Reuses the coverflow confirm glass shell + portal positioning.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { CoinLottie } from "@/components/ui/CoinLottie";
import { DiamondLottie } from "@/components/ui/DiamondLottie";
	import { formatCompactBalance } from "@/lib/formatBalance";
import {
  bestAffordableCoinExchange,
  formatExchangeDiamondAmount,
  formatExchangeDiamondPreview,
  type CoinExchangeOption,
} from "@/services/store";
import "@/features/packs/packs-entry.css";

export type WalletBalancesPopoverProps = {
  open: boolean;
  leaving?: boolean;
  diamonds: number | null;
  coins: number | null;
  /** Coins just received (post-game receipt) — shows a "+N" chip on the Dust row. */
  coinReceipt?: number;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onLeaveEnd?: () => void;
  /**
   * Convert Dust → Diamonds.
   * Desktop: hover previews max affordable diamonds on the Dust value.
   * Coarse pointer (mobile): tap runs the exchange immediately.
   */
  onConvertDust?: (option: CoinExchangeOption) => boolean | Promise<boolean>;
  /** Game HUD: same shell, diamond balance only — no dust or convert. */
  diamondsOnly?: boolean;
};

const LEAVE_ANIMATIONS = new Set([
  "coverflow-confirm-leave",
  "coverflow-buy-confirm-leave",
  "wallet-balances-popover-leave",
]);

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type FixedBox = {
  top: number;
  left: number;
  width: number;
};

function dialogFocusables(dialog: HTMLElement) {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) =>
      el.getAttribute("aria-disabled") !== "true" &&
      el.getClientRects().length > 0,
  );
}

function isCoarsePointer() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(hover: none), (pointer: coarse)").matches;
}

export function ConvertDustIcon({ className }: { className?: string }) {
  return (
    <svg
      width="9"
      height="18"
      viewBox="0 0 9 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M1.00024 17C2.76003 16.7554 4.39059 15.9391 5.64075 14.6766C6.89091 13.4142 7.69133 11.7758 7.91869 10.0137C8.14606 8.25159 7.78776 6.46362 6.899 4.9252C6.01023 3.38678 4.64031 2.18325 3.00024 1.5M7.00024 1L3.00024 1L3.00024 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WalletBalancesPopover({
  open,
  leaving = false,
  diamonds,
  coins,
  coinReceipt = 0,
  anchorRef,
  onClose,
  onLeaveEnd,
  onConvertDust,
  diamondsOnly = false,
}: WalletBalancesPopoverProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<FixedBox | null>(null);
  const [previewExchange, setPreviewExchange] = useState(false);
  const [converting, setConverting] = useState(false);
  const convertingRef = useRef(false);

  const affordable = useMemo(
    () => bestAffordableCoinExchange(coins ?? 0),
    [coins],
  );
  const canConvert = Boolean(onConvertDust && affordable && !converting);

  useLayoutEffect(() => {
    if (!open && !leaving) {
      setBox(null);
      setPreviewExchange(false);
      setConverting(false);
      convertingRef.current = false;
      return;
    }

    let raf = 0;
    let cancelled = false;

    const measure = () => {
      if (cancelled) return;
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const next: FixedBox = diamondsOnly
        ? {
            // Inset from the button's top-right so the bubble clears the progress border.
            top: rect.top + 50,
            left: rect.right - 40,
            width: 5 * 16,
          }
        : {
            // Sit directly under the Diamonds top-nav control.
            top: rect.bottom + 7,
            left: rect.left + rect.width / 2,
            width: 10 * 16,
          };
      setBox((prev) => {
        if (
          prev &&
          Math.abs(prev.top - next.top) < 0.5 &&
          Math.abs(prev.left - next.left) < 0.5 &&
          Math.abs(prev.width - next.width) < 0.5
        ) {
          return prev;
        }
        return next;
      });
    };

    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };

    measure();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);

    return () => {
      cancelled = true;
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
    };
  }, [anchorRef, open, leaving, diamonds, coins, diamondsOnly]);

  useEffect(() => {
    if (!open || leaving) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    let tries = 0;
    let raf = 0;
    const focusWhenReady = () => {
      const node = dialogRef.current;
      if (!node) return;
      const focusables = dialogFocusables(node);
      if (focusables.length > 0) {
        // Mobile autofocus paints :focus / :focus-visible on the convert
        // control as soon as the popover opens. Keep that for keyboards only.
        if (isCoarsePointer()) node.focus();
        else focusables[0]?.focus();
        return;
      }
      if (tries++ < 20) {
        raf = window.requestAnimationFrame(focusWhenReady);
      } else {
        node.focus();
      }
    };
    raf = window.requestAnimationFrame(focusWhenReady);

    function onPointerDown(event: PointerEvent) {
      const node = dialogRef.current;
      if (!node) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (node.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }

    function onKeyDown(event: KeyboardEvent) {
      const node = dialogRef.current;
      if (!node) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusables = dialogFocusables(node);
      if (focusables.length === 0) return;

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;

      if (!(active instanceof Node) || !node.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      if (
        previouslyFocused &&
        typeof previouslyFocused.focus === "function" &&
        document.contains(previouslyFocused)
      ) {
        previouslyFocused.focus();
      }
    };
  }, [open, leaving, onClose, anchorRef]);

  function handleLeaveEnd(event: ReactAnimationEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (!LEAVE_ANIMATIONS.has(event.animationName)) return;
    onLeaveEnd?.();
  }

  async function runConvert() {
    if (!onConvertDust || !affordable || convertingRef.current) return;
    convertingRef.current = true;
    setConverting(true);
    try {
      const ok = await onConvertDust(affordable);
      if (ok) {
        setPreviewExchange(false);
        onClose();
      }
    } finally {
      convertingRef.current = false;
      setConverting(false);
    }
  }

  function handleConvertClick(event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    event.preventDefault();
    if (!canConvert) return;
    // Mobile: tap converts immediately. Desktop: click also converts after hover preview.
    void runConvert();
  }

  if (!open && !leaving) return null;

	  const diamondLabel = formatCompactBalance(diamonds);
  const dustLabel = formatCompactBalance(coins);
  const previewAmount = affordable
    ? formatExchangeDiamondAmount(affordable.diamonds)
    : null;
  // Default always Dust balance; diamond exchange amount only while hovering convert.
  const showPreview =
    previewExchange &&
    Boolean(previewAmount) &&
    !isCoarsePointer() &&
    !converting;

  const style: CSSProperties | undefined = box
    ? {
        position: "fixed",
        top: box.top,
        left: box.left,
        width: box.width,
        minWidth: box.width,
        transform: diamondsOnly ? "translateX(-100%)" : "translateX(-50%)",
        transformOrigin: diamondsOnly ? "100% 0" : undefined,
        zIndex: 5200,
      }
    : {
        position: "fixed",
        top: 0,
        left: 0,
        opacity: 0,
        pointerEvents: "none",
        zIndex: 5200,
      };

  const hasReceipt = coinReceipt > 0;
  const dustRowLabel = hasReceipt
    ? `Dust balance ${dustLabel}. Received ${coinReceipt.toLocaleString("en-US")} Coins`
    : "Dust balance";

  const convertAria = affordable
    ? `Convert ${affordable.coins.toLocaleString("en-US")} Coins for ${formatExchangeDiamondPreview(affordable.diamonds)}`
    : "Not enough Coins to convert";

  const dialog = (
    <div
      ref={dialogRef}
      id="top-nav-wallet-balances"
      className={[
        "coverflow-cart-remove-confirm",
        "coverflow-buy-confirm",
        "wallet-balances-popover",
        "is-portaled",
        diamondsOnly ? "is-diamonds-only" : "",
        leaving ? "is-leaving" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="dialog"
      aria-label={diamondsOnly ? "Diamond balance" : "Wallet balances"}
      tabIndex={-1}
      style={style}
      onAnimationEnd={handleLeaveEnd}
    >
      <div
        className={[
          "wallet-balances-popover__row",
          "wallet-balances-popover__row--diamonds",
          !diamondsOnly && onConvertDust ? "has-convert" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="group"
        aria-label="Diamonds balance"
      >
        <div className="wallet-balances-popover__metric">
          <DiamondLottie
            className="wallet-balances-popover__icon"
            size={18}
            animated
            loop
            autoplay
            aria-hidden
          />
          <span className="wallet-balances-popover__value tabular-nums">
            {diamondLabel}
          </span>
        </div>
        {!diamondsOnly && onConvertDust ? (
          <button
            type="button"
            className={[
              "wallet-balances-popover__convert",
              canConvert ? "" : "is-disabled",
              converting ? "is-busy" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label={convertAria}
            disabled={!canConvert}
            onMouseEnter={() => {
              // Preview only on pointer hover — never on focus (dialog autofocus
              // would otherwise swap Dust → diamonds immediately on open).
              if (affordable && !isCoarsePointer()) setPreviewExchange(true);
            }}
            onMouseLeave={() => setPreviewExchange(false)}
            onClick={handleConvertClick}
          >
            <ConvertDustIcon className="wallet-balances-popover__convert-icon" />
          </button>
        ) : null}
      </div>

      {diamondsOnly ? null : (
      <div
        className={[
          "wallet-balances-popover__row",
          "wallet-balances-popover__row--dust",
          showPreview ? "is-exchange-preview" : "",
          hasReceipt ? "has-receipt" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="group"
        aria-label={dustRowLabel}
      >
        <div className="wallet-balances-popover__metric wallet-balances-popover__metric--dust">
          {showPreview ? (
            <DiamondLottie
              className="wallet-balances-popover__icon wallet-balances-popover__icon--preview-diamond"
              size={14}
              animated
              loop
              autoplay
              aria-hidden
            />
          ) : (
            <CoinLottie
              className="wallet-balances-popover__icon wallet-balances-popover__icon--dust"
              size={16}
              aria-hidden
            />
          )}
          <span
            className={[
              "wallet-balances-popover__value",
              "wallet-balances-popover__value--dust",
              "tabular-nums",
              showPreview ? "is-exchange-preview" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-live="polite"
          >
            {showPreview && previewAmount ? previewAmount : dustLabel}
          </span>
          {hasReceipt && !showPreview ? (
            <span
              className="wallet-balances-popover__receipt tabular-nums"
              aria-hidden="true"
            >
              +{formatCompactBalance(coinReceipt)}
            </span>
          ) : null}
        </div>
      </div>
      )}
    </div>
  );

  return typeof document !== "undefined"
    ? createPortal(dialog, document.body)
    : null;
}
