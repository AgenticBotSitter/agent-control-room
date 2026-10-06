// Real-PostgreSQL proof for the five scheduler defects the PGlite review left
// UNCONFIRMED (PLAN-U1..U5 in reports/qa/plan.md). Every case runs as the
// production logins the code actually runs as: rules are created and paused by
// the private-web owner login, due-rule bookkeeping runs as the task-coordinator
// login, and S1 proposal intake runs as the work-intake login.
//
// Each test names the defect it closes. The three-attempt retry cap, the
// per-cycle proposal cap, single-occurrence idempotency and proposal-only
// authority are asserted alongside each fix, so a repair that buys one
// property by giving up another fails here.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import type { DatabaseClient } from "../src/persistence/database";
import { sha256Digest, type AuthenticatedPrincipal } from "../src/security";
import { RecurringRuleServiceV1 } from "../src/recurring/v1";
import { RecurringRuleSchedulerV1, RECURRING_S7B_CAPS_V1, recurringWorkBatchProposalPortV1,
  type RecurringProposalPortV1 } from "../src/scheduler/v1";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";

// Ports 59741-59745 sit inside this stream's assigned 59740-59759 range. One
// cluster at a time: the package script passes --test-concurrency=1, so these
// cases never contend for a port or a pool slot.
const PORT_BASE = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59741);
const PG = requiresRealPostgres();
const NOW = Date.parse("2026-10-05T08:00:00.000Z");
const ids = { tenant: "tenant:recurring-u", workspace: "workspace:recurring-u", adapter: "adapter:recurring-u",
  project: "project:recurring-u", owner: "identity:recurring-u-owner", ownerGrant: "grant:recurring-u-owner",
  agent: "identity:recurring-u-agent", agentGrant: "grant:recurring-u-agent" };
const provider = "test", tokenDigest = sha256Digest({ session: "recurring-u-owner" });
let ran = 0;

/**
 * One bounded pool per login, exactly as production builds them.
 *
 * `max` is how many connections that login may hold at once. It is 1 wherever a
 * test needs a caller refused for want of a connection rather than queued: the
 * plan asks for 50 INDEPENDENT task-coordinator schedulers, and a shared pool
 * would serialise those behind 8 admission slots and end up proving the pool's
 * `database_unavailable` refusal instead of the scheduler's missing claim.
 */
function pool(postgres: RealPostgres, role: string, max = 8) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host, max }));
  return { client: bound.client as DatabaseClient, config, close: () => bound.close() };
}

/**
 * The owner connection, held open for the whole test body.
 *
 * Seeding and asserting both need it. The first version closed this client with
 * `seed` and then read the ledger back through it, which failed on a closed
 * client and reported the fixture's own slip as the defect's failure.
 */
async function seeded(postgres: RealPostgres, tick: number) {
  const admin = await connect(postgres.admin({ database: postgres.database }));
  try { await seed(admin, tick); } catch (error) { await admin.end(); throw error; }
  return admin;
}

async function connect(options: { host: string; port: number; database: string; user: string; password: string }) {
  const client = new Client(options);
  // Without a listener, a connection the cluster terminates during teardown
  // surfaces as an uncaughtException and buries the real failure.
  client.on("error", () => {});
  await client.connect();
  return client;
}

async function seed(admin: Client, tick: number) {
  // `control_web_sessions_check` is `expires_at > issued_at`, so the session has
  // to be issued BEFORE the instant it expires. PLAN-U4's earliest tick is in
  // September, ahead of NOW, so the expiry is derived from the latest tick and
  // the issue time is kept at NOW -- the identity is the same owner either way.
  const at = new Date(NOW).toISOString(), expires = new Date(Math.max(tick, NOW) + 86_400_000).toISOString();
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Recurring scheduling')", [ids.tenant]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Recurring scheduling')",
    [ids.workspace, ids.tenant]);
  await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES($1,$2,'control-room-manual','1.0.0','control_room_native',
    'disabled','v1',30)`, [ids.adapter, ids.tenant]);
  await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1','Recurring scheduling','running','manual_project_active','healthy',
    'control_room_native',$5,'{}',$5)`, [ids.project, ids.tenant, ids.workspace, ids.adapter, at]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,$3,$3)`, [ids.tenant, ids.project, at]);
  // `auth_provider` is not cosmetic: `work_batches_work_intake_scope` (0093) is a
  // RESTRICTIVE policy that admits an intake-session row only for an identity
  // whose provider is literally 'work-intake'. A proposing agent registered under
  // any other provider makes the shared intake login's INSERT raise, which the
  // scheduler records as a failed proposal -- every rule would silently never
  // propose anything. Same reasoning as tests/recurring-work-postgres.test.ts.
  for (const [identity, actor, subject, authProvider] of [
    [ids.owner, "human", "owner", provider], [ids.agent, "agent", "agent", "work-intake"]] as const)
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,$3,$1,$4,$5,'active',$6,$6)`,
    [identity, ids.tenant, actor, authProvider, sha256Digest({ provider: authProvider, subject }), at]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`,
    [ids.ownerGrant, ids.tenant, ids.owner, at]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'work_batch_proposer','["work_batches.propose"]',$4::jsonb,'low',false,false,$5,$5)`,
    [ids.agentGrant, ids.tenant, ids.agent, JSON.stringify([ids.project]), at]);
  await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`, [ids.tenant, tokenDigest, ids.owner, at, expires]);
  await admin.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)", [ids.tenant]);
}

function identity(tick: number): VerifiedWebIdentity {
  // The SAME owner session for every instant in a test. `assertFresh` requires
  // `expiresAt`/`verificationExpiresAt` to be strictly AFTER the service clock,
  // and the service clock is frozen at NOW, so the expiry has to be derived from
  // the latest instant the test will reach, not from the instant in hand --
  // otherwise the September ticks of PLAN-U4 expire before they are presented.
  const at = new Date(NOW).toISOString(), expires = new Date(Math.max(tick, NOW) + 86_400_000).toISOString();
  return { provider, subject: "owner", tokenDigest, issuedAt: at,
    expiresAt: expires, verificationExpiresAt: expires };
}

/**
 * The proposing agent's principal, valid at `tick`.
 *
 * `authenticatedAt` is the earlier of NOW and the tick, NOT always NOW. The policy
 * engine refuses `authentication_from_future` when the principal was authenticated
 * after the request instant, and PLAN-U4's ticks run in SEPTEMBER -- so a principal
 * authenticated at the October NOW is, to the policy engine, authenticated six weeks
 * in the future. Measured: every U4 proposal was refused `no_matching_grant`, which
 * is the generic "nothing matched" answer and says nothing about the clock
 * correction the case exists to test. The identity, tenant and grant are the same
 * either way; only the instant an agent authenticated moved.
 */
function principal(tick: number): AuthenticatedPrincipal {
  const authenticatedAt = new Date(Math.min(tick, NOW)).toISOString();
  const expires = new Date(Math.max(tick, NOW) + 86_400_000).toISOString();
  return { tenantId: ids.tenant, identityId: ids.agent, actorType: "agent", authenticatedAt, expiresAt: expires };
}

/** A rule body the owner service accepts; `suffix` keeps task templates distinct. */
function ruleInput(suffix: string) {
  return { schedule: "every day at 9", timezone: "UTC", title: `Daily check ${suffix}`,
    instructions: `Review the named inputs for ${suffix} and cite retained evidence.`,
    requiredCapability: "dependency.review", acceptanceCriteria: "Every claim cites its source.",
    acceptanceTests: "The owner checks each cited source.", skillRefs: [] };
}

/**
 * Creates `count` rules as the private-web owner login, oldest first.
 *
 * `at` is the instant written to each rule's own `last_evaluated_at` cursor, and it
 * is a parameter rather than always `NOW` because a case whose ticks run BEFORE
 * NOW has to seed a cursor before them. PLAN-U4's fixture left this at NOW and then
 * ticked in September, which gave every rule a cursor a month in its own future and
 * so an empty window on the very first tick -- the test measured the fixture's slip,
 * not the clock-correction defect it was written for.
 */
async function createRules(web: { client: DatabaseClient }, count: number, tick: number, suffix: string,
  at: number = NOW) {
  const rules = new RecurringRuleServiceV1(web.client,
    { tenantId: ids.tenant, workspaceId: ids.workspace }, () => at);
  const created = [];
  for (let index = 0; index < count; index += 1)
    created.push(await rules.create(identity(tick), ids.project, ruleInput(`${suffix} ${index}`)));
  return created;
}

/** The real S1 port, wrapped so a caller can hold or count every proposal. */
function s1Port(intake: { client: DatabaseClient }, tick: number) {
  const service = new WorkBatchServiceV1(new WorkBatchStoreV1(intake.client, new Uint8Array(32).fill(29)));
  return recurringWorkBatchProposalPortV1(service, principal(tick), () => tick);
}

async function ledgerRows(db: { client: DatabaseClient }, ruleId: string) {
  return (await db.client.query<{ occurrence_key: string; state: string; attempt_count: number;
    batch_id: string | null }>(`SELECT occurrence_key,state,attempt_count,batch_id
    FROM control_recurring_proposals WHERE tenant_id=$1 AND rule_id=$2`, [ids.tenant, ruleId])).rows;
}

async function countOn(admin: Client, sql: string, params: unknown[] = []) {
  return Number((await admin.query<{ count: number }>(sql, params)).rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// PLAN-U1 -- overlapping ticks ignore the declared maxConcurrentProposals: 1
// ---------------------------------------------------------------------------

test("PLAN-U1: fifty independent ticks enforce one concurrent proposal claim", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  ran += 1;
  const tick = Date.parse("2026-10-05T09:01:00.000Z"), port = PORT_BASE;
  await withRealPostgres(async postgres => {
    const admin = await seeded(postgres, tick);
    // 50 INDEPENDENT schedulers, each with its own bounded pool: the plan asks
    // for independently connected task-coordinator schedulers, because a single
    // shared pool would serialise them behind 8 admission slots and the
    // measurement would be of the pool, not of the missing proposal claim.
    const schedulers = Array.from({ length: 50 }, () => pool(postgres, "coordinator"));
    const web = pool(postgres, "web"), intake = pool(postgres, "control_room_work_intake_agent");
    try {
      const [rule] = await createRules(web, 1, tick, "concurrency");
      const real = s1Port(intake, tick);
      // One counting port shared by every racing scheduler, so the peak is the
      // number of proposals genuinely in flight at one moment rather than a sum of
      // per-scheduler totals.
      //
      // THE BARRIER IS HELD BY TIME, NOT BY ARRIVAL, and that is the correction
      // that makes this a test of the fix rather than a deadlock. The first
      // version released the barrier once all fifty racers had ARRIVED, which
      // measured the defect exactly -- but it is a barrier that only opens if the
      // defect is present, so against fixed code it waits forever. Measured: the
      // test timed out at 300 s with peak=0 and one caller still holding the port.
      //
      // A short real-time hold instead measures the same quantity on both sides of
      // the fix: on the old code all fifty callers pile in during the window and
      // the peak is fifty; on the fixed code one holds the claim and the other
      // forty-nine are refused at the claim, so the peak is one. The window is
      // bounded and unconditional, so the test terminates either way.
      let inFlight = 0, peak = 0, calls = 0;
      const HOLD_MS = 200;
      const port: RecurringProposalPortV1 = { propose: async input => {
        inFlight += 1; calls += 1; peak = Math.max(peak, inFlight);
        try { await new Promise<void>(resolve => { setTimeout(resolve, HOLD_MS); }); return await real.propose(input); }
        finally { inFlight -= 1; }
      } };
      // Every racer is launched before any is awaited, so all fifty are genuinely
      // competing for the claim rather than arriving one after another.
      const results = await Promise.all(schedulers.map(entry => new RecurringRuleSchedulerV1(
        entry.client, ids.tenant, { read: () => "running" }, port, () => tick).tick()));
      // No caller may still hold the port here, or the peak is fiction.
      assert.equal(inFlight, 0, "every proposal call returned before the peak is read");
      assert.equal(calls, 1, "exactly one of fifty racers reached the proposal boundary at all");
      assert.equal(peak, 1, "the S7b maxConcurrentProposals ceiling of 1 held: peak simultaneous proposals");
      const rows = await ledgerRows(schedulers[0]!, rule.ruleId);
      assert.equal(rows.length, 1, "one occurrence row, so 50 ticks are one occurrence and not 50");
      assert.equal(rows[0]!.state, "proposed");
      assert.equal(Number(rows[0]!.attempt_count), 1,
        "the single owned attempt is counted once; replays must not spend the retry budget");
      assert.equal(await countOn(admin, "SELECT count(*)::int count FROM work_batches"), 1);
      assert.equal(await countOn(admin, "SELECT count(*)::int count FROM control_attempts"), 0,
        "a recurring proposal starts no work");
      assert.equal(await countOn(admin, "SELECT count(*)::int count FROM control_jobs"), 0);
      // A receipt replay is reported separately from a newly created proposal,
      // so exactly one tick claims the batch while the others see the same one.
      assert.equal(results.filter(result => result.proposed.length > 0).length, 1,
        "exactly one tick reports the proposal as newly created");
      assert.equal(await countOn(admin,
        "SELECT count(*)::int count FROM control_recurring_proposals WHERE state='failed'"), 0,
        "a fenced tick is not recorded as a failure");
    } finally {
      await admin.end();
      await Promise.all([web.close(), intake.close(), ...schedulers.map(entry => entry.close())]);
    }
  }, { port, allowedPorts: [port], boundMs: 300_000 });
});

// ---------------------------------------------------------------------------
// PLAN-U2 -- a due rule beyond the first 100 active rules is never visited
// ---------------------------------------------------------------------------

test("PLAN-U2: active rule 101 is visited across bounded ticks", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  ran += 1;
  const tick = Date.parse("2026-10-05T09:01:00.000Z"), port = PORT_BASE + 1;
  await withRealPostgres(async postgres => {
    const admin = await seeded(postgres, tick);
    const web = pool(postgres, "web"), coordinator = pool(postgres, "coordinator"),
      intake = pool(postgres, "control_room_work_intake_agent");
    try {
      const created = await createRules(web, 101, tick, "paging");
      assert.equal(created.length, 101);
      const visited: string[] = [];
      const real = s1Port(intake, tick);
      const counting: RecurringProposalPortV1 = { propose: async input => {
        visited.push(input.ruleId); return await real.propose(input);
      } };
      // WHICH RULE IS "PAST THE WINDOW" IS NOT THE LAST ONE CREATED. rule ids are
      // `recurring-rule:<uuid>`, so the scan's `ORDER BY rule_id` is a UUID ordering
      // and creation order is uncorrelated with it. The original case took
      // `created.at(-1)`, whose own comment claims it is the lexically greatest
      // "only because ids are minted in order" -- measured, that is false for UUIDs,
      // and so the case was asserting about whichever rule happened to sort last.
      // The rule past the window is named from the DATABASE's own ordering: the
      // 101st row the scan will actually reach.
      const ordered = (await coordinator.client.query<{ rule_id: string }>(`SELECT rule_id
        FROM control_recurring_rules WHERE tenant_id=$1 AND state='active' ORDER BY rule_id`,
      [ids.tenant])).rows.map(row => row.rule_id);
      const pastWindow = ordered.at(-1)!;
      assert.equal(ordered.length, 101, "the fixture really created 101 active rules");
      // ENOUGH TICKS TO WALK PAST THE WINDOW, and the number is derived rather than
      // chosen. Five ticks cannot do it: the per-cycle cap is three, so five ticks
      // reach fifteen rules, and one hundred and one rules need thirty-four. The
      // first version of this case used five -- the review's number -- and it could
      // only ever have passed by luck about which rules were where, so it proved
      // nothing about the window it names. The scan is bounded but not that bounded:
      // the bound is a deadline, and a tick every minute makes 34 ticks five and a
      // half minutes of real time.
      const ticksNeeded = Math.ceil(101 / RECURRING_S7B_CAPS_V1.maxProposalsPerCycle);
      assert.equal(ticksNeeded, 34, "101 rules at three proposals a cycle is 34 ticks");
      for (let index = 0; index < ticksNeeded; index += 1) await new RecurringRuleSchedulerV1(coordinator.client,
        ids.tenant, { read: () => "running" }, counting, () => tick).tick();
      assert.ok(visited.includes(pastWindow),
        `the rule past the fixed 100-row window was visited; ${visited.length} rules were proposed of ${ordered.length}`);
      const rows = await ledgerRows(coordinator, pastWindow);
      assert.equal(rows.length, 1, "one occurrence retained for the rule beyond the window");
      assert.equal(rows[0]!.state, "proposed");
      assert.equal(Number(rows[0]!.attempt_count), 1,
        "one occurrence and one attempt, so the bounded scan never duplicates it");
      assert.equal(await countOn(admin,
        "SELECT count(*)::int count FROM control_recurring_proposals WHERE rule_id=$1", [pastWindow]), 1);
    } finally { await admin.end(); await Promise.all([web.close(), coordinator.close(), intake.close()]); }
  }, { port, allowedPorts: [port], boundMs: 420_000 });
});

// ---------------------------------------------------------------------------
// PLAN-U3 -- three persistently failing rules block every healthy rule behind them
// ---------------------------------------------------------------------------

test("PLAN-U3: persistent failures do not starve the fourth due rule", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  ran += 1;
  const tick = Date.parse("2026-10-05T09:01:00.000Z"), port = PORT_BASE + 2;
  await withRealPostgres(async postgres => {
    const admin = await seeded(postgres, tick);
    const web = pool(postgres, "web"), coordinator = pool(postgres, "coordinator"),
      intake = pool(postgres, "control_room_work_intake_agent");
    try {
      const created = await createRules(web, 4, tick, "starvation");
      const failing = new Set(created.slice(0, 3).map(rule => rule.ruleId));
      const healthy = created[3]!.ruleId;
      const real = s1Port(intake, tick);
      let healthyCalls = 0;
      const perRule = new Map<string, number>();
      const port: RecurringProposalPortV1 = { propose: async input => {
        perRule.set(input.ruleId, (perRule.get(input.ruleId) ?? 0) + 1);
        if (failing.has(input.ruleId)) throw new Error("fixture_proposal_failure");
        healthyCalls += 1; return await real.propose(input);
      } };
      // TWENTY TICKS SPREAD ACROSS THE BACKOFF WINDOWS, and that is the correction.
      // The first version froze all twenty at one instant, which is precisely the
      // schedule that made the original defect invisible: on a frozen clock a
      // backoff means ONE call per failing rule, so the test could only ever have
      // proved the fix by asserting a count the defect never produced anyway. A
      // starved rule only shows itself when ticks actually pass.
      //
      // Each tick advances 15 minutes, which is exactly the backoff, so every
      // failing rule is eligible again at every tick. That is the STRICTEST reading
      // available: if the backoff were even one millisecond longer the cap would
      // never be reached, and if it were shorter the cap would not be what limits
      // the calls. The three-attempt cap is the only thing that ends the retries.
      const BACKOFF_MS = 15 * 60_000;
      for (let index = 0; index < 20; index += 1) {
        const at = tick + index * BACKOFF_MS;
        await new RecurringRuleSchedulerV1(coordinator.client, ids.tenant,
          { read: () => "running" }, port, () => at).tick();
      }
      assert.equal(healthyCalls, 1,
        "the healthy rule behind three permanently failing rules is proposed exactly once");
      // The three-attempt cap is the owner's stated retry bound, so the starvation
      // fix must not quietly raise it. Each failing rule is offered a call on the
      // first three ticks, is refused by the cap on the fourth, and is never called
      // again for the remaining sixteen.
      for (const ruleId of failing)
        assert.equal(perRule.get(ruleId) ?? 0, 3,
          `the three-call cap still holds for the failing rule ${ruleId}`);
      const healthyRows = await ledgerRows(coordinator, healthy);
      assert.equal(healthyRows.length, 1);
      assert.equal(healthyRows[0]!.state, "proposed");
    } finally { await admin.end(); await Promise.all([web.close(), coordinator.close(), intake.close()]); }
  }, { port, allowedPorts: [port], boundMs: 300_000 });
});

// ---------------------------------------------------------------------------
// PLAN-U4 -- a forward clock jump then a correction suppresses work until the
// erroneous future instant is reached
// ---------------------------------------------------------------------------

test("PLAN-U4: a future cursor recovers after a wall-clock correction and restart", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  ran += 1;
  // The three instants from the review. The middle one is the erroneous future.
  const september7 = Date.parse("2026-09-07T09:01:00.000Z");
  const september14 = Date.parse("2026-09-14T09:01:00.000Z");
  const september8 = Date.parse("2026-09-08T09:01:00.000Z");
  const port = PORT_BASE + 3;
  await withRealPostgres(async postgres => {
    const admin = await seeded(postgres, september14);
    const web = pool(postgres, "web"), coordinator = pool(postgres, "coordinator"),
      intake = pool(postgres, "control_room_work_intake_agent");
    try {
      // Seeded at 08:59 on September 7, which is the cursor the review's
      // reproduction names. The rule is CREATED at that instant, so its own
      // last_evaluated_at is behind the 09:00 occurrence the first tick is due to
      // find -- an empty window here would be the fixture's fault, not the fix's.
      // Seeded at 08:59 on September 7, which is the cursor the review's
      // reproduction names. It is written with one statement rather than by
      // creating the rule in the past: `RecurringRuleServiceV1` is constructed with
      // the session authority's own clock, so creating "in September" would make
      // the owner session -- issued at NOW -- look unissued, and the rule service
      // refused with `authentication_required` before any recurrence was involved.
      const [rule] = await createRules(web, 1, september14, "clock");
      // Placed as the COORDINATOR, not the web login: 0243 leaves `last_evaluated_at`
      // as the coordinator's column (0243's role file does not widen the web
      // login's rule UPDATE, which covers schedule and version fields), and the web
      // login's attempt was refused 42501 -- read as `database_unavailable`, which
      // is how a missing column grant presents to a caller. Measured, not assumed.
      await coordinator.client.query(`UPDATE control_recurring_rules SET last_evaluated_at=$1
        WHERE tenant_id=$2 AND rule_id=$3`, ["2026-09-07T08:59:00.000Z", ids.tenant, rule.ruleId]);
      const real = s1Port(intake, september8);
      const proposed: string[] = [];
      const refusals: string[] = [];
      const port: RecurringProposalPortV1 = { propose: async input => {
        proposed.push(input.occurrenceKey);
        try { return await real.propose(input); }
        catch (error) { refusals.push(String(error)); throw error; }
      } };
      const tickAt = (at: number) => new RecurringRuleSchedulerV1(coordinator.client, ids.tenant,
        { read: () => "running" }, port, () => at).tick();
      // Day one: the legitimate occurrence is proposed.
      const first = await tickAt(september7);
      // The two facts that must hold before the correction means anything: the
      // window really had an occurrence, and the ledger really recorded whatever
      // happened to it. Without this the case reports "nothing was proposed" for
      // either of two very different reasons -- a refused admission and an empty
      // window -- and they need different fixes.
      assert.equal(first.proposed.length, 1, `S1 refusals: ${refusals.join(" | ")}`);
      assert.deepEqual((await coordinator.client.query(`SELECT state,safe_reason_code,attempt_count
        FROM control_recurring_proposals WHERE tenant_id=$1 AND rule_id=$2`,
      [ids.tenant, rule.ruleId])).rows.map(row => [row.state, row.safe_reason_code, Number(row.attempt_count)]),
        [["proposed", null, 1]], "the first tick proposes the September 7 occurrence exactly once");
      assert.match(proposed[0]!, /2026-09-07T09:00/u);
      // The clock jumps a week forward. The cursor is behind, so a real catch-up
      // window exists and this is a legitimate tick, not a fault.
      const jumped = await tickAt(september14);
      assert.equal(jumped.failed.length, 0, "a genuine forward jump is a catch-up tick, not a failure");
      assert.ok(proposed.length >= 2, "the forward tick proposed the newer occurrence");
      const afterJump = proposed.length;
      // The clock is corrected BACK one day. The retained cursor is a week in the
      // future, so every window built from it is refused and the rule never runs
      // again until the erroneous instant actually arrives.
      for (let index = 0; index < 5; index += 1) await tickAt(september8);
      assert.ok(proposed.length > afterJump,
        "legitimate September 8 work is not silently suppressed by the future cursor");
      // Reconstruction between ticks is the restart the review asks for.
      for (let index = 0; index < 3; index += 1) await tickAt(september8);
      assert.ok(proposed.length > afterJump, "a reconstructed scheduler also keeps working");
      // Neither the September 7 nor the September 14 occurrence is duplicated.
      const rows = await ledgerRows(coordinator, rule.ruleId);
      const keys = rows.map(row => row.occurrence_key);
      assert.equal(new Set(keys).size, keys.length, "every retained occurrence key is distinct");
      for (const row of rows) {
        assert.equal(row.state, "proposed");
        assert.equal(Number(row.attempt_count), 1,
          `the ${row.occurrence_key} occurrence was proposed exactly once across the correction`);
      }
      assert.equal(keys.filter(key => key.includes("2026-09-07")).length, 1);
      assert.equal(await countOn(admin, "SELECT count(*)::int count FROM control_attempts"), 0);
    } finally { await admin.end(); await Promise.all([web.close(), coordinator.close(), intake.close()]); }
  }, { port, allowedPorts: [port], boundMs: 300_000 });
});

// ---------------------------------------------------------------------------
// PLAN-U5 -- pausing a rule after selection still submits its old proposal
// ---------------------------------------------------------------------------

test("PLAN-U5: a committed rule pause fences a selected occurrence", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  ran += 1;
  const tick = Date.parse("2026-10-05T09:01:00.000Z"), port = PORT_BASE + 4;
  await withRealPostgres(async postgres => {
    const admin = await seeded(postgres, tick);
    const web = pool(postgres, "web"), coordinator = pool(postgres, "coordinator"),
      intake = pool(postgres, "control_room_work_intake_agent");
    // Independent connections for the owner and the scheduler, exactly as the
    // review specifies: the pause commits on the owner's connection while the
    // scheduler holds its own row read open.
    const ownerConnection = await connect(postgres.connection("web"));
    const coordinatorConnection = await connect(postgres.connection("coordinator"));
    try {
      const [rule] = await createRules(web, 1, tick, "pause");
      let submitted = 0;
      const real = s1Port(intake, tick);
      const port: RecurringProposalPortV1 = { propose: async input => {
        submitted += 1; return await real.propose(input);
      } };
      // THE BARRIER IS ON THE SECOND MODE READ, AND THAT IS THE WHOLE TEST. The
      // first version gated the FIRST `operations.read()`, which happens before the
      // rule scan -- so the owner's Pause committed while the scheduler had not yet
      // read the rule at all, and the old unfixed scheduler then found it paused on
      // its own snapshot SELECT and proposed nothing. Measured: this case PASSED
      // against the pre-fix scheduler (the file at 317503d8c), which makes it a test
      // that certifies a fix it cannot detect. Gating the second read puts the Pause
      // in the window that actually exists: after the rule has been selected as
      // active, before anything is admitted.
      //
      // The second read is the one an implementation makes at ADMISSION, so a
      // scheduler that never gets there (because it found the rule paused) resolves
      // the barrier's promise without ever blocking on it.
      let reads = 0, selected!: () => void, releaseBarrier!: () => void;
      const reachedSelection = new Promise<void>(resolve => { selected = resolve; });
      const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
      const scheduler = new RecurringRuleSchedulerV1(coordinator.client, ids.tenant,
        { read: async (): Promise<"running"> => {
          // `read` must resolve to a `SupervisorRunModeV1`, not a bare string: the
          // port's own type names the four modes, and an async arrow returning
          // "running" widens to `Promise<string>`, which is not assignable.
          reads += 1;
          if (reads === 1) return "running";
          selected();
          await barrier;
          return "running";
        } }, port, () => tick);
      const ticked = scheduler.tick();
      // The first read is the installation-mode boundary, before any rule is looked
      // at. Wait for it before anything else, so the wait below cannot be satisfied
      // by the FIRST read arriving late.
      while (reads < 1) await new Promise<void>(resolve => { setTimeout(resolve, 5); });
      await reachedSelection;
      // The scheduler has now read the rule as active and is blocked at admission.
      // Commit the owner's Pause here.
      const rules = new RecurringRuleServiceV1(web.client,
        { tenantId: ids.tenant, workspaceId: ids.workspace }, () => NOW);
      const paused = await rules.setPaused(identity(tick), ids.project, rule.ruleId,
        { paused: true, expectedVersion: 1 });
      assert.equal(paused.state, "paused");
      assert.equal(paused.version, 2);
      releaseBarrier();
      const result = await ticked;
      assert.equal(submitted, 0, "no S1 submission for a rule paused after selection");
      assert.deepEqual(result.proposed, []);
      assert.equal(await countOn(admin,
        `SELECT count(*)::int count FROM control_recurring_proposals WHERE rule_id=$1 AND state='proposed'`,
        [rule.ruleId]), 0, "no proposed occurrence survives a committed pause");
      // NO LEDGER ROW AT ALL, which is stronger than the review asked for and is
      // what the fence actually buys. The review expected one retained occurrence;
      // this implementation gets there the other way round. A fence means the
      // admission never happened, and an admission is what spends an attempt and
      // writes the row -- so a pause that wins the row lock leaves nothing behind
      // to be mistaken later for work that was owed. A retained `pending` row would
      // have been worse: it would look like an attempt the owner had to think about
      // for work that never started.
      assert.equal(await countOn(admin,
        `SELECT count(*)::int count FROM control_recurring_proposals WHERE rule_id=$1`, [rule.ruleId]), 0,
        "a fence spends no attempt and leaves no ledger row, so nothing looks owed");
      // And the rule's own cursor did not move either, so the occurrence is still
      // genuinely due whenever the owner resumes the rule.
      assert.equal((await admin.query(`SELECT last_evaluated_at FROM control_recurring_rules
        WHERE tenant_id=$1 AND rule_id=$2`, [ids.tenant, rule.ruleId])).rows[0]!.last_evaluated_at.toISOString(),
        new Date(NOW).toISOString(), "a fenced rule's cursor is untouched, so resuming proposes the occurrence");
      assert.equal(await countOn(admin, "SELECT count(*)::int count FROM work_batches"), 0,
        "a fenced selection starts no work at all");
      assert.equal(await countOn(admin, "SELECT count(*)::int count FROM control_attempts"), 0);
    } finally {
      await admin.end();
      await ownerConnection.end(); await coordinatorConnection.end();
      await Promise.all([web.close(), coordinator.close(), intake.close()]);
    }
  }, { port, allowedPorts: [port], boundMs: 300_000 });
});

// ---------------------------------------------------------------------------
// PLAN-U6 -- an operations-mode halt spends one of the occurrence's three
// attempts without ever calling S1
// ---------------------------------------------------------------------------

test("PLAN-U6: a committed operations-mode halt spends no attempt", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  ran += 1;
  const tick = Date.parse("2026-10-05T09:01:00.000Z"), port = PORT_BASE + 5;
  // The backoff, restated here rather than imported: it is private to the scheduler,
  // and this case has to wait it out on real PostgreSQL the way an installation
  // would. It is also the constant PLAN-U3 is written against, so the two agreeing
  // here is a check rather than a copy.
  const BACKOFF_MS = 15 * 60_000;
  await withRealPostgres(async postgres => {
    const admin = await seeded(postgres, tick);
    const web = pool(postgres, "web"), coordinator = pool(postgres, "coordinator"),
      intake = pool(postgres, "control_room_work_intake_agent");
    try {
      const [rule] = await createRules(web, 1, tick, "halt");
      let submitted = 0;
      const real = s1Port(intake, tick);
      const port_: RecurringProposalPortV1 = { propose: async input => {
        submitted += 1; return await real.propose(input);
      } };
      const ledgerAt = async () => (await coordinator.client.query<{ state: string; attempt_count: number;
        safe_reason_code: string | null }>(`SELECT state,attempt_count,safe_reason_code
        FROM control_recurring_proposals WHERE tenant_id=$1 AND rule_id=$2`, [ids.tenant, rule.ruleId])).rows;
      // FOUR HALTS, ONE PER BACKOFF WINDOW, on the same occurrence. The mode is
      // read twice per tick: the first read admits the scan and the second is the
      // admission-time read, so flipping the port between them puts the halt in the
      // only window where it is observed after the rule has been selected as due.
      // Only the FIRST halt reaches admission at all -- a retained row is inside its
      // own backoff -- which is exactly why the defect the review found is invisible
      // on a fresh occurrence and visible on every later one.
      for (let index = 0; index < 4; index += 1) {
        let reads = 0;
        const at = tick + index * BACKOFF_MS;
        const halted = await new RecurringRuleSchedulerV1(coordinator.client, ids.tenant,
          { read: () => ++reads === 1 ? "running" : "paused" }, port_, () => at).tick();
        assert.equal(halted.halted, "paused", `halt ${index + 1} at ${new Date(at).toISOString()} was observed`);
        const rows = await ledgerAt();
        assert.equal(rows.length, 1, "one retained occurrence across every halt");
        assert.deepEqual([rows[0]!.state, Number(rows[0]!.attempt_count), rows[0]!.safe_reason_code],
          ["failed", 1, "operations_mode"],
          `the halt is recorded but spends no attempt (halt ${index + 1})`);
      }
      assert.equal(submitted, 0, "no S1 submission for any halted occurrence");
      assert.equal(await countOn(admin, "SELECT count(*)::int count FROM work_batches"), 0);
      // THE POINT OF THE GUARD: four owner-initiated stops and the occurrence has
      // still spent none of its budget, so it is still proposable. On the reviewed
      // code the four halts took attempt_count to 4 -- past the three-attempt cap --
      // so the occurrence left the scan as `attempt_cap` and could never be proposed
      // at all, with the owner's own Pause as the reason and nothing ever offered to
      // S1.
      const afterHalt = tick + 4 * BACKOFF_MS;
      const proposed = await new RecurringRuleSchedulerV1(coordinator.client, ids.tenant,
        { read: () => "running" }, port_, () => afterHalt).tick();
      assert.equal(proposed.proposed.length, 1,
        "an occurrence stopped four times by the owner's own operations mode is still proposed");
      assert.deepEqual((await ledgerAt()).map(row => [row.state, Number(row.attempt_count)]),
        [["proposed", 2]], "and only the real proposal call spent an attempt");
      assert.equal(submitted, 1);
      assert.equal(await countOn(admin, "SELECT count(*)::int count FROM work_batches"), 1);
      assert.equal(await countOn(admin, "SELECT count(*)::int count FROM control_attempts"), 0,
        "recurring proposals still start no work");
    } finally { await admin.end(); await Promise.all([web.close(), coordinator.close(), intake.close()]); }
  }, { port, allowedPorts: [port], boundMs: 300_000 });
});

test("the recurring scheduling proofs ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(ran, 0); return; }
  assert.equal(ran, 6);
});