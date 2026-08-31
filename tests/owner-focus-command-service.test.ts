import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database";
import { SecurityStore, type VerifiedAuthentication } from "../src/security";
import { AuthorizedOwnerFocusCommandServiceV1, OPERATOR_SURFACES_CONTRACT_V1, OwnerFocusCommandError, OperatorSurfaceStoreV1 } from "../src/operator-surfaces/v1";

const t0 = "2026-08-27T12:00:00.000Z";
const t1 = "2026-08-27T12:01:00.000Z";
const authentication: VerifiedAuthentication = { tenantId: "tenant:1", provider: "test-provider", subject: "owner", verifiedAt: t0, expiresAt: "2026-08-27T12:10:00.000Z" };
const command = { contractVersion: OPERATOR_SURFACES_CONTRACT_V1, commandId: "command:focus:1", tenantId: "tenant:1", operation: "set_owner_focus" as const, projectId: "project:1", idempotencyKey: "owner-focus-idempotency-001", requestedAt: t1, level: "p0" as const, reason: "Keep the blocked review visible" };

async function database(): Promise<PGlite> {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort()) await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:1','One')`);
  return raw;
}

test("CR6E Owner Focus write requires a durable policy decision and records only priority intent", async () => {
  const raw = await database();
  try {
    const db = adaptPglite(raw);
    await new SecurityStore(db).bootstrapOwner({ ...authentication, identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner", now: t1 });
    const result = await new AuthorizedOwnerFocusCommandServiceV1(db).apply({ command, authentication, decisionId: "decision:focus:1" });
    assert.equal(result.replayed, false);
    assert.equal(result.pin?.projectId, "project:1");
    assert.equal(result.authorization.allowed, true);
    assert.deepEqual(await new OperatorSurfaceStoreV1(db).listOwnerFocus({ tenantId: "tenant:1", now: t1 }), [result.pin]);
    assert.equal((await raw.query<{ count: number }>(`SELECT count(*)::int AS count FROM control_outbox`)).rows[0]?.count, 0);
  } finally { await raw.close(); }
});

test("CR6E Owner Focus write denies an unrecognized identity without persisting a pin", async () => {
  const raw = await database();
  try {
    const db = adaptPglite(raw);
    await assert.rejects(new AuthorizedOwnerFocusCommandServiceV1(db).apply({ command, authentication, decisionId: "decision:focus:denied" }), (error: unknown) => error instanceof OwnerFocusCommandError && error.safeCode === "owner_focus_unavailable");
    assert.deepEqual(await new OperatorSurfaceStoreV1(db).listOwnerFocus({ tenantId: "tenant:1", now: t1 }), []);
  } finally { await raw.close(); }
});

test("CR6E Owner Focus write refuses a policy-denied request without persisting a pin", async () => {
  const raw = await database();
  try {
    const db = adaptPglite(raw);
    await new SecurityStore(db).bootstrapOwner({ ...authentication, identityId: "identity:owner", grantId: "grant:owner", displayName: "Owner", now: t1 });
    await raw.query(`UPDATE control_role_grants SET allowed_actions='["other.action"]'::jsonb WHERE tenant_id='tenant:1' AND id='grant:owner'`);
    await assert.rejects(new AuthorizedOwnerFocusCommandServiceV1(db).apply({ command, authentication, decisionId: "decision:focus:forbidden" }), (error: unknown) => error instanceof OwnerFocusCommandError && error.safeCode === "owner_focus_forbidden");
    assert.deepEqual(await new OperatorSurfaceStoreV1(db).listOwnerFocus({ tenantId: "tenant:1", now: t1 }), []);
  } finally { await raw.close(); }
});
