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
      // Another tenant's tenant id, project id and batch id are all refused by the
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