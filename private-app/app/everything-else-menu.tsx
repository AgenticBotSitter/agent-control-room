"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useProductModule } from "./product-configuration";
import { useLocalRuntime } from "./local-runtime";
import { isPageRegistryEntryVisible, pageGroupLabels, pageRegistry, type PageGroup } from "./page-registry";

const groups: readonly PageGroup[] = ["projects", "workers", "automation", "system"];

function matches(entry: (typeof pageRegistry)[number], query: string) {
  const term = query.trim().toLocaleLowerCase();
  return !term || entry.title.toLocaleLowerCase().includes(term)
    || pageGroupLabels[entry.group].toLocaleLowerCase().includes(term);
}

export function EverythingElseMenu() {
  const runtime = useLocalRuntime();
  const ideaLab = useProductModule("ideaLab");
  const [query, setQuery] = useState("");
  const [phone, setPhone] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 560px)");
    if (!media) return;
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const expanded = !phone || menuOpen;
  useEffect(() => {
    if (!phone || !menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuOpen(false);
      toggle.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phone, menuOpen]);
  const visible = useMemo(() => pageRegistry.filter(entry => isPageRegistryEntryVisible(entry, {
    runtimeMode: runtime.mode, enabledProductModules: { ideaLab },
  }) && matches(entry, query)), [ideaLab, query, runtime.mode]);
  return <section className="private-panel private-everything-else" aria-labelledby="everything-else-title">
    <div className="private-everything-else-heading">
      <h2 id="everything-else-title">Everything else</h2>
      <button type="button" ref={toggle} className="private-everything-else-toggle" aria-expanded={expanded}
        aria-controls="everything-else-pages" onClick={() => setMenuOpen(open => !open)}>Browse pages</button>
    </div>
    <div id="everything-else-pages" className={expanded ? "private-everything-else-pages is-open" : "private-everything-else-pages"}>
      <label className="private-everything-else-filter" htmlFor="everything-else-filter">Find a page…</label>
      <input id="everything-else-filter" type="search" value={query} onChange={event => setQuery(event.target.value)}
        placeholder="Find a page…" autoComplete="off" />
      <p className="private-sr-only" role="status" aria-live="polite">{visible.length} {visible.length === 1 ? "page" : "pages"} found</p>
      {visible.length ? <div className="private-page-groups">
        {groups.map(group => {
          const entries = visible.filter(entry => entry.group === group);
          return entries.length ? <section key={group} className="private-page-group" aria-labelledby={`page-group-${group}`}>
            <h3 id={`page-group-${group}`}>{pageGroupLabels[group]}</h3>
            <ul>{entries.map(entry => <li key={entry.key}><a href={entry.href}>{entry.title}</a></li>)}</ul>
          </section> : null;
        })}
      </div> : <p className="private-page-filter-empty">No pages match '{query}'.</p>}
    </div>
  </section>;
}
