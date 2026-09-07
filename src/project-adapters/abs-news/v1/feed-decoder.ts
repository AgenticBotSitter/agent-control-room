import Parser from "rss-parser";
import { z } from "zod";
import { sha256Digest } from "../../../security";
import { projectWorkspaceSafeIdSchemaV1 as id, projectWorkspaceLabelSchemaV1 as label,
  projectWorkspaceTimeSchemaV1 as time } from "../../../project-workspace/v1";
import { absNewsCanonicalUrlSchemaV1 } from "./schemas";
import { canonicalizeAbsNewsDiscoveredUrlV1 } from "./collection";
import { buildAbsNewsStoryV1 } from "./story";
import type { AbsNewsStoryV1 } from "./types";
import { curateIndustryDiscoveries, scoreIndustryDiscovery } from "../../../vendor/control-center/industry-curation";

export const absFeedInputSchema = z.object({
  tenantId: id, workspaceId: id, projectId: id,
  source: z.object({ sourceId: id, sourceLabel: label, sourceKind: z.enum(["rss", "atom"]),
    endpointUrl: absNewsCanonicalUrlSchemaV1 }).strict(),
  observedAt: time, xml: z.string().min(1).max(1_048_576),
  maxBytes: z.number().int().min(1).max(1_048_576),
  maxItems: z.number().int().min(1).max(100),
}).strict();

export class AbsFeedDecodeError extends Error {
  constructor(readonly code: "invalid_feed" | "feed_limit_exceeded") { super(code); }
}
const compact = (value: string, limit: number) => {
  // Intentional removal of control characters from untrusted display text.
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
};
const digestId = (prefix: string, value: unknown) => `${prefix}:${sha256Digest(value).slice(7, 39)}`;

/** Parse supplied RSS/Atom bytes only. Does not fetch URLs or grant verification.
 * rss-parser handles XML; our small adapter binds provenance and existing story shape.
 * Invalid entries are counted, never silently treated as a complete successful feed. */
export async function decodeAbsFeed(value: unknown) {
  const parsed = absFeedInputSchema.safeParse(value);
  if (!parsed.success) throw new AbsFeedDecodeError("invalid_feed");
  const { xml, source, observedAt, maxBytes, maxItems, ...scope } = parsed.data;
  const byteCount = Buffer.byteLength(xml, "utf8");
  if (byteCount > maxBytes) throw new AbsFeedDecodeError("feed_limit_exceeded");
  // RSS/Atom do not need DTDs. Reject declarations before invoking upstream XML parsing.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || xml.includes("\u0000")) throw new AbsFeedDecodeError("invalid_feed");
  let feed: Parser.Output<Parser.Item>;
  try { feed = await new Parser().parseString(xml); }
  catch { throw new AbsFeedDecodeError("invalid_feed"); }
  if (!Array.isArray(feed.items)) throw new AbsFeedDecodeError("invalid_feed");
  if (feed.items.length > maxItems) throw new AbsFeedDecodeError("feed_limit_exceeded");
  const feedDigest = sha256Digest({ xml });
  const stories: AbsNewsStoryV1[] = [], urls = new Set<string>();
  let rejectedCount = 0, duplicateCount = 0;
  for (const item of feed.items) {
    try {
      if (typeof item.title !== "string" || typeof item.link !== "string") throw new Error();
      const title = compact(item.title, 240);
      if (!title) throw new Error();
      const canonicalUrl = absNewsCanonicalUrlSchemaV1.parse(canonicalizeAbsNewsDiscoveredUrlV1(item.link));
      let publishedAt: string | undefined;
      if (item.isoDate !== undefined) {
        const date = new Date(item.isoDate);
        if (!Number.isFinite(date.getTime()) || date.getTime() > Date.parse(observedAt)) throw new Error();
        publishedAt = date.toISOString();
      }
      const summary = typeof item.contentSnippet === "string" ? compact(item.contentSnippet, 800) || title : title;
      const material = { title, summary, canonicalUrl, ...(publishedAt ? { publishedAt } : {}) };
      const contentDigest = sha256Digest(material);
      const evidence = { ...source, canonicalUrl, observedAt, feedDigest, contentDigest };
      const story = buildAbsNewsStoryV1({ ...scope, ...material,
        storyId: digestId("story.abs", { ...scope, canonicalUrl }),
        clusterId: digestId("cluster.abs", { canonicalUrl }), sourceLabel: source.sourceLabel,
        queue: "earlier", discoveredAt: observedAt, lastVerifiedAt: observedAt,
        verificationState: "review_only", priorityScore: scoreIndustryDiscovery({ title, summary, url: canonicalUrl,
          source: source.sourceLabel, kind: source.sourceKind, publishedAt, discoveredAt: observedAt },
        { now: Date.parse(observedAt) }).score, coverageCount: 1,
        contentDigest, sourceEvidence: [{ evidenceId: digestId("evidence.abs", evidence),
          sourceId: source.sourceId, sourceKind: source.sourceKind, sourceLabel: source.sourceLabel,
          canonicalUrl, observedAt, evidenceDigest: sha256Digest(evidence),
          containsRawNewsletterBody: false, grantsNetworkAuthority: false }],
      });
      if (urls.has(canonicalUrl)) { duplicateCount++; continue; }
      urls.add(canonicalUrl); stories.push(story);
    } catch { rejectedCount++; }
  }
  // Upstream curation is discovery presentation, not verification or durable identity.
  // Retain every valid story even when upstream deduplicates, excludes or defers it.
  const curated = curateIndustryDiscoveries(stories.map(story => ({ id: story.storyId,
    title: story.title, summary: story.summary, url: story.canonicalUrl, source: story.sourceLabel,
    kind: source.sourceKind, publishedAt: story.publishedAt, discoveredAt: story.discoveredAt })),
  { now: Date.parse(observedAt), limit: Math.min(maxItems, 30) });
  const discoveryCuration = { engine: "control-center/industry-curation" as const,
    selectedStoryIds: curated.selected.map(candidate => candidate.item.id),
    deferredStoryIds: curated.deferred.map(candidate => candidate.item.id),
    excludedStoryIds: curated.excluded.map(candidate => candidate.item.id),
    deduplicatedCount: curated.deduplicatedCount, grantsVerification: false as const };
  return { stories, discoveryCuration, sourceId: source.sourceId, feedDigest, byteCount,
    inputItemCount: feed.items.length, rejectedCount, duplicateCount,
    state: rejectedCount ? "partial" as const : "available" as const,
    observedAt, startsWork: false as const };
}
