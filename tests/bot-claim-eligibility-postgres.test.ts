// Two claims guards on the fleet claim path, proven on real PostgreSQL as the
// production logins, because both were wrong in a way only a real row shows:
//
//   1. A task whose owner picked a MODEL or an EFFORT is not fleet-claimable.
//      The owner-chosen model lives in a `worker_kind IS NULL` row (0091 shape
//      (b)), which the execution planner reads back as a real request. Claiming
//      it silently drops the owner's explicit choice; only the all-NULL row
//      (shape (a)) carries no request and stays claimable.
//   2. Project Settings `eligible_worker_kinds` restricts which worker kinds
//      may claim a project's work at all. The coordinator enforced it; the
//      fleet claim path did not, so a project that restricted itself to one
//      kind was still claimable by every other kind.
//
// Both refusals are asserted WITH their code (`conflict`), so a guard that
// fails closed with the wrong reason, or that lets the claim through with a
// different code, fails here. The rows are written by production code where
// one exists: the owner-model row is written by WebTaskService.propose through
// its real model catalog, not by a hand-written INSERT.
//
// Reserved disposable-cluster lane for this file: 59627-59629.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1, type FleetOperationsModeV1 } from "../src/fleet/v1";
import { buildSignedFleetConnectorReleaseForTestV1 } from "./support/fleet-release";
import { captureTaskModelCatalogV1 } from "../src/web/v1/task-model-selection";
import { WebProjectService } from "../src/web/v1/project-service";
import { WebTaskService } from "../src/web/v1/task-service";
import { sha256Digest } from "../src/security";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, seedFleetTenant, seedProposedTask } from "./support/fleet-fixture";
import { ScriptedBotV1, makeBotWorkspaceV1, removeBotWorkspaceV1 } from "../scripts/dogfood/bot-journey.mjs";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59627);
const PG = requiresRealPostgres();
/** The catalog the owner's own page is served from. `model:any` is in it, so
 * the model's OWNER-picked row is a real request, not an invented string. */
const catalog = captureTaskModelCatalogV1([
  { kind: "codex", policy: { models: ["model:any"], defaultModel: "model:any",
    efforts: ["medium", "high", "max"], defaultEffort: "medium" } },
]);

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
const close = (server: Server) => new Promise<void>(done => server.close(() => done()));
const listen = (server: Server) => new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
const portOf = (server: Server) => (server.address() as AddressInfo).port;

test("an owner-picked model and a restricted worker kind both refuse a fleet claim, on real PostgreSQL", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), web = pool(postgres, "web"), fleet = pool(postgres, "fleet"),
      fleetOwner = pool(postgres, "fleetOwner");
    const workspaces: string[] = [], servers: Server[] = [];
    const unexpected: unknown[] = [];
    let mode: FleetOperationsModeV1 = "running";
    const gateway = new FleetGatewayStoreV1(fleet.client,
      { tenantId: FLEET_TENANT, operationsMode: async () => mode });
    const owner = new FleetOwnerServiceV1(fleetOwner.client,
      { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE, afterDecision: () => gateway.reconcile() });
    try {
      const releaseRoot = await makeBotWorkspaceV1("elig-release");
      workspaces.push(releaseRoot);
      const { connectorRelease, releaseTrust } = await buildSignedFleetConnectorReleaseForTestV1(
        { root: `${releaseRoot}/fleet`, builtFrom: "3".repeat(40) });
      const handler = createFleetGatewayHandlerV1({ store: gateway, connectorRelease, releaseTrust,
        onUnexpectedError: error => { unexpected.push(error); } });
      const server = createServer((request, response) => { void handler.handle(request, response); });
      servers.push(server);
      await listen(server);
      const origin = `http://127.0.0.1:${portOf(server)}`;
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));

      // --- 0. The claim path's policy read is actually permitted. Without
      // this the guard below would silently read as a 42501 turned into an
      // opaque `database_unavailable`, and the eligibility assertions would
      // pass for the wrong reason.
      const policyRead = await admin.client.query("SELECT"
        + " has_column_privilege('control_room_fleet','control_project_settings','eligible_worker_kinds','SELECT') AS col_allowed,"
        + " has_table_privilege('control_room_fleet','control_project_settings','SELECT') AS table_allowed,"
        + " (SELECT relrowsecurity FROM pg_class WHERE relname='control_project_settings') AS rls");
      assert.equal(policyRead.rows[0].col_allowed, true,
        "the fleet login can read the eligibility policy it enforces");

      const bot = new ScriptedBotV1({ name: "elig", workspace: workspaces[0]!, origin });
      // The project is created through the owner's OWN service, because the
      // fixture's manual adapter is not the one the web catalog reads: a
      // fixture project is invisible to the page that would pick a model.
      const projects = new WebProjectService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
      const created = await projects.create(ownerIdentity(), { title: "Eligibility", summary: "Bot claim eligibility" },
        "elig-project-0001");
      const projectId = created.project.projectId;
      await bot.install();
      // The bot's capabilities must cover both task shapes under test: the
      // owner-proposed tasks require `task.proposal.review`, the seeded fleet
      // tasks require `task.generic`. A claim outside its capabilities is
      // refused as not_found, which would mask the refusal under test.
      const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "Eligibility bot",
        workerKind: "mcp-agent", projectIds: [projectId],
        capabilities: ["writing", "code.change", "task.proposal.review", "task.generic"], maxConcurrent: 8 });
      await bot.join(code.code);

      const tasks = new WebTaskService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE },
        Date.now, { modelCatalog: catalog });
      /** The owner's own proposal path, so the selection row under test is
       * written exactly as the owner's page writes it. */
      const proposeWithModel = async (title: string, choice: { model?: string; effort?: string }) => {
        const receipt = await tasks.propose(ownerIdentity(), projectId, { title,
          instructions: "Do the bounded thing.", ...choice },
          `elig-${title.replace(/\W/gu, "-")}`);
        return receipt.receipt.jobId;
      };
      /** Offers a job under the capability the job itself requires. The offer
       * table's guard refuses a capability the task does not declare, and the
       * two fixture shapes differ: an owner-proposed task requires
       * `task.proposal.review`, a seeded fleet task requires `task.generic`. */
      const offerOf = async (jobId: string) => {
        const job = (await admin.client.query("SELECT payload->>'requiredCapability' AS capability FROM control_jobs"
          + " WHERE tenant_id=$1 AND id=$2", [FLEET_TENANT, jobId])).rows[0];
        const capability = String(job?.capability ?? "task.generic");
        // A disjoint file scope for every task this test offers. A task with
        // no declared scope owns the whole repository tree while leased, so
        // without this the second successful claim is refused by the
        // assignment-lease scope guard -- a real refusal, but the wrong one.
        await admin.client.query(`INSERT INTO control_task_declared_scopes
          (tenant_id,project_id,job_id,scope_kind,path,path_fold) VALUES($1,$2,$3,'file',$4,$4)
          ON CONFLICT (tenant_id,job_id,scope_kind,path_fold) DO NOTHING`,
        [FLEET_TENANT, projectId, jobId, `docs/${jobId.replace(/[^A-Za-z0-9]+/gu, "-")}.md`]);
        const offer = await owner.offerTask(ownerIdentity(), { projectId, jobId, capability });
        return offer.offerId;
      };
      /** A seeded fleet task, offered the same way. */
      const offerFixture = async (name: string) => {
        const task = await seedProposedTask(admin.client, projectId, name);
        return offerOf(task.jobId);
      };
      const claimCode = async (offerId: string, key: string) => {
        const call = await bot.call("claim", { offerId, idempotencyKey: key });
        if (call.refused) return { refused: true, code: call.refusalCode ?? "", text: call.text } as const;
        // Every successful claim is handed straight back, so one row's success
        // never becomes the next row's capacity or scope conflict. This test is
        // about WHICH claims are refused, and a live lease from an earlier row
        // would refuse a later one for an unrelated reason.
        await bot.call("report_blocker", { claimId: call.value.claimId, message: "eligibility probe done",
          release: true, idempotencyKey: `${key}-release` });
        return { refused: false, code: "", text: "" } as const;
      };

      // --- 1. The owner picked a model and an effort: refused, as `conflict`.
      const modelJob = await proposeWithModel("Owner picked a model", { model: "model:any", effort: "high" });
      const stored = (await admin.client.query("SELECT worker_kind,selection_key,model,effort"
        + " FROM control_task_model_selections WHERE tenant_id=$1 AND job_id=$2", [FLEET_TENANT, modelJob])).rows[0];
      assert.equal(stored.worker_kind, null, "the owner's choice is an unresolved row, not a resolved one");
      assert.equal(stored.selection_key, "model:any", "the owner's exact selection key is stored");
      const modelOffer = await offerOf(modelJob);
      // A claim must fail HERE, as a refusal, for two reasons the owner can act on:
      // the model it asked for, and the worker kinds it admitted. Any other
      // refusal (or a database fault) means this row is testing something else.
      const claimed = await claimCode(modelOffer, "elig-model-0001");
      const faults = unexpected.map(error => `${(error as Error)?.message ?? "?"}`
        + ` [${(error as { sqlState?: string })?.sqlState ?? "-"}]`);
      assert.equal(claimed.refused, true, `an owner-picked model must not be fleet-claimable: ${claimed.text}`);
      assert.equal(claimed.code, "conflict", `the refusal is a named conflict, not a server fault: ${claimed.text}`);
      assert.deepEqual(faults, [], "an owner-picked model is refused, never a database fault");
      const noLease = (await admin.client.query("SELECT count(*)::int AS count FROM control_leases"
        + " WHERE tenant_id=$1 AND job_id=$2", [FLEET_TENANT, modelJob])).rows[0].count;
      assert.equal(noLease, 0, "a refused claim leaves no lease behind");
      // The offer is still open and still claimable in principle: the refusal
      // is this task's unresolved selection, not the offer.
      assert.equal((await admin.client.query("SELECT state FROM fleet_work_offers WHERE tenant_id=$1 AND offer_id=$2",
        [FLEET_TENANT, modelOffer])).rows[0].state, "open", "the refusal consumed no offer");

      // --- 2. The owner picked only an effort: also a real request, also refused.
      const effortJob = await proposeWithModel("Owner picked an effort", { effort: "max" });
      const effortClaim = await claimCode(await offerOf(effortJob), "elig-effort-0001");
      assert.equal(effortClaim.refused, true, `an owner-picked effort must not be fleet-claimable: ${effortClaim.text}`);
      assert.equal(effortClaim.code, "conflict", "an effort alone is still an unresolved request");

      // --- 3. The owner proposed a task and named no model: claimable. This is
      // 0091's all-NULL row -- the shape WebTaskService always writes when the
      // owner picks nothing -- and it carries no request to drop, so the guard
      // must not refuse it. Asserted through the owner's own propose path
      // rather than a seeded task, because a seeded task has NO row at all,
      // which is a different case and would not catch a widened guard.
      const plainJob = await proposeWithModel("Owner named no model", {});
      const plainSelection = (await admin.client.query("SELECT worker_kind,selection_key,model,effort"
        + " FROM control_task_model_selections WHERE tenant_id=$1 AND job_id=$2", [FLEET_TENANT, plainJob])).rows[0];
      assert.deepEqual([plainSelection.worker_kind, plainSelection.selection_key, plainSelection.model,
        plainSelection.effort], [null, null, null, null], "the owner's task carries an all-NULL selection row");
      const plainClaim = await claimCode(await offerOf(plainJob), "elig-plain-0001");
      assert.equal(plainClaim.refused, false,
        `a task with no model request is still claimable: ${plainClaim.text} code=${plainClaim.code}`);
      // And a seeded fleet task with no row at all is claimable too.
      const noRowClaim = await claimCode(await offerFixture("elig-norow"), "elig-norow-0001");
      assert.equal(noRowClaim.refused, false,
        `a task with no selection row is still claimable: ${noRowClaim.text} code=${noRowClaim.code}`);

      // --- 4. Project Settings restricts the eligible worker kinds: refused.
      // Written through the owner's OWN settings route's service, so the row is
      // exactly what the Settings tab writes and every NOT NULL column is real.
      const setEligible = async (kinds: string[] | null) => {
        const current = await projects.readSettings(ownerIdentity(), projectId);
        return projects.updateSettings(ownerIdentity(), projectId, { expectedVersion: current.version,
          eligibleWorkerKinds: kinds, maxConcurrentTasks: null, defaultWorkerKind: null,
          defaultModel: null, defaultEffort: null });
      };
      await setEligible(["codex"]);
      const restrictedClaim = await claimCode(await offerFixture("elig-restricted"), "elig-restricted-0001");
      assert.equal(restrictedClaim.refused, true,
        `a worker kind outside eligible_worker_kinds must not claim: ${restrictedClaim.text}`);
      assert.equal(restrictedClaim.code, "conflict", "an ineligible worker kind is a conflict");

      // --- 5. Every configured kind is a local harness kind, so a fleet bot is
      // never among them. Naming all three still refuses, which is the honest
      // result: the setting restricts LOCAL assignment, and the fleet path
      // fails closed rather than assuming an unknown kind is eligible.
      await setEligible(["codex", "claude-code", "hermes"]);
      const permittedClaim = await claimCode(await offerFixture("elig-permitted"), "elig-permitted-0001");
      assert.equal(permittedClaim.refused, true,
        `a fleet bot kind is outside every configured worker kind: ${permittedClaim.text}`);
      assert.equal(permittedClaim.code, "conflict", "an ineligible worker kind is a conflict");

      // --- 6. Withdrawing the restriction restores the claim. Not a latch.
      await setEligible(null);
      const withdrawnClaim = await claimCode(await offerFixture("elig-withdrawn"), "elig-withdrawn-0001");
      assert.equal(withdrawnClaim.refused, false, `no restriction means no refusal: ${withdrawnClaim.text}`);

      // --- 7. Under load, not just once. A guard that holds for one caller and
      // leaks for twenty is not a guard. The per-IP budget answers a real
      // burst, so the two facts are measured separately: a small burst proves
      // the budget still refuses, and a SERIALISED run of the same twenty
      // proves the guards themselves refuse every caller, one at a time,
      // with no contention to hide behind.
      const RATE_LIMITED = "rate_limited";
      const stressModel = await proposeWithModel("Owner picked a model under load",
        { model: "model:any", effort: "high" });
      const stressModelOffer = await offerOf(stressModel);
      await setEligible(["codex"]);
      const stressRestrictedOffer = await offerFixture("elig-restricted-load");
      const burst = await Promise.all(Array.from({ length: 8 }, (_unused, index) => bot.call("claim",
        { offerId: stressModelOffer, idempotencyKey: `elig-load-model-${index}` })));
      const throttled = burst.filter(call => call.refusalCode === RATE_LIMITED).length;
      process.stderr.write(`dogfood eligibility burst: ${burst.length} parallel callers,`
        + ` ${throttled} throttled by the per-IP budget\n`);
      assert.ok(throttled > 0, "the per-IP budget still refuses a parallel burst");
      for (const call of burst) assert.equal(call.refused, true,
        `a burst never got past the guard: ${call.text}`);
      const serial = [];
      for (let index = 0; index < 20; index += 1) serial.push(await bot.call("claim",
        { offerId: stressModelOffer, idempotencyKey: `elig-serial-model-${index}` }));
      const judged = serial.filter(call => call.refusalCode === "conflict").length;
      process.stderr.write(`dogfood eligibility serial: ${serial.length} callers,`
        + ` ${judged} refused as a conflict by the model guard\n`);
      assert.equal(judged, 20, "the model guard refuses every caller, not only the first");
      for (const call of serial) assert.equal(call.refused, true,
        `the model guard let a caller through under a repeated attempt: ${call.text}`);
      const kindsSerial = [];
      for (let index = 0; index < 20; index += 1) kindsSerial.push(await bot.call("claim",
        { offerId: stressRestrictedOffer, idempotencyKey: `elig-serial-kinds-${index}` }));
      assert.equal(kindsSerial.filter(call => call.refusalCode === "conflict").length, 20,
        "the eligible-kinds guard refuses every caller, not only the first");
      // And a claim that IS allowed still works after all that contention.
      await setEligible(null);
      const afterLoad = await claimCode(await offerFixture("elig-after-load"), "elig-after-load-0001");
      assert.equal(afterLoad.refused, false, `a claim still works after the burst: ${afterLoad.text}`);

      // The whole run answered every refusal. A guard that threw instead of
      // refusing would land in the operator log, and the assertion above
      // already proved no fault fires at all.
      assert.deepEqual(unexpected, [], "the whole eligibility run logged no gateway fault");
    } finally {
      for (const item of servers) await close(item);
      for (const item of [admin, web, fleet, fleetOwner]) {
        try { await item.close(); } catch { /* already stopped */ }
      }
      for (const workspace of workspaces) await removeBotWorkspaceV1(workspace);
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
});
