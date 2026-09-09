import { sha256Digest } from "../../../security";
import { ProjectWorkspaceContractErrorV1, parseExactProjectWorkspaceV1 } from "../../../project-workspace/v1";
import { absNewsCollectionInputSchemaV1, absNewsFakeCollectionBatchSchemaV1 } from "./schemas";
import { buildAbsNewsStoryV1 } from "./story";
import type {
  AbsNewsCollectedItemV1,
  AbsNewsCollectionResultV1,
  AbsNewsFakeCollectionBatchV1,
  AbsNewsSourceEvidenceV1,
  AbsNewsStoryV1,
} from "./types";

const TRACKING_PARAMETER = /^(?:utm_[a-z0-9_]+|fbclid|gclid|mc_cid|mc_eid|ref|source)$/i;

export class AbsNewsInjectedFakeCollectorV1 {
  readonly #batch: AbsNewsFakeCollectionBatchV1;
  constructor(batchValue: unknown) {
    this.#batch = parseExactProjectWorkspaceV1(absNewsFakeCollectionBatchSchemaV1, batchValue) as AbsNewsFakeCollectionBatchV1;
  }
  collect(): AbsNewsFakeCollectionBatchV1 {
    return parseExactProjectWorkspaceV1(absNewsFakeCollectionBatchSchemaV1, this.#batch) as AbsNewsFakeCollectionBatchV1;
  }
}

function digestId(prefix: string, value: unknown): string {
  return `${prefix}.${sha256Digest(value).slice("sha256:".length, "sha256:".length + 24)}`;
}

function normalizedTitle(value: string): string {
  const normalized = value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  if (normalized.length < 3) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  return normalized;
}

export function canonicalizeAbsNewsDiscoveredUrlV1(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProjectWorkspaceContractErrorV1("invalid_input"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal") || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":")) {
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
  for (const key of [...url.searchParams.keys()]) {
    if (!TRACKING_PARAMETER.test(key)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    url.searchParams.delete(key);
  }
  url.hash = "";
  url.hostname = host;
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  const canonical = url.href;
  if (url.search || url.hash || url.username || url.password || url.port) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  return canonical;
}

function preferred(items: readonly AbsNewsCollectedItemV1[]): AbsNewsCollectedItemV1 {
  return [...items].sort((left, right) => {
    if (left.directlyVerified !== right.directlyVerified) return left.directlyVerified ? -1 : 1;
    const time = (right.publishedAt ?? right.observedAt).localeCompare(left.publishedAt ?? left.observedAt);
    return time || left.collectionItemId.localeCompare(right.collectionItemId);
  })[0]!;
}

function evidence(item: AbsNewsCollectedItemV1, canonicalUrl: string): AbsNewsSourceEvidenceV1 {
  const material = {
    sourceId: item.sourceId,
    sourceKind: item.sourceKind,
    sourceLabel: item.sourceLabel,
    canonicalUrl,
    observedAt: item.observedAt,
    collectionItemId: item.collectionItemId,
    contentDigest: item.contentDigest,
  };
  return {
    evidenceId: digestId("evidence.abs", material),
    sourceId: item.sourceId,
    sourceKind: item.sourceKind,
    sourceLabel: item.sourceLabel,
    canonicalUrl,
    observedAt: item.observedAt,
    evidenceDigest: sha256Digest(material),
    containsRawNewsletterBody: false,
    grantsNetworkAuthority: false,
  };
}

export function collectAbsNewsFakeSourcesV1(inputValue: unknown): AbsNewsCollectionResultV1 {
  const input = parseExactProjectWorkspaceV1(absNewsCollectionInputSchemaV1, inputValue) as {
    tenantId: string; workspaceId: string; projectId: string; batches: AbsNewsFakeCollectionBatchV1[]; collectedAt: string;
  };
  const scope = input;
  const batches = input.batches;
  if (new Set(batches.map((batch) => batch.batchId)).size !== batches.length) throw new ProjectWorkspaceContractErrorV1("replay_drift");
  const batchDigests = batches.map((batch) => sha256Digest(batch)).sort();
  const all = batches.flatMap((batch) => batch.items).map((item) => ({ item, canonicalUrl: canonicalizeAbsNewsDiscoveredUrlV1(item.discoveredUrl), titleKey: normalizedTitle(item.title) }));
  if (new Set(all.map(({ item }) => item.collectionItemId)).size !== all.length) throw new ProjectWorkspaceContractErrorV1("replay_drift");

  const clusters = new Map<string, typeof all>();
  for (const entry of all) {
    const key = entry.titleKey;
    const group = clusters.get(key) ?? [];
    group.push(entry);
    clusters.set(key, group);
  }
  const stories: AbsNewsStoryV1[] = [];
  for (const [titleKey, entries] of [...clusters].sort(([left], [right]) => left.localeCompare(right))) {
    const items = entries.map(({ item }) => item);
    const chosen = preferred(items);
    const canonicalUrl = entries.find(({ item }) => item.collectionItemId === chosen.collectionItemId)!.canonicalUrl;
    const verifiedItems = items.filter((item) => item.directlyVerified);
    const directlyVerified = verifiedItems.length > 0;
    const retainedEvidence = entries.map(({ item, canonicalUrl: itemUrl }) => evidence(item, itemUrl))
      .sort((left, right) => left.evidenceDigest.localeCompare(right.evidenceDigest));
    const distinctKinds = new Set(items.map((item) => item.sourceKind)).size;
    const priorityScore = Math.min(100, (directlyVerified ? 72 : 35) + Math.min(18, (items.length - 1) * 9) + Math.min(10, (distinctKinds - 1) * 5));
    const clusterId = digestId("cluster.abs", { titleKey });
    stories.push(buildAbsNewsStoryV1({
      storyId: digestId("story.abs", { titleKey }),
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      clusterId,
      queue: directlyVerified && priorityScore >= 70 ? "important_now" : "earlier",
      title: chosen.title,
      summary: chosen.summary,
      canonicalUrl,
      sourceLabel: chosen.sourceLabel,
      ...(chosen.publishedAt ? { publishedAt: chosen.publishedAt } : {}),
      discoveredAt: [...items].map((item) => item.observedAt).sort()[0]!,
      lastVerifiedAt: [...(directlyVerified ? verifiedItems : items)].map((item) => item.observedAt).sort().at(-1)!,
      verificationState: directlyVerified ? "verified" : "review_only",
      priorityScore,
      coverageCount: retainedEvidence.length,
      sourceEvidence: retainedEvidence,
      contentDigest: sha256Digest(items.map((item) => item.contentDigest).sort()),
    }));
  }
  stories.sort((left, right) => right.priorityScore - left.priorityScore || left.storyId.localeCompare(right.storyId));
  const material = {
    stories,
    batchDigests,
    inputItemCount: all.length,
    clusterCount: stories.length,
    duplicateCount: all.length - stories.length,
    verifiedCount: stories.filter((story) => story.verificationState === "verified").length,
    reviewOnlyCount: stories.filter((story) => story.verificationState === "review_only").length,
    collectedAt: scope.collectedAt,
    synthetic: true as const,
    networkUsed: false as const,
    grantsNetworkAuthority: false as const,
  };
  return { ...material, resultDigest: sha256Digest(material) };
}
