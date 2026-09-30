// Real-PostgreSQL proof that the installation operations mode is a server-side
// owner control rather than a browser note, run on the production logins that
// execute it.
//
// Who runs what in production:
// - WebOperationsModeServiceV1 and its HTTP handler are composed on the private
//   web database (private-process.ts, mac-local-web-process.ts): the web login,
//   group control_room_private_web.
// - TaskAssignmentCoordinator.listRunning / revokeRunning are composed on the
//   coordinator database (task-coordinator-lifecycle.ts): the coordinator
//   login, group control_room_task_coordinator. The private web login holds no
//   grant on control_transition_events and so cannot revoke anything itself.
// - The claim / admission / start refusals are BEFORE INSERT triggers (0156).
//   They are the only enforcement, which is why they are exercised as the admin
//   connection too: a caller holding every table right must still be refused, or
//   the guard is not the guard.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { WebOperationsModeServiceV1 } from "../src/web/v1/operations-mode-service";
import { createOperationsModeHttpHandlerV1 } from "../src/web/v1/operations-mode-http";
import type { AccessTrust, VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { computeAuthorityDigest, sha256Digest } from "../src/security";

// Reserved disposable-cluster lane for this file: 58710-58719.
const PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) => 58710 + index));
const PORT = PORTS[0];
const PG = requiresRealPostgres();
const needsPg = () => (PG ? undefined : { skip: realPostgresSkipMessage() });

const ORIGIN = "https://operations.example.invalid";
const PROVIDER = "https://access.example.invalid";
const KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TRUST: AccessTrust = { issuer: PROVIDER, audience: "operations-mode-app", keys: [{ kid: "operations-key",
  jwk: KEYS.publicKey.export({ format: "jwk" }) }], validUntilMs: Date.now() + 3_600_000, maxSessionSeconds: 604800 };
const KEY = new Uint8Array(32).fill(67);

const TENANT = "tenant:operations-mode";
const WORKSPACE = "workspace:operations-mode";
const PROJECT = "project:operations-mode";
const ADAPTER = "adapter:operations-mode";
const NODE = "node:operations-mode";
const NODE_KEY = "node-key:operations-mode";
const OWNER = "identity:operations-mode-owner";
const OPERATOR = "identity:operations-mode-operator";
const AGENT = "identity:operations-mode-worker";

// The service is called two ways and each needs its own session row. Calling it
// directly uses a synthetic identity; going through HTTP uses a real signed
// gateway assertion, whose tokenDigest is derived from the token's exact bytes.
const ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const identityOf = (subject: string): VerifiedWebIdentity => ({ provider: PROVIDER, subject,
  tokenDigest: sha256Digest({ session: subject }), issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT,
  verificationExpiresAt: EXPIRES_AT });
const ownerIdentity = () => identityOf(OWNER);
const operatorIdentity = () => identityOf(OPERATOR);

function gatewayJwt(subject: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "operations-key" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: TRUST.issuer, aud: [TRUST.audience], sub: subject,
    email: `${subject}@example.invalid`, type: "app", iat: now - 60, exp: now + 600 })).toString("base64url");
  return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), KEYS.privateKey).toString("base64url")}`;
}
function gatewayRequest(path: string, method: "GET" | "POST", subject: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, { method,
    headers: { "cf-access-jwt-assertion": gatewayJwt(subject), origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
/** The identity the verifier will produce for a freshly minted assertion. */
function gatewayIdentity(subject: string): VerifiedWebIdentity {
  const now = Math.floor(Date.now() / 1000);
  return { provider: TRUST.issuer, subject,
    tokenDigest: `sha256:${createHash("sha256").update(gatewayJwt(subject)).digest("hex")}`,
    issuedAt: new Date((now - 60) * 1000).toISOString(), expiresAt: new Date((now + 600) * 1000).toISOString(),
    verificationExpiresAt: new Date((now + 600) * 1000).toISOString() };
}

async function seedTenant(admin: Client) {
  const now = new Date().toISOString();
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [TENANT]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [WORKSPACE, TENANT]);
  await admin.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [ADAPTER, TENANT]);
  await admin.query(`INSERT INTO projects
    (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
     health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1',$1,'running','fixture','healthy','control_room_native',$5,'{}',$5)`,
  [PROJECT, TENANT, WORKSPACE, ADAPTER, now]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,$3,$3)`, [TENANT, PROJECT, now]);
  // The node the work is leased to. The domain schema is complete — the
  // canonical store re-validates the whole lineage, node included, on every
  // transition, and a record that satisfies only the mirror trigger is refused
  // there.
  await admin.query(`INSERT INTO control_nodes(id,tenant_id,state,identity_key_id,version,payload,created_at,updated_at)
    VALUES($1,$2,'active',$3,1,$4::jsonb,$5,$5)`, [NODE, TENANT, NODE_KEY, JSON.stringify({
      contractVersion: "control-room-domain/v1", kind: "node", id: NODE, tenantId: TENANT, displayName: "Local worker",
      state: "active", platform: "macos", architecture: "arm64", identityKeyId: NODE_KEY,
      hardwareFingerprint: `sha256:${"3".repeat(64)}`, softwareFingerprint: `sha256:${"4".repeat(64)}`,
      policyVersion: "mac-local/v1", minimumProtocolVersion: "local-only", version: 1, createdAt: now, updatedAt: now,
    }), now]);
  // The owner holds a wildcard grant, which is what a real owner has. The
  // operator also holds a wildcard, as an operator: it must not reach this
  // control, which is the whole point of requiring an owner-only action.
  for (const [identity, display, role, actions] of [
    [OWNER, "Owner", "owner", '["*"]'], [OPERATOR, "Operator", "operator", '["*"]'],
    [AGENT, "Worker", "operator", '["tasks.read"]']] as const) {
    await admin.query(`INSERT INTO control_identities
      (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES($1,$2,'human',$3,$4,$5,'active',$6,$6)`,
    [identity, TENANT, display, PROVIDER, sha256Digest({ provider: PROVIDER, subject: identity }), now]);
    await admin.query(`INSERT INTO control_role_grants
      (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,
       require_strong_factor,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'["*"]','critical',true,false,$6,$6)`,
    [`grant:operations-mode:${identity}`, TENANT, identity, role, actions, now]);
  }
  // Web sessions: one per direct service identity and one per gateway assertion.
  // WebSessionAuthority reads these rows, so without them every call is
  // authentication_required and nothing else about the control is exercised.
  for (const identity of [ownerIdentity(), operatorIdentity(), gatewayIdentity(OWNER), gatewayIdentity(OPERATOR)])
    await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [TENANT, identity.tokenDigest, identity.subject, identity.issuedAt, identity.expiresAt]);
}

/** A ready job, as the ordinary proposal path leaves it before a claim. */
async function seedReadyJob(admin: Client, jobId: string) {
  const now = new Date().toISOString();
  const request = { kind: "request", id: `request:${jobId}`, tenantId: TENANT, workspaceId: WORKSPACE, projectId: PROJECT,
    state: "accepted", version: 1, idempotencyKey: `request-key:${jobId}`, createdAt: now, updatedAt: now };
  const workflow = { kind: "workflow", id: `workflow:${jobId}`, tenantId: TENANT, workspaceId: WORKSPACE, projectId: PROJECT,
    requestId: `request:${jobId}`, definitionDigest: sha256Digest({ workflow: jobId }), state: "active", version: 1,
    createdAt: now, updatedAt: now };
  await admin.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
    VALUES($1,$2,$3,'accepted',1,$4,$5::jsonb,$6,$6)`,
  [request.id, TENANT, PROJECT, request.idempotencyKey, JSON.stringify(request), now]);
  await admin.query(`INSERT INTO control_workflows(id,tenant_id,project_id,request_id,definition_digest,state,version,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'active',1,$6::jsonb,$7,$7)`,
  [workflow.id, TENANT, PROJECT, request.id, workflow.definitionDigest, JSON.stringify(workflow), now]);
  const authority = { projectId: PROJECT, allowedExecutor: "executor:test", allowedOperations: ["operation:test"],
    credentialRefs: [], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [],
    effectPolicy: "approval_required", maxRisk: "low", maxDurationSeconds: 60, maxConcurrentEffects: 1,
    expiresAt: new Date(Date.now() + 600_000).toISOString(), digest: "" };
  // The production digest function, so the seeded job is one the real planner
  // and the real claim path would both accept.
  authority.digest = computeAuthorityDigest(authority as never);
  const job = { kind: "job", id: jobId, tenantId: TENANT, workflowId: workflow.id, projectId: PROJECT, jobType: "task.proposal",
    specVersion: "1.0.0", inputDigest: sha256Digest({ jobId }), state: "ready", version: 1, priority: 50,
    requiredCapability: "code.change", dependsOnJobIds: [], authority,
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false,
      ambiguousEffectPolicy: "attention" }, createdAt: now, updatedAt: now };
  await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
    required_capability,authority_digest,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,'ready',1,50,'code.change',$5,$6::jsonb,$7,$7)`,
  [jobId, TENANT, workflow.id, PROJECT, authority.digest, JSON.stringify(job), now]);
  return job;
}

/** A claim: a ready job and the attempt row the canonical store creates for it.
 * Each call is its own job, because a job has exactly one attempt number 1 — a
 * real installation reaches these states through a different job, not by
 * re-claiming the same one. */
async function claim(admin: Client, suffix: string, state = "leased", inserter: Client = admin) {
  const job = await seedReadyJob(admin, `job:operations-mode:${suffix}`);
  const now = new Date().toISOString(), attemptId = `${job.id}:attempt:1`;
  const attempt = { kind: "attempt", id: attemptId, tenantId: TENANT, jobId: job.id, attemptNumber: 1, state,
    workerId: "executor:test", nodeId: NODE, leaseId: null, version: 0, startedAt: null, finishedAt: null,
    createdAt: now, updatedAt: now };
  await inserter.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,worker_id,node_id,version,
    payload,created_at,updated_at) VALUES($1,$2,$3,1,$4,'executor:test',$5,0,$6::jsonb,$7,$7)`,
  [attemptId, TENANT, job.id, state, NODE, JSON.stringify(attempt), now]);
  return { jobId: job.id, attemptId };
}

/** A native task queue row: the recorded intent to hand an already-claimed
 * attempt to a worker. The approval packet is the pre-existing prerequisite, so
 * the refusal being measured is the mode's and not a foreign key.
 *
 * The attempt must already exist: a start is by definition downstream of a
 * claim, and the claim gate is what refuses a fresh claim while a mode is set.
 * This helper therefore measures the start gate on its own, against a claim
 * that predates the mode. */
async function startDelivery(admin: Client, claimed: { jobId: string; attemptId: string }) {
  await admin.query(`INSERT INTO control_native_approval_packets(tenant_id,project_id,job_id,attempt_id,record,auth_tag)
    VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING`,
  [TENANT, PROJECT, claimed.jobId, claimed.attemptId,
    { jobId: claimed.jobId, attemptId: claimed.attemptId }, `hmac-sha256:${"b".repeat(64)}`]);
  await admin.query(`INSERT INTO control_native_task_queue(tenant_id,project_id,job_id,attempt_id,record,auth_tag)
    VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
  [TENANT, PROJECT, claimed.jobId, claimed.attemptId,
    { tenantId: TENANT, projectId: PROJECT, jobId: claimed.jobId, attemptId: claimed.attemptId, nodeId: NODE },
    `hmac-sha256:${"a".repeat(64)}`]);
}

function productionPool(postgres: RealPostgres, role: "web" | "coordinator") {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  const refused: string[] = [];
  const traced = (session: DatabaseSession): DatabaseSession => ({ query: async (sql, params) => {
    try { return await session.query(sql, params); }
    catch (error) { refused.push(sql.replace(/\s+/g, " ").trim()); throw error; }
  } });
  const client: DatabaseClient = { query: (sql, params) => bound.client.query(sql, params),
    transaction: work => bound.client.transaction(tx => work(traced(tx))),
    transactionWithPreCommitCheck: (work, check) => bound.client.transactionWithPreCommitCheck(tx => work(traced(tx)), check) };
  return { config, login, refused, pool: { client, close: () => bound.close() } };
}

const permissionFailure = (error: unknown, refused: readonly string[] = []) => {
  const sqlState = (error as { sqlState?: unknown; code?: unknown } | null)?.sqlState
    ?? (error as { code?: unknown } | null)?.code;
  return `${String(error)} sqlState=${String(sqlState)}${sqlState === "42501" ? " (permission denied)" : ""}`
    + (refused.length ? ` refused statement: ${refused.at(-1)}` : "");
};

const MODE = /installation operations mode/;

test("the owner records the mode server-side and the database refuses claims, admissions and starts", { timeout: 600_000 },
  async t => {
    const skip = needsPg();
    if (skip) { t.skip(skip.skip); return; }
    await withRealPostgres(async postgres => {
      const admin = new Client(postgres.admin({ database: postgres.database }));
      await admin.connect();
      try {
        await seedTenant(admin);
        const count = async () => Number((await admin.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_attempts WHERE tenant_id=$1", [TENANT])).rows[0]?.count ?? -1);
        const queueCount = async () => Number((await admin.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_native_task_queue WHERE tenant_id=$1", [TENANT])).rows[0]?.count ?? -1);

        // ---- A running installation admits a claim and a start. ----
        const web = productionPool(postgres, "web");
        try {
          const service = new WebOperationsModeServiceV1(web.pool.client,
            { tenantId: TENANT, workspaceId: WORKSPACE }, KEY);
          const before = await service.read(ownerIdentity())
            .catch((error: unknown) => assert.fail(`read as web login: ${permissionFailure(error, web.refused)}`));
          assert.equal(before.mode, "running");
          assert.equal(before.revision, 0);
          assert.equal(before.reason, "");
          assert.equal(before.admitsNewWork, true);
          // Revision zero is an absence, not a recorded decision: there is no
          // row and therefore no author to name.
          assert.equal(before.setByIdentityId, "");
          assert.equal(before.setAt, "");

          // This work is claimed and delivered while the installation is still
          // running. Every later mode must leave it exactly as it is.
          const running = await claim(admin, "running");
          await startDelivery(admin, running);
          assert.equal(await count(), 1, "a running installation admits a claim");
          assert.equal(await queueCount(), 1, "a running installation admits a start");

          // ---- Paused refuses a claim, and refuses a start for work claimed
          // before it. The start gate is measured on its own, against a claim
          // that predates the mode: a claim that already exists must not be
          // handed to a worker once the owner has paused. ----
          const undeliveredUnderRunning = await claim(admin, "undelivered-while-running");
          const paused = await service.set(ownerIdentity(), { mode: "paused", reason: "owner lunch" })
            .catch((error: unknown) => assert.fail(`set paused as web login: ${permissionFailure(error, web.refused)}`));
          assert.equal(paused.mode, "paused");
          assert.equal(paused.replayed, false);
          assert.equal(paused.revision, 1);
          assert.equal(paused.stopRequests, null, "pausing requests no stop");
          await assert.rejects(claim(admin, "refused-while-paused"), MODE, "paused must refuse a claim");
          await assert.rejects(startDelivery(admin, undeliveredUnderRunning), MODE,
            "paused must refuse a start for an already-claimed attempt");
          // Every production login that creates claims is held by the same
          // guard. The guard reads the mode with the inserting login's
          // privileges, so a claim login without a read of the mode record is
          // refused with "permission denied" in every mode, running included,
          // which is how the fleet gateway's claims all failed. (The fleet
          // gateway has its own attempt-write trigger that refuses a raw insert
          // first; its real claim path is proven in
          // fleet-connector-postgres.test.ts.)
          for (const role of ["news"] as const) {
            const login = new Client(postgres.connection(role));
            await login.connect();
            try {
              await assert.rejects(claim(admin, `refused-while-paused-${role}`, "leased", login),
                (error: unknown) => MODE.test(String(error)) && (error as { code?: string }).code === "55000",
                `paused must refuse a claim from the ${role} login by its mode, not by a missing grant`);
            } finally { await login.end(); }
          }
          assert.equal(await count(), 2, "the refused claims wrote nothing");
          assert.equal(await queueCount(), 1, "the refused start wrote nothing");

          // The refusal is the mode, not a coincidence: the same start is
          // admitted the moment the mode is running again.
          await service.set(ownerIdentity(), { mode: "running", reason: "" });
          await startDelivery(admin, undeliveredUnderRunning);
          assert.equal(await count(), 2);
          assert.equal(await queueCount(), 2);

          // ---- Draining and stopped refuse a claim and a start too. ----
          for (const mode of ["draining", "stopped"] as const) {
            await service.set(ownerIdentity(), { mode, reason: "wind down" });
            await assert.rejects(claim(admin, `refused-while-${mode}`), MODE, `${mode} must refuse a claim`);
            // A second, undelivered claim, so the start gate is measured on its
            // own rather than inheriting the claim gate's refusal.
            await service.set(ownerIdentity(), { mode: "running", reason: "" });
            const undelivered = await claim(admin, `undelivered-while-${mode}`);
            await service.set(ownerIdentity(), { mode, reason: "wind down" });
            await assert.rejects(startDelivery(admin, undelivered), MODE, `${mode} must refuse a start`);
          }
          assert.equal(await count(), 4, "only the four admitted claims exist; no refused claim reached the table");
          assert.equal(await queueCount(), 2, "no refused start ever reached the table");

          // ---- Draining and stopped leave running work alone. ----
          // The attempts claimed while running are untouched by every later
          // mode: no trigger fires on an existing row, and nothing in the drain
          // path writes to them. This is what makes draining a drain and not a
          // stop.
          for (const claimed of [running, undeliveredUnderRunning]) {
            const row = (await admin.query<{ state: string }>("SELECT state FROM control_attempts WHERE tenant_id=$1 AND id=$2",
              [TENANT, claimed.attemptId])).rows[0];
            assert.equal(row?.state, "leased", `${claimed.attemptId} is still leased under stopped`);
          }
          assert.equal(await queueCount(), 2, "an already-recorded start is not withdrawn by a later mode");

          // ---- Who changed it, and when, is in the record. ----
          const history = (await admin.query<{ revision: string; mode: string; reason: string; set_by_identity_id: string }>(
            "SELECT revision::text,mode,reason,set_by_identity_id FROM installation_operations_mode_revisions"
            + " WHERE tenant_id=$1 ORDER BY revision", [TENANT])).rows;
          // paused, running, then draining and stopped each pressed twice: once
          // to refuse a claim and once to refuse a start, with a running press
          // between.
          assert.deepEqual(history.map(row => [Number(row.revision), row.mode]),
            [[1, "paused"], [2, "running"], [3, "draining"], [4, "running"], [5, "draining"], [6, "stopped"],
             [7, "running"], [8, "stopped"]]);
          assert.ok(history.every(row => row.set_by_identity_id === OWNER),
            "every recorded revision names the owner who made it");
          assert.equal(history[0]?.reason, "owner lunch");

          // An exact repeat is a replay, not a second decision: same mode, same
          // reason, so no new revision and no second stop request.
          const replay = await service.set(ownerIdentity(), { mode: "stopped", reason: "wind down" });
          assert.equal(replay.replayed, true);
          assert.equal(replay.revision, 8, "a replay proves the existing revision instead of appending one");
          assert.equal(Number((await admin.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM installation_operations_mode_revisions WHERE tenant_id=$1",
            [TENANT])).rows[0]?.count), 8);
        } finally { await web.pool.close(); }

        // ---- The endpoint, over HTTP, on the real web login. ----
        const httpWeb = productionPool(postgres, "web");
        try {
          const service = new WebOperationsModeServiceV1(httpWeb.pool.client,
            { tenantId: TENANT, workspaceId: WORKSPACE }, KEY);
          const handler = createOperationsModeHttpHandlerV1({ origin: ORIGIN, service, trust: TRUST });
          const read = await handler(gatewayRequest("/api/v1/operations-mode", "GET", OWNER));
          assert.equal(read.status, 200);
          const view = await read.json() as { mode: string; revision: number; admitsNewWork: boolean };
          assert.equal(view.mode, "stopped");
          assert.equal(view.revision, 8);
          assert.equal(view.admitsNewWork, false);

          const posted = await handler(gatewayRequest("/api/v1/operations-mode", "POST", OWNER,
            { mode: "draining", reason: "overnight" }));
          assert.equal(posted.status, 200);
          const receipt = await posted.json() as { mode: string; revision: number; replayed: boolean };
          assert.equal(receipt.mode, "draining");
          assert.equal(receipt.revision, 9);

          // A mode the schema does not have is refused, not coerced.
          const unknown = await handler(gatewayRequest("/api/v1/operations-mode", "POST", OWNER,
            { mode: "stopped_everything" }));
          assert.equal(unknown.status, 400);
          // An extra field is refused too: this is not a place to smuggle a
          // second meaning onto the record.
          const extra = await handler(gatewayRequest("/api/v1/operations-mode", "POST", OWNER,
            { mode: "running", reason: "", extra: "ignored" }));
          assert.equal(extra.status, 400);
          // A query string has no meaning here and is refused rather than ignored.
          const query = await handler(new Request(`${ORIGIN}/api/v1/operations-mode?force=1`, {
            headers: { "cf-access-jwt-assertion": gatewayJwt(OWNER), origin: ORIGIN } }));
          assert.equal(query.status, 404);
        } finally { await httpWeb.pool.close(); }
      } finally { await admin.end(); }
    }, { port: PORT, allowedPorts: PORTS, boundMs: 240_000 });
  });

test("a worker cannot change the mode, and the database refuses the change itself", { timeout: 600_000 },
  async t => {
    const skip = needsPg();
    if (skip) { t.skip(skip.skip); return; }
    await withRealPostgres(async postgres => {
      const admin = new Client(postgres.admin({ database: postgres.database }));
      await admin.connect();
      try {
        await seedTenant(admin);
        const web = productionPool(postgres, "web");
        try {
          const service = new WebOperationsModeServiceV1(web.pool.client,
            { tenantId: TENANT, workspaceId: WORKSPACE }, KEY);
          // The operator holds a wildcard operator grant. This is the switch
          // that stops an entire installation, so a wildcard is not enough.
          await assert.rejects(service.set(operatorIdentity(), { mode: "stopped", reason: "not mine to press" }),
            (error: unknown) => (error as { code?: string }).code === "access_denied",
            "an operator's wildcard must not reach the operations mode");
          await assert.rejects(service.read(operatorIdentity()),
            (error: unknown) => (error as { code?: string }).code === "access_denied",
            "and an operator may not read it either");
          assert.equal((await service.read(ownerIdentity())).mode, "running",
            "a refused change leaves the mode exactly where it was");
        } finally { await web.pool.close(); }

        // Defence in depth: the application check is not the only one. A caller
        // with every table right — the admin connection, which is not an owner
        // and holds no grant at all — is refused by 0155's trigger, so no future
        // code path can write this by bypassing the service.
        const now = new Date().toISOString();
        const record = { schema: "control-room.installation-operations-mode/v1", tenantId: TENANT, revision: 1,
          mode: "stopped", reason: "written directly", setByIdentityId: AGENT, setAt: now };
        await assert.rejects(admin.query(`INSERT INTO installation_operations_mode_revisions
          (tenant_id,revision,mode,reason,set_by_identity_id,set_at,record,auth_tag)
          VALUES($1,1,'stopped','written directly',$2,$3,$4::jsonb,$5)`, [TENANT, AGENT, now, JSON.stringify(record),
          `hmac-sha256:${"c".repeat(64)}`]), MODE, "the trigger refuses a non-owner identity holding every table right");
        // The owner's own row is accepted: the trigger is an owner check, not a
        // blanket refusal.
        const ownerRecord = { ...record, setByIdentityId: OWNER };
        await admin.query(`INSERT INTO installation_operations_mode_revisions
          (tenant_id,revision,mode,reason,set_by_identity_id,set_at,record,auth_tag)
          VALUES($1,1,'stopped','owner wrote this',$2,$3,$4::jsonb,$5)`, [TENANT, OWNER, now,
          JSON.stringify({ ...ownerRecord, reason: "owner wrote this" }),
          `hmac-sha256:${"c".repeat(64)}`]);
        // A recorded mode is not rewritable or deletable, by anyone.
        await assert.rejects(admin.query("UPDATE installation_operations_mode_revisions SET mode='running'"
          + " WHERE tenant_id=$1 AND revision=1", [TENANT]), /append-only/,
        "a recorded decision is never rewritten");
        await assert.rejects(admin.query("DELETE FROM installation_operations_mode_revisions WHERE tenant_id=$1",
          [TENANT]), /append-only/, "a recorded decision is never deleted");
        // And a gap in the numbering is refused, so the effective mode can
        // never be a fiction.
        await assert.rejects(admin.query(`INSERT INTO installation_operations_mode_revisions
          (tenant_id,revision,mode,reason,set_by_identity_id,set_at,record,auth_tag)
          VALUES($1,5,'running','',$2,$3,$4::jsonb,$5)`, [TENANT, OWNER, now,
          JSON.stringify({ ...ownerRecord, revision: 5, mode: "running", reason: "", setAt: now }),
          `hmac-sha256:${"c".repeat(64)}`]), MODE, "a revision gap is refused");
      } finally { await admin.end(); }
    }, { port: PORTS[1], allowedPorts: PORTS, boundMs: 240_000 });
  });
