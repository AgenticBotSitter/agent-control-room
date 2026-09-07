import { generateKeyPairSync, sign } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../../src/persistence/database.ts";
import { SecurityStore } from "../../src/security/security-store.ts";
import { WebProjectService } from "../../src/web/v1/project-service.ts";
import { createProjectHttpHandler } from "../../src/web/v1/project-http.ts";
import type { AccessTrust } from "../../src/web/v1/access-verifier.ts";

export const now = Date.parse("2026-09-04T12:00:00.000Z");
export const origin = "https://private.example.invalid";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const trust: AccessTrust = { issuer: "https://access.example.invalid", audience: "test-app",
  keys: [{ kid: "test-public-key", jwk: keys.publicKey.export({ format: "jwk" }) }], validUntilMs: now + 3600_000, maxSessionSeconds: 604800 };
export function token(changes: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-public-key" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: trust.issuer, aud: [trust.audience], sub: "test-owner", type: "app",
    iat: now / 1000 - 60, exp: now / 1000 + 300, ...changes })).toString("base64url");
  return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), keys.privateKey).toString("base64url")}`;
}
export function request(path = "/api/v1/projects", method = "GET", value?: unknown, key = "test-request-key-0001", jwt = token()) {
  return new Request(`${origin}${path}`, { method, headers: { "cf-access-jwt-assertion": jwt, origin,
    "content-type": "application/json", "idempotency-key": key }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}
export type WebFixtureMigrationProfile = "full" | "without-external-content";
export async function fixture(clock = () => now, migrationProfile: WebFixtureMigrationProfile = "full") {
  const db = new PGlite();
  const omitted = migrationProfile === "without-external-content"
    ? new Set(["0025_cr9a_external_content_sync.sql", "0026_cr9a_external_content_placement.sql"]) : new Set<string>();
  for (const file of (await readdir("db/migrations")).filter(f => f.endsWith(".sql") && !omitted.has(f)).sort())
    await db.exec(await readFile(`db/migrations/${file}`, "utf8"));
  await db.query("INSERT INTO tenants(id,display_name) VALUES('tenant:web','Test tenant')");
  await db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:web','tenant:web','Test workspace')");
  const client = adaptPglite(db);
  await new SecurityStore(client).bootstrapOwner({ tenantId: "tenant:web", provider: trust.issuer, subject: "test-owner",
    identityId: "identity:web", grantId: "grant:web", displayName: "Test owner", verifiedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 300_000).toISOString(), now: new Date(now).toISOString() });
  const service = new WebProjectService(client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, clock);
  return { db, client, service, handler: createProjectHttpHandler({ origin, trust, service, clock }) };
}
