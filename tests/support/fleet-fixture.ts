// Shared seed data for the fleet connector tests: one tenant, two projects,
// an owner with a live web session, and proposed canonical tasks created
// through the canonical store exactly as the web propose path stores them.
import { CanonicalStore } from "../../src/persistence/canonical-store";
import type { DatabaseClient } from "../../src/persistence/database";
import { DOMAIN_CONTRACT_VERSION, type JobRecord, type RequestRecord, type WorkflowRecord } from "../../src/domain/v1";
import { computeAuthorityDigest, sha256Digest } from "../../src/security";
import type { VerifiedWebIdentity } from "../../src/web/v1/access-verifier";

export const FLEET_TENANT = "tenant:fleet";
export const FLEET_WORKSPACE = "workspace:fleet";
export const PROJECT_A = "project:fleet-alpha";
export const PROJECT_B = "project:fleet-beta";
const PROVIDER = "test";
const OWNER = "identity:fleet-owner";
const TOKEN = sha256Digest({ session: "fleet-owner" });

type Query = (sql: string, params?: unknown[]) => Promise<unknown>;

const SESSION = { issuedAt: "", expiresAt: "" };

/** The owner's verified browser identity for the session seeded below. */
export function ownerIdentity(): VerifiedWebIdentity {
  return { provider: PROVIDER, subject: OWNER, tokenDigest: TOKEN, issuedAt: SESSION.issuedAt,
    expiresAt: SESSION.expiresAt, verificationExpiresAt: SESSION.expiresAt };
}

export async function seedFleetTenant(query: Query) {
  SESSION.issuedAt = new Date(Date.now() - 60_000).toISOString();
  SESSION.expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  await query("INSERT INTO tenants(id,display_name) VALUES($1,'Fleet tenant')", [FLEET_TENANT]);
  await query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Fleet')", [FLEET_WORKSPACE, FLEET_TENANT]);
  await query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES('adapter:fleet',$1,'control-room-manual','1.0.0',
    'control_room_native','disabled','v1',30)`, [FLEET_TENANT]);
  for (const project of [PROJECT_A, PROJECT_B]) {
    await query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES($1,$2,$3,'adapter:fleet',$1,'1',$1,'running','fixture','healthy','control_room_native',now(),'{}',now())`,
    [project, FLEET_TENANT, FLEET_WORKSPACE]);
    await query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
      VALUES($1,$2,'active',1,now(),now())`, [FLEET_TENANT, project]);
  }
  await query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,
    state,created_at,updated_at) VALUES($1,$2,'human','Owner',$3,$4,'active',$5,$5)`,
  [OWNER, FLEET_TENANT, PROVIDER, sha256Digest({ provider: PROVIDER, subject: OWNER }), SESSION.issuedAt]);
  await query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,
    allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:fleet-owner',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,
  [FLEET_TENANT, OWNER, SESSION.issuedAt]);
  await query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`, [FLEET_TENANT, TOKEN, OWNER, SESSION.issuedAt, SESSION.expiresAt]);
  await query(`INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1) ON CONFLICT DO NOTHING`, [FLEET_TENANT]);
}

/** One proposed task: draft request, proposed workflow, proposed job. */
export async function seedProposedTask(db: DatabaseClient, projectId: string, name: string, options: {
  maxDurationSeconds?: number } = {}) {
  const now = new Date().toISOString(), store = new CanonicalStore(db);
  const requestId = `request:${name}`, workflowId = `workflow:${name}`, jobId = `job:${name}`;
  const request: RequestRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "request", id: requestId,
    tenantId: FLEET_TENANT, version: 0, createdAt: now, updatedAt: now, projectId, title: `Task ${name}`,
    objective: `Write a short note for ${name}.`, state: "draft", priority: 50,
    requestedBy: { actorId: OWNER, actorType: "human" }, idempotencyKey: `request-key-${name}` };
  const workflow: WorkflowRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "workflow", id: workflowId,
    tenantId: FLEET_TENANT, version: 0, createdAt: now, updatedAt: now, requestId, projectId,
    definitionVersion: "fleet-test/v1", definitionDigest: sha256Digest({ name }), authorityMode: "control_room_native",
    state: "proposed", jobIds: [jobId] };
  const authority = { projectId, allowedExecutor: "executor:any-fleet", allowedOperations: ["task.run"],
    credentialRefs: [], filesystemRoots: [], networkPolicy: "none" as const, allowedNetworkDestinations: [],
    effectPolicy: "none" as const, maxRisk: "low" as const, maxDurationSeconds: options.maxDurationSeconds ?? 7200,
    maxConcurrentEffects: 0, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  const job: JobRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "job", id: jobId, tenantId: FLEET_TENANT,
    version: 0, createdAt: now, updatedAt: now, workflowId, projectId, jobType: "fleet.task", specVersion: "fleet-test/v1",
    inputDigest: sha256Digest({ name, input: true }), state: "proposed", priority: 50, requiredCapability: "task.generic",
    dependsOnJobIds: [], authority: { ...authority, digest: computeAuthorityDigest(authority as never) },
    retryPolicy: { maxAttempts: 5, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: true,
      ambiguousEffectPolicy: "attention" } };
  await store.create(request); await store.create(workflow); await store.create(job);
  return { requestId, workflowId, jobId };
}
