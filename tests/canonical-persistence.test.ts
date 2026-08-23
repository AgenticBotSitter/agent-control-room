import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { DOMAIN_CONTRACT_VERSION, type ApprovalRecord, type CheckpointRecord, type JobRecord, type MessageEnvelope, type NodeRecord, type RequestRecord, type WorkflowRecord } from "../src/domain/v1/index.ts";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";
import { adaptPglite, type DatabaseSession } from "../src/persistence/database.ts";
import { DeliveryStore } from "../src/persistence/delivery-store.ts";
import { computeAuthorityDigest, sha256Digest } from "../src/security/index.ts";

const t0 = "2026-08-22T18:00:00.000Z";
const t1 = "2026-08-22T18:01:00.000Z";
const t5 = "2026-08-22T18:05:00.000Z";
const t10 = "2026-08-22T18:10:00.000Z";
const t11 = "2026-08-22T18:11:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
const actor = { actorId: "actor:owner", actorType: "human" as const };

async function migratedDatabase() {
  const db = new PGlite();
  const files = (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await db.exec(await readFile(resolve("db/migrations", file), "utf8"));
  await db.query(`INSERT INTO tenants (id,display_name) VALUES ('tenant:owner','Owner')`);
  return db;
}

function records(suffix: string) {
  const common = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: "tenant:owner", version: 0, createdAt: t0, updatedAt: t0 } as const;
  const request: RequestRecord = {
    ...common, kind: "request", id: `request:${suffix}`, projectId: `project:${suffix}`,
    title: `Request ${suffix}`, objective: "Synthetic persistence proof", state: "draft", priority: 50,
    requestedBy: actor, idempotencyKey: `request-key-${suffix}-0000`,
  };
  const workflow: WorkflowRecord = {
    ...common, kind: "workflow", id: `workflow:${suffix}`, requestId: request.id, projectId: `project:${suffix}`,
    definitionVersion: "1.0.0", definitionDigest: hashA, authorityMode: "control_room_native", state: "proposed", jobIds: [`job:${suffix}`],
  };
  const authority: JobRecord["authority"] = {
    projectId: workflow.projectId, allowedExecutor: "executor:test", allowedOperations: ["operation:test"],
    credentialRefs: [], networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "none",
    maxDurationSeconds: 600, expiresAt: t10, digest: hashB,
  };
  authority.digest = computeAuthorityDigest(authority);
  const job: JobRecord = {
    ...common, kind: "job", id: `job:${suffix}`, workflowId: workflow.id, projectId: workflow.projectId,
    jobType: "synthetic:test", specVersion: "1.0.0", inputDigest: hashA, state: "proposed", priority: 50,
    requiredCapability: "capability:test", dependsOnJobIds: [],
    authority,
    retryPolicy: { maxAttempts: 3, backoffSeconds: 5, retryableFailureCodes: ["temporary"], retryAfterOrphan: true, ambiguousEffectPolicy: "attention" },
  };
  return { request, workflow, job };
}

function node(): NodeRecord {
  return {
    contractVersion: DOMAIN_CONTRACT_VERSION, kind: "node", id: "node:synthetic", tenantId: "tenant:owner",
    displayName: "Synthetic node", state: "pending_enrollment", platform: "linux", architecture: "x64",
    identityKeyId: "key:synthetic", hardwareFingerprint: hashA, softwareFingerprint: hashB,
    policyVersion: "1.0.0", minimumProtocolVersion: "control-room-node/v1",
    version: 0, createdAt: t0, updatedAt: t0,
  };
}

async function seedActiveNode(store: CanonicalStore) {
  const pending = node();
  await store.create(pending);
  return store.transition({
    tenantId: pending.tenantId, kind: "node", entityId: pending.id, expectedVersion: 0, toState: "active",
    transitionId: "transition:node-active", idempotencyKey: "idem-node-active-0001", actor, occurredAt: t1,
    recordPatch: { enrolledAt: t1 },
  });
}

async function seedReadyJob(store: CanonicalStore, suffix: string) {
  const seeded = records(suffix);
  await store.create(seeded.request);
  await store.create(seeded.workflow);
  await store.create(seeded.job);
  const ready = await store.transition({
    tenantId: "tenant:owner", kind: "job", entityId: seeded.job.id, expectedVersion: 0, toState: "ready",
    transitionId: `transition:${suffix}:ready`, idempotencyKey: `transition-key-${suffix}-ready`, actor, occurredAt: t1,
  });
  return ready.entity as JobRecord;
}

test("CR-4B migrations create normalized domain and delivery tables", async () => {
  const db = await migratedDatabase();
  const result = await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
  const tables = new Set(result.rows.map((row) => row.table_name));
  for (const table of ["control_requests","control_workflows","control_jobs","control_attempts","control_leases","control_effect_intents","control_approvals","control_artifact_manifests","control_transition_events","control_inbox","control_outbox","control_idempotency"]) {
    assert.ok(tables.has(table), `missing ${table}`);
  }
  await db.close();
});

test("optimistic transitions are idempotent and reject illegal or stale mutations", async () => {
  const db = await migratedDatabase();
  const store = new CanonicalStore(adaptPglite(db));
  const { request } = records("transition");
  await store.create(request);
  const submitted = await store.transition({ tenantId: request.tenantId, kind: "request", entityId: request.id, expectedVersion: 0, toState: "submitted", transitionId: "transition:request:submitted", idempotencyKey: "idem-request-submitted", actor, occurredAt: t1 });
  assert.equal(submitted.entity.version, 1);
  const restartedStore = new CanonicalStore(adaptPglite(db));
  const replay = await restartedStore.transition({ tenantId: request.tenantId, kind: "request", entityId: request.id, expectedVersion: 0, toState: "submitted", transitionId: "ignored-on-replay", idempotencyKey: "idem-request-submitted", actor, occurredAt: t1 });
  assert.equal(replay.replayed, true);
  await assert.rejects(store.transition({ tenantId: request.tenantId, kind: "request", entityId: request.id, expectedVersion: 0, toState: "accepted", transitionId: "transition:stale", idempotencyKey: "idem-request-stale", actor, occurredAt: t1 }), /Version conflict/);
  await assert.rejects(store.transition({ tenantId: request.tenantId, kind: "request", entityId: request.id, expectedVersion: 1, toState: "fulfilled", transitionId: "transition:illegal", idempotencyKey: "idem-request-illegal", actor, occurredAt: t1 }), /Illegal request transition/);
  await db.close();
});

test("only one concurrent claimant receives the active lease and monotonic epoch", async () => {
  const db = await migratedDatabase();
  const store = new CanonicalStore(adaptPglite(db));
  await seedActiveNode(store);
  const ready = await seedReadyJob(store, "claim");
  await assert.rejects(
    store.transition({ tenantId: ready.tenantId, kind: "job", entityId: ready.id, expectedVersion: ready.version, toState: "leased", transitionId: "transition:unsafe-direct-claim", idempotencyKey: "idem-unsafe-direct-claim", actor, occurredAt: t1 }),
    /requires a coordinated repository operation/,
  );

  const claims = await Promise.allSettled([
    store.claimReadyJob({ tenantId: ready.tenantId, jobId: ready.id, expectedJobVersion: ready.version, nodeId: node().id, attemptId: "attempt:claim-a", leaseId: "lease:claim-a", transitionId: "transition:claim-a", idempotencyKey: "idem-claim-a", actor, acquiredAt: t1, expiresAt: t5 }),
    store.claimReadyJob({ tenantId: ready.tenantId, jobId: ready.id, expectedJobVersion: ready.version, nodeId: node().id, attemptId: "attempt:claim-b", leaseId: "lease:claim-b", transitionId: "transition:claim-b", idempotencyKey: "idem-claim-b", actor, acquiredAt: t1, expiresAt: t5 }),
  ]);
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(claims.filter((result) => result.status === "rejected").length, 1);
  const active = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM control_leases WHERE job_id=$1 AND state='active'`, [ready.id]);
  assert.equal(active.rows[0].count, "1");
  const winner = claims.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<CanonicalStore["claimReadyJob"]>>>;
  assert.equal(winner.value.lease.epoch, 1);
  await db.close();
});

test("lease renewal and expiry are epoch/version guarded and replay safe", async () => {
  const db = await migratedDatabase();
  const store = new CanonicalStore(adaptPglite(db));
  await seedActiveNode(store);
  const ready = await seedReadyJob(store, "expiry");
  const claimed = await store.claimReadyJob({ tenantId: ready.tenantId, jobId: ready.id, expectedJobVersion: ready.version, nodeId: node().id, attemptId: "attempt:expiry", leaseId: "lease:expiry", transitionId: "transition:expiry-claim", idempotencyKey: "idem-expiry-claim", actor, acquiredAt: t1, expiresAt: t5 });
  const renewed = await store.renewLease({ tenantId: ready.tenantId, leaseId: claimed.lease.id, expectedVersion: 0, epoch: 1, renewalId: "renewal:expiry", idempotencyKey: "idem-renewal-expiry", renewedAt: t1, expiresAt: t10 });
  assert.equal(renewed.lease.version, 1);
  assert.equal((await store.renewLease({ tenantId: ready.tenantId, leaseId: claimed.lease.id, expectedVersion: 0, epoch: 1, renewalId: "ignored", idempotencyKey: "idem-renewal-expiry", renewedAt: t1, expiresAt: t10 })).replayed, true);
  await assert.rejects(store.renewLease({ tenantId: ready.tenantId, leaseId: claimed.lease.id, expectedVersion: 1, epoch: 2, renewalId: "renewal:stale", idempotencyKey: "idem-renewal-stale", renewedAt: t1, expiresAt: t11 }), /stale state, epoch, or version/);

  const expired = await store.expireLease({ tenantId: ready.tenantId, leaseId: claimed.lease.id, jobId: ready.id, attemptId: claimed.attempt.id, expectedLeaseVersion: 1, expectedJobVersion: claimed.job.version, expectedAttemptVersion: claimed.attempt.version, epoch: 1, transitionId: "transition:expiry", idempotencyKey: "idem-expiry", actor, occurredAt: t11 });
  assert.equal(expired.lease.state, "expired");
  assert.equal(expired.attempt.state, "orphaned");
  assert.equal(expired.job.state, "ready");
  assert.equal((await store.expireLease({ tenantId: ready.tenantId, leaseId: claimed.lease.id, jobId: ready.id, attemptId: claimed.attempt.id, expectedLeaseVersion: 1, expectedJobVersion: claimed.job.version, expectedAttemptVersion: claimed.attempt.version, epoch: 1, transitionId: "ignored", idempotencyKey: "idem-expiry", actor, occurredAt: t11 })).replayed, true);
  const reclaimed = await store.claimReadyJob({ tenantId: ready.tenantId, jobId: ready.id, expectedJobVersion: expired.job.version, nodeId: node().id, attemptId: "attempt:expiry-2", leaseId: "lease:expiry-2", transitionId: "transition:expiry-claim-2", idempotencyKey: "idem-expiry-claim-2", actor, acquiredAt: t11, expiresAt: "2026-08-22T18:20:00.000Z" });
  assert.equal(reclaimed.lease.epoch, 2);
  assert.equal(reclaimed.attempt.attemptNumber, 2);
  await db.close();
});

test("database constraints reject payload mirror drift and cross-tenant lineage", async () => {
  const db = await migratedDatabase();
  const store = new CanonicalStore(adaptPglite(db));
  const owner = records("tenant-boundary");
  await store.create(owner.request);
  await assert.rejects(
    db.query(`UPDATE control_requests SET state='submitted' WHERE id=$1`, [owner.request.id]),
    /payload mirror mismatch/,
  );

  await db.query(`INSERT INTO tenants (id,display_name) VALUES ('tenant:other','Other')`);
  const otherRequest = { ...records("foreign").request, tenantId: "tenant:other", id: "request:foreign", idempotencyKey: "request-key-foreign-0000" };
  await store.create(otherRequest);
  const crossTenantWorkflow = { ...owner.workflow, id: "workflow:cross-tenant", requestId: otherRequest.id };
  await assert.rejects(store.create(crossTenantWorkflow), /foreign key|violates/i);

  await store.create(owner.workflow);
  await assert.rejects(
    db.query(
      `UPDATE control_workflows
       SET definition_digest='not-a-digest',payload=jsonb_set(payload,'{definitionDigest}','"not-a-digest"'::jsonb)
       WHERE id=$1`,
      [owner.workflow.id],
    ),
    /definition_digest|check constraint/i,
  );
  await assert.rejects(db.exec(`TRUNCATE control_transition_events`), /append-only relation/i);
  await db.close();
});

test("checkpoint ordering and live approval uniqueness are enforced", async () => {
  const db = await migratedDatabase();
  const store = new CanonicalStore(adaptPglite(db));
  await seedActiveNode(store);
  const ready = await seedReadyJob(store, "ordering");
  const claimed = await store.claimReadyJob({ tenantId: ready.tenantId, jobId: ready.id, expectedJobVersion: ready.version, nodeId: node().id, attemptId: "attempt:ordering", leaseId: "lease:ordering", transitionId: "transition:ordering-claim", idempotencyKey: "idem-ordering-claim", actor, acquiredAt: t1, expiresAt: t5 });
  const checkpoint: CheckpointRecord = {
    contractVersion: DOMAIN_CONTRACT_VERSION, kind: "checkpoint", id: "checkpoint:ordering-5",
    tenantId: ready.tenantId, attemptId: claimed.attempt.id, sequence: 5, state: "declared",
    payloadDigest: hashA, artifactIds: [], version: 0, createdAt: t1, updatedAt: t1,
  };
  await store.create(checkpoint);
  await assert.rejects(
    store.create({ ...checkpoint, id: "checkpoint:ordering-4", sequence: 4, payloadDigest: hashB }),
    /increase monotonically/,
  );

  const approval: ApprovalRecord = {
    contractVersion: DOMAIN_CONTRACT_VERSION, kind: "approval", id: "approval:ordering-a",
    tenantId: ready.tenantId, operationDigest: hashA, scope: "effect:ordering", risk: "high",
    state: "pending", requestedBy: actor, requiredActorType: "owner", expiresAt: t10,
    version: 0, createdAt: t1, updatedAt: t1,
  };
  await store.create(approval);
  await assert.rejects(
    store.create({ ...approval, id: "approval:ordering-b" }),
    /uq_control_approvals_live_operation|unique/i,
  );
  await db.close();
});

test("inbox and operation idempotency prevent duplicate handling", async () => {
  const db = await migratedDatabase();
  const delivery = new DeliveryStore(adaptPglite(db));
  const body = { safe: true };
  const envelope: MessageEnvelope = { protocol: "control-room-node/v1", messageId: "message:delivery", correlationId: "correlation:delivery", actorId: "node:synthetic", tenantId: "tenant:owner", sentAt: t0, expiresAt: t10, nonce: "1234567890abcdef", type: "job:event", bodyDigest: sha256Digest(body), body, signature: "1234567890abcdef" };
  assert.equal((await delivery.receive(envelope, { now: t1 })).replayed, false);
  assert.equal((await delivery.receive(envelope, { now: t1 })).replayed, true);
  await assert.rejects(delivery.receive({ ...envelope, messageId: "message:tampered", body: { safe: false } }, { now: t1 }), /digest mismatch/);
  await assert.rejects(delivery.receive({ ...envelope, messageId: "message:expired" }, { now: t10 }), /has expired/);
  const secretBody = { apiKey: "sk_test_abcdefghijklmnopqrstuvwxyz" };
  await assert.rejects(delivery.receive({ ...envelope, messageId: "message:secret", body: secretBody, bodyDigest: sha256Digest(secretBody) }, { now: t1 }), /secret material/);
  const conflictingBody = { safe: false };
  await assert.rejects(delivery.receive({ ...envelope, body: conflictingBody, bodyDigest: sha256Digest(conflictingBody) }, { now: t1 }), /different body digest/);

  let handled = 0;
  const first = await delivery.processOnce({ tenantId: envelope.tenantId, protocol: envelope.protocol, messageId: envelope.messageId }, async () => ++handled);
  const restartedDelivery = new DeliveryStore(adaptPglite(db));
  const replay = await restartedDelivery.processOnce({ tenantId: envelope.tenantId, protocol: envelope.protocol, messageId: envelope.messageId }, async () => ++handled);
  assert.deepEqual({ first: first.result, replayed: replay.replayed, handled }, { first: 1, replayed: true, handled: 1 });

  let effects = 0;
  const operation = { tenantId: "tenant:owner", operationScope: "test:operation", idempotencyKey: "operation-idem-0001", requestDigest: hashA };
  const once = await delivery.executeIdempotent(operation, async () => ({ effect: ++effects }));
  const twice = await delivery.executeIdempotent(operation, async () => ({ effect: ++effects }));
  assert.deepEqual({ once: once.result.effect, twice: twice.result.effect, replayed: twice.replayed, effects }, { once: 1, twice: 1, replayed: true, effects: 1 });
  await assert.rejects(delivery.executeIdempotent({ ...operation, requestDigest: hashB }, async () => ({ effect: 9 })), /different request digest/);
  await assert.rejects(delivery.executeIdempotent({ ...operation, idempotencyKey: "operation-idem-undefined" }, async () => undefined), /undefined is not replayable/);
  await db.close();
});

test("inbox handler failures roll back work and park poison messages", async () => {
  const db = await migratedDatabase();
  const delivery = new DeliveryStore(adaptPglite(db));
  const body = { safe: true };
  const envelope: MessageEnvelope = { protocol: "control-room-node/v1", messageId: "message:poison", correlationId: "correlation:poison", actorId: "node:synthetic", tenantId: "tenant:owner", sentAt: t0, expiresAt: t10, nonce: "abcdef1234567890", type: "job:event", bodyDigest: sha256Digest(body), body, signature: "abcdef1234567890" };
  const ref = { tenantId: envelope.tenantId, protocol: envelope.protocol, messageId: envelope.messageId };
  await delivery.receive(envelope, { now: t1 });

  let handlerRuns = 0;
  const poisonHandler = async (tx: DatabaseSession) => {
    handlerRuns += 1;
    await tx.query(`INSERT INTO tenants (id,display_name) VALUES ('tenant:rolled-back','Must roll back')`);
    throw new Error("synthetic poison");
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assert.rejects(delivery.processOnce(ref, poisonHandler, { maxAttempts: 3, safeFailureCode: "invalid_payload" }), /synthetic poison/);
    const row = await db.query<{ status: string; attempts: number; safe_failure_code: string }>(
      `SELECT status,attempts,safe_failure_code FROM control_inbox WHERE tenant_id=$1 AND protocol=$2 AND message_id=$3`,
      [ref.tenantId, ref.protocol, ref.messageId],
    );
    assert.deepEqual(row.rows[0], { status: attempt === 3 ? "failed" : "received", attempts: attempt, safe_failure_code: "invalid_payload" });
    assert.equal((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM tenants WHERE id='tenant:rolled-back'`)).rows[0].count, "0");
  }
  await assert.rejects(delivery.processOnce(ref, poisonHandler), /parked after repeated failures/);
  assert.equal(handlerRuns, 3);
  await db.close();
});

test("outbox claims use claim tokens and support bounded retry", async () => {
  const db = await migratedDatabase();
  const store = new CanonicalStore(adaptPglite(db));
  const delivery = new DeliveryStore(adaptPglite(db));
  const { request } = records("outbox");
  await store.create(request);
  await store.transition({ tenantId: request.tenantId, kind: "request", entityId: request.id, expectedVersion: 0, toState: "submitted", transitionId: "transition:outbox", idempotencyKey: "idem-outbox-transition", actor, occurredAt: t1 });
  const claimed = await delivery.claimOutbox({ claimToken: "claim-token-0001", limit: 10, maxAttempts: 3, now: t1 });
  assert.equal(claimed.length, 1);
  await assert.rejects(delivery.markOutboxDelivered(claimed[0].id, "wrong-claim-token", t5), /stale or missing/);
  await delivery.markOutboxFailed({ id: claimed[0].id, claimToken: "claim-token-0001", availableAt: t5, safeFailureCode: "temporary", maxAttempts: 3 });
  assert.equal((await delivery.claimOutbox({ claimToken: "claim-token-0002", limit: 10, maxAttempts: 3, now: t1 })).length, 0);
  const retried = await delivery.claimOutbox({ claimToken: "claim-token-0002", limit: 10, maxAttempts: 3, now: t5 });
  assert.equal(retried[0].attempts, 2);
  assert.equal(await delivery.recoverStaleOutbox({ claimedBefore: t10, availableAt: t10, safeFailureCode: "claim_abandoned", maxAttempts: 3 }), 1);
  await assert.rejects(delivery.markOutboxDelivered(retried[0].id, "claim-token-0002", t10), /stale or missing/);
  const recovered = await delivery.claimOutbox({ claimToken: "claim-token-0003", limit: 10, maxAttempts: 3, now: t10 });
  assert.equal(recovered[0].attempts, 3);
  await delivery.markOutboxDelivered(recovered[0].id, "claim-token-0003", t10);
  await delivery.markOutboxDelivered(recovered[0].id, "claim-token-0003", t10);
  assert.equal((await delivery.claimOutbox({ claimToken: "claim-token-0004", limit: 10, maxAttempts: 3, now: t10 })).length, 0);
  await db.query(
    `INSERT INTO control_outbox (id,tenant_id,topic,aggregate_type,aggregate_id,idempotency_key,status,attempts,available_at,payload)
     VALUES ('outbox:dead','tenant:owner','test','test','test:1','idem-dead','failed',2,$1,'{}'::jsonb)`,
    [t10],
  );
  const finalAttempt = await delivery.claimOutbox({ claimToken: "claim-token-dead", limit: 10, maxAttempts: 3, now: t10 });
  await delivery.markOutboxFailed({ id: finalAttempt[0].id, claimToken: "claim-token-dead", availableAt: t11, safeFailureCode: "permanent", maxAttempts: 3 });
  const dead = await db.query<{ status: string }>(`SELECT status FROM control_outbox WHERE id='outbox:dead'`);
  assert.equal(dead.rows[0].status, "dead_letter");
  assert.equal((await delivery.claimOutbox({ claimToken: "claim-token-dead-again", limit: 10, maxAttempts: 3, now: t11 })).length, 0);
  assert.equal(await delivery.recoverStaleOutbox({ claimedBefore: t11, availableAt: t11, safeFailureCode: "claim_abandoned", maxAttempts: 3 }), 0);
  await db.close();
});

test("acknowledgement loss redelivers while destination idempotency absorbs the duplicate", async () => {
  const db = await migratedDatabase();
  const store = new CanonicalStore(adaptPglite(db));
  const delivery = new DeliveryStore(adaptPglite(db));
  const { request } = records("ack-loss");
  await store.create(request);
  await store.transition({ tenantId: request.tenantId, kind: "request", entityId: request.id, expectedVersion: 0, toState: "submitted", transitionId: "transition:ack-loss", idempotencyKey: "idem-ack-loss", actor, occurredAt: t1 });

  const destination = new Map<string, unknown>();
  let deliveryAttempts = 0;
  const deliver = (message: Awaited<ReturnType<DeliveryStore["claimOutbox"]>>[number]) => {
    deliveryAttempts += 1;
    if (!destination.has(message.idempotencyKey)) destination.set(message.idempotencyKey, message.payload);
  };

  const first = (await delivery.claimOutbox({ claimToken: "claim-ack-lost", limit: 1, maxAttempts: 3, now: t1 }))[0];
  deliver(first); // The destination commits, but Control Room never receives the acknowledgement.
  await delivery.recoverStaleOutbox({ claimedBefore: t5, availableAt: t5, safeFailureCode: "ack_lost", maxAttempts: 3 });
  const second = (await delivery.claimOutbox({ claimToken: "claim-ack-retry", limit: 1, maxAttempts: 3, now: t5 }))[0];
  deliver(second);
  await delivery.markOutboxDelivered(second.id, "claim-ack-retry", t5);

  assert.equal(deliveryAttempts, 2);
  assert.equal(destination.size, 1);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  await db.close();
});
