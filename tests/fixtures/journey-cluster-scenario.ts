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
//
// Prints one machine-readable line: `SCENARIO_DATA_DIR=<path>`.

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { PG_AVAILABLE, needsPg, startCluster, stopCluster, installProcessTeardown }
  from "../helpers/disposable-postgres-cluster";

const mode = process.argv[2] ?? "hold";

if (!PG_AVAILABLE) {
  console.log(`SCENARIO_SKIPPED=${needsPg}`);
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
