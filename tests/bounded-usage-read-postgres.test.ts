// Real-PostgreSQL proof that the task-detail usage read is BOUNDED and still
// EXACT, run as the production private-web login against the real role files.
//
// Why this file exists
// --------------------
// #412 replaced a deliberately `LIMIT 11`-bounded reader on the task-detail path
// with `inspectUsageScope`, an unbounded `SELECT` over every run in the job with
// every event, HMAC-verified row by row in the application. Row volume — not
// query count — was the exposure, and it grew monotonically with project
// history. `tests/task-read-query-budget.test.ts` cannot see it: it counts
// round trips, which stayed constant.
//
// What it proves, on a real cluster, with 5,000 usage rows in scope:
//   1. BOUNDED — the total number of database rows that cross into the
//      application while serving task detail does not grow with run history.
//   2. EXACT — the totals it reports equal the totals of every one of those
//      5,000 runs, computed independently from the seeded data.
//   3. ROLE-CORRECT — the read runs as `control_room_private_web`, the login
//      both deployments use, with the real role files and no superuser bypass.
//
// (3) is why this is not written against a fake client. A `DatabaseClient`
// stub cannot be refused a privilege, so it would prove nothing about whether
// the aggregate is readable by the role that actually runs this page.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { WebTaskService } from "../src/web/v1/task-service";
import { HarnessRunStoreV1 } from "../src/harness/v1/store";
import { sha256Digest } from "../src/security";
import { rollupUsageGroupsV1 } from "../src/usage/v1/usage-cost";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";

// Reserved disposable-cluster lane for this job: 56230-56239.
const PORT = Number(process.env.BOUNDED_USAGE_PG_PORT ?? 56230);
const PORTS = [56230, 56231, 56232, 56233, 56234, 56235, 56236, 56237, 56238, 56239];
const PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => {
  if (PG) { required += 1; return undefined; }
  return { skip: realPostgresSkipMessage() };
};

/** How many runs the job has accumulated. The whole point of the test: this
 * number is large, and nothing the page does may scale with it. */
const RUNS = 5_000;
/**
 * Runs written through the REAL store with real digests, as the production
 * publisher role. This is 11, not 10, and the reason is the bound itself:
 * `inspectAttempts` uses `LIMIT 11` — ten displayed plus one that exists only so
 * `additionalRunsOmitted` can be set — and it authenticates every row it reads
 * before the page discards the eleventh. So all eleven rows the reader can return
 * must be authentic, and the fixture signs exactly that many.
 */
const STORE_SIGNED_RUNS = 11;

const PROVIDER = "test";
const SUBJECT = "owner";
const MODEL = "gpt-bounded-fixture";
/** A second priced model whose entry records no cache rate, so the two differ
 * only in whether a cache discount was ever set. */
const UNCACHED_MODEL = "gpt-bounded-fixture-no-cache-price";
const INTEGRITY_KEY = new Uint8Array(32).fill(41);
const ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const tokenDigest = sha256Digest({ session: "bounded-usage-owner" });

const SCOPE = { tenantId: "tenant:bounded-usage", workspaceId: "workspace:bounded-usage" };
/** `WebProjectService.getViewInSession` only resolves a project whose adapter
 * is this derived manual adapter, so the fixture must register that exact id —
 * the same derivation production uses from the tenant/workspace scope. */
const MANUAL_ADAPTER = `adapter:manual:${sha256Digest(SCOPE).slice(7, 39)}`;
const ids = {
  tenant: SCOPE.tenantId, workspace: SCOPE.workspaceId,
  adapter: MANUAL_ADAPTER, project: "project:bounded-usage",
  identity: "identity:bounded-usage-owner", grant: "grant:bounded-usage-owner",
  request: "request:bounded-usage", workflow: "workflow:bounded-usage",
  job: "job:bounded-usage", attempt: "attempt:bounded-usage", node: "node:bounded-usage",
};
const AUTHORITY_DIGEST = `sha256:${"a".repeat(64)}`;
const CONTRACT = "control-room-domain/v1";

/** Per-run token counts, so the expected totals are derivable without the code
 * under test being involved in producing them. */
const perRun = { inputTokens: 100, outputTokens: 20, totalTokens: 120, wallTimeMs: 250 };

/**
 * Owner price table for exactly the fixture model. Deliberately the token kind
 * with a cache price, so the aggregate's cache-aware branch is the one on the
 * hot path and a cache-token regression cannot hide behind a subscription.
 */
const priceTable = {
  schema: "control-room.usage-price-table/v1" as const,
  tableId: "owner-prices-bounded-usage",
  recordedAt: "2026-09-29T00:00:00.000Z",
  entries: [
    { entryId: "bounded-usage-codex-price", harness: "codex" as const, model: MODEL,
      billing: { kind: "token" as const, inputNanoUsdPerToken: "1250",
        outputNanoUsdPerToken: "10000", cachedInputNanoUsdPerToken: "125" } },
    // Deliberately NO cache rate: a run on this model with cache tokens must
    // report `cache_pricing_not_recorded`, never a discount nobody recorded.
    { entryId: "bounded-usage-codex-unpriced-cache", harness: "codex" as const, model: UNCACHED_MODEL,
      billing: { kind: "token" as const, inputNanoUsdPerToken: "1250", outputNanoUsdPerToken: "10000" } },
  ],
};

async function seedScope(admin: Client) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [ids.tenant]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [ids.workspace, ids.tenant]);
  await admin.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [ids.adapter, ids.tenant]);
  await admin.query(`INSERT INTO projects
    (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
     health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1',$1,'running','fixture','healthy','control_room_native',now(),'{}',now())`,
  [ids.project, ids.tenant, ids.workspace, ids.adapter]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,now(),now())`, [ids.tenant, ids.project]);
  await admin.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Owner',$3,$4,'active',$5,$5)`,
  [ids.identity, ids.tenant, PROVIDER, sha256Digest({ provider: PROVIDER, subject: SUBJECT }), ISSUED_AT]);
  await admin.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,
     require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`, [ids.grant, ids.tenant, ids.identity, ISSUED_AT]);
  await admin.query(`INSERT INTO control_requests
    (id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
    VALUES($1,$2,$3,'accepted',0,$1,jsonb_build_object('id',$1::text,'kind','request','tenantId',$2::text,
      'projectId',$3::text,'contractVersion','control-room-domain/v1','title','Bounded usage task',
      'objective','Bound the usage read.','state','accepted','version',0,'priority',50,
      'requestedBy',jsonb_build_object('actorId',$4::text,'actorType','human'),'idempotencyKey',$1::text,
      'createdAt',$5::text,'updatedAt',$5::text),$5::timestamptz,$5::timestamptz)`,
  [ids.request, ids.tenant, ids.project, ids.identity, ISSUED_AT]);
  // `validate_control_payload_mirror()` requires `payload->>'id'`, `tenantId`,
  // `state` and `version` to equal the columns, so the workflow is inserted with
  // its jobIds already present rather than patched afterwards.
  await admin.query(`INSERT INTO control_workflows
    (id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'active',1,jsonb_build_object('id',$1::text,'kind','workflow','tenantId',$2::text,
      'requestId',$3::text,'projectId',$4::text,'contractVersion','control-room-domain/v1','definitionVersion','1.0.0',
      'definitionDigest',$5::text,'authorityMode','control_room_native','state','active','version',1,'jobIds',$6::jsonb,
      'createdAt',$7::text,'updatedAt',$7::text),$7::timestamptz,$7::timestamptz)`,
  [ids.workflow, ids.tenant, ids.request, ids.project, AUTHORITY_DIGEST, JSON.stringify([ids.job]), ISSUED_AT]);
  // The job record must satisfy the real `jobRecordSchema`, including its
  // authority envelope, or the detail read refuses before reaching any usage.
  const authority = { projectId: ids.project, allowedExecutor: ids.adapter, allowedOperations: ["execute"],
    credentialRefs: [], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [],
    effectPolicy: "preauthorized", maxRisk: "low", maxDurationSeconds: 3_600, maxConcurrentEffects: 1,
    expiresAt: EXPIRES_AT, digest: AUTHORITY_DIGEST };
  const payload = { id: ids.job, kind: "job", contractVersion: CONTRACT, tenantId: ids.tenant,
    workflowId: ids.workflow, projectId: ids.project,
    // Not `task.proposal`: that type makes `validated()` re-derive the input
    // digest from the request's own title/objective, which would couple this
    // fixture's job row to its request row for no benefit. Any other type keeps
    // the read path identical up to the usage work under test.
    jobType: "harness.fixture.job", specVersion: "1.0.0",
    inputDigest: sha256Digest({ instructions: "Bound the usage read." }),
    state: "leased", version: 1, createdAt: ISSUED_AT, updatedAt: ISSUED_AT, priority: 50,
    requiredCapability: "fixture", dependsOnJobIds: [], authority,
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false,
      ambiguousEffectPolicy: "attention" } };
  await admin.query(`INSERT INTO control_jobs
    (id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,
     created_at,updated_at)
    VALUES($1,$2,$3,$4,'leased',1,50,'fixture',$5,$6::jsonb,$7::timestamptz,$7::timestamptz)`,
  [ids.job, ids.tenant, ids.workflow, ids.project, AUTHORITY_DIGEST, JSON.stringify(payload), ISSUED_AT]);
  // The node carries the canonical payload mirror too, so `id`/`tenantId`/
  // `state`/`version` inside it must match its own columns.
  // `validate_control_payload_mirror()` mirrors `identityKeyId` for nodes and
  // `idempotencyKey`/`projectId` for requests, so each payload carries every
  // column its own trigger names rather than the four generic ones.
  await admin.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    VALUES($1,$2,'active',0,$3,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','active','version',0,
      'identityKeyId',$3::text),$4::timestamptz,$4::timestamptz)`,
  [ids.node, ids.tenant, "key:bounded-usage", ISSUED_AT]);
  await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`, [ids.tenant, tokenDigest, ids.identity, ISSUED_AT, EXPIRES_AT]);
  // The one attempt the runs hang off. `HarnessRunStoreV1.create` refuses a run
  // whose attempt is not leased/running/waiting, so the fixture has to be a real
  // active attempt — which is also what the detail page displays.
  await admin.query(`INSERT INTO control_attempts
    (id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,payload,created_at,updated_at)
    VALUES($1,$2,$3,1,'running',1,$4,1,jsonb_build_object('id',$1::text,'kind','attempt','tenantId',$2::text,
      'contractVersion','control-room-domain/v1',
      'jobId',$3::text,'state','running','version',1,'nodeId',$4::text,'createdAt',$5::text,'offeredAt',$5::text,
      'startedAt',$5::text,'updatedAt',$5::text,'leaseEpoch',1,'attemptNumber',1),$5::timestamptz,$5::timestamptz)`,
  // `running` is a nonterminal attempt, so it carries `startedAt` and NO
  // `finishedAt` — `attemptRecordSchema` rejects either combination when it is
  // paired the wrong way round.
  [ids.attempt, ids.tenant, ids.job, ids.node, new Date(Date.now() - 30_000).toISOString()]);
}

/**
 * Seed `count` runs, each carrying a lifecycle pair, a usage event and a
 * terminal event, all reporting `perRun`'s tokens.
 *
 * The FIRST `STORE_SIGNED_RUNS` go through the real `HarnessRunStoreV1` over the
 * production EVIDENCE role, so the rows the page displays are genuinely
 * store-signed, digest-verified records. The remainder are one plain-SQL
 * `generate_series` batch.
 *
 * Why the split, stated plainly rather than hidden behind a comment: this test
 * asserts two different properties of the same read, and they need different
 * fixtures. The DISPLAYED rows must be authentic — `verifyStoredHarnessRunV1`
 * HMAC-checks every one of them, and a fixture that skipped that would be
 * testing a code path production never takes. The AGGREGATED rows are, by the
 * fix's own design, never handed to the application at all: the bound IS that
 * no per-run row crosses into it. Signing 4,990 further rows would prove nothing
 * the 10 real ones do not, and would cost ~95,000 statements and several minutes
 * of CI for it. The exactness claim is about totals versus seeded data, which is
 * independent of whether a digest was real.
 */
async function seedRuns(store: HarnessRunStoreV1, admin: Client, count: number) {
  // The store-signed runs are the NEWEST ones on purpose.
  // `inspectAttempts` reads `ORDER BY created_at DESC, id DESC LIMIT 11`, so the
  // rows the page actually displays — and therefore the rows
  // `verifyStoredHarnessRunV1` authenticates — are these ten. The bulk runs sit
  // behind them, so the aggregate has to cover all `count` while the verified
  // presentation set stays genuinely authentic. Getting this backwards fails the
  // test at `harness event integrity failure`, which is the store doing its job.
  const createdAt = new Date(Date.now() - 100_000).toISOString();
  const finishedAt = new Date(Date.now() - 90_000).toISOString();
  const bulkCreatedAt = new Date(Date.now() - 900_000).toISOString();
  const bulkFinishedAt = new Date(Date.now() - 890_000).toISOString();
  for (let index = 0; index < Math.min(count, STORE_SIGNED_RUNS); index += 1) {
    const runId = `run:bounded-usage:${String(index).padStart(4, "0")}`;
    await store.create({
      schemaVersion: "control-room-harness/v1", id: runId, tenantId: ids.tenant, projectId: ids.project,
      jobId: ids.job, attemptId: ids.attempt, nodeId: ids.node, adapterId: ids.adapter,
      adapterVersion: "1.0.0", harness: "codex", harnessVersion: "codex-bounded-usage-1",
      nativeSessionKeyDigest: sha256Digest({ purpose: "bounded-usage-test", runId }),
      modelSelection: { model: MODEL, effort: "medium" }, state: "discovered", resumable: false,
      cancelState: "not_requested", createdAt, updatedAt: createdAt, lastObservedAt: createdAt,
    });
    // The store enforces the real lifecycle, so the event sequence is the one
    // production publishes: discovered -> starting -> running -> usage -> terminal.
    for (const [sequence, occurredAt, payload] of [
      [1, createdAt, { category: "lifecycle" as const, state: "starting" as const }],
      [2, createdAt, { category: "lifecycle" as const, state: "running" as const }],
      [3, finishedAt, { category: "usage" as const, inputTokens: perRun.inputTokens,
        outputTokens: perRun.outputTokens, totalTokens: perRun.totalTokens, cachedInputTokens: 0,
        reasoningTokens: null, wallTimeMs: perRun.wallTimeMs }],
      [4, finishedAt, { category: "lifecycle" as const, state: "succeeded" as const }],
    ] as const) {
      await store.append({ schemaVersion: "control-room-harness-event/v1", tenantId: ids.tenant, runId,
        sequence, occurredAt, source: "adapter", sourceEventKeyDigest: sha256Digest({ runId, sequence }), payload });
    }
  }
  if (count <= STORE_SIGNED_RUNS) return;
  // The bulk batch. Digest columns carry well-formed placeholders: the read under
  // test deliberately does not verify them (that is the point of the bound), and
  // the token values are what the exactness assertions are computed from.
  // Two bulk statements. Every parameter is cast where its type is ambiguous,
  // and the ISO strings are passed separately from the `timestamptz` values they
  // become: `jsonb_build_object` on a `timestamptz` parameter would render a
  // timestamp literal, which `harnessRunEventSchemaV1` rejects as `occurredAt`.
  const digest = `sha256:${"b".repeat(64)}`, tag = `hmac-sha256:${"c".repeat(64)}`;
  const from = STORE_SIGNED_RUNS + 1, bulk = count - STORE_SIGNED_RUNS;
  // `UNIQUE (tenant_id,node_id,adapter_id,native_session_key_digest)` means every
  // run needs its own session key, so the digest is derived per row rather than
  // shared. Two concatenated md5 halves give the 64 hex characters the schema's
  // `^sha256:[a-f0-9]{64}$` check wants, with no extension needed.
  await admin.query(`INSERT INTO control_harness_runs
    (id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,
     state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
    SELECT 'run:bounded-usage:'||lpad(bulk.g::text,4,'0'),
      $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,'codex',bulk.session_key,
      'succeeded',4,$7::text,$8::text,
      jsonb_build_object('schemaVersion','control-room-harness/v1',
        'id','run:bounded-usage:'||lpad(bulk.g::text,4,'0'),
        'tenantId',$1::text,'projectId',$2::text,'jobId',$3::text,'attemptId',$4::text,'nodeId',$5::text,
        'adapterId',$6::text,'adapterVersion','1.0.0','harness','codex','harnessVersion','codex-bounded-usage-1',
        'nativeSessionKeyDigest',bulk.session_key,
        'modelSelection',jsonb_build_object('model',$9::text,'effort','medium'),
        'state','succeeded','resumable',false,'cancelState','not_requested','createdAt',$10::text,
        'startedAt',$10::text,'updatedAt',$11::text,'finishedAt',$11::text,'lastObservedAt',$11::text),
      $10::timestamptz,$11::timestamptz,$11::timestamptz
    FROM (SELECT g,'sha256:'||md5(g::text)||md5(('bulk'||g::text)::text) AS session_key
      FROM generate_series($12::int,$12::int+$13::int-1) g) bulk`,
  [ids.tenant, ids.project, ids.job, ids.attempt, ids.node, ids.adapter,
    digest, tag, MODEL, bulkCreatedAt, bulkFinishedAt, from, bulk]);
  // Only the USAGE event is written per bulk run; it is the last event the
  // aggregate's precedence picks, and it is what the exactness claims use.
  await admin.query(`INSERT INTO control_harness_run_events
    (tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,event_auth_tag,payload,recorded_at)
    SELECT $1::text,'run:bounded-usage:'||lpad(g::text,4,'0'),4,$2::timestamptz,'adapter',
      $3::text,$4::text,$5::text,
      jsonb_build_object('schemaVersion','control-room-harness-event/v1','tenantId',$1::text,
        'runId','run:bounded-usage:'||lpad(g::text,4,'0'),'sequence',4,'occurredAt',$6::text,'source','adapter',
        'sourceEventKeyDigest',$3::text,
        'payload',jsonb_build_object('category','usage','inputTokens',$7::int,
          'outputTokens',$8::int,'totalTokens',$9::int,'cachedInputTokens',0,'reasoningTokens',null,
          'wallTimeMs',$10::int)),
      $2::timestamptz
    FROM generate_series($11::int,$11::int+$12::int-1) g`,
  // $3 source_event_key_digest and $4 event_digest are both `sha256:`-shaped and
  // $5 event_auth_tag is `hmac-sha256:`-shaped; each column's CHECK pattern is
  // distinct, so one placeholder value cannot fill all three.
  [ids.tenant, bulkFinishedAt, digest, digest, tag, bulkFinishedAt,
    perRun.inputTokens, perRun.outputTokens, perRun.totalTokens, perRun.wallTimeMs, from, bulk]);
}

/** Records every statement and how many rows it returned, so a test can assert
 * what crossed into the application rather than what was asked for.
 *
 * The bounded-database driver maps every definite SQLSTATE to one opaque
 * `database_unavailable`, which is right for production and useless for a
 * fixture: a SQL error in the aggregate would otherwise report itself as an
 * outage. So the original error's message rides along on the wrapper, and the
 * assertion below prints it when something here is a query bug rather than a
 * product bug. */
function traced(db: DatabaseClient) {
  const statements: { sql: string; rows: number }[] = [];
  const record = async <T>(sql: string, params: unknown[],
    run: (s: string, p: unknown[]) => Promise<{ rows: T[] }>) => {
    const result = await run(sql, params);
    statements.push({ sql, rows: result.rows.length });
    return result;
  };
  const wrap = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
    try { return await record(sql, params ?? [], (s, p) => tx.query<T>(s, p)); }
    catch (error) { throw Object.assign(error as Error, { statement: sql }); }
  } });
  const client: DatabaseClient = {
    query: async <T>(sql: string, params?: unknown[]) => {
      try { return await record(sql, params ?? [], (s, p) => db.query<T>(s, p)); }
      catch (error) { throw Object.assign(error as Error, { statement: sql }); }
    },
    transaction: work => db.transaction(tx => work(wrap(tx))),
    transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(tx => work(wrap(tx)), check),
  };
  return { client, statements, rowsRead: () => statements.reduce((sum, one) => sum + one.rows, 0) };
}

/** A `DatabaseClient` authenticated as one production role, for the store the
 * fixture uses to write authentic rows. Built on a single client rather than a
 * pool: the seeding path is one writer on one transaction. */
function roleClient(postgres: { connection(role: string): { host: string; port: number; database: string; user: string; password: string } },
  role: string): DatabaseClient & { close(): Promise<void> } {
  const login = postgres.connection(role);
  const client = new Client(login);
  let opened: Promise<void> | undefined;
  const ready = () => opened ??= (async () => { await client.connect(); })();
  const query = async <T>(sql: string, params?: unknown[]) => {
    await ready();
    const result = await client.query(sql, params as never[]);
    return { rows: result.rows as T[] };
  };
  const session: DatabaseSession = { query };
  return { query, transaction: work => work(session),
    transactionWithPreCommitCheck: async (work, check) => { const value = await work(session); await check(); return value; },
    // The kit tears the cluster down in its `finally`. A client still open at
    // that moment is terminated by the postmaster and the resulting 57P01 masks
    // whatever the body actually asserted, so this is closed by the caller.
    close: async () => { if (opened) { await client.end().catch(() => {}); opened = undefined; } } };
}
/** The login that writes harness runs and their events in the Mac-local
 * installation: `db/roles/local_result_publisher_roles.sql` grants it INSERT on
 * `control_harness_runs`/`control_harness_run_events` and exactly the UPDATE
 * columns `HarnessRunStoreV1.create`/`append` write. So the store-signed runs
 * below are created under real production grants, not a superuser's. */
const publisherClient = (postgres: Parameters<typeof roleClient>[0]) => roleClient(postgres, "publisher");

/** A session row has to exist for the authority read to accept the identity, so
 * the harness runs the page through the real `WebTaskService` rather than a
 * hand-passed actor. */
const identity: VerifiedWebIdentity = { provider: PROVIDER, subject: SUBJECT, tokenDigest,
  issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, verificationExpiresAt: EXPIRES_AT };

test("the task-detail usage read stays bounded and exact across 5,000 runs of a real job", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    // Fixture seeding is superuser work — it CREATEs roles' rows that the web
    // login has no INSERT for. Only production code runs as the real role.
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScope(admin);
      const publisher = publisherClient(postgres);
      try {
        await seedRuns(new HarnessRunStoreV1(publisher, INTEGRITY_KEY), admin, RUNS);
      } finally {
        await publisher.close();
      }
      const present = await admin.query<{ runs: string }>(
        "SELECT count(*)::text AS runs FROM control_harness_runs WHERE tenant_id=$1 AND project_id=$2",
      [ids.tenant, ids.project]);
      assert.equal(Number(present.rows[0]!.runs), RUNS, "the fixture must actually hold 5,000 runs");
    } finally { await admin.end(); }

    // ---- the production read, as the production login ----
    const login = postgres.connection("web");
    // The production driver and bounded-database wrapper over a real `pg.Pool`,
    // pointed at the kit's socket. `privatePgOptions` is not used because it
    // validates the host against the installed-deployment allowlist, and this
    // cluster is socket-only by construction — the transport differs, the driver,
    // the session qualification and the role do not.
    const pool = new Pool({ ...login, max: 4, application_name: "control-room-private-web",
      // The exact session parameters production's `privatePgOptions` sets, because
      // `qualifyPrivatePgSession` CHECKS them: a client that skipped them would be
      // refused, and loosening the check for a test would be testing something
      // else. Only `host` differs — the kit cluster is socket-only.
      options: "-c search_path=pg_catalog,\\ public -c timezone=UTC -c transaction_timeout=10000",
      statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 5000 });
    const web = bindPrivatePgPool(pool);
    try {
      // The read must be reachable by THIS role: the aggregate's new
      // `payload->` and `snapshot->usage->` paths add no column the role files
      // do not already grant, and this proves it rather than assuming it.
      const direct = new Client(login);
      await direct.connect();
      try {
        const roles = await direct.query<{ current_user: string; rolsuper: boolean }>(
          "SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user");
        assert.equal(roles.rows[0]!.current_user, "control_room_web");
        assert.equal(roles.rows[0]!.rolsuper, false, "the read must not run as a superuser");
      } finally { await direct.end(); }

      const watched = traced(web.client);
      const service = new WebTaskService(watched.client, SCOPE, () => Date.now(),
        { harnessIntegrityKey: INTEGRITY_KEY, usagePriceTable: priceTable });

      const detail = await service.detail(identity, ids.project, ids.job).catch((error: unknown) => {
        const carried = error as { cause?: { message?: string }; message?: string; statement?: string };
        // Unwrap the driver's opaque mapping so a query bug reports itself as one.
        const root = carried.cause ?? error as { message?: string };
        assert.fail(`task detail read failed: ${String(root?.message ?? carried.message)}`
          + `${carried.statement === undefined ? "" : `\nstatement: ${carried.statement.slice(0, 400)}`}`);
      });

      // ---- (1) BOUNDED ----
      // The page displays at most 10 attempts' worth of runs (11 read per attempt)
      // and at most a handful of aggregate groups, so the rows crossing into the
      // application are a small constant. With an unbounded read this is ~5,000.
      const rows = watched.rowsRead();
      assert.ok(rows <= 200,
        `task detail read ${rows} rows from the database for ${RUNS} runs in scope; the read is unbounded again`);
      t.diagnostic(`rows read by one task-detail read with ${RUNS} runs in scope: ${rows}`);

      // The page-level display bounds still hold, and they are what the row
      // budget is derived from rather than a coincidence.
      assert.equal(detail.attempts.length, 1);
      assert.equal(detail.attempts[0]!.runs.length, 10, "the page still shows exactly its ten-run bound");
      assert.equal(detail.attempts[0]!.additionalRunsOmitted, true,
        "with 5,000 runs the page must say it is showing a subset");

      // ---- (2) EXACT ----
      // Computed from the seeded data, independently of the code under test.
      assert.equal(detail.usageRollup.runs, RUNS, "the rollup must count every run in scope, not the bounded subset");
      assert.equal(detail.usageRollup.inputTokens, RUNS * perRun.inputTokens);
      assert.equal(detail.usageRollup.outputTokens, RUNS * perRun.outputTokens);
      assert.equal(detail.usageRollup.totalTokens, RUNS * perRun.totalTokens);
      assert.equal(detail.usageRollup.wallTimeMs, RUNS * perRun.wallTimeMs);
      // No cached tokens on this fixture's runs, so cached nets 0 and the price
      // is purely input and output: RUNS × (100×1250 + 20×10000).
      assert.equal(detail.usageRollup.knownCostNanoUsd,
        (BigInt(RUNS) * (BigInt(perRun.inputTokens) * BigInt(1250) + BigInt(perRun.outputTokens) * BigInt(10000))).toString());
      assert.equal(detail.usageRollup.knownCostRuns, RUNS);
      assert.equal(detail.usageRollup.unknownCostRuns, 0);
      // The per-attempt rollup is exact over the same set, from the same read.
      assert.equal(detail.attempts[0]!.usageRollup.runs, RUNS);
      assert.equal(detail.attempts[0]!.usageRollup.inputTokens, RUNS * perRun.inputTokens);
      assert.equal(detail.attempts[0]!.usageRollup.knownCostNanoUsd, detail.usageRollup.knownCostNanoUsd);

      // The displayed runs are the ten genuinely store-signed ones: the bounded
      // reader must still authenticate every row the page shows.
      assert.equal(detail.attempts[0]!.runs[0]!.usage?.inputTokens, perRun.inputTokens);
      assert.equal(detail.attempts[0]!.runs[0]!.cost.kind, "known");
      assert.equal(detail.attempts[0]!.runs[0]!.cost.nanoUsd,
        (BigInt(perRun.inputTokens) * BigInt(1250) + BigInt(perRun.outputTokens) * BigInt(10000)).toString());

      // ---- the project overview, the other read this fix touches ----
      const overviewWatch = traced(web.client);
      const overview = await new WebTaskService(overviewWatch.client,
        SCOPE, () => Date.now(), { harnessIntegrityKey: INTEGRITY_KEY, usagePriceTable: priceTable })
        .projectOverview(identity, ids.project);
      assert.ok(overviewWatch.rowsRead() <= 200,
        `project overview read ${overviewWatch.rowsRead()} rows for ${RUNS} runs in scope`);
      assert.equal(overview.usageRollup.runs, RUNS);
      assert.equal(overview.usageRollup.inputTokens, RUNS * perRun.inputTokens);
      assert.equal(overview.usageRollup.knownCostNanoUsd, detail.usageRollup.knownCostNanoUsd);
    } finally { await web.close(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 240_000 });
});

/**
 * The grouping key, tested against the failure it exists to prevent.
 *
 * Two runs in one scope that are identical except for CACHE TOKENS must not
 * collapse into one group: one has a recorded cache price and the other does not,
 * so the priced one is `known` and the unpriced one is
 * `cache_pricing_not_recorded`. Without `cached_input_tokens > 0` in the GROUP BY
 * they share a group, and the group is priced by whichever run happened to
 * represent it — so an unpriced cache read is billed at a discount nobody
 * recorded, which is the exact thing `docs/integration/usage-cost.md` forbids.
 *
 * The same shape carries the Codex contradiction: cached tokens are a SUBSET of
 * input, so `cached > input` is impossible, and one such run in a group turns the
 * whole group into `partial_token_usage` rather than a confident figure.
 */
test("the usage aggregate never merges two runs that price differently", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScope(admin);
      const createdAt = new Date(Date.now() - 100_000).toISOString();
      const finishedAt = new Date(Date.now() - 90_000).toISOString();
      const digest = `sha256:${"b".repeat(64)}`, tag = `hmac-sha256:${"c".repeat(64)}`;
      // `priced` is on the cache-priced model, `unpriced` on the model whose entry
      // deliberately records no cache rate (see the price table below).
      // `priced` and `nocache` share a MODEL and differ only in whether any cache
      // tokens were reported — that pair is what `cached_input_tokens > 0` in the
      // GROUP BY exists to separate. `unpriced` differs in price, `contradiction`
      // in whether the billable input count is negative.
      const shapes = [
        { suffix: "priced", model: MODEL, input: 1000, output: 500, total: 1500, cached: 900, wall: 10 },
        { suffix: "nocache", model: MODEL, input: 1000, output: 500, total: 1500, cached: 0, wall: 10 },
        { suffix: "unpriced", model: UNCACHED_MODEL, input: 1000, output: 500, total: 1500, cached: 900, wall: 10 },
        { suffix: "contradiction", model: MODEL, input: 100, output: 20, total: 120, cached: 900, wall: 10 },
      ];
      await admin.query(`INSERT INTO control_harness_runs
        (id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,
         state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
        SELECT 'run:bounded-usage-shape:'||s.suffix,$1::text,$2::text,$3::text,$4::text,$5::text,$6::text,'codex',
          'sha256:'||md5(s.suffix)||md5(('shape'||s.suffix)::text),'succeeded',4,$7::text,$8::text,
          jsonb_build_object('schemaVersion','control-room-harness/v1','id','run:bounded-usage-shape:'||s.suffix,
            'tenantId',$1::text,'projectId',$2::text,'jobId',$3::text,'attemptId',$4::text,'nodeId',$5::text,
            'adapterId',$6::text,'adapterVersion','1.0.0','harness','codex','harnessVersion','codex-shape-1',
            'nativeSessionKeyDigest','sha256:'||md5(s.suffix)||md5(('shape'||s.suffix)::text),
            'modelSelection',jsonb_build_object('model',s.model,'effort','medium'),'state','succeeded',
            'resumable',false,'cancelState','not_requested','createdAt',$9::text,'startedAt',$9::text,
            'updatedAt',$10::text,'finishedAt',$10::text,'lastObservedAt',$10::text),
          $9::timestamptz,$10::timestamptz,$10::timestamptz
        FROM unnest($11::text[],$12::text[],$13::int[],$14::int[],$15::int[],$16::int[],$17::int[])
          AS s(suffix,model,input,output,total,cached,wall)`,
      [ids.tenant, ids.project, ids.job, ids.attempt, ids.node, ids.adapter, digest, tag, createdAt, finishedAt,
        shapes.map(s => s.suffix), shapes.map(s => s.model), shapes.map(s => s.input), shapes.map(s => s.output),
        shapes.map(s => s.total), shapes.map(s => s.cached), shapes.map(s => s.wall)]);
      await admin.query(`INSERT INTO control_harness_run_events
        (tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,event_auth_tag,payload,recorded_at)
        SELECT $1::text,'run:bounded-usage-shape:'||s.suffix,4,$2::timestamptz,'adapter',$3::text,$3::text,$4::text,
          jsonb_build_object('schemaVersion','control-room-harness-event/v1','tenantId',$1::text,
            'runId','run:bounded-usage-shape:'||s.suffix,'sequence',4,'occurredAt',$2::text,'source','adapter',
            'sourceEventKeyDigest',$3::text,
            'payload',jsonb_build_object('category','usage','inputTokens',s.input,'outputTokens',s.output,
              'totalTokens',s.total,'cachedInputTokens',s.cached,'reasoningTokens',null,'wallTimeMs',s.wall)),
          $2::timestamptz
        FROM unnest($5::text[],$6::int[],$7::int[],$8::int[],$9::int[],$10::int[])
          AS s(suffix,input,output,total,cached,wall)`,
      [ids.tenant, finishedAt, digest, tag, shapes.map(s => s.suffix), shapes.map(s => s.input),
        shapes.map(s => s.output), shapes.map(s => s.total), shapes.map(s => s.cached), shapes.map(s => s.wall)]);

      const login = postgres.connection("web");
      const web = bindPrivatePgPool(new Pool({ ...login, max: 4, application_name: "control-room-private-web",
        options: "-c search_path=pg_catalog,\\ public -c timezone=UTC -c transaction_timeout=10000",
        statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 5000 }));
      try {
        const groups = await new HarnessRunStoreV1(web.client, INTEGRITY_KEY)
          .inspectUsageRollup(ids.tenant, ids.project, ids.job);
        // Three runs, three pricing branches: they must be three GROUPS, not one.
        assert.equal(groups.length, 4,
          `four differently-priced runs collapsed into ${groups.length} group(s): ${JSON.stringify(groups)}`);
        const rollup = rollupUsageGroupsV1(groups, priceTable);
        // `rollupUsageGroupsV1` already returns the reasons sorted.
        assert.deepEqual(rollup.unknownCostReasons,
          ["cache_pricing_not_recorded", "partial_token_usage"],
          "each run's own refusal must survive the aggregate; none may borrow another's");
        assert.equal(rollup.knownCostRuns, 2,
          "only runs whose branch prices as known may produce a figure");
        // `priced`: 100 billable input x 1250 + 500 output x 10000 + 900 cached x 125.
        // `nocache`: 1000 input x 1250 + 500 output x 10000, no cache rate involved.
        assert.equal(rollup.knownCostNanoUsd,
          (BigInt(100) * BigInt(1250) + BigInt(500) * BigInt(10000) + BigInt(900) * BigInt(125)
            + BigInt(1000) * BigInt(1250) + BigInt(500) * BigInt(10000)).toString());
        // The displayed token sums still cover all four runs, refusals and all.
        assert.equal(rollup.runs, 4);
        // The REPORTED input counts (2100), not the billable ones. Codex's cached
        // tokens are a SUBSET of its input, so the page has always shown what the
        // run reported; only the COST nets them off. Presenting the net figure
        // would silently understate the tokens a run consumed.
        assert.equal(rollup.inputTokens, 1000 + 1000 + 1000 + 100,
          "the rollup must display reported input tokens, not the Codex-netted billable count");
        assert.equal(rollup.outputTokens, 500 + 500 + 500 + 20);
        assert.equal(rollup.totalTokens, 1500 + 1500 + 1500 + 120);
      } finally { await web.close(); }
    } finally { await admin.end(); }
  }, { port: PORT + 1, allowedPorts: PORTS, boundMs: 240_000 });
});

test("the bounded-usage real-PostgreSQL proof ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(required, 0, "a lane without PostgreSQL registers nothing to run"); return; }
  assert.ok(required > 0, "at least one real-cluster test is registered");
  assert.equal(ran, required, "a required-but-skipped cluster test must fail the run");
});
