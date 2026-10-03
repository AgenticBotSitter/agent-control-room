// Real-PostgreSQL proof for the two offer bugs that shared one line of
// `FleetOwnerServiceV1.offerTask`, run AS the production login that serves the
// owner's fleet pages (control_room_fleet_owner, group
// control_room_fleet_owner_authority) with only the grants db/roles gives it,
// and AS the production gateway login (control_room_fleet) for the machine side.
//
// R6F-06 (reports/qa/r6fleet.md steps 2-6)
//
//   Re-offering an open task with a DIFFERENT chosen-bot list answered 201
//   "success" and left the stored scope untouched. The replay compared only the
//   open state and the capability, so the owner's changed intent was reported as
//   applied when it never was. The offer is immutable (0140's guard refuses any
//   update to allowed_worker_ids), so a changed list must be a CONFLICT and the
//   stored scope must never move.
//
// R6W-06 (reports/qa/r6web.md)
//
//   The replay query had no project predicate: an authorized project plus a
//   FOREIGN job ID returned that job's offer ID. The job's tenant, project and
//   workspace binding is now validated before the replay lookup, and the
//   existing-offer query is bound to the authorized project.
//
// What is proved here, on real rows:
//
//   * an unrestricted offer re-offered with no list still replays (unchanged);
//   * re-offering with a DIFFERENT list is `conflict` under 20 CONCURRENT
//     callers, and the stored list is byte-identical afterwards;
//   * the same list in a DIFFERENT ORDER still replays, because the choice is a
//     set -- order is the order the owner ticked boxes, not part of the scope;
//   * a re-offer with the same list replays and mints no second offer row;
//   * an authorized project plus a FOREIGN job ID is refused, never reveals the
//     foreign offer id, and writes nothing;
//   * the control: a stored [A] offer really does refuse B and admit A, so the
//     changed-scope conflict above is about replay semantics and not about a
//     stored list the claim path ignores;
//   * a job in ANOTHER WORKSPACE of the same tenant is refused too, which is the
//     workspace binding R6W-06 asks for and the one a project-id check alone
//     does not give.
//
// NO SCHEMA OR MIGRATION CHANGE. Every column, state and grant used here was read
// off the checked-out db/migrations and db/roles files and re-asserted against the
// live cluster.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { sha256Digest } from "../src/security";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { LOCAL_OWNER_SESSION_PROFILE_V1, LocalOwnerSessionServiceV1,
  captureLocalOwnerSessionProfileV1 } from "../src/web/v1/local-owner-session";
import { createPostgresLocalOwnerSessionStoreV1 } from "../src/web/v1/local-owner-session-store";
import { createFleetOwnerHttpHandlerV1 } from "../src/web/v1/fleet-owner-http";
import { createFleetGatewayHandlerV1, FleetOwnerServiceV1 } from "../src/fleet/v1";
import { createFleetGatewayStoreFromConfigurationV1 } from "../scripts/run-fleet-gateway";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, PROJECT_B, seedFleetTenant, seedProposedTask }
  from "./support/fleet-fixture";
// The connector is a dependency-free .mjs shipped to worker machines.
import * as connector from "../scripts/fleet/connector.mjs";
import { buildSignedFleetConnectorReleaseForTestV1 } from "./support/fleet-release";

// This file's reserved lane inside the assigned 59500-59519 block. It moves
// with CONTROL_ROOM_PG_TEST_PORT_BASE like its neighbours, so a run that lost a
// port race fails as a port conflict rather than colliding with another job.
const PORT_BASE = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59500);
const PORT = PORT_BASE;
const range = (base: number) => Array.from({ length: 20 }, (_, index) => base + index);
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
/** One statement as a named production login, for refusals the guard must issue. */
async function as(postgres: RealPostgres, role: string) {
  const client = new Client(postgres.connection(role));
  client.on("error", () => {});
  await client.connect();
  return client;
}

/**
 * A second human owner whose grant names ONE project, with its own live web
 * session, so "authorized for project A" and "not authorized for project B" are
 * two different truths about the same caller. R6W-06's shape needs exactly that:
 * the request that reaches the replay lookup is authorized for the project it
 * names and unauthorized for the job it carries.
 *
 * Seeded through the schema owner because this is fixture data, not a product
 * write: 0140 confines `control_identities` only for the fleet gateway login, and
 * the ordinary owner path in `seedFleetTenant` writes the same rows this way.
 */
async function seedScopedOwner(db: DatabaseClient, projectId: string, name: string): Promise<VerifiedWebIdentity> {
  const subject = `identity:fleet-owner-${name}`;
  const issuedAt = new Date(Date.now() - 60_000).toISOString(), expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const tokenDigest = sha256Digest({ session: `fleet-owner-${name}` });
  await db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,
    state,created_at,updated_at) VALUES($1,$2,'human',$1,$3,$4,'active',$5,$5)`,
  [subject, FLEET_TENANT, "test", sha256Digest({ provider: "test", subject }), issuedAt]);
  await db.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]',to_jsonb(ARRAY[$4::text]),'critical',true,false,$5,$5)`,
  [`grant:fleet-owner-${name}`, FLEET_TENANT, subject, projectId, issuedAt]);
  await db.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`, [FLEET_TENANT, tokenDigest, subject, issuedAt, expiresAt]);
  return Object.freeze({ provider: "test", subject, tokenDigest, issuedAt, expiresAt, verificationExpiresAt: expiresAt });
}

test("a changed chosen-bot list conflicts, and a foreign job never reveals its offer", { timeout: 600_000 }, async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), fleetOwner = pool(postgres, "fleetOwner"), fleet = pool(postgres, "fleet"),
      workIntake = pool(postgres, "control_room_work_intake_agent"),
      // The ordinary private-web login is what the loopback session store writes
      // its signed-in session row with; the fleet OWNER authority is what
      // executes the offer itself. Two logins, each used for its own job.
      webPool = pool(postgres, "web");
    const dir = await mkdtemp(join(tmpdir(), "offer-scope-pg-"));
    const listeners: { close(): Promise<void> }[] = [];
    try {
      const gateway = createFleetGatewayStoreFromConfigurationV1(fleet.client, { tenantId: FLEET_TENANT,
        workIntake: { database: {} as never, integrityKey: Buffer.alloc(32, 7).toString("base64url") } });
      const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
        afterDecision: () => gateway.reconcile() });
      const proposals = new WorkBatchServiceV1(new WorkBatchStoreV1(workIntake.client, new Uint8Array(32).fill(7)));
      const release = await buildSignedFleetConnectorReleaseForTestV1({ root: resolve(dir, "fleet-release"),
        builtFrom: "0".repeat(40) });
      const handler = createFleetGatewayHandlerV1({ store: gateway, proposals, releaseTrust: release.releaseTrust,
        connectorRelease: release.connectorRelease, onUnexpectedError: error => { console.error(error); } });
      const listener = createServer((request, response) => { void handler.handle(request, response); });
      await new Promise<void>(done => listener.listen(0, "127.0.0.1", done));
      listeners.push({ close: () => new Promise<void>(done => listener.close(() => done())) });
      const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

      await seedFleetTenant((sql, params) => admin.client.query(sql, params));
      // A second workspace in the SAME tenant, with a project and a task in it.
      // The fleet tables carry no row policy of their own, so this is the only way
      // to show the offer path refuses a project outside the configured workspace
      // rather than merely a project the caller was refused.
      await admin.client.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Other')",
        ["workspace:fleet-other", FLEET_TENANT]);
      await admin.client.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,
        source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
        VALUES($1,$2,'workspace:fleet-other','adapter:fleet',$1,'1',$1,'running','fixture','healthy',
        'control_room_native',now(),'{}',now())`, ["project:fleet-elsewhere", FLEET_TENANT]);
      await admin.client.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,
        created_at,updated_at) VALUES($1,$2,'active',1,now(),now())`,
      [FLEET_TENANT, "project:fleet-elsewhere"]);

      // Two enrolled machines in the same project with the same skill, each at
      // capacity 1. Both are real enrollments with real credentials through the
      // real connector, so the claim control below exercises the claim guard.
      const enroll = async (displayName: string) => {
        const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName, workerKind: "mcp-agent",
          projectIds: [PROJECT_A], capabilities: ["writing"], maxConcurrent: 1 });
        const configPath = join(dir, `${displayName}.json`);
        await connector.join({ server: origin, code: code.code, workerKind: "mcp-agent", configPath });
        const config = await connector.loadConfig(configPath);
        return { workerId: config.workerId!, client: connector.createClient(config) };
      };
      const botA = await enroll("Choice A"), botB = await enroll("Choice B");
      const storedList = async (offerId: string) => (await fleetOwner.client.query<{ allowed_worker_ids: string[] | null }>(
        "SELECT allowed_worker_ids FROM fleet_work_offers WHERE tenant_id=$1 AND offer_id=$2",
      [FLEET_TENANT, offerId])).rows[0]!.allowed_worker_ids;
      const offerRow = async (jobId: string) => (await fleetOwner.client.query<{ offer_id: string; project_id: string;
        allowed_worker_ids: string[] | null }>("SELECT offer_id,project_id,allowed_worker_ids FROM fleet_work_offers"
        + " WHERE tenant_id=$1 AND job_id=$2", [FLEET_TENANT, jobId])).rows[0];
      const auditCount = async () => Number((await fleetOwner.client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM audit_events WHERE tenant_id=$1 AND action='fleet.task.offered'",
      [FLEET_TENANT])).rows[0]!.n);

      // --- R6F-06 step 2/3: an unrestricted offer, then the same one narrowed.
      const openTask = await seedProposedTask(admin.client, PROJECT_A, "scope-open");
      const unrestricted = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A,
        jobId: openTask.jobId, capability: "writing" });
      assert.equal(unrestricted.replayed, false);
      assert.equal(await storedList(unrestricted.offerId), null, "the first offer is unrestricted");

      // A replay with no list at all is unchanged behaviour and must still work:
      // an owner who retries the button must not be refused by the fix.
      const same = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: openTask.jobId,
        capability: "writing" });
      assert.deepEqual(same, { offerId: unrestricted.offerId, replayed: true },
        "an identical unrestricted offer still replays");

      const beforeAudits = await auditCount();
      // Step 5: twenty CONCURRENT callers asking for a different list, through
      // the production shape: ONE pool, the 8 connections and 5s checkout the
      // owner's fleet routes really have. A burst wider than the pool is refused
      // at checkout with `database_unavailable`, which is honest backpressure and
      // is asserted as such below -- what must never appear is a SUCCESS.
      const narrowCalls = Array.from({ length: 20 }, () => owner.offerTask(ownerIdentity(),
        { projectId: PROJECT_A, jobId: openTask.jobId, capability: "writing", allowedWorkerIds: [botA.workerId] }));
      const narrowed = await Promise.allSettled(narrowCalls);
      assert.ok(narrowed.every(entry => entry.status === "rejected"), "no changed-scope caller is answered");
      const codes = narrowed.map(entry => (entry as PromiseRejectedResult).reason as { code?: string });
      for (const code of codes) {
        assert.ok(code?.code === "conflict" || code?.code === "database_unavailable",
          `a changed list is refused as a conflict, got ${String(code?.code)}`);
      }
      const conflicts = codes.filter(code => code?.code === "conflict").length;
      const backpressure = codes.filter(code => code?.code === "database_unavailable").length;
      // The guard must have actually run, not merely been out-shout by the pool:
      // at least the pool's own width of callers reached the replay comparison.
      assert.ok(conflicts >= 8, `only ${conflicts} of 20 callers reached the replay comparison`);
      assert.equal(backpressure, 20 - conflicts);
      assert.equal(await storedList(unrestricted.offerId), null,
        "the stored scope is untouched after twenty changed-scope callers");
      assert.equal(await auditCount(), beforeAudits, "no refused replay wrote an audit row");
      assert.equal((await offerRow(openTask.jobId))?.offer_id, unrestricted.offerId,
        "the immutable offer still holds its own id");

      // The same twenty callers again, each with its OWN pool, so all twenty are
      // real concurrent transactions on the production login instead of eight
      // and twelve refusals at the checkout gate. This is the guard under genuine
      // concurrency; the phase above is the same guard as the owner meets it.
      const separate = Array.from({ length: 20 }, () => pool(postgres, "fleetOwner"));
      try {
        const racedOwners = separate.map(one => new FleetOwnerServiceV1(one.client,
          { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE, afterDecision: () => gateway.reconcile() }));
        const raced = await Promise.allSettled(racedOwners.map(one => one.offerTask(ownerIdentity(),
          { projectId: PROJECT_A, jobId: openTask.jobId, capability: "writing", allowedWorkerIds: [botA.workerId] })));
        assert.ok(raced.every(entry => entry.status === "rejected"), "no raced caller is answered");
        for (const entry of raced) assert.equal((entry as PromiseRejectedResult).reason?.code, "conflict",
          "twenty concurrent transactions all see the same conflict");
      } finally { await Promise.allSettled(separate.map(one => one.close())); }
      assert.equal(await storedList(unrestricted.offerId), null,
        "the stored scope is still untouched after twenty concurrent transactions");

      // The other direction: an offer already restricted to B, then A.
      const restrictedTask = await seedProposedTask(admin.client, PROJECT_A, "scope-restricted");
      const forB = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: restrictedTask.jobId,
        capability: "writing", allowedWorkerIds: [botB.workerId] });
      assert.deepEqual(await storedList(forB.offerId), [botB.workerId]);
      await assert.rejects(owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: restrictedTask.jobId,
        capability: "writing", allowedWorkerIds: [botA.workerId] }), /fleet_conflict/u);
      assert.deepEqual(await storedList(forB.offerId), [botB.workerId], "B's list is still B's list");
      // A capability change is still a conflict too (existing behaviour, kept).
      await assert.rejects(owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: restrictedTask.jobId,
        capability: "testing" }), /fleet_conflict/u);

      // The same SET in a different ORDER replays: which bots were chosen is the
      // scope, not the order the owner ticked the boxes.
      const orderTask = await seedProposedTask(admin.client, PROJECT_A, "scope-order");
      const forAB = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: orderTask.jobId,
        capability: "writing", allowedWorkerIds: [botA.workerId, botB.workerId] });
      const reordered = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: orderTask.jobId,
        capability: "writing", allowedWorkerIds: [botB.workerId, botA.workerId] });
      assert.deepEqual(reordered, { offerId: forAB.offerId, replayed: true }, "the same set replays in any order");
      // Removing one bot is a change, not a replay.
      await assert.rejects(owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: orderTask.jobId,
        capability: "writing", allowedWorkerIds: [botA.workerId] }), /fleet_conflict/u);
      // So is widening to "any connected bot".
      await assert.rejects(owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: orderTask.jobId,
        capability: "writing" }), /fleet_conflict/u);
      assert.deepEqual(await storedList(forAB.offerId), [botA.workerId, botB.workerId]);
      const offerCount = async (jobId: string) => Number((await fleetOwner.client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM fleet_work_offers WHERE tenant_id=$1 AND job_id=$2",
      [FLEET_TENANT, jobId])).rows[0]!.n);
      assert.equal(await offerCount(orderTask.jobId), 1, "one offer per job, still");

      // A CLOSED offer is not an open one, whichever way the owner reaches it:
      // withdrawn through the owner path, then re-offered with the very same
      // scope, is still a conflict rather than a replay that resurrects it.
      const withdrawnTask = await seedProposedTask(admin.client, PROJECT_A, "scope-withdrawn");
      const withdrawn = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: withdrawnTask.jobId,
        capability: "writing", allowedWorkerIds: [botA.workerId] });
      assert.deepEqual(await owner.withdrawOffer(ownerIdentity(), withdrawn.offerId),
        { offerId: withdrawn.offerId, withdrawn: true });
      assert.deepEqual(await storedList(withdrawn.offerId), [botA.workerId], "withdrawal keeps the saved scope");
      await assert.rejects(owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: withdrawnTask.jobId,
        capability: "writing", allowedWorkerIds: [botA.workerId] }), /fleet_conflict/u,
      "a withdrawn offer cannot be replayed as open, even with an identical scope");
      await assert.rejects(owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: withdrawnTask.jobId,
        capability: "writing" }), /fleet_conflict/u);
      assert.equal((await fleetOwner.client.query<{ state: string; close_reason: string }>(
        "SELECT state,close_reason FROM fleet_work_offers WHERE tenant_id=$1 AND offer_id=$2",
      [FLEET_TENANT, withdrawn.offerId])).rows[0]!.state, "closed",
      "the withdrawn offer is still closed after two refused re-offers");

      // --- R6W-06: an authorized project plus a FOREIGN job id.
      const foreignTask = await seedProposedTask(admin.client, PROJECT_B, "scope-foreign");
      const foreignOffer = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_B, jobId: foreignTask.jobId,
        capability: "writing", allowedWorkerIds: [botB.workerId] });
      // R6W-06's production shape: the caller's grants are confined to project A
      // while the job belongs to project B. A second human identity with exactly
      // that narrow owner grant and its own live web session, read through the
      // same owner service and the same production login.
      const scopedOwner = await seedScopedOwner(admin.client, PROJECT_A, "scope-partial");
      const beforeForeign = await auditCount();
      // An honest foreign-project request is refused by the grant check.
      await assert.rejects(owner.offerTask(scopedOwner, { projectId: PROJECT_B, jobId: foreignTask.jobId,
        capability: "writing" }), /access_denied|not_found/u, "project B is not this owner's to offer");
      const crossed = await Promise.allSettled(Array.from({ length: 20 }, () => owner.offerTask(scopedOwner,
        { projectId: PROJECT_A, jobId: foreignTask.jobId, capability: "writing", allowedWorkerIds: [botA.workerId] })));
      assert.ok(crossed.every(entry => entry.status === "rejected"), "no crossed request is answered");
      const crossedCodes = crossed.map(entry => (entry as PromiseRejectedResult).reason as { code?: string; message?: string });
      for (const reason of crossedCodes) {
        assert.ok(reason?.code === "not_found" || reason?.code === "database_unavailable",
          `a foreign job is refused, got ${String(reason?.code)}`);
        assert.ok(!JSON.stringify(reason).includes(foreignOffer.offerId),
          "no refusal carries the foreign offer id");
      }
      assert.ok(crossedCodes.filter(reason => reason?.code === "not_found").length >= 8,
        "at least the pool's width of crossed requests reached the job-binding check");
      // The same scoped caller, offered its OWN project's job, still works: the
      // refusal above is the job binding, not a caller that can never offer.
      const ownTask = await seedProposedTask(admin.client, PROJECT_A, "scope-own-project");
      const own = await owner.offerTask(scopedOwner, { projectId: PROJECT_A, jobId: ownTask.jobId, capability: "writing" });
      assert.equal(own.replayed, false);
      assert.equal(await auditCount(), beforeForeign + 1,
        "only the own-project offer wrote an audit row; nothing crossed");
      assert.deepEqual(await storedList(foreignOffer.offerId), [botB.workerId],
        "the foreign offer keeps its own scope");
      // WHY the replay predicate is not the load-bearing half of R6W-06: 0140's
      // insert guard refuses an offer whose project is not its job's, so a stored
      // offer's project already agrees with its job. Asserted here rather than
      // assumed, because that guard is what makes the two bindings equivalent --
      // and a row that did NOT agree is exactly what the replay predicate exists
      // to refuse rather than answer.
      assert.equal(Number((await fleetOwner.client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM fleet_work_offers o JOIN control_jobs j ON j.tenant_id=o.tenant_id"
        + " AND j.id=o.job_id WHERE o.tenant_id=$1 AND o.project_id<>j.project_id",
      [FLEET_TENANT])).rows[0]!.n), 0, "no stored offer names a project other than its job's");
      // The refusal itself, on a raw connection so the raised message is not
      // sanitised away: this is 0140's own guard refusing a mismatched project.
      const rawOwner = await as(postgres, "fleetOwner");
      try {
        await assert.rejects(rawOwner.query(`INSERT INTO fleet_work_offers(tenant_id,offer_id,project_id,
          job_id,capability,allowed_worker_ids,offered_by_identity_id,state,created_at)
          VALUES($1,$2,$3,$4,'writing',NULL,'identity:fleet-owner','open',now())`,
        [FLEET_TENANT, `fleet-offer:${"d".repeat(32)}`, PROJECT_A, foreignTask.jobId]),
        /fleet work offer rejected/u, "an offer cannot be stored against a foreign job's project");
      } finally { await rawOwner.end(); }

      // The configured workspace binding, which a project-id check alone does not
      // give: this job is in a project of the SAME tenant in a DIFFERENT
      // workspace, so the offer path refuses it even for the wildcard owner.
      const elsewhereTask = await seedProposedTask(admin.client, "project:fleet-elsewhere", "scope-elsewhere");
      await assert.rejects(owner.offerTask(ownerIdentity(), { projectId: "project:fleet-elsewhere",
        jobId: elsewhereTask.jobId, capability: "writing" }), /fleet_not_found/u,
      "a project outside this workspace cannot be offered into");
      await assert.rejects(owner.offerTask(ownerIdentity(), { projectId: PROJECT_A,
        jobId: elsewhereTask.jobId, capability: "writing" }), /fleet_not_found/u,
      "a job outside this workspace is not found here");

      // --- Control (r6fleet step 6): the stored list is not cosmetic. With [A]
      // stored, B is refused and A is admitted, through the real gateway login.
      const control = await seedProposedTask(admin.client, PROJECT_A, "scope-control");
      const controlOffer = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId: control.jobId,
        capability: "writing", allowedWorkerIds: [botA.workerId] });
      const bWork = await botB.client.work() as { offerId: string }[];
      assert.ok(!bWork.some((item: { offerId: string }) => item.offerId === controlOffer.offerId),
        "B does not see A's restricted offer");
      await assert.rejects(botB.client.claim(controlOffer.offerId, "qa-scope-choice-b-0001"), /not_found/u,
        "B cannot claim an offer restricted to A");
      const aClaim = await botA.client.claim(controlOffer.offerId, "qa-scope-choice-a-0001");
      assert.equal(aClaim.jobId, control.jobId, "A claims the offer restricted to it");
      const claimRow = await fleet.client.query<{ project_id: string; job_id: string }>(
        "SELECT project_id,job_id FROM fleet_claims WHERE tenant_id=$1 AND offer_id=$2",
      [FLEET_TENANT, controlOffer.offerId]);
      assert.deepEqual(claimRow.rows[0], { project_id: PROJECT_A, job_id: control.jobId },
        "the committed claim names this fixture's project and job");

      // --- Least privilege is unchanged, and the new job-binding read needs
      // nothing this branch did not already have.
      for (const [table, allowed] of [["fleet_work_offers", true], ["control_jobs", true], ["projects", true]] as const)
        assert.equal((await fleetOwner.client.query<{ ok: boolean }>(
          "SELECT has_table_privilege('control_room_fleet_owner',$1,'SELECT') AS ok", [table])).rows[0]!.ok, allowed,
        `fleet owner SELECT on ${table}`);
      // The offer's scope columns are NOT among the owner authority's three
      // writable ones, which is why a changed list cannot be applied by any
      // route: the grant itself is column-scoped to state, closed_at, close_reason.
      for (const column of ["allowed_worker_ids", "capability", "project_id", "job_id"])
        assert.equal((await fleetOwner.client.query<{ ok: boolean }>(
          "SELECT has_column_privilege('control_room_fleet_owner','fleet_work_offers',$1,'UPDATE') AS ok",
          [column])).rows[0]!.ok, false, `fleet owner UPDATE on fleet_work_offers.${column}`);
      for (const column of ["state", "closed_at", "close_reason"])
        assert.equal((await fleetOwner.client.query<{ ok: boolean }>(
          "SELECT has_column_privilege('control_room_fleet_owner','fleet_work_offers',$1,'UPDATE') AS ok",
          [column])).rows[0]!.ok, true, `fleet owner UPDATE on fleet_work_offers.${column}`);
      const surgeon = await as(postgres, "migrator");
      try {
        await assert.rejects(surgeon.query(`UPDATE fleet_work_offers SET allowed_worker_ids=ARRAY[$1::text]
          WHERE tenant_id=$2 AND offer_id=$3`, [botB.workerId, FLEET_TENANT, controlOffer.offerId]),
        /fleet work offer update rejected/u, "the stored list is still immutable at the database");
      } finally { await surgeon.end(); }

      // --- THE PRODUCTION DEFAULT PATH, end to end. Everything above calls the
      // owner service directly; this phase drives the REAL owner HTTP handler
      // over a REAL loopback listener, with the REAL loopback session issuer and
      // a REAL signed-in cookie, so what is proved is the answer an owner
      // actually receives: a status code and a body, not a thrown code.
      //
      // `LocalOwnerSessionServiceV1` is the production issuer and
      // `createPostgresLocalOwnerSessionStoreV1` the production store, so the
      // cookie below is signed in and verified exactly as a browser's would be.
      const ownerCode = "loopback-owner-code-for-the-offer-route-proof";
      // Bind first, derive the origin second: the session profile's own origin
      // check refuses anything else, and a probe-then-bind port race would hand
      // this fixture an origin it does not own.
      const ownerServer = createServer();
      await new Promise<void>(done => ownerServer.listen(0, "127.0.0.1", done));
      listeners.push({ close: () => new Promise<void>(done => ownerServer.close(() => done())) });
      const webOrigin = `http://127.0.0.1:${(ownerServer.address() as AddressInfo).port}`;
      const profile = captureLocalOwnerSessionProfileV1({ schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: webOrigin,
        tenantId: FLEET_TENANT, provider: "test", subject: "identity:fleet-owner",
        ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 });
      const sessions = new LocalOwnerSessionServiceV1(profile, createPostgresLocalOwnerSessionStoreV1(webPool.client, profile));
      const ownerHttp = createFleetOwnerHttpHandlerV1({ origin: webOrigin, localOwnerSession: sessions,
        service: owner, clock: () => Date.now() });
      // The loopback listener, converting the socket into the Request the owner
      // handler takes exactly as private-node-handler.ts:380 does. The Mac host's
      // own adapter needs an HTTPS origin, which a loopback fixture cannot
      // present, so the CONVERSION is copied and the ADAPTER is not: the origin,
      // cookie, body and headers below are the real ones, and the sign-in and
      // verification are the production session service.
      const toRequest = async (request: IncomingMessage, base: string): Promise<Request> => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers.set(name, value);
          else if (Array.isArray(value)) for (const one of value) headers.append(name, one);
        }
        return new Request(new URL(request.url ?? "/", base).href, { method: request.method ?? "GET",
          headers, ...(body.length ? { body: new Uint8Array(body) } : {}) });
      };
      ownerServer.on("request", (request, response) => { void (async () => {
        const webRequest = await toRequest(request, webOrigin);
        const answer = webRequest.url === `${webOrigin}/api/v1/local-owner-session`
          ? await sessions.issue(webRequest, (await webRequest.clone().json() as { ownerCode?: unknown }).ownerCode,
            Date.now()).then(issued => new Response(null, { status: 201, headers: { "set-cookie": issued.cookie } }),
            () => new Response(null, { status: 401 }))
          : await ownerHttp(webRequest);
        response.writeHead(answer.status, Object.fromEntries(answer.headers));
        response.end(Buffer.from(await answer.arrayBuffer()));
      })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); }); });
      const signedIn = await fetch(`${webOrigin}/api/v1/local-owner-session`, { method: "POST",
        headers: { origin: webOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: JSON.stringify({ ownerCode }) });
      assert.equal(signedIn.status, 201, await signedIn.clone().text());
      const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
      const post = async (body: unknown) => {
        const response = await fetch(`${webOrigin}/api/v1/fleet/offers`, { method: "POST",
          headers: { cookie, origin: webOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
          body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() as { offerId?: string; replayed?: boolean; error?: string } };
      };
      const routeTask = await seedProposedTask(admin.client, PROJECT_A, "scope-route");
      const created = await post({ projectId: PROJECT_A, jobId: routeTask.jobId, capability: "writing",
        allowedWorkerIds: [botA.workerId] });
      assert.equal(created.status, 201, `a first offer is 201: ${JSON.stringify(created.body)}`);
      assert.deepEqual(await storedList(created.body.offerId!), [botA.workerId]);
      // The changed-scope answer an owner receives: 409, and NO offer id, so a
      // refusal cannot be mistaken for a successful second offer.
      const changed = await post({ projectId: PROJECT_A, jobId: routeTask.jobId, capability: "writing",
        allowedWorkerIds: [botB.workerId] });
      assert.equal(changed.status, 409, `a changed list is 409: ${JSON.stringify(changed.body)}`);
      assert.deepEqual(changed.body, { error: "conflict" }, "the refusal carries only the fixed code");
      assert.ok(!JSON.stringify(changed.body).includes(created.body.offerId!), "no offer id in the refusal");
      // A foreign job with an authorized project is 404, never another project's id.
      const crossedRoute = await post({ projectId: PROJECT_A, jobId: foreignTask.jobId, capability: "writing" });
      assert.equal(crossedRoute.status, 404, `a foreign job is 404: ${JSON.stringify(crossedRoute.body)}`);
      assert.ok(!JSON.stringify(crossedRoute.body).includes(foreignOffer.offerId));
      // The identical request still replays as 409 at the route, because the
      // route refuses to imply a replay applied a draft (unchanged behaviour).
      const replay = await post({ projectId: PROJECT_A, jobId: routeTask.jobId, capability: "writing",
        allowedWorkerIds: [botA.workerId] });
      assert.equal(replay.status, 409, "the route's replay refusal is unchanged");
      assert.deepEqual(await storedList(created.body.offerId!), [botA.workerId],
        "the route answered twice and moved nothing");
    } finally {
      await Promise.allSettled(listeners.map(one => one.close()));
      await Promise.allSettled([admin.close(), fleetOwner.close(), fleet.close(), workIntake.close(), webPool.close()]);
      await rm(dir, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: range(PORT), boundMs: 540_000 });
});
