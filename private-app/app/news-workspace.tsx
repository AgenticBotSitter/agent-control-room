"use client";
import { useEffect, useRef, useState } from "react";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { newsPageSchema, type NewsPage } from "../../src/web/v1/news-wire";
import { PrivateHeader } from "./private-header";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import { NewsResearchForm } from "./news-research-form";
import { newsReadingView, type NewsReadingView } from "../../src/web/v1/news-reading-view";
import type { IndustrySortOrder } from "../../src/vendor/control-center/industry";
import { NewsDailySnapshot } from "./news-daily-snapshot";
import { NewsSourceSettings } from "./news-source-settings";
import { createNewsArchiveClient } from "../../src/web/v1/news-archive-client";
import { installNewsNavigationGuard } from "../../src/web/v1/news-navigation-guard";

export function NewsSourceHealth({ sources }: { sources: NewsPage["sources"] }) {
  const labels = { available: "Last check succeeded", partial: "Last check was incomplete", stale: "Needs a fresh check", unavailable: "Last check failed", disabled: "Disabled" };
  return <details><summary>Source checks ({sources.length} on this page)</summary>
    <p>Saved check results, not a live connection test. Refreshing this page does not fetch news.</p>
    {!sources.length ? <p>No saved source checks on this page.</p> : sources.map(source => <article className="private-panel" key={source.sourceId}>
      <h3>{source.label}</h3><p>{source.mode === "synthetic" ? "Test data · " : ""}{labels[source.state]}</p>
      <p>Checked: <time dateTime={source.checkedAt}>{source.checkedAt}</time></p>
      <p>Last successful check: {source.lastSuccessfulAt ? <time dateTime={source.lastSuccessfulAt}>{source.lastSuccessfulAt}</time> : "Not recorded"}</p>
      <p>{source.itemCount !== undefined ? `${source.itemCount} articles in that check` : "Article count unknown"}</p>
    </article>)}
  </details>;
}

export function PrivateNewsWorkspace({ projectId, after, sourceAfter, view = "history", order = "important" }: { projectId: string; after?: string; sourceAfter?: string; view?: NewsReadingView; order?: Exclude<IndustrySortOrder, "watched"> }) {
  const [page, setPage] = useState<NewsPage>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<NewsPage["stories"][number]>();
  const [archiveClient] = useState(() => createNewsArchiveClient(projectId));
  const [archiveHeld, setArchiveHeld] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveMessage, setArchiveMessage] = useState<string>();
  const archiveLock = useRef(false);
  useEffect(() => installNewsNavigationGuard(window, document,
    () => archiveLock.current || archiveClient.hasPending(),
    () => setArchiveMessage("Finish the pending Archive or Restore change before leaving this page.")), [archiveClient]);
  async function changeArchive(story?: NewsPage["stories"][number]) {
    if (archiveLock.current || story && (archiveClient.hasPending() || !page?.canArchive || selected)) return;
    archiveLock.current = true; setArchiveBusy(true); setArchiveHeld(true); setArchiveMessage(undefined);
    try {
      const receipt = story ? await archiveClient.save({ storyId: story.storyId, archived: story.queue !== "archive",
        expectedRevision: story.archiveRevision ?? 0 }) : await archiveClient.retry();
      setArchiveMessage(receipt.record.archived ? "Article archived." : "Article restored to History.");
      // Reload server-ranked pages rather than pretending a local list edit can
      // fill the gap or recompute its whole-library pagination cursor.
      setRefresh(value => value + 1);
    } catch (reason) {
      setArchiveMessage(reason instanceof Error ? reason.message : "Could not confirm the archive change.");
    } finally {
      archiveLock.current = false; setArchiveBusy(false); setArchiveHeld(archiveClient.hasPending());
    }
  }
  const reading = page ? newsReadingView(page.stories, view, order, page.observedAt) : undefined;
  const brief = page ? newsReadingView(page.stories, "fresh", "important", page.observedAt) : undefined;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const setView = (value: NewsReadingView) => {
    if (archiveLock.current || archiveClient.hasPending()) return;
    window.location.assign(`${base}/news?${new URLSearchParams({ view: value, order })}`);
  };
  const setOrder = (value: string) => window.location.assign(`${base}/news?${new URLSearchParams({ view, order: value })}`);
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    const load = async () => {
      try {
        const query = new URLSearchParams({ view, order, ...(after ? { after } : {}), ...(sourceAfter ? { sourceAfter } : {}) });
        const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/news${query.size ? `?${query}` : ""}`,
          { credentials: "same-origin", cache: "no-store", redirect: "error",
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]), headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" } });
        if (!response.ok) throw new BrowserRequestError(response.status === 401 ? "authentication_required"
          : response.status === 403 ? "access_denied" : "unavailable");
        const result = newsPageSchema.parse(await readBrowserJson(response));
        if (result.project.projectId !== projectId || new Set(result.stories.map(story => story.storyId)).size !== result.stories.length
          || result.stories.some(story => story.storyId === after)
          || result.nextCursor !== null && (result.stories.length !== 50 || result.nextCursor !== result.stories.at(-1)?.storyId)
          || result.sources.some((s, i) => sourceAfter !== undefined && s.sourceId <= sourceAfter || i > 0 && s.sourceId <= result.sources[i - 1].sourceId)
          || result.sourcesNextCursor !== null && (result.sources.length !== 50 || result.sourcesNextCursor !== result.sources.at(-1)?.sourceId)) throw new Error();
        if (active) { setPage(result); setError(undefined); }
      } catch (reason) {
        if (active) { setPage(undefined); setError(reason instanceof BrowserRequestError ? browserErrorMessage[reason.code]
          : "Saved news is unavailable. Refresh or check your access."); }
      }
    };
    void load();
    return () => { active = false; abort.abort(); };
  }, [projectId, after, sourceAfter, view, order, refresh]);
  return <><PrivateHeader /><main id="private-main" className="private-main">
    <h1>{page ? `${page.project.title} · News` : "Project news"}</h1>
    <nav aria-label="Project pages"><a href={base}>Overview</a>{" · "}<a href={`${base}/tasks`}>Tasks</a>{" · "}<a href={`${base}/news`} aria-current="page">News</a></nav>
    <NewsSourceSettings key={projectId} projectId={projectId} />
    <button type="button" disabled={!!selected || archiveHeld} onClick={() => { setPage(undefined); setError(undefined); setRefresh(v => v + 1); }}>Refresh saved news</button>
    {archiveMessage ? <p role="status">{archiveMessage}</p> : null}
    {archiveHeld ? <p>{archiveBusy ? "Saving article location…" : "The earlier change is not yet confirmed."}{" "}
      <button type="button" disabled={archiveBusy} onClick={() => void changeArchive()}>Retry exact archive change</button></p> : null}
    {selected ? <NewsResearchForm projectId={projectId} story={selected} close={() => setSelected(undefined)} /> : null}
    {error ? <p role="alert">{error}</p> : !page ? <p role="status">Loading saved news…</p> : page.availability === "not_configured"
      ? <p role="status">News storage is not configured for this installation. No sample stories are shown.</p>
      : <><p>Saved sources, not an assertion that every claim is correct.</p>
        <NewsSourceHealth sources={page.sources} />
        <NewsDailySnapshot items={brief!.stories.slice(0, 5)} availableCount={brief!.counts.fresh} onOpen={() => setView("fresh")} />
        <nav aria-label="Saved news views">{(["fresh", "history", "archive"] as const).map(value =>
          <button key={value} type="button" disabled={archiveHeld} aria-pressed={view === value} onClick={() => setView(value)}>
            {value === "fresh" ? "Recent (24 hours)" : value === "history" ? "History" : "Archive"}
          </button>)}</nav>
        <label>Sort saved library<select disabled={archiveHeld} value={order} onChange={event => setOrder(event.target.value)}>
          <option value="important">Most important</option><option value="newest">Newest</option><option value="oldest">Oldest</option>
        </select></label>
        <p>View and sorting apply across the saved library. The daily snapshot summarizes this page. Use “Next saved stories” for more.</p>
        {after ? <a href={`${base}/news?${new URLSearchParams({ view, order, ...(sourceAfter ? { sourceAfter } : {}) })}`}>First saved stories</a> : null}
        {page.sourcesNextCursor ? <a href={`${base}/news?${new URLSearchParams({ view, order, ...(after ? { after } : {}), sourceAfter: page.sourcesNextCursor })}`}>Next source checks</a> : null}
        {!reading!.stories.length ? <p>No saved stories in this view on this page.</p> : reading!.stories.map(story => <article className="private-panel" key={story.storyId}>
          <h2><a href={story.canonicalUrl} target="_blank" rel="noopener noreferrer">{story.title}</a></h2>
          <p>{story.summary}</p><p>{story.verificationState === "verified" ? "Source evidence retained" : "Source needs review"} · {story.queue.replaceAll("_", " ")}</p>
          <p>{story.sourceLabel ?? new URL(story.canonicalUrl).hostname}{story.publishedAt ? ` · Published ${story.publishedAt}` : story.discoveredAt ? ` · Discovered ${story.discoveredAt}` : " · Date unknown"}</p>
          <button type="button" disabled={!!selected || archiveHeld || !page.canPrepare}
            onClick={() => setSelected(story)}>{story.verificationState === "review_only" ? "Research and verify" : "Research, compare or draft"}</button>
          <button type="button" disabled={!!selected || archiveHeld || !page.canArchive}
            onClick={() => void changeArchive(story)}>{story.queue === "archive" ? "Restore to History" : "Archive article"}</button>
        </article>)}
        {page.nextCursor ? <a href={`${base}/news?${new URLSearchParams({ view, order, after: page.nextCursor, ...(sourceAfter ? { sourceAfter } : {}) })}`}>Next saved stories</a> : null}
      </>}
  </main></>;
}
