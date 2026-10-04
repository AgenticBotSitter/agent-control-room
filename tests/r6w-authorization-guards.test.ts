// Fast, database-free proof that the two authorization guards I added are
// load-bearing, so a regression is caught in the ordinary test lane and not
// only in the PostgreSQL lane (tests/r6w-authorization-postgres.test.ts).
//
// What is checked here is the DECISION each guard makes, with the durable
// authority stubbed at exactly the boundary it occupies:
//
//   * R6W-04: the in-flight map is keyed to the exact verified credential, and
//     every write request authorizes itself before consulting it. Removing the
//     key binding or the authorization call must make these fail.
//   * R6W-05: a project outside the configured workspace is refused, and the
//     refusal is `not_found` so it is indistinguishable from an absent project.
//
// The real database proof of both lives in the PostgreSQL lane; this file is
// the one that runs in `pnpm test:coordination` and `pnpm test:recurring`.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { createAccessVerifier, WebAccessError, type AccessTrust } from "../src/web/v1/access-verifier";
import { callerBinding, createCoordinationHttpHandler } from "../src/web/v1/coordination-http";
import { createProjectCoordinationCanonicalStoreAdapterV1 } from "../src/web/v1/project-coordination-http";
import type { QueryResult } from "../src/persistence/database";
import {
  assertWorkspaceProjectInSessionV1,
  readWorkspaceScopedProjectRowV1,
  type ProjectWorkspaceQueryV1,
} from "../src/web/v1/project-workspace-lookup";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const ORIGIN = "https://private.r6w.invalid";
const KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TRUST: AccessTrust = {
  issuer: "https://access.r6w.invalid",
  audience: "r6w-app",
  keys: [{ kid: "r6w-key", jwk: KEYS.publicKey.export({ format: "jwk" }) }],
  validUntilMs: NOW + 3_600_000,
  maxSessionSeconds: 604_800,
};
const SCOPE = { tenantId: "tenant:r6w", workspaceId: "ws:r6w-main" };
const PROJECT = "project:r6w-main";
const SIBLING = "project:r6w-sibling";

function makeToken(nonce: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "r6w-key" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: TRUST.issuer, aud: [TRUST.audience], sub: "owner-r6w", type: "app",
    iat: Math.floor(NOW / 1000) - 60, exp: Math.floor(NOW / 1000) + 300, nonce,
  })).toString("base64url");
  return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), KEYS.privateKey).toString("base64url")}`;
}
const identityOf = (nonce: string) => createAccessVerifier(TRUST)(
  new Request(`${ORIGIN}/x`, { headers: { "cf-access-jwt-assertion": makeToken(nonce) } }), NOW);

// ---------------------------------------------------------------------------
// R6W-04
// ---------------------------------------------------------------------------

test("R6W-04: the in-flight binding distinguishes two credentials of one subject", () => {
  const live = identityOf("live"), revoked = identityOf("revoked");
  assert.equal(live.subject, revoked.subject, "one subject, two credentials");
  assert.notEqual(live.tokenDigest, revoked.tokenDigest);
  assert.notEqual(callerBinding(live).binding, callerBinding(revoked).binding,
    "two credentials of the same subject must not share an in-flight slot");
  // The same credential always produces the same binding, so a genuine retry
  // still coalesces.
  assert.equal(callerBinding(live).binding, callerBinding(live).binding);
  // The binding is a digest, never the raw credential or subject.
  assert.match(callerBinding(live).binding, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(callerBinding(live).binding, /owner-r6w/);
  // Provider is part of it: the same credential under another provider profile
  // is a different caller.
  assert.notEqual(callerBinding(live).binding,
    callerBinding({ ...live, provider: "https://other.invalid" }).binding);
});

/** A coordination service double that records the callers it was asked about. */
function stubService() {
  const seen: string[] = [];
  return {
    seen,
    async appointCoordinator(identity: { tokenDigest: string }) {
      seen.push(identity.tokenDigest);
      return { status: "accepted" as const, revision: { projectId: PROJECT, observedAt: new Date(NOW).toISOString(),
        expectedCoordinatorVersion: 1, expectedPolicyVersion: 0, expectedConflictsVersion: 0, expectedAttentionVersion: 0 } };
    },
    async read() { throw new Error("not used"); },
  } as unknown as Parameters<typeof createCoordinationHttpHandler>[0]["service"] & { seen: string[] };
}

const post = (handler: ReturnType<typeof createCoordinationHttpHandler>, token: string, key: string) => handler(
  new Request(`${ORIGIN}/api/v1/projects/${PROJECT}/coordination/appoint-coordinator`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-access-jwt-assertion": token,
      "idempotency-key": key },
    body: JSON.stringify({ revision: { projectId: PROJECT, expectedCoordinatorVersion: 0, expectedPolicyVersion: 0,
      expectedConflictsVersion: 0, expectedAttentionVersion: 0, observedAt: new Date(NOW).toISOString() },
      coordinatorActorType: "human", coordinatorIdentityId: "identity:r6w-coordinator" }),
  }));

test("R6W-04: a refused caller never reaches the shared in-flight result", async () => {
  const revokedToken = makeToken("revoked"), liveToken = makeToken("live");
  const service = stubService();
  const authorized: string[] = [];
  // One in-flight map shared across handlers, exactly as private-process.ts does.
  const inflight = new Map<string, Promise<unknown>>();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const onEnter = new Promise<void>(resolve => { entered = resolve; });
  const gated = Object.freeze({
    ...service,
    appointCoordinator: async (identity: { tokenDigest: string }) => {
      // The leader parks here; a follower that reached the service would join
      // the same promise, which is the disclosure being guarded against.
      entered();
      await gate;
      return (service as unknown as { appointCoordinator: (i: unknown) => Promise<unknown> })
        .appointCoordinator(identity);
    },
  }) as unknown as Parameters<typeof createCoordinationHttpHandler>[0]["service"];

  const handler = createCoordinationHttpHandler({
    origin: ORIGIN, trust: TRUST, service: gated, clock: () => NOW, inflight,
    // The real production authorizer is WebSessionAuthority.probeCaller; here
    // only the decision boundary is exercised.
    authorizeCaller: async (verified) => {
      authorized.push(verified.tokenDigest);
      if (verified.tokenDigest === identityOf("revoked").tokenDigest)
        throw new WebAccessError("authentication_required");
    },
  });

  const leader = post(handler, liveToken, "r6w-unit-key-0001");
  await onEnter;
  // Fifty revoked followers, same key and body, while the leader is parked.
  const followers = await Promise.all(Array.from({ length: 50 },
    () => post(handler, revokedToken, "r6w-unit-key-0001")));
  // Every one of them was authorized BEFORE the in-flight map was consulted,
  // and every authorization failed.
  assert.equal(authorized.length, 51, "every write request authorized itself");
  assert.equal(authorized.filter(digest => digest === identityOf("live").tokenDigest).length, 1);
  release();
  assert.equal((await leader).status, 200, "the live caller's own write succeeds");
  // Not one refused caller was handed the leader's outcome.
  assert.equal(followers.filter(response => response.status === 200).length, 0,
    "a refused caller received the leader's receipt");
  assert.equal(followers.every(response => response.status === 401), true,
    `every refused caller must be 401; saw ${[...new Set(followers.map(r => r.status))].join(",")}`);
  // The service ran exactly once: the fifty followers did not reach it.
  assert.equal((service as unknown as { seen: string[] }).seen.length, 1,
    "the engine ran once for the whole coalesced group");
});

test("R6W-04: a genuine retry of the SAME caller still coalesces onto one run", async () => {
  const token = makeToken("live");
  const service = stubService();
  const inflight = new Map<string, Promise<unknown>>();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const onEnter = new Promise<void>(resolve => { entered = resolve; });
  const gated = Object.freeze({
    ...service,
    async appointCoordinator(identity: { tokenDigest: string }) {
      entered(); await gate;
      return (service as unknown as { appointCoordinator: (i: unknown) => Promise<unknown> })
        .appointCoordinator(identity);
    },
  }) as unknown as Parameters<typeof createCoordinationHttpHandler>[0]["service"];
  const handler = createCoordinationHttpHandler({
    origin: ORIGIN, trust: TRUST, service: gated, clock: () => NOW, inflight,
    authorizeCaller: async () => {},
  });
  const leader = post(handler, token, "r6w-unit-key-0002");
  await onEnter;
  // Fire the followers and release in the same turn: a follower AWAITS the
  // leader's promise, so awaiting them before the release would deadlock.
  const followers = Array.from({ length: 20 }, () => post(handler, token, "r6w-unit-key-0002"));
  // Let every follower reach the in-flight map BEFORE the leader settles, which
  // is the whole point of coalescing. A follower arriving after the leader
  // committed is the sequential retry, and the DURABLE ledger answers that one
  // -- not the in-memory map -- so it is not what this test is about.
  await new Promise(resolve => setImmediate(resolve));
  release();
  const [leaderResponse, ...followerResponses] = await Promise.all([leader, ...followers]);
  assert.equal(leaderResponse.status, 200);
  const leaderBody = await leaderResponse.clone().json();
  // Every follower shared the leader's promise, so the engine ran once. Any
  // follower that missed the slot would have called the service again.
  assert.equal((service as unknown as { seen: string[] }).seen.length, 1,
    "twenty-one concurrent identical requests ran the engine once");
  for (const follower of followerResponses) {
    assert.equal(follower.status, 200, "the same caller's follower shares the outcome");
    assert.deepEqual(await follower.clone().json(), leaderBody);
  }
  // The map is emptied when the leader settles, so a later retry reaches the
  // durable ledger instead of a stale promise.
  assert.equal(inflight.size, 0, "the in-flight slot is released");
});

test("R6W-04: a handler built without a caller authorizer is refused at construction", () => {
  // Omitting the authorizer is the pre-fix condition; it must not be
  // constructible, because it is exactly the shape that lets a follower skip
  // its own credential check.
  assert.throws(() => createCoordinationHttpHandler({
    origin: ORIGIN, trust: TRUST, service: stubService(), clock: () => NOW,
  } as never), /coordination_http_caller_authorizer_missing/);
});

// ---------------------------------------------------------------------------
// R6W-05
// ---------------------------------------------------------------------------

test("R6W-05: the shared project lookup is fenced by tenant, workspace and id", async () => {
  const statements: { statement: string; params: unknown[] }[] = [];
  const row = { id: PROJECT, title: "Main", summary: "", lifecycle: "active", version: 1,
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() };
  const db: ProjectWorkspaceQueryV1 = {
    async query<T = Record<string, unknown>>(statement: string, params: unknown[] = []): Promise<QueryResult<T>> {
      statements.push({ statement, params });
      // The fake is only the database: the predicate that decides is the SQL
      // the production code sent, read back here.
      const mentionsWorkspace = /\bworkspace_id\s*=\s*\$\d+/u.test(statement);
      const wanted = params[2];
      return { rows: (mentionsWorkspace && wanted === PROJECT ? [row] : []) as unknown as T[] };
    },
  };
  assert.ok(await readWorkspaceScopedProjectRowV1(db, SCOPE, { projectId: PROJECT }));
  assert.equal(await readWorkspaceScopedProjectRowV1(db, SCOPE, { projectId: SIBLING }), undefined,
    "a sibling workspace's project must not resolve");
  // Both calls sent the SAME fenced statement; only the bound project differs.
  assert.equal(new Set(statements.map(entry => entry.statement)).size, 1,
    "one lookup shape serves every caller, so no caller can omit the fence");
  const statement = statements[0]!.statement;
  // Every predicate the fence is made of is in the statement, not in a comment.
  assert.match(statement, /p\.tenant_id=\$\d+/u);
  assert.match(statement, /p\.workspace_id=\$\d+/u);
  assert.match(statement, /p\.id=\$\d+/u);
  // The lock that keeps the fenced row from moving under the caller's work.
  assert.match(statement, /FOR SHARE/u);
  // The workspace parameter is BOUND, not interpolated away: dropping it is the
  // defect, and a statement that merely mentions the column would not catch it.
  assert.equal(statements[0]!.params[1], SCOPE.workspaceId,
    "the workspace predicate is bound to the configured workspace");
  assert.deepEqual(statements.map(entry => entry.params[2]), [PROJECT, SIBLING],
    "each call binds exactly the project the caller named");
});

test("R6W-05: an out-of-workspace project is not_found, never access_denied", async () => {
  const tx = { query: async () => ({ rows: [] }) };
  await assert.rejects(assertWorkspaceProjectInSessionV1(tx as never, SCOPE, SIBLING),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  await assert.rejects(assertWorkspaceProjectInSessionV1(tx as never, SCOPE, "project:r6w-absent"),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found",
    "an absent project and a sibling-workspace project must be indistinguishable");
});

test("R6W-05: an unfenced or empty workspace is a construction error", () => {
  // The adapter builds its engine eagerly and refuses a bad workspace at
  // CONSTRUCTION, before any request can reach a tenant-wide lookup. (The
  // deeper property -- that a configured workspace really fences the SQL, and
  // that an unconfigured one refuses to resolve -- needs a real canonical
  // client, so it lives in tests/r6w-authorization-postgres.test.ts.)
  const db = { query: async () => ({ rows: [] }), transaction: async () => ({ rows: [] }),
    transactionWithPreCommitCheck: async () => ({ rows: [] }) } as never;
  assert.throws(() => createProjectCoordinationCanonicalStoreAdapterV1({
    database: db, tenantId: SCOPE.tenantId, workspaceId: "" }), /coordination_store_workspace_invalid/);
  // A valid workspace constructs.
  assert.doesNotThrow(() => createProjectCoordinationCanonicalStoreAdapterV1({
    database: db, tenantId: SCOPE.tenantId, workspaceId: SCOPE.workspaceId }));
});
