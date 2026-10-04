#!/usr/bin/env node
// A hard timeout for one command, in its OWN PROCESS GROUP, for
// `scripts/r7cfix-mutation-self-test.sh`.
//
// WHY THIS EXISTS, and why it is a separate program rather than `timeout(1)`.
// The mutation self-test rewrites product source files, runs a test lane, and
// must restore every file whatever happens. Three properties make that safe,
// and none of them is available from a bare `node --test` invocation:
//
//   1. A BOUND. The PostgreSQL lane provisions a real cluster; a lane that
//      wedges (a held lock, a postmaster that never answers, a test that
//      awaits forever) would otherwise hang this script forever with a
//      mutated source file on disk. Measured here: a `--test-timeout` that
//      fires still leaves the process alive for the rest of the run
//      (`duration_ms 60058` on a 1500 ms timeout), so node's own timeout is
//      NOT a bound on the process, only on the test.
//   2. A PROCESS GROUP. `detached: true` puts the child in a new group whose
//      id is the child's pid, so the kill below reaches every descendant --
//      the postmaster, the `initdb`, the `pg_ctl` -- and not only the direct
//      child. A timeout that killed only the direct child would leave a
//      live PostgreSQL cluster holding the lane's ports, which is precisely
//      the leak the lane-coverage rules exist to prevent.
//   3. A DISTINGUISHED EXIT. 124 for the bound, 125 for a spawn failure, so
//      the caller can tell "the test failed" from "the test never finished"
//      and REFUSE to count the second as a caught mutation.
//
// Interrupts are forwarded to the group as well, so Ctrl-C does not leave a
// cluster behind either.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Exactly two leading flags are accepted and nothing else, so a mistyped
// invocation can never be silently reinterpreted as a different command.
const USAGE = "usage: r7cfix-test-watchdog.mjs --timeout-ms <n> -- <command> [args...]";
const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (separator !== 2 || argv[0] !== "--timeout-ms") {
  console.error(USAGE);
  process.exit(2);
}
const timeoutMs = Number(argv[1]);
const command = argv.slice(separator + 1);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || command.length === 0) {
  console.error(`${USAGE}\nr7cfix-test-watchdog: bad invocation ${JSON.stringify(argv)}`);
  process.exit(2);
}

// One hard bound, one process group, one cleanup. See the header for why each
// of the three exists; none of them is decoration.
//
// `sweepClusters` is the measured fix for a leak the group signal alone did not
// close: a postmaster already reparented to init never receives the group
// signal, so it kept holding its port. It walks ONLY this run's own TMPDIR --
// the attack kit creates every cluster in a `attack-kit-pg-*` directory there --
// stops each one with `pg_ctl` against its OWN data directory (never a name or
// port pattern, which would reach another bot's cluster on a shared machine),
// and then removes the directory. A cluster another process owns is left alone,
// and a directory that is not there is a no-op.
const sweepClusters = () => {
  const root = process.env.TMPDIR;
  if (!root) return;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("attack-kit-pg-")) continue;
    const clusterRoot = join(root, entry.name);
    const dataDirectory = join(clusterRoot, "data");
    try {
      if (existsSync(join(dataDirectory, "postmaster.pid"))) {
        spawnSync(process.env.PG_BIN ? join(process.env.PG_BIN, "pg_ctl") : "pg_ctl",
          ["-D", dataDirectory, "-m", "fast", "stop"], { stdio: "ignore", timeout: 30_000 });
      }
      rmSync(clusterRoot, { recursive: true, force: true });
    } catch { /* nothing left to clean up for this directory */ }
  }
};

const child = spawn(command[0], command.slice(1), { detached: true, stdio: "inherit" });
child.on("error", error => {
  console.error(`r7cfix-test-watchdog: spawn failed: ${error.message}`);
  process.exit(125);
});

const killGroup = signal => {
  // The group id is the child's pid. A negative pid targets the group; if the
  // group is already gone this throws ESRCH, which is the normal race and is
  // deliberately swallowed -- there is nothing left to kill.
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
};

// Cleanup, then leave. Two passes, then 124. This is the ONLY path that exits
// with 124, so a timeout can never skip it.
const sweepAndExit = () => {
  sweepClusters();
  setTimeout(() => { sweepClusters(); process.exit(124); }, 4_000);
};

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`r7cfix-test-watchdog: TIMED OUT after ${timeoutMs}ms; killing the process group ${child.pid}`);
  killGroup("SIGKILL");
  // Belt and braces: a group whose members ignore or race SIGKILL must still not
  // be able to outlive the bound, so this leaves regardless once the signal has
  // had a moment to land.
  //
  // The group signal is what normally cleans up. It is NOT sufficient on its
  // own, and this is measured rather than assumed: a postmaster that had
  // already been reparented to init by the time the group signal arrives does not
  // receive it, and four such clusters survived earlier timeout self-checks on
  // this machine, holding lanes until they were stopped by hand. So the data
  // directories this run created under TMPDIR are removed here as well -- which
  // is safe because TMPDIR is this lane's own, and a directory that is not there
  // is a no-op.
  //
  // The sweep runs AFTER the child's exit, not on a timer that races it. The
  // measured cause of an earlier version that left a cluster behind: the child
  // is killed by the group signal at once, its `exit` event fires immediately,
  // and that handler called `process.exit` -- so any cleanup scheduled on a timer
  // never ran. `child.on("exit")` below therefore defers to `sweepAndExit`.
  // It also runs TWICE, which is not redundancy: the first pass can land while
  // the kit has forked the postmaster but not yet written `postmaster.pid`, and
  // a directory with nothing to stop is a no-op. One mechanism, two passes, against
  // a measured race.
  sweepAndExit();
}, timeoutMs);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => killGroup(signal));
}

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  // The bound wins over the child's own status: a group killed for running long
  // reports the SIGNAL that killed it, and reporting that as a failure would be
  // exactly the lie this program exists to remove. 124 is the timeout convention.
  if (timedOut) return;
  process.exit(signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[signal] ?? 0) : code ?? 1);
});