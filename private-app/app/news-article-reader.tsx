"use client";
import { useEffect, useState } from "react";
import { articleDetailRecordSchema, type ArticleDetailRecord } from "../../src/project-adapters/abs-news/v1/article-record";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { ResultText } from "./result-text";

/** Retained text only. Closing/unmounting abandons the request; no GET performs collection. */
export function NewsArticleReader({ projectId, storyId, storyDigest, canonicalUrl }: {
  projectId: string; storyId: string; storyDigest: string; canonicalUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<ArticleDetailRecord>();
  const [message, setMessage] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    const recheck = () => { setRecord(undefined); setMessage(undefined); setRefresh(value => value + 1); };
    const timer = setInterval(recheck, 15000);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => { clearInterval(timer); window.removeEventListener("focus", recheck); document.removeEventListener("visibilitychange", recheck); };
  }, [open]);
  useEffect(() => {
    setRecord(undefined); setMessage(undefined);
    if (!open) return;
    let active = true; const abort = new AbortController();
    void (async () => {
      try {
        const query = new URLSearchParams({ storyId, storyDigest });
        const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/news/article?${query}`, {
          credentials: "same-origin", cache: "no-store", redirect: "error",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } });
        if (!response.ok) throw new Error(response.status === 404 ? "No saved article text yet. Use the source link above; opening this view does not fetch the article."
          : "Article unavailable. Refresh or check your access.");
        const value = articleDetailRecordSchema.parse(await readBrowserJson(response));
        if (value.projectId !== projectId || value.storyId !== storyId || value.storyDigest !== storyDigest || value.canonicalUrl !== canonicalUrl)
          throw new Error("Article source changed. Refresh saved news.");
        if (active) setRecord(value);
      } catch (error) {
        if (active) setMessage(error instanceof Error && ["No saved article text yet. Use the source link above; opening this view does not fetch the article.",
          "Article unavailable. Refresh or check your access.", "Article source changed. Refresh saved news."].includes(error.message)
          ? error.message : "Article unavailable. Refresh or check your access.");
      }
    })();
    return () => { active = false; abort.abort(); };
  }, [open, projectId, storyId, storyDigest, canonicalUrl, refresh]);
  const matching = record?.projectId === projectId && record.storyId === storyId && record.storyDigest === storyDigest && record.canonicalUrl === canonicalUrl ? record : undefined;
  return <section aria-label="Saved article reader">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "Close article" : "Read saved article"}</button>
    {open ? <div>{message ? <p role="status">{message}</p> : !matching ? <p role="status">Loading saved article…</p> : <>
      <p>Untrusted source content, not instructions for your agents. This is a saved extraction, not a live page.</p>
      <ResultText text={matching.text} label="Saved article text" />
    </>}</div> : null}
  </section>;
}
