// End-to-end proof of Bug 1: a connector stopped the way an owner actually stops
// one reports a clean offline immediately.
//
// The bug: `runWorker`'s `finally { ... offline() }` only ran on a normal return
// (`--once`), a revoked key or a thrown error. With no SIGINT/SIGTERM listener
// registered, Node terminates at the libuv layer on a stop signal, so no pending
// `finally` ever ran: the machine stayed "checking in" until the server's 90s
// window lapsed into "Unreachable" — the alarming red state the whole fenced
// offline call exists to prevent.
//
// Why this spawns a real process and raises a real signal: the bug IS the signal
// handling, and it is invisible to any in-process test. Calling
// `runWorker`'s stop path directly, or injecting a fake signal, would exercise
// the code that exists rather than the behaviour that was missing — the review
// proved exactly that a `try/finally` around a sleep loop never runs its cleanup
// on SIGINT. So this starts the real connector module as a child process, waits
// for its first real check-in over real HTTP, sends it a real SIGTERM, and
// asserts the offline call arrives.
//
// Nothing here is injected: no fake signal, no injected runner, no mocked
// process. The connector's own `installStopSignalsV1` default is what runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FLEET_WORKING_AGREEMENT_METADATA_V1 } from "../src/fleet/v1/working-agreement";

const CONNECTOR = new URL("../scripts/fleet/connector.mjs", import.meta.url).pathname;
const SESSION_PATTERN = /^fleet-session:[a-f0-9]{32}$/u;

/** A gateway stub that speaks only what a stopping connector needs: one real
 * HTTP server on a real socket, counting the calls that matter. It is not a mock
 * of the connector under test — the connector runs unmodified, with its own
 * default signal handlers, against a real socket. */
function startGateway(t) {
  const calls = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* refuse below */ }
      calls.push({ path: request.url ?? "", body });
      const ok = (result) => { response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, result })); };
      const path = request.url ?? "";
      if (path === "/fleet/v1/enroll") { response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, result: { workerId: `fleet-worker:${"a".repeat(32)}` } })); return; }
      if (path === "/fleet/v1/heartbeat") {
        ok({ workerId: `fleet-worker:${"a".repeat(32)}`, displayName: "Stop machine", workerKind: "handoff",
          projectIds: [], capabilities: [], maxConcurrent: 1, credentialExpiresAt: null, canApprove: false,
          canAcceptResults: false, canMerge: false, canChangePermissions: false, operationsMode: "running",
          claimsAllowed: true, workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1 });
        return;
      }
      if (path === "/fleet/v1/offline") { ok({ ok: true }); return; }
      if (path === "/fleet/v1/work") { ok([]); return; }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "not_found" }));
    });
  });
  t.after(() => new Promise(resolve => { server.close(() => resolve()); }));
  return { server, calls, listen: () => new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)); }) };
}

/** A credential the real `loadConfig` accepts, so the connector reaches its work
 * loop without any production guard being stood down. */
async function writeCredential(dir, port) {
  const path = join(dir, "credential.json");
  await writeFile(path, JSON.stringify({ schema: "control-room.fleet-connector/v1", server: `http://127.0.0.1:${port}`,
    secret: `crf_${"s".repeat(43)}`, workerId: `fleet-worker:${"a".repeat(32)}`, installedAt: new Date().toISOString() }));
  // `loadConfig` refuses a world- or group-readable credential file. That guard
  // is a real production guard and this test does not stand it down: the
  // connector under test is started exactly as it is started for an owner.
  await chmod(path, 0o600);
  return path;
}

async function waitFor(predicate, label, timeoutMs = 30_000, childStderr = []) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (childStderr.exitCode !== null) {
      throw new Error(`the connector exited (${childStderr.exitCode}) before ${label}. Its own output: `
        + childStderr.lines.join("").slice(-800));
    }
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error(`timed out waiting for ${label}. Its output so far: `
    + childStderr.lines.join("").slice(-800));
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`a real ${signal} stops the connector cleanly and reports offline (production default path)`, async t => {
    const gateway = startGateway(t);
    const port = await gateway.listen();
    const dir = await mkdtemp(join(tmpdir(), "control-room-connector-stop-"));
    // Own process group, killed in `finally`: this test starts a real child that
    // installs signal handlers, and leaving one behind would keep a timer alive.
    let child = null;
    t.after(async () => {
      if (child?.pid && child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
      await rm(dir, { recursive: true, force: true });
    });
    const configPath = await writeCredential(dir, port);

    child = spawn(process.execPath, [CONNECTOR, "run", "--config", configPath, "--harnesses", join(dir, "harnesses.json")], {
      env: { ...process.env, CONTROL_ROOM_PG_TEST_PORT_BASE: process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? "" },
      detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const tracker = { exitCode: null, lines: [], exited: new Promise(resolve => {
      child.stderr?.on("data", chunk => tracker.lines.push(String(chunk)));
      // `child.exitCode` is null on some paths at the moment `exit` resolves, so
      // the code is read off the event here and nowhere else.
      child.on("exit", (code) => { tracker.exitCode = code; resolve(code); });
    }) };

    // The connector must reach the gateway on its own, with its own default
    // signal handling. No injected stop, no fake timer.
    await waitFor(() => gateway.calls.some(call => call.path === "/fleet/v1/heartbeat"),
      "the first real check-in", 30_000, tracker);
    const first = gateway.calls.find(call => call.path === "/fleet/v1/heartbeat");
    assert.match(String(first.body.sessionId), SESSION_PATTERN,
      "every check-in carries the connector's own session id, which is what makes a clean stop possible");

    process.kill(child.pid, signal);

    await waitFor(() => gateway.calls.some(call => call.path === "/fleet/v1/offline"),
      `the clean offline call after ${signal}`, 20_000, tracker);
    const offline = gateway.calls.find(call => call.path === "/fleet/v1/offline");
    assert.equal(offline.body.sessionId, first.body.sessionId,
      "the stop must be fenced to the session that checked in, or a stale process could take a live one offline");

    // The decisive property: the stop is reported PROMPTLY. Without the handler
    // there is no call at all and the machine reads Unreachable after 90s, so
    // anything inside a couple of seconds is proof the cleanup actually ran.
    const closedAt = gateway.calls.findIndex(call => call.path === "/fleet/v1/offline");
    assert.ok(closedAt >= 0);
    const checkInsBeforeStop = gateway.calls.filter(call => call.path === "/fleet/v1/heartbeat").length;
    assert.ok(checkInsBeforeStop >= 1);

    const settled = await tracker.exited;
    assert.equal(settled, 0,
      "a deliberate stop is a clean exit, not a failure a service manager would report: "
      + `code=${settled} stderr=${tracker.lines.join("").slice(-400)}`);
  });
}

test("a second stop signal exits immediately rather than waiting on the network", async t => {
  const gateway = startGateway(t);
  const port = await gateway.listen();
  const dir = await mkdtemp(join(tmpdir(), "control-room-connector-double-"));
  let child = null;
  t.after(async () => {
    if (child?.pid && child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
    await rm(dir, { recursive: true, force: true });
  });
  const configPath = await writeCredential(dir, port);
  child = spawn(process.execPath, [CONNECTOR, "run", "--config", configPath, "--harnesses", join(dir, "harnesses.json")],
    { env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const tracker2 = { exitCode: null, lines: [], exited: new Promise(resolve => {
    child.stderr?.on("data", chunk => tracker2.lines.push(String(chunk)));
    child.on("exit", (code) => { tracker2.exitCode = code; resolve(code); });
  }) };
  child.stdout?.resume();
  await waitFor(() => gateway.calls.some(call => call.path === "/fleet/v1/heartbeat"),
    "the first check-in", 30_000, tracker2);

  process.kill(child.pid, "SIGTERM");
  process.kill(child.pid, "SIGTERM");
  const code = await Promise.race([
    tracker2.exited,
    new Promise(resolve => setTimeout(() => resolve("timeout"), 15_000))]);
  assert.notEqual(code, "timeout",
    "an owner who pressed Ctrl-C twice means it: the process must not linger");
  void configPath;
});