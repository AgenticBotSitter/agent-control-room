import type { DatabaseSession } from "../../persistence/database";
import type { RehearsalProbe } from "./private-rehearsal-probe";
import { RehearsalProbeError } from "./private-rehearsal-probe";

export const rehearsalCheckNames = ["preflight", "unsuitable_scope_rejected", "synthetic_fixture", "project_commands",
  "catalog_and_connections", "protected_columns", "lock_serialization", "lock_timeout", "statement_timeout",
  "transaction_timeout", "idle_session_absence", "pool_capacity", "drain", "pool_reopen_receipts", "logout"] as const;
export type RehearsalCheck = typeof rehearsalCheckNames[number];
export type CheckRecorder = (name: RehearsalCheck) => void;
const requireTrue = (value: unknown) => { if (value !== true) throw new Error("rehearsal_check_failed"); };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Fixed rollback-only permission checks. No supplied SQL, arbitrary target or privilege repair. */
export async function checkProtectedColumns(probe: RehearsalProbe) {
  for (const statement of [
    "UPDATE control_identities SET state=state WHERE false",
    "UPDATE control_role_grants SET expires_at=expires_at WHERE false",
    "UPDATE control_connection_enrollments SET result_digest=result_digest WHERE false",
    "UPDATE control_web_sessions SET expires_at=expires_at WHERE false",
  ]) {
    await probe.query("BEGIN");
    let denied = false;
    try { await probe.query(statement); }
    catch (error) { if (!(error instanceof RehearsalProbeError) || error.code !== "42501") throw error; denied = true; }
    await probe.query("ROLLBACK");
    requireTrue(denied);
  }
}

/** Two independently reserved same-role sessions, plus read-only observation through the web pool.
 * `checkpoint` fences work after cancellation/deadline. Injectable timing is for deterministic tests only.
 */
export async function checkPostgresLimits(input: {
  a: RehearsalProbe; b: RehearsalProbe; observer: DatabaseSession; tenantId: string; ownerIdentityId: string;
  record: CheckRecorder; checkpoint: () => void; timing?: { now: () => number; sleep: (ms: number) => Promise<void> };
}) {
  const { a, b, observer, record, checkpoint } = input;
  const { now, sleep } = input.timing ?? { now: () => performance.now(), sleep: delay };
  const query = async <T>(db: DatabaseSession, statement: string, params?: unknown[]) => {
    checkpoint(); const result = await db.query<T>(statement, params); checkpoint(); return result;
  };
  const pid = async (db: DatabaseSession) => {
    const row = (await query<{ pid: number }>(db, "SELECT pg_backend_pid() AS pid")).rows[0];
    requireTrue(Number.isSafeInteger(row?.pid) && row.pid > 0); return row.pid;
  };
  const [aPid, bPid] = [await pid(a), await pid(b)]; requireTrue(aPid !== bPid);
  const lock = "SELECT id FROM control_identities WHERE tenant_id=$1 AND id=$2 FOR UPDATE";
  const params = [input.tenantId, input.ownerIdentityId];
  const hold = async () => {
    await query(a, "BEGIN"); requireTrue((await query(a, lock, params)).rows.length === 1);
    await query(b, "BEGIN");
  };
  await hold();
  // Attach both outcomes immediately: a failed observer must not leave an unhandled lock promise.
  let settled = false;
  const waiting = query(b, lock, params).then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
  const started = now(); let observedLock = false;
  for (let count = 0; count < 40 && now() - started < 1500 && !settled; count++) {
    const row = (await query<{ blocked: boolean }>(observer,
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=current_user AND wait_event_type='Lock') AS blocked", [bPid])).rows[0];
    if (row?.blocked === true) { observedLock = true; break; }
    await sleep(25); checkpoint();
  }
  requireTrue(observedLock && !settled);
  await query(a, "ROLLBACK");
  const unlocked = await waiting;
  requireTrue("result" in unlocked && unlocked.result.rows.length === 1);
  await query(b, "ROLLBACK"); record("lock_serialization");

  const expected = async (db: DatabaseSession, statement: string, code: string, min: number, max: number, values?: unknown[]) => {
    const began = now(); let matched = false;
    try { await query(db, statement, values); }
    catch (error) { if (!(error instanceof RehearsalProbeError) || error.code !== code) throw error; matched = true; }
    checkpoint(); requireTrue(matched && now() - began >= min && now() - began <= max);
  };
  await hold();
  await expected(b, lock, "55P03", 1750, 4000, params);
  await query(b, "ROLLBACK"); await query(a, "ROLLBACK"); record("lock_timeout");
  await expected(a, "SELECT pg_sleep(6)", "57014", 4500, 7500); record("statement_timeout");

  // Keep each statement below 5s so the 10s transaction limit, not statement/idle timeout, is observed.
  await query(a, "BEGIN"); const transactionBegan = now();
  await query(a, "SELECT pg_sleep(4)"); await query(a, "SELECT pg_sleep(4)");
  await expected(a, "SELECT pg_sleep(4)", "25P04", 0, 4000);
  requireTrue(now() - transactionBegan >= 9000 && now() - transactionBegan <= 12_000);
  // Do not query the terminated connection or give the driver a reason to replace it.
  await a.close(); record("transaction_timeout");

  await query(b, "BEGIN"); const idleBegan = now();
  await sleep(4500); checkpoint(); requireTrue(!b.isClosed());
  const idle = (await query<{ idle: boolean }>(observer,
    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=current_user AND state='idle in transaction') AS idle", [bPid])).rows[0];
  requireTrue(idle?.idle === true);
  await sleep(1000); checkpoint();
  requireTrue(now() - idleBegan >= 5000 && now() - idleBegan <= 7500 && b.isClosed());
  const absence = (await query<{ absent: boolean }>(observer,
    "SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()) AS absent", [bPid])).rows[0];
  // postgres.js does not expose the cause of an idle ErrorResponse. This is observed absence,
  // not proof of SQLSTATE 25P03; a disconnect in the same interval cannot be distinguished.
  requireTrue(absence?.absent === true); await b.close(); record("idle_session_absence");
}
