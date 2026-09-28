// Real PostgreSQL proof that an enforced resource stop lands in the run record.
//
// The supervision path is real here too: a real runaway child, stopped by the
// real supervisor, whose result is carried through the real delivery bridge
// and the real publish lifecycle into a real `control_harness_runs` history
// verified on read by `HarnessRunStoreV1` (run digest plus every event auth
// tag are re-checked on that read, so a forged or mismatched record throws).
//
// Two clocks are in play and both matter. This file owns a disposable
// PostgreSQL 17 cluster, started and removed on every exit path, because a
// change to process supervision is not done until it has run against a real
// database. The run record itself is written through the ledger schema via the
// real store. The delivery packet uses a live clock because the real receipt
// port refuses a receipt stamped outside the packet's issued/expires window.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { createOwnerTrustedLocalCodexExecV1 } from "../src/harness/codex-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalCliLifecycleV1 } from "../src/harness/v1/owner-trusted-local-cli-publish";
import { deliverOwnerTrustedLocalCliTaskV1 } from "../src/harness/v1/owner-trusted-local-cli-delivery";
import { createOwnerTrustedLocalCliReceiptPortV1 } from "../src/harness/v1/owner-trusted-local-cli-receipt-port";
import { createControllerWorkerDeliveryV1, deliverControllerWorkerPacketV1 } from "../src/harness/v1/controller-worker-delivery";
import { codexOwnerTrustedLocalRunRegistrationV1 } from "../src/harness/codex-v1/owner-trusted-local-run-registration";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../src/harness/codex-v1/owner-trusted-local-task-planning-contract";
import { seedMacLocalAdapterRegistryV1 } from "../src/web/v1/mac-local-owner-bootstrap";
import { DurableResultReviewSubmissionServiceV1 } from "../src/completion-gate/v1/durable-result-review-submission";
import { createDurableReservationPostgresPortV1 } from "../src/artifacts/v1/neutral-reservation-postgres";
import { InMemoryArtifactStorage } from "../src/node-executor/artifact-storage";
import { sha256Digest } from "../src/security";
import { HarnessRunStoreV1 } from "../src/harness/v1/store";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { binding } from "./hermes-native-fixture";

const exec = promisify(execFile);
const candidates = [process.env.PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"]
  .filter(Boolean) as string[];
const bin = candidates.find(value => existsSync(join(value, "initdb")) && existsSync(join(value, "postgres")))
  ?? "/usr/lib/postgresql/17/bin";
const available = existsSync(join(bin, "initdb")) && existsSync(join(bin, "postgres"));
const needsPg = available ? undefined : { skip: "needs PostgreSQL 17 binaries" };
// This job's own port block is 56140-56149; one cluster on one port.
const port = 56141;

let root = "", data = "", socket = "", mayBeRunning = false;
const native = (name: string, args: readonly string[]) => exec(join(bin, name), args,
  { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: root || "/tmp", NODE_ENV: "test" },
    timeout: 60_000, maxBuffer: 1 << 24 });

const start = async () => {
  mayBeRunning = true;
  await native("pg_ctl", ["-D", data, "-l", join(root, "server.log"), "-w", "-t", "30", "-o",
    `-k ${socket} -p ${port} -h 127.0.0.1 -c shared_buffers=32MB -c max_connections=20 -c shared_preload_libraries=''`,
    "start"]);
};
const stop = async () => {
  if (!mayBeRunning) return;
  try {
    await native("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]);
    mayBeRunning = false;
  } catch (error) {
    // A failed stop is only "stopped" when pg_ctl independently confirms no
    // server owns this exact data directory.
    const stillRunning = await native("pg_ctl", ["-D", data, "status"]).then(() => true, () => false);
    if (stillRunning) throw error;
    mayBeRunning = false;
  }
};

before(async () => {
  if (!available) return;
  root = await mkdtemp(join(tmpdir(), "cr-run-limits-pg-"));
  data = join(root, "data"); socket = join(root, "socket");
  await mkdir(socket, { mode: 0o700 });
  assert.match((await native("postgres", ["--version"])).stdout, /PostgreSQL\) 17\./);
  await native("initdb", ["-D", data, "-U", "fixture_run_limits", "--auth-local=trust",
    "--auth-host=trust", "--no-locale", "--encoding=UTF8"]);
  await start();
  // Prove this exact cluster answers on the intended port before any test
  // claims anything about it.
  const probe = await native("psql", ["-h", "127.0.0.1", "-p", String(port), "-d", "postgres",
    "-U", "fixture_run_limits", "-Atqc", "SELECT 1"]);
  assert.equal(probe.stdout.trim(), "1");
});

after(async () => {
  if (!root) return;
  await stop();
  // Never remove the data directory until stop() confirmed this cluster is down.
  await rm(root, { recursive: true, force: true });
});

const HARNESS_VERSION = "2026.9.28";
const WORKER = "worker:codex-local";
const authorityDigest = sha256Digest("run-limits-authority");
const connectorProfileDigest = sha256Digest("run-limits-connector");
const acceptanceProfileDigest = sha256Digest("run-limits-profile");
const route = { kind: "local" as const, workerId: WORKER };

/** A child that burns CPU and refuses to stop on a signal, so only the
 * supervisor can end it. */
const CPU_BURNER = `
process.on("SIGXCPU", () => {});
process.on("SIGTERM", () => {});
let total = 0;
for (;;) { total += 1; }
`;

function realRunawayExecutor() {
  return createOwnerTrustedLocalCodexExecV1({ spawn: (_file, _args, options) =>
    spawn(process.execPath, ["-e", CPU_BURNER], { ...options, env: { ...options.env, NODE_ENV: "test" } }) });
}

/** A live-clock delivery packet: the real receipt port refuses a receipt
 * stamped outside the packet's issued/expires window. */
function deliveryPacket(runId: string, jobId: string, attemptId: string) {
  const issuedAt = new Date().toISOString();
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: binding.tenantId, projectId: binding.projectId, jobId, attemptId, runId, nodeId: binding.nodeId },
    worker: { workerId: WORKER, adapterId: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, adapterRevision: "source-1" },
    input: { prompt: "Answer briefly.", instructions: "Return plain text only." },
    authorityDigest, connectorProfileDigest,
    acceptanceProfileId: "profile:run-limits", acceptanceProfileDigest,
    issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 600_000).toISOString() });
}

type Fixture = Awaited<ReturnType<typeof webNativeResultFixture>>;

function lifecycle(f: Fixture, key: Uint8Array) {
  const storage = new InMemoryArtifactStorage();
  const reviewSubmission = new DurableResultReviewSubmissionServiceV1(f.db, {
    integrityKey: key, reviewIntegrityKey: key, checkpoints: f.checkpoints, storageClass: "local", storage });
  return createOwnerTrustedLocalCliLifecycleV1({
    db: f.db, runIntegrityKey: key,
    publication: { db: f.db, integrityKey: key, reviewKey: key, storage, storageClass: "local",
      reservations: createDurableReservationPostgresPortV1(), reviewSubmission },
    registerRun: (value, createdAt) => codexOwnerTrustedLocalRunRegistrationV1(value, createdAt, HARNESS_VERSION) });
}

async function scenario(t: { after(fn: () => unknown): void }, runId: string, keyByte: number) {
  const f = await webNativeResultFixture();
  t.after(f.close);
  const jobId = `job:${runId}`, attemptId = `attempt:${runId}`;
  await f.provisionRun(runId, jobId, attemptId, authorityDigest);
  // The fixture's own harness row describes a synthetic manual adapter; remove
  // it and seed the Mac-local registry so the real registration can be written.
  await f.db.query("DELETE FROM control_harness_runs WHERE tenant_id=$1 AND id=$2", [binding.tenantId, runId]);
  await f.db.transaction(tx => seedMacLocalAdapterRegistryV1(tx, binding.tenantId));
  return { f, jobId, attemptId, key: new Uint8Array(32).fill(keyByte) };
}

test("an enforced CPU stop lands in the run record with the limit, the measured value and the stopped status",
  needsPg, async t => {
    const { f, jobId, attemptId, key } = await scenario(t, "run:cpu-limit-record", 51);
    const packet = deliveryPacket("run:cpu-limit-record", jobId, attemptId);
    const outcome = await deliverOwnerTrustedLocalCliTaskV1({
      db: f.db, integrityKey: key,
      binding: { workerId: WORKER, adapterId: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, adapterRevision: "source-1" },
      receiptPort: createOwnerTrustedLocalCliReceiptPortV1(),
      assertCurrent: async () => {},
      execute: async () => {
        const result = await realRunawayExecutor().execute({ executablePath: process.execPath, prompt: "x",
          workingDirectory: root || tmpdir(), deadlineMs: 60_000,
          resources: { cpuTimeMs: 1_000, maxResidentBytes: 1_073_741_824 } });
        // Narrow explicitly: a completed run has no reason and no limit, so the
        // bridge below only ever forwards a genuine supervisor stop.
        if (result.status === "completed") assert.fail("a runaway run must be stopped by the supervisor");
        assert.equal(result.status, "limit_exceeded", "a runaway run must be stopped by the supervisor");
        return { kind: "failed" as const, reason: result.reason, limit: result.limit };
      },
      publish: lifecycle(f, key).publish, recordFailure: lifecycle(f, key).recordFailure,
    }, packet, route, new Date().toISOString());

    assert.equal(outcome.state, "execution_failed");

    // Read back through the real store: digests and auth tags are re-verified.
    const stored = await new HarnessRunStoreV1(f.db, key).inspect(binding.tenantId, "run:cpu-limit-record");
    if (!stored) assert.fail("the run record must exist");
    assert.equal(stored.run.state, "failed", "a stopped run is recorded as failed");
    assert.equal(stored.run.safeReasonCode, "local_cli_cpu_time_exceeded",
      "the run record must name the limit that stopped it");

    const evidence = stored.events.filter(event => event.payload.category === "resource");
    assert.equal(evidence.length, 1, "exactly one resource event describes the stop");
    const payload = evidence[0]!.payload;
    if (payload.category !== "resource") throw new Error("expected a resource event");
    assert.equal(payload.limit, "cpu_time");
    assert.equal(payload.cause, "exceeded");
    assert.equal(payload.limitCpuTimeMs, 1_000, "the configured limit must be recorded");
    assert.ok(payload.measuredCpuTimeMs >= 1_000,
      `the measured value ${payload.measuredCpuTimeMs} must be at or past the limit`);

    // Evidence precedes the terminal lifecycle event, so a run is never
    // terminal before the record explains why.
    const categories = stored.events.map(event => event.payload.category);
    assert.ok(categories.indexOf("resource") < categories.lastIndexOf("lifecycle"),
      "the resource evidence must precede the terminal lifecycle event");

    // A limit stop publishes nothing: no durable result reservation, no
    // review plan, no artifact receipt. These are the exact tables the real
    // publish path writes, so their absence is the evidence.
    for (const table of ["control_durable_result_write_reservations", "control_native_review_plans",
      "control_native_artifact_receipts"]) {
      assert.equal((await f.db.query(`SELECT 1 AS present FROM ${table} WHERE tenant_id=$1 AND run_id=$2`,
        [binding.tenantId, "run:cpu-limit-record"])).rows.length, 0, `${table} must have no row`);
    }
  });

test("a run stopped for another reason records no resource evidence", needsPg, async t => {
  const { f, jobId, attemptId, key } = await scenario(t, "run:within-limits", 52);
  const packet = deliveryPacket("run:within-limits", jobId, attemptId);
  const receipt = await deliverControllerWorkerPacketV1(createOwnerTrustedLocalCliReceiptPortV1(),
    packet, route, new AbortController().signal);
  await lifecycle(f, key).recordFailure({ delivery: packet, receipt, signal: new AbortController().signal });

  const stored = await new HarnessRunStoreV1(f.db, key).inspect(binding.tenantId, "run:within-limits");
  if (!stored) assert.fail("the run record must exist");
  assert.equal(stored.run.state, "failed");
  assert.equal(stored.run.safeReasonCode, "local_cli_execution_failed");
  assert.equal(stored.events.some(event => event.payload.category === "resource"), false,
    "a run stopped for another reason must not claim a resource limit");
});

test("a malformed stop claim cannot name a limit in the run record", needsPg, async t => {
  const { f, jobId, attemptId, key } = await scenario(t, "run:malformed-limit", 53);
  const packet = deliveryPacket("run:malformed-limit", jobId, attemptId);
  const receipt = await deliverControllerWorkerPacketV1(createOwnerTrustedLocalCliReceiptPortV1(),
    packet, route, new AbortController().signal);
  await assert.rejects(lifecycle(f, key).recordFailure({
    delivery: packet, receipt, signal: new AbortController().signal,
    // A claimed bound that is not a complete, in-bounds record is refused
    // before any write, rather than being recorded as a stop.
    limit: { limit: "cpu_time", reason: "cpu_time_exceeded", cause: "exceeded", measuredCpuTimeMs: -1,
      measuredResidentBytes: 0, limitCpuTimeMs: 1_000, limitResidentBytes: 0 } }),
  /task_run_resource_supervisor_unavailable/u);

  // Nothing was written for a refused claim: no run exists for this delivery.
  assert.equal((await f.db.query("SELECT 1 FROM control_harness_runs WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, "run:malformed-limit"])).rows.length, 0);
});


test("recording the same stop twice is idempotent and never strands the run", needsPg, async t => {
  // `occurredAt` is recomputed per attempt, so without the prior-event check a
  // retry would carry a different event digest and the store would reject it
  // as a replay conflict -- leaving a stopped run permanently unrecordable.
  // The digest is derived from the stop itself, so a second attempt finds the
  // prior event and skips the append.
  const { f, jobId, attemptId, key } = await scenario(t, "run:replay", 55);
  const packet = deliveryPacket("run:replay", jobId, attemptId);
  const receipt = await deliverControllerWorkerPacketV1(createOwnerTrustedLocalCliReceiptPortV1(),
    packet, route, new AbortController().signal);
  const stop = { limit: "cpu_time", reason: "cpu_time_exceeded", cause: "exceeded",
    measuredCpuTimeMs: 1_200, measuredResidentBytes: 56_000_000,
    limitCpuTimeMs: 1_000, limitResidentBytes: 1_073_741_824 };

  // `recordFailure` returns nothing, so the run is read back through the
  // store: that path re-verifies the run digest and every event auth tag.
  const resourceEvents = async () => (await (new HarnessRunStoreV1(f.db, key))
    .inspect(binding.tenantId, "run:replay"))?.events
    .filter(event => event.payload.category === "resource") ?? [];

  await lifecycle(f, key).recordFailure({
    delivery: packet, receipt, signal: new AbortController().signal, limit: stop });
  assert.equal((await resourceEvents()).length, 1, "the stop must be recorded once");

  // Replay the identical claim against the same delivery. It must not throw
  // a replay conflict, and must not append a second event.
  await lifecycle(f, key).recordFailure({
    delivery: packet, receipt, signal: new AbortController().signal, limit: stop });
  assert.equal((await resourceEvents()).length, 1, "a replay must not append a second evidence event");

  const stored = await (new HarnessRunStoreV1(f.db, key)).inspect(binding.tenantId, "run:replay");
  if (!stored) throw new Error("the run record must exist after a replay");
  // The terminal lifecycle event must not be duplicated either.
  assert.equal(stored.events.filter(event => event.payload.category === "lifecycle"
    && event.payload.state === "failed").length, 1);
  assert.equal(stored.run.state, "failed", "the run must still be terminal, not stranded");
  assert.equal(stored.run.safeReasonCode, "local_cli_cpu_time_exceeded");
});
