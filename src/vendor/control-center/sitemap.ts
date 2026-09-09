import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import type { LiveStory } from "./types";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });

export const SITEMAP_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
export const FEED_MAX_RESPONSE_BYTES = 10_000_000;
export const DEFAULT_SITEMAP_DOCUMENT_LIMIT = 500;
export const DEFAULT_SITEMAP_ENTRY_LIMIT = 100_000;

function arrayify<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value: unknown) {
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : typeof value === "object" && value && "#text" in value ? String((value as { "#text": unknown })["#text"]) : "";
  return text.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

export type SitemapUrl = { loc: string; lastmod: string };
export type SitemapFetchResult = { text: string; finalUrl?: string };
export type SitemapFetcher = (url: string) => Promise<SitemapFetchResult>;
export type SitemapFailure = { url: string; message: string };
export type SitemapWalkResult = {
  entries: SitemapUrl[];
  rootFinalUrl: string;
  documentsRead: number;
  documentsFailed: number;
  failures: SitemapFailure[];
  truncated: boolean;
};

export type UndatedFeedObservation = {
  items: LiveStory[];
  nextSeenUrls: Record<string, string>;
  baselineCount: number;
  newlyObservedCount: number;
};

function linkValue(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const alternate = value.find((item) => typeof item === "object" && item && (item as { "@_rel"?: string })["@_rel"] === "alternate");
    return linkValue(alternate ?? value[0]);
  }
  if (typeof value === "object" && value) {
    const link = value as { "@_href"?: string; "#text"?: string };
    return String(link["@_href"] || link["#text"] || "");
  }
  return "";
}

function absoluteUrl(value: string, baseUrl?: string) {
  if (!value) return "";
  try { return new URL(value, baseUrl).toString(); } catch { return ""; }
}

function storyId(identity: string) {
  return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

export function parseFeed(xml: string, fallbackSource: string, baseUrl?: string): LiveStory[] {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const rss = parsed.rss as { channel?: Record<string, unknown> } | undefined;
  const atom = parsed.feed as Record<string, unknown> | undefined;
  const rdf = (parsed.RDF ?? parsed["rdf:RDF"]) as Record<string, unknown> | undefined;
  const channel = rss?.channel ?? rdf?.channel as Record<string, unknown> | undefined;
  const source = cleanText(channel?.title ?? atom?.title) || fallbackSource;
  const rawItems = rss?.channel
    ? arrayify(rss.channel.item as Record<string, unknown> | Record<string, unknown>[] | undefined)
    : atom
      ? arrayify(atom.entry as Record<string, unknown> | Record<string, unknown>[] | undefined)
      : arrayify(rdf?.item as Record<string, unknown> | Record<string, unknown>[] | undefined);

  const stories = rawItems.flatMap((item) => {
    const title = cleanText(item.title) || "Untitled update";
    const rawUrl = linkValue(item.link) || cleanText(item.guid) || cleanText(item["@_about"]);
    const url = absoluteUrl(rawUrl, baseUrl) || rawUrl;
    if (!url || !title) return [];
    const identity = cleanText(item.guid ?? item.id ?? item["@_about"]) || url || title;
    const summary = cleanText(item.description ?? item.summary ?? item.content ?? item.encoded).slice(0, 420);
    const publishedAt = cleanText(item.pubDate ?? item.published ?? item.updated ?? item.date ?? item.issued ?? item.created);
    const itemSource = cleanText(item.source ?? item.Source) || source;
    return [{
      id: storyId(identity),
      title,
      summary,
      url,
      source: itemSource,
      publishedAt,
      kind: "feed" as const,
    }];
  });

  stories.sort((left, right) => {
    const leftTime = Date.parse(left.publishedAt);
    const rightTime = Date.parse(right.publishedAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime;
    if (Number.isFinite(rightTime)) return 1;
    if (Number.isFinite(leftTime)) return -1;
    return 0;
  });
  return stories.slice(0, 250);
}

export function observeUndatedFeedStories(
  items: LiveStory[],
  previousSeenUrls: Record<string, string> | undefined,
  discoveredAt: string,
): UndatedFeedObservation {
  const dated: LiveStory[] = [];
  const undated: LiveStory[] = [];
  for (const item of items) {
    if (Number.isFinite(Date.parse(item.publishedAt))) dated.push(item);
    else undated.push(item);
  }

  const nextSeenUrls = { ...(previousSeenUrls ?? {}) };
  for (const item of undated) nextSeenUrls[item.url || item.id] = item.id;

  if (previousSeenUrls === undefined) {
    return {
      items: dated,
      nextSeenUrls,
      baselineCount: undated.length,
      newlyObservedCount: 0,
    };
  }

  const newlyObserved = undated
    .filter((item) => !Object.prototype.hasOwnProperty.call(previousSeenUrls, item.url || item.id))
    .map((item) => ({ ...item, publishedAt: discoveredAt, discoveredAt }));
  return {
    items: [...dated, ...newlyObserved],
    nextSeenUrls,
    baselineCount: 0,
    newlyObservedCount: newlyObserved.length,
  };
}

function normalizedHost(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function looksLikeSyndicationEndpoint(pathname: string) {
  return /\.(?:xml|rss|atom|json|gz)$/i.test(pathname) || /\/(?:feed|rss|atom)\/?$/i.test(pathname);
}

export function sourceContentPath(sourceUrl: string) {
  const url = new URL(sourceUrl);
  const pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  if (pathname === "/" || looksLikeSyndicationEndpoint(pathname)) return "";
  return pathname;
}

export function isUrlWithinSourcePath(candidateUrl: string, sourceUrl: string) {
  const scope = sourceContentPath(sourceUrl);
  if (!scope) return true;
  try {
    const candidate = new URL(candidateUrl);
    const source = new URL(sourceUrl);
    if (normalizedHost(candidate.hostname) !== normalizedHost(source.hostname)) return false;
    const pathname = candidate.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
    return pathname === scope || pathname.startsWith(`${scope}/`);
  } catch {
    return false;
  }
}

export function filterSitemapEntriesForSource(entries: SitemapUrl[], sourceUrl: string) {
  return sourceContentPath(sourceUrl) ? entries.filter((entry) => isUrlWithinSourcePath(entry.loc, sourceUrl)) : entries;
}

export function newSitemapEntries(entries: SitemapUrl[], previousUrls?: Record<string, string>) {
  return previousUrls ? entries.filter(({ loc }) => !(loc in previousUrls)) : [];
}

export function nextSitemapSnapshotUrls(
  entries: SitemapUrl[],
  previousUrls: Record<string, string> | undefined,
  coverageComplete: boolean,
) {
  const currentUrls = Object.fromEntries(entries.map(({ loc, lastmod }) => [loc, lastmod]));
  if (coverageComplete) return currentUrls;
  if (!previousUrls) return null;
  return { ...previousUrls, ...currentUrls };
}

export function sitemapStoryTimes(lastModifiedAt: string, discoveredAt: string) {
  return {
    publishedAt: discoveredAt,
    discoveredAt,
    lastModifiedAt: lastModifiedAt || undefined,
  };
}

export function parseSitemap(xml: string): { kind: "index" | "urls"; entries: SitemapUrl[] } {
  const parsed = parser.parse(xml) as { sitemapindex?: { sitemap?: unknown }; urlset?: { url?: unknown } };
  if (parsed.sitemapindex) {
    const entries = arrayify(parsed.sitemapindex.sitemap as Record<string, unknown> | Record<string, unknown>[] | undefined)
      .map((entry) => ({ loc: cleanText(entry.loc), lastmod: cleanText(entry.lastmod) }))
      .filter((entry) => entry.loc);
    return { kind: "index", entries };
  }
  if (parsed.urlset) {
    const entries = arrayify(parsed.urlset.url as Record<string, unknown> | Record<string, unknown>[] | undefined)
      .map((entry) => ({ loc: cleanText(entry.loc), lastmod: cleanText(entry.lastmod) }))
      .filter((entry) => entry.loc);
    return { kind: "urls", entries };
  }
  throw new Error("Not a sitemap");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function walkSitemapRoots(
  rootUrls: string[],
  fetcher: SitemapFetcher,
  options: { concurrency?: number; maxDocuments?: number; maxEntries?: number } = {},
): Promise<SitemapWalkResult> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 6, 12));
  const maxDocuments = Math.max(1, options.maxDocuments ?? DEFAULT_SITEMAP_DOCUMENT_LIMIT);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_SITEMAP_ENTRY_LIMIT);
  const queued = new Set<string>();
  const queue: string[] = [];
  const entries = new Map<string, SitemapUrl>();
  const failures: SitemapFailure[] = [];
  let documentsRead = 0;
  let documentsFailed = 0;
  let truncated = false;
  const normalizedRootUrls = [...new Set(rootUrls.map((rootUrl) => absoluteUrl(rootUrl) || rootUrl).filter(Boolean))];
  const rootUrlSet = new Set(normalizedRootUrls);
  let rootFinalUrl = normalizedRootUrls[0] || "";
  let resolvedRoot = false;

  const enqueue = (value: string, base?: string) => {
    const url = absoluteUrl(value, base);
    if (!url || queued.has(url)) return;
    if (queued.size >= maxDocuments) {
      truncated = true;
      return;
    }
    queued.add(url);
    queue.push(url);
  };
  for (const rootUrl of normalizedRootUrls) enqueue(rootUrl);

  while (queue.length && entries.size < maxEntries) {
    const batch = queue.splice(0, concurrency);
    const results = await Promise.all(batch.map(async (url) => {
      try {
        const response = await fetcher(url);
        return { url, response, parsed: parseSitemap(response.text) } as const;
      } catch (error) {
        return { url, error } as const;
      }
    }));

    for (const result of results) {
      if ("error" in result) {
        documentsFailed += 1;
        failures.push({ url: result.url, message: errorMessage(result.error) });
        continue;
      }
      documentsRead += 1;
      const base = result.response.finalUrl || result.url;
      if (!resolvedRoot && rootUrlSet.has(result.url)) {
        rootFinalUrl = base;
        resolvedRoot = true;
      }
      if (result.parsed.kind === "index") {
        for (const child of result.parsed.entries) enqueue(child.loc, base);
        continue;
      }
      for (const entry of result.parsed.entries) {
        const loc = absoluteUrl(entry.loc, base);
        if (!loc) continue;
        if (entries.size >= maxEntries && !entries.has(loc)) {
          truncated = true;
          break;
        }
        const previous = entries.get(loc);
        entries.set(loc, { loc, lastmod: entry.lastmod || previous?.lastmod || "" });
      }
    }
  }
  if (queue.length) truncated = true;

  return { entries: [...entries.values()], rootFinalUrl, documentsRead, documentsFailed, failures, truncated };
}

export async function walkSitemap(
  rootUrl: string,
  fetcher: SitemapFetcher,
  options: { concurrency?: number; maxDocuments?: number; maxEntries?: number } = {},
) {
  return walkSitemapRoots([rootUrl], fetcher, options);
}

export function sitemapCoverageMessage(result: SitemapWalkResult, totalEntries: number, scopedEntries: number) {
  const notes: string[] = [];
  if (result.documentsFailed) {
    const attempted = result.documentsRead + result.documentsFailed;
    const firstFailure = result.failures[0];
    notes.push(`partial coverage: ${result.documentsRead}/${attempted} sitemap documents read, ${result.documentsFailed} failed${firstFailure ? ` (${firstFailure.message})` : ""}`);
  }
  if (result.truncated) notes.push("coverage stopped at the configured safety limit");
  if (scopedEntries !== totalEntries) notes.push(`${scopedEntries.toLocaleString()} of ${totalEntries.toLocaleString()} URLs matched the configured path`);
  return notes.length ? `; ${notes.join("; ")}` : "";
}

function byteLimitLabel(maxBytes: number) {
  if (maxBytes % 1_000_000 === 0) return `${maxBytes / 1_000_000} MB`;
  return `${maxBytes.toLocaleString()} bytes`;
}

export async function readBoundedResponseText(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Source response is larger than ${byteLimitLabel(maxBytes)}.`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Source response is larger than ${byteLimitLabel(maxBytes)}.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);

  const decoder = new TextDecoder();
  let decompressedBytes = 0;
  let text = "";
  for await (const chunk of Readable.from([bytes]).pipe(createGunzip())) {
    const value = chunk as Buffer;
    decompressedBytes += value.byteLength;
    if (decompressedBytes > maxBytes) {
      throw new Error(`Source response is larger than ${byteLimitLabel(maxBytes)} after decompression.`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function writeFileAtomically(target: string, contents: string) {
  const resolvedTarget = path.resolve(target);
  await mkdir(path.dirname(resolvedTarget), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(resolvedTarget), `.${path.basename(resolvedTarget)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await queueAtomicReplacement(resolvedTarget, () =>
      renameWithTransientRetry(temporary, resolvedTarget),
    );
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

const atomicReplacementQueues = new Map<string, Promise<void>>();
const transientRenameErrors = new Set(["EACCES", "EBUSY", "EPERM"]);

async function renameWithTransientRetry(source: string, target: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !transientRenameErrors.has(code) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}

async function queueAtomicReplacement(
  target: string,
  replace: () => Promise<void>,
) {
  const prior = atomicReplacementQueues.get(target) || Promise.resolve();
  const queued = prior.catch(() => undefined).then(replace);
  atomicReplacementQueues.set(target, queued);
  try {
    await queued;
  } finally {
    if (atomicReplacementQueues.get(target) === queued) {
      atomicReplacementQueues.delete(target);
    }
  }
}
