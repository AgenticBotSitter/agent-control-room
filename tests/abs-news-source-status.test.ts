import assert from "node:assert/strict";
import test from "node:test";
import { taskFixture } from "./helpers/web-task";
import { PostgresAbsNewsStoreV1 } from "../src/project-adapters/abs-news/v1/postgres-store";
import { decodeAbsFeed } from "../src/project-adapters/abs-news/v1/feed-decoder";

const checkedAt = "2026-09-07T12:00:00.000Z";
const status = { sourceId: "source:example", sourceKind: "rss", label: "Example news", mode: "configured",
  state: "available", safeStatusCode: "feed_parsed", checkedAt, lastSuccessfulAt: checkedAt,
  itemCount: 0, grantsNetworkAuthority: false };
async function setup() {
  const f = await taskFixture(), scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId }, key = new Uint8Array(32).fill(23);
  return { ...f, scope, key, open: (k = key) => new PostgresAbsNewsStoreV1(f.client, scope, k) };
}
test("source outcomes survive reopening, retain last success and do not turn failure into zero news", async t => {
  const f = await setup(); t.after(() => f.db.close());
  assert.equal((await f.open().saveSourceStatus(status)).replayed, false);
  const { itemCount: _count, ...base } = status; void _count;
  const failure = { ...base, state: "unavailable", safeStatusCode: "read_failed", checkedAt: "2026-09-07T13:00:00.000Z" };
  await f.open().saveCollection([], failure);
  assert.equal((await f.open().saveSourceStatus(status)).replayed, true);
  // Even a newly inserted older observation cannot replace a newer check.
  await f.open().saveSourceStatus({ ...status, safeStatusCode: "older_check", checkedAt: "2026-09-07T12:30:00.000Z" });
  const read = await f.open().listSourceStatuses();
  assert.deepEqual(read.statuses, [failure]); assert.equal(read.nextCursor, null);
  assert.equal(read.statuses[0].itemCount, undefined);
  await assert.rejects(f.open(new Uint8Array(32)).listSourceStatuses(), /integrity_failed/);
  await assert.rejects(f.open().saveSourceStatus({ ...failure, itemCount: 0 }), /invalid_input/);
  await assert.rejects(f.open().saveSourceStatus({ ...status, lastSuccessfulAt: "2026-09-08T12:00:00.000Z" }), /invalid_input/);
  for (const sql of ["DELETE FROM control_abs_source_observations", "TRUNCATE control_abs_source_observations", "UPDATE control_abs_source_observations SET source_id='other'"])
    await assert.rejects(f.client.query(sql));
});
test("source status and article batch commit together or neither commits", async t => {
  const f = await setup(); t.after(() => f.db.close());
  const decoded = await decodeAbsFeed({ ...f.scope, source: { sourceId: status.sourceId, sourceKind: "rss", sourceLabel: status.label, endpointUrl: "https://example.org/rss" },
    observedAt: checkedAt, maxBytes: 10000, maxItems: 10,
    xml: '<rss version="2.0"><channel><title>News</title><item><title>Example story</title><link>https://example.org/story</link></item></channel></rss>' });
  const observed = { ...status, itemCount: 1 };
  const failing = new PostgresAbsNewsStoreV1({ ...f.client, transaction: work => f.client.transaction(tx => work({ query: (sql, params) => {
    if (sql.includes("INSERT INTO control_abs_source_observations")) throw new Error("injected_status_failure");
    return tx.query(sql, params);
  } })) }, f.scope, f.key);
  await assert.rejects(failing.saveCollection(decoded.stories, observed), /injected_status_failure/);
  assert.equal((await f.open().listStories()).stories.length, 0);
  assert.equal((await f.open().listSourceStatuses()).statuses.length, 0);
  assert.equal((await f.open().saveCollection(decoded.stories, observed)).inserted, 1);
  const replay = await f.open().saveCollection(decoded.stories, observed);
  assert.equal(replay.replayed, 1); assert.equal(replay.statusReplayed, true);
  for (const changed of [{ ...observed, sourceId: "source:other" }, { ...observed, itemCount: 0 }, { ...observed, checkedAt: "2026-09-07T12:01:00.000Z" }])
    await assert.rejects(f.open().saveCollection(decoded.stories, changed), /invalid_input/);
});
test("source listing has explicit pagination and project separation", async t => {
  const f = await setup(); t.after(() => f.db.close());
  for (let i = 0; i < 51; i++) await f.open().saveSourceStatus({ ...status, sourceId: `source:${String(i).padStart(3, "0")}` });
  const page = await f.open().listSourceStatuses(); assert.equal(page.statuses.length, 50); assert.equal(page.nextCursor, "source:049");
  const next = await f.open().listSourceStatuses(page.nextCursor!); assert.equal(next.statuses.length, 1); assert.equal(next.nextCursor, null);
  const other = new PostgresAbsNewsStoreV1(f.client, { ...f.scope, projectId: "project:absent" }, f.key);
  assert.deepEqual((await other.listSourceStatuses()).statuses, []);
  await assert.rejects(other.saveSourceStatus(status), /not_found/);
});
