import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database.ts";
import {
  buildProtectedProjectCatalogHighWaterV1,
  buildProtectedProjectCatalogV1,
  buildProjectWorkspaceVerifiedOwnerSessionV1,
  InMemoryProjectWorkspaceCatalogHighWaterStoreV1,
  PROJECT_WORKSPACE_CATALOG_CONTRACT_V1,
  PROJECT_WORKSPACE_OWNER_SESSION_CONTRACT_V1,
  ProjectWorkspaceContractErrorV1,
  ProjectWorkspaceOwnerReadScopeAuthorityV1,
  ProjectWorkspaceProtectedCatalogAuthorityV1,
  type ProtectedProjectCatalogHighWaterV1,
} from "../src/project-workspace/v1/index.ts";
import { SecurityStore, sha256Digest } from "../src/security/index.ts";

const tenantId = "tenant.owner";
const workspaceId = "workspace.alpha";
const projectId = "project.alpha";
const now = "2026-08-31T18:01:00.000Z";
const authenticatedAt = "2026-08-31T18:00:00.000Z";
const expiresAt = "2026-08-31T18:10:00.000Z";
const key = new Uint8Array(32).fill(17);
const highWaterKey = new Uint8Array(32).fill(23);
const sourceIdentityDigest = sha256Digest({ source: "protected-catalog-test" });

async function database() {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  }
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ($1,'Owner')`, [tenantId]);
  const security = new SecurityStore(adaptPglite(raw));
  await security.bootstrapOwner({
    tenantId, provider: "local_owner", subject: "owner-subject", verifiedAt: authenticatedAt, expiresAt,
    identityId: "identity.owner", grantId: "grant.owner", displayName: "Owner", now,
  });
  return { raw, security };
}

function catalog(input: { revision?: number; previousCatalogDigest?: string | null; projectState?: "active" | "revoked"; catalogState?: "active" | "revoked" } = {}) {
  const projectState = input.projectState ?? "active", catalogState = input.catalogState ?? "active";
  return buildProtectedProjectCatalogV1({
    contractVersion: PROJECT_WORKSPACE_CATALOG_CONTRACT_V1,
    catalogId: "catalog.owner",
    tenantId,
    revision: input.revision ?? 1,
    previousCatalogDigest: input.previousCatalogDigest ?? null,
    state: catalogState,
    sourceKind: "protected_server_catalog",
    sourceIdentityDigest,
    recordedAt: authenticatedAt,
    entries: [{ tenantId, workspaceId, projectId, projectType: "project.test", state: projectState, recordedAt: authenticatedAt }],
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  }, key);
}

function session(overrides: Partial<Parameters<typeof buildProjectWorkspaceVerifiedOwnerSessionV1>[0]> = {}) {
  return buildProjectWorkspaceVerifiedOwnerSessionV1({
    contractVersion: PROJECT_WORKSPACE_OWNER_SESSION_CONTRACT_V1,
    tenantId,
    provider: "local_owner",
    subject: "owner-subject",
    sessionIdDigest: sha256Digest({ session: "owner-session" }),
    authenticatedAt,
    expiresAt,
    readOnly: true,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
    ...overrides,
  });
}

function catalogBoundary(initial = catalog()) {
  let current: unknown = initial;
  let calls = 0;
  const highWater = new InMemoryProjectWorkspaceCatalogHighWaterStoreV1(highWaterKey, { testOnly: true });
  const checkpoint = buildProtectedProjectCatalogHighWaterV1({ catalog: initial, checkpointId: "checkpoint.catalog.1", recordedAt: authenticatedAt }, key, highWaterKey);
  highWater.apply(checkpoint);
  const authority = new ProjectWorkspaceProtectedCatalogAuthorityV1(
    { read: async () => { calls += 1; return current; } },
    highWater,
    { catalogId: initial.catalogId, tenantId, sourceIdentityDigest },
    key,
    highWaterKey,
  );
  return { authority, highWater, checkpoint, set(value: unknown) { current = value; }, calls: () => calls };
}

test("CR12A-PILOT-015 derives project scope only from protected catalog, owner session, and active owner policy", async () => {
  const { raw, security } = await database();
  try {
    const boundary = catalogBoundary();
    const scope = await new ProjectWorkspaceOwnerReadScopeAuthorityV1(
      { verify: async () => session() }, boundary.authority, security,
    ).authorize({ credential: new Request("http://localhost"), projectId, now });
    assert.deepEqual({ tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId: scope.projectId, actorId: scope.actorId },
      { tenantId, workspaceId, projectId, actorId: "identity.owner" });
    assert.equal(scope.catalogId, "catalog.owner");
    assert.equal(scope.catalogRevision, 1);
    assert.match(scope.catalogCheckpointDigest, /^sha256:/);
    assert.equal(Date.parse(scope.expiresAt) - Date.parse(now), 60_000);
    assert.equal((await raw.query<{ count: string }>(`SELECT count(*)::text AS count FROM control_policy_decisions`)).rows[0]!.count, "0");
  } finally { await raw.close(); }
});

test("CR12A-PILOT-015 authenticates before catalog access and rejects caller-mintable scope fields", async () => {
  const { raw, security } = await database();
  try {
    const boundary = catalogBoundary();
    const missing = new ProjectWorkspaceOwnerReadScopeAuthorityV1({ verify: async () => undefined }, boundary.authority, security);
    await assert.rejects(missing.authorize({ credential: {}, projectId, now }), (error: unknown) =>
      error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "authentication_required");
    assert.equal(boundary.calls(), 0);
    await assert.rejects(missing.authorize({ credential: {}, projectId, now, tenantId }), ProjectWorkspaceContractErrorV1);
    await assert.rejects(missing.authorize({ credential: {}, projectId, now, actorId: "identity.forged" }), ProjectWorkspaceContractErrorV1);
    assert.equal(boundary.calls(), 0);
  } finally { await raw.close(); }
});

test("CR12A-PILOT-015 rejects expired, future, cross-tenant, forged-subject, and malformed sessions", async () => {
  const { raw, security } = await database();
  try {
    const boundary = catalogBoundary();
    for (const candidate of [
      session({ expiresAt: now }),
      session({ authenticatedAt: "2026-08-31T18:01:06.000Z", expiresAt: "2026-08-31T18:05:00.000Z" }),
      session({ tenantId: "tenant.foreign" }),
      session({ subject: "forged-subject" }),
      { ...session(), sessionDigest: sha256Digest({ forged: true }) },
    ]) {
      const authority = new ProjectWorkspaceOwnerReadScopeAuthorityV1({ verify: async () => candidate }, boundary.authority, security);
      await assert.rejects(authority.authorize({ credential: {}, projectId, now }), ProjectWorkspaceContractErrorV1);
    }
  } finally { await raw.close(); }
});

test("CR12A-PILOT-015 requires an active owner grant and observes revocation without writing a read decision", async () => {
  const { raw, security } = await database();
  try {
    const boundary = catalogBoundary();
    const authority = new ProjectWorkspaceOwnerReadScopeAuthorityV1({ verify: async () => session() }, boundary.authority, security);
    await authority.authorize({ credential: {}, projectId, now });
    await raw.query(`UPDATE control_role_grants SET revoked_at=$1,updated_at=$1 WHERE id='grant.owner'`, [now]);
    await raw.query(
      `INSERT INTO control_role_grants
        (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
       VALUES ('grant.operator',$1,'identity.owner','operator',$2::jsonb,$3::jsonb,'low',false,false,$4,$4)`,
      [tenantId, JSON.stringify(["project_workspace.read"]), JSON.stringify([projectId]), now],
    );
    await assert.rejects(authority.authorize({ credential: {}, projectId, now }), (error: unknown) =>
      error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "policy_denied");
    assert.equal((await raw.query<{ count: string }>(`SELECT count(*)::text AS count FROM control_policy_decisions`)).rows[0]!.count, "0");
  } finally { await raw.close(); }
});

test("CR12A-PILOT-015 detects source rollback after the independent catalog high-water advances", async () => {
  const first = catalog(), boundary = catalogBoundary(first);
  const second = catalog({ revision: 2, previousCatalogDigest: first.catalogDigest });
  const checkpoint = buildProtectedProjectCatalogHighWaterV1({
    catalog: second, prior: boundary.checkpoint, checkpointId: "checkpoint.catalog.2", recordedAt: now,
  }, key, highWaterKey);
  boundary.highWater.apply(checkpoint);
  boundary.set(first);
  await assert.rejects(boundary.authority.resolve(projectId, now), (error: unknown) =>
    error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "catalog_rollback");
});

test("CR12A-PILOT-015 makes project and whole-catalog revocation terminal", async () => {
  const first = catalog(), boundary = catalogBoundary(first);
  const revoked = catalog({ revision: 2, previousCatalogDigest: first.catalogDigest, projectState: "revoked", catalogState: "revoked" });
  const revokedCheckpoint = buildProtectedProjectCatalogHighWaterV1({
    catalog: revoked, prior: boundary.checkpoint, checkpointId: "checkpoint.catalog.2", recordedAt: now,
  }, key, highWaterKey);
  boundary.highWater.apply(revokedCheckpoint);
  boundary.set(revoked);
  await assert.rejects(boundary.authority.resolve(projectId, now), (error: unknown) =>
    error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "catalog_revoked");
  const reactivated = catalog({ revision: 3, previousCatalogDigest: revoked.catalogDigest });
  assert.throws(() => buildProtectedProjectCatalogHighWaterV1({
    catalog: reactivated, prior: revokedCheckpoint, checkpointId: "checkpoint.catalog.3", recordedAt: now,
  }, key, highWaterKey), (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "catalog_rollback");
});

test("CR12A-PILOT-015 rejects catalog HMAC, pinned source identity, project identity, and checkpoint substitution", async () => {
  const first = catalog(), boundary = catalogBoundary(first);
  for (const changed of [
    { ...first, catalogAuthTag: `hmac-sha256:${"0".repeat(64)}` },
    { ...first, sourceIdentityDigest: sha256Digest({ source: "foreign" }) },
    { ...first, entries: [{ ...first.entries[0]!, workspaceId: "workspace.foreign" }] },
  ]) {
    boundary.set(changed);
    await assert.rejects(boundary.authority.resolve(projectId, now), ProjectWorkspaceContractErrorV1);
  }
  const wrongHighWater = new InMemoryProjectWorkspaceCatalogHighWaterStoreV1(highWaterKey, { testOnly: true });
  const forged = { ...boundary.checkpoint, checkpointAuthTag: `hmac-sha256:${"0".repeat(64)}` };
  assert.throws(() => wrongHighWater.apply(forged), ProjectWorkspaceContractErrorV1);
  const wrongKeyDomain = buildProtectedProjectCatalogHighWaterV1({
    catalog: first, checkpointId: "checkpoint.catalog.wrong-key", recordedAt: authenticatedAt,
  }, key, key);
  assert.throws(() => wrongHighWater.apply(wrongKeyDomain), ProjectWorkspaceContractErrorV1);
});

test("CR12A-PILOT-015 exact session and catalog boundaries reject Proxies and accessors without executing traps", async () => {
  const { raw, security } = await database();
  try {
    let traps = 0;
    const boundary = catalogBoundary();
    boundary.set(new Proxy(catalog(), { ownKeys() { traps += 1; throw new Error("trap"); } }));
    await assert.rejects(boundary.authority.resolve(projectId, now), ProjectWorkspaceContractErrorV1);
    const authority = new ProjectWorkspaceOwnerReadScopeAuthorityV1({ verify: async () => ({
      ...session(), get subject() { traps += 1; return "owner-subject"; },
    }) }, catalogBoundary().authority, security);
    await assert.rejects(authority.authorize({ credential: {}, projectId, now }), ProjectWorkspaceContractErrorV1);
    assert.equal(traps, 0);
  } finally { await raw.close(); }
});

test("CR12A-PILOT-015 catalog builder retains a complete sorted identity high-water", () => {
  const first = catalog();
  const checkpoint: ProtectedProjectCatalogHighWaterV1 = buildProtectedProjectCatalogHighWaterV1({
    catalog: first, checkpointId: "checkpoint.catalog.1", recordedAt: authenticatedAt,
  }, key, highWaterKey);
  assert.deepEqual(checkpoint.projects.map((entry) => [entry.projectId, entry.workspaceId, entry.projectType, entry.state]),
    [[projectId, workspaceId, "project.test", "active"]]);
  assert.equal(checkpoint.catalogDigest, first.catalogDigest);
});

test("CR12A-PILOT-015 protected configuration rejects key subclasses, Proxies, and accessor-bearing setup", () => {
  let traps = 0;
  class KeySubclass extends Uint8Array {}
  const first = catalog();
  const { catalogDigest: _digest, catalogAuthTag: _tag, ...unsigned } = first;
  void _digest; void _tag;
  assert.throws(() => buildProtectedProjectCatalogV1(unsigned, new KeySubclass(32)), ProjectWorkspaceContractErrorV1);
  const proxyKey = new Proxy(new Uint8Array(32), { get() { traps += 1; throw new Error("trap"); } });
  assert.throws(() => buildProtectedProjectCatalogV1(unsigned, proxyKey), ProjectWorkspaceContractErrorV1);
  const hostileInput = new Proxy({ catalog: first, checkpointId: "checkpoint.hostile", recordedAt: authenticatedAt }, {
    ownKeys() { traps += 1; throw new Error("trap"); },
  });
  assert.throws(() => buildProtectedProjectCatalogHighWaterV1(hostileInput, key, highWaterKey), ProjectWorkspaceContractErrorV1);
  const store = new InMemoryProjectWorkspaceCatalogHighWaterStoreV1(highWaterKey, { testOnly: true });
  const hostileExpected = new Proxy({ catalogId: first.catalogId, tenantId, sourceIdentityDigest }, {
    ownKeys() { traps += 1; throw new Error("trap"); },
  });
  assert.throws(() => new ProjectWorkspaceProtectedCatalogAuthorityV1(
    { read: async () => first }, store, hostileExpected, key, highWaterKey,
  ), ProjectWorkspaceContractErrorV1);
  assert.equal(traps, 0);
});
