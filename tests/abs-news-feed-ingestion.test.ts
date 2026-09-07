import assert from "node:assert/strict";
import test from "node:test";
import { taskFixture } from "./helpers/web-task";
import { AbsFeedIngestionService } from "../src/project-adapters/abs-news/v1/feed-ingestion";
import { PostgresAbsNewsStoreV1 } from "../src/project-adapters/abs-news/v1/postgres-store";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const at = "2026-09-07T12:00:00.000Z", later = "2026-09-07T12:01:00.000Z";
const xml = (title = "Model news") => `<rss version="2.0"><channel><title>News</title><item><title>${title}</title><link>https://example.org/story</link></item></channel></rss>`;
async function setup() {
  const f = await taskFixture(), scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId }, key = new Uint8Array(32).fill(43);
  const config = { ...scope, source: { sourceId: "source:news", sourceLabel: "Example News", sourceKind: "rss", endpointUrl: "https://example.org/feed" }, maxItems: 50, maxBytes: 65536 };
  return { ...f, scope, key, config, open: () => new AbsFeedIngestionService(f.client, config, key), store: new PostgresAbsNewsStoreV1(f.client, scope, key) };
}
test("one ingestion path records parsed articles, safe failures and last successful collection", async t => {
  const f = await setup(); t.after(() => f.db.close());
  const first = await f.open().ingest(xml(), at);
  assert.equal(first.inserted, 1); assert.equal(first.status.lastSuccessfulAt, at); assert.equal(first.startsWork, false);
  const replay = await f.open().ingest(xml(), at); assert.equal(replay.statusReplayed, true); assert.equal(replay.replayed, 1);
  const failed = await f.open().recordReadFailure({ checkedAt: later, reason: "read_timed_out" });
  assert.equal(failed.status.lastSuccessfulAt, at); assert.equal(failed.status.itemCount, undefined); assert.equal(failed.rejectedCount, null);
  assert.equal((await f.open().recordReadFailure({ checkedAt: later, reason: "read_timed_out" })).statusReplayed, true);
  assert.equal((await f.store.listStories()).stories.length, 1);
  await assert.rejects(f.open().ingest(xml("Old content"), at), /news_observation_stale/);
  assert.equal((await f.store.listStories()).stories[0].title, "Model news");
  assert.equal((await f.client.query("SELECT * FROM control_jobs")).rows.length, 0);
});

test("collection receipt binds exact retained versions after newer observations arrive", async t => {
  const f = await setup(); t.after(() => f.db.close());
  const first = await f.open().ingest(xml(), at), replay = await f.open().ingest(xml(), at);
  assert.deepEqual(replay.receipt, first.receipt);
  await f.open().ingest(xml("New headline"), later);
  const result = await new PostgresAbsNewsStoreV1(f.client, f.scope, f.key).verifyCollectionReceipt(first.receipt);
  assert.equal(result.status.checkedAt, at); assert.equal(result.storyCount, 1); assert.equal(result.grantsNetworkAuthority, false);
  assert.equal((await f.store.getSourceStatus(first.receipt.sourceId, first.receipt.statusDigest))?.checkedAt, at);
  assert.equal((await f.store.getSourceStatus(first.receipt.sourceId))?.checkedAt, later);
  for (const changed of [{ ...first.receipt, stories: [] }, { ...first.receipt, sourceId: "source:other" },
    { ...first.receipt, projectId: "project:other" }, { ...first.receipt, startsWork: true }])
    await assert.rejects(f.store.verifyCollectionReceipt(changed));
  await assert.rejects(new PostgresAbsNewsStoreV1(f.client, f.scope, new Uint8Array(32).fill(44)).verifyCollectionReceipt(first.receipt));
});

test("receipt verification refuses missing retained data and preserves unsuccessful source state", async t => {
  const f = await setup(); t.after(() => f.db.close());
  const saved = await f.open().ingest(xml(), at);
  for (const missing of ["control_abs_story_versions", "control_abs_source_observations"]) {
    const session = (tx: DatabaseSession): DatabaseSession => ({ query: <T>(sql: string, values?: unknown[]) =>
      sql.includes(`FROM ${missing}`) ? Promise.resolve({ rows: [] as T[] }) : tx.query<T>(sql, values) });
    const db: DatabaseClient = { query: f.client.query.bind(f.client), transaction: work => f.client.transaction(tx => work(session(tx))),
      transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work(session(tx)), check) };
    await assert.rejects(new PostgresAbsNewsStoreV1(db, f.scope, f.key).verifyCollectionReceipt(saved.receipt));
  }
  const empty = await f.open().ingest('<rss version="2.0"><channel><title>Empty feed</title></channel></rss>', "2026-09-07T12:00:30.000Z");
  const checkedEmpty = await f.store.verifyCollectionReceipt(empty.receipt);
  assert.equal(checkedEmpty.status.state, "available"); assert.equal(checkedEmpty.status.itemCount, 0);
  const failed = await f.open().recordReadFailure({ checkedAt: later, reason: "read_failed" });
  const checked = await f.store.verifyCollectionReceipt(failed.receipt);
  assert.equal(checked.status.state, "unavailable"); assert.equal(checked.storyCount, 0);
  assert.equal(checked.status.itemCount, undefined);
});
test("invalid and partial feeds retain honest outcomes without silently claiming a full successful check", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await f.open().ingest(xml(), at);
  const failed = await f.open().ingest("<!DOCTYPE rss><rss>", later);
  assert.equal(failed.status.state, "unavailable"); assert.equal(failed.status.safeStatusCode, "invalid_feed");
  assert.equal(failed.status.lastSuccessfulAt, at); assert.equal(failed.status.itemCount, undefined);
  const partial = await f.open().ingest(xml().replace("</channel>", "<item><title>No link</title></item></channel>"), "2026-09-07T12:02:00.000Z");
  assert.equal(partial.status.state, "partial"); assert.equal(partial.rejectedCount, 1); assert.equal(partial.status.lastSuccessfulAt, at);
  await assert.rejects(f.open().recordReadFailure({ checkedAt: later, reason: "raw_private_error" }));
});
test("database failure remains a storage failure and cannot be relabeled a feed failure", async t => {
  const f = await setup(); t.after(() => f.db.close());
  const broken = new AbsFeedIngestionService({ ...f.client, transaction: async () => { throw new Error("injected_database_unavailable"); } }, f.config, f.key);
  await assert.rejects(broken.ingest(xml(), at), /injected_database_unavailable/);
  assert.equal((await f.store.listSourceStatuses()).statuses.length, 0);
  assert.equal((await f.store.listStories()).stories.length, 0);
});

test("an older observation from another source cannot replace newer canonical article content", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await f.open().ingest(xml("Newer headline"), later);
  const other = new AbsFeedIngestionService(f.client, { ...f.config, source: { ...f.config.source, sourceId: "source:other", sourceLabel: "Other News" } }, f.key);
  await assert.rejects(other.ingest(xml("Older headline"), at), /news_observation_stale/);
  assert.equal((await f.store.listStories()).stories[0].title, "Newer headline");
  assert.equal(await f.store.getSourceStatus("source:other"), undefined);
  assert.equal((await f.store.listSourceStatuses()).statuses.length, 1);
});
