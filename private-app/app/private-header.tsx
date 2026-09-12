"use client";

import { useEffect, useState } from "react";

type NavigationItem = { href: string; label: string; optional?: boolean };

const navigation: readonly NavigationItem[] = [
  { href: "/", label: "Home" },
  { href: "/projects", label: "Projects" },
  { href: "/workers", label: "Workers" },
  { href: "/needs-me", label: "Needs attention" },
  { href: "/settings", label: "Settings" },
  { href: "/ideas", label: "Idea Lab", optional: true },
];

function isCurrent(pathname: string | undefined, href: string) {
  return href === "/" ? pathname === href : pathname === href || pathname?.startsWith(`${href}/`);
}

export function PrivateHeader() {
  const [pathname, setPathname] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { setPathname(window.location.pathname); }, []);
  return <header className="private-header">
    <a href="/" className="private-brand">Control Room</a>
    <span className="private-context">Private workspace</span>
    <button type="button" className="private-navigation-toggle" aria-expanded={menuOpen}
      aria-controls="private-workspace-navigation" onClick={() => setMenuOpen(open => !open)}>Menu</button>
    <nav id="private-workspace-navigation" className={menuOpen ? "private-navigation is-open" : "private-navigation"}
      aria-label="Workspace pages">
      {navigation.map(item => <a key={item.href} href={item.href}
        aria-current={isCurrent(pathname, item.href) ? "page" : undefined}>
        {item.label}{item.optional ? <span className="private-optional">Optional</span> : null}
      </a>)}
    </nav>
  </header>;
}
