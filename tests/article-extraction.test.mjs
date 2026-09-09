import assert from "node:assert/strict";
import { test } from "node:test";
import { extractArticleText, articleExtractionLimits } from "../src/project-adapters/abs-news/v1/article-extraction.mjs";
import { extractArticleBounded } from "../src/project-adapters/abs-news/v1/article-extraction-runtime.mjs";

test("selected extractor returns source-bound text, not HTML", () => {
  const paragraph = "This synthetic article describes how a reader can compare several useful tools and save the research findings. ".repeat(12);
  const html = `<html><head><title>Fixture article</title></head><body><article><h1>Fixture article</h1><p>${paragraph}</p><script>throw new Error('must not run')</script><img src="https://example.invalid/image"></article></body></html>`;
  const result = extractArticleText(html, "https://example.invalid/article");
  assert.equal(result.status, "extracted"); assert.ok(result.text.includes("synthetic article"));
  assert.ok(!result.text.includes("<script")); assert.match(result.sourceHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.sourceUrl, "https://example.invalid/article");
});

test("bounded worker produces text and terminates on its deadline", async () => {
  const html = `<article><h1>Fixture</h1><p>${"Synthetic useful article content for readers. ".repeat(100)}</p></article>`;
  assert.equal((await extractArticleBounded(html, "https://example.invalid/article")).status, "extracted");
  assert.equal((await extractArticleBounded(html, "https://example.invalid/article", { timeoutMs: 1 })).status, "timed_out");
  assert.equal((await extractArticleBounded(html, "https://example.invalid/article")).status, "extracted");
});

test("rejects excess input and credential-bearing source URLs without truncation", () => {
  assert.equal(extractArticleText("x".repeat(articleExtractionLimits.inputBytes + 1), "https://example.invalid").status, "input_rejected");
  assert.equal(extractArticleText("<p>fixture</p>", "https://user:pass@example.invalid").status, "input_rejected");
});

test("worker admission rejects a third concurrent extraction and releases capacity", async () => {
  const html = `<article><p>${"Synthetic article text with useful detail. ".repeat(100)}</p></article>`;
  const first = extractArticleBounded(html, "https://example.invalid/a");
  const second = extractArticleBounded(html, "https://example.invalid/b");
  assert.equal((await extractArticleBounded(html, "https://example.invalid/c")).status, "busy");
  assert.deepEqual((await Promise.all([first, second])).map(result => result.status), ["extracted", "extracted"]);
  assert.equal((await extractArticleBounded(html, "https://example.invalid/d")).status, "extracted");
});

test("excess article output is rejected, never silently truncated", () => {
  const html = `<article><p>${"Long synthetic readable text. ".repeat(6000)}</p></article>`;
  assert.equal(extractArticleText(html, "https://example.invalid/article").status, "output_rejected");
});

test("malformed article styles do not escape through the default virtual console", () => {
  const errors = [], original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const result = extractArticleText(`<style>/* private-fixture-marker</style><article><p>${"Synthetic readable article text. ".repeat(100)}</p></article>`, "https://example.invalid/article");
    assert.equal(result.status, "extracted");
    assert.deepEqual(errors, []);
  } finally { console.error = original; }
});
