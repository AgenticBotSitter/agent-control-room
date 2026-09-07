import { readFile } from "node:fs/promises";
import { fixture, now, origin, trust, type WebFixtureMigrationProfile } from "./web-foundation";
import { seedWebIdea, webIdeaKey } from "./web-idea-project";
import { seedWebConnection, seedWebSignal, webConnectionKeys } from "./web-connection";
import type { PrivateStartupConfiguration } from "../../src/web/v1/private-startup";
import { boundPrivateDatabase } from "../../src/web/v1/bounded-database";

export const startupConfig: PrivateStartupConfiguration = {
  origin, issuer: trust.issuer, audience: trust.audience, maxSessionSeconds: trust.maxSessionSeconds,
  tenantId: "tenant:web", workspaceId: "workspace:web", ownerIdentityId: "identity:web", loadKeys: async () => trust.keys,
  database: { host: "127.0.0.1", port: 5432, database: "template1", username: "web_test", password: "synthetic-only", majorVersion: 17 },
  ideaProjects: { integrityKey: webIdeaKey }, connections: webConnectionKeys,
};
export async function limitedWebFixture(migrationProfile: WebFixtureMigrationProfile = "full") {
  const f = await fixture(() => now, migrationProfile);
  await seedWebIdea(f.client); await seedWebConnection(f.client); await seedWebSignal(f.client);
  await f.db.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.db.exec(`CREATE ROLE web_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_private_web TO web_test;
    SET SESSION AUTHORIZATION web_test;
    SET search_path = pg_catalog, public;
    SET statement_timeout = '5s'; SET lock_timeout = '2s'; SET transaction_timeout = '10s';
    SET idle_in_transaction_session_timeout = '5s'`);
  let closes = 0;
  // PGlite 0.3.14 exposes template1 as its current DB but cannot REVOKE its ACL
  // (XX000 tuple concurrently deleted). Only this connection-metadata field is injected.
  // Production preflight has no override. Real database ACL/connection evidence remains gated.
  const query: typeof f.client.query = async <T>(statement: string, params?: unknown[]) => {
    const result = await f.client.query<Record<string, unknown>>(statement, params);
    if (statement.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
    return result as { rows: T[] };
  };
  const pool = boundPrivateDatabase({ acquire: async () => ({ query, release: () => {} }),
    terminate: async () => { closes++; await f.db.close(); } });
  return { ...f, pool, closes: () => closes, clock: () => now };
}
