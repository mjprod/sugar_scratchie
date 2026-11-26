import { Menu } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { operatorLogout } from "./shared/api";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/dashboard/models", label: "Models" },
  { href: "/dashboard/packs", label: "Packs" },
  { href: "/dashboard/themes", label: "Themes" },
  { href: "/dashboard/seasons", label: "Seasons" },
  { href: "/dashboard/users", label: "Users" },
  { href: "/symbols", label: "Symbols" },
  { href: "/dashboard/ai-models", label: "AI models" },
  { href: "/dashboard/video-flow", label: "Video" },
  { href: "/game", label: "Game" },
  { href: "/dashboard", label: "Dashboard" },
] as const;

function currentHref(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "/";
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
  if (path === "/dashboard") return "/dashboard";
  const match = LINKS.find(
    (link) => link.href !== "/" && link.href !== "/dashboard" && (path === link.href || path.startsWith(`${link.href}/`)),
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
  const active = currentHref(window.location.pathname);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const inner = innerRef.current;
    const menu = menuRef.current;
    if (!header || !inner || !menu) return;

    const popoverOk = Object.hasOwn(HTMLElement.prototype, "popover");
    let lastWidth = 0;

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
      lastWidth = header.clientWidth;
      requestAnimationFrame(() => header.classList.remove("is-measuring"));
    };

    const onResize = () => {
      const wide = header.classList.contains("is-wide");
      const width = header.clientWidth;
      if (!wide && width <= lastWidth) return;
      sync();
    };

    const observer = new ResizeObserver(onResize);
    observer.observe(header);
    observer.observe(menu);
    sync();

    const button = header.querySelector<HTMLButtonElement>(".menu-button");
    const onToggle = () => {
      if (popoverOk || header.classList.contains("is-wide")) return;
      const open = menu.classList.toggle("is-open");
      button?.setAttribute("aria-expanded", open ? "true" : "false");
    };
    button?.addEventListener("click", onToggle);

    return () => {
      observer.disconnect();
      button?.removeEventListener("click", onToggle);
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
          </ul>
        </nav>
        <button className="site-signout" type="button" onClick={signOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}
