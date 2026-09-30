// The real-PostgreSQL answer to "can a bot build Control Room through Control
// Room?", run as the production logins on a disposable cluster.
//
// Nothing here is a stub. The throwaway installation is composed from the same
// objects the Mac-local host composes:
//   * the private web login signs the owner in and owns the owner routes
//     (create a project, a join code, approve a batch, open work, accept a
//     result, revoke a worker, and Pause / Drain / Stop) — the owner acts ONLY
//     through those HTTP routes, never through the database;
//   * the fleet gateway login runs the real gateway HTTP handler on loopback
//     with the real connector release the gateway would serve;
//   * the fleet owner-authority login runs the real owner service the fleet
//     routes delegate to;
//   * the connector is the dependency-free .mjs the gateway actually serves,
//     and the bot verifies its sha256 against a real manifest before joining.
//
// The bot is a script (scripts/dogfood/bot-journey.mjs). It holds a credential
// file and a workspace, and nothing else. It never starts hermes, claude or
// codex: CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 is set for the whole run, so the
// connector refuses those CLIs even if something tried to.
//
// Reserved disposable-cluster lane for this file: 59620-59629.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1, type FleetOperationsModeV1 } from "../src/fleet/v1";
import { buildFleetConnectorReleaseForTestV1 } from "../scripts/build-fleet-connector.mjs";
import { loadFleetConnectorReleaseV1 } from "../scripts/run-fleet-gateway";
import { WorkBatchServiceV1, WorkBatchOwnerServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import type { WorkBatchProposalV1 } from "../src/work-intake/v1";
import { WebTaskService } from "../src/web/v1/task-service";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createPostgresLocalOwnerSessionStoreV1 } from "../src/web/v1/local-owner-session-store";
import { sha256Digest } from "../src/security";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_B, seedFleetTenant, seedProposedTask } from "./support/fleet-fixture";
import { BOT_JOURNEY_CONDITIONAL_REFUSALS_V1, BOT_JOURNEY_EXPECTED_REFUSALS_V1, BOT_JOURNEY_EXPECTED_ROWS_V1, ScriptedBotV1, botJourneyMarkdownV1,
  makeBotWorkspaceV1, removeBotWorkspaceV1, runBotJourneyV1 } from "../scripts/dogfood/bot-journey.mjs";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59620);
const PG = requiresRealPostgres();
const WORK_BATCH_KEY = Buffer.alloc(32, 21).toString("base64url");
const WORK_BATCH_KEY_BYTES = new Uint8Array(Buffer.from(WORK_BATCH_KEY, "base64url"));
const OWNER_CODE = "dogfood-owner-code-long-enough";
const OWNER_INTAKE_IDENTITY = "identity:work-intake:dogfood-owner";

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
    database: postgres.database, username: login.user, password: login.password, majorVersion: 17 as const }),
    host: login.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}
function adminPool(postgres: RealPostgres) {
  const admin = postgres.admin({ database: postgres.database });
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
    database: postgres.database, username: admin.user, password: admin.password, majorVersion: 17 as const }),
    host: admin.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}
const sqlState = (error: unknown) => (error as { code?: string }).code;
const close = (server: Server) => new Promise<void>(done => server.close(() => done()));
const listen = (server: Server) => new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
const portOf = (server: Server) => (server.address() as AddressInfo).port;

test("a bot can build Control Room through Control Room, end to end, as the production logins", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), web = pool(postgres, "web"), fleet = pool(postgres, "fleet"),
      fleetOwner = pool(postgres, "fleetOwner"), intake = pool(postgres, "control_room_work_intake_agent");
    const workspaces: string[] = [];
    const unexpected: unknown[] = [];
    const servers: Server[] = [];
    let primaryWorkspace = "";
    let mode: FleetOperationsModeV1 = "running";
    // The gateway login is the only one that talks to a worker machine; the
    // proposal-only intake login is the one the gateway writes proposals with.
    const gateway = new FleetGatewayStoreV1(fleet.client,
      { tenantId: FLEET_TENANT, operationsMode: async () => mode });
    const proposals = new WorkBatchServiceV1(new WorkBatchStoreV1(intake.client, WORK_BATCH_KEY_BYTES));
    try {
      const releaseRoot = await makeBotWorkspaceV1("release");
      workspaces.push(releaseRoot);
      const built = await buildFleetConnectorReleaseForTestV1({ root: resolve(releaseRoot, "fleet"),
        builtFrom: "0".repeat(40) });
      const connectorRelease = await loadFleetConnectorReleaseV1(built.root);
      const handler = createFleetGatewayHandlerV1({ store: gateway, proposals, connectorRelease,
        onUnexpectedError: error => { unexpected.push(error); } });
      const gatewayServer = createServer((request, response) => { void handler.handle(request, response); });
      servers.push(gatewayServer);
      await listen(gatewayServer);
      const origin = `http://127.0.0.1:${portOf(gatewayServer)}`;

      await seedFleetTenant((sql, params) => admin.client.query(sql, params));
      // A registered proposal agent, seeded exactly as the Mac-local owner
      // bootstrap seeds the real roster (mac-local-owner-bootstrap.ts), so the
      // owner's own intake runs as a real proposal-only agent identity with a
      // real grant rather than an invented id the intake login may not audit.
      await admin.client.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
        auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'agent','Registered proposal agent dogfood',
        'work-intake',$3,'active',now(),now()) ON CONFLICT (tenant_id,id) DO NOTHING`,
      [OWNER_INTAKE_IDENTITY, FLEET_TENANT, sha256Digest({ workerId: "owner-dogfood", kind: "dogfood" })]);
      await admin.client.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
        risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES($1,$2,$3,'work_batch_proposer','["work_batches.propose"]','["*"]'::jsonb,'low',false,false,now(),now())
        ON CONFLICT (tenant_id,id) DO NOTHING`, [`grant:dogfood-owner-intake`, FLEET_TENANT, OWNER_INTAKE_IDENTITY]);

      // The owner's real web process, on its own loopback origin, with the
      // fleet routes, the pipelines module and Pause / Drain / Stop composed in.
      // A probe listener only reserves the owner's own origin; the owner's app
      // is driven through its handle() seam, so that listener is released
      // immediately and never serves anything.
      const webProbe = createServer();
      await listen(webProbe);
      const webOrigin = `http://127.0.0.1:${portOf(webProbe)}`;
      await close(webProbe);
      const tasks = new WebTaskService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
      const app = createMacLocalWebProcessV1({ origin: webOrigin, workspaceId: FLEET_WORKSPACE,
        localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: webOrigin, tenantId: FLEET_TENANT,
          provider: "test", subject: "identity:fleet-owner", ownerCodeDigest: sha256Digest({ ownerCode: OWNER_CODE }),
          sessionSeconds: 900 },
        database: { client: web.client, close: async () => {}, isAvailable: () => true },
        // The real Postgres-backed session store, so the owner session row the
        // owner's own routes authorize against is written by production code
        // with exactly the issuedAt they will compare against.
        localOwnerSessionStore: createPostgresLocalOwnerSessionStoreV1(web.client, {
          schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: webOrigin, tenantId: FLEET_TENANT, provider: "test",
          subject: "identity:fleet-owner", ownerCodeDigest: sha256Digest({ ownerCode: OWNER_CODE }), sessionSeconds: 900 }),
        workBatchIntegrityKey: WORK_BATCH_KEY_BYTES,
        operationsModeIntegrityKey: new Uint8Array(32).fill(29),
        taskService: tasks,
        fleet: { ownerAuthority: fleetOwner.client, gatewayOrigin: origin, connectorRelease: connectorRelease.manifest,
          afterDecision: () => gateway.reconcile() } });
      const ownerRoute = async (path: string, init: RequestInit = {}) => app.handle(
        new Request(`${webOrigin}${path}`, init), () => new Response("unused"));

      const asAdmin = async (sql: string, params: unknown[] = []) => (await admin.client.query(sql, params)).rows;
      // The owner signs in with the real owner code, through the real route;
      // the real session store writes the row the owner's other routes check.
      const signedIn = await ownerRoute("/api/v1/local-owner-session", { method: "POST", headers: {
        origin: webOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ ownerCode: OWNER_CODE }) });
      assert.equal(signedIn.status, 201, await signedIn.clone().text());
      const ownerCookies = signedIn.headers.get("set-cookie")!;

      let projects = 0;
      let journeyProjectId = "";
      const createProject = async (title: string) => {
        const response = await ownerRoute("/api/v1/projects", { method: "POST", headers: { cookie: ownerCookies,
          origin: webOrigin, "content-type": "application/json",
          // The real route requires a 16..100 character key of [A-Za-z0-9_-].
          "idempotency-key": `dogfood-project-${projects + 1}`.padEnd(20, "0") },
          body: JSON.stringify({ title, summary: "Dogfood" }) });
        assert.equal(response.status, 201, await response.clone().text());
        return (await response.json() as { project: { projectId: string } }).project.projectId;
      };
      const post = (path: string, body: unknown, key?: string) => ownerRoute(path, { method: "POST",
        headers: { cookie: ownerCookies, origin: webOrigin, "content-type": "application/json",
          ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });

      /** The owner's real approve route, over HTTP, with its own revision and
       * its own idempotency key — never a database shortcut. The HTTP status is
       * returned separately because it is what the journey asserts: a refusal
       * the owner sees is a status, and a status that is 2xx means the approval
       * went through whatever the row claims about it. */
      const approveBatch = async (projectId: string, batchId: string, items: { localId: string; decision: "approve" }[]) => {
        const detail = await ownerRoute(`/api/v1/projects/${encodeURIComponent(projectId)}/pipelines/${batchId}`,
          { headers: { cookie: ownerCookies } });
        assert.equal(detail.status, 200, await detail.clone().text());
        const view = await detail.json() as { revision: number };
        const response = await post(`/api/v1/projects/${encodeURIComponent(projectId)}/pipelines/${batchId}`,
          { batchId, expectedRevision: view.revision, operation: "decide", items },
          `dogfood-approve-${batchId.slice(-12)}`);
        return { status: response.status, detail: (await response.clone().text()).slice(0, 240) };
      };

      const journey = await runBotJourneyV1({
        origin, ownerRoute, ownerCookies, ownerOrigin: webOrigin,
        // The primary bot's workspace, so the harness can write a file just
        // outside it: the target of the result-file boundary row.
        makeBot: async (name: string) => {
          const workspace = await makeBotWorkspaceV1(name);
          workspaces.push(workspace);
          const bot = new ScriptedBotV1({ name, workspace, origin });
          if (name === "primary") primaryWorkspace = workspace;
          return bot;
        },
        otherProjectId: PROJECT_B,
        createProject: async () => { projects += 1; journeyProjectId = await createProject(`Dogfood ${projects}`);
          return journeyProjectId; },
        setMode: async (next: FleetOperationsModeV1) => {
          const response = await post("/api/v1/operations-mode", { mode: next, reason: "dogfood" },
            `dogfood-mode-${next}-${mode}`);
          assert.equal(response.status, 200, await response.clone().text());
          mode = next;
        },
        proposeBatchOwner: async (projectId: string, proposal: WorkBatchProposalV1) => {
          // The owner's own registered proposal agent, through the same S1
          // intake login the fleet gateway uses, so the flagged proposal is a
          // real batch with real flags the real approve route then refuses.
          const receipt = await proposals.submit({ principal: { tenantId: FLEET_TENANT,
            identityId: OWNER_INTAKE_IDENTITY, actorType: "agent", authenticatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
          projectId, rawProposal: JSON.stringify(proposal), idempotencyKey: `dogfood-owner-propose-${projects}`,
            now: new Date().toISOString() });
          if (!("batchId" in receipt)) throw new Error(`bot_journey_owner_proposal_refused:${receipt.safeReasonCode}`);
          return receipt.batchId;
        },
        approveBatch: (batchId: string, items: { localId: string; decision: "approve" }[]) =>
          approveBatch(journeyProjectId, batchId, items),
        approvedJobId: (batchId: string) => (asAdmin("SELECT job_id FROM work_batch_items WHERE batch_id=$1 LIMIT 1",
          [batchId]).then(rows => String(rows[0]?.job_id ?? ""))),
        offerForFleet: async (projectId: string, jobId: string) => {
          const response = await post("/api/v1/fleet/offers", { projectId, jobId, capability: "code.change" });
          assert.equal(response.status, 201, await response.clone().text());
          return (await response.json() as { offerId: string }).offerId;
        },
        acceptResult: async (resultId: string) => {
          const response = await post(`/api/v1/fleet/results/${resultId}/review`, { decision: "accepted" });
          assert.equal(response.status, 200, await response.clone().text());
          return "accepted";
        },
        release: async (bot: ScriptedBotV1, claimId: string) =>
          (await bot.call("report_blocker", { claimId, message: "dogfood: handing it back", release: true,
            idempotencyKey: "dogfood-blocker-0001" })).refused,
        // A real file just OUTSIDE the bot's workspace, written by the harness
        // rather than by the bot: `bot.write` is test code and refuses escaping
        // paths itself, so it cannot be the boundary under test. The journey
        // points submit_result at this file and the connector's own
        // workspaceFile decides the row.
        writeOutsideWorkspace: async (name: string, contents: string) => {
          await writeFile(join(primaryWorkspace, "..", name), contents, { mode: 0o600 });
        },
        createFleetTask: async (projectId: string, name: string) => (await seedProposedTask(admin.client,
          projectId, name)).jobId,
        workerState: async (workerId: string) => String((await asAdmin(
          "SELECT state FROM fleet_workers WHERE worker_id=$1", [workerId]))[0]?.state),
        revokeWorker: async (workerId: string) => {
          const response = await post(`/api/v1/fleet/workers/${workerId}/revoke`, {});
          assert.equal(response.status, 200, await response.clone().text());
        },
      });
      // Every row the table prints is checked against the declared expectation,
      // on the label AND on the code. `runBotJourneyV1` already throws on a
      // mismatch; this loop is the second, independent check that a row was
      // not silently dropped from the declared set, and it names the row.
      for (const entry of journey.steps) {
        if (entry.outcome === "refused") {
          assert.ok(BOT_JOURNEY_EXPECTED_REFUSALS_V1.includes(entry.refusal!), `unlabelled refusal: ${entry.what}`);
          assert.notEqual(BOT_JOURNEY_EXPECTED_ROWS_V1[entry.refusal!], undefined,
            `refusal with no declared code: ${entry.what}`);
        }
        if (entry.outcome === "not tried")
          assert.equal(entry.code, "", `a row nobody tried must not report a code: ${entry.what}`);
      }
      // Every declared refusal was actually reached by this run. A label that
      // is declared but never recorded would otherwise look like a pass.
      const recorded = new Set(journey.steps.map(entry => entry.refusal).filter(Boolean));
      for (const label of BOT_JOURNEY_EXPECTED_REFUSALS_V1) {
        if (BOT_JOURNEY_CONDITIONAL_REFUSALS_V1.includes(label)) continue;
        assert.ok(recorded.has(label), `declared refusal never recorded by this run: ${label}`);
      }
      // A conditional label that DID appear is itself a finding: it means the
      // protection failed, and the journey already recorded it as a refusal.
      for (const label of BOT_JOURNEY_CONDITIONAL_REFUSALS_V1)
        assert.ok(!recorded.has(label), `conditional refusal recorded, so a protection failed: ${label}`);
      process.stderr.write(`dogfood journey rows: ${journey.steps.length},`
        + ` refusals=${recorded.size}, not tried=${journey.steps.filter(e => e.outcome === "not tried").length}\n`);
      const markdown = botJourneyMarkdownV1(journey);
      process.stderr.write(`\n--- bot journey ---\n${markdown}\n--- end bot journey ---\n`);

      // --- A bot's own grant is proposal-only, on its own project.
      const grants = await asAdmin("SELECT g.role_key,g.allowed_actions,g.project_ids,g.risk_ceiling"
        + " FROM control_role_grants g JOIN fleet_workers w ON w.tenant_id=g.tenant_id"
        + " AND w.identity_id=g.identity_id WHERE w.worker_id=$1", [journey.primaryWorkerId]);
      assert.deepEqual(grants.map(row => [row.role_key, row.allowed_actions, row.project_ids, row.risk_ceiling]),
        [["work_batch_proposer", ["work_batches.propose"], [journey.projectId], "low"]]);

      // --- Nothing a bot proposed started work on its own. Two separate facts:
      // an unapproved batch created no task at all, and every leased job came
      // from an offer the owner made (never from a proposal alone).
      const unapprovedTasks = (await asAdmin("SELECT count(*)::int AS count FROM work_batch_items i"
        + " JOIN work_batches b ON b.id=i.batch_id AND b.tenant_id=i.tenant_id"
        + " WHERE b.state='proposed' AND i.job_id IS NOT NULL"))[0].count;
      assert.equal(unapprovedTasks, 0, "an unapproved batch created no task");
      const leasedWithoutOffer = (await asAdmin("SELECT count(*)::int AS count FROM control_jobs j"
        + " WHERE j.state='leased' AND NOT EXISTS (SELECT 1 FROM fleet_work_offers o"
        + " WHERE o.tenant_id=j.tenant_id AND o.job_id=j.id)"))[0].count;
      assert.equal(leasedWithoutOffer, 0, "nothing is leased that the owner never offered");
      // The batch the bot proposed first, and which the owner never approved,
      // is still exactly one proposed batch with no items and no jobs.
      const untouched = (await asAdmin("SELECT b.id, count(i.id)::int AS items FROM work_batches b"
        + " LEFT JOIN work_batch_items i ON i.batch_id=b.id AND i.tenant_id=b.tenant_id"
        + " WHERE b.state='proposed' GROUP BY b.id, b.created_at ORDER BY b.created_at LIMIT 1"))[0];
      assert.equal(untouched.items, 0, "the batch nobody approved holds no items");
      // Every fleet worker's only grant is proposal-only intake.
      const workerGrants = await asAdmin("SELECT DISTINCT g.role_key,g.allowed_actions,g.risk_ceiling"
        + " FROM control_role_grants g JOIN fleet_workers w ON w.tenant_id=g.tenant_id"
        + " AND w.identity_id=g.identity_id");
      for (const grant of workerGrants)
        assert.deepEqual([grant.role_key, grant.allowed_actions, grant.risk_ceiling],
          ["work_batch_proposer", ["work_batches.propose"], "low"],
          "a fleet worker holds no grant but proposal-only intake");

      // --- A bot cannot decide anything, with any production login.
      const as = async (role: string, sql: string) => {
        const client = new Client(postgres.connection(role)); await client.connect();
        try { await client.query(sql); } finally { await client.end(); }
      };
      await assert.rejects(as("fleet", "INSERT INTO fleet_result_reviews(tenant_id,review_id,result_id,decision,"
        + "reviewed_by_identity_id,reviewed_at) SELECT tenant_id,'fleet-review:${\"9\".repeat(32)}',result_id,"
        + "'accepted',worker_id,now() FROM fleet_results LIMIT 1"),
      (error: unknown) => ["42501", "23514", "23503", "42883"].includes(sqlState(error) ?? ""));
      await assert.rejects(as("web", "UPDATE work_batches SET state='approved',approved_at=now()"
        + " WHERE tenant_id=$1".replace("$1", `'${FLEET_TENANT}'`)),
      // The web login is refused by 0102's trigger, not by a table privilege:
      // a decision is only legitimate with its signed digest and tag, and the
      // web login has no path to write one for a batch it never decided.
      (error: unknown) => ["42501", "P0001", "42883"].includes(sqlState(error) ?? ""));
      // The gateway must log no unexpected error for anything the bots do. The
      // two-bot 40P01 (claim path vs the MCP audit append) is fixed at the root
      // by the tenant-mutex lock order (FOR NO KEY UPDATE, mutex before row
      // locks) from cook/connonly, so any deadlock now fails this test.
      const faults = unexpected.map(error => `${(error as { code?: string }).code ?? "unknown"}`
        + `[${(error as { sqlState?: string }).sqlState ?? "-"}]`);
      const KNOWN_LOCK_ORDER_DEADLOCK = /database_unavailable\[40P01\]/u;
      const knownDeadlocks = faults.filter(code => KNOWN_LOCK_ORDER_DEADLOCK.test(code));
      assert.deepEqual(faults, [], "the gateway logged no unexpected error");
      assert.deepEqual(knownDeadlocks, [], "no lock-order deadlock (40P01) may surface");
      process.stderr.write(`dogfood known lock-order deadlocks (40P01): ${knownDeadlocks.length} of ${faults.length}`
        + ` faults\n`);
      const audit = await asAdmin("SELECT action, count(*)::int AS count FROM audit_events"
        + " WHERE action LIKE 'fleet.%' GROUP BY action ORDER BY action");
      process.stderr.write(`dogfood audit: ${JSON.stringify(audit)}`
        + "\n");
      assert.equal(ownerIdentity().subject, "identity:fleet-owner");
    } finally {
      // Every listener this test started is closed and every pool is ended on
      // the failure path too: a journey that throws half way must not leave a
      // handle behind, or the runner waits for the event loop forever.
      for (const server of servers) await close(server);
      await closePools(admin, web, fleet, fleetOwner, intake);
      for (const workspace of workspaces) await removeBotWorkspaceV1(workspace);
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
});

/** The pools must be ended one at a time and in reverse dependency order, and
 * each close must be allowed to finish before the next begins: `Promise.all`
 * over five `pg` pools at once can interleave a `database_outcome_uncertain`
 * teardown failure that says nothing about the code under test. */
async function closePools(...pools: { close: () => Promise<void> }[]) {
  for (const item of [...pools].reverse()) {
    try { await item.close(); } catch { /* a pool already stopped by the failure path */ }
  }
}
