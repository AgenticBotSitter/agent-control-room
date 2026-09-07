"use client";
// Adapted from mreflow/control-center components/daily-snapshot.tsx (MIT).
// Single project-news category; existing theme/classes and text replace icon dependency.
import type { NewsPage } from "../../src/web/v1/news-wire";

export function NewsDailySnapshot({ items, availableCount, onOpen }: {
  items: NewsPage["stories"]; availableCount: number; onOpen: () => void;
}) {
  return <section className="private-panel" aria-label="News daily snapshot">
    <header><h2>News at a glance</h2><p>Top {items.length} · {availableCount} recent articles on this page</p></header>
    {items.length ? <ol>
      {items.map(item => <li key={item.storyId}>
        <div><a href={item.canonicalUrl} target="_blank" rel="noopener noreferrer">{item.title}</a>
          <p>{item.summary}</p><small>{item.sourceLabel ?? new URL(item.canonicalUrl).hostname}</small>
        </div>
      </li>)}
    </ol> : <div><b>Nothing recent on this page</b><p>Older saved stories remain in History. Archived stories stay out of this brief.</p></div>}
    <footer><button type="button" onClick={onOpen}>See recent stories</button></footer>
  </section>;
}
