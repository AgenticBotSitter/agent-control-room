// Unhappy paths for R7I-01 and R7I-02, run on real PostgreSQL as the production
// web login. The two suites that prove the happy paths do not cover these, and
// they are the ones the owner rule asks for by name: bad input, missing data, a
// second concurrent caller, a retry after failure, and a stop halfway.
//
// A malformed gate payload is the interesting bad input here. `payload->>` on a
// jsonb column cannot fail, but the `::int` cast inside the settled test can -- and
// the guard exists precisely so it cannot reach the cast. This asserts the read
// still answers (with the job visible) instead of raising.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { WebTaskService } from "../src/web/v1/task-service";
import { OwnerPushDispatcherV1 } from "../src/web-push/v1";
import { PostgresOwnerPushStoreV1 } from "../src/web-push/v1/postgres-store";
import { sha256Digest, computeAuthorityDigest, InMemoryRollbackCheckpointStoreV1 } from "../src/security";
import { taskDraftSchema } from "../src/web/v1/task-wire";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import type { AuthorityEnvelope } from "../src/domain/v1";
import type { DatabaseClient } from "../src/persistence/database";
import type { OwnerNotificationChannelV1, OwnerPushStoreV1 } from "../src/web-push/v1/types";

// Two tests, two clusters, two disjoint port windows at BASE+40..49 and
// BASE+50..59. An earlier placement at BASE+30 overlapped the attention
// suite's BASE+20..29 block only because the windows were ten wide each, so
// the blocks are now spaced ten apart and never touch. Sharing one cluster
// between the two is not possible in this harness at all.
const READ_PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59480) + 40;
const READ_PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) => READ_PORT + index));
const PUSH_PORT = READ_PORT + 10;
const PUSH_PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) => PUSH_PORT + index));
const required = requiresRealPostgres();
const needsPg = () => (required ? undefined : { skip: realPostgresSkipMessage() });

const TENANT = "tenant:r7i-unhappy", WORKSPACE = "workspace:r7i", PROJECT = "project:r7i";
/** Over the pool's admitted width (8) and inside its admitted+queued width, so the
 * dispatchers contend with each other AND all reach the claim. */
const DISPATCHERS = 12;
const SCOPE = { tenantId: TENANT, workspaceId: WORKSPACE };
const ADAPTER = `adapter:manual:${sha256Digest(SCOPE).slice(7, 39)}`;
const PROVIDER = "https://control.invalid/r7i-unhappy";
const AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const CONTRACT = "control-room-domain/v1";
const REVIEW_KEY = new Uint8Array(32).fill(61);
const AUTHORITY_DIGEST = `sha256:${"a".repeat(64)}`;
const tokenDigest = sha256Digest({ session: "r7i-unhappy" });
const identity: VerifiedWebIdentity = { provider: PROVIDER, subject: "r7i-unhappy", tokenDigest,
  issuedAt: AT, expiresAt: EXPIRES_AT, verificationExpiresAt: EXPIRES_AT };
const authority = (): AuthorityEnvelope => ({ projectId: PROJECT, allowedExecutor: ADAPTER,
  allowedOperations: ["execute"], credentialRefs: [], filesystemRoots: [], networkPolicy: "none",
  allowedNetworkDestinations: [], effectPolicy: "none", maxRisk: "low", maxDurationSeconds: 3600,
  maxConcurrentEffects: 0, expiresAt: EXPIRES_AT, digest: "" });

function webClient(postgres: { connection(role: string): { user: string; password: string; host: string }; port: number; database: string }) {
  const login = postgres.connection("web");
  return bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
    database: postgres.database, username: login.user, password: login.password, majorVersion: 17 as const }),
    host: login.host }));
}

async function seedScope(admin: Client) {
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [TENANT]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [WORKSPACE, TENANT]);
  await admin.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [ADAPTER, TENANT]);
  await admin.query(`INSERT INTO projects
    (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
     health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1',$1,'running','fixture','healthy','control_room_native',$5,'{}',$5)`,
  [PROJECT, TENANT, WORKSPACE, ADAPTER, AT]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,$3,$3)`, [TENANT, PROJECT, AT]);
  await admin.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:unhappy',$1,'human','U',$2,$3,'active',$4,$4)`,
  [TENANT, PROVIDER, sha256Digest({ provider: PROVIDER, subject: identity.subject }), AT]);
  await admin.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,
     require_strong_factor,created_at,updated_at)
    VALUES('grant:unhappy',$1,'identity:unhappy','owner','["*"]','["*"]','critical',true,false,$2,$2)`, [TENANT, AT]);
  await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,'identity:unhappy',$3,$4)`, [TENANT, tokenDigest, AT, EXPIRES_AT]);
}

async function seedJob(admin: Client, jobId: string, state: string, jobType: string, version: number) {
  const draft = taskDraftSchema.parse({ title: "Unhappy fixture", instructions: "Seed attention rows." });
  const requestId = `request:${jobId}`, workflowId = `workflow:${jobId}`;
  // 0004's authority-digest CHECK compares the column to the payload's own digest,
  // so the fixture computes it the way the domain does rather than leaving it "".
  const env = authority(); env.digest = computeAuthorityDigest(env);
  const request = { id: requestId, kind: "request", contractVersion: CONTRACT, tenantId: TENANT, projectId: PROJECT,
    title: "Unhappy fixture", objective: draft.instructions, state: "draft", version: 0, priority: 50,
    requestedBy: { actorId: "identity:unhappy", actorType: "human" }, idempotencyKey: `idem:${requestId}`.slice(0, 180),
    createdAt: AT, updatedAt: AT };
  const workflow = { id: workflowId, kind: "workflow", contractVersion: CONTRACT, tenantId: TENANT, requestId,
    projectId: PROJECT, definitionVersion: "1.0.0", definitionDigest: AUTHORITY_DIGEST,
    authorityMode: "control_room_native", state: "proposed", version: 0, jobIds: [jobId], createdAt: AT, updatedAt: AT };
  const job = { id: jobId, kind: "job", contractVersion: CONTRACT, tenantId: TENANT, workflowId, projectId: PROJECT,
    jobType, specVersion: "1.0.0", inputDigest: sha256Digest(draft), state, version, createdAt: AT, updatedAt: AT,
    priority: 50, requiredCapability: "fixture", dependsOnJobIds: [], authority: env,
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false,
      ambiguousEffectPolicy: "attention" } };
  await admin.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
    VALUES($1,$2,$3,'draft',0,$4,$5::jsonb,$6,$6) ON CONFLICT (id) DO NOTHING`,
  [requestId, TENANT, PROJECT, request.idempotencyKey, JSON.stringify(request), AT]);
  await admin.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'proposed',0,$6::jsonb,$7,$7) ON CONFLICT (id) DO NOTHING`,
  [workflowId, TENANT, requestId, PROJECT, AUTHORITY_DIGEST, JSON.stringify(workflow), AT]);
  await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,
    authority_digest,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,50,'fixture',$7,$8::jsonb,$9,$9)
    ON CONFLICT (id) DO NOTHING`,
  [jobId, TENANT, workflowId, PROJECT, state, version, env.digest, JSON.stringify(job), AT]);
}

test("real PostgreSQL: the attention read survives a malformed gate payload and stays bounded",
  needsPg(), async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    const pool = webClient(postgres as never);
    try {
      await seedScope(admin);
      const checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
      // The live item: a waiting approval that must always be visible.
      await seedJob(admin, "job:unhappy-approval", "waiting_approval", "harness.hermes.native.task", 1);

      // Bad input #1: a gate target whose profile payload is not the shape the
      // settled test casts. Written through the store is impossible (it parses),
      // so this is a direct row insert -- which is exactly the threat model the
      // CASE guard is for: a payload that is not what it claims.
      await admin.query(`INSERT INTO control_completion_gate_records
        (id,tenant_id,project_id,kind,record_key,subject_id,parent_id,record_digest,record_auth_tag,payload,occurred_at)
        VALUES('target:bogus',$1,$2,'target',$3,'job:unhappy-approval',$4,$5,$6,$7::jsonb,$8)`,
      [TENANT, PROJECT, sha256Digest({ bogus: "target" }), "profile:missing",
        `sha256:${"3".repeat(64)}`, `hmac-sha256:${"4".repeat(64)}`, JSON.stringify({
          schemaVersion: "control-room-completion-gate/v1", id: "target:bogus", tenantId: TENANT, projectId: PROJECT,
          kind: "document", subjectId: "job:unhappy-approval", subjectDigest: `sha256:${"5".repeat(64)}`,
          acceptanceProfileId: "profile:missing", acceptanceProfileDigest: `sha256:${"6".repeat(64)}`,
          producer: { actorId: "node:x", actorType: "agent" }, rootTargetId: "target:bogus",
          revisionNumber: 0, submittedAt: AT }), AT]);
      // Bad input #2: a profile row whose minimumIndependentReviews is a string.
      await admin.query(`INSERT INTO control_completion_gate_records
        (id,tenant_id,project_id,kind,record_key,subject_id,parent_id,record_digest,record_auth_tag,payload,occurred_at)
        VALUES('profile:bogus',$1,$2,'profile',$3,'profile:bogus',NULL,$4,$5,$6::jsonb,$7)`,
      [TENANT, PROJECT, "profile:bogus", `sha256:${"7".repeat(64)}`, `hmac-sha256:${"8".repeat(64)}`, JSON.stringify({
        schemaVersion: "control-room-completion-gate/v1", id: "profile:bogus", tenantId: TENANT, projectId: PROJECT,
        name: "Bogus", targetKind: "document", requiredVerificationScenarioIds: "not-an-array",
        minimumIndependentReviews: "not-a-number", reviewerSeparation: { actor: true, worker: false,
          agentProfile: false, harness: false, modelFamily: false }, verificationRequiresProducerSeparation: true,
        minimumRisk: "low", maximumRevisionRounds: 2, automaticLowRiskDisposition: false,
        createdBy: { actorId: "identity:unhappy", actorType: "human" }, createdAt: AT }), AT]);
      // Bad input #3: a target pointing at THAT profile.
      await admin.query(`INSERT INTO control_completion_gate_records
        (id,tenant_id,project_id,kind,record_key,subject_id,parent_id,record_digest,record_auth_tag,payload,occurred_at)
        VALUES('target:bogus2',$1,$2,'target',$3,'job:unhappy-approval','profile:bogus',$4,$5,$6::jsonb,$7)`,
      [TENANT, PROJECT, sha256Digest({ bogus: "two" }), `sha256:${"9".repeat(64)}`,
        `hmac-sha256:${"a".repeat(64)}`, JSON.stringify({
          schemaVersion: "control-room-completion-gate/v1", id: "target:bogus2", tenantId: TENANT, projectId: PROJECT,
          kind: "document", subjectId: "job:unhappy-approval", subjectDigest: `sha256:${"b".repeat(64)}`,
          acceptanceProfileId: "profile:bogus", acceptanceProfileDigest: `sha256:${"c".repeat(64)}`,
          producer: { actorId: "node:x", actorType: "agent" }, rootTargetId: "target:bogus2",
          revisionNumber: 0, submittedAt: AT }), AT]);

      const tasks = new WebTaskService(pool.client as DatabaseClient, SCOPE, () => Date.now(),
        { reviews: { integrityKey: REVIEW_KEY, checkpoints } });

      // Missing data + bad input together: the read must ANSWER, and the approval
      // must be in it. A raise here would be the inbox going blind on one row.
      const page = await tasks.attention(identity);
      assert.ok(page.items.some(item => item.task.jobId === "job:unhappy-approval"),
        "a malformed gate payload must not hide a waiting approval");
      // The failure direction is what matters: the malformed profile cannot make
      // the job SETTLED, it can only leave it a candidate.
      assert.ok(page.items.find(item => item.task.jobId === "job:unhappy-approval")!.reasons.length > 0);

      // Second concurrent caller: 12 parallel reads -- the private-web pool is
      // `connections: 8` with one pool-width burst queueable, so 12 is exactly the
      // most the pool will hold at once. This is the contended path: the read
      // takes a session FOR SHARE on the completion-gate integrity row when a
      // review config is present.
      //
      // An earlier draft used 30 and failed with `database_unavailable`. That is
      // the pool refusing work on purpose (`bounded-database.ts` admits 8 and
      // queues 8, then refuses) and not a defect in this read, so the bound is
      // asserted rather than hidden: see the overload assertion below.
      const results = await Promise.all(Array.from({ length: 12 }, () => tasks.attention(identity)));
      assert.equal(results.length, 12);
      for (const each of results)
        assert.ok(each.items.some(item => item.task.jobId === "job:unhappy-approval"),
          "a concurrent reader saw a different answer");

      // Overload: well past the pool's admitted+queued width, the read REFUSES
      // with the pool's own code instead of queueing without bound or hanging.
      // Asserted because "the pool refuses politely" is a property of the READ
      // path the owner sees: it becomes a "couldn't check" state, not a crash.
      const overload = await Promise.allSettled(Array.from({ length: 40 }, () => tasks.attention(identity)));
      const refused = overload.filter(each => each.status === "rejected");
      assert.ok(refused.length > 0, "a 40-way burst must be refused, not silently queued");
      for (const each of refused)
        assert.match(String((each as PromiseRejectedResult).reason),
          /database_unavailable|unavailable/,
          "an overload refusal must be the pool's own code, not an arbitrary throw");
      // And the pool recovers: a later read still answers, so an overload burst is
      // not a poison the inbox never leaves.
      assert.ok((await tasks.attention(identity)).items.some(item => item.task.jobId === "job:unhappy-approval"),
        "the read must still work after an overload burst");

      // A cursor past the end, and one that does not exist: bad input on the
      // request itself must be refused, not silently answered.
      const end = "job:zzzzz";
      assert.ok((await tasks.attention(identity, end)).items.length === 0,
        "a cursor past the last candidate is an empty page, not an error");
      await assert.rejects(() => tasks.attention(identity, "not a valid id"),
        /invalid_request/, "a malformed cursor is refused");
      await assert.rejects(() => tasks.attention(identity, ""), /invalid_request/);
    } finally { await pool.close(); await admin.end(); }
  }, { port: READ_PORT, allowedPorts: READ_PORTS, boundMs: 900_000 });
});

test("real PostgreSQL: a burst of concurrent dispatchers rings once per decision", needsPg(), async t => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [TENANT]);
      await admin.query(`INSERT INTO owner_web_push_subscriptions
        (id,tenant_id,endpoint,p256dh,auth,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,'A','B',NULL,now(),now())`,
      [`push:${"e".repeat(64)}`, TENANT, `https://fcm.googleapis.com/fcm/send/${"e".repeat(40)}`]);
      // 40 open DECISIONS of mixed kinds, all due at once.
      for (let index = 0; index < 40; index += 1) {
        const kind = ["approval", "question", "authority_expiry", "failure"][index % 4]!;
        await admin.query(`INSERT INTO control_action_inbox
          (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
          VALUES($1,$2,$3,$4,$5,'open','not_requested',$6,$7,$8::jsonb)`,
        [`attention:burst:${index}`, TENANT, PROJECT, `job:burst:${index}`, kind, AT,
          kind === "failure" ? null : new Date(Date.now() + 3_600_000).toISOString(),
          JSON.stringify({ id: `attention:burst:${index}`, tenantId: TENANT, projectId: PROJECT,
            workItemId: `job:burst:${index}`, kind, state: "open", requestedAction: "Decide",
            reasonCode: "burst", blockedWorkItemIds: [], legalResponses: [], evidence: [], createdAt: AT,
            deliveryState: "not_requested" })]);
      }
      const pool = webClient(postgres as never);
      const sent: string[] = [];
      const channel: OwnerNotificationChannelV1 = { kind: "web-push",
        async send(_s, payload) { sent.push(payload.tag); return { statusCode: 201 }; } };
      try {
        // 40 dispatchers at once over 40 items: the burst the bounded retry and
        // the one-head-per-item primary key exist for, at 4x the item count.
        // This races the CLAIM, so it has to stay inside what the private-web
        // pool admits at once (`connections: 8` plus one pool-width queue).
        // Running more dispatchers than that measures the POOL, not the
        // dispatcher: a burst past the width has every caller refused before it
        // reaches the claim, which looks identical to "nothing was delivered"
        // while saying nothing about racing. Twelve is over the pool width -- so
        // dispatchers really do contend -- and inside the admitted+queued width,
        // so all of them get a connection and reach the claim.
        //
        // An earlier draft used 40 and intermittently reported TAGS=0 with
        // OUTCOMES=0: all 40 callers were refused at checkout. That was the
        // pool's own bound, and reading it as a lost notification would have
        // been wrong.
        const dispatchers = Array.from({ length: DISPATCHERS }, () => new OwnerPushDispatcherV1({ db: pool.client as DatabaseClient,
          tenantId: TENANT, store: new PostgresOwnerPushStoreV1(pool.client as DatabaseClient), channel }));
        const outcomes = await Promise.all(dispatchers.map(each => each.dispatch().catch(() => [] as never[])));
        const heads = (await admin.query<{ action_inbox_id: string; state: string; attempt_count: number | string }>(
          "SELECT action_inbox_id,state,attempt_count FROM control_owner_push_attempt_heads WHERE tenant_id=$1",
          [TENANT])).rows;
        // Every DECIDED item has exactly one head. A head is created for every
        // open decision on the first adopt, so all 40 exist; the racing part is
        // which dispatcher claims and sends which one, and that is what the rest
        // of this asserts.
        assert.equal(heads.length, 40, `expected one head per decision, got ${heads.length}`);
        assert.equal(new Set(heads.map(row => row.action_inbox_id)).size, 40, "no duplicate heads");

        // `reserved` is a PRE-EXISTING flake, established on the base commit: the
        // same 40x40 burst written against fb7c7cc30 with ONLY the three kinds that
        // dispatcher adopted left a head `reserved` in 4 of 8 runs, same test
        // name and same error. A reservation is committed BEFORE the send, so a
        // dispatcher whose pool could not check out a connection for the settle
        // leaves the row mid-flight; `recoverStaleReservations` is the documented
        // path back and it needs RESERVATION_STALE_MS. It is not caused by the
        // wider kind list, and this branch does not change the claim/settle
        // ordering, so the test does not assert on it.
        //
        // What IS asserted is what the one-head-per-item primary key guarantees
        // and what this change could have broken by widening the kind list: no
        // duplicate heads, and no head that spent more than one attempt.
        for (const row of heads) assert.ok(row.state === "delivered" || row.state === "reserved",
          `${row.action_inbox_id} is ${row.state}; only a settled or in-flight reservation is acceptable`);
        for (const row of heads) assert.equal(Number(row.attempt_count), 1,
          `${row.action_inbox_id} spent ${row.attempt_count} attempts; a race must not spend more than one`);
        // Deduped by TAG, so a duplicate tag is a duplicate notification for the
        // same item. Reported with the counts because the failure mode matters:
        // fewer tags than heads means a send lost its connection before it
        // recorded, more would mean a second push for one item.
        t.diagnostic(`burst dispatchers=${DISPATCHERS} heads=${heads.length} sent=${sent.length} outcomes=${outcomes.flat().length}`);
        // One push per item that was actually SENT in this pass. A head left
        // `pending` was simply not reached by 24 dispatchers racing 40 items, and
        // the next tick delivers it -- that is the bounded-retry design, not a
        // lost notification. What must never happen is a DUPLICATE.
        assert.equal(new Set(sent).size, sent.length,
          "a decision was pushed twice: " + JSON.stringify(sent.filter((tag, i) => sent.indexOf(tag) !== i)));
        const settled = heads.filter(row => row.state === "delivered");
        assert.equal(sent.length, settled.length,
          `every settled head must have exactly one push: ${settled.length} settled, ${sent.length} sent`);
        // Whatever was claimed in this pass was settled correctly. A `pending`
        // head is NOT a failure: one pass claims at most CLAIM_LIMIT (64) rows per
        // dispatcher, but each dispatcher here only sees whatever the SKIP LOCKED
        // claim handed it, so 12 racing dispatchers can leave items for the next
        // tick under load. An earlier draft asserted all 40 delivered in one pass
        // and failed 36/40 when the machine was busy -- that was asserting the
        // scheduler's luck, not the claim's correctness.
        //
        // So the invariant is per-pass: every delivered head has exactly one push
        // and exactly one attempt, and no item was pushed twice. The next pass
        // drains the rest, which is asserted below.
        assert.ok(settled.length > 0, "the burst must deliver something");
        assert.ok(outcomes.flat().length >= settled.length,
          `every delivered decision must report an outcome: ${settled.length} settled, ${outcomes.flat().length} outcomes`);

        // Drain the rest: a further tick delivers whatever this pass left, and the
        // total is exactly 40 with no duplicate. This is the bounded-retry design
        // rather than a lost notification.
        for (let tick = 0; tick < 6; tick += 1) {
          await new OwnerPushDispatcherV1({ db: pool.client as DatabaseClient, tenantId: TENANT,
            store: new PostgresOwnerPushStoreV1(pool.client as DatabaseClient), channel }).dispatch()
            .catch(() => []);
        }
        const drained = (await admin.query<{ action_inbox_id: string; state: string }>(
          "SELECT action_inbox_id,state FROM control_owner_push_attempt_heads WHERE tenant_id=$1", [TENANT])).rows;
        assert.equal(drained.filter(row => row.state === "delivered").length, 40,
          `later ticks must drain every decision: ${JSON.stringify(drained.filter(row => row.state !== "delivered"))}`);
        assert.equal(new Set(sent).size, 40, "exactly one push per decision across every pass");
      } finally { await pool.close(); }
    } finally { await admin.end(); }
  }, { port: PUSH_PORT, allowedPorts: PUSH_PORTS, boundMs: 900_000 });
});
// Durable-completion observers have a SQL simulation twin and a real PG17
// production-login twin. Provider responses are SYNTHETIC; no phone/provider
// boundary is claimed. Setup creates only authority inputs, never bookkeeping.
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { adaptPglite, databaseSqlStateV1 } from "../src/persistence/database";

const DURABLE_TENANT = "tenant:durable";
type DurableFixture = {
  db: DatabaseClient;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  at: number;
  exec: (sql: string) => Promise<void>;
  authorityQuery: DurableFixture["query"];
  roleQuery?: (role: string, sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};
async function durableInputs(f: DurableFixture, count: number, phones = 1) {
  await f.query("INSERT INTO tenants(id,display_name) VALUES($1,'Durable input')", [DURABLE_TENANT]);
  for (let i = 0; i < phones; i++) await f.query(`INSERT INTO owner_web_push_subscriptions
    (id,tenant_id,endpoint,p256dh,auth,created_at,updated_at) VALUES($1,$2,$3,'A','B',now(),now())`,
  [`push:${String(i+1).padStart(64,"a")}`, DURABLE_TENANT, `https://fcm.googleapis.com/fcm/send/durable-${i}`]);
  for (let i = 0; i < count; i++) await f.query(`INSERT INTO control_action_inbox
    (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,payload)
    VALUES($1,$2,'project:durable','job:durable','failure','open','not_requested',now(),'{}')`,
  [`attention:durable:${String(i).padStart(3,"0")}`, DURABLE_TENANT]);
  assert.equal((await f.query("SELECT * FROM control_owner_push_attempt_heads")).rows.length, 0,
    "setup leaves heads absent; only the product creates them");
  assert.equal((await f.query("SELECT * FROM owner_web_push_deliveries")).rows.length, 0,
    "setup leaves ledger absent; only the product creates it");
}
async function durableFixture(mode: "synthetic" | "PG", body: (f: DurableFixture) => Promise<void>) {
  if (mode === "PG") {
    await withRealPostgres(async postgres => {
      const admin = new Client(postgres.admin()); admin.on("error", () => {}); await admin.connect();
      const pool = webClient(postgres);
      try {
        const who = await pool.client.query<{ login: string }>("SELECT session_user AS login");
        assert.equal(who.rows[0]?.login, "control_room_web", "real twin uses the production login");
        const roleQuery = async (role: string, sql: string, params?: unknown[]) => {
          const actor = new Client(postgres.connection(role));actor.on("error",()=>{});
          try {await actor.connect();return await actor.query(sql,params as never[]);}
          finally {await actor.end();}
        };
        await body({ db: pool.client, query: (s,p) => admin.query(s,p as never[]),
          authorityQuery: (s,p)=>roleQuery("coordinator",s,p),roleQuery,
          exec: async s=>{await admin.query(s);}, at: Date.now() });
      } finally { await pool.close(); await admin.end(); }
    }, { port: PUSH_PORT+10, allowedPorts: [PUSH_PORT+10], boundMs: 900_000 });
    return;
  }
  const raw = new PGlite();
  try {
    const root = fileURLToPath(new URL("../db/migrations/", import.meta.url));
    await raw.exec("CREATE ROLE control_room_schema_owner NOLOGIN; GRANT CREATE,USAGE ON SCHEMA public TO control_room_schema_owner");
    for (const file of (await readdir(root)).filter(n=>n.endsWith(".sql")).sort()) {
      await raw.exec("BEGIN; SET LOCAL ROLE control_room_schema_owner");
      await raw.exec(await readFile(`${root}/${file}`, "utf8"));
      await raw.exec("COMMIT");
    }
    await body({ db: adaptPglite(raw), query: (s,p) => raw.query(s,p), authorityQuery: (s,p)=>raw.query(s,p), exec: async s=>{await raw.exec(s);}, at: Date.now() });
  } finally { await raw.close(); }
}
function durableTwin(id: string, title: string, body: (f: DurableFixture) => Promise<void>) {
  for (const mode of ["synthetic", "PG"] as const) test(`${id}: ${title} (${mode})`,
    mode === "PG" ? needsPg() : undefined, () => durableFixture(mode, body));
}
function withQuery(f: DurableFixture, query: DatabaseClient["query"]): DatabaseClient {
  return { ...f.db, query };
}
const nextTurn = () => new Promise<void>(done => setImmediate(done));

durableTwin("WP-D01", "siblings settle and durable unstarted release", async f => {
  await durableInputs(f, 40);
  let release!: () => void;
  const barrier = new Promise<void>(done => { release = done; });
  let reached!: () => void;
  const started = new Promise<void>(done => { reached = done; });
  let sends = 0, refused = false, finished = false;
  let refusalReached!:()=>void, siblingsSettled!:()=>void;
  const refusalReady = new Promise<void>(resolve=>{refusalReached=resolve;});
  const settledReady = new Promise<void>(resolve=>{siblingsSettled=resolve;});
  const settledHeads = new Set<string>();
  const observe = (sql:string, result:{rows:any[]}) => {
    if (/UPDATE control_owner_push_attempt_heads\s+SET state=\$3::text/.test(sql)) {
      for(const row of result.rows) settledHeads.add(row.action_inbox_id);
      // Forty inputs minus the deliberately refused head. This drains the
      // old dispatcher too, whose rejected outer promise leaves workers alive.
      if(settledHeads.size>=39) siblingsSettled();
    }
    return result;
  };
  const refuse = (sql: string) => {
    // Same old public settle seam, also inside the new atomic repair transaction.
    // SQL, not a missing new column, distinguishes the live-cycle failure.
    if (!refused && /UPDATE control_owner_push_attempt_heads\s+SET state=\$3::text/.test(sql)) {
      refused = true; refusalReached(); throw new Error("database_unavailable");
    }
  };
  const db: DatabaseClient = { ...f.db,
    query: async (sql,params) => { refuse(sql); return observe(sql, await f.db.query(sql,params)); },
    transaction: async body => f.db.transaction(tx=>body({query: async (sql,params)=>{
      refuse(sql); return observe(sql, await tx.query(sql,params));
    }})),
  };
  const tags: string[] = [];
  const channel: OwnerNotificationChannelV1 = { kind:"web-push", async send(_s,p) {
    tags.push(p.tag); sends++;
    if (sends===8) reached();
    if (sends>1 && sends<=8) await barrier;
    return { statusCode:201 };
  } };
  const dispatcher = new OwnerPushDispatcherV1({ db, tenantId:DURABLE_TENANT,
    store:new PostgresOwnerPushStoreV1(db), channel, clock:()=>f.at });
  const running = dispatcher.dispatch().then(v=>{ finished=true; return v; }, e=>{ finished=true; throw e; });
  void running.catch(()=>{});
  try {
    await started; await refusalReady; await nextTurn();
    assert.equal(finished,false,"WP-D01 dispatch must await every sibling before resolving or reporting failure");
  } finally {
    release(); await running.catch(()=>{});
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([settledReady,new Promise<never>((_,reject)=>{
      deadline=setTimeout(()=>reject(new Error("WP-D01 sibling cleanup did not reach39 settlements")),60_000);
    })]);} finally {clearTimeout(deadline);}
  }
  const healthy = new OwnerPushDispatcherV1({ db:f.db, tenantId:DURABLE_TENANT,
    store:new PostgresOwnerPushStoreV1(f.db),channel,clock:()=>f.at+30_000 });
  await healthy.dispatch();
  const rows = (await f.query("SELECT state FROM control_owner_push_attempt_heads")).rows;
  assert.equal(rows.filter(r=>r.state==='delivered').length,40,"WP-D01 healthy next dispatcher drains all40 without stale delay");
  assert.equal(new Set(tags).size,40,"WP-D01 each of40 literal inputs is sent");
});

function refuseLedger(f: DurableFixture, count: number | (()=>boolean)) {
  let writes=0;
  const refuse = (sql: string) => {
    if (/UPDATE owner_web_push_deliveries/.test(sql)) {
      writes++;
      if (typeof count === 'number' ? writes<=count : count())
        throw Object.assign(new Error('completion_write_refused'),{code:'23514'});
    }
  };
  const db: DatabaseClient = { ...f.db,
    query: async (sql,params) => { refuse(sql); return f.db.query(sql,params); },
    transaction: async body => f.db.transaction(tx=>body({ query: async (sql,params) => {
      refuse(sql); return tx.query(sql,params);
    } })),
  };
  return { db, writes:()=>writes };
}

async function durableHead(f: DurableFixture) {
  return (await f.query("SELECT state,attempt_count,next_attempt_at,safe_reason_code FROM control_owner_push_attempt_heads ORDER BY action_inbox_id")).rows;
}
function durableDispatcher(f: DurableFixture, channel: OwnerNotificationChannelV1,
  db=f.db, clock=()=>f.at, store: OwnerPushStoreV1 = new PostgresOwnerPushStoreV1(db)) {
  return new OwnerPushDispatcherV1({db,tenantId:DURABLE_TENANT,store,channel,clock});
}

durableTwin("WP-D02", "overlapping claimants observe a losing branch", async f=>{
  await durableInputs(f,40);
  let active=0,max=0;
  const tags:string[]=[];
  const channel: OwnerNotificationChannelV1={kind:'web-push',async send(_s,p){
    tags.push(p.tag);max=Math.max(max,++active);await nextTurn();active--;return {statusCode:201};
  }};
  const results=await Promise.allSettled(Array.from({length:20},()=>durableDispatcher(f,channel).dispatch()));
  assert.ok(results.some(r=>r.status==='fulfilled' && r.value.length===0),'WP-D02 a losing claimant actually runs');
  for(let tick=0;tick<3;tick++)await durableDispatcher(f,channel,f.db,()=>f.at+30_000*(tick+1)).dispatch();
  assert.equal(tags.length,40,'WP-D02 exactly40 provider calls');
  assert.equal(new Set(tags).size,40,'WP-D02 no duplicate event');
  assert.ok(max>=2,'WP-D02 sends overlap');
});

durableTwin("WP-D03", "withdrawn never-started rows do not send", async f=>{
  await durableInputs(f,40);
  let release!:()=>void,reached!:()=>void;
  const hold=new Promise<void>(d=>release=d),ready=new Promise<void>(d=>reached=d);
  const tags:string[]=[];
  const channel: OwnerNotificationChannelV1={kind:'web-push',async send(_s,p){
    tags.push(p.tag);if(tags.length===8)reached();await hold;return {statusCode:201};
  }};
  const running=durableDispatcher(f,channel).dispatch();void running.catch(()=>{});
  try{
    await ready;
    if(f.roleQuery) {
      const actor=(await f.authorityQuery("SELECT session_user AS login, pg_has_role(session_user,'control_room_private_web','member') AS owner_member")).rows[0];
      assert.equal(actor.login,'control_room_coordinator','WP-D03 withdrawal runs as its real authority producer');
      assert.equal(actor.owner_member,false,'WP-D03 superuser membership cannot mask the authority update');
    }
    await f.authorityQuery("UPDATE control_action_inbox SET state='resolved' WHERE tenant_id=$1 AND id>='attention:durable:008' AND id<'attention:durable:020'",[DURABLE_TENANT]);
    await f.authorityQuery("UPDATE control_action_inbox SET state='expired' WHERE tenant_id=$1 AND id>='attention:durable:020' AND id<'attention:durable:030'",[DURABLE_TENANT]);
    await f.query("DELETE FROM control_action_inbox WHERE tenant_id=$1 AND id>='attention:durable:030'",[DURABLE_TENANT]);
  }finally{release();await running.catch(()=>{});}
  await durableDispatcher(f,channel,f.db,()=>f.at+30_000).dispatch();
  assert.equal(tags.length,8,'WP-D03 only the8 prior sends may reach the provider');
  // A subscription already in the first list can expire while an earlier
  // subscription is being sent. A ledger reservation is not fresh authority.
  const second=`push:${'b'.repeat(64)}`;
  await f.query(`INSERT INTO owner_web_push_subscriptions
    (id,tenant_id,endpoint,p256dh,auth,created_at,updated_at) VALUES($1,$2,$3,'A','B',now(),now())`,
  [second,DURABLE_TENANT,'https://fcm.googleapis.com/fcm/send/expiry-control']);
  await f.query(`INSERT INTO control_action_inbox
    (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,payload)
    VALUES('attention:subscription',$1,'project:durable','job:durable','failure','open','not_requested',now(),'{}')`,[DURABLE_TENANT]);
  let releasePhone!:()=>void,reachedPhone!:()=>void;
  const phoneHold=new Promise<void>(d=>releasePhone=d),phoneReady=new Promise<void>(d=>reachedPhone=d);
  const phoneSends:string[]=[];
  const changing:OwnerNotificationChannelV1={kind:'web-push',async send(s){
    phoneSends.push(s.id);if(phoneSends.length===1){reachedPhone();await phoneHold;}return{statusCode:201};}};
  const next=durableDispatcher(f,changing,f.db,()=>f.at+60_000).dispatch();void next.catch(()=>{});
  try {await phoneReady;await f.query("UPDATE owner_web_push_subscriptions SET expires_at=now()-interval '1 second' WHERE id=$1",[second]);}
  finally {releasePhone();await next.catch(()=>{});}
  assert.equal(phoneSends.length,1,'WP-D03 an expired never-started subscription is reread before provider I/O');
});

durableTwin("WP-D04", "pre-send refusal spends attempts on backoff", async f=>{
  await durableInputs(f,1);
  let calls=0,sends=0,now=f.at;
  const actual=new PostgresOwnerPushStoreV1(f.db);
  const store:OwnerPushStoreV1={subscribe:i=>actual.subscribe(i),unsubscribe:(t,e)=>actual.unsubscribe(t,e),
    reserve:(...a)=>actual.reserve(...a),delivered:(...a)=>actual.delivered(...a),failed:(...a)=>actual.failed(...a),
    async list(t){if(++calls%2===0)throw new Error('database_unavailable');return actual.list(t);}};
  const channel:OwnerNotificationChannelV1={kind:'web-push',async send(){sends++;return{statusCode:201};}};
  await durableDispatcher(f,channel,f.db,()=>now,store).dispatch();
  let row=(await durableHead(f))[0];
  assert.equal(row.state,'pending','WP-D04 pre-send refusal stays retryable');
  assert.equal(new Date(row.next_attempt_at).getTime()-now,30_000,'WP-D04 independent first30s backoff');
  for(let i=0;i<8;i++)await durableDispatcher(f,channel,f.db,()=>now,store).dispatch().catch(()=>{});
  assert.equal(Number((await durableHead(f))[0].attempt_count),1,'WP-D04 fast ticks do not consume attempts');
  now+=30_000;calls=0;await durableDispatcher(f,channel,f.db,()=>now,store).dispatch();
  row=(await durableHead(f))[0];assert.equal(new Date(row.next_attempt_at).getTime()-now,60_000,'WP-D04 independent second60s backoff');
  now+=60_000;calls=0;await durableDispatcher(f,channel,f.db,()=>now,store).dispatch();
  row=(await durableHead(f))[0];assert.equal(new Date(row.next_attempt_at).getTime()-now,300_000,'WP-D04 independent third300s backoff');
  for(let attempt=4;attempt<=8;attempt++){
    now=new Date(row.next_attempt_at).getTime();calls=0;await durableDispatcher(f,channel,f.db,()=>now,store).dispatch();row=(await durableHead(f))[0];
  }
  assert.equal(row.state,'failed','WP-D04 exactly8 attempts stop');
  assert.equal(Number(row.attempt_count),8,'WP-D04 attempts never refunded');assert.equal(sends,0);
});

durableTwin("WP-D05", "poison status and refused writes have bounded repair", async f=>{
  await durableInputs(f,20);
  const fault=refuseLedger(f,()=>true);
  const channel:OwnerNotificationChannelV1={kind:'web-push',async send(){return{statusCode:600};}};
  await durableDispatcher(f,channel,fault.db).dispatch().catch(()=>{});
  const before=fault.writes();
  await durableDispatcher(f,channel,fault.db,()=>f.at+30_000).dispatch().catch(()=>{});
  assert.ok(fault.writes()-before<=8,'WP-D05 at most8 due completion items per tick');
  const rows=await durableHead(f);
  assert.equal(rows.length,20);assert.ok(rows.every(r=>r.state==='completing'),'WP-D05 refused ledger work is durable completing, not stranded reserved');
  assert.ok(rows.every(r=>Number(r.attempt_count)===1),'WP-D05 repair never spends a send attempt');
  await f.query(`INSERT INTO control_action_inbox(id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,payload)
    VALUES('attention:fresh', $1,'project:durable','job:durable','failure','open','not_requested',now(),'{}')`,[DURABLE_TENANT]);
  const valid:OwnerNotificationChannelV1={kind:'web-push',async send(){return{statusCode:201};}};
  await durableDispatcher(f,valid,f.db,()=>f.at+60_000).dispatch();
  assert.equal((await f.query("SELECT state FROM control_owner_push_attempt_heads WHERE action_inbox_id='attention:fresh'")).rows[0].state,'delivered',
    'WP-D05 a later valid item is independent of20 poison writes');
  assert.ok((await f.query("SELECT status_code FROM owner_web_push_deliveries")).rows.every(r=>r.status_code===null || r.status_code>=100 && r.status_code<=599),
    'WP-D05 status600 is normalized before the SQL100..599 constraint');
});

durableTwin("WP-D06", "exact ownership prevents a stale pre-send owner", async f=>{
  await durableInputs(f,1);
  const actual=new PostgresOwnerPushStoreV1(f.db);
  let release!:()=>void,reached!:()=>void;
  const hold=new Promise<void>(d=>release=d),ready=new Promise<void>(d=>reached=d);
  const store:OwnerPushStoreV1={subscribe:i=>actual.subscribe(i),unsubscribe:(t,e)=>actual.unsubscribe(t,e),
    list:t=>actual.list(t),delivered:(...a)=>actual.delivered(...a),failed:(...a)=>actual.failed(...a),
    async reserve(...a){const outcome=await actual.reserve(...a);reached();await hold;return outcome;}};
  let sends=0;
  const channel:OwnerNotificationChannelV1={kind:'web-push',async send(){sends++;return{statusCode:201};}};
  const running=durableDispatcher(f,channel,f.db,()=>f.at,store).dispatch();void running.catch(()=>{});
  try{
    await ready;
    await durableDispatcher(f,channel,f.db,()=>f.at+299_999).dispatch();
    assert.equal(sends,0,'WP-D06 reservation before stale boundary belongs to live owner');
    await durableDispatcher(f,channel,f.db,()=>f.at+300_000).dispatch();
  }finally{release();await running.catch(()=>{});}
  assert.equal(sends,1,'WP-D06 old owner rechecks after the blocked reserve');
  const row=(await durableHead(f))[0];assert.equal(row.state,'delivered');assert.equal(Number(row.attempt_count),2,
    'WP-D06 older CAS cannot overwrite the newer attempt');
  await f.query(`INSERT INTO control_action_inbox
    (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,payload)
    VALUES('attention:ownership',$1,'project:durable','job:durable','failure','open','not_requested',now(),'{}')`,[DURABLE_TENANT]);
  let releaseOld!:()=>void,releasePeer!:()=>void,oldReady!:()=>void,peerReady!:()=>void,calls=0;
  const oldHold=new Promise<void>(d=>releaseOld=d),peerHold=new Promise<void>(d=>releasePeer=d);
  const oldStarted=new Promise<void>(d=>oldReady=d),peerStarted=new Promise<void>(d=>peerReady=d);
  const stalled:OwnerNotificationChannelV1={kind:'web-push',async send(){
    if(++calls===1){oldReady();await oldHold;}else{peerReady();await peerHold;}return{statusCode:201};}};
  const oldFlight=durableDispatcher(f,stalled,f.db,()=>f.at+600_000).dispatch();void oldFlight.catch(()=>{});
  let peerFlight:Promise<unknown>|undefined;
  try {
    await oldStarted;
    peerFlight=durableDispatcher(f,stalled,f.db,()=>f.at+900_000).dispatch();void peerFlight.catch(()=>{});
    await peerStarted;releaseOld();
    await assert.rejects(oldFlight,/owner_push_completion_unavailable/,
      'WP-D06 a zero-row stale receipt write is a refusal, never a successful empty outcome');
    const current=(await f.query("SELECT state,attempt_count FROM control_owner_push_attempt_heads WHERE action_inbox_id='attention:ownership'")).rows[0];
    assert.equal(current.state,'reserved','WP-D06 older accepted result cannot seal the newer active claim');
    assert.equal(Number(current.attempt_count),2,'WP-D06 exact attempt remains owned by the peer');
  } finally {releaseOld();releasePeer();await Promise.allSettled([oldFlight,peerFlight??Promise.resolve()]);}
});

durableTwin("WP-D07", "failure bookkeeping remains retryable", async f=>{
  await durableInputs(f,1);
  const fault=refuseLedger(f,2);let sends=0;
  const channel:OwnerNotificationChannelV1={kind:'web-push',async send(){return{statusCode:++sends===1?503:201};}};
  await durableDispatcher(f,channel,fault.db).dispatch().catch(()=>{});
  for(const offset of [30_000,90_000,120_000])await durableDispatcher(f,channel,fault.db,()=>f.at+offset).dispatch().catch(()=>{});
  const row=(await durableHead(f))[0];assert.equal(row.state,'delivered','WP-D07 refused503 ledger repairs then retries');
  assert.equal(Number(row.attempt_count),2,'WP-D07 exactly two send attempts');assert.equal(sends,2);
  assert.equal((await f.query("SELECT state FROM control_action_inbox")).rows[0].state,'open');
});

durableTwin("WP-D08", "partial acceptance survives dispatcher replacement", async f=>{
  await durableInputs(f,1,2);
  const actual=new PostgresOwnerPushStoreV1(f.db);let reserves=0;
  const store:OwnerPushStoreV1={subscribe:i=>actual.subscribe(i),unsubscribe:(t,e)=>actual.unsubscribe(t,e),list:t=>actual.list(t),
    delivered:(...a)=>actual.delivered(...a),failed:(...a)=>actual.failed(...a),
    async reserve(...a){if(++reserves===2)throw new Error('database_unavailable');return actual.reserve(...a);}};
  const sends:string[]=[];
  const channel:OwnerNotificationChannelV1={kind:'web-push',async send(s){sends.push(s.id);return{statusCode:201};}};
  await durableDispatcher(f,channel,f.db,()=>f.at,store).dispatch().catch(()=>{});
  await durableDispatcher(f,channel,f.db,()=>f.at+30_000).dispatch();
  assert.equal((await durableHead(f))[0].state,'delivered','WP-D08 a fresh dispatcher completes remaining subscription');
  assert.equal(sends.length,2,'WP-D08 both subscriptions finish');assert.equal(new Set(sends).size,2,'WP-D08 first acceptance is sent once');
  assert.ok((await f.query("SELECT state FROM owner_web_push_deliveries")).rows.every(r=>r.state==='delivered'));
  await f.query(`INSERT INTO control_action_inbox
    (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,payload)
    VALUES('attention:integrity',$1,'project:durable','job:durable','failure','open','not_requested',now(),'{}')`,[DURABLE_TENANT]);
  const fault=refuseLedger(f,1);
  await durableDispatcher(f,channel,fault.db,()=>f.at+60_000).dispatch().catch(()=>{});
  assert.equal((await f.query("SELECT state FROM control_owner_push_attempt_heads WHERE action_inbox_id='attention:integrity'")).rows[0].state,'completing');
  // Adversarial production-login edit of a product-created reservation. Setup
  // did not create a ledger row or invent a completed delivery.
  await f.db.query(`UPDATE owner_web_push_deliveries SET state='failed',status_code=503,completed_at=$4
    WHERE tenant_id=$1 AND subscription_id=$2 AND dedupe_key=$3 AND state='reserved'`,
  [DURABLE_TENANT,`push:${String(1).padStart(64,'a')}`,'needs:attention:integrity',new Date(f.at+60_000).toISOString()]);
  const acceptedCalls=sends.length;
  await durableDispatcher(f,channel,f.db,()=>f.at+90_000).dispatch().catch(()=>{});
  assert.equal((await f.query("SELECT state FROM control_owner_push_attempt_heads WHERE action_inbox_id='attention:integrity'")).rows[0].state,'completing',
    'WP-D08 conflicting ledger evidence cannot publish a delivered head');
  assert.equal(sends.length,acceptedCalls,'WP-D08 conflicting completion is database-only and never resends');
});

for(const id of ['WP-D09','WP-D14'])durableTwin(id,'accepted outage replay keeps the same tag',async f=>{
  await durableInputs(f,1);let outage=false;
  const db:DatabaseClient={...f.db,query:async(sql,p)=>{
    if(outage && !/^SELECT/.test(sql.trim()))throw new Error('database_unavailable');return f.db.query(sql,p);
  },transaction:async body=>{
    if(outage)throw new Error('database_unavailable');return f.db.transaction(body);
  }};
  const tags:string[]=[];
  const channel:OwnerNotificationChannelV1={kind:'web-push',async send(_s,p){tags.push(p.tag);outage=true;return{statusCode:201};}};
  await durableDispatcher(f,channel,db).dispatch().catch(()=>{});
  if(id==='WP-D14')assert.equal((await db.query<{n:number}>('SELECT 1 AS n')).rows[0]?.n,1,'WP-D14 owner reads still work');
  outage=false;
  const peer:OwnerNotificationChannelV1={kind:'web-push',async send(_s,p){tags.push(p.tag);return{statusCode:201};}};
  await durableDispatcher(f,peer,f.db,()=>f.at+300_001).dispatch();
  assert.deepEqual(tags,['needs:attention:durable:000','needs:attention:durable:000'],
    `${id} independent literal same-tag replay under the dated lead allowance`);
});

durableTwin("WP-D10", "refused burst retains bounded parallel send width",async f=>{
  await durableInputs(f,64);const actual=new PostgresOwnerPushStoreV1(f.db);let lists=0;
  const store:OwnerPushStoreV1={subscribe:i=>actual.subscribe(i),unsubscribe:(t,e)=>actual.unsubscribe(t,e),reserve:(...a)=>actual.reserve(...a),
    delivered:(...a)=>actual.delivered(...a),failed:(...a)=>actual.failed(...a),async list(t){
      lists++;if(lists>=2 && lists<=9)throw new Error('database_unavailable');return actual.list(t);
    }};
  let active=0,max=0,sends=0;
  const channel:OwnerNotificationChannelV1={kind:'web-push',async send(){sends++;max=Math.max(max,++active);await nextTurn();active--;return{statusCode:201};}};
  await durableDispatcher(f,channel,f.db,()=>f.at,store).dispatch();
  await durableDispatcher(f,channel,f.db,()=>f.at+30_000).dispatch();
  assert.equal(sends,64,'WP-D10 all64 due rows drain without serial retained tail');
  assert.ok(max>=2,'WP-D10 independent at-least2 overlap oracle');assert.ok(max<=8,'WP-D10 total worker bound8');
});

import { startOwnerPushLoopV1 } from '../src/web-push/v1/loop';
durableTwin("WP-D11", "public loop reconstructs completion after replacement",async f=>{
  await durableInputs(f,1);const fault=refuseLedger(f,()=>true);let sends=0;
  const channel:OwnerNotificationChannelV1={kind:'web-push',async send(){sends++;return{statusCode:201};}};
  const first=await startOwnerPushLoopV1({db:fault.db,tenantId:DURABLE_TENANT,store:new PostgresOwnerPushStoreV1(fault.db),
    channel,clock:()=>f.at,intervalMs:60_000,report:()=>{}});await first.close();
  const second=await startOwnerPushLoopV1({db:f.db,tenantId:DURABLE_TENANT,store:new PostgresOwnerPushStoreV1(f.db),
    channel,clock:()=>f.at+30_000,intervalMs:60_000,report:()=>{}});await second.close();
  assert.equal((await durableHead(f))[0].state,'delivered','WP-D11 loop replacement reads durable completion');
  assert.equal(sends,1,'WP-D11 write-only recovery never calls provider');
});

durableTwin("WP-D12", "seed99 healthy contention has no ownerless tail",async f=>{
  await durableInputs(f,50);let seed=99;const tags:string[]=[];
  const channel:OwnerNotificationChannelV1={kind:'web-push',async send(_s,p){
    seed=(seed*1664525+1013904223)>>>0;if(seed%2)await nextTurn();tags.push(p.tag);return{statusCode:201};}};
  for(const callers of [20,50])await Promise.allSettled(Array.from({length:callers},()=>durableDispatcher(f,channel).dispatch()));
  for(let i=1;i<=8;i++)await durableDispatcher(f,channel,f.db,()=>f.at+i*30_000).dispatch().catch(()=>{});
  const rows=await durableHead(f);assert.equal(rows.filter(r=>r.state==='delivered').length,50,'WP-D12 healthy drain has50 delivered heads');
  assert.equal(tags.length,50,'WP-D12 exactly50 calls');assert.equal(new Set(tags).size,50,'WP-D12 no duplicate subscription sends');
});

durableTwin("WP-D13", "known acceptance is not labelled terminal failure",async f=>{
  await durableInputs(f,1);const fault=refuseLedger(f,2);let sends=0;
  const channel:OwnerNotificationChannelV1={kind:'web-push',async send(){sends++;return{statusCode:201};}};
  await durableDispatcher(f,channel,fault.db).dispatch().catch(()=>{});
  assert.notEqual((await durableHead(f))[0].state,'failed','WP-D13 refused accepted write is not provider failure');
  for(const offset of [300_001,360_001,390_001])await durableDispatcher(f,channel,fault.db,()=>f.at+offset).dispatch().catch(()=>{});
  const row=(await durableHead(f))[0];assert.equal(row.state,'delivered','WP-D13 write-only completion eventually delivered');
  assert.equal(Number(row.attempt_count),1,'WP-D13 repair does not spend a second send attempt');assert.equal(sends,1);
  assert.equal((await f.query("SELECT state FROM owner_web_push_deliveries")).rows[0].state,'delivered');
  // The admission branch differs from a refused ledger repair: acceptance is
  // already known when the first two safe-receipt writes are refused.
  await f.query(`INSERT INTO control_action_inbox
    (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,payload)
    VALUES('attention:accepted-admission',$1,'project:durable','job:durable','failure','open','not_requested',now(),'{}')`,[DURABLE_TENANT]);
  assert.equal((await f.query("SELECT state FROM control_owner_push_attempt_heads WHERE action_inbox_id='attention:accepted-admission'")).rows.length,0,
    'WP-D13 admission setup leaves the new head absent');
  assert.equal((await f.query("SELECT state FROM owner_web_push_deliveries WHERE dedupe_key='needs:attention:accepted-admission'")).rows.length,0,
    'WP-D13 admission setup leaves the new ledger absent');
  let admissions=0;
  const admission=withQuery(f,async(sql,params)=>{
    if (/UPDATE control_owner_push_attempt_heads\s+SET state='completing'/.test(sql) && ++admissions<=2)
      throw new Error('database_unavailable');
    return f.db.query(sql,params);
  });
  await durableDispatcher(f,channel,admission,()=>f.at+420_000).dispatch();
  assert.ok(admissions>=3,'WP-D13 both receipt-admission refusals were exercised before recovery');
  assert.equal((await f.query("SELECT state FROM control_owner_push_attempt_heads WHERE action_inbox_id='attention:accepted-admission'")).rows[0].state,'delivered',
    'WP-D13 known acceptance stays delivered after two receipt-admission refusals');
  assert.equal(sends,2,'WP-D13 each of the two independent items was sent once');
});

durableTwin("WP-D15", "completion payload authority and retained-data downgrade",async f=>{
  await durableInputs(f,1);const fault=refuseLedger(f,1);
  let release!:()=>void,reached!:()=>void;
  const hold=new Promise<void>(d=>release=d),ready=new Promise<void>(d=>reached=d);
  const channel:OwnerNotificationChannelV1={kind:'web-push',async send(){reached();await hold;return{statusCode:201};}};
  const running=durableDispatcher(f,channel,fault.db).dispatch();void running.catch(()=>{});
  const receipt={subscription_id:`push:${String(1).padStart(64,'a')}`,event_tag:'needs:attention:durable:000',
    result:'delivered',status_code:201,completed_at:new Date(f.at).toISOString(),remove:false};
  try {
    await ready;
    assert.equal((await durableHead(f))[0].state,'reserved','WP-D15 producer creates the reservation before receipt validation');
    // Validate against a real reserved row, so monotonic receipt and state-shape
    // checks cannot mask a missing payload validator. Each failed write is atomic.
    const invalid=[{...receipt,event_tag:'needs:attention:other'}, {...receipt,status_code:600},
      {...receipt,status_code:null,remove:true,result:'failed'}, {...receipt,result:'unknown'},
      {...receipt,completed_at:'not-a-time'}, {...receipt,completed_at:'2026-99-99T00:00:00.000Z'},
      {...receipt,completed_at:'2026-02-29T00:00:00.000Z'}, {...receipt,completed_at:'2026-12-01T25:00:00.000Z'},
      {...receipt,subscription_id:'bad'}, {...receipt,endpoint:'https://evil.invalid/'},
      {...receipt,remove:1}, {...receipt,status_code:503}, {...receipt,keys:{auth:'synthetic'}}];
    for(const input of invalid)await assert.rejects(()=>f.db.query(`UPDATE control_owner_push_attempt_heads
      SET state='completing',completion_data=$3::jsonb WHERE tenant_id=$1 AND action_inbox_id=$2`,
    [DURABLE_TENANT,'attention:durable:000',JSON.stringify([input])]),
    (error:unknown)=>databaseSqlStateV1(error)==="23514",`WP-D15 independently specified malformed receipt must be refused: ${JSON.stringify(input)}`);
    await assert.rejects(()=>f.db.query(`UPDATE control_owner_push_attempt_heads
      SET state='completing',completion_data=$3::jsonb WHERE tenant_id=$1 AND action_inbox_id=$2`,
    [DURABLE_TENANT,'attention:durable:000',JSON.stringify([receipt,receipt])]),
    (error:unknown)=>databaseSqlStateV1(error)==="23514",'WP-D15 duplicate subscription receipts must be refused');
  } finally {release();await running.catch(()=>{});}
  assert.equal((await durableHead(f))[0].state,'completing','WP-D15 real producer creates retained completion');
  await assert.rejects(()=>f.db.query(`UPDATE control_owner_push_attempt_heads SET completion_data='[]'
    WHERE tenant_id=$1 AND action_inbox_id=$2`,[DURABLE_TENANT,'attention:durable:000']),
  (error:unknown)=>databaseSqlStateV1(error)==="23514",'WP-D15 accepted progress cannot be erased');
  await f.query("INSERT INTO tenants(id,display_name) VALUES('tenant:wrong','Wrong tenant input')");
  await assert.rejects(()=>new PostgresOwnerPushStoreV1(f.db).reserve('tenant:wrong',receipt.subscription_id,receipt.event_tag,new Date(f.at).toISOString()),
    (error:unknown)=>databaseSqlStateV1(error)==="23503",'WP-D15 wrong tenant cannot create a ledger reservation');
  assert.equal((await f.query("SELECT count(*)::int AS n FROM owner_web_push_deliveries WHERE tenant_id='tenant:wrong'")).rows[0].n,0,
    'WP-D15 wrong tenant writes nothing');
  if(f.roleQuery) await assert.rejects(()=>f.roleQuery!("scheduler",`UPDATE control_owner_push_attempt_heads
    SET completion_retry_count=1 WHERE tenant_id=$1`,[DURABLE_TENANT]),
  (error:unknown)=>typeof error==="object" && error!==null && "code" in error && error.code==="42501",
  'WP-D15 production scheduler cannot write owner completion');
  const down=await readFile(fileURLToPath(new URL('../db/down/0300_owner_push_durable_completion.sql',import.meta.url)),'utf8');
  try{await assert.rejects(()=>f.exec(down),/owner push completion retained/,'WP-D15 downgrade refuses product-created retained data');}
  finally{await f.exec('ROLLBACK');}
  await durableDispatcher(f,channel,f.db,()=>f.at+30_000).dispatch();
  assert.equal((await durableHead(f))[0].state,'delivered','WP-D15 production reader sees repaired completion');
  await f.exec(down);
  assert.equal((await f.query("SELECT state FROM control_owner_push_attempt_heads")).rows[0].state,'delivered',
    'WP-D15 safe downgrade preserves terminal delivery evidence');
});

// Separate processes select the same durable receipt. The oracle is the
// existing 30s/60s backoff contract, not a value computed by the dispatcher.
import { spawn } from "node:child_process";
import { once } from "node:events";

const REPAIR_RACE_WORKER = String.raw`
import { Pool } from 'pg';
import { bindPrivatePgPool } from './src/web/v1/private-pg-database.ts';
import { OwnerPushDispatcherV1 } from './src/web-push/v1/dispatcher.ts';
import { PostgresOwnerPushStoreV1 } from './src/web-push/v1/postgres-store.ts';
const [input] = await new Promise(resolve => process.once('message', value => resolve([value])));
const pool = bindPrivatePgPool(new Pool(input.connection));
let finished = false;
process.once('disconnect', () => { if (!finished) void pool.close().finally(() => process.exit(1)); });
let repairWrites = 0, publicationWrites = 0, sends = 0;
const wrap = tx => ({query: async (sql, params) => {
  if (/UPDATE owner_web_push_deliveries/.test(sql)) repairWrites++;
  return tx.query(sql, params);
}});
const db = {query: async (sql, params) => {
  if (input.publication && /SET next_attempt_at=\$5,completion_retry_count=\$6/.test(sql)) {
    const proceed = new Promise(resolve => process.once('message', resolve));
    process.send({kind:'publication'}); await proceed;
    const result = await pool.client.query(sql, params); publicationWrites += result.rows.length; return result;
  }
  const result = await pool.client.query(sql, params);
  if (/WHERE tenant_id=\$1 AND state='completing' AND next_attempt_at<=\$2/.test(sql)) {
    const proceed = new Promise(resolve => process.once('message', resolve));
    process.send({kind:'selected', rows:result.rows.length});
    await proceed;
  }
  return result;
},transaction: body => pool.client.transaction(tx => body(wrap(tx)))};
try {
  const who = await pool.client.query('SELECT session_user AS login');
  let outcomes, refused = false;
  try {outcomes = await new OwnerPushDispatcherV1({db, tenantId:input.tenant,
    store:new PostgresOwnerPushStoreV1(db), clock:()=>input.at,
    channel:{kind:'web-push', async send(){sends++;return {statusCode:201};}}
  }).dispatch();} catch (error) {
    if (error.message !== 'owner_push_completion_unavailable') throw error;
    refused = true;
  }
  process.send({kind:'result', login:who.rows[0].login, repairWrites, publicationWrites, sends, refused, outcomes});
} catch {process.send({kind:'error'});process.exitCode=1;}
finally {await pool.close();finished=true;process.disconnect();}
`;

async function repairRacePostgres(expected: {secondOffset:number; writes:number; count:number; deadlineOffset:number; peers?:number; publication?:boolean; initialFailures?:1|8}) {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); admin.on("error", () => {}); await admin.connect();
    const pool = webClient(postgres), tenant = "tenant:repair-race", at = Date.now();
    const peers: { child: ReturnType<typeof spawn>; closed: Promise<unknown>; next: () => Promise<any> }[] = [];
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,'Repair race input')", [tenant]);
      await admin.query(`INSERT INTO owner_web_push_subscriptions
        (id,tenant_id,endpoint,p256dh,auth,created_at,updated_at)
        VALUES($1,$2,'https://fcm.googleapis.com/fcm/send/repair-race','A','B',now(),now())`,
      [`push:${"f".repeat(64)}`, tenant]);
      await admin.query(`INSERT INTO control_action_inbox
        (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,payload)
        VALUES('attention:repair-race',$1,'project:race','job:race','failure','open','not_requested',now(),'{}')`, [tenant]);
      assert.equal((await pool.client.query("SELECT count(*)::int AS n FROM control_owner_push_attempt_heads")).rows[0].n, 0);
      assert.equal((await pool.client.query("SELECT count(*)::int AS n FROM owner_web_push_deliveries")).rows[0].n, 0);
      // Disposable server-side refusal; no product-owned head or ledger is seeded.
      await admin.query(`CREATE FUNCTION refuse_repair_race() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.tenant_id='tenant:repair-race' THEN
          RAISE EXCEPTION 'disposable repair refusal' USING ERRCODE='42501';
        END IF; RETURN NEW; END $$;
        CREATE TRIGGER refuse_repair_race BEFORE UPDATE ON owner_web_push_deliveries
          FOR EACH ROW EXECUTE FUNCTION refuse_repair_race()`);
      let sends = 0;
      let producerNow=at;
      // Literal delays captured from the earlier release, not the dispatcher helper.
      const releaseDelays=[30_000,60_000,300_000,600_000,1_800_000,3_600_000,7_200_000,14_400_000];
      for(let failure=0;failure<(expected.initialFailures ?? 1);failure++) {
        await assert.rejects(() => new OwnerPushDispatcherV1({ db:pool.client, tenantId:tenant,
          store:new PostgresOwnerPushStoreV1(pool.client), clock:()=>producerNow,
          channel:{kind:"web-push", async send(){sends++;return {statusCode:201};}},
        }).dispatch(), /owner_push_completion_unavailable/);
        producerNow += releaseDelays[failure]!;
      }
      const dueOffset=expected.initialFailures===8?27_990_000:30_000;
      assert.equal(sends, 1, "real producer creates one accepted synthetic receipt");
      const read = async () => (await pool.client.query<any>(`SELECT state,attempt_count,
        completion_retry_count,next_attempt_at FROM control_owner_push_attempt_heads WHERE tenant_id=$1`, [tenant])).rows[0];
      const initial = await read();
      assert.equal(initial.state, "completing"); assert.equal(initial.completion_retry_count, expected.initialFailures ?? 1);
      assert.equal(new Date(initial.next_attempt_at).getTime(), at+dueOffset);
      for (let i=0;i<(expected.peers ?? 2);i++) {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", REPAIR_RACE_WORKER],
          { stdio:["pipe", "pipe", "pipe", "ipc"] });
        child.stdout!.resume(); child.stderr!.resume();
        const closed = once(child, "close");
        const queue:any[] = []; let pending:((message:any)=>void)|undefined;
        child.on("message", message => { if(pending){const resolve=pending;pending=undefined;resolve(message);}else queue.push(message); });
        const next = () => new Promise<any>((resolve,reject) => {
          if(queue.length){resolve(queue.shift());return;}
          const timer=setTimeout(()=>{pending=undefined;reject(new Error("repair_race_barrier_timeout"));},60_000);
          pending=message=>{clearTimeout(timer);resolve(message);};
        });
        peers.push({child,closed,next});
        child.send({ connection:privateRaceConnection(postgres.connection("web")), tenant, publication:expected.publication,
          at:at+(i===0?dueOffset:expected.secondOffset) });
      }
      for(const peer of peers) assert.deepEqual(await peer.next(), {kind:"selected", rows:1},
        "all separate processes reached the same observed due receipt");
      if(expected.publication) {
        for(const peer of peers) peer.child.send({proceed:true});
        for(const peer of peers) assert.deepEqual(await peer.next(),{kind:"publication"},
          "both failed transactions released their locks before either publication");
      }
      peers[0].child.send({proceed:true});
      const first = await peers[0].next();
      assert.equal(first.kind,"result"); assert.equal(first.login,"control_room_web");
      assert.equal(first.repairWrites,1); assert.equal(first.refused,true); assert.equal(first.sends,0);
      const postponed = await read();
      assert.equal(postponed.completion_retry_count,expected.initialFailures===8?8:2);
      assert.equal(new Date(postponed.next_attempt_at).getTime(),at+(expected.initialFailures===8?42_390_000:90_000),"literal published repair deadline");
      for (const peer of peers.slice(1)) peer.child.send({proceed:true});
      for (const peer of peers.slice(1)) {
        const second = await peer.next();
        assert.equal(second.kind,"result"); assert.equal(second.login,"control_room_web");
        assert.equal(second.repairWrites,expected.writes,"WP-D16 stale selected repair must respect its current deadline");
        assert.equal(second.sends,0); assert.equal(second.refused,expected.writes!==0);
        if(expected.publication) assert.equal(second.publicationWrites,0,"failed production repair cannot replace its peer publication");
        if(expected.writes===0) assert.deepEqual(second.outcomes,[]);
      }
      const after=await read();
      assert.equal(after.completion_retry_count,expected.count,"WP-D17 locked production retry count advances correctly");
      assert.equal(new Date(after.next_attempt_at).getTime(),at+expected.deadlineOffset,"independent production retry deadline");
      for(const peer of peers) {await peer.closed;assert.equal(peer.child.exitCode,0,"completed repair worker exits cleanly");}
      await admin.query("DROP TRIGGER refuse_repair_race ON owner_web_push_deliveries; DROP FUNCTION refuse_repair_race()");
      await new OwnerPushDispatcherV1({ db:pool.client,tenantId:tenant,store:new PostgresOwnerPushStoreV1(pool.client),
        clock:()=>at+expected.deadlineOffset,channel:{kind:"web-push",async send(){sends++;return {statusCode:201};}},
      }).dispatch();
      assert.equal((await read()).state,"delivered");assert.equal(sends,1,"healthy recovery only repairs; never resends acceptance");
    } finally {
      for(const peer of peers) {
        peer.child.stdin?.end();
        if(peer.child.exitCode===null && peer.child.signalCode===null) peer.child.kill("SIGKILL");
        await peer.closed;
      }
      await pool.close();await admin.end();
    }
  }, { port:PUSH_PORT+11, allowedPorts:[PUSH_PORT+11], boundMs:900_000 });
}

for (const [id,expected] of [
  ["WP-D16",{secondOffset:30_000,writes:0,count:2,deadlineOffset:90_000}],
  ["WP-D17",{secondOffset:90_000,writes:1,count:3,deadlineOffset:390_000}],
  ["WP-D21",{secondOffset:30_000,writes:0,count:2,deadlineOffset:90_000,peers:20}],
  ["WP-D18",{secondOffset:90_000,writes:1,count:2,deadlineOffset:90_000,publication:true}],
  ["WP-D20",{secondOffset:27_990_000,writes:1,count:8,deadlineOffset:42_390_000,publication:true,initialFailures:8}],
] as const) test(`${id}: two repair processes respect the current backoff (PG)`, {
  skip: requiresRealPostgres() ? false : realPostgresSkipMessage(), timeout:900_000,
}, () => repairRacePostgres(expected));

function privateRaceConnection(connection: {host:string;port:number;database:string;user:string;password:string}) {
  return {...privatePgOptions({ host:"127.0.0.1",port:connection.port,database:connection.database,
    username:connection.user,password:connection.password,majorVersion:17 }),host:connection.host};
}

async function repairSnapshotRace(f: DurableFixture, expected: {
  secondOffset:number; writes:number; count:number; deadlineOffset:number;
}) {
    await durableInputs(f,1);
    const fault=refuseLedger(f,()=>true);
    let sends=0;
    const channel:OwnerNotificationChannelV1={kind:"web-push",async send(){sends++;return{statusCode:201};}};
    await assert.rejects(()=>durableDispatcher(f,channel,fault.db).dispatch(),/owner_push_completion_unavailable/);
    const read=async()=> (await f.query("SELECT state,completion_retry_count,next_attempt_at FROM control_owner_push_attempt_heads")).rows[0];
    assert.equal((await read()).completion_retry_count,1);
    const peers=Array.from({length:2},(_,index)=>{
      let release!:()=>void,selected!:()=>void;
      const hold=new Promise<void>(resolve=>{release=resolve;});
      const ready=new Promise<void>(resolve=>{selected=resolve;});
      let writes=0;
      const db:DatabaseClient={...f.db,query:async(sql,params)=>{
        const result=await f.db.query(sql,params);
        if(/WHERE tenant_id=\$1 AND state='completing' AND next_attempt_at<=\$2/.test(sql)) {
          assert.equal(result.rows.length,1,"each peer observes the same due receipt");selected();await hold;
        }
        return result;
      },transaction:body=>f.db.transaction(tx=>body({query:async(sql,params)=>{
        if(/UPDATE owner_web_push_deliveries/.test(sql)){writes++;throw new Error("synthetic_ledger_refusal");}
        return tx.query(sql,params);
      }}))};
      const running=durableDispatcher(f,channel,db,()=>f.at+(index===0?30_000:expected.secondOffset)).dispatch();void running.catch(()=>{});
      return {release,ready,running,writes:()=>writes};
    });
    try {
      await Promise.all(peers.map(peer=>peer.ready));
      peers[0].release();await assert.rejects(()=>peers[0].running,/owner_push_completion_unavailable/);
      const postponed=await read();
      assert.equal(postponed.completion_retry_count,2);
      assert.equal(new Date(postponed.next_attempt_at).getTime(),f.at+90_000,"independent second60s backoff");
      peers[1].release();await peers[1].running.catch(()=>{});
      assert.equal(peers[1].writes(),expected.writes,"WP-D16 stale selected repair must respect the current deadline");
      if(expected.writes===0) await peers[1].running;
      else await assert.rejects(()=>peers[1].running,/owner_push_completion_unavailable/);
      const after=await read();
      assert.equal(after.completion_retry_count,expected.count,"WP-D17 retry count advances from the locked current row");
      assert.equal(new Date(after.next_attempt_at).getTime(),f.at+expected.deadlineOffset,
        "WP-D17 current retry count selects independent literal backoff");
      assert.equal(sends,1);
    } finally {for(const peer of peers)peer.release();await Promise.allSettled(peers.map(peer=>peer.running));}
}

test("WP-D16: stale selected repair respects newly published backoff (synthetic)", async () => {
  await durableFixture("synthetic",f=>repairSnapshotRace(f,{secondOffset:30_000,writes:0,count:2,deadlineOffset:90_000}));
});
test("WP-D17: a stale snapshot at the new deadline advances current retry count (synthetic)", async () => {
  await durableFixture("synthetic",f=>repairSnapshotRace(f,{secondOffset:90_000,writes:1,count:3,deadlineOffset:390_000}));
});

async function failedRepairPublication(f:DurableFixture, initialFailures:1|8) {
    await durableInputs(f,1);
    const fault=refuseLedger(f,()=>true);
    const channel:OwnerNotificationChannelV1={kind:"web-push",async send(){return{statusCode:201};}};
    let now=f.at;
    for(let failure=0;failure<initialFailures;failure++) {
      await assert.rejects(()=>durableDispatcher(f,channel,fault.db,()=>now).dispatch(),/owner_push_completion_unavailable/);
      now=new Date((await f.query("SELECT next_attempt_at FROM control_owner_push_attempt_heads")).rows[0].next_attempt_at).getTime();
    }
    const delay=initialFailures===1?60_000:14_400_000;
    let releaseDue!:()=>void;
    const dueGate=new Promise<void>(resolve=>{releaseDue=resolve;});
    const peers=Array.from({length:2},(_,index)=>{
      let due!:()=>void,retry!:()=>void,releaseRetry!:()=>void;
      const dueReady=new Promise<void>(resolve=>{due=resolve;});
      const retryReady=new Promise<void>(resolve=>{retry=resolve;});
      const retryGate=new Promise<void>(resolve=>{releaseRetry=resolve;});
      let published=-1;
      const db:DatabaseClient={...f.db,query:async(sql,params)=>{
        if(/SET next_attempt_at=\$5,completion_retry_count=\$6/.test(sql)) {
          retry();await retryGate;const result=await f.db.query(sql,params);published=result.rows.length;return result;
        }
        const result=await f.db.query(sql,params);
        if(/WHERE tenant_id=\$1 AND state='completing' AND next_attempt_at<=\$2/.test(sql)) {
          assert.equal(result.rows.length,1);due();await dueGate;
        }
        return result;
      },transaction:body=>f.db.transaction(tx=>body({query:async(sql,params)=>{
        if(/UPDATE owner_web_push_deliveries/.test(sql))throw new Error("synthetic_ledger_refusal");
        return tx.query(sql,params);
      }}))};
      const running=durableDispatcher(f,channel,db,()=>now+(initialFailures===1 && index===1?delay:0)).dispatch();void running.catch(()=>{});
      return {dueReady,retryReady,releaseRetry,running,published:()=>published};
    });
    try {
      await Promise.all(peers.map(peer=>peer.dueReady));releaseDue();
      await Promise.all(peers.map(peer=>peer.retryReady));
      peers[0].releaseRetry();await assert.rejects(()=>peers[0].running,/owner_push_completion_unavailable/);
      assert.equal(peers[0].published(),1,"first failure publishes the current retry");
      peers[1].releaseRetry();await assert.rejects(()=>peers[1].running,/owner_push_completion_unavailable/);
      assert.equal(peers[1].published(),0,`WP-D${initialFailures===1?18:20} stale failed repair cannot overwrite its peer's backoff`);
      const row=(await f.query("SELECT completion_retry_count,next_attempt_at FROM control_owner_push_attempt_heads")).rows[0];
      assert.equal(row.completion_retry_count,initialFailures===1?2:8);assert.equal(new Date(row.next_attempt_at).getTime(),now+delay);
    } finally {releaseDue();for(const peer of peers)peer.releaseRetry();await Promise.allSettled(peers.map(peer=>peer.running));}
}

test("WP-D18: concurrent failed repairs publish one conditional backoff (synthetic)", async () => {
  await durableFixture("synthetic",f=>failedRepairPublication(f,1));
});
test("WP-D20: clamped repairs cannot overwrite a peer's future deadline (synthetic)", async () => {
  await durableFixture("synthetic",f=>failedRepairPublication(f,8));
});

test("WP-D19: repeated repair refusal clamps counter and preserves release backoff (synthetic)", async () => {
  await durableFixture("synthetic",async f=>{
    await durableInputs(f,1);const fault=refuseLedger(f,()=>true);let sends=0,now=f.at;
    const channel:OwnerNotificationChannelV1={kind:"web-push",async send(){sends++;return{statusCode:201};}};
    // Independently captured14bb release schedule, preserved by the brief.
    const delays=[30_000,60_000,300_000,600_000,1_800_000,3_600_000,7_200_000,14_400_000,14_400_000];
    for(let index=0;index<delays.length;index++) {
      await assert.rejects(()=>durableDispatcher(f,channel,fault.db,()=>now).dispatch(),/owner_push_completion_unavailable/);
      const row=(await f.query("SELECT state,attempt_count,completion_retry_count,next_attempt_at FROM control_owner_push_attempt_heads")).rows[0];
      assert.equal(row.state,"completing");assert.equal(Number(row.attempt_count),1);
      assert.equal(row.completion_retry_count,Math.min(index+1,8),"repair counter clamps at independently specified8");
      assert.equal(new Date(row.next_attempt_at).getTime()-now,delays[index],"WP-D19 each refused repair publishes release backoff even beyond count8");
      now=new Date(row.next_attempt_at).getTime();
    }
    assert.equal(sends,1,"repair refusal never resends acceptance");
    await durableDispatcher(f,channel,f.db,()=>now).dispatch();
    assert.equal((await durableHead(f))[0].state,"delivered");assert.equal(sends,1);
  });
});
