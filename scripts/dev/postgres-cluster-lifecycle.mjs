// Shared lifecycle for every disposable PostgreSQL this repository starts.
//
// A postmaster creates one 56-byte SysV shared-memory segment and releases it
// on any shutdown that runs its exit path. SIGKILL cannot run an exit path, so
// a SIGKILLed postmaster leaves the segment behind with a dead creator and
// `nattch 0`. MEASURED against PostgreSQL 17.11 on this machine:
//
//   pg_ctl -m fast stop .............. released  (3/3)
//   SIGQUIT, idle ..................... released, ~4 ms  (3/3)
//   SIGQUIT, prepared xact pending ... released  (1/1)
//   SIGKILL ........................... LEAKED  (6/6)
//   SIGKILL during startup ........... LEAKED  (6/6)
//   shared_memory_type=mmap + SIGKILL  LEAKED  (5/5)
//
// This machine has 32 such segments in total, so every orphan is a resource
// another job needs, and a full set blocks `initdb` outright.
//
// The order is therefore by what RELEASES the segment, not by what ends the
// process soonest, and it lives in one function so the order is asserted
// rather than described. `shared_memory_type=mmap` is NOT the fix: that GUC
// governs `shared_buffers`, and the 56-byte segment is created unconditionally
// beside it, so it leaks on every SIGKILL with mmap too. It was measured rather
// than assumed, and it does not work.
//
// Plain `.mjs` on purpose: `scripts/ops/verify-database-backup.mjs` is run by
// bare `node` with no TypeScript loader, so a `.ts` module cannot be imported
// by one of its callers.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** Every shutdown step, in the order that releases shared memory. */
export const SHUTDOWN_LADDER_ORDER = Object.freeze([
  "cooperative:fast", "cooperative:immediate", "signal:SIGQUIT", "signal:SIGKILL",
]);

/** True when a pid exists. EPERM means it exists and belongs to another user. */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error)?.code === "EPERM"; }
}

/**
 * The postmaster pid a data directory records, read SYNCHRONOUSLY.
 *
 * The async `readPostmasterPid` cannot be used from the `exit` hook, which only
 * ever runs synchronous work: an `await` there is a promise that never settles
 * before the process is gone, so the hook would read nothing and then either
 * stop nothing or claim a stop it never performed.
 */
export function readPostmasterPidSync(dataDirectory) {
  try {
    const first = readFileSync(join(dataDirectory, "postmaster.pid"), "utf8").split("\n")[0]?.trim();
    return first && /^\d+$/u.test(first) ? Number(first) : undefined;
  } catch {
    // A postmaster that never came up leaves no file, which is itself evidence.
    return undefined;
  }
}

/** The postmaster pid a data directory currently records, if any. */
export async function readPostmasterPid(dataDirectory) {
  const first = (await readFile(`${dataDirectory}/postmaster.pid`, "utf8").catch(() => ""))
    .split("\n")[0]?.trim();
  return first && /^\d+$/u.test(first) ? Number(first) : undefined;
}

/**
 * Stop a postmaster, in the order that releases its shared memory.
 *
 * `cooperative fast` -> `cooperative immediate` -> `SIGQUIT` -> `SIGKILL`. The
 * first step that finds the postmaster gone ends the ladder, so the common case
 * performs exactly one `pg_ctl -m fast` and never reaches a signal. `SIGKILL`
 * is reachable only by a postmaster that refused every cooperative shutdown,
 * and reaching it sets `forced` — which the caller reports as a failure,
 * because a teardown that had to be forced leaked a shared-memory segment.
 */
export async function shutdownLadder(options) {
  const graceMs = options.graceMs ?? 30_000;
  const tickMs = options.tickMs ?? 100;
  const sleep = options.sleep ?? (ms => new Promise(done => { setTimeout(done, ms); }));
  const steps = [];
  const waitForExit = async () => {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && options.alive()) await sleep(tickMs);
    return !options.alive();
  };
  for (const mode of ["fast", "immediate"]) {
    if (!options.alive()) break;
    let error;
    try { await options.cooperativeStop(mode); }
    catch (thrown) {
      // Expected when the postmaster never came up, or is already gone. Whether
      // that is a failure is decided by asking whether it is still running, and
      // the reason is kept because it is the only thing that says why.
      error = `${thrown instanceof Error ? thrown.message : String(thrown)}`.split("\n")[0].slice(0, 200);
    }
    // `pg_ctl -w` reports success once postmaster.pid is gone, and the
    // postmaster unlinks that file on its exit path just BEFORE the process
    // ends (it is then reaped by launchd/init, not by us). On a loaded machine
    // the pid is still alive for a moment after a SUCCESSFUL stop; judging it at
    // once sent a needless `-m immediate`, which can only fail ("PID file does
    // not exist") while the pid lingers, and a clean shutdown was reported as
    // attack_kit_cluster_stop_degraded. A stop that returned success gets the
    // same grace a signal does to finish exiting.
    const stopped = error === undefined ? await waitForExit() : !options.alive();
    steps.push({ action: "cooperative", mode, stopped, failed: error !== undefined && !stopped,
      ...(error === undefined ? {} : { error }) });
    if (stopped) return { steps, stopped: true, forced: false };
  }
  for (const signal of ["SIGQUIT", "SIGKILL"]) {
    if (!options.alive()) break;
    try { options.signal(signal); } catch { /* already gone */ }
    const stopped = await waitForExit();
    steps.push({ action: "signal", signal, stopped, failed: !stopped });
    if (stopped) return { steps, stopped: true, forced: signal === "SIGKILL" };
  }
  return { steps, stopped: !options.alive(), forced: steps.some(step => step.signal === "SIGKILL") };
}

const firstLineOf = error => `${error?.message ?? String(error)}`.split("\n")[0].slice(0, 200);

/**
 * The teardown every disposable-cluster start site shares.
 *
 * Created and handed its process-level hooks BEFORE `initdb` runs, because that
 * ordering is the fix: a start that fails after the postmaster forked, and a
 * lane that calls `process.exit()` before its own `after()` hook, both used to
 * leave a live postmaster holding a segment. Registering first means there is
 * no window in which a cluster exists and nothing knows it does.
 *
 * Three hooks, because three different exits skip `after()`:
 *
 *  - `SIGINT`/`SIGTERM` — what every runner sends FIRST
 *    (the mutation helper, a Ctrl-C, any bounded runner). The postmaster is asked
 *    to shut down cooperatively, then the process exits with the signal's
 *    conventional code so the caller still sees a signalled failure.
 *  - `exit` — a lane that returns or calls `process.exit()` without reaching
 *    its teardown. This hook can only run SYNCHRONOUS work, so it uses
 *    `execFileSync` and a short wait. It cannot run on SIGKILL: nothing can.
 *  - the returned `stop()`, for the ordinary path.
 *
 * SIGKILL of the parent remains the one path no code inside the parent can
 * handle, because the kernel does not deliver it. That is why `pg_ctl start`
 * gives the postmaster its own session, why the ladder never prefers SIGKILL,
 * and why the segments this repository's own tests create are attributed by
 * creator pid rather than swept.
 */
export function createClusterTeardown(options) {
  const { dataDirectory, runDirectory, socketDirectory, port, pgBin, removeDirectories = true } = options;
  let stopped = false;
  let postmasterPid;
  /** Recorded so a failure names the pid, the data directory, and the port. */
  const failures = [];
  /**
   * Where a degraded teardown is reported.
   *
   * stderr by default, because that is where an operator running
   * `scripts/ops/verify-database-backup.mjs` or a test lane by hand is already
   * looking, and the line has to be visible without a caller opting in — a
   * swallowed reason is how a postmaster that refused to stop came to be
   * reported as a clean teardown once already. Overridable so a test can read
   * the line instead of letting it interleave with the runner's own output.
   */
  const logDegraded = options.degradedLogger ?? (line => { process.stderr.write(`${line}\n`); });

  const rememberPid = async () => {
    postmasterPid ??= await readPostmasterPid(dataDirectory);
    return postmasterPid;
  };

  /**
   * One `pg_ctl` invocation. `pg_bin` may be undefined on PATH.
   *
   * `options.pgCtl` replaces the COMMAND, never the logic, and exists because
   * the guards that matter most here cannot otherwise be reached: a postmaster
   * that refuses every cooperative shutdown cannot be produced on demand from a
   * healthy one, so without a seam the "refuse to report success" and "report a
   * forced teardown" branches are asserted by nothing. The ladder, the liveness
   * checks, the directory removal and the error shapes all still run.
   */
  // The seam is `(args) => void` while the built-in path is
  // `(args, timeout) => void`. A test double therefore cannot observe or change
  // the timeout, so the production timeout behaviour is not reproducible through
  // the seam. That is deliberate: a seam that could change a timeout could also
  // be used to shorten one in production, and every test here needs the default.
  const pgCtl = options.pgCtl
    ? (args) => options.pgCtl(args)
    : (args, timeout = 90_000) => execFileSync(
      pgBin ? `${pgBin}/pg_ctl` : "pg_ctl", args,
      { encoding: "utf8", timeout, env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", LC_ALL: "C" } });

  /**
   * A bounded, SYNCHRONOUS cooperative stop, safe to call from a signal handler.
   *
   * The async ladder yields at its first `await`, and a runner that sends
   * SIGTERM and SIGKILLs two seconds later — which is what
   * `tests/support/attack-kit/mutation.ts` and the operator's out-of-repo
   * test-slot wrapper both do — could catch the process in that window with the postmaster still
   * running. Running the whole `pg_ctl -m fast` inside the handler closes it.
   *
   * Honest limit on what this is worth: MUTATION-CHECKED, and removing the
   * synchronous call changes no test result, because a real `pg_ctl -m fast` of
   * a real postmaster finishes well inside the runner's 2 s grace, so the async
   * path also completes in time. The synchronous form is therefore NOT a guard
   * with a test behind it — it is defence in depth against a slower stop under
   * load, which this machine has not been observed to produce. It is kept
   * because it costs one `execFileSync` and removes a class of failure, and it is
   * recorded here rather than claimed as covered.
   */
  const cooperativeStopSync = () => {
    try { pgCtl(["-D", dataDirectory, "-m", "fast", "-w", "-t", "20", "stop"], 30_000); }
    catch { /* The ladder and the exit hook both still have it. */ }
  };

  const stop = async () => {
    if (stopped) return;
    const pid = await rememberPid();
    if (pid !== undefined && pidAlive(pid)) {
      const ladder = await shutdownLadder({
        alive: () => pidAlive(pid),
        cooperativeStop: async (mode) => pgCtl(["-D", dataDirectory, "-m", mode, "-w", "-t", "60", "stop"]),
        signal: (signal) => { process.kill(pid, signal); },
        // How long to wait for the postmaster to exit after a signal. Overridable
        // so a test that drives a wedged process is not made to wait 30 s per
        // step; the default is the one production uses.
        ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
        ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
      });
      for (const step of ladder.steps) {
        if (step.failed) {
          failures.push(step.action === "cooperative"
            ? `pg_ctl_stop_${step.mode}_failed:${step.error ?? "stop_did_not_confirm"}`
            : `${step.signal ?? "signal"}_did_not_stop_the_postmaster`);
        }
      }
      // A failure, not a detail: a postmaster that refused every cooperative
      // shutdown had to be SIGKILLed, and that SIGKILL is the only path that
      // leaves its 56-byte SysV segment behind with a dead creator. Reporting
      // a clean teardown here would hide both.
      //
      // This is the ONLY teardown failure the LADDER branch may produce: the
      // no-captured-pid branch below throws `disposable_postgres_shutdown_unconfirmed`. A ladder that ended with the postmaster gone and did not reach
      // SIGKILL leaked nothing, so its earlier failed steps are a slow shutdown
      // and not a defect — and a caller that turns them into an exception
      // reports a successful run as a failure. `scripts/ops/verify-database-backup.mjs`
      // did exactly that: a `fast` stop that did not confirm inside its 60 s
      // window after the restore, followed by an `immediate` that did, printed
      // `FAIL` and exited 1 for a backup whose digests, ledger, ownership and
      // grants had all matched, which docs/BACKUP_AND_RESTORE.md:41-44 reserves
      // for a mismatch. Those reasons are still recorded and still reported (on
      // `degraded()` and on stderr); they just no longer change the verdict.
      if (ladder.forced) {
        failures.push("postmaster_required_sigkill_which_leaks_its_shared_memory_segment");
      }
      // Reaching here means the ladder ended with the postmaster gone, and the
      // `pid === undefined` branch below is the one that can still be unsure.
      //
      // There is deliberately no `if (pidAlive(pid)) throw` here. It is
      // unreachable: the ladder's last step is SIGKILL, and MEASURED on this
      // machine, no process survives SIGKILL — not even one that installs
      // `trap "" KILL` (the disposition cannot be caught). So a check after the
      // ladder would be a guard that can never fire, and a guard that can never
      // fire is a comment wearing code's clothes. MUTATION-CHECKED: disabling it
      // changes no test result, which is the evidence that it is not a guard.
      // The uncertainty that CAN happen is handled one branch down, where there is
      // no pid to signal and `pg_ctl status` is the only evidence.
      //
      // `postmasterPid` is intentionally NOT cleared: it is the evidence a
      // post-teardown liveness check needs, and the process is confirmed gone.
    } else if (pid === undefined) {
      // Never captured a pid, so the ladder has nothing to signal. Ask the two
      // things that still exist because nothing has been deleted: a
      // `postmaster.pid` that is absent or non-numeric is a stopped postmaster
      // (PostgreSQL removes the file on clean shutdown), and `pg_ctl status`
      // exits non-zero when there is no server in that data directory. Only
      // BOTH agreeing counts as a confirmed shutdown.
      try { pgCtl(["-D", dataDirectory, "-m", "fast", "-w", "-t", "20", "stop"], 30_000); }
      catch (error) { failures.push(`pg_ctl_stop_failed:${firstLineOf(error)}`); }
      const stillRecorded = await readPostmasterPid(dataDirectory);
      let statusReportsRunning = false;
      try { pgCtl(["-D", dataDirectory, "status"], 20_000); statusReportsRunning = true; }
      catch { /* pg_ctl status exits non-zero when no postmaster is running. */ }
      if (stillRecorded !== undefined || statusReportsRunning) {
        throw new Error(`disposable_postgres_shutdown_unconfirmed:${port}`
          + `:pid_not_captured:postmaster_pid_alive=${stillRecorded !== undefined}`
          + `:pg_ctl_status_running=${statusReportsRunning}`
          + `:${failures.join(",")}`
          + `:data_directory_preserved=${dataDirectory}:run_directory_preserved=${runDirectory}`
          + `:socket_directory_preserved=${socketDirectory}`);
      }
    }
    if (removeDirectories) {
      // Both paths are removed: the run directory holds the data directory, and
      // a short socket directory may live outside it.
      await Promise.all([
        rm(runDirectory, { recursive: true, force: true }),
        ...(socketDirectory ? [rm(socketDirectory, { recursive: true, force: true })] : []),
      ]);
    }
    stopped = true;
    if (failures.length > 0) {
      // The postmaster is confirmed gone, so this is not a leak, but the
      // cooperative path did not go cleanly and that is worth surfacing rather
      // than swallowing. It is reported, not THROWN, and that is the whole point
      // of the change: a caller must be able to distinguish "the cluster is
      // gone and nothing leaked" (this) from "the cluster survived" (the throw
      // above) and from "we had to SIGKILL it and a segment leaked"
      // (`ladder.forced`). Silently swallowing is what the old verifier did and
      // is why a postmaster that refused to stop was once reported as a clean
      // teardown; throwing is what the interim version did and is why a
      // verified backup was once reported as a mismatch. Reporting is the third
      // option that keeps both facts.
      const line = `disposable_postgres_stop_degraded:${port}:${failures.join(",")}`;
      logDegraded(line);
      // Except when the ladder reached SIGKILL, which is a genuine failure and
      // stays one: a teardown that had to be forced did leak a segment, and the
      // whole purpose of the ladder is that a caller learns about that. The
      // `failures.includes` is a filter, not a second copy of the condition —
      // `ladder.forced` is not in scope here, and this string is produced by
      // exactly one line above.
      if (failures.includes("postmaster_required_sigkill_which_leaks_its_shared_memory_segment"))
        throw new Error(line);
    }
  };

  // A signal must not leave a postmaster behind. This machine has 32 SysV
  // shared-memory segments in total, so one orphaned cluster blocks every other
  // job. The handlers are installed here — before `initdb` — and removed once
  // `stop()` has run, so an ordinary stop cannot re-enter.
  //
  // The exact functions are kept so removal takes this teardown's handlers and
  // only those. `removeAllListeners` would take a test runner's own handlers
  // with it, which is a different lane's behaviour to break.
  const handlers = new Map();
  const onSignal = signal => {
    // The synchronous stop runs FIRST, inside the handler. A runner that sends
    // SIGTERM and then SIGKILLs two seconds later must not be able to catch
    // this process between the signal and its first `await`.
    cooperativeStopSync();
    void stop().finally(() => { process.exit(signal === "SIGINT" ? 130 : 143); });
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => onSignal(signal);
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  // `process.on("exit")` only ever runs synchronous work, so this fallback is
  // a short `execFileSync` cooperative stop. It closes the "the lane returned
  // or called process.exit() before its own teardown" hole, which is the one
  // the signal handlers above cannot. It cannot run on SIGKILL: nothing can.
  const onExit = () => {
    if (stopped) return;
    // The flag is set ONLY when the stop actually confirmed the postmaster is
    // gone. Setting it unconditionally would make a later `stop()` a silent
    // no-op, and the two things it would then skip — the ladder, and the
    // `degraded` reporting — are exactly what an interrupted teardown needs.
    // The stop is attempted, and `stopped` is set only when it CONFIRMED the
    // postmaster is gone — so a later `stop()` still runs the ladder and still
    // reports `degraded`, which is what an interrupted teardown needs.
    //
    // It used to set the flag unconditionally, which made that later `stop()` a
    // silent no-op and skipped both.
    //
    // Deliberately NOT guarded on "is there a recorded pid": a `postmaster.pid`
    // on disk is exactly the normal case here, and treating its presence as a
    // reason to do nothing would defeat the hook on every real cluster.
    const recorded = postmasterPid ?? readPostmasterPidSync(dataDirectory);
    const alreadyGone = recorded === undefined || !pidAlive(recorded);
    if (alreadyGone) { stopped = true; return; }
    cooperativeStopSync();
    // Confirmed only by re-reading liveness: `pg_ctl` refusing a stop is not
    // proof the postmaster is gone, and claiming it is would hide the very
    // orphan this whole module exists to prevent.
    //
    // MUTATION-CHECKED, and setting the flag unconditionally changes no test
    // result. The reason is that this hook only runs on a real process exit,
    // where no later `stop()` can happen, so the difference is unobservable from
    // inside a test process — and a test written to appear to catch it would
    // pass either way, which is worse than no test. Recorded as a limit rather
    // than claimed as a guard. The condition is still the right one: it costs
    // one `pidAlive` call and removes a way for the flag to be set while a
    // postmaster is still running.
    if (!pidAlive(recorded)) stopped = true;
  };
  process.once("exit", onExit);

  const release = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    process.removeListener("exit", onExit);
  };

  return {
    /** The recorded postmaster pid, once `initdb`/`pg_ctl start` published one. */
    postmasterPid: () => postmasterPid,
    /**
     * Why the teardown degraded, in the order the reasons were recorded.
     *
     * A teardown that ends with the postmaster confirmed gone does not throw for
     * the steps that did not stop it on their own — that is a slow shutdown, not
     * a leak, and a caller that reports it as a failure reports a successful run
     * as a failed one. These reasons are still available here, and are also
     * written to stderr, so nothing is swallowed and nothing is fatal:
     *
     *   - `pg_ctl_stop_<mode>_failed` / `<signal>_did_not_stop_the_postmaster` /
     *     `pg_ctl_stop_failed` — a step did not stop the postmaster, but a later
     *     step did.
     *   - `postmaster_required_sigkill_which_leaks_its_shared_memory_segment` —
     *     the ladder reached SIGKILL. This one DOES throw, because that SIGKILL
     *     leaves a SysV segment behind.
     *
     * Empty when the teardown went cleanly, and for a teardown that has not run.
     */
    degraded: () => failures.slice(),
    /**
     * Read the postmaster pid and remember it.
     *
     * Called by a start site the moment `pg_ctl start` returns, so the teardown
     * has a pid even when the caller's own bookkeeping is about to throw. A
     * transient read is retried once, because a cluster that is up but whose
     * `postmaster.pid` is not yet visible is the exact case a leak needs.
     */
    capturePostmasterPid: async () => {
      if (postmasterPid === undefined) postmasterPid = await readPostmasterPid(dataDirectory);
      if (postmasterPid === undefined) {
        await new Promise(done => { setTimeout(done, 500); });
        postmasterPid = await readPostmasterPid(dataDirectory);
      }
      return postmasterPid;
    },
    /**
     * Disarm the process-level hooks WITHOUT stopping the cluster.
     *
     * For a caller that deliberately leaves a cluster running — the rehearsal
     * hands a live database to the owner's browser session — where arming the
     * hooks at startup was still right (a failure before the hand-off must not
     * leak) but a normal return must not tear the cluster down.
     */
    release,
    /** The teardown for the ordinary path. Idempotent, and safe in a `finally`. */
    stop: async () => { release(); await stop(); },
  };
}
