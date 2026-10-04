#!/usr/bin/env node
// A child process that drives the REAL transition path against a REAL cluster
// and is SIGKILLed by its parent at a named seam (B4).
//
// WHY A SEPARATE PROCESS, AND WHY THIS FILE. "A kill between two statements" can
// be simulated by making the second statement throw, and the rehearsal did
// exactly that — against a FILE store with no guards, killing only at journal
// lines. That is a different failure: a thrown error rolls the transaction back
// cleanly, which is precisely what a SIGKILL does NOT do. A kill tears down the
// connection mid-flight and leaves behind whatever had already been committed, so
// the only way to prove the run is not wedged is to actually SIGKILL a process
// that holds a real session, and then look at what the database committed.
//
// THE SEAM, AND WHY THE ORDER OF ITS TWO HALVES IS THE PROTOCOL. `KILL_AT` names
// the seam. The child writes that label to stderr (which the parent reads as a
// pipe) and ONLY THEN parks. That order is the whole protocol, in both
// directions:
//
//   * Label first: a parent that has seen the label knows the child is about to
//     be parked with its PostgreSQL session open, so the SIGKILL that follows
//     lands with the connection still live — which is the state under test.
//   * Not the reverse: park first, then write, and the parent blocks reading a
//     pipe that will never be written. The test then hangs until its own bound
//     instead of failing, and a hung test reports nothing.
//
// So the label goes out first and the never-firing interval is installed second.
// The parent does not assume this works — it kills only after the label arrives,
// and it fails if the child dies before the label, so a regression in this
// ordering shows up as a failure rather than as a hang.
//
// stderr, not stdout: stdout is a pipe here and a buffered write that has not
// been flushed when the process is killed is a label the parent never sees — the
// same hang, arrived at differently. stderr on the same pipe is unbuffered.
//
// Its own process group: the parent starts this with `detached: true`, so the
// whole test owns one group it can tear down in a `finally`. Nothing started here
// is left running if the test throws.
import { Client } from "pg";
import { PostgresUpdaterStoreV1 } from "../src/updater/v1/store.mjs";

// The parent passes these; they are the same production login the store asserts.
const [socketDirectory, port, database, runId, leaseToken, from, to, killAt, terminal] =
  process.argv.slice(2);

/** Say "I am parked at <seam>", then wait to be killed. */
const seam = (label) => {
  if (label !== killAt) return;
  // WriteSync, not `process.stderr.write`: a queued write is a queued write, and
  // the SIGKILL does not wait for the queue to drain.
  process.stderr.write(`${label}\n`);
  // The park: a timer that never fires and is never cleared. The process stays
  // alive with its session open until the parent's SIGKILL lands.
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
  // `after_report` is "the caller knows the move landed and has written nothing
  // else". It is announced BEFORE the `moved:` line, because that line is
  // output the parent must not mistake for a seam label — the parent reads the
  // first line it sees, so a `moved:` line arriving first would resolve the wait
  // with the wrong seam and the test would assert nothing about the parking.
  seam("after_report");
  process.stderr.write(`moved:${moved.state}\n`);
} catch (error) {
  process.stderr.write(`error:${error?.code ?? "no-code"}:${String(error?.message ?? "").split("\n")[0]}\n`);
} finally {
  // Only reached if the parent never killed us, which is the happy path. The
  // kill path leaves this unrun, which is the point.
  await client.end().catch(() => {});
}