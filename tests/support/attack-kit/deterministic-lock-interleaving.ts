// A deterministic two-connection lock interleaving for real PostgreSQL tests.
//
// Every helper here exists because the defect it drives is invisible to a test that
// merely STARTS two things at once. `Promise.all([submit(), archive()])` does not
// create a race: whichever transaction happens to reach `projects` first wins, the
// other one then blocks and reads the winner's committed value, and the test passes
// on a build whose fence leaks work into an archived project. That is exactly what
// the previous version of the r6proj race lane did (see
// tests/r6proj-project-admission-postgres.test.ts).
//
// This helper inverts the ordering. It drives the PRODUCTION helper through a real
// `pg` client on a real connection, and pins every step:
//
//   1. connection A opens a transaction and takes the row lock the archive takes;
//   2. connection B opens a transaction and issues the fence query, which BLOCKS
//      on that row -- and the test WAITS until the wait is real, by observing
//      connection B's own `pg_stat_activity` state (`wait_event_type='Lock'`) over a
//      separate observer connection. Nothing sleeps-and-hopes;
//   3. connection A commits;
//   4. connection B proceeds, and the test asserts what it decided.
//
// Step 2 is the part that makes it a race proof rather than a scheduling
// coincidence, and it is also what lets the test assert the COMMIT ORDER rather
// than infer it from which caller happened to win.
//
// It is deliberately a low-level helper over raw `pg` connections: the ordering has
// to be observable from outside the product code, and the product's own bounded
// driver cannot expose "this statement is blocked" to a test without also becoming
// the thing under test.

import { Client, type ClientConfig } from "pg";

/** A live, connected client. The caller owns `end()`. */
export type RaceClient = Client;

export interface InterleavingStepOptions {
  /** Wall-clock bound for every wait in the interleaving. Exceeding it throws. */
  boundMs?: number;
}

const defaultBoundMs = 30_000;
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/**
 * A promise plus the `settled` flag a caller needs to distinguish "still running"
 * from "finished, with this value" -- which is the distinction the whole helper
 * exists for.
 */
export interface Tracked<T> {
  readonly promise: Promise<T>;
  settled: boolean;
  value?: T;
  error?: unknown;
}

/**
 * Start `work` without awaiting it, and return something the caller can poll.
 *
 * A plain `.then()` is enough for the value; what a plain promise does NOT give the
 * caller is a claim about whether it has settled yet, and the race proof needs that
 * claim at every intermediate step ("B is still blocked", "A has committed").
 */
export function track<T>(work: () => Promise<T>): Tracked<T> {
  // Built in two steps because the settled flag is only assignable on the object,
  // not through a readonly interface: the flag is this helper's whole point.
  const tracked = { settled: false, promise: undefined as unknown as Promise<T>, value: undefined as T | undefined,
    error: undefined as unknown };
  tracked.promise = (async () => {
    try { const value = await work(); tracked.value = value; tracked.settled = true; return value; }
    catch (error) { tracked.error = error; tracked.settled = true; throw error; }
  })();
  // The caller decides when to observe a rejection; an unobserved one must not
  // become an unhandled rejection that kills the process before the assertions run.
  tracked.promise.catch(() => {});
  return tracked as Tracked<T>;
}

/**
 * True once connection `backendPid` is blocked waiting on a lock.
 *
 * Observed through `pg_stat_activity` on a SEPARATE observer connection, which is
 * the only way to see another session's wait state: a blocked statement's own
 * connection cannot report on itself. `pg_stat_activity` is a view every login in
 * this repository can read (it shows activity for all backends, with `state` and
 * `wait_event_type` visible to any role), so this needs no extra grant.
 *
 * `state='active'` with `wait_event_type='Lock'` is the shape a blocked row lock
 * produces: the backend is running a statement and is waiting on a heavyweight
 * lock. A backend that has not started its statement yet, or has already finished,
 * does not report that pair, so a positive result is a real "it is blocked".
 */
export async function waitForLockWait(observer: Client, backendPid: number, options: InterleavingStepOptions = {}) {
  const boundMs = options.boundMs ?? defaultBoundMs;
  const deadline = Date.now() + boundMs;
  for (;;) {
    const result = await observer.query<{ state: string; wait_event_type: string | null }>(
      `SELECT state, wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid=$1`, [backendPid]);
    const row = result.rows[0];
    if (row?.state === "active" && row.wait_event_type === "Lock") return true;
    if (Date.now() >= deadline) {
      throw new Error(`deterministic_interleaving_no_lock_wait:backend=${backendPid}`
        + `:state=${row?.state ?? "gone"}:wait_event_type=${row?.wait_event_type ?? "none"}`);
    }
    await sleep(20);
  }
}

/**
 * True once `backendPid` HOLDS a row lock on `relation`, and is not waiting for one.
 *
 * The complement of `waitForLockWait`, and needed for the reverse ordering: to prove
 * two transactions contended, the first has to be holding the lock the second then
 * waits for. `pg_locks` reports a held row lock as `granted=true` with a relation
 * OID, and `relation` is the table name to match.
 *
 * `pg_locks` is readable by any role on a non-superuser cluster (it shows locks
 * for all backends; only the `pg_stat_activity`-style columns are restricted), so
 * this needs no extra grant.
 */
export async function waitForHeldLock(observer: Client, backendPid: number, relation: string,
  options: InterleavingStepOptions = {}) {
  const boundMs = options.boundMs ?? defaultBoundMs;
  const deadline = Date.now() + boundMs;
  const statement = `SELECT 1 FROM pg_catalog.pg_locks l
      JOIN pg_catalog.pg_class c ON c.oid = l.relation
     WHERE l.pid = $1 AND l.granted AND c.relname = $2 LIMIT 1`;
  for (;;) {
    if ((await observer.query(statement, [backendPid, relation])).rows.length > 0) return true;
    if (Date.now() >= deadline)
      throw new Error(`deterministic_interleaving_no_held_lock:backend=${backendPid}:relation=${relation}`);
    await sleep(20);
  }
}

/** Wait until `work` has settled, or throw. The complement of `waitForLockWait`. */
export async function waitForSettlement(work: Tracked<unknown>, options: InterleavingStepOptions = {}): Promise<unknown> {
  const boundMs = options.boundMs ?? defaultBoundMs;
  const deadline = Date.now() + boundMs;
  while (!work.settled) {
    if (Date.now() >= deadline) throw new Error("deterministic_interleaving_work_never_settled");
    await sleep(20);
  }
  if (work.error !== undefined) throw work.error;
  return work.value;
}

/**
 * Begin a transaction on a fresh connection and return it with its backend pid.
 *
 * The pid is read from the server (`pg_backend_pid()`) rather than guessed, because
 * every observation below keys on it. The caller must `ROLLBACK` or `COMMIT` and
 * `end()` it; `closeRaceClient` does both in a `finally`-safe way.
 */
export async function openTransaction(config: ClientConfig, applicationName: string): Promise<{
  client: RaceClient; backendPid: number; release: () => Promise<void>;
}> {
  const client = new Client({ ...config, application_name: applicationName });
  await client.connect();
  const backendPid = Number((await client.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0]!.pid);
  await client.query("BEGIN");
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  };
  return { client, backendPid, release };
}

/** A plain observer connection, used only for `pg_stat_activity` reads. */
export async function openObserver(config: ClientConfig, applicationName: string): Promise<{
  client: RaceClient; close: () => Promise<void>;
}> {
  const client = new Client({ ...config, application_name: applicationName });
  await client.connect();
  return { client, close: async () => { await client.end().catch(() => {}); } };
}