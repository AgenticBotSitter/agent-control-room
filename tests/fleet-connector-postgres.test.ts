// Real-PostgreSQL proof for the fleet connector, run AS the production
// logins that execute each step, with only the grants the real db/roles files
// give them:
// - owner actions (codes, offers, revocation, reviews): the private web login;
// - the connector gateway (enroll, claim, progress, results, reconcile): the
//   dedicated fleet gateway login, group control_room_fleet_gateway;
// - migrations: the real applier as the schema owner.
// The attack kit provisions a disposable socket-only cluster on this file's
// reserved port lane (58640-58649), or the test runner's assigned port block
// so concurrent runs never collide, and destroys it afterwards.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { privateWebSchemaDigest, readPrivateWebSchemaDigest, verifyPrivateDatabase } from "../src/web/v1/private-database-preflight";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1, FleetWaitRegistryV1 } from "../src/fleet/v1";
import { createFleetGatewayStoreFromConfigurationV1 } from "../scripts/run-fleet-gateway";
import { SupervisorReconcilerV1 } from "../src/supervisor/v1";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, PROJECT_B, seedFleetTenant,
  seedProposedTask } from "./support/fleet-fixture";
// The connector is a dependency-free .mjs shipped to worker machines.
import * as connector from "../scripts/fleet/connector.mjs";

const PORT = Number(process.env.FLEET_CONNECTOR_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 58640);
const PG = requiresRealPostgres();

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, config, close: () => bound.close() };
}
function adminPool(postgres: RealPostgres) {
  const admin = postgres.admin({ database: postgres.database });
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database, username: admin.user,
    password: admin.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: admin.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}
const sqlState = (error: unknown) => (error as { code?: string }).code;

test("fleet connector end to end and least privilege, as the production logins", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), web = pool(postgres, "web"), fleet = pool(postgres, "fleet"),
      coordinator = pool(postgres, "coordinator"),
      fleetOwner = pool(postgres, "fleetOwner"), workIntake = pool(postgres, "control_room_work_intake_agent");
    const dir = await mkdtemp(join(tmpdir(), "fleet-pg-"));
    // The real standalone composition: the fleet login reads the authenticated
    // mode journal (empty here, so running) with the installation key.
    const gateway = createFleetGatewayStoreFromConfigurationV1(fleet.client, { tenantId: FLEET_TENANT,
      workIntake: { database: {} as never, integrityKey: Buffer.alloc(32, 3).toString("base64url") } });
    const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
      afterDecision: () => gateway.reconcile() });
    const proposals = new WorkBatchServiceV1(new WorkBatchStoreV1(workIntake.client, new Uint8Array(32).fill(3)));
    const unexpected: unknown[] = [];
    const handler = createFleetGatewayHandlerV1({ store: gateway, proposals,
      waitRegistry: new FleetWaitRegistryV1({ waitMs: 60, pollMs: 10 }),
      onUnexpectedError: error => { unexpected.push(error); console.error(error); } });
    const server = createServer((request, response) => { void handler.handle(request, response); });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const direct = async (role: string, sql: string, params: unknown[] = []) => {
      const client = new Client(postgres.connection(role)); await client.connect();
      try { return await client.query(sql, params); } finally { await client.end(); }
    };
    // A long-lived superuser connection for fixture surgery only. `direct`
    // opens a connection per call, which is right for assertions and wrong for
    // the suspend/restore pairs below; this one also raises the real refusal
    // message rather than the driver's sanitized wrapper.
    const surgeon = new Client(postgres.admin({ database: postgres.database }));
    await surgeon.connect();
    try {
      assert.equal(await readPrivateWebSchemaDigest(admin.client), privateWebSchemaDigest,
        "the recorded private web schema digest matches a live cluster with 0141 applied");
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));
      // The existing exact-privilege preflights still pass with the fleet
      // grants and guards installed: no new definer-rights function, and the
      // web login's fleet rights are exactly the declared owner-decision set. The
      // definer-function and EXECUTE rules this checks apply to every role.
      const scope = { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE, ownerIdentityId: "identity:fleet-owner", issuer: "test" };
      await verifyPrivateDatabase(web.client, web.config, scope, Date.now(), { nativeQueue: true });
      const task = await seedProposedTask(admin.client, PROJECT_A, "pg-1");
      const betaTask = await seedProposedTask(admin.client, PROJECT_B, "pg-beta");
      const untouched = await seedProposedTask(admin.client, PROJECT_A, "pg-not-offered");

      // --- Owner (web login) creates a code; the machine joins (fleet login).
      const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "PG worker", workerKind: "mcp-agent",
        projectIds: [PROJECT_A], capabilities: ["writing"], maxConcurrent: 2 });
      const configPath = join(dir, "worker.json");
      const joined = await connector.join({ server: origin, code: code.code, workerKind: "mcp-agent", configPath });
      assert.deepEqual(Object.keys(joined.workingAgreement).sort(), ["digest", "grantsAuthority", "startsWork", "text", "version"]);
      const client = connector.createClient(await connector.loadConfig(configPath));
      const dispatch = connector.createMcpDispatcher({ client, workspaceRoot: dir });
      let mcpId = 0;
      const mcpCall = async (name: string, args: Record<string, unknown>) => {
        const reply = await dispatch({ jsonrpc: "2.0", id: ++mcpId, method: "tools/call", params: { name, arguments: args } });
        assert.ok(reply && "result" in reply && !reply.result.isError, JSON.stringify(reply));
        return reply.result.structuredContent.result;
      };
      await assert.rejects(connector.join({ server: origin, code: code.code, workerKind: "mcp-agent",
        configPath: join(dir, "x.json") }), /unauthenticated/u,
        "a code is single use for the production gateway login too");

      // A committed redemption is recoverable only while the owner-issued
      // code remains live. Simulate a response lost after commit, then age the
      // immutable code as the schema owner and retry through the fleet login.
      const expiring = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "PG expired replay",
        workerKind: "mcp-agent", projectIds: [PROJECT_A], capabilities: ["writing"] });
      const expiringPath = join(dir, "expired-replay.json");
      const loseResponse: typeof fetch = async (...args) => {
        const response = await fetch(...args);
        await response.arrayBuffer();
        throw new Error("simulated lost enrollment response");
      };
      await assert.rejects(connector.join({ server: origin, code: expiring.code, workerKind: "mcp-agent", configPath: expiringPath,
        fetcher: loseResponse }), /simulated lost enrollment response/u);
      await admin.client.query("ALTER TABLE fleet_enrollment_codes DISABLE TRIGGER fleet_enrollment_codes_guard");
      try {
        await admin.client.query(`UPDATE fleet_enrollment_codes SET created_at=now()-interval '20 minutes',
          expires_at=now()-interval '10 minutes' WHERE id=$1`, [expiring.codeId]);
      } finally {
        await admin.client.query("ALTER TABLE fleet_enrollment_codes ENABLE TRIGGER fleet_enrollment_codes_guard");
      }
      await assert.rejects(connector.join({ server: origin, code: expiring.code, workerKind: "mcp-agent", configPath: expiringPath }),
        /unauthenticated/u, "the production fleet login refuses a matching replay after code expiry");

      // --- Offer, claim, progress, result, revision, resubmit, accept.
      const offered = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: task.jobId, capability: "writing" });
      await owner.offerTask(ownerIdentity(), { projectId: PROJECT_B, jobId: betaTask.jobId, capability: "writing" });
      const work = await mcpCall("list_eligible_work", {});
      assert.deepEqual(work.map((item: { jobId: string }) => item.jobId), [task.jobId], "other projects stay invisible");
      const claim = await mcpCall("claim", { offerId: offered.offerId, idempotencyKey: "pg-claim-key-0001" });
      assert.equal(claim.taskState, "leased");
      await client.progress(claim.claimId, "Working.", "pg-progress-key-01");
      await writeFile(join(dir, "note.txt"), "hello");
      const first = await mcpCall("submit_result", { claimId: claim.claimId, answer: "First try.", files: ["note.txt"],
        idempotencyKey: "pg-result-key-001" });
      await owner.review(ownerIdentity(), { resultId: first.resultId, decision: "revision_requested", note: "Add detail." });
      const again = await client.claim(offered.offerId, "pg-claim-key-0002");
      const second = await client.result(again.claimId, "Second try with detail.", [], "pg-result-key-002");
      await owner.review(ownerIdentity(), { resultId: second.resultId, decision: "accepted" });
      const job = await direct("web", "SELECT state FROM control_jobs WHERE id=$1", [task.jobId]);
      assert.equal(job.rows[0].state, "succeeded");

      // --- The gateway observes but never expires a fleet lease. The
      // production coordinator login is the one lease-expiry owner and records
      // both lapse count and the second-lapse incident/outbox proposal.
      const lapseTask = await seedProposedTask(admin.client, PROJECT_A, "pg-lapse");
      const lapseOffer = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: lapseTask.jobId,
        capability: "writing" });
      // An elapsed lease, aged the way a real machine that stops reporting
      // would age it: the acquisition moves back with the expiry, because
      // control_leases checks expires_at > acquired_at and 0004's payload
      // mirror compares both instants against the payload. Only the schema
      // owner may do this; the production coordinator cannot reach around it,
      // which is the point -- no application role can fake an expiry.
      const expireClaim = async (claimId: string) => admin.client.query(`UPDATE control_leases l
        SET acquired_at=statement_timestamp()-interval '30 seconds',
          expires_at=statement_timestamp()-interval '10 seconds',
          payload=l.payload
            || jsonb_build_object('acquiredAt', to_jsonb((statement_timestamp()-interval '30 seconds')::timestamptz))
            || jsonb_build_object('expiresAt', to_jsonb((statement_timestamp()-interval '10 seconds')::timestamptz))
        FROM fleet_claims fc WHERE fc.tenant_id=l.tenant_id AND fc.lease_id=l.id AND fc.claim_id=$1`, [claimId]);
      const firstLapseClaim = await client.claim(lapseOffer.offerId, "pg-lapse-claim-01");
      await expireClaim(firstLapseClaim.claimId);
      assert.deepEqual(await gateway.reconcile(), { reviews: 0, revocations: 0, leaseRevocations: 0 });
      assert.equal((await direct("web", "SELECT state FROM control_jobs WHERE id=$1", [lapseTask.jobId])).rows[0].state,
        "leased", "the production fleet login leaves the elapsed lease untouched");
      // A plain clock: a clock skewed into the future would stamp entities
      // ahead of the real HTTP claims that follow, and the canonical store's
      // transition-monotonicity guard would then refuse them.
      const supervisor = new SupervisorReconcilerV1(coordinator.client, FLEET_TENANT);
      const firstLapse = await supervisor.reconcileStalled();
      assert.equal(firstLapse.find(outcome => outcome.jobId === lapseTask.jobId)?.lapseNumber, 1);
      assert.equal((await direct("coordinator", `SELECT lapse_count FROM control_supervisor_task_heads
        WHERE tenant_id=$1 AND job_id=$2`, [FLEET_TENANT, lapseTask.jobId])).rows[0].lapse_count, "1");
      const secondLapseClaim = await client.claim(lapseOffer.offerId, "pg-lapse-claim-02");
      await expireClaim(secondLapseClaim.claimId);
      const secondLapse = (await Promise.all([supervisor.reconcileStalled(),supervisor.reconcileStalled()])).flat();
      const committedSecondLapse = secondLapse.filter(outcome => outcome.jobId === lapseTask.jobId&&!outcome.replayed);
      assert.equal(committedSecondLapse.length,1,"concurrent production-role sweeps commit one second-lapse event");
      assert.equal(committedSecondLapse[0]?.disposition, "needs_attention");
      assert.equal((await supervisor.reconcileStalled()).length, 0, "a retry emits no duplicate Needs-you item");
      assert.equal((await direct("coordinator", `SELECT count(*)::int AS count FROM control_action_inbox
        WHERE tenant_id=$1 AND kind='incident' AND payload->>'reasonCode'='second_stall_needs_attention'`,
      [FLEET_TENANT])).rows[0].count, 1);
      assert.equal((await direct("coordinator", `SELECT count(*)::int AS count FROM control_outbox
        WHERE tenant_id=$1 AND topic='service.incident.opened' AND aggregate_type='service_incident'
          AND payload->>'safeReasonCode'='second_stall_needs_attention'`,[FLEET_TENANT])).rows[0].count, 1,
      "migration 0196 admits the supervisor incident outbox shape for the production coordinator login");

      // --- MCP proposals use the production proposal-only intake login and
      // create only the S1 proposal record, never a task, lease or offer.
      const proposal = { schema: "control-room.work-batch-proposal/v1", projectId: PROJECT_A,
        tasks: [{ localId: "build", title: "Build", instructions: "Write the bounded change.",
          requiredCapability: "code.change", role: "builder", requestedWorkerKind: "worker:code",
          requestedModelKey: "model:any", acceptanceCriteria: "Checks pass.", acceptanceTests: "Run focused tests." }], edges: [] };
      const jobsBeforeProposal = (await direct("web", "SELECT count(*)::int AS count FROM control_jobs")).rows[0].count;
      const proposed = await mcpCall("propose_work", { projectId: PROJECT_A, proposal,
        idempotencyKey: "pg-propose-key-001" });
      assert.equal(proposed.state, "proposed");
      assert.equal(proposed.startsWork, false);
      assert.equal((await direct("web", "SELECT count(*)::int AS count FROM control_jobs")).rows[0].count, jobsBeforeProposal);
      assert.equal((await direct("web", "SELECT count(*)::int AS count FROM work_batches")).rows[0].count, 1);
      const mcpAudits = await direct("web", `SELECT safe_metadata->>'toolName' AS tool_name FROM audit_events
        WHERE action='fleet.mcp.called' ORDER BY chain_sequence`);
      assert.deepEqual(mcpAudits.rows.map(row => row.tool_name),
        ["list_eligible_work", "claim", "submit_result", "propose_work"]);

      // --- The gateway login cannot decide anything the owner decides.
      await assert.rejects(direct("fleet", `INSERT INTO fleet_result_reviews(tenant_id,review_id,result_id,decision,
        reviewed_by_identity_id,reviewed_at) VALUES($1,'fleet-review:${"1".repeat(32)}',$2,'accepted','identity:fleet-owner',now())`,
      [FLEET_TENANT, second.resultId]), (error: unknown) => sqlState(error) === "42501");
      await assert.rejects(direct("fleet", `UPDATE fleet_enrollment_codes SET state='revoked' WHERE tenant_id=$1`,
        [FLEET_TENANT]), (error: unknown) => sqlState(error) === "42501");
      await assert.rejects(direct("fleet", `INSERT INTO fleet_enrollment_redemptions(tenant_id,code_id,worker_id,
        client_nonce_digest,credential_digest,redeemed_at) SELECT tenant_id,id,worker_id,
        'sha256:${"8".repeat(64)}','sha256:${"9".repeat(64)}',now() FROM fleet_enrollment_codes LIMIT 1`),
      (error: unknown) => sqlState(error) === "42501", "direct gateway SQL cannot redeem an owner code");
      await assert.rejects(direct("fleet", "SELECT * FROM control_web_sessions"), (error: unknown) => sqlState(error) === "42501",
        "the gateway never reads owner sessions");
      await assert.rejects(direct("fleet", `UPDATE control_jobs SET updated_at=updated_at WHERE id=$1`, [untouched.jobId]),
        /job write rejected/u, "jobs that were never offered to the fleet are untouchable");
      await assert.rejects(direct("fleet", `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
        auth_subject_digest,state,created_at,updated_at) VALUES('identity:fleet:${"2".repeat(32)}',$1,'human','x','test',
        'sha256:${"3".repeat(64)}','active',now(),now())`, [FLEET_TENANT]), /identity write rejected/u);
      await assert.rejects(direct("fleet", `INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,
        project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        SELECT 'grant:fleet:${"4".repeat(32)}',tenant_id,identity_id,'owner','["*"]','["*"]','critical',true,false,now(),now()
        FROM fleet_workers`), /grant write rejected/u, "a worker identity can never be granted owner authority");
      await assert.rejects(direct("fleet", `UPDATE fleet_work_offers SET state='closed',close_reason='withdrawn',closed_at=now()
        WHERE job_id=$1`, [betaTask.jobId]), (error: unknown) => sqlState(error) === "42501");

      // A claimed job cannot be marked succeeded by the gateway without an owner acceptance.
      const pending = await seedProposedTask(admin.client, PROJECT_A, "pg-2");
      const pendingOffer = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: pending.jobId, capability: "writing" });
      const pendingClaim = await client.claim(pendingOffer.offerId, "pg-claim-key-0003");
      const overlapping = await seedProposedTask(admin.client, PROJECT_A, "pg-overlapping-scope");
      const overlappingOffer = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A,
        jobId: overlapping.jobId, capability: "writing" });
      await assert.rejects(client.claim(overlappingOffer.offerId, "pg-claim-key-overlap"),
        (error: any) => error.code === "conflict",
        "the bounded production pool maps its sqlState 23P01 scope refusal to conflict");
      await owner.withdrawOffer(ownerIdentity(), overlappingOffer.offerId);
      const leaseBeforeWait = await direct("web", `SELECT l.expires_at FROM control_leases l JOIN fleet_claims c
        ON c.tenant_id=l.tenant_id AND c.lease_id=l.id WHERE c.claim_id=$1`, [pendingClaim.claimId]);
      const presenceBeforeWait = await direct("web", "SELECT last_seen_at FROM fleet_worker_presence WHERE worker_id=$1", [joined.workerId]);
      await new Promise(done => setTimeout(done, 5));
      assert.deepEqual(await client.waitForWork(), { offers: [], operationsMode: "running" });
      const leaseAfterWait = await direct("web", `SELECT l.expires_at FROM control_leases l JOIN fleet_claims c
        ON c.tenant_id=l.tenant_id AND c.lease_id=l.id WHERE c.claim_id=$1`, [pendingClaim.claimId]);
      const presenceAfterWait = await direct("web", "SELECT last_seen_at FROM fleet_worker_presence WHERE worker_id=$1", [joined.workerId]);
      assert.equal(new Date(leaseAfterWait.rows[0].expires_at).toISOString(), new Date(leaseBeforeWait.rows[0].expires_at).toISOString(),
        "a parked wait never renews its active lease");
      assert.ok(new Date(presenceAfterWait.rows[0].last_seen_at) >= new Date(presenceBeforeWait.rows[0].last_seen_at),
        "the production fleet login records the wait as presence");
      await client.result(pendingClaim.claimId, "Unreviewed.", [], "pg-result-key-003");
      await assert.rejects(direct("fleet", `UPDATE control_jobs SET state='succeeded',
        payload=jsonb_set(payload,'{state}','"succeeded"') WHERE id=$1`, [pending.jobId]), /job write rejected/u);

      // --- The web login records decisions but cannot act as the gateway.
      await assert.rejects(direct("web", "SELECT * FROM fleet_gateway_role_anchor"), (error: unknown) => sqlState(error) === "42501");
      await assert.rejects(direct("web", `INSERT INTO fleet_result_reviews(tenant_id,review_id,result_id,decision,
        reviewed_by_identity_id,reviewed_at) VALUES($1,'fleet-review:${"7".repeat(32)}',$2,'accepted',
        'identity:fleet-owner',now())`, [FLEET_TENANT, second.resultId]),
      (error: unknown) => sqlState(error) === "42501", "the ordinary web login cannot forge an owner review");
      await assert.rejects(direct("web", `UPDATE fleet_workers SET state='revoked',revoked_at=now(),
        revoked_by_identity_id='identity:fleet-owner' WHERE tenant_id=$1`, [FLEET_TENANT]),
      (error: unknown) => sqlState(error) === "42501", "the ordinary web login cannot forge an owner revocation");
      await assert.rejects(direct("web", `UPDATE fleet_work_offers SET state='closed',close_reason='withdrawn',closed_at=now()
        WHERE tenant_id=$1`, [FLEET_TENANT]), (error: unknown) => sqlState(error) === "42501",
      "the ordinary web login cannot forge an offer withdrawal");
      await assert.rejects(direct("web", `INSERT INTO fleet_enrollment_codes(tenant_id,id,code_digest,purpose,worker_id,
        worker_kind,display_name,project_ids,capabilities,max_concurrent,created_by_identity_id,created_at,expires_at,state)
        VALUES($1,'fleet-code:${"6".repeat(32)}','sha256:${"7".repeat(64)}','join','fleet-worker:${"8".repeat(32)}',
        'mcp-agent','forged',ARRAY[$2],ARRAY['writing'],1,'identity:fleet-owner',now(),now()+interval '5 minutes','issued')`,
      [FLEET_TENANT, PROJECT_A]), (error: unknown) => sqlState(error) === "42501",
      "the ordinary web login cannot forge an enrollment");
      await assert.rejects(direct("web", `UPDATE fleet_enrollment_codes SET consumed_at=now()`), (error: unknown) => sqlState(error) === "42501");
      await assert.rejects(direct("web", `INSERT INTO fleet_worker_credentials(tenant_id,credential_id,worker_id,secret_digest,state,
        issued_at,expires_at,rotated_from_credential_id) SELECT tenant_id,'fleet-credential:${"5".repeat(32)}',worker_id,
        'sha256:${"6".repeat(64)}','active',now(),now()+interval '1 day',credential_id FROM fleet_worker_credentials LIMIT 1`),
      (error: unknown) => sqlState(error) === "42501");
      await assert.rejects(direct("web", `INSERT INTO fleet_claims(tenant_id,claim_id,offer_id,worker_id,node_id,project_id,
        job_id,attempt_id,lease_id,idempotency_key,claimed_at) VALUES('x','y','z','w','n','p','j','a','l','kkkkkkkkkkkkkk',now())`),
      (error: unknown) => sqlState(error) === "42501");

      // --- Existing roles keep working: the guards are no-ops for them.
      await direct("coordinator", "UPDATE control_jobs SET updated_at=updated_at WHERE id=$1", [untouched.jobId]);

      // --- Revocation takes effect on the production logins. The joined worker
      // first claims real work, so this also proves the owner's revocation is
      // not counted as a stall by the supervisor -- the fleet counterpart of
      // what the local Stop path already does through revokeLease.
      const revokedTask = await seedProposedTask(admin.client, PROJECT_A, "pg-revoked");
      const revokedOffer = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: revokedTask.jobId,
        capability: "writing" });
      const revokedClaim = await client.claim(revokedOffer.offerId, "pg-revoked-claim-01");
      const applied = await owner.revokeWorker(ownerIdentity(), joined.workerId);
      assert.equal(applied.revoked, true);
      await assert.rejects(client.me(), /unauthenticated/u);
      const identity = await direct("web", "SELECT state FROM control_identities WHERE id LIKE 'identity:fleet:%'");
      assert.equal(identity.rows[0].state, "revoked");
      const revokedLease = await direct("web", "SELECT state FROM control_leases WHERE id=" +
        "(SELECT lease_id FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2)", [FLEET_TENANT, revokedClaim.claimId]);
      assert.equal(revokedLease.rows[0].state, "revoked",
        "the production fleet login released the in-flight lease at revocation");
      // Time then passes, so the revoked lease is BOTH revoked and elapsed --
      // the case a naive expiry sweep would mistake for a stall. Only the
      // lease's active-state guard stands between the two, so this is the
      // assertion that proves the exclusion rather than the revocation alone.
      await expireClaim(revokedClaim.claimId);
      // Revocation is a withdrawal, not a failure: the attempt is cancelled and
      // the job is orphaned, so the owner's own flows pick the work back up
      // rather than the supervisor requeueing it as a fresh attempt.
      const revokedAttempt = await direct("web", "SELECT state, payload->>'safeFailureCode' AS reason FROM control_attempts WHERE id=" +
        "(SELECT attempt_id FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2)", [FLEET_TENANT, revokedClaim.claimId]);
      assert.deepEqual(revokedAttempt.rows[0], { state: "cancelled", reason: "worker_revoked" });
      const revokedJob = await direct("web", "SELECT state FROM control_jobs WHERE id=$1", [revokedTask.jobId]);
      assert.equal(revokedJob.rows[0].state, "orphaned", "the job is not marked done and not requeued");
      // The derived ownership scope is released, so a later claim in that
      // project is not blocked by a lease that no longer exists.
      const scopeRows = await direct("web", "SELECT count(*)::int AS count FROM control_assignment_lease_scopes WHERE lease_id=" +
        "(SELECT lease_id FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2)", [FLEET_TENANT, revokedClaim.claimId]);
      assert.equal(scopeRows.rows[0].count, 0, "the revoked lease releases its derived ownership scope");
      // Reconcile runs on a timer as well as after each owner action, so a
      // second pass must be a no-op: no second lease revocation, no throw.
      const repeated = await gateway.reconcile();
      assert.deepEqual(repeated, { reviews: 0, revocations: 0, leaseRevocations: 0 },
        "a repeated reconcile over an already-revoked worker changes nothing");

      // --- Two reconcilers racing the same revoked worker. This is the case the
      // skip-if-not-active guard actually exists for, and a sequential repeat
      // cannot reach it: the owner's revokeWorker() has already settled the
      // identity by now, so the outer query never re-selects this worker. A
      // SECOND machine, revoked without the settling callback, leaves its
      // identity 'active', so both concurrent reconciles select it and race to
      // move the same lease. Exactly one may win; the other must skip rather
      // than throw or double-count.
      const racingCode = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "Racing worker",
        workerKind: "mcp-agent", projectIds: [PROJECT_B], capabilities: ["writing"], maxConcurrent: 1 });
      const racingPath = join(dir, "racing.json");
      const racingJoined = await connector.join({ server: origin, code: racingCode.code, workerKind: "mcp-agent", configPath: racingPath });
      const racingClient = connector.createClient(await connector.loadConfig(racingPath));
      const racingTask = await seedProposedTask(admin.client, PROJECT_B, "pg-revoked-race");
      const racingOffer = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_B, jobId: racingTask.jobId,
        capability: "writing" });
      const racingClaim = await racingClient.claim(racingOffer.offerId, "pg-race-claim-0001");
      await owner.revokeWorker(ownerIdentity(), racingJoined.workerId);
      // The owner path settles identity and node, so re-arm only the identity to
      // put the worker back in the outer query's result set with a live lease.
      // The worker-row guard refuses a revoked worker being revived; this is
      // fixture surgery to create the race window, so the trigger is suspended
      // for it and restored immediately, exactly as the code-expiry fixture
      // above does.
      await surgeon.query("ALTER TABLE fleet_workers DISABLE TRIGGER fleet_workers_guard");
      try {
        await admin.client.query(`UPDATE control_identities SET state='active'
          WHERE tenant_id=$1 AND id=(SELECT identity_id FROM fleet_workers WHERE tenant_id=$1 AND worker_id=$2)`,
        [FLEET_TENANT, racingJoined.workerId]);
      } finally {
        await surgeon.query("ALTER TABLE fleet_workers ENABLE TRIGGER fleet_workers_guard");
      }
      // The lease/attempt re-arm trips 0140's fleet gateway write guard for the
      // same reason, so it is suspended for the same fixture surgery.
      await surgeon.query("ALTER TABLE control_leases DISABLE TRIGGER control_leases_fleet_gateway_guard");
      await surgeon.query("ALTER TABLE control_attempts DISABLE TRIGGER control_attempts_fleet_gateway_guard");
      try {
        // The 0003 payload mirror also compares `version`, so the payload copy
        // must move with the column exactly as every real transition does.
        await surgeon.query(`UPDATE control_leases SET state='active',
          payload=jsonb_set(jsonb_set(payload,'{state}','"active"'),'{version}',to_jsonb(version+1)),
          version=version+1
          WHERE id=(SELECT lease_id FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2)`,
        [FLEET_TENANT, racingClaim.claimId]);
      } finally {
        await surgeon.query("ALTER TABLE control_leases ENABLE TRIGGER control_leases_fleet_gateway_guard");
        await surgeon.query("ALTER TABLE control_attempts ENABLE TRIGGER control_attempts_fleet_gateway_guard");
      }
      // `finishedAt` must be absent on a non-terminal attempt, and `safeFailureCode`
      // belongs to a terminal one, so the re-arm clears both.
      await admin.client.query(`UPDATE control_attempts SET state='leased',
        payload=(payload - 'finishedAt' - 'safeFailureCode')
          || jsonb_build_object('state','leased','version',version+1),
        version=version+1
        WHERE id=(SELECT attempt_id FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2)`,
      [FLEET_TENANT, racingClaim.claimId]);
      await admin.client.query(`UPDATE control_jobs SET state='leased',
        payload=jsonb_set(jsonb_set(payload,'{state}','"leased"'),'{version}',to_jsonb(version+1)),
        version=version+1 WHERE id=$1`, [racingTask.jobId]);
      const raced = await Promise.all([gateway.reconcile(), gateway.reconcile()]);
      const revokedTwice = raced.reduce((total, result) => total + result.leaseRevocations, 0);
      assert.equal(revokedTwice, 1, "two reconcilers racing one revoked worker revoke its lease exactly once");
      const racedLease = await direct("web", "SELECT state FROM control_leases WHERE id=" +
        "(SELECT lease_id FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2)", [FLEET_TENANT, racingClaim.claimId]);
      assert.equal(racedLease.rows[0].state, "revoked");
      assert.deepEqual(unexpected, [], "a losing reconciler fails loudly in the test, never silently");
      // The supervisor is the sole expiry owner and must find nothing to sweep:
      // a deliberate revocation is not a lapse, so no Needs-you item is raised.
      assert.equal((await supervisor.reconcileStalled()).length, 0);
      assert.equal((await direct("coordinator", `SELECT count(*)::int AS count FROM control_supervisor_task_heads
        WHERE tenant_id=$1 AND job_id=$2`, [FLEET_TENANT, revokedTask.jobId])).rows[0].count, 0,
      "a revoked worker's lease never counts as a lapse");
      // Only one stall-shaped item exists on the whole run, and it belongs to the
      // genuine second lapse. The run's other inbox row is the work-batch
      // proposal approval, which is an owner decision, not a stall.
      assert.equal((await direct("coordinator", `SELECT count(*)::int AS count FROM control_action_inbox
        WHERE tenant_id=$1 AND payload->>'reasonCode' IN
          ('first_stall_requeued','second_stall_needs_attention','stalled_outcome_uncertain')`,
      [FLEET_TENANT])).rows[0].count, 1,
      "the only stall item on the whole run is the genuine second lapse");
    } finally {
      await new Promise(done => server.close(done));
      await surgeon.end().catch(() => {});
      await Promise.all([admin.close(), web.close(), fleet.close(), coordinator.close(), fleetOwner.close(), workIntake.close()]);
      await rm(dir, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
});
