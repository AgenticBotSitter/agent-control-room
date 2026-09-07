"use client";
import { useEffect, useState } from "react";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { newsPageSchema, type NewsPage } from "../../src/web/v1/news-wire";
import { PrivateHeader } from "./private-header";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import { NewsResearchForm } from "./news-research-form";

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

export function PrivateNewsWorkspace({ projectId, after, sourceAfter }: { projectId: string; after?: string; sourceAfter?: string }) {
  const [page, setPage] = useState<NewsPage>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<NewsPage["stories"][number]>();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    const load = async () => {
      try {
        const query = new URLSearchParams({ ...(after ? { after } : {}), ...(sourceAfter ? { sourceAfter } : {}) });
        const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/news${query.size ? `?${query}` : ""}`,
          { credentials: "same-origin", cache: "no-store", redirect: "error",
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]), headers: { accept: "application/json" } });
        if (!response.ok) throw new BrowserRequestError(response.status === 401 ? "authentication_required"
          : response.status === 403 ? "access_denied" : "unavailable");
        const result = newsPageSchema.parse(await readBrowserJson(response));
        if (result.project.projectId !== projectId || result.stories.some((s, i) => after !== undefined && s.storyId <= after
          || i > 0 && s.storyId <= result.stories[i - 1].storyId)
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
  }, [projectId, after, sourceAfter, refresh]);
  return <><PrivateHeader /><main className="private-main">
    <h1>{page ? `${page.project.title} · News` : "Project news"}</h1>
    <nav aria-label="Project pages"><a href={base}>Overview</a>{" · "}<a href={`${base}/tasks`}>Tasks</a>{" · "}<a href={`${base}/news`} aria-current="page">News</a></nav>
    <button type="button" disabled={!!selected} onClick={() => { setPage(undefined); setError(undefined); setRefresh(v => v + 1); }}>Refresh saved news</button>
    {selected ? <NewsResearchForm projectId={projectId} story={selected} close={() => setSelected(undefined)} /> : null}
    {error ? <p role="alert">{error}</p> : !page ? <p role="status">Loading saved news…</p> : page.availability === "not_configured"
      ? <p role="status">News storage is not configured for this installation. No sample stories are shown.</p>
      : <><p>Saved sources, not an assertion that every claim is correct.</p>
        <NewsSourceHealth sources={page.sources} />
        {page.sourcesNextCursor ? <a href={`${base}/news?${new URLSearchParams({ ...(after ? { after } : {}), sourceAfter: page.sourcesNextCursor })}`}>Next source checks</a> : null}
        {!page.stories.length ? <p>No saved stories on this page.</p> : page.stories.map(story => <article className="private-panel" key={story.storyId}>
          <h2><a href={story.canonicalUrl} target="_blank" rel="noopener noreferrer">{story.title}</a></h2>
          <p>{story.summary}</p><p>{story.verificationState === "verified" ? "Source evidence retained" : "Source needs review"} · {story.queue.replaceAll("_", " ")}</p>
          <button type="button" disabled={!!selected || !page.canPrepare || story.verificationState !== "verified"}
            onClick={() => setSelected(story)}>Research or write a setup guide</button>
        </article>)}
        {page.nextCursor ? <a href={`${base}/news?${new URLSearchParams({ after: page.nextCursor, ...(sourceAfter ? { sourceAfter } : {}) })}`}>Next saved stories</a> : null}
      </>}
  </main></>;
}
