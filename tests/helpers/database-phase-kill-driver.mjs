// The kill-at-every-statement driver for the M1 real-PostgreSQL lane (H3 of the
// M1b review). It is a CHILD PROCESS, because only a process that really dies can
// prove a retry converges: a thrown error runs `finally` blocks, a SIGKILL runs
// nothing.
//
// It runs one database phase with the PRODUCTION dependency set — the same
// builders the shipped scripts' entries call — plus exactly two overrides:
//
//   onPgSpawn         the observation point `spawnPgFamily` offers; it names every
//                     PG-family program the phase is about to start, and this driver
//                     SIGKILLs itself at the first one the lane has not killed at yet;
//   deployerIdentity  (release only) the invoking uid instead of root, because this
//                     lane has no root; the lane's peer-map simulation maps it.
//
// Every kill point is a statement LABEL: a digest of the program, its argv and its
// SQL, plus how many times this run has started that same statement — so the
// catalogue read before and after a grant diff are two kill points, not one.
//
// argv: <config.json>. The config names the phase, the request, the passwords, the
// kill points already used (`<label>@before` / `<label>@during`), the share of
// labels that also get a mid-statement kill, and a state file this driver appends
// what it did to, one JSON line per event.

import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const killed = new Set(config.killed);
const seen = new Map();
const record = event => appendFileSync(config.stateFile, `${JSON.stringify(event)}\n`);

/**
 * THE POWER-CUT WINDOW (N1 of the M1c review), and its own mode: while `initdb`
 * runs, its standalone backend holds `postmaster.pid` with a NEGATIVE pid. When
 * that line appears, this driver SIGKILLs every process it started — the whole
 * tree, found by ppid from its own pid, never by pattern — and then itself. That
 * is what a power cut, a restart or a kernel kill leaves: the file, no process.
 */
function armStandaloneWindowKill(data) {
  // The kill lands in the POST-BOOTSTRAP single-user session (`postgres
  // --single`), not in one of `initdb`'s earlier `--check` probes or in `--boot`,
  // and only once its shared memory exists (line 7 of the file is the segment's
  // key and id). That is the point at which a lane can give back the segment a
  // SIGKILL leaks: a standalone backend started on the same directory reclaims it,
  // and it can only start on a cluster whose bootstrap finished. MEASURED: gating
  // on "the second negative pid" hit a `--check` probe, whose directory has no
  // `global/pg_control` yet, and the reclaim could not start.
  const notSingle = new Set();
  const timer = setInterval(() => {
    let lines = [];
    try { lines = readFileSync(join(data, "postmaster.pid"), "utf8").split("\n"); } catch { return; }
    const first = (lines[0] ?? "").trim();
    if (!/^-[0-9]+$/u.test(first) || notSingle.has(first)) return;
    if (!/^[0-9]+\s+[0-9]+$/u.test((lines[6] ?? "").trim())) return;
    // FROZEN FIRST, then checked, then identified. A standalone run removes its own
    // file on a clean exit, and MEASURED: a backend read here could be inside that
    // exit, so the file was gone by the kill. SIGSTOP holds the backend that wrote
    // the file; the file is read AGAIN while it is frozen (a frozen process cannot
    // unlink anything), and if it is gone or changed the backend is let go and the
    // watch goes on. It is SIGKILLed only if it is in this driver's own tree.
    const backend = Math.abs(Number(first));
    try { process.kill(backend, "SIGSTOP"); } catch { return; }
    let still = "";
    try { still = readFileSync(join(data, "postmaster.pid"), "utf8").split("\n")[0].trim(); } catch { /* gone */ }
    let command = "";
    try { command = execFileSync("/bin/ps", ["-o", "command=", "-p", String(backend)], { encoding: "utf8" }); } catch { /* gone */ }
    if (still !== first || !/ --single\b/u.test(command)) {
      if (still === first) notSingle.add(first);
      try { process.kill(backend, "SIGCONT"); } catch { /* gone */ }
      return;
    }
    clearInterval(timer);
    const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
      .split("\n").map(line => line.trim().split(/\s+/u).map(Number)).filter(([pid]) => pid > 1);
    const tree = new Set([process.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [pid, ppid] of rows) if (!tree.has(pid) && tree.has(ppid)) { tree.add(pid); grew = true; }
    }
    tree.delete(process.pid);
    if (!tree.has(backend)) { try { process.kill(backend, "SIGCONT"); } catch { /* gone */ } }
    record({ event: "kill", label: "standalone-window", key: "standalone-window", name: "initdb standalone window",
      mode: "tree", pidFileFirstLine: first, backendCommand: command.trim().slice(0, 120), pids: [...tree],
      backendInTree: tree.has(backend) });
    for (const pid of tree) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    process.kill(process.pid, "SIGKILL");
  }, 1);
}

// A `during` kill is a KILL POINT ONLY IF THE PHASE IS STILL RUNNING, and that is
// not a detail: a SIGKILL that lands after the phase has already returned is not
// a kill at all — the run has COMPLETED, it simply has not exited yet, because
// the driver's own `setTimeout` callback is still pending. MEASURED (x1, the
// M1 lane's "init killed at EVERY statement"): with the kill unconditional, the
// `during` kill of the LAST statement (`pg_controldata`, the final spawn of the
// phase) landed after the phase had written its completion marker `pg/current`,
// so the next run — same data id — correctly refused
// `database_init_already_initialized`, and the lane failed with
// "run N must either complete or die at a kill point". The refusal was right;
// the harness had manufactured a kill point that cannot be one.
//
// The fix is `settled`, and it is DETERMINISTIC rather than timing-dependent,
// which matters because the lane is required to be green twice in a row. The
// phase's last await resolves in a child `close` callback; the continuation that
// assigns `settled = true` is therefore a MICROTASK, and a microtask always runs
// before the next macrotask — so if the phase has resolved, `settled` is already
// true when the timer fires, on every run. There is no window for a slower
// machine or a busier lane to open.
let settled = false;

const onPgSpawn = ({ executable, args, stdin }) => {
  if (config.mode === "standalone-window") {
    if (executable.endsWith("/initdb")) armStandaloneWindowKill(args[args.indexOf("-D") + 1]);
    return;
  }
  // A SCRAM verifier carries a fresh random salt on every run, so it is masked:
  // the same `ALTER ROLE` must be the same kill point in the next run.
  const program = stdin.replace(/SCRAM-SHA-256\$[^']*/gu, "SCRAM-SHA-256$<verifier>");
  const digest = createHash("sha256").update(`${executable}\0${args.join("\0")}\0${program}`).digest("hex").slice(0, 16);
  const occurrence = (seen.get(digest) ?? 0) + 1;
  seen.set(digest, occurrence);
  const label = `${digest}#${occurrence}`;
  // Each statement is killed at twice at most: BEFORE its child starts (a kill
  // between statements) and, for the sampled share `duringSample`/16 of labels,
  // 25 ms AFTER it started (a kill mid-statement, leaving the child orphaned).
  let mode;
  if (!killed.has(`${label}@before`)) mode = "before";
  else if (parseInt(digest[0], 16) < (config.duringSample ?? 16) && !killed.has(`${label}@during`)) mode = "during";
  else return;
  const name = `${executable.split("/").pop()} ${(stdin.split("\n").find(line => line.trim() !== "") ?? args.join(" "))
    .trim().slice(0, 80)}`;
  // A `before` kill is the driver killing ITSELF, so it happens HERE, in this
  // synchronous callback, before the phase has a chance to finish the statement.
  // A `during` kill is deferred to a timer, and a deferred kill can arrive too
  // late — so the two are recorded at DIFFERENT TIMES, and the lane reads the
  // record to decide what the run was.
  //
  // Recording the `during` arm here, before the timer exists, is what lets the
  // lane tell "this run died at a kill point" from "this run armed a kill and then
  // finished anyway". The lane's loop (see `killEveryStatement`) accepts a run
  // only when it exited 0 WITH a result, or died by SIGKILL WITH a kill record;
  // any other outcome is a failure it reports. A run that armed a `during` kill and
  // then REFUSED would otherwise be reported as having died at that kill point,
  // which is false — the phase had already refused, on its own terms.
  if (mode === "before") {
    record({ event: "kill", label, key: `${label}@before`, name, mode });
    process.kill(process.pid, "SIGKILL");
    return;
  }
  const armed = { event: "kill-armed", label, key: `${label}@during`, name, mode };
  record(armed);
  setTimeout(() => {
    // THE PHASE GOT THERE FIRST. The run is complete — returned or refused — so
    // there is nothing left to kill and the deferred kill was not a kill point.
    // Rewritten to `kill-late`, which the lane does not read as a kill, and the
    // armed record's key is removed so the same label is available again on the
    // next run. Without the removal the label would be counted as visited without
    // ever having been killed, and the lane would stop testing it.
    if (settled) {
      record({ ...armed, event: "kill-late", late: true });
      try {
        const lines = readFileSync(config.stateFile, "utf8").split("\n").filter(Boolean);
        writeFileSync(config.stateFile, `${lines
          .filter(line => { const event = JSON.parse(line); return event.event !== "kill-armed"; })
          .join("\n")}\n`);
      } catch { /* the state file is this driver's own; a lost line is a counted miss */ }
      return;
    }
    record({ event: "kill", label, key: `${label}@during`, name, mode });
    // The children this driver started are DETACHED (setsid), so they survive it;
    // their pids are recorded so the lane can wait for exactly those, and nothing
    // found by pattern.
    const children = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
      .split("\n").map(line => line.trim().split(/\s+/u).map(Number))
      .filter(([pid, ppid]) => ppid === process.pid && pid > 1).map(([pid]) => pid);
    record({ event: "orphans", label, pids: children });
    process.kill(process.pid, "SIGKILL");
  }, 25);
};

const releaseRoot = join(config.request.root, "current");
let result;
let completed = false;
try {
  if (config.phase === "init") {
    const { initializeDatabaseV1, buildInitDependenciesV1 } = await import("../../src/updater/v1/pg/init-database.mjs");
    result = await initializeDatabaseV1(config.request, config.passwords,
      await buildInitDependenciesV1(releaseRoot, { onPgSpawn }));
  } else {
    const { applyReleaseSchemaV1, buildReleaseDependenciesV1 } =
      await import("../../src/updater/v1/pg/apply-release-schema.mjs");
    result = await applyReleaseSchemaV1(config.request, config.passwords,
      await buildReleaseDependenciesV1(releaseRoot, {
        onPgSpawn, deployerIdentity: { uid: process.getuid(), gid: process.getgid() } }));
  }
  completed = true;
} catch (error) {
  // THE PHASE REFUSED, and it is recorded as an EVENT rather than left to the
  // process's non-zero exit. The lane's loop decides what a run was from the event
  // log plus the signal, and a refusal that threw past the `result` record left
  // the lane with a non-zero exit, no `result` and — if a deferred `during` kill
  // had been armed — a `kill-armed` record. That combination is exactly the shape
  // this lane mistook for "died at a kill point", and it is why the reason is
  // recorded here: the lane can now report the refusal by name instead of
  // guessing, and the `kill-armed` case is distinguishable from a kill.
  record({ event: "refused", reason: error instanceof Error ? error.message : String(error) });
  process.stderr.write(`${error instanceof Error ? error.message : "database_phase_failed"}\n`);
  process.exitCode = 1;
} finally {
  // Whether the phase RETURNED, REFUSED or THREW, this run is over: nothing of it
  // is left to kill, so a `during` timer that fires from here on is not a kill
  // point. Set in the `finally` rather than after the record, precisely so a
  // REFUSAL is marked as finished too.
  settled = true;
}
// `completed`, NOT `process.exitCode`: on a clean exit Node leaves
// `process.exitCode` UNDEFINED, not 0, so `exitCode === 0` is false and the
// result event was never written — every run that actually SUCCEEDED looked to
// the lane like "exited 0 with no result, no kill, no arm", and the loop failed it.
// MEASURED: this broke only the one run per lane that completes, so it looked
// like a phase problem at the very last kill point.
if (completed) record({ event: "result", result });
