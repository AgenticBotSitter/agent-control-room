import { z } from "zod";
import type { DatabaseClient } from "../../../persistence/database";
import { projectWorkspaceSafeIdSchemaV1 as id, projectWorkspaceLabelSchemaV1 as label,
  projectWorkspaceTimeSchemaV1 as time } from "../../../project-workspace/v1";
import { sha256Digest } from "../../../security";
import { curateIndustryDiscoveries, scoreIndustryDiscovery } from "../../../vendor/control-center/industry-curation";
import { absNewsCanonicalUrlSchemaV1, absNewsDiscoveryEndpointSchemaV1 } from "./schemas";
import { canonicalizeAbsNewsDiscoveredUrlV1 } from "./collection";
import { buildAbsNewsStoryV1 } from "./story";
import type { AbsNewsStoryV1 } from "./types";
import { saveAbsNewsDiscovery } from "./discovery-ingestion";
import { discoverySnapshotSchema, readDiscoveryBaseline, saveDiscoveryBaseline } from "./discovery-baseline";
import { absDiscoveryCollectionLimit } from "./postgres-store";
import type { createIndustrySourceReader } from "../../../vendor/control-center/source-reader";

const configuration = z.object({ tenantId: id, workspaceId: id, projectId: id,
  source: z.object({ id, name: label, url: absNewsDiscoveryEndpointSchemaV1 }).strict() }).strict();
const resultSchema = z.object({ sourceUrl: absNewsDiscoveryEndpointSchemaV1, coverageComplete: z.boolean(), feedKind: z.enum(["rss", "atom"]).optional(),
  snapshot: discoverySnapshotSchema.optional(),
  status: z.object({ sourceId: id, source: label, mode: z.enum(["feed", "sitemap"]), endpoint: absNewsDiscoveryEndpointSchemaV1 }),
  items: z.array(z.object({ title: z.string().max(20_000), summary: z.string().max(20_000), url: z.string().max(2_000),
    publishedAt: z.string().max(100), discoveredAt: time.optional() })).max(absDiscoveryCollectionLimit),
});
const digestId = (prefix: string, value: unknown) => `${prefix}:${sha256Digest(value).slice(7, 39)}`;
const text = (value: string, max: number) => value.replace(/<[^>]*>/g, " ")
  // Minimized display text, never executable markup.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Translation/storage adapter for the borrowed reader. No fetching or dispatch.
 * Articles and baseline commit together; failed or rejected items never advance memory. */
export class AbsControlCenterIngestion {
  private readonly config: z.infer<typeof configuration>;
  private readonly key: Uint8Array;
  constructor(private readonly db: DatabaseClient, value: unknown, key: Uint8Array) {
    this.config = configuration.parse(value);
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("news_key_invalid");
    this.key = Uint8Array.from(key);
  }
  async loadBaseline() { return readDiscoveryBaseline(this.db, this.config, this.key); }
  /** Connect the borrowed reader to durable restart memory. The caller supplies an
   * already-bounded/authorized reader; this adds no network implementation or grants.
   * Abort prevents persistence, but transport cancellation remains the reader's job. */
  async collect(reader: Pick<ReturnType<typeof createIndustrySourceReader>, "readSource">,
    signal: AbortSignal, clock: () => number = Date.now) {
    const read = reader.readSource.bind(reader);
    const current = () => { signal.throwIfAborted(); };
    current();
    const previous = await this.loadBaseline(); current();
    const result = await read({ ...this.config.source }, previous); current();
    const checkedAt = new Date(clock()).toISOString();
    const db: DatabaseClient = { query: this.db.query.bind(this.db),
      transaction: work => { current(); return this.db.transactionWithPreCommitCheck(work, current); },
      transactionWithPreCommitCheck: (work, check) => this.db.transactionWithPreCommitCheck(work, async () => { await check(); current(); }),
    };
    return new AbsControlCenterIngestion(db, this.config, this.key).ingest(result, checkedAt, previous);
  }
  async ingest(value: unknown, observedAt: unknown, previousBaseline?: unknown) {
    const checkedAt = time.parse(observedAt), result = resultSchema.parse(value);
    const expected = previousBaseline === undefined ? undefined : discoverySnapshotSchema.parse(previousBaseline);
    const { source, ...scope } = this.config;
    if (result.status.sourceId !== source.id || result.status.source !== source.name || result.sourceUrl !== source.url)
      throw new Error("news_source_mismatch");
    if (result.status.mode === "feed" && !result.feedKind) throw new Error("news_source_format_missing");
    if (result.snapshot && (result.snapshot.sourceUrl !== source.url || result.snapshot.endpoint !== result.status.endpoint
      || (result.snapshot.mode ?? "sitemap") !== result.status.mode || Date.parse(result.snapshot.checkedAt) > Date.parse(checkedAt)))
      throw new Error("news_baseline_mismatch");
    const sourceKind = result.status.mode === "sitemap" ? "sitemap" as const : result.feedKind!;
    const stories: AbsNewsStoryV1[] = [], seen = new Set<string>();
    let rejectedCount = 0, duplicateCount = 0;
    for (const item of result.items) {
      try {
        const canonicalUrl = absNewsCanonicalUrlSchemaV1.parse(canonicalizeAbsNewsDiscoveredUrlV1(item.url));
        const title = text(item.title, 240), summary = text(item.summary, 800) || title;
        if (!title) throw new Error();
        // Upstream synthesizes publication dates for newly discovered sitemap/undated
        // pages. Retain discovery time instead of claiming a publisher supplied date.
        let publishedAt: string | undefined;
        if (sourceKind !== "sitemap" && !item.discoveredAt && item.publishedAt) {
          const date = Date.parse(item.publishedAt);
          if (!Number.isFinite(date) || date > Date.parse(checkedAt)) throw new Error();
          publishedAt = new Date(date).toISOString();
        }
        const material = { title, summary, canonicalUrl, ...(publishedAt ? { publishedAt } : {}) };
        const contentDigest = sha256Digest(material), evidence = { ...material, source, sourceKind,
          endpoint: result.status.endpoint, observedAt: checkedAt, contentDigest };
        const score = scoreIndustryDiscovery({ ...item, title, summary, url: canonicalUrl, source: source.name,
          publishedAt, discoveredAt: checkedAt, kind: result.status.mode }, { now: Date.parse(checkedAt) });
        const story = buildAbsNewsStoryV1({ ...scope, ...material,
          storyId: digestId("story.abs", { ...scope, canonicalUrl }), clusterId: digestId("cluster.abs", { canonicalUrl }),
          sourceLabel: source.name, queue: "earlier", discoveredAt: checkedAt, lastVerifiedAt: checkedAt,
          verificationState: "review_only", priorityScore: score.score, coverageCount: 1, contentDigest,
          sourceEvidence: [{ evidenceId: digestId("evidence.abs", evidence), sourceId: source.id, sourceKind,
            sourceLabel: source.name, canonicalUrl, observedAt: checkedAt, evidenceDigest: sha256Digest(evidence),
            containsRawNewsletterBody: false, grantsNetworkAuthority: false }],
        });
        if (seen.has(canonicalUrl)) { duplicateCount++; continue; }
        seen.add(canonicalUrl); stories.push(story);
      } catch { rejectedCount++; }
    }
    const curated = curateIndustryDiscoveries(stories.map(story => ({ id: story.storyId, title: story.title,
      summary: story.summary, url: story.canonicalUrl, source: source.name, kind: result.status.mode,
      publishedAt: story.publishedAt, discoveredAt: story.discoveredAt })), { now: Date.parse(checkedAt), limit: 30 });
    return saveAbsNewsDiscovery(this.db, { ...scope, source: { sourceId: source.id, sourceLabel: source.name, sourceKind } },
      this.key, checkedAt, { stories, rejectedCount, duplicateCount,
        statusCode: rejectedCount || !result.coverageComplete ? "discovery_partial" : "discovery_parsed",
        state: rejectedCount || !result.coverageComplete ? "partial" : "available",
        discoveryCuration: { engine: "control-center/industry-curation", selectedStoryIds: curated.selected.map(x => x.item.id),
          deferredStoryIds: curated.deferred.map(x => x.item.id), excludedStoryIds: curated.excluded.map(x => x.item.id),
          deduplicatedCount: curated.deduplicatedCount, grantsVerification: false },
      }, undefined, result.snapshot && rejectedCount === 0
        ? tx => saveDiscoveryBaseline(tx, this.config, this.key, result.snapshot, expected) : undefined);
  }
}
