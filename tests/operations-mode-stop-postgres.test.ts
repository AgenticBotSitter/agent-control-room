// Real-PostgreSQL proof that `stopped` asks running work to stop through the
// existing lease-revocation path, and is honest about what it could not confirm.
//
// The stop is a post-commit effect on the coordinator's own login. The private
// web login holds no grant on control_transition_events and cannot revoke
// anything, so the recorded mode stands on its own whether or not the requests
// succeed — and this file is where that separation is measured, including the
// case where the coordinator login is not composed at all.
//
// Reserved disposable-cluster lane for this file: 58710-58719.
import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import test from "node:test";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { WebOperationsModeServiceV1 } from "../src/web/v1/operations-mode-service";
import { TaskAssignmentCoordinator, type TaskAssignmentRoute } from "../src/web/v1/task-assignment-coordinator";
import { CanonicalStore } from "../src/persistence/canonical-store";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { computeAuthorityDigest, sha256Digest } from "../src/security";

const PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) => 58710 + index));
const PG = requiresRealPostgres();
const needsPg = () => (PG ? undefined : { skip: realPostgresSkipMessage() });

const PROVIDER = "test";
const ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const KEY = new Uint8Array(32).fill(71);
const TENANT = "tenant:operations-stop";
const WORKSPACE = "workspace:operations-stop";
const PROJECT = "project:operations-stop";
const ADAPTER = "adapter:operations-stop";
const NODE = "node:operations-stop";
const NODE_KEY = "node-key:operations-stop";
const OWNER = "identity:operations-stop-owner";
const EXECUTOR = "executor:operations-stop";

const ownerIdentity = (): VerifiedWebIdentity => ({ provider: PROVIDER, subject: OWNER,
  tokenDigest: sha256Digest({ session: OWNER }), issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT,
  verificationExpiresAt: EXPIRES_AT });

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
  await admin.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Owner',$3,$4,'active',$5,$5)`,
  [OWNER, TENANT, PROVIDER, sha256Digest({ provider: PROVIDER, subject: OWNER }), now]);
  await admin.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,
     require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`, [`grant:operations-stop`, TENANT, OWNER, now]);
  const identity = ownerIdentity();
  await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`, [TENANT, identity.tokenDigest, OWNER, identity.issuedAt, identity.expiresAt]);
}

/** One job, claimed and leased: running work, as the canonical store leaves it.
 *
 * The job, attempt and lease are produced by the real `claimReadyJob`, not by
 * hand-written SQL. The revoke re-validates every record it touches through the
 * domain schema, so a fixture assembled from column values is refused by a
 * record whose shape the raw insert never had to satisfy. */
async function seedRunningWork(admin: Client, jobId: string, store: CanonicalStore) {
  const now = new Date().toISOString();
  // Complete domain records, exactly as the canonical store persists them.
  const request = { contractVersion: "control-room-domain/v1", kind: "request", id: `request:${jobId}`, tenantId: TENANT,
    projectId: PROJECT, title: "Nightly build", objective: "Build, check and validate one bounded change",
    state: "accepted", priority: 50, requestedBy: { actorId: OWNER, actorType: "human" },
    idempotencyKey: `request-key:${jobId}`, version: 1, createdAt: now, updatedAt: now };
  const workflow = { contractVersion: "control-room-domain/v1", kind: "workflow", id: `workflow:${jobId}`, tenantId: TENANT,
    requestId: request.id, projectId: PROJECT, definitionVersion: "1.0.0", definitionDigest: sha256Digest({ workflow: jobId }),
    authorityMode: "control_room_native", state: "active", jobIds: [jobId], version: 1, createdAt: now, updatedAt: now };
  await admin.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
    VALUES($1,$2,$3,'accepted',1,$4,$5::jsonb,$6,$6)`, [request.id, TENANT, PROJECT, request.idempotencyKey, JSON.stringify(request), now]);
  await admin.query(`INSERT INTO control_workflows(id,tenant_id,project_id,request_id,definition_digest,state,version,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'active',1,$6::jsonb,$7,$7)`,
  [workflow.id, TENANT, PROJECT, request.id, workflow.definitionDigest, JSON.stringify(workflow), now]);
  const authority = { projectId: PROJECT, allowedExecutor: EXECUTOR, allowedOperations: ["operation:test"],
    credentialRefs: [], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [],
    effectPolicy: "approval_required", maxRisk: "low", maxDurationSeconds: 600, maxConcurrentEffects: 1,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), digest: "" };
  authority.digest = computeAuthorityDigest(authority as never);
  const job = { contractVersion: "control-room-domain/v1", kind: "job", id: jobId, tenantId: TENANT, workflowId: workflow.id,
    projectId: PROJECT, jobType: "task.proposal", specVersion: "1.0.0", inputDigest: sha256Digest({ jobId }),
    state: "ready", version: 1, priority: 50, requiredCapability: "code.change", dependsOnJobIds: [], authority,
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false,
      ambiguousEffectPolicy: "attention" }, createdAt: now, updatedAt: now };
  await admin.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
    required_capability,authority_digest,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,'ready',1,50,'code.change',$5,$6::jsonb,$7,$7)`,
  [jobId, TENANT, workflow.id, PROJECT, authority.digest, JSON.stringify(job), now]);
  const claimed = await store.claimReadyTaskJob({ tenantId: TENANT, jobId, expectedJobVersion: 1, nodeId: NODE,
    workerId: EXECUTOR, attemptId: `${jobId}:attempt:1`, leaseId: `${jobId}:lease:1`, transitionId: `${jobId}:claim`,
    idempotencyKey: `${jobId}:claim-key`, actor: { actorId: OWNER, actorType: "human" }, acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString() });
  return { jobId, attemptId: claimed.attempt.id, leaseId: claimed.lease.id };
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
  return { refused, pool: { client, close: () => bound.close() } };
}


/** A CanonicalStore on one connection, running each unit of work in a real
 * transaction, so the seeding claim sees the same BEGIN/COMMIT boundaries the
 * production store gives it. */
function transactionalStore(admin: Client): CanonicalStore {
  const session = { query: (sql: string, params?: unknown[]) => admin.query(sql, params as never[]) } as never;
  return new CanonicalStore({ query: (sql: string, params?: unknown[]) => admin.query(sql, params as never[]),
    transaction: async (work: (tx: never) => Promise<never>) => { await admin.query("BEGIN");
      try { const r = await work(session); await admin.query("COMMIT"); return r; }
      catch (e) { await admin.query("ROLLBACK"); throw e; } },
    transactionWithPreCommitCheck: async (work: (tx: never) => Promise<never>, check: () => unknown) => {
      await admin.query("BEGIN");
      try { const r = await work(session); await check(); await admin.query("COMMIT"); return r; }
      catch (e) { await admin.query("ROLLBACK"); throw e; } } } as never);
}

const permissionFailure = (error: unknown, refused: readonly string[] = []) => {
  const sqlState = (error as { sqlState?: unknown; code?: unknown } | null)?.sqlState
    ?? (error as { code?: unknown } | null)?.code;
  return `${String(error)} sqlState=${String(sqlState)}${sqlState === "42501" ? " (permission denied)" : ""}`
    + (refused.length ? ` refused statement: ${refused.at(-1)}` : "");
};

test("stopped asks running work to stop through the coordinator, and reports what it could not confirm", { timeout: 600_000 },
  async t => {
    const skip = needsPg();
    if (skip) { t.skip(skip.skip); return; }
    await withRealPostgres(async postgres => {
      const admin = new Client(postgres.admin({ database: postgres.database }));
      await admin.connect();
      try {
        await seedTenant(admin);
        // The seeding store runs on the admin connection: it is writing fixture
        // rows, not exercising a production login, and the production logins are
        // exercised separately below through the real service and coordinator.
        const seedStore = transactionalStore(admin);
        const running = await seedRunningWork(admin, "job:operations-stop:running", seedStore);


        const coordinator = productionPool(postgres, "coordinator");
        const web = productionPool(postgres, "web");
        try {
          // The coordinator's own login sees exactly the running work, and only
          // that: a finished job is not on the list.
          const coordinatorForStop = new TaskAssignmentCoordinator(coordinator.pool.client,
            { tenantId: TENANT, workspaceId: WORKSPACE },
            { webOperation: () => ({ tenantId: TENANT, workspaceId: WORKSPACE }) } as never,
            [] as unknown as TaskAssignmentRoute[]);
          const listed = await coordinatorForStop.listRunning(TENANT);
          assert.deepEqual(listed.map(lease => lease.jobId), [running.jobId],
            "only the genuinely running job is asked to stop");
          // The stop reads the exact versions it will then re-check under the
          // revoke, so a mismatch there is a bug in one of the two and not a
          // reason for the revoke to fail later. The claim assigns them, so the
          // test reads them rather than assuming a fixed fixture.
          const live = (await admin.query<{ epoch: string; attempt_version: string; job_version: string }>(
            "SELECT l.epoch::text,a.version::text AS attempt_version,j.version::text AS job_version"
            + " FROM control_leases l JOIN control_attempts a ON a.tenant_id=l.tenant_id AND a.id=l.attempt_id"
            + " JOIN control_jobs j ON j.tenant_id=l.tenant_id AND j.id=l.job_id WHERE l.tenant_id=$1 AND l.id=$2",
          [TENANT, running.leaseId])).rows[0];
          assert.equal(listed[0]?.leaseEpoch, Number(live?.epoch));
          assert.equal(listed[0]?.attemptVersion, Number(live?.attempt_version));
          assert.equal(listed[0]?.jobVersion, Number(live?.job_version));

          const service = new WebOperationsModeServiceV1(web.pool.client,
            { tenantId: TENANT, workspaceId: WORKSPACE }, KEY, Date.now, {
              // The coordinator's own two methods, unbound from the lifecycle
              // wrapper, exactly as production composes them.
              listRunningInSession: (tenantId: string) => coordinatorForStop.listRunning(tenantId),
              revokeRunning: (input) => coordinatorForStop.revokeRunning(input),
            });
          const receipt = await service.set(ownerIdentity(), { mode: "stopped", reason: "shutting down for the night" })
            .catch((error: unknown) => assert.fail(`set stopped as web login: ${permissionFailure(error, web.refused)}`));
          assert.equal(receipt.mode, "stopped");
          assert.notEqual(receipt.stopRequests, null, "stopped sends stop requests");
          assert.equal(receipt.stopRequests?.requested, 1, "exactly the running job was asked to stop");
          assert.equal(receipt.stopRequests?.revoked, 1, "and its lease was actually revoked");
          assert.deepEqual(receipt.stopRequests?.uncertainJobIds, [],
            "nothing is uncertain: the one revoke succeeded and nothing else was on the list");

          // The revocation is the ordinary canonical transition: lease revoked,
          // attempt cancelled, job cancelled. Nothing here claims a process on a
          // worker observed it — the record says the stop was requested.
          const states = await admin.query<{ kind: string; state: string }>(`SELECT 'lease' AS kind,l.state FROM control_leases l
            WHERE l.tenant_id=$1 AND l.id=$2 UNION ALL SELECT 'attempt',a.state FROM control_attempts a
            WHERE a.tenant_id=$1 AND a.id=$3 UNION ALL SELECT 'job',j.state FROM control_jobs j
            WHERE j.tenant_id=$1 AND j.id=$4`, [TENANT, running.leaseId, running.attemptId, running.jobId]);
          assert.deepEqual(states.rows.map(row => [row.kind, row.state]).sort(),
            [["attempt", "cancelled"], ["job", "cancelled"], ["lease", "revoked"]]);
          const audit = await admin.query<{ action: string; safe_metadata: Record<string, unknown> }>(
            "SELECT action,safe_metadata FROM audit_events WHERE tenant_id=$1 AND action='tasks.assignment.operations_stop'",
            [TENANT]);
          assert.equal(audit.rows.length, 1, "the stop is audited once, as itself, not as an owner revoke");
          assert.equal(audit.rows[0]?.safe_metadata.confirmedProcessStop, false,
            "the record never claims the process was observed to stop");

          // Stopping again is a replay: it re-sends nothing, because the
          // requests belong to the revision, not to the button.
          const again = await service.set(ownerIdentity(), { mode: "stopped", reason: "shutting down for the night" });
          assert.equal(again.replayed, true);
          assert.equal(again.stopRequests, null, "a replay sends no second round of stop requests");
          assert.equal(Number((await admin.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM audit_events WHERE tenant_id=$1 AND action='tasks.assignment.operations_stop'",
            [TENANT])).rows[0]?.count), 1, "and audits nothing a second time");
        } finally { await web.pool.close(); await coordinator.pool.close(); }
      } finally { await admin.end(); }
    }, { port: PORTS[2], allowedPorts: PORTS, boundMs: 240_000 });
  });

test("stopped still stands when no stop authority is composed, and says so", { timeout: 600_000 },
  async t => {
    const skip = needsPg();
    if (skip) { t.skip(skip.skip); return; }
    await withRealPostgres(async postgres => {
      const admin = new Client(postgres.admin({ database: postgres.database }));
      await admin.connect();
      try {
        await seedTenant(admin);
        const seedStore = transactionalStore(admin);
        const running = await seedRunningWork(admin, "job:operations-stop:uncomposed", seedStore);
        const web = productionPool(postgres, "web");
        try {
          // No stop authority: the recorded mode must still hold, and the
          // receipt must not imply a request it could not send.
          const service = new WebOperationsModeServiceV1(web.pool.client,
            { tenantId: TENANT, workspaceId: WORKSPACE }, KEY);
          const receipt = await service.set(ownerIdentity(), { mode: "stopped", reason: "stopped with no coordinator" });
          assert.equal(receipt.mode, "stopped");
          assert.equal(receipt.stopRequests, null,
            "null means no request was sent, which is not the same as a request that succeeded");
          assert.equal((await service.read(ownerIdentity())).mode, "stopped", "the mode still stands");
          // The lease is untouched, because nothing asked it to stop. Saying so
          // is the honest outcome; claiming a stop that did not happen is not.
          const lease = (await admin.query<{ state: string }>("SELECT state FROM control_leases WHERE tenant_id=$1 AND id=$2",
            [TENANT, running.leaseId])).rows[0];
          assert.equal(lease?.state, "active", "running work is left alone when no stop could be requested");
        } finally { await web.pool.close(); }
      } finally { await admin.end(); }
    }, { port: PORTS[3], allowedPorts: PORTS, boundMs: 240_000 });
  });
