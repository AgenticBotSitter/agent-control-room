import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSession } from "./database";
import { sha256Digest } from "../security";

// Narrow structural seam for the evaluated package. Composition supplies the pinned
// constructor; this module never installs/imports a runtime package or opens a pool.
type SqlPort = { executeSql(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
export interface PgBossBoundedSubmissionClient<T> {
  start(): Promise<unknown>;
  stop(options: { graceful: false }): Promise<unknown>;
  on(event: "error", listener: (error: unknown) => void): unknown;
  getQueue(name: string): Promise<unknown>;
  send(name: string, data: T, options: { id: string; retryLimit: 0; db: SqlPort }): Promise<string | null>;
  retry?(name: string, id: string, options: { db: SqlPort }): Promise<unknown>;
  update?(name: string, data: undefined, options: { id: string; retryLimit: 0; db: SqlPort }): Promise<unknown>;
}
export type PgBossBoundedSubmissionConstructor<T> = new (options: {
  db: SqlPort; schema: string; backend: "postgres" | "pglite";
  migrate: false; createSchema: false; supervise: false; schedule: false; useListenNotify: false;
}) => PgBossBoundedSubmissionClient<T>;

export interface BoundedSubmission<T> {
  enqueueInSession(tx: DatabaseSession, reference: T): Promise<void>;
  recoverUnsentInSession?(tx: DatabaseSession, reference: T, ordinal: number): Promise<boolean>;
  close(): Promise<void>;
}
/** Trusted fixed wrapper profile only, never queued or browser input. Schema is fixed. */
export interface BoundedSubmissionProfile<T> {
  name: string; maximumRecoveries: number; unavailableCode: string;
  parse(value: unknown): T; identify(value: T): string; assertQueue(value: unknown): void;
}

/** Explicit preparation against an already-created schema/queue. No migrations,
 * fetching, scheduling, retries or listeners are activated. SQL supplied here must
 * already be bounded by its owning database client. Not wired into app startup. */
export async function preparePgBossBoundedSubmission<T>(
  PgBoss: PgBossBoundedSubmissionConstructor<T>, database: DatabaseSession, profile: BoundedSubmissionProfile<T>,
  options: { backend: "postgres" | "pglite"; recovery?: true } = { backend: "postgres" },
): Promise<BoundedSubmission<T>> {
  const { name, maximumRecoveries, unavailableCode } = profile;
  const parse = profile.parse.bind(profile), identify = profile.identify.bind(profile), assertQueue = profile.assertQueue.bind(profile);
  const unavailable = (): never => { throw new Error(unavailableCode); };
  const context = new AsyncLocalStorage<{ session: DatabaseSession; active: boolean }>();
  let closed = false, faulted = false;
  const assertAvailable = () => { if (closed || faulted) unavailable(); };
  const sql: SqlPort = { async executeSql(statement, values) {
    assertAvailable();
    const current = context.getStore();
    if (current && !current.active) return unavailable();
    return (current?.session ?? database).query(statement, values);
  } };
  const boss = new PgBoss({ db: sql, schema: "control_room_queue", backend: options.backend,
    migrate: false, createSchema: false, supervise: false, schedule: false, useListenNotify: false });
  boss.on("error", () => { faulted = true; });
  const retry = boss.retry?.bind(boss), update = boss.update?.bind(boss);
  try {
    await boss.start();
    assertQueue(await boss.getQueue(name));
    if (options.recovery && (!retry || !update)) unavailable();
    assertAvailable();
  } catch {
    closed = true;
    await boss.stop({ graceful: false });
    return unavailable();
  }
  return Object.freeze({
    ...(options.recovery ? { async recoverUnsentInSession(tx: DatabaseSession, input: T, ordinal: number) {
      assertAvailable();
      if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > maximumRecoveries) unavailable();
      const reference = parse(input), id = identify(reference);
      const current = { session: tx, active: true };
      try { return await context.run(current, async () => {
        const locked = await tx.query("SELECT name FROM control_room_queue.queue WHERE name=$1 FOR SHARE", [name]);
        if (locked.rows.length !== 1) unavailable();
        assertQueue(await boss.getQueue(name));
        type Row = { data: unknown; state: string; retry_limit: number; retry_count: number; policy: string; dead_letter: string | null };
        const rows = await tx.query<Row>(`SELECT data,state,retry_limit,retry_count,policy,dead_letter FROM control_room_queue.job
          WHERE name=$1 AND id=$2 FOR UPDATE`, [name, id]);
        if (rows.rows.length !== 1) unavailable();
        const row = rows.rows[0];
        if (sha256Digest(parse(row.data)) !== sha256Digest(reference)
          || row.retry_limit !== 0 || row.policy !== "standard" || row.dead_letter !== null) unavailable();
        if (row.state !== "failed") return false;
        if (row.retry_count !== ordinal - 1) unavailable();
        const retried = await retry!(name, id, { db: sql });
        if (!retried || typeof retried !== "object" || !("affected" in retried) || retried.affected !== 1) unavailable();
        await update!(name, undefined, { id, retryLimit: 0, db: sql });
        const after = (await tx.query<Row>(`SELECT data,state,retry_limit,retry_count,policy,dead_letter FROM control_room_queue.job
          WHERE name=$1 AND id=$2`, [name, id])).rows;
        if (after.length !== 1 || after[0].state !== "retry" || after[0].retry_limit !== 0
          || after[0].retry_count !== row.retry_count || sha256Digest(after[0].data) !== sha256Digest(row.data)) unavailable();
        assertAvailable(); return true;
      }); } catch { return unavailable(); } finally { current.active = false; }
    } } : {}),
    async enqueueInSession(tx: DatabaseSession, input: T): Promise<void> {
      assertAvailable();
      const reference = parse(input), id = identify(reference);
      const current = { session: tx, active: true };
      try {
        await context.run(current, async () => {
          // Lock the pre-provisioned queue configuration until canonical commit.
          // This prevents a concurrent queue edit enabling retries/dead letters.
          const locked = await tx.query("SELECT name FROM control_room_queue.queue WHERE name=$1 FOR SHARE", [name]);
          if (locked.rows.length !== 1) unavailable();
          assertQueue(await boss.getQueue(name));
          // Both the explicit INSERT override and any cold-cache library query use
          // the exact caller session; no live fetch is needed to prime metadata.
          const result = await boss.send(name, reference, { id, retryLimit: 0, db: sql });
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
