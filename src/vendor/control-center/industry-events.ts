// Adapted from mreflow/control-center lib/industry-curation.ts
// commit d13e79e866cc33a1fddfe84f563ce2fb9a2113e0.
// Copyright (c) 2026 Matt Wolfe. MIT; see third_party/control-center/LICENSE.
// Changes: event-only subset; precomputed title tokens; no hashing, URL rewriting,
// ranking, fetching or soft source-cap fallback. Preserve distinct numeric versions.

const titleStopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in", "is", "it", "its", "new", "of", "on", "or", "that", "the", "their", "this", "to", "was", "with",
]);

// Text comparison only. This is NOT an HTML sanitizer or a rendering function.
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

export function normalizeIndustryTitle(title: string, source = "") {
  let value = cleanText(title);
  const normalizedSource = normalizedPhrase(source);
  const separator = value.match(/\s+(?:[-|–—:]\s+)([^|–—:]+)$/u);
  if (separator && normalizedSource && normalizedPhrase(separator[1]) === normalizedSource) {
    value = value.slice(0, separator.index).trim();
  }
  return normalizedPhrase(value.replace(/^(?:breaking|exclusive|updated)\s*:\s*/i, ""));
}

export interface IndustryEventTitle {
  readonly normalizedTitle: string;
  readonly tokens: ReadonlySet<string>;
  readonly numericTokens: string;
  readonly directUrl: string;
}

export function describeIndustryEvent(title: string, source: string, canonicalUrl: string): IndustryEventTitle {
  const normalizedTitle = normalizeIndustryTitle(title, source);
  const tokens = new Set(normalizedTitle.split(" ").filter(token => token.length > 1 && !titleStopWords.has(token)));
  let directUrl = "";
  try {
    const url = new URL(canonicalUrl);
    const wrapper = url.hostname === "news.google.com"
      || (["www.bing.com", "bing.com"].includes(url.hostname) && /\/news\/apiclick\.aspx$/i.test(url.pathname));
    if (!wrapper && /^https?:$/.test(url.protocol)) directUrl = canonicalUrl;
  } catch { /* No reliable direct URL. No network request is made. */ }
  return { normalizedTitle, tokens, directUrl,
    numericTokens: [...new Set(normalizedTitle.split(" ").filter(token => /\p{N}/u.test(token)))].sort().join(" ") };
}

/** Upstream token-overlap/event conflict rule, adapted for already-verified ABS
 * stories. It defers a digest entry; it never merges or changes canonical records. */
export function industryEventsConflict(left: IndustryEventTitle, right: IndustryEventTitle): boolean {
  if (!left.tokens.size || !right.tokens.size) return false;
  // Material model/version/date differences are not duplicate-event evidence.
  if (left.numericTokens !== right.numericTokens) return false;
  let shared = 0;
  for (const token of left.tokens) if (right.tokens.has(token)) shared++;
  const similarity = shared / (left.tokens.size + right.tokens.size - shared);
  if (similarity < 0.72) return false;
  // Upstream exempts identical sparse headlines on distinct direct URLs. Broaden
  // that exception: stop-word/single-letter removal can make DIFFERENT short
  // headlines collide too. Sparse text alone cannot merge separate publications.
  if (Math.min(left.tokens.size, right.tokens.size) <= 3
    && (!left.directUrl || left.directUrl !== right.directUrl)) return false;
  return true;
}
