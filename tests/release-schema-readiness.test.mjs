// The release phase waits, bounded, for the database LaunchDaemon's postmaster
// before its first statement, and waits out ONLY "not up yet".
//
// The installer bootstraps the database LaunchDaemon and starts the release phase
// straight away. A bootstrap returns when launchd accepts the job, not when the
// postmaster listens, so the phase's first `psql` used to meet a socket that did
// not exist yet and refuse the install.
//
// The phase-level tests run the REAL phase, the REAL `sandbox-exec` and the real
// PostgreSQL profile, with a scripted `psql` in place of the vendored one: it
// answers like a server that is not up for the first attempts, and then like one
// that is. No PostgreSQL, no root, no network.

import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { planPgClusterLayoutV1 } from "../src/pg-runtime/v1/pg-cluster-layout.ts";
import { applyReleaseSchemaV1 } from "../src/updater/v1/pg/apply-release-schema.mjs";
import { sessionNotReadyV1, waitForSessionReadyV1 } from "../src/updater/v1/pg/sql-session.mjs";
import { spawnPgFamily } from "../src/updater/v1/pg/database-phase-process.mjs";

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const SOCKET = "/install/pg/socket/.s.PGSQL.5432";
const answer = (code, stderr, stdout = "") => Object.freeze({ code, signal: null, stdout, stderr });
const noSocket = answer(2, `psql: error: connection to server on socket "${SOCKET}" failed: No such file or directory\n`
  + "\tIs the server running locally and accepting connections on that socket?\n");
const refused = answer(2, `psql: error: connection to server on socket "${SOCKET}" failed: Connection refused\n`);
const startingUp = answer(2,
  `psql: error: connection to server on socket "${SOCKET}" failed: FATAL:  the database system is starting up\n`);
const peerFailed = answer(2,
  `psql: error: connection to server on socket "${SOCKET}" failed: FATAL:  Peer authentication failed for user "postgres"\n`);
const ready = answer(0, "", "1\n");

test("only a missing socket, a refused connection and 57P03 count as not ready", () => {
  for (const result of [noSocket, refused, startingUp,
    answer(2, `psql: error: connection to server on socket "${SOCKET}" failed: FATAL:  the database system is not yet accepting connections\n`)]) {
    assert.equal(sessionNotReadyV1(result), true, result.stderr);
  }
  for (const result of [peerFailed, ready,
    answer(2, `psql: error: connection to server on socket "${SOCKET}" failed: FATAL:  role "postgres" does not exist\n`),
    answer(2, `psql: error: connection to server on socket "${SOCKET}" failed: FATAL:  database "control_room" does not exist\n`),
    answer(2, `psql: error: connection to server on socket "${SOCKET}" failed: Permission denied\n`),
    answer(2, `psql: error: connection to server on socket "${SOCKET}" failed: FATAL:  the database system is shutting down\n`),
    // A sandbox or exec failure says the same words but is not psql's connection report.
    answer(71, "sandbox-exec: execvp() of '/install/runtime/pg-current/bin/psql' failed: No such file or directory\n"),
    answer(65, "sandbox-exec: /install/updater/current/policy/service-postgres.sb: Permission denied\n"),
    // A non-connection exit status with the same text is not a readiness answer either.
    answer(1, noSocket.stderr)]) {
    assert.equal(sessionNotReadyV1(result), false, result.stderr);
  }
});

const context = Object.freeze({ root: "/install", layout: { socketDirectory: "/install/pg/socket" },
  identity: { uid: 401, gid: 401 }, environment: { LC_ALL: "C" }, port: 5432,
  profile: "/install/updater/current/policy/service-postgres.sb", profileParameters: [["RUNTIME_ROOT", "/install/runtime"]],
  pgRoot: "/install/pg" });

function scripted(answers) {
  const calls = [];
  let clock = 0;
  return { calls, now: () => clock, sleep: async milliseconds => { clock += milliseconds; },
    spawn: async options => { calls.push(options); return answers[Math.min(calls.length, answers.length) - 1]; } };
}

test("the wait retries until a real session works, as the phase's own identity, profile and socket", async () => {
  const fake = scripted([noSocket, refused, startingUp, ready]);
  assert.equal(await waitForSessionReadyV1({ user: "postgres", database: "control_room" }, context,
    { spawn: fake.spawn, now: fake.now, sleep: fake.sleep }), 4);
  assert.equal(fake.calls.length, 4);
  for (const call of fake.calls) {
    assert.equal(call.executable, "/install/runtime/pg-current/bin/psql");
    assert.deepEqual([call.uid, call.gid, call.role], [401, 401, "database"]);
    assert.equal(call.profile, context.profile);
    assert.equal(call.cwd, "/install/pg");
    assert.equal(call.stdin, "SELECT 1;\n");
    assert.deepEqual(call.args.slice(0, 8), ["-h", "/install/pg/socket", "-p", "5432", "-U", "postgres", "-d", "control_room"]);
    assert.ok(call.args.includes("-w"), "a password prompt can never block the wait");
  }
});

test("an authentication or identity failure is refused at once, never waited out", async () => {
  const fake = scripted([peerFailed, ready]);
  await assert.rejects(waitForSessionReadyV1({ user: "postgres", database: "control_room" }, context,
    { spawn: fake.spawn, now: fake.now, sleep: fake.sleep }),
  /^Error: pg_phase_session_refused:2:psql: error: .*Peer authentication failed/u);
  assert.equal(fake.calls.length, 1);
});

test("a server that never comes up is refused after the bound, naming the last answer", async () => {
  const fake = scripted([noSocket]);
  await assert.rejects(waitForSessionReadyV1({ user: "postgres", database: "control_room" }, context,
    { spawn: fake.spawn, now: fake.now, sleep: fake.sleep }),
  /^Error: pg_phase_session_not_ready:121:psql: error: .*No such file or directory/u);
  assert.equal(fake.calls.length, 121, "attempts at 0, 0.5, ... 60 s, then refused");
  await assert.rejects(waitForSessionReadyV1({ user: "postgres", database: "control_room" }, context,
    { timeoutMs: 0 }), /pg_phase_readiness_bounds_refused/u);
});

// ---- the real phase, under the real sandbox, with a scripted psql ----------------

test("the actual PG spawn forwards the allowed working directory on first use, retry and parallel calls", async () => {
  const original = childProcess.spawn, calls = [];
  let result = noSocket;
  childProcess.spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.resume();
    const reply = result;
    result = ready;
    queueMicrotask(() => {
      child.stdout.end(reply.stdout); child.stderr.end(reply.stderr);
      child.emit("close", reply.code, null);
    });
    return child;
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await waitForSessionReadyV1({ user: "postgres", database: "control_room" }, context,
      { spawn: spawnPgFamily, sleep: async () => {} }), 2);
    result = peerFailed;
    await assert.rejects(waitForSessionReadyV1({ user: "postgres", database: "control_room" }, context,
      { spawn: spawnPgFamily }), /Peer authentication failed/u);
    await Promise.all(Array.from({ length: 50 }, () =>
      waitForSessionReadyV1({ user: "postgres", database: "control_room" }, context, { spawn: spawnPgFamily })));
    assert.equal(calls.length, 53);
    for (const call of calls) {
      assert.equal(call.file, "/usr/bin/sandbox-exec");
      // Literal from the requested pgRoot; do not copy the spawned options.
      assert.equal(call.options.cwd, "/install/pg", "sandbox child must start in the allowed pgRoot");
      assert.deepEqual([call.options.uid, call.options.gid], [401, 401]);
      assert.equal(call.options.shell, false);
    }
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});

const darwin = process.platform === "darwin" ? false : "sandbox-exec is macOS only";

async function phaseFixture(t, mode) {
  // A SHORT root, as the real-PostgreSQL lane uses: the layout refuses a socket path
  // over macOS's `sun_path` budget, and a per-test directory under a long TMPDIR
  // crosses it.
  const root = await realpath(await mkdtemp(join(existsSync("/private/tmp") ? "/private/tmp" : tmpdir(), "cr-ready-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = 61987, socket = join(root, "pg", "socket"), bin = join(root, "runtime", "pg-current", "bin");
  for (const directory of [socket, bin, join(root, "updater", "current", "policy"), join(root, "logs", "postgresql17")]) {
    await mkdir(directory, { recursive: true });
  }
  await copyFile(join(REPO, "src/updater/v1/policy/service-postgres.sb"),
    join(root, "updater", "current", "policy", "service-postgres.sb"));
  await symlink(REPO, join(root, "current"));
  const count = join(socket, "attempts"), say = `connection to server on socket \\"${socket}/.s.PGSQL.${port}\\" failed:`;
  // The scripted psql. The layout's environment has no PATH, so every program it
  // runs is named absolutely, and it writes only inside SOCKET_ROOT, which is all
  // the profile lets it write.
  await writeFile(join(bin, "psql"), [
    "#!/bin/sh",
    `n=$(/bin/cat "${count}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${count}"`,
    "program=$(/bin/cat)",
    mode === "late" ? `if [ "$n" -le 2 ]; then echo "psql: error: ${say} No such file or directory" >&2; exit 2; fi` : "",
    mode === "starting" ? `if [ "$n" -le 2 ]; then echo "psql: error: ${say} FATAL:  the database system is starting up" >&2; exit 2; fi` : "",
    mode === "auth" ? `echo "psql: error: ${say} FATAL:  Peer authentication failed for user \\"postgres\\"" >&2; exit 2` : "",
    'case "$program" in *pg_terminate_backend*) echo "ERROR:  scripted server reached the orphan sweep" >&2; exit 3 ;; esac',
    'echo 1', "exit 0", "",
  ].join("\n"), { mode: 0o755 });
  await chmod(join(bin, "psql"), 0o755);
  const name = userInfo().username;
  const request = Object.freeze({ schema: "control-room.release-schema/v1", root, pgDataId: "data-A",
    runtime: "runtime/pg-current", socketDir: "pg/socket", port, release: "current",
    accounts: { database: { name, uid: process.getuid(), gid: process.getgid() },
      service: { name: `${name}-service`, uid: process.getuid() === 502 ? 503 : 502, gid: process.getgid() } },
    logins: [{ name: "control_room_web", passwordStdin: true }] });
  const passwords = { control_room_web: `control_room_web-fixture-${"p".repeat(24)}` };
  const run = () => applyReleaseSchemaV1(request, passwords,
    { planLayout: input => planPgClusterLayoutV1(input), readinessIntervalMs: 50 });
  return { run, attempts: async () => Number((await readFile(count, "utf8")).trim()) };
}

test("the release phase waits for a postmaster that is still starting before its first statement", { skip: darwin }, async t => {
  for (const mode of ["late", "starting"]) {
    const fixture = await phaseFixture(t, mode);
    // Reaching the orphan sweep IS the proof: it is the phase's first statement, and
    // the scripted server only answers it after two "not up yet" attempts.
    await assert.rejects(fixture.run(), /scripted server reached the orphan sweep/u, mode);
    assert.equal(await fixture.attempts(), 4, `${mode}: two not-ready answers, one ready probe, then the sweep`);
  }
});

test("the release phase refuses an authentication failure at the first attempt", { skip: darwin }, async t => {
  const fixture = await phaseFixture(t, "auth");
  await assert.rejects(fixture.run(), /pg_phase_session_refused:2:.*Peer authentication failed/u);
  assert.equal(await fixture.attempts(), 1);
});
