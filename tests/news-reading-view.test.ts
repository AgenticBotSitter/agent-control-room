import test from "node:test";
import assert from "node:assert/strict";
import { newsReadingView } from "../src/web/v1/news-reading-view";
import type { NewsPage } from "../src/web/v1/news-wire";

const at = "2026-09-07T12:00:00.000Z";
const story = (id: string, changes: Partial<NewsPage["stories"][number]> = {}): NewsPage["stories"][number] => ({
  storyId: `story:${id}`, storyDigest: `sha256:${"a".repeat(64)}`, title: id, summary: "Saved article",
  canonicalUrl: `https://example.org/${id}`, queue: "earlier", verificationState: "review_only",
  discoveredAt: at, sourceLabel: "Example", priorityScore: 40, ...changes,
});
test("upstream reading flow sorts without changing evidence and excludes archive from recent", () => {
  const low = story("low"), high = story("high", { priorityScore: 90 }), archived = story("archived", { queue: "archive" });
  const old = story("old", { publishedAt: "2026-08-01T12:00:00.000Z" });
  const rows = [low, high, archived, old], snapshot = structuredClone(rows);
  const recent = newsReadingView(rows, "fresh", "important", at);
  assert.deepEqual(recent.counts, { fresh: 2, history: 3, archive: 1 });
  assert.deepEqual(recent.stories, [high, low]); assert.equal(recent.stories[0], high);
  assert.deepEqual(newsReadingView(rows, "archive", "newest", at).stories, [archived]);
  assert.equal(newsReadingView(rows, "history", "oldest", at).stories[0], old);
  assert.deepEqual(rows, snapshot);
});
test("legacy missing dates are history only, discovery dates support undated pages, dates beyond upstream future tolerance stay out", () => {
  const undated = story("undated", { discoveredAt: undefined });
  const fresh = story("new-page"), future = story("future", { publishedAt: "2026-10-01T12:00:00.000Z" });
  assert.deepEqual(newsReadingView([undated, fresh, future], "fresh", "newest", at).stories, [fresh]);
  assert.equal(newsReadingView([undated, fresh, future], "history", "newest", at).stories.length, 3);
});
