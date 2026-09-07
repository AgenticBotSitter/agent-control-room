"use client";
import { useEffect, useState } from "react";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { newsPageSchema, type NewsPage } from "../../src/web/v1/news-wire";
import { PrivateHeader } from "./private-header";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import { NewsResearchForm } from "./news-research-form";

export function PrivateNewsWorkspace({ projectId, after }: { projectId: string; after?: string }) {
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
        const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/news${after ? `?after=${encodeURIComponent(after)}` : ""}`,
          { credentials: "same-origin", cache: "no-store", redirect: "error",
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]), headers: { accept: "application/json" } });
        if (!response.ok) throw new BrowserRequestError(response.status === 401 ? "authentication_required"
          : response.status === 403 ? "access_denied" : "unavailable");
        const result = newsPageSchema.parse(await readBrowserJson(response));
        if (result.project.projectId !== projectId || result.stories.some((s, i) => after !== undefined && s.storyId <= after
          || i > 0 && s.storyId <= result.stories[i - 1].storyId)
          || result.nextCursor !== null && (result.stories.length !== 50 || result.nextCursor !== result.stories.at(-1)?.storyId)) throw new Error();
        if (active) { setPage(result); setError(undefined); }
      } catch (reason) {
        if (active) { setPage(undefined); setError(reason instanceof BrowserRequestError ? browserErrorMessage[reason.code]
          : "Saved news is unavailable. Refresh or check your access."); }
      }
    };
    void load();
    return () => { active = false; abort.abort(); };
  }, [projectId, after, refresh]);
  return <><PrivateHeader /><main className="private-main">
    <h1>{page ? `${page.project.title} · News` : "Project news"}</h1>
    <nav aria-label="Project pages"><a href={base}>Overview</a>{" · "}<a href={`${base}/tasks`}>Tasks</a>{" · "}<a href={`${base}/news`} aria-current="page">News</a></nav>
    <button type="button" disabled={!!selected} onClick={() => { setPage(undefined); setError(undefined); setRefresh(v => v + 1); }}>Refresh saved news</button>
    {selected ? <NewsResearchForm projectId={projectId} story={selected} close={() => setSelected(undefined)} /> : null}
    {error ? <p role="alert">{error}</p> : !page ? <p role="status">Loading saved news…</p> : page.availability === "not_configured"
      ? <p role="status">News storage is not configured for this installation. No sample stories are shown.</p>
      : <><p>Saved sources, not an assertion that every claim is correct. Collection freshness is not yet connected.</p>
        {!page.stories.length ? <p>No saved stories on this page.</p> : page.stories.map(story => <article className="private-panel" key={story.storyId}>
          <h2><a href={story.canonicalUrl} target="_blank" rel="noopener noreferrer">{story.title}</a></h2>
          <p>{story.summary}</p><p>{story.verificationState === "verified" ? "Source evidence retained" : "Source needs review"} · {story.queue.replaceAll("_", " ")}</p>
          <button type="button" disabled={!!selected || !page.canPrepare || story.verificationState !== "verified"}
            onClick={() => setSelected(story)}>Research or write a setup guide</button>
        </article>)}
        {page.nextCursor ? <a href={`${base}/news?after=${encodeURIComponent(page.nextCursor)}`}>Next saved stories</a> : null}
      </>}
  </main></>;
}
