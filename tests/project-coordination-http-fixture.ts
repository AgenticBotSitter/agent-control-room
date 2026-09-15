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
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

import { adaptPglite } from "../src/persistence/database";
import { SecurityStore } from "../src/security/security-store";
import { createAccessVerifier, type AccessTrust } from "../src/web/v1/access-verifier";
import { ProjectCoordinationHttpService, type ProjectCoordinationCanonicalStoreAdapter } from "../src/web/v1/project-coordination-http";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { ProjectCoordinationErrorV1 } from "../src/project-coordination/v1/errors";
import type { ProjectCoordinationCanonicalPortV1 } from "../src/project-coordination/v1/services";
import type { CoordinatorLifecycleReceiptV1 } from "../src/project-coordination/v1/schemas";
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
  const policyRows = new Map<string, DelegationPolicyRow>();
  const policyByProject = new Map<string, DelegationPolicyRow>();
  const attentionByProject = new Map<string, number>();
  const conflictsByProject = new Map<string, number>();

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
    async setProjectDelegationPolicyStateV1(input) {
      const existing = policyRows.get(input.policyId);
      if (!existing) throw new ProjectCoordinationErrorV1("policy_required" as never);
      if (input.toState === "active" && existing.state === "active") throw new ProjectCoordinationErrorV1("policy_already_active" as never);
      if (input.toState === "paused" && existing.state === "paused") throw new ProjectCoordinationErrorV1("policy_already_paused" as never);
      if (input.toState === "revoked" && existing.state === "revoked") throw new ProjectCoordinationErrorV1("policy_already_revoked" as never);
      const next: DelegationPolicyRow = {
        ...existing,
        state: input.toState,
        coordinatorVersion: existing.coordinatorVersion + 1,
        ownerIdentityId: input.ownerIdentityId,
      };
      policyRows.set(input.policyId, next);
      if (policyByProject.get(input.projectId)?.policyId === input.policyId) {
        policyByProject.set(input.projectId, next);
      }
      return { version: next.coordinatorVersion, state: input.toState };
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
    async conflictsVersion(projectId) {
      return conflictsByProject.get(projectId) ?? 0;
    },
    async attentionVersion(projectId) {
      return attentionByProject.get(projectId) ?? 0;
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
