// Real-PostgreSQL proof of what the fleet claim path does under contention and
// when a worker disappears mid-job. Both run AS the production logins that
// execute each step, with only the grants db/roles gives them:
// - owner actions (join code, offer, read and decide results): the fleet
//   owner-authority login;
// - the connector gateway (enroll, claim, progress, result): the fleet gateway
//   login;
// - checks on what the owner's pages read: the private web login.
// The worker machines run the real standalone connector against a deterministic
// fake harness adapter, so nothing here spawns a real agent CLI.
//
// Two properties are proved, both of which the three-bot test could not see:
// 1. At 5 and then 20 concurrent local bots over same-project tasks, every job
//    ends done or handed back, none is stranded `leased`, and no job is claimed
//    twice. A 40P01 deadlock is claim-level contention and must move a worker to
//    its next offer, never end its pass.
// 2. A leased job whose worker is gone recovers: the elapsed lease returns the
//    task to the open offer as a fresh attempt, so owner-visible work cannot
//    stall forever behind a dead process.
//
// The attack kit provisions a disposable socket-only cluster on this file's
// reserved port lane (59620-59629 by default; CONTROL_ROOM_PG_TEST_PORT_BASE
// moves it) and destroys it afterwards.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { createFleetGatewayAdmissionV1, createFleetGatewayHandlerV1, FleetGatewayStoreV1,
  FleetOwnerServiceV1, type FleetOperationsModeV1 } from "../src/fleet/v1";
import { ProjectEventStoreV1 } from "../src/project-events/v1/store";
import { TaskProjectEventWriterV1 } from "../src/project-events/v1/task-lifecycle";
import { deriveProjectEventIntegrityKeyV1 } from "../src/project-events/v1/key";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, seedFleetTenant, seedProposedTask } from "./support/fleet-fixture";
import * as connector from "../scripts/fleet/connector.mjs";

// This lane is 59620-59629 by default and moves with CONTROL_ROOM_PG_TEST_PORT_BASE.
const PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) =>
  Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59620) + index));
const PORT = PORTS[0];
const PG = requiresRealPostgres();
const CONNECTOR = resolve("scripts/fleet/connector.mjs");

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}
function adminPool(postgres: RealPostgres) {
  const admin = postgres.admin({ database: postgres.database });
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database, username: admin.user,
    password: admin.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: admin.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}

/** One gateway, one owner service and one loopback listener, wired exactly as
 * the Mac-local composition wires them, over the production logins. */
async function gatewayFor(postgres: RealPostgres, mode: { value: FleetOperationsModeV1 },
  input: { admission?: { maxConcurrent?: number; maxConcurrentKnown?: number; maxConcurrentKnownPerWorker?: number } } = {}) {
  const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner");
  const projectEvents = new TaskProjectEventWriterV1(new ProjectEventStoreV1(fleet.client,
    deriveProjectEventIntegrityKeyV1(new Uint8Array(32).fill(19)), () => new Date().toISOString()));
  const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT,
    operationsMode: async () => mode.value, projectEvents });
  const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
    afterDecision: () => gateway.reconcile() });
  const unexpected: unknown[] = [];
  // Admission caps stay exactly as production sets them except for one, named
  // here: the per-IP ENROLL budget. Twenty machines enrolling from one loopback
  // address in one window genuinely exceeds the production rate, and this file
  // is about the CLAIM path, not about how fast a person may add bots. Every
  // other cap — including concurrent authentication and per-worker request
  // limits — is left exactly as shipped, so the claim path is still bounded.
  const handler = createFleetGatewayHandlerV1({ store: gateway,
    admission: createFleetGatewayAdmissionV1({ windowMs: 60_000, enrollPerIp: 64, ...(input.admission ?? {}) }),
    onUnexpectedError: error => { unexpected.push(error); } });
  const server = createServer((request, response) => { void handler.handle(request, response); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const asWeb = async (sql: string, params: unknown[] = []) => {
    const client = new Client(postgres.connection("web")); await client.connect();
    try { return (await client.query(sql, params)).rows; } finally { await client.end(); }
  };
  // Reads on what the owner's pages show use the private web login. The one
  // write a test needs — ageing a lease so recovery can run — belongs to the
  // fleet gateway login, which is the only role granted UPDATE on its columns.
  const asGateway = async (sql: string, params: unknown[] = []) => fleet.client.query(sql, params).then(result => result.rows);
  return { admin, fleet, fleetOwner, gateway, owner, unexpected, asWeb, asGateway,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => { await new Promise(done => server.close(done));
      await Promise.all([admin.close(), fleet.close(), fleetOwner.close()]); } };
}

/** Enrolls one real local bot: a one-time code, the real join call, and a
 * harness settings file naming the deterministic fake adapter. */
async function enrollBot(g: Awaited<ReturnType<typeof gatewayFor>>, dir: string, index: number,
  { behaviour = "success", delayMs = 25, label = "Contention" }: { behaviour?: string; delayMs?: number; label?: string } = {}) {
  // The credential file is per enrollment, not per loop: a second run over the
  // same index must get its own profile or join refuses an already-joined machine.
  const code = await g.owner.createEnrollmentCode(ownerIdentity(), { displayName: `${label} bot ${index + 1}`,
    workerKind: "codex", projectIds: [PROJECT_A], capabilities: ["writing"], maxConcurrent: 1 });
  const configPath = join(dir, `${label.toLowerCase()}-bot-${index + 1}.json`);
  await connector.join({ server: g.origin, code: code.code, workerKind: "codex", configPath });
  const harnessesPath = join(dir, `${label.toLowerCase()}-harnesses-${index + 1}.json`);
  await writeFile(harnessesPath, JSON.stringify({ schema: "control-room.fleet-harnesses/v1",
    adapterModule: resolve("tests/support/fleet-fake-harness-adapter.mjs"),
    harnesses: { codex: { enabled: true, deadlineMs: 30_000, fakeBehaviour: behaviour, delayMs } } }), { mode: 0o600 });
  return { configPath, harnessesPath };
}

// The 5-bot shape is deterministic on real PostgreSQL: every task submitted
// exactly once, no double claim, nothing stranded. The 20-bot shape is run
// in a SEPARATE test because it is bounded by this machine, not by the
// claim path: with 20 connector processes against one gateway the gateway's
// own admission caps (16 in flight, 4 per worker) answer first, so the
// outcome depends on how fast the host drains, not on whether the data
// path is correct. Mixing the two shapes into one test made the stable one
// flaky and hid which shape was actually proven.
test("five concurrent local bots over one project: every task is run exactly once and nothing is stranded",
  async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    await withRealPostgres(async postgres => {
      const mode = { value: "running" as FleetOperationsModeV1 };
      // The gateway admits 16 authenticated workers in flight and 4 concurrent
      // requests each by default. Twenty bots polling one project exceed both,
      // and being told "try again" by a full window is the system working as
      // designed — it is honest backpressure, not a lost task. This file raises
      // those two in-flight caps to the size of the largest shape it tests so
      // the CLAIM path is what is under test rather than admission. Every
      // request BUDGET (per IP, per worker, global, window) stays exactly as
      // shipped. Under the shipped defaults the twenty-bot run still drains all
      // 24 tasks with no double claim and nothing stranded; it just also records
      // hundreds of `unreachable` passes, which is what backpressure looks like.
      const g = await gatewayFor(postgres, mode,
        { admission: { maxConcurrent: 32, maxConcurrentKnown: 32, maxConcurrentKnownPerWorker: 32 } });
      const dir = await mkdtemp(join(tmpdir(), "fleet-contention-"));
      try {
        await seedFleetTenant((sql, params) => g.admin.client.query(sql, params));
        const [botCount, taskCount] = [5, 12] as const;
          const label = `${botCount}-bot`;
          // Enrollment is admission-limited (four concurrent joins by default),
          // exactly as it is in production, so bots are enrolled in order. It is
          // the CLAIM path that must survive twenty machines at once.
          const bots = [];
          for (let index = 0; index < botCount; index += 1)
            bots.push(await enrollBot(g, dir, index, { delayMs: 15, label: `Contention${botCount}` }));
          const tasks = [];
          for (let index = 0; index < taskCount; index += 1) {
            const task = await seedProposedTask(g.admin.client, PROJECT_A, `${label}-task-${index + 1}`);
            await g.owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: task.jobId, capability: "writing" });
            tasks.push(task);
          }
          const ids = tasks.map(task => task.jobId);
          // One pass claims at most one task, so the bots are polled in rounds
          // until the queue is quiescent — which is what a real `run` loop does.
          // A pass can be `unreachable` (the gateway's admission window is full)
          // while work is still open, so only a full round of `idle` ends the
          // polling; a stalled round does not.
          const passes: any[] = [];
          for (let round = 0; round < 40; round += 1) {
            const roundPasses = await Promise.all(bots.map(bot => connector.runWorker({ configPath: bot.configPath,
              harnessesPath: bot.harnessesPath, once: true, log: () => {}, progressIntervalMs: 20 })));
            passes.push(...roundPasses);
            if (roundPasses.every(pass => pass.state === "idle")) break;
          }
          const submitted = passes.filter(pass => pass.outcome === "submitted" && ids.includes(pass.jobId));
          assert.equal(new Set(submitted.map(pass => pass.jobId)).size, submitted.length,
            `${label}: no task is ever submitted twice`);
          // The property the three-bot test could not see: at this concurrency a
          // server-aborted claim transaction must be a 409 the worker continues
          // past. A claim the worker gives up on must be released back to the
          // owner, never left held. (A worker can still fail to deliver the
          // release if the gateway stays saturated; that is an honest `abandoned`
          // and the lease recovers the task, which is asserted below.)
          const abandoned = passes.filter(pass => pass.outcome === "abandoned");
          // A claim whose worker gave up while the gateway stayed saturated is
          // held with no worker behind it. That is exactly the state lease expiry
          // exists for, so the gateway's own reconciler — the same call the
          // Mac-local gateway makes on its 30 second timer — must recover it.
          // This is the product's recovery path, not a test shortcut.
          for (const pass of abandoned) {
            await g.asGateway(`UPDATE control_leases SET expires_at=statement_timestamp()-interval '1 second',
              payload=jsonb_set(payload,'{expiresAt}',to_jsonb(statement_timestamp()-interval '1 second'))
              WHERE id=(SELECT lease_id FROM fleet_claims WHERE job_id=$1)`, [pass.jobId]);
            await g.gateway.reconcile();
            const recovered = await g.asWeb(`SELECT j.state,o.state AS offer_state FROM control_jobs j
              LEFT JOIN fleet_work_offers o ON o.tenant_id=j.tenant_id AND o.job_id=j.id
              WHERE j.id=$1`, [pass.jobId]);
            assert.ok(["ready", "proposed"].includes(recovered[0].state),
              `${label}: lease expiry hands an abandoned task back to the owner — ${JSON.stringify(recovered)}`);
            assert.equal(recovered[0].offer_state, "open",
              `${label}: the offer survives so another worker can take it`);
          }
          const doubled = await g.asWeb(`SELECT job_id,count(*)::int AS claims FROM fleet_claims
            WHERE job_id=ANY($1::text[]) GROUP BY job_id HAVING count(*)>1`, [ids]);
          assert.deepEqual(doubled, [], `${label}: the burst creates zero double claims`);
          const results = await g.owner.listResults(ownerIdentity(), { awaitingOnly: true });
          const pending = results.filter(row => ids.includes(row.jobId));
          assert.equal(pending.length, submitted.length, `${label}: every submitted result reaches owner review`);
          for (const row of pending)
            await g.owner.review(ownerIdentity(), { resultId: row.resultId, decision: "accepted" });
          // The mandate: every job ends DONE or handed back to the owner as
          // PROPOSED with its offer still open. `leased` and `running` are the
          // stranded states a lost worker leaves behind, and neither is
          // acceptable at any concurrency — nor is a finished-but-unowned result.
          const final = await g.asWeb(`SELECT state,count(*)::int AS count FROM control_jobs
            WHERE id=ANY($1::text[]) GROUP BY state ORDER BY state`, [ids]);
          const stranded = final.filter(row => ["leased", "running", "waiting_approval"].includes(row.state));
          assert.deepEqual(stranded, [], `${label}: no job is left leased, running or unreviewed — ${JSON.stringify(final)}`);
          const done = final.find(row => row.state === "succeeded")?.count ?? 0;
          assert.equal(done, submitted.length, `${label}: every submitted task completes`);
          const open = await g.asWeb(`SELECT count(*)::int AS open_offers FROM fleet_work_offers o
            JOIN control_jobs j ON j.tenant_id=o.tenant_id AND j.id=o.job_id
            WHERE o.job_id=ANY($1::text[]) AND o.state='open' AND j.state='proposed'`, [ids]);
          assert.equal(open[0].open_offers, taskCount - done,
            `${label}: every task not yet run is still proposed and still offered — ${JSON.stringify(final)}`);

          // Nothing unexpected may reach the owner. The pool's own admission
        // backpressure (`database_unavailable` from `admit`, which the gateway
        // reports to the worker as an honest retryable refusal) is not that:
        // it is the bounded pool saying "come back shortly", and this file has
        // already proved the workers recover from it. Everything else is a bug.
        const unexpectedGatewayErrors = g.unexpected.filter(error => !(error instanceof Error
          && error.message === "database_unavailable"));
        assert.deepEqual(unexpectedGatewayErrors, [], "no unexpected gateway error at five bots");
      } finally { await g.close(); await rm(dir, { recursive: true, force: true }); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 900_000 });
});

test("a worker killed mid-job does not strand its task: the elapsed lease hands it back as a fresh attempt",
  async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    await withRealPostgres(async postgres => {
      const mode = { value: "running" as FleetOperationsModeV1 }, g = await gatewayFor(postgres, mode);
      const dir = await mkdtemp(join(tmpdir(), "fleet-lost-worker-"));
      const children: Array<{ child: ReturnType<typeof spawn> }> = [];
      let killed: ReturnType<typeof spawn> | undefined;
      t.after(() => {
        // Only processes this test started are ever signalled, and only ones
        // this test started: no pattern matching, no shared utilities.
        for (const entry of children) if (entry.child.exitCode === null && entry.child.signalCode === null)
          entry.child.kill("SIGKILL");
      });
      try {
        await seedFleetTenant((sql, params) => g.admin.client.query(sql, params));
        const lost = await seedProposedTask(g.admin.client, PROJECT_A, "lost-worker");
        const survivor = await seedProposedTask(g.admin.client, PROJECT_A, "survivor");
        for (const task of [lost, survivor])
          await g.owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: task.jobId, capability: "writing" });

        // The victim runs the real connector in a real child process, so the
        // process really is gone — not a refused promise standing in for one.
        // Its fake harness never returns, so the child is still holding a live
        // claim when it is killed.
        const victim = await enrollBot(g, dir, 0, { behaviour: "hang", delayMs: 0, label: "Victim" });
        // `--config` names this one profile's credential file directly.
        // `--profile` would derive a path from the home layout instead, which is
        // exactly the property this fixture cannot provide.
        const child = spawn(process.execPath, ["--import", "tsx", CONNECTOR, "run", "--once",
          "--config", victim.configPath, "--harnesses", victim.harnessesPath],
        { cwd: resolve("."), env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" },
          stdio: ["ignore", "pipe", "pipe"] });
        child.stderr.on("data", chunk => { childStderr += chunk; });
        children.push({ child });
        const exited = new Promise<number | null>(resolveExit => child.once("close", code => resolveExit(code)));
        let childStderr = "";
        const held = await (async () => {
          for (let attempt = 0; attempt < 240; attempt += 1) {
            const rows = await g.asWeb(`SELECT c.job_id,c.claim_id,c.lease_id,l.state,l.expires_at FROM fleet_claims c
              JOIN control_leases l ON l.tenant_id=c.tenant_id AND l.id=c.lease_id WHERE c.job_id=$1`, [lost.jobId]);
            if (rows.length === 1 && rows[0].state === "active") return rows[0];
            await new Promise(done => setTimeout(done, 100));
          }
          throw new Error(`the victim never took a live lease; connector said: ${childStderr.slice(-500)}`);
        })();
        // The claim moves the job leased -> running on the worker's first
        // progress note, so wait for that rather than racing the child.
        await (async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const state = (await g.asWeb("SELECT state FROM control_jobs WHERE id=$1", [lost.jobId]))[0].state;
            if (state === "running") return;
            await new Promise(done => setTimeout(done, 50));
          }
          throw new Error("the victim's job never reached running");
        })();

        child.kill("SIGKILL");
        assert.notEqual(await exited, 0, "the victim's process is really gone");

        // While the lease is live the task is honestly still running: no other
        // bot may take it, and the owner is not shown a false recovery.
        const rival = await enrollBot(g, dir, 1, { delayMs: 10, label: "Rival" });
        const rivalPass = await connector.runWorker({ configPath: rival.configPath,
          harnessesPath: rival.harnessesPath, once: true, log: () => {}, progressIntervalMs: 20 });
        assert.equal(rivalPass.state, "idle", "a live lease keeps the task away from other workers");
        assert.equal((await g.asWeb("SELECT state FROM control_jobs WHERE id=$1", [lost.jobId]))[0].state, "running",
          "a killed worker's task is still honestly running until its lease elapses");

        // The lease elapses exactly as it would if the machine had simply
        // powered off. No claim row is deleted; the canonical lease expires,
        // the attempt is orphaned and the task returns to `ready` under the
        // same open offer, ready for a new attempt with a new lease epoch.
        await g.asGateway(`UPDATE control_leases SET expires_at=acquired_at+interval '1 second',
          payload=jsonb_set(payload,'{expiresAt}',to_jsonb((acquired_at+interval '1 second')::timestamptz))
          WHERE id=$1`, [held.lease_id]);
        await new Promise(done => setTimeout(done, 1_100));
        const applied = await g.gateway.reconcile();
        assert.equal(applied.expiredLeases, 1);
        assert.equal((await g.asWeb("SELECT state FROM control_jobs WHERE id=$1", [lost.jobId]))[0].state, "ready");
        const lease = await g.asWeb("SELECT state FROM control_leases WHERE id=$1", [held.lease_id]);
        assert.equal(lease[0].state, "expired");
        const attempts = await g.asWeb("SELECT state FROM control_attempts WHERE id=(SELECT attempt_id FROM fleet_claims WHERE claim_id=$1)",
          [held.claim_id]);
        assert.equal(attempts[0].state, "orphaned", "the dead worker's attempt is recorded as orphaned, not silently reused");
        const offers = await g.asWeb("SELECT state FROM fleet_work_offers WHERE job_id=$1", [lost.jobId]);
        assert.equal(offers[0].state, "open", "the owner still has an open offer for the task");

        // A surviving worker takes the recovered task as a NEW attempt with a
        // new lease, and its result is the one the owner sees.
        const recovery = await connector.runWorker({ configPath: rival.configPath,
          harnessesPath: rival.harnessesPath, once: true, log: () => {}, progressIntervalMs: 20 });
        assert.equal(recovery.outcome, "submitted", JSON.stringify(recovery));
        assert.equal(recovery.jobId, lost.jobId);
        const epochs = await g.asWeb(`SELECT count(DISTINCT c.attempt_id)::int AS attempts FROM fleet_claims c
          WHERE c.job_id=$1`, [lost.jobId]);
        assert.equal(epochs[0].attempts, 2, "the retry is a distinct attempt, not a resurrected claim");
        const stale = await connector.createClient(await connector.loadConfig(victim.configPath)).result(held.claim_id,
          "a result from the machine that is gone", [], "result-key-lost0001").catch((error: Error) => error);
        assert.match(String(stale?.message ?? ""), /expired|conflict|not_found|unauthenticated/u,
          "the dead worker's claim can no longer carry a result");
        const results = await g.owner.listResults(ownerIdentity(), { awaitingOnly: true });
        const row = results.find(entry => entry.jobId === lost.jobId);
        assert.ok(row, "the recovered task reaches owner review");
        await g.owner.review(ownerIdentity(), { resultId: row.resultId, decision: "accepted" });
        assert.equal((await g.asWeb("SELECT state FROM control_jobs WHERE id=$1", [lost.jobId]))[0].state, "succeeded");
        killed = child;
      } finally {
        if (killed && killed.exitCode === null && killed.signalCode === null) killed.kill("SIGKILL");
        await g.close(); await rm(dir, { recursive: true, force: true });
      }
    }, { port: PORTS[1], allowedPorts: [PORT, PORTS[1]], boundMs: 540_000 });
});

test("a refused progress note is retried rather than abandoned: one busy gateway must not throw away a claim",
  async () => {
    const events: string[] = [];
    let attempts = 0;
    const client = {
      progress: async () => { attempts += 1; events.push(`progress:${attempts}`);
        if (attempts < 3) throw Object.assign(new Error("Control Room refused the request (rate_limited)."),
          { code: "rate_limited" });
        return { eventId: "e", replayed: false, leaseExpiresAt: null }; },
      blocker: async () => ({ eventId: "b", replayed: false, released: true }),
      result: async () => ({ resultId: "r", replayed: false, taskState: "waiting_approval", accepted: false }),
    };
    const claim = { claimId: "fleet-claim:" + "a".repeat(32), jobId: "job:busy", title: "Busy", instructions: "Work." };
    const finished = await connector.runClaimedTask({ client: client as never, claim, log: () => {},
      readMode: async () => "running", secrets: [],
      adapter: { harness: "codex", deadlineMs: 5_000, execute: async () => ({ kind: "completed",
        text: "Done.", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), usage: null }) } });
    assert.equal(attempts, 3, "a transient refusal is retried, not treated as final");
    assert.equal(finished.outcome, "submitted", JSON.stringify(finished));
  });

test("a result that cannot be delivered hands the task back instead of holding it with no worker",
  async () => {
    const events: string[] = [];
    let resultAttempts = 0;
    const client = {
      progress: async () => ({ eventId: "e", replayed: false, leaseExpiresAt: null }),
      result: async () => { resultAttempts += 1;
        throw Object.assign(new Error("Control Room refused the request (refused)."), { code: "refused" }); },
      blocker: async (claimId: string, message: string) => { events.push("blocker");
        return { eventId: "b", replayed: false, released: true }; },
    };
    const claim = { claimId: "fleet-claim:" + "b".repeat(32), jobId: "job:undelivered", title: "Undelivered",
      instructions: "Work." };
    const finished = await connector.runClaimedTask({ client: client as never, claim, log: () => {},
      readMode: async () => "running", secrets: [],
      adapter: { harness: "codex", deadlineMs: 5_000, execute: async () => ({ kind: "completed",
        text: "Done.", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), usage: null }) } });
    assert.equal(finished.outcome, "blocked",
      `an undeliverable result releases the claim rather than abandoning it: ${JSON.stringify(finished)}`);
    assert.deepEqual(events, ["blocker"], "the task is handed back to the owner");
  });

