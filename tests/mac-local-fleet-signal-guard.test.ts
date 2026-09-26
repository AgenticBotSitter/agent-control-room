// Migration 0087: the real restricted task-coordinator role may record Mac-local
// readiness signals (capability/telemetry) for local worker nodes only, and can
// never rewrite signal history or signal for a remote node.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const NOW = "2026-09-25T12:00:00.000Z", LATER = "2026-09-25T12:05:00.000Z";
const digest = (c: string) => `sha256:${c.repeat(64)}`;

async function seed() {
  const pg = new PGlite();
  for (const file of (await readdir("db/migrations")).filter(f => f.endsWith(".sql")).sort())
    await pg.exec(await readFile(`db/migrations/${file}`, "utf8"));
  await pg.exec("INSERT INTO tenants(id,display_name) VALUES('tenant:a','A')");
  const node = async (id: string, payload: Record<string, unknown>) => pg.query(
    `INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
     VALUES($1,'tenant:a','active',1,$2,$3::jsonb,$4,$4)`,
    [id, `key:${id}`, JSON.stringify({ id, tenantId: "tenant:a", state: "active", version: 1, identityKeyId: `key:${id}`, ...payload }), NOW]);
  await node("mac-1.codex", { platform: "macos", policyVersion: "mac-local/v1", minimumProtocolVersion: "local-only" });
  await node("remote-1", { platform: "linux", policyVersion: "remote/v1", minimumProtocolVersion: "1" });
  await pg.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
  await pg.exec(`CREATE ROLE coordinator_login_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_task_coordinator TO coordinator_login_test;
    SET SESSION AUTHORIZATION coordinator_login_test;
    SET search_path = pg_catalog, public;`);
  return pg;
}

type Overrides = Partial<{ trust: string; expiresAt: string; source: string; nodeInPayload: string; sequenceInPayload: number }>;
const envelope = (nodeId: string, kind: string, sequence: number, o: Overrides = {}) => ({
  schemaVersion: "1.0.0", tenantId: "tenant:a", nodeId: o.nodeInPayload ?? nodeId, sequence: o.sequenceInPayload ?? sequence,
  observedAt: NOW, expiresAt: o.expiresAt ?? LATER, trust: o.trust ?? "reported", fingerprint: digest("b"), kind,
  source: o.source ?? (kind === "telemetry" ? "telemetry_port" : "probe_runner"), payload: {} });
const signal = (pg: PGlite, nodeId: string, kind: string, sequence: number, o: Overrides = {}) => pg.query(
  `INSERT INTO control_node_fleet_signals(tenant_id,node_id,signal_kind,signal_sequence,payload_digest,fingerprint,trust,observed_at,expires_at,payload,recorded_at)
   VALUES('tenant:a',$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$7)`,
  [nodeId, kind, sequence, digest("a"), digest("b"), o.trust ?? "reported", NOW, o.expiresAt ?? LATER, JSON.stringify(envelope(nodeId, kind, sequence, o))]);
const current = (pg: PGlite, nodeId: string, kind: string, sequence: number, o: Overrides = {}) => pg.query(
  `INSERT INTO control_node_fleet_current(tenant_id,node_id,signal_kind,signal_subject_id,signal_sequence,fingerprint,trust,observed_at,expires_at,payload)
   VALUES('tenant:a',$1,$2,'node',$3,$4,$5,$6,$7,$8::jsonb)
   ON CONFLICT (tenant_id,node_id,signal_kind,signal_subject_id) DO UPDATE SET signal_sequence=EXCLUDED.signal_sequence,
     fingerprint=EXCLUDED.fingerprint,trust=EXCLUDED.trust,observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,payload=EXCLUDED.payload`,
  [nodeId, kind, sequence, digest("b"), o.trust ?? "reported", NOW, o.expiresAt ?? LATER, JSON.stringify(envelope(nodeId, kind, sequence, o))]);

test("the coordinator records and refreshes a Mac-local worker's readiness signals", async t => {
  const pg = await seed(); t.after(() => pg.close());
  for (const kind of ["capability", "telemetry"]) {
    await signal(pg, "mac-1.codex", kind, 1); await current(pg, "mac-1.codex", kind, 1);
    await signal(pg, "mac-1.codex", kind, 2); await current(pg, "mac-1.codex", kind, 2);
  }
  await pg.query("SELECT signal_sequence FROM control_node_fleet_signals WHERE node_id='mac-1.codex' ORDER BY signal_sequence DESC LIMIT 1 FOR UPDATE");
  const rows = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM control_node_fleet_current WHERE node_id='mac-1.codex'");
  assert.equal(rows.rows[0]?.n, 2);
});

test("the coordinator cannot signal for a remote node", async t => {
  const pg = await seed(); t.after(() => pg.close());
  await assert.rejects(signal(pg, "remote-1", "capability", 1), /fleet signal rejected/);
  await assert.rejects(current(pg, "remote-1", "telemetry", 1), /fleet signal rejected/);
});

test("the coordinator cannot record discovery or benchmark signals", async t => {
  const pg = await seed(); t.after(() => pg.close());
  for (const kind of ["discovery", "benchmark"]) {
    await assert.rejects(signal(pg, "mac-1.codex", kind, 1), /fleet signal rejected/);
    await assert.rejects(current(pg, "mac-1.codex", kind, 1), /fleet signal rejected/);
  }
});

test("the coordinator cannot rewrite or delete signal history", async t => {
  const pg = await seed(); t.after(() => pg.close());
  await signal(pg, "mac-1.codex", "capability", 1);
  await assert.rejects(pg.query("UPDATE control_node_fleet_signals SET coordinator_lock=false WHERE node_id='mac-1.codex'"), /fleet signal rejected/);
  await assert.rejects(pg.query("UPDATE control_node_fleet_signals SET trust='blocked'"), /permission denied/);
  await assert.rejects(pg.query("DELETE FROM control_node_fleet_signals"), /permission denied/);
});

test("history signals are host-reported, short-lived, sequential, and match their stored envelope", async t => {
  const pg = await seed(); t.after(() => pg.close());
  for (const [name, attempt] of [
    ["verified trust", () => signal(pg, "mac-1.codex", "capability", 1, { trust: "verified" })],
    ["a lifetime over five minutes", () => signal(pg, "mac-1.codex", "capability", 1, { expiresAt: "2026-09-25T12:06:00.000Z" })],
    ["an envelope for another node", () => signal(pg, "mac-1.codex", "capability", 1, { nodeInPayload: "remote-1" })],
    ["an envelope with another sequence", () => signal(pg, "mac-1.codex", "capability", 1, { sequenceInPayload: 2 })],
    ["the wrong source", () => signal(pg, "mac-1.codex", "telemetry", 1, { source: "probe_runner" })],
    ["a skipped sequence", () => signal(pg, "mac-1.codex", "capability", 2)],
  ] as const) await assert.rejects(attempt(), /fleet signal rejected/, name);
  const rows = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM control_node_fleet_signals");
  assert.equal(rows.rows[0]?.n, 0);
});

test("the live row is only ever a newer copy of an appended history row", async t => {
  const pg = await seed(); t.after(() => pg.close());
  await assert.rejects(current(pg, "mac-1.codex", "capability", 1), /fleet signal rejected/, "no history yet");
  await signal(pg, "mac-1.codex", "capability", 1); await signal(pg, "mac-1.codex", "capability", 2);
  await current(pg, "mac-1.codex", "capability", 2);
  await assert.rejects(current(pg, "mac-1.codex", "capability", 1), /fleet signal rejected/, "moving backwards");
  await assert.rejects(pg.query("UPDATE control_node_fleet_current SET trust='verified'"), /fleet signal rejected/, "trust rewrite");
  await assert.rejects(pg.query(`UPDATE control_node_fleet_current SET signal_sequence=3,
    expires_at=expires_at + interval '30 days'`), /fleet signal rejected/, "expiry rewrite");
  await assert.rejects(pg.query(`UPDATE control_node_fleet_current SET signal_sequence=3,
    payload=jsonb_set(payload,'{sequence}','3')`), /fleet signal rejected/, "payload rewrite");
});

test("the coordinator may lock a worker delivery receipt but never change one (0088)", async t => {
  const pg = await seed(); t.after(() => pg.close());
  await pg.query("SELECT tenant_id FROM control_worker_delivery_receipts WHERE false FOR UPDATE");
  await assert.rejects(pg.query("UPDATE control_worker_delivery_receipts SET record=record WHERE false"), /permission denied/);
  await assert.rejects(pg.query("DELETE FROM control_worker_delivery_receipts WHERE false"), /permission denied/);
});
