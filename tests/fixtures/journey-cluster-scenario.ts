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
//            by the time it is created, and there is no Cluster to stop, so only
//            the registry-backed exit path can clean up.
//
// Prints one machine-readable line: `SCENARIO_DATA_DIR=<path>`.

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { PG_AVAILABLE, needsPg, startCluster, stopCluster, installProcessTeardown, TEST_TMP_DIRECTORY }
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
  // The start is kicked off but not awaited, while this branch watches the
  // filesystem. The moment the run dir appears, the process signals itself: the
  // earliest a signal can arrive after the directory exists, and before the
  // socket dir has a chance to.
  const removeTeardown = installProcessTeardown(() => undefined);
  const root = resolve(process.cwd(), TEST_TMP_DIRECTORY);
  // Only consider directories that appear AFTER this point. A previous run that
  // leaked one would otherwise be matched first, and the test would then assert
  // about a directory this process never created — passing or failing for
  // reasons that have nothing to do with the code under test.
  const preexisting = new Set(existsSync(root) ? readdirSync(root) : []);
  startCluster(`journey-scenario-${mode}-`).catch(() => { /* the signal below ends this */ });
  const deadline = Date.now() + 60_000;
  for (;;) {
    // The root may not exist yet either; an absent directory simply means the
    // start has not reached its own `mkdir`.
    const seen = existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith(`journey-scenario-${mode}-`)
          && !preexisting.has(entry.name))
        .map(entry => join(root, entry.name))
      : [];
    if (seen.length > 0) {
      console.log(`SCENARIO_RUN_DIR=${seen[0]}`);
      console.log(`SCENARIO_DATA_DIR=${join(seen[0], "data")}`);
      break;
    }
    if (Date.now() > deadline) { console.log("SCENARIO_EARLY_TIMEOUT=1"); process.exit(3); }
    await delay(1);
  }
  // Signal this process itself, from a TIMER rather than synchronously here.
  // A synchronous self-signal does not reach a handler installed with
  // `process.on` — the signal is only dispatched once the current turn of the
  // event loop ends, and the unsettled top-level await below means that turn
  // never ends. The result was an exit code 13 ("unsettled top-level await") that
  // skipped the handler entirely, so the run directory survived. A timer yields
  // first, which lets the handler actually run.
  setTimeout(() => { process.kill(process.pid, "SIGTERM"); }, 0);
  // Stay alive until the signal lands, so the handler (and its cleanup) is the
  // thing that ends this process rather than an abandoned top-level await.
  await new Promise<void>(resolve => {
    setTimeout(() => { removeTeardown(); resolve(); }, 60_000);
  });
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
