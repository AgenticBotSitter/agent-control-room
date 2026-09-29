// Fleet connector: one-command join, per-machine credentials, MCP tools and
// the owner review loop. These tests drive the real standalone connector
// against the real gateway HTTP handler and services over an in-process
// database with every migration applied. The same guards are exercised as the
// production logins in tests/fleet-connector-postgres.test.ts.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite, type DatabaseClient } from "../src/persistence/database";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1 } from "../src/fleet/v1";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, PROJECT_B, seedFleetTenant,
  seedProposedTask } from "./support/fleet-fixture";
// @ts-expect-error -- the connector is a dependency-free .mjs shipped to worker machines
import * as connector from "../scripts/fleet/connector.mjs";

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(options: { gatewayClock?: () => number } = {}) {
  const raw = new PGlite();
  for (const file of (await readdir("db/migrations")).filter(name => name.endsWith(".sql")).sort())
    await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
  const db: DatabaseClient = adaptPglite(raw);
  await seedFleetTenant((sql, params) => raw.query(sql, params));
  const gateway = new FleetGatewayStoreV1(db, { tenantId: FLEET_TENANT, ...(options.gatewayClock ? { clock: options.gatewayClock } : {}) });
  const owner = new FleetOwnerServiceV1(db, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
    afterDecision: () => gateway.reconcile() });
  const proposals = new WorkBatchServiceV1(new WorkBatchStoreV1(db, new Uint8Array(32).fill(3)));
  const handler = createFleetGatewayHandlerV1({ store: gateway, proposals,
    connectorScript: { body: "export {};\n", digest: `sha256:${"0".repeat(64)}` } });
  let reads = 0;
  const server: Server = createServer((request, response) => {
    // Count only when the handler starts reading the body.
    const iterate = request[Symbol.asyncIterator].bind(request);
    request[Symbol.asyncIterator] = () => { reads += 1; return iterate(); };
    void handler.handle(request, response);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = await mkdtemp(join(tmpdir(), "fleet-connector-"));
  return { raw, db, gateway, owner, origin, dir, server, bodyReads: () => reads,
    query: <T>(sql: string, params?: unknown[]) => raw.query<T>(sql, params).then(r => r.rows),
    async close() { await new Promise(done => server.close(done)); await raw.close(); await rm(dir, { recursive: true, force: true }); } };
}

async function joinWorker(f: Fixture, name: string, projectIds = [PROJECT_A], capabilities = ["writing"], maxConcurrent = 1) {
  const code = await f.owner.createEnrollmentCode(ownerIdentity(), { displayName: name, workerKind: "mcp-agent",
    projectIds, capabilities, maxConcurrent });
  const configPath = join(f.dir, `${name}.json`);
  const joined = await connector.join({ server: f.origin, code: code.code, configPath });
  const config = await connector.loadConfig(configPath);
  return { code, configPath, joined, config, client: connector.createClient(config) };
}

async function offer(f: Fixture, projectId: string, name: string, capability = "writing") {
  const task = await seedProposedTask(f.db, projectId, name);
  const offered = await f.owner.offerTask(ownerIdentity(), { projectId, jobId: task.jobId, capability });
  return { ...task, offerId: offered.offerId };
}

async function rawCall(f: Fixture, method: string, path: string, headers: Record<string, string>, body?: string) {
  const response = await fetch(`${f.origin}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  return { status: response.status, body: await response.json() as { ok: boolean; error?: string; result?: unknown } };
}

test("one-command join: a single-use code enrolls a machine whose secret never leaves it", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Laptop");
  assert.match(worker.joined.workerId, /^fleet-worker:[a-f0-9]{32}$/u);
  assert.deepEqual(worker.joined.projectIds, [PROJECT_A]);
  if (process.platform !== "win32") assert.equal((await stat(worker.configPath)).mode & 0o077, 0, "credential file is private");
  // Only the digest is stored; the secret itself is nowhere in the database.
  const dump = JSON.stringify(await f.query("SELECT * FROM fleet_worker_credentials"));
  assert.ok(!dump.includes(worker.config.secret));
  assert.ok(!JSON.stringify(await f.query("SELECT * FROM fleet_enrollment_codes")).includes(worker.code.code));
  const me = await worker.client.me();
  assert.equal(me.workerId, worker.joined.workerId);
  assert.equal(me.canApprove, false); assert.equal(me.canMerge, false);

  // Single use: the same code cannot enroll a second machine.
  await assert.rejects(connector.join({ server: f.origin, code: worker.code.code, configPath: join(f.dir, "again.json") }),
    /unauthenticated/u);
  // The canonical records: an active node, a proposal-only agent grant.
  const grants = await f.query<{ role_key: string; allowed_actions: string[]; project_ids: string[] }>(
    "SELECT role_key,allowed_actions,project_ids FROM control_role_grants WHERE identity_id LIKE 'identity:fleet:%'");
  assert.deepEqual(grants, [{ role_key: "work_batch_proposer", allowed_actions: ["work_batches.propose"], project_ids: [PROJECT_A] }]);
  const workers = await f.owner.listWorkers(ownerIdentity());
  assert.equal(workers.workers[0]!.status, "connected");
});

test("an expired or cancelled enrollment code is refused", async t => {
  let skew = 0;
  const f = await fixture({ gatewayClock: () => Date.now() + skew }); t.after(() => f.close());
  const code = await f.owner.createEnrollmentCode(ownerIdentity(), { displayName: "Late", workerKind: "codex",
    projectIds: [PROJECT_A], capabilities: ["code.change"] });
  skew = 11 * 60_000;
  await assert.rejects(connector.join({ server: f.origin, code: code.code, configPath: join(f.dir, "late.json") }), /unauthenticated/u);
  skew = 0;
  const cancelled = await f.owner.createEnrollmentCode(ownerIdentity(), { displayName: "Cancelled", workerKind: "codex",
    projectIds: [PROJECT_A], capabilities: ["code.change"] });
  assert.equal((await f.owner.cancelCode(ownerIdentity(), cancelled.codeId)).cancelled, true);
  await assert.rejects(connector.join({ server: f.origin, code: cancelled.code, configPath: join(f.dir, "c.json") }), /unauthenticated/u);
  // The database clock also refuses consumption after expiry, whatever the caller's clock says.
  const direct = await f.owner.createEnrollmentCode(ownerIdentity(), { displayName: "Direct", workerKind: "codex",
    projectIds: [PROJECT_A], capabilities: ["code.change"] });
  await f.raw.exec("ALTER TABLE fleet_enrollment_codes DISABLE TRIGGER fleet_enrollment_codes_guard");
  await f.raw.query(`UPDATE fleet_enrollment_codes SET created_at=now()-interval '20 minutes',
    expires_at=now()-interval '10 minutes' WHERE id=$1`, [direct.codeId]);
  await f.raw.exec("ALTER TABLE fleet_enrollment_codes ENABLE TRIGGER fleet_enrollment_codes_guard");
  await assert.rejects(f.raw.query(`UPDATE fleet_enrollment_codes SET state='consumed',
    consumed_at=created_at+interval '1 minute' WHERE id=$1`, [direct.codeId]), /consumption rejected/u);
});

test("codes cannot be widened: scope is fixed at creation and re-key copies it", async t => {
  const f = await fixture(); t.after(() => f.close());
  await assert.rejects(f.owner.createEnrollmentCode(ownerIdentity(), { displayName: "X", workerKind: "codex",
    projectIds: ["project:missing"], capabilities: ["code.change"] }), /invalid/u);
  await assert.rejects(f.owner.createEnrollmentCode(ownerIdentity(), { displayName: "X", workerKind: "root",
    projectIds: [PROJECT_A], capabilities: ["code.change"] }), /invalid/u);
  const worker = await joinWorker(f, "Scoped");
  const rekey = await f.owner.issueRekeyCode(ownerIdentity(), worker.joined.workerId);
  const rows = await f.query<{ project_ids: string[]; capabilities: string[] }>(
    "SELECT project_ids,capabilities FROM fleet_enrollment_codes WHERE id=$1", [rekey.codeId]);
  assert.deepEqual(rows[0], { project_ids: [PROJECT_A], capabilities: ["writing"] });
  // A direct attempt to issue a wider re-key code is refused by the database.
  await assert.rejects(f.raw.query(`INSERT INTO fleet_enrollment_codes(tenant_id,id,code_digest,purpose,worker_id,worker_kind,
    display_name,project_ids,capabilities,max_concurrent,created_by_identity_id,created_at,expires_at,state)
    VALUES($1,'fleet-code:${"b".repeat(32)}','sha256:${"c".repeat(64)}','rekey',$2,'mcp-agent','Scoped',$3,'{writing}',1,
      'identity:fleet-owner',now(),now()+interval '5 minutes','issued')`, [FLEET_TENANT, worker.joined.workerId,
    [PROJECT_A, PROJECT_B]]), /enrollment code rejected/u);
});

test("a stolen credential cannot act as another worker or reach another project", async t => {
  const f = await fixture(); t.after(() => f.close());
  const a = await joinWorker(f, "Alpha", [PROJECT_A]);
  const b = await joinWorker(f, "Beta", [PROJECT_B]);
  // A's secret presented as B is refused, with no hint which check failed.
  const posing = await rawCall(f, "GET", "/fleet/v1/me", { authorization: `Bearer ${a.config.secret}`,
    "x-control-room-worker": b.joined.workerId });
  assert.deepEqual([posing.status, posing.body.error], [401, "unauthenticated"]);
  const missing = await rawCall(f, "GET", "/fleet/v1/me", { authorization: `Bearer ${a.config.secret}` });
  assert.equal(missing.status, 401);
  // A cannot see or claim B's project work, and cannot touch B's claim.
  const betaTask = await offer(f, PROJECT_B, "beta-1");
  assert.deepEqual(await a.client.work(), []);
  await assert.rejects(a.client.claim(betaTask.offerId, "claim-key-000001"), /not_found/u);
  const bClaim = await b.client.claim(betaTask.offerId, "claim-key-000002");
  await assert.rejects(a.client.progress(bClaim.claimId, "hijack", "progress-key-0001"), /not_found/u);
  await assert.rejects(a.client.result(bClaim.claimId, "stolen", [], "result-key-00001"), /not_found/u);
  assert.equal((await a.client.claims()).length, 0);
  // Proposals are confined to the worker's own projects too.
  await assert.rejects(a.client.propose(PROJECT_B, { schema: "x" }, "propose-key-0001"), /not_found/u);
});

test("a revoked worker is refused at once and its lease cannot be used", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Revokable");
  const task = await offer(f, PROJECT_A, "revoke-1");
  const claim = await worker.client.claim(task.offerId, "claim-key-revoke1");
  await f.owner.revokeWorker(ownerIdentity(), worker.joined.workerId);
  await assert.rejects(worker.client.me(), /unauthenticated/u);
  await assert.rejects(worker.client.progress(claim.claimId, "still here", "progress-key-rv1"), /unauthenticated/u);
  // Even a direct write under the live claim is refused by the database guard.
  await assert.rejects(f.raw.query(`INSERT INTO fleet_worker_events(tenant_id,event_id,claim_id,worker_id,kind,message,
    idempotency_key,occurred_at) VALUES($1,'fleet-event:${"d".repeat(32)}',$2,$3,'progress','x','direct-key-00001',now())`,
  [FLEET_TENANT, claim.claimId, worker.joined.workerId]), /worker event rejected/u);
  // Reconcile retires the canonical identity, grant and node.
  const identity = await f.query<{ state: string }>("SELECT state FROM control_identities WHERE id LIKE 'identity:fleet:%'");
  assert.deepEqual(identity, [{ state: "revoked" }]);
  const node = await f.query<{ state: string }>("SELECT state FROM control_nodes WHERE id LIKE 'node:fleet:%'");
  assert.deepEqual(node, [{ state: "revoked" }]);
  await assert.rejects(f.owner.issueRekeyCode(ownerIdentity(), worker.joined.workerId), /conflict/u);
});

test("revoking the worker row alone is enough: its still-active credential is refused everywhere", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Half revoked");
  const task = await offer(f, PROJECT_A, "half-1");
  const claim = await worker.client.claim(task.offerId, "claim-key-half001");
  // Only the owner-side worker row changes; the credential row stays active.
  await f.raw.query(`UPDATE fleet_workers SET state='revoked',revoked_at=now(),revoked_by_identity_id='identity:fleet-owner'`);
  assert.equal((await f.query("SELECT state FROM fleet_worker_credentials"))[0]!.state, "active");
  await assert.rejects(worker.client.me(), /unauthenticated/u);
  await assert.rejects(f.raw.query(`INSERT INTO fleet_worker_events(tenant_id,event_id,claim_id,worker_id,kind,message,
    idempotency_key,occurred_at) VALUES($1,'fleet-event:${"9".repeat(32)}',$2,$3,'progress','x','direct-key-half1',now())`,
  [FLEET_TENANT, claim.claimId, worker.joined.workerId]), /worker event rejected/u);
});

test("a worker cannot claim work that needs a capability it was not given", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Writer only", [PROJECT_A], ["writing"]);
  const task = await offer(f, PROJECT_A, "code-1", "code.change");
  assert.deepEqual(await worker.client.work(), []);
  await assert.rejects(worker.client.claim(task.offerId, "claim-key-capab01"), /not_found/u);
});

test("credential rotation retires the old secret and owner re-key replaces it", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Rotating");
  const oldSecret = worker.config.secret;
  await connector.rotate({ configPath: worker.configPath });
  const rotated = await connector.loadConfig(worker.configPath);
  assert.notEqual(rotated.secret, oldSecret);
  assert.equal(rotated.pendingSecret, undefined);
  await connector.createClient(rotated).me();
  await assert.rejects(connector.createClient({ ...rotated, secret: oldSecret }).me(), /unauthenticated/u);
  // Owner re-key: a fresh machine credential, the previous one revoked.
  const rekey = await f.owner.issueRekeyCode(ownerIdentity(), worker.joined.workerId);
  const second = join(f.dir, "rekeyed.json");
  const rejoined = await connector.join({ server: f.origin, code: rekey.code, configPath: second });
  assert.equal(rejoined.workerId, worker.joined.workerId);
  await connector.createClient(await connector.loadConfig(second)).me();
  await assert.rejects(connector.createClient(rotated).me(), /unauthenticated/u);
});

test("a claim without a live lease is refused, and no claim can exist without its canonical lease", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Leaseless");
  const task = await offer(f, PROJECT_A, "lease-1");
  await assert.rejects(worker.client.progress(`fleet-claim:${"e".repeat(32)}`, "no claim", "progress-key-nl1"), /not_found/u);
  // A direct claim row with no canonical attempt and lease fails at commit.
  const workerRow = (await f.query<{ node_id: string }>("SELECT node_id FROM fleet_workers"))[0]!;
  await assert.rejects(f.raw.transaction(async tx => {
    await tx.query(`UPDATE control_jobs SET state='ready',payload=jsonb_set(payload,'{state}','"ready"') WHERE id=$1`, [task.jobId]);
    await tx.query(`INSERT INTO fleet_claims(tenant_id,claim_id,offer_id,worker_id,node_id,project_id,job_id,attempt_id,
      lease_id,idempotency_key,claimed_at) VALUES($1,'fleet-claim:${"f".repeat(32)}',$2,$3,$4,$5,$6,'attempt:none',
      'lease:none','direct-claim-0001',now())`, [FLEET_TENANT, task.offerId, worker.joined.workerId, workerRow.node_id,
      PROJECT_A, task.jobId]);
  }), /without its canonical lease/u);
  // An elapsed lease: progress and results are refused, and reconcile hands the task back.
  const claim = await worker.client.claim(task.offerId, "claim-key-lease01");
  await f.raw.query(`UPDATE control_leases SET expires_at=acquired_at+interval '1 millisecond',
    payload=jsonb_set(payload,'{expiresAt}',to_jsonb((acquired_at+interval '1 millisecond')::timestamptz)) WHERE id LIKE 'lease:fleet:%'`);
  await assert.rejects(worker.client.progress(claim.claimId, "late", "progress-key-late"), /expired/u);
  await assert.rejects(worker.client.result(claim.claimId, "late result", [], "result-key-late01"), /expired/u);
  const applied = await f.gateway.reconcile();
  assert.equal(applied.expiredLeases, 1);
  const job = await f.query<{ state: string }>("SELECT state FROM control_jobs WHERE id=$1", [task.jobId]);
  assert.deepEqual(job, [{ state: "ready" }]);
  assert.equal((await worker.client.work()).length, 1, "the task is claimable again as a new attempt");
});

test("oversized results and files are refused before anything is stored", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Big");
  const task = await offer(f, PROJECT_A, "big-1");
  const claim = await worker.client.claim(task.offerId, "claim-key-big0001");
  await assert.rejects(worker.client.result(claim.claimId, "x".repeat(65_537), [], "result-key-big001"), /too_large/u);
  const big = { name: "big.txt", mediaType: "text/plain", contentBase64: Buffer.alloc(262_145, 97).toString("base64") };
  await assert.rejects(worker.client.result(claim.claimId, "ok", [big], "result-key-big002"), /too_large/u);
  // Five files under the per-file limit that together exceed the 1 MiB total.
  const quarter = (n: number) => ({ name: `f${n}.txt`, mediaType: "text/plain", contentBase64: Buffer.alloc(220_000, 97).toString("base64") });
  await assert.rejects(worker.client.result(claim.claimId, "ok", [1, 2, 3, 4, 5].map(quarter), "result-key-big003"), /too_large/u);
  const nine = Array.from({ length: 9 }, (_, n) => ({ name: `s${n}.txt`, mediaType: "text/plain", contentBase64: "YQ==" }));
  await assert.rejects(worker.client.result(claim.claimId, "ok", nine, "result-key-big004"), /too_large/u);
  const evil = { name: "../escape.txt", mediaType: "text/plain", contentBase64: "YQ==" };
  await assert.rejects(worker.client.result(claim.claimId, "ok", [evil], "result-key-big005"), /invalid/u);
  const html = { name: "page.html", mediaType: "text/html", contentBase64: "YQ==" };
  await assert.rejects(worker.client.result(claim.claimId, "ok", [html], "result-key-big006"), /invalid/u);
  // A declared body over the limit is refused before a byte is read.
  const before = f.bodyReads();
  const status = await new Promise<number>((done, fail) => {
    const request = httpRequest(`${f.origin}/fleet/v1/claims/${claim.claimId}/result`, { method: "POST", headers: {
      authorization: `Bearer ${worker.config.secret}`, "x-control-room-worker": worker.joined.workerId,
      "content-type": "application/json", "content-length": "5000000" } }, response => { response.resume(); done(response.statusCode!); });
    request.on("error", fail);
    request.write("{");
  });
  assert.equal(status, 413);
  assert.equal(f.bodyReads() - before, 0);
  assert.deepEqual(await f.query("SELECT result_id FROM fleet_results"), []);
  // The schema holds the same limits against any direct write.
  await assert.rejects(f.raw.query(`INSERT INTO fleet_results(tenant_id,result_id,claim_id,worker_id,project_id,job_id,
    attempt_id,summary,file_count,total_file_bytes,content_digest,idempotency_key,submitted_at)
    SELECT $1,'fleet-result:${"a".repeat(32)}',claim_id,worker_id,project_id,job_id,attempt_id,$2,0,0,
      'sha256:${"0".repeat(64)}','direct-key-big01',now() FROM fleet_claims WHERE claim_id=$3`,
  [FLEET_TENANT, "y".repeat(65_537), claim.claimId]), /check constraint/u);
});

test("unauthenticated requests are refused before the body is read", async t => {
  const f = await fixture(); t.after(() => f.close());
  const before = f.bodyReads();
  const response = await rawCall(f, "POST", `/fleet/v1/claims/fleet-claim:${"1".repeat(32)}/result`, {
    authorization: `Bearer crf_${"A".repeat(43)}`, "x-control-room-worker": `fleet-worker:${"2".repeat(32)}`,
    "content-type": "application/json" }, JSON.stringify({ summary: "x".repeat(100_000), idempotencyKey: "result-key-unauth" }));
  assert.equal(response.status, 401);
  assert.equal(f.bodyReads() - before, 0);
});

test("there is no route to approve, accept, merge, assign or widen permissions", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Limited");
  const auth = { authorization: `Bearer ${worker.config.secret}`, "x-control-room-worker": worker.joined.workerId,
    "content-type": "application/json" };
  for (const path of ["/fleet/v1/approve", "/fleet/v1/results/x/accept", `/fleet/v1/claims/fleet-claim:${"1".repeat(32)}/accept`,
    "/fleet/v1/merge", "/fleet/v1/grants", "/fleet/v1/assign", "/fleet/v1/reviews", "/api/v1/fleet/workers"]) {
    const response = await rawCall(f, "POST", path, auth, "{}");
    assert.equal(response.status, 404, path);
  }
  // The worker's identity holds no grant to review, and the table refuses a non-owner.
  const result = await f.raw.query(`INSERT INTO fleet_result_reviews(tenant_id,review_id,result_id,decision,reviewed_by_identity_id,
    reviewed_at) SELECT $1,'fleet-review:${"3".repeat(32)}',$2,'accepted',identity_id,now() FROM fleet_workers`,
  [FLEET_TENANT, `fleet-result:${"4".repeat(32)}`]).catch(error => error);
  assert.ok(result instanceof Error);
});

test("a proposal is recorded for the owner and never starts work", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Proposer");
  const jobsBefore = await f.query("SELECT id FROM control_jobs");
  const proposal = { schema: "control-room.work-batch-proposal/v1", projectId: PROJECT_A,
    tasks: [{ localId: "build", title: "Build", instructions: "Write the bounded change.", requiredCapability: "code.change",
      role: "builder", requestedWorkerKind: "worker:code", requestedModelKey: "model:any",
      acceptanceCriteria: "Checks pass.", acceptanceTests: "Run the focused tests." }], edges: [] };
  const result = await worker.client.propose(PROJECT_A, proposal, "propose-key-00001");
  assert.equal(result.state, "proposed");
  assert.equal(result.startsWork, false);
  assert.equal(result.grantsExecutionAuthority, false);
  assert.deepEqual(await f.query("SELECT id FROM control_jobs"), jobsBefore, "no task was created");
  assert.deepEqual(await f.query("SELECT id FROM control_leases"), []);
  assert.deepEqual(await f.query("SELECT offer_id FROM fleet_work_offers"), [], "no offer was opened");
});

test("end to end: enroll, claim, progress, submit, owner asks for changes, resubmit, owner accepts", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Remote writer");
  const task = await offer(f, PROJECT_A, "e2e-1");
  const listed = await worker.client.work();
  assert.deepEqual(listed.map((item: { jobId: string }) => item.jobId), [task.jobId]);
  const claim = await worker.client.claim(task.offerId, "claim-key-e2e0001");
  assert.equal(claim.taskState, "leased");
  assert.equal(claim.title, "Task e2e-1");
  // Exact retry returns the same claim; the canonical lease path made one lease.
  const replay = await worker.client.claim(task.offerId, "claim-key-e2e0001");
  assert.equal(replay.claimId, claim.claimId); assert.equal(replay.replayed, true);
  assert.equal((await f.query("SELECT id FROM control_leases")).length, 1);
  // A second worker cannot claim the same task while it is held.
  const other = await joinWorker(f, "Second writer");
  await assert.rejects(other.client.claim(task.offerId, "claim-key-e2e0002"), /conflict/u);

  const progress = await worker.client.progress(claim.claimId, "Drafting the note.", "progress-key-e2e1");
  assert.equal(progress.replayed, false);
  assert.equal((await worker.client.progress(claim.claimId, "Drafting the note.", "progress-key-e2e1")).replayed, true);
  const file = { name: "note.md", mediaType: "text/markdown", contentBase64: Buffer.from("# Note\n").toString("base64") };
  const submitted = await worker.client.result(claim.claimId, "First draft.", [file], "result-key-e2e001");
  assert.equal(submitted.taskState, "waiting_approval");
  assert.equal(submitted.accepted, false);
  assert.equal((await worker.client.result(claim.claimId, "First draft.", [file], "result-key-e2e001")).replayed, true);
  await assert.rejects(worker.client.result(claim.claimId, "Changed draft.", [], "result-key-e2e001"), /conflict/u);

  const awaiting = await f.owner.listResults(ownerIdentity(), { awaitingOnly: true });
  assert.equal(awaiting.length, 1);
  assert.equal(awaiting[0]!.workerName, "Remote writer");
  const files = await f.owner.listResultFiles(ownerIdentity(), awaiting[0]!.resultId);
  assert.deepEqual(files.map(value => value.fileName), ["note.md"]);
  await assert.rejects(f.owner.review(ownerIdentity(), { resultId: awaiting[0]!.resultId, decision: "revision_requested" }), /invalid/u);
  // The worker's own identity can never record a review of its result.
  await assert.rejects(f.raw.query(`INSERT INTO fleet_result_reviews(tenant_id,review_id,result_id,decision,
    reviewed_by_identity_id,reviewed_at) SELECT $1,'fleet-review:${"8".repeat(32)}',$2,'accepted',identity_id,now()
    FROM fleet_workers WHERE worker_id=$3`, [FLEET_TENANT, awaiting[0]!.resultId, worker.joined.workerId]), /review rejected/u);
  await f.owner.review(ownerIdentity(), { resultId: awaiting[0]!.resultId, decision: "revision_requested",
    note: "Please add a summary line." });
  const mine = await worker.client.claims();
  assert.equal(mine[0].ownerDecision, "revision_requested");
  assert.equal(mine[0].ownerNote, "Please add a summary line.");
  assert.deepEqual(await f.query("SELECT state FROM control_jobs WHERE id=$1", [task.jobId]), [{ state: "ready" }]);

  const second = await worker.client.claim(task.offerId, "claim-key-e2e0003");
  assert.notEqual(second.claimId, claim.claimId);
  const final = await worker.client.result(second.claimId, "Second draft with a summary line.", [file], "result-key-e2e002");
  const pending = await f.owner.listResults(ownerIdentity(), { awaitingOnly: true });
  assert.equal(pending[0]!.resultId, final.resultId);
  await f.owner.review(ownerIdentity(), { resultId: final.resultId, decision: "accepted" });
  assert.deepEqual(await f.query("SELECT state FROM control_jobs WHERE id=$1", [task.jobId]), [{ state: "succeeded" }]);
  assert.deepEqual(await f.query("SELECT state,close_reason FROM fleet_work_offers"), [{ state: "closed", close_reason: "accepted" }]);
  const attempts = await f.query<{ state: string }>("SELECT state FROM control_attempts ORDER BY attempt_number");
  assert.deepEqual(attempts.map(row => row.state), ["failed", "succeeded"]);
  const audit = await f.query<{ action: string }>("SELECT action FROM audit_events WHERE action LIKE 'fleet.%'");
  for (const action of ["fleet.worker.enrolled", "fleet.task.offered", "fleet.task.claimed", "fleet.result.submitted",
    "fleet.result.reviewed", "fleet.review.applied"]) assert.ok(audit.some(row => row.action === action), action);
  assert.deepEqual(await worker.client.work(), []);
});

test("a blocker is recorded, and release hands the task back without marking it done", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Blocked");
  const task = await offer(f, PROJECT_A, "blocked-1");
  const claim = await worker.client.claim(task.offerId, "claim-key-block01");
  await worker.client.progress(claim.claimId, "Started.", "progress-key-blk1");
  const blocked = await worker.client.blocker(claim.claimId, "The source file is missing.", "blocker-key-blk01", true);
  assert.equal(blocked.released, true);
  assert.deepEqual(await f.query("SELECT state FROM control_jobs WHERE id=$1", [task.jobId]), [{ state: "ready" }]);
  assert.deepEqual(await f.query<{ state: string }>("SELECT state FROM control_attempts"), [{ state: "failed" }]);
  assert.equal((await worker.client.work()).length, 1);
});

test("capacity: a worker cannot hold more live claims than the owner allowed", async t => {
  const f = await fixture(); t.after(() => f.close());
  // Two projects, so the whole-project file-area lease of one task does not
  // collide with the other: only the capacity limit can refuse.
  const worker = await joinWorker(f, "Single", [PROJECT_A, PROJECT_B]);
  const one = await offer(f, PROJECT_A, "cap-1"), two = await offer(f, PROJECT_B, "cap-2");
  await worker.client.claim(one.offerId, "claim-key-cap0001");
  await assert.rejects(worker.client.claim(two.offerId, "claim-key-cap0002"), /conflict/u);
  const wider = await joinWorker(f, "Double", [PROJECT_A, PROJECT_B], ["writing"], 2);
  const three = await offer(f, PROJECT_B, "cap-3");
  await wider.client.claim(three.offerId, "claim-key-cap0003");
});

test("two tasks in one project with no declared file areas cannot be held at once", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "Pair", [PROJECT_A], ["writing"], 2);
  const one = await offer(f, PROJECT_A, "scope-1"), two = await offer(f, PROJECT_A, "scope-2");
  await worker.client.claim(one.offerId, "claim-key-scope01");
  await assert.rejects(worker.client.claim(two.offerId, "claim-key-scope02"), /conflict/u);
  assert.deepEqual(await f.query("SELECT claim_id FROM fleet_claims WHERE idempotency_key='claim-key-scope02'"), []);
});

test("MCP server: lists only bounded tools, claims through the gateway, and keeps files inside the workspace", async t => {
  const f = await fixture(); t.after(() => f.close());
  const worker = await joinWorker(f, "MCP agent");
  const task = await offer(f, PROJECT_A, "mcp-1");
  const workspace = join(f.dir, "workspace"); await mkdir(workspace);
  await writeFile(join(workspace, "answer.md"), "# Answer\n");
  await writeFile(join(f.dir, "secret.txt"), "outside");
  await symlink(join(f.dir, "secret.txt"), join(workspace, "link.txt"));
  const input = new PassThrough(), output = new PassThrough();
  const replies: Array<{ id: number; result?: Record<string, unknown>; error?: unknown }> = [];
  let buffer = "";
  output.on("data", chunk => { buffer += chunk; let index;
    while ((index = buffer.indexOf("\n")) >= 0) { replies.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); } });
  const serving = connector.serveMcp({ configPath: worker.configPath, input, output, workspaceRoot: workspace });
  let id = 0;
  const call = async (method: string, params?: unknown) => {
    const mine = ++id;
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, ...(params ? { params } : {}) })}\n`);
    for (let i = 0; i < 400 && !replies.some(r => r.id === mine); i += 1) await new Promise(r => setTimeout(r, 10));
    return replies.find(r => r.id === mine)!;
  };
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal((init.result!.serverInfo as { name: string }).name, "control-room");
  const tools = (await call("tools/list")).result!.tools as Array<{ name: string }>;
  const names = tools.map(tool => tool.name);
  assert.deepEqual(names.sort(), ["control_room_claim_task", "control_room_list_work", "control_room_my_claims",
    "control_room_post_progress", "control_room_propose_work", "control_room_report_blocker", "control_room_submit_result",
    "control_room_whoami"]);
  assert.ok(!names.some(name => /approve|accept|merge|grant|permission|review/u.test(name)));
  const text = (reply: { result?: Record<string, unknown> }) => JSON.parse((reply.result!.content as Array<{ text: string }>)[0]!.text);
  const listed = text(await call("tools/call", { name: "control_room_list_work", arguments: {} }));
  assert.equal(listed[0].offerId, task.offerId);
  const claim = text(await call("tools/call", { name: "control_room_claim_task", arguments: { offerId: task.offerId } }));
  const again = text(await call("tools/call", { name: "control_room_claim_task", arguments: { offerId: task.offerId } }));
  assert.equal(again.claimId, claim.claimId, "identical retries are idempotent");
  const escape = await call("tools/call", { name: "control_room_submit_result",
    arguments: { claimId: claim.claimId, summary: "done", files: ["link.txt"] } });
  assert.equal(escape.result!.isError, true);
  const traversal = await call("tools/call", { name: "control_room_submit_result",
    arguments: { claimId: claim.claimId, summary: "done", files: ["../secret.txt"] } });
  assert.equal(traversal.result!.isError, true);
  const extra = await call("tools/call", { name: "control_room_claim_task", arguments: { offerId: task.offerId, approve: true } });
  assert.equal(extra.result!.isError, true);
  const done = text(await call("tools/call", { name: "control_room_submit_result",
    arguments: { claimId: claim.claimId, summary: "Answer attached.", files: ["answer.md"] } }));
  assert.equal(done.taskState, "waiting_approval");
  const unknown = await call("tools/call", { name: "control_room_accept_result", arguments: {} });
  assert.ok(unknown.error);
  input.end(); await serving;
});

test("the connector refuses insecure servers and loosely protected credential files", async t => {
  assert.throws(() => connector.checkServer("http://control.example"), /https/u);
  assert.throws(() => connector.checkServer("https://user:pw@control.example"), /server address/u);
  assert.equal(connector.checkServer("http://100.100.1.2:8443"), "http://100.100.1.2:8443");
  assert.equal(connector.checkServer("https://control.example/"), "https://control.example");
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "fleet-perm-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "c.json");
  await writeFile(path, JSON.stringify({ schema: "control-room.fleet-connector/v1", server: "https://control.example",
    workerId: `fleet-worker:${"a".repeat(32)}`, secret: `crf_${"A".repeat(43)}` }), { mode: 0o644 });
  await assert.rejects(connector.loadConfig(path), /readable by other users/u);
});
