import assert from "node:assert/strict";
import test from "node:test";

import { createRepositorySimulationDatabaseV1 } from "../src/persistence/database";
import { PostgresGitHubWebhookReplayStore } from "../src/github-app/v1";
import { readFile } from "node:fs/promises";

// Future relative to any supported build environment so the database's own
// clock_timestamp() can prove live-row deletion is refused deterministically.
const NOW = Date.parse("2099-09-15T08:00:00.000Z");
const HOUR = 60 * 60_000;

async function fixture(t: test.TestContext) {
  const database = await createRepositorySimulationDatabaseV1({ testOnly: true });
  t.after(async () => { await database.close(); });
  await database.exec(`CREATE FUNCTION reject_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'mutation rejected'; END $$;`);
  await database.exec(await readFile(new URL("../db/migrations/0078_github_webhook_replays.sql", import.meta.url), "utf8"));
  return database;
}

test("durable replay claims both keys atomically and survives store reconstruction", async (t) => {
  const database = await fixture(t);
  const keys = ["delivery:delivery-12345678", `signature:sha256=${"a".repeat(64)}`];
  assert.equal(await new PostgresGitHubWebhookReplayStore(database.client).claim(keys, NOW + HOUR, NOW), true);
  assert.equal(await new PostgresGitHubWebhookReplayStore(database.client).claim(keys, NOW + HOUR, NOW), false);
  const rows = await database.query<{ replay_key: string }>("SELECT replay_key FROM control_github_webhook_replays ORDER BY replay_key");
  assert.deepEqual(rows.rows.map((row) => row.replay_key), [...keys].sort());
});

test("one conflicting key rolls back every new key in the same claim", async (t) => {
  const database = await fixture(t);
  const store = new PostgresGitHubWebhookReplayStore(database.client);
  const signature = `signature:sha256=${"b".repeat(64)}`;
  assert.equal(await store.claim(["delivery:delivery-22345678", signature], NOW + HOUR, NOW), true);
  assert.equal(await store.claim(["delivery:delivery-32345678", signature], NOW + HOUR, NOW), false);
  const absent = await database.query("SELECT 1 FROM control_github_webhook_replays WHERE replay_key=$1", ["delivery:delivery-32345678"]);
  assert.equal(absent.rows.length, 0, "the non-conflicting half must roll back with the conflict");
});

test("simultaneous stores accept one identical delivery and reject the other", async (t) => {
  const database = await fixture(t);
  const keys = ["delivery:delivery-concurrent1", `signature:sha256=${"f".repeat(64)}`];
  const outcomes = await Promise.all([
    new PostgresGitHubWebhookReplayStore(database.client).claim(keys, NOW + HOUR, NOW),
    new PostgresGitHubWebhookReplayStore(database.client).claim(keys, NOW + HOUR, NOW),
  ]);
  assert.deepEqual(outcomes.sort(), [false, true]);
  const rows = await database.query("SELECT 1 FROM control_github_webhook_replays");
  assert.equal(rows.rows.length, 2);
});

test("expired claims may be pruned but live claims cannot be deleted or updated", async (t) => {
  const database = await fixture(t);
  const store = new PostgresGitHubWebhookReplayStore(database.client);
  const oldKeys = ["delivery:delivery-42345678", `signature:sha256=${"c".repeat(64)}`];
  assert.equal(await store.claim(oldKeys, NOW + HOUR, NOW), true);
  await assert.rejects(database.query("DELETE FROM control_github_webhook_replays WHERE replay_key=$1", [oldKeys[0]]),
    /live github webhook replay deletion rejected/u);
  await assert.rejects(database.query("UPDATE control_github_webhook_replays SET expires_at=$2 WHERE replay_key=$1",
    [oldKeys[0], new Date(NOW + 2 * HOUR).toISOString()]), /github webhook replay mutation rejected/u);
  const expired = ["delivery:delivery-expired1", `signature:sha256=${"e".repeat(64)}`];
  await database.query(`INSERT INTO control_github_webhook_replays(replay_key,recorded_at,expires_at)
    SELECT key,'2000-01-01T00:00:00Z'::timestamptz,'2000-01-02T00:00:00Z'::timestamptz
    FROM unnest($1::text[]) AS key`, [expired]);
  assert.equal(await store.claim(["delivery:delivery-52345678", `signature:sha256=${"d".repeat(64)}`], NOW + HOUR, NOW), true);
  const expiredRows = await database.query("SELECT 1 FROM control_github_webhook_replays WHERE replay_key = ANY($1::text[])", [expired]);
  assert.equal(expiredRows.rows.length, 0);
});

test("invalid, duplicate, oversized and reversed claims are refused before SQL", async (t) => {
  const database = await fixture(t);
  const store = new PostgresGitHubWebhookReplayStore(database.client);
  await assert.rejects(store.claim([], NOW + HOUR, NOW), /keys_invalid/u);
  await assert.rejects(store.claim(["delivery:same-key", "delivery:same-key"], NOW + HOUR, NOW), /keys_invalid/u);
  await assert.rejects(store.claim(["bad:key"], NOW + HOUR, NOW), /keys_invalid/u);
  await assert.rejects(store.claim(["delivery:12345678"], NOW, NOW), /time_invalid/u);
  await assert.rejects(store.claim(["delivery:12345678"], NOW + 8 * 24 * HOUR, NOW), /time_invalid/u);
});

test("database clock applies the duration despite a wildly skewed caller clock", async (t) => {
  const database = await fixture(t);
  const callerNow = Date.parse("2000-01-01T00:00:00.000Z");
  const before = Date.now();
  const store = new PostgresGitHubWebhookReplayStore(database.client);
  assert.equal(await store.claim(["delivery:delivery-clockskew", `signature:sha256=${"9".repeat(64)}`],
    callerNow + HOUR, callerNow), true);
  const result = await database.query<{ expires_at: string }>("SELECT expires_at FROM control_github_webhook_replays LIMIT 1");
  const expires = Date.parse(result.rows[0].expires_at);
  assert.ok(expires >= before + HOUR - 5_000 && expires <= Date.now() + HOUR + 5_000,
    "expiry must be database-current time plus the requested bounded duration");
});

test("production role is limited to replay claims and expired-row cleanup", async () => {
  const roles = await readFile(new URL("../db/roles/production_roles.sql", import.meta.url), "utf8");
  const grants = await readFile(new URL("../db/roles/production_table_grants.sql", import.meta.url), "utf8");
  const provision = await readFile(new URL("../db/roles/production_provision.sql", import.meta.url), "utf8");
  const applier = await readFile(new URL("../deploy/postgres/apply-migrations.mjs", import.meta.url), "utf8");
  assert.match(roles, /CREATE ROLE control_room_github_broker NOLOGIN/u);
  assert.match(provision, /CREATE ROLE control_room_github_broker NOLOGIN/u);
  assert.match(applier, /CREATE ROLE control_room_github_broker NOLOGIN/u);
  assert.match(grants, /GRANT SELECT, INSERT, DELETE ON control_github_webhook_replays TO control_room_github_broker/u);
  assert.match(grants, /REVOKE ALL ON control_github_webhook_replays FROM control_room_application, control_room_reader/u);
  assert.doesNotMatch(grants, /GRANT (?:UPDATE|TRUNCATE).*control_github_webhook_replays TO control_room_github_broker/u);
  assert.doesNotMatch(grants, /GRANT .*ON ALL TABLES.*control_room_github_broker/u);
});
