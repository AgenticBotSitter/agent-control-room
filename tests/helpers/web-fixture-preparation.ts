import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite, type QueryResult } from "../../src/persistence/database";
import { boundPrivateDatabase } from "../../src/web/v1/bounded-database";
import { fixtureMigratorScopeDigest, type FixturePreparationInput } from "../../src/web/v1/private-fixture-preparation";
import { rehearsalScopeDigest } from "../../src/web/v1/private-database-rehearsal";
import { now } from "./web-foundation";

export function preparationInput(): FixturePreparationInput {
  const manifest = { commit: "1".repeat(40), tree: "2".repeat(40), artifactDigest: "3".repeat(64) };
  const migrator = { host: "127.0.0.1" as const, port: 5432, database: "cr14b_rehearsal_test", username: "prep_test",
    password: "synthetic-private-password", majorVersion: 17 as const };
  const webDatabase = { host: migrator.host, port: migrator.port, database: migrator.database, username: "web_test", majorVersion: migrator.majorVersion };
  return { manifest, migrator, webDatabase, packet: { manifest, migratorScopeDigest: fixtureMigratorScopeDigest(migrator),
    webScopeDigest: rehearsalScopeDigest({ ...webDatabase, password: "not-used" }), ownerApprovalDigest: "4".repeat(64),
    cleanupPlanDigest: "5".repeat(64), pgPackageDigest: "6".repeat(64), pgVersionNumber: 170005,
    expiresAt: now + 60_000, durationMs: 30_000, dedicatedEmptyDatabase: true, migrationsApplied: "0001-0040",
    setupRolesAccepted: true, maximumConnections: 1, maximumTransactions: 1, maximumStatements: 256,
    installOrProvision: false, automaticRetry: false, cleanup: "close_owned_client_then_operator_database_cleanup" } };
}

/** PGlite only. Real role/table ownership and schema checks; database name and TEMP metadata
 * differ from the native environment. No actual PostgreSQL pool/concurrency/ACL proof is claimed.
 */
export async function emptyPreparationFixture() {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE prep_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT USAGE, CREATE ON SCHEMA public TO prep_test; SET SESSION AUTHORIZATION prep_test;`);
    for (const file of (await readdir("db/migrations")).filter(f => f.endsWith(".sql")).sort())
      await db.exec(await readFile(`db/migrations/${file}`, "utf8"));
    // PGlite RESET retains the latest session user; explicitly restore its synthetic setup role.
    await db.exec("SET SESSION AUTHORIZATION postgres");
    await db.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
    await db.exec(`CREATE ROLE web_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT control_room_private_web TO web_test; SET SESSION AUTHORIZATION prep_test;
      SET search_path = pg_catalog, public; SET statement_timeout = '5s'; SET lock_timeout = '2s';
      SET transaction_timeout = '10s'; SET idle_in_transaction_session_timeout = '5s';`);
    const client = adaptPglite(db), input = preparationInput(), statements: string[] = [];
    input.packet.pgVersionNumber = Number((await client.query<{ version: string }>("SELECT current_setting('server_version_num') AS version")).rows[0].version);
    let opens = 0, closes = 0;
    return { db, client, input, statements, opens: () => opens, closes: () => closes,
      openPool(options: { before?: (sql: string) => void; after?: (sql: string, result: QueryResult<Record<string, unknown>>) => void;
        closeFails?: boolean; observer?: typeof client.query } = {}) {
        opens++;
        return boundPrivateDatabase({ acquire: async () => ({ release: () => {},
          query: async <T>(sql: string, params: unknown[] = []) => {
            statements.push(sql); options.before?.(sql);
            if (sql.includes("FROM pg_stat_activity") && options.observer) return options.observer<T>(sql, params);
            const preparationMetadata = sql.includes("SELECT current_user=session_user"), webMetadata = sql.includes("AS database_temp");
            const bound = preparationMetadata ? [params[0], "template1", params[2]] : webMetadata ? [params[0], "template1"] : params;
            const result = await client.query<Record<string, unknown>>(sql, bound);
            // PGlite template1 TEMP cannot be revoked. The runtime has no such override.
            if (webMetadata) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
            options.after?.(sql, result); return result as QueryResult<T>;
          },
        }), terminate: async () => { closes++; if (options.closeFails) throw new Error("private cleanup detail"); } });
      },
      async useWebRole() { await db.exec("SET SESSION AUTHORIZATION postgres; SET SESSION AUTHORIZATION web_test"); },
    };
  } catch (error) { await db.close(); throw error; }
}
