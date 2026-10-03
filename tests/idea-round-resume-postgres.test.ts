// Real-PostgreSQL proof for M3-IDEA-U01 (P1): an interrupted first Idea Lab
// round must be RESUMABLE, not stranded.
//
// The QA fixture reproduced, on PGlite, that a failure while the Nth
// participant's ordinary task is being proposed leaves the round with only
// N-1 links, and that every later retry is refused as a conflict, because
// WebIdeaRoundProposalOperation requires an existing first round to already
// hold exactly `participants.length` links. The discussion is then stranded:
// the detail wire requires a minimum task count the partial lineage cannot
// reach, and no amount of retrying can fill the gap.
//
// This file proves the behaviour on REAL PostgreSQL 17, driving the real
// WebIdeaRoundProposalOperation through the production web login, and then
// proves that the fix (idempotently filling the missing turn) makes an exact
// retry converge on a complete round with zero attempts and zero leases.
//
// Reserved disposable-cluster lane for this file: 59860-59869.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { buildIdeaLabContributionV1, buildIdeaLabSessionV1, buildIdeaLabSynthesisV1 } from "../src/idea-lab/v1/contracts";
import { IdeaLabCanonicalTaskLinkStoreV1 } from "../src/idea-lab/v1/canonical-task-link-store";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { WebIdeaRoundProposalOperation } from "../src/web/v1/idea-round-proposal-operation";
import { WebTaskService } from "../src/web/v1/task-service";
import { WebProjectService } from "../src/web/v1/project-service";
import { sha256Digest } from "../src/security";
import { WebAccessError, type VerifiedWebIdentity } from "../src/web/v1/access-verifier";

const PORT = Number(process.env.IDEA_RESUME_PG_PORT ?? 59860);
const PORTS = [59860, 59861, 59862, 59863, 59864, 59865];
const PG = requiresRealPostgres();
const NOW = "2026-09-29T15:00:00.000Z";
const LATER = "2026-09-29T16:00:00.000Z";
const KEY = new Uint8Array(32).fill(0x4d);
const scope = { tenantId: "tenant:idea-resume", workspaceId: "workspace:idea-resume" };
const IDENTITY_ID = "identity:idea-resume";
const identity: VerifiedWebIdentity = { provider: "test", subject: "idea-resume-owner",
  tokenDigest: sha256Digest("idea-resume-web-session"), issuedAt: NOW, expiresAt: LATER, verificationExpiresAt: LATER };

/** One connection is one `DatabaseClient`, exactly as the private web host
 * composes it. The `query`/`transaction` pair is the real production shape. */
function database(client: Client): DatabaseClient {
  const session: DatabaseSession = { query: async <T>(sql: string, values?: unknown[]) => {
    const result = await client.query(sql, values as never[]); return { rows: result.rows as T[] };
  } };
  return {
    query: session.query,
    transaction: async work => {
      await client.query("BEGIN");
      try { const value = await work(session); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    },
    transactionWithPreCommitCheck: async (work, check) => {
      await client.query("BEGIN");
      try { const value = await work(session); await check(); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    },
  };
}

/** Tenant, workspace, the one ordinary project, and a saved one-round session
 * with four participants. Everything is written through the real production
 * services, so every stored digest is the one the product computes. */
async function seed(admin: Client) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [scope.tenantId]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [scope.workspaceId, scope.tenantId]);
  await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES('adapter.control-room-native-ideas',$1,'control_room_native_ideas','1.0.0','control_room_native','online',
    '["business_validation"]'::jsonb,'["read_project"]'::jsonb,'[]'::jsonb,'v1',30)`, [scope.tenantId]);
  await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Owner','test',$3,'active',$4,$4)`,
  [IDENTITY_ID, scope.tenantId, sha256Digest({ provider: "test", subject: identity.subject }), NOW]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:idea-resume',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,
  [scope.tenantId, IDENTITY_ID, NOW]);
  await admin.query("INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)",
    [scope.tenantId, identity.tokenDigest, IDENTITY_ID, NOW, LATER]);

  const setup = database(admin);
  const { project } = await new WebProjectService(setup, scope, () => Date.parse(NOW))
    .create(identity, { title: "Idea resume project", summary: "Ordinary project that owns the discussion." }, "idea-resume-project-001");

  const source = buildIdeaLabFixtureV1();
  const session = buildIdeaLabSessionV1({ sessionId: "idea:resume-pg", tenantId: scope.tenantId,
    workspaceId: scope.workspaceId, title: source.session.title, ideaSummary: source.session.ideaSummary,
    targetCustomer: source.session.targetCustomer, participants: source.session.participants, maxRounds: 1,
    maxDurationSeconds: 900, maxCostUsd: source.session.maxCostUsd,
    createdByIdentityDigest: source.session.createdByIdentityDigest, createdAt: NOW });
  await new IdeaLabProjectRegistryStoreV1(setup, KEY).registerSession(session);
  return { project, session };
}

test("M3-IDEA-U01: an interrupted first Idea Lab round resumes to a complete round on real PostgreSQL", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      const { project, session } = await seed(admin);
      const web = new Client(postgres.connection("web")); await web.connect();
      try {
        const db = database(web);
        const links = new IdeaLabCanonicalTaskLinkStoreV1(db, KEY);
        const tasks = new WebTaskService(db, scope, () => Date.parse(NOW), { ideaIntegrityKey: KEY });
        const request = { sessionDigest: session.sessionDigest, projectId: project.projectId, round: 1 };

        // The interruption: the SECOND participant's proposal fails after the
        // first has committed. This is the shape a dropped connection or a
        // transient database error takes, injected at the real call the
        // operation makes - not around it.
        let calls = 0;
        const failing = {
          proposeWithDependencies: async (...args: Parameters<WebTaskService["proposeWithDependencies"]>) => {
            calls += 1;
            if (calls === 2) throw new Error("injected_lost_reply_after_first_task_commits");
            return tasks.proposeWithDependencies(...args);
          },
        };
        const interrupted = new WebIdeaRoundProposalOperation(db, scope, KEY,
          failing as unknown as WebTaskService, () => Date.parse(NOW));
        await assert.rejects(interrupted.propose(identity, session.sessionId, request));
        assert.equal(calls, 2, "the failure happened on the second participant");

        // The strand: one of four participant tasks is linked, and the round is
        // NOT complete. This is the state the owner is left in.
        const partial = await links.list(session.tenantId, session.sessionId);
        assert.equal(partial.length, 1, "the interrupted round left a partial lineage");
        assert.notEqual(partial.length, session.participants.length);

        // Twenty exact retries. Every one must converge rather than conflict.
        const operation = new WebIdeaRoundProposalOperation(db, scope, KEY, tasks, () => Date.parse(NOW));
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const result = await operation.propose(identity, session.sessionId, request);
          assert.equal(result.startsWork, false);
        }

        // The resumed round is complete: one unique proposed job per participant.
        const resumed = await links.list(session.tenantId, session.sessionId);
        assert.equal(resumed.length, session.participants.length,
          "an exact retry must fill the missing turn rather than refuse");
        assert.equal(new Set(resumed.map(link => link.participantId)).size, session.participants.length,
          "each participant holds exactly one task");
        assert.equal(new Set(resumed.map(link => link.jobId)).size, session.participants.length,
          "each participant's task has a distinct job");
        assert.equal(resumed.every(link => link.projectId === project.projectId), true,
          "no second project binding was created");
        assert.equal((await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_idea_canonical_task_sessions WHERE tenant_id=$1",
          [scope.tenantId])).rows[0]?.count, "1", "still exactly one project binding");

        // Preparing tasks starts nothing: no attempt, no lease.
        assert.equal((await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_attempts WHERE tenant_id=$1", [scope.tenantId])).rows[0]?.count, "0");
        assert.equal((await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_leases WHERE tenant_id=$1", [scope.tenantId])).rows[0]?.count, "0");
        // Every task is a proposal, not work.
        const states = await db.query<{ state: string; count: string }>(
          "SELECT state,count(*)::text AS count FROM control_jobs WHERE tenant_id=$1 GROUP BY state ORDER BY state",
          [scope.tenantId]);
        assert.deepEqual(states.rows, [{ state: "proposed", count: String(session.participants.length) }]);
      } finally { await web.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 120_000 });
});

test("M3-IDEA-U01: the read path reports a partial round the browser can parse, and it disappears when complete",
  async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    await withRealPostgres(async postgres => {
      const admin = new Client(postgres.admin()); await admin.connect();
      try {
        const { project, session } = await seed(admin);
        const web = new Client(postgres.connection("web")); await web.connect();
        try {
          const db = database(web);
          const links = new IdeaLabCanonicalTaskLinkStoreV1(db, KEY);
          const tasks = new WebTaskService(db, scope, () => Date.parse(NOW), { ideaIntegrityKey: KEY });
          let calls = 0;
          const failing = { proposeWithDependencies: async (...args: Parameters<WebTaskService["proposeWithDependencies"]>) => {
            calls += 1;
            if (calls === 2) throw new Error("injected_lost_reply_after_first_task_commits");
            return tasks.proposeWithDependencies(...args);
          } };
          await assert.rejects(new WebIdeaRoundProposalOperation(db, scope, KEY,
            failing as unknown as WebTaskService, () => Date.parse(NOW))
            .propose(identity, session.sessionId, { sessionDigest: session.sessionDigest,
              projectId: project.projectId, round: 1 }));

          // The detail the browser actually parses. A partial round must be
          // representable, otherwise the owner cannot see the round to retry it.
          const { WebIdeaService } = await import("../src/web/v1/idea-service");
          const { ideaDetailSchema } = await import("../src/web/v1/idea-wire");
          const service = new WebIdeaService(db, scope, KEY, () => Date.parse(NOW), true, false, false, true, false, false);
          const detail = service.detail(identity, session.sessionId);
          const parsed = ideaDetailSchema.safeParse(await detail);
          assert.equal(parsed.success, true,
            `a partial first round must parse for the browser: ${parsed.success ? "" : parsed.error.message}`);
          assert.equal(parsed.data?.canonicalTasks?.taskCount, 1);
          // ...and the owner is offered the one action that can finish it.
          assert.equal(parsed.data?.unfinishedRound, 1, "the partial round is named so the owner can act");
          assert.equal(parsed.data?.canFinishRound, true, "a configured installation offers the resume action");
          assert.equal(parsed.data?.canPrepareNextRound, false,
            "a partial round is not a later round and must not be offered as one");
          assert.equal(parsed.data?.nextCanonicalRound, null);
          // The resume control appears in the rendered page.
          const { renderToStaticMarkup } = await import("react-dom/server");
          const { createElement } = await import("react");
          const { IdeaDiscussion } = await import("../private-app/app/idea-workspace");
          const markup = renderToStaticMarkup(createElement(IdeaDiscussion, { detail: parsed.data! }));
          assert.match(markup, /Round 1 is unfinished/);
          assert.match(markup, /Only 1 of 4 tasks for this round were saved/);

          // Once finished, the same state reads as a complete round.
          const finisher = new WebTaskService(db, scope, () => Date.parse(NOW), { ideaIntegrityKey: KEY });
          await new WebIdeaRoundProposalOperation(db, scope, KEY, finisher, () => Date.parse(NOW))
            .propose(identity, session.sessionId, { sessionDigest: session.sessionDigest,
              projectId: project.projectId, round: 1 });
          const complete = ideaDetailSchema.safeParse(await service.detail(identity, session.sessionId));
          assert.equal(complete.success, true);
          assert.equal(complete.data?.unfinishedRound, null, "a complete round offers no resume");
          assert.equal(complete.data?.canFinishRound, false);
          assert.equal(complete.data?.canonicalTasks?.taskCount, session.participants.length);
        } finally { await web.end(); }
      } finally { await admin.end(); }
    }, { port: PORT, allowedPorts: PORTS, boundMs: 120_000 });
  });

test("M3-IDEA-U01: a changed owner follow-up still cannot join a partial first round", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      const { project, session } = await seed(admin);
      const web = new Client(postgres.connection("web")); await web.connect();
      try {
        const db = database(web);
        const tasks = new WebTaskService(db, scope, () => Date.parse(NOW), { ideaIntegrityKey: KEY });
        let calls = 0;
        const failing = { proposeWithDependencies: async (...args: Parameters<WebTaskService["proposeWithDependencies"]>) => {
          calls += 1;
          if (calls === 2) throw new Error("injected_lost_reply_after_first_task_commits");
          return tasks.proposeWithDependencies(...args);
        } };
        await assert.rejects(new WebIdeaRoundProposalOperation(db, scope, KEY,
          failing as unknown as WebTaskService, () => Date.parse(NOW))
          .propose(identity, session.sessionId, { sessionDigest: session.sessionDigest,
            projectId: project.projectId, round: 1 }));

        // The fix must NOT become a way to rewrite an already-linked turn. A
        // second round is where a follow-up belongs; a first round carries none,
        // so a caller supplying one is refused at the input boundary as before.
        await assert.rejects(new WebIdeaRoundProposalOperation(db, scope, KEY, tasks, () => Date.parse(NOW))
          .propose(identity, session.sessionId, { sessionDigest: session.sessionDigest,
            projectId: project.projectId, round: 1, followUp: "A different scope entirely." }),
        /invalid_request/u, "a first round cannot carry an owner follow-up");
        // The partial lineage is untouched by that refusal.
        assert.equal((await new IdeaLabCanonicalTaskLinkStoreV1(db, KEY)
          .list(session.tenantId, session.sessionId)).length, 1);
      } finally { await web.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 120_000 });
});

// M3-IDEA-U03: the detail offered a preparation action that the operation then
// refused. `canPrepareNextRound` was derived without consulting the session's
// deadline, so at +60,001 ms on a 60-second session the owner was shown a
// control whose POST returned conflict and created zero jobs. The action is now
// derived from the SAME deadline rule the operation enforces, and the boundary
// is tested at -1, exact, and +1 millisecond.
test("M3-IDEA-U03: an expired discussion offers no preparation the server would refuse, on real PostgreSQL", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      const { project, session } = await seed(admin);
      // A 60-second session, exactly as the expired-discussion fixture uses.
      // The DISCUSSION is created one second after the seeded web session is
      // issued, because the session authority refuses any clock reading earlier
      // than the session's own issue instant. Anchoring the discussion at NOW
      // would make the -1 ms boundary unreachable for a reason that has nothing
      // to do with the deadline rule. Its 60-second window therefore closes at
      // NOW + 61s, and every boundary below is comfortably inside the session.
      const DISCUSSION_START = Date.parse(NOW) + 1_000;
      const short = buildIdeaLabSessionV1({ sessionId: "idea:deadline-pg", tenantId: scope.tenantId,
        workspaceId: scope.workspaceId, title: "A short discussion", ideaSummary: "Test the boundary.",
        targetCustomer: "Small teams", participants: session.participants, maxRounds: 2,
        maxDurationSeconds: 60, maxCostUsd: 1, createdByIdentityDigest: session.createdByIdentityDigest,
        createdAt: new Date(DISCUSSION_START).toISOString() });
      const AFTER_START = new Date(DISCUSSION_START + 1_000).toISOString();
      const setup = database(admin);
      await new IdeaLabProjectRegistryStoreV1(setup, KEY).registerSession(short);
      const web = new Client(postgres.connection("web")); await web.connect();
      try {
        const db = database(web);
        const at = (offsetMs: number) => DISCUSSION_START + 60_000 + offsetMs;
        const { WebIdeaService } = await import("../src/web/v1/idea-service");
        const { WebIdeaRoundProposalOperation } = await import("../src/web/v1/idea-round-proposal-operation");
        const { WebTaskService } = await import("../src/web/v1/task-service");
        const { ideaDetailSchema } = await import("../src/web/v1/idea-wire");
        const request = { sessionDigest: short.sessionDigest, projectId: project.projectId, round: 1 };
        const opener = new WebTaskService(db, scope, () => at(-1), { ideaIntegrityKey: KEY });

        // Round 1 is saved while the window is open. A TWO-round session is used
        // deliberately: a one-round session has no next round to offer at all,
        // so `canPrepareNextRound` would be null for reasons unrelated to the
        // deadline and the guard below could never be exercised. This is what
        // the first version of this test got wrong - mutating the deadline
        // guard did not fail it.
        await new WebIdeaRoundProposalOperation(db, scope, KEY, opener, () => at(-1))
          .propose(identity, short.sessionId, request);
        // Every round-1 task result is recorded, which is what makes round 2 the
        // offered next round.
        // Recorded on the ADMIN connection: the private web login holds no
        // INSERT on control_idea_contributions, because contributions are
        // written by the result-projection operation and not by the browser.
        // Writing them as the web role is refused with 42501, which says
        // nothing about the deadline rule under test.
        const saved = new IdeaLabProjectRegistryStoreV1(db, KEY);
        const adminStore = new IdeaLabProjectRegistryStoreV1(database(admin), KEY);
        const linkStore = new IdeaLabCanonicalTaskLinkStoreV1(db, KEY);
        for (const [index, link] of (await linkStore.list(short.tenantId, short.sessionId)).entries()) {
          await adminStore.recordContribution(buildIdeaLabContributionV1(short, {
            participantId: link.participantId, round: 1,
            safeOpinion: `A reviewed result from ${link.participantId} that cites its own evidence.`,
            opportunityCode: `opportunity_${index + 1}`, primaryRiskCode: `risk_${index + 1}`,
            suggestedExperiment: `Run one bounded check for ${link.participantId}.`,
            confidencePercent: 70, contributedAt: AFTER_START,
          // A reviewed ordinary-task result, which is the only source the
          // next-round rule accepts. An injected contribution would not make
          // the round offered, so the guard under test would never be reached.
          }, { sourceMode: "canonical_task_result", liveBotContactAuthorized: false, providerContacted: false,
            canonicalTaskEvidence: { taskKey: link.taskKey, taskLinkDigest: link.linkDigest,
              taskPlanDigest: link.taskPlanDigest, taskInputDigest: link.taskInputDigest,
              projectId: link.projectId, jobId: link.jobId, runId: `run:deadline-${index + 1}`,
              artifactId: `artifact:deadline-${index + 1}`, contentHash: `sha256:${"a".repeat(64)}`,
              targetId: `target:deadline-${index + 1}`, targetDigest: `sha256:${"b".repeat(64)}`,
              acceptanceProfileDigest: `sha256:${"c".repeat(64)}`, rootTargetId: `target:root-${index + 1}`,
              revisionNumber: 0, acceptedReviewIds: [`review:accepted-${index + 1}`],
              verificationIds: [`verification:passed-${index + 1}`] } }));
        }
        const reviewed = (await adminStore.listContributions(short.tenantId, short.sessionId))
          .filter(contribution => contribution.sourceMode === "canonical_task_result");
        assert.equal(reviewed.length, short.participants.length,
          "every round-1 result is recorded, so a next round exists to offer");

        for (const [offset, expired] of [[-1, false], [0, false], [1, true]] as const) {
          // ONE identity is used for every boundary. The web session authority
          // requires the session row's issued_at to equal the identity's
          // issuedAt and its expires_at to be in the future at the injected
          // clock, so re-issuing per boundary would fail authentication before
          // the deadline rule was consulted. The seeded session is valid for a
          // day; every boundary is within a millisecond of the deadline, so the
          // SESSION clock never interferes and only the discussion's own
          // 60-second window moves.
          const atBoundary = identity;
          const tasks = new WebTaskService(db, scope, () => at(offset), { ideaIntegrityKey: KEY });
          const service = new WebIdeaService(db, scope, KEY, () => at(offset), true, false, false, true, false, false);
          const detail = await service.detail(atBoundary, short.sessionId);
          const parsed = ideaDetailSchema.parse(detail);

          // Inside the window the action IS offered - otherwise the refusal
          // below would be satisfied by an action that never existed, and the
          // guard would be untested.
          if (!expired) {
            assert.equal(parsed.canPrepareNextRound, true,
              `the window is open at ${offset} ms, so the next round must be offered`);
            assert.equal(parsed.nextCanonicalRound, 2);
            assert.equal(parsed.preparationExpired, false);
          } else {
            // Past the deadline: no NEW work is offered, and the owner is told
            // why. A visible control whose POST the operation refuses is the
            // whole defect.
            assert.equal(parsed.canPrepareNextRound, false,
              "an expired discussion must not offer a preparation the server refuses");
            assert.equal(parsed.preparationExpired, true);
            // The operation refuses round 2 past the deadline, which is the
            // reason the control must not be shown. Asserted once, at the last
            // boundary, because round 2 was already saved at the in-window
            // boundary and an exact replay is deliberately permitted there.
            if (offset === 1) {
              await assert.rejects(new WebIdeaRoundProposalOperation(db, scope, KEY, tasks, () => at(offset))
                .propose(atBoundary, short.sessionId, { sessionDigest: short.sessionDigest,
                  projectId: project.projectId, round: 2, followUp: "A different follow-up after expiry." }),
              WebAccessError,
              "and the operation does refuse new work past the deadline, which is why the control must not be shown");
            }
          }
        }
        // Preparing created no attempts and no leases at any boundary.
        assert.equal((await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_attempts WHERE tenant_id=$1", [scope.tenantId])).rows[0]?.count, "0");
        assert.equal((await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_leases WHERE tenant_id=$1", [scope.tenantId])).rows[0]?.count, "0");
      } finally { await web.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 180_000 });
});

// M3-IDEA-U02: the low-level synthesis builder accepted a structurally
// incomplete round set. `buildIdeaLabSynthesisV1` only required that every
// participant appear AT LEAST ONCE, while the ordinary engine requires exactly
// `maxMessages` distinct participant/round tuples. A four-turn session with one
// contribution per participant - four of eight turns - therefore built a valid
// synthesis and a valid owner decision through the low-level path. The engine
// refused the same contributions. This test drives the NORMAL saved-contribution
// route on real PostgreSQL and requires the low-level builder to refuse too, so
// a restored or imported record cannot widen what the engine enforces.
test("M3-IDEA-U02: the low-level synthesis builder refuses an incomplete round set, on real PostgreSQL", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      const { session } = await seed(admin);
      // A contribution cannot predate its session, so both timestamps below
      // sit after the seeded session's createdAt.
      const AFTER_CREATED_AT = new Date(Date.parse(NOW) + 60_000).toISOString();
      const web = new Client(postgres.connection("web")); await web.connect();
      try {
        const db = database(web);
        const store = new IdeaLabProjectRegistryStoreV1(db, KEY);
        // One contribution per participant, round 1 only. The session has
        // maxRounds 1 in this fixture, so this is COMPLETE; the incomplete shape
        // is built explicitly below with a two-round session.
        // Written through the STORE on the admin connection. The private web
        // login holds no INSERT on control_idea_contributions - contributions
        // are recorded by the result-projection operation, not by the browser -
        // so seeding them as the web role is refused with 42501, which says
        // nothing about synthesis completeness. The values are still built by the
        // real contract builder, so every digest is the product's own.
        const writer = database(admin);
        for (const participant of session.participants) {
          await new IdeaLabProjectRegistryStoreV1(writer, KEY).recordContribution(buildIdeaLabContributionV1(session, {
            participantId: participant.participantId, round: 1,
            safeOpinion: `A bounded opinion from ${participant.participantId} that cites its own evidence.`,
            opportunityCode: `opportunity_${participant.participantId.replace(/[^a-z0-9]/gu, "_")}`,
            primaryRiskCode: `risk_${participant.participantId.replace(/[^a-z0-9]/gu, "_")}`,
            suggestedExperiment: `Run one bounded check for ${participant.participantId}.`,
            confidencePercent: 70, contributedAt: AFTER_CREATED_AT }));
        }
        const contributions = await store.listContributions(session.tenantId, session.sessionId);
        const synthesisInput = { marketDemand: 60, feasibility: 60, differentiation: 55, durability: 60,
          ownerFit: 65, riskPercent: 30, executiveSummary: "A bounded recap of one complete round.",
          nextExperiment: "Interview one customer before building.", dissentingPerspectiveCodes: [],
          synthesizedAt: AFTER_CREATED_AT };

        // The complete set is accepted - the check is not simply refusing
        // everything, which would make the refusal below meaningless.
        const complete = buildIdeaLabSynthesisV1(session, contributions, synthesisInput);
        assert.equal(complete.contributionCount, session.participants.length);

        // Now the incomplete shape: a TWO-round session with only round 1
        // supplied. Every participant appears, so the old per-participant check
        // passed, but half the rounds are missing.
        const twoRound = buildIdeaLabSessionV1({ sessionId: "idea:incomplete-pg", tenantId: scope.tenantId,
          workspaceId: scope.workspaceId, title: session.title, ideaSummary: session.ideaSummary,
          targetCustomer: session.targetCustomer, participants: session.participants, maxRounds: 2,
          maxDurationSeconds: 600, maxCostUsd: 1,
          createdByIdentityDigest: session.createdByIdentityDigest, createdAt: NOW });
        // Rebuilt against the TWO-round session, not spread from the stored
        // record: a stored contribution carries a digest over the session it was
        // built for, so reusing it against a different session is a scope
        // mismatch rather than the incomplete-round shape under test.
        const roundOne = session.participants.map(participant => buildIdeaLabContributionV1(twoRound, {
          participantId: participant.participantId, round: 1,
          safeOpinion: `A bounded opinion from ${participant.participantId} that cites its own evidence.`,
          opportunityCode: `opportunity_${participant.participantId.replace(/[^a-z0-9]/gu, "_")}`,
          primaryRiskCode: `risk_${participant.participantId.replace(/[^a-z0-9]/gu, "_")}`,
          suggestedExperiment: `Run one bounded check for ${participant.participantId}.`,
          confidencePercent: 70, contributedAt: AFTER_CREATED_AT }));
        assert.ok(roundOne.length < twoRound.maxMessages,
          "the fixture must genuinely be short of the full round set");
        assert.equal(new Set(roundOne.map(c => c.participantId)).size, session.participants.length,
          "every participant is present, which is what the old check accepted");
        // The builder is SYNCHRONOUS, so it throws rather than rejecting; this
        // is asserted with assert.throws, not assert.rejects.
        assert.throws(() => buildIdeaLabSynthesisV1(twoRound, roundOne, synthesisInput),
          /panel_incomplete/u,
          "a structurally incomplete round set must be refused at this boundary");
      } finally { await web.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 180_000 });
});

// The resume action carries the SAME deadline guard as the next-round action,
// and it needs its own proof: mutating only `canFinishRound` did not fail the
// next-round test, because that action is null in a session with no next round.
test("M3-IDEA-U03: an expired unfinished round offers no resume the server would refuse, on real PostgreSQL", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      const { project, session } = await seed(admin);
      const DISCUSSION_START = Date.parse(NOW) + 1_000;
      const short = buildIdeaLabSessionV1({ sessionId: "idea:resume-deadline", tenantId: scope.tenantId,
        workspaceId: scope.workspaceId, title: "A short discussion", ideaSummary: "Test the boundary.",
        targetCustomer: "Small teams", participants: session.participants, maxRounds: 1,
        maxDurationSeconds: 60, maxCostUsd: 1, createdByIdentityDigest: session.createdByIdentityDigest,
        createdAt: new Date(DISCUSSION_START).toISOString() });
      await new IdeaLabProjectRegistryStoreV1(database(admin), KEY).registerSession(short);
      const web = new Client(postgres.connection("web")); await web.connect();
      try {
        const db = database(web);
        const at = (offsetMs: number) => DISCUSSION_START + 60_000 + offsetMs;
        const { WebIdeaService } = await import("../src/web/v1/idea-service");
        const { WebIdeaRoundProposalOperation } = await import("../src/web/v1/idea-round-proposal-operation");
        const { WebTaskService } = await import("../src/web/v1/task-service");
        const { ideaDetailSchema } = await import("../src/web/v1/idea-wire");

        // Interrupt round 1 on its SECOND participant, so the round is left
        // genuinely unfinished while the window is still open.
        const real = new WebTaskService(db, scope, () => at(-1), { ideaIntegrityKey: KEY });
        let calls = 0;
        const failing = { proposeWithDependencies: async (...args: Parameters<WebTaskService["proposeWithDependencies"]>) => {
          calls += 1;
          if (calls === 2) throw new Error("injected_lost_reply_after_first_task_commits");
          return real.proposeWithDependencies(...args);
        } };
        await assert.rejects(new WebIdeaRoundProposalOperation(db, scope, KEY,
          failing as unknown as WebTaskService, () => at(-1))
          .propose(identity, short.sessionId, { sessionDigest: short.sessionDigest, projectId: project.projectId, round: 1 }));

        // Inside the window the resume action IS offered, and it works.
        const open = ideaDetailSchema.parse(await new WebIdeaService(db, scope, KEY, () => at(-1), true, false, false, true, false, false)
          .detail(identity, short.sessionId));
        assert.equal(open.unfinishedRound, 1, "the interrupted round is named");
        assert.equal(open.canFinishRound, true, "inside the window the round can be finished");
        assert.equal(open.preparationExpired, false);

        // One millisecond later the window has closed, and the resume action is
        // gone with an explanation. Offering it would be a control whose POST
        // the operation refuses.
        const closed = ideaDetailSchema.parse(await new WebIdeaService(db, scope, KEY, () => at(1), true, false, false, true, false, false)
          .detail(identity, short.sessionId));
        assert.equal(closed.preparationExpired, true, "the window has closed at +1 ms");
        assert.equal(closed.canFinishRound, false, "an expired unfinished round offers no resume");
        // The round is still readable, so the owner can see what is half-done.
        assert.equal(closed.unfinishedRound, 1);
        assert.equal(closed.canonicalTasks?.taskCount, 1);
        await assert.rejects(new WebIdeaRoundProposalOperation(db, scope, KEY, real, () => at(1))
          .propose(identity, short.sessionId, { sessionDigest: short.sessionDigest, projectId: project.projectId, round: 1 }),
        WebAccessError, "and the operation refuses to finish it, which is why the control must not be shown");
      } finally { await web.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 180_000 });
});
