import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExecutionStateConflictError,
  SqliteExecutionStateStore,
  applyExecutionAuthorityEvent,
  calculateEffectiveExecutionDeadline,
  classifyExecutionRecovery,
  computeExecutionId,
  createExecutionAuthoritySnapshot,
  observeExecutionDeadline,
  recheckBeforeExternalEffect,
  type ExecutionAuthorityEventV1,
  type ExecutionAuthoritySnapshotV1,
  type ExecutionDeadlineSourcesV1,
} from "../src/node-policy/v1/index.ts";

const admittedAt = "2026-08-23T12:00:00.000Z";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const identity = {
  tenantId: "tenant:owner", nodeId: "node:marvin", projectId: "project:alpha", jobId: "job:alpha",
  attemptId: "attempt:alpha:1", operationDigest: digest("a"),
};

function sources(overrides: Partial<ExecutionDeadlineSourcesV1> = {}): ExecutionDeadlineSourcesV1 {
  return {
    admittedAt, ceilingDurationSeconds: 3_600, authorityDurationSeconds: 3_600,
    authorityExpiresAt: "2026-08-23T13:00:00.000Z", leaseExpiresAt: "2026-08-23T12:30:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<ExecutionDeadlineSourcesV1> = {}): ExecutionAuthoritySnapshotV1 {
  return createExecutionAuthoritySnapshot({
    executionId: computeExecutionId("admission:alpha", identity.operationDigest), admissionId: "admission:alpha",
    identity, authorityDigest: digest("b"), deadlineSources: sources(overrides), leaseEpoch: 1, createdAt: admittedAt,
  });
}

function event(kind: ExecutionAuthorityEventV1["kind"], occurredAt: string, extra: Record<string, unknown> = {}): ExecutionAuthorityEventV1 {
  return { eventId: `event:${kind}:${occurredAt}`, kind, occurredAt, ...extra } as ExecutionAuthorityEventV1;
}

test("effective deadline is the earliest strict clamp and records every tied limiting factor", () => {
  const deadline = calculateEffectiveExecutionDeadline(sources({
    ceilingDurationSeconds: 600, authorityDurationSeconds: 900,
    leaseExpiresAt: "2026-08-23T12:40:00.000Z", approvalExpiresAt: "2026-08-23T12:10:00.000Z",
    reservationExpiresAt: "2026-08-23T12:10:00.000Z",
  }));
  assert.equal(deadline.effectiveDeadline, "2026-08-23T12:10:00.000Z");
  assert.deepEqual(deadline.limitingFactors, ["duration", "approval", "reservation"]);
  assert.throws(() => calculateEffectiveExecutionDeadline(sources({ leaseExpiresAt: admittedAt })), /after admission/);
  assert.throws(() => calculateEffectiveExecutionDeadline(sources({ ceilingDurationSeconds: 0 })), /positive safe integer/);
});

test("deadline observations are exact at the boundary and the advisory threshold is explicit", () => {
  const executing = applyExecutionAuthorityEvent(snapshot(), event("start", "2026-08-23T12:00:01.000Z")).snapshot;
  assert.deepEqual(observeExecutionDeadline(executing, "2026-08-23T12:29:00.000Z"), {
    kind: "none", observedAt: "2026-08-23T12:29:00.000Z", remainingMilliseconds: 60_000,
  });
  assert.equal(observeExecutionDeadline(executing, "2026-08-23T12:29:00.000Z", 60).kind, "expiring_soon");
  assert.deepEqual(observeExecutionDeadline(executing, "2026-08-23T12:30:00.000Z"), {
    kind: "deadline_crossed", observedAt: "2026-08-23T12:30:00.000Z", latenessMilliseconds: 0, requestCancellation: true,
  });
  assert.equal(observeExecutionDeadline(executing, "2026-08-23T12:30:02.000Z").kind, "deadline_crossed");
});

test("deadline crossing revokes authority and requests cancellation only for in-flight work", () => {
  const admitted = snapshot();
  const idleExpiry = applyExecutionAuthorityEvent(admitted, event("deadline_crossed", "2026-08-23T12:30:00.000Z", { latenessMilliseconds: 0 }));
  assert.equal(idleExpiry.snapshot.state, "expired");
  assert.equal(idleExpiry.requestCancellation, false);
  assert.equal(classifyExecutionRecovery(idleExpiry.snapshot), "remain_expired");

  const executing = applyExecutionAuthorityEvent(snapshot(), event("start", "2026-08-23T12:00:01.000Z")).snapshot;
  const activeExpiry = applyExecutionAuthorityEvent(executing, event("deadline_crossed", "2026-08-23T12:30:05.000Z", { latenessMilliseconds: 5_000 }));
  assert.equal(activeExpiry.snapshot.state, "expired");
  assert.equal(activeExpiry.requestCancellation, true);
  assert.equal(activeExpiry.snapshot.cancellationRequestedAt, "2026-08-23T12:30:05.000Z");
  assert.equal(classifyExecutionRecovery(activeExpiry.snapshot), "request_cancellation");
  assert.throws(() => applyExecutionAuthorityEvent(activeExpiry.snapshot, event("start", "2026-08-23T12:30:06.000Z")), /Invalid execution transition/);
  assert.throws(() => applyExecutionAuthorityEvent(executing, event("deadline_crossed", "2026-08-23T12:30:05.000Z", { latenessMilliseconds: 4_999 })), /does not match/);
  assert.throws(() => applyExecutionAuthorityEvent(executing, event("completed", "2026-08-23T12:30:00.000Z")), /cannot complete/);
});

test("renewal may narrow or extend only the lease clamp and never resurrects expired authority", () => {
  const initial = snapshot({ leaseExpiresAt: "2026-08-23T12:10:00.000Z" });
  const renewed = applyExecutionAuthorityEvent(initial, event("lease_renewed", "2026-08-23T12:09:00.000Z", {
    authorityDigest: digest("b"), leaseEpoch: 2, leaseExpiresAt: "2026-08-23T12:45:00.000Z",
  })).snapshot;
  assert.equal(renewed.leaseEpoch, 2);
  assert.equal(renewed.deadline.effectiveDeadline, "2026-08-23T12:45:00.000Z");
  assert.throws(() => applyExecutionAuthorityEvent(renewed, event("lease_renewed", "2026-08-23T12:09:01.000Z", {
    authorityDigest: digest("b"), leaseEpoch: 2, leaseExpiresAt: "2026-08-23T12:50:00.000Z",
  })), /epoch must increase/);
  assert.throws(() => applyExecutionAuthorityEvent(renewed, event("lease_renewed", "2026-08-23T12:09:02.000Z", {
    authorityDigest: digest("c"), leaseEpoch: 3, leaseExpiresAt: "2026-08-23T12:50:00.000Z",
  })), /replace authority/);
  const expired = applyExecutionAuthorityEvent(renewed, event("deadline_crossed", "2026-08-23T12:45:00.000Z", { latenessMilliseconds: 0 })).snapshot;
  assert.throws(() => applyExecutionAuthorityEvent(expired, event("lease_renewed", "2026-08-23T12:45:01.000Z", {
    authorityDigest: digest("b"), leaseEpoch: 3, leaseExpiresAt: "2026-08-23T12:55:00.000Z",
  })), /Invalid execution transition/);
});

test("pre-effect recheck independently fails closed for every mutable authority condition", () => {
  const executing = applyExecutionAuthorityEvent(snapshot(), event("start", "2026-08-23T12:00:01.000Z")).snapshot;
  const base = {
    snapshot: executing, now: "2026-08-23T12:01:00.000Z", currentOperationDigest: identity.operationDigest,
    keyAvailability: "available" as const, paused: false, effectClaim: "claimed" as const,
  };
  const detail = (result: ReturnType<typeof recheckBeforeExternalEffect>) => {
    assert.equal(result.allowed, false);
    return result.allowed ? undefined : result.detail;
  };
  assert.deepEqual(recheckBeforeExternalEffect(base), { allowed: true, checkedAt: base.now });
  assert.equal(detail(recheckBeforeExternalEffect({ ...base, now: executing.deadline.effectiveDeadline })), "authority_expired");
  assert.equal(detail(recheckBeforeExternalEffect({ ...base, keyAvailability: "locked" })), "keystore_unavailable");
  assert.equal(detail(recheckBeforeExternalEffect({ ...base, currentOperationDigest: digest("f") })), "authority_invalid");
  assert.equal(detail(recheckBeforeExternalEffect({ ...base, paused: true })), "paused");
  assert.equal(detail(recheckBeforeExternalEffect({ ...base, effectClaim: "missing" })), "effect_in_progress");
  assert.equal(detail(recheckBeforeExternalEffect({ ...base, effectClaim: "ambiguous" })), "effect_ambiguous");
});

test("durable execution history survives restart, is idempotent, and classifies recovery conservatively", async () => {
  const directory = await mkdtemp(join(tmpdir(), "control-room-execution-"));
  const path = join(directory, "execution.sqlite");
  const execution = snapshot();
  const creation = {
    executionId: execution.executionId, admissionId: execution.admissionId, identity, authorityDigest: digest("b"),
    deadlineSources: sources(), leaseEpoch: 1, createdAt: admittedAt,
  };
  try {
    let store = new SqliteExecutionStateStore(path);
    assert.equal(store.create(creation), "created");
    assert.equal(store.create(creation), "duplicate");
    const start = event("start", "2026-08-23T12:00:01.000Z");
    assert.equal(store.apply(execution.executionId, start).disposition, "applied");
    assert.equal(store.create(creation), "duplicate");
    assert.equal(store.apply(execution.executionId, start).disposition, "duplicate");
    assert.throws(() => store.apply(execution.executionId, { ...start, occurredAt: "2026-08-23T12:00:02.000Z" }), ExecutionStateConflictError);
    assert.equal(store.recoveryAction(execution.executionId), "request_cancellation");
    assert.equal(store.events(execution.executionId).length, 2);
    store.close();

    store = new SqliteExecutionStateStore(path);
    assert.equal(store.load(execution.executionId)?.state, "executing");
    assert.equal(store.recoveryAction(execution.executionId), "request_cancellation");
    const crossed = store.apply(execution.executionId, event("deadline_crossed", "2026-08-23T12:30:00.000Z", { latenessMilliseconds: 0 }));
    assert.equal(crossed.requestCancellation, true);
    assert.equal(store.apply(execution.executionId, start).requestCancellation, false);
    assert.equal(store.recoveryAction(execution.executionId), "request_cancellation");
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("execution persistence requires a durable path and detects mirror tampering", async () => {
  assert.throws(() => new SqliteExecutionStateStore(":memory:"), /filesystem path/);
  const ephemeral = new SqliteExecutionStateStore(":memory:", { testOnlyAllowEphemeral: true });
  ephemeral.close();

  const directory = await mkdtemp(join(tmpdir(), "control-room-execution-tamper-"));
  const path = join(directory, "execution.sqlite");
  const execution = snapshot();
  try {
    const store = new SqliteExecutionStateStore(path);
    store.create({
      executionId: execution.executionId, admissionId: execution.admissionId, identity, authorityDigest: digest("b"),
      deadlineSources: sources(), leaseEpoch: 1, createdAt: admittedAt,
    });
    store.close();
    const db = new DatabaseSync(path);
    db.prepare(`UPDATE execution_authority_state SET state='completed' WHERE execution_id=?`).run(execution.executionId);
    db.close();
    const reopened = new SqliteExecutionStateStore(path);
    assert.throws(() => reopened.load(execution.executionId), ExecutionStateConflictError);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
