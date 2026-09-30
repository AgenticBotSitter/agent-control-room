// Real-PostgreSQL-shaped coverage for TaskAssignmentCoordinator.cancel(), run against the same
// disposable database fixture (and its production role, `f.db`) that task-assignment-scopes.test.ts
// already uses for assign/expire/revoke -- this file adds no new database or role wiring, it tests
// the one new coordinator method against the identical harness its siblings already trust.
import assert from "node:assert/strict";
import test from "node:test";
import { createAccessVerifier, WebAccessError } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";
import { binding, instant } from "./hermes-native-fixture";
import { request, token, trust } from "./helpers/web-foundation";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import type { DatabaseClient } from "../src/persistence/database";

/**
 * Test-only: moves a job/attempt straight to "running", exactly as the queue worker's own
 * completion recording does directly against these tables (see
 * `src/persistence/native-task-completion.ts`'s private `transition()`), bypassing
 * `CanonicalStore.transition()` on purpose -- that method deliberately refuses an uncoordinated
 * attempt transition and any job transition past "proposed", so a test cannot use it either
 * without reimplementing the coordination it is refusing to skip.
 */
async function forceRunning(db: DatabaseClient, tenantId: string, kind: "job" | "attempt", entityId: string,
  occurredAt: string, patch: Record<string, unknown> = {}) {
  const table = kind === "job" ? "control_jobs" : "control_attempts";
  const row = (await db.query<{ payload: Record<string, unknown>; version: number }>(
    `SELECT payload,version FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, entityId])).rows[0]!;
  const next = { ...row.payload, ...patch, state: "running", version: row.version + 1, updatedAt: occurredAt };
  await db.query(`UPDATE ${table} SET state='running',version=$1,payload=$2::jsonb,updated_at=$3 WHERE tenant_id=$4 AND id=$5`,
    [next.version, JSON.stringify(next), occurredAt, tenantId, entityId]);
  return next;
}

test("cancelling a queued reservation (attempt not yet running) marks it cancelled and releases the lease; idempotent", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const assigned = await f.assign();
  assert.equal(assigned.receipt.leaseState, "active");

  const cancelled = await f.coordinator.cancel(f.identity, binding.projectId, f.prepared.receipt.jobId, f.prepared.receipt.inputDigest);
  assert.equal(cancelled.replayed, false);
  assert.equal(cancelled.receipt.effect, "cancelled");
  if (cancelled.receipt.effect !== "cancelled") throw new Error("unreachable");
  assert.equal(cancelled.receipt.leaseId, assigned.receipt.leaseId);

  const job = (await f.db.query<{ state: string }>("SELECT state FROM control_jobs WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, f.prepared.receipt.jobId])).rows[0];
  assert.equal(job?.state, "cancelled", "a queued cancel must reach the canonical cancelled state, not just the receipt");
  const attempt = (await f.db.query<{ state: string }>("SELECT state FROM control_attempts WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, assigned.receipt.attemptId])).rows[0];
  assert.equal(attempt?.state, "cancelled", "the attempt must be recorded as cancelled, never failed");
  const lease = (await f.db.query<{ state: string }>("SELECT state FROM control_leases WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, assigned.receipt.leaseId])).rows[0];
  assert.equal(lease?.state, "revoked", "the claimed lease must be released");
  const scopeCount = (await f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_assignment_lease_scopes WHERE tenant_id=$1 AND lease_id=$2",
    [binding.tenantId, assigned.receipt.leaseId])).rows[0];
  assert.equal(scopeCount?.count, "0", "cancel must release the declared-scope rows along with the lease");

  const replay = await f.coordinator.cancel(f.identity, binding.projectId, f.prepared.receipt.jobId, f.prepared.receipt.inputDigest);
  assert.equal(replay.replayed, true, "cancelling an already-cancelled task must be a safe no-op, not an error");
  assert.deepEqual(replay.receipt, cancelled.receipt);
});

test("cancelling a running attempt records the owner's stop request without claiming it stopped; idempotent; leaves state untouched", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const assigned = await f.assign();
  const now = new Date(instant + 9000).toISOString();
  // Move the job and attempt to "running", exactly as the queue worker would once it actually
  // starts the native process -- this is the one state a live cancel cannot safely claim undone.
  await forceRunning(f.db, binding.tenantId, "job", f.prepared.receipt.jobId, now);
  await forceRunning(f.db, binding.tenantId, "attempt", assigned.receipt.attemptId, now, { startedAt: now });

  const stopRequested = await f.coordinator.cancel(f.identity, binding.projectId, f.prepared.receipt.jobId, f.prepared.receipt.inputDigest);
  assert.equal(stopRequested.replayed, false);
  assert.equal(stopRequested.receipt.effect, "stop_requested");
  if (stopRequested.receipt.effect !== "stop_requested") throw new Error("unreachable");
  assert.equal(stopRequested.receipt.confirmsNativeStop, false);
  assert.equal(stopRequested.receipt.attemptId, assigned.receipt.attemptId);

  // The mutation guard: a running attempt must NOT be silently claimed cancelled. If the
  // attempt.state === "running" branch in cancel() were ever removed or inverted, this is exactly
  // what would start failing -- the job/attempt/lease would jump straight to cancelled/revoked here.
  const job = (await f.db.query<{ state: string }>("SELECT state FROM control_jobs WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, f.prepared.receipt.jobId])).rows[0];
  assert.equal(job?.state, "running", "an uncertain in-flight effect must stay uncertain, never claimed as undone");
  const attempt = (await f.db.query<{ state: string }>("SELECT state FROM control_attempts WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, assigned.receipt.attemptId])).rows[0];
  assert.equal(attempt?.state, "running");
  const lease = (await f.db.query<{ state: string }>("SELECT state FROM control_leases WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, assigned.receipt.leaseId])).rows[0];
  assert.equal(lease?.state, "active", "a stop request alone must not release a lease the process may still hold");

  const replay = await f.coordinator.cancel(f.identity, binding.projectId, f.prepared.receipt.jobId, f.prepared.receipt.inputDigest);
  assert.equal(replay.replayed, true, "repeating a stop request while still running must replay, not record a second audit event");
  assert.deepEqual(replay.receipt, stopRequested.receipt);
});

test("cancel refuses a task with no assignment at all: nothing is queued yet to cancel", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  await assert.rejects(f.coordinator.cancel(f.identity, binding.projectId, f.prepared.receipt.jobId, f.prepared.receipt.inputDigest),
    (error: unknown) => error instanceof WebAccessError && error.code === "conflict",
    "an unassigned task has no reservation for cancel to release");
});

test("an operator without the owner role cannot cancel another actor's assignment", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  await f.assign();
  const identityAt = new Date(instant + 9000).toISOString();
  await f.db.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:cancel-operator',$1,'human','Cancel-test operator',$2,$3,'active',$4,$4)`,
    [binding.tenantId, trust.issuer, sha256Digest({ provider: trust.issuer, subject: "cancel-operator" }), identityAt]);
  await f.db.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:cancel-operator',$1,'identity:cancel-operator','operator',$2::jsonb,$3::jsonb,'low',false,false,$4,$4)`,
    [binding.tenantId, JSON.stringify(["*"]), JSON.stringify([binding.projectId]), identityAt]);
  const operatorJwt = token({ sub: "cancel-operator", iat: instant / 1000 - 60, exp: instant / 1000 + 600 });
  const operator = createAccessVerifier(f.accessTrust)(request(undefined, undefined, undefined, undefined, operatorJwt), instant + 9000);
  await assert.rejects(f.coordinator.cancel(operator, binding.projectId, f.prepared.receipt.jobId, f.prepared.receipt.inputDigest),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied",
    "only the owner role may cancel; a lesser-privileged operator must be refused, matching assign/expire/revoke");
});
