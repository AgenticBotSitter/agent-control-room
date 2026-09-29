"use client";

import { useEffect, useRef, useState } from "react";
import { useProductDisplayName, useProductModule } from "./product-configuration";
import { useLocalRuntime } from "./local-runtime";

type NavigationItem = { href: string; label: string; optional?: boolean; localOnly?: boolean };

const navigation: readonly NavigationItem[] = [
  { href: "/", label: "Home" },
  { href: "/projects", label: "Projects" },
  { href: "/workers", label: "Workers" },
  { href: "/session-watch", label: "Session watch" },
  { href: "/setup", label: "Setup" },
  { href: "/workboard", label: "Control Room" },
  { href: "/needs-me", label: "Action Inbox" },
  { href: "/settings", label: "Settings" },
  { href: "/ideas", label: "Idea Lab", optional: true },
  { href: "/sign-out", label: "Sign out", localOnly: true },
];

function isCurrent(pathname: string | undefined, href: string) {
  return href === "/" ? pathname === href : pathname === href || pathname?.startsWith(`${href}/`);
}

export function PrivateHeader() {
  const runtime = useLocalRuntime();
  const displayName = useProductDisplayName();
  const ideaLab = useProductModule("ideaLab");
  const [pathname, setPathname] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => { setPathname(window.location.pathname); }, []);
  // A disclosure is expected to close on Escape, returning focus to the
  // control that opened it. Without this the menu could only be dismissed by
  // re-activating the toggle or by tabbing out of it.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuOpen(false);
      toggle.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [menuOpen]);
  return <header className="private-header">
    <a href="/" className="private-brand">{displayName}</a>
    <span className="private-context">Private workspace</span>
    <button type="button" ref={toggle} className="private-navigation-toggle" aria-expanded={menuOpen}
      aria-controls="private-workspace-navigation" onClick={() => setMenuOpen(open => !open)}>Menu</button>
    {/* `hidden` is not used: the collapsed menu is removed by `display: none`
      at narrow widths only, where the toggle is the visible control. The
      toggle's `aria-expanded` is what conveys the collapsed state. */}
    <nav id="private-workspace-navigation" className={menuOpen ? "private-navigation is-open" : "private-navigation"}
      aria-label="Workspace pages">
      {navigation.filter(item => runtime.mode === "hosted" ? !item.localOnly && (!item.optional || ideaLab)
        : ["/", "/projects", "/workers", "/session-watch", "/needs-me", "/sign-out"].includes(item.href)).map(item => <a key={item.href} href={item.href}
        aria-current={isCurrent(pathname, item.href) ? "page" : undefined}>
        {item.label}{item.optional ? <span className="private-optional">Optional</span> : null}
      </a>)}
    </nav>
  </header>;
}
