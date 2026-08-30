import assert from "node:assert/strict";
import test from "node:test";
import {
  ABS_NEWS_PROJECT_ID_V1,
  ABS_NEWS_WORKSPACE_ID_V1,
  AbsNewsInjectedFakeCollectorV1,
  canonicalizeAbsNewsDiscoveredUrlV1,
  collectAbsNewsFakeSourcesV1,
} from "../src/project-adapters/abs-news/v1/index.ts";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const collectedAt = "2026-08-29T21:00:00.000Z";

function batch(sourceId: string, sourceKind: "rss" | "sitemap" | "newsletter", sourceLabel: string, items: Array<Record<string, unknown>>) {
  return {
    batchId: `batch.abs.${sourceKind}`, sourceId, sourceKind, sourceLabel, collectedAt,
    items: items.map((item, index) => ({
      collectionItemId: `collected.abs.${sourceKind}.${index + 1}`, sourceId, sourceKind, sourceLabel,
      observedAt: collectedAt, contentDigest: sha256Digest({ sourceId, index }), containsRawNewsletterBody: false,
      grantsNetworkAuthority: false, ...item,
    })),
    synthetic: true, networkUsed: false, grantsNetworkAuthority: false,
  };
}

function fixtures() {
  return [
    batch("source.abs.rss", "rss", "Injected RSS", [{ title: "Agent Runtime 2.0 Released", summary: "A verified runtime release from the canonical product page.", discoveredUrl: "https://example.com/releases/runtime-2?utm_source=feed#top", publishedAt: "2026-08-29T20:00:00.000Z", directlyVerified: true }]),
    batch("source.abs.newsletter", "newsletter", "Injected newsletter", [
      { title: "Agent Runtime 2.0 — Released!", summary: "A newsletter mention pointing to retained source evidence.", discoveredUrl: "https://news.example.com/runtime-2?mc_cid=abc", directlyVerified: false },
      { title: "Unconfirmed Model Partnership", summary: "A discovery-only item that still needs direct page verification.", discoveredUrl: "https://news.example.com/partnership", directlyVerified: false },
    ]),
    batch("source.abs.sitemap", "sitemap", "Injected sitemap", [{ title: "Local Model Setup Update", summary: "A directly verified documentation update.", discoveredUrl: "https://docs.example.com/guides/local-model/", directlyVerified: true }]),
  ];
}

test("CR9D-ABS-020 injected RSS, sitemap, and newsletter collectors expose no network path", () => {
  const collectors = fixtures().map((value) => new AbsNewsInjectedFakeCollectorV1(value));
  assert.deepEqual(collectors.map((collector) => collector.collect().sourceKind), ["rss", "newsletter", "sitemap"]);
  for (const collector of collectors) {
    assert.equal("endpoint" in collector, false);
    assert.equal("fetch" in collector, false);
  }
});

test("CR9D-ABS-020 canonicalizes tracking-only URLs, clusters duplicates, and preserves verification truth", () => {
  const batches = fixtures().map((value) => new AbsNewsInjectedFakeCollectorV1(value).collect());
  const result = collectAbsNewsFakeSourcesV1({ tenantId: "tenant.owner", workspaceId: ABS_NEWS_WORKSPACE_ID_V1, projectId: ABS_NEWS_PROJECT_ID_V1, batches, collectedAt });
  assert.equal(result.inputItemCount, 4);
  assert.equal(result.clusterCount, 3);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.verifiedCount, 2);
  assert.equal(result.reviewOnlyCount, 1);
  assert.equal(result.networkUsed, false);
  assert.equal(result.grantsNetworkAuthority, false);
  const clustered = result.stories.find((story) => story.title.includes("Runtime 2.0"))!;
  assert.equal(clustered.coverageCount, 2);
  assert.equal(clustered.verificationState, "verified");
  assert.equal(clustered.queue, "important_now");
  assert.equal(clustered.canonicalUrl, "https://example.com/releases/runtime-2");
  assert.equal(result.stories.find((story) => story.title.includes("Partnership"))?.verificationState, "review_only");
});

test("CR9D-ABS-020 canonicalization rejects semantic queries and private destinations", () => {
  assert.equal(canonicalizeAbsNewsDiscoveredUrlV1("https://EXAMPLE.com/story/?utm_source=x#part"), "https://example.com/story");
  for (const value of ["https://example.com/story?id=7", "https://localhost/story", "https://127.0.0.1/story", "https://user:pass@example.com/story"]) {
    assert.throws(() => canonicalizeAbsNewsDiscoveredUrlV1(value), ProjectWorkspaceContractErrorV1);
  }
});

test("CR9D-ABS-020 rejects proxied collection input without executing traps", () => {
  const candidate = observedProxy({ tenantId: "tenant.owner", workspaceId: ABS_NEWS_WORKSPACE_ID_V1, projectId: ABS_NEWS_PROJECT_ID_V1, batches: fixtures(), collectedAt }, "throwing");
  assert.throws(() => collectAbsNewsFakeSourcesV1(candidate.value), ProjectWorkspaceContractErrorV1);
  assert.equal(candidate.trapCount(), 0);
});
