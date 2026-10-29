// `stopCluster` must give a postmaster that `pg_ctl` could not stop the chance to
// leave through SIGQUIT (PostgreSQL's immediate shutdown, which releases its SysV
// shared-memory segment) before it falls back to SIGKILL (which orphans it).
//
// No PostgreSQL is needed: the "postmaster" is a stub node process whose argv
// contains `postgres` (so the helper's default liveness check would accept it), and `pg_ctl`
// is a stub that always fails, which is what sends `stopCluster` to its fallback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isPidAlive, stopCluster } from "./helpers/disposable-postgres-cluster";

// `kill -0` liveness: the stub's argv carries `postgres`, but the default check shells out to ps.
const isAlive = pid => typeof pid === "number" && isPidAlive(pid);

/** A stub postmaster that records every signal it is sent; `ignoreQuit` makes it refuse SIGQUIT. */
async function startStub(root, ignoreQuit) {
  const log = join(root, "signals.log");
  const script = `
    const { appendFileSync } = require("node:fs");
    process.on("SIGQUIT", () => { appendFileSync(${JSON.stringify(log)}, "SIGQUIT\\n"); if (!${ignoreQuit}) process.exit(0); });
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script, "postgres"], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise(resolve => child.stdout.once("data", resolve));
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  return { child, closed, log };
}

function fixture(pid) {
  const root = mkdtempSync(join(tmpdir(), "quit-before-kill-"));
  const data = join(root, "data");
  mkdirSync(data);
  writeFileSync(join(data, "postmaster.pid"), `${pid}\n`);
  const pgCtl = join(root, "pg_ctl");
  writeFileSync(pgCtl, "#!/bin/sh\nexit 1\n");
  chmodSync(pgCtl, 0o755);
  const socket = join(root, "socket");
  mkdirSync(socket);
  return { root, cluster: { run: join(root, "run"), data, socket, port: 1, pgCtl, fixturePassword: "unused" } };
}

test("stopCluster sends SIGQUIT to a postmaster pg_ctl could not stop, and does not SIGKILL one that leaves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quit-before-kill-stub-"));
  const stub = await startStub(dir, false);
  const { root, cluster } = fixture(stub.child.pid);
  try {
    await stopCluster(cluster, { quitGraceMs: 5_000, isAlive });
    const exit = await stub.closed;
    assert.equal(readFileSync(stub.log, "utf8"), "SIGQUIT\n", "the stub must have been sent SIGQUIT");
    assert.deepEqual(exit, { code: 0, signal: null }, "a process that quits on SIGQUIT must not be SIGKILLed");
    assert.equal(existsSync(cluster.socket), false, "the socket directory is removed once the postmaster is gone");
  } finally {
    try { stub.child.kill("SIGKILL"); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopCluster falls back to SIGKILL only after SIGQUIT was ignored for the grace period", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quit-before-kill-stub-"));
  const stub = await startStub(dir, true);
  const { root, cluster } = fixture(stub.child.pid);
  try {
    const started = Date.now();
    await stopCluster(cluster, { quitGraceMs: 400, isAlive });
    const exit = await stub.closed;
    assert.equal(readFileSync(stub.log, "utf8"), "SIGQUIT\n", "SIGQUIT must come before the SIGKILL");
    assert.deepEqual(exit, { code: null, signal: "SIGKILL" }, "a process that ignores SIGQUIT is SIGKILLed after the grace");
    assert.ok(Date.now() - started >= 350, "the grace period must be waited out before SIGKILL");
  } finally {
    try { stub.child.kill("SIGKILL"); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
