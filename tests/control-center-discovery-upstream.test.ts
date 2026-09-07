// Adapted test subset from mreflow/control-center at d13e79e866cc33a1fddfe84f563ce2fb9a2113e0.
// Copyright (c) 2026 Matt Wolfe. MIT; see third_party/control-center/LICENSE.
import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { canonicalizeIndustryUrl, curateIndustryDiscoveries, normalizeIndustryTitle,
 selectDiverseIndustryDiscoveries, stableIndustryDiscoveryId, type IndustryDiscoveryLike
} from "../src/vendor/control-center/industry-curation";
import { discoveredFeedLinks, isFeedDocument } from "../src/vendor/control-center/feed-discovery";
import { filterSitemapEntriesForSource, isUrlWithinSourcePath, newSitemapEntries,
 nextSitemapSnapshotUrls, observeUndatedFeedStories, parseFeed, parseSitemap,
 readBoundedResponseText, sitemapCoverageMessage, sourceContentPath, walkSitemap,
 walkSitemapRoots, type SitemapFetcher } from "../src/vendor/control-center/sitemap";
function urlset(entries: Array<{ loc: string; lastmod?: string }>) {
  return `<urlset>${entries.map((entry) => `<url><loc>${entry.loc}</loc>${entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : ""}</url>`).join("")}</urlset>`;
}

function sitemapIndex(urls: string[]) {
  return `<sitemapindex>${urls.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join("")}</sitemapindex>`;
}

test("valid empty feeds remain distinguishable from HTML challenge pages", () => {
  assert.equal(isFeedDocument("<rss><channel><title>Quiet trade journal</title></channel></rss>"), true);
  assert.equal(isFeedDocument("<html><title>Bot check</title></html>"), false);
});

test("feed discovery accepts valid HTML attribute spacing and unquoted URLs", () => {
  const links = discoveredFeedLinks(
    '<link rel="alternate" type = "application/rss+xml" href = /trade/updates.xml>',
    "https://example.com/journal/",
  );
  assert.deepEqual(links, ["https://example.com/trade/updates.xml"]);
});

test("RSS 1.0 RDF items and dc:date are parsed as feed stories", () => {
  const stories = parseFeed(`
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><title>Independent Architecture</title></channel>
      <item rdf:about="https://example.com/journal/passive-house-retrofit">
        <title>Passive house retrofit lessons</title>
        <link>/journal/passive-house-retrofit</link>
        <description>Measured heating demand after one winter.</description>
        <dc:date>2026-08-24T15:30:00Z</dc:date>
      </item>
    </rdf:RDF>
  `, "Fallback", "https://example.com/feed.rdf");

  assert.equal(stories.length, 1);
  assert.equal(stories[0].source, "Independent Architecture");
  assert.equal(stories[0].url, "https://example.com/journal/passive-house-retrofit");
  assert.equal(stories[0].publishedAt, "2026-08-24T15:30:00Z");
  assert.equal(stories[0].kind, "feed");
  assert.match(stories[0].id, /^[a-f0-9]{20}$/);
});

test("feed stories are sorted before the safety cap is applied", () => {
  const items = Array.from({ length: 251 }, (_, index) => `<item><guid>story-${index}</guid><title>Story ${index}</title><link>https://example.com/story-${index}</link><pubDate>${new Date(Date.UTC(2026, 7, 1, 0, index)).toUTCString()}</pubDate></item>`).reverse().join("");
  const stories = parseFeed(`<rss><channel><title>Large feed</title>${items}</channel></rss>`, "Fallback");
  assert.equal(stories.length, 250);
  assert.equal(stories[0].title, "Story 250");
  assert.equal(stories.at(-1)?.title, "Story 1");
});

test("configured content paths scope sitemap URLs while feed endpoints remain unscoped", () => {
  assert.equal(sourceContentPath("https://example.com/journal"), "/journal");
  assert.equal(sourceContentPath("https://example.com/journal/feed.xml"), "");
  assert.equal(isUrlWithinSourcePath("https://www.example.com/journal/story", "https://example.com/journal"), true);
  assert.equal(isUrlWithinSourcePath("https://example.com/jobs/story", "https://example.com/journal"), false);

  const filtered = filterSitemapEntriesForSource([
    { loc: "https://example.com/journal/story", lastmod: "" },
    { loc: "https://example.com/jobs/opening", lastmod: "" },
  ], "https://example.com/journal");
  assert.deepEqual(filtered.map((entry) => entry.loc), ["https://example.com/journal/story"]);
});

test("recursive sitemap walking reads children beyond 30 and nested indexes", async () => {
  const root = "https://example.com/sitemap.xml";
  const childUrls = Array.from({ length: 35 }, (_, index) => `https://example.com/sitemaps/child-${index}.xml`);
  const documents = new Map<string, string>([[root, sitemapIndex(childUrls)]]);
  childUrls.forEach((url, index) => {
    documents.set(url, index === 34
      ? sitemapIndex(["https://example.com/sitemaps/nested.xml"])
      : urlset([{ loc: `https://example.com/journal/story-${index}` }]));
  });
  documents.set("https://example.com/sitemaps/nested.xml", urlset([{ loc: "https://example.com/journal/story-34" }]));
  const fetcher: SitemapFetcher = async (url) => {
    const text = documents.get(url);
    if (!text) throw new Error(`Missing fixture ${url}`);
    return { text, finalUrl: url };
  };

  const result = await walkSitemap(root, fetcher, { concurrency: 4, maxDocuments: 100 });
  assert.equal(result.entries.length, 35);
  assert.equal(result.documentsRead, 37);
  assert.equal(result.documentsFailed, 0);
  assert.equal(result.truncated, false);
  assert.ok(result.entries.some((entry) => entry.loc.endsWith("story-34")));
});

test("all robots-declared sitemap roots are merged before standard-location fallback", async () => {
  const posts = "https://example.com/post-sitemap.xml";
  const pages = "https://example.com/page-sitemap.xml";
  const documents = new Map([
    [posts, urlset([{ loc: "https://example.com/posts/one" }])],
    [pages, urlset([{ loc: "https://example.com/about" }])],
  ]);
  const result = await walkSitemapRoots([posts, pages], async (url) => {
    const text = documents.get(url);
    if (!text) throw new Error(`Unexpected fallback request: ${url}`);
    return { text, finalUrl: url };
  });

  assert.deepEqual(result.entries.map((entry) => entry.loc).sort(), [
    "https://example.com/about",
    "https://example.com/posts/one",
  ]);
  assert.equal(result.documentsRead, 2);
  assert.equal(result.documentsFailed, 0);
});

test("undated feeds establish a quiet baseline and only emit later observations", () => {
  const checkedAt = "2026-08-24T12:00:00Z";
  const dated = {
    id: "dated",
    title: "Dated update",
    summary: "",
    url: "https://example.com/dated",
    source: "Example",
    publishedAt: "2026-08-24T10:00:00Z",
    kind: "feed" as const,
  };
  const oldUndated = { ...dated, id: "old-undated", title: "Old undated", url: "https://example.com/old-undated", publishedAt: "" };
  const initial = observeUndatedFeedStories([dated, oldUndated], undefined, checkedAt);
  assert.deepEqual(initial.items.map((item) => item.id), [dated.id]);
  assert.equal(initial.baselineCount, 1);

  const newUndated = { ...oldUndated, id: "new-undated", title: "New undated", url: "https://example.com/new-undated" };
  const later = observeUndatedFeedStories([dated, oldUndated, newUndated], initial.nextSeenUrls, "2026-08-24T13:00:00Z");
  assert.deepEqual(later.items.map((item) => item.id), [dated.id, newUndated.id]);
  assert.equal(later.items[1].publishedAt, "2026-08-24T13:00:00Z");
  assert.equal(later.items[1].discoveredAt, "2026-08-24T13:00:00Z");
  assert.equal(later.newlyObservedCount, 1);
});

test("recursive sitemap walking preserves readable entries and reports partial coverage", async () => {
  const root = "https://example.com/sitemap.xml";
  const good = "https://example.com/sitemaps/good.xml";
  const unavailable = "https://example.com/sitemaps/unavailable.xml";
  const fetcher: SitemapFetcher = async (url) => {
    if (url === root) return { text: sitemapIndex([good, unavailable]), finalUrl: url };
    if (url === good) return { text: urlset([{ loc: "https://example.com/journal/current" }]), finalUrl: url };
    throw new Error("HTTP 503 Service Unavailable");
  };

  const result = await walkSitemap(root, fetcher);
  assert.deepEqual(result.entries, [{ loc: "https://example.com/journal/current", lastmod: "" }]);
  assert.equal(result.documentsRead, 2);
  assert.equal(result.documentsFailed, 1);
  assert.deepEqual(result.failures, [{ url: unavailable, message: "HTTP 503 Service Unavailable" }]);
  assert.match(sitemapCoverageMessage(result, 1, 1), /partial coverage: 2\/3 sitemap documents read, 1 failed \(HTTP 503 Service Unavailable\)/);
});

test("sitemap walking resolves relative child and content URLs against final URLs", async () => {
  const root = "https://example.com/sitemap.xml";
  const fetcher: SitemapFetcher = async (url) => {
    if (url === root) return { text: sitemapIndex(["parts/current.xml"]), finalUrl: "https://www.example.com/maps/root.xml" };
    assert.equal(url, "https://www.example.com/maps/parts/current.xml");
    return { text: urlset([{ loc: "../../journal/today", lastmod: "2026-08-24" }]), finalUrl: url };
  };
  const result = await walkSitemap(root, fetcher);
  assert.deepEqual(result.entries, [{ loc: "https://www.example.com/journal/today", lastmod: "2026-08-24" }]);
  assert.equal(result.rootFinalUrl, "https://www.example.com/maps/root.xml");
});

test("first sitemap baselines remain quiet", () => {
  const entries = [{ loc: "https://example.com/journal/current", lastmod: "2026-08-24" }];
  assert.deepEqual(newSitemapEntries(entries), []);
});

test("partial sitemap coverage preserves seen URLs and defers an incomplete first baseline", () => {
  const previouslySeen = {
    "https://example.com/journal/current": "2026-08-23",
    "https://example.com/journal/temporarily-unreadable": "2026-08-22",
  };
  const partialEntries = [
    { loc: "https://example.com/journal/current", lastmod: "2026-08-24" },
    { loc: "https://example.com/journal/new", lastmod: "2026-08-24" },
  ];

  assert.equal(nextSitemapSnapshotUrls(partialEntries, undefined, false), null);
  const partialSnapshot = nextSitemapSnapshotUrls(partialEntries, previouslySeen, false);
  assert.deepEqual(partialSnapshot, {
    ...previouslySeen,
    "https://example.com/journal/current": "2026-08-24",
    "https://example.com/journal/new": "2026-08-24",
  });
  assert.deepEqual(newSitemapEntries([
    ...partialEntries,
    { loc: "https://example.com/journal/temporarily-unreadable", lastmod: "2026-08-22" },
  ], partialSnapshot || undefined), []);
});

test("bounded response reading enforces streamed and declared limits", async () => {
  const withinLimit = new Response("12345");
  assert.equal(await readBoundedResponseText(withinLimit, 5), "12345");

  const streamed = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("123"));
      controller.enqueue(new TextEncoder().encode("456"));
      controller.close();
    },
  }));
  await assert.rejects(readBoundedResponseText(streamed, 5), /larger than 5 bytes/);
  await assert.rejects(readBoundedResponseText(new Response("small", { headers: { "content-length": "6" } }), 5), /larger than 5 bytes/);
});

test("ordinary gzip sitemap files are decoded with a decompressed size bound", async () => {
  const xml = urlset([{ loc: "https://example.com/journal/new", lastmod: "2026-08-24" }]);
  const decoded = await readBoundedResponseText(new Response(gzipSync(xml), {
    headers: { "content-type": "application/gzip" },
  }), Buffer.byteLength(xml));
  assert.deepEqual(parseSitemap(decoded), {
    kind: "urls",
    entries: [{ loc: "https://example.com/journal/new", lastmod: "2026-08-24" }],
  });

  const compressedBomb = gzipSync("x".repeat(1_000));
  assert.ok(compressedBomb.byteLength < 100);
  await assert.rejects(
    readBoundedResponseText(new Response(compressedBomb), 100),
    /larger than 100 bytes after decompression/,
  );
});

test("industry discovery identity is stable across tracking URLs and provider wrappers", () => {
  const base: IndustryDiscoveryLike = {
    title: "Acme launches reusable shipping crate - Trade Journal",
    summary: "",
    source: "Trade Journal",
    url: "https://www.example.com/news/acme-crate/?utm_source=digest&id=7#details",
    publishedAt: "2026-08-25T10:00:00Z",
    kind: "feed",
  };
  const trackedVariant = {
    ...base,
    url: "https://example.com/news/acme-crate?id=7&utm_campaign=weekly",
  };
  assert.equal(canonicalizeIndustryUrl(base.url), "https://example.com/news/acme-crate?id=7");
  assert.equal(normalizeIndustryTitle(base.title, base.source), "acme launches reusable shipping crate");
  assert.equal(stableIndustryDiscoveryId(base), stableIndustryDiscoveryId(trackedVariant));

  const wrapper = {
    ...base,
    kind: "topic",
    url: "https://news.google.com/rss/articles/provider-token-a?oc=5",
  };
  assert.equal(
    stableIndustryDiscoveryId(wrapper),
    stableIndustryDiscoveryId({ ...wrapper, url: "https://news.google.com/rss/articles/provider-token-b?hl=en-US" }),
  );
});

test("industry curation deduplicates canonical and title matches while preferring watched sources", () => {
  const now = Date.parse("2026-08-25T16:00:00Z");
  const direct: IndustryDiscoveryLike = {
    id: "direct",
    title: "Acme launches reusable shipping crate",
    summary: "Acme announced a reusable crate for regional delivery networks.",
    source: "Acme",
    url: "https://acme.example/news/reusable-crate?utm_source=feed",
    publishedAt: "2026-08-25T12:00:00Z",
    kind: "feed",
  };
  const canonicalDuplicate = {
    ...direct,
    id: "canonical-duplicate",
    url: "https://www.acme.example/news/reusable-crate/",
    kind: "topic",
  };
  const titleDuplicate = {
    ...direct,
    id: "title-duplicate",
    source: "Trade Journal",
    url: "https://news.example/acme-crate",
    kind: "topic",
  };
  const result = curateIndustryDiscoveries(
    [canonicalDuplicate, titleDuplicate, direct],
    { now, topicTerms: ["reusable shipping"], limit: 10 },
  );

  assert.equal(result.candidateCount, 3);
  assert.equal(result.deduplicatedCount, 2);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].item.id, "direct");
  assert.equal(result.selected[0].watched, true);
  assert.deepEqual(result.selected[0].corroboratingSources.sort(), ["Acme", "Trade Journal"]);
});

test("industry curation keeps unrelated watched pages with the same sparse title", () => {
  const result = curateIndustryDiscoveries([
    {
      id: "alpha-results",
      title: "Quarterly results",
      summary: "Alpha published its current operating results.",
      source: "Alpha",
      url: "https://alpha.example/investors/quarterly-results",
      publishedAt: "2026-08-25T12:00:00Z",
      kind: "feed",
    },
    {
      id: "beta-results",
      title: "Quarterly results",
      summary: "Beta published a different current operating report.",
      source: "Beta",
      url: "https://beta.example/news/quarterly-results",
      publishedAt: "2026-08-25T13:00:00Z",
      kind: "feed",
    },
  ], { now: Date.parse("2026-08-25T16:00:00Z"), limit: 10 });

  assert.equal(result.deduplicatedCount, 0);
  assert.deepEqual(result.selected.map((candidate) => candidate.item.id).sort(), [
    "alpha-results",
    "beta-results",
  ]);
});

test("industry curation applies generic exclusions and keeps similar events from dominating", () => {
  const now = Date.parse("2026-08-25T16:00:00Z");
  const item = (id: string, title: string, source: string): IndustryDiscoveryLike => ({
    id,
    title,
    summary: "A detailed current report about recyclable packaging supply chains.",
    source,
    url: `https://${source.toLowerCase().replace(/\s/g, "-")}.example/${id}`,
    publishedAt: "2026-08-25T14:00:00Z",
    kind: "topic",
  });
  const result = curateIndustryDiscoveries([
    item("first", "Acme launches Nova recyclable packaging platform", "Journal One"),
    item("second", "Nova recyclable packaging platform launches from Acme", "Journal Two"),
    item("betting", "Sports betting platform expands packaging sponsorship", "Journal Three"),
    { ...item("privacy", "Privacy policy", "Journal Four"), url: "https://journal-four.example/privacy-policy" },
  ], {
    now,
    topicTerms: ["recyclable packaging"],
    excludeTerms: ["sports betting"],
    limit: 10,
  });

  assert.equal(result.selected.length, 1);
  assert.equal(result.deferred.filter((candidate) => candidate.deferredReason === "similar-event").length, 1);
  assert.deepEqual(result.excluded.map((candidate) => candidate.item.id).sort(), ["betting", "privacy"]);
});

test("industry curation bounds the daily set and preserves watched and source diversity", () => {
  const now = Date.parse("2026-08-25T16:00:00Z");
  const topicItems = Array.from({ length: 45 }, (_, index): IndustryDiscoveryLike => ({
    id: `topic-${index}`,
    title: `Manufacturer ${String(index).padStart(3, "0")} announces circular material ${String(index).padStart(3, "0")}`,
    summary: "A current material announcement for reusable shipping systems.",
    source: index < 35 ? "Large Wire" : "Specialist Review",
    url: `https://news.example/${index}`,
    publishedAt: new Date(now - index * 60_000).toISOString(),
    kind: "topic",
  }));
  const watched = Array.from({ length: 5 }, (_, index): IndustryDiscoveryLike => ({
    id: `watched-${index}`,
    title: `Supplier ${String(index).padStart(3, "0")} releases fiber product ${String(index).padStart(3, "0")}`,
    summary: "A new page on a watched supplier site.",
    source: "Watched Supplier",
    url: `https://supplier.example/releases/${index}`,
    publishedAt: new Date(now - index * 60_000).toISOString(),
    kind: "feed",
  }));
  const result = curateIndustryDiscoveries([...topicItems, ...watched], {
    now,
    topicTerms: ["circular material", "reusable shipping"],
    limit: 10,
    maxPerSource: 2,
  });

  assert.equal(result.selected.length, 10);
  assert.ok(result.selected.some((candidate) => candidate.watched));
  assert.ok(new Set(result.selected.map((candidate) => candidate.item.source)).size >= 3);
  assert.ok(result.deferred.some((candidate) => candidate.deferredReason === "source-diversity" || candidate.deferredReason === "daily-limit"));

  const defaultBound = curateIndustryDiscoveries(
    Array.from({ length: 50 }, (_, index): IndustryDiscoveryLike => ({
      id: `independent-${index}`,
      title: `Organization ${String(index).padStart(3, "0")} announces standard ${String(index).padStart(3, "0")}`,
      summary: "",
      source: `Source ${index}`,
      url: `https://source-${index}.example/story`,
      publishedAt: new Date(now - index * 60_000).toISOString(),
      kind: "topic",
    })),
    { now },
  );
  assert.equal(defaultBound.selected.length, 30);
});

test("semantic ranking is constrained by deterministic source diversity", () => {
  const now = Date.parse("2026-08-25T16:00:00Z");
  const wireTitles = [
    "Copper tariff reshapes Chile contracts",
    "Battery recall closes Ohio plant",
    "Shipping law changes Baltic insurance",
    "Patent ruling alters medical licensing",
    "Drought report cuts regional harvest",
    "Security breach delays airline merger",
  ];
  const specialistTitles = [
    "University maps coral recovery",
    "Regulator approves timber standard",
    "Cooperative opens dairy exchange",
    "Laboratory studies ceramic coating",
  ];
  const raw = [
    ...wireTitles.map((title, index): IndustryDiscoveryLike => ({
      id: `wire-${index}`,
      title,
      summary: "A timely report about the configured market.",
      source: "Dominant Wire",
      url: `https://wire.example/${index}`,
      publishedAt: new Date(now - index * 60_000).toISOString(),
      kind: "feed",
    })),
    ...specialistTitles.map((title, index): IndustryDiscoveryLike => ({
      id: `specialist-${index}`,
      title,
      summary: "A timely independent report about the configured market.",
      source: `Specialist ${index}`,
      url: `https://specialist-${index}.example/report`,
      publishedAt: new Date(now - (index + 10) * 60_000).toISOString(),
      kind: "feed",
    })),
  ];
  const ranked = raw.flatMap((item) => curateIndustryDiscoveries([item], { now }).selected);
  const selected = selectDiverseIndustryDiscoveries(ranked, {
    limit: 6,
    maxPerSource: 2,
  }).selected;

  assert.equal(selected.length, 6);
  assert.equal(selected.filter((candidate) => candidate.item.source === "Dominant Wire").length, 2);
  assert.equal(new Set(selected.map((candidate) => candidate.item.source)).size, 5);
});
