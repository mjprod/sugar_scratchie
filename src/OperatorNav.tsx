import { ChevronDown, Menu } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { operatorLogout } from "./shared/api";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/dashboard/users", label: "Users" },
  { href: "/dashboard/ai-models", label: "AI models" },
  { href: "/dashboard/video-flow", label: "Video" },
] as const;

const GAME_LINKS = [
  { href: "/dashboard/seasons", label: "Seasons" },
  { href: "/dashboard/themes", label: "Themes" },
  { href: "/dashboard/packs", label: "Packs" },
  { href: "/symbols", label: "Symbols" },
  { href: "/game", label: "Play" },
] as const;

const ALL_LINKS = [...LINKS, ...GAME_LINKS];

function currentHref(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/dashboard/models") return "/";
  if (path === "/game") return "/game";
  if (path === "/symbols" || path === "/dashboard/symbols") return "/symbols";
  if (path === "/dashboard/seasons" || path === "/dashboard/sessions") return "/dashboard/seasons";
  if (
    path === "/video-flow" ||
    path.startsWith("/dashboard/video-flow") ||
    path === "/picture-flow" ||
    path.startsWith("/dashboard/picture-flow")
  ) {
    return "/dashboard/video-flow";
  }
  const match = ALL_LINKS.find(
    (link) => link.href !== "/" && (path === link.href || path.startsWith(`${link.href}/`)),
  );
  return match?.href ?? null;
}

function signOut() {
  void operatorLogout().finally(() => {
    window.location.assign("/dashboard/login");
  });
}

export function OperatorFrame({ children }: { children: ReactNode }) {
  return (
    <div className="operator-frame">
      <OperatorNav />
      {children}
    </div>
  );
}

export function OperatorNav() {
  const headerRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const gameItemRef = useRef<HTMLLIElement>(null);
  const gameTriggerRef = useRef<HTMLButtonElement>(null);
  const gameMenuRef = useRef<HTMLUListElement>(null);
  const active = currentHref(window.location.pathname);
  const gameSectionActive = GAME_LINKS.some((link) => link.href === active);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const inner = innerRef.current;
    const menu = menuRef.current;
    const gameItem = gameItemRef.current;
    const trigger = gameTriggerRef.current;
    const submenu = gameMenuRef.current;
    if (!header || !inner || !menu || !gameItem || !trigger || !submenu) return;

    const popoverOk = Object.hasOwn(HTMLElement.prototype, "popover");
    const canHover = window.matchMedia("(hover: hover)");
    let lastWidth = 0;
    let layoutWide: boolean | null = null;
    let previewed = false;

    const syncSubmenu = (wide: boolean) => {
      if (layoutWide === wide) return;
      layoutWide = wide;
      previewed = false;
      if (wide && popoverOk) {
        submenu.setAttribute("popover", "auto");
        submenu.hidden = false;
      } else {
        submenu.removeAttribute("popover");
        submenu.hidden = true;
      }
      trigger.setAttribute("aria-expanded", "false");
    };

    const sync = () => {
      const wasOpen = popoverOk && menu.matches(":popover-open");
      header.classList.add("is-measuring");
      header.classList.add("is-wide");
      if (popoverOk) menu.removeAttribute("popover");
      const fits = inner.scrollWidth <= inner.clientWidth + 1;
      header.classList.toggle("is-wide", fits);
      if (!popoverOk) {
        menu.classList.remove("is-open");
      } else if (fits) {
        menu.removeAttribute("popover");
      } else {
        menu.setAttribute("popover", "auto");
        if (wasOpen) {
          try {
            menu.showPopover();
          } catch {
            // Already open, or the popover API rejected the call.
          }
        }
      }
      syncSubmenu(fits);
      lastWidth = header.clientWidth;
      requestAnimationFrame(() => header.classList.remove("is-measuring"));
    };

    const onResize = () => {
      const wide = header.classList.contains("is-wide");
      const width = header.clientWidth;
      if (!wide && width <= lastWidth) return;
      sync();
    };

    const onToggle = (event: ToggleEvent) => {
      if (!submenu.hasAttribute("popover")) return;
      trigger.setAttribute("aria-expanded", event.newState === "open" ? "true" : "false");
    };

    const onTriggerClick = (event: MouseEvent) => {
      if (!header.classList.contains("is-wide")) {
        event.preventDefault();
        const open = submenu.hidden;
        submenu.hidden = !open;
        trigger.setAttribute("aria-expanded", open ? "true" : "false");
        return;
      }
      if (!previewed) return;
      previewed = false;
      event.preventDefault();
    };

    const onPointerEnter = (event: PointerEvent) => {
      if (!header.classList.contains("is-wide") || !submenu.hasAttribute("popover")) return;
      if (!canHover.matches || event.pointerType === "touch") return;
      previewed = true;
      const show = submenu.showPopover as (options?: { source?: HTMLElement }) => void;
      show.call(submenu, { source: trigger });
    };

    const onPointerLeave = (event: PointerEvent) => {
      if (!previewed) return;
      const next = event.relatedTarget;
      if (next instanceof Node && (gameItem.contains(next) || submenu.contains(next))) return;
      previewed = false;
      if (submenu.matches(":popover-open")) submenu.hidePopover();
    };

    const onFocusOut = (event: FocusEvent) => {
      if (!header.classList.contains("is-wide")) return;
      const next = event.relatedTarget;
      if (!(next instanceof Node) || gameItem.contains(next) || submenu.contains(next)) return;
      previewed = false;
      if (submenu.matches(":popover-open")) submenu.hidePopover();
    };

    const onSubmenuClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest("a")) return;
      previewed = false;
      if (submenu.hasAttribute("popover")) {
        if (submenu.matches(":popover-open")) submenu.hidePopover();
      } else {
        submenu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }
    };

    const observer = new ResizeObserver(onResize);
    observer.observe(header);
    observer.observe(menu);
    sync();

    const button = header.querySelector<HTMLButtonElement>(".menu-button");
    const onMenuToggle = () => {
      if (popoverOk || header.classList.contains("is-wide")) return;
      const open = menu.classList.toggle("is-open");
      button?.setAttribute("aria-expanded", open ? "true" : "false");
    };
    button?.addEventListener("click", onMenuToggle);
    submenu.addEventListener("toggle", onToggle);
    trigger.addEventListener("click", onTriggerClick);
    gameItem.addEventListener("pointerenter", onPointerEnter);
    gameItem.addEventListener("pointerleave", onPointerLeave);
    gameItem.addEventListener("focusout", onFocusOut);
    submenu.addEventListener("click", onSubmenuClick);

    return () => {
      observer.disconnect();
      button?.removeEventListener("click", onMenuToggle);
      submenu.removeEventListener("toggle", onToggle);
      trigger.removeEventListener("click", onTriggerClick);
      gameItem.removeEventListener("pointerenter", onPointerEnter);
      gameItem.removeEventListener("pointerleave", onPointerLeave);
      gameItem.removeEventListener("focusout", onFocusOut);
      submenu.removeEventListener("click", onSubmenuClick);
    };
  }, []);

  return (
    <header className="site-header" ref={headerRef}>
      <div className="header-inner" ref={innerRef}>
        <a className="site-logo" href="/">
          Sugar Scratchie
        </a>
        <nav className="site-nav" aria-label="Primary">
          <button
            className="menu-button"
            type="button"
            popoverTarget="site-menu"
            popoverTargetAction="toggle"
            aria-controls="site-menu"
          >
            <Menu aria-hidden="true" size={16} strokeWidth={2.25} />
            <span>Menu</span>
          </button>
          <ul id="site-menu" className="site-menu" popover="auto" ref={menuRef}>
            {LINKS.map((link) => (
              <li key={link.href}>
                <a href={link.href} aria-current={active === link.href ? "page" : undefined}>
                  {link.label}
                </a>
              </li>
            ))}
            <li className="nav-dropdown" ref={gameItemRef}>
              <button
                ref={gameTriggerRef}
                className="dropdown-trigger"
                type="button"
                aria-expanded="false"
                aria-controls="game-menu"
                popoverTarget="game-menu"
              >
                Game
                <ChevronDown aria-hidden="true" size={14} strokeWidth={2.25} />
              </button>
              <ul
                id="game-menu"
                className={`dropdown-list${gameSectionActive ? " has-current" : ""}`}
                ref={gameMenuRef}
              >
                {GAME_LINKS.map((link) => (
                  <li key={link.href}>
                    <a href={link.href} aria-current={active === link.href ? "page" : undefined}>
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </li>
          </ul>
        </nav>
        <button className="site-signout" type="button" onClick={signOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}
