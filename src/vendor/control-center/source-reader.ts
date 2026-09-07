import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { filterPlausiblyDatedStories } from "./freshness";
import type { IndustrySource, IndustrySourceStatus, LiveStory } from "./types";
import { discoveredFeedLinks, isFeedDocument } from "./feed-discovery";
import {
  FEED_MAX_RESPONSE_BYTES,
  SITEMAP_MAX_RESPONSE_BYTES,
  filterSitemapEntriesForSource,
  isUrlWithinSourcePath,
  newSitemapEntries,
  nextSitemapSnapshotUrls,
  observeUndatedFeedStories,
  parseFeed as parseFeedDocument,
  parseSitemap,
  sitemapCoverageMessage,
  sitemapStoryTimes,
  sourceContentPath,
  walkSitemap,
  walkSitemapRoots,
} from "./sitemap";

export type SitemapSnapshot = { sourceUrl: string; endpoint: string; urls: Record<string, string>; checkedAt: string; mode?: "sitemap" | "feed" };
export type SitemapSnapshots = Record<string, SitemapSnapshot>;
export type IndustryReadResult = { sourceUrl: string; items: LiveStory[]; status: IndustrySourceStatus; snapshot?: SitemapSnapshot; coverageComplete: boolean; feedKind?: "rss" | "atom" };

/** Adapted upstream reader with explicit I/O and clock ports. No ambient network or
 * filesystem snapshot writes; caller owns authority, total budgets and persistence. */
export function createIndustrySourceReader(ports: {
  readText(url: string, options?: { maxBytes?: number; timeoutMs?: number; headers?: HeadersInit }): Promise<{ text: string; finalUrl: string }>;
  now?: () => number;
}) {
  const safeFetchText = ports.readText.bind(ports), now = ports.now?.bind(ports) ?? Date.now;
  // Preserve source format for Control Room evidence; reuse the same XML package.
  const feedKind = (xml: string): "rss" | "atom" => Object.hasOwn(new XMLParser({ removeNSPrefix: true }).parse(xml), "feed") ? "atom" : "rss";
function parseFeed(xml: string, fallbackSource: string, baseUrl?: string) {
  return filterPlausiblyDatedStories(parseFeedDocument(xml, fallbackSource, baseUrl), now());
}


function storyId(identity: string) {
  return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function normalizedHost(value: string) {
  return value.toLowerCase().replace(/^www\./, "");
}

function feedItemsInSourcePath(items: LiveStory[], sourceUrl: string) {
  const scope = sourceContentPath(sourceUrl);
  if (!scope) return items;
  const source = new URL(sourceUrl);
  return items.filter((item) => {
    try {
      const candidate = new URL(item.url);
      if (normalizedHost(candidate.hostname) !== normalizedHost(source.hostname)) return true;
      return isUrlWithinSourcePath(item.url, sourceUrl);
    } catch {
      return false;
    }
  });
}

function feedCandidates(input: URL) {
  const scope = sourceContentPath(input.toString());
  const scoped = scope ? ["/feed", "/feed.xml", "/rss.xml", "/rss", "/atom.xml"].map((suffix) => new URL(`${scope}${suffix}`, input.origin).toString()) : [];
  return unique([
    ...scoped,
    new URL("/news/rss.xml", input.origin).toString(),
    new URL("/news/feed", input.origin).toString(),
    new URL("/blog/rss.xml", input.origin).toString(),
    new URL("/blog/feed", input.origin).toString(),
    new URL("/feed", input.origin).toString(),
    new URL("/feed.xml", input.origin).toString(),
    new URL("/rss.xml", input.origin).toString(),
    new URL("/rss", input.origin).toString(),
    new URL("/atom.xml", input.origin).toString(),
  ]);
}

async function firstFeed(candidates: string[], sourceName: string, sourceUrl: string) {
  const attempts = await Promise.allSettled(unique(candidates).map(async (candidate) => {
    const response = await safeFetchText(candidate, { maxBytes: FEED_MAX_RESPONSE_BYTES });
    if (!isFeedDocument(response.text)) throw new Error("Not a feed");
    const items = feedItemsInSourcePath(parseFeed(response.text, sourceName, response.finalUrl), sourceUrl);
    return { endpoint: response.finalUrl, items, feedKind: feedKind(response.text) };
  }));
  let emptyFeed: { endpoint: string; items: LiveStory[]; feedKind: "rss" | "atom" } | null = null;
  for (const attempt of attempts) {
    if (attempt.status !== "fulfilled") continue;
    if (attempt.value.items.length) return attempt.value;
    emptyFeed ||= attempt.value;
  }
  return emptyFeed;
}

async function readSitemap(candidate: string) {
  const result = await walkSitemap(candidate, async (url) => {
    const response = await safeFetchText(url, {
      maxBytes: SITEMAP_MAX_RESPONSE_BYTES,
      timeoutMs: 20_000,
      headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.5" },
    });
    return { text: response.text, finalUrl: response.finalUrl };
  });
  if (!result.entries.length && (result.documentsFailed || !result.documentsRead)) {
    const detail = result.failures[0] ? `: ${result.failures[0].message}` : "";
    throw new Error(`Sitemap did not contain a readable URL set${detail}`);
  }
  return { endpoint: result.rootFinalUrl, ...result };
}

async function readSitemapRoots(candidates: string[]) {
  const result = await walkSitemapRoots(unique(candidates), async (url) => {
    const response = await safeFetchText(url, {
      maxBytes: SITEMAP_MAX_RESPONSE_BYTES,
      timeoutMs: 20_000,
      headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.5" },
    });
    return { text: response.text, finalUrl: response.finalUrl };
  });
  if (!result.entries.length && (result.documentsFailed || !result.documentsRead)) {
    const detail = result.failures[0] ? `: ${result.failures[0].message}` : "";
    throw new Error(`Sitemaps did not contain a readable URL set${detail}`);
  }
  return { endpoint: result.rootFinalUrl, ...result };
}

async function firstSitemap(candidates: string[]) {
  for (const candidate of unique(candidates)) {
    try { return await readSitemap(candidate); } catch { /* keep probing standard locations */ }
  }
  return null;
}

function titleFromUrl(value: string) {
  const url = new URL(value);
  const finalSegment = url.pathname.split("/").filter(Boolean).at(-1) || url.hostname;
  return decodeURIComponent(finalSegment).replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isSitemapDocument(text: string) {
  try { parseSitemap(text); return true; } catch { return false; }
}

function standardSitemapCandidates(input: URL) {
  const scope = sourceContentPath(input.toString());
  const scoped = scope ? ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"].map((suffix) => new URL(`${scope}${suffix}`, input.origin).toString()) : [];
  return unique([
    ...scoped,
    new URL("/sitemap.xml", input.origin).toString(),
    new URL("/sitemap_index.xml", input.origin).toString(),
    new URL("/sitemap-index.xml", input.origin).toString(),
  ]);
}

function feedReadResult(source: IndustrySource, sourceName: string, endpoint: string, feedItems: LiveStory[], previous: SitemapSnapshot | undefined, kind: "rss" | "atom"): IndustryReadResult {
  const checkedAt = new Date(now()).toISOString();
  const prior = previous?.sourceUrl === source.url && previous.mode === "feed" ? previous : undefined;
  const observed = observeUndatedFeedStories(feedItems, prior?.urls, checkedAt);
  const snapshot: SitemapSnapshot = {
    sourceUrl: source.url,
    endpoint,
    urls: observed.nextSeenUrls,
    checkedAt,
    mode: "feed",
  };
  const undatedMessage = observed.baselineCount
    ? `; ${observed.baselineCount} undated entr${observed.baselineCount === 1 ? "y was" : "ies were"} quietly baselined`
    : observed.newlyObservedCount
      ? `; ${observed.newlyObservedCount} newly observed undated entr${observed.newlyObservedCount === 1 ? "y" : "ies"} detected`
      : "";
  return {
    items: observed.items,
    sourceUrl: source.url, feedKind: kind,
    coverageComplete: true,
    snapshot,
    status: {
      sourceId: source.id,
      source: sourceName,
      mode: "feed",
      endpoint,
      state: observed.newlyObservedCount ? "changed" : observed.baselineCount && !observed.items.length ? "baseline" : "live",
      message: `${feedItems.length} feed entries found${undatedMessage}`,
    },
  };
}

async function readSource(source: IndustrySource, previous?: SitemapSnapshot): Promise<IndustryReadResult> {
  source = { ...source }; previous = previous ? structuredClone(previous) : undefined;
  const input = new URL(source.url.includes("://") ? source.url : `https://${source.url}`);
  const origin = input.origin;
  const sourceName = source.name || input.hostname;
  let homepage: Awaited<ReturnType<typeof safeFetchText>> | null = null;
  let homepageError = "";
  try { homepage = await safeFetchText(input.toString()); } catch (error) { homepageError = error instanceof Error ? error.message : "Homepage request failed"; }

  if (homepage && isFeedDocument(homepage.text)) {
    const items = parseFeed(homepage.text, sourceName, homepage.finalUrl);
    return feedReadResult(source, sourceName, homepage.finalUrl, items, previous, feedKind(homepage.text));
  }

  const feed = await firstFeed([
    ...(homepage ? discoveredFeedLinks(homepage.text, homepage.finalUrl) : []),
    ...feedCandidates(input),
  ], sourceName, input.toString());
  if (feed) {
    const result = feedReadResult(source, sourceName, feed.endpoint, feed.items, previous, feed.feedKind);
    if (homepageError) result.status.message += "; homepage access was not required";
    return result;
  }

  let robots: Awaited<ReturnType<typeof safeFetchText>> | null = null;
  try { robots = await safeFetchText(new URL("/robots.txt", origin).toString()); } catch { /* standard sitemap locations still work */ }
  const robotsSitemaps = robots ? [...robots.text.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)].map((match) => match[1]) : [];
  let sitemap: Awaited<ReturnType<typeof readSitemap>> | null = null;
  if (homepage && isSitemapDocument(homepage.text)) {
    try { sitemap = await readSitemap(input.toString()); } catch { /* declared and standard sitemap locations remain available */ }
  }
  let declaredSitemaps: Awaited<ReturnType<typeof readSitemapRoots>> | null = null;
  if (!sitemap && robotsSitemaps.length) {
    try { declaredSitemaps = await readSitemapRoots(robotsSitemaps); } catch { /* standard sitemap locations remain a fallback */ }
    if (declaredSitemaps?.entries.length) sitemap = declaredSitemaps;
  }
  if (!sitemap) sitemap = await firstSitemap(standardSitemapCandidates(input)) ?? declaredSitemaps;
  if (!sitemap) throw new Error(`No readable RSS, Atom, RDF, or sitemap endpoint was found${homepageError ? `; homepage returned ${homepageError}` : ""}.`);

  const scopedEntries = filterSitemapEntriesForSource(sitemap.entries, input.toString());
  const checkedAt = new Date(now()).toISOString();
  const prior = previous?.sourceUrl === source.url && previous.mode !== "feed" ? previous : undefined;
  const coverageComplete = sitemap.documentsFailed === 0 && !sitemap.truncated;
  const snapshotUrls = nextSitemapSnapshotUrls(scopedEntries, prior?.urls, coverageComplete);
  const snapshot: SitemapSnapshot | undefined = snapshotUrls
    ? { sourceUrl: source.url, endpoint: sitemap.endpoint, urls: snapshotUrls, checkedAt, mode: "sitemap" }
    : undefined;
  const additions = newSitemapEntries(scopedEntries, prior?.urls);
  const items = additions.map(({ loc, lastmod }) => ({
    id: storyId(loc),
    title: titleFromUrl(loc),
    summary: `New page detected in ${sourceName}'s sitemap.`,
    url: loc,
    source: sourceName,
    ...sitemapStoryTimes(lastmod, checkedAt),
    kind: "sitemap" as const,
  }));
  const state = prior ? (items.length ? "changed" : "unchanged") : "baseline";
  const coverage = sitemapCoverageMessage(sitemap, sitemap.entries.length, scopedEntries.length);
  const message = prior
    ? (items.length ? `${items.length} new sitemap page${items.length === 1 ? "" : "s"}${coverage}` : `No new pages across ${scopedEntries.length.toLocaleString()} sitemap URLs${coverage}`)
    : snapshot
      ? `Baseline saved for ${scopedEntries.length.toLocaleString()} sitemap URLs${coverage}`
      : `Baseline deferred until full sitemap coverage; ${scopedEntries.length.toLocaleString()} URLs observed${coverage}`;
  return { sourceUrl: source.url, items, snapshot, coverageComplete, status: { sourceId: source.id, source: sourceName, mode: "sitemap", endpoint: sitemap.endpoint, state, message } };
}

  return Object.freeze({ readSource, parseFeed });
}
