// CR-E081 partitions independent clusters across file clocks without changing
// their assertions, real migration ledger, roles, faults or 240000ms budget.
// Lifecycle, shutdown faults and role refusals each close their own lane.
// PG_BIN supplies the real PostgreSQL binaries in the CI lane.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { describe } from "node:test";
import { portIsOccupied, withRealPostgres } from "./support/attack-kit/index.ts";
import { createLane, PORTS } from "./support/attack-kit/suite-lane.ts";

const lane = await createLane();
const { needsPgOrFail, countedRealPostgresRun, temporary } = lane;

describe("attack kit: real PostgreSQL", () => {

  // A postmaster that was started and then orphaned. `startCluster` set
  // `started = true` and caught every `postmaster.pid` read failure, so the pid
  // could be undefined even though the server was running; `stop` only attempted
  // `pg_ctl stop` inside `if (pid !== undefined)` and otherwise deleted the data
  // and socket directories, so the run reported a clean teardown with a live
  // postmaster behind it and no way left to stop or diagnose it. This injects
  // exactly that pid-read failure after a REAL start and proves the postmaster
  // is gone afterwards.
  test("a failed pid read after a real start leaves no postmaster behind", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[5]!;
    const pidRecord = join(await temporary("attack-kit-pid-fault-"), "observed.json");
    // The pid is read INSIDE the body, from the test's own read of the data
    // directory, before the runner's teardown deletes anything. That is the only
    // observation that survives the deletion: afterwards the directory is gone,
    // the runner holds no pid, the cluster published no TCP listener (`-h ''`),
    // and the socket has been removed with its directory — so every
    // post-teardown check the runner and a socket probe can make would report
    // "gone" for a server that is still running. Holding the pid makes this test
    // falsifiable rather than self-confirming.
    let observedPid: number | undefined;
    let observation: {
      pidCapturedByRunner: boolean;
      observedPid: number | undefined;
      outcome: "resolved" | "rejected";
      preservedDataDirectory?: string;
      error?: string;
    } | undefined;
    let survivor: number | undefined;
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch (error) {
        return (error as { code?: string }).code === "EPERM";
      }
    };

    try {
      try {
        const result = await withRealPostgres(async postgres => {
          // The fault must have fired on the real path, or this test would prove
          // the healthy teardown and say nothing about the degraded one.
          assert.equal(postgres.postmasterPidCaptured, false,
            "the injected pid read failure must leave the runner's pid uncaptured");
          assert.ok(existsSync(postgres.socketDirectory), "the cluster really started and published a socket");
          const recorded = (await readFile(join(postgres.dataDirectory, "postmaster.pid"), "utf8"))
            .split("\n")[0]!.trim();
          observedPid = /^\d+$/.test(recorded) ? Number(recorded) : undefined;
          assert.ok(observedPid !== undefined, "the postmaster published a readable pid before teardown");
          assert.equal(alive(observedPid!), true, "and that pid is a live process");
          // A real server answering a real query: the cluster is genuinely up,
          // not merely started and immediately dead.
          const answer = await postgres.query("migrator", "SELECT 1 AS one");
          assert.equal(answer.rows[0]!.one, 1);
          return postgres;
        }, { port, allowedPorts: PORTS, database: "attack_kit_pid_fault", pidCaptureFault: "read_fails" });
        // The runner's own `stop` already ran in its finally, so `cleanedUp` is
        // its verdict on the teardown under the fault.
        observation = { pidCapturedByRunner: false, observedPid, outcome: "resolved" };
        assert.equal(result.cleanedUp, true,
          `teardown must be clean after a lost pid, got leftovers: ${result.leftovers.join(",")}`);
      } catch (error) {
        // A preserved-evidence outcome is also acceptable per the brief, and is
        // recorded rather than swallowed so the assertions below can demand the
        // one property that matters either way: nothing survives.
        const message = `${(error as Error).message}`;
        observation = { pidCapturedByRunner: false, observedPid, outcome: "rejected", error: message };
        assert.match(message, /attack_kit_postmaster_shutdown_unconfirmed|attack_kit_cluster_leaked/,
          "a failed teardown must name its own reason");
        const preserved = /data_directory_preserved=([^:]+)/.exec(message)?.[1];
        if (preserved !== undefined) {
          // Evidence kept because shutdown could not be confirmed is the other
          // half of the contract: the directory must still be there to stop the
          // cluster by hand.
          assert.equal(existsSync(preserved), true,
            "when shutdown cannot be confirmed the data directory must be preserved");
          observation.preservedDataDirectory = preserved;
        }
      }

      assert.ok(observedPid !== undefined, "the test observed a real postmaster pid inside the body");
      survivor = alive(observedPid!) ? observedPid : undefined;
      assert.equal(survivor, undefined,
        `postmaster ${observedPid} survived the teardown with no retained pid to stop it`);
      assert.equal(await portIsOccupied(port), false,
        `the postmaster must not still hold port ${port} after a lost pid`);
      // Nothing of ours may be left listening on the short socket path either.
      assert.equal(existsSync(join("/tmp", `ak${process.pid}-attack-kit-pg-`)), false);
    } finally {
      // Reap anything that outlived the run, so a failing assertion costs a test
      // failure and not a blocked machine. Under the guard this does nothing.
      if (survivor !== undefined) {
        try { process.kill(survivor, "SIGQUIT"); } catch { /* already gone */ }
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && alive(survivor)) {
          await new Promise(done => { setTimeout(done, 100); });
        }
        if (alive(survivor)) { try { process.kill(survivor, "SIGKILL"); } catch { /* already gone */ } }
      }
      await writeFile(pidRecord, JSON.stringify(observation ?? { outcome: "never_observed" }));
    }
  });

  // The other half of the same contract: when shutdown cannot be confirmed, the
  // runner must KEEP the data directory and report the failure rather than
  // delete the evidence and call it clean. This needs a second fault, because
  // with `pg_ctl stop` working the pid-read fault is enough for the stop to
  // succeed. `stopAttemptFault: "no_op"` makes the cooperative stop report
  // success without stopping anything, so the confirmation is the only thing
  // that can notice.
  test("an unconfirmed shutdown preserves the data directory and fails the run", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[6]!;
    let observedPid: number | undefined;
    let preserved: string | undefined;
    let message = "";
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch (error) {
        return (error as { code?: string }).code === "EPERM";
      }
    };
    try {
      try {
        await withRealPostgres(async postgres => {
          const recorded = (await readFile(join(postgres.dataDirectory, "postmaster.pid"), "utf8"))
            .split("\n")[0]!.trim();
          observedPid = /^\d+$/.test(recorded) ? Number(recorded) : undefined;
          assert.equal(postgres.postmasterPidCaptured, false, "the pid was not captured");
          assert.equal(alive(observedPid!), true, "the cluster is really running");
        }, {
          port, allowedPorts: PORTS, database: "attack_kit_unconfirmed",
          pidCaptureFault: "read_fails", stopAttemptFault: "no_op",
        });
      } catch (error) {
        message = `${(error as Error).message}`;
      }
      // The run MUST fail, and it must say why in a form an operator can act on.
      assert.match(message, /attack_kit_postmaster_shutdown_unconfirmed/,
        `a postmaster that refused to stop must fail the run, got: ${message}`);
      assert.match(message, /pg_ctl_status_running=true/,
        "and it must report that the status check saw a running postmaster");
      assert.match(message, /postmaster_pid_alive=true/,
        "and that the postmaster.pid read saw a live process");
      preserved = /data_directory_preserved=([^:]+)/.exec(message)?.[1];
      assert.ok(preserved, "the message must name the preserved data directory");
      assert.equal(existsSync(preserved!), true,
        "the data directory must still be there — it is the only way to stop the cluster");
      assert.equal(existsSync(join(preserved!, "postmaster.pid")), true,
        "and it must still hold the postmaster.pid that identifies the survivor");
      assert.ok(observedPid !== undefined && alive(observedPid),
        "the postmaster is indeed still running at the moment of refusal");
    } finally {
      // The refusal deliberately leaves evidence behind, so this test reaps it
      // and removes the preserved directories itself. A test that leaves a
      // cluster running is the defect, not the demonstration of it.
      if (observedPid !== undefined && alive(observedPid)) {
        try { process.kill(observedPid, "SIGQUIT"); } catch { /* already gone */ }
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && alive(observedPid)) {
          await new Promise(done => { setTimeout(done, 100); });
        }
        if (alive(observedPid)) { try { process.kill(observedPid, "SIGKILL"); } catch { /* already gone */ } }
      }
      if (preserved !== undefined) {
        // The preserved evidence is the DATA directory, whose parent is the run
        // directory the runner would normally remove, and the short socket
        // directory lives outside it. All three are removed here, or this test
        // would leave the same leak the refusal exists to report.
        const runDirectory = join(preserved, "..");
        await rm(preserved, { recursive: true, force: true });
        await rm(runDirectory, { recursive: true, force: true });
        await rm(join("/tmp", `ak${process.pid}-${runDirectory.split("/").pop()}`),
          { recursive: true, force: true });
      }
    }
  });

  // `started = true` was set only after `pg_ctl start` returned 0. A start that
  // fails AFTER the postmaster has forked — `-w -t 60` "server did not start in
  // time" under load, or the 120 s exec timeout while the server is still
  // coming up — left `started` false, so `stop` skipped the shutdown, and the
  // data directory and socket directory were deleted underneath a LIVE
  // postmaster. Reproduced with a shim `pg_ctl` that runs the real start and
  // then exits 1: withRealPostgres threw, the postmaster was still alive, the
  // data directory was gone, and a new SysV segment was held — on a machine with
  // 32 segments in total.
  test("a start that fails after launching a postmaster leaves nothing behind", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[1]!;
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch (error) {
        return (error as { code?: string }).code === "EPERM";
      }
    };
    let message = "";
    let observedPid: number | undefined;
    try {
      await withRealPostgres(async () => "never reached", {
        port, allowedPorts: PORTS, database: "attack_kit_start_fail",
        startAttemptFault: "exit_non_zero_after_start",
      });
      assert.fail("a start that reported failure must not resolve the promise");
    } catch (error) {
      message = `${(error as Error).message}`;
    }
    // The failure is reported as a start failure, and it carries the pid it
    // captured while stopping the orphan.
    assert.match(message, /attack_kit_cluster_start_failed/,
      `the run must name the start failure, got: ${message}`);
    const pid = /postmaster_pid=(\d+)/.exec(message)?.[1];
    observedPid = pid ? Number(pid) : undefined;
    assert.ok(observedPid !== undefined && observedPid > 0,
      `the failure must report the pid it found, got: ${message}`);
    // THE ASSERTION: the postmaster the failed start launched is gone, and the
    // port it held is free. Under the old code it was still running.
    assert.equal(alive(observedPid), false,
      `postmaster ${observedPid} survived a start that reported failure`);
    assert.equal(await portIsOccupied(port), false,
      `the port must be released after a failed start, still held on ${port}`);
  });
});

lane.closeLane(["attack-kit-pg-", "attack-kit-pid-fault-"]);
