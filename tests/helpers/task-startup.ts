import { readFile } from "node:fs/promises";
import { taskAssignmentFixture } from "./task-assignment";
import { origin } from "./web-foundation";
import type { DatabaseClient, DatabaseSession } from "../../src/persistence/database";
import type { PrivateTaskStartupConfiguration } from "../../src/web/v1/private-task-startup";

export async function taskStartupFixture(base?: Awaited<ReturnType<typeof taskAssignmentFixture>>) {
  const f = base ?? await taskAssignmentFixture();
  await f.raw.query("SELECT set_config('control_room.setup_tenant_id',$1,false)", [f.scope.tenantId]);
  await f.raw.exec(await readFile("db/setup/private_idea_adapter.sql", "utf8"));
  await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.raw.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
  await f.raw.exec(`CREATE ROLE web_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE coordinator_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_private_web TO web_test; GRANT control_room_task_coordinator TO coordinator_test;
    SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
    SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
  // One disposable PGlite backend, serialized transactions with actual LOGIN session identities.
  // This proves SQL privileges, not physical independent PostgreSQL connections or concurrency.
  // Only the known PGlite database TEMP metadata limitation is injected; both real gates run.
  const pool = (login: "web_test" | "coordinator_test" | "idea_test" | "idea_runtime_test" | "news_test" | "ingestion_test") => {
    let closes = 0, available = true;
    const client: DatabaseClient = {
      query: (sql, params) => client.transaction(tx => tx.query(sql, params)),
      transaction: work => client.transactionWithPreCommitCheck(work, () => {}),
      transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
        await tx.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
        const session: DatabaseSession = { async query<T>(sql: string, params?: unknown[]) {
          const result = await tx.query<T>(sql, params);
          if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
          return result;
        } };
        return work(session);
      }, check),
    };
    return { client, close: async () => { closes++; available = false; }, isAvailable: () => available,
      closes: () => closes, quarantine: () => { available = false; } };
  };
  const web = pool("web_test"), coordinator = pool("coordinator_test");
  const database = { host: "127.0.0.1" as const, port: 5432, database: "template1", username: "web_test", password: "synthetic-only", majorVersion: 17 as const };
  if (!f.ownerKeys.harnessIntegrityKey) throw new Error("fixture key missing");
  const config: PrivateTaskStartupConfiguration = {
    web: { ...f.accessTrust, ...f.scope, origin, ownerIdentityId: "identity:test", loadKeys: async () => f.accessTrust.keys,
      database, tasks: { ...f.ownerKeys, harnessIntegrityKey: f.ownerKeys.harnessIntegrityKey } },
    coordinator: { database: { ...database, username: "coordinator_test" }, planning: f.plannerConfig, routes: [f.route] },
  };
  return { ...f, web, coordinator, config, pool, openDatabase: (db: { username: string }) => db.username === "web_test" ? web : coordinator };
}
