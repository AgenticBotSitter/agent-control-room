import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ABS_NEWS_PROJECT_ID_V1,
  ABS_NEWS_WORKSPACE_ID_V1,
  AbsNewsFakeIngestionServiceV1,
  AbsNewsInjectedFakeCollectorV1,
  SqliteAbsNewsStoreV1,
  buildAbsNewsSyntheticWorkspaceV1,
  buildAbsNewsWorkOrderProposalV1,
  selectAbsNewsDigestV1,
} from "../src/project-adapters/abs-news/v1/index.ts";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";

const scope = { tenantId: "tenant.owner", workspaceId: ABS_NEWS_WORKSPACE_ID_V1, projectId: ABS_NEWS_PROJECT_ID_V1 };
const key = new Uint8Array(32).fill(23);
const t0 = "2026-08-29T21:00:00.000Z", t1 = "2026-08-29T21:01:00.000Z", t2 = "2026-08-29T21:02:00.000Z";

async function location() {
  const directory = await mkdtemp(join(tmpdir(), "abs-news-store-"));
  return { directory, path: join(directory, "store.sqlite") };
}

test("CR14F digest reads current verified store state without changing queues or history", async t => {
  const store = new SqliteAbsNewsStoreV1(":memory:", scope, { integrityKey: key, mode: "create" });
  t.after(() => store.close());
  const fixture = buildAbsNewsSyntheticWorkspaceV1();
  store.ingestStories(fixture.stories, t0);
  const options = { nowMs: Date.parse(t0), windowHours: 168, limit: 10, maxPerSource: 10, minimumScore: 0 };
  const before = store.listStories();
  const selected = store.selectDigest(options);
  assert.deepEqual(selected, selectAbsNewsDigestV1(before, options));
  assert.ok(selected.selectedStoryIds.length > 0);
  assert.deepEqual(store.listStories(), before);
  const storyId = selected.selectedStoryIds[0]!;
  store.changeQueue({ storyId, toQueue: "archive", changedByActorDigest: sha256Digest({ actor: "owner" }), changedAt: t1 });
  assert.ok(!store.selectDigest(options).selectedStoryIds.includes(storyId));
  assert.ok(store.selectDigest(options).deferredStoryIds.includes(storyId));
});

test("CR9D-ABS-010/020 fake ingestion atomically persists clustered stories and honest source status", async () => {
  const target = await location();
  try {
    const store = new SqliteAbsNewsStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
    const makeBatch = (kind: "rss" | "newsletter", verified: boolean) => ({
      batchId: `batch.abs.vertical.${kind}`, sourceId: `source.abs.vertical.${kind}`, sourceKind: kind, sourceLabel: `Injected ${kind}`, collectedAt: t0,
      items: [{ collectionItemId: `item.abs.vertical.${kind}`, sourceId: `source.abs.vertical.${kind}`, sourceKind: kind, sourceLabel: `Injected ${kind}`, title: "Shared Synthetic Release", summary: "A duplicate synthetic release used for the local ingestion vertical.", discoveredUrl: `https://${kind}.example.com/shared-release`, observedAt: t0, directlyVerified: verified, contentDigest: sha256Digest({ kind }), containsRawNewsletterBody: false, grantsNetworkAuthority: false }],
      synthetic: true, networkUsed: false, grantsNetworkAuthority: false,
    });
    const service = new AbsNewsFakeIngestionServiceV1(store, [new AbsNewsInjectedFakeCollectorV1(makeBatch("rss", true)), new AbsNewsInjectedFakeCollectorV1(makeBatch("newsletter", false))]);
    const first = service.run({ ...scope, collectedAt: t0 });
    assert.deepEqual({ inserted: first.insertedStoryCount, replayed: first.replayedStoryCount, sources: first.sourceStatusCount, network: first.networkUsed, work: first.createsWorkItem }, { inserted: 1, replayed: 0, sources: 2, network: false, work: false });
    assert.equal(store.listStories()[0]?.coverageCount, 2);
    assert.equal(store.listSourceStatuses().length, 2);
    const replay = service.run({ ...scope, collectedAt: t0 });
    assert.deepEqual({ inserted: replay.insertedStoryCount, replayed: replay.replayedStoryCount }, { inserted: 0, replayed: 1 });
    store.close();
  } finally { await rm(target.directory, { recursive: true, force: true }); }
});

test("CR9D-ABS-010 durable store survives restart with exact story, source, queue, and proposal history", async () => {
  const target = await location();
  try {
    const fixture = buildAbsNewsSyntheticWorkspaceV1();
    let store = new SqliteAbsNewsStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
    assert.deepEqual(store.ingestStories(fixture.stories, t0), { inserted: 3, replayed: 0, stories: fixture.stories });
    assert.equal(store.ingestStories(fixture.stories, t0).replayed, 3);
    assert.equal(store.saveSourceStatus(fixture.workspace.sourceStatuses[0], t0).replayed, false);
    assert.equal(store.saveSourceStatus(fixture.workspace.sourceStatuses[0], t0).replayed, true);
    const changed = store.changeQueue({ storyId: fixture.stories[0]!.storyId, toQueue: "archive", changedByActorDigest: sha256Digest({ actor: "owner" }), changedAt: t1 });
    assert.equal(changed.story.queue, "archive");
    const proposal = buildAbsNewsWorkOrderProposalV1({ proposalId: "proposal.abs.store.1", ...scope, story: store.getStory(fixture.stories[1]!.storyId), actionId: "setup_guide", requestedTitle: "Prepare the local model guide", goal: "Produce an exact technical setup guide from retained evidence.", requestedPlatform: "any", requestedByActorDigest: sha256Digest({ actor: "owner" }), requestedAt: t2 });
    assert.equal(store.saveProposal(proposal).replayed, false);
    const semanticReplay = buildAbsNewsWorkOrderProposalV1({ proposalId: "proposal.abs.store.replay", ...scope, story: store.getStory(fixture.stories[1]!.storyId), actionId: "setup_guide", requestedTitle: "Prepare the local model guide", goal: "Produce an exact technical setup guide from retained evidence.", requestedPlatform: "any", requestedByActorDigest: sha256Digest({ actor: "owner" }), requestedAt: t2 });
    assert.equal(store.saveProposal(semanticReplay).proposal.proposalId, proposal.proposalId);
    const before = store.verifyIntegrity();
    assert.equal(before.recordCount, 7);
    store.close();

    store = new SqliteAbsNewsStoreV1(target.path, scope, { integrityKey: key, mode: "open" });
    assert.equal(store.listStories({ queue: "archive" }).length, 1);
    assert.equal(store.listQueueHistory().length, 1);
    assert.equal(store.listProposals().length, 1);
    assert.equal(store.listSourceStatuses().length, 1);
    assert.deepEqual(store.verifyIntegrity(), before);
    store.close();
  } finally { await rm(target.directory, { recursive: true, force: true }); }
});

test("CR9D-ABS-010 store detects row deletion and rejects cross-scope data", async () => {
  const target = await location();
  try {
    const fixture = buildAbsNewsSyntheticWorkspaceV1();
    const store = new SqliteAbsNewsStoreV1(target.path, scope, { integrityKey: key, mode: "create" });
    assert.throws(() => store.ingestStories([{ ...fixture.stories[0], projectId: "project.other" }], t0), ProjectWorkspaceContractErrorV1);
    store.ingestStories([fixture.stories[0]], t0);
    const attacker = new DatabaseSync(target.path);
    attacker.exec("DELETE FROM abs_news_story_versions");
    attacker.close();
    assert.throws(() => store.verifyIntegrity(), (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "integrity_failed");
    store.close();
  } finally { await rm(target.directory, { recursive: true, force: true }); }
});
