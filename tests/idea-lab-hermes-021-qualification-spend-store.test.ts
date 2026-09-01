import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database.ts";
import { InMemoryRollbackCheckpointStoreV1, sha256Digest } from "../src/security/index.ts";
import {
  IdeaLabErrorV1,
  IdeaLabHermes021QualificationSpendDatabaseStoreV1,
} from "../src/idea-lab/v1/index.ts";

const tenantId = "tenant:qualification-owner";
const stateKey = new Uint8Array(32).fill(0x51);
const checkpointKey = new Uint8Array(32).fill(0x52);
const digest = (label: string) => sha256Digest({ label });

async function setup() {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  }
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ($1,$2)`, [tenantId, "Qualification Owner"]);
  const checkpoint = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const store = new IdeaLabHermes021QualificationSpendDatabaseStoreV1(adaptPglite(raw),
    { tenantId, stateKey, checkpointKey }, checkpoint);
  return { raw, checkpoint, store };
}

function claim(label = "one") {
  return { permitDigest: digest(`permit:${label}`), attemptId: `attempt:${label}`,
    markerDigest: digest(`marker:${label}`), claimedAt: "2026-09-01T10:04:00.000Z" };
}

test("CR12B-IDEA-110A durable spend store atomically claims once and makes exact replay inert", async () => {
  const target = await setup();
  try {
    const input = claim();
    const outcomes = await Promise.all([target.store.claim(input), target.store.claim(input)]);
    assert.deepEqual(outcomes.sort(), ["already_claimed", "claimed"]);
    assert.equal(await target.store.claim({ ...input, attemptId: "attempt:other" }), "conflict");
    const rows = await target.raw.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM control_idea_qualification_spend_events`);
    assert.equal(rows.rows[0]!.count, "1");
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-110A durable spend store enforces execution then cleanup chronology across reconstruction", async () => {
  const target = await setup();
  try {
    const input = claim();
    assert.equal(await target.store.claim(input), "claimed");
    await target.store.settle({ permitDigest: input.permitDigest, attemptId: input.attemptId,
      markerDigest: input.markerDigest, outcome: "execute_returned", settledAt: "2026-09-01T10:04:10.000Z" });
    const reopened = new IdeaLabHermes021QualificationSpendDatabaseStoreV1(adaptPglite(target.raw),
      { tenantId, stateKey, checkpointKey }, target.checkpoint);
    await reopened.settle({ permitDigest: input.permitDigest, attemptId: input.attemptId,
      markerDigest: input.markerDigest, outcome: "cleanup_completed", settledAt: "2026-09-01T10:04:20.000Z" });
    await assert.rejects(() => reopened.settle({ permitDigest: input.permitDigest, attemptId: input.attemptId,
      markerDigest: input.markerDigest, outcome: "cleanup_completed", settledAt: "2026-09-01T10:04:21.000Z" }),
    (error) => error instanceof IdeaLabErrorV1);
    await reopened.settle({ permitDigest: input.permitDigest, attemptId: input.attemptId,
      markerDigest: input.markerDigest, outcome: "cleanup_completed", settledAt: "2026-09-01T10:04:20.000Z" });
    const events = await target.raw.query<{ event_kind: string }>(`SELECT event_kind
      FROM control_idea_qualification_spend_events ORDER BY sequence`);
    assert.deepEqual(events.rows.map((row) => row.event_kind), ["claimed", "execute_returned", "cleanup_completed"]);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-110A durable spend store preserves terminal ambiguity and refuses illegal settlement order", async () => {
  const target = await setup();
  try {
    const ambiguous = claim("ambiguous"), illegal = claim("illegal");
    await target.store.claim(ambiguous);
    await target.store.settle({ permitDigest: ambiguous.permitDigest, attemptId: ambiguous.attemptId,
      markerDigest: ambiguous.markerDigest, outcome: "terminal_ambiguity", settledAt: "2026-09-01T10:04:10.000Z" });
    await target.store.settle({ permitDigest: ambiguous.permitDigest, attemptId: ambiguous.attemptId,
      markerDigest: ambiguous.markerDigest, outcome: "cleanup_uncertain", settledAt: "2026-09-01T10:04:20.000Z" });
    await target.store.claim(illegal);
    await assert.rejects(() => target.store.settle({ permitDigest: illegal.permitDigest, attemptId: illegal.attemptId,
      markerDigest: illegal.markerDigest, outcome: "cleanup_completed", settledAt: "2026-09-01T10:04:20.000Z" }),
    (error) => error instanceof IdeaLabErrorV1);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-110A durable spend store detects wrong integrity keys and rollback deletion", async () => {
  const target = await setup();
  try {
    const input = claim();
    await target.store.claim(input);
    const wrongKey = new IdeaLabHermes021QualificationSpendDatabaseStoreV1(adaptPglite(target.raw),
      { tenantId, stateKey: new Uint8Array(32).fill(0x61), checkpointKey }, target.checkpoint);
    await assert.rejects(() => wrongKey.claim(input), (error) => error instanceof IdeaLabErrorV1);
    await target.raw.exec(`DROP TRIGGER control_idea_qualification_spend_events_append_only
      ON control_idea_qualification_spend_events`);
    await target.raw.query(`DELETE FROM control_idea_qualification_spend_events WHERE tenant_id=$1 AND permit_digest=$2`,
      [tenantId, input.permitDigest]);
    await assert.rejects(() => target.store.claim(input), (error) => error instanceof IdeaLabErrorV1);
  } finally { await target.raw.close(); }
});

test("CR12B-IDEA-110A migration keeps every qualification spend row append-only", async () => {
  const source = await readFile("db/migrations/0032_cr12b_idea_qualification_spends.sql", "utf8");
  assert.match(source, /BEFORE UPDATE OR DELETE/);
  assert.match(source, /BEFORE TRUNCATE/);
  assert.match(source, /UNIQUE INDEX uq_control_idea_qualification_attempt/);
  assert.match(source, /UNIQUE INDEX uq_control_idea_qualification_marker/);
});
