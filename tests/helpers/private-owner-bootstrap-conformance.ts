import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite, type DatabaseClient } from "../../src/persistence/database";
import { sha256Digest } from "../../src/security";
import type { AccessTrust } from "../../src/web/v1/access-verifier";
import type { PrivateOwnerBootstrapConfiguration } from "../../src/web/v1/private-owner-bootstrap";
import type { PrivatePostgresConfiguration } from "../../src/web/v1/private-postgres";

export const conformanceNow = Date.parse("2026-09-13T15:30:00.000Z");
export const conformanceOrigin = "https://private.example.invalid";
export const conformanceIssuer = "https://access.example.invalid";
export const conformanceAudience = "control-room-conformance";
export const conformanceSubject = "synthetic-owner@example.invalid";
export const conformanceEmail = "distinct-synthetic-email@example.invalid";

export type SyntheticSigningKey = ReturnType<typeof syntheticSigningKey>;

export function syntheticSigningKey(kid = "synthetic-access-key") {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return Object.freeze({ kid, privateKey: pair.privateKey,
    publicKey: Object.freeze({ kid, jwk: pair.publicKey.export({ format: "jwk" }) }) });
}

export function syntheticAccessTrust(key: SyntheticSigningKey, now = conformanceNow): AccessTrust {
  return { issuer: conformanceIssuer, audience: conformanceAudience, keys: [key.publicKey],
    validUntilMs: now + 3_600_000, maxSessionSeconds: 3600 };
}

export function syntheticAssertion(key: { kid: string; privateKey: KeyObject }, changes: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: conformanceIssuer, aud: [conformanceAudience],
    sub: conformanceSubject, email: conformanceEmail, type: "app", iat: conformanceNow / 1000 - 60,
    exp: conformanceNow / 1000 + 1800, ...changes })).toString("base64url");
  return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), key.privateKey).toString("base64url")}`;
}

let shared: Promise<{ raw: PGlite; client: DatabaseClient }> | undefined;
let leased = false;
let instancesCreated = 0;

async function sharedDatabase() {
  if (!shared) shared = (async () => {
    instancesCreated++;
    if (instancesCreated > 1) throw new Error("offline_auth_pglite_instance_limit_exceeded");
    const raw = new PGlite();
    for (const file of (await readdir("db/migrations")).filter(name => name.endsWith(".sql")).sort())
      await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
    await raw.query("INSERT INTO tenants(id,display_name) VALUES('tenant:bootstrap','Synthetic tenant')");
    await raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:bootstrap','tenant:bootstrap','Synthetic workspace')");
    return { raw, client: adaptPglite(raw) };
  })();
  return shared;
}

export function privateOwnerBootstrapPgliteInstances() { return instancesCreated; }

export async function closePrivateOwnerBootstrapConformanceDatabase() {
  if (leased) throw new Error("offline_auth_fixture_still_leased");
  const current = shared ? await shared : undefined;
  if (current) await current.raw.close();
}

export async function privateOwnerBootstrapFixture(options: { fresh?: boolean | string } = {}) {
  if (leased) throw new Error("offline_auth_fixture_already_leased");
  const { raw, client } = await sharedDatabase();
  await client.query("DELETE FROM control_web_sessions WHERE tenant_id='tenant:bootstrap'");
  await client.query("DELETE FROM control_role_grants WHERE tenant_id='tenant:bootstrap'");
  await client.query("DELETE FROM control_identities WHERE tenant_id='tenant:bootstrap'");
  leased = true;
  const key = syntheticSigningKey(), trust = syntheticAccessTrust(key);
  const suffix = typeof options.fresh === "string" ? options.fresh : options.fresh ? "fresh" : "bootstrap";
  const configuration: PrivateOwnerBootstrapConfiguration = {
    databaseName: "template1", tenantId: `tenant:${suffix}`, workspaceId: `workspace:${suffix}`,
    tenantDisplayName: "Synthetic tenant", workspaceDisplayName: "Synthetic workspace",
    identityId: `identity:synthetic-owner-${suffix}`, grantId: `grant:synthetic-owner-${suffix}`, displayName: "Synthetic owner",
    expectedOwnerSubjectDigest: sha256Digest({ provider: conformanceIssuer, subject: conformanceSubject }),
  };
  const database: PrivatePostgresConfiguration = { host: "127.0.0.1", port: 5432, database: "template1",
    username: "synthetic_bootstrap", password: "synthetic-password-never-output", majorVersion: 17 };
  let opens = 0, closes = 0;
  const openDatabase = (selected: DatabaseClient = client, close: () => Promise<void> = async () => { closes++; }) =>
    (_input: PrivatePostgresConfiguration) => { opens++; return Object.freeze({ client: selected, close, isAvailable: () => true }); };
  const counts = async () => {
    const identities = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM control_identities WHERE tenant_id=$1", [configuration.tenantId]);
    const grants = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM control_role_grants WHERE tenant_id=$1", [configuration.tenantId]);
    return { identities: Number(identities.rows[0]?.count ?? -1), grants: Number(grants.rows[0]?.count ?? -1) };
  };
  let released = false;
  return { raw, client, key, trust, configuration, database, assertion: syntheticAssertion(key), openDatabase, counts,
    stats: () => ({ opens, closes }), async close() { if (!released) { released = true; leased = false; } } };
}

export function afterCommitUncertain(client: DatabaseClient): DatabaseClient {
  return { query: client.query.bind(client), transaction: client.transaction.bind(client),
    async transactionWithPreCommitCheck(work, check) {
      await client.transactionWithPreCommitCheck(work, check);
      throw new Error("synthetic_commit_acknowledgement_lost");
    } };
}
