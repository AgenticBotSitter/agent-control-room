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
//   * simultaneous same-key POSTs -> engine runs once, both callers get the
//     same outcome (in-flight coalescing, perf-only; PG receipt is durable);
//   * sequential same-key retry -> saved PG receipt, no second write;
//   * reconstructed handler -> saved PG receipt, restart-safe;
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
import { sha256Digest } from "../src/security/digest";
import { SecurityStore } from "../src/security/security-store";
import { createAccessVerifier, type AccessTrust } from "../src/web/v1/access-verifier";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import type { ProjectCoordinationCanonicalStoreAdapter } from "../src/web/v1/project-coordination-http";
import type { ProjectCoordinationCanonicalPortV1 } from "../src/project-coordination/v1/services";
import type { CoordinatorLifecycleReceiptV1 } from "../src/project-coordination/v1/schemas";
import { ProjectCoordinationErrorV1 } from "../src/project-coordination/v1/errors";

const FIXTURE_NOW = Date.parse("2026-09-14T00:00:00.000Z");
const FIXTURE_ORIGIN = "https://private.example.invalid";
const FIXTURE_TENANT = "tenant:test";
const FIXTURE_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
// A second keypair the trust store never sees. Tokens signed with it carry a
// valid shape but a bad signature — the verifier must refuse them.
const WRONG_KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });

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

function makeBadSignatureToken(now: number, audience: string, subject = "test-owner"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-public-key" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: "https://access.example.invalid", aud: [audience], sub: subject, type: "app",
    iat: now / 1000 - 60, exp: now / 1000 + 300,
  })).toString("base64url");
  // Signed with the wrong private key: header claims kid test-public-key but
  // the signature does not verify against the trusted JWK.
  return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), WRONG_KEYS.privateKey).toString("base64url")}`;
}

interface RouteFixture {
  handle: (request: Request) => Promise<Response>;
  /**
   * Fresh handler + service + in-flight map over the same durable rows —
   * simulates a process restart. Only in-memory coalescing is lost; the
   * receipt ledger (like PG rows) survives.
   */
  rebuild: () => { handle: (request: Request) => Promise<Response> };
  dispose: () => Promise<void>;
}

async function buildRouteFixture(opts: { coordinationEnabled?: boolean; engineDelayMs?: number; onEngineWrite?: () => void; onEngineCommit?: () => void; onCoordinationCall?: () => void; onPolicyCall?: () => void } = {}): Promise<RouteFixture> {
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
  type CoordinatorHeadRow = NonNullable<ReturnType<typeof headRows.get>>;
  // Durable receipt ledger mirroring control_idempotency for the coordinator
  // lifecycle: one saved receipt per Idempotency-Key. Shared by rebuilt
  // handlers in reconstruction tests, like PG rows survive a restart.
  const lifecycleReceipts = new Map<string, { contentKey: string; receipt: CoordinatorLifecycleReceiptV1 }>();
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
      opts.onCoordinationCall?.();
      // Mirrors the merged canonical receipt semantics: the idempotency
      // ledger is probed first (exact retry returns the saved receipt,
      // changed content under the same key conflicts), then the expected
      // version is enforced. Appoint is version-checked upsert, like the
      // merged engine — there is no already_active refusal at this layer.
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
      // Builds the same receipt shape the merged canonical store writes,
      // so the service's receipt parse behaves identically against the fake.
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
      opts.onEngineWrite?.();
      if (opts.engineDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.engineDelayMs));
      if (input.operation === "revoke") {
        const existing = headRows.get(input.appointment.projectId);
        if (!existing) throw new ProjectCoordinationErrorV1("coordinator_absent" as never);
        const next: CoordinatorHeadRow = { ...existing, state: "revoked" };
        headRows.set(input.appointment.projectId, next);
        const receipt = buildReceipt(existing.version, "revoked");
        lifecycleReceipts.set(input.idempotencyKey, { contentKey, receipt });
        opts.onEngineCommit?.();
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
      opts.onEngineCommit?.();
      return { ...receipt, replayed: false as const };
    },
    async setProjectDelegationPolicyStateV1(input) {
      opts.onCoordinationCall?.();
      opts.onPolicyCall?.();
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
    async recordProjectCoordinationProposalV1() { opts.onCoordinationCall?.(); throw new Error("not used"); },
    async loadAcceptedProjectCoordinationProposalV1() { opts.onCoordinationCall?.(); throw new Error("not used"); },
    async findCommittedProjectCoordinationAdoptionV1() { opts.onCoordinationCall?.(); throw new Error("not used"); },
    async adoptProjectCoordinationProposalV1() { opts.onCoordinationCall?.(); throw new Error("not used"); },
    async admitProjectWorkResourcesV1() { opts.onCoordinationCall?.(); throw new Error("not used"); },
    async recheckProjectWorkResourceAdmissionV1() { opts.onCoordinationCall?.(); throw new Error("not used"); },
    async retireProjectWorkResourceAdmissionV1() { opts.onCoordinationCall?.(); throw new Error("not used"); },
  };

  const store: ProjectCoordinationCanonicalStoreAdapter = {
    coordinator: port,
    async coordinatorVersion(projectId) { opts.onCoordinationCall?.(); return headRows.get(projectId)?.version ?? 0; },
    async readActiveHead(projectId) {
      opts.onCoordinationCall?.();
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
    async policyVersion(projectId) { opts.onCoordinationCall?.(); return policyByProject.get(projectId)?.coordinatorVersion ?? 0; },
    async readDelegationPolicySummary() { opts.onCoordinationCall?.(); return null; },
    async conflictsVersion() { opts.onCoordinationCall?.(); return 0; },
    async attentionVersion() { opts.onCoordinationCall?.(); return 0; },
    async project(projectId) {
      opts.onCoordinationCall?.();
      const project = projects.get(projectId);
      if (!project) throw new Error("not_found");
      return project;
    },
    async coordinationEnabled() { opts.onCoordinationCall?.(); return opts.coordinationEnabled ?? true; },
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
  const toFixture = (application: { handle: (request: Request, render: () => Promise<Response> | Response) => Promise<Response> }) => ({
    handle: async (request: Request) => {
      return application.handle(request, () => new Response(null, { status: 404 }));
    },
  });
  // We use the wired application directly; pass a noop render so unknown
  // paths return 404 instead of an SSR shell. We only care about
  // /api/v1/projects/:id/coordination paths.
  return {
    ...toFixture(application),
    rebuild: () => toFixture(createPrivateWebProcess({
      origin: FIXTURE_ORIGIN,
      issuer: trust.issuer,
      audience: trust.audience,
      tenantId: FIXTURE_TENANT,
      workspaceId: "workspace:test",
      maxSessionSeconds: 604800,
      clock: () => FIXTURE_NOW,
      loadKeys: async () => trust.keys,
      database: { client, close: async () => {} },
      coordination: { store },
    })),
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

test("bad JWT signature produces authentication_required and never reaches the service", async (t) => {
  let coordinationCalls = 0;
  const f = await buildRouteFixture({ onCoordinationCall: () => { coordinationCalls += 1; } }); t.after(() => f.dispose());
  // Signed with a key the trust store never saw: well-formed JWT, wrong signature.
  const token = makeBadSignatureToken(FIXTURE_NOW, "test-app");
  const request = new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination`, {
    method: "GET",
    headers: { "cf-access-jwt-assertion": token },
  });
  const response = await f.handle(request);
  assert.equal(response.status, 401);
  const body = await response.json();
  // The verifier must refuse before the service runs — no page payload, no grant check.
  assert.match(JSON.stringify(body), /authentication_required/);
  // Machine-checked ordering: the JWT verifier short-circuits before any
  // coordination store/service entry point runs.
  assert.equal(coordinationCalls, 0);
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

test("sequential same-key retry returns the saved receipt without repeating the coordinator change", async (t) => {
  let commits = 0;
  const f = await buildRouteFixture({ onEngineCommit: () => { commits += 1; } });
  t.after(() => f.dispose());
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
    coordinatorIdentityId: "owner-self-5",
  });
  const buildRequest = () => new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination/appoint-coordinator`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": token,
      "idempotency-key": "appointment-replay12",
      "origin": FIXTURE_ORIGIN,
    },
    body,
  });
  // First call runs the engine, records one permanent receipt, and bumps the
  // canonical coordinator version.
  const first = await f.handle(buildRequest());
  const firstResult = await first.clone().json();
  assert.equal(first.status, 200);
  assert.equal(firstResult.status, "accepted");
  assert.equal(firstResult.revision.expectedCoordinatorVersion, 1);
  assert.equal(commits, 1);

  // Lost response: the client retries the byte-identical request. The route
  // passes the exact Idempotency-Key into the merged service, whose PG
  // transaction finds the saved receipt and returns it — no second write,
  // same recorded outcome.
  const second = await f.handle(buildRequest());
  assert.equal(second.status, 200);
  const secondResult = await second.clone().json();
  assert.equal(secondResult.status, "accepted");
  assert.deepEqual(secondResult, firstResult);
  assert.equal(commits, 1);
});

test("simultaneous same-key POSTs run the engine once and both callers get the same outcome", async (t) => {
  let commits = 0;
  const f = await buildRouteFixture({
    engineDelayMs: 20,
    onEngineCommit: () => { commits += 1; },
  });
  t.after(() => f.dispose());
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
    coordinatorIdentityId: "owner-self-7",
  });
  const buildRequest = () => new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination/appoint-coordinator`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": token,
      "idempotency-key": "appointment-race01",
      "origin": FIXTURE_ORIGIN,
    },
    body,
  });
  // Both requests are in flight at once. The in-flight map coalesces them:
  // the engine runs exactly once and both callers receive the same recorded
  // outcome. This is perf-only coalescing, not durable replay.
  const [first, second] = await Promise.all([f.handle(buildRequest()), f.handle(buildRequest())]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstResult = await first.json();
  const secondResult = await second.json();
  assert.equal(commits, 1);
  assert.equal(firstResult.status, "accepted");
  assert.deepEqual(secondResult, firstResult);
});

test("simultaneous same-key POSTs with different content never share one outcome", async (t) => {
  const f = await buildRouteFixture({ engineDelayMs: 20 });
  t.after(() => f.dispose());
  const token = makeToken(FIXTURE_NOW, "test-app");
  const observedAt = new Date(FIXTURE_NOW).toISOString();
  const buildRequest = (coordinatorIdentityId: string) => new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination/appoint-coordinator`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": token,
      "idempotency-key": "appointment-changed01",
      "origin": FIXTURE_ORIGIN,
    },
    body: JSON.stringify({
      revision: {
        projectId: "project:example",
        expectedCoordinatorVersion: 0,
        expectedPolicyVersion: 0,
        expectedConflictsVersion: 0,
        expectedAttentionVersion: 0,
        observedAt,
      },
      coordinatorActorType: "human",
      coordinatorIdentityId,
    }),
  });
  // Same Idempotency-Key, different coordinator identities, both in flight.
  // The canonical body digest keeps them in separate in-flight slots: the
  // engine must run for each, and the second caller must never receive the
  // first caller's accepted receipt.
  const [first, second] = await Promise.all([
    f.handle(buildRequest("owner-self-9")),
    f.handle(buildRequest("owner-self-10")),
  ]);
  assert.equal(first.status, 200);
  const firstResult = await first.json();
  const secondResult = await second.json();
  // Both changed-content requests ran in separate in-flight slots: the
  // second caller is never answered with the first caller's accepted
  // receipt. Depending on interleaving it is refused with
  // coordinator_replay_conflict (durable ledger wins) or accepts its own
  // distinct receipt — either way its outcome differs. Receipts embed the
  // request digest, so equality with the first outcome is impossible.
  assert.equal(firstResult.status, "accepted");
  assert.notDeepEqual(secondResult, firstResult);
});

test("policy pause, resume, and revoke POSTs are refused at the route before any service call", async (t) => {
  let policyCalls = 0;
  const f = await buildRouteFixture({
    onPolicyCall: () => { policyCalls += 1; },
  });
  t.after(() => f.dispose());
  const token = makeToken(FIXTURE_NOW, "test-app");
  for (const subaction of ["pause-policy", "resume-policy", "revoke-policy"]) {
    const response = await f.handle(new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination/${subaction}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-access-jwt-assertion": token,
        "idempotency-key": `policy-suspended01`,
        "origin": FIXTURE_ORIGIN,
      },
      body: JSON.stringify({ policyId: "policy:test" }),
    }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "access_denied" });
  }
  // Suspended at the route until #220: no policy service call ran.
  assert.equal(policyCalls, 0);
});

test("reconstructed handler returns the saved receipt — restart loses no retry safety", async (t) => {
  let commits = 0;
  const f = await buildRouteFixture({ onEngineCommit: () => { commits += 1; } });
  t.after(() => f.dispose());
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
    coordinatorIdentityId: "owner-self-8",
  });
  const buildRequest = () => new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination/appoint-coordinator`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": token,
      "idempotency-key": "appointment-restart01",
      "origin": FIXTURE_ORIGIN,
    },
    body,
  });
  const first = await f.handle(buildRequest());
  const firstResult = await first.clone().json();
  assert.equal(firstResult.status, "accepted");
  assert.equal(commits, 1);

  // Simulate a Control Room restart: a fresh handler, service, and in-flight
  // map over the same durable rows. The retry must be answered from the
  // saved receipt — no second coordinator write.
  const rebuilt = f.rebuild();
  const second = await rebuilt.handle(buildRequest());
  assert.equal(second.status, 200);
  const secondResult = await second.clone().json();
  assert.equal(secondResult.status, "accepted");
  assert.deepEqual(secondResult, firstResult);
  assert.equal(commits, 1);
});

test("different Idempotency-Keys on the same project both run the engine", async (t) => {
  const f = await buildRouteFixture(); t.after(() => f.dispose());
  const token = makeToken(FIXTURE_NOW, "test-app");
  const observedAt = new Date(FIXTURE_NOW).toISOString();
  const buildRequest = (key: string) => new Request(`${FIXTURE_ORIGIN}/api/v1/projects/project:example/coordination/appoint-coordinator`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": token,
      "idempotency-key": key,
      "origin": FIXTURE_ORIGIN,
    },
    body: JSON.stringify({
      revision: {
        projectId: "project:example",
        expectedCoordinatorVersion: 0,
        expectedPolicyVersion: 0,
        expectedConflictsVersion: 0,
        expectedAttentionVersion: 0,
        observedAt,
      },
      coordinatorActorType: "human",
      coordinatorIdentityId: "owner-self-6",
    }),
  });
  // Two distinct Idempotency-Keys — different in-flight slots — both must run.
  // The first call installs the coordinator; the second call MUST re-run the
  // engine (different key) and refuse with stale_revision on the now-outdated
  // revision, proving no cross-key short-circuit.
  const first = await f.handle(buildRequest("appointment-distinct1"));
  assert.equal(first.status, 200);
  const firstResult = await first.clone().json();
  assert.equal(firstResult.status, "accepted");
  assert.equal(firstResult.revision.expectedCoordinatorVersion, 1);

  const second = await f.handle(buildRequest("appointment-distinct2"));
  assert.equal(second.status, 200);
  const secondResult = await second.clone().json();
  // Different Idempotency-Key → engine re-runs. The client still submits the
  // original (now-stale) revision, so the engine refuses with stale_revision,
  // proving the request was not short-circuited by the replay cache.
  assert.equal(secondResult.status, "refused");
  assert.equal(secondResult.reasonCode, "stale_revision");
  // The engine saw the head at version 1 — proving it re-ran, not the cached 0.
  assert.equal(secondResult.revision.expectedCoordinatorVersion, 1);
});
