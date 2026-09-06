import { PgBoss } from "pg-boss";
import type { DatabaseSession } from "./database";
import { PG_BOSS_NATIVE_SUBMISSION } from "./pg-boss-native-task-submission";

/** Explicit read-only rehearsal inspection, not an operational-role grant or automatic repair.
 * Caller supplies a bounded, appropriately authorized SQL port. Never starts pg-boss.
 * Record swallowed probe failures so upstream's best-effort `ok` cannot certify completeness.
 */
export async function inspectInstalledNativeQueueSchema(database: DatabaseSession, signal: AbortSignal) {
  const fail = (): never => { throw new Error("native_queue_schema_inspection_failed"); };
  let failedProbe = false;
  const assertCurrent = () => { if (signal.aborted) fail(); };
  assertCurrent();
  const boss = new PgBoss({ schema: PG_BOSS_NATIVE_SUBMISSION.schema, migrate: false, createSchema: false,
    supervise: false, schedule: false, useListenNotify: false, db: { async executeSql(sql, values) {
      try { assertCurrent(); const result = await database.query(sql, values); assertCurrent(); return result; }
      catch { failedProbe = true; return fail(); }
    } } });
  try {
    const version = await boss.schemaVersion();
    if (version !== 40) fail();
    const report = await boss.detectSchemaDrift();
    assertCurrent();
    if (failedProbe || !report.ok || report.building.length || report.extraIndexes.length) fail();
    return Object.freeze({ packageVersion: PG_BOSS_NATIVE_SUBMISSION.packageVersion, schemaVersion: version,
      inspected: true as const, repairsPerformed: false as const });
  } catch { return fail(); }
}
