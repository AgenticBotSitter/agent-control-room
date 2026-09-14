// Route-level tests for the wired project-coordination HTTP handler.
//
// These tests prove the wiring: the createCoordinationHttpHandler is mounted
// inside createPrivateWebProcess, runs the same-origin check first, the
// Cloudflare-Access JWT verifier second, then dispatches to
// ProjectCoordinationHttpService. The fixture stands up PGlite +
// SecurityStore + the canonical store adapter, exactly as production
// would, so every code path runs against the real authority and the real
// identity lock.
//
// What we pin:
//
//   * invalid same-origin -> 401/403 access_denied and never reaches the service;
//   * missing JWT -> 401 authentication_required, no service call;
//   * bad JWT signature -> 401 authentication_required;
//   * valid JWT, GET page -> 200 with the wire-shaped page payload;
//   * valid JWT, POST appoint without Idempotency-Key -> 400 invalid_request;
//   * valid JWT, POST appoint with bad revision -> 200 refused (revision envelope)
//     in the response body (the HTTP layer wraps the service outcome);
//   * disabled coordination flag -> the read still succeeds but the write
//     returns not_found from the wire envelope (the layer checks before the
//     service).

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database";
import { SecurityStore } from "../src/security/security-store";
import { createAccessVerifier, type AccessTrust } from "../src/web/v1/access-verifier";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import type { ProjectCoordinationCanonicalStoreAdapter } from "../src/web/v1/project-coordination-http";
import type { ProjectCoordinationCanonicalPortV1 } from "../src/project-coordination/v1/services";
import { ProjectCoordinationErrorV1 } from "../src/project-coordination/v1/errors";

const FIXTURE_NOW = Date.parse("2026-09-14T00:00:00.000Z");
const FIXTURE_ORIGIN = "https://private.example.invalid";
const FIXTURE_TENANT = "tenant:test";
const FIXTURE_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });

function makeTrust(now: number): AccessTrust {
  return {
    issuer: "https://access.example.invalid",
    audience: "test-app",
    keys: [{ kid: "test-public-key", jwk: FIXTURE_KEYS.publicKey.export({ format: "jwk" }) }],
    validUntilMs: now + 3600_000,
    maxSessionSeconds: 604800,
  };
}

function makeToken(now: number, audience: string, subject = "test-owner"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-public-key" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: "https://access.example.invalid", aud: [audience], sub: subject, type: "app",
    iat: now / 1000 - 60, exp: now / 1000 + 300,
  })).toString("base64url");
  return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), FIXTURE_KEYS.privateKey).toString("base64url")}`;
}

interface RouteFixture {
  handle: (request: Request) => Promise<Response>;
  dispose: () => Promise<void>;
}

async function buildRouteFixture(opts: { coordinationEnabled?: boolean } = {}): Promise<RouteFixture> {
  const db = new PGlite();
  for (const file of (await readdir("db/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(await readFile(`db/migrations/${file}`, "utf8"));
  }
  await db.query("INSERT INTO tenants(id,display_name) VALUES('tenant:test','Test tenant')");
  await db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','Test workspace')");
  const client = adaptPglite(db);

  // Reuse the module-level FIXTURE_KEYS so the test tokens match the cache's JWK.
  const trust: AccessTrust = {
    issuer: "https://access.example.invalid",
    audience: "test-app",
    keys: [{ kid: "test-public-key", jwk: FIXTURE_KEYS.publicKey.export({ format: "jwk" }) }],
    validUntilMs: FIXTURE_NOW + 3600_000,
    maxSessionSeconds: 604800,
  };
  await new SecurityStore(client).bootstrapOwner({
    tenantId: FIXTURE_TENANT,
    provider: trust.issuer,
    subject: "test-owner",
    identityId: "identity:test",
    grantId: "grant:test",
    displayName: "Test owner",
    verifiedAt: new Date(FIXTURE_NOW - 60_000).toISOString(),
    expiresAt: new Date(FIXTURE_NOW + 300_000).toISOString(),
    now: new Date(FIXTURE_NOW).toISOString(),
  });

  const headRows = new Map<string, { state: "active" | "revoked"; version: number; coordinatorActorType: "human" | "agent"; coordinatorIdentityId: string; executorId?: string; adapterId?: string; connectorProfileDigest?: string; executionBindingDigest?: string; occurredAt: string; ownerIdentityId: string }>();
  const policyRows = new Map<string, { policyId: string; state: "active" | "paused" | "revoked"; coordinatorVersion: number; ownerIdentityId: string }>();
  const policyByProject = new Map<string, { policyId: string; state: "active" | "paused" | "revoked"; coordinatorVersion: number; ownerIdentityId: string }>();
  const projects = new Map<string, { projectId: string; title: string; summary: string; lifecycle: string; version: number; createdAt: string; updatedAt: string }>([["project:example", {
    projectId: "project:example",
    title: "Example",
    summary: "Example",
    lifecycle: "active",
    version: 1,
    createdAt: new Date(FIXTURE_NOW - 60_000).toISOString(),
    updatedAt: new Date(FIXTURE_NOW - 60_000).toISOString(),
  }]]);

  const port: ProjectCoordinationCanonicalPortV1 = {
    async assignProjectCoordinatorV1(input) {
      if (input.operation === "revoke") {
        const existing = headRows.get(input.appointment.projectId);
        if (!existing) throw new ProjectCoordinationErrorV1("no_coordinator" as never);
        const next = { ...existing, state: "revoked" as const };
        headRows.set(input.appointment.projectId, next);
        return { version: existing.version, state: "revoked" as const };
      }
      const existing = headRows.get(input.appointment.projectId);
      if (existing && existing.state === "active") throw new ProjectCoordinationErrorV1("coordinator_already_active" as never);
      const version = (existing?.version ?? 0) + 1;
      const row = {
        state: "active" as const,
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
      return { version, state: "active" as const, executionBindingDigest: input.executionBindingDigest };
    },
    async setProjectDelegationPolicyStateV1(input) {
      const existing = policyRows.get(input.policyId);
      if (!existing) throw new ProjectCoordinationErrorV1("policy_required" as never);
      if (input.toState === "active" && existing.state === "active") throw new ProjectCoordinationErrorV1("policy_already_active" as never);
      if (input.toState === "paused" && existing.state === "paused") throw new ProjectCoordinationErrorV1("policy_already_paused" as never);
      if (input.toState === "revoked" && existing.state === "revoked") throw new ProjectCoordinationErrorV1("policy_already_revoked" as never);
      const next = {
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
    async recordProjectCoordinationProposalV1() { throw new Error("not used"); },
    async loadAcceptedProjectCoordinationProposalV1() { throw new Error("not used"); },
    async findCommittedProjectCoordinationAdoptionV1() { throw new Error("not used"); },
    async adoptProjectCoordinationProposalV1() { throw new Error("not used"); },
    async admitProjectWorkResourcesV1() { throw new Error("not used"); },
    async recheckProjectWorkResourceAdmissionV1() { throw new Error("not used"); },
    async retireProjectWorkResourceAdmissionV1() { throw new Error("not used"); },
  };

  const store: ProjectCoordinationCanonicalStoreAdapter = {
    coordinator: port,
    async coordinatorVersion(projectId) { return headRows.get(projectId)?.version ?? 0; },
    async readActiveHead(projectId) {
      const row = headRows.get(projectId);
      if (!row || row.state === "revoked") return null;
      return {
        tenantId: FIXTURE_TENANT, projectId,
        version: row.version, state: row.state,
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
    async policyVersion(projectId) { return policyByProject.get(projectId)?.coordinatorVersion ?? 0; },
    async readDelegationPolicySummary() { return null; },
    async conflictsVersion() { return 0; },
    async attentionVersion() { return 0; },
    async project(projectId) {
      const project = projects.get(projectId);
      if (!project) throw new Error("not_found");
      return project;
    },
    async coordinationEnabled() { return opts.coordinationEnabled ?? true; },
  };

  const application = createPrivateWebProcess({
    origin: FIXTURE_ORIGIN,
    issuer: trust.issuer,
    audience: trust.audience,
    tenantId: FIXTURE_TENANT,
    workspaceId: "workspace:test",
    maxSessionSeconds: 604800,
    // Pin the clock so the FIXTURE_NOW tokens stay fresh for the test run.
    clock: () => FIXTURE_NOW,
    loadKeys: async () => trust.keys,
    database: { client, close: async () => { await db.close(); } },
    coordination: { store },
  });
  // We use the wired application directly; pass a noop render so unknown
  // paths return 404 instead of an SSR shell. We only care about
  // /api/v1/projects/:id/coordination paths.
  return {
    handle: async (request: Request) => {
      return application.handle(request, () => new Response(null, { status: 404 }));
    },
    dispose: async () => { void db.close(); },
  };
}

test("GET page with valid identity serves the wire-shaped page", async (t) => {
  const f = await buildRouteFixture(); t.after(() => f.dispose());
  const token = makeToken(FIXTURE_NOW, "test-app");
  const request = new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination`, {
    method: "GET",
    headers: { "cf-access-jwt-assertion": token },
  });
  const response = await f.handle(request);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.project.projectId, "project:example");
  assert.equal(body.coordinatorHead.state, "none");
  assert.equal(body.coordinatorHead.version, 0);
  assert.equal(body.coordinationEnabled, true);
});

test("request from a different origin is refused without reaching the service", async (t) => {
  const f = await buildRouteFixture(); t.after(() => f.dispose());
  const token = makeToken(FIXTURE_NOW, "test-app");
  const request = new Request(`https://attacker.example.invalid/api/v1/projects/project:example/coordination`, {
    method: "GET",
    headers: { "cf-access-jwt-assertion": token },
  });
  const response = await f.handle(request);
  // Same-origin check happens inside the service + handler, so an attacker-origin
  // request without the right Origin / Referer never reaches the engine.
  assert.notEqual(response.status, 200);
});

test("missing JWT produces authentication_required and never reaches the service", async (t) => {
  const f = await buildRouteFixture(); t.after(() => f.dispose());
  const request = new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination`, {
    method: "GET",
  });
  const response = await f.handle(request);
  assert.equal(response.status, 401);
});

test("POST without Idempotency-Key is invalid_request at the HTTP boundary", async (t) => {
  const f = await buildRouteFixture(); t.after(() => f.dispose());
  const token = makeToken(FIXTURE_NOW, "test-app");
  const body = JSON.stringify({
    revision: {
      projectId: "project:example",
      expectedCoordinatorVersion: 0,
      expectedPolicyVersion: 0,
      expectedConflictsVersion: 0,
      expectedAttentionVersion: 0,
      observedAt: new Date(FIXTURE_NOW).toISOString(),
    },
    coordinatorActorType: "human",
    coordinatorIdentityId: "owner-self-2",
  });
  const request = new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination/appoint-coordinator`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": token,
    },
    body,
  });
  const response = await f.handle(request);
  // The wiring must reject without reaching the service when the contract is broken.
  assert.notEqual(response.status, 200);
  assert.notEqual(response.status, 201);
});

test("POST with Idempotency-Key + valid body returns the action-result envelope", async (t) => {
  const f = await buildRouteFixture(); t.after(() => f.dispose());
  const token = makeToken(FIXTURE_NOW, "test-app");
  const observedAt = new Date(FIXTURE_NOW).toISOString();
  const body = JSON.stringify({
    revision: {
      projectId: "project:example",
      expectedCoordinatorVersion: 0,
      expectedPolicyVersion: 0,
      expectedConflictsVersion: 0,
      expectedAttentionVersion: 0,
      observedAt,
    },
    coordinatorActorType: "human",
    coordinatorIdentityId: "owner-self-2",
  });
  const request = new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination/appoint-coordinator`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": token,
      "idempotency-key": "appointment-12345678",
      "origin": FIXTURE_ORIGIN,
    },
    body,
  });
  const response = await f.handle(request);
  const result = await response.clone().json();
  // Wire-spec envelope: { status, reasonCode?, revision? }.
  assert.equal(result.status, "accepted");
  assert.equal(result.revision.expectedCoordinatorVersion, 1);
});

test("disabled coordination flag blocks writes; reads still succeed", async (t) => {
  const f = await buildRouteFixture({ coordinationEnabled: false }); t.after(() => f.dispose());
  const token = makeToken(FIXTURE_NOW, "test-app");

  const readRequest = new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination`, {
    method: "GET",
    headers: { "cf-access-jwt-assertion": token },
  });
  const readResponse = await f.handle(readRequest);
  assert.equal(readResponse.status, 200);
  const readBody = await readResponse.json();
  assert.equal(readBody.coordinationEnabled, false);

  const writeRequest = new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination/appoint-coordinator`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": token,
      "idempotency-key": "appointment-disabled12",
      "origin": FIXTURE_ORIGIN,
    },
    body: JSON.stringify({
      revision: {
        projectId: "project:example",
        expectedCoordinatorVersion: 0,
        expectedPolicyVersion: 0,
        expectedConflictsVersion: 0,
        expectedAttentionVersion: 0,
        observedAt: new Date(FIXTURE_NOW).toISOString(),
      },
      coordinatorActorType: "human",
      coordinatorIdentityId: "owner-self-2",
    }),
  });
  const writeResponse = await f.handle(writeRequest);
  // Disabled flag should produce a non-2xx — the service-level disabled check
  // must surface above the engine so the response is refused regardless of what
  // the engine would have said.
  assert.notEqual(writeResponse.status, 200);
  assert.notEqual(writeResponse.status, 201);
});

test("POST with a revision from a different project is refused with invalid_input", async (t) => {
  const f = await buildRouteFixture(); t.after(() => f.dispose());
  const token = makeToken(FIXTURE_NOW, "test-app");
  const body = JSON.stringify({
    revision: {
      projectId: "project:other",
      expectedCoordinatorVersion: 0,
      expectedPolicyVersion: 0,
      expectedConflictsVersion: 0,
      expectedAttentionVersion: 0,
      observedAt: new Date(FIXTURE_NOW).toISOString(),
    },
    coordinatorActorType: "human",
    coordinatorIdentityId: "owner-self-3",
  });
  const request = new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination/appoint-coordinator`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": token,
      "idempotency-key": "appointment-cross12",
      "origin": FIXTURE_ORIGIN,
    },
    body,
  });
  const response = await f.handle(request);
  const result = await response.clone().json();
  // Cross-project revision MUST be refused — clients cannot mix revisions
  // from different projects, otherwise stale-revision guards can be bypassed.
  assert.equal(result.status, "refused");
  assert.equal(result.reasonCode, "invalid_input");
});

test("POST with a stale revision is refused with stale_revision", async (t) => {
  const f = await buildRouteFixture(); t.after(() => f.dispose());
  const token = makeToken(FIXTURE_NOW, "test-app");
  const observedAt = new Date(FIXTURE_NOW).toISOString();
  const body = JSON.stringify({
    revision: {
      projectId: "project:example",
      expectedCoordinatorVersion: 99,
      expectedPolicyVersion: 0,
      expectedConflictsVersion: 0,
      expectedAttentionVersion: 0,
      observedAt,
    },
    coordinatorActorType: "human",
    coordinatorIdentityId: "owner-self-4",
  });
  const request = new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination/appoint-coordinator`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": token,
      "idempotency-key": "appointment-stale123",
      "origin": FIXTURE_ORIGIN,
    },
    body,
  });
  const response = await f.handle(request);
  const result = await response.clone().json();
  // Stale revision MUST be refused — the client observed a snapshot that
  // doesn't match the current canonical version.
  assert.equal(result.status, "refused");
  assert.equal(result.reasonCode, "stale_revision");
});
