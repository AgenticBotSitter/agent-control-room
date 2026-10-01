#!/usr/bin/env node
// A child process that drives the REAL transition path against a REAL cluster
// and is SIGKILLed by its parent between two statements (B4).
//
// WHY A SEPARATE PROCESS, AND WHY THIS FILE. "A kill between two statements" can
// be simulated by making the second statement throw, and the rehearsal did
// exactly that — against a FILE store with no guards, killing only at journal
// lines. That is a different failure: a thrown error rolls the transaction back
// cleanly, which is precisely what a SIGKILL does NOT do. A kill tears down the
// connection mid-flight and leaves on disk whatever had been committed, so the
// only way to prove the run is not wedged is to actually SIGKILL a process that
// holds a real session, and then look at what the database committed.
//
// THE SEAM. `KILL_BEFORE` is the label of the statement the child is about to
// run. It writes that label to fd 3 (a pipe the parent reads), then parks. The
// parent sees the label, sends SIGKILL, and the child dies with the session
// still open — no COMMIT, no ROLLBACK, no cleanup. Whatever PostgreSQL had
// already committed for that statement is what survives.
//
// Its own process group: the parent starts it with `detached: true`, so the
// whole test owns one group it can kill in a `finally`. Nothing here is left
// running if the test throws.
import { Client } from "pg";
import { PostgresUpdaterStoreV1 } from "../src/updater/v1/store.mjs";

// The parent passes these; they are the same production login the store asserts.
const [socketDirectory, port, database, runId, leaseToken, from, to, killBefore, terminal] =
  process.argv.slice(2);

/** Say "I am about to run <label>", then wait to be killed. */
const seam = (label) => {
  if (label !== killBefore) return;
  // fd 3 is the notification pipe. Writing and exiting immediately is not
  // allowed here: the parent must SIGKILL this process, and a process that has
  // already exited is not a process that was killed mid-statement.
  process.stdout.write(`${label}\n`);
  setInterval(() => {}, 1_000);
};

const client = new Client({ host: socketDirectory, port: Number(port), database,
  user: "control_room_deployer", password: process.env.CONTROL_ROOM_TEST_DEPLOYER_PASSWORD });

try {
  await client.connect();
  const store = new PostgresUpdaterStoreV1(client);
  await store.initialize();

  seam("before_transition");
  const moved = await store.transition(runId, leaseToken, to, { from, to },
    { terminal: terminal === "true" });
  // The seam AFTER the statement: the row and its mirror event are committed
  // together, so there is no reachable instant in which one is durable and the
  // other is not. The parent kills here too, to prove the NEXT step is still
  // reachable from whatever this one left behind.
  seam("after_transition");
  process.stdout.write(`moved:${moved.state}\n`);
  seam("after_report");
} catch (error) {
  process.stdout.write(`error:${error?.code ?? "no-code"}:${String(error?.message ?? "").split("\n")[0]}\n`);
} finally {
  await client.end().catch(() => {});
}
