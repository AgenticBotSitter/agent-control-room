// Scenario fixture for the journey-cluster hygiene lane.
//
// Starts a disposable cluster with the SAME production helper the journey lane
// uses, then holds it open until it is signalled or told to fail. The hygiene
// test spawns this as a child process so it can be hostile to the lifecycle
// (SIGTERM mid-run, or a failing assertion) without the lane killing itself.
//
// Modes (argv[2]):
//   hold   — start the cluster, print its data dir and pid, then stay alive
//   fail   — start the cluster, print its data dir and pid, then fail an
//            assertion, so the file-level `after` hook must still tear down
//   idle   — start the cluster, print, and exit immediately with no teardown
//            at all: the process `exit` handler is the only thing that can
//            clean this up, which is exactly the interrupted-run case.
//   stall  — the start interruption case: pause inside `startCluster` with the
//            postmaster already launched but before it resolves, so nothing in
//            this file has a Cluster to tear down and only the process-level
//            handlers can clean up. Prints the run and data directories as soon
//            as they exist, so the parent knows what to assert is gone.
//   early  — the pre-start window: signal this process the instant the run
//            directory appears, before any socket directory or postmaster exists.
//            The directories leak here if the helper has not registered the run
//            by the time it is created, and there is no returned Cluster to stop,
//            so only the registry-backed process teardown can clean up.
//
// Prints one machine-readable line: `SCENARIO_DATA_DIR=<path>`.

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { PG_AVAILABLE, needsPg, startCluster, stopCluster, installProcessTeardown }
  from "../helpers/disposable-postgres-cluster";
import type { Cluster } from "../helpers/disposable-postgres-cluster";

const mode = process.argv[2] ?? "hold";

if (!PG_AVAILABLE) {
  console.log(`SCENARIO_SKIPPED=${needsPg}`);
} else if (mode === "stall") {
  // The hostile window: the postmaster is running, `startCluster`'s promise has
  // not resolved, and this file therefore holds no Cluster at all. The teardown
  // handlers are installed FIRST, exactly as the journey lane does, so a SIGTERM
  // arriving in the next line has to be caught by the helper's own registry —
  // nothing here could clean up.
  let cluster: Cluster | undefined;
  const removeTeardown = installProcessTeardown(() => cluster);
  startCluster(`journey-scenario-${mode}-`, { afterPostmasterLaunch: async inFlight => {
    // Report this run's own directories straight from the handle the start
    // passes in. Deliberately NOT read from the registry: a fixture that had to
    // consult the registry to name its own directories could not report anything
    // in the pre-fix state, so the test's precondition would depend on the very
    // mechanism it is testing.
    console.log(`SCENARIO_RUN_DIR=${inFlight.run}`);
    console.log(`SCENARIO_DATA_DIR=${inFlight.data}`);
    console.log(`SCENARIO_SOCKET_DIR=${inFlight.socket}`);
    // The port as known DURING the start. If the start resolved first, this
    // would be the bound port; while it is in flight, the registry entry has the
    // requested one. The test asserts this is the requested value, which is a
    // real signal that the start has not resolved yet — printing nothing here
    // (as this mode did at first) would have made that assertion vacuous.
    console.log(`SCENARIO_PORT=${inFlight.port}`);
    // Never settles, and a timer holds the event loop open. Both are required:
    // an unawaited never-settling promise is not a pending job, so node would
    // exit the moment pg_ctl's child handles closed, and the test would be
    // signalling an already-dead process instead of an in-flight start. The
    // timer is cleared by the process exiting, never by the test.
    const hold = setInterval(() => {}, 1_000);
    await new Promise<void>(() => { void hold; /* only a signal ends this start */ });
  } }).then(ready => {
    // The only marker that the start RESOLVED. Its absence is what proves to the
    // test that the promise had not settled when the signal was sent; the
    // directories and the pid file are all in place before this line can run.
    console.log("SCENARIO_RESOLVED=1");
    cluster = ready;
    removeTeardown();
  }).catch(() => { removeTeardown(); });
} else if (mode === "early") {
  // The pre-start window: the run directory exists, but the socket directory and
  // the postmaster do not. This is the gap a signal can land in with nothing
  // running at all, and where an empty run dir used to survive every time —
  // because the run was not registered until after the socket `mkdtemp`, an
  // `await` wide enough to be hit.
  //
  // The helper pauses at an explicit checkpoint immediately after registering
  // the run and before it begins creating the socket directory. Filesystem
  // polling used to make this timing-dependent: on a busy full lane it could
  // observe the run only after initdb had started, so its child could race the
  // synchronous signal cleanup while both changed the same directory.
  const removeTeardown = installProcessTeardown(() => undefined);
  await startCluster(`journey-scenario-${mode}-`, { afterRunDirectoryRegistered: async inFlight => {
    console.log(`SCENARIO_RUN_DIR=${inFlight.run}`);
    console.log(`SCENARIO_DATA_DIR=${inFlight.data}`);
    // Empty is an asserted precondition: the checkpoint must remain before the
    // socket directory is assigned and before any PostgreSQL command starts.
    console.log(`SCENARIO_SOCKET_DIR=${inFlight.socket}`);
    // Keep the event loop referenced after the zero-delay kill timer fires.
    // Without this, Node can classify the never-settling top-level await as
    // exit 13 before it dispatches the queued signal; the generic `exit` hook
    // then cleans the directory and gives a false-positive SIGTERM test.
    const hold = setInterval(() => {}, 1_000);
    setTimeout(() => { process.kill(process.pid, "SIGTERM"); }, 0);
    await new Promise<void>(() => { void hold; /* only the signal ends this checkpoint */ });
  } }).finally(removeTeardown);
} else {
  let cluster = await startCluster(`journey-scenario-${mode}-`);
  const removeTeardown = installProcessTeardown(() => cluster);
  console.log(`SCENARIO_DATA_DIR=${cluster.data}`);
  console.log(`SCENARIO_SOCKET_DIR=${cluster.socket}`);
  console.log(`SCENARIO_PORT=${cluster.port}`);

  if (mode === "fail") {
    after(async () => {
      try { if (cluster) await stopCluster(cluster); } finally { removeTeardown(); }
    });
    test("a journey assertion that fails on purpose", () => {
      assert.equal(1, 2, "deliberate failure: the cluster must still be stopped and removed");
    });
  } else if (mode === "idle") {
    // No `after` hook: exiting the process is the interruption. The `exit`
    // handler installed above is the only teardown that will run.
    process.exit(0);
  } else {
    // Stay alive so the parent can signal us mid-run.
    setInterval(() => {}, 1_000);
  }
}
