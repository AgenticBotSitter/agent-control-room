// Real-PostgreSQL proof of the fleet harness hand-off, run AS the production
// logins that execute each step, with only the grants the real db/roles files
// give them:
// - owner actions (join code, offer, reading the result): the fleet owner-authority login;
// - the connector gateway (enroll, claim, progress, blocker, result): the fleet gateway login;
// - checks on what the owner's pages read: the private web login.
// The worker machine runs the real standalone connector with a deterministic
// fake harness adapter speaking the shared local CLI delivery contract.
// The attack kit provisions a disposable socket-only cluster on this file's
// reserved port lane (59200-59209 by default; CONTROL_ROOM_PG_TEST_PORT_BASE
// moves it, as in linear-pipeline-postgres) and destroys it afterwards.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1, type FleetOperationsModeV1 } from "../src/fleet/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, seedFleetTenant, seedProposedTask } from "./support/fleet-fixture";
import * as connector from "../scripts/fleet/connector.mjs";
import * as fake from "./support/fleet-fake-harness-adapter.mjs";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59200);
const PG = requiresRealPostgres();

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

test("harness hand-off end to end as the production logins: join, offer, run, result visible to the owner", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner");
    const dir = await mkdtemp(join(tmpdir(), "fleet-handoff-pg-"));
    let mode: FleetOperationsModeV1 = "running";
    const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT, operationsMode: async () => mode });
    const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
      afterDecision: () => gateway.reconcile() });
    const unexpected: unknown[] = [];
    const handler = createFleetGatewayHandlerV1({ store: gateway, onUnexpectedError: error => { unexpected.push(error); } });
    const server = createServer((request, response) => { void handler.handle(request, response); });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const asWeb = async (sql: string, params: unknown[] = []) => {
      const client = new Client(postgres.connection("web")); await client.connect();
      try { return (await client.query(sql, params)).rows; } finally { await client.end(); }
    };
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input, init) => { requests.push(String(input)); return fetch(input, init); };
    try {
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));
      const task = await seedProposedTask(admin.client, PROJECT_A, "handoff-pg");
      const failing = await seedProposedTask(admin.client, PROJECT_A, "handoff-pg-fail");

      // --- The owner adds a Codex machine; the machine joins with the one-time code.
      const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "PG Codex box", workerKind: "codex",
        projectIds: [PROJECT_A], capabilities: ["writing"], maxConcurrent: 1 });
      const configPath = join(dir, "worker.json");
      await connector.join({ server: origin, code: code.code, configPath, fetcher });
      const settings = async (fakeBehaviour: string) => {
        const path = join(dir, `harnesses-${fakeBehaviour}.json`);
        await writeFile(path, JSON.stringify({ schema: "control-room.fleet-harnesses/v1",
          adapterModule: resolve("tests/support/fleet-fake-harness-adapter.mjs"),
          harnesses: { codex: { enabled: true, deadlineMs: 5000, fakeBehaviour } } }), { mode: 0o600 });
        return path;
      };
      const run = async (fakeBehaviour: string) => connector.runWorker({ configPath, harnessesPath: await settings(fakeBehaviour),
        fetcher, once: true, log: () => {}, progressIntervalMs: 50 });

      // --- Paused: the machine takes nothing, and the production gateway refuses a direct claim.
      await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: task.jobId, capability: "writing" });
      mode = "paused";
      assert.equal((await run("success")).state, "paused");
      assert.equal((await asWeb("SELECT count(*)::int AS count FROM fleet_claims"))[0].count, 0);
      mode = "running";

      // --- Running: run claims, the fake Codex adapter answers, the result reaches the owner.
      fake.calls.length = 0;
      const pass = await run("success");
      assert.equal(pass.state, "ran");
      assert.equal(pass.outcome, "submitted", JSON.stringify(pass));
      assert.equal(fake.calls.length, 1);
      const shown = await owner.listResults(ownerIdentity(), { awaitingOnly: true });
      assert.equal(shown.length, 1);
      assert.equal(shown[0]!.jobId, task.jobId);
      assert.equal(shown[0]!.workerName, "PG Codex box");
      assert.match(shown[0]!.summary, /^Done by fake codex: Task handoff-pg/u);
      assert.equal(shown[0]!.taskState, "waiting_approval");
      assert.equal(shown[0]!.decision, null);
      // What the owner's pages read with the private web login agrees.
      const [job] = await asWeb("SELECT state FROM control_jobs WHERE id=$1", [task.jobId]);
      assert.equal(job.state, "waiting_approval");
      const progress = await asWeb(`SELECT e.kind,e.message FROM fleet_worker_events e JOIN fleet_claims c
        ON c.tenant_id=e.tenant_id AND c.claim_id=e.claim_id WHERE c.job_id=$1`, [task.jobId]);
      assert.deepEqual(progress.map(row => [row.kind, row.message]), [["progress", "Started on Codex on this machine."]]);
      const audit = await asWeb(`SELECT action FROM audit_events WHERE target_id=$1 ORDER BY chain_sequence`, [task.jobId]);
      assert.deepEqual(audit.map(row => row.action), ["fleet.task.offered", "fleet.task.claimed", "fleet.result.submitted"]);

      // --- The owner accepts through the owner path; only then is the task done.
      await owner.review(ownerIdentity(), { resultId: shown[0]!.resultId, decision: "accepted" });
      assert.equal((await asWeb("SELECT state FROM control_jobs WHERE id=$1", [task.jobId]))[0].state, "succeeded");

      // --- A failing harness is a blocker as the production login, never a result.
      await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: failing.jobId, capability: "writing" });
      const failed = await run("failure");
      assert.equal(failed.outcome, "blocked");
      assert.equal((await asWeb("SELECT count(*)::int AS count FROM fleet_results WHERE job_id=$1", [failing.jobId]))[0].count, 0);
      assert.equal((await asWeb("SELECT state FROM control_jobs WHERE id=$1", [failing.jobId]))[0].state, "ready");
      const blocker = await asWeb(`SELECT e.message FROM fleet_worker_events e JOIN fleet_claims c ON c.tenant_id=e.tenant_id
        AND c.claim_id=e.claim_id WHERE c.job_id=$1 AND e.kind='blocker'`, [failing.jobId]);
      assert.match(blocker[0].message, /^The Codex run did not finish/u);
      const note = (await owner.listWorkers(ownerIdentity())).workers[0]!.latestNote;
      assert.equal(note?.kind, "blocker", "the owner-authority login sees the blocker on the Workers page");
      assert.equal(note?.taskTitle, "Task handoff-pg-fail");

      assert.ok(requests.every(url => url.startsWith(`${origin}/fleet/v1/`)), "the connector spoke only to the gateway");
      assert.deepEqual(unexpected, []);
    } finally {
      await new Promise(done => server.close(done));
      await Promise.all([admin.close(), fleet.close(), fleetOwner.close()]);
      await rm(dir, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
});
