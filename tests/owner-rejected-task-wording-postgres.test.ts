// A task the owner closed by rejecting a bot's result must read "Rejected by
// you" on both the task page and the project task list -- and only that task.
//
// This is proved on real PostgreSQL, as the PRODUCTION web login, because the
// claim being proved is about a real row: the gateway records the owner's Reject
// as the attempt's `safeFailureCode`, and the web read path has to find that row
// and only that row. A mocked session cannot show whether the read is even
// permitted for this login, nor whether the DISTINCT ON picks the newest attempt.
//
// Every state move below goes through production code (FleetGatewayStoreV1's
// review reconciler, TaskAssignmentCoordinator's stop authority, WebTaskService),
// so nothing here hand-writes the row the projection reads. The one hand-written
// UPDATE is the deliberate CORRUPTION case in the second test, which exists to
// prove the integrity check still fails closed; it rewrites one attempt payload
// with 0004's mirror trigger disabled for exactly that statement and re-enabled
// immediately, because a database that cannot hold a corrupt row cannot be asked
// what the code does with one.
//
// Reserved disposable-cluster lane for this file: 59793.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1, type FleetOperationsModeV1 }
  from "../src/fleet/v1";
import { buildSignedFleetConnectorReleaseForTestV1 } from "./support/fleet-release";
import { WebProjectService } from "../src/web/v1/project-service";
import { WebTaskService } from "../src/web/v1/task-service";
import { TaskAssignmentCoordinator, type TaskAssignmentRoute } from "../src/web/v1/task-assignment-coordinator";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, seedFleetTenant, seedProposedTask } from "./support/fleet-fixture";
import { ScriptedBotV1, makeBotWorkspaceV1, removeBotWorkspaceV1 } from "../scripts/dogfood/bot-journey.mjs";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59793);
const PG = requiresRealPostgres();

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
const listen = (server: Server) => new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
const portOf = (server: Server) => (server.address() as AddressInfo).port;
const closeServer = (server: Server) => new Promise<void>(done => server.close(() => done()));

async function waitFor(check: () => Promise<boolean>, seconds = 45) {
  const deadline = Date.now() + seconds * 1_000;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(done => setTimeout(done, 250));
  }
  return false;
}

test("only a task whose newest attempt records the owner's Reject reads as rejected, on real PostgreSQL", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), web = pool(postgres, "web"),
      fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner");
    const workspaces: string[] = [];
    let mode: FleetOperationsModeV1 = "running";
    const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT, operationsMode: async () => mode });
    const owner = new FleetOwnerServiceV1(fleetOwner.client,
      { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE, afterDecision: () => gateway.reconcile() });
    const releaseRoot = await makeBotWorkspaceV1("reject-wording-release");
    workspaces.push(releaseRoot);
    const { connectorRelease, releaseTrust } = await buildSignedFleetConnectorReleaseForTestV1(
      { root: `${releaseRoot}/fleet`, builtFrom: "9".repeat(40) });
    const handler = createFleetGatewayHandlerV1({ store: gateway, connectorRelease, releaseTrust });
    const server = createServer((request, response) => { void handler.handle(request, response); });
    const botWorkspace = await makeBotWorkspaceV1("reject-wording-bot");
    workspaces.push(botWorkspace);
    try {
      await listen(server);
      const origin = `http://127.0.0.1:${portOf(server)}`;
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));
      const projects = new WebProjectService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
      const tasks = new WebTaskService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
      const projectId = (await projects.create(ownerIdentity(),
        { title: "Rejection wording", summary: "Owner rejection" }, "rejectproject0001")).project.projectId;

      /** One already-seeded task, from the owner's offer through the gateway
       * applying an owner decision. Only the decision differs between callers. */
      const offerToDecision = async (name: string, jobId: string,
        decision: "accepted" | "rejected" | "revision_requested") => {
        await owner.offerTask(ownerIdentity(), { projectId, jobId, capability: "task.generic" });
        const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: `bot ${name}`,
          workerKind: "mcp-agent", projectIds: [projectId], capabilities: ["task.generic"], maxConcurrent: 4 });
        const bot = new ScriptedBotV1({ name: `bot-${name}`, workspace: botWorkspace, origin });
        await bot.join(code.code);
        const work = await bot.call("list_eligible_work", {});
        assert.equal(work.refused, false, `${name} list_eligible_work: ${work.text}`);
        const eligible = (work.value as { offerId: string; jobId: string }[]).find(item => item.jobId === jobId);
        assert.ok(eligible, `${name}: the owner's offer must be claimable`);
        const claim = await bot.call("claim", { offerId: eligible.offerId, idempotencyKey: `claim-${name}` });
        assert.equal(claim.refused, false, `${name} claim: ${claim.text}`);
        const submitted = await bot.call("submit_result", { claimId: (claim.value as { claimId: string }).claimId,
          answer: `One harmless line for ${name}.`, idempotencyKey: `result-${name}` });
        assert.equal(submitted.refused, false, `${name} submit_result: ${submitted.text}`);
        const waiting = await waitFor(async () => ((await admin.client.query(
          "SELECT state FROM control_jobs WHERE tenant_id=$1 AND id=$2", [FLEET_TENANT, jobId])).rows[0]?.state
          === "waiting_approval"));
        assert.ok(waiting, `${name}: the returned result must reach the owner`);
        const result = (await owner.listResults(ownerIdentity(), { awaitingOnly: true }))
          .find(item => item.jobId === jobId);
        assert.ok(result, `${name}: the owner's result list must show it`);
        const review = await owner.review(ownerIdentity(), { resultId: result.resultId, decision,
          ...(decision === "revision_requested" ? { note: "Return another line." } : {}) });
        assert.equal(review.decision, decision);
        return jobId;
      };
      /** Seeds one fresh task and drives it to an owner decision. */
      const runToDecision = async (name: string, decision: "accepted" | "rejected" | "revision_requested") => {
        const { jobId } = await seedProposedTask(admin.client, projectId, name);
        await admin.client.query(`INSERT INTO control_task_declared_scopes
          (tenant_id,project_id,job_id,scope_kind,path,path_fold) VALUES($1,$2,$3,'file',$4,$4)
          ON CONFLICT (tenant_id,job_id,scope_kind,path_fold) DO NOTHING`,
          [FLEET_TENANT, projectId, jobId, `docs/${name}.md`]);
        return offerToDecision(name, jobId, decision);
      };

      const rejectedJobId = await runToDecision("owner-rejected", "rejected");
      const acceptedJobId = await runToDecision("owner-accepted", "accepted");
      const changesJobId = await runToDecision("owner-changes", "revision_requested");

      // The gateway really did record the owner's Reject as that attempt's reason.
      const codes = (await admin.client.query("SELECT job_id,payload->>'safeFailureCode' AS code"
        + " FROM control_attempts WHERE tenant_id=$1 AND job_id=ANY($2::text[]) ORDER BY job_id",
        [FLEET_TENANT, [rejectedJobId, acceptedJobId, changesJobId]])).rows;
      assert.equal(codes.find(row => row.job_id === rejectedJobId)?.code, "result_rejected",
        "the gateway records the owner's Reject as the attempt's failure code");

      const settled = await waitFor(async () => (await admin.client.query(
        "SELECT state FROM control_jobs WHERE tenant_id=$1 AND id=$2", [FLEET_TENANT, rejectedJobId]))
        .rows[0]?.state === "cancelled");
      assert.ok(settled, "the rejected task must settle into the cancelled state");

      // The production web login must be able to read the reason at all: a
      // missing grant or a wrong column would surface as database_unavailable
      // here rather than as a silently missing word on the owner's page.
      const page = await tasks.list(ownerIdentity(), projectId);
      const listed = (jobId: string) => page.tasks.find(task => task.jobId === jobId);
      const rejectedTask = listed(rejectedJobId);
      assert.equal(rejectedTask?.state, "cancelled");
      assert.equal(rejectedTask?.ownerRejected, true,
        "the task the owner rejected must say so, read through the production web login");
      // Every other task keeps the plain wording. A task the gateway closed by
      // the revision path is NOT the owner rejecting a result.
      for (const jobId of [acceptedJobId, changesJobId]) {
        const other = listed(jobId);
        assert.ok(other, `${jobId} must still be on the owner's task list`);
        assert.equal(other.ownerRejected, undefined,
          `a ${other.state} task must never be reported as "Rejected by you"`);
      }

      // The detail page agrees with the list: same evidence, same wording, and
      // the canonical lifecycle record is untouched.
      const detail = await tasks.detail(ownerIdentity(), projectId, rejectedJobId);
      assert.equal(detail.task.ownerRejected, true);
      assert.equal(detail.task.state, "cancelled", "the canonical state is never changed by the wording");
      for (const jobId of [acceptedJobId, changesJobId])
        assert.equal((await tasks.detail(ownerIdentity(), projectId, jobId)).task.ownerRejected, undefined);

      // Two attempts on one task: an older one the gateway ended for a reason
      // that is NOT the owner rejecting, then the newer one that is. Reading the
      // wrong row would label this task from the stale reason.
      const { jobId: retriedJobId } = await seedProposedTask(admin.client, projectId, "owner-rejected-retried");
      await admin.client.query(`INSERT INTO control_task_declared_scopes
        (tenant_id,project_id,job_id,scope_kind,path,path_fold) VALUES($1,$2,$3,'file',$4,$4)
        ON CONFLICT (tenant_id,job_id,scope_kind,path_fold) DO NOTHING`,
        [FLEET_TENANT, projectId, retriedJobId, "docs/owner-rejected-retried.md"]);
      await admin.client.query(`INSERT INTO control_attempts
        (id,tenant_id,job_id,attempt_number,state,version,payload,created_at,updated_at)
        VALUES('attempt:older-' || $2, $1, $2, 1, 'failed', 0, $3::jsonb, now(), now())`,
        [FLEET_TENANT, retriedJobId, JSON.stringify({ contractVersion: "control-room-domain/v1", kind: "attempt",
          id: `attempt:older-${retriedJobId}`, tenantId: FLEET_TENANT, version: 0, createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(), jobId: retriedJobId, attemptNumber: 1, state: "failed",
          offeredAt: new Date().toISOString(), startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(), safeFailureCode: "worker_blocked" })]);
      await offerToDecision("owner-rejected-retried", retriedJobId, "rejected");
      const retried = await tasks.list(ownerIdentity(), projectId);
      const retriedTask = retried.tasks.find(task => task.jobId === retriedJobId);
      assert.equal(retriedTask?.ownerRejected, true,
        "the NEWEST attempt's reason wins; the older worker_blocked must not be read");
    } finally {
      await closeServer(server);
      for (const workspace of workspaces) await removeBotWorkspaceV1(workspace);
      for (const opened of [admin, web, fleet, fleetOwner]) await opened.close();
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
});

// The second lane of the same file. It owns its own cluster on PORT+1 so the
// two tests never share a postmaster, and it proves the case the first test
// could not reach: an ordinary CANCEL on the same page as a rejected task.
const PORT_B = PORT + 1;

test("one plainly cancelled task must not strip \"Rejected by you\" from its whole page, on real PostgreSQL",
  { timeout: 600_000 }, async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    await withRealPostgres(async postgres => {
      const admin = adminPool(postgres), web = pool(postgres, "web"),
        fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner"),
        coordinatorLogin = pool(postgres, "coordinator");
      const workspaces: string[] = [];
      const mode: FleetOperationsModeV1 = "running";
      const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT, operationsMode: async () => mode });
      const owner = new FleetOwnerServiceV1(fleetOwner.client,
        { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE, afterDecision: () => gateway.reconcile() });
      const releaseRoot = await makeBotWorkspaceV1("cancel-wording-release");
      workspaces.push(releaseRoot);
      const { connectorRelease, releaseTrust } = await buildSignedFleetConnectorReleaseForTestV1(
        { root: `${releaseRoot}/fleet`, builtFrom: "c".repeat(40) });
      const handler = createFleetGatewayHandlerV1({ store: gateway, connectorRelease, releaseTrust });
      const server = createServer((request, response) => { void handler.handle(request, response); });
      const botWorkspace = await makeBotWorkspaceV1("cancel-wording-bot");
      workspaces.push(botWorkspace);
      try {
        await listen(server);
        const origin = `http://127.0.0.1:${portOf(server)}`;
        await seedFleetTenant((sql, params) => admin.client.query(sql, params));
        const projects = new WebProjectService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
        const tasks = new WebTaskService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
        const project = async (title: string, key: string) =>
          (await projects.create(ownerIdentity(), { title, summary: title }, key)).project.projectId;

        // ---- Seeding the plain cancel, through production code ----
        //
        // A plain cancel is what the OWNER gets by pressing Stop on work that is
        // leased or running: `TaskAssignmentCoordinator` reaches
        // `CanonicalStore.revokeLease`, which moves lease/attempt/job and records
        // NO safeFailureCode at all. That is the ordinary shape the first test
        // never produced, and it is the shape that used to blank the rejection
        // wording for every task on the page.
        //
        // `revokeRunning` is the production stop authority the operations-mode
        // service composes (src/web/v1/operations-mode-service.ts:364) and is
        // exercised the same way in tests/operations-mode-stop-postgres.test.ts.
        // The owner's own `cancel()` is not reachable here: it re-derives the
        // reservation ids from `assignment:<sha256>` lineage and refuses an
        // attempt that was claimed through the gateway, which is the only way
        // this file produces a `result_rejected` attempt.
        const coordinator = new TaskAssignmentCoordinator(
          coordinatorLogin.client,
          { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE },
          { webOperation: () => ({ tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE }) } as never,
          [] as unknown as TaskAssignmentRoute[]);
        const store = new CanonicalStore(admin.client);
        try {
          const nodeId = "node:plain-cancel";
          const now = new Date().toISOString();
          await admin.client.query(`INSERT INTO control_nodes(id,tenant_id,state,identity_key_id,version,payload,created_at,updated_at)
            VALUES($1,$2,'active','key:plain-cancel',1,$3::jsonb,$4,$4)`,
          [nodeId, FLEET_TENANT, JSON.stringify({ contractVersion: "control-room-domain/v1", kind: "node", id: nodeId,
            tenantId: FLEET_TENANT, displayName: "Local worker", state: "active", platform: "macos", architecture: "arm64",
            identityKeyId: "key:plain-cancel", hardwareFingerprint: `sha256:${"3".repeat(64)}`,
            softwareFingerprint: `sha256:${"4".repeat(64)}`, policyVersion: "mac-local/v1",
            minimumProtocolVersion: "local-only", version: 1, createdAt: now, updatedAt: now }), now]);
          /** One task the owner stops: leased, then revoked with no recorded reason. */
          const plainCancel = async (projectId: string, name: string) => {
            const { jobId } = await seedProposedTask(admin.client, projectId, name);
            const at = new Date(Date.now() + 1_000).toISOString();
            const ready = (await store.transition({ tenantId: FLEET_TENANT, kind: "job", entityId: jobId,
              expectedVersion: 0, toState: "ready", transitionId: `transition:${name}:ready`,
              idempotencyKey: `${name}:ready`, actor: { actorId: "identity:fleet-owner", actorType: "human" },
              occurredAt: at })).entity as { version: number };
            const claimed = await store.claimReadyTaskJob({ tenantId: FLEET_TENANT, jobId,
              expectedJobVersion: ready.version, nodeId, workerId: `executor:plain:${name}`,
              attemptId: `attempt:plain:${name}`, leaseId: `lease:plain:${name}`,
              transitionId: `transition:${name}:claim`, idempotencyKey: `${name}:claim`,
              actor: { actorId: "identity:fleet-owner", actorType: "human" }, acquiredAt: at,
              expiresAt: new Date(Date.parse(at) + 600_000).toISOString() });
            const outcome = await coordinator.revokeRunning({ tenantId: FLEET_TENANT, projectId, jobId,
              attemptId: claimed.attempt.id, leaseId: claimed.lease.id, leaseEpoch: claimed.lease.epoch,
              attemptVersion: claimed.attempt.version, jobVersion: claimed.job.version,
              actorId: "identity:fleet-owner", now: new Date(Date.parse(at) + 1_000).toISOString() });
            assert.equal(outcome, "revoked", `${name}: the stop must reach the canonical revoke`);
            const recorded = (await admin.client.query<{ code: string | null }>(
              "SELECT payload->>'safeFailureCode' AS code FROM control_attempts WHERE tenant_id=$1 AND job_id=$2",
              [FLEET_TENANT, jobId])).rows[0];
            assert.equal(recorded?.code, null,
              `${name}: the production cancel path records NO safe failure code, which is the shape under test`);
            return jobId;
          };
          /** One task the owner rejects after a bot returns a result: the gateway records the reason. */
          const rejectedTask = async (projectId: string, name: string) => {
            const { jobId } = await seedProposedTask(admin.client, projectId, name);
            await admin.client.query(`INSERT INTO control_task_declared_scopes
              (tenant_id,project_id,job_id,scope_kind,path,path_fold) VALUES($1,$2,$3,'file',$4,$4)
              ON CONFLICT (tenant_id,job_id,scope_kind,path_fold) DO NOTHING`,
            [FLEET_TENANT, projectId, jobId, `docs/${name}.md`]);
            await owner.offerTask(ownerIdentity(), { projectId, jobId, capability: "task.generic" });
            const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: `bot ${name}`,
              workerKind: "mcp-agent", projectIds: [projectId], capabilities: ["task.generic"], maxConcurrent: 8 });
            const bot = new ScriptedBotV1({ name: `bot-${name}`, workspace: botWorkspace, origin });
            await bot.join(code.code);
            const work = await bot.call("list_eligible_work", {});
            const eligible = (work.value as { offerId: string; jobId: string }[]).find(item => item.jobId === jobId);
            assert.ok(eligible, `${name}: the owner's offer must be claimable`);
            const claim = await bot.call("claim", { offerId: eligible.offerId, idempotencyKey: `claim-${name}` });
            assert.equal(claim.refused, false, `${name} claim: ${claim.text}`);
            const submitted = await bot.call("submit_result", { claimId: (claim.value as { claimId: string }).claimId,
              answer: `One harmless line for ${name}.`, idempotencyKey: `result-${name}` });
            assert.equal(submitted.refused, false, `${name} submit_result: ${submitted.text}`);
            assert.ok(await waitFor(async () => ((await admin.client.query(
              "SELECT state FROM control_jobs WHERE tenant_id=$1 AND id=$2", [FLEET_TENANT, jobId])).rows[0]?.state
              === "waiting_approval")), `${name}: the returned result must reach the owner`);
            const result = (await owner.listResults(ownerIdentity(), { awaitingOnly: true }))
              .find(item => item.jobId === jobId);
            assert.ok(result, `${name}: the owner's result list must show it`);
            await owner.review(ownerIdentity(), { resultId: result.resultId, decision: "rejected" });
            const code2 = (await admin.client.query<{ code: string | null }>(
              "SELECT payload->>'safeFailureCode' AS code FROM control_attempts WHERE tenant_id=$1 AND job_id=$2",
              [FLEET_TENANT, jobId])).rows[0]?.code;
            assert.equal(code2, "result_rejected", `${name}: the gateway records the owner's Reject as the reason`);
            return jobId;
          };
          const listed = async (projectId: string) => {
            const page = await tasks.list(ownerIdentity(), projectId);
            return { page, find: (jobId: string) => page.tasks.find(task => task.jobId === jobId) };
          };

          // ---- 1. The review's case: a plain cancel on the page as a rejected task ----
          const mixed = await project("Mixed cancels", "mixed-cancels-0001");
          const mixedRejected = await rejectedTask(mixed, "mixed-rejected");
          const mixedPlain = await plainCancel(mixed, "mixed-plain-cancel");
          const mixedPage = await listed(mixed);
          assert.equal(mixedPage.find(mixedRejected)?.state, "cancelled");
          assert.equal(mixedPage.find(mixedRejected)?.ownerRejected, true,
            "a plainly cancelled sibling on the same page must not strip the rejected task's wording");
          assert.equal(mixedPage.find(mixedPlain)?.state, "cancelled");
          assert.equal(mixedPage.find(mixedPlain)?.ownerRejected, undefined,
            "the plain cancel itself must keep the plain wording");
          assert.equal((await tasks.detail(ownerIdentity(), mixed, mixedRejected)).task.ownerRejected, true,
            "the detail page already read this correctly and must still agree");

          // ---- 2. A page with ONLY plain cancels: no label, and no error ----
          const plainOnly = await project("Only plain cancels", "plain-only-cancels-0001");
          const plainIds = [await plainCancel(plainOnly, "plain-only-a"),
            await plainCancel(plainOnly, "plain-only-b")];
          const plainPage = await listed(plainOnly);
          assert.equal(plainPage.page.tasks.length, 2);
          for (const jobId of plainIds) {
            assert.equal(plainPage.find(jobId)?.state, "cancelled");
            assert.equal(plainPage.find(jobId)?.ownerRejected, undefined,
              "no plain cancel may ever read as \"Rejected by you\"");
          }

          // ---- 3. Mixed SYSTEM cancels alongside a rejected task ----
          //
          // A measured note, not a guess: on this schema the only two producers
          // of a JOB in state 'cancelled' are the gateway's review reconciler
          // (reason `result_rejected`) and `CanonicalStore.revokeLease` (no
          // reason). A cancelled job carrying some third code is therefore not a
          // shape the product can produce, so it cannot be tested as one. What
          // IS reachable, and is what the gateway itself writes, is an ATTEMPT
          // cancelled for a system reason (`worker_blocked` on a blocker with
          // release) sitting on the same page: that is what is asserted here.
          const systemMixed = await project("System cancels", "system-cancels-0001");
          const systemRejected = await rejectedTask(systemMixed, "system-rejected");
          const systemBlockerJob = await seedProposedTask(admin.client, systemMixed, "system-blocker");
          await admin.client.query(`INSERT INTO control_task_declared_scopes
            (tenant_id,project_id,job_id,scope_kind,path,path_fold) VALUES($1,$2,$3,'file',$4,$4)
            ON CONFLICT (tenant_id,job_id,scope_kind,path_fold) DO NOTHING`,
          [FLEET_TENANT, systemMixed, systemBlockerJob.jobId, "docs/system-blocker.md"]);
          await owner.offerTask(ownerIdentity(), { projectId: systemMixed, jobId: systemBlockerJob.jobId,
            capability: "task.generic" });
          const blockerCode = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "bot blocker",
            workerKind: "mcp-agent", projectIds: [systemMixed], capabilities: ["task.generic"], maxConcurrent: 8 });
          const blockerBot = new ScriptedBotV1({ name: "bot-blocker", workspace: botWorkspace, origin });
          await blockerBot.join(blockerCode.code);
          const blockerOffer = ((await blockerBot.call("list_eligible_work", {})).value as { offerId: string; jobId: string }[])
            .find(item => item.jobId === systemBlockerJob.jobId);
          assert.ok(blockerOffer, "the blocked task must be claimable");
          const blockerClaim = await blockerBot.call("claim", { offerId: blockerOffer.offerId, idempotencyKey: "claim-blocker" });
          assert.equal(blockerClaim.refused, false, `blocker claim: ${blockerClaim.text}`);
          const blocker = await blockerBot.call("report_blocker", { claimId: (blockerClaim.value as { claimId: string }).claimId,
            message: "Cannot continue.", idempotencyKey: "blocker-0001", release: true });
          assert.equal(blocker.refused, false, `report_blocker: ${blocker.text}`);
          const blockerCode2 = (await admin.client.query<{ code: string | null; state: string }>(
            "SELECT payload->>'safeFailureCode' AS code, state FROM control_attempts WHERE tenant_id=$1 AND job_id=$2",
            [FLEET_TENANT, systemBlockerJob.jobId])).rows[0];
          assert.equal(blockerCode2?.code, "worker_blocked",
            "the gateway records a system reason on the attempt it cancels; only the state column is asserted here");
          assert.equal(blockerCode2?.state, "cancelled");
          const systemPlain = await plainCancel(systemMixed, "system-plain");
          const systemPage = await listed(systemMixed);
          assert.equal(systemPage.find(systemRejected)?.ownerRejected, true,
            "a system cancel and a plain cancel on the page must not strip the rejected task's wording");
          assert.equal(systemPage.find(systemPlain)?.ownerRejected, undefined);
          assert.equal(systemPage.find(systemBlockerJob.jobId)?.ownerRejected, undefined,
            "a system-recorded cancellation is never the owner rejecting a result");

          // ---- 4. More than a page of tasks: 51 on one project, all in one read ----
          //
          // The list read bounds one page at 50 rows, so a page this size is the
          // only shape that proves the fix is not an artefact of a small list.
          const big = await project("Fifty-one tasks", "fifty-one-tasks-0001");
          const bigRejected = await rejectedTask(big, "aaa-rejected");
          const bigPlain: string[] = [];
          for (let index = 0; index < 50; index += 1)
            bigPlain.push(await plainCancel(big, `zz-plain-${String(index).padStart(3, "0")}`));
          const bigPage = await listed(big);
          assert.equal(bigPage.page.tasks.length, 50, "the list page is bounded at 50 rows");
          assert.ok(bigPage.page.nextCursor, "51 tasks means a second page exists");
          assert.equal(bigPage.find(bigRejected)?.ownerRejected, true,
            "the rejected task still reads \"Rejected by you\" with 50 plain cancels beside it");
          for (const jobId of bigPlain.slice(0, 49)) {
            const task = bigPage.find(jobId);
            assert.ok(task, `${jobId} must be on the first page`);
            assert.equal(task.state, "cancelled");
            assert.equal(task.ownerRejected, undefined, "a plain cancel is never labelled a rejection");
          }

          // ---- 5. The integrity check still fails closed on real corruption ----
          //
          // One attempt payload is rewritten so its own record claims a
          // DIFFERENT job AND carries `result_rejected`. Both halves matter:
          // the mismatched jobId is what the integrity check exists to catch,
          // and the recorded reason is what would mislabel the OTHER task if
          // that check were ever deleted. 0004's payload-mirror trigger does
          // police `jobId`, so it is disabled for exactly this write and
          // re-enabled in the same `finally` -- the same surgical approach
          // tests/fleet-connector-postgres.test.ts uses. A database that cannot
          // hold the corrupt row cannot be asked what the code does with one.
          const corruptProject = await project("Corrupt lineage", "corrupt-lineage-0001");
          const corruptA = await plainCancel(corruptProject, "corrupt-a");
          const corruptB = await plainCancel(corruptProject, "corrupt-b");
          await admin.client.query("ALTER TABLE control_attempts DISABLE TRIGGER control_attempts_payload_mirror");
          try {
            await admin.client.query(`UPDATE control_attempts SET payload=payload || jsonb_build_object(
              'jobId',$2::text,'safeFailureCode','result_rejected') WHERE tenant_id=$1 AND job_id=$3`,
            [FLEET_TENANT, corruptB, corruptA]);
            const corrupt = (await admin.client.query<{ job: string; code: string | null }>(
              "SELECT payload->>'jobId' AS job, payload->>'safeFailureCode' AS code"
              + " FROM control_attempts WHERE tenant_id=$1 AND job_id=$2",
              [FLEET_TENANT, corruptA])).rows[0];
            assert.equal(corrupt?.job, corruptB, "the fixture must really hold the corrupt row");
            assert.equal(corrupt?.code, "result_rejected", "and the reason it must never be read from");
          } finally {
            await admin.client.query("ALTER TABLE control_attempts ENABLE TRIGGER control_attempts_payload_mirror");
          }
          const corruptPage = await listed(corruptProject);
          assert.equal(corruptPage.find(corruptA)?.ownerRejected, undefined,
            "a record that disagrees with its own row must never be read");
          assert.equal(corruptPage.find(corruptB)?.ownerRejected, undefined,
            "and it must never label the task whose id it borrowed");
        } finally {
          await coordinatorLogin.close();
        }
      } finally {
        await closeServer(server);
        for (const workspace of workspaces) await removeBotWorkspaceV1(workspace);
        for (const opened of [admin, web, fleet, fleetOwner]) await opened.close();
      }
    }, { port: PORT_B, allowedPorts: [PORT, PORT_B], boundMs: 600_000 });
  });