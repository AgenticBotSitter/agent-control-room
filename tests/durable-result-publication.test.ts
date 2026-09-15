import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { publishDurableResultV1, readDurableResultV1, reconcileDurableResultReservationCrashV1,
  type DurableResultBindingV1 } from "../src/artifacts/v1/durable-result-publication";
import { durableReceiptFromCodexV1, durableReceiptFromNativeV1 } from "../src/artifacts/v1/durable-result-receipt";
import { reserveNativeResultWriteV1, markNativeResultReservationStorageUncertainV1 } from "../src/artifacts/v1/native-result-reservation";
import { resultBytesHash } from "../src/artifacts/v1/native-results";
import { taskReviewTargetV1 } from "../src/completion-gate/v1/task-review-plan";
import { readDurableResultReviewPlanV1 } from "../src/completion-gate/v1/durable-result-review-plan";
import { openPrivateArtifactStorageV1, privateArtifactStorageNamespaceDigestV1 } from "../src/web/v1/private-artifact-storage";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../src/node-executor/artifact-storage";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { hmacSha256Tag, sha256Digest } from "../src/security";
import { createInMemoryNeutralReservationPort, createPersistentNeutralReservationPort,
  createPersistentNeutralReservationStore } from "../src/artifacts/v1/neutral-reservation-port";
import { binding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { webNativeResultFixture } from "./helpers/web-native-result";

const digest = (seed = "a") => `sha256:${createHash("sha256").update(`durable-test:${seed}`).digest("hex")}`;

class ControlledStorage implements ArtifactStoragePortV1, ArtifactReadPortV1 {
  readonly artifacts = new Map<string, Uint8Array>();
  putCalls = 0;
  throwAfterPut = false;
  missingReadback = false;
  tamperReadback = false;
  waitForRelease = false;
  /** Set true when a put/read returns ambiguous; subsequent calls fail-closed
   *  with the same error and no storage work is done. Mirrors the contract
   *  enforced by the public storage adapters and the publisher's
   *  `durableStorageIo`. Cleared only when a fresh storage port is constructed. */
  isStorageUncertain = false;
  private enteredResolve!: () => void;
  private releaseResolve!: () => void;
  readonly entered = new Promise<void>(resolve => { this.enteredResolve = resolve; });
  private readonly released = new Promise<void>(resolve => { this.releaseResolve = resolve; });
  release(): void { this.releaseResolve(); }
  async put(input: { artifactId: string; bytes: Uint8Array; signal?: AbortSignal }) {
    if (this.isStorageUncertain) throw new Error("synthetic_storage_uncertain");
    input.signal?.throwIfAborted();
    this.putCalls++;
    this.enteredResolve();
    if (this.waitForRelease) await this.released;
    const bytes = Uint8Array.from(input.bytes);
    this.artifacts.set(input.artifactId, bytes);
    if (this.throwAfterPut) {
      this.isStorageUncertain = true;
      throw new Error("synthetic_ambiguous_put");
    }
    return { artifactId: input.artifactId, opaqueLocator: `memory://durable/${encodeURIComponent(input.artifactId)}`,
      contentHash: resultBytesHash(bytes), sizeBytes: bytes.byteLength };
  }
  async read(artifactId: string, signal?: AbortSignal) {
    if (this.isStorageUncertain) throw new Error("synthetic_storage_uncertain");
    signal?.throwIfAborted();
    if (this.missingReadback) return undefined;
    const bytes = this.artifacts.get(artifactId);
    if (!bytes) return undefined;
    if (this.tamperReadback) {
      this.isStorageUncertain = true;
      return new TextEncoder().encode("tampered bytes with same length!!".slice(0, bytes.byteLength));
    }
    return Uint8Array.from(bytes);
  }
}

const text = (suffix: string) => `Durable neutral result ${suffix}.`;
const bytesOf = (suffix: string) => new TextEncoder().encode(text(suffix));

function nativeBinding(runId: string): DurableResultBindingV1 {
  return { tenantId: binding.tenantId, projectId: binding.projectId, jobId: `job:${runId}`,
    attemptId: `attempt:${runId}`, runId, nodeId: binding.nodeId, workflowId: "workflow:test", harness: "native",
    connectorProfileDigest: digest("c"), snapshotDigest: digest("s"), snapshotVersion: 1,
    acceptanceProfileId: "profile:test", acceptanceProfileDigest: digest("p") };
}

function codexBinding(runId: string): DurableResultBindingV1 {
  return { tenantId: binding.tenantId, projectId: binding.projectId, jobId: `job:${runId}`,
    attemptId: `attempt:${runId}`, runId, nodeId: binding.nodeId, workflowId: "workflow:test", harness: "codex",
    connectorProfileDigest: digest("c"), publicationContractDigest: digest("d"), terminalEvidenceDigest: digest("e"),
    threadId: "thread:test", turnId: "turn:test", itemId: "item:test",
    acceptanceProfileId: "profile:test", acceptanceProfileDigest: digest("p") };
}

async function setup() {
  const f = await webNativeResultFixture();
  // Reservation persistence goes through the injected neutral port. The
  // PostgreSQL adapter for the dedicated neutral table is lead-owned and
  // pending, so tests inject either:
  //  - `nonpersistentReservations`: InMemoryNeutralReservationPort,
  //    labeled test-only, never survives reconstruction. Use for
  //    single-shot publish/conflict/uncertainty tests.
  //  - `restartStore` + `restartReservations`: shared backing store that
  //    the test wraps in a fresh PersistentNeutralReservationPort after
  //    "restart". Use for replay, restart-recovery, manifest-collision
  //    and inventory scans.
  const restartStore = createPersistentNeutralReservationStore();
  return { ...f, resultKey: f.resultKey, reviewKey: f.reviewKey,
    nonpersistentReservations: createInMemoryNeutralReservationPort(),
    restartStore, restartReservations: createPersistentNeutralReservationPort(restartStore) };
}

async function setupWithProvision(runId: string, authorityDigest = digest("s")) {
  const f = await setup();
  await f.provisionRun(runId, `job:${runId}`, `attempt:${runId}`, authorityDigest);
  return f;
}

function configOf(f: Awaited<ReturnType<typeof setup>>, storage: ControlledStorage,
  reservations = f.restartReservations) {
  return { db: f.db, integrityKey: f.resultKey, reviewKey: f.reviewKey, storage,
    storageClass: "local" as const, reservations };
}

/** Rebuild the publisher config with a fresh port around the same backing
 *  store, simulating a process restart. */
function configAfterRestart(f: Awaited<ReturnType<typeof setup>>, storage: ControlledStorage) {
  return configOf(f, storage, createPersistentNeutralReservationPort(f.restartStore));
}

function thirdPartyBinding(runId: string): DurableResultBindingV1 {
  // A future connector: no snapshot, no publication contract, no
  // thread/turn/item IDs. The publisher contract must accept this without
  // forcing the connector to impersonate a built-in harness.
  return { tenantId: binding.tenantId, projectId: binding.projectId, jobId: `job:${runId}`,
    attemptId: `attempt:${runId}`, runId, nodeId: binding.nodeId, workflowId: "workflow:test",
    harness: "third-party", connectorProfileDigest: digest("c"),
    acceptanceProfileId: "profile:test", acceptanceProfileDigest: digest("p") };
}

test("third-party harness: a non-native/non-codex connector can publish with only a connector profile digest", async t => {
  const f = await setupWithProvision("run:durable-third-party", digest("c")); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-third-party";
  const receivedAt = at(9300);
  const first = await publishDurableResultV1(configOf(f, storage),
    { binding: thirdPartyBinding(runId), bytes: bytesOf("third-party"), receivedAt, assertAuthority: () => {} });
  assert.equal(first.replayed, false);
  // The harness tag is a publisher-supplied label, not a gate. A
  // connector that supplies neither a snapshot nor a publication contract
  // is accepted — its identity is recorded by connectorProfileDigest.
  assert.equal(first.receipt.harness, "third-party");
  assert.ok(first.receipt.contentHash.startsWith("sha256:"));
  // The receipt carries only the evidence the connector actually supplied
  // (no snapshot, no publication contract, no thread/turn/item IDs).
  assert.equal(first.receipt.snapshotDigest, undefined);
  assert.equal(first.receipt.publicationContractDigest, undefined);
  assert.equal(first.receipt.terminalEvidenceDigest, undefined);
  assert.equal(first.receipt.threadId, undefined);
  assert.equal(first.receipt.turnId, undefined);
  assert.equal(first.receipt.itemId, undefined);
  // The receipt surfaces the connector profile and acceptance profile
  // digests so readers can verify the binding identity without joining
  // back to the binding row.
  assert.equal(first.receipt.connectorProfileDigest, digest("c"));
  assert.equal(first.receipt.acceptanceProfileId, "profile:test");
  assert.equal(first.receipt.acceptanceProfileDigest, digest("p"));
});

for (const [flavor, makeBinding] of [["native", nativeBinding], ["codex", codexBinding]] as const) {
  test(`${flavor}: one exact result publishes once and replays the same receipt after restart`, async t => {
    const f = await setupWithProvision(`run:durable-replay-${flavor}`,
      flavor === "codex" ? digest("d") : digest("s")); t.after(f.close);
      const storage = new ControlledStorage();
      const runId = `run:durable-replay-${flavor}`;
    const receivedAt = at(9000);
    const first = await publishDurableResultV1(configOf(f, storage),
      { binding: makeBinding(runId), bytes: bytesOf(flavor), receivedAt, assertAuthority: () => {} });
    assert.equal(first.replayed, false);
    assert.equal(first.receipt.harness, flavor);
    assert.match(first.receipt.artifactId, /^artifact:result:[a-f0-9]{64}$/);
    assert.equal(first.receipt.qualityAccepted, false);
    assert.equal(first.target.kind, "document");
    assert.equal(storage.putCalls, 1);

    const restarted = await publishDurableResultV1(configAfterRestart(f, storage),
      { binding: makeBinding(runId), bytes: bytesOf(flavor), receivedAt, assertAuthority: () => {} });
    assert.equal(restarted.replayed, true);
    assert.deepEqual(restarted.receipt, first.receipt);
    assert.deepEqual(restarted.target, first.target);
    assert.equal(storage.putCalls, 1);

    const read = await f.db.transaction(tx => readDurableResultV1(tx, f.resultKey, "local",
      (artifactId, signal) => storage.read(artifactId, signal),
      binding.tenantId, binding.projectId, makeBinding(runId).jobId, first.receipt.artifactId));
    assert.equal(read?.text, text(flavor));
  });

  test(`${flavor}: a poisoned storage port stays poisoned: subsequent calls fail closed before any write`, async t => {
    const f = await setupWithProvision(`run:durable-poison-${flavor}`,
      flavor === "codex" ? digest("d") : digest("s")); t.after(f.close);
    const storage = new ControlledStorage();
    storage.throwAfterPut = true;
    const runId = `run:durable-poison-${flavor}`;
    const receivedAt = at(9100);
    await assert.rejects(() => publishDurableResultV1(configOf(f, storage),
      { binding: makeBinding(runId), bytes: bytesOf(`${flavor}-a`), receivedAt, assertAuthority: () => {} }),
    /durable_result_storage_uncertain/);
    assert.equal(storage.putCalls, 1);
    // Once poisoned, the shared port-level flag is sticky. Clearing
    // `throwAfterPut` does NOT reset it; the second call must hit the
    // poisoning fence before any reservation or write attempt.
    storage.throwAfterPut = false;
    await assert.rejects(() => publishDurableResultV1(configOf(f, storage),
      { binding: makeBinding(runId), bytes: bytesOf(`${flavor}-b`), receivedAt, assertAuthority: () => {} }),
    /durable_result_storage_uncertain/);
    assert.equal(storage.putCalls, 1);
  });
}

test("a racing capture during the byte window reconciles manually and the first still commits", async t => {
  const f = await setupWithProvision("run:durable-race"); t.after(f.close);
  const storage = new ControlledStorage();
  storage.waitForRelease = true;
  const runId = "run:durable-race";
  const receivedAt = at(9200);
  const first = publishDurableResultV1(configOf(f, storage),
    { binding: nativeBinding(runId), bytes: bytesOf("race"), receivedAt, assertAuthority: () => {} });
  await storage.entered;
  await assert.rejects(() => publishDurableResultV1(configOf(f, storage),
    { binding: nativeBinding(runId), bytes: bytesOf("race"), receivedAt, assertAuthority: () => {} }),
  /durable_result_manual_reconciliation_required/);
  storage.release();
  const captured = await first;
  assert.equal(captured.replayed, false);
  assert.equal(storage.putCalls, 1);
});

test("an ambiguous write is terminal: a fresh storage port still reconciles manually and never rewrites", async t => {
  const f = await setupWithProvision("run:durable-ambiguous"); t.after(f.close);
  const poisoned = new ControlledStorage();
  poisoned.throwAfterPut = true;
  const runId = "run:durable-ambiguous";
  const receivedAt = at(9300);
  await assert.rejects(() => publishDurableResultV1(configOf(f, poisoned),
    { binding: nativeBinding(runId), bytes: bytesOf("ambiguous"), receivedAt, assertAuthority: () => {} }),
  /durable_result_storage_uncertain/);
  const row = f.restartReservations.peek(binding.tenantId, runId);
  assert.equal(row?.state, "storage_uncertain");
  // The poisoned port stays poisoned for the rest of the process. A
  // restart with a fresh storage port (and the same reservation backing
  // store, simulating durable reservation persistence) must still refuse
  // because the reservation itself is in `storage_uncertain` state — that
  // is the manual reconciliation outcome the system requires.
  const freshStorage = new ControlledStorage();
  await assert.rejects(() => publishDurableResultV1(configAfterRestart(f, freshStorage),
    { binding: nativeBinding(runId), bytes: bytesOf("ambiguous"), receivedAt, assertAuthority: () => {} }),
  /durable_result_manual_reconciliation_required/);
  assert.equal(freshStorage.putCalls, 0);
});

function failingMetadataDatabase(base: DatabaseClient): DatabaseClient {
  let fail = true;
  const intercepted = (tx: DatabaseSession): DatabaseSession => ({
    query<T>(sql: string, params?: unknown[]) {
      if (fail && sql.includes("INSERT INTO control_artifact_manifests")) {
        fail = false; throw new Error("synthetic_metadata_crash");
      }
      return tx.query<T>(sql, params);
    },
  });
  return { query: base.query.bind(base),
    transaction: work => base.transaction(tx => work(intercepted(tx))),
    transactionWithPreCommitCheck: (work, check) =>
      base.transactionWithPreCommitCheck(tx => work(intercepted(tx)), check) };
}

test("a crash after verified bytes leaves manual reconciliation and never writes again", async t => {
  const f = await setupWithProvision("run:durable-metacrash"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-metacrash";
  const receivedAt = at(9400);
  const crashing = { ...configOf(f, storage), db: failingMetadataDatabase(f.db) };
  await assert.rejects(() => publishDurableResultV1(crashing,
    { binding: nativeBinding(runId), bytes: bytesOf("metacrash"), receivedAt, assertAuthority: () => {} }),
  /synthetic_metadata_crash/);
  const row = f.restartReservations.peek(binding.tenantId, runId);
  assert.equal(row?.state, "bytes_verified");
  await assert.rejects(() => publishDurableResultV1(configOf(f, storage),
    { binding: nativeBinding(runId), bytes: bytesOf("metacrash"), receivedAt, assertAuthority: () => {} }),
  /durable_result_manual_reconciliation_required/);
  assert.equal(storage.putCalls, 1);
});

test("revoked authority refuses before any reservation or byte write", async t => {
  const f = await setupWithProvision("run:durable-revoked"); t.after(f.close);
  const storage = new ControlledStorage();
  let calls = 0;
  await assert.rejects(() => publishDurableResultV1(configOf(f, storage),
    { binding: nativeBinding("run:durable-revoked"), bytes: bytesOf("revoked"), receivedAt: at(9500),
      assertAuthority: () => { calls++; throw new Error("authority_revoked"); } }),
  /authority_revoked/);
  assert.ok(calls >= 1);
  assert.equal(storage.putCalls, 0);
});

test("oversize, non-UTF8 and tampered readback all fail closed", async t => {
  const f = await (async () => { const x = await setup();
    for (const r of ["run:durable-oversize","run:durable-badutf","run:durable-tampered"]) await x.provisionRun(r, `job:${r}`, `attempt:${r}`);
    return x; })(); t.after(f.close);
  const receivedAt = at(9600);
  const oversize = new Uint8Array(65_537);
  await assert.rejects(() => publishDurableResultV1(configOf(f, new ControlledStorage()),
    { binding: nativeBinding("run:durable-oversize"), bytes: oversize, receivedAt, assertAuthority: () => {} }),
  /durable_result_publication_unavailable/);
  const invalid = new Uint8Array([0xff, 0xfe, 0x41]);
  await assert.rejects(() => publishDurableResultV1(configOf(f, new ControlledStorage()),
    { binding: nativeBinding("run:durable-badutf"), bytes: invalid, receivedAt, assertAuthority: () => {} }),
  /result_content_unavailable/);
  const tampered = new ControlledStorage();
  tampered.tamperReadback = true;
  await assert.rejects(() => publishDurableResultV1(configOf(f, tampered),
    { binding: nativeBinding("run:durable-tampered"), bytes: bytesOf("tampered"), receivedAt,
      assertAuthority: () => {} }), /durable_result_storage_uncertain/);
  const row = f.restartReservations.peek(binding.tenantId, "run:durable-tampered");
  assert.equal(row?.state, "storage_uncertain");
});

test("the protected reader returns verified text and fails closed on tampering", async t => {
  const f = await setupWithProvision("run:durable-read"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-read";
  const receivedAt = at(9700);
  const captured = await publishDurableResultV1(configOf(f, storage),
    { binding: nativeBinding(runId), bytes: bytesOf("read"), receivedAt, assertAuthority: () => {} });
  const read = (artifactId: string, signal?: AbortSignal) => storage.read(artifactId, signal);
  const good = await f.db.transaction(tx => readDurableResultV1(tx, f.resultKey, "local", read,
    binding.tenantId, binding.projectId, nativeBinding(runId).jobId, captured.receipt.artifactId));
  assert.equal(good?.text, text("read"));
  const wrongProject = await f.db.transaction(tx => readDurableResultV1(tx, f.resultKey, "local", read,
    binding.tenantId, "project:other", nativeBinding(runId).jobId, captured.receipt.artifactId));
  assert.equal(wrongProject, undefined);
  storage.tamperReadback = true;
  // Tampered readback now also flips the port's `isStorageUncertain`
  // flag. The reader still catches the content mismatch at the bytes
  // check on the first tampered call (`result_content_unavailable`);
  // subsequent calls on the same poisoned port fail closed at the
  // storage boundary.
  await assert.rejects(() => f.db.transaction(tx => readDurableResultV1(tx, f.resultKey, "local", read,
    binding.tenantId, binding.projectId, nativeBinding(runId).jobId, captured.receipt.artifactId)),
  /result_content_unavailable|synthetic_storage_uncertain/);
  // Reset the tamper flag, but the port stays poisoned: subsequent
  // reads on the same port fail closed at the storage boundary.
  storage.tamperReadback = false;
  await assert.rejects(() => f.db.transaction(tx => readDurableResultV1(tx, f.resultKey, "local", read,
    binding.tenantId, binding.projectId, nativeBinding(runId).jobId, captured.receipt.artifactId)),
  /synthetic_storage_uncertain/);
  // A fresh storage port (simulated restart) clears the poisoning and
  // returns the original bytes intact.
  const freshStorage = new ControlledStorage();
  freshStorage.artifacts.set(captured.receipt.artifactId, bytesOf("read"));
  const freshRead = (artifactId: string, signal?: AbortSignal) => freshStorage.read(artifactId, signal);
  const recovered = await f.db.transaction(tx => readDurableResultV1(tx, f.resultKey, "local", freshRead,
    binding.tenantId, binding.projectId, nativeBinding(runId).jobId, captured.receipt.artifactId));
  assert.equal(recovered?.text, text("read"));
});

test("exactly one pending owner-review target exists and cross-harness pairs refuse", async t => {
  const f = await (async () => { const x = await setup();
    await x.provisionRun("run:durable-plan-native", "job:run:durable-plan-native", "attempt:run:durable-plan-native", digest("s"));
    await x.provisionRun("run:durable-plan-codex", "job:run:durable-plan-codex", "attempt:run:durable-plan-codex", digest("d"));
    return x; })(); t.after(f.close);
  const storage = new ControlledStorage();
  const receivedAt = at(9800);
  // Override jobId+attemptId so the artifact-manifest FK
  // (tenant, attempt_id, job_id) matches the parent rows we provisioned.
  const native = await publishDurableResultV1(configOf(f, storage),
    { binding: { ...nativeBinding("run:durable-plan-native"), jobId: "job:run:durable-plan-native",
      attemptId: "attempt:run:durable-plan-native" },
      bytes: bytesOf("plan-native"), receivedAt, assertAuthority: () => {} });
  const codex = await publishDurableResultV1(configOf(f, storage),
    { binding: { ...codexBinding("run:durable-plan-codex"), jobId: "job:run:durable-plan-codex",
      attemptId: "attempt:run:durable-plan-codex" },
      bytes: bytesOf("plan-codex"), receivedAt, assertAuthority: () => {} });
  const plans = (await f.db.query<{ plan: unknown }>(
    "SELECT plan FROM control_native_review_plans WHERE tenant_id=$1", [binding.tenantId])).rows;
  assert.equal(plans.length, 2);
  await f.db.transaction(async tx => {
    const readNative = await readDurableResultReviewPlanV1(tx, f.reviewKey,
      binding.tenantId, binding.projectId, "job:run:durable-plan-native");
    assert.ok(readNative);
    // Both publishers now produce durable-result-receipt/v1 schemas under the
    // unified port, so cross-harness rejection lands at the durable plan layer
    // (harness mismatch in durableReviewTargetV1) instead of the legacy task
    // schema guard. The intent — reader rejects the foreign receipt — holds.
    assert.throws(() => taskReviewTargetV1(readNative!, codex.receipt),
      /durable_result_review_plan_unavailable/);
    assert.throws(() => taskReviewTargetV1(readNative!, { ...native.receipt,
      schema: "control-room.native-result-receipt/v1" } as unknown as Parameters<typeof taskReviewTargetV1>[1]),
      /task_review_target_unavailable/);
  });
  assert.ok(!("qualityAccepted" in native.target) && !("completionVerified" in native.target));
});

test("crash reconciliation reports committed metadata versus manual work", async t => {
  const f = await setupWithProvision("run:durable-reconcile"); t.after(f.close);
  const storage = new ControlledStorage();
  const receivedAt = at(9900);
  const captured = await publishDurableResultV1(configOf(f, storage),
    { binding: nativeBinding("run:durable-reconcile"), bytes: bytesOf("reconcile"), receivedAt,
      assertAuthority: () => {} });
  assert.equal(captured.replayed, false);
  const peeked = f.restartReservations.peek(binding.tenantId, "run:durable-reconcile");
  assert.ok(peeked);
  const decision = reconcileDurableResultReservationCrashV1(peeked!.reservation) as { disposition: string;
    autoRetriesWrite: boolean; autoCommitsMetadata: boolean };
  assert.equal(decision.disposition, "metadata_already_committed");
  assert.equal(decision.autoRetriesWrite, false);
  assert.equal(decision.autoCommitsMetadata, false);
});

test("receipt converters label honestly and refuse relabelling", async t => {
  const receivedAt = at(10_000);
  const contentHash = resultBytesHash(bytesOf("convert"));
  const base = { tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId,
    attemptId: binding.attemptId, runId: "run:convert", nodeId: binding.nodeId, contentHash,
    sizeBytes: bytesOf("convert").byteLength, manifestDigest: digest("m"), receivedAt,
    byteCheck: "matched_recorded_claim" as const, qualityAccepted: false as const };
  const nativeReceipt = { schema: "control-room.native-result-receipt/v1", artifactId: "artifact:native:convert",
    ...base, snapshotDigest: digest("s"), snapshotVersion: 1 };
  const codexReceipt = { schema: "control-room.codex-result-receipt/v1", artifactId: "artifact:native:convert",
    ...base, sizeBytes: Math.max(1, base.sizeBytes), publicationId: "publication:test",
    publicationContractDigest: digest("d"), terminalEvidenceDigest: digest("e"),
    qualificationReceiptBodyDigest: digest("q"), qualificationSignerKeyId: "signer:test",
    threadId: "thread:test", turnId: "turn:test", itemId: "item:test",
    projectionDigest: digest("j"), rawResultDigest: digest("r"), rawTurnDigest: digest("t"),
    canonicalPublicationAllowed: false as const, completionVerified: false as const,
    releasesCapacity: false as const, grantsExecutionAuthority: false as const };
  const fromNative = durableReceiptFromNativeV1(nativeReceipt as never);
  assert.equal(fromNative.harness, "native");
  assert.match(fromNative.artifactId, /^artifact:result:[a-f0-9]{64}$/);
  const fromCodex = durableReceiptFromCodexV1(codexReceipt as never);
  assert.equal(fromCodex.harness, "codex");
  assert.throws(() => durableReceiptFromNativeV1(codexReceipt as never), /durable_result_receipt_unavailable/);
  assert.throws(() => durableReceiptFromCodexV1(nativeReceipt as never), /durable_result_receipt_unavailable/);
});

test("delegated native reservations keep strict replay comparison", async t => {
  const f = await setup(); t.after(f.close);
  const input = f.complete("Strict replay comparison.");
  const reserved = reserveNativeResultWriteV1({ tenantId: binding.tenantId, nodeId: binding.nodeId,
    snapshot: input.body });
  assert.ok(Object.isFrozen(reserved));
  const uncertain = markNativeResultReservationStorageUncertainV1({ reservation: reserved,
    uncertaintyDigest: digest("u") });
  assert.equal(uncertain.state, "storage_uncertain");
  assert.throws(() => markNativeResultReservationStorageUncertainV1({ reservation: uncertain,
    uncertaintyDigest: digest("v") }), /native_result_reservation_conflict/);
});

test("the backup inventory includes the neutral receipt and exact stored bytes", async t => {
  const f = await setupWithProvision("run:durable-inventory"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-inventory";
  const receivedAt = at(10_100);
  const captured = await publishDurableResultV1(configOf(f, storage),
    { binding: nativeBinding(runId), bytes: bytesOf("inventory"), receivedAt, assertAuthority: () => {} });
  const reservationRow = f.restartReservations.peek(binding.tenantId, runId);
  assert.ok(reservationRow);
  const reservationRows = [{ reservation: reservationRow!.reservation, auth_tag: reservationRow!.auth_tag }];
  const receiptRows = (await f.db.query<{ receipt: unknown; auth_tag: string; manifest: unknown }>(
    `SELECT r.receipt,r.auth_tag,m.payload AS manifest FROM control_native_artifact_receipts r
     JOIN control_artifact_manifests m ON m.tenant_id=r.tenant_id AND m.id=r.artifact_id
     AND m.project_id=r.project_id AND m.job_id=r.job_id AND m.attempt_id=r.attempt_id
     WHERE r.tenant_id=$1 AND r.run_id=$2`, [binding.tenantId, runId])).rows;
  const row = { tenant_id: binding.tenantId, project_id: binding.projectId, job_id: nativeBinding(runId).jobId,
    attempt_id: nativeBinding(runId).attemptId, run_id: runId, artifact_id: captured.receipt.artifactId,
    receipt: receiptRows[0].receipt, receipt_auth_tag: receiptRows[0].auth_tag, manifest: receiptRows[0].manifest,
    reservation: reservationRows[0].reservation, reservation_auth_tag: reservationRows[0].auth_tag };
  const database = (rows: unknown[]): Pick<DatabaseClient, "query"> => ({ query: async <T>() => ({ rows: rows as T[] }) });
  const opened = await openPrivateArtifactStorageV1(
    { local: { rootPath: "memory:durable-inventory-test", maximumArtifacts: 20, maximumFileBytes: 65_536,
      maximumTotalBytes: 1_000_000, operationTimeoutMs: 2_000 },
    inventory: { releaseId: "release:test", releaseDigest: digest("r"), databaseSchemaVersion: "schema:71",
      databaseSchemaDigest: digest("s"), storageNamespace: "artifact-namespace:test",
      storageNamespaceDigest: privateArtifactStorageNamespaceDigestV1("artifact-namespace:test",
        "memory:durable-inventory-test") } },
    async () => ({ put: storage.put.bind(storage), read: storage.read.bind(storage) }));
  const captured_inventory = await opened.captureInventory(database([row]), binding.tenantId, f.resultKey);
  assert.deepEqual(captured_inventory.entries, [{ artifactId: captured.receipt.artifactId,
    contentHash: captured.receipt.contentHash, sizeBytes: captured.receipt.sizeBytes,
    manifestDigest: captured.receipt.manifestDigest, receiptDigest: sha256Digest(captured.receipt) }]);
  await assert.rejects(opened.captureInventory(database([{ ...row,
    receipt_auth_tag: hmacSha256Tag(f.resultKey, { purpose: "durable-result-receipt/v1",
      receipt: { ...(row.receipt as object), sizeBytes: 1 } }) }]), binding.tenantId, f.resultKey),
  /private_artifact_storage_unavailable/);
});
