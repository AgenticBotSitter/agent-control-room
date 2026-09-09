import assert from "node:assert/strict";
import { test } from "node:test";
import { extractArticleBounded } from "../dist-vps/server/articleExtraction.js";

test("compiled article worker loads from the build and returns bounded text", async () => {
  const result = await extractArticleBounded(`<article><p>${"Synthetic built worker article content. ".repeat(100)}</p></article>`, "https://example.invalid/article");
  assert.equal(result.status, "extracted"); assert.match(result.text, /Synthetic built worker/);
  assert.equal((await extractArticleBounded("<article>Fixture</article>", "https://example.invalid/article", { timeoutMs: 1 })).status, "timed_out");
  const stop = new AbortController();
  const cancelled = extractArticleBounded("<article>Fixture</article>", "https://example.invalid/article", { signal: stop.signal });
  stop.abort(); assert.equal((await cancelled).status, "cancelled");
});
