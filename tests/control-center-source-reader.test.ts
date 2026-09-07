import test from "node:test";
import assert from "node:assert/strict";
import { createIndustrySourceReader } from "../src/vendor/control-center/source-reader";

const source = { id: "source:test", name: "Example", url: "https://example.org/" };
const now = Date.parse("2026-09-07T12:00:00Z");
const rss = (items: string) => `<rss><channel><title>Example</title>${items}</channel></rss>`;
const entry = (slug: string) => `<item><title>${slug}</title><link>https://example.org/${slug}</link></item>`;

test("upstream whole source flow discovers an HTML feed and preserves undated baselines", async () => {
  let contents = rss(entry("old"));
  const calls: string[] = [];
  const ports = { now: () => now, async readText(url: string) {
    calls.push(url);
    if (url === source.url) return { text: '<link rel="alternate" type="application/rss+xml" href="/updates.xml">', finalUrl: url };
    if (url.endsWith("/updates.xml")) return { text: contents, finalUrl: url };
    throw new Error("fixture unavailable");
  } };
  const reader = createIndustrySourceReader(ports);
  ports.readText = async () => { throw new Error("mutated port"); };
  const first = await reader.readSource(source);
  assert.equal(first.status.mode, "feed"); assert.equal(first.status.state, "baseline");
  assert.deepEqual(first.items, []); assert.ok(first.snapshot);
  contents = rss(entry("old") + entry("new"));
  const next = await reader.readSource(source, first.snapshot);
  assert.deepEqual(next.items.map(item => item.title), ["new"]);
  assert.equal(next.items[0].discoveredAt, new Date(now).toISOString());
  assert.equal(next.status.state, "changed");
  assert.ok(calls.includes("https://example.org/updates.xml"));
});

test("upstream source flow falls back to robots sitemap and emits only new pages", async () => {
  let pages = ["old"];
  const reader = createIndustrySourceReader({ now: () => now, async readText(url) {
    if (url.endsWith("/robots.txt")) return { text: "Sitemap: https://example.org/posts.xml", finalUrl: url };
    if (url.endsWith("/posts.xml")) return { text: `<urlset>${pages.map(p => `<url><loc>https://example.org/${p}</loc></url>`).join("")}</urlset>`, finalUrl: url };
    throw new Error("fixture unavailable");
  } });
  const first = await reader.readSource(source);
  assert.equal(first.status.mode, "sitemap"); assert.equal(first.status.state, "baseline");
  assert.deepEqual(first.items, []);
  pages = ["old", "new"];
  const next = await reader.readSource(source, first.snapshot);
  assert.equal(next.status.state, "changed"); assert.deepEqual(next.items.map(item => item.url), ["https://example.org/new"]);
});

test("source construction does no I/O and total source failure is not an empty success", async () => {
  let reads = 0;
  const reader = createIndustrySourceReader({ async readText() { reads++; throw new Error("fixture unavailable"); } });
  assert.equal(reads, 0);
  await assert.rejects(reader.readSource(source), /No readable RSS/);
  assert.ok(reads > 0);
});
