// Real-PostgreSQL proof for F1: an archived project must stop admitting new work.
//
// The finding this closes: archive writes `control_manual_project_heads.lifecycle`,
// and both authoritative new-proposal transactions read only `projects`, which has
// no lifecycle column. Measured on this lane before the fix, fifty scheduler
// callers on a due rule created a work batch AND an open approval item while the
// project stayed archived, and twenty scheduled-admission callers created a
// proposed canonical job.
//
// What is production here, and what is fixture:
//   * production: the real migrations, the real role files, the real private-web,
//     work-intake, coordinator and scheduler logins (the attack kit creates one
//     LOGIN per production role name), the real WebProjectService.transition()
//     archive path, the real RecurringRuleSchedulerV1, the real WorkBatchServiceV1
//     over the real store, and the real ScheduledTaskAdmissionServiceV1.
//   * fixture: identities, grants, the project, its rule and its schedule, because
//     an installation provisions them once at setup. Nothing here grants any login
//     a privilege the role files do not, so a read that needs more authority fails
//     42501 instead of being papered over.
//
// The properties this lane proves, each separately:
//   1. archive, then 50 scheduler callers on a due rule create NOTHING new;
//   2. reopen, and admission works again (the fence is a lifecycle check, not a latch);
//   3. a DETERMINISTIC archive-first interleave refuses, twenty times, on two real
//      production-login connections -- and the reverse order still admits, so the
//      fence serialises rather than latches;
//   4. a missing project is 404 on the list routes, and archived history still reads.
//
// Plus the rule a fence can quietly break: an ALREADY-COMMITTED exact replay stays
// valid after archive. Proved here, because refusing it would turn a completed
// proposal into a permanent failure the caller retries forever.
//
// Property 3 is the one the earlier version of this lane got wrong, and the reason
// it is written as two separate tests with an OBSERVED lock wait rather than a
// `Promise.all`: see the block comment above them.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { Client, Pool } from "pg";
import { DOMAIN_CONTRACT_VERSION, type AuthorityEnvelope, type ScheduleRecord } from "../src/domain/v1";
import { CanonicalStore, type ProposedWorkBundle } from "../src/persistence/canonical-store";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { RecurringRuleSchedulerV1, recurringWorkBatchProposalPortV1 } from "../src/scheduler/v1";
import { EMPTY_SCHEDULE_REUSABLE_CONTEXT_BINDING_DIGEST_V1, ScheduledTaskAdmissionServiceV1,
  computeScheduledTaskDefinitionDigestV1 } from "../src/services/v1/scheduled-task-admission";
import { ScheduleOccurrenceStore } from "../src/services/v1/occurrence-store";
import { computeAuthorityDigest, hmacSha256Tag, sha256Digest, type AuthenticatedPrincipal } from "../src/security";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { createAccessVerifier, type AccessTrust } from "../src/web/v1/access-verifier";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { WebProjectService } from "../src/web/v1/project-service";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { openObserver, openTransaction, track, waitForHeldLock, waitForLockWait } from "./support/attack-kit/deterministic-lock-interleaving";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59400), PG = requiresRealPostgres();
// One fixed instant for every assertion, so nothing here depends on the wall clock.
const NOW = Date.parse("2026-10-02T09:00:00.000Z");
const TICK = Date.parse("2026-10-05T10:00:00.000Z");
// The three weekly instants this lane ticks at: the active control, the 50-caller
// burst, and the post-reopen tick. Each lands on its own immutable weekly occurrence,
// so the final one is three weeks after NOW.
const BURST_TICK = TICK + 7 * 86_400_000;
const REOPENED_TICK = BURST_TICK + 7 * 86_400_000;
const LAST_TICK = REOPENED_TICK;
const ids = {
  tenant: "tenant:r6proj", workspace: "workspace:r6proj", adapter: "adapter:r6proj",
  project: "project:r6proj", owner: "identity:r6proj-owner", ownerGrant: "grant:r6proj-owner",
  agent: "identity:r6proj-agent", agentGrant: "grant:r6proj-agent",
};
const provider = "test", tokenDigest = sha256Digest({ session: "r6proj-owner" });
/** The hosted private-web origin the owner actually arrives at. */
const ORIGIN = "https://private.r6proj.invalid";
let ran = 0;

function pool(postgres: RealPostgres, role: string) {
  // The kit gives a socket-directory host; privatePgOptions validates a TCP endpoint,
  // so the pool is built for 127.0.0.1 on the kit's port and the socket directory is
  // passed through `host` exactly as tests/recurring-work-postgres.test.ts does.
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, config, close: () => bound.close() };
}

async function seed(admin: Client) {
  // The owner's web SESSION is anchored to the wall clock, not to NOW. The private-web
  // handlers verify a live Access assertion with `Date.now()`, so a session row that
  // expired at a fixed 2026 instant reads as expired and every request answers 401 --
  // which looks exactly like the F4 fix failing when it is a fixture artefact. The
  // DOMAIN instants below (NOW/TICK) still drive every product assertion.
  const wallNow = new Date();
  const at = new Date(NOW).toISOString();
  const expires = new Date(wallNow.getTime() + 7 * 86_400_000).toISOString();
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'R6proj')", [ids.tenant]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'R6proj')",
    [ids.workspace, ids.tenant]);
  await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES($1,$2,'control-room-manual','1.0.0','control_room_native',
    'disabled','v1',30)`, [MANUAL_ADAPTER, ids.tenant]);
  // An ACTIVE ordinary project, with the head row WebProjectService.create() writes.
  await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1','R6proj','planned','manual_project_active','healthy','control_room_native',$5,'{}',$5)`,
  [ids.project, ids.tenant, ids.workspace, MANUAL_ADAPTER, at]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,$3,$3)`, [ids.tenant, ids.project, at]);
  for (const [identity, actor, subject, authProvider] of [
    [ids.owner, "human", "owner", provider], [ids.agent, "agent", "agent", "work-intake"],
  ] as const)
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,$3,$1,$4,$5,'active',$6,$6)`,
    [identity, ids.tenant, actor, authProvider, sha256Digest({ provider: authProvider, subject }), at]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`, [ids.ownerGrant, ids.tenant, ids.owner, at]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'work_batch_proposer','["work_batches.propose"]',$4::jsonb,'low',false,false,$5,$5)`,
  [ids.agentGrant, ids.tenant, ids.agent, JSON.stringify([ids.project]), at]);
  await admin.query("INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)",
    [ids.tenant, tokenDigest, ids.owner, at, expires]);
  await admin.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)", [ids.tenant]);
}

/** The production web identity the archive path authenticates. */
const identity = (): VerifiedWebIdentity => ({ provider, subject: "owner", tokenDigest,
  issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(TICK + 86_400_000).toISOString(),
  verificationExpiresAt: new Date(TICK + 86_400_000).toISOString() });
// The proposing agent's authority has to outlast EVERY instant this lane uses, and the
// ticks deliberately run three weeks apart (control, burst, post-reopen) so each one
// lands on a fresh, immutable weekly occurrence. The expiry is anchored to the LAST
// tick, not the first: an earlier value makes the final proposal answer
// `no_matching_grant` for `session_expired`, which reads like a fence that latched when
// it is really the fixture's own clock running out.
const principal = (): AuthenticatedPrincipal => ({ tenantId: ids.tenant, identityId: ids.agent,
  actorType: "agent", authenticatedAt: new Date(NOW).toISOString(),
  expiresAt: new Date(LAST_TICK + 86_400_000).toISOString() });

const scope = { tenantId: ids.tenant, workspaceId: ids.workspace };
/**
 * The adapter id an ORDINARY project must carry: exactly what
 * `WebProjectService.manualAdapterId()` derives from the deployment scope. Seeding
 * anything else makes the owner's own archive transition 404 for a reason unrelated
 * to lifecycle, which is precisely how this lane's first draft failed.
 */
const MANUAL_ADAPTER = `adapter:manual:${sha256Digest(scope).slice(7, 39)}`;
/**
 * A second registered intake agent, for the projects the main fixture's grant
 * does not cover. Module scope because both the seeding and the no-write
 * injection below name it: the injected rows must be attributed to the same
 * registered agent a real proposal would carry, or the proposal-only insert
 * trigger refuses them for an unrelated reason.
 */
const secondAgent = "identity:r6proj-agent-2";
const taskTemplate = { title: "Weekly dependency review", instructions: "Review dependency changes.",
  requiredCapability: "dependency.review", acceptanceCriteria: "Evidence is cited.",
  acceptanceTests: "The owner checks every cited source.", skillRefs: [] };

/** Counts the three things F1 is about.
 *
 * Read through the logins that legitimately hold each table: the owner's web login
 * for batches and open approval items, and the coordinator login for the recurring
 * proposal ledger, which production_table_grants.sql never grants to the web login.
 * Measured: asking the web login for it is a plain 42501, so this splits rather than
 * widening a grant for a test's convenience.
 */
async function ownerAttention(web: DatabaseClient, coordinator: DatabaseClient, ruleId: string) {
  const owner = (await web.query<{ batches: number; open_items: number }>(
    `SELECT (SELECT count(*)::int FROM work_batches WHERE tenant_id=$1 AND project_id=$2) batches,
            (SELECT count(*)::int FROM control_action_inbox WHERE tenant_id=$1 AND project_id=$2
              AND kind='approval' AND state='open') open_items`, [ids.tenant, ids.project])).rows[0]!;
  const proposals = (await coordinator.query<{ proposals: number }>(
    `SELECT count(*)::int proposals FROM control_recurring_proposals WHERE tenant_id=$1 AND project_id=$2
      AND state='proposed'`, [ids.tenant, ids.project])).rows[0]!;
  return { ...owner, proposals: proposals.proposals, ruleId };
}

test("F1: an archived project stops admitting new work, and reopening restores it", { timeout: 600_000 }, async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try { await seed(admin); } finally { await admin.end(); }
    const web = pool(postgres, "web"), coordinator = pool(postgres, "coordinator"),
      intake = pool(postgres, "control_room_work_intake_agent");
    try {
      // The owner creates the rule through the real web service, so it is a rule the
      // product would really have. The coordinator login runs the scheduler's
      // bookkeeping, exactly as the installed composition does.
      const rules = new (await import("../src/recurring/v1")).RecurringRuleServiceV1(web.client, scope, () => NOW);
      const rule = await rules.create(identity(), ids.project, { schedule: "every Monday at 9", timezone: "UTC",
        title: taskTemplate.title, instructions: taskTemplate.instructions,
        requiredCapability: taskTemplate.requiredCapability, acceptanceCriteria: taskTemplate.acceptanceCriteria,
        acceptanceTests: taskTemplate.acceptanceTests });
      const proposals = new WorkBatchServiceV1(new WorkBatchStoreV1(intake.client, new Uint8Array(32).fill(41)));
      const tick = () => new RecurringRuleSchedulerV1(coordinator.client, ids.tenant, { read: () => "running" },
        recurringWorkBatchProposalPortV1(proposals, principal(), () => TICK), () => TICK);

      // Control 1: on an ACTIVE project the installed scheduler really does propose.
      // A fence that refused everything would prove nothing.
      const first = await tick().tick();
      assert.equal(first.proposed.length, 1, "the active control must propose exactly once");
      const afterActive = await ownerAttention(web.client, coordinator.client, rule.ruleId);
      assert.deepEqual([afterActive.batches, afterActive.proposals, afterActive.open_items], [1, 1, 1],
        "the active control creates one batch, one proposal row and one open approval");

      // ARCHIVE, through the real owner service and its real transaction.
      const projects = new WebProjectService(web.client, scope, () => TICK + 3_600_000);
      const archived = await projects.transition(identity(), ids.project,
        { lifecycle: "archived", expectedVersion: 1 }, "r6proj-archive-0001");
      assert.equal(archived.project.lifecycle, "archived", "the owner archived the project");
      const stored = (await web.client.query<{ lifecycle: string }>(
        "SELECT lifecycle FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2",
        [ids.tenant, ids.project])).rows[0]!;
      assert.equal(stored.lifecycle, "archived", "the archive really committed to the lifecycle row");

      // Property 1: fifty scheduler callers on a due rule create NOTHING new.
      //
      // Fifty callers, each on its OWN connection. The production pool is max: 8
      // with a 2s lock_timeout, so running fifty callers through one pool would
      // measure queueing rather than the fence: 42 of them would wait for a
      // connection and fail with a capacity error instead of the lifecycle refusal
      // this finding is about. Separate connections are what makes each answer
      // reflect the fence. (The 50-way burst is also run through the production pool
      // in the load test below, where the refusal VALUE -- not the capacity error --
      // is asserted for every caller.)
      //
      // The burst runs at its own later instant (BURST_TICK, the Monday after the
      // control's). Two reasons, both about keeping the measurement honest rather
      // than convenient: the TICK occurrence was already proposed by the control and
      // an occurrence is immutable, so reusing it would prove nothing; and each caller
      // still writes the pending ledger row the scheduler creates before it proposes,
      // so the burst gets its own occurrence to leave behind.
      const callers = await Promise.all(Array.from({ length: 50 }, async () => {
        const own = pool(postgres, "coordinator"), ownIntake = pool(postgres, "control_room_work_intake_agent");
        try {
          return await new RecurringRuleSchedulerV1(own.client, ids.tenant, { read: () => "running" },
            recurringWorkBatchProposalPortV1(new WorkBatchServiceV1(
              new WorkBatchStoreV1(ownIntake.client, new Uint8Array(32).fill(41))), principal(), () => BURST_TICK),
            () => BURST_TICK).tick();
        } finally { await Promise.all([own.close(), ownIntake.close()]); }
      }));
      const burst = callers;
      const afterArchive = await ownerAttention(web.client, coordinator.client, rule.ruleId);
      assert.deepEqual([afterArchive.batches, afterArchive.proposals, afterArchive.open_items],
        [afterActive.batches, afterActive.proposals, afterActive.open_items],
        "fifty scheduler callers after archive created new owner attention");
      assert.equal(burst.filter(outcome => outcome.proposed.length > 0).length, 0,
        "no caller reported a new proposal after archive");
      // The rule itself is retained and still active, so reopen can resume it
      // deliberately rather than the archive silently disabling the automation.
      const ruleState = (await web.client.query<{ state: string }>(
        "SELECT state FROM control_recurring_rules WHERE tenant_id=$1 AND rule_id=$2",
        [ids.tenant, rule.ruleId])).rows[0]!;
      assert.equal(ruleState.state, "active", "archive must not pause or delete the rule");

      // A direct intake call is refused for the same reason: the fence is in the
      // authoritative transaction, not in the scheduler's scan.
      await assert.rejects(proposals.submit({ principal: principal(), projectId: ids.project,
        rawProposal: JSON.stringify({ schema: "control-room.work-batch-proposal/v1", projectId: ids.project,
          tasks: [{ localId: "direct", title: "Direct", instructions: "Direct proposal.",
            requiredCapability: "dependency.review", role: "builder",
            acceptanceCriteria: "n/a", acceptanceTests: "n/a", skillRefs: [] }], edges: [] }),
        idempotencyKey: "r6proj-direct-after-archive-0001", now: new Date(TICK).toISOString() }),
      /project_inactive/u, "a direct proposal after archive must be refused");
      assert.equal((await ownerAttention(web.client, coordinator.client, rule.ruleId)).batches, afterActive.batches,
        "the refused direct proposal wrote no batch");

      // Property 2: REOPEN, and admission works again. The fence reads the lifecycle,
      // so it is not a one-way latch and no state was burned clearing the refusal.
      //
      // The tick is advanced a week, because the occurrence due at TICK was already
      // handled by the active control above and an occurrence is immutable: a second
      // tick at the same instant would correctly find nothing new.
      //
      // The 50-caller burst above consumes the occurrence at BURST_TICK, and an
      // occurrence is immutable: re-deciding it is refused by design ("wait for the
      // next scheduled occurrence"), which is the product behaving correctly rather
      // than a fence that latched. So the post-reopen tick uses the NEXT occurrence,
      // one week after the burst's, which is what "reopen lets new work in again"
      // actually means.
      const reopened = await projects.transition(identity(), ids.project,
        { lifecycle: "active", expectedVersion: 2 }, "r6proj-reopen-0001");
      assert.equal(reopened.project.lifecycle, "active");
      // The scheduler's catch records only `proposal_failed`, which hides WHY. This
      // port records the refusal reason so a failure names its cause instead of
      // leaving the next assertion to guess.
      const refusals: string[] = [];
      const afterReopen = await new RecurringRuleSchedulerV1(coordinator.client, ids.tenant,
        { read: () => "running" }, { async propose(request) {
          try { return await recurringWorkBatchProposalPortV1(proposals, principal(), () => REOPENED_TICK)
            .propose(request); }
          catch (error) { refusals.push(`${(error as { safeCode?: string }).safeCode ?? ""}:${
            (error as Error).message}`); throw error; } } }, () => REOPENED_TICK).tick();
      if (afterReopen.proposed.length !== 1)
        t.diagnostic(`post-reopen refusals: ${JSON.stringify(refusals)}`);
      assert.equal(afterReopen.proposed.length, 1,
        "reopening must restore admission; a latch would not");
      const afterReopenCounts = await ownerAttention(web.client, coordinator.client, rule.ruleId);
      assert.deepEqual([afterReopenCounts.batches, afterReopenCounts.proposals, afterReopenCounts.open_items],
        [afterActive.batches + 1, afterActive.proposals + 1, afterActive.open_items + 1],
        "the post-reopen cycle added exactly one more of each");

      // Archive again, to test the replay rule against an archived project.
      await projects.transition(identity(), ids.project, { lifecycle: "archived", expectedVersion: 3 },
        "r6proj-archive-0002");

      // THE REPLAY RULE. An already-committed exact replay stays valid after archive.
      // Refusing it would convert a completed proposal into a permanent failure that
      // every caller retries forever, which is worse than the archive.
      //
      // Order matters and is deliberate: reopen, COMMIT the proposal, archive again,
      // and only then replay the same bytes and key. There is no submit before the
      // commit, because on an archived project submit() REFUSES (it throws
      // project_inactive) rather than returning a receipt -- which is the first half of
      // the property, already asserted above.
      const replayKey = "r6proj-replay-after-archive-0001";
      const replayProposal = { schema: "control-room.work-batch-proposal/v1" as const, projectId: ids.project,
        tasks: [{ localId: "replay", title: "Replay", instructions: "Already committed.",
          requiredCapability: "dependency.review", role: "builder" as const,
          acceptanceCriteria: "n/a", acceptanceTests: "n/a", skillRefs: [] as never[] }], edges: [] };
      await projects.transition(identity(), ids.project, { lifecycle: "active", expectedVersion: 4 },
        "r6proj-reopen-0002");
      const real = await proposals.submit({ principal: principal(), projectId: ids.project,
        rawProposal: JSON.stringify(replayProposal), idempotencyKey: replayKey, now: new Date(TICK).toISOString() });
      assert.ok("batchId" in real, "the proposal commits while the project is active");
      const batchId = real.batchId, batchesBeforeReplay = (await ownerAttention(web.client, coordinator.client, rule.ruleId)).batches;
      await projects.transition(identity(), ids.project, { lifecycle: "archived", expectedVersion: 5 },
        "r6proj-archive-0003");
      const replayed = await proposals.submit({ principal: principal(), projectId: ids.project,
        rawProposal: JSON.stringify(replayProposal), idempotencyKey: replayKey, now: new Date(TICK).toISOString() });
      assert.ok("batchId" in replayed && replayed.batchId === batchId,
        `an exact replay of committed work must still return its receipt after archive: ${
          JSON.stringify(replayed).slice(0, 200)}`);
      assert.equal(replayed.replayed, true, "and it must be reported as a replay, not a new proposal");
      assert.equal((await ownerAttention(web.client, coordinator.client, rule.ruleId)).batches, batchesBeforeReplay,
        "the replay added no second batch");
    } finally { await Promise.all([web.close(), coordinator.close(), intake.close()]); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 480_000 });
});

test("F1: scheduled admission refuses an archived project and replays a committed receipt", { timeout: 600_000 }, async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try { await seed(admin); } finally { await admin.end(); }
    // Canonical admission runs as the production scheduler login.
    // Scheduled canonical admission writes requests, workflows and jobs, so it runs as
    // the shared application login. MEASURED on this cluster: the narrow
    // `control_room_schedule_admissions` login holds SELECT on schedules,
    // occurrences and projects but its INSERT into control_requests/control_jobs is
    // refused 42501, and it holds no UPDATE on control_outbox, which the delivered-
    // receipt check needs. This lane therefore drives admission as the app login --
    // the login that can actually execute the shipped transaction -- and the FENCE is
    // proven there, not on a login that could never have run it.
    const sched = pool(postgres, "app"), web = pool(postgres, "web");
    const scheduleId = "schedule:r6proj-daily", occurrenceKey = `${scheduleId}:2026-10-05T10:00`;
    const scheduledFor = "2026-10-05T10:00:00.000Z", createdAt = "2026-10-05T09:00:00.000Z";
    const source = { requestId: "request:r6proj", workflowId: "workflow:r6proj", jobId: "job:r6proj" };
    // ENCLOSING SCOPE, on purpose. The bound driver below is a separate `Pool` from
    // `sched` and `web`, so nothing else in this test closes it: the earlier
    // version closed it on the success path only, and an assertion failure between
    // the first admission and the end leaked it until the cluster teardown
    // force-closed the sockets -- which is not the same as this test owning and
    // closing its own driver on every path. Both halves are declared here, and the
    // wrapper is closed in the `finally` below.
    let boundedAdmission: ReturnType<typeof bindPrivatePgPool> | undefined;
    try {
      const base = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId: ids.tenant, version: 0,
        createdAt: NOW ? new Date(NOW).toISOString() : createdAt, updatedAt: createdAt };
      const authority: AuthorityEnvelope = { projectId: ids.project, allowedExecutor: "executor:unassigned",
        allowedOperations: ["task.propose"], credentialRefs: [], filesystemRoots: [], networkPolicy: "none",
        allowedNetworkDestinations: [], effectPolicy: "none", maxRisk: "low", maxDurationSeconds: 300,
        maxConcurrentEffects: 0, maxCostUsd: 0, expiresAt: "2026-10-06T10:00:00.000Z", digest: "" };
      authority.digest = computeAuthorityDigest(authority);
      const bundle: ProposedWorkBundle = {
        request: { ...base, id: source.requestId, kind: "request", projectId: ids.project,
          title: "Scheduled work", objective: "Prepared scheduled research.", state: "draft", priority: 60,
          requestedBy: { actorId: ids.owner, actorType: "human" }, idempotencyKey: "source:r6proj" },
        workflow: { ...base, id: source.workflowId, kind: "workflow", requestId: source.requestId,
          projectId: ids.project, definitionVersion: "synthetic/v1", definitionDigest: sha256Digest("r6proj"),
          authorityMode: "control_room_native", state: "proposed", jobIds: [source.jobId] },
        job: { ...base, id: source.jobId, kind: "job", workflowId: source.workflowId, projectId: ids.project,
          jobType: "research.daily", specVersion: "1.0.0", inputDigest: sha256Digest("r6proj-input"),
          state: "proposed", priority: 60, requiredCapability: "research.daily", dependsOnJobIds: [],
          authority, retryPolicy: { maxAttempts: 3, backoffSeconds: 30,
            retryableFailureCodes: ["provider_timeout"], retryAfterOrphan: true, ambiguousEffectPolicy: "attention" } },
      };
      await new CanonicalStore(sched.client).createProposedWorkBundle(bundle);
      const schedule: ScheduleRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, id: scheduleId,
        tenantId: ids.tenant, version: 0, createdAt, updatedAt: createdAt, kind: "schedule",
        projectId: ids.project, state: "active", scheduleType: "cron", expression: "0 10 * * *",
        timezone: "UTC", targetType: "job", targetId: source.jobId, idempotencyWindowSeconds: 3600 };
      await new CanonicalStore(sched.client).create(schedule);
      const scheduleDefinitionDigest = computeScheduledTaskDefinitionDigestV1(schedule);
      await new ScheduleOccurrenceStore(sched.client).materialize({ tenantId: ids.tenant, scheduleId,
        occurrenceKey, targetType: "job", targetId: source.jobId, definitionDigest: scheduleDefinitionDigest,
        scheduledFor, localTime: "2026-10-05T10:00", createdAt });
      const delivered = new Date(Date.parse(scheduledFor) + 60_000).toISOString();
      await sched.client.query(`UPDATE control_outbox SET status='delivered',delivered_at=$2
        WHERE tenant_id=$1 AND topic='schedule.occurrence.created'`, [ids.tenant, delivered]);

      // The admission input schema is STRICT, so this carries exactly its keys -- no
      // contractVersion and no per-source digests: `sourceSchema` takes only
      // requestId/workflowId/jobId/bundleDigest, and `contextBindingSchema` only
      // reusableContexts/bindingDigest. The empty binding uses the module's own
      // exported digest rather than a recomputed one, so the fixture cannot drift
      // from what the product defines empty to be.
      const admissionInput = () => ({ tenantId: ids.tenant, workspaceId: ids.workspace,
        projectId: ids.project, scheduleId, occurrenceKey, scheduleDefinitionDigest,
        source: { requestId: source.requestId, workflowId: source.workflowId, jobId: source.jobId,
          bundleDigest: sha256Digest({ contractVersion: "control-room-scheduled-source-bundle/v1", ...bundle }) },
        contextBinding: { reusableContexts: [], bindingDigest: EMPTY_SCHEDULE_REUSABLE_CONTEXT_BINDING_DIGEST_V1 } });
      // The PRODUCTION bounded private-web driver, not a bare pg Pool.
      //
      // The previous version of this lane replaced it with a hand-rolled adapter whose
      // `transactionWithPreCommitCheck` ran COMMIT BEFORE `check()` and did not await
      // it. That is the opposite of src/web/v1/bounded-database.ts:167-171, which awaits
      // the check and refuses to COMMIT if it rejects. So that run proved a transaction
      // composition the product never executes, and it hid (rather than reported) the one
      // reason it needed a bare pool: scheduled-task-admission.ts issued its three source
      // reads as one `Promise.all` on one connection, which the driver's one-statement-
      // at-a-time guard refuses. Those reads are now SEQUENTIAL in a fixed
      // request -> workflow -> job order, which is a real fix to shipped code and not a
      // test accommodation, so this lane runs the transaction exactly as shipped.
      //
      // The attack-kit cluster is socket-only (`-h ''`), so the pool connects over the
      // kit's socket directory. privatePgOptions still validates the TCP-shaped config,
      // which is the same arrangement tests/recurring-work-postgres.test.ts uses.
      const appLogin = postgres.connection("app");
      const admissionPool = new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
        database: postgres.database, username: appLogin.user, password: appLogin.password,
        majorVersion: 17 as const }), host: appLogin.host });
      boundedAdmission = bindPrivatePgPool(admissionPool);
      const admission = new ScheduledTaskAdmissionServiceV1(
        boundedAdmission.client as DatabaseClient, () => Date.parse(delivered));
      const admittedJobs = async () => Number((await sched.client.query<{ n: number }>(
        "SELECT count(*)::int n FROM control_scheduled_task_admissions WHERE tenant_id=$1 AND project_id=$2",
        [ids.tenant, ids.project])).rows[0]!.n);
      const destinationJobs = async () => Number((await sched.client.query<{ n: number }>(
        "SELECT count(*)::int n FROM control_jobs WHERE tenant_id=$1 AND id LIKE 'job:schedule:%'",
        [ids.tenant])).rows[0]!.n);

      // Control: active admits, and exactly one destination job appears.
      const control = await admission.admit(admissionInput());
      assert.equal(control.replayed, false, "the active control admits");
      assert.equal(await admittedJobs(), 1);
      assert.equal(await destinationJobs(), 1, "the active control created exactly one destination job");

      // Twenty exact replays while active: one admission, one job. This is the
      // idempotency the fence must not break.
      //
      // Bounded in waves of the pool's own width (connections: 8, transactionMs:
      // 10s). Firing twenty at once on ONE pool measures the pool, not admission --
      // the surplus callers queue past `checkoutMs` and the driver reports
      // `database_outcome_uncertain`, which is a capacity answer masquerading as an
      // admission one. Waves keep every answer an admission answer.
      const replays = [];
      for (let start = 0; start < 20; start += 8) {
        const wave = await Promise.all(Array.from({ length: Math.min(8, 20 - start) },
          () => admission.admit(admissionInput()).catch(error => ({ refused: String(error) }))));
        replays.push(...wave);
      }
      assert.equal(replays.filter(r => "refused" in r).length, 0,
        `an exact replay was refused while active: ${JSON.stringify(replays.find(r => "refused" in r))}`);
      assert.equal(await destinationJobs(), 1, "twenty replays created no extra destination job");

      // ARCHIVE, then twenty admission callers for a NEW occurrence: nothing new.
      const projects = new WebProjectService(web.client, scope, () => TICK + 3_600_000);
      await projects.transition(identity(), ids.project, { lifecycle: "archived", expectedVersion: 1 },
        "r6proj-adm-archive-0001");
      const secondKey = `${scheduleId}:2026-10-06T10:00`, secondFor = "2026-10-06T10:00:00.000Z";
      await new ScheduleOccurrenceStore(sched.client).materialize({ tenantId: ids.tenant, scheduleId,
        occurrenceKey: secondKey, targetType: "job", targetId: source.jobId,
        definitionDigest: scheduleDefinitionDigest, scheduledFor: secondFor,
        localTime: "2026-10-06T10:00", createdAt: "2026-10-06T09:00:00.000Z" });
      await sched.client.query(`UPDATE control_outbox SET status='delivered',delivered_at=$2
        WHERE tenant_id=$1 AND topic='schedule.occurrence.created'`, [ids.tenant, delivered]);
      const secondInput = { ...admissionInput(), occurrenceKey: secondKey };
      // Same wave bound as above, for the same reason: every caller must answer with
      // an ADMISSION refusal, and a pool-capacity answer would hide the fence.
      const outcomes: string[] = [];
      for (let start = 0; start < 20; start += 8) {
        outcomes.push(...await Promise.all(Array.from({ length: Math.min(8, 20 - start) },
          () => admission.admit(secondInput).then(() => "admitted",
            error => (error as { safeCode?: string }).safeCode ?? String(error)))));
      }
      assert.deepEqual([...new Set(outcomes)], ["project_inactive"],
        `every caller after archive must refuse with project_inactive, got ${[...new Set(outcomes)].join(",")}`);
      assert.equal(await admittedJobs(), 1, "the archived admission added no admission row");
      assert.equal(await destinationJobs(), 1, "the archived admission created no destination job");

      // And the committed receipt still replays after archive.
      const replay = await admission.admit(admissionInput());
      assert.equal(replay.replayed, true, "a committed receipt must replay after archive");

      // Reopen restores admission for the pending occurrence.
      await projects.transition(identity(), ids.project, { lifecycle: "active", expectedVersion: 2 },
        "r6proj-adm-reopen-0001");
      const afterReopen = await admission.admit(secondInput);
      assert.equal(afterReopen.replayed, false, "reopening restores admission");
      assert.equal(await destinationJobs(), 2, "the post-reopen admission created its one destination job");
    } finally {
      // Closed HERE, on every path, and through the BOUND wrapper that actually
      // ran the transactions -- not the raw pool, and not a second bind around
      // the same pool. `bindPrivatePgPool` installs client `end` observers and its
      // `close()` awaits them, so a socket still closing cannot be reported as
      // closed. The success path used to close it inline; an assertion failure
      // anywhere above skipped that line, and the pool then survived until the
      // cluster teardown destroyed its sockets from underneath it.
      await boundedAdmission?.close().catch(() => {});
      await Promise.all([sched.close(), web.close()]);
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 480_000 });
});

test("R6P2-02: the admission pool is closed on the FAILURE path too, not only on success",
  { timeout: 600_000 }, async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    ran += 1;
    await withRealPostgres(async postgres => {
      const admin = new Client(postgres.admin()); await admin.connect();
      try { await seed(admin); } finally { await admin.end(); }
      const sched = pool(postgres, "app");
      // THE SAME PRODUCTION DRIVER as the test above: `bindPrivatePgPool` over a
      // real `Pool` at the production app login, with `privatePgOptions` shaping
      // the config. No stub, no fake, because the thing under test is whether
      // THAT driver's sockets are closed.
      const appLogin = postgres.connection("app");
      const admissionPool = new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
        database: postgres.database, username: appLogin.user, password: appLogin.password,
        majorVersion: 17 as const }), host: appLogin.host });
      const bounded = bindPrivatePgPool(admissionPool);
      let failureRaised = false;
      try {
        // Drive the driver on its DEFAULT path first -- one real transaction
        // against the real schema, through the bounded wrapper -- so there are
        // genuinely open sockets for the cleanup to be responsible for. A pool
        // that never connected has nothing to close, and would make this test
        // pass whether or not the close existed.
        const result = await bounded.client.query<{ n: number }>(
          "SELECT count(*)::int n FROM control_scheduled_task_admissions WHERE tenant_id=$1", [ids.tenant]);
        assert.equal(typeof result.rows[0]?.n, "number",
          "the production bounded driver must really have connected and queried");
        assert.ok(admissionPool.totalCount > 0,
          `the pool must hold real connections before the failure, else the cleanup proves nothing; `
          + `totalCount=${admissionPool.totalCount}`);
        assert.ok(admissionPool.ended === false, "the pool is still open at this point");
        // ...and then FAIL, exactly where an assertion failure would.
        failureRaised = true;
        assert.fail("deliberate failure to prove the admission pool is closed on the failure path");
      } catch (error) {
        assert.match((error as Error).message, /deliberate failure/u,
          "the only failure here is the deliberate one");
      } finally {
        // THE CLAIM UNDER TEST. The close runs in the same `finally` that the
        // scheduled-admission test now uses, so a throw above cannot skip it.
        await bounded.close();
        assert.equal(admissionPool.ended, true,
          `the admission pool must be CLOSED on the failure path; ended=${String(admissionPool.ended)}`);
        assert.equal(admissionPool.totalCount, 0,
          `and its sockets must be gone, not merely flagged; totalCount=${admissionPool.totalCount}`);
        await sched.close();
      }
      assert.ok(failureRaised, "this test must actually have taken its failure path");
      // A closed driver refuses further work with a sanitized code, which is what
      // makes "closed" observable from outside rather than an internal flag.
      await assert.rejects(bounded.client.query("SELECT 1"), /database_unavailable/u,
        "a closed driver must refuse, not quietly reconnect");
    }, { port: PORT, allowedPorts: [PORT], boundMs: 480_000 });
  });


// ---------------------------------------------------------------------------
// R6P-01: the deterministic interleave, on two real connections and the
// production fence.
//
// The earlier version of this lane started the admission and the archive with
// `Promise.all` and hoped the scheduler gave the archive the lock. That does not
// create a race: whichever transaction reaches `projects` first wins, the other
// blocks and then reads the winner's committed value, so the assertions held on a
// build whose fence leaked work into an archived project. It also counted
// `batch:race%` prefixes the store never mints (it generates `batch:<random
// UUID>`), and converted archive errors into a string it then discarded.
//
// These tests pin the ordering instead, which is the only way to test it:
//
//   A (owner/web login)   its own transaction, the owner's REAL archive path,
//                         which locks p and h and writes both rows -- holds them
//   B (intake login)      its own transaction, the PRODUCTION fence query --
//                         blocks on `projects`
//   observer              confirms B is blocked on a Lock (pg_stat_activity)
//   A                     COMMIT -- the commit order, asserted not inferred
//   B                     unblocks, reads, decides -- must REFUSE
//
// B's statement is the SQL the shipped helper issues, reached through
// `WorkBatchStoreV1.create()`: no probe query, no fake database, and no query the
// product does not run. The sessions are real `pg` connections at the production
// login, so the row locks, the READ COMMITTED snapshots and the grants are real.
// ---------------------------------------------------------------------------

/** A raw production-login connection. privatePgOptions is the production shape. */
function loginConfig(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  return { ...privatePgOptions({ host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const }), host: login.host };
}

/**
 * The production `DatabaseClient` contract, served by ONE already-open connection
 * the test owns.
 *
 * This is the shape `joined()` builds in scheduled-task-admission.ts: the
 * interleaving has to place BEGIN and COMMIT on connections the test chooses, and
 * a pool would take both back. `beforeCommit` is the gate that decides WHEN the
 * transaction commits, which is what makes admission-first assertable. There is no
 * other seam: `transaction` and `transactionWithPreCommitCheck` run the production
 * callback and honour its pre-commit check exactly as src/web/v1/bounded-database.ts
 * does (await the check, then commit).
 */
function clientOn(session: DatabaseSession, beforeCommit?: () => Promise<void>): DatabaseClient {
  const wrap = async <T>(run: (tx: DatabaseSession) => Promise<T>, check?: () => void | Promise<void>): Promise<T> => {
    const value = await run(session);
    if (check) await check();
    await beforeCommit?.();
    return value;
  };
  return Object.freeze({ query: session.query.bind(session),
    transaction: <T>(run: (tx: DatabaseSession) => Promise<T>) => wrap(run),
    transactionWithPreCommitCheck: <T>(run: (tx: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) =>
      wrap(run, check) }) as DatabaseClient;
}

/** The stored lifecycle, read on a third connection so it never contends. */
async function headLifecycle(web: DatabaseClient): Promise<string> {
  return (await web.query<{ lifecycle: string }>(
    "SELECT lifecycle FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2",
    [ids.tenant, ids.project])).rows[0]!.lifecycle;
}

/** The head's optimistic-concurrency version, read on a non-contending connection. */
async function headVersion(web: DatabaseClient): Promise<number> {
  return Number((await web.query<{ version: number }>(
    "SELECT version FROM control_manual_project_heads WHERE tenant_id=$1 AND project_id=$2",
    [ids.tenant, ids.project])).rows[0]!.version);
}

/** Every batch for the project. Counted, never pattern-matched on a minted id. */
async function batchCount(web: DatabaseClient): Promise<number> {
  return Number((await web.query<{ n: number }>(
    "SELECT count(*)::int n FROM work_batches WHERE tenant_id=$1 AND project_id=$2",
    [ids.tenant, ids.project])).rows[0]!.n);
}

const raceProposal = (n: number) => ({ schema: "control-room.work-batch-proposal/v1" as const,
  projectId: ids.project, tasks: [{ localId: `race-${n}`, title: "Race", instructions: "Race the archive.",
    requiredCapability: "dependency.review", role: "builder" as const,
    acceptanceCriteria: "n/a", acceptanceTests: "n/a", skillRefs: [] as never[] }], edges: [] });

test("R6P-01: twenty archive-first rounds refuse, on two real connections", { timeout: 600_000 }, async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try { await seed(admin); } finally { await admin.end(); }
    const webConfig = loginConfig(postgres, "web"), intakeConfig = loginConfig(postgres, "control_room_work_intake_agent");
    const web = pool(postgres, "web");
    let rounds = 0, admitted = 0, refused = 0;
    try {
      for (let round = 1; round <= 20; round += 1) {
        // Every round STARTS active, through the owner's own service and its own
        // version check. The earlier version reset the head row as superuser and
        // swallowed the failure, which is how its later rounds stayed archived and
        // raced against nothing at all.
        const owner = new WebProjectService(web.client, scope, () => TICK + 3_600_000);
        if (await headLifecycle(web.client) !== "active") {
          await owner.transition(identity(), ids.project,
            { lifecycle: "active", expectedVersion: await headVersion(web.client) },
            `r6proj-race-open-${String(round).padStart(4, "0")}`);
        }
        assert.equal(await headLifecycle(web.client), "active",
          `round ${round} must START active, or it is not a race at all`);
        const archiveVersion = await headVersion(web.client);

        const batchesBefore = await batchCount(web.client);
        const observer = await openObserver(intakeConfig, "r6proj-race-observer");
        let archive: Awaited<ReturnType<typeof openTransaction>> | undefined;
        let admission: Awaited<ReturnType<typeof openTransaction>> | undefined;
        try {
          // ---- connection A: the owner's REAL archive path, holding p AND h ----
          archive = await openTransaction(webConfig, "r6proj-race-archive");
          await new WebProjectService(clientOn(archive.client), scope, () => TICK + 3_600_000)
            .transition(identity(), ids.project, { lifecycle: "archived", expectedVersion: archiveVersion },
              `r6proj-race-archive-${String(round).padStart(4, "0")}`);
          // Uncommitted: A holds both rows, so B provably cannot have decided yet.

          // ---- connection B: the PRODUCTION admission transaction, now blocked --
          admission = await openTransaction(intakeConfig, "r6proj-race-admission");
          const store = new WorkBatchStoreV1(clientOn(admission.client), new Uint8Array(32).fill(53));
          const decision = track(() => store.create({ principal: principal(), proposal: raceProposal(round),
            proposalDigest: sha256Digest(raceProposal(round)),
            idempotencyKey: `r6proj-race-${String(round).padStart(4, "0")}`,
            now: new Date(TICK).toISOString(), queueDepthLimit: 10 }));
          // The block is OBSERVED, on the observer connection, keyed on B's own pid.
          await waitForLockWait(observer.client, admission.backendPid, { boundMs: 20_000 });
          assert.equal(decision.settled, false,
            `round ${round}: B must still be blocked on the projects row before the archive commits`);

          // ---- A commits FIRST. That ordering IS the property under test ---------
          await archive.client.query("COMMIT");
          const outcome = await decision.promise.then(value => ({ admitted: true as const, value }),
            (error: unknown) => ({ admitted: false as const, error }));
          assert.equal(await headLifecycle(web.client), "archived",
            `round ${round}: the archive really committed before B decided`);
          // Counted BEFORE the branch, so a build that admits in every round reports
          // `admitted=20 of 20` rather than a round count of zero.
          rounds += 1;

          if (outcome.admitted) { admitted += 1; await admission.client.query("COMMIT").catch(() => {}); continue; }
          refused += 1;
          const safeCode = (outcome.error as { safeCode?: string }).safeCode;
          assert.equal(safeCode, "project_inactive",
            `round ${round}: an admission that waited behind a COMMITTED archive must refuse with `
            + `project_inactive, saw ${JSON.stringify(safeCode ?? outcome.error)}`);
          await admission.client.query("ROLLBACK").catch(() => {});
          assert.equal(await batchCount(web.client), batchesBefore,
            `round ${round}: the refused admission wrote no batch`);
        } finally { await Promise.all([archive?.release(), admission?.release(), observer.close()]); }
      }
      t.diagnostic(`R6P-01: ${rounds} deterministic archive-first rounds `
        + `(refused=${refused}, admitted=${admitted}), each on two production-login connections`);
      assert.equal(rounds, 20, "every round ran the interleaving");
      assert.equal(admitted, 0,
        `an admission that waited behind a COMMITTED archive must never be admitted; ${admitted} of 20 admitted`);
    } finally { await web.close(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 480_000 });
});

test("R6P-01: the reverse order still admits, so the fence is not a latch", { timeout: 600_000 }, async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try { await seed(admin); } finally { await admin.end(); }
    const webConfig = loginConfig(postgres, "web"), intakeConfig = loginConfig(postgres, "control_room_work_intake_agent");
    const web = pool(postgres, "web");
    let admission: Awaited<ReturnType<typeof openTransaction>> | undefined;
    let archive: Awaited<ReturnType<typeof openTransaction>> | undefined;
    const observer = await openObserver(webConfig, "r6proj-order-observer");
    try {
      assert.equal(await headLifecycle(web.client), "active");
      const archiveVersion = await headVersion(web.client);
      const batchesBefore = await batchCount(web.client);

      // B goes first. The gate is before its COMMIT, so the test -- not the
      // scheduler -- decides the commit point, which is what makes this ordering
      // deterministic instead of merely likely.
      admission = await openTransaction(intakeConfig, "r6proj-order-admission");
      let open!: () => void;
      const gate = new Promise<void>(resolve => { open = resolve; });
      const store = new WorkBatchStoreV1(clientOn(admission.client, async () => { await gate; }),
        new Uint8Array(32).fill(59));
      const decision = track(() => store.create({ principal: principal(), proposal: raceProposal(999),
        proposalDigest: sha256Digest(raceProposal(999)), idempotencyKey: "r6proj-order-admission-0001",
        now: new Date(TICK).toISOString(), queueDepthLimit: 10 }));
      // B is holding the projects row lock, and it is held, not merely queued.
      await waitForHeldLock(observer.client, admission.backendPid, "projects", { boundMs: 20_000 });

      // A starts while B holds it, and is observed BLOCKED. That is what proves the
      // two transactions really contended rather than running one after the other.
      archive = await openTransaction(webConfig, "r6proj-order-archive");
      const blocked = track(() => new WebProjectService(clientOn(archive!.client), scope, () => TICK + 3_600_000)
        .transition(identity(), ids.project, { lifecycle: "archived", expectedVersion: archiveVersion },
          "r6proj-order-archive-0001"));
      await waitForLockWait(observer.client, archive.backendPid, { boundMs: 20_000 });
      assert.equal(blocked.settled, false, "the archive must be waiting behind the admission");

      // B commits first, so its proposal is legitimately ordered BEFORE the archive.
      open();
      const receipt = await decision.promise;
      assert.ok("batchId" in receipt, "an admission holding the projects row first must commit its proposal");
      await admission.client.query("COMMIT");
      assert.equal(await batchCount(web.client), batchesBefore + 1, "exactly one batch was added");

      // A is released only now, and its write lands after the proposal committed.
      const archived = await blocked.promise;
      await archive.client.query("COMMIT");
      assert.equal(archived.project.lifecycle, "archived", "the waiting archive then commits");
      assert.equal(await headLifecycle(web.client), "archived");
      t.diagnostic("R6P-01 reverse order: the archive backend was observed blocked on a Lock "
        + "before the admission's COMMIT, and the proposal committed first");
    } finally { await Promise.all([admission?.release(), archive?.release(), observer.close()]); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 480_000 });
});

// The fail-closed half of the guard, which the archive tests above never reach: a
// project whose lifecycle cannot be established from EITHER place.
//
// Both states it must refuse are seeded here, because both are real and both were
// uncaught by a mutation check -- flipping the helper to admit `undefined` passed
// every other assertion in this file.
//
//  * `domain_state='ready'` with no head row: the ordinary spelling neither place
//    can place. The shape the previous commit had to fix in the
//    postgres-production-lifecycle fixtures.
//  * `domain_state='idea_project_active'` with a head row saying `archived`:
//    the two places DISAGREE, which is the case a reader that prefers one place
//    silently decides. The head is the ordinary spelling and is authoritative
//    where it exists, so this must refuse -- and it must refuse because the head
//    won, not because the head was never read.
//
// The IDEA fallback is proved here too, by removing the head row from a project
// whose `domain_state` DOES carry the Idea spelling: that one must still be
// admitted, because it is the shape idea-lab's store actually writes.
test("R6P-01: an unplaceable or contradicted lifecycle is refused; the Idea fallback still admits",
  { timeout: 600_000 }, async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    ran += 1;
    await withRealPostgres(async postgres => {
      const admin = new Client(postgres.admin()); await admin.connect();
      const probe = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows;
      try {
        await seed(admin);
        const at = new Date(NOW).toISOString();
        // A second agent identity and grant, because the fixture's single agent grant
        // is scoped to the seeded project only. Real rows, real grants, no widened ACL.
        await probe(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
          auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'agent',$1,'work-intake',$3,'active',$4,$4)`,
        [secondAgent, ids.tenant, sha256Digest({ provider: "work-intake", subject: "agent-2" }), at]);
        for (const projectId of ["project:r6proj-orphan", "project:r6proj-contradicted",
          "project:r6proj-idea", "project:r6proj-idea-archived"]) {
          await probe(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
            risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
            VALUES($1,$2,$3,'work_batch_proposer','["work_batches.propose"]',$4::jsonb,'low',false,false,$5,$5)`,
          [`grant:${projectId}`, ids.tenant, secondAgent, JSON.stringify([projectId]), at]);
        }
        const seedProject = async (id: string, domainState: string, lifecycle: string | null) => {
          await probe(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
            normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
            VALUES($1,$2,$3,$4,$1,'1','Lifecycle probe','planned',$5,'healthy','control_room_native',$6,'{}',$6)`,
          [id, ids.tenant, ids.workspace, MANUAL_ADAPTER, domainState, at]);
          if (lifecycle !== null)
            await probe(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
              VALUES($1,$2,$3,1,$4,$4)`, [ids.tenant, id, lifecycle, at]);
        };
        await seedProject("project:r6proj-orphan", "ready", null);
        await seedProject("project:r6proj-contradicted", "idea_project_active", "archived");
        await seedProject("project:r6proj-idea", "idea_project_active", null);
        await seedProject("project:r6proj-idea-archived", "idea_project_archived", null);
      } finally { await admin.end(); }

      const web = pool(postgres, "web"), intake = pool(postgres, "control_room_work_intake_agent");
      try {
        const proposals = new WorkBatchServiceV1(new WorkBatchStoreV1(intake.client, new Uint8Array(32).fill(61)));
        const asSecondAgent = (): AuthenticatedPrincipal => ({ tenantId: ids.tenant, identityId: secondAgent,
          actorType: "agent", authenticatedAt: new Date(NOW).toISOString(),
          expiresAt: new Date(LAST_TICK + 86_400_000).toISOString() });
        const submitFor = (projectId: string, key: string) => proposals.submit({ principal: asSecondAgent(),
          projectId, rawProposal: JSON.stringify({ schema: "control-room.work-batch-proposal/v1", projectId,
            tasks: [{ localId: "probe", title: "Probe", instructions: "Probe the lifecycle read.",
              requiredCapability: "dependency.review", role: "builder",
              acceptanceCriteria: "n/a", acceptanceTests: "n/a", skillRefs: [] }], edges: [] }),
          idempotencyKey: key, now: new Date(TICK).toISOString() });

        // Neither place can place it: no head row, and a domain_state that is not the
        // Idea spelling. Refused on purpose -- admitting here is the same defect this
        // module exists to close, with a different cause.
        await assert.rejects(submitFor("project:r6proj-orphan", "r6proj-orphan-0001"), /project_inactive/u,
          "a project with no head row and a non-Idea domain_state must be refused, not assumed live");
        // The two places disagree. The head wins where it exists, so this refuses.
        await assert.rejects(submitFor("project:r6proj-contradicted", "r6proj-contradicted-0001"),
          /project_inactive/u, "an archived head must win over an active idea_project_ domain_state");
        // An archived Idea project has no head row, so only domain_state carries it.
        await assert.rejects(submitFor("project:r6proj-idea-archived", "r6proj-idea-archived-0001"),
          /project_inactive/u, "the Idea fallback must refuse an archived Idea project");

        // The fallback itself: an active Idea project has no head row either, and must
        // still admit. This is the shape idea-lab's store writes, so refusing it would
        // stop every Idea project from ever taking automated work again.
        const admitted = await submitFor("project:r6proj-idea", "r6proj-idea-0001");
        assert.ok("batchId" in admitted,
          `an active Idea project must be admitted through the domain_state fallback: ${
            JSON.stringify(admitted).slice(0, 160)}`);

        // And the refusals wrote nothing, counted rather than inferred from codes.
        //
        // The predicate counts on `project_id`, NOT on `id`. The earlier version
        // passed the PROJECT IDS as the `id = ANY($2::text[])` filter, and the
        // batch store mints `batch:<random UUID>` (src/work-intake/v1/store.ts:145),
        // so a leaked batch for `project:r6proj-orphan` could never match: the
        // assertion read 0 whether or not the refusals wrote anything. It was
        // blind, not green. The predicate below is proved sensitive by the
        // injection that follows, so a future change cannot silently re-blind it.
        const refusedProjects = ["project:r6proj-orphan", "project:r6proj-contradicted",
          "project:r6proj-idea-archived"];
        const leakedBatches = async () => Number((await web.client.query<{ n: number }>(
          "SELECT count(*)::int n FROM work_batches WHERE tenant_id=$1 AND project_id=ANY($2::text[])",
          [ids.tenant, refusedProjects])).rows[0]!.n);
        assert.equal(await leakedBatches(), 0, "no refused lifecycle probe wrote a batch");

        // ---- THE INJECTION: prove that assertion can fail at all -------------
        //
        // One batch per refused project, written by the REAL intake login over the
        // real connection, with the shipped store's own insert columns and its own
        // integrity key. Only the lifecycle decision is bypassed -- which is
        // exactly what a leaked write would be: a row the fence should never have
        // let exist. The refused projects are refused *because* of their lifecycle,
        // so the store cannot write these rows; the row shape is taken from
        // `WorkBatchStoreV1.create()` and the HMAC from the same `hmacSha256Tag`
        // over the same material the store would have used, so the row is one the
        // shipped reader accepts rather than a malformed artefact.
        //
        // Every refused project gets its own row, not just one, so the assertion
        // has to be sensitive to a leak at EACH refused id rather than only at the
        // first -- the failure mode a single-row probe would miss.
        const injected: string[] = [];
        const key = new Uint8Array(32).fill(67);
        try {
          for (const projectId of refusedProjects) {
            const batchId = `batch:r6proj-injected-${projectId.replaceAll(":", "-")}`;
            injected.push(batchId);
            const proposal = { schema: "control-room.work-batch-proposal/v1", projectId,
              tasks: [{ localId: "injected", title: "Injected", instructions: "Prove the counter sees a leak.",
                requiredCapability: "dependency.review", role: "builder",
                acceptanceCriteria: "n/a", acceptanceTests: "n/a", skillRefs: [] }], edges: [] };
            const proposalDigest = sha256Digest(proposal);
            const at = new Date(TICK).toISOString();
            const tag = hmacSha256Tag(key, { id: batchId, tenantId: ids.tenant, projectId,
              proposedByIdentityId: secondAgent, proposedAt: at, state: "proposed", proposal,
              queueDepthLimit: 10, batchDigest: proposalDigest, version: 1, createdAt: at, updatedAt: at });
            // The column list and VALUES clause are copied from the shipped
            // `WorkBatchStoreV1.create()` INSERT (src/work-intake/v1/store.ts:151-155),
            // parameter for parameter -- including `$6::jsonb` and the `$5` reuse for
            // created_at/updated_at -- so the row that lands is one the shipped
            // writer would have written. `RETURNING id` is the only addition: the
            // `DatabaseClient` contract carries `rows` and no `rowCount`, so a landed
            // row is proved by reading its own id back.
            const wrote = await intake.client.query<{ id: string }>(`INSERT INTO work_batches(id,tenant_id,
              project_id,proposed_by_identity_id,proposed_by_actor_type,proposed_at,state,proposal,
              queue_depth_limit,batch_digest,auth_tag,version,created_at,updated_at)
              VALUES($1,$2,$3,$4,'agent',$5,'proposed',$6::jsonb,$7,$8,$9,1,$5,$5)
              RETURNING id`, [batchId, ids.tenant, projectId, secondAgent, at,
                JSON.stringify(proposal), 10, proposalDigest, tag]);
            assert.equal(wrote.rows[0]?.id, batchId,
              `the sensitivity injection must really land for ${projectId}, as a login that can write one`);
          }
          assert.equal(await leakedBatches(), refusedProjects.length,
            "the project_id predicate must see a leak at EVERY refused project, or it is blind again");
        } finally {
          // Always remove the injection, so a FAILED assertion above cannot leave
          // rows behind for the rest of the lane to count. The intake login holds no
          // DELETE (production_table_grants.sql grants it INSERT only), so the
          // database owner removes them -- the same superuser fixture `seed()` uses.
          if (injected.length > 0) {
            const cleanup = new Client(postgres.admin());
            await cleanup.connect();
            try {
              await cleanup.query("DELETE FROM work_batches WHERE tenant_id=$1 AND id=ANY($2::text[])",
                [ids.tenant, injected]);
            } finally { await cleanup.end(); }
          }
        }
        assert.equal(await leakedBatches(), 0,
          "the injected rows are removed, so the counter returns to zero");
      } finally { await Promise.all([web.close(), intake.close()]); }
    }, { port: PORT, allowedPorts: [PORT], boundMs: 480_000 });
  });

test("F4: a missing project is 404 on the list routes, and archived history still reads", { timeout: 600_000 }, async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try { await seed(admin); } finally { await admin.end(); }
    const web = pool(postgres, "web");
    try {
      const { createRecurringRuleHttpHandlerV1 } = await import("../src/web/v1/recurring-rule-http");
      const { createReusableSkillHttpHandlerV1 } = await import("../src/web/v1/reusable-skill-http");
      const { RecurringRuleServiceV1 } = await import("../src/recurring/v1");
      const { ReusableSkillServiceV1 } = await import("../src/skills/v1");
      // A REAL signed Access assertion over the real hosted verifier, as the owner
      // arrives: these are the production handlers, not a direct service call, so the
      // 404 has to survive the real HTTP routing and error mapping as well.
      const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const trust: AccessTrust = { issuer: "https://access.r6proj.invalid", audience: "r6proj-app",
        keys: [{ kid: "r6proj-key", jwk: keys.publicKey.export({ format: "jwk" }) }],
        validUntilMs: Date.now() + 3_600_000, maxSessionSeconds: 604_800 };
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "r6proj-key" })).toString("base64url");
      const claims = Buffer.from(JSON.stringify({ iss: trust.issuer, aud: [trust.audience], sub: "owner",
        type: "app", iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 300,
        nonce: "r6proj-f4" })).toString("base64url");
      const assertion = `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`),
        keys.privateKey).toString("base64url")}`;
      const auth = { "cf-access-jwt-assertion": assertion };
      // The session row must carry the digest of THIS assertion. The verifier derives
      // `tokenDigest` as sha256 over the raw token bytes, so seeding a session for a
      // constant instead of the token the handler will actually verify leaves the
      // owner unauthenticated and every route answers 401. Registering it through the
      // verifier is what keeps the fixture honest.
      const verified = createAccessVerifier(trust)(new Request(`${ORIGIN}/x`,
        { headers: { "cf-access-jwt-assertion": assertion } }), Date.now());
      // The owner identity must be registered under THIS trust's issuer and subject:
      // session-authority looks the identity up by (auth_provider, auth_subject_digest),
      // and a mismatch is a 401 that has nothing to do with the route under test. The
      // seed above registered the owner under the fixed provider `test`, so F4
      // registers its own owner identity under the Access issuer -- the same shape the
      // existing r6w lane uses for its two-workspace proof.
      const subjectDigest = sha256Digest({ provider: trust.issuer, subject: verified.subject });
      const f4Owner = `identity:r6proj-access-owner`;
      const sessionAdmin = new Client(postgres.admin());
      await sessionAdmin.connect();
      try {
        await sessionAdmin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,
          auth_provider,auth_subject_digest,state,created_at,updated_at)
          VALUES($1,$2,'human','Access owner',$3,$4,'active',$5,$5)
          ON CONFLICT (tenant_id,id) DO NOTHING`,
        [f4Owner, ids.tenant, trust.issuer, subjectDigest, new Date().toISOString()]);
        // ...and the ordinary tenant-wide owner grant the production web login
        // really carries. Without it the session is valid but every route refuses with
        // access_denied, which again is not what F4 is about.
        await sessionAdmin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,
          allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
          VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)
          ON CONFLICT (tenant_id,id) DO NOTHING`,
        [`grant:r6proj-access-owner`, ids.tenant, f4Owner, new Date().toISOString()]);
        await sessionAdmin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,
          issued_at,expires_at) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT (tenant_id,token_digest) DO UPDATE SET expires_at=EXCLUDED.expires_at,revoked_at=NULL`,
        [ids.tenant, verified.tokenDigest, f4Owner, verified.issuedAt,
          new Date(Date.now() + 7 * 86_400_000).toISOString()]);
      } finally { await sessionAdmin.end(); }
      // The wall clock, deliberately: these handlers verify a LIVE Access assertion, and
      // WebSessionAuthority's assertFresh() compares the assertion's issue/expiry against
      // the injected clock. A fixed 2026 instant here refuses every request with
      // authentication_required BEFORE the route under test is even reached, which
      // reads exactly like the F4 fix failing.
      const wallClock = () => Date.now();
      const recurring = createRecurringRuleHttpHandlerV1({ origin: ORIGIN, trust, clock: wallClock,
        service: new RecurringRuleServiceV1(web.client, scope, wallClock) });
      const skills = createReusableSkillHttpHandlerV1({ origin: ORIGIN, trust, clock: wallClock,
        service: new ReusableSkillServiceV1(web.client, scope, wallClock) });
      const call = (handler: (request: Request) => Promise<Response>, projectId: string, path: string) =>
        handler(new Request(`${ORIGIN}/api/v1/projects/${encodeURIComponent(projectId)}/${path}`, { headers: auth }));
      const missing = "project:r6proj-absent";

      // THE FINDING. Both list routes answered 200 with [] for a project that does
      // not exist, so a stale or mistyped link looked like a real project with no
      // automations. Both must answer 404, exactly as project detail does.
      for (const [label, path] of [["recurring-rules", "recurring-rules"], ["skills", "skills"]] as const) {
        const response = await call(label === "recurring-rules" ? recurring : skills, missing, path);
        const body = await response.text();
        assert.equal(response.status, 404,
          `${label} answered ${response.status} for a nonexistent project: ${body.slice(0, 200)}`);
      }

      // A REAL project, with real children, so the matrix cannot pass by refusing
      // everything. Both routes must read.
      const ruleService = new RecurringRuleServiceV1(web.client, scope, wallClock);
      const skillService = new ReusableSkillServiceV1(web.client, scope, wallClock);
      const rule = await ruleService.create(verified, ids.project, { schedule: "every Monday at 9",
        timezone: "UTC", title: "F4 rule", instructions: "Prove the catalog reads." });
      // int9's skills service takes a scope-bound idempotency key on every create.
      const skill = await skillService.create(verified, ids.project,
        { name: "F4 skill", instructions: "Prove the catalog reads." }, "r6proj-f4-skill-create");
      assert.ok(rule.ruleId && skill.skillId, "the owner created a rule and a skill");
      const recurringBody = await (await call(recurring, ids.project, "recurring-rules"))
        .json() as { rules: unknown[] };
      const skillsBody = await (await call(skills, ids.project, "skills")).json() as { skills: unknown[] };
      assert.equal(recurringBody.rules.length, 1, "the configured project's rules are served");
      assert.equal(skillsBody.skills.length, 1, "the configured project's skills are served");

      // ARCHIVED history still reads. The finding's fix is `not_found` for an absent
      // project; refusing an archived project's retained rules and skills would be a
      // different product regression, and one the owner would notice as data loss.
      await new WebProjectService(web.client, scope, wallClock).transition(verified, ids.project,
        { lifecycle: "archived", expectedVersion: 1 }, "r6proj-f4-archive-0001");
      for (const [label, path] of [["recurring-rules", "recurring-rules"], ["skills", "skills"]] as const) {
        const response = await call(label === "recurring-rules" ? recurring : skills, ids.project, path);
        assert.equal(response.status, 200,
          `${label} must still serve an ARCHIVED project's retained history, answered ${response.status}`);
      }
    } finally { await web.close(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 480_000 });
});

test("the F1, R6P-01 and F4 real-PostgreSQL proofs ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(ran, 0); return; }
  assert.equal(ran, 7, "every real-PostgreSQL proof in this lane must have run");
});