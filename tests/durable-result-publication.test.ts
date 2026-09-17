import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { publishDurableResultV1, readDurableResultV1, reconcileDurableResultReservationCrashV1,
  type DurableResultBindingV1 } from "../src/artifacts/v1/durable-result-publication";
import { durableReceiptFromCodexV1, durableReceiptFromNativeV1 } from "../src/artifacts/v1/durable-result-receipt";
import { publishHermesSessionResultV1,
  type HermesSessionResultOutcomeV1 } from "../src/harness/hermes-gpt-v1/result-publication";
import { projectClaudeTerminalResultEvidenceV1,
  terminalResultEvidenceSchemaV1 } from "../src/harness/v1/terminal-result-evidence";
import { reserveNativeResultWriteV1, markNativeResultReservationStorageUncertainV1 } from "../src/artifacts/v1/native-result-reservation";
import { resultBytesHash } from "../src/artifacts/v1/native-results";
import { taskReviewTargetV1 } from "../src/completion-gate/v1/task-review-plan";
import { readDurableResultReviewPlanV1, verifyReviewPlanAgainstReceiptV1 } from "../src/completion-gate/v1/durable-result-review-plan";
import { openPrivateArtifactStorageV1, privateArtifactStorageNamespaceDigestV1 } from "../src/web/v1/private-artifact-storage";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../src/node-executor/artifact-storage";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { sha256Digest } from "../src/security";
import { createDurableReservationPostgresPortV1 } from "../src/artifacts/v1/neutral-reservation-postgres";
import { createInMemoryNeutralReservationPort, createPersistentNeutralReservationPort,
  createPersistentNeutralReservationStore,
  type NeutralReservationPort } from "../src/artifacts/v1/neutral-reservation-port";
import { binding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { webNativeResultFixture } from "./helpers/web-native-result";

const digest = (seed = "a") => `sha256:${createHash("sha256").update(`durable-test:${seed}`).digest("hex")}`;

/**
 * Namespace identity only: the storage port is injected, so no directory is
 * opened or created. Resolved rather than written as a POSIX literal so the
 * root stays canonical on every platform a contributor runs this lane from.
 */
const syntheticRoot = resolve("/synthetic/durable-inventory-test");

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
  // production PostgreSQL adapter is exercised separately against the real
  // migration-0077 table; these two shims keep the publisher's own behavior
  // tests independent of a database round trip. Tests inject either:
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
  reservations: NeutralReservationPort = f.restartReservations) {
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

test("verifyReviewPlanAgainstReceiptV1: a stored plan and its receipt must agree on every carried field", async t => {
  const f = await setupWithProvision("run:durable-planverify"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-planverify";
  const receivedAt = at(9500);
  const captured = await publishDurableResultV1(configOf(f, storage),
    { binding: nativeBinding(runId), bytes: bytesOf("planverify"), receivedAt, assertAuthority: () => {} });
  const plan = await f.db.transaction(tx => readDurableResultReviewPlanV1(tx, f.reviewKey,
    binding.tenantId, binding.projectId, nativeBinding(runId).jobId));
  assert.ok(plan);
  // Happy path: the stored plan and the live receipt agree.
  assert.doesNotThrow(() => verifyReviewPlanAgainstReceiptV1(plan!, captured.receipt));
  // Tampered receiptDigest: verify fails closed.
  assert.throws(() => verifyReviewPlanAgainstReceiptV1({ ...plan!, receiptDigest: digest("tampered") }, captured.receipt),
    /durable_result_review_plan_unavailable/);
  // Foreign receipt (different run/jobId): verify fails closed.
  const foreign = { ...captured.receipt, runId: "run:other", jobId: "job:other" };
  assert.throws(() => verifyReviewPlanAgainstReceiptV1(plan!, foreign),
    /durable_result_review_plan_unavailable/);
  // Foreign harness: verify fails closed.
  assert.throws(() => verifyReviewPlanAgainstReceiptV1({ ...plan!, harness: "codex" }, captured.receipt),
    /durable_result_review_plan_unavailable/);
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

test("the backup inventory captures the neutral result through the actual reader and the reservation boundary", async t => {
  const f = await setupWithProvision("run:durable-inventory"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-inventory";
  const receivedAt = at(10_100);
  const captured = await publishDurableResultV1(configOf(f, storage),
    { binding: nativeBinding(runId), bytes: bytesOf("inventory"), receivedAt, assertAuthority: () => {} });
  const opened = await openPrivateArtifactStorageV1(
    // Absolute canonical namespace root, matching the operator-configuration
    // contract. The storage port is injected, so no directory is opened or
    // created; the path is namespace identity only. Resolved rather than
    // written as a POSIX literal so the root stays canonical on every
    // platform a contributor runs this lane from.
    { local: { rootPath: syntheticRoot, maximumArtifacts: 20, maximumFileBytes: 65_536,
      maximumTotalBytes: 1_000_000, operationTimeoutMs: 2_000 },
    inventory: { releaseId: "release:test", releaseDigest: digest("r"), databaseSchemaVersion: "schema:71",
      databaseSchemaDigest: digest("s"), storageNamespace: "artifact-namespace:test",
      storageNamespaceDigest: privateArtifactStorageNamespaceDigestV1("artifact-namespace:test",
        syntheticRoot) } },
    async () => ({ put: storage.put.bind(storage), read: storage.read.bind(storage) }));
  // Without the neutral reservation boundary the actual reader fails
  // closed: its SQL join finds receipt and manifest rows but no native-table
  // reservation for the neutral record. This is the gap the boundary closes.
  await assert.rejects(opened.captureInventory(f.db, binding.tenantId, f.resultKey),
    /private_artifact_storage_unavailable/);
  // Through the boundary port the actual reader — real SQL against the real
  // test database, no fabricated joined row — captures the neutral receipt
  // and exact stored bytes.
  const captured_inventory = await opened.captureInventory(f.db, binding.tenantId, f.resultKey,
    undefined, f.restartReservations);
  assert.deepEqual(captured_inventory.entries, [{ artifactId: captured.receipt.artifactId,
    contentHash: captured.receipt.contentHash, sizeBytes: captured.receipt.sizeBytes,
    manifestDigest: captured.receipt.manifestDigest, receiptDigest: sha256Digest(captured.receipt) }]);
  // A wrong integrity key fails closed through the same actual reader:
  // neither the receipt nor the reservation auth tag verifies.
  await assert.rejects(opened.captureInventory(f.db, binding.tenantId, new Uint8Array(32).fill(7),
    undefined, f.restartReservations), /private_artifact_storage_unavailable/);
});

test("the PostgreSQL adapter persists the neutral reservation in its own table and replays over the same database", async t => {
  const f = await setupWithProvision("run:pg-durable"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:pg-durable";
  const port = createDurableReservationPostgresPortV1();
  // One submission replayed after a restart carries its original receipt
  // instant; the bound review plan is part of that submission's identity.
  const receivedAt = at(10_100);

  const first = await publishDurableResultV1(configOf(f, storage, port),
    { binding: nativeBinding(runId), bytes: bytesOf("pg"), receivedAt, assertAuthority: () => {} });
  assert.equal(first.replayed, false);
  assert.equal(storage.putCalls, 1);

  // The row lands in the neutral sibling table only. The native-only table
  // from migration 0071 is untouched, so no schema literal or role boundary
  // was widened to make this record fit.
  const stored = (await f.db.query<{ state: string; schema: string; created_at: string | Date }>(
    `SELECT state, reservation->>'schema' AS schema, created_at
     FROM control_durable_result_write_reservations WHERE tenant_id=$1 AND run_id=$2`,
    [binding.tenantId, runId])).rows;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].state, "metadata_committed");
  assert.equal(stored[0].schema, "control-room.durable-result-write-reservation/v1");
  const native = (await f.db.query(
    "SELECT run_id FROM control_native_result_write_reservations WHERE tenant_id=$1 AND run_id=$2",
    [binding.tenantId, runId])).rows;
  assert.equal(native.length, 0);

  // Acceptance property: reconstructing over the same database and the same
  // persistent bytes returns the identical verified receipt and writes no
  // second copy. A brand-new port instance holds no state of its own.
  const replay = await publishDurableResultV1(
    configOf(f, storage, createDurableReservationPostgresPortV1()),
    { binding: nativeBinding(runId), bytes: bytesOf("pg"), receivedAt, assertAuthority: () => {} });
  assert.equal(replay.replayed, true);
  assert.equal(storage.putCalls, 1);
  assert.deepEqual(replay.receipt, first.receipt);
});

test("the PostgreSQL adapter reports both uniqueness conflicts without aborting the transaction", async t => {
  const f = await setupWithProvision("run:pg-conflict"); t.after(f.close);
  const port = createDurableReservationPostgresPortV1();
  const runId = "run:pg-conflict";
  await publishDurableResultV1(configOf(f, new ControlledStorage(), port),
    { binding: nativeBinding(runId), bytes: bytesOf("conflict"), receivedAt: at(10_100), assertAuthority: () => {} });

  const existing = await f.db.transaction(tx => port.findForUpdate(tx, binding.tenantId, runId));
  assert.ok(existing);

  // The table's mirror CHECK is evaluated before uniqueness, so a colliding
  // row must still mirror its own reservation body exactly. Rewrite both the
  // column and the mirrored identity field together.
  const mirrored = (row: typeof existing, field: "run_id" | "artifact_id", value: string) => {
    const reservation = structuredClone(row.reservation) as { identity: Record<string, unknown> };
    reservation.identity[field === "run_id" ? "runId" : "artifactId"] = value;
    return { ...row, [field]: value, reservation };
  };

  await f.db.transaction(async tx => {
    // Same (tenant, run): the primary key collides.
    assert.equal(await port.insertFresh(tx, mirrored(existing, "artifact_id", "artifact:other")), "conflict");
    // Same (tenant, artifact) under a different run: the artifact uniqueness
    // collides instead. Both must report `conflict`, and neither may poison
    // the surrounding transaction — a raised unique violation would turn an
    // ordinary replay into an unrecoverable failure.
    assert.equal(await port.insertFresh(tx, mirrored(existing, "run_id", "run:pg-conflict-other")), "conflict");
    // The transaction is still usable, which is the property under test.
    assert.ok(await port.findForUpdate(tx, binding.tenantId, runId));
  });
});

test("compareAndSwap applies only on the exact prior state and preserves created_at", async t => {
  const f = await setupWithProvision("run:pg-swap"); t.after(f.close);
  const port = createDurableReservationPostgresPortV1();
  const runId = "run:pg-swap";
  await publishDurableResultV1(configOf(f, new ControlledStorage(), port),
    { binding: nativeBinding(runId), bytes: bytesOf("swap"), receivedAt: at(10_100), assertAuthority: () => {} });
  const committed = await f.db.transaction(tx => port.findForUpdate(tx, binding.tenantId, runId));
  assert.ok(committed);
  assert.equal(committed.state, "metadata_committed");

  await f.db.transaction(async tx => {
    // A stale prior state changes nothing and reports false.
    assert.equal(await port.compareAndSwap(tx,
      { tenantId: binding.tenantId, runId, state: "reserved", contractDigest: committed.contract_digest },
      { ...committed, state: "storage_uncertain", updated_at: at(10_500) }), false);
    // A stale contract digest is equally refused even with the right state.
    assert.equal(await port.compareAndSwap(tx,
      { tenantId: binding.tenantId, runId, state: committed.state, contractDigest: digest("stale") },
      { ...committed, state: "storage_uncertain", updated_at: at(10_500) }), false);
    const unchanged = await port.findForUpdate(tx, binding.tenantId, runId);
    assert.deepEqual(unchanged, committed);
  });

  // The database's own trigger independently refuses an illegal transition,
  // so the adapter cannot be used to walk the state machine backwards.
  await assert.rejects(f.db.transaction(tx => port.compareAndSwap(tx,
    { tenantId: binding.tenantId, runId, state: committed.state, contractDigest: committed.contract_digest },
    { ...committed, state: "reserved", updated_at: at(10_500) })), /transition rejected/);

  // created_at is never in SET, so a legal swap preserves the creation instant.
  const reserved = await setupWithProvision("run:pg-created"); t.after(reserved.close);
  const freshPort = createDurableReservationPostgresPortV1();
  await publishDurableResultV1(configOf(reserved, new ControlledStorage(), freshPort),
    { binding: nativeBinding("run:pg-created"), bytes: bytesOf("created"), receivedAt: at(10_100),
      assertAuthority: () => {} });
  const row = (await reserved.db.query<{ created_at: string | Date; updated_at: string | Date }>(
    `SELECT created_at, updated_at FROM control_durable_result_write_reservations
     WHERE tenant_id=$1 AND run_id=$2`, [binding.tenantId, "run:pg-created"])).rows[0];
  assert.equal(new Date(row.created_at).toISOString(), at(10_100));
  assert.ok(new Date(row.updated_at).getTime() >= new Date(row.created_at).getTime());
});

test("the PostgreSQL adapter refuses an unusable session and an ambiguous row", async t => {
  const f = await setupWithProvision("run:pg-guard"); t.after(f.close);
  const port = createDurableReservationPostgresPortV1();
  await assert.rejects(port.findForUpdate(undefined as never, binding.tenantId, "run:pg-guard"),
    /durable_reservation_session_invalid/);
  await assert.rejects(port.findForUpdate({ query: "not a function" } as never, binding.tenantId, "run:pg-guard"),
    /durable_reservation_session_invalid/);
  // A row missing an identity column is rejected rather than returned as a
  // partially-formed reservation for the publisher to verify.
  await assert.rejects(port.findForUpdate(
    { query: async () => ({ rows: [{ tenant_id: "", project_id: "p", job_id: "j", attempt_id: "a", run_id: "r",
      artifact_id: "x", identity_digest: "d", state: "reserved", contract_digest: "c", reservation: {},
      auth_tag: "t", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }] }) } as never,
    binding.tenantId, "run:pg-guard"), /durable_reservation_row_invalid/);
  assert.equal(await port.findForUpdate(
    { query: async () => ({ rows: [] }) } as never, binding.tenantId, "run:pg-guard"), null);
});

test("the PostgreSQL adapter emits the row-lock clause, normalizes instants and rejects a non-object body", async t => {
  const f = await setupWithProvision("run:pg-shape"); t.after(f.close);
  const port = createDurableReservationPostgresPortV1();
  const runId = "run:pg-shape";
  await publishDurableResultV1(configOf(f, new ControlledStorage(), port),
    { binding: nativeBinding(runId), bytes: bytesOf("shape"), receivedAt: at(10_100), assertAuthority: () => {} });

  // PGlite is single-connection, so no test in this repository can observe a
  // real row lock. Assert the emitted statement instead: this is a guard
  // against a refactor silently dropping the clause, NOT a concurrency proof.
  const statements: string[] = [];
  const recording = { query: async (statement: string) => { statements.push(statement); return { rows: [] }; } };
  assert.equal(await port.findForUpdate(recording as never, binding.tenantId, runId), null);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /FOR UPDATE\s*$/);
  assert.match(statements[0], /FROM control_durable_result_write_reservations/);
  // The neutral adapter must never read the native-only sibling table.
  assert.ok(!statements[0].includes("control_native_result_write_reservations"));

  // timestamptz arrives as a Date; the port interface declares strings.
  const committed = await f.db.transaction(tx => port.findForUpdate(tx, binding.tenantId, runId));
  assert.ok(committed);
  assert.equal(typeof committed.created_at, "string");
  assert.equal(typeof committed.updated_at, "string");
  assert.equal(new Date(committed.created_at).toISOString(), committed.created_at);

  // A jsonb array or scalar is not a reservation body and never reaches the publisher.
  for (const body of [[1, 2], 7, "text", null]) {
    await assert.rejects(port.findForUpdate(
      { query: async () => ({ rows: [{ ...committed, reservation: body }] }) } as never,
      binding.tenantId, runId), /durable_reservation_row_invalid/);
  }
  // An unparseable instant is refused rather than returned as "Invalid Date".
  await assert.rejects(port.findForUpdate(
    { query: async () => ({ rows: [{ ...committed, created_at: new Date(Number.NaN) }] }) } as never,
    binding.tenantId, runId), /durable_reservation_row_invalid/);
});

test("reconstructing over the same persistent directory and database returns the same receipt without rewriting", async t => {
  const f = await setupWithProvision("run:pg-persistent"); t.after(f.close);
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-durable-persistent-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "run:pg-persistent";
  const receivedAt = at(10_100);

  const namespace = "artifact-namespace:durable-persistent";
  const storageConfiguration = {
    local: { rootPath: root, maximumArtifacts: 10, maximumFileBytes: 65_536,
      maximumTotalBytes: 1_000_000, operationTimeoutMs: 2_000 },
    inventory: { releaseId: "release:durable", releaseDigest: digest("r"),
      databaseSchemaVersion: "schema:77", databaseSchemaDigest: digest("s"),
      storageNamespace: namespace,
      storageNamespaceDigest: privateArtifactStorageNamespaceDigestV1(namespace, root) },
  };

  /** Counts real byte writes without replacing the real filesystem store. */
  const counting = (inner: Awaited<ReturnType<typeof openPrivateArtifactStorageV1>>["storage"]) => {
    const calls = { put: 0 };
    return { calls, port: { put: (input: Parameters<typeof inner.put>[0]) => { calls.put++; return inner.put(input); },
      read: (artifactId: string, signal?: AbortSignal) => inner.read(artifactId, signal) } };
  };

  // Publish once through the real persistent local store and the real
  // PostgreSQL reservation adapter.
  const opened = await openPrivateArtifactStorageV1(storageConfiguration);
  const first = counting(opened.storage);
  const published = await publishDurableResultV1(
    { db: f.db, integrityKey: f.resultKey, reviewKey: f.reviewKey, storage: first.port,
      storageClass: "local" as const, reservations: createDurableReservationPostgresPortV1() },
    { binding: nativeBinding(runId), bytes: bytesOf("persistent"), receivedAt, assertAuthority: () => {} });
  assert.equal(published.replayed, false);
  assert.equal(first.calls.put, 1);

  // The bytes are on disk, and their exact on-disk identity is recorded.
  const entries = await readdir(root);
  assert.equal(entries.length, 1);
  const before = await stat(join(root, entries[0]));

  // Reconstruct BOTH adapters: a new storage object opened over the same
  // directory, and a new reservation port over the same database. Neither
  // carries state from the first pass.
  const reopened = await openPrivateArtifactStorageV1(storageConfiguration);
  const second = counting(reopened.storage);
  const replay = await publishDurableResultV1(
    { db: f.db, integrityKey: f.resultKey, reviewKey: f.reviewKey, storage: second.port,
      storageClass: "local" as const, reservations: createDurableReservationPostgresPortV1() },
    { binding: nativeBinding(runId), bytes: bytesOf("persistent"), receivedAt, assertAuthority: () => {} });

  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, published.receipt);
  // No second byte write reached the real store, and the stored file is
  // untouched: same inode, size and modification time.
  assert.equal(second.calls.put, 0);
  const after = await stat(join(root, entries[0]));
  assert.deepEqual(await readdir(root), entries);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);

  // The reconstructed store still returns the exact verified text through the
  // ordinary protected reader, from bytes read off the same directory.
  const reread = await f.db.transaction(tx => readDurableResultV1(tx, f.resultKey, "local",
    (artifactId: string, signal?: AbortSignal) => reopened.storage.read(artifactId, signal),
    binding.tenantId, binding.projectId, nativeBinding(runId).jobId, published.receipt.artifactId));
  assert.equal(reread?.text, text("persistent"));
});


/* ------------------------------------------------------------------ */
/* Upstream Hermes session result publication                          */
/* ------------------------------------------------------------------ */

/**
 * Construct the upstream Hermes session outcome (the success side of the
 * pinned `hermes_session_job_result` reply, lifted into the durable
 * publisher's input shape). Matches the `HermesSessionResultOutcomeV1`
 * completed variant in `session-runtime.ts`.
 */
function upstreamHermesOutcome(runId: string, overrides: Partial<{
  text: string; truncated: boolean; ceilingTruncated: boolean; returnCode: number | null;
  upstreamJobId: string; upstreamSessionId: string; sessionIdResolved: boolean;
}> = {}): HermesSessionResultOutcomeV1 {
  const text = overrides.text ?? "exact upstream terminal result";
  const upstreamJobId = overrides.upstreamJobId ?? "0123456789abcdef0123456789abcdef";
  const upstreamSessionId = overrides.upstreamSessionId ?? `session:${runId}`;
  const textBytes = new TextEncoder().encode(text);
  return {
    kind: "completed",
    schema: "control-room.hermes-session-outcome/v1" as never,
    binding: { lineage: {
      tenantId: binding.tenantId, projectId: binding.projectId,
      jobId: `job:${runId}`, attemptId: `attempt:${runId}`,
      runId, nodeId: binding.nodeId,
    }, sessionId: upstreamSessionId },
    upstreamJobId, upstreamSessionId,
    sessionIdResolvedByUpstream: overrides.sessionIdResolved ?? false,
    text,
    contentHash: resultBytesHash(textBytes),
    sizeBytes: textBytes.byteLength,
    upstreamTruncated: overrides.truncated ?? false,
    ceilingTruncated: overrides.ceilingTruncated ?? false,
    returnCode: overrides.returnCode ?? 0,
    canonicalPublicationAllowed: false,
    qualityAccepted: false,
    completionRecorded: false,
    grantsExecutionAuthority: false,
    permitsRetry: false,
    permitsResume: false,
  };
}

/**
 * Independently retained, already-authenticated upstream binding for a run.
 * Deliberately a SEPARATE source from the outcome: the adapter must compare
 * the two, so the retained side is built here from the caller's own record
 * of the run, not from anything the outcome produced.
 */
function retainedBindingFor(runId: string, overrides: Partial<{
  upstreamJobId: string; upstreamSessionId: string; connectorProfileDigest: string;
  lineage: { tenantId: string; projectId: string; jobId: string; attemptId: string;
             runId: string; nodeId: string };
}> = {}) {
  return {
    lineage: overrides.lineage ?? {
      tenantId: binding.tenantId, projectId: binding.projectId,
      jobId: `job:${runId}`, attemptId: `attempt:${runId}`,
      runId, nodeId: binding.nodeId,
    },
    upstreamSessionId: overrides.upstreamSessionId ?? `session:${runId}`,
    upstreamJobId: overrides.upstreamJobId ?? "0123456789abcdef0123456789abcdef",
    connectorProfileDigest: overrides.connectorProfileDigest ?? digest("c"),
  };
}

function upstreamHermesInput(
  runId: string,
  overrides: Parameters<typeof upstreamHermesOutcome>[1] = {},
  retainedOverrides: Parameters<typeof retainedBindingFor>[1] = {},
) {
  return {
    outcome: upstreamHermesOutcome(runId, overrides),
    retainedBinding: retainedBindingFor(runId, retainedOverrides),
    workflowId: "workflow:test",
    assertAuthority: () => {},
    acceptanceProfile: { id: "profile:test:upstream-hermes", digest: digest("acceptance-profile") },
  };
}

test("upstream Hermes: a completed session result publishes exactly once and replays the existing receipt", async t => {
  const f = await setupWithProvision("run:durable-upstream-hermes"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-upstream-hermes";
  const receivedAt = at(9300);
  const input = upstreamHermesInput(runId);
  const first = await publishHermesSessionResultV1(configOf(f, storage), { ...input, receivedAt });
  assert.equal(first.replayed, false);
  // The receipt is inert; the connector profile digest is bound into the
  // identity and surfaced on the receipt.
  assert.equal(first.receipt.harness, "upstream-hermes");
  assert.equal(first.receipt.connectorProfileDigest, digest("c"));
  assert.equal(first.receipt.contentHash, resultBytesHash(new TextEncoder().encode("exact upstream terminal result")));
  // The receipt carries no snapshot, no publication contract, and no
  // thread/turn/item — those are the native/codex concerns, not the
  // upstream connector's.
  assert.equal(first.receipt.snapshotDigest, undefined);
  assert.equal(first.receipt.publicationContractDigest, undefined);
  assert.equal(first.receipt.terminalEvidenceDigest, undefined);
  assert.equal(first.receipt.threadId, undefined);
  assert.equal(first.receipt.turnId, undefined);
  assert.equal(first.receipt.itemId, undefined);
  // The projected evidence is frozen and bound to upstream identity.
  assert.equal(first.evidence.kind, "upstream_hermes_session_result");
  // The published identity is consistent with the retained binding.
  //
  // This is a CONSISTENCY check, not a PROVENANCE check, and it deliberately
  // asserts nothing more. The durable publication path refuses any completed
  // outcome whose upstream identity differs from the independently retained
  // binding before it projects or persists anything, so on any successful
  // publication the two sides are equal by construction. No assertion at this
  // point can therefore distinguish which input the projection actually read:
  // pointing it at the outcome's values instead would read the same value and
  // pass identically. (Verified by mutation: substituting the outcome's values
  // for the retained ones at the projection call still passes this test.)
  //
  // Provenance is proven where the two sides are made to differ, which is what
  // forces the guard to fire:
  //   - the adapter: "a complete but FOREIGN outcome fails closed against
  //     every retained boundary" below (foreign job id, session id, and
  //     lineage, each refused with zero durable writes);
  //   - the projection: "refuses upstream Hermes evidence for mismatched
  //     upstream identity and tampered digests" in
  //     terminal-result-evidence.test.ts, whose wrong-job-id and
  //     wrong-session-id cases supply a retained identity that differs from
  //     the reply and would not be refused by a self-comparing projector.
  assert.equal(first.evidence.source.upstreamSessionId, retainedBindingFor(runId).upstreamSessionId);
  assert.equal(first.evidence.source.upstreamJobId, retainedBindingFor(runId).upstreamJobId);
  assert.equal(first.evidence.source.connectorProfileDigest, digest("c"));
  assert.equal(first.evidence.source.upstreamTruncated, false);
  assert.equal(first.evidence.source.upstreamCeilingTruncated, false);
  assert.equal(first.evidence.content.sizeBytes, Buffer.byteLength("exact upstream terminal result"));
  assert.equal(first.evidence.canonicalPublicationAllowed, false);
  assert.equal(first.evidence.qualityAccepted, false);
  assert.equal(first.evidence.completionRecorded, false);
  assert.equal(first.evidence.grantsExecutionAuthority, false);
  assert.equal(first.evidence.permitsRetry, false);
  assert.equal(first.evidence.permitsResume, false);
  // The pending owner-review target is recorded. Review is required: the
  // publisher grants no execution authority. The durable target carries
  // the receipt digest as its subject and is frozen for downstream readers.
  // The durable review target carries the binding's jobId as its subject
  // (the publisher's contract uses the durable identity, not the artifact),
  // and the receipt content hash as the subject digest.
  assert.equal(first.target.subjectId, `job:${runId}`);
  assert.equal(first.target.subjectDigest, first.receipt.contentHash);
  assert.equal(first.target.revisionNumber, 0);
  assert.ok(Object.isFrozen(first.evidence));

  // Exact replay: same outcome, same durable identity, no second write.
  const replayed = await publishHermesSessionResultV1(configOf(f, storage), { ...input, receivedAt });
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.receipt, first.receipt);
  assert.deepEqual(replayed.evidence, first.evidence);
  // The replay target is a fresh object with the same content; assert the
  // identifying fields rather than reference identity.
  assert.equal(replayed.target.id, first.target.id);
  assert.equal(replayed.target.subjectId, first.target.subjectId);
  assert.equal(replayed.target.subjectDigest, first.target.subjectDigest);
  assert.equal(replayed.target.acceptanceProfileDigest, first.target.acceptanceProfileDigest);
  // No second byte write reached the storage port.
  assert.equal(storage.putCalls, 1);

  // The ordinary protected reader returns the verified text. The reader
  // keys on the binding's jobId, which for this fixture is
  // `job:run:durable-upstream-hermes` (see upstreamHermesInput above).
  const read = await f.db.transaction(tx => readDurableResultV1(tx, f.resultKey, "local",
    (artifactId, signal) => storage.read(artifactId, signal),
    binding.tenantId, binding.projectId, `job:${runId}`, first.receipt.artifactId));
  assert.equal(read?.text, "exact upstream terminal result");
});

test("upstream Hermes: changed text under the same durable identity fails closed without rewriting", async t => {
  const f = await setupWithProvision("run:durable-upstream-hermes-changed"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-upstream-hermes-changed";
  const receivedAt = at(9400);
  await publishHermesSessionResultV1(configOf(f, storage), { ...upstreamHermesInput(runId, { text: "original" }), receivedAt });
  const before = storage.putCalls;
  // A forged second publication with different text must fail closed at the
  // identity-mismatch check inside the durable publisher.
  await assert.rejects(publishHermesSessionResultV1(configOf(f, storage),
    { ...upstreamHermesInput(runId, { text: "forged" }), receivedAt }),
    /durable_result_reservation_conflict|durable_result_identity_mismatch|durable_result_manual_reconciliation_required|durable_result_storage_uncertain/);
  // No second byte write reached the storage port.
  assert.equal(storage.putCalls, before);
});

test("upstream Hermes: wrong upstream job id / wrong connector profile digest fail closed without durable writes", async t => {
  const f = await setupWithProvision("run:durable-upstream-hermes-id"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-upstream-hermes-id";
  const receivedAt = at(9500);
  // Malformed retained job id: rejected on shape before any comparison.
  await assert.rejects(publishHermesSessionResultV1(configOf(f, storage),
    { ...upstreamHermesInput(runId, {}, { upstreamJobId: "not-hex-job-id" }), receivedAt }),
    /upstream_hermes_invalid_upstream_job_id/);
  // Wrong connector profile digest: the durable publisher's
  // `verifyRecordedIdentity` rejects the binding before any write.
  await assert.rejects(publishHermesSessionResultV1(configOf(f, storage),
    { ...upstreamHermesInput(runId, {}, { connectorProfileDigest: digest("wrong-profile") }), receivedAt }),
    /durable_result_identity_mismatch/);
  assert.equal(storage.putCalls, 0);
});

test("upstream Hermes: a complete but FOREIGN outcome fails closed against every retained boundary", async t => {
  const f = await setupWithProvision("run:durable-upstream-hermes-foreign"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-upstream-hermes-foreign";
  const receivedAt = at(9550);

  // Each case below submits a structurally valid, fully self-consistent
  // outcome: real text, and a contentHash/sizeBytes pair recomputed from
  // that text by the same builder the adapter uses. Nothing inside the
  // outcome is wrong on its own terms — it is simply not the result the
  // caller authenticated. Only the retained binding can tell.

  // (a) Foreign upstream job id, valid retained job id.
  await assert.rejects(publishHermesSessionResultV1(configOf(f, storage),
    { ...upstreamHermesInput(runId, { upstreamJobId: "fedcba9876543210fedcba9876543210" }), receivedAt }),
    /upstream_hermes_retained_upstream_job_id_mismatch/);

  // (b) Foreign upstream session id — the case the previous round wrongly
  //     dismissed as impossible. The outcome is complete and correctly
  //     hashed; only the retained session id disagrees.
  await assert.rejects(publishHermesSessionResultV1(configOf(f, storage),
    { ...upstreamHermesInput(runId, { upstreamSessionId: "session:foreign" }), receivedAt }),
    /upstream_hermes_retained_upstream_session_id_mismatch/);

  // (c) Foreign lineage: the CALLER retained a different run id than the
  //     outcome carries, everything else well-formed. The retained side is
  //     the trusted one, so the override goes on the retained argument.
  await assert.rejects(publishHermesSessionResultV1(configOf(f, storage),
    { ...upstreamHermesInput(runId, {}, { lineage: {
        tenantId: binding.tenantId, projectId: binding.projectId,
        jobId: `job:${runId}`, attemptId: `attempt:${runId}`,
        runId: "run:some-other-run", nodeId: binding.nodeId } }), receivedAt }),
    /upstream_hermes_retained_lineage_mismatch/);

  // (d) Foreign project lineage only — one field of six, again on the
  //     retained side.
  await assert.rejects(publishHermesSessionResultV1(configOf(f, storage),
    { ...upstreamHermesInput(runId, {}, { lineage: {
        tenantId: binding.tenantId, projectId: "project:someone-else",
        jobId: `job:${runId}`, attemptId: `attempt:${runId}`,
        runId, nodeId: binding.nodeId } }), receivedAt }),
    /upstream_hermes_retained_lineage_mismatch/);

  // Not one byte reached storage across all four foreign outcomes.
  assert.equal(storage.putCalls, 0);
});

test("upstream Hermes: every non-completed outcome is refused before publication", async t => {
  const f = await setupWithProvision("run:durable-upstream-hermes-states"); t.after(f.close);
  const storage = new ControlledStorage();
  for (const kind of ["failed", "uncertain", "pending", "unknown_job", "invalid"] as const) {
    const outcome = {
      kind, ...(kind === "failed" ? { state: "failed", returnCode: 1 }
        : kind === "uncertain" ? { state: "orphaned", reason: "process not owned" }
        : kind === "pending" ? { state: "running" }
        : kind === "unknown_job" ? { detail: "no such job" }
        : { reason: "invalid reply" }),
    } as HermesSessionResultOutcomeV1;
    await assert.rejects(publishHermesSessionResultV1(configOf(f, storage),
      { outcome, retainedBinding: retainedBindingFor("run:durable-upstream-hermes-states"),
        workflowId: "workflow:test", assertAuthority: () => {},
        receivedAt: "2026-09-15T12:00:00.000Z",
        acceptanceProfile: { id: "profile:test:upstream-hermes", digest: digest("acceptance-profile") } }),
      /upstream_hermes_session_result_not_completed|terminal_result_evidence_unavailable/);
  }
  assert.equal(storage.putCalls, 0);
});

test("upstream Hermes: authority loss before each durable effect aborts the publication with zero writes", async t => {
  const f = await setupWithProvision("run:durable-upstream-hermes-auth"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-upstream-hermes-auth";
  let authorityCalls = 0;
  const losing = () => { authorityCalls++; throw new Error("upstream_binding_revoked"); };
  await assert.rejects(publishHermesSessionResultV1(configOf(f, storage),
    { ...upstreamHermesInput(runId), receivedAt: "2026-09-15T12:00:00.000Z", assertAuthority: losing }),
    /upstream_binding_revoked/);
  // Authority is checked before the reservation write, before byte I/O,
  // before manifest/receipt/audit appends. Zero durable writes.
  assert.equal(storage.putCalls, 0);
  // The fence was invoked at least once (publisher's first assertAuthority).
  assert.ok(authorityCalls >= 1);
});

test("upstream Hermes: storage uncertainty surfaces as uncertainty and never grants permission to retry Hermes", async t => {
  const f = await setupWithProvision("run:durable-upstream-hermes-uncertain"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-upstream-hermes-uncertain";
  storage.throwAfterPut = true;
  await assert.rejects(publishHermesSessionResultV1(configOf(f, storage),
    { ...upstreamHermesInput(runId), receivedAt: at(9600) }),
    /durable_result_storage_uncertain/);
  // No completion, no retry grant.
  assert.equal(storage.putCalls, 1);
});

test("upstream Hermes: both truncation flags are preserved on the receipt", async t => {
  const f = await setupWithProvision("run:durable-upstream-hermes-trunc"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-upstream-hermes-trunc";
  const receivedAt = at(9700);
  const truncated = await publishHermesSessionResultV1(configOf(f, storage),
    { ...upstreamHermesInput(runId, { text: "trimmed to upstream ceiling", truncated: true, ceilingTruncated: true }),
      receivedAt });
  assert.equal(truncated.replayed, false);
  assert.equal(truncated.evidence.source.upstreamTruncated, true);
  assert.equal(truncated.evidence.source.upstreamCeilingTruncated, true);
  assert.equal(truncated.evidence.content.sizeBytes, Buffer.byteLength("trimmed to upstream ceiling"));
});

test("upstream Hermes: invalid connector profile digest shape is rejected without durable writes", async t => {
  const f = await setupWithProvision("run:durable-upstream-hermes-shape"); t.after(f.close);
  const storage = new ControlledStorage();
  const runId = "run:durable-upstream-hermes-shape";
  await assert.rejects(publishHermesSessionResultV1(configOf(f, storage),
    { ...upstreamHermesInput(runId, {}, { connectorProfileDigest: "not-a-digest" }),
      receivedAt: "2026-09-15T12:00:00.000Z" }),
    /upstream_hermes_invalid_connector_profile_digest/);
  assert.equal(storage.putCalls, 0);
});

/* ------------------------------------------------------------------ */
/* Shared terminal-evidence union: the Claude member.                   */
/*                                                                      */
/* The durable path's connector anchors are carried by the shared       */
/* `terminal-result-evidence` union. These cases prove the Claude       */
/* member discriminates on `kind` within that union and that a forged   */
/* evidence digest is refused there, alongside the members the other    */
/* harnesses already publish through. No database, storage or           */
/* reservation is involved: the projection is pure.                     */
/* ------------------------------------------------------------------ */

const CLAUDE_EVIDENCE_SESSION = "00000000-0000-4000-8000-0000000000c1";

function claudeTerminalLine(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false,
    session_id: CLAUDE_EVIDENCE_SESSION, result: "durable-lane Claude terminal result",
    total_cost_usd: 0, usage: {}, ...overrides });
}

function claudeEvidenceFor(rawLine = claudeTerminalLine()) {
  return projectClaudeTerminalResultEvidenceV1({
    lineage: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: "job:claude-union",
      attemptId: "attempt:claude-union", runId: "run:claude-union", nodeId: binding.nodeId },
    retained: { processAttemptId: "attempt.process.claude-union", sessionId: CLAUDE_EVIDENCE_SESSION,
      connectorProfileDigest: digest("claude-profile"),
      terminalFrameDigest: sha256Digest(JSON.parse(rawLine)) },
    terminalFrameRawLine: rawLine,
    resultSubtypeCode: "success",
    decoderFramesAccepted: 2,
    observedAt: at(9900),
  });
}

test("the shared terminal-evidence union discriminates the Claude member on kind", () => {
  const claude = claudeEvidenceFor();
  assert.equal(claude.kind, "claude_terminal_result");
  // The union accepts it and selects the Claude member, not a sibling.
  const parsed = terminalResultEvidenceSchemaV1.parse(claude);
  assert.equal(parsed.kind, "claude_terminal_result");
  assert.ok("terminalFrameDigest" in parsed.source);
  // The same evidence relabelled as another harness's kind no longer
  // satisfies that member's source shape, so the union cannot be crossed.
  for (const kind of ["hermes_native_snapshot", "codex_exact_completed_turn",
    "upstream_hermes_session_result"]) {
    assert.throws(() => terminalResultEvidenceSchemaV1.parse({ ...claude, kind }),
      /.*/, `relabelled as ${kind}`);
  }
  // It is inert, exactly like every other member of the union.
  assert.equal(claude.canonicalPublicationAllowed, false);
  assert.equal(claude.qualityAccepted, false);
  assert.equal(claude.completionRecorded, false);
  assert.equal(claude.grantsExecutionAuthority, false);
  assert.equal(claude.permitsRetry, false);
  assert.equal(claude.permitsResume, false);
  assert.ok(Object.isFrozen(claude));
});

test("a forged Claude evidence digest is refused by the shared union", () => {
  const claude = claudeEvidenceFor();
  // The digest is recomputed over the whole material, so every substitution
  // under a preserved digest is refused.
  for (const forged of [
    { content: { contentHash: digest("forged"), sizeBytes: 7 } },
    { lineage: { ...claude.lineage, runId: "run:claude-other" } },
    { source: { ...claude.source, sessionId: "00000000-0000-4000-8000-0000000000c2" } },
    { source: { ...claude.source, terminalFrameDigest: digest("forged-frame") } },
    { observedAt: at(9901) },
  ]) {
    assert.throws(() => terminalResultEvidenceSchemaV1.parse({ ...claude, ...forged }),
      /terminal result evidence digest mismatch/, JSON.stringify(Object.keys(forged)));
  }
  // And a projection over tampered material never re-derives the honest
  // evidence digest, so it cannot stand in for it.
  const tampered = claudeTerminalLine({ result: "text that was never observed" });
  assert.notEqual(claudeEvidenceFor(tampered).evidenceDigest, claude.evidenceDigest);
});

test("a claimed resultSubtypeCode that disagrees with the raw material is refused", () => {
  // The raw line, and the digest that binds it, genuinely say error_max_turns.
  // A caller cannot make that appear as "success" in shared evidence merely
  // by claiming a different resultSubtypeCode alongside the same raw line.
  const genuineFailureLine = claudeTerminalLine({ subtype: "error_max_turns" });
  assert.throws(() => projectClaudeTerminalResultEvidenceV1({
    lineage: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: "job:claude-union",
      attemptId: "attempt:claude-union", runId: "run:claude-union", nodeId: binding.nodeId },
    retained: { processAttemptId: "attempt.process.claude-union", sessionId: CLAUDE_EVIDENCE_SESSION,
      connectorProfileDigest: digest("claude-profile"),
      terminalFrameDigest: sha256Digest(JSON.parse(genuineFailureLine)) },
    terminalFrameRawLine: genuineFailureLine,
    resultSubtypeCode: "success",
    decoderFramesAccepted: 2,
    observedAt: at(9902),
  }), /terminal_result_evidence_unavailable/);

  // The honest pairing (raw subtype and claimed code agree) is unaffected.
  assert.equal(claudeEvidenceFor().kind, "claude_terminal_result");
});
