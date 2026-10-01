// Real PostgreSQL proof that the owner-facing chief-of-staff port is wired to the
// shape MIG-A actually shipped (0200's current-revision view, 0201's planner
// columns), and that the adapter built over it behaves as the in-memory double
// does. Everything here runs AS the production logins: the superuser connection
// seeds fixtures and nothing else.
//
// This is the test the review asked for at F1. The wire claims `effort` is
// nullable because 0201's CHECK refuses a stored 'default'; that claim is proved
// here by writing what the adapter writes, as the web login, against the real
// constraint -- not by asserting the adapter agrees with itself.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { hmacSha256Tag, sha256Digest } from "../src/security";
import { workBatchProposalDigestV1 } from "../src/work-intake/v1/digest";
import { randomUUID } from "node:crypto";
import { IntakeCoordinatorV1, PostgresIntakeCompletionLookupV1, PostgresIntakeNeedsYouStoreV1,
  PostgresIntakeOwnerRetryStoreV1, PostgresIntakePlannerFailureStoreV1, PostgresIntakeSuggestionStoreV1,
  intakeProjectScopeV1, WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import { workBatchReceiptSchemaV1 as workBatchReceiptShape } from "../src/work-intake/v1/schemas";
import { createProjectOrchestrationServiceV1 } from "../src/web/v1/project-orchestration-composition";
import { PostgresProjectOrchestrationAccessV1, PostgresProjectOrchestrationBatchRevisionsV1,
  PostgresProjectOrchestrationStoreV1 } from "../src/web/v1/project-orchestration-postgres-store";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import type { WorkBatchQueueCatalogV1 } from "../src/work-intake/v1/queue-catalog";
import type { WorkBatchProposalV1 } from "../src/work-intake/v1/schemas";

// The disposable-cluster lane reserved for this stream: 59450-59459, or the test
// runner's assigned block, so concurrent runs never collide.
const PORT = Number(process.env.ORCHESTRATION_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59450);
const ALLOWED = Array.from({ length: 10 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();
// The session authority compares the assertion's own issuedAt against the CLOCK it
// was given, and a WebSessionAuthority built on a fixed past instant refuses any
// assertion that looks older than it. So the fixture's instants are anchored to the
// run's own clock, and the adapter reads it through the same function. Everything
// the schema stores is still exact, because NOW is written into the rows verbatim.
const RUN_MS = Date.parse("2026-09-29T23:00:00.000Z");
const clock = (): number => Math.max(Date.now(), RUN_MS);
const NOW = new Date(RUN_MS).toISOString();
const LATER = new Date(RUN_MS + 3_600_000).toISOString();
const KEY = new Uint8Array(32).fill(47);

const scope = { tenantId: "tenant:chief", workspaceId: "workspace:chief", projectId: "project:chief" };
const other = { tenantId: "tenant:chief-other", workspaceId: "workspace:chief-other", projectId: "project:chief-other" };
const otherProject = { ...scope, projectId: "project:chief-two" };
const provider = "https://access.invalid", subject = "owner";
const tokenDigest = `sha256:${"c".repeat(64)}`;
const identity: VerifiedWebIdentity = { provider, subject, tokenDigest,
  issuedAt: new Date(clock()).toISOString(),
  // Expires an hour after the assertion was issued, on the same clock.
  expiresAt: new Date(clock() + 3_600_000).toISOString(),
  verificationExpiresAt: new Date(clock() + 3_600_000).toISOString() };

function database(client: Client): DatabaseClient {
  const session: DatabaseSession = { query: async <T>(sql: string, values?: unknown[]) => {
    const result = await client.query(sql, values as never[]); return { rows: result.rows as T[] };
  } };
  return { query: session.query,
    // BOTH shapes. `transactionWithPreCommitCheck` is what the owner adapter's
    // optimistic settings write uses; plain `transaction` is what WorkBatchStoreV1
    // uses for authorize() and create(). The first version of this helper
    // provided only the former, so the real WorkBatchServiceV1 failed with
    // "this.db.transaction is not a function" the moment a describe reached the
    // submission -- which is exactly the kind of thing an in-memory double hides.
    transaction: async (work: (tx: DatabaseSession) => Promise<unknown>) => {
      await client.query("BEGIN");
      try { const value = await work(session); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    },
    transactionWithPreCommitCheck: async (work: (tx: DatabaseSession) => Promise<unknown>) => {
      await client.query("BEGIN");
      try { const value = await work(session); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    } } as unknown as DatabaseClient;
}

const proposal = (projectId: string, taskCount = 2): WorkBatchProposalV1 => ({ schema: "control-room.work-batch-proposal/v1",
  projectId, tasks: Array.from({ length: taskCount }, (_, index) => ({ localId: `part-${index}`,
    title: `Bounded part ${index}`, instructions: "Implement exactly the requested change.",
    requiredCapability: "code.change", role: "builder" as const,
    acceptanceCriteria: "The focused behavior matches the written contract.",
    acceptanceTests: "Run the focused orchestrator tests." })), edges: [] }) as WorkBatchProposalV1;

async function seedTenant(admin: Client, at: { tenantId: string; workspaceId: string; projectId: string }) {
  const adapter = `adapter:manual:${sha256Digest({ w: at.workspaceId }).slice(7, 39)}`;
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING", [at.tenantId]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1) ON CONFLICT DO NOTHING",
    [at.workspaceId, at.tenantId]);
  await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30) ON CONFLICT DO NOTHING`,
  [adapter, at.tenantId]);
  for (const projectId of [at.projectId, at.projectId === scope.projectId ? otherProject.projectId : at.projectId]) {
    await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES($1,$2,$3,$4,$1,'1','Chief project','planned','manual_project_active','healthy','control_room_native',$5,'{}',$5)
      ON CONFLICT DO NOTHING`, [projectId, at.tenantId, at.workspaceId, adapter, NOW]);
    await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
      VALUES($1,$2,'active',1,$3,$3) ON CONFLICT DO NOTHING`, [at.tenantId, projectId, NOW]);
  }
  // 0200's write guard reads the intake login's tenant through
  // is_work_intake_session(), which resolves work_intake_tenant_binding. Without
  // it a suggestion insert is refused for a fixture reason, not a guard reason.
  await admin.query("DELETE FROM work_intake_tenant_binding");
  await admin.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)", [at.tenantId]);
}

/** An owner with `projects.read` + `projects.settings`, an OPERATOR with the read
 * only, and the chief-of-staff agent. The operator is the subject of the
 * owner-only assertion: an operator grant must never change the chief of staff. */
async function seedIdentities(admin: Client, at: { tenantId: string }, suffix: string) {
  const owner = `identity:chief-owner${suffix}`, operator = `identity:chief-operator${suffix}`;
  const rows: Array<[string, string, string, string, string, string, string]> = [
    [owner, "human", provider, sha256Digest({ provider, subject }), "owner", '["*"]', "critical"],
    [operator, "human", `https://operator.invalid`, sha256Digest({ provider: `https://operator.invalid` }),
      "operator", '["*"]', "high"],
    [`identity:chief-agent${suffix}`, "agent", "work-intake", sha256Digest({ id: `agent${suffix}` }),
      "work_batch_proposer", '["work_batches.propose"]', "low"],
  ];
  for (const [id, actorType, authProvider, subjectDigest, roleKey, actions, risk] of rows) {
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,$3,'Fixture',$4,$5,'active',$6,$6)
      ON CONFLICT DO NOTHING`, [id, at.tenantId, actorType, authProvider, subjectDigest, NOW]);
    await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
      risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'["*"]'::jsonb,$6,false,false,$7,$7) ON CONFLICT DO NOTHING`,
    [`grant:${id}`, at.tenantId, id, roleKey, actions, risk, NOW]);
  }
  await admin.query("DELETE FROM control_web_sessions WHERE tenant_id=$1 AND token_digest=$2", [at.tenantId, tokenDigest]);
  await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`, [at.tenantId, tokenDigest, owner, identity.issuedAt, identity.expiresAt]);
  return { owner, operator };
}

async function seedBatch(admin: Client, at: { tenantId: string; projectId: string }, batchId: string,
  proposer: string, revision = 1, value = proposal(at.projectId)) {
  const digest = workBatchProposalDigestV1(value);
  // 0093 admits revision 1 by INSERT and nothing else; advancing a batch is an
  // UPDATE, which its own owner-update guard refuses for an agent. The fixture
  // therefore seeds the batch once at revision 1 and, when a test needs a later
  // revision, moves it with the same disable/enable the orchdb lane uses for a
  // decided batch -- and says so, because it is a fixture reaching a state a
  // production path reaches through WorkBatchOwnerServiceV1 instead.
  await admin.query(`INSERT INTO work_batches(id,tenant_id,project_id,proposed_by_identity_id,proposed_by_actor_type,
    proposed_at,state,proposal,queue_depth_limit,batch_digest,auth_tag,version,created_at,updated_at)
    VALUES($1,$2,$3,$4,'agent',$5,'proposed',$6::jsonb,10,$7,$8,1,$5,$5)
    ON CONFLICT DO NOTHING`,
  [batchId, at.tenantId, at.projectId, proposer, NOW, JSON.stringify(value), digest,
    hmacSha256Tag(KEY, { purpose: "work-batch/v1", record: { id: batchId, tenantId: at.tenantId, projectId: at.projectId,
      proposedByIdentityId: proposer, proposedAt: NOW, state: "proposed", proposal: value, queueDepthLimit: 10,
      batchDigest: digest, version: 1, createdAt: NOW, updatedAt: NOW } })]);
  // Revision 1 must carry the batch's own proposal and batch digest (0102's guard
  // compares them), so it is written BEFORE the batch row is advanced. Later
  // revisions carry the plan the batch now holds, which is what makes 0200's view
  // stop matching the suggestion bound to revision 1.
  await admin.query(`INSERT INTO work_batch_revisions(id,tenant_id,batch_id,revision,edited_by_identity_id,edited_at,
    reason_code,proposal,revision_digest,auth_tag) VALUES($1,$2,$3,1,$4,$5,'submitted',$6::jsonb,$7,$8)
    ON CONFLICT DO NOTHING`,
  [`${batchId}:revision:1`, at.tenantId, batchId, proposer, NOW, JSON.stringify(value), digest,
    hmacSha256Tag(KEY, { purpose: "work-batch-revision/v1", record: { id: `${batchId}:revision:1`,
      tenantId: at.tenantId, batchId, revision: 1, editedByIdentityId: proposer, editedAt: NOW,
      reasonCode: "submitted", proposal: value, revisionDigest: digest } })]);
  return digest;
}

/** Move an already-seeded batch to `revision`, with a DIFFERENT plan.
 *
 * 0093 admits revision 1 by INSERT only and 0102's owner-update guard refuses an
 * agent's UPDATE, so the fixture reaches this state the way the orchdb lane
 * reaches a decided batch: with the guard disabled for one statement, and saying
 * so. What is under test is 0200's VIEW losing the current-revision binding, and
 * the rows are otherwise real -- each has its proposal, its digest and its HMAC. */
async function advanceBatch(admin: Client, at: { tenantId: string; projectId: string }, batchId: string,
  revision: number) {
  const advanced = proposal(at.projectId, 7), advancedDigest = workBatchProposalDigestV1(advanced);
  // 0102's revision guard requires `revision = batch.version + 1` AT INSERT TIME, so
  // the new revision row is written BEFORE the batch is advanced, and it must be
  // edited by a live HUMAN owner holding `work_batches.decide` -- which is exactly
  // what WorkBatchOwnerServiceV1 does, so the fixture follows the same shape.
  await admin.query(`INSERT INTO work_batch_revisions(id,tenant_id,batch_id,revision,edited_by_identity_id,
    edited_at,reason_code,proposal,revision_digest,auth_tag) VALUES($1,$2,$3,$4,$5,$6,'owner_revision',$7::jsonb,$8,$9)
    ON CONFLICT DO NOTHING`,
  [`${batchId}:revision:${revision}`, at.tenantId, batchId, revision, `identity:chief-owner`, LATER,
    JSON.stringify(advanced), advancedDigest, hmacSha256Tag(KEY, { purpose: "work-batch-revision/v1",
      record: { id: `${batchId}:revision:${revision}`, tenantId: at.tenantId, batchId, revision,
        editedByIdentityId: "identity:chief-owner", editedAt: LATER, reasonCode: "owner_revision",
        proposal: advanced, revisionDigest: advancedDigest } })]);
  await admin.query("ALTER TABLE work_batches DISABLE TRIGGER work_batches_owner_update");
  try {
    await admin.query(`UPDATE work_batches SET version=$3,proposal=$4::jsonb,batch_digest=$5,updated_at=$6
      WHERE tenant_id=$1 AND id=$2`, [at.tenantId, batchId, revision, JSON.stringify(advanced), advancedDigest, LATER]);
  } finally { await admin.query("ALTER TABLE work_batches ENABLE TRIGGER work_batches_owner_update"); }
  return advancedDigest;
}

/** The suggestion INSERT, exactly as the intake login's adapter writes it. */
async function insertSuggestion(intake: Client, input: { id: string; tenantId: string; projectId: string;
  batchId: string; requestKey: string; revision: number; revisionDigest: string; proposer: string;
  value: WorkBatchProposalV1 }) {
  const proposalDigest = workBatchProposalDigestV1(input.value);
  await intake.query(`INSERT INTO work_batch_split_suggestions(id,tenant_id,project_id,batch_id,request_key,
    base_revision,base_revision_digest,proposed_by_identity_id,proposed_by_actor_type,proposal,proposal_digest,
    suggestion_digest,auth_tag,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'agent',$9::jsonb,$10,$11,$12,$13)`,
  [input.id, input.tenantId, input.projectId, input.batchId, input.requestKey, input.revision,
    input.revisionDigest, input.proposer, JSON.stringify(input.value), proposalDigest,
    sha256Digest({ baseRevisionDigest: input.revisionDigest, proposalDigest }),
    hmacSha256Tag(KEY, { purpose: "work-batch-split-suggestion/v1", record: { id: input.id, tenantId: input.tenantId,
      projectId: input.projectId, batchId: input.batchId, requestKey: input.requestKey, baseRevision: input.revision,
      baseRevisionDigest: input.revisionDigest, proposerIdentityId: input.proposer, proposal: input.value,
      proposalDigest, createdAt: NOW } }), NOW]);
}

const catalog: WorkBatchQueueCatalogV1 = [{ workerId: "worker:chief", workerKind: "codex", nodeId: "node:chief",
  modelPolicy: { models: ["model:plan"], defaultModel: "model:plan", efforts: ["high"], defaultEffort: "high" } }];
const hermesCatalog: WorkBatchQueueCatalogV1 = [{ workerId: "worker:hermes", workerKind: "hermes",
  nodeId: "node:hermes", modelPolicy: { profiles: [{ name: "profile:one", provider: "provider:one",
    model: "model:one" }], defaultProfile: "profile:one", efforts: ["default"], defaultEffort: "default" } }];

function serviceFor(client: Client, queueCatalog = catalog) {
  const db = database(client), ids = { tenantId: scope.tenantId, workspaceId: scope.workspaceId };
  return createProjectOrchestrationServiceV1({ db, ...ids, queueCatalog, integrityKey: KEY,
    coordinator: { async coordinateInitial() { throw new Error("planner_unavailable_in_this_test"); },
      ownerPrefill: (input) => new PostgresProjectOrchestrationStoreV1(db, ids, clock, KEY)
        .prefillForOwner(input) } });
}

test("the planner selection round-trips through 0201's real constraint, including a NULL effort", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const web = new Client(postgres.connection("control_room_web")); await web.connect();
    try {
      await seedTenant(admin, scope); await seedIdentities(admin, scope, "");
      const hermes = serviceFor(web, hermesCatalog);
      const offered = await hermes.readSettings(identity, scope.projectId);
      // The hermes option's effort is NULL, which is what 0201 accepts.
      assert.deepEqual(offered.options.map(option => [option.modelKey, option.effort]), [["profile:one", null]]);
      const saved = await hermes.saveSettings(identity, scope.projectId, { expectedVersion: 0,
        choice: { mode: "selected", workerId: "worker:hermes", workerKind: "hermes", modelKey: "profile:one",
          effort: null } });
      assert.equal(saved.version, 1);
      // PROOF: the row the web login just wrote satisfies 0201's own CHECK. Writing
      // the string 'default' through the same login is refused by the database --
      // which is precisely why the wire carries null.
      const row = (await web.query(`SELECT planner_mode,planner_worker_id,planner_worker_kind,planner_model,
        planner_effort,version FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2`,
      [scope.tenantId, scope.projectId])).rows[0];
      assert.deepEqual({ ...row, version: Number(row.version) },
        { planner_mode: "selected", planner_worker_id: "worker:hermes", planner_worker_kind: "hermes",
          planner_model: "profile:one", planner_effort: null, version: 1 });
      await assert.rejects(web.query(`UPDATE control_project_settings SET planner_effort='default'
        WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId]),
        (error: unknown) => String(error).includes("control_project_settings_planner_effort_check"));
      // The read-back is exactly what was stored, and the coordinator's own view
      // reports NO effort at all, because NULL means the catalog decides.
      assert.deepEqual(await hermes.readSettings(identity, scope.projectId).then(value => value.choice),
        { mode: "selected", workerId: "worker:hermes", workerKind: "hermes", modelKey: "profile:one", effort: null });
      const store = new PostgresProjectOrchestrationStoreV1(database(web),
        { tenantId: scope.tenantId, workspaceId: scope.workspaceId }, clock);
      assert.deepEqual(await store.read(scope.projectId), { workerId: "worker:hermes", workerKind: "hermes",
        modelKey: "profile:one" });
      // A concrete effort on the codex catalog round-trips as the exact value.
      const codex = serviceFor(web);
      assert.deepEqual((await codex.readSettings(identity, scope.projectId)).options.map(option => option.effort), ["high"]);
      await codex.saveSettings(identity, scope.projectId, { expectedVersion: 1, choice: { mode: "selected",
        workerId: "worker:chief", workerKind: "codex", modelKey: "model:plan", effort: "high" } });
      assert.equal((await codex.readSettings(identity, scope.projectId)).choiceStale, false);
      // And 'none' clears every selected column, as 0201's coherence CHECK requires.
      await codex.saveSettings(identity, scope.projectId, { expectedVersion: 2, choice: { mode: "none" } });
      assert.deepEqual(await store.readSettings(scope.tenantId, scope.projectId),
        { version: 3, choice: { mode: "none" } });
    } finally { await web.end(); await admin.end(); }
  }, { port: PORT, allowedPorts: ALLOWED, boundMs: 180_000 });
});

test("the optimistic version check is real under 20 concurrent saves at one expected version", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const web = new Client(postgres.connection("control_room_web")); await web.connect();
    try {
      await seedTenant(admin, scope); await seedIdentities(admin, scope, "");
      await serviceFor(web).saveSettings(identity, scope.projectId, { expectedVersion: 0, choice: { mode: "none" } });
      // TWENTY SEPARATE CONNECTIONS. One pg Client cannot run twenty concurrent
      // transactions -- they would interleave inside a single BEGIN, which tests
      // nothing about the row lock. Each caller below is its own authenticated
      // connection, which is what "concurrent" means to a connection pool.
      const callers = Array.from({ length: 20 }, async (_unused, index) => {
        const client = new Client(postgres.connection("control_room_web", { applicationName: `chief-save-${index}` }));
        await client.connect();
        try {
          const service = serviceFor(client);
          return await service.saveSettings(identity, scope.projectId, { expectedVersion: 1,
            choice: index % 2 === 0 ? { mode: "selected", workerId: "worker:chief", workerKind: "codex",
              modelKey: "model:plan", effort: "high" } : { mode: "none" } });
        } finally { await client.end(); }
      });
      const results = await Promise.allSettled(callers);
      const won = results.filter(result => result.status === "fulfilled");
      const lost = results.filter(result => result.status === "rejected");
      assert.equal(won.length, 1, `exactly one save may win, got ${won.length}`);
      assert.equal(lost.length, 19);
      for (const failure of lost) assert.match(String((failure as PromiseRejectedResult).reason), /conflict/);
      const stored = (await web.query(`SELECT version FROM control_project_settings
        WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId])).rows[0];
      assert.equal(Number(stored.version), 2, "one increment, not twenty");
    } finally { await web.end(); await admin.end(); }
  }, { port: PORT + 1, allowedPorts: ALLOWED, boundMs: 180_000 });
});

test("suggestions come from 0200's current-revision view, and a stale one is simply not there", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    const web = new Client(postgres.connection("control_room_web")); await web.connect();
    try {
      await seedTenant(admin, scope); await seedIdentities(admin, scope, "");
      const digest = await seedBatch(admin, scope, "batch:chief-one", "identity:chief-agent");
      await insertSuggestion(intake, { id: `split-suggestion:${"a".repeat(32)}`, tenantId: scope.tenantId,
        projectId: scope.projectId, batchId: "batch:chief-one", requestKey: "orchestrator-resplit-0001",
        revision: 1, revisionDigest: digest, proposer: "identity:chief-agent",
        value: proposal(scope.projectId, 3) });
      const service = serviceFor(web);
      const current = await service.listSuggestions(identity, scope.projectId, "batch:chief-one");
      // With no dismissal table on any branch yet, the read reports "nothing
      // dismissed" rather than failing. That absence is EXPECTED here, and it must
      // not present as a database outage on an otherwise fine project page.
      assert.equal(current.dismissAvailable, false, "no dismissal record is composed yet");
      assert.equal(current.suggestions.length, 1);
      assert.equal(current.suggestions[0]!.proposal.tasks.length, 3);
      assert.equal(current.suggestions[0]!.savesRevision, false);
      assert.equal(current.dismissAvailable, false, "no dismissal record is composed yet");

          // Move the batch to revision 2. 0200's VIEW is current-revision-only, so the
      // suggestion the owner already saw is not in it any more: the adapter does
      // not need a second copy of that rule to be correct.
      await advanceBatch(admin, scope, "batch:chief-one", 2);
      const afterRevision = await service.listSuggestions(identity, scope.projectId, "batch:chief-one");
      assert.equal(afterRevision.suggestions.length, 0, "a suggestion against an old revision is history");

      // Use is refused. Which refusal is the honest one: the suggestion is not in
      // the current-revision VIEW at all, so it is not_found rather than a
      // conflict -- and "a stale suggestion is not there" is the same answer the
      // in-memory double gives for a suggestion the owner already dismissed.
      await assert.rejects(service.useSuggestion(identity, scope.projectId, "batch:chief-one",
        `split-suggestion:${"a".repeat(32)}`, 2), /not_found/);
      // The use route's own expected-revision check still refuses a revision that
      // is not the batch's current one, before any read.
      await assert.rejects(service.useSuggestion(identity, scope.projectId, "batch:chief-one",
        `split-suggestion:${"a".repeat(32)}`, 99), /conflict/);
      // And dismiss is refused with no durable record to write, rather than lost.
      await assert.rejects(service.dismissSuggestion(identity, scope.projectId, "batch:chief-one",
        `split-suggestion:${"a".repeat(32)}`, 2), /not_found/);
    } finally { await web.end(); await intake.end(); await admin.end(); }
  }, { port: PORT + 2, allowedPorts: ALLOWED, boundMs: 180_000 });
});

test("the prefill re-derives the stored HMAC and refuses a row tampered with after it was written", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    const web = new Client(postgres.connection("control_room_web")); await web.connect();
    try {
      await seedTenant(admin, scope); await seedIdentities(admin, scope, "");
      const value = proposal(scope.projectId, 2);
      const digest = await seedBatch(admin, scope, "batch:chief-tamper", "identity:chief-agent", 1, value);
      const id = `split-suggestion:${"b".repeat(32)}`;
      await insertSuggestion(intake, { id, tenantId: scope.tenantId, projectId: scope.projectId,
        batchId: "batch:chief-tamper", requestKey: "orchestrator-resplit-0002", revision: 1,
        revisionDigest: digest, proposer: "identity:chief-agent", value });
      const service = serviceFor(web);
      const prefill = await service.useSuggestion(identity, scope.projectId, "batch:chief-tamper", id, 1);
      assert.equal(prefill.proposal.tasks.length, 2);
      assert.equal(prefill.savesRevision, false);

      // Rewrite the stored plan. 0200 is append-only, so this needs the guard
      // disabled -- which is the point: it simulates a row altered out of band,
      // and the read must still refuse it.
      await admin.query("ALTER TABLE work_batch_split_suggestions DISABLE TRIGGER work_batch_split_suggestions_append_only");
      try {
        await admin.query(`UPDATE work_batch_split_suggestions SET proposal=$2::jsonb
          WHERE tenant_id=$1 AND id=$3`, [scope.tenantId, JSON.stringify(proposal(scope.projectId, 7)), id]);
      } finally {
        await admin.query("ALTER TABLE work_batch_split_suggestions ENABLE TRIGGER work_batch_split_suggestions_append_only");
      }
      await assert.rejects(service.useSuggestion(identity, scope.projectId, "batch:chief-tamper", id, 1),
        /invalid_request/, "a tampered row is refused, not handed to the owner as a plan");
    } finally { await web.end(); await intake.end(); await admin.end(); }
  }, { port: PORT + 3, allowedPorts: ALLOWED, boundMs: 180_000 });
});

test("only the project's owner can read or change the chief of staff; an operator cannot", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const web = new Client(postgres.connection("control_room_web")); await web.connect();
    try {
      await seedTenant(admin, scope); await seedIdentities(admin, scope, "");
      const service = serviceFor(web);
      const access = new PostgresProjectOrchestrationAccessV1(database(web),
        { tenantId: scope.tenantId, workspaceId: scope.workspaceId }, clock);
      const actor = await access.owner(identity, scope.projectId, "read");
      assert.equal(actor.tenantId, scope.tenantId);
      assert.equal(actor.ownerIdentityId, "identity:chief-owner");
      // An operator holding projects.read can read the SETTINGS, but changing one
      // requires the owner role, exactly as Project settings already does.
      const operatorIdentity: VerifiedWebIdentity = { provider: "https://operator.invalid",
        subject: "owner", tokenDigest, issuedAt: identity.issuedAt, expiresAt: identity.expiresAt,
        verificationExpiresAt: identity.verificationExpiresAt };
      await assert.rejects(access.owner(operatorIdentity, scope.projectId, "settings"), /access_denied/);
      // The settings row is never created by a refused write.
      assert.equal((await web.query(`SELECT count(*)::int AS n FROM control_project_settings
        WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId])).rows[0].n, 0);
      assert.ok(service);
    } finally { await web.end(); await admin.end(); }
  }, { port: PORT + 4, allowedPorts: ALLOWED, boundMs: 180_000 });
});

test("a second tenant's project and settings are unreachable through this port", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const web = new Client(postgres.connection("control_room_web")); await web.connect();
    try {
      await seedTenant(admin, scope); await seedIdentities(admin, scope, "");
      await seedTenant(admin, other); await seedIdentities(admin, other, "-other");
      const service = serviceFor(web);
      const store = new PostgresProjectOrchestrationStoreV1(database(web),
        { tenantId: scope.tenantId, workspaceId: scope.workspaceId }, clock);
      await service.saveSettings(identity, scope.projectId, { expectedVersion: 0, choice: { mode: "selected",
        workerId: "worker:chief", workerKind: "codex", modelKey: "model:plan", effort: "high" } });
      // A project that does not exist is not found, not read as "none chosen" and
      // not answered with a foreign-key error. The owner granted a wildcard project
      // scope, so the GRANT alone cannot tell a real project from a typed id.
      await assert.rejects(service.readSettings(identity, "project:not-here"), /not_found/);
      await assert.rejects(service.saveSettings(identity, "project:not-here",
        { expectedVersion: 0, choice: { mode: "none" } }), /not_found/);
      await assert.rejects(service.describe(identity, "project:not-here", { description: "x" },
        "request:ghost-0001"), /not_found/);
      // A second tenant's tenant id, project id and batch id are all refused by the
      // store's own tenant check, not merely by the access port.
      for (const foreign of [other.tenantId, "tenant:invented"])
        await assert.rejects(store.readSettings(foreign, scope.projectId), /access_denied/);
      await assert.rejects(store.listSuggestions({ tenantId: other.tenantId, projectId: scope.projectId,
        batchId: "batch:chief-one" }), /access_denied/);
      await assert.rejects(store.dismissedSuggestionIds({ tenantId: other.tenantId, projectId: scope.projectId,
        batchId: "batch:chief-one" }), /access_denied/);
      // The batch revision port refuses another tenant and an unknown batch.
      const batches = new PostgresProjectOrchestrationBatchRevisionsV1(database(web), scope.tenantId);
      await assert.rejects(batches.read({ tenantId: other.tenantId, projectId: scope.projectId,
        batchId: "batch:chief-one" }), /access_denied/);
      await assert.rejects(batches.read({ tenantId: scope.tenantId, projectId: scope.projectId,
        batchId: "batch:missing" }), /not_found/);
    } finally { await web.end(); await admin.end(); }
  }, { port: PORT + 5, allowedPorts: ALLOWED, boundMs: 180_000 });
});

/** The brief's stress case: 20 concurrent describes on ONE project through the
 * real composed service. Every one must be refused as unavailable -- never reach a
 * planner, never leave work started -- and never hang. */
test("20 concurrent describes on one project are refused in bounded time without a planner", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const web = new Client(postgres.connection("control_room_web")); await web.connect();
    try {
      await seedTenant(admin, scope); await seedIdentities(admin, scope, "");
      const service = serviceFor(web);
      await service.saveSettings(identity, scope.projectId, { expectedVersion: 0, choice: { mode: "selected",
        workerId: "worker:chief", workerKind: "codex", modelKey: "model:plan", effort: "high" } });
      const started = Date.now();
      // TWENTY SEPARATE CONNECTIONS, as above: one Client would serialise the
      // twenty runs inside a single transaction and prove nothing about
      // concurrency under load.
      const results = await Promise.all(Array.from({ length: 20 }, async (_unused, index) => {
        const client = new Client(postgres.connection("control_room_web", { applicationName: `chief-describe-${index}` }));
        await client.connect();
        try {
          const value = await serviceFor(client).describe(identity, scope.projectId,
            { description: `Prepare bounded job ${index}` }, `request:stress-${String(index).padStart(4, "0")}`);
          return { ok: true as const, value };
        } catch (error) { return { ok: false as const, message: String(error) }; }
        finally { await client.end(); }
      }));
      const elapsed = Date.now() - started;
      assert.ok(service);
      assert.equal(results.every(result => !result.ok), true, "every describe is refused without a planner host");
      assert.equal(results.every(result => !result.ok && /not_found/.test(result.message)), true);
      assert.ok(elapsed < 30_000, `bounded: took ${elapsed}ms`);
      // Nothing was started, and nothing was written by the refusals.
      assert.equal((await web.query(`SELECT count(*)::int AS n FROM work_batches
        WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId])).rows[0].n, 0);
      assert.equal((await web.query(`SELECT count(*)::int AS n FROM control_project_settings
        WHERE tenant_id=$1 AND project_id=$2 AND version<>1`, [scope.tenantId, scope.projectId])).rows[0].n, 0);
    } finally { await web.end(); await admin.end(); }
  }, { port: PORT + 6, allowedPorts: ALLOWED, boundMs: 240_000 });
});
/** The real coordinator, over the real stores, on the real logins.
 *
 * Everything above this line proves the ADAPTER. This proves the thing the
 * review actually found broken: the retry of a describe that already succeeded.
 * It is built from the production pieces -- IntakeCoordinatorV1, the real
 * PostgresIntakeSuggestionStoreV1, PostgresIntakePlannerFailureStoreV1,
 * PostgresIntakeNeedsYouStoreV1, PostgresIntakeCompletionLookupV1, and
 * WorkBatchServiceV1 on the intake login -- with only the planner and the
 * allowance doubled, because neither has a production adapter yet.
 *
 * TWO logins, and that is the production shape rather than a convenience. The
 * proposal goes in through the INTAKE login (0200's suggestions, 0093's batches)
 * and the failure counter and the Needs-you ledger are the COORDINATOR's (0202
 * grants them to control_room_task_coordinator and to nobody else). So the
 * harness takes both clients: one for the suggestion/submission stores and one
 * for the failure/needs-you/completion stores. Running the failure store on the
 * intake login fails with "permission denied for table
 * control_planner_failure_counters" -- measured, and it is 0202's grant doing its
 * job.
 *
 * The planner double VARIES its answer run to run, exactly as a real LLM's does.
 * That is the load-bearing detail: with a fixed reply the old code would have
 * re-run the planner and then re-submitted the identical bytes, which the store's
 * idempotency check treats as an exact replay and answers happily. The bug only
 * appears when the reply differs, which is the normal case. */
function coordinatorFor(input: Readonly<{ intake: DatabaseClient; coordinatorDb: DatabaseClient;
  agentId: string; onRun: () => void; onConsume: () => void; varying: boolean; completions?: boolean;
  /** The project the planner double proposes for. It MUST be the project the
   * request names: the coordinator refuses a reply whose proposal carries a
   * different projectId (proposal_cross_project), so a hardcoded tenant A's
   * project made the second tenant's describe return 'refused' -- the guard
   * working, and the reason the two-tenant half of the stress run needs its own
   * harness rather than the shared one. */
  projectId?: string }>) {
  const projectId = input.projectId ?? scope.projectId;
  const runs: string[] = [];
  const store = new PostgresIntakeSuggestionStoreV1(input.intake, KEY);
  const completions = input.completions === false ? undefined
    : new PostgresIntakeCompletionLookupV1(input.intake);
  const coordinator = new IntakeCoordinatorV1(
    { read: () => ({ workerId: "worker:chief", workerKind: "codex", modelKey: "model:plan", effort: "high" }) },
    { async run() {
      input.onRun();
      // A varying reply: a different part count each run, so two runs of the
      // same request key carry DIFFERENT content and the store must refuse the
      // second one rather than answer with the first.
      const taskCount = input.varying ? 2 + runs.length : 3;
      runs.push(String(taskCount));
      return { replyText: JSON.stringify(proposal(projectId, taskCount)) };
    } },
    { async consume() { input.onConsume(); return { allowed: true as const }; } },
    new PostgresIntakePlannerFailureStoreV1(input.coordinatorDb,
      () => ({ tenantId: scope.tenantId, projectId: scope.projectId }), () => LATER),
    new PostgresIntakeNeedsYouStoreV1(input.coordinatorDb, () => ({ identityId: input.agentId }), () => LATER),
    new WorkBatchServiceV1(new WorkBatchStoreV1(input.intake, KEY)),
    store, catalog, ["code.change"], completions);
  return { coordinator, store, runs };
}

test("B2: retrying a describe that already succeeded returns the stored receipt, with no second run", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    const tasks = new Client(postgres.connection("coordinator")); await tasks.connect();
    try {
      await seedTenant(admin, scope); await seedIdentities(admin, scope, "");
      const agentId = "identity:chief-agent";
      const principal = { tenantId: scope.tenantId, identityId: agentId, actorType: "agent" as const,
        authenticatedAt: NOW, expiresAt: LATER };
      let runs = 0, consumes = 0;
      const { coordinator, runs: replies } = coordinatorFor({ intake: database(intake),
        coordinatorDb: database(tasks), agentId,
        onRun: () => { runs += 1; }, onConsume: () => { consumes += 1; }, varying: true });
      const key = "orchestrator:describe-retry-0001";
      const describe = () => coordinator.coordinateInitial({ principal, projectId: scope.projectId,
        ownerRequest: "Prepare the launch note.", idempotencyKey: key, now: NOW });

      const first = await describe();
      assert.equal(first.status, "submitted", "the first describe submits");
      if (first.status !== "submitted") return;
      const batchId = first.submission.batchId;
      assert.equal(runs, 1, "one planner run");
      assert.equal(consumes, 1, "one allowance consumption");

      // Now the SAME request, three times, exactly as the owner's "Check this
      // exact request again" sends it. Without the completion lookup each of
      // these re-ran the planner, got a DIFFERENT reply, and the submission
      // refused with replay_conflict -- a 503 to the owner for a proposal that
      // already exists.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const retry = await describe();
        assert.equal(retry.status, "submitted",
          `retry ${attempt + 1} must return the stored result, not re-run the planner`);
        if (retry.status === "submitted") assert.equal(retry.submission.batchId, batchId,
          "and it must be the SAME batch, not a new one");
      }
      assert.equal(runs, 1, "three exact retries spent no further planner run");
      assert.equal(consumes, 1, "nor a further allowance unit");
      assert.equal(replies.length, 1, "the planner was called exactly once in total");
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM work_batches
        WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId])).rows[0].n, 1,
        "one batch, and no duplicate from the retries");

      // A SUBMISSION THAT DIED IN FLIGHT. `WorkBatchStoreV1.create` writes the
      // control_idempotency row with status 'processing' before the batch and
      // 'completed' after, in one transaction -- so a row left in 'processing' is
      // a process that died between the two. The lookup must read it as "not
      // completed" and let the caller run, because answering from it would hand
      // the owner a receipt for a batch that was never committed.
      //
      // Both rows are written as the intake login, and both use ONLY the columns
      // its grant covers. `GRANT INSERT (tenant_id, operation_scope,
      // idempotency_key, request_digest, status)` is column-scoped and does NOT
      // include `result`, so the "completed" row is written 'processing' and then
      // UPDATED to 'completed' -- which is exactly what production does, and it
      // needs no wider grant than the store already holds.
      await intake.query(`INSERT INTO control_idempotency(tenant_id,operation_scope,idempotency_key,request_digest,status)
        VALUES($1,$2,$3,$4,'processing') ON CONFLICT DO NOTHING`,
        [scope.tenantId, `work-batches.propose/v1:${agentId}`, "orchestrator:describe-crashed-0003",
          `sha256:${"d".repeat(64)}`]);
      const crashed = await new PostgresIntakeCompletionLookupV1(database(intake)).completed(
        { tenantId: scope.tenantId, projectId: scope.projectId, identityId: agentId,
          requestKey: "orchestrator:describe-crashed-0003" });
      assert.equal(crashed, null,
        "a 'processing' row is not a completed request, so no receipt is invented from it");
      // ... and a row in 'processing' that DOES carry a real receipt is still not a
      // completed request. This is the arm that the `status` filter alone holds:
      // the schema check cannot catch it, because the result is a perfectly valid
      // receipt. Without the filter, a submission that died after writing its
      // result but before its transaction committed would answer the retry with a
      // receipt for a batch that was never created -- the one way this lookup
      // could fabricate a batch id. The receipt is copied from the row the
      // describe above really wrote, so it is genuine content in the wrong state.
      const realResult = (await admin.query<{ result: unknown }>(
        "SELECT result FROM control_idempotency WHERE tenant_id=$1 AND operation_scope=$2 AND idempotency_key=$3",
        [scope.tenantId, `work-batches.propose/v1:${agentId}`, key])).rows[0]!.result;
      await intake.query(`INSERT INTO control_idempotency(tenant_id,operation_scope,idempotency_key,request_digest,status)
        VALUES($1,$2,$3,$4,'processing') ON CONFLICT DO NOTHING`,
        [scope.tenantId, `work-batches.propose/v1:${agentId}`, "orchestrator:describe-midflight-0005",
          `sha256:${"f".repeat(64)}`]);
      await admin.query("UPDATE control_idempotency SET result=$4::jsonb WHERE tenant_id=$1 AND operation_scope=$2 AND idempotency_key=$3",
        [scope.tenantId, `work-batches.propose/v1:${agentId}`, "orchestrator:describe-midflight-0005",
          JSON.stringify(realResult)]);
      assert.equal(await new PostgresIntakeCompletionLookupV1(database(intake)).completed(
        { tenantId: scope.tenantId, projectId: scope.projectId, identityId: agentId,
          requestKey: "orchestrator:describe-midflight-0005" }), null,
        "a valid receipt in a 'processing' row is not a completed request: the status is what decides");
      // ... and a 'completed' row whose result is NOT a receipt is unreachable
      // through this login, which is a stronger property than "the adapter would
      // refuse it": 0093's `guard_work_intake_idempotency_write` requires a
      // completed row's result to name a real batch at that revision, so the
      // intake login cannot write one at all. (Measured -- writing it raised
      // "work intake idempotency update rejected".) The lookup's own
      // `workBatchReceiptSchemaV1.safeParse` is the second line of defence for a
      // row written by anyone with broader rights, and the preflight's digest
      // plus the schema's own CHECKs are the third. The refusal is asserted
      // through the guard, and the guard is what actually holds.
      await intake.query(`INSERT INTO control_idempotency(tenant_id,operation_scope,idempotency_key,request_digest,status)
        VALUES($1,$2,$3,$4,'processing') ON CONFLICT DO NOTHING`,
        [scope.tenantId, `work-batches.propose/v1:${agentId}`, "orchestrator:describe-garbage-0004",
          `sha256:${"e".repeat(64)}`]);
      await assert.rejects(intake.query(`UPDATE control_idempotency SET status='completed',
        result='{"schema":"not-a-receipt"}'::jsonb, completed_at=$4::timestamptz
        WHERE tenant_id=$1::text AND operation_scope=$2::text AND idempotency_key=$3::text`,
      [scope.tenantId, `work-batches.propose/v1:${agentId}`, "orchestrator:describe-garbage-0004", LATER]),
      /work intake idempotency update rejected/u,
      "a 'completed' row whose result is not a receipt cannot be written by the intake login at all");
      // A receipt for a DIFFERENT project is not this project's proposal.
      assert.equal(await new PostgresIntakeCompletionLookupV1(database(intake)).completed(
        { tenantId: scope.tenantId, projectId: otherProject.projectId, identityId: agentId, requestKey: key }),
        null, "a stored receipt is not answered for a project it was not made for");
    } finally { await tasks.end(); await intake.end(); await admin.end(); }
  }, { port: PORT + 7, allowedPorts: ALLOWED, boundMs: 240_000 });
});

test("B4: a differing replay under a used request key is refused, not answered with the stored row", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    const tasks = new Client(postgres.connection("coordinator")); await tasks.connect();
    try {
      await seedTenant(admin, scope); await seedIdentities(admin, scope, "");
      const agentId = "identity:chief-agent";
      const { coordinator } = coordinatorFor({ intake: database(intake), coordinatorDb: database(tasks),
        agentId, onRun: () => {}, onConsume: () => {}, varying: false });
      const principal = { tenantId: scope.tenantId, identityId: agentId, actorType: "agent" as const,
        authenticatedAt: NOW, expiresAt: LATER };
      const batchDigest = await seedBatch(admin, scope, "batch:chief-replay", agentId);
      const requestKey = "resplit-replay-0001";
      // The re-split's `currentProposal` must be the batch's ACTUAL current plan --
      // the coordinator checks its digest against `baseRevisionDigest` and refuses
      // a mismatch as intake_coordinator_input_invalid, which is the guard
      // working.
      //
      // The B4 case is exercised at revision 1 rather than by advancing the batch,
      // and that is deliberate: advancing the batch to revision 2 makes 0200's
      // write guard refuse the whole INSERT ("batch.state/version must match"),
      // so the differing replay would be refused by the DATABASE for the wrong
      // reason and the adapter's comparison would never run. To reach the
      // adapter's arm the batch must still be current, so the differing content
      // is the PLANNER'S NEW PROPOSAL under the same key -- a different part
      // count, a different proposal digest, same bound revision.
      const current = proposal(scope.projectId);
      const first = await coordinator.coordinateResplit({ principal, projectId: scope.projectId,
        ownerRequest: "Split it again, more safely.", requestKey, batchId: "batch:chief-replay",
        baseRevision: 1, baseRevisionDigest: batchDigest, currentProposal: current, now: NOW });
      assert.equal(first.status, "suggested");
      if (first.status !== "suggested") return;
      const suggestionId = first.suggestion.suggestionId;
      // A second coordinator whose planner returns DIFFERENT content for the same
      // key and the same current revision. The store must refuse it rather than
      // answer with the row already stored -- which is exactly what production did
      // before the fix, and what the in-memory double refused.
      const different = new IntakeCoordinatorV1(
        { read: () => ({ workerId: "worker:chief", workerKind: "codex", modelKey: "model:plan", effort: "high" }) },
        { async run() { return { replyText: JSON.stringify(proposal(scope.projectId, 6)) }; } },
        { async consume() { return { allowed: true as const }; } },
        new PostgresIntakePlannerFailureStoreV1(database(tasks),
          () => ({ tenantId: scope.tenantId, projectId: scope.projectId }), () => LATER),
        new PostgresIntakeNeedsYouStoreV1(database(tasks), () => ({ identityId: agentId }), () => LATER),
        new WorkBatchServiceV1(new WorkBatchStoreV1(database(intake), KEY)),
        new PostgresIntakeSuggestionStoreV1(database(intake), KEY), catalog, ["code.change"],
        new PostgresIntakeCompletionLookupV1(database(intake)));
      // `now: NOW`, not LATER: the principal's `expiresAt` IS LATER, and
      // evaluatePolicy refuses a request at or after the session expiry
      // ("session_expired"). Passing LATER here refused the whole re-split as
      // planner_proposer_unauthorized before it ever reached the store, which
      // reads like a broken authority check rather than a fixture clock.
      await assert.rejects(different.coordinateResplit({ principal, projectId: scope.projectId,
        ownerRequest: "Split it again, more safely.", requestKey, batchId: "batch:chief-replay",
        baseRevision: 1, baseRevisionDigest: batchDigest, currentProposal: current, now: NOW }),
      (error: unknown) => error instanceof Error
        && /intake_suggestion_replay_conflict|replay_conflict/u.test(error.message),
      "a differing replay under a used request key is refused");
      // The stored suggestion is untouched, and there is still exactly one.
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM work_batch_split_suggestions
        WHERE tenant_id=$1 AND project_id=$2 AND request_key=$3`, [scope.tenantId, scope.projectId, requestKey]))
        .rows[0].n, 1, "a refused differing replay left the one stored row alone");
      assert.ok(suggestionId, "the original suggestion still has its id");
    } finally { await tasks.end(); await intake.end(); await admin.end(); }
  }, { port: PORT + 8, allowedPorts: ALLOWED, boundMs: 240_000 });
});

test("STRESS: 20 concurrent describes + retries on one project, two tenants, through the real coordinator", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    // 20 callers, each with its OWN pooled connection, as separate requests would.
    const CONCURRENCY = 20;
    const clients = await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      const client = new Client(postgres.connection("control_room_work_intake_agent")); await client.connect(); return client;
    }));
    // A coordinator connection per caller too: 0202's counter and ledger are the
    // coordinator's, and sharing one connection across 20 callers would hide any
    // per-connection problem the burst would otherwise expose.
    const coordinators = await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      const client = new Client(postgres.connection("coordinator")); await client.connect(); return client;
    }));
    try {
      // Only tenant A is seeded here. `seedTenant` REBINDS the singleton
      // work_intake_tenant_binding, so seeding the second tenant before A's own
      // describes run refuses all 20 of A's submissions with "new row violates
      // row-level security policy control_idempotency_work_intake_scope". That
      // is 0093 working as designed -- the intake login can only ever write for
      // the tenant it is bound to -- and it is the property the two-tenant half of
      // this test then exercises deliberately, at the end.
      await seedTenant(admin, scope); await seedIdentities(admin, scope, "");
      const agentId = "identity:chief-agent";
      const principal = { tenantId: scope.tenantId, identityId: agentId, actorType: "agent" as const,
        authenticatedAt: NOW, expiresAt: LATER };

      // A: 20 concurrent describes on 20 DIFFERENT keys (distinct requests).
      // Each should produce its own batch -- they are genuinely 20 different
      // requests, not 20 retries of one.
      const started = Date.now();
      const results = await Promise.all(clients.map(async (client, index) => {
        const runs = { planner: 0, consume: 0 };
        const { coordinator } = coordinatorFor({ intake: database(client),
          coordinatorDb: database(coordinators[index]!), agentId,
          onRun: () => { runs.planner += 1; }, onConsume: () => { runs.consume += 1; }, varying: false });
        try {
          const value = await coordinator.coordinateInitial({ principal, projectId: scope.projectId,
            ownerRequest: `Prepare bounded job ${index}.`, idempotencyKey: `request:stress-${String(index).padStart(4, "0")}`,
            now: NOW });
          return { ok: true as const, value, runs };
        } catch (error) { return { ok: false as const, message: String(error), runs }; }
      }));
      const elapsed = Date.now() - started;
      const failedResults = results.flatMap(result => result.ok ? [] : [result.message]);
      assert.deepEqual(failedResults, [],
        `every concurrent describe should succeed: ${failedResults.join("; ")}`);
      assert.ok(elapsed < 60_000, `bounded: 20 concurrent describes took ${elapsed}ms`);
      // 20 distinct requests = 20 runs and 20 batches. This is the property the
      // completion lookup must NOT break: it answers a REPEAT, never a new one.
      assert.equal(results.reduce((sum, r) => sum + r.runs.planner, 0), CONCURRENCY,
        "20 distinct requests are 20 planner runs");
      const batches = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM work_batches
        WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId]);
      assert.equal(batches.rows[0]!.n, String(CONCURRENCY), "20 distinct requests produced 20 batches");
      // Nothing started and nothing was approved by a describe.
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM work_batches
        WHERE tenant_id=$1 AND project_id=$2 AND state<>'proposed'`, [scope.tenantId, scope.projectId]))
        .rows[0].n, 0, "every batch is still proposed: a describe approves nothing");
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM control_jobs
        WHERE tenant_id=$1`, [scope.tenantId])).rows[0].n, 0, "and no job was created");

      // B: 20 concurrent RETRIES on ONE already-completed key. With the
      // completion lookup, 0 of them run the planner; without it, each would.
      const { coordinator: retryCoordinator } = coordinatorFor({ intake: database(clients[0]!),
        coordinatorDb: database(coordinators[0]!), agentId, onRun: () => {}, onConsume: () => {}, varying: true });
      const completedKey = "orchestrator:stress-retry-0001";
      const firstCall = await retryCoordinator.coordinateInitial({ principal, projectId: scope.projectId,
        ownerRequest: "Prepare one bounded job.", idempotencyKey: completedKey, now: NOW });
      assert.equal(firstCall.status, "submitted", "the first call under the retry key succeeds");
      if (firstCall.status !== "submitted") return;
      const retryBatchId = firstCall.submission.batchId;
      // Now fire 20 retries on that completed key, concurrently. Each shares the
      // completion lookup, so each returns the stored receipt with no run.
      let retryRuns = 0, retryConsumes = 0;
      const retries = await Promise.all(clients.map((client, index) => {
        const { coordinator: c } = coordinatorFor({ intake: database(client),
          coordinatorDb: database(coordinators[index]!), agentId,
          onRun: () => { retryRuns += 1; }, onConsume: () => { retryConsumes += 1; }, varying: true });
        return c.coordinateInitial({ principal, projectId: scope.projectId,
          ownerRequest: "Prepare one bounded job.", idempotencyKey: completedKey, now: NOW });
      }));
      const notSubmitted = retries.flatMap(r => r.status === "submitted" ? [] : [r.status]);
      assert.deepEqual(notSubmitted, [],
        `every retry returns the stored receipt: ${notSubmitted.join(",")}`);
      const retryIds = new Set(retries.flatMap(r => r.status === "submitted" ? [r.submission.batchId] : []));
      assert.deepEqual([...retryIds], [retryBatchId], "every retry returns the SAME batch id");
      assert.equal(retryRuns, 0, "20 concurrent retries spent zero planner runs");
      assert.equal(retryConsumes, 0, "and zero allowance units");
      // Under concurrency the durable store's idempotency held: 21 submissions on
      // 1 key = 1 batch, not 21. Asserted on the count rather than left implied.
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM work_batches
        WHERE tenant_id=$1 AND project_id=$2`, [scope.tenantId, scope.projectId])).rows[0].n,
        CONCURRENCY + 1, "21 submissions on the retry key and 20 distinct keys produced 21 batches, not 41");

      // C: the SECOND tenant is unaffected throughout -- its own coordinator,
      // its own batches, and no cross-tenant visibility.
      //
      // `seedTenant` REBINDS the work_intake_tenant_binding singleton, so this is
      // where the second tenant is seeded and where A's describes have finished.
      // Doing it earlier refused all 20 of A's submissions with "new row violates
      // row-level security policy control_idempotency_work_intake_scope" -- which
      // is 0093 working exactly as designed, and a property worth stating: the
      // intake login can only ever write for the tenant it is bound to.
      await seedTenant(admin, other); await seedIdentities(admin, other, "-other");
      const otherPrincipal = { tenantId: other.tenantId, identityId: "identity:chief-agent-other",
        actorType: "agent" as const, authenticatedAt: NOW, expiresAt: LATER };
      const { coordinator: otherCoordinator } = coordinatorFor({ intake: database(clients[2]!),
        coordinatorDb: database(coordinators[2]!), agentId: otherPrincipal.identityId,
        onRun: () => {}, onConsume: () => {}, varying: false, projectId: other.projectId });
      const otherResult = await otherCoordinator.coordinateInitial({ principal: otherPrincipal, projectId: other.projectId,
        ownerRequest: "Prepare a different job.", idempotencyKey: "request:other-0001", now: NOW });
      assert.equal(otherResult.status, "submitted", "the second tenant's describe works independently");
      assert.equal((await admin.query(`SELECT count(*)::text AS n FROM work_batches WHERE tenant_id=$1`,
        [other.tenantId])).rows[0]!.n, "1", "the second tenant got exactly one batch of its own");
      assert.equal((await admin.query(`SELECT count(*)::text AS n FROM work_batches WHERE tenant_id=$1 AND project_id=$2`,
        [scope.tenantId, scope.projectId])).rows[0]!.n, String(CONCURRENCY + 1),
        "the first tenant's batch count is unchanged by the second tenant's work");
    } finally { await Promise.all([...clients, ...coordinators].map(async client => {
      await client.end().catch(() => {}); })); await admin.end(); }
  }, { port: PORT + 9, allowedPorts: ALLOWED, boundMs: 300_000 });
});


test("STRESS: 20 concurrent presses and owner retries of ONE description stay one item and one run", async t => {
  // Round 3's stress, and it is the shape the review said it could not rule out
  // from the panel: "One panel cannot do this, because `pending` disables the
  // button. Two tabs or devices can."
  //
  // What it has to hold, and what round 2 measured failing:
  //   * 20 concurrent presses of ONE description -> ONE Needs-you row and ONE
  //     open inbox item, not 19 of each. That is the de-duplication.
  //   * 20 concurrent owner retries -> at most ONE grant, because the grant is
  //     one-shot at the database, and the count is never lowered.
  //   * and no run loop: the presses that are refused cost no planner run.
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const CONCURRENCY = 20;
    const coordinators = await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      const client = new Client(postgres.connection("coordinator")); await client.connect(); return client;
    }));
    try {
      // No tenant binding is needed here: this stress drives the COORDINATOR's
      // failure counter, ledger and retry grant, none of which are intake-table
      // writes, so 0093's binding policy is not in the path. `seedTenant` in this
      // file takes no options for exactly that reason.
      await seedTenant(admin, scope); await seedIdentities(admin, scope, "");
      const description = "Make the release notes match the shipped behaviour.";
      const projectScope = intakeProjectScopeV1("initial", scope.tenantId, scope.projectId, description);
      const scopeOf = () => ({ tenantId: scope.tenantId, projectId: scope.projectId });

      // Escalate through the real adapter on one connection, so the counter is
      // real before the burst rather than hand-set.
      const warm = new PostgresIntakePlannerFailureStoreV1(database(coordinators[0]!), scopeOf, () => LATER);
      assert.equal(await warm.record(projectScope), 1);
      assert.equal(await warm.record(projectScope), 2);

      // TWENTY CONCURRENT PRESSES, a fresh request key each, through twenty
      // coordinators each on its own connection -- the two-tabs case.
      let runs = 0;
      const results = await Promise.all(coordinators.map(async (client, index) => {
        const { coordinator } = coordinatorFor({ intake: database(client),
          coordinatorDb: database(client), agentId: "identity:chief-agent",
          onRun: () => { runs += 1; }, onConsume: () => {}, varying: true,
          completions: false, projectId: scope.projectId });
        try {
          const value = await coordinator.coordinateInitial({ principal: {
            tenantId: scope.tenantId, identityId: "identity:chief-agent", actorType: "agent",
            authenticatedAt: NOW, expiresAt: LATER }, projectId: scope.projectId,
            ownerRequest: description, idempotencyKey: `orchestrator:burst-${String(index).padStart(4, "0")}`,
            now: LATER });
          return value.status;
        } catch (error) { return `threw:${String((error as Error).message).slice(0, 90)}` as const; }
      }));
      // EVERY press is refused with Needs-you -- none of them is a run, and none
      // is a submission.
      assert.deepEqual([...new Set(results.map(value => value.split(":")[0]))], ["needs_you"],
        `every concurrent press of an escalated description is refused as needs_you, got ${JSON.stringify(results)}`);
      assert.equal(runs, 0, "and not one of them spent a planner run");

      // ONE ITEM, however many pressed. This is the flood the review measured at
      // five items and five inbox entries for one broken description.
      const items = await admin.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM control_planner_needs_you_items WHERE scope_key=$1", [projectScope]);
      assert.equal(items.rows[0]!.n, "1", "twenty presses of ONE description leave ONE Needs-you item");
      const inbox = await admin.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM control_action_inbox WHERE kind='failure'");
      assert.equal(inbox.rows[0]!.n, "1", "and ONE open inbox item, not twenty");

      // TWENTY CONCURRENT OWNER RETRIES, raced on the OWNER'S OWN LOGIN because
      // that is the only login holding EXECUTE on
      // `control_room_planner_grant_owner_retry` after round 4's REVOKE -- and
      // because a `catch { return 0 }` here would have turned twenty permission
      // errors into "nobody was granted", which is exactly the reading this
      // assertion exists to rule out. Twenty callers now race the same row, and
      // the trigger plus the function's own WHERE must leave at most one latch.
      // Twenty SEPARATE connections, because that is what twenty real callers
      // have and a shared one would serialise them into a queue and prove nothing.
      // Each is closed in its own finally: a connection still open when the
      // harness stops the cluster surfaces as an uncaught 57P01 on an idle socket.
      const granted = await Promise.all(Array.from({ length: 20 }, async () => {
        const client = new Client(postgres.connection("web")); await client.connect();
        try {
          return await new PostgresIntakeOwnerRetryStoreV1(database(client)).grant({ tenantId: scope.tenantId,
            projectId: scope.projectId, requestKey: `orchestrator:retry-${randomUUID()}`, ownerRequest: description });
        } finally { await client.end(); }
      }));
      const total = granted.reduce((sum, value) => sum + value, 0);
      assert.equal(total, 1, `exactly one of twenty concurrent retries may be granted, got ${total}`);
      const latched = await admin.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM control_planner_failure_counters WHERE scope_key=$1 AND owner_retry_cleared_at IS NOT NULL",
      [projectScope]);
      assert.equal(latched.rows[0]!.n, "1", "and exactly one latch is standing");
      const count = await admin.query<{ failure_count: string }>(
        "SELECT failure_count::text FROM control_planner_failure_counters WHERE scope_key=$1", [projectScope]);
      assert.equal(count.rows[0]!.failure_count, "2", "a granted retry never lowers the count");
      // THE OWNER'S WEB LOGIN is the one that normally asks, and it holds no
      // privilege on the table -- so the same race through it must produce the
      // same single grant, and must be refused outright for anything else.
      const web = new Client(postgres.connection("web")); await web.connect();
      try {
        const retry = new PostgresIntakeOwnerRetryStoreV1(database(web));
        assert.equal(await retry.grant({ tenantId: scope.tenantId, projectId: scope.projectId,
          requestKey: `orchestrator:web-retry-${randomUUID()}`, ownerRequest: description }), 0,
        "a second grant through the owner's own login is refused: the latch is one-shot");
        await assert.rejects(web.query("UPDATE control_planner_failure_counters SET failure_count=0"),
          /permission denied/u, "and the owner still holds no UPDATE on the counters");
      } finally { await web.end(); }

      // AND A SUCCESS ENDS IT. The store's clear -- what the granted run's success
      // performs -- zeroes the count and drops any latch still standing, so the
      // burst cannot be repeated against it and no further press is exempt.
      await warm.clear(projectScope);
      assert.equal(await warm.count(projectScope), 0);
      assert.equal(await warm.ownerRetryGranted(projectScope), false,
        "the latch is gone, so no further press is exempt from the escalation");
    } finally { for (const client of coordinators) await client.end(); await admin.end(); }
  }, { port: PORT + 5, allowedPorts: ALLOWED, boundMs: 240_000 });
});


test("the completion lookup answers only a COMPLETED request, and never a different description", async t => {
  // Two properties of the same read, both of which round 3 nearly broke by accident.
  //
  // ONE: only a COMPLETED row counts. A 'processing' row is a submission that was
  // in flight when the process died, and answering from it hands the owner a
  // receipt for a batch that may never have been committed. Round 3 rewrote this
  // SELECT to add `request_digest` and dropped `status='completed'` without
  // noticing; the mutation suite's B2c anchor stopped existing, which is how it
  // was found. This assertion is here so the next rewrite of this query is caught
  // by a TEST rather than by a missing anchor.
  //
  // TWO (N8): a completed key must not answer a DIFFERENT description. The stored
  // request_digest is over the planner's OUTPUT, which the owner cannot recompute
  // before a run, so the honest answer is to refuse rather than guess.
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const intake = new Client(postgres.connection("control_room_work_intake_agent")); await intake.connect();
    try {
      await seedTenant(admin, scope);
      await seedIdentities(admin, scope, "");
      // The intake login needs a binding to write at all (0093's policy), and this
      // file's `seedTenant` takes no options, so the binding is set here.
      await admin.query("DELETE FROM work_intake_tenant_binding");
      await admin.query("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1)", [scope.tenantId]);
      const db = database(intake), identityId = "identity:chief-agent";
      const scopeName = `work-batches.propose/v1:${identityId}`;
      const requestKey = "completion-lookup-0001";
      const lookup = new PostgresIntakeCompletionLookupV1(db);

      // A 'processing' row: in flight, never finished. It carries a result on
      // purpose, because a 'processing' row with a NULL result is refused by the
      // adapter's own `!receipt.success` check and so proves nothing about the
      // status predicate. This is the shape the predicate exists for: a receipt
      // written, the transaction not yet committed, the process gone.
      // Seeded as the SCHEMA OWNER, deliberately. 0093's own guard refuses a
      // 'processing' row that already carries a result, so the only way to produce
      // the exact shape the status predicate exists for -- a receipt written, the
      // transaction not committed, the process gone -- is to write it as the owner,
      // which is what that failure state actually looks like on disk.
      const inFlight = { schema: "control-room.work-batch-receipt/v1", batchId: "batch:completion-0001",
        projectId: scope.projectId, state: "proposed", proposalDigest: `sha256:${"a".repeat(64)}`,
        revision: 1, replayed: false, startsWork: false, grantsExecutionAuthority: false };
      await admin.query(`INSERT INTO control_idempotency(tenant_id,operation_scope,idempotency_key,
        request_digest,status,result) VALUES($1,$2,$3,$4,'processing',$5::jsonb)`,
      [scope.tenantId, scopeName, requestKey, sha256Digest({ inFlight: true }), JSON.stringify(inFlight)]);
      // The receipt is a VALID one -- it parses and names this project -- so
      // nothing but the status predicate can refuse it. That is what makes the
      // next assertion the test rather than a restatement of the parse check.
      assert.ok(workBatchReceiptShape.safeParse(inFlight).success,
        "precondition: the in-flight row carries a receipt this adapter would otherwise accept");
      assert.equal(await lookup.completed({ tenantId: scope.tenantId, projectId: scope.projectId,
        identityId, requestKey }), null,
      "a 'processing' row is not a completed request, so nothing is answered from it -- even with a parseable receipt");
      assert.equal(await lookup.completed({ tenantId: scope.tenantId, projectId: scope.projectId,
        identityId, requestKey, ownerRequest: "Any description at all." }), null,
      "and a description does not make it completable");

      // Complete it with a real receipt, and it IS answered. 0093's own guard
      // refuses an UPDATE that does not name a real proposed batch matching the
      // receipt, so the batch is seeded first -- as the schema owner, because
      // seeding a batch is not what this test is about and the guard would (rightly)
      // refuse a hand-written shortcut. A receipt the database will not accept is
      // not a receipt the owner could ever be shown.
      const value = { schema: "control-room.work-batch-receipt/v1", batchId: "batch:completion-0001",
        projectId: scope.projectId, state: "proposed", proposalDigest: `sha256:${"a".repeat(64)}`,
        revision: 1, replayed: false, startsWork: false, grantsExecutionAuthority: false };
      const stored = { schema: "control-room.work-batch-proposal/v1", projectId: scope.projectId,
        tasks: [{ localId: "only", title: "Do the bounded thing", instructions: "Implement exactly it.",
          requiredCapability: "code.change", role: "builder",
          acceptanceCriteria: "It matches the contract.", acceptanceTests: "Run the focused tests." }], edges: [] };
      const agentId = `identity:chief-agent`;
      await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
        auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'agent','Fixture','work-intake',$3,'active',$4,$4)
        ON CONFLICT DO NOTHING`, [agentId, scope.tenantId, sha256Digest({ agentId }), NOW]);
      await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
        risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES($1,$2,$3,'work_batch_proposer','["work_batches.propose"]'::jsonb,'["*"]'::jsonb,'low',false,false,$4,$4)
        ON CONFLICT DO NOTHING`, [`grant:${agentId}`, scope.tenantId, agentId, NOW]);
      await admin.query(`INSERT INTO work_batches(id,tenant_id,project_id,proposed_by_identity_id,
        proposed_by_actor_type,proposed_at,state,proposal,queue_depth_limit,batch_digest,auth_tag,version,
        created_at,updated_at) VALUES($1,$2,$3,$4,'agent',$5,'proposed',$6::jsonb,10,$7,$8,1,$5,$5)
        ON CONFLICT DO NOTHING`,
      ["batch:completion-0001", scope.tenantId, scope.projectId, agentId, NOW, JSON.stringify(stored),
        `sha256:${"a".repeat(64)}`, `hmac-sha256:${"0".repeat(64)}`]);
      // A SECOND key, seeded directly as 'completed'. 0093's guard only permits the
      // processing -> completed transition, and only from a row with a NULL result,
      // so completing the in-flight row above is impossible by design; this is the
      // same end state written directly, which is what a committed submission looks
      // like on disk.
      const doneKey = "completion-lookup-0002";
      await admin.query(`INSERT INTO control_idempotency(tenant_id,operation_scope,idempotency_key,
        request_digest,status,result,completed_at) VALUES($1,$2,$3,$4,'completed',$5::jsonb,$6)`,
      [scope.tenantId, scopeName, doneKey, sha256Digest({ done: true }), JSON.stringify(value), LATER]);
      const replayed = await lookup.completed({ tenantId: scope.tenantId, projectId: scope.projectId,
        identityId, requestKey: doneKey });
      assert.equal(replayed?.status, "submitted", "a completed request is answered from storage");
      assert.equal(replayed?.status === "submitted" ? replayed.submission.batchId : null, "batch:completion-0001");
      // N8: the SAME key, a DIFFERENT description. This used to return the old
      // receipt -- `submitted`, `replayed: true`, no run and no refusal -- so a
      // caller that reused a key for a new job was told that job had been prepared.
      assert.equal(await lookup.completed({ tenantId: scope.tenantId, projectId: scope.projectId,
        identityId, requestKey: doneKey, ownerRequest: "A completely different description." }), null,
      "a completed key does not answer a different description");
      // A receipt for a DIFFERENT project is also not an answer, unchanged by
      // round 3 and asserted so it stays that way.
      assert.equal(await lookup.completed({ tenantId: scope.tenantId, projectId: "project:elsewhere",
        identityId, requestKey: doneKey }), null, "a receipt for another project is not this project's proposal");
      // And a key under a different identity is a different request entirely,
      // because 0093 scopes the ledger per identity.
      assert.equal(await lookup.completed({ tenantId: scope.tenantId, projectId: scope.projectId,
        identityId: "identity:somebody-else", requestKey: doneKey }), null);
    } finally { await intake.end(); await admin.end(); }
  }, { port: PORT + 3, allowedPorts: ALLOWED, boundMs: 180_000 });
});
