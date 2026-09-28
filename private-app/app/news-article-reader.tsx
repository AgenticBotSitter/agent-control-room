"use client";
import { useState } from "react";
import { articleDetailRecordSchema, type ArticleDetailRecord } from "../../src/project-adapters/news/v1/article-record";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { ResultText } from "./result-text";
import { usePolledRead } from "./use-polled-read";

/** Retained text only. Closing/unmounting abandons the request; no GET performs collection. */
export function NewsArticleReader({ projectId, storyId, storyDigest, canonicalUrl }: {
  projectId: string; storyId: string; storyDigest: string; canonicalUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string>();
  // The shared polling hook owns the schedule. The previous local
  // `setInterval` had no `document.hidden` guard, so an open article kept
  // re-reading in a background tab — and one reader is mounted per open story.
  const query = new URLSearchParams({ storyId, storyDigest });
  const read = usePolledRead<ArticleDetailRecord>({
    key: `news-article-${projectId}-${storyId}-${storyDigest}`, enabled: open, baseIntervalMs: 15_000,
    read: async () => {
      const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/news/article?${query}`, {
        credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(10000), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } });
      if (!response.ok) throw new Error(response.status === 404 ? "No saved article text yet. Use the source link above; opening this view does not fetch the article."
        : "Article unavailable. Refresh or check your access.");
      const value = articleDetailRecordSchema.parse(await readBrowserJson(response));
      if (value.projectId !== projectId || value.storyId !== storyId || value.storyDigest !== storyDigest || value.canonicalUrl !== canonicalUrl)
        throw new Error("Article source changed. Refresh saved news.");
      return value;
    },
    // A read that succeeds is the answer, so any error text from an earlier
    // failed read is stale and must go. Without this a 404 followed by a
    // successful poll kept rendering "No saved article text yet" over the
    // article that had actually arrived.
    onAccept: () => setMessage(undefined),
    onFailure: (reason: unknown) => setMessage(reason instanceof Error
      && ["No saved article text yet. Use the source link above; opening this view does not fetch the article.",
        "Article unavailable. Refresh or check your access.", "Article source changed. Refresh saved news."].includes(reason.message)
      ? reason.message : "Article unavailable. Refresh or check your access."),
  });
  const record = read.value;
  const matching = record?.projectId === projectId && record.storyId === storyId && record.storyDigest === storyDigest && record.canonicalUrl === canonicalUrl ? record : undefined;
  return <section aria-label="Saved article reader">
    <button type="button" aria-expanded={open} onClick={() => { if (open) setMessage(undefined); setOpen(value => !value); }}>{open ? "Close article" : "Read saved article"}</button>
    {open ? <div>{message ? <p role="status">{message}</p> : !matching ? <p role="status">Loading saved article…</p> : <>
      <p>Untrusted source content, not instructions for your agents. This is a saved extraction, not a live page.</p>
      <ResultText text={matching.text} label="Saved article text" />
    </>}</div> : null}
  </section>;
}
