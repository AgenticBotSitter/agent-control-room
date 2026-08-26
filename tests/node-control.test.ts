import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { NodeControlError, NodeControlService } from "../src/node-control/index.ts";
import { adaptPglite } from "../src/persistence/database.ts";

const t0 = "2026-08-26T18:00:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;

async function fixture(state: "active" | "draining" | "offline" = "active") {
  const db = new PGlite();
  const files = (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await db.exec(await readFile(resolve("db/migrations", file), "utf8"));
  await db.query(`INSERT INTO tenants (id,display_name) VALUES ('tenant:owner','Owner')`);
  const node = {
    contractVersion: "control-room-domain/v1",
    kind: "node",
    id: "node:controlled",
    tenantId: "tenant:owner",
    displayName: "Controlled node",
    state,
    platform: "linux",
    architecture: "x64",
    identityKeyId: "key:controlled",
    hardwareFingerprint: hashA,
    softwareFingerprint: hashB,
    policyVersion: "1.0.0",
    minimumProtocolVersion: "control-room-node/v1",
    enrolledAt: t0,
    version: 4,
    createdAt: t0,
    updatedAt: t0,
  };
  await db.query(
    `INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7)`,
    [node.id,node.tenantId,node.state,node.version,node.identityKeyId,JSON.stringify(node),t0],
  );
  return { db, service: new NodeControlService(adaptPglite(db)) };
}

function request(operation: "request_drain" | "request_resume" | "request_quarantine" = "request_drain") {
  return {
    tenantId: "tenant:owner",
    nodeId: "node:controlled",
    operation,
    expectedNodeVersion: 4,
    actorId: "identity:owner",
    idempotencyKey: `operation-${operation}-0001`,
    requestedAt: t0,
    ...(operation === "request_quarantine" ? { safeReasonCode: "security_review" } : {}),
  } as const;
}

test("authenticated intent is version-bound, audited, and does not claim the node changed", async () => {
  const { db, service } = await fixture();
  const created = await service.request(request());
  assert.equal(created.state, "requested");
  assert.equal(created.replayed, false);
  const node = await db.query<{ state: string; version: number }>(
    `SELECT state,version FROM control_nodes WHERE id='node:controlled'`,
  );
  assert.deepEqual(node.rows[0], { state: "active", version: 4 });
  const stored = await db.query<{ operation: string; expected_node_version: number; state: string }>(
    `SELECT operation,expected_node_version,state FROM control_node_operation_requests WHERE id=$1`, [created.requestId],
  );
  assert.deepEqual(stored.rows[0], { operation: "request_drain", expected_node_version: 4, state: "requested" });
  const outbox = await db.query<{ topic: string; aggregate_id: string; status: string; payload: { requestId: string; desiredState: string } }>(
    `SELECT topic,aggregate_id,status,payload FROM control_outbox WHERE aggregate_id='node:controlled'`,
  );
  assert.deepEqual(outbox.rows[0], {
    topic: "node.operation.request",
    aggregate_id: "node:controlled",
    status: "pending",
    payload: { ...outbox.rows[0].payload, requestId: created.requestId, desiredState: "draining" },
  });
  const audit = await db.query<{ action: string; target_id: string }>(
    `SELECT action,target_id FROM audit_events WHERE id=$1`, [`audit:${created.requestId}`],
  );
  assert.deepEqual(audit.rows[0], { action: "node.operation.requested", target_id: "node:controlled" });
  await db.close();
});

test("exact retry replays one request while changed content and a second pending operation fail closed", async () => {
  const { db, service } = await fixture();
  const first = await service.request(request());
  const replay = await service.request(request());
  assert.equal(replay.requestId, first.requestId);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    service.request({ ...request(), expectedNodeVersion: 3 }),
    (error: unknown) => error instanceof NodeControlError && error.safeCode === "idempotency_conflict",
  );
  await assert.rejects(
    service.request({ ...request("request_quarantine"), idempotencyKey: "operation-quarantine-0002" }),
    (error: unknown) => error instanceof NodeControlError && error.safeCode === "operation_not_allowed",
  );
  const count = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM control_node_operation_requests`);
  assert.equal(count.rows[0].count, 1);
  await db.close();
});

test("stale versions, illegal state transitions, and unreasoned quarantine requests are rejected", async () => {
  const active = await fixture();
  await assert.rejects(
    active.service.request({ ...request(), expectedNodeVersion: 3, idempotencyKey: "stale-version-0001" }),
    (error: unknown) => error instanceof NodeControlError && error.safeCode === "stale_node_version",
  );
  await assert.rejects(
    active.service.request({ ...request("request_quarantine"), safeReasonCode: undefined }),
    (error: unknown) => error instanceof NodeControlError && error.safeCode === "invalid_request",
  );
  await active.db.close();

  const draining = await fixture("draining");
  await assert.rejects(
    draining.service.request(request("request_drain")),
    (error: unknown) => error instanceof NodeControlError && error.safeCode === "operation_not_allowed",
  );
  assert.equal((await draining.service.request(request("request_resume"))).state, "requested");
  await draining.db.close();
});

test("only an exact node acknowledgement applies the requested state and version", async () => {
  const { db, service } = await fixture();
  const requested = await service.request(request());
  const acknowledgement = {
    tenantId: "tenant:owner",
    nodeId: "node:controlled",
    requestId: requested.requestId,
    acknowledgementId: "ack:drain:0001",
    disposition: "applied" as const,
    acknowledgedAt: "2026-08-26T18:01:00.000Z",
  };
  const applied = await service.acknowledge(acknowledgement);
  assert.deepEqual(applied, {
    requestId: requested.requestId,
    nodeId: "node:controlled",
    state: "applied",
    applied: true,
    resultingNodeVersion: 5,
    replayed: false,
  });
  assert.deepEqual(await service.acknowledge(acknowledgement), { ...applied, replayed: true });
  await assert.rejects(
    service.acknowledge({ ...acknowledgement, acknowledgementId: "ack:changed:0002" }),
    (error: unknown) => error instanceof NodeControlError && error.safeCode === "idempotency_conflict",
  );
  const node = await db.query<{ state: string; version: number; payload: { state: string; version: number } }>(
    `SELECT state,version,payload FROM control_nodes WHERE id='node:controlled'`,
  );
  assert.deepEqual(node.rows[0], { state: "draining", version: 5, payload: { ...node.rows[0].payload, state: "draining", version: 5 } });
  const audit = await db.query<{ action: string }>(`SELECT action FROM audit_events WHERE id='audit:ack:drain:0001'`);
  assert.deepEqual(audit.rows[0], { action: "node.operation.applied" });
  await db.close();
});

test("rejection and stale confirmation never mutate node state", async () => {
  const rejectedFixture = await fixture();
  const rejectedRequest = await rejectedFixture.service.request(request());
  const rejected = await rejectedFixture.service.acknowledge({
    tenantId: "tenant:owner", nodeId: "node:controlled", requestId: rejectedRequest.requestId,
    acknowledgementId: "ack:rejected:0001", disposition: "rejected", safeResultCode: "local_policy_denied",
    acknowledgedAt: "2026-08-26T18:01:00.000Z",
  });
  assert.equal(rejected.applied, false);
  assert.equal(rejected.safeResultCode, "local_policy_denied");
  assert.deepEqual((await rejectedFixture.db.query<{ state: string; version: number }>(
    `SELECT state,version FROM control_nodes WHERE id='node:controlled'`,
  )).rows[0], { state: "active", version: 4 });
  await rejectedFixture.db.close();

  const staleFixture = await fixture();
  const staleRequest = await staleFixture.service.request(request());
  await staleFixture.db.query(`UPDATE control_nodes SET version=5,payload=jsonb_set(payload,'{version}','5'::jsonb) WHERE id='node:controlled'`);
  const stale = await staleFixture.service.acknowledge({
    tenantId: "tenant:owner", nodeId: "node:controlled", requestId: staleRequest.requestId,
    acknowledgementId: "ack:stale:0001", disposition: "applied", acknowledgedAt: "2026-08-26T18:01:00.000Z",
  });
  assert.equal(stale.state, "rejected");
  assert.equal(stale.safeResultCode, "stale_node_version");
  assert.deepEqual((await staleFixture.db.query<{ state: string; version: number }>(
    `SELECT state,version FROM control_nodes WHERE id='node:controlled'`,
  )).rows[0], { state: "active", version: 5 });
  await staleFixture.db.close();
});
