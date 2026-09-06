import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSession } from "./database";
import { MAX_NATIVE_UNSENT_RECOVERIES, nativeTaskSubmissionReferenceSchema, type NativeTaskSubmission, type NativeTaskSubmissionReference } from "./native-task-submission";
import { sha256Digest } from "../security";

export const PG_BOSS_NATIVE_SUBMISSION = Object.freeze({
  packageVersion: "12.30.0", schema: "control_room_queue", name: "native-task-delivery", table: "job_common",
});

// Narrow structural seam for the evaluated package. Composition supplies the pinned
// constructor; this module never installs/imports a runtime package or opens a pool.
type SqlPort = { executeSql(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
export interface PgBossSubmissionClient {
  start(): Promise<unknown>;
  stop(options: { graceful: false }): Promise<unknown>;
  on(event: "error", listener: (error: unknown) => void): unknown;
  getQueue(name: string): Promise<unknown>;
  send(name: string, data: NativeTaskSubmissionReference, options: { id: string; retryLimit: 0; db: SqlPort }): Promise<string | null>;
  retry?(name: string, id: string, options: { db: SqlPort }): Promise<unknown>;
  update?(name: string, data: undefined, options: { id: string; retryLimit: 0; db: SqlPort }): Promise<unknown>;
}
export type PgBossSubmissionConstructor = new (options: {
  db: SqlPort; schema: string; backend: "postgres" | "pglite";
  migrate: false; createSchema: false; supervise: false; schedule: false; useListenNotify: false;
}) => PgBossSubmissionClient;

const unavailable = (): never => { throw new Error("native_task_submission_unavailable"); };

export function nativeTaskSubmissionId(value: NativeTaskSubmissionReference): string {
  const reference = nativeTaskSubmissionReferenceSchema.parse(value);
  const queueId = `native-queue:${sha256Digest({ tenantId: reference.tenantId, jobId: reference.jobId, attemptId: reference.attemptId }).slice(7)}`;
  if (reference.queueId !== queueId) return unavailable();
  // Stable UUID for the operational row; canonical history, not this truncated
  // digest or pg-boss retention, is the permanent replay authority.
  const hex = sha256Digest({ purpose: "pg-boss-native-submission/v1", tenantId: reference.tenantId, queueId }).slice(7);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function assertPgBossNativeQueue(value: unknown): void {
  if (!value || typeof value !== "object") unavailable();
  const q = value as Record<string, unknown>;
  if (q.name !== PG_BOSS_NATIVE_SUBMISSION.name || q.table !== PG_BOSS_NATIVE_SUBMISSION.table
    || q.policy !== "standard" || q.partition !== false || q.retryLimit !== 0
    || q.deadLetter != null || q.notify !== false) unavailable();
}

/** Explicit preparation against an already-created schema/queue. No migrations,
 * fetching, scheduling, retries or listeners are activated. SQL supplied here must
 * already be bounded by its owning database client. Not wired into app startup. */
export async function preparePgBossNativeTaskSubmission(
  PgBoss: PgBossSubmissionConstructor, database: DatabaseSession,
  options: { backend: "postgres" | "pglite"; recovery?: true } = { backend: "postgres" },
): Promise<NativeTaskSubmission & { close(): Promise<void> }> {
  const context = new AsyncLocalStorage<{ session: DatabaseSession; active: boolean }>();
  let closed = false, faulted = false;
  const assertAvailable = () => { if (closed || faulted) unavailable(); };
  const sql: SqlPort = { async executeSql(statement, values) {
    assertAvailable();
    const current = context.getStore();
    if (current && !current.active) return unavailable();
    return (current?.session ?? database).query(statement, values);
  } };
  const boss = new PgBoss({ db: sql, schema: PG_BOSS_NATIVE_SUBMISSION.schema, backend: options.backend,
    migrate: false, createSchema: false, supervise: false, schedule: false, useListenNotify: false });
  boss.on("error", () => { faulted = true; });
  const retry = boss.retry?.bind(boss), update = boss.update?.bind(boss);
  try {
    await boss.start();
    assertPgBossNativeQueue(await boss.getQueue(PG_BOSS_NATIVE_SUBMISSION.name));
    if (options.recovery && (!retry || !update)) unavailable();
    assertAvailable();
  } catch {
    closed = true;
    await boss.stop({ graceful: false });
    return unavailable();
  }
  return Object.freeze({
    ...(options.recovery ? { async recoverUnsentInSession(tx: DatabaseSession, input: NativeTaskSubmissionReference, ordinal: number) {
      assertAvailable();
      if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > MAX_NATIVE_UNSENT_RECOVERIES) unavailable();
      const reference = nativeTaskSubmissionReferenceSchema.parse(input), id = nativeTaskSubmissionId(reference);
      const current = { session: tx, active: true };
      try { return await context.run(current, async () => {
        const locked = await tx.query("SELECT name FROM control_room_queue.queue WHERE name=$1 FOR SHARE", [PG_BOSS_NATIVE_SUBMISSION.name]);
        if (locked.rows.length !== 1) unavailable();
        assertPgBossNativeQueue(await boss.getQueue(PG_BOSS_NATIVE_SUBMISSION.name));
        type Row = { data: unknown; state: string; retry_limit: number; retry_count: number; policy: string; dead_letter: string | null };
        const rows = await tx.query<Row>(`SELECT data,state,retry_limit,retry_count,policy,dead_letter FROM control_room_queue.job
          WHERE name=$1 AND id=$2 FOR UPDATE`, [PG_BOSS_NATIVE_SUBMISSION.name, id]);
        if (rows.rows.length !== 1) unavailable();
        const row = rows.rows[0];
        if (sha256Digest(nativeTaskSubmissionReferenceSchema.parse(row.data)) !== sha256Digest(reference)
          || row.retry_limit !== 0 || row.policy !== "standard" || row.dead_letter !== null) unavailable();
        if (row.state !== "failed") return false;
        if (row.retry_count !== ordinal - 1) unavailable();
        const retried = await retry!(PG_BOSS_NATIVE_SUBMISSION.name, id, { db: sql });
        if (!retried || typeof retried !== "object" || !("affected" in retried) || retried.affected !== 1) unavailable();
        await update!(PG_BOSS_NATIVE_SUBMISSION.name, undefined, { id, retryLimit: 0, db: sql });
        const after = (await tx.query<Row>(`SELECT data,state,retry_limit,retry_count,policy,dead_letter FROM control_room_queue.job
          WHERE name=$1 AND id=$2`, [PG_BOSS_NATIVE_SUBMISSION.name, id])).rows;
        if (after.length !== 1 || after[0].state !== "retry" || after[0].retry_limit !== 0
          || after[0].retry_count !== row.retry_count || sha256Digest(after[0].data) !== sha256Digest(row.data)) unavailable();
        assertAvailable(); return true;
      }); } catch { return unavailable(); } finally { current.active = false; }
    } } : {}),
    async enqueueInSession(tx: DatabaseSession, input: NativeTaskSubmissionReference): Promise<void> {
      assertAvailable();
      const reference = nativeTaskSubmissionReferenceSchema.parse(input), id = nativeTaskSubmissionId(reference);
      const current = { session: tx, active: true };
      try {
        await context.run(current, async () => {
          // Lock the pre-provisioned queue configuration until canonical commit.
          // This prevents a concurrent queue edit enabling retries/dead letters.
          const locked = await tx.query("SELECT name FROM control_room_queue.queue WHERE name=$1 FOR SHARE", [PG_BOSS_NATIVE_SUBMISSION.name]);
          if (locked.rows.length !== 1) unavailable();
          assertPgBossNativeQueue(await boss.getQueue(PG_BOSS_NATIVE_SUBMISSION.name));
          // Both the explicit INSERT override and any cold-cache library query use
          // the exact caller session; no live fetch is needed to prime metadata.
          const result = await boss.send(PG_BOSS_NATIVE_SUBMISSION.name, reference, { id, retryLimit: 0, db: sql });
          assertAvailable();
          // A fresh canonical intent cannot silently adopt an existing/orphan job.
          // Authenticated canonical replay is handled before calling this adapter.
          if (result !== id) unavailable();
        });
      } catch { return unavailable(); }
      finally { current.active = false; }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await boss.stop({ graceful: false });
    },
  });
}
