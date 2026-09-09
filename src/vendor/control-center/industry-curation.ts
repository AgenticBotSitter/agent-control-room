import { createHash } from "node:crypto";

export const DEFAULT_INDUSTRY_SELECTION_LIMIT = 30;
export const DEFAULT_INDUSTRY_MINIMUM_SCORE = 50;

export type IndustryDiscoveryLike = {
  id?: string;
  title: string;
  summary?: string;
  url?: string;
  source: string;
  publishedAt?: string;
  discoveredAt?: string;
  kind?: string;
  collectionScope?: string;
};

export type IndustryCurationOptions = {
  now?: Date | number;
  limit?: number;
  minimumScore?: number;
  topicTerms?: readonly string[];
  priorityTerms?: readonly string[];
  excludeTerms?: readonly string[];
  sourcePriorities?: Readonly<Record<string, number>>;
  maxPerSource?: number;
  eventSimilarityThreshold?: number;
  routineExclusions?: readonly string[] | false;
};

export type IndustryDiscoveryScore = {
  score: number;
  reasons: string[];
  excludedReason?: string;
};

export type CuratedIndustryDiscovery<T extends IndustryDiscoveryLike> = {
  item: T;
  discoveryId: string;
  canonicalUrl: string;
  normalizedTitle: string;
  eventKey: string;
  watched: boolean;
  score: number;
  reasons: string[];
  alternateUrls: string[];
  corroboratingSources: string[];
  deferredReason?: "below-threshold" | "source-diversity" | "similar-event" | "daily-limit";
  excludedReason?: string;
};

export type IndustryCurationResult<T extends IndustryDiscoveryLike> = {
  selected: CuratedIndustryDiscovery<T>[];
  selectedItems: T[];
  deferred: CuratedIndustryDiscovery<T>[];
  excluded: CuratedIndustryDiscovery<T>[];
  candidateCount: number;
  deduplicatedCount: number;
};

export type IndustryDiversityResult<T extends IndustryDiscoveryLike> = {
  selected: CuratedIndustryDiscovery<T>[];
  deferred: CuratedIndustryDiscovery<T>[];
};

const providerWrapperHosts = new Set([
  "news.google.com",
  "www.bing.com",
  "bing.com",
]);

const trackingParameters = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|referrer|source|campaign)$/i;
const materialChangePattern = /\b(?:acquir(?:e|es|ed|ing|ition)|announce(?:s|d|ment)?|approval|breach|expand(?:s|ed|ing)?|funding|invest(?:s|ed|ment)|launch(?:es|ed|ing)?|law|lawsuit|merg(?:e|es|ed|er)|open(?:s|ed|ing)|partnership|patent|policy|recall|regulation|release(?:s|d)?|report|research|security|standard|study|unveil(?:s|ed)?|update(?:s|d)?|upgrade(?:s|d)?)\b/i;
const evergreenPattern = /\b(?:beginner(?:'s)? guide|explainer|how to|podcast|tips|tutorial|webinar)\b/i;
const routinePathPattern = /\/(?:author|authors|category|categories|contact|cookie-policy|legal|login|page|privacy|search|sign-in|tag|tags|terms)(?:\/|$)/i;
const defaultRoutineExclusions = [
  "about us",
  "contact us",
  "cookie policy",
  "log in",
  "privacy policy",
  "sign in",
  "terms of service",
] as const;

const titleStopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in", "is", "it", "its", "new", "of", "on", "or", "that", "the", "their", "this", "to", "was", "with",
]);

function shortHash(value: string, length = 24) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function cleanText(value: string | undefined) {
  return (value || "")
    .normalize("NFKC")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|#38);/gi, "&")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedPhrase(value: string) {
  return cleanText(value)
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceKey(value: string) {
  return normalizedPhrase(value) || "unknown source";
}

function sourcePriorityFor(item: IndustryDiscoveryLike, priorities: Readonly<Record<string, number>> | undefined) {
  if (!priorities) return 0;
  const keys = [item.collectionScope, item.source]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => [value, sourceKey(value)]);
  for (const key of keys) {
    const value = priorities[key];
    if (Number.isFinite(value)) return Math.max(-20, Math.min(25, Math.round(value)));
  }
  return 0;
}

function isProviderWrapper(value: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (!providerWrapperHosts.has(url.hostname.toLocaleLowerCase("en-US"))) return false;
    return url.hostname.includes("google") || /\/news\/apiclick\.aspx$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function canonicalizeIndustryUrl(value: string | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return "";
    url.hash = "";
    url.hostname = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    for (const key of [...url.searchParams.keys()]) {
      if (trackingParameters.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return "";
  }
}

export function normalizeIndustryTitle(title: string, source = "") {
  let value = cleanText(title);
  const normalizedSource = normalizedPhrase(source);
  const separator = value.match(/\s+(?:[-|–—:]\s+)([^|–—:]+)$/u);
  if (separator && normalizedSource && normalizedPhrase(separator[1]) === normalizedSource) {
    value = value.slice(0, separator.index).trim();
  }
  return normalizedPhrase(value.replace(/^(?:breaking|exclusive|updated)\s*:\s*/i, ""));
}

function publicationDay(item: IndustryDiscoveryLike) {
  const timestamp = Date.parse(item.publishedAt || item.discoveredAt || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "undated";
}

export function stableIndustryDiscoveryId(item: IndustryDiscoveryLike) {
  const canonicalUrl = canonicalizeIndustryUrl(item.url);
  const normalizedTitle = normalizeIndustryTitle(item.title, item.source);
  const material = canonicalUrl && !isProviderWrapper(canonicalUrl)
    ? `url:${canonicalUrl}`
    : `story:${sourceKey(item.source)}:${normalizedTitle}:${publicationDay(item)}`;
  return shortHash(material);
}

function significantTitleTokens(title: string) {
  return normalizedPhrase(title)
    .split(" ")
    .filter((token) => token.length > 1 && !titleStopWords.has(token));
}

function eventKey(title: string) {
  const tokens = [...new Set(significantTitleTokens(title))].sort();
  return shortHash(tokens.join(" ") || normalizeIndustryTitle(title), 16);
}

function termMatches(context: string, rawTerms: readonly string[] | undefined) {
  const normalizedContext = ` ${normalizedPhrase(context)} `;
  const matches: string[] = [];
  for (const raw of rawTerms || []) {
    const term = normalizedPhrase(raw);
    if (!term || !normalizedContext.includes(` ${term} `)) continue;
    matches.push(cleanText(raw));
  }
  return [...new Set(matches)];
}

function timestampFor(item: IndustryDiscoveryLike) {
  const timestamp = Date.parse(item.publishedAt || item.discoveredAt || "");
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function normalizedNow(value: Date | number | undefined) {
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

export function isWatchedIndustryDiscovery(item: IndustryDiscoveryLike) {
  return item.kind !== "topic";
}

export function scoreIndustryDiscovery(
  item: IndustryDiscoveryLike,
  options: IndustryCurationOptions = {},
  corroboratingSourceCount = 1,
): IndustryDiscoveryScore {
  const context = `${item.title} ${item.summary || ""} ${item.url || ""}`;
  const exclusionMatches = termMatches(context, options.excludeTerms);
  if (exclusionMatches.length) {
    return { score: 0, reasons: [], excludedReason: `Matches excluded topic: ${exclusionMatches[0]}` };
  }

  const routineTerms = options.routineExclusions === false
    ? []
    : options.routineExclusions || defaultRoutineExclusions;
  const routineMatches = termMatches(context, routineTerms);
  const canonicalUrl = canonicalizeIndustryUrl(item.url);
  let pathname = "";
  try { pathname = canonicalUrl ? new URL(canonicalUrl).pathname : ""; } catch { /* invalid URLs are scored using available text */ }
  if (routineMatches.length || routinePathPattern.test(pathname)) {
    return {
      score: 0,
      reasons: [],
      excludedReason: routineMatches.length ? `Routine page: ${routineMatches[0]}` : "Routine utility or index page",
    };
  }

  let score = 25;
  const reasons: string[] = [];
  const watched = isWatchedIndustryDiscovery(item);
  if (watched) {
    score += 22;
    reasons.push("Update from a watched site");
  }

  const now = normalizedNow(options.now);
  const timestamp = timestampFor(item);
  if (Number.isFinite(timestamp)) {
    const ageHours = Math.max(0, (now - timestamp) / 3_600_000);
    if (ageHours <= 6) {
      score += 18;
      reasons.push("Published in the last 6 hours");
    } else if (ageHours <= 24) {
      score += 14;
      reasons.push("Published in the last 24 hours");
    } else if (ageHours <= 72) {
      score += 7;
      reasons.push("Published in the last 3 days");
    } else if (ageHours > 168) {
      score -= 15;
    }
  }

  const topicMatches = termMatches(context, options.topicTerms);
  if (topicMatches.length) {
    score += Math.min(24, 16 + (topicMatches.length - 1) * 4);
    reasons.push(`Matches ${topicMatches.slice(0, 2).join(" and ")}`);
  } else if (item.kind === "topic" && options.topicTerms?.length) {
    score -= 12;
  }

  const priorityMatches = termMatches(context, options.priorityTerms);
  if (priorityMatches.length) {
    score += Math.min(26, 18 + (priorityMatches.length - 1) * 4);
    reasons.push(`Priority topic: ${priorityMatches.slice(0, 2).join(" and ")}`);
  }

  const sourcePriority = sourcePriorityFor(item, options.sourcePriorities);
  if (sourcePriority) {
    score += sourcePriority;
    reasons.push(sourcePriority > 0 ? "Higher-priority source" : "Lower-priority source");
  }

  if (materialChangePattern.test(context)) {
    score += 10;
    reasons.push("Signals a material change or development");
  }
  if (evergreenPattern.test(context)) score -= 8;
  if ((item.summary || "").trim().length >= 120) score += 4;
  if (corroboratingSourceCount > 1) {
    score += Math.min(12, (corroboratingSourceCount - 1) * 5);
    reasons.push(`Corroborated by ${corroboratingSourceCount} sources`);
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

function preferredCandidate<T extends IndustryDiscoveryLike>(
  left: T,
  right: T,
  options: IndustryCurationOptions,
) {
  const quality = (item: T) => {
    const watched = isWatchedIndustryDiscovery(item) ? 100 : 0;
    const direct = item.url && !isProviderWrapper(item.url) ? 40 : 0;
    const priority = sourcePriorityFor(item, options.sourcePriorities) * 2;
    const summary = Math.min(30, Math.round((item.summary || "").length / 20));
    const dated = Number(Number.isFinite(timestampFor(item))) * 5;
    return watched + direct + priority + summary + dated;
  };
  const difference = quality(right) - quality(left);
  if (difference) return difference > 0 ? right : left;
  return timestampFor(right) > timestampFor(left) ? right : left;
}

type CandidateGroup<T extends IndustryDiscoveryLike> = {
  item: T;
  canonicalUrls: Set<string>;
  sources: Set<string>;
  hasReliableDirectIdentity: boolean;
};

function deduplicateCandidates<T extends IndustryDiscoveryLike>(items: readonly T[], options: IndustryCurationOptions) {
  const groups: CandidateGroup<T>[] = [];
  const byCanonicalUrl = new Map<string, number>();
  const byTitle = new Map<string, number>();
  for (const item of items) {
    const canonicalUrl = canonicalizeIndustryUrl(item.url);
    const normalizedTitle = normalizeIndustryTitle(item.title, item.source);
    const titleIdentity = normalizedTitle ? `${normalizedTitle}:${publicationDay(item)}` : "";
    const hasReliableDirectIdentity = Boolean(
      canonicalUrl &&
      !isProviderWrapper(canonicalUrl) &&
      isWatchedIndustryDiscovery(item),
    );
    const canonicalIndex = canonicalUrl && !isProviderWrapper(canonicalUrl)
      ? byCanonicalUrl.get(canonicalUrl)
      : undefined;
    const titleIndex = titleIdentity ? byTitle.get(titleIdentity) : undefined;
    const existingIndex = canonicalIndex ?? (
      titleIndex !== undefined && (
        !hasReliableDirectIdentity ||
        !groups[titleIndex].hasReliableDirectIdentity
      )
        ? titleIndex
        : undefined
    );
    if (existingIndex === undefined) {
      const nextIndex = groups.length;
      groups.push({
        item,
        canonicalUrls: new Set(canonicalUrl ? [canonicalUrl] : []),
        sources: new Set(item.source ? [item.source] : []),
        hasReliableDirectIdentity,
      });
      if (canonicalUrl && !isProviderWrapper(canonicalUrl)) byCanonicalUrl.set(canonicalUrl, nextIndex);
      if (titleIdentity) byTitle.set(titleIdentity, nextIndex);
      continue;
    }

    const group = groups[existingIndex];
    group.item = preferredCandidate(group.item, item, options);
    group.hasReliableDirectIdentity ||= hasReliableDirectIdentity;
    if (canonicalUrl) group.canonicalUrls.add(canonicalUrl);
    if (item.source) group.sources.add(item.source);
    if (canonicalUrl && !isProviderWrapper(canonicalUrl)) byCanonicalUrl.set(canonicalUrl, existingIndex);
    if (titleIdentity) byTitle.set(titleIdentity, existingIndex);
  }
  return groups;
}

function assessmentFor<T extends IndustryDiscoveryLike>(group: CandidateGroup<T>, options: IndustryCurationOptions) {
  const canonicalUrl = canonicalizeIndustryUrl(group.item.url);
  const normalizedTitle = normalizeIndustryTitle(group.item.title, group.item.source);
  const score = scoreIndustryDiscovery(group.item, options, group.sources.size);
  return {
    item: group.item,
    discoveryId: stableIndustryDiscoveryId(group.item),
    canonicalUrl,
    normalizedTitle,
    eventKey: eventKey(group.item.title),
    watched: isWatchedIndustryDiscovery(group.item),
    score: score.score,
    reasons: score.reasons,
    alternateUrls: [...group.canonicalUrls].filter((url) => url !== canonicalUrl),
    corroboratingSources: [...group.sources],
    excludedReason: score.excludedReason,
  } satisfies CuratedIndustryDiscovery<T>;
}

function titleSimilarity(left: CuratedIndustryDiscovery<IndustryDiscoveryLike>, right: CuratedIndustryDiscovery<IndustryDiscoveryLike>) {
  if (left.eventKey === right.eventKey) return 1;
  const leftTokens = new Set(significantTitleTokens(left.normalizedTitle));
  const rightTokens = new Set(significantTitleTokens(right.normalizedTitle));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return shared / (leftTokens.size + rightTokens.size - shared);
}

function conflictsWithIndustryEvent(
  left: CuratedIndustryDiscovery<IndustryDiscoveryLike>,
  right: CuratedIndustryDiscovery<IndustryDiscoveryLike>,
  similarityThreshold: number,
) {
  if (titleSimilarity(left, right) < similarityThreshold) return false;
  const distinctWatchedUrls = left.watched && right.watched &&
    Boolean(left.canonicalUrl) && Boolean(right.canonicalUrl) &&
    !isProviderWrapper(left.canonicalUrl) && !isProviderWrapper(right.canonicalUrl) &&
    left.canonicalUrl !== right.canonicalUrl;
  const sparseGenericTitle = left.normalizedTitle === right.normalizedTitle &&
    Math.min(
      significantTitleTokens(left.normalizedTitle).length,
      significantTitleTokens(right.normalizedTitle).length,
    ) <= 3;
  return !(distinctWatchedUrls && sparseGenericTitle);
}

function ranking<T extends IndustryDiscoveryLike>(left: CuratedIndustryDiscovery<T>, right: CuratedIndustryDiscovery<T>) {
  if (right.score !== left.score) return right.score - left.score;
  if (left.watched !== right.watched) return Number(right.watched) - Number(left.watched);
  const dateDifference = timestampFor(right.item) - timestampFor(left.item);
  if (dateDifference) return dateDifference;
  return left.discoveryId.localeCompare(right.discoveryId);
}

export function selectDiverseIndustryDiscoveries<T extends IndustryDiscoveryLike>(
  candidates: readonly CuratedIndustryDiscovery<T>[],
  options: Pick<IndustryCurationOptions, "limit" | "maxPerSource" | "eventSimilarityThreshold"> = {},
): IndustryDiversityResult<T> {
  const limit = Math.max(1, Math.min(200, Math.round(options.limit ?? DEFAULT_INDUSTRY_SELECTION_LIMIT)));
  const maxPerSource = Math.max(1, Math.min(limit, Math.round(options.maxPerSource ?? Math.max(3, Math.ceil(limit * 0.2)))));
  const similarityThreshold = Math.max(0.5, Math.min(1, options.eventSimilarityThreshold ?? 0.72));
  const selected: CuratedIndustryDiscovery<T>[] = [];
  const deferred: CuratedIndustryDiscovery<T>[] = [];
  const sourceCounts = new Map<string, number>();
  const seen = new Set<string>();

  const conflictsWithSelectedEvent = (candidate: CuratedIndustryDiscovery<T>) => selected.some(
    (current) => conflictsWithIndustryEvent(candidate, current, similarityThreshold),
  );

  for (const candidate of candidates) {
    if (seen.has(candidate.discoveryId)) continue;
    seen.add(candidate.discoveryId);
    if (conflictsWithSelectedEvent(candidate)) {
      deferred.push({ ...candidate, deferredReason: "similar-event" });
      continue;
    }
    const key = sourceKey(candidate.item.source);
    if ((sourceCounts.get(key) || 0) >= maxPerSource) {
      deferred.push({ ...candidate, deferredReason: "source-diversity" });
      continue;
    }
    if (selected.length >= limit) {
      deferred.push({ ...candidate, deferredReason: "daily-limit" });
      continue;
    }
    selected.push({ ...candidate, deferredReason: undefined });
    sourceCounts.set(key, (sourceCounts.get(key) || 0) + 1);
  }

  if (selected.length < limit) {
    const remaining = deferred.filter((candidate) => candidate.deferredReason === "source-diversity");
    for (const candidate of remaining) {
      if (selected.length >= limit) break;
      if (conflictsWithSelectedEvent(candidate)) continue;
      selected.push({ ...candidate, deferredReason: undefined });
      const index = deferred.findIndex((item) => item.discoveryId === candidate.discoveryId);
      if (index >= 0) deferred.splice(index, 1);
    }
  }

  return { selected, deferred };
}

export function curateIndustryDiscoveries<T extends IndustryDiscoveryLike>(
  items: readonly T[],
  options: IndustryCurationOptions = {},
): IndustryCurationResult<T> {
  const minimumScore = Math.max(0, Math.min(100, Math.round(options.minimumScore ?? DEFAULT_INDUSTRY_MINIMUM_SCORE)));
  const groups = deduplicateCandidates(items, options);
  const assessed = groups.map((group) => assessmentFor(group, options)).sort(ranking);
  const excluded = assessed.filter((candidate) => candidate.excludedReason);
  const eligible = assessed.filter((candidate) => !candidate.excludedReason);
  const belowThreshold = eligible
    .filter((candidate) => candidate.score < minimumScore)
    .map((candidate) => ({ ...candidate, deferredReason: "below-threshold" as const }));
  const diverse = selectDiverseIndustryDiscoveries(
    eligible.filter((candidate) => candidate.score >= minimumScore),
    options,
  );
  const deferred = [...belowThreshold, ...diverse.deferred].sort(ranking);

  return {
    selected: diverse.selected,
    selectedItems: diverse.selected.map((candidate) => candidate.item),
    deferred,
    excluded,
    candidateCount: items.length,
    deduplicatedCount: items.length - groups.length,
  };
}
