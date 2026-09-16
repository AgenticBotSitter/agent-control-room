// Disposable test fixture for the project-coordination HTTP service.
//
// The fixture stands up:
//   * a PGlite database with all migrations applied and a single owner
//     identity seeded through SecurityStore.bootstrapOwner, so the
//     WebSessionAuthority.authenticated path runs for real;
//   * an in-memory ProjectCoordinationCanonicalStoreAdapter so the coordinator
//     lifecycle calls run against a controllable fake;
//   * a hand-rolled JWKS-equivalent access-trust and identity verifier that
//     mirrors the existing tests/project-template-http.test.ts shape;
//   * the ProjectCoordinationHttpService composed against the above.
//
// Tests use it to exercise every refusal and every accepted lifecycle step
// without depending on the canonical store, migrations of coordination tables,
// or real owner grants from a Cloudflare token.

import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

import { adaptPglite } from "../src/persistence/database";
import { SecurityStore } from "../src/security/security-store";
import { createAccessVerifier, type AccessTrust } from "../src/web/v1/access-verifier";
import { ProjectCoordinationHttpService, createProjectCoordinationCanonicalStoreAdapterV1, type ProjectCoordinationCanonicalStoreAdapter } from "../src/web/v1/project-coordination-http";
import { createCoordinationHttpHandler } from "../src/web/v1/coordination-http";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { ProjectCoordinationErrorV1 } from "../src/project-coordination/v1/errors";
import type { ProjectCoordinationCanonicalPortV1 } from "../src/project-coordination/v1/services";
import type { CoordinatorLifecycleReceiptV1, DelegationPolicyLifecycleReceiptV1 } from "../src/project-coordination/v1/schemas";
import { delegationPolicyLifecycleRequestDigestV1 } from "../src/project-coordination/v1/schemas";
import { sha256Digest } from "../src/security/digest";

interface FixtureOptions {
  now: number;
  ownerIdentityId?: string;
  withPolicy?: boolean;
  coordinationEnabled?: boolean;
}

interface CoordinatorHeadRow {
  state: "active" | "revoked";
  version: number;
  coordinatorActorType: "human" | "agent";
  coordinatorIdentityId: string;
  executorId?: string;
  adapterId?: string;
  connectorProfileDigest?: string;
  executionBindingDigest?: string;
  occurredAt: string;
  ownerIdentityId: string;
}

interface DelegationPolicyRow {
  policyId: string;
  state: "active" | "paused" | "revoked";
  coordinatorVersion: number;
  ownerIdentityId: string;
}

interface ProjectLookupRow {
  projectId: string;
  title: string;
  summary: string;
  lifecycle: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const FIXTURE_ORIGIN = "https://private.example.invalid";
const FIXTURE_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const FIXTURE_OWNER_SUBJECT = "test-owner";
const FIXTURE_TRUST: AccessTrust = (() => {
  const audience = "test-app";
  return {
    issuer: "https://access.example.invalid",
    audience,
    keys: [{ kid: "test-public-key", jwk: FIXTURE_KEYS.publicKey.export({ format: "jwk" }) }],
    validUntilMs: 0, // Updated per-fixture
    maxSessionSeconds: 604800,
  };
})();

function makeToken(trust: AccessTrust, now: number, subject: string, audience: string) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-public-key" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: trust.issuer, aud: [audience], sub: subject, type: "app",
    iat: now / 1000 - 60, exp: now / 1000 + 300,
  })).toString("base64url");
  return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), FIXTURE_KEYS.privateKey).toString("base64url")}`;
}

export async function projectCoordinationHttpFixture(options: FixtureOptions) {
  const trust: AccessTrust = { ...FIXTURE_TRUST, validUntilMs: options.now + 3600_000 };
  const subject = options.ownerIdentityId ?? FIXTURE_OWNER_SUBJECT;
  const token = makeToken(trust, options.now, subject, trust.audience);
  const verifier = createAccessVerifier(trust);
  const identity: VerifiedWebIdentity = verifier(
    new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example`, { method: "GET",
      headers: { "cf-access-jwt-assertion": token, origin: FIXTURE_ORIGIN } }),
    options.now,
  );

  // Real PGlite with all migrations applied — WebSessionAuthority.authenticated
  // needs the real control_identities / control_web_sessions tables.
  const db = new PGlite();
  for (const file of (await readdir("db/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(await readFile(`db/migrations/${file}`, "utf8"));
  }
  await db.query("INSERT INTO tenants(id,display_name) VALUES('tenant:test','Test tenant')");
  await db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','Test workspace')");
  const client = adaptPglite(db);

  const ownerIdentityId = options.ownerIdentityId ?? "identity:test";
  await new SecurityStore(client).bootstrapOwner({
    tenantId: "tenant:test",
    provider: trust.issuer,
    subject,
    identityId: ownerIdentityId,
    grantId: "grant:test",
    displayName: "Test owner",
    verifiedAt: new Date(options.now - 60_000).toISOString(),
    expiresAt: new Date(options.now + 300_000).toISOString(),
    now: new Date(options.now).toISOString(),
  });

  const headRows = new Map<string, CoordinatorHeadRow>();
  // Same durable receipt ledger as the route-test fixture.
  const lifecycleReceipts = new Map<string, { contentKey: string; receipt: CoordinatorLifecycleReceiptV1 }>();
  const policyReceipts = new Map<string, { contentKey: string; receipt: DelegationPolicyLifecycleReceiptV1 }>();
  const policyRows = new Map<string, DelegationPolicyRow>();
  const policyByProject = new Map<string, DelegationPolicyRow>();
  const projects = new Map<string, ProjectLookupRow>([["project:example", {
    projectId: "project:example",
    title: "Example project",
    summary: "Example",
    lifecycle: "active",
    version: 1,
    createdAt: new Date(options.now - 60_000).toISOString(),
    updatedAt: new Date(options.now - 60_000).toISOString(),
  }]]);

  if (options.withPolicy) {
    const policyId = `policy:${Math.random().toString(16).slice(2, 10)}`;
    const row: DelegationPolicyRow = {
      policyId,
      state: "active",
      coordinatorVersion: 1,
      ownerIdentityId,
    };
    policyRows.set(policyId, row);
    policyByProject.set("project:example", row);
  }

  const port: ProjectCoordinationCanonicalPortV1 = {
    async assignProjectCoordinatorV1(input) {
      // Mirrors the merged canonical receipt semantics (see the route-test
      // fixture): ledger probe first, then expected-version enforcement.
      const contentKey = JSON.stringify({
        operation: input.operation,
        appointment: input.appointment,
        expectedVersion: input.expectedVersion,
        executionBindingDigest: input.executionBindingDigest ?? null,
      });
      const prior = lifecycleReceipts.get(input.idempotencyKey);
      if (prior) {
        if (prior.contentKey !== contentKey) {
          throw new ProjectCoordinationErrorV1("coordinator_replay_conflict" as never);
        }
        return { ...prior.receipt, replayed: true as const };
      }
      const headVersion = headRows.get(input.appointment.projectId)?.version ?? 0;
      if (input.expectedVersion !== headVersion) {
        throw new ProjectCoordinationErrorV1("coordinator_version_stale" as never);
      }
      const buildReceipt = (version: number, state: "active" | "revoked") => {
        const body = {
          schema: "control-room.project-coordinator-lifecycle-receipt/v1" as const,
          operation: input.operation,
          tenantId: input.appointment.tenantId,
          projectId: input.appointment.projectId,
          idempotencyKey: input.idempotencyKey,
          requestDigest: input.requestDigest,
          expectedVersion: input.expectedVersion,
          version,
          state,
        };
        return { ...body, receiptDigest: sha256Digest(body) };
      };
      if (input.operation === "revoke") {
        const existing = headRows.get(input.appointment.projectId);
        if (!existing) throw new ProjectCoordinationErrorV1("coordinator_absent" as never);
        const next: CoordinatorHeadRow = { ...existing, state: "revoked" };
        headRows.set(input.appointment.projectId, next);
        const receipt = buildReceipt(existing.version, "revoked");
        lifecycleReceipts.set(input.idempotencyKey, { contentKey, receipt });
        return { ...receipt, replayed: false as const };
      }
      const existing = headRows.get(input.appointment.projectId);
      const version = (existing?.version ?? 0) + 1;
      const row: CoordinatorHeadRow = {
        state: "active",
        version,
        coordinatorActorType: input.appointment.coordinatorActorType,
        coordinatorIdentityId: input.appointment.coordinatorIdentityId,
        executorId: input.appointment.executorId,
        adapterId: input.appointment.adapterId,
        connectorProfileDigest: input.appointment.connectorProfileDigest,
        executionBindingDigest: input.executionBindingDigest,
        occurredAt: input.appointment.occurredAt,
        ownerIdentityId: input.appointment.ownerIdentityId,
      };
      headRows.set(input.appointment.projectId, row);
      const receipt = buildReceipt(version, "active");
      lifecycleReceipts.set(input.idempotencyKey, { contentKey, receipt });
      return { ...receipt, replayed: false as const };
    },
    async findDelegationPolicyLifecycleReceiptV1(input) {
      const prior = policyReceipts.get(input.idempotencyKey);
      if (!prior) return undefined;
      if (prior.receipt.requestDigest !== input.requestDigest) {
        throw new ProjectCoordinationErrorV1("policy_replay_conflict" as never);
      }
      return { ...prior.receipt, replayed: true as const };
    },
    async setProjectDelegationPolicyStateDurableV1(input) {
      // Mirrors the canonical policy receipt semantics: the expected digest
      // is recomputed, the per-key ledger is probed first (exact retry
      // returns the saved receipt), then the expected version is enforced
      // and the prepared mutation runs at most once per key.
      const expectedDigest = delegationPolicyLifecycleRequestDigestV1({ action: input.action,
        tenantId: input.tenantId, projectId: input.projectId, policyId: input.policyId,
        ownerIdentityId: input.ownerIdentityId, expectedVersion: input.expectedVersion,
        expectedCoordinatorVersion: input.expectedCoordinatorVersion,
        expectedConflictsVersion: input.expectedConflictsVersion,
        expectedAttentionVersion: input.expectedAttentionVersion });
      if (expectedDigest !== input.requestDigest) {
        throw new ProjectCoordinationErrorV1("invalid_input" as never);
      }
      const contentKey = JSON.stringify({ action: input.action, tenantId: input.tenantId,
        projectId: input.projectId, policyId: input.policyId, ownerIdentityId: input.ownerIdentityId,
        expectedVersion: input.expectedVersion });
      const prior = policyReceipts.get(input.idempotencyKey);
      if (prior) {
        if (prior.contentKey !== contentKey) {
          throw new ProjectCoordinationErrorV1("policy_replay_conflict" as never);
        }
        return { ...prior.receipt, replayed: true as const };
      }
      const toState = input.action === "revoke" ? "revoked" as const
        : input.action === "resume" ? "active" as const : "paused" as const;
      const alreadyState = toState === "paused" ? "policy_already_paused" as const
        : toState === "active" ? "policy_already_active" as const
        : "policy_already_revoked" as const;
      const buildReceipt = (version: number, state: "active" | "paused" | "revoked",
        already: typeof alreadyState | undefined) => {
        const body = {
          schema: "control-room.project-delegation-policy-lifecycle-receipt/v1" as const,
          action: input.action,
          tenantId: input.tenantId,
          projectId: input.projectId,
          policyId: input.policyId,
          ownerIdentityId: input.ownerIdentityId,
          idempotencyKey: input.idempotencyKey,
          requestDigest: input.requestDigest,
          expectedVersion: input.expectedVersion,
          version,
          state,
          ...(already ? { alreadyState: already } : {}),
        };
        return { ...body, receiptDigest: sha256Digest(body) };
      };
      const existing = policyRows.get(input.policyId);
      if (!existing) throw new ProjectCoordinationErrorV1("policy_required" as never);
      // Only an exact saved-receipt replay (handled above) may bypass the
      // version guard: a fresh key with a stale version is refused even when
      // the policy already names the target state.
      if (existing.state === toState && existing.coordinatorVersion !== input.expectedVersion) {
        throw new ProjectCoordinationErrorV1("policy_version_stale" as never);
      }
      if (existing.state === toState) {
        const receipt = buildReceipt(existing.coordinatorVersion, toState, alreadyState);
        policyReceipts.set(input.idempotencyKey, { contentKey, receipt });
        return { ...receipt, replayed: false as const };
      }
      if (existing.state === "revoked") throw new ProjectCoordinationErrorV1("policy_revoked" as never);
      if (existing.coordinatorVersion !== input.expectedVersion) {
        throw new ProjectCoordinationErrorV1("policy_version_stale" as never);
      }
      const next: DelegationPolicyRow = {
        ...existing,
        state: toState,
        coordinatorVersion: existing.coordinatorVersion + 1,
        ownerIdentityId: input.ownerIdentityId,
      };
      policyRows.set(input.policyId, next);
      if (policyByProject.get(input.projectId)?.policyId === input.policyId) {
        policyByProject.set(input.projectId, next);
      }
      const receipt = buildReceipt(next.coordinatorVersion, toState, undefined);
      policyReceipts.set(input.idempotencyKey, { contentKey, receipt });
      return { ...receipt, replayed: false as const };
    },
    async recordProjectCoordinationProposalV1() {
      throw new Error("not used by http lifecycle tests");
    },
    async loadAcceptedProjectCoordinationProposalV1() {
      throw new Error("not used by http lifecycle tests");
    },
    async findCommittedProjectCoordinationAdoptionV1() {
      throw new Error("not used by http lifecycle tests");
    },
    async adoptProjectCoordinationProposalV1() {
      throw new Error("not used by http lifecycle tests");
    },
    async admitProjectWorkResourcesV1() {
      throw new Error("not used by http lifecycle tests");
    },
    async recheckProjectWorkResourceAdmissionV1() {
      throw new Error("not used by http lifecycle tests");
    },
    async retireProjectWorkResourceAdmissionV1() {
      throw new Error("not used by http lifecycle tests");
    },
  };

  const store: ProjectCoordinationCanonicalStoreAdapter = {
    coordinator: port,
    async coordinatorVersion(projectId) {
      return headRows.get(projectId)?.version ?? 0;
    },
    async readActiveHead(projectId) {
      const row = headRows.get(projectId);
      if (!row || row.state === "revoked") return null;
      return {
        tenantId: "tenant:test",
        projectId,
        version: row.version,
        state: row.state,
        coordinatorActorType: row.coordinatorActorType,
        coordinatorIdentityId: row.coordinatorIdentityId,
        executorId: row.executorId ?? null,
        adapterId: row.adapterId ?? null,
        connectorProfileDigest: row.connectorProfileDigest ?? null,
        executionBindingDigest: row.executionBindingDigest ?? null,
        appointedAt: row.occurredAt,
        appointedByOwnerIdentityId: row.ownerIdentityId,
      };
    },
    async policyVersion(projectId) {
      return policyByProject.get(projectId)?.coordinatorVersion ?? 0;
    },
    async readDelegationPolicySummary(projectId) {
      const row = policyByProject.get(projectId);
      if (!row) return null;
      return {
        tenantId: "tenant:test",
        projectId,
        policyId: row.policyId,
        coordinatorVersion: row.coordinatorVersion,
        state: row.state,
        allowedActions: ["maintain.active-work", "manage.dependencies"],
        validFrom: new Date(options.now - 60_000).toISOString(),
        validUntil: new Date(options.now + 60_000 * 60 * 24 * 7).toISOString(),
        taskAllowance: 10,
        taskUnitsUsed: 0,
        microUsdCeiling: "1000000",
        microUsdUsed: "0",
        concurrencyAllowance: 4,
        concurrencyUnitsUsed: 0,
      };
    },
    async conflictsVersion(_projectId) {
      return 0;
    },
    async attentionVersion(_projectId) {
      return 0;
    },
    async readActiveWork(_projectId) {
      // Fakes-only baseline: the fixture does not yet model a real
      // active-work ledger. The composition surface is wired so the real
      // canonical store can drop in via this hook.
      return [];
    },
    async readDependencies(_projectId) {
      return [];
    },
    async readConflicts(_projectId) {
      return [];
    },
    async readAttention(_projectId) {
      return [];
    },
    async project(projectId) {
      const project = projects.get(projectId);
      if (!project) throw new Error("not_found");
      return project;
    },
    async coordinationEnabled() {
      return options.coordinationEnabled ?? true;
    },
  };

  const service = new ProjectCoordinationHttpService({
    database: client,
    scope: { tenantId: "tenant:test", workspaceId: "workspace:test" },
    clock: () => options.now,
    store,
  });

  return {
    identity,
    service,
    headRows,
    policyRows,
    dispose() {
      void db.close();
    },
  };
}

/**
 * A real route fixture for the policy durability proofs. It intentionally uses
 * the production adapter and its bindSession hook over PGlite, then exposes the
 * Fetch handler through a real Node HTTP listener. The old fixture above stays
 * focused on the legacy service-only cases.
 */
export async function composedProjectCoordinationHttpFixture(now: number) {
  const raw = new PGlite();
  for (const file of (await readdir("db/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
  }
  const db = adaptPglite(raw);
  const iso = new Date(now).toISOString();
  const digest = (value: unknown) => sha256Digest(value);
  await raw.query("INSERT INTO tenants(id,display_name) VALUES('tenant:test','Test tenant')");
  await raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','Test workspace')");
  await raw.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES('adapter:test','tenant:test','fixture','1.0.0','control_room_native','disabled','v1',30)`);
  await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
    normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES('project:example','tenant:test','workspace:test','adapter:test','project:example','1','Example','Example',
      'running','fixture','healthy','control_room_native',$1,'{}',$1)`, [iso]);
  await raw.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES('tenant:test','project:example','active',1,$1,$1)`, [iso]);

  const trust: AccessTrust = { ...FIXTURE_TRUST, validUntilMs: now + 3_600_000 };
  const token = makeToken(trust, now, FIXTURE_OWNER_SUBJECT, trust.audience);
  await new SecurityStore(db).bootstrapOwner({
    tenantId: "tenant:test", provider: trust.issuer, subject: FIXTURE_OWNER_SUBJECT,
    identityId: "identity:test", grantId: "grant:test", displayName: "Test owner",
    verifiedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 300_000).toISOString(), now: iso,
  });
  await raw.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:other','tenant:test','human','Other','fixture',$1,'active',$2,$2)`,
    [sha256Digest({ subject: "other" }), iso]);
  await raw.query(`INSERT INTO control_project_coordinator_heads
    (tenant_id,project_id,state,coordinator_identity_id,coordinator_actor_type,assigned_by_owner_identity_id,version,assigned_at,updated_at,payload)
    VALUES('tenant:test','project:example','active','identity:test','human','identity:test',1,$1,$1,'{}')`, [iso]);
  const policyId = "policy:composed";
  const policyDigest = digest({ policyId, fixture: "composed" });
  const ownerDigest = digest({ identityId: "identity:test" });
  await raw.query(`INSERT INTO control_project_delegation_policies
    (tenant_id,id,project_id,coordinator_identity_id,coordinator_version,state,version,policy_digest,
     owner_identity_id,owner_identity_digest,allowed_actions,eligible_routes,risk_ceiling,effect_ceiling,
     max_total_tasks,max_total_cost_microusd,max_concurrent_tasks,valid_from,valid_until,payload,created_at,updated_at)
    VALUES('tenant:test',$1,'project:example','identity:test',1,'active',1,$2,'identity:test',$3,
      '["proposal.adopt"]','["executor:agent"]','low','none',8,1000000,8,$4,$5,'{}',$4,$4)`,
    [policyId, policyDigest, ownerDigest, iso, new Date(now + 3_600_000).toISOString()]);

  const store = createProjectCoordinationCanonicalStoreAdapterV1({ database: db, tenantId: "tenant:test", now: () => now });
  const service = new ProjectCoordinationHttpService({ database: db, scope: { tenantId: "tenant:test", workspaceId: "workspace:test" },
    clock: () => now, store });
  const handler = createCoordinationHttpHandler({ origin: FIXTURE_ORIGIN, trust, service, clock: () => now });
  const server = createServer(async (req, res) => {
    try {
      const request = new Request(`${FIXTURE_ORIGIN}${req.url ?? "/"}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: Readable.toWeb(req) as ReadableStream, duplex: "half" as const }),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_http_listen_failed");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { origin: FIXTURE_ORIGIN, "cf-access-jwt-assertion": token, "content-type": "application/json" };
  const request = async (path: string, body: object, idempotencyKey: string) => {
    const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { ...headers, "idempotency-key": idempotencyKey }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const read = async () => {
    const response = await fetch(`${baseUrl}/api/v1/projects/project%3Aexample/coordination`, { headers });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const revision = (page: Record<string, unknown>) => {
    const versions = page.versions as Record<string, number>;
    return { projectId: "project:example", expectedCoordinatorVersion: versions.coordinatorVersion,
      expectedPolicyVersion: versions.policyVersion, expectedConflictsVersion: versions.conflictsVersion,
      expectedAttentionVersion: versions.attentionVersion, observedAt: page.observedAt as string };
  };
  const addAttention = async (suffix: string) => raw.query(`INSERT INTO attention_items
    (id,tenant_id,workspace_id,project_id,work_item_id,adapter_id,source_record_id,source_version,attention_type,
     title,summary,due_at,created_at_source,observed_at,payload,updated_at)
    VALUES($1,'tenant:test','workspace:test','project:example',NULL,'adapter:test',$2,'1','approval',
      'Attention','Attention',NULL,$3,$3,'{}',$3)`, [`attention:${suffix}`, `source:${suffix}`, iso]);
  const addConflict = async () => {
    const d = `sha256:${"a".repeat(64)}`;
    const nodePayload = JSON.stringify({ id: "node:conflict", tenantId: "tenant:test", state: "active", version: 1, identityKeyId: "key:conflict" });
    await raw.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
      VALUES('node:conflict','tenant:test','active',1,'key:conflict',$1::jsonb,$2,$2)`, [nodePayload, iso]);
    const requestPayload = JSON.stringify({ id: "request:conflict", tenantId: "tenant:test", state: "accepted", version: 1, projectId: "project:example", idempotencyKey: "request-conflict-key" });
    await raw.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
      VALUES('request:conflict','tenant:test','project:example','accepted',1,'request-conflict-key',$1::jsonb,$2,$2)`, [requestPayload, iso]);
    const workflowPayload = JSON.stringify({ id: "workflow:conflict", tenantId: "tenant:test", state: "active", version: 1, requestId: "request:conflict", projectId: "project:example", definitionDigest: d });
    await raw.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
      VALUES('workflow:conflict','tenant:test','request:conflict','project:example',$1,'active',1,$2::jsonb,$3,$3)`, [d, workflowPayload, iso]);
    for (const n of [1, 2]) {
      const jobId = `job:conflict:${n}`, attemptId = `attempt:conflict:${n}`, leaseId = `lease:conflict:${n}`;
      const jobPayload = JSON.stringify({ id: jobId, tenantId: "tenant:test", state: "running", version: 1, workflowId: "workflow:conflict", projectId: "project:example", priority: 1, requiredCapability: "fixture", authority: { digest: d } });
      await raw.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at)
        VALUES($1,'tenant:test','workflow:conflict','project:example','running',1,1,'fixture',$2,$3::jsonb,$4,$4)`, [jobId, d, jobPayload, iso]);
      const attemptPayload = JSON.stringify({ id: attemptId, tenantId: "tenant:test", state: "running", version: 1, jobId, attemptNumber: 1, workerId: "worker:conflict", nodeId: "node:conflict", leaseEpoch: 1 });
      await raw.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,lease_epoch,payload,created_at,updated_at)
        VALUES($1,'tenant:test',$2,1,'running',1,'worker:conflict','node:conflict',1,$3::jsonb,$4,$4)`, [attemptId, jobId, attemptPayload, iso]);
      const expiresAt = new Date(now + 600_000).toISOString();
      const leasePayload = JSON.stringify({ id: leaseId, tenantId: "tenant:test", state: "active", version: 1, jobId, attemptId, nodeId: "node:conflict", epoch: 1, acquiredAt: iso, expiresAt });
      await raw.query(`INSERT INTO control_leases(id,tenant_id,job_id,attempt_id,node_id,epoch,state,version,acquired_at,expires_at,payload,created_at,updated_at)
        VALUES($1,'tenant:test',$2,$3,'node:conflict',1,'active',1,$4,$5,$6::jsonb,$4,$4)`, [leaseId, jobId, attemptId, iso, expiresAt, leasePayload]);
    }
    await raw.query(`INSERT INTO control_work_resources(tenant_id,id,kind,canonical_key,comparison_key,configuration_digest,payload,created_at)
      VALUES('tenant:test','resource:conflict','repository','repo:conflict','repo:conflict',$1,'{}',$2)`, [d, iso]);
    for (const n of [1, 2]) {
      await raw.query(`INSERT INTO control_attempt_resource_admissions
        (tenant_id,id,project_id,job_id,attempt_id,lease_id,node_id,repository_resource_id,base_revision,
         workspace_intent_digest,declaration_digest,state,version,acquired_at,payload)
        VALUES('tenant:test',$1,'project:example',$2,$3,$4,'node:conflict','resource:conflict','base:1',$5,$5,'held',1,$6,'{}')`,
        [`admission:conflict:${n}`, `job:conflict:${n}`, `attempt:conflict:${n}`, `lease:conflict:${n}`, d, new Date(now + n).toISOString()]);
      await raw.query(`INSERT INTO control_attempt_resource_scopes(tenant_id,admission_id,resource_id,access_mode,scope_kind,path,path_fold)
        VALUES('tenant:test',$1,'resource:conflict','write','tree','src','src')`, [`admission:conflict:${n}`]);
    }
  };
  return {
    db: raw, policyId, request, read, revision, addAttention, addConflict,
    async dispose() { await new Promise<void>((resolve) => server.close(() => resolve())); await raw.close(); },
  };
}
