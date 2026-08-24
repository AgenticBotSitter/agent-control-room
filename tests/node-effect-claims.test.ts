import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EffectClaimConflictError,
  SqliteEffectClaimStore,
  applyExecutionAuthorityEvent,
  computeEffectClaimKey,
  computeExecutionId,
  computeNormalizedOperationDigest,
  createExecutionAuthoritySnapshot,
  createPreEffectMarker,
  effectClaimStateForPreEffect,
  type EffectClaimRequestV1,
  type EffectIdentityV1,
  type ExecutionAuthoritySnapshotV1,
  type NormalizedLocalPolicyRequestV1,
} from "../src/node-policy/v1/index.ts";

const at = "2026-08-23T12:00:00.000Z";
const deadline = "2026-08-23T12:30:00.000Z";
const digest = (character: string) => `sha256:${character.repeat(64)}`;

function request(overrides: Partial<NormalizedLocalPolicyRequestV1> = {}): NormalizedLocalPolicyRequestV1 {
  const value: NormalizedLocalPolicyRequestV1 = {
    contractVersion: "control-room-node-policy/v1",
    requestId: "request:effect:1",
    tenantId: "tenant:owner",
    nodeId: "node:marvin",
    nodeClass: "personal-compute",
    projectId: "project:alpha",
    jobId: "job:alpha",
    attemptId: "attempt:alpha:1",
    leaseId: "lease:alpha:1",
    leaseEpoch: 1,
    executorId: "executor:local",
    operationId: "operation:upload",
    operationDigest: digest("a"),
    authorityDigest: digest("b"),
    credentialRefs: ["credential:publish"],
    target: { kind: "network", canonicalDestination: "https://api.example.test:443" },
    risk: "medium",
    externalEffect: true,
    estimatedDurationSeconds: 60,
    occurredAt: at,
    ...overrides,
  };
  value.operationDigest = computeNormalizedOperationDigest(value);
  return value;
}

function execution(operation = request()): ExecutionAuthoritySnapshotV1 {
  const identity: EffectIdentityV1 = {
    tenantId: operation.tenantId,
    nodeId: operation.nodeId,
    projectId: operation.projectId,
    jobId: operation.jobId,
    attemptId: operation.attemptId,
    operationDigest: operation.operationDigest,
  };
  const admitted = createExecutionAuthoritySnapshot({
    executionId: computeExecutionId("admission:effect:1", operation.operationDigest),
    admissionId: "admission:effect:1",
    identity,
    authorityDigest: operation.authorityDigest,
    deadlineSources: {
      admittedAt: at,
      ceilingDurationSeconds: 3_600,
      authorityDurationSeconds: 3_600,
      authorityExpiresAt: "2026-08-23T13:00:00.000Z",
      leaseExpiresAt: deadline,
    },
    leaseEpoch: 1,
    createdAt: at,
  });
  return applyExecutionAuthorityEvent(admitted, {
    eventId: "event:effect:start",
    kind: "start",
    occurredAt: "2026-08-23T12:00:01.000Z",
  }).snapshot;
}

function claimInput(messageId = "message:effect:1", operation = request()): EffectClaimRequestV1 {
  return { messageId, execution: execution(operation), claimedAt: "2026-08-23T12:00:02.000Z" };
}

async function withStore(run: (store: SqliteEffectClaimStore, path: string) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "control-room-effect-"));
  const path = join(directory, "claims.sqlite");
  const store = new SqliteEffectClaimStore(path);
  try {
    await run(store,path);
  } finally {
    try { store.close(); } catch { /* already closed by restart tests */ }
    await rm(directory,{ recursive: true,force: true });
  }
}

function committedMarker(store: SqliteEffectClaimStore, operation = request()) {
  const claimed = store.claim(claimInput("message:effect:marker",operation));
  assert.equal(claimed.lookup.kind,"full");
  const marker = createPreEffectMarker({
    markerId: "marker:effect:1",
    claim: claimed.lookup.kind === "full" ? claimed.lookup.snapshot : assert.fail(),
    request: operation,
    authorityDigest: operation.authorityDigest,
    effectiveDeadline: deadline,
    markedAt: "2026-08-23T12:00:03.000Z",
  });
  return { marker,result: store.commitPreEffectMarker(marker) };
}

test("effect identity is stable per effect and excludes delivery message identity", () => {
  const operation = request();
  const identity: EffectIdentityV1 = {
    tenantId: operation.tenantId,nodeId: operation.nodeId,projectId: operation.projectId,
    jobId: operation.jobId,attemptId: operation.attemptId,operationDigest: operation.operationDigest,
  };
  const key = computeEffectClaimKey(identity);
  assert.equal(key,computeEffectClaimKey({ ...identity }));
  for (const field of ["tenantId","nodeId","projectId","jobId","attemptId","operationDigest"] as const) {
    const changed = { ...identity,[field]: field === "operationDigest" ? digest("f") : `${identity[field]}:different` };
    assert.notEqual(computeEffectClaimKey(changed),key,field);
  }
});

test("claim creation requires live execution authority and serializes fresh message aliases", async () => {
  await withStore((store,path) => {
    const input = claimInput();
    const first = store.claim(input);
    assert.equal(first.created,true);
    assert.equal(first.disposition,"dispatch_permitted");
    assert.equal(store.claim(input).disposition,"in_progress");
    assert.equal(store.claim({ ...input,messageId: "message:effect:fresh" }).disposition,"in_progress");
    assert.equal(store.countFull(),1);

    const secondStore = new SqliteEffectClaimStore(path);
    assert.equal(secondStore.claim({ ...input,messageId: "message:effect:other-process" }).disposition,"in_progress");
    secondStore.close();

    const unrelated = request({ jobId: "job:other" });
    assert.throws(() => store.claim({ ...claimInput("message:effect:1",unrelated) }),EffectClaimConflictError);
    assert.throws(() => store.claim({ ...input,messageId: "x" }),EffectClaimConflictError);
    assert.throws(() => store.claim({ ...input,execution: { ...input.execution,state: "expired" } }),/live executing authority/);
    assert.throws(() => store.claim({ ...input,claimedAt: deadline }),/Expired authority/);
  });
});

test("pre-effect marker is exact, durable, and is the only executing transition", async () => {
  await withStore((store) => {
    const { marker,result } = committedMarker(store);
    assert.equal(result.disposition,"committed");
    assert.equal(result.snapshot.state,"executing");
    assert.equal(effectClaimStateForPreEffect(result.snapshot),"claimed");
    assert.equal(store.commitPreEffectMarker(marker).disposition,"duplicate");
    assert.throws(() => store.commitPreEffectMarker({ ...marker,requestDigest: digest("f") }),EffectClaimConflictError);

    const fresh = request({ jobId: "job:binding" });
    const claim = store.claim(claimInput("message:effect:binding",fresh));
    assert.equal(claim.lookup.kind,"full");
    const candidate = createPreEffectMarker({
      markerId: "marker:effect:binding",claim: claim.lookup.kind === "full" ? claim.lookup.snapshot : assert.fail(),
      request: fresh,authorityDigest: fresh.authorityDigest,effectiveDeadline: deadline,markedAt: "2026-08-23T12:00:03.000Z",
    });
    assert.throws(() => store.commitPreEffectMarker({ ...candidate,requestDigest: "not-a-digest" }),EffectClaimConflictError);
    assert.throws(() => store.commitPreEffectMarker({ ...candidate,operation: { ...candidate.operation,target: { kind: "none" } } }),EffectClaimConflictError);
    assert.throws(() => store.commitPreEffectMarker({ ...candidate,markedAt: deadline }),EffectClaimConflictError);
  });
});

test("restart distinguishes safe re-evaluation from honest ambiguity and never auto-retries ambiguity", async () => {
  await withStore((store,path) => {
    const safe = store.claim(claimInput("message:safe:claim",request({ jobId: "job:safe" })));
    assert.equal(store.recover(safe.claimKey,"event:recover:safe","2026-08-23T12:00:04.000Z").action,"re_evaluate_claimed");

    const { result } = committedMarker(store);
    const claimKey = result.snapshot.claimKey;
    store.close();
    const reopened = new SqliteEffectClaimStore(path);
    const recovered = reopened.recover(claimKey,"event:recover:ambiguous","2026-08-23T12:00:04.000Z");
    assert.equal(recovered.action,"ambiguous");
    assert.equal(recovered.snapshot.state,"ambiguous");
    assert.equal(effectClaimStateForPreEffect(recovered.snapshot),"ambiguous");
    assert.equal(reopened.recover(claimKey,"event:recover:again","2026-08-23T12:00:05.000Z").action,"await_evidence");
    assert.equal(reopened.claim({ ...claimInput("message:effect:after-restart"),execution: execution() }).disposition,"ambiguous");
    assert.throws(() => reopened.apply(claimKey,{ eventId: "event:unsafe-fail",kind: "failed",safeFailureCode: "unknown",occurredAt: "2026-08-23T12:00:06.000Z" }),/non-execution evidence/);
    assert.throws(() => reopened.apply(claimKey,{ eventId: "event:unsafe-cancel",kind: "cancelled",occurredAt: "2026-08-23T12:00:06.000Z" }),/pre-effect/);
    const confirmed = reopened.apply(claimKey,{ eventId: "event:destination-confirmed",kind: "confirmed",destinationReceiptDigest: digest("c"),occurredAt: "2026-08-23T12:00:06.000Z" });
    assert.equal(confirmed.snapshot.state,"confirmed");
    assert.equal(reopened.recover(claimKey,"event:recover:terminal","2026-08-23T12:00:07.000Z").action,"replay_terminal");
    reopened.close();
  });
});

test("settlement requires evidence whenever the effect may have fired and replays terminal truth", async () => {
  await withStore((store) => {
    const before = store.claim(claimInput("message:failure:before",request({ jobId: "job:before" })));
    const failedBefore = store.apply(before.claimKey,{ eventId: "event:failure:before",kind: "failed",safeFailureCode: "policy_changed",occurredAt: "2026-08-23T12:00:03.000Z" });
    assert.equal(failedBefore.snapshot.state,"failed");
    assert.equal(store.claim(claimInput("message:failure:before:fresh",request({ jobId: "job:before" }))).disposition,"replay_failed");

    const operation = request({ jobId: "job:evidence" });
    const { result } = committedMarker(store,operation);
    assert.throws(() => store.apply(result.snapshot.claimKey,{ eventId: "event:no-evidence",kind: "failed",safeFailureCode: "destination_rejected",occurredAt: "2026-08-23T12:00:04.000Z" }),/non-execution evidence/);
    const failed = store.apply(result.snapshot.claimKey,{ eventId: "event:with-evidence",kind: "failed",safeFailureCode: "destination_rejected",nonExecutionEvidenceDigest: digest("d"),occurredAt: "2026-08-23T12:00:04.000Z" });
    assert.equal(failed.snapshot.nonExecutionEvidenceDigest,digest("d"));
    assert.equal(store.apply(result.snapshot.claimKey,{ eventId: "event:with-evidence",kind: "failed",safeFailureCode: "destination_rejected",nonExecutionEvidenceDigest: digest("d"),occurredAt: "2026-08-23T12:00:04.000Z" }).disposition,"duplicate");
    assert.throws(() => store.apply(result.snapshot.claimKey,{ eventId: "event:with-evidence",kind: "failed",safeFailureCode: "different",nonExecutionEvidenceDigest: digest("d"),occurredAt: "2026-08-23T12:00:04.000Z" }),EffectClaimConflictError);
  });
});

test("terminal compaction is horizon-gated, permanent, idempotent, and replayable", async () => {
  await withStore((store,path) => {
    const operation = request({ jobId: "job:tombstone" });
    const claimed = store.claim(claimInput("message:tombstone",operation));
    store.apply(claimed.claimKey,{ eventId: "event:tombstone:cancel",kind: "cancelled",occurredAt: "2026-08-23T12:00:03.000Z" });
    assert.equal(store.compactTerminal(claimed.claimKey,{},"2026-09-01T00:00:00.000Z").disposition,"retained_unknown_horizon");
    const horizons = {
      jobRetentionUntil: "2026-08-24T00:00:00.000Z",
      destinationIdempotencyUntil: "2026-08-25T00:00:00.000Z",
      authorityLateDeliveryUntil: "2026-08-26T00:00:00.000Z",
      protocolRetryUntil: "2026-08-27T00:00:00.000Z",
    };
    assert.equal(store.compactTerminal(claimed.claimKey,horizons,"2026-08-26T23:59:59.999Z").disposition,"retained_until");
    const compacted = store.compactTerminal(claimed.claimKey,horizons,"2026-08-27T00:00:00.000Z");
    assert.equal(compacted.disposition,"compacted");
    assert.equal(compacted.tombstone?.terminalDisposition,"cancelled");
    assert.equal(store.countFull(),0);
    assert.equal(store.countTombstones(),1);
    assert.equal(store.claim(claimInput("message:tombstone:fresh",operation)).disposition,"replay_cancelled");
    assert.throws(() => store.claim(claimInput("message:tombstone:fresh",request({ jobId: "job:message-reuse" }))),EffectClaimConflictError);
    assert.equal(store.compactTerminal(claimed.claimKey,horizons,"2026-08-28T00:00:00.000Z").tombstone?.tombstoneDigest,compacted.tombstone?.tombstoneDigest);
    store.close();
    const reopened = new SqliteEffectClaimStore(path);
    assert.equal(reopened.load(claimed.claimKey)?.kind,"tombstone");
    assert.equal(reopened.countTombstones(),1);
    reopened.close();
  });
});

test("nonterminal and ambiguous effects never compact", async () => {
  await withStore((store) => {
    const horizons = {
      jobRetentionUntil: at,destinationIdempotencyUntil: at,authorityLateDeliveryUntil: at,protocolRetryUntil: at,
    };
    const claimed = store.claim(claimInput("message:nonterminal",request({ jobId: "job:nonterminal" })));
    assert.throws(() => store.compactTerminal(claimed.claimKey,horizons,"2026-08-23T12:00:03.000Z"),/settled terminal/);
    const { result } = committedMarker(store,request({ jobId: "job:ambiguous" }));
    store.recover(result.snapshot.claimKey,"event:ambiguous","2026-08-23T12:00:04.000Z");
    assert.throws(() => store.compactTerminal(result.snapshot.claimKey,horizons,"2026-08-23T12:00:05.000Z"),/settled terminal/);
  });
});

test("durable claim store requires a filesystem path and fails closed on snapshot, marker, and history tampering", async () => {
  assert.throws(() => new SqliteEffectClaimStore(":memory:"),/filesystem path/);
  const ephemeral = new SqliteEffectClaimStore(":memory:",{ testOnlyAllowEphemeral: true });
  ephemeral.close();

  await withStore((store,path) => {
    const { result } = committedMarker(store);
    const key = result.snapshot.claimKey;
    store.close();
    let db = new DatabaseSync(path);
    db.prepare(`UPDATE effect_claim_events SET transition_digest=? WHERE claim_key=? AND event_id=?`).run(digest("f"),key,"marker:effect:1");
    db.close();
    let reopened = new SqliteEffectClaimStore(path);
    assert.throws(() => reopened.load(key),EffectClaimConflictError);
    reopened.close();

    db = new DatabaseSync(path);
    db.prepare(`UPDATE effect_claim_events SET transition_digest=? WHERE claim_key=? AND event_id=?`).run(
      // The original value is intentionally reconstructed only after the prior tamper was detected.
      digest("0"),key,"marker:effect:1",
    );
    db.prepare(`UPDATE effect_claims SET state='confirmed' WHERE claim_key=?`).run(key);
    db.close();
    reopened = new SqliteEffectClaimStore(path);
    assert.throws(() => reopened.load(key),EffectClaimConflictError);
    reopened.close();
  });
});
