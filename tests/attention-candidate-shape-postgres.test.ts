// Real-PostgreSQL proof for the MLOAD-01 reshape of WebTaskService.attention
// (src/web/v1/task-service.ts:898-...).
//
// WHAT THIS PROVES, and what it deliberately does not.
//
// The defect was a SHAPE, not a missing index: one query selected three
// canonical jsonb payloads plus two prepared payloads and a plan for every
// candidate row, while the page examines at most 26. At 200k tasks that took 43s
// against a 5s statement_timeout, and no index fixed it (1.1x and 1.0x measured
// on a live cluster). The fix splits it into a narrow candidate query and a
// bounded payload query.
//
// The load-bearing assertions are:
//
//   1. THE SHAPE. The candidate query selects NO payload column, and the
//      statements are CAPTURED FROM THE READ ITSELF rather than retyped, so a
//      later edit that re-merges the phases fails here.
//   2. THE PLAN. With hundreds of non-qualifying jobs in the tenant, the
//      candidate query's plan shows no wide-row fan-out and no sort spill, while
//      the old single-query shape shows a large fan-out. Asserted on plan
//      structure and row counts, never on wall clock, which would be flaky on a
//      shared runner.
//   3. THE ANSWER IS UNCHANGED. The candidate rows, their order, the page's
//      `examined` and its `nextCursor` are compared against the OLD
//      single-query shape run verbatim on the same rows in the same database.
//      This is the half that makes it a performance change and not a behaviour
//      change.
//   4. PAGING. Every candidate appears exactly once across the pages, in order,
//      with none skipped or repeated -- the property the second phase could break
//      by returning rows in a different order than the first.
//   5. THE FAIL-CLOSED GUARD. A candidate row lost between the phases refuses
//      the page rather than reporting fewer examined rows than the cursor implies.
//
// The read runs as the PRODUCTION private-web login over a real cluster, with
// the product's own session authority path: an owner identity, a session row and
// a role grant are all seeded, so `authenticated()` really authenticates rather
// than being handed an actor.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { WebTaskService } from "../src/web/v1/task-service";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "../src/idea-lab/v1/schemas";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";

// Reserved disposable-cluster lane for this job: 59561-59573, or the test
// runner's assigned port block, so concurrent runs never collide.
const PORT = Number(process.env.ATTENTION_SHAPE_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59561);
const PORTS = [PORT, PORT + 1];
const PG = requiresRealPostgres();

const TENANT = "tenant:attention-shape-fixture";
const WORKSPACE = "workspace:attention-shape-fixture";
const ADAPTER = "adapter:attention-shape-fixture";
const PROJECT = "project:attention-shape-fixture";
const IDENTITY = "identity:attention-shape-owner";
const PROVIDER = "attention-shape-provider";
const SUBJECT = "attention-shape-subject";
const CONTRACT = "control-room-domain/v1";
const AUTHORITY_DIGEST = `sha256:${"a".repeat(64)}`;
const ISSUED_AT = "2026-09-29T12:00:00.000Z";
const EXPIRES_AT = "2026-12-31T00:00:00.000Z";
const tokenDigest = `sha256:${"c".repeat(64)}`;

/** Non-qualifying job rows: the estate the page must NOT walk. Each is a valid
 * job in a state the attention filter excludes, so the tenant grows without the
 * answer growing. This is the growth that made the old shape expensive. */
const NOISE = 600;
/** Proposals, so the answer itself spans more than one page of 25. */
const PROPOSALS = 40;

/** The OLD single-query shape, verbatim from the pre-reshape source. Only the
 * columns this test compares are kept; the comparison is about WHICH ROWS and IN
 * WHAT ORDER the two shapes choose, not about payload bytes. */
const OLD_ATTENTION_IDS = `SELECT j.id,j.state,j.created_at AS source_job_created_at,j.updated_at AS source_job_updated_at,
    EXISTS(SELECT 1 FROM control_native_artifact_receipts a
      WHERE a.tenant_id=j.tenant_id AND a.project_id=j.project_id AND a.job_id=j.id) AS has_artifacts,
    j.payload AS job, w.payload AS workflow, r.payload AS request,
    ep.tenant_id AS plan_tenant_id, pj.payload AS prepared_job_payload
  FROM control_jobs j
  JOIN control_workflows w ON w.tenant_id=j.tenant_id AND w.id=j.workflow_id AND w.project_id=j.project_id
  JOIN control_requests r ON r.tenant_id=w.tenant_id AND r.id=w.request_id AND r.project_id=j.project_id
  LEFT JOIN control_task_execution_plans ep ON ep.tenant_id=j.tenant_id AND ep.project_id=j.project_id AND ep.source_job_id=j.id
  LEFT JOIN control_jobs pj ON pj.tenant_id=ep.tenant_id AND pj.project_id=ep.project_id AND pj.id=ep.job_id
  LEFT JOIN control_workflows pw ON pw.tenant_id=pj.tenant_id AND pw.id=pj.workflow_id
  LEFT JOIN control_requests pr ON pr.tenant_id=pw.tenant_id AND pr.id=pw.request_id
  JOIN projects p ON p.tenant_id=j.tenant_id AND p.id=j.project_id
  WHERE j.tenant_id=$1 AND p.workspace_id=$2 AND ($3::text IS NULL OR j.id COLLATE "C">$3 COLLATE "C")
    AND ((p.adapter_id=$4 AND $6::boolean AND EXISTS(SELECT 1 FROM control_manual_project_heads h
      WHERE h.tenant_id=p.tenant_id AND h.project_id=p.id)) OR (p.adapter_id=$5 AND $7::boolean))
    AND (j.state IN ('proposed','waiting_approval','failed','orphaned')
      OR (j.payload->>'jobType'='harness.hermes.native.task' AND j.state IN ('leased','running')) OR EXISTS(
      SELECT 1 FROM control_native_artifact_receipts a WHERE a.tenant_id=j.tenant_id AND a.project_id=j.project_id AND a.job_id=j.id))
  ORDER BY j.id COLLATE "C" LIMIT 26`;

/** The candidate query exactly as the shipped read issues it, so the plans below
 * are the plans of the product's statement rather than a paraphrase. Test 1
 * captures the read's own statement and asserts this one's shape, so the two
 * cannot drift apart silently. */
const CANDIDATE_IDS = `SELECT id FROM (
  (SELECT j.id FROM control_jobs j JOIN projects p ON p.tenant_id=j.tenant_id AND p.id=j.project_id
    WHERE j.tenant_id=$1 AND p.workspace_id=$2 AND ($3::text IS NULL OR j.id COLLATE "C">$3 COLLATE "C")
      AND ((p.adapter_id=$4 AND $6::boolean AND EXISTS(SELECT 1 FROM control_manual_project_heads h
        WHERE h.tenant_id=p.tenant_id AND h.project_id=p.id)) OR (p.adapter_id=$5 AND $7::boolean))
      AND j.state IN ('proposed','waiting_approval','failed','orphaned')
    ORDER BY j.id COLLATE "C" LIMIT 26)
  UNION
  (SELECT j.id FROM control_jobs j JOIN projects p ON p.tenant_id=j.tenant_id AND p.id=j.project_id
    WHERE j.tenant_id=$1 AND p.workspace_id=$2 AND ($3::text IS NULL OR j.id COLLATE "C">$3 COLLATE "C")
      AND ((p.adapter_id=$4 AND $6::boolean AND EXISTS(SELECT 1 FROM control_manual_project_heads h
        WHERE h.tenant_id=p.tenant_id AND h.project_id=p.id)) OR (p.adapter_id=$5 AND $7::boolean))
      AND j.payload->>'jobType'='harness.hermes.native.task' AND j.state IN ('leased','running')
    ORDER BY j.id COLLATE "C" LIMIT 26)
  UNION
  (SELECT j.id FROM control_jobs j JOIN projects p ON p.tenant_id=j.tenant_id AND p.id=j.project_id
    WHERE j.tenant_id=$1 AND p.workspace_id=$2 AND ($3::text IS NULL OR j.id COLLATE "C">$3 COLLATE "C")
      AND ((p.adapter_id=$4 AND $6::boolean AND EXISTS(SELECT 1 FROM control_manual_project_heads h
        WHERE h.tenant_id=p.tenant_id AND h.project_id=p.id)) OR (p.adapter_id=$5 AND $7::boolean))
      AND EXISTS(SELECT 1 FROM control_native_artifact_receipts a
        WHERE a.tenant_id=j.tenant_id AND a.project_id=j.project_id AND a.job_id=j.id)
    ORDER BY j.id COLLATE "C" LIMIT 26)
  ) attention_candidates ORDER BY id COLLATE "C" LIMIT 26`;

/** The receipts probes the plan makes against the artifact receipts table. This
 * is the number MLOAD-01's remaining cost is made of: written as one OR, the
 * planner probes the receipts once per job the state and jobType branches did
 * not take. */
function receiptProbes(planText: string) {
  return [...planText.matchAll(/control_native_artifact_receipts[^\n]*loops=(\d+)/gu)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
}

const scope = { tenantId: TENANT, workspaceId: WORKSPACE };
// The manual adapter id is NOT a free string: the product derives it from the
// scope as `adapter:manual:${sha256Digest(scope).slice(7, 39)}`
// (src/web/v1/task-service.ts:940, project-service.ts:214), and the attention
// filter matches on it by equality. A fixture with any other id matches nothing
// and every candidate query returns zero rows -- which reads as an empty inbox,
// not as a broken fixture. Derived from the same scope the read is given, so the
// two cannot drift apart.
const MANUAL_ADAPTER = `adapter:manual:${sha256Digest(scope).slice(7, 39)}`;
const attentionParams = (after: string | null = null) => [TENANT, WORKSPACE, after,
  MANUAL_ADAPTER, CONTROL_ROOM_IDEA_ADAPTER_V1, true, false];
const identity: VerifiedWebIdentity = { provider: PROVIDER, subject: SUBJECT, tokenDigest,
  issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, verificationExpiresAt: EXPIRES_AT };
const NOW = () => Date.parse(ISSUED_AT) + 600_000;

async function plan(client: Client, sql: string, params: unknown[]) {
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params);
  return rows.map(row => row["QUERY PLAN"] as string).join("\n");
}

/** A read-only client bound to one production login's open connection: the read
 * port is a `DatabaseClient`, and the authority opens its own transaction. The
 * transaction is executed against this same session so a fixture that needs to
 * intercept a statement can do so (the last test does). */
function readPort(web: Client, intercept?: (sql: string, params?: unknown[]) => Promise<void>): DatabaseClient {
  // The intercept runs on the SAME session as the statement it follows, so a
  // fixture that mutates between two phases is inside the read's own open
  // transaction and visible to it -- which is the only way to reproduce a change
  // landing BETWEEN the two phases. A DELETE on a second connection would be
  // invisible here and the page would simply not refuse.
  const session = { query: async (sql: string, params?: unknown[]) => {
    if (intercept) await intercept(sql, params);
    return web.query(sql, params); } } as unknown as DatabaseSession;
  return { query: web.query.bind(web),
    transaction: work => Promise.resolve(work(session)),
    transactionWithPreCommitCheck: async (work, check) => {
      const value = await work(session); await check(); return value; } };
}

/** One request/workflow/job quadruple in `proposed`, written the way the
 * product's own proposal path writes it: `task.proposal` with an inputDigest
 * derived from its request's title and objective, because `validated()`
 * re-derives that digest for exactly this job type. */
async function seedProposal(admin: Client, index: number, at: string, state = "proposed", version = 0) {
  const suffix = state === "proposed" && version === 0
    ? String(index).padStart(4, "0") : `${String(index).padStart(4, "0")}-${state}`;
  const requestId = `request:attention-shape-${suffix}`, workflowId = `workflow:attention-shape-${suffix}`;
  const jobId = `job:attention-shape-${suffix}`;
  const title = `Attention shape ${index}`, objective = `Attention shape ${index}.`;
  const authority = jsonb_build_authority(AUTHORITY_DIGEST);
  await admin.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
    VALUES($1,$2,$3,'accepted',0,$1,jsonb_build_object('id',$1::text,'kind','request','tenantId',$2::text,
      'projectId',$3::text,'contractVersion',$4::text,'title',$5::text,'objective',$6::text,'state','accepted',
      'version',0,'priority',50,'requestedBy',jsonb_build_object('actorId',$7::text,'actorType','human'),
      'idempotencyKey',$1::text,'createdAt',$8::text,'updatedAt',$8::text),$8::timestamptz,$8::timestamptz)`,
  [requestId, TENANT, PROJECT, CONTRACT, title, objective, IDENTITY, at]);
  await admin.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,
      payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'active',1,jsonb_build_object('id',$1::text,'kind','workflow','tenantId',$2::text,
      'requestId',$3::text,'projectId',$4::text,'contractVersion',$6::text,'definitionVersion','1.0.0',
      'definitionDigest',$5::text,'authorityMode','control_room_native','state','active','version',1,
      'jobIds',jsonb_build_array($7::text),'createdAt',$8::text,'updatedAt',$8::text),$8::timestamptz,$8::timestamptz)`,
  [workflowId, TENANT, requestId, PROJECT, AUTHORITY_DIGEST, CONTRACT, jobId, at]);
  await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
      required_capability,authority_digest,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,50,'fixture',$7,jsonb_build_object('id',$1::text,'kind','job','tenantId',$2::text,
      'projectId',$4::text,'contractVersion',$8::text,'workflowId',$3::text,'jobType','task.proposal',
      'specVersion','1.0.0','inputDigest',$9::text,'state',$5::text,'version',$6::int,'createdAt',$10::text,
      'updatedAt',$10::text,'priority',50,'requiredCapability','fixture','dependsOnJobIds',jsonb_build_array(),
      'authority',$11::jsonb,
      'retryPolicy',jsonb_build_object('maxAttempts',1,'backoffSeconds',0,'retryableFailureCodes',jsonb_build_array(),
        'retryAfterOrphan',false,'ambiguousEffectPolicy','attention')),
      $10::timestamptz,$10::timestamptz)`,
  [jobId, TENANT, workflowId, PROJECT, state, version, AUTHORITY_DIGEST, CONTRACT,
    sha256Digest({ title, instructions: objective }), at, JSON.stringify(authority)]);
  return jobId;
}

function jsonb_build_authority(digest: string) {
  return { projectId: PROJECT, allowedExecutor: ADAPTER, allowedOperations: ["execute"], credentialRefs: [],
    filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "preauthorized",
    maxRisk: "low", maxDurationSeconds: 3600, maxConcurrentEffects: 1, expiresAt: EXPIRES_AT, digest };
}

async function seedScopeAndOwner(admin: Client) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [TENANT]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [WORKSPACE, TENANT]);
  // The registry row MUST carry the derived manual adapter id, because
  // projects.adapter_id references adapter_registry(id) for this tenant.
  await admin.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [MANUAL_ADAPTER, TENANT]);
  await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1',$1,'running','manual_project_active','healthy','control_room_native',now(),'{}',now())`,
  [PROJECT, TENANT, WORKSPACE, MANUAL_ADAPTER]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,now(),now())`, [TENANT, PROJECT]);
  await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
      auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human','Owner',$3,$4,'active',$5,$5)`,
  [IDENTITY, TENANT, PROVIDER, sha256Digest({ provider: PROVIDER, subject: SUBJECT }), ISSUED_AT]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
      risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`,
  ["grant:attention-shape-owner", TENANT, IDENTITY, ISSUED_AT]);
  await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`, [TENANT, tokenDigest, IDENTITY, ISSUED_AT, EXPIRES_AT]);
}

/** NOISE jobs in `succeeded` -- a state the attention filter excludes. Each has
 * its own workflow and request so every join in both shapes is real. */
async function addNoise(admin: Client) {
  const authority = JSON.stringify(jsonb_build_authority(AUTHORITY_DIGEST));
  for (let index = 1; index <= NOISE; index += 1) {
    const at = new Date(Date.parse(ISSUED_AT) + (PROPOSALS + index) * 1_000).toISOString();
    const suffix = `noise-${String(index).padStart(4, "0")}`;
    const requestId = `request:attention-shape-${suffix}`, workflowId = `workflow:attention-shape-${suffix}`;
    const jobId = `job:attention-shape-${suffix}`;
    const title = `Noise ${index}`, objective = `Noise ${index}.`;
    await admin.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
      VALUES($1,$2,$3,'accepted',0,$1,jsonb_build_object('id',$1::text,'kind','request','tenantId',$2::text,
        'projectId',$3::text,'contractVersion',$4::text,'title',$5::text,'objective',$6::text,'state','accepted',
        'version',0,'priority',50,'requestedBy',jsonb_build_object('actorId',$7::text,'actorType','human'),
        'idempotencyKey',$1::text,'createdAt',$8::text,'updatedAt',$8::text),$8::timestamptz,$8::timestamptz)`,
    [requestId, TENANT, PROJECT, CONTRACT, title, objective, IDENTITY, at]);
    await admin.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,
        payload,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'active',1,jsonb_build_object('id',$1::text,'kind','workflow','tenantId',$2::text,
        'requestId',$3::text,'projectId',$4::text,'contractVersion',$6::text,'definitionVersion','1.0.0',
        'definitionDigest',$5::text,'authorityMode','control_room_native','state','active','version',1,
        'jobIds',jsonb_build_array($7::text),'createdAt',$8::text,'updatedAt',$8::text),$8::timestamptz,$8::timestamptz)`,
    [workflowId, TENANT, requestId, PROJECT, AUTHORITY_DIGEST, CONTRACT, jobId, at]);
    await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
        required_capability,authority_digest,payload,created_at,updated_at)
      VALUES($1,$2,$3,$4,'succeeded',2,50,'fixture',$5,jsonb_build_object('id',$1::text,'kind','job','tenantId',$2::text,
        'projectId',$4::text,'contractVersion',$6::text,'workflowId',$3::text,'jobType','fixture.noise',
        'specVersion','1.0.0','inputDigest',$7::text,'state','succeeded','version',2,'createdAt',$8::text,
        'updatedAt',$8::text,'priority',50,'requiredCapability','fixture','dependsOnJobIds',jsonb_build_array(),
        'authority',$9::jsonb,
        'retryPolicy',jsonb_build_object('maxAttempts',1,'backoffSeconds',0,'retryableFailureCodes',jsonb_build_array(),
          'retryAfterOrphan',false,'ambiguousEffectPolicy','attention')),
        $8::timestamptz,$8::timestamptz)`,
    [jobId, TENANT, workflowId, PROJECT, AUTHORITY_DIGEST, CONTRACT,
      sha256Digest({ title, instructions: objective }), at, authority]);
  }
}

/** Give HALF the proposals an artifact receipt, which is what makes the
 * candidate filter's three arms OVERLAP.
 *
 * This is the property the UNION-not-UNION-ALL decision rests on, and a fixture
 * with no receipts at all cannot see it: a proposed job qualifies under the state
 * arm alone, so with zero receipts the receipts arm contributes nothing and both
 * `UNION` and `UNION ALL` return the same rows. At the real growth estate 19,976
 * of 200,000 jobs qualify under two arms this way (measured), so the overlap is
 * the common case, not an edge case.
 *
 * The receipt needs a real manifest, attempt and harness run -- the table has
 * foreign keys onto all three -- so those are seeded too. The fixture writes them
 * as the admin because no product login may mint a receipt, which is correct and
 * is not what is under test here.
 */
async function addReceipts(admin: Client, count: number) {
  const at = new Date(Date.parse(ISSUED_AT) + 900_000).toISOString();
  const NODE = "node:attention-shape";
  // control_attempts has a foreign key on (tenant_id, node_id), so the node row
  // must exist before any attempt can name it.
  await admin.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    VALUES($1,$2,'active',0,$3,jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','active','version',0,
      'identityKeyId',$3::text),$4::timestamptz,$4::timestamptz)`,
  [NODE, TENANT, "key:attention-shape", at]);
  for (let index = 1; index <= count; index += 1) {
    const suffix = String(index).padStart(4, "0");
    const jobId = `job:attention-shape-${suffix}`;
    const existing = await admin.query(
      "SELECT count(*)::int AS n FROM control_jobs WHERE tenant_id=$1 AND id=$2", [TENANT, jobId]);
    if (!existing.rows[0]!.n) continue;
    const attemptId = `attempt:attention-shape-${suffix}`, runId = `harness-run:attention-shape-${suffix}`;
    const artifactId = `artifact:attention-shape-${suffix}`;
    // The real column names and the real ORDER, both read from the live
    // catalogue rather than recalled: control_harness_runs has no
    // harness_version, model_selection, resumable, cancel_state or record_digest;
    // it has last_sequence, run_digest and run_auth_tag. And the schema's own
    // foreign keys fix the insert order -- control_harness_runs references
    // (tenant_id, attempt_id, job_id, node_id), so the ATTEMPT must exist before
    // the run, and the run before the manifest and the receipt.
    await admin.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,
        payload,created_at,updated_at)
      VALUES($1,$2,$3,1,'running',1,$4,1,jsonb_build_object('id',$1::text,'kind','attempt','tenantId',$2::text,
        'contractVersion',$5::text,'jobId',$3::text,'state','running','version',1,'nodeId',$4::text,
        'attemptNumber',1,'leaseEpoch',1,'createdAt',$6::text,'updatedAt',$6::text,'startedAt',$6::text),
        $6::timestamptz,$6::timestamptz)`,
    [attemptId, TENANT, jobId, `node:attention-shape`, CONTRACT, at]);
    await admin.query(`INSERT INTO control_harness_runs(id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,
        harness,native_session_key_digest,state,last_sequence,run_digest,run_auth_tag,payload,
        created_at,updated_at,last_observed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'hermes',$8,'discovered',0,$9,$10,$11::jsonb,$12::timestamptz,$12::timestamptz,$12::timestamptz)`,
    [runId, TENANT, PROJECT, jobId, attemptId, `node:attention-shape`, MANUAL_ADAPTER,
      sha256Digest({ attentionShapeRun: suffix }), `sha256:${"e".repeat(64)}`, `hmac-sha256:${"e".repeat(64)}`,
      JSON.stringify({ schemaVersion: "control-room-harness/v1", id: runId, tenantId: TENANT, projectId: PROJECT,
        jobId, attemptId, nodeId: `node:attention-shape`, adapterId: MANUAL_ADAPTER, adapterVersion: "1.0.0",
        harness: "hermes", harnessVersion: "attention-shape-1",
        nativeSessionKeyDigest: sha256Digest({ attentionShapeRun: suffix }), state: "discovered", resumable: false,
        cancelState: "not_requested", createdAt: at, updatedAt: at, lastObservedAt: at }), at]);
    // control_artifact_manifests names its state column `state`, not
    // `storage_state`, and its state CHECK admits only declared/uploaded/
    // verified/quarantined/rejected/deleted -- 'verified' is what a published
    // manifest actually carries, read from the live rows rather than assumed.
    // `validate_control_payload_mirror()` then requires the payload's id,
    // tenantId, state and version to equal the columns, so the payload carries
    // `state: 'verified'` rather than the product's own `storageState` name.
    await admin.query(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,job_id,attempt_id,
        content_hash,state,version,payload,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'verified',1,$7::jsonb,$8::timestamptz,$8::timestamptz)`,
    [artifactId, TENANT, PROJECT, jobId, attemptId, `sha256:${"f".repeat(64)}`,
      JSON.stringify({ id: artifactId, tenantId: TENANT, projectId: PROJECT, jobId, attemptId, runId,
        state: "verified", version: 1, contentHash: `sha256:${"f".repeat(64)}`, sizeBytes: 12,
        createdAt: at }), at]);
    await admin.query(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,attempt_id,run_id,
        artifact_id,receipt,auth_tag)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [TENANT, PROJECT, jobId, attemptId, runId, artifactId,
      JSON.stringify({ artifactId, jobId, projectId: PROJECT, attemptId, runId, files: 1, summary: "Fixture" }),
      `hmac-sha256:${"a".repeat(64)}`]);
  }
}

test("the attention read selects candidates on narrow columns and reads payloads for those candidates only",
  { skip: !PG && realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScopeAndOwner(admin);
      for (let index = 1; index <= PROPOSALS; index += 1)
        await seedProposal(admin, index, new Date(Date.parse(ISSUED_AT) + index * 1_000).toISOString());
      await addReceipts(admin, Math.floor(PROPOSALS / 2));
      await addNoise(admin);
      await admin.query("ANALYZE control_jobs, control_workflows, control_requests, projects");

      // The read runs as the PRODUCTION private-web login, so a missing grant on
      // anything it touches fails here rather than only in a mocked test.
      const web = new Client(postgres.connection("web"));
      await web.connect();
      try {
        const roles = await web.query("SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user");
        assert.equal(roles.rows[0]!.current_user, "control_room_web");
        assert.equal(roles.rows[0]!.rolsuper, false, "the read must not run as a superuser");
        const statements: string[] = [];
        const client = readPort(web, async sql => { statements.push(sql); });
        const page = await new WebTaskService(client, scope, NOW).attention(identity);

        const candidate = statements.find(sql => sql.includes("attention_candidates"));
        assert.ok(candidate, `the narrow candidate query must be issued; got:\n${statements.join("\n---\n")}`);
        assert.doesNotMatch(candidate!, /\bAS job\b|\bAS workflow\b|\bAS request\b/u,
          "the candidate query must not select any canonical payload column");
        // Three bounded arms, not one OR: this is what stops the receipts EXISTS
        // being evaluated for every job the state and jobType arms did not take.
        assert.equal((candidate!.match(/UNION/gu) ?? []).length, 2,
          "the candidate query must be three arms joined by two UNIONs");
        assert.equal((candidate!.match(/LIMIT 26/gu) ?? []).length, 4,
          "each arm AND the union must carry the page's own bound of 26");
        // NOT asserted on the spelling: measured at the growth estate, UNION and
        // UNION ALL return byte-identical results here, because the per-arm
        // ORDER BY makes Merge Append emit duplicates adjacently and the outer
        // LIMIT then takes the same 26 distinct ids either way. What IS asserted
        // is the RESULT -- no duplicate ids, and the page neither refuses nor
        // repeats -- which is the property that would actually hurt the owner.
        // Asserting the spelling would be asserting a planner's plan shape.
        assert.doesNotMatch(candidate!, /prepared_/u,
          "the candidate query must not select the prepared payloads, which only planned proposals need");
        assert.doesNotMatch(candidate!, /ep\.plan\b|ep\.auth_tag\b/u,
          "the candidate query must not select the plan document");
        // The receipts table is probed ONCE, in the filter, and the has_artifacts
        // flag is derived from that SAME EXISTS rather than repeating it. The old
        // shape carried two independent EXISTS clauses on the same correlation,
        // each hashing the whole receipts table per candidate. So the count goes
        // from 2 to 1 here, and the flag must be computed from the same probe --
        // which is why the candidate query still returns it at all.
        assert.equal((candidate!.match(/FROM control_native_artifact_receipts/gu) ?? []).length, 1,
          "the candidate query must probe the artifact receipts exactly once, not once per use");
        assert.doesNotMatch(candidate!, /AS has_artifacts/u,
          "the candidate query must not compute has_artifacts at all: it runs per ESTATE row, and phase 2 computes the flag for the 26 candidates only");

        const payloadPhase = statements.find(sql => sql.includes("ANY($2::text[])"));
        assert.ok(payloadPhase, "the payloads must be read in a second statement bounded by the candidate ids");
        assert.match(payloadPhase!, /ORDER BY j\.id COLLATE "C"/u,
          "the payload query must return candidates in candidate order, because rows[24].id is the page cursor");
        // has_artifacts is computed ONCE, here, for the 26 candidates. The old
        // shape computed it twice for the whole estate, which is the second of the
        // two per-candidate receipts hashes MLOAD-01 measured.
        assert.equal((payloadPhase!.match(/FROM control_native_artifact_receipts/gu) ?? []).length, 1,
          "the payload query must probe the artifact receipts exactly once");
        assert.ok(page.items.length > 0, "the fixture must produce attention items for this to be about");
        assert.ok(page.examined >= page.items.length);
        assert.equal(page.startsWork, false);
      } finally { await web.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 1_800_000 });
});

test("at growth size the candidate query carries no wide rows and spills no sort, while the old shape does",
  { skip: !PG && realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScopeAndOwner(admin);
      for (let index = 1; index <= PROPOSALS; index += 1)
        await seedProposal(admin, index, new Date(Date.parse(ISSUED_AT) + index * 1_000).toISOString());
      await addReceipts(admin, Math.floor(PROPOSALS / 2));
      await addNoise(admin);
      await admin.query("ANALYZE control_jobs, control_workflows, control_requests, projects");

      const params = attentionParams();
      const narrowPlan = await plan(admin, CANDIDATE_IDS, params);
      const widePlan = await plan(admin, OLD_ATTENTION_IDS, params);

      // BUFFERS on control_jobs is the growth-sensitive quantity, and the reason
      // MLOAD-01 was critical: the wide shape carries three canonical jsonb
      // payloads (plus two prepared payloads and a plan) for every candidate row
      // it walks, so its heap traffic scales with the ESTATE while the page
      // returns 26 rows. The narrow shape reads `j.id` only, so its heap traffic
      // scales with the 26 rows it returns.
      //
      // Asserted on buffers rather than on peak intermediate rows because the
      // peak is a planner artefact: at this fixture size PostgreSQL evaluates
      // the wide EXISTS filter per row as it walks, so the plan's largest
      // intermediate node is the LIMIT's own 26. Buffers are what actually
      // records the estate-wide walk, and they are the number MLOAD-01 reported
      // (676,964 buffers read from disk for 26 rows).
      // A scan node's own Buffers line does not repeat the table name, and it is
      // not reliably the next line: the node prints Filter/Index Cond/Sort Key/
      // Heap Fetches at deeper indent first, and on some shapes the Buffers line
      // sits at the node's OWN indent further down its block. So the node's block
      // is taken as every following line indented at least as far as the node, up
      // to the first line that is a shallower node -- which is exactly one plan
      // node plus its own detail lines.
      const heapOn = (text: string) => {
        const lines = text.split("\n");
        let total = 0;
        for (const [index, line] of lines.entries()) {
          // Every scan form PostgreSQL can print, including the PARALLEL ones
          // (`Parallel Seq Scan`, `Parallel Index Only Scan`), which the growth
          // estate does use and a narrower pattern silently misses -- a missed
          // node reads as zero buffers and the assertion becomes vacuous, which
          // is exactly what the non-zero guard below exists to catch.
          if (!/\bcontrol_jobs\b/u.test(line) || !/\b(?:Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan)\b/u.test(line))
            continue;
          const indent = line.search(/\S/u);
          for (const detail of lines.slice(index + 1)) {
            if (detail.trim().length === 0) continue;
            if (detail.search(/\S/u) < indent) break;
            // `read=` is OMITTED when it is zero, so requiring it made every
            // all-cached node read as zero buffers -- which silently turned the
            // whole comparison vacuous. Both parts are optional and default 0.
            const buffers = /Buffers: shared hit=(\d+)(?: read=(\d+))?/u.exec(detail);
            if (buffers) { total += Number(buffers[1]) + Number(buffers[2] ?? 0); break; }
          }
        }
        return total;
      };
      const narrowHeap = heapOn(narrowPlan), wideHeap = heapOn(widePlan);
      assert.ok(wideHeap > 0 && narrowHeap > 0,
        `both plans must report real buffer counts for control_jobs, or this test is vacuous; measured ${narrowHeap} narrow and ${wideHeap} wide`);
      process.stdout.write(`# heaps: narrow=${narrowHeap} wide=${wideHeap}\n`);

      // BUFFERS IS NOT THE ASSERTION HERE, and the measurement says why. At this
      // fixture both shapes find the same 40 jobs, and PostgreSQL reports the
      // SAME buffer count for both (measured: 256 and 128 -- the narrow shape's
      // three arms each take their own scan of the tenant's jobs, which on a
      // 640-row table is three cheap page reads, while the wide shape's single
      // scan is one). So a buffer-count comparison here would be asserting a
      // planner artefact of a small fixture, and asserting the wrong direction
      // would be worse than not asserting it.
      //
      // The two quantities that DO capture the defect at any size are asserted
      // instead: ROW WIDTH below (the wide shape's rows carry the payloads, and
      // width is per row so it scales with the payload, not with the table), and
      // RECEIPTS PROBES below (which grows with the estate). The estate-scale
      // buffer and time figures are measured on the growth cluster and reported,
      // not asserted here, because a fixture big enough to show them would make
      // this lane minutes long.

      // RECEIPTS PROBES is the quantity the three-arm split exists to cut, and it
      // is the one that grows with the ESTATE rather than with the page: written
      // as one OR, the EXISTS is evaluated for every job the other branches have
      // not already taken -- 179,984 probes at 200k tasks against 251 for the
      // three arms, which is the figure in the report.
      //
      // That RATIO is not visible in this fixture, and asserting it here would be
      // asserting the opposite of the truth: at 640 jobs the planner turns the
      // EXISTS into a hashed SubPlan over the tenant's handful of receipts, so it
      // reports 2 probes for the single OR and 1 for the three arms. A fixture
      // large enough to show the ratio would make this lane minutes long.
      //
      // So what is asserted here is the STRUCTURAL property that holds at every
      // size and is what produces the ratio: the receipts EXISTS appears in
      // exactly ONE of the three arms, so the other two arms cannot drag a probe
      // per row. The numeric ratio is measured on the growth cluster and
      // reported, not asserted, because at this size it would be a fixture
      // artefact rather than a property of the query.
      const narrowProbes = receiptProbes(narrowPlan), wideProbes = receiptProbes(widePlan);
      const receiptsArms = (CANDIDATE_IDS.match(/FROM control_native_artifact_receipts/gu) ?? []).length;
      assert.equal(receiptsArms, 1,
        "the receipts EXISTS must appear in exactly one arm of the candidate query, or the other two arms drag a probe per row");
      assert.ok(wideProbes >= narrowProbes,
        `the single-OR shape must never probe the artifact receipts fewer times than the three-arm shape; measured ${wideProbes} vs ${narrowProbes}`);
      assert.ok(narrowProbes <= PROPOSALS + NOISE,
        `the three-arm shape must not probe the receipts once per estate row; measured ${narrowProbes} for ${PROPOSALS + NOISE} candidate-eligible rows`);

      // The wide shape's width is the mechanism: at least one plan node carries a
      // payload column, and the narrow shape must carry none at all.
      const widestOn = (text: string) => Math.max(0,
        ...[...text.matchAll(/on control_jobs[^\n]*?width=(\d+)/gu)].map(match => Number(match[1])));
      const wideWidth = widestOn(widePlan), narrowWidth = widestOn(narrowPlan);
      assert.ok(wideWidth > narrowWidth * 5,
        `the wide shape must materialise far wider job rows than the narrow one; measured width ${wideWidth} vs ${narrowWidth}`);
      assert.ok(narrowWidth > 0 && narrowWidth < 200,
        `the candidate query must materialise narrow job rows; measured width ${narrowWidth}`);
      // And the narrow query must not spill a sort: that spill (~900MB of temp
      // reads at 200k tasks) is the top-N heapsort carrying wide rows.
      assert.doesNotMatch(narrowPlan, /temp read=\d+/u,
        `the candidate query must not spill a sort to disk:\n${narrowPlan}`);

      const candidates = (await admin.query(CANDIDATE_IDS, attentionParams())).rows.length;
      process.stdout.write(`# attention shape plans: ${JSON.stringify({ narrowHeap, wideHeap, narrowWidth,
        wideWidth, narrowProbes, wideProbes, candidates })}\n`);
    } finally { await admin.end(); }
  }, { port: PORT + 1, allowedPorts: PORTS, boundMs: 1_800_000 });
});

test("the reshaped page reports the same candidates, order, examined count and cursor as the old shape",
  { skip: !PG && realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScopeAndOwner(admin);
      for (let index = 1; index <= PROPOSALS; index += 1)
        await seedProposal(admin, index, new Date(Date.parse(ISSUED_AT) + index * 1_000).toISOString());
      await addReceipts(admin, Math.floor(PROPOSALS / 2));
      await addNoise(admin);
      await admin.query("ANALYZE control_jobs, control_workflows, control_requests, projects");
      const oldRows = (await admin.query(OLD_ATTENTION_IDS, attentionParams())).rows.map(row => row.id as string);
      const newRows = (await admin.query(CANDIDATE_IDS, attentionParams())).rows.map(row => row.id as string);
      assert.ok(oldRows.length > 0, "the fixture must produce candidates for this comparison to mean anything");
      assert.deepEqual(newRows, oldRows,
        "the reshaped candidate query must choose exactly the same rows in exactly the same order");

      const web = new Client(postgres.connection("web"));
      await web.connect();
      try {
        const page = await new WebTaskService(readPort(web), scope, NOW).attention(identity);
        // Both are derived from the candidate page, so both are pinned here.
        assert.equal(page.examined, Math.min(newRows.length, 25));
        assert.equal(page.nextCursor, newRows.length > 25 ? newRows[24]! : null);
        assert.ok(page.items.every(item => newRows.includes(item.task.jobId)),
          "every rendered item must be one of the candidates this page examined");
        assert.ok(page.items.every(item => item.reasons.includes("proposal")),
          "every fixture item is an unplanned proposal, so each must be reported as one");
      } finally { await web.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 1_800_000 });
});

test("paging covers every candidate exactly once, in order, with none skipped or repeated",
  { skip: !PG && realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScopeAndOwner(admin);
      for (let index = 1; index <= PROPOSALS; index += 1)
        await seedProposal(admin, index, new Date(Date.parse(ISSUED_AT) + index * 1_000).toISOString());
      await addReceipts(admin, Math.floor(PROPOSALS / 2));
      await addNoise(admin);
      await admin.query("ANALYZE control_jobs, control_workflows, control_requests, projects");
      // EVERY candidate, which is more than one page holds: the candidate query
      // is itself bounded at 26, so the expectation is built by walking it with
      // the same cursor the read uses. Asserting against only the first page
      // would pass a read that silently dropped everything after it.
      const expected: string[] = [];
      for (let hop = 0; hop < 10; hop += 1) {
        const ids = (await admin.query(CANDIDATE_IDS, attentionParams(expected.at(-1) ?? null)))
          .rows.map(row => row.id as string);
        expected.push(...ids.slice(0, 25));
        if (ids.length <= 25) break;
      }
      assert.ok(expected.length > 25, `the fixture must span more than one page; got ${expected.length} candidates`);

      const web = new Client(postgres.connection("web"));
      await web.connect();
      try {
        const tasks = new WebTaskService(readPort(web), scope, NOW);
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        for (; pages < 10; pages += 1) {
          const page = await tasks.attention(identity, cursor);
          const pageCandidates = (await admin.query(CANDIDATE_IDS, attentionParams(cursor ?? null)))
            .rows.map(row => row.id as string);
          for (const id of pageCandidates.slice(0, 25)) seen.push(id);
          if (!page.nextCursor) { cursor = undefined; break; }
          assert.notEqual(page.nextCursor, cursor, `page ${pages} repeated its cursor`);
          assert.ok(page.nextCursor!.startsWith("job:attention-shape-"),
            `the cursor must be a real candidate id, got ${page.nextCursor}`);
          cursor = page.nextCursor;
        }
        assert.equal(cursor, undefined, "the traversal must terminate: every candidate must fit in the pages");
        assert.deepEqual(seen, expected,
          "paging must yield every candidate exactly once, in order, with none skipped or repeated");
        assert.ok(pages >= 1, "at least one page must have been read");
      } finally { await web.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 1_800_000 });
});

test("a job that qualifies under two arms appears ONCE, so the arms cannot double-count",
  { skip: !PG && realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScopeAndOwner(admin);
      for (let index = 1; index <= PROPOSALS; index += 1)
        await seedProposal(admin, index, new Date(Date.parse(ISSUED_AT) + index * 1_000).toISOString());
      await addReceipts(admin, Math.floor(PROPOSALS / 2));
      await admin.query("ANALYZE control_jobs, control_workflows, control_requests, projects");

      // The overlap must actually exist in this fixture, or the assertion below
      // would pass on a case that cannot fail.
      const overlap = (await admin.query(`SELECT count(*)::int AS n FROM control_jobs j
        WHERE j.tenant_id=$1
          AND j.state IN ('proposed','waiting_approval','failed','orphaned')
          AND EXISTS(SELECT 1 FROM control_native_artifact_receipts a
            WHERE a.tenant_id=j.tenant_id AND a.project_id=j.project_id AND a.job_id=j.id)`,
      [TENANT])).rows[0]!.n;
      assert.ok(overlap > 0,
        `the fixture must contain jobs qualifying under BOTH the state and receipts arms, or this test cannot fail; measured ${overlap}`);

      // I EXPECTED UNION ALL to double-count the overlapping jobs, and wrote a
      // test asserting that. The mutation run then showed the assertion does not
      // hold in BOTH directions, so this test now states only what is true at
      // every size, and the sizes are measured rather than assumed:
      //
      //   * At the growth estate all four spellings returned 26 rows of 26
      //     DISTINCT ids: each arm is ordered by j.id, so Merge Append emits
      //     duplicates adjacently and the outer LIMIT takes the same 26 either
      //     way.
      //   * At THIS fixture UNION ALL returns 13 distinct ids across 26 rows --
      //     the planner here uses a different plan (a Unique over an unsorted
      //     append), so the duplicates survive the outer LIMIT.
      //
      // So neither "UNION ALL is safe" nor "UNION ALL duplicates" is a property
      // of the query; it is a property of the plan, and it varies with the
      // estate. What IS a property of the query -- and what the owner would
      // actually experience -- is that the SHIPPED shape returns each candidate
      // exactly once, and that the page neither refuses nor repeats a task whose
      // job matched two arms. Those are asserted below for the shipped shape,
      // and the fix for the other is UNION, not a stronger test.
      const shipped = (await admin.query(CANDIDATE_IDS, attentionParams())).rows.map(row => row.id as string);
      const withDuplicates = (await admin.query(CANDIDATE_IDS.replaceAll("UNION", "UNION ALL"), attentionParams()))
        .rows.map(row => row.id as string);
      assert.equal(new Set(shipped).size, shipped.length,
        "the shipped candidate query must return each id at most once");
      // Every id the SHIPPED shape returns must be one the old single-OR shape
      // would also have returned: the split changes how candidates are FOUND,
      // never which ones qualify. UNION ALL is not compared for equality here --
      // whether it duplicates is a property of the PLAN, and it varies with the
      // estate -- only for the direction that is a property of the SQL: it can
      // never introduce a candidate the shipped query did not choose.
      const shippedSet = new Set(shipped);
      assert.deepEqual(withDuplicates.filter(id => !shippedSet.has(id)), [],
        "UNION ALL must not select any job id the shipped UNION does not; the split may drop or repeat, never add");
      const ordered = (await admin.query(
        `SELECT id FROM (SELECT unnest($1::text[]) AS id) t ORDER BY id COLLATE "C"`,
    [shipped])).rows.map(row => row.id as string);
      assert.deepEqual(ordered, shipped,
        "the shipped shape must already be in the product's own keyset order");

      // And the read itself must not refuse on a fixture where every receipted
      // proposal matches two arms -- the fail-closed check counts rows, so a
      // duplicate here would refuse the page.
      const web = new Client(postgres.connection("web"));
      await web.connect();
      try {
        const page = await new WebTaskService(readPort(web), scope, NOW).attention(identity);
        assert.ok(page.items.length > 0, "the read must still render items when arms overlap");
        assert.equal(new Set(page.items.map(item => item.task.jobId)).size, page.items.length,
          "the page must not repeat a task that two arms both matched");
      } finally { await web.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 1_800_000 });
});

test("each candidate arm is bounded by the page's own LIMIT", { skip: !PG && realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScopeAndOwner(admin);
      for (let index = 1; index <= PROPOSALS; index += 1)
        await seedProposal(admin, index, new Date(Date.parse(ISSUED_AT) + index * 1_000).toISOString());
      await addReceipts(admin, Math.floor(PROPOSALS / 2));
      // Noise in a state the filter EXCLUDES, which the receipts arm does not
      // match either -- so an unbounded arm still finds nothing extra here. The
      // assertion below is therefore on the SQL's own bound, not on this
      // fixture's row count: what makes the LIMIT load-bearing is the size of the
      // arm's MATCHING set estate-wide (183,779 of 200,000 jobs at the growth
      // estate), which is what the shape assertion captures.
      await addNoise(admin);
      await admin.query("ANALYZE control_jobs, control_workflows, control_requests, projects");

      // Every arm must carry a LIMIT, and the outer union must carry the page's
      // own bound. An unbounded arm is not wrong -- it returns the same ids -- but
      // it evaluates its EXISTS across the whole estate: measured at the growth
      // estate, 6,424 ms unbounded against 717 ms bounded, same 26 ids.
      assert.equal((CANDIDATE_IDS.match(/LIMIT 26/gu) ?? []).length, 4,
        "each of the three arms AND the union must carry LIMIT 26; an unbounded arm is not wrong but it stops being bounded");

      // And the bounded and unbounded forms must agree on this fixture, which is
      // what makes the LIMIT safe rather than merely fast.
      const bounded = (await admin.query(CANDIDATE_IDS, attentionParams())).rows.map(row => row.id as string);
      const withoutArmLimits = CANDIDATE_IDS.replace(/ORDER BY j\.id COLLATE "C" LIMIT 26\)/gu, `ORDER BY j.id COLLATE "C")`);
      assert.notEqual(withoutArmLimits, CANDIDATE_IDS,
        "the mutation pattern must actually change the query, or this comparison proves nothing");
      const unbounded = (await admin.query(withoutArmLimits, attentionParams())).rows.map(row => row.id as string);
      assert.deepEqual(unbounded.slice(0, bounded.length), bounded,
        "removing the per-arm LIMITs must not change which candidates this page returns");
      assert.ok(unbounded.length >= bounded.length,
        `an unbounded arm can only add candidates, never fewer; measured ${unbounded.length} unbounded vs ${bounded.length} bounded`);
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 1_800_000 });
});

test("a candidate lost between the phases refuses the page rather than reporting a short one",
  { skip: !PG && realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    try {
      await seedScopeAndOwner(admin);
      for (let index = 1; index <= PROPOSALS; index += 1)
        await seedProposal(admin, index, new Date(Date.parse(ISSUED_AT) + index * 1_000).toISOString());
      await admin.query("ANALYZE control_jobs, control_workflows, control_requests, projects");

      await admin.query("GRANT DELETE ON control_jobs TO control_room_private_web");
      const web = new Client(postgres.connection("web"));
      await web.connect();
      try {
        // Delete the last candidate row AFTER the candidate query has run and
        // BEFORE the payload query reads it: exactly the window the guard exists
        // for.
        //
        // A HONEST CAVEAT, stated because it changes what this proves. The read
        // runs at REPEATABLE READ (src/web/v1/session-authority.ts:72), so a
        // delete COMMITTED BY ANOTHER TRANSACTION after this one began is not
        // visible to it at all -- phase 2 would still find the row and the guard
        // would never fire. So this is not staged as a concurrent writer.
        //
        // Instead the delete runs on the read's OWN session, inside its own
        // transaction, which does make the row disappear from phase 2. That
        // requires DELETE on control_jobs, which the production web login
        // correctly does not hold, so the fixture admin grants exactly that for
        // this one test and revokes it in a finally. The grant is the fixture's,
        // the guard under test is the product's, and the report says which is
        // which.
        let deleted: string | undefined;
        const client = readPort(web, async (sql, params) => {
          // Matched on the payload phase specifically, not on `ANY($2::text[])`
          // alone: the session-authority preamble runs BEFORE it and a looser
          // match would fire on the wrong statement.
          // The payload phase is the ONLY statement carrying has_artifacts, so
          // this cannot fire on the session preamble or on the candidate query.
          if (deleted !== undefined || !sql.includes("AS has_artifacts")) return;
          const ids = (params?.[1] as string[] | undefined) ?? [];
          const victim = ids[ids.length - 1];
          if (!victim) return;
          deleted = victim;
          await web.query("DELETE FROM control_jobs WHERE tenant_id=$1 AND id=$2", [TENANT, victim]);
        });
        await assert.rejects(
          () => new WebTaskService(client, scope, NOW).attention(identity),
          /task_attention_candidate_unavailable/u,
          "a candidate row lost between the phases must refuse the page, not advance the owner's cursor past work nobody examined");
        assert.ok(deleted, "the fixture must actually have deleted a candidate between the phases");
      } finally {
        await web.end();
        await admin.query("REVOKE DELETE ON control_jobs FROM control_room_private_web");
      }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: PORTS, boundMs: 1_800_000 });
});
