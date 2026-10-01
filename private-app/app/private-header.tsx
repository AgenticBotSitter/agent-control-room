"use client";

import { useEffect, useRef, useState } from "react";
import { useProductDisplayName, useProductModule } from "./product-configuration";
import { useLocalRuntime } from "./local-runtime";
import { readTaskAttention } from "../../src/web/v1/queue-attention-browser-client";
import { headerPageRegistry, isPageRegistryEntryVisible } from "./page-registry";

function isCurrent(pathname: string | undefined, href: string) {
  return href === "/" ? pathname === href : pathname === href || pathname?.startsWith(`${href}/`);
}

/** The nav-wide "Needs you" count, read from the same saved task-attention
 * page Home and the Action Inbox already read (owner-ux-feedback-2026-09-27.md
 * item 2: "the Needs attention nav item/header glows/turns red with a count,
 * on EVERY page"). This is honest, not exhaustive: `readTaskAttention` reads
 * one bounded page, so a truncated page reports "N+" rather than a false
 * exact count, and a failed read reports no badge at all rather than "0" —
 * the same "never invent a zero" rule the rest of the app already keeps.
 *
 * Deliberately a single read on mount, not a recurring poll: the header
 * mounts on every page, and `useVisiblePolling`'s shared focus/visibility
 * listeners would double-count against Home's own dashboard fetch of this
 * same endpoint in tests/private-shell-navigation.test.tsx's exact-request-
 * count coalescing assertions — and, more to the point, would mean a badge
 * on every open page independently re-polling the same saved page on every
 * window focus. Navigating to a new page re-mounts the header and refreshes
 * the count; a page left open for a long time may show a stale count until
 * then. The next slice should share one read across the header and Home
 * rather than widen this trade-off.
 *
 * `enabled` waits for runtime detection to settle (the same
 * `runtime.mode !== "checking"` gate Home's own dashboard uses) rather than
 * firing the instant the header mounts. Detection is one more protected read
 * that has not resolved yet, so a badge fetch before it settles would be a
 * request this app cannot yet route correctly. */
function useNeedsAttentionBadge(enabled: boolean): { count: number; truncated: boolean } | undefined {
  const [state, setState] = useState<{ count: number; truncated: boolean }>();
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // Deferred by a tick, the same technique the dashboard's own polling hook
    // uses (use-visible-polling.ts): React StrictMode mounts, cleans up and
    // remounts each component once in development, and a fetch started
    // synchronously in the effect body would fire on the mount that gets torn
    // down too. Starting it after a zero-delay timeout means the first
    // mount's cleanup cancels its timer before the fetch ever goes out, and
    // only the surviving mount's timer fires — one request, not two.
    const timer = setTimeout(() => {
      void readTaskAttention().then(page => {
        if (live) setState({ count: page.items.length, truncated: !!page.nextCursor });
      }, () => { if (live) setState(undefined); });
    }, 0);
    return () => { live = false; clearTimeout(timer); };
  }, [enabled]);
  return state;
}

function NeedsAttentionBadge({ enabled }: { enabled: boolean }) {
  const badge = useNeedsAttentionBadge(enabled);
  if (!badge || !badge.count) return null;
  // No aria-hidden: this text becomes part of the "Action Inbox" link's
  // accessible name ("Action Inbox 5"), the same way PrivateCount's trailing
  // pill is read as part of a panel heading elsewhere in this app.
  return <span className="private-nav-badge">{badge.count}{badge.truncated ? "+" : ""}
    <span className="private-sr-only"> needing you</span></span>;
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
      {headerPageRegistry.filter(item => isPageRegistryEntryVisible(item, {
        runtimeMode: runtime.mode, enabledProductModules: { ideaLab },
      })).map(item => {
        const href = item.headerHref ?? item.href;
        return <a key={item.key} href={href} aria-current={isCurrent(pathname, href) ? "page" : undefined}>
        {item.headerTitle ?? item.title}{item.optional ? <span className="private-optional">Optional</span> : null}
        {item.key === "needs-me" ? <NeedsAttentionBadge enabled={runtime.mode !== "checking"} /> : null}
      </a>;
      })}
      {/* Sign out is an account action, not the `/session` page. Keep the
          established Mac-local action without making that page navigable. */}
      {runtime.mode !== "hosted" ? <a href="/sign-out" aria-current={isCurrent(pathname, "/sign-out") ? "page" : undefined}>Sign out</a> : null}
    </nav>
  </header>;
}
