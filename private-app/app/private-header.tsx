"use client";

import { useEffect, useRef, useState } from "react";
import { OwnerWebPushSettings } from "./owner-web-push";
import { useProductDisplayName, useProductModule } from "./product-configuration";
import { useLocalRuntime } from "./local-runtime";
import { useSharedTaskAttention, refreshSharedTaskAttention } from "./shared-task-attention";
import { headerPageRegistry, isPageRegistryEntryVisible } from "./page-registry";

function isCurrent(pathname: string | undefined, href: string) {
  return href === "/" ? pathname === href : pathname === href || pathname?.startsWith(`${href}/`);
}

export function PrivateHeader() {
  const runtime = useLocalRuntime();
  const attention = useSharedTaskAttention(runtime.mode !== "checking");
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
    {/* The banner is above EVERY page's content, so its height is subtracted from
        the first screen of every route. At phone width only the first question
        paints (`private.css`): three wrapped questions put the page's first
        status below the fold. Nothing is hidden without a way to it -- the badge
        above carries the real count, and this box's own "Needs attention" link
        goes to /needs-me, where the whole list lives. */}
    <section className={`private-panel private-attention-box private-shared-attention${attention.state === "ready" && attention.value.items.length ? " has-items" : ""}`} aria-label="Needs attention">
      <a href="/needs-me"><strong>Needs attention</strong>{attention.state === "ready"
        ? <span className="private-nav-badge">{attention.value.items.length}{!attention.value.complete ? "+" : ""}
          <span className="private-sr-only"> needing you</span></span> : null}</a>
      {attention.state === "loading" ? <p role="status">Checking saved attention…</p>
        : attention.state === "unavailable" ? <><p role="alert">Attention could not be checked. No all-clear is assumed.</p>
          <button type="button" onClick={() => void refreshSharedTaskAttention()}>Read attention again</button></>
          : attention.value.items.length ? <ul>{attention.value.items.slice(0, 3).map((item, index) => <li key={item.key}
              className={index === 0 ? "private-shared-attention-lead" : "private-shared-attention-extra"}>
            <strong>{item.title}</strong> <a href={item.href ?? "/needs-me"}>{item.href ? item.actionLabel : "Open Action Inbox"}</a>
          </li>)}</ul> : attention.value.complete ? <p>All clear.</p> : null}
      {attention.state === "ready" && attention.value.checking ? <p role="status">Checking saved attention…</p>
        : attention.state === "ready" && !attention.value.complete ? <p role="alert">Some attention could not be checked completely. Open Action Inbox; no all-clear is assumed.</p> : null}
      {runtime.mode === "local" ? <OwnerWebPushSettings attentionOnly /> : null}
    </section>
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
      </a>;
      })}
      {/* Sign out is an account action, not the `/session` page. Keep the
          established Mac-local action without making that page navigable. */}
      {runtime.mode !== "hosted" ? <a href="/sign-out" aria-current={isCurrent(pathname, "/sign-out") ? "page" : undefined}>Sign out</a> : null}
    </nav>
  </header>;
}
