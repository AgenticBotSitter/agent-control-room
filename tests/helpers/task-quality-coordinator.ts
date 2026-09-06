import { readFile } from "node:fs/promises";
import { nativeQualityCompletionFixture } from "./native-quality-completion";
import { createTaskCoordinatorLifecycle, type TaskCoordinatorConfiguration } from "../../src/web/v1/task-coordinator-lifecycle";
import { verifyTaskCoordinatorDatabase } from "../../src/web/v1/private-database-preflight";
import type { DatabaseClient } from "../../src/persistence/database";

export function deferredQuality() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

export async function taskQualityCoordinatorFixture(text?: string) {
  const x = await nativeQualityCompletionFixture(text);
  try {
    const { f } = x;
    await f.raw.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
    await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
    await f.raw.exec(`CREATE ROLE quality_coordinator_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT control_room_task_coordinator TO quality_coordinator_test;
      SET SESSION AUTHORIZATION quality_coordinator_test;
      SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
      SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
    const scope = { ...f.scope, ownerIdentityId: "identity:test", issuer: f.accessTrust.issuer };
    const connection = { host: "127.0.0.1" as const, port: 5432, database: "template1", username: "quality_coordinator_test",
      password: "synthetic-only", majorVersion: 17 as const };
    // PGlite does not honor revoked TEMP metadata. This is the only preflight metadata adaptation;
    // all actual queries, permissions, role membership, guard and schema checks remain real.
    const checked: DatabaseClient = { ...f.db, transaction: work => f.db.transaction(tx => work({
      async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
        return result;
      },
    })) };
    let available = true, closes = 0;
    const config: TaskCoordinatorConfiguration = { scope: f.scope, planning: f.plannerConfig, routes: [f.route],
      quality: { ...f.ownerConfig, scenarios: [x.scenario] }, clock: f.clock,
      database: { client: f.db, isAvailable: () => available, close: async () => { closes++; available = false; } } };
    const createOwner = (extra: Partial<TaskCoordinatorConfiguration> = {}) => createTaskCoordinatorLifecycle({ ...config, ...extra });
    const owner = createOwner();
    const request = { ...x.request, projectId: x.registration.projectId, jobId: x.registration.jobId };
    const reconcile = (input = request, signal = new AbortController().signal) => owner.quality!.reconcile(input, signal);
    const asMigrator = async <T>(work: () => Promise<T>) => {
      await f.raw.exec("SET SESSION AUTHORIZATION postgres; RESET ROLE");
      try { return await work(); } finally { await f.raw.exec("RESET ROLE; SET SESSION AUTHORIZATION quality_coordinator_test"); }
    };
    const ownerReview = (decision: "accepted" | "changes_requested" = "accepted") => asMigrator(async () => {
      await f.raw.exec("SET ROLE control_room_private_web"); return x.review(decision);
    });
    return { ...x, owner, config, request, reconcile, createOwner, checked, connection, preflightScope: scope,
      verifyRole: () => verifyTaskCoordinatorDatabase(checked, connection, scope, f.clock()),
      asMigrator, ownerReview, closes: () => closes, unavailable: () => { available = false; },
      close: async () => { await owner.close(); await x.close(); } };
  } catch (error) { await x.close(); throw error; }
}
