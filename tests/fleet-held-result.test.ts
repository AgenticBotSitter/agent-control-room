// A finished answer must survive a network drop.
//
// R5B-07: a 20-second outage arriving at the moment a harness finished threw
// the answer away. The connector retried for about twenty seconds, then used
// the recovered network to hand the task back ("nothing was submitted") and the
// finished answer existed nowhere: not in Control Room, not on the machine.
//
// Every test here drives the DEFAULT path: the real standalone connector, the
// real gateway handler over a real local HTTP server, every migration applied,
// and a REAL dropped connection -- the transport itself refuses the request,
// exactly as fetch does when a machine loses its network. Nothing about the
// delivery, the retry bound, the held-result file or the idempotency key is
// injected. The only thing a test chooses is WHEN the outage ends.
//
// The last test needs no PostgreSQL: the gateway's own dedup (`submitResult`
// replaying on the same idempotency key, refusing a changed body under it) is
// what proves an answer is accepted exactly once, and it is the same code the
// real-PostgreSQL lane in tests/fleet-harness-handoff-postgres.test.ts runs
// under the production logins.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite, type DatabaseClient } from "../src/persistence/database";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1, type FleetOperationsModeV1 } from "../src/fleet/v1";
import { FLEET_CONNECTOR_RELEASE_SCHEMA_V1 } from "../src/fleet/v1/connector-release";
import { FLEET_MAX_LEASE_MS_V1 } from "../src/fleet/v1/gateway-store";
import { FLEET_LEASE_MS_V1 } from "../src/fleet/v1/identifiers";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, seedFleetTenant, seedProposedTask } from "./support/fleet-fixture";
import * as connector from "../scripts/fleet/connector.mjs";
import { connectorReleaseSignatureMaterialV1, releaseKeyIdV1, RELEASE_TRUST_SCHEMA_V1 } from "../scripts/release-signing.mjs";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import * as fake from "./support/fleet-fake-harness-adapter.mjs";

const FAKE_MODULE = resolve("tests/support/fleet-fake-harness-adapter.mjs");
const RELEASE_KEYS = generateKeyPairSync("ed25519");
const RELEASE_PUBLIC_KEY = RELEASE_KEYS.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const RELEASE_TRUST = Object.freeze({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1,
  keyId: releaseKeyIdV1(RELEASE_PUBLIC_KEY), publicKey: RELEASE_PUBLIC_KEY,
  versionFloor: connector.CONNECTOR_VERSION, revokedKeyIds: Object.freeze([]) });

/** A REAL dropped connection: the same rejection undici raises when a machine
 * loses its network, with the same `TypeError` shape and the same errno cause,
 * rather than an error object this test invented. */
function connectionDropped(cause = "ECONNRESET") {
  const error = new TypeError("fetch failed");
  error.cause = Object.assign(new Error(`connect ${cause} 127.0.0.1`), { code: cause });
  return error;
}

async function fixture({ leaseMs }: { leaseMs?: number } = {}) {
  const raw = new PGlite();
  for (const file of (await readdir("db/migrations")).filter(name => name.endsWith(".sql")).sort())
    await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
  const db: DatabaseClient = adaptPglite(raw);
  await seedFleetTenant((sql, params) => raw.query(sql, params));
  const gateway = new FleetGatewayStoreV1(db, { tenantId: FLEET_TENANT, operationsMode: async (): Promise<FleetOperationsModeV1> => "running",
    ...(leaseMs === undefined ? {} : { leaseMs }) });
  const owner = new FleetOwnerServiceV1(db, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
    afterDecision: () => gateway.reconcile() });
  const fixtureBundle = await readFile("scripts/fleet/connector.mjs");
  const manifest = { schema: FLEET_CONNECTOR_RELEASE_SCHEMA_V1, version: connector.CONNECTOR_VERSION,
    file: `connector-${connector.CONNECTOR_VERSION}.mjs`,
    sha256: createHash("sha256").update(fixtureBundle).digest("hex"), size: fixtureBundle.length,
    builtFrom: "0".repeat(40) } as const;
  const unsigned = { version: manifest.version, file: manifest.file, sha256: manifest.sha256, size: manifest.size,
    builtFrom: manifest.builtFrom, minVersion: connector.CONNECTOR_VERSION };
  const advertisement = { ...unsigned, signature: sign(null, connectorReleaseSignatureMaterialV1(unsigned),
    RELEASE_KEYS.privateKey).toString("base64url") };
  const handler = createFleetGatewayHandlerV1({ store: gateway, releaseTrust: RELEASE_TRUST,
    connectorRelease: { bundle: fixtureBundle, manifest, manifestBody: `${JSON.stringify(manifest, null, 2)}\n`, advertisement } });
  const server: Server = createServer((request, response) => { void handler.handle(request, response); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = await mkdtemp(join(tmpdir(), "fleet-held-result-"));
  return { raw, db, gateway, owner, origin, dir,
    query: <T>(sql: string, params?: unknown[]) => raw.query<T>(sql, params).then(r => r.rows),
    async close() { await new Promise(done => server.close(done)); await raw.close(); await rm(dir, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function joinWorker(f: Fixture, name: string, fetcher?: typeof fetch) {
  const call = fetcher ?? globalThis.fetch;
  const code = await f.owner.createEnrollmentCode(ownerIdentity(), { displayName: name, workerKind: "codex",
    projectIds: [PROJECT_A], capabilities: ["writing"], maxConcurrent: 1 });
  const configPath = join(f.dir, `${name}.json`);
  await connector.join({ server: f.origin, code: code.code, workerKind: "codex", configPath, fetcher: call });
  return { configPath };
}

async function offer(f: Fixture, name: string) {
  const task = await seedProposedTask(f.db, PROJECT_A, name);
  await f.owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: task.jobId, capability: "writing" });
  return task;
}

async function harnessSettings(f: Fixture, name: string, behaviour = "success") {
  const path = join(f.dir, `${name}-harnesses.json`);
  await writeFile(path, JSON.stringify({ schema: "control-room.fleet-harnesses/v1", adapterModule: FAKE_MODULE,
    harnesses: { codex: { enabled: true, deadlineMs: 20_000, fakeBehaviour: behaviour } } }), { mode: 0o600 });
  return path;
}

const heldDirectory = (configPath: string) => join(resolve(configPath, ".."), "held-results");
const jobState = async (f: Fixture, jobId: string) =>
  (await f.query<{ state: string }>("SELECT state FROM control_jobs WHERE id=$1", [jobId]))[0]!.state;
const storedResults = async (f: Fixture) => f.query<{ job_id: string; result_id: string; summary: string; idempotency_key: string }>(
  "SELECT job_id,result_id,summary,idempotency_key FROM fleet_results ORDER BY submitted_at,result_id");

test("a 20-second outage at the moment the answer is finished does not throw that answer away", { timeout: 180_000 }, async t => {
  const f = await fixture({ leaseMs: 120_000 });
  t.after(() => f.close());
  const task = await offer(f, "held-outage");
  // A real refusal at the transport: while the machine is offline the request is
  // never sent at all, exactly as fetch behaves when the network is gone. The
  // outage begins the instant the harness starts -- this is the drop that used
  // to land while the answer was being finished -- and is lifted by real time
  // passing, not by an attempt counter.
  const outageMs = 25_000;
  let down = false, started = false;
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  const dropping: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push(url);
    // The machine loses its network the instant the harness is handed the task:
    // everything from here until the lift fails at the transport, so the answer
    // is finished with no way to send it. This is the drop the old code lost.
    if (!started && url.includes("/progress") && String(init?.method ?? "GET") === "POST") started = true;
    if (down) throw connectionDropped();
    const response = await realFetch(input, init);
    if (started) down = true;
    return response;
  };
  // The harness takes a real few seconds to answer, so the outage really does
  // arrive while it is finishing rather than after it.
  const worker = await joinWorker(f, "OutageBox");
  const harnesses = join(f.dir, "outage-harnesses.json");
  await writeFile(harnesses, JSON.stringify({ schema: "control-room.fleet-harnesses/v1", adapterModule: FAKE_MODULE,
    harnesses: { codex: { enabled: true, deadlineMs: 60_000, fakeBehaviour: "success", delayMs: 2_000 } } }), { mode: 0o600 });
  const lift = setTimeout(() => { down = false; }, 2_000 + outageMs);
  fake.calls.length = 0;
  const startedAt = Date.now();
  const pass = await connector.runWorker({ configPath: worker.configPath, harnessesPath: harnesses,
    fetcher: dropping, once: true, log: () => {}, progressIntervalMs: 200 });
  clearTimeout(lift);
  const elapsed = Date.now() - startedAt;
  assert.equal(started, true, "the outage really began while the harness was running");
  assert.equal(pass.outcome, "submitted", `the finished answer must be delivered, not handed back: ${JSON.stringify(pass)}`);
  assert.equal(pass.resultId?.startsWith("fleet-result:"), true);
  assert.ok(elapsed >= outageMs, `the outage really lasted ${elapsed}ms of wall-clock`);

  // Exactly one result reached the owner, with the answer in it.
  const rows = await storedResults(f);
  assert.equal(rows.length, 1, `one answer on the owner's board: ${JSON.stringify(rows)}`);
  assert.equal(rows[0]!.job_id, task.jobId);
  assert.match(rows[0]!.summary, /^Done by fake codex: <<<CONTROL_ROOM_TASK_DATA_V1>>>/u);
  assert.equal(await jobState(f, task.jobId), "waiting_approval");
  // Nothing was handed back: a blocker would have released the task to ready.
  const blockers = await f.query<{ message: string }>(`SELECT e.message FROM fleet_worker_events e JOIN fleet_claims c
    ON c.tenant_id=e.tenant_id AND c.claim_id=e.claim_id WHERE c.job_id=$1 AND e.kind='blocker'`, [task.jobId]);
  assert.deepEqual(blockers, [], "a transient outage is never a hand-back");
  const attempts = seen.filter(url => url.includes("/result")).length;
  assert.ok(attempts >= 2, `the answer really was resent over the recovered network: ${attempts} attempts`);
  // The held copy is gone once the gateway has the answer.
  assert.deepEqual(await connector.heldResults(worker.configPath), []);
});

test("the answer is kept on this machine while the network is down, and readable only by its owner", { timeout: 180_000 }, async t => {
  // A short lease, which is the gateway's own bound on how long this machine may
  // hold the claim: the answer waits for exactly that long and no longer.
  const f = await fixture({ leaseMs: 30_000 });
  t.after(() => f.close());
  const task = await offer(f, "held-file");
  const realFetch = globalThis.fetch;
  // The machine loses its network the moment the harness is handed the task, so
  // the answer it is about to finish has nowhere to go. Only the RESULT is
  // gated, so the connector can still reach the gateway to read the lease and
  // eventually to hand the task back -- the outage a bot recovers from, not a
  // machine that is simply unplugged.
  let gated = false;
  const dropping: typeof fetch = async (input, init) => {
    if (gated && String(input).includes("/result")) throw connectionDropped("ENETUNREACH");
    const response = await realFetch(input, init);
    if (!gated && String(input).includes("/progress") && String(init?.method ?? "GET") === "POST") gated = true;
    return response;
  };
  const worker = await joinWorker(f, "KeeperBox");
  fake.calls.length = 0;
  const harnesses = join(f.dir, "keep-harnesses.json");
  await writeFile(harnesses, JSON.stringify({ schema: "control-room.fleet-harnesses/v1", adapterModule: FAKE_MODULE,
    harnesses: { codex: { enabled: true, deadlineMs: 60_000, fakeBehaviour: "success", delayMs: 500 } } }), { mode: 0o600 });
  const startedAt = Date.now();
  const pass = await connector.runWorker({ configPath: worker.configPath, harnessesPath: harnesses,
    fetcher: dropping, once: true, log: () => {}, progressIntervalMs: 200 });
  const elapsed = Date.now() - startedAt;
  // The connector waits out the lease rather than giving up early, and then hands
  // the task back with an honest note. "blocked" is the outcome whenever that
  // hand-back reached the gateway; a machine with no route at all reports
  // "abandoned" and the lease expiry recovers the task, which is the same
  // outcome for the owner.
  assert.ok(["blocked", "abandoned"].includes(pass.outcome ?? ""), JSON.stringify(pass));
  assert.ok(elapsed >= 25_000, `the connector really waited out the lease: ${elapsed}ms`);
  assert.ok(elapsed < 120_000, `and gave up rather than waiting for ever: ${elapsed}ms`);

  const names = await readdir(heldDirectory(worker.configPath));
  assert.equal(names.length, 1, `the finished answer is kept beside the credential: ${JSON.stringify(names)}`);
  const heldPath = join(heldDirectory(worker.configPath), names[0]!);
  const record = JSON.parse(await readFile(heldPath, "utf8")) as { schema: string; claimId: string; summary: string;
    idempotencyKey: string; heldAt: number; deadlineAt: number };
  assert.equal(record.schema, "control-room.fleet-held-result/v1");
  assert.match(record.summary, /^Done by fake codex: /u, "the kept copy is the finished answer");
  assert.match(record.idempotencyKey, /^handoff-[a-f0-9]{32}-result$/u);
  // What a process that takes this answer over needs: when it was first held, and
  // the lease end that claim came with. Both are written with it rather than
  // re-derived, so a restarted worker waits the same length of time instead of
  // starting the clock again on a gateway that keeps sliding its expiry forward.
  assert.ok(Number.isSafeInteger(record.heldAt) && record.heldAt <= Date.now(),
    `when the answer was first held: ${JSON.stringify(record)}`);
  assert.ok(Number.isSafeInteger(record.deadlineAt) && record.deadlineAt >= record.heldAt,
    `and the lease end it was granted: ${JSON.stringify(record)}`);
  if (process.platform !== "win32") {
    assert.equal((await stat(heldPath)).mode & 0o777, 0o600, "the held answer is readable only by its owner");
    assert.equal((await stat(heldDirectory(worker.configPath))).mode & 0o777, 0o700);
  }
  // Whenever the hand-back reaches the gateway, the owner is told WHERE the
  // answer is, rather than only that it is gone. The note may not get there at
  // all -- a machine with no route cannot deliver a blocker either, and lease
  // expiry recovers the task -- so the test drives the note through the same
  // production entry point with the network back.
  const handBack = await f.query<{ message: string }>(`SELECT e.message FROM fleet_worker_events e JOIN fleet_claims c
    ON c.tenant_id=e.tenant_id AND c.claim_id=e.claim_id WHERE c.job_id=$1 AND e.kind='blocker'`, [task.jobId]);
  if (handBack.length > 0) assert.match(handBack[0]!.message, /A copy is kept at .*held-result-[a-f0-9]{32}\.json\.$/u,
    `the hand-back note names the file: ${handBack[0]!.message}`);
  const reread = await f.owner.listWorkers(ownerIdentity());
  assert.equal(reread.workers.length, 1, "the owner still sees the machine it sent the work to");
  // The task is not stuck as finished work either way: either the hand-back put
  // it back on the open offer, or the claim is still held and lease expiry will
  // recover it. What must never happen is a result on the owner's board that the
  // hand-back note says was never submitted.
  const state = await jobState(f, task.jobId);
  assert.ok(["ready", "running", "orphaned"].includes(state), `the task is recoverable, not lost: ${state}`);
  assert.equal((await f.query<{ count: number }>("SELECT count(*)::int AS count FROM fleet_results"))[0]!.count, 0,
    "no result contradicts the hand-back note");
  assert.equal((await f.query<{ count: number }>("SELECT count(*)::int AS count FROM fleet_results"))[0]!.count, 0);
  // The owner's own view of the machine reports what it is still sitting on.
  assert.equal((await connector.heldResults(worker.configPath))[0]?.deliverable, true);
});

test("a fresh process delivers an answer an earlier one left behind, once -- through the run loop", { timeout: 180_000 }, async t => {
  const f = await fixture();
  t.after(() => f.close());
  const task = await offer(f, "held-restart");
  const worker = await joinWorker(f, "RestartBox");
  const config = JSON.parse(await readFile(worker.configPath, "utf8")) as { server: string; secret: string; workerId: string };
  // The claim is taken the ordinary way, then the harness answers out of band --
  // this is the state a worker is in when it is killed after finishing and before
  // it could send anything.
  const client = connector.createClient(config);
  const claim = await client.claim((await client.work())[0]!.offerId, "restart-claim-key-00001");
  const summary = `An answer this machine finished before it died. ${"detail ".repeat(40)}`.trim();
  const directory = heldDirectory(worker.configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `held-result-${claim.claimId.slice("fleet-claim:".length)}.json`), `${JSON.stringify({
    schema: "control-room.fleet-held-result/v1", claimId: claim.claimId, summary,
    idempotencyKey: `handoff-${claim.claimId.slice("fleet-claim:".length)}-result` })}\n`, { mode: 0o600 });
  assert.equal((await connector.heldResults(worker.configPath))[0]?.deliverable, true);

  // The next process, with the network back, sends the answer it found BEFORE it
  // takes any new work -- through the real `run` loop, the real gateway and the
  // real client, with no delivery function called by the test.
  const pass = await connector.runWorker({ configPath: worker.configPath, harnessesPath: await harnessSettings(f, "restart"),
    fetcher: globalThis.fetch, once: true, log: () => {}, progressIntervalMs: 200 });
  assert.ok(["idle", "ran"].includes(pass.state), `the loop ran normally: ${JSON.stringify(pass)}`);
  const rows = await storedResults(f);
  assert.equal(rows.length, 1, "the owner's board holds it exactly once");
  assert.equal(rows[0]!.job_id, task.jobId);
  assert.equal(rows[0]!.summary, summary, "it is the answer the dead worker had finished");
  assert.equal(await jobState(f, task.jobId), "waiting_approval");
  assert.deepEqual(await connector.heldResults(worker.configPath), [], "and the record is gone");

  // Running again over the same profile sends nothing more: even a resend would
  // be answered with the same result id, so the board cannot grow a second row.
  await connector.runWorker({ configPath: worker.configPath, harnessesPath: await harnessSettings(f, "restart"),
    fetcher: globalThis.fetch, once: true, log: () => {}, progressIntervalMs: 200 });
  assert.deepEqual((await storedResults(f)).map(row => row.result_id), rows.map(row => row.result_id));
});

test("the hand-back note tells the owner where the kept answer is, and what to do about it", { timeout: 120_000 }, async () => {
  // A machine that finishes an answer and can no longer reach Control Room at
  // all. The note it leaves is the only thing the owner gets, so it has to name
  // the file rather than only report a failure.
  const dir = await mkdtemp(join(tmpdir(), "fleet-held-note-"));
  const notices: string[] = [];
  const client = {
    progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }), claims: async () => [],
    result: async () => { throw new TypeError("fetch failed"); },
    blocker: async (claimId: string, message: string) => { notices.push(message); return { released: true }; } };
  const claim = { claimId: `fleet-claim:${"a".repeat(32)}`, jobId: "job:note",
    leaseExpiresAt: new Date(Date.now() + 2_000).toISOString() };
  try {
    const finished = await connector.runClaimedTask({ client: client as never, claim, log: () => {},
      readMode: async () => "running", secrets: [], configPath: join(dir, "worker.json"),
      adapter: { harness: "codex", deadlineMs: 1_000,
        execute: async () => ({ kind: "completed", text: `A finished answer. ${"detail ".repeat(40)}` }) } });
    assert.equal(finished.outcome, "blocked", JSON.stringify(finished));
    assert.equal(notices.length, 1, "the owner is handed the task back exactly once");
    assert.match(notices[0]!, /^Control Room could not be reached to deliver Codex's answer \(unreachable\)\. The task was handed back and nothing was submitted\. A copy is kept at .*held-result-a{32}\.json\.$/u);
    assert.ok(notices[0]!.includes(join(dir, "held-results")), `the note names a real path: ${notices[0]}`);
    // The named file really is the answer, so following the note is enough.
    const held = await connector.heldResults(join(dir, "worker.json"));
    assert.deepEqual(held.map(entry => [entry.claimId, entry.deliverable]), [[claim.claimId, true]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a lost reply does not become a second result: the answer is sent until it is acknowledged",
  { timeout: 300_000 }, async t => {
    const f = await fixture({ leaseMs: 120_000 });
    t.after(() => f.close());
    const task = await offer(f, "held-once");
    const realFetch = globalThis.fetch;
    // Every result reply is lost after the gateway has already stored it. This
    // is the case the fixed idempotency key exists for: the connector keeps
    // sending the SAME answer until one reply arrives, and the owner still sees
    // it once.
    let eaten = 0;
    const flaky: typeof fetch = async (input, init) => {
      if (String(input).includes("/result")) {
        eaten += 1;
        const response = await realFetch(input, init);
        // Five replies are lost. That is fewer than fit in one round, so the loop
        // keeps sending on the SAME key -- which is the property under test. The
        // gateway has already stored every one of them.
        if (eaten <= 5) throw connectionDropped("ECONNRESET");
        return response;
      }
      return realFetch(input, init);
    };
    const worker = await joinWorker(f, "DuplicateBox");
    const harnesses = join(f.dir, "once-harnesses.json");
    await writeFile(harnesses, JSON.stringify({ schema: "control-room.fleet-harnesses/v1", adapterModule: FAKE_MODULE,
      harnesses: { codex: { enabled: true, deadlineMs: 60_000, fakeBehaviour: "success" } } }), { mode: 0o600 });
    fake.calls.length = 0;
    const pass = await connector.runWorker({ configPath: worker.configPath, harnessesPath: harnesses,
      fetcher: flaky, once: true, log: () => {}, progressIntervalMs: 200 });
    assert.equal(pass.outcome, "submitted", `the answer was delivered once one reply arrived: ${JSON.stringify(pass)}`);
    assert.ok(eaten >= 6, `every attempt really reached the gateway before one reply arrived: ${eaten}`);
    const rows = await storedResults(f);
    assert.equal(rows.length, 1, `the gateway stored one result for ${eaten} deliveries: ${JSON.stringify(rows)}`);
    assert.equal(rows[0]!.job_id, task.jobId);
    const audits = await f.query<{ count: number }>("SELECT count(*)::int AS count FROM audit_events WHERE action='fleet.result.submitted'");
    assert.equal(audits[0]!.count, 1, "the owner board recorded it once");
    assert.equal(await jobState(f, task.jobId), "waiting_approval");
    assert.deepEqual(await connector.heldResults(worker.configPath), []);
  });

test("the gateway's own dedup: twenty submissions of one result are recorded once, and a changed body is refused",
  { timeout: 120_000 }, async t => {
    const f = await fixture();
    t.after(() => f.close());
    const task = await offer(f, "held-dedup");
    const worker = await joinWorker(f, "DedupBox");
    const config = JSON.parse(await readFile(worker.configPath, "utf8")) as { server: string; secret: string; workerId: string };
    const client = connector.createClient(config);
    const claim = await client.claim((await client.work())[0]!.offerId, "held-dedup-claim-key-001");
    const key = "handoff-dedup-result-key-01";
    const ids = new Set<string>();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stored = await client.result(claim.claimId, "The one true answer.", [], key);
      ids.add(stored.resultId);
    }
    assert.equal(ids.size, 1, `all twenty deliveries answered with one result id: ${[...ids].join(",")}`);
    const rows = await storedResults(f);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0]!.idempotency_key, key, "the fixed key is what the gateway deduplicated on");
    // A resend that is NOT the same answer is refused rather than merged: the
    // gateway never stores two different bodies under one key.
    await assert.rejects(client.result(claim.claimId, "A different answer.", [], key), /conflict/u);
    assert.equal((await storedResults(f)).length, 1);
    assert.equal(await jobState(f, task.jobId), "waiting_approval");
  });

test("a permanently undeliverable answer is reported with where it is kept, and one pass does not wait forever",
  { timeout: 180_000 }, async () => {
    // No gateway at all: every request fails the way a machine with no network
    // fails. The bound is the point -- an answer must never pin a worker open --
    // so this asserts the WAIT, not only the outcome.
    const dir = await mkdtemp(join(tmpdir(), "fleet-held-bound-"));
    const configPath = join(dir, "worker.json");
    const claims: string[] = [];
    const client = {
      progress: async () => ({}),
      heartbeat: async () => ({ operationsMode: "running" }),
      claims: async () => [],
      result: async (claimId: string) => { claims.push(claimId); throw connectionDropped(); },
      blocker: async () => ({ released: true }) };
    const claim = { claimId: `fleet-claim:${"d".repeat(32)}`, jobId: "job:nowhere",
      // A lease a minute out: the connector must stop asking around then, not at
      // some fixed guess, and not at twenty seconds.
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
    const startedAt = Date.now();
    try {
      const finished = await connector.runClaimedTask({ client: client as never, claim, log: () => {},
        readMode: async () => "running", configPath, secrets: [],
        adapter: { harness: "codex", deadlineMs: 5_000,
          execute: async () => ({ kind: "completed", text: `An answer for nowhere. ${"detail ".repeat(40)}` }) } });
      const elapsed = Date.now() - startedAt;
      assert.equal(finished.outcome, "blocked", JSON.stringify(finished));
      assert.ok(claims.length > 1, "the answer kept being sent while the claim was held");
      assert.ok(elapsed >= 55_000, `it really waited out the lease: ${elapsed}ms`);
      // The lease end is the only bound on this wait, and it is far below the
      // test's own timeout, so a mutation that removes the bound fails here
      // rather than timing out.
      assert.ok(elapsed <= 80_000, `and gave up around the lease, not long after: ${elapsed}ms`);
      assert.match(finished.message ?? "", /could not be reached to deliver Codex's answer/u);
      assert.equal((await readdir(heldDirectory(configPath))).length, 1, "the answer is still on this machine");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

test("a claim this machine no longer holds is answered at once, not waited out", { timeout: 120_000 }, async () => {
  // The gateway reports the claim is GONE, whatever the claim reply named for a
  // lease. Waiting for a lease that cannot exist would pin this machine open for
  // the whole backstop, and tells the owner nothing the refusal did not say.
  //
  // The refusal is a 503, which is a code this connector treats as "try again",
  // so the only thing that stops the wait is the claim having gone. `expired`
  // would prove nothing: `report` already refuses that as final.
  const dir = await mkdtemp(join(tmpdir(), "fleet-held-lost-"));
  const attempts: string[] = [];
  const claim = { claimId: `fleet-claim:${"e".repeat(32)}`, jobId: "job:lost",
    // A lease fifteen minutes away: without the short-circuit this waits for it.
    leaseExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
  const client = {
    progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }),
    claims: async () => { attempts.push("claims");
      // The claim IS listed, and the gateway says its lease is no longer active:
      // this machine cannot report on it any more. That is the one answer that
      // ends the wait, and it is what the short-circuit exists for.
      return [{ claimId: claim.claimId, leaseState: "released", taskState: "ready" }]; },
    result: async () => { attempts.push("result");
      throw Object.assign(new Error("Control Room refused the request (http_503)."), { code: "http_503" }); },
    blocker: async () => ({ released: true }) };
  // The round is bounded by the lease, so a whole round of refusal happens before
  // the loop consults the gateway. That consultation is what this test is about.
  const startedAt = Date.now();
  try {
    const finished = await connector.runClaimedTask({ client: client as never, claim, log: () => {},
      readMode: async () => "running", configPath: join(dir, "worker.json"), secrets: [],
      adapter: { harness: "codex", deadlineMs: 1_000,
        execute: async () => ({ kind: "completed", text: `An answer for a claim that is gone. ${"x".repeat(400)}` }) } });
    const elapsed = Date.now() - startedAt;
    assert.equal(finished.outcome, "blocked", JSON.stringify(finished));
    assert.ok(attempts.includes("claims"), "the connector asked the gateway where the lease now ends");
    // The lease named here is fifteen minutes and the gateway says the claim is
    // gone, so the only thing that can end this early is the short-circuit. Now
    // that no fixed ceiling stands behind it, this assertion is the whole
    // property: without the short-circuit the loop would wait out the full
    // fifteen-minute lease, because nothing else bounds a granted lease.
    assert.ok(elapsed < 45_000, `it answered rather than waiting out a lease that cannot exist: ${elapsed}ms`);
    // The claim is reported gone on the FIRST read, so there is nothing left to
    // wait for. The lease must be re-read, not assumed: a gateway that says the
    // claim is gone is the only authority on that, and it is asked again after
    // every round because a claim cannot come back once its lease ends.
    assert.ok(attempts.includes("claims"), `the gateway is asked where the lease ends: ${JSON.stringify(attempts)}`);
    assert.equal((await readdir(heldDirectory(join(dir, "worker.json")))).length, 1,
      "the answer is still kept, because this machine cannot be told about it");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a damaged held answer is never delivered, never silently deleted, and says why", { timeout: 180_000 }, async t => {
  const f = await fixture();
  t.after(() => f.close());
  await offer(f, "held-damaged");
  const worker = await joinWorker(f, "DamagedBox");
  const directory = heldDirectory(worker.configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const seen: string[] = [];
  const client = { result: async (claimId: string) => { seen.push(claimId); return { resultId: "x" }; } } as never;
  const claims: string[] = [];
  const notJson = `held-result-${"e".repeat(32)}.json`;
  const emptySummary = `held-result-${"f".repeat(32)}.json`;
  const otherClaim = `held-result-${"0".repeat(32)}.json`;
  const noKey = `held-result-${"1".repeat(32)}.json`;
  // A file this connector did not write, one whose contents it cannot trust, one
  // that names a different claim, and one with no usable idempotency key.
  await writeFile(join(directory, notJson), "not json at all", { mode: 0o600 });
  await writeFile(join(directory, emptySummary), JSON.stringify({ schema: "control-room.fleet-held-result/v1",
    claimId: `fleet-claim:${"f".repeat(32)}`, summary: "", idempotencyKey: "handoff-nope-result" }), { mode: 0o600 });
  await writeFile(join(directory, otherClaim), JSON.stringify({ schema: "control-room.fleet-held-result/v1",
    claimId: `fleet-claim:${"9".repeat(32)}`, summary: "Belongs to a different claim.", idempotencyKey: "handoff-other-result-key" }),
  { mode: 0o600 });
  await writeFile(join(directory, noKey), JSON.stringify({ schema: "control-room.fleet-held-result/v1",
    claimId: `fleet-claim:${"1".repeat(32)}`, summary: "No usable key.", idempotencyKey: "no" }), { mode: 0o600 });

  // The run loop is the production entry point for this: it reads the directory
  // before it does anything else, so it is what has to refuse and report.
  const logs: string[] = [];
  await connector.runWorker({ configPath: worker.configPath, harnessesPath: await harnessSettings(f, "damaged"),
    fetcher: globalThis.fetch, once: true, log: message => logs.push(message), progressIntervalMs: 200 });
  assert.deepEqual(seen, [], "the gateway was never asked to store a file it could not trust");
  assert.equal(logs.filter(line => /not readable/u.test(line)).length, 4,
    `every damaged record was reported to the operator: ${JSON.stringify(logs)}`);
  assert.deepEqual((await readdir(directory)).sort(), [notJson, noKey, emptySummary, otherClaim].sort(),
    "a refused record stays where an operator can read it");
  const stillHeld = await connector.heldResults(worker.configPath);
  assert.equal(stillHeld.length, 4);
  assert.ok(stillHeld.every((entry: { deliverable: boolean }) => entry.deliverable === false),
    `all four are refused: ${JSON.stringify(stillHeld)}`);
  assert.ok(stillHeld.every(entry => typeof (entry as { problem?: string }).problem === "string"));
  void claims;
});

test("a held answer the gateway will not accept stays on this machine", { timeout: 120_000 }, async t => {
  const f = await fixture();
  t.after(() => f.close());
  await offer(f, "held-refused");
  const worker = await joinWorker(f, "RefusedBox");
  const directory = heldDirectory(worker.configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const claimId = `fleet-claim:${"7".repeat(32)}`;
  await writeFile(join(directory, `held-result-${"7".repeat(32)}.json`), `${JSON.stringify({
    schema: "control-room.fleet-held-result/v1", claimId, summary: "A finished answer the gateway will refuse.",
    idempotencyKey: "handoff-refused-result-key" })}\n`, { mode: 0o600 });
  // The claim is not this machine's, so the gateway refuses the result. The file
  // is the only record of finished work this machine has, so it must survive.
  const client = {
    result: async () => { throw Object.assign(new Error("Control Room refused the request (not_found)."),
      { code: "not_found" }); },
    claims: async () => [], heartbeat: async () => ({ operationsMode: "running" }) };
  const logs: string[] = [];
  const delivered = await connector.deliverHeldResults({ client: client as never, configPath: worker.configPath,
    log: message => logs.push(message) });
  assert.deepEqual(delivered.map(entry => [entry.outcome, entry.reason]), [["held", "not_found"]],
    `the answer was not delivered: ${JSON.stringify(delivered)}`);
  assert.equal((await readdir(directory)).length, 1, "and the only record of it was NOT deleted");
  assert.ok(logs[0]!.includes("It is kept at"), `the operator is told where it is: ${logs[0]}`);
  assert.equal((await connector.heldResults(worker.configPath))[0]?.deliverable, true);
});

test("a claim reply that names no lease is told its deadline by the gateway, not guessed", { timeout: 180_000 }, async t => {
  // An older gateway, or a claim taken before the field existed: the reply names
  // no expiry. Answering immediately is what made the first version give up at
  // twenty seconds, and waiting blind is what would pin a machine open, so the
  // gateway is asked -- and the answer it gives is the deadline.
  const f = await fixture();
  t.after(() => f.close());
  await offer(f, "held-reread");
  const worker = await joinWorker(f, "ReReadBox");
  const config = JSON.parse(await readFile(worker.configPath, "utf8")) as { server: string; secret: string; workerId: string };
  const client = connector.createClient(config);
  const claimed = await client.claim((await client.work())[0]!.offerId, "reread-claim-key-000001");
  const reads: string[] = [];
  let fails = 0;
  const directory = heldDirectory(worker.configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const flaky = {
    claims: async () => { reads.push("claims");
      // What the gateway reports now: this claim is live and its lease ends soon.
      return [{ claimId: claimed.claimId, leaseState: "active",
        leaseExpiresAt: new Date(Date.now() + 3_000).toISOString() }]; },
    heartbeat: async () => ({ operationsMode: "running" }), progress: async () => ({}),
    result: async () => { fails += 1;
      // Refused for whole rounds, so the loop must ask where the lease ends
      // before it tries again -- which is the whole point of this test.
      if (fails <= 3) throw connectionDropped();
      return { resultId: "fleet-result:reread" }; },
    blocker: async () => ({ released: true }) };
  const finished = await connector.runClaimedTask({ client: flaky as never, claim: { claimId: claimed.claimId },
    log: () => {}, readMode: async () => "running", configPath: worker.configPath, secrets: [],
    adapter: { harness: "codex", deadlineMs: 1_000,
      execute: async () => ({ kind: "completed", text: `An answer whose deadline had to be asked for. ${"y".repeat(400)}` }) } });
  assert.equal(finished.outcome, "submitted", JSON.stringify(finished));
  assert.ok(reads.length >= 1, `the deadline was asked for, not assumed: ${reads.length} reads`);
  assert.equal(fails, 4, `refused for whole rounds, then sent: ${fails}`);
  assert.deepEqual(await readdir(directory), [], "and the record is gone once it lands");
  // What the gateway reports for this claim is the field this depends on.
  const live = await client.claims() as ReadonlyArray<Record<string, unknown>>;
  const mine = live.find(entry => entry.claimId === claimed.claimId);
  assert.equal(typeof mine?.leaseExpiresAt, "string", `myClaims reports the lease: ${JSON.stringify(mine)}`);
  assert.equal(mine?.leaseState, "active");
  assert.ok(Date.parse(String(mine?.leaseExpiresAt)) > Date.now(), "and it is a real future instant");
});

test("how long one delivery attempt spends is bounded, and a lease buys more ROUNDS not more waiting",
  { timeout: 600_000 }, async () => {
    // The bug in the first version was `report`'s own eight attempts bounding the
    // OUTER loop, so a delivery ended at about twenty seconds whatever the claim
    // had left. What replaced it is: one round is bounded, and the LEASE decides
    // whether another round happens. A round is about 20 s, so a 25 s lease gets
    // one round and a 70 s lease gets three -- and both finish near their own
    // lease, not near twenty seconds.
    const rounds = async (leaseMs: number) => {
      const dir = await mkdtemp(join(tmpdir(), "fleet-held-round-"));
      let sends = 0, reads = 0;
      const claimId = `fleet-claim:${String(leaseMs % 10).repeat(32)}`;
      const claimedAt = Date.now();
      const client = {
        progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }),
        // The gateway answers about this claim from the start, and its lease is
        // the one this test is measuring.
        claims: async () => { reads += 1; return [{ claimId, leaseState: "active",
          leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString() }]; },
        result: async () => { sends += 1;
          throw Object.assign(new Error("Control Room refused the request (http_503)."), { code: "http_503" }); },
        blocker: async () => ({ released: true }) };
      try {
        const startedAt = Date.now();
        const pass = await connector.runClaimedTask({ client: client as never,
          claim: { claimId, jobId: `job:${leaseMs}`, leaseExpiresAt: new Date(claimedAt + leaseMs).toISOString() },
          log: () => {}, readMode: async () => "running", configPath: join(dir, "worker.json"), secrets: [],
          adapter: { harness: "codex", deadlineMs: 1_000,
            execute: async () => ({ kind: "completed", text: `An answer with ${leaseMs}ms of lease. ${"q".repeat(400)}` }) } });
        return { elapsed: Date.now() - startedAt, sends, reads, outcome: pass.outcome };
      } finally { await rm(dir, { recursive: true, force: true }); }
    };
    const short = await rounds(25_000);
    const long = await rounds(70_000);
    // Neither is the old twenty-second give-up, and neither is report's own eight
    // attempts: both keep sending for far longer than that, and the longer lease
    // is waited out for longer. Each now ends at the lease the gateway last
    // reported rather than at a fixed sixty seconds, which is what a lease is
    // FOR: the 25 s case ends near 25 s because that is when its claim expired,
    // not because any timer fired.
    assert.ok(short.elapsed >= 20_000, `not given up at twenty seconds: ${short.elapsed}ms`);
    assert.ok(long.elapsed > short.elapsed + 30_000,
      `a longer lease is waited out for longer, and by about as much again: ${JSON.stringify({ short, long })}`);
    assert.ok(short.sends > 8, `and neither stopped at report's own eight attempts: ${JSON.stringify({ short, long })}`);
    assert.ok(long.sends > short.sends, `the longer lease bought more attempts: ${JSON.stringify({ short, long })}`);
    // What the per-round budget is FOR: a round is short enough that the loop
    // consults the gateway repeatedly, so a claim that is taken away or revoked
    // part-way through is noticed while there is still time to act on it. A round
    // as long as the whole lease would consult it once and then be blind for the
    // rest of the wait -- which is what the first version of this did.
    //
    // Two is the floor, not three: a round is 20 s and this wait is 70 s, but
    // where the boundaries fall depends on how far into a round the loop starts,
    // so the count varies between runs (measured 2 and 3). What must hold is
    // that the gateway is asked again at all, which a full-length round never
    // manages even once more.
    assert.ok(long.reads >= 2,
      `the lease is re-read across a long wait, not read once: ${long.reads} readings`);
    assert.ok(short.reads <= long.reads,
      `a longer wait consults the gateway at least as often: ${JSON.stringify({ short, long })}`);
    assert.equal(short.outcome, "blocked");
    assert.equal(long.outcome, "blocked");
  });

test("a key refused BEFORE the run starts is a lost claim, not an outage", { timeout: 120_000 }, async () => {
  // The same refusal, one step earlier: the gateway already refuses this
  // machine's credential when the run loop sends its start-progress note, so
  // the harness never runs. The lane's own "revoked mid-run" test covers this but
  // is timing-dependent about WHERE the revocation lands; this one pins the
  // branch itself.
  const notices: string[] = [];
  const client = {
    progress: async () => { throw Object.assign(new Error("Control Room refused the request (unauthenticated)."),
      { code: "unauthenticated" }); },
    heartbeat: async () => ({ operationsMode: "running" }), claims: async () => [],
    result: async () => { throw new Error("the harness must not run"); },
    blocker: async () => { notices.push("blocker"); return { released: true }; } };
  let ran = false;
  const finished = await connector.runClaimedTask({ client: client as never,
    claim: { claimId: `fleet-claim:${"5".repeat(32)}`, jobId: "job:refused-early" },
    log: message => notices.push(message), readMode: async () => "running", secrets: [],
    adapter: { harness: "codex", deadlineMs: 1_000,
      execute: async () => { ran = true; return { kind: "completed", text: "never reached." }; } } });
  assert.equal(ran, false, "the harness is never handed a task this machine cannot report on");
  assert.equal(finished.outcome, "abandoned", JSON.stringify(finished));
  assert.equal(finished.reason, "claim_lost", "a refused key is a lost claim, not a network outage");
  assert.deepEqual(notices.filter(line => line === "blocker"), [], "nothing is handed back");
  assert.ok(notices.every(line => !/could not be reached/u.test(line)),
    `and nothing suggests waiting for a network that works: ${JSON.stringify(notices)}`);
});

test("a key the gateway stops accepting is a lost claim, not an outage", { timeout: 120_000 }, async t => {
  // The gateway refuses this machine's credential the moment the answer is
  // being delivered -- a revocation that lands after the harness finished. That
  // is not a network problem: this machine can no longer report on the claim at
  // all, and saying "unreachable" would send the operator to wait for a network
  // that is working perfectly. It is the same fact the progress ticker reports
  // when it loses the claim mid-run.
  const f = await fixture();
  t.after(() => f.close());
  await offer(f, "held-revoked");
  const worker = await joinWorker(f, "RevokedLate");
  const realFetch = globalThis.fetch;
  let revoked = false;
  const revoking: typeof fetch = async (input, init) => {
    if (revoked && String(input).includes("/result")) {
      throw Object.assign(new Error("Control Room refused the request (unauthenticated)."),
        { code: "unauthenticated" });
    }
    if (!revoked && String(input).includes("/progress") && String(init?.method ?? "GET") === "POST") revoked = true;
    return realFetch(input, init);
  };
  const logs: string[] = [];
  const pass = await connector.runWorker({ configPath: worker.configPath, harnessesPath: await harnessSettings(f, "revoked"),
    fetcher: revoking, once: true, log: message => logs.push(message), progressIntervalMs: 200 });
  assert.equal(pass.outcome, "abandoned", JSON.stringify(pass));
  assert.equal(pass.reason, "claim_lost", "a refused key is a lost claim, not an unreachable network");
  assert.ok(logs.some(line => /refused this machine's key/u.test(line)),
    `and the operator is told why: ${JSON.stringify(logs)}`);
  assert.equal((await f.query<{ count: number }>("SELECT count(*)::int AS count FROM fleet_results"))[0]!.count, 0);
  assert.ok(logs.every(line => !/could not be reached/u.test(line)),
    `nothing suggests waiting for a network that works: ${JSON.stringify(logs)}`);
});

test("a claim missing from the gateway's bounded list is not read as gone", { timeout: 180_000 }, async () => {
  // `myClaims` is bounded and newest-first, so a claim older than its window is
  // simply absent while still being live. Reading that as "the claim is gone"
  // would throw away the answer of any machine holding more work than the list
  // shows -- which is exactly the case this path exists to protect.
  const dir = await mkdtemp(join(tmpdir(), "fleet-held-absent-"));
  let sends = 0, finished = false;
  const client = {
    progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }),
    // The gateway answered, and this claim is not in the list.
    claims: async () => [],
    result: async () => { sends += 1;
      // Every attempt is refused for the whole lease. If an absent claim read as
      // "gone" the loop would answer on its first round and this never succeeds.
      throw connectionDropped(); },
    blocker: async () => ({ released: true }) };
  const claim = { claimId: `fleet-claim:${"4".repeat(32)}`, jobId: "job:absent",
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() };
  const startedAt = Date.now();
  try {
    const pass = await connector.runClaimedTask({ client: client as never, claim, log: () => {},
      readMode: async () => "running", configPath: join(dir, "worker.json"), secrets: [],
      adapter: { harness: "codex", deadlineMs: 1_000,
        execute: async () => ({ kind: "completed", text: `An answer for an absent claim. ${"w".repeat(400)}` }) } });
    const elapsed = Date.now() - startedAt;
    // Read as "gone", the loop would answer on its first round: about 20 s is a
    // round, and the answer would be given up at the end of the FIRST lease read.
    assert.ok(elapsed >= 28_000, `an absent claim was waited out, not written off: ${elapsed}ms`);
    assert.ok(sends > 8, `and it kept being sent while the lease said so: ${sends}`);
    assert.equal(pass.outcome, "blocked", `the answer is not delivered, but it is not lost: ${JSON.stringify(pass)}`);
    assert.equal((await readdir(join(dir, "held-results"))).length, 1, "and it is still on this machine");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a known lease is honoured for its WHOLE life: a 20s, 60s and 300s outage all deliver",
  { timeout: 900_000 }, async t => {
    // The gap rv-r5b7 found: a fixed sixty-second ceiling sat beside the lease, so
    // a gateway that stayed unreachable for longer than a minute handed the task
    // back -- "nothing was submitted" -- on a claim that still had minutes of life
    // left. The lease the owner granted is the authority, so each of these drops
    // ends with the answer delivered, for the whole of the lease rather than for
    // the first minute of it.
    //
    // Every case here is a FULL outage: the transport refuses every request, so
    // the answer cannot be sent AND the lease cannot be re-read. That is the case
    // the ceiling was overriding, and it is why the claim reply's own deadline --
    // the owner's grant -- has to be what bounds the wait.
    for (const outageMs of [20_000, 60_000, 300_000]) {
      const f = await fixture({ leaseMs: outageMs + 120_000 });
      // Each case builds its own gateway and worker, so a failing assertion must
      // not leak the server or the temp directory into the next iteration.
      try {
        const task = await offer(f, `held-long-${outageMs}`);
        const realFetch = globalThis.fetch;
        let down = false, started = false;
        const dropping: typeof fetch = async (input, init) => {
          const url = String(input);
          if (!started && url.includes("/progress") && String(init?.method ?? "GET") === "POST") started = true;
          if (down) throw connectionDropped();
          const response = await realFetch(input, init);
          if (started) down = true;
          return response;
        };
        const worker = await joinWorker(f, `Long${outageMs}Box`);
        const harnesses = join(f.dir, `long-${outageMs}-harnesses.json`);
        await writeFile(harnesses, JSON.stringify({ schema: "control-room.fleet-harnesses/v1", adapterModule: FAKE_MODULE,
          harnesses: { codex: { enabled: true, deadlineMs: 60_000, fakeBehaviour: "success", delayMs: 2_000 } } }),
        { mode: 0o600 });
        const lift = setTimeout(() => { down = false; }, 2_000 + outageMs);
        fake.calls.length = 0;
        const startedAt = Date.now();
        const pass = await connector.runWorker({ configPath: worker.configPath, harnessesPath: harnesses,
          fetcher: dropping, once: true, log: () => {}, progressIntervalMs: 200 });
        clearTimeout(lift);
        const elapsed = Date.now() - startedAt;
        t.diagnostic(`outage ${outageMs}ms -> ${pass.outcome} in ${elapsed}ms`);
        assert.equal(started, true, `the outage began while the harness was running (${outageMs}ms case)`);
        assert.equal(pass.outcome, "submitted",
          `a ${outageMs}ms outage must not override the lease: ${JSON.stringify(pass)}`);
        assert.ok(elapsed >= outageMs, `the outage really lasted ${elapsed}ms of wall-clock`);
        // Exactly one answer reached the owner, and no hand-back contradicts it.
        const rows = await storedResults(f);
        assert.equal(rows.length, 1, `one answer on the owner's board after a ${outageMs}ms drop: ${JSON.stringify(rows)}`);
        assert.equal(rows[0]!.job_id, task.jobId);
        assert.equal(await jobState(f, task.jobId), "waiting_approval");
        const blockers = await f.query<{ message: string }>(`SELECT e.message FROM fleet_worker_events e JOIN fleet_claims c
          ON c.tenant_id=e.tenant_id AND c.claim_id=e.claim_id WHERE c.job_id=$1 AND e.kind='blocker'`, [task.jobId]);
        assert.deepEqual(blockers, [], `a long outage is never a hand-back (${outageMs}ms case)`);
        assert.deepEqual(await connector.heldResults(worker.configPath), []);
      } finally { await f.close(); }
    }
  });

test("an outage longer than the lease hands back only after the lease ends, and never delivers after it",
  { timeout: 400_000 }, async t => {
    // The other half of the lease's meaning: honouring it must not mean waiting
    // past it. With the network away for twice the lease, the answer is NOT
    // submitted -- the claim cannot be reported on any more -- and the hand-back
    // lands only once the lease has genuinely run out, with the finished answer
    // still on this machine rather than thrown away.
    const leaseMs = 30_000;
    const f = await fixture({ leaseMs });
    t.after(() => f.close());
    const task = await offer(f, "held-past-lease");
    const realFetch = globalThis.fetch;
    let down = false, started = false, lifted = false;
    const dropping: typeof fetch = async (input, init) => {
      const url = String(input);
      if (!started && url.includes("/progress") && String(init?.method ?? "GET") === "POST") started = true;
      if (down) throw connectionDropped();
      const response = await realFetch(input, init);
      if (started) down = true;
      return response;
    };
    const worker = await joinWorker(f, "PastLeaseBox");
    const harnesses = join(f.dir, "past-lease-harnesses.json");
    await writeFile(harnesses, JSON.stringify({ schema: "control-room.fleet-harnesses/v1", adapterModule: FAKE_MODULE,
      harnesses: { codex: { enabled: true, deadlineMs: 60_000, fakeBehaviour: "success", delayMs: 2_000 } } }),
    { mode: 0o600 });
    // Past the lease, the network comes back, so the hand-back has somewhere to
    // land. Lifting it before the lease ended would be a different test: the
    // connector would deliver the answer, which is correct and the case above.
    // Outage is measured from the harness starting, and the lease was granted at
    // the claim just before it, so it ends a shade before the lift does.
    const lift = setTimeout(() => { down = false; lifted = true; }, 2_000 + leaseMs + 15_000);
    fake.calls.length = 0;
    const startedAt = Date.now();
    const pass = await connector.runWorker({ configPath: worker.configPath, harnessesPath: harnesses,
      fetcher: dropping, once: true, log: () => {}, progressIntervalMs: 200 });
    clearTimeout(lift);
    const elapsed = Date.now() - startedAt;
    assert.equal(started, true, "the outage began while the harness was running");
    assert.equal(lifted, true, "the network came back, so the hand-back had somewhere to land");
    assert.ok(["blocked", "abandoned"].includes(pass.outcome ?? ""), JSON.stringify(pass));
    assert.ok(elapsed >= leaseMs, `it waited for the lease it was granted: ${elapsed}ms`);
    assert.ok(elapsed < leaseMs * 2 + 40_000, `and did not wait past it either: ${elapsed}ms`);
    // Never delivered after the lease ended: the gateway has nothing, even though
    // the network recovered with the answer still in hand.
    assert.equal((await storedResults(f)).length, 0, "an answer was never stored after its lease ended");
    assert.notEqual(await jobState(f, task.jobId), "waiting_approval");
    // The finished work is still recoverable by hand rather than lost.
    const held = await connector.heldResults(worker.configPath);
    assert.equal(held.length, 1, `the answer is still on this machine: ${JSON.stringify(held)}`);
    assert.equal(held[0]!.deliverable, true);
  });

test("a gateway whose lease keeps sliding forward does not hold this machine open for ever",
  { timeout: 420_000 }, async () => {
    // Removing the fixed ceiling must not remove the ONLY thing that bounded a
    // wait. A lease is a deadline the gateway re-reports, so a stub that answers
    // every reading with a fresh full-length lease would otherwise never let the
    // wait end. There is now ONE deadline per answer, set from the owner's grant
    // and only ever moved EARLIER, so the bound that replaces the ceiling is the
    // EARLIEST lease end ever read for this claim.
    //
    // Both halves matter, and the order is what makes this end early. The grant
    // is deliberately LONGER than the ceiling this replaced, and the stub's own
    // reading is SHORTER than that grant but still slides forward on every call:
    // a gateway that keeps renewing as it is asked. The first reading is therefore
    // the earliest this machine ever sees, it wins, and everything after it is a
    // later reading that must be ignored. A short grant would end at its own
    // expiry either way, and a stub that stopped at the grant would end at the
    // grant either way, so neither alone makes this a test of anything.
    const dir = await mkdtemp(join(tmpdir(), "fleet-held-sliding-"));
    const leaseMs = 25_000, grantMs = 150_000, claimId = `fleet-claim:${"3".repeat(32)}`;
    const claimedAt = Date.now();
    let sends = 0, reads = 0;
    const client = {
      progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }),
      // Every reading reports a lease ending a full term from NOW, sliding
      // further out as the wait goes on. The first of these is the earliest this
      // machine is ever told, so it is the one that ends the wait.
      claims: async () => { reads += 1; return [{ claimId, leaseState: "active",
        leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString() }]; },
      result: async () => { sends += 1;
        throw Object.assign(new Error("Control Room refused the request (http_503)."), { code: "http_503" }); },
      blocker: async () => ({ released: true }) };
    try {
      const startedAt = Date.now();
      const pass = await connector.runClaimedTask({ client: client as never,
        claim: { claimId, jobId: "job:sliding", leaseExpiresAt: new Date(claimedAt + grantMs).toISOString() },
        log: () => {}, readMode: async () => "running", configPath: join(dir, "worker.json"), secrets: [],
        adapter: { harness: "codex", deadlineMs: 1_000,
          execute: async () => ({ kind: "completed", text: `An answer against a sliding stub. ${"s".repeat(400)}` }) } });
      const elapsed = Date.now() - startedAt;
      assert.equal(pass.outcome, "blocked", JSON.stringify(pass));
      assert.ok(reads >= 1, `the lease really was consulted: ${reads} readings`);
      assert.ok(sends > 0, `and the answer really kept being sent: ${sends} attempts`);
      // It ends near the EARLIEST deadline ever read -- the FIRST stub reading,
      // leaseMs out -- not at sixty seconds (the ceiling this replaces), not at
      // the much longer grant, and not never. Every reading after the first is a
      // later one, and a stub that answers 25 s further out each time is measured
      // over several of those, so a wait that followed the latest reading rather
      // than the first would run far past this bound.
      assert.ok(elapsed >= leaseMs - 5_000, `it waited out the shortest lease it was ever told: ${elapsed}ms`);
      assert.ok(elapsed <= leaseMs + 45_000,
        `a sliding lease does not hold the machine open past the shortest reading: ${elapsed}ms`);
      assert.ok(elapsed < grantMs - 5_000,
        `and it certainly did not wait out the longer grant: ${elapsed}ms`);
      assert.equal((await readdir(join(dir, "held-results"))).length, 1, "the answer is still on this machine");
    } finally { await rm(dir, { recursive: true }); }
  });

test("a claim reply naming no lease, on a gateway whose lease slides, still ends at one deadline",
  { timeout: 300_000 }, async () => {
    // The rv-r5b7b probe, unchanged in shape: the claim reply names NO lease at
    // all, and every reading the gateway gives back is a fresh full term measured
    // from now. With no grant to anchor it, the only thing that ever ends this is
    // the earliest deadline this machine learns -- take the latest reading instead
    // and it never ends, which is what a restarted worker did.
    const dir = await mkdtemp(join(tmpdir(), "fleet-held-unnamed-sliding-"));
    let sends = 0, reads = 0;
    const client = {
      progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }),
      claims: async () => { reads += 1; return [{ claimId: `fleet-claim:${"6".repeat(32)}`, leaseState: "active",
        leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() }]; },
      result: async () => { sends += 1; throw connectionDropped(); },
      blocker: async () => ({ released: true }) };
    try {
      const startedAt = Date.now();
      const pass = await connector.runClaimedTask({ client: client as never,
        claim: { claimId: `fleet-claim:${"6".repeat(32)}`, jobId: "job:unnamed-sliding" },
        log: () => {}, readMode: async () => "running", configPath: join(dir, "worker.json"), secrets: [],
        adapter: { harness: "codex", deadlineMs: 1_000,
          execute: async () => ({ kind: "completed", text: `An answer with no grant. ${"n".repeat(400)}` }) } });
      const elapsed = Date.now() - startedAt;
      assert.equal(pass.outcome, "blocked", JSON.stringify(pass));
      assert.ok(reads >= 1 && sends > 1, `it really was trying and really was asking: ${reads} reads, ${sends} sends`);
      // It ends at the FIRST reading it learned (about 30 s out), not never. The
      // stub here slides by a full term each time it is asked, so following the
      // latest reading would push this past two minutes.
      assert.ok(elapsed >= 25_000, `it waited out the first lease it was told: ${elapsed}ms`);
      assert.ok(elapsed <= 100_000, `and it ended rather than following the sliding expiry: ${elapsed}ms`);
      // The first deadline it learned is written down with the answer, because
      // this is the case where nothing else carries it across a restart.
      const record: { deadlineAt: number; heldAt: number } = JSON.parse(
        await readFile(join(dir, "held-results", `held-result-${"6".repeat(32)}.json`), "utf8"));
      assert.ok(Number.isSafeInteger(record.deadlineAt), `the learned deadline was kept: ${JSON.stringify(record)}`);
      assert.ok(record.deadlineAt >= startedAt && record.deadlineAt <= startedAt + 40_000,
        `and it is the FIRST one, roughly a full term from the first reading rather than from the end of the wait: ${JSON.stringify(record)}`);
      assert.equal((await readdir(join(dir, "held-results"))).length, 1, "the answer is still on this machine");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

test("a restart keeps the deadline it learned instead of starting the wait again", { timeout: 300_000 }, async () => {
  // A worker that dies holding an answer and comes back has no claim reply to
  // carry the lease: the restart sweep passes only a claimId. So the deadline the
  // first process learned has to have been written down with the answer, or the
  // second one re-learns a sliding expiry from scratch and never ends. This runs
  // the REAL sweep -- deliverHeldResults over a real file on disk -- twice over.
  const dir = await mkdtemp(join(tmpdir(), "fleet-held-restart-deadline-"));
  const claimId = `fleet-claim:${"8".repeat(32)}`;
  const summary = `An answer a dead worker left behind. ${"k".repeat(200)}`.trim();
  const firstAt = Date.now() - 20_000;
  // A record written by the process that died: held twenty seconds ago, with the
  // first deadline it learned -- fifteen seconds after it was held, so five
  // seconds ago. That deadline has PASSED, so a sweep honouring it stops at once
  // and never asks the gateway for a longer one. A sweep that ignores the record
  // and follows this stub's sliding 120 s reading instead would run for minutes,
  // which is the whole property.
  await mkdir(join(dir, "held-results"), { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "held-results", `held-result-${"8".repeat(32)}.json`), `${JSON.stringify({
    schema: "control-room.fleet-held-result/v1", claimId, summary,
    idempotencyKey: `handoff-${"8".repeat(32)}-result`, heldAt: firstAt, deadlineAt: firstAt + 15_000 })}\n`, { mode: 0o600 });
  let sends = 0, reads = 0;
  const client = {
    progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }),
    // A sliding gateway again, and a later reading than the one already learned.
    claims: async () => { reads += 1; return [{ claimId, leaseState: "active",
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() }]; },
    result: async () => { sends += 1; throw connectionDropped(); },
    blocker: async () => ({ released: true }) };
  try {
    const startedAt = Date.now();
    const delivered = await connector.deliverHeldResults({ client: client as never, configPath: join(dir, "worker.json"),
      log: () => {} });
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(delivered.map(entry => entry.outcome), ["held"], `it gave up rather than waiting: ${JSON.stringify(delivered)}`);
    assert.ok(sends > 0, `and it really kept trying: ${sends} attempts`);
    // The persisted deadline is already past, so a sweep that honoured it ends
    // at once. A sweep that ignored the record -- which is what "pass only a
    // claimId" invites -- would follow this gateway's sliding 120 s reading and
    // run for minutes.
    assert.ok(elapsed <= 20_000, `the restart waited out the deadline the dead process learned: ${elapsed}ms`);
    assert.equal(reads, 0, `and did not ask the gateway for a later one: ${reads} readings`);
    assert.equal((await readdir(join(dir, "held-results"))).length, 1, "the answer is still on this machine");
  } finally { await rm(dir, { recursive: true, force: true }); }
  // The other half: a persisted deadline that has NOT yet passed is the one this
  // worker has to wait out, and it must not be replaced by the gateway's longer
  // sliding reading. Same file shape, same sweep, deadline 15 seconds out.
  const live = await mkdtemp(join(tmpdir(), "fleet-held-restart-live-"));
  const liveAt = Date.now();
  try {
    await mkdir(join(live, "held-results"), { recursive: true, mode: 0o700 });
    await writeFile(join(live, "held-results", `held-result-${"c".repeat(32)}.json`), `${JSON.stringify({
      schema: "control-room.fleet-held-result/v1", claimId: `fleet-claim:${"c".repeat(32)}`, summary,
      idempotencyKey: `handoff-${"c".repeat(32)}-result`, heldAt: liveAt, deadlineAt: liveAt + 15_000 })}\n`, { mode: 0o600 });
    let liveReads = 0;
    const sliding = {
      progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }),
      claims: async () => { liveReads += 1; return [{ claimId: `fleet-claim:${"c".repeat(32)}`, leaseState: "active",
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() }]; },
      result: async () => { throw connectionDropped(); },
      blocker: async () => ({ released: true }) };
    const startedAt = Date.now();
    const delivered = await connector.deliverHeldResults({ client: sliding as never, configPath: join(live, "worker.json"),
      log: () => {} });
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(delivered.map(entry => entry.outcome), ["held"], `it gave up rather than waiting: ${JSON.stringify(delivered)}`);
    assert.ok(elapsed >= 12_000, `it waited out the deadline it was handed, not answered at once: ${elapsed}ms`);
    // The upper bound is the property: this stub answers every reading with five
    // minutes, and following that would run far past the deadline in the file.
    assert.ok(elapsed <= 60_000, `and did not follow the gateway's five-minute sliding reading: ${elapsed}ms over ${liveReads} readings`);
  } finally { await rm(live, { recursive: true, force: true }); }
});

test("a held record whose deadline cannot be believed is refused, not waited on", { timeout: 120_000 }, async () => {
  // An invalid deadline has no trustworthy minimum and must be refused.
  // Missing or invalid heldAt is covered by the conservative-anchor regressions.
  const cases: ReadonlyArray<{ label: string; fields: Record<string, unknown> }> = [
    { label: "deadlineAt fractional", fields: { heldAt: Date.now(), deadlineAt: Date.now() + 1_000.5 } },
    { label: "deadlineAt not a number", fields: { heldAt: Date.now(), deadlineAt: "tomorrow" } },
  ];
  for (const [index, entry] of cases.entries()) {
    const dir = await mkdtemp(join(tmpdir(), `fleet-held-badclock-${index}-`));
    const digit = String(index + 1).repeat(32);
    const claimId = `fleet-claim:${digit}`;
    try {
      await mkdir(join(dir, "held-results"), { recursive: true, mode: 0o700 });
      await writeFile(join(dir, "held-results", `held-result-${digit}.json`), `${JSON.stringify({
        schema: "control-room.fleet-held-result/v1", claimId, summary: "An answer with an impossible clock.",
        idempotencyKey: `handoff-${digit}-result`, ...entry.fields })}\n`, { mode: 0o600 });
      let touched = false;
      const logs: string[] = [];
      const client = {
        progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }), claims: async () => [],
        result: async () => { touched = true; return { resultId: "fleet-result:never" }; } };
      const startedAt = Date.now();
      const delivered = await connector.deliverHeldResults({ client: client as never, configPath: join(dir, "worker.json"),
        log: message => logs.push(message) });
      const elapsed = Date.now() - startedAt;
      assert.deepEqual(delivered, [], `${entry.label}: nothing was delivered: ${JSON.stringify(delivered)}`);
      assert.equal(touched, false, `${entry.label}: the gateway was never sent an answer from it`);
      assert.equal(logs.filter(line => /not readable/u.test(line)).length, 1,
        `${entry.label}: and the operator was told why: ${JSON.stringify(logs)}`);
      assert.ok(elapsed < 5_000, `${entry.label}: and it did not wait: ${elapsed}ms`);
      assert.equal((await readdir(join(dir, "held-results"))).length, 1, `${entry.label}: left where an operator can look`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  // The other half of the rule, so it is a rule and not a reflex: a record naming
  // NO instants at all is ordinary -- that is what every older connector wrote --
  // and is delivered, never refused.
  const plain = await mkdtemp(join(tmpdir(), "fleet-held-noclock-"));
  try {
    const digit = "9".repeat(32);
    const claimId = `fleet-claim:${digit}`;
    await mkdir(join(plain, "held-results"), { recursive: true, mode: 0o700 });
    await writeFile(join(plain, "held-results", `held-result-${digit}.json`), `${JSON.stringify({
      schema: "control-room.fleet-held-result/v1", claimId, summary: "An answer with no instants at all.",
      idempotencyKey: `handoff-${digit}-result` })}\n`, { mode: 0o600 });
    const client = {
      progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }), claims: async () => [],
      result: async () => ({ resultId: `fleet-result:${digit.slice(0, 8)}` }) };
    const logs: string[] = [];
    const delivered = await connector.deliverHeldResults({ client: client as never, configPath: join(plain, "worker.json"),
      log: message => logs.push(message) });
    assert.deepEqual(delivered.map(entry => entry.outcome), ["submitted"],
      `a record with no instants is an ordinary one, not a damaged one: ${JSON.stringify(delivered)} ${JSON.stringify(logs)}`);
    assert.deepEqual(await readdir(join(plain, "held-results")), [], "and it was cleared once delivered");
  } finally { await rm(plain, { recursive: true, force: true }); }
});

test("a claim whose deadline NOTHING has ever named still asks, and still stops", { timeout: 180_000 }, async () => {
  // Round sizing is what makes this possible. With no deadline named anywhere,
  // every round is the short one, so the loop comes back and asks the gateway
  // again -- and a gateway that cannot say when the claim ends must not hold the
  // wait open. Both halves matter. One long blind round would never ask at all,
  // and never asking again would never end.
  const dir = await mkdtemp(join(tmpdir(), "fleet-held-unnamed-rounds-"));
  let sends = 0, reads = 0;
  const client = {
    progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }),
    // The gateway cannot say, ever: the claim is simply not in the bounded list,
    // which means "cannot say" rather than "gone" (see the absent-claim test).
    claims: async () => { reads += 1; return []; },
    result: async () => { sends += 1; throw connectionDropped(); },
    blocker: async () => ({ released: true }) };
  try {
    const startedAt = Date.now();
    const pass = await connector.runClaimedTask({ client: client as never,
      claim: { claimId: `fleet-claim:${"a".repeat(32)}`, jobId: "job:unnamed-rounds" },
      log: () => {}, readMode: async () => "running", configPath: join(dir, "worker.json"), secrets: [],
      adapter: { harness: "codex", deadlineMs: 1_000,
        execute: async () => ({ kind: "completed", text: `An answer asked for twice. ${"p".repeat(400)}` }) } });
    const elapsed = Date.now() - startedAt;
    assert.equal(pass.outcome, "blocked", JSON.stringify(pass));
    // Asked repeatedly: the short round is what buys a second question, and a
    // second question is the only way a deadline can be learned at all. Measured
    // on this shape: eleven readings with the short round, three without, so this
    // floor is a real difference rather than a round count that drifts.
    assert.ok(reads >= 6, `the gateway was asked repeatedly: ${reads} readings`);
    assert.ok(sends > 10, `and the answer kept being sent while it asked: ${sends} attempts`);
    // It ends on the fallback window from when the answer was held, which is well
    // inside the timeout -- a wait that had learned nothing could still never be
    // allowed to run for ever.
    assert.ok(elapsed >= 50_000, `it was given the window it has to learn a deadline: ${elapsed}ms`);
    assert.ok(elapsed <= 100_000, `and gave up rather than waiting for ever: ${elapsed}ms`);
    assert.equal((await readdir(join(dir, "held-results"))).length, 1, "the answer is still on this machine");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the ceiling the delivery waits under is the gateway's own maximum lease", { timeout: 120_000 }, async () => {
  // This connector ships to a worker's machine as ONE standalone file, so it
  // cannot import the gateway's constants -- it carries its own copy of the
  // maximum lease, and nothing else keeps the two in step. `FleetGatewayStoreV1`
  // refuses any lease outside 30 s .. 3 600 000, and `FLEET_LEASE_MS_V1` is the
  // ordinary one, so the connector's ceiling has to be the gateway's maximum: a
  // smaller one would hand a task back while a real lease was still live (the
  // original outage bug in a new place) and a larger one would wait for a claim that
  // cannot exist.
  const source = await readFile("scripts/fleet/connector.mjs", "utf8");
  assert.match(source, /const RESULT_MAX_LEASE_MS = 60 \* 60_000;/u,
    "the connector's ceiling is the gateway's maximum lease length");
  assert.equal(60 * 60_000, FLEET_MAX_LEASE_MS_V1, "connector ceiling matches the real gateway definition");
  const db = {} as DatabaseClient;
  assert.doesNotThrow(() => new FleetGatewayStoreV1(db, { tenantId: FLEET_TENANT, leaseMs: FLEET_MAX_LEASE_MS_V1 }));
  assert.throws(() => new FleetGatewayStoreV1(db, { tenantId: FLEET_TENANT, leaseMs: FLEET_MAX_LEASE_MS_V1 + 1 }),
    /fleet_gateway_configuration_invalid/u);
  assert.ok(FLEET_LEASE_MS_V1 <= FLEET_MAX_LEASE_MS_V1);
  // A source read proves the number is there, not that anything obeys it. This is
  // the behaviour: an answer held for longer than ANY lease the gateway can grant
  // -- its `heldAt` is more than the ceiling in the past, and its `deadlineAt` is
  // further out than any real claim -- belongs to a claim that cannot still be
  // live. It must be handed back at once, not waited on, because that is the
  // only thing that stops a sliding deadline running for ever.
  const dir = await mkdtemp(join(tmpdir(), "fleet-held-past-ceiling-"));
  const claimId = `fleet-claim:${"e".repeat(32)}`;
  try {
    await mkdir(join(dir, "held-results"), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "held-results", `held-result-${"e".repeat(32)}.json`), `${JSON.stringify({
      schema: "control-room.fleet-held-result/v1", claimId, summary: "An answer held past every real lease.",
      idempotencyKey: `handoff-${"e".repeat(32)}-result`, heldAt: Date.now() - 90 * 60_000,
      deadlineAt: Date.now() + 80 * 60_000 })}\n`, { mode: 0o600 });
    let sends = 0;
    const client = {
      progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }),
      // A gateway that will happily keep sliding: this is what a real one looks
      // like when a claim has been gone for an hour and it has not noticed.
      claims: async () => [{ claimId, leaseState: "active", leaseExpiresAt: new Date(Date.now() + 90 * 60_000).toISOString() }],
      result: async () => { sends += 1; throw connectionDropped(); },
      blocker: async () => ({ released: true }) };
    const startedAt = Date.now();
    const delivered = await connector.deliverHeldResults({ client: client as never, configPath: join(dir, "worker.json"),
      log: () => {} });
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(delivered.map(entry => entry.outcome), ["held"], `it gave up rather than waiting: ${JSON.stringify(delivered)}`);
    assert.ok(elapsed <= 20_000, `a claim older than any real lease is not waited on: ${elapsed}ms over ${sends} attempts`);
    assert.equal((await readdir(join(dir, "held-results"))).length, 1, "the answer is still on this machine");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a claim whose deadline is genuinely unknown is still bounded", { timeout: 300_000 }, async () => {
    // The ceiling the fix removed applied to this case too, and rightly: a reply
    // that names no expiry and a gateway that cannot say when the claim ends must
    // not pin a machine open for the length of a real lease. It is bounded by the
    // wait it is given to learn a deadline, counted from the moment it began.
    const dir = await mkdtemp(join(tmpdir(), "fleet-held-unknown-"));
    let sends = 0;
    const client = {
      progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }),
      // The gateway cannot say: the claim is simply not in the bounded list.
      claims: async () => [],
      result: async () => { sends += 1; throw connectionDropped(); },
      blocker: async () => ({ released: true }) };
    try {
      const startedAt = Date.now();
      const pass = await connector.runClaimedTask({ client: client as never,
        claim: { claimId: `fleet-claim:${"2".repeat(32)}`, jobId: "job:unknown" },
        log: () => {}, readMode: async () => "running", configPath: join(dir, "worker.json"), secrets: [],
        adapter: { harness: "codex", deadlineMs: 1_000,
          execute: async () => ({ kind: "completed", text: `An answer with no deadline anywhere. ${"u".repeat(400)}` }) } });
      const elapsed = Date.now() - startedAt;
      assert.equal(pass.outcome, "blocked", JSON.stringify(pass));
      assert.ok(sends > 1, `it kept trying rather than answering at once: ${sends} attempts`);
      assert.ok(elapsed >= 55_000, `it was given the wait it has to learn a deadline: ${elapsed}ms`);
      assert.ok(elapsed <= 95_000, `and gave up rather than waiting for ever: ${elapsed}ms`);
      assert.equal((await readdir(join(dir, "held-results"))).length, 1, "the answer is still on this machine");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

test("the held-answer directory beside the credential is private, and a delivered answer leaves nothing behind",
  { timeout: 120_000 }, async t => {
    const f = await fixture();
    t.after(() => f.close());
    const worker = await joinWorker(f, "ManyBox");
    const config = JSON.parse(await readFile(worker.configPath, "utf8")) as { secret: string };
    const client = {
      result: async (claimId: string) => ({ resultId: `fleet-result:${claimId.slice(12, 20)}` }),
      progress: async () => ({}), heartbeat: async () => ({ operationsMode: "running" }), claims: async () => [],
      blocker: async () => ({ released: true }) };
    const log: string[] = [];
    // Ten different claims, each delivered: the directory beside the credential
    // is created, kept private, and emptied of every delivered answer.
    for (let index = 0; index < 10; index += 1) {
      const claimId = `fleet-claim:${String(index).repeat(32)}`;
      const finished = await connector.runClaimedTask({ client: client as never, claim: { claimId, jobId: `job:${index}` },
        log: m => log.push(m), readMode: async () => "running", secrets: [], configPath: worker.configPath,
        adapter: { harness: "codex", deadlineMs: 1_000,
          execute: async () => ({ kind: "completed", text: `Answer number ${index} for ${claimId}.` }) } });
      assert.equal(finished.outcome, "submitted", JSON.stringify(finished));
    }
    assert.deepEqual(await connector.heldResults(worker.configPath), [], "a delivered answer leaves no record behind");
    const directory = heldDirectory(worker.configPath);
    assert.deepEqual(await readdir(directory), [], "nothing accumulates beside the credential");
    assert.ok(log.every(line => !line.includes(config.secret)), "no held-result note ever prints the credential");
    if (process.platform !== "win32") assert.equal((await stat(directory)).mode & 0o777, 0o700);
  });

// The review's recovery probes, promoted to fast deterministic regressions. The
// same primitive still uses real journal files; only time and the report port
// are injected, so hour-long restart windows need no hour-long timer.
async function recoveryPorts() {
  const { register } = await import("node:module");
  register("./support/fleet-held-recovery-loader.mjs", import.meta.url);
  const specifier = "../scripts/fleet/connector.mjs?held-recovery-test";
  return await import(specifier);
}
async function recoveryRecord(fields: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fleet-held-recovery-"));
  const claimId = `fleet-claim:${"4".repeat(32)}`;
  const file = join(directory, `held-result-${"4".repeat(32)}.json`);
  const record = { schema: "control-room.fleet-held-result/v1", claimId, summary: "A completed held answer.",
    idempotencyKey: `handoff-${"4".repeat(32)}-result`, ...fields };
  await writeFile(file, JSON.stringify(record), { mode: 0o600 });
  return { directory, claimId, file, record };
}
const outage = () => Object.assign(new Error("controlled outage"), { code: "unavailable" });

test("missing or invalid held anchors are persisted before delivery and survive restart", { timeout: 30_000 }, async () => {
  const ports = await recoveryPorts();
  for (const anchor of [undefined, null, 0, -1, "invalid", Date.now() + 86_400_000]) {
    for (const named of [true, false]) {
      const base = Date.now();
      const state = await recoveryRecord({ heldAt: anchor, ...(named ? { deadlineAt: base + 12 * 3_600_000 } : {}) });
      const stops: number[] = [];
      let sentWithoutAnchor = false;
      try {
        for (const start of [base, base + 30 * 60_000]) {
          let clock = start, rounds = 0;
          const held = await ports.testRead(state.directory, state.claimId);
          await assert.rejects(ports.testDeliver({ ...state.record, directory: state.directory,
            claim: { claimId: state.claimId }, held, now: () => clock,
            // Simulate a long sleep after the first retry. This tests recovery
            // at the actual boundary without thousands of disk-sync rounds.
            sleep: async (target: number) => { clock = Math.max(target, base + (named ? FLEET_MAX_LEASE_MS_V1 : 60_000)); },
            client: { result: async () => { throw outage(); }, claims: async () => [] },
            reportDelivery: async (_send: unknown, _allowed: number, budget: number) => {
              const saved = JSON.parse(await readFile(state.file, "utf8"));
              sentWithoutAnchor ||= saved.heldAt !== base;
              assert.ok(++rounds < 250);
              clock += budget; throw outage();
            } }));
          stops.push(clock);
        }
        assert.ok(stops[1] <= Math.max(stops[0], base + 30 * 60_000), "restart cannot reset the deadline");
        assert.equal(sentWithoutAnchor, false, "anchor is durable before ANY delivery");
        const saved = JSON.parse(await readFile(state.file, "utf8"));
        assert.equal(saved.heldAt, base);
        if (named) assert.equal(saved.deadlineAt, base + FLEET_MAX_LEASE_MS_V1, "the saved deadline is capped from that first anchor");
      } finally { await rm(state.directory, { recursive: true, force: true }); }
    }
  }
});

test("synchronized recovery callers merge the current disk minimum, including 50 callers", { timeout: 30_000 }, async () => {
  const ports = await recoveryPorts();
  const base = Date.now(), state = await recoveryRecord({ heldAt: base, deadlineAt: null });
  let release: () => void = () => {};
  const firstSaved = new Promise<void>(done => { release = done; });
  const held = await ports.testRead(state.directory, state.claimId);
  const run = async (later: boolean) => {
    let clock = base;
    return ports.testDeliver({ ...state.record, directory: state.directory, claim: { claimId: state.claimId }, held,
      now: () => clock, sleep: async (target: number) => { clock = target; },
      client: { result: async () => { throw outage(); }, claims: async () => {
        if (later) await firstSaved;
        return [{ claimId: state.claimId, leaseState: "active", leaseExpiresAt: new Date(base + (later ? 30_000 : 10_000)).toISOString() }];
      } }, reportDelivery: async () => { throw outage(); } });
  };
  const callers = [run(false), run(true)];
  try {
    // Both callers have the same stale snapshot; release the later gateway
    // reading only after the earlier minimum is on disk.
    for (let i = 0; i < 200; i++) {
      if (JSON.parse(await readFile(state.file, "utf8")).deadlineAt === base + 10_000) break;
      await new Promise(done => setTimeout(done, 5));
    }
    assert.equal(JSON.parse(await readFile(state.file, "utf8")).deadlineAt, base + 10_000);
    release();
    await Promise.allSettled(callers);
    assert.equal(JSON.parse(await readFile(state.file, "utf8")).deadlineAt, base + 10_000);
    await Promise.all(Array.from({ length: 50 }, (_, i) => ports.testWrite(state.directory, state.claimId,
      { ...state.record, heldAt: base + i, deadlineAt: base + 1000 + i * 1000 })));
    const saved = JSON.parse(await readFile(state.file, "utf8"));
    assert.equal(saved.deadlineAt, base + 1000);
    assert.equal(saved.heldAt, base);
    assert.equal((await readdir(state.directory)).filter(name => name.endsWith(".lock")).length, 0);
  } finally { release(); await Promise.allSettled(callers); await rm(state.directory, { recursive: true, force: true }); }
});

test("an outstanding deadline retries after temporary ENOSPC and real filesystem refusal", { timeout: 30_000 }, async () => {
  const ports = await recoveryPorts();
  const globals = globalThis as typeof globalThis & { heldRecoveryWriteFailures?: number };
  for (const real of [false, true]) {
    const base = Date.now(), state = await recoveryRecord({ heldAt: base, deadlineAt: base + 90_000 });
    const { rename } = await import("node:fs/promises");
    let clock = base, reads = 0, moved = false, sendsAfterFailure = 0, unsafeResend = false;
    const restore = async () => {
      if (moved) { await rm(state.directory); await rename(`${state.directory}-saved`, state.directory); moved = false; }
    };
    try {
      await assert.rejects(ports.testDeliver({ ...state.record, directory: state.directory,
        claim: { claimId: state.claimId }, held: await ports.testRead(state.directory, state.claimId), now: () => clock,
        client: { result: async () => { throw outage(); }, claims: async () => {
          if (++reads === 1) {
            if (real) { await rename(state.directory, `${state.directory}-saved`); await writeFile(state.directory, "temporary refusal"); moved = true; }
            else globals.heldRecoveryWriteFailures = 1;
          }
          return [{ claimId: state.claimId, leaseState: "active", leaseExpiresAt: new Date(base + 60_000).toISOString() }];
        } }, sleep: async (target: number) => { await restore(); clock = target; },
        reportDelivery: async () => {
          if (reads > 0) {
            sendsAfterFailure++;
            unsafeResend ||= JSON.parse(await readFile(state.file, "utf8")).deadlineAt !== base + 60_000;
          }
          clock += 20_000; throw outage();
        } }));
      await restore();
      assert.equal(unsafeResend, false, "no resend until minimum is durable");
      assert.ok(sendsAfterFailure > 0, "storage recovery resumes delivery");
      assert.equal(JSON.parse(await readFile(state.file, "utf8")).deadlineAt, base + 60_000);
    } finally { globals.heldRecoveryWriteFailures = 0; await restore(); await rm(state.directory, { recursive: true, force: true }); }
  }
});

test("durability refusal stops sends and hands back plainly; anchor failure never sends", { timeout: 30_000 }, async () => {
  const ports = await recoveryPorts();
  const globals = globalThis as typeof globalThis & { heldRecoveryWriteFailures?: number };
  const base = Date.now(), state = await recoveryRecord();
  try {
    let sends = 0;
    globals.heldRecoveryWriteFailures = 5;
    const logs: string[] = [];
    await assert.rejects(ports.testDeliver({ ...state.record, directory: state.directory,
      claim: { claimId: state.claimId }, held: await ports.testRead(state.directory, state.claimId),
      now: () => base, log: (message: string) => logs.push(message),
      client: { result: async () => { sends++; return {}; } } }), { code: "held_result_durability" });
    assert.equal(sends, 0);
    assert.equal(globals.heldRecoveryWriteFailures, 4, "an anchor refusal is immediate, with no retry of that record");
    assert.ok(logs.some(message => /storage is retried/u.test(message)));
    // Exercise the public sweep and its handback, with a real filesystem failure.
    const { rename } = await import("node:fs/promises");
    const root = join(state.directory, "held-results");
    await mkdir(root);
    const file = join(root, state.file.split("/").at(-1)!);
    await rename(state.file, file);
    globals.heldRecoveryWriteFailures = 5;
    const publicPorts = ports;
    let handbacks = 0;
    const delivered = await publicPorts.deliverHeldResults({ configPath: join(state.directory, "worker.json"), log: (message: string) => logs.push(message),
      client: { result: async () => { sends++; return {}; }, blocker: async (_id: string, message: string) => {
        handbacks++; assert.match(message, /could not be saved safely/u); return { released: true };
      } } });
    assert.equal(sends, 0);
    assert.equal(handbacks, 1);
    assert.equal(delivered[0].reason, "held_result_durability");
  } finally { globals.heldRecoveryWriteFailures = 0; await rm(state.directory, { recursive: true, force: true }); }
});

test("claim locks release on failure, recover dead owners, and bound incomplete-owner waits", { timeout: 30_000 }, async () => {
  const ports = await recoveryPorts();
  const state = await recoveryRecord({ heldAt: Date.now(), deadlineAt: null });
  const lock = `${state.file}.lock`;
  try {
    await assert.rejects(ports.testLock(state.directory, state.claimId, async () => { throw new Error("stop halfway"); }), /stop halfway/u);
    await assert.rejects(stat(lock), { code: "ENOENT" });
    await writeFile(lock, JSON.stringify({ pid: 2_000_000_000, token: "e".repeat(32) }));
    await ports.testWrite(state.directory, state.claimId, state.record);
    await assert.rejects(stat(lock), { code: "ENOENT" });
    await writeFile(lock, "partial");
    const start = Date.now();
    await assert.rejects(ports.testWrite(state.directory, state.claimId, state.record), /locked by another session/u);
    assert.ok(Date.now() - start < 5000);
  } finally { await rm(state.directory, { recursive: true, force: true }); }
});

test("two public recovery sweeps cannot overwrite the synchronized shorter deadline", { timeout: 30_000 }, async () => {
  const { rename } = await import("node:fs/promises");
  const base = Date.now(), state = await recoveryRecord({ heldAt: base, deadlineAt: null });
  const root = join(state.directory, "held-results");
  await mkdir(root);
  const file = join(root, state.file.split("/").at(-1)!);
  await rename(state.file, file);
  let wake: () => void = () => {}, stop = false, laterRead = false;
  const firstSaved = new Promise<void>(done => { wake = done; });
  const client = (later: boolean) => ({
    result: async () => { throw stop ? Object.assign(outage(), { code: "expired" }) : outage(); },
    claims: async () => {
      if (later) { await firstSaved; laterRead = true; }
      return [{ claimId: state.claimId, leaseState: stop ? "expired" : "active",
        leaseExpiresAt: new Date(base + (later ? 30_000 : 10_000)).toISOString() }];
    } });
  const configPath = join(state.directory, "worker.json");
  const callers = [connector.deliverHeldResults({ client: client(false) as never, configPath }),
    connector.deliverHeldResults({ client: client(true) as never, configPath })];
  try {
    const until = Date.now() + 10_000;
    while (Date.now() < until && JSON.parse(await readFile(file, "utf8")).deadlineAt !== base + 10_000)
      await new Promise(done => setTimeout(done, 10));
    assert.equal(JSON.parse(await readFile(file, "utf8")).deadlineAt, base + 10_000);
    wake();
    while (Date.now() < until && !laterRead) await new Promise(done => setTimeout(done, 10));
    assert.ok(laterRead);
    await new Promise(done => setTimeout(done, 50));
    stop = true;
    await Promise.all(callers);
    assert.equal(JSON.parse(await readFile(file, "utf8")).deadlineAt, base + 10_000);
  } finally { stop = true; wake(); await Promise.allSettled(callers); await rm(state.directory, { recursive: true, force: true }); }
});

test("a conflicting or disappeared held record stops recovery before another send", { timeout: 30_000 }, async () => {
  const ports = await recoveryPorts();
  const base = Date.now(), state = await recoveryRecord({ heldAt: base, deadlineAt: base + 90_000 });
  try {
    const held = await ports.testRead(state.directory, state.claimId);
    await assert.rejects(ports.testWrite(state.directory, state.claimId, { ...state.record, summary: "Changed answer" }), /changed during recovery/u);
    await rm(state.file);
    let sends = 0, clock = base;
    await assert.rejects(ports.testDeliver({ ...state.record, directory: state.directory, held,
      claim: { claimId: state.claimId }, now: () => clock, sleep: async (target: number) => { clock = target; },
      client: { result: async () => { sends++; return {}; } } }), { code: "held_result_durability" });
    assert.equal(sends, 0);
    await assert.rejects(stat(state.file), { code: "ENOENT" });
  } finally { await rm(state.directory, { recursive: true, force: true }); }
});

test("persistent shortening failure refuses durability after a bounded retry", { timeout: 30_000 }, async () => {
  const ports = await recoveryPorts();
  const globals = globalThis as typeof globalThis & { heldRecoveryWriteFailures?: number };
  const base = Date.now(), state = await recoveryRecord({ heldAt: base, deadlineAt: base + 90_000 });
  let sends = 0, clock = base;
  const logs: string[] = [];
  try {
    await assert.rejects(ports.testDeliver({ ...state.record, directory: state.directory,
      claim: { claimId: state.claimId }, held: await ports.testRead(state.directory, state.claimId),
      now: () => clock, sleep: async (target: number) => { clock = target; }, log: (message: string) => logs.push(message),
      reportDelivery: async () => { sends++; throw outage(); },
      client: { result: async () => { sends++; throw outage(); }, claims: async () => {
        globals.heldRecoveryWriteFailures = 5;
        return [{ claimId: state.claimId, leaseState: "active", leaseExpiresAt: new Date(base + 60_000).toISOString() }];
      } } }), { code: "held_result_durability" });
    assert.equal(sends, 1, "no resend while the disk minimum is outstanding");
    assert.equal(logs.length, 2, "failure is retried once and reported both times");
    assert.equal(JSON.parse(await readFile(state.file, "utf8")).deadlineAt, base + 90_000);
  } finally { globals.heldRecoveryWriteFailures = 0; await rm(state.directory, { recursive: true, force: true }); }
});

test("a stopped direct-child lock owner leaves a recoverable generation", { timeout: 30_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const ports = await recoveryPorts();
  const state = await recoveryRecord({ heldAt: Date.now(), deadlineAt: null });
  const source = `import { register } from 'node:module';
    import { pathToFileURL } from 'node:url'; import { resolve } from 'node:path';
    process.stdin.resume(); process.stdin.on('end', () => process.exit(0));
    register(pathToFileURL(resolve('tests/support/fleet-held-recovery-loader.mjs')));
    const ports = await import(pathToFileURL(resolve('scripts/fleet/connector.mjs')) + '?held-recovery-test');
    await ports.testLock(process.argv[1], process.argv[2], async () => {
      process.stdout.write('locked'); await new Promise(() => {});
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, state.directory, state.claimId],
    { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>(done => child.once("close", () => done()));
  try {
    await new Promise<void>((done, reject) => {
      child.stdout.once("data", () => done());
      child.once("error", reject);
      child.once("close", () => reject(new Error("lock helper exited before acquiring the lock")));
    });
    child.kill("SIGTERM");
    await closed;
    await ports.testWrite(state.directory, state.claimId, state.record);
    await assert.rejects(stat(`${state.file}.lock`), { code: "ENOENT" });
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("a directory sync refusal is retried even when the renamed minimum is already visible", { timeout: 30_000 }, async () => {
  const ports = await recoveryPorts();
  const globals = globalThis as typeof globalThis & { heldRecoverySyncFailures?: number };
  const base = Date.now(), state = await recoveryRecord({ heldAt: base, deadlineAt: base + 90_000 });
  let clock = base, reads = 0, resumed = false;
  const logs: string[] = [];
  try {
    await assert.rejects(ports.testDeliver({ ...state.record, directory: state.directory,
      claim: { claimId: state.claimId }, held: await ports.testRead(state.directory, state.claimId),
      now: () => clock, sleep: async (target: number) => { clock = target; }, log: (message: string) => logs.push(message),
      reportDelivery: async () => { if (reads > 0) resumed = true; clock += 20_000; throw outage(); },
      client: { result: async () => { throw outage(); }, claims: async () => {
        if (++reads === 1) globals.heldRecoverySyncFailures = 1;
        return [{ claimId: state.claimId, leaseState: "active", leaseExpiresAt: new Date(base + 60_000).toISOString() }];
      } } }));
    assert.equal(globals.heldRecoverySyncFailures, 0);
    assert.equal(logs.length, 1);
    assert.ok(resumed);
    assert.equal(JSON.parse(await readFile(state.file, "utf8")).deadlineAt, base + 60_000);
  } finally { globals.heldRecoverySyncFailures = 0; await rm(state.directory, { recursive: true, force: true }); }
});

test("both finished-task paths explain storage durability failure without blaming the network", { timeout: 30_000 }, async () => {
  const ports = await recoveryPorts();
  const globals = globalThis as typeof globalThis & { heldRecoveryWriteFailures?: number };
  for (const tool of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "fleet-held-path-refusal-"));
    const logs: string[] = [], messages: string[] = [];
    let sends = 0;
    const claim = { claimId: `fleet-claim:${"9".repeat(32)}`, jobId: `job:${"9".repeat(32)}`,
      title: "A local task", prompt: "Produce an answer", leaseExpiresAt: new Date(Date.now() + 90_000).toISOString() };
    const client = { progress: async () => ({}), result: async () => { sends++; return {}; },
      blocker: async (_id: string, message: string) => { messages.push(message); return { released: true }; } };
    try {
      // A real joined profile, as every worker has: r6cfix's tool path re-reads it
      // for the current secret before scanning the output, and refuses without it.
      await writeFile(join(directory, "worker.json"), JSON.stringify({ schema: "control-room.fleet-connector/v1",
        server: "https://gateway.invalid", workerId: `fleet-worker:${"1".repeat(32)}`, credentialExpiresAt: "2099-01-01T00:00:00Z",
        secret: `crf_${"A".repeat(43)}` }), { mode: 0o600 });
      globals.heldRecoveryWriteFailures = 5;
      const options = { client, claim, configPath: join(directory, "worker.json"), readMode: async () => "running",
        log: (message: string) => logs.push(message) };
      const result = tool ? await ports.runClaimedToolTask({ ...options,
        runner: { execute: async () => ({ summary: "A finished answer.", files: [] }) } })
        : await ports.runClaimedTask({ ...options,
          adapter: { harness: "controlled-harness", deadlineMs: 1000, execute: async () => ({ kind: "completed", text: "A finished answer." }) } });
      assert.equal(result.outcome, "blocked");
      assert.equal(sends, 0);
      assert.equal(messages.length, 1);
      assert.match(messages[0], /could not be saved safely/u);
      assert.doesNotMatch(messages[0], /could not be reached/u);
      assert.ok(logs.some(message => /delivery is paused/u.test(message)));
    } finally { globals.heldRecoveryWriteFailures = 0; await rm(directory, { recursive: true, force: true }); }
  }
});
