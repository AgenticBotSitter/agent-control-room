import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { authorized, PortPool, RunnerRefusal } from "../scripts/test-runner/service.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  // Exercise the production HTTP handler with controlled command resolution
  // and execution. Native sandbox availability must not decide whether the
  // disconnect checks are tested. The existing service suite covers spawning.
  const source = readFileSync(new URL("../scripts/test-runner/service.mjs", import.meta.url), "utf8");
  const server = new EventEmitter(), resolving = deferred(), releaseResolution = deferred();
  const calls = [], audits = [];
  let gate = true;
  const create = runInNewContext(source.slice(source.indexOf("export async function createTestRunnerService"))
    .replace("export async function", "async function") + "\ncreateTestRunnerService", {
    AbortController, Map, Object, Date, Promise, RunnerRefusal, PortPool, authorized,
    readOrCreateToken: async () => "fixture-token",
    createServer: handler => { server.on("request", handler); return server; },
    requestBody: async request => request.body,
    resolveApprovedCommand: async () => {
      resolving.resolve();
      if (gate) await releaseResolution.promise;
      return { worktree: "fixture", display: "fixture" };
    },
    portBlockHeld: async () => false,
    randomUUID: () => `run-${calls.length}`,
    executeApprovedCommand: (_config, _command, block, { signal }) => {
      const done = deferred();
      const call = { signal, block, finish: () => done.resolve({ cancelled: signal.aborted }) };
      calls.push(call);
      signal.addEventListener("abort", call.finish, { once: true });
      if (signal.aborted) call.finish();
      return done.promise;
    },
    appendAudit: async (_config, record) => audits.push(record),
    respond: (response, status, body) => { response.status = status; response.body = body; response.writableEnded = true; },
  });
  const service = await create({ tokenFile: "fixture", portPool: { start: 28100, end: 28101, blockSize: 2 }, concurrency: 1 });
  function request() {
    const response = new EventEmitter();
    response.destroyed = false; response.writableEnded = false;
    const finished = server.listeners("request")[0]({ headers: { authorization: "Bearer fixture-token" },
      method: "POST", url: "/v1/runs", body: {} }, response);
    return { response, finished };
  }
  return { service, calls, audits, resolving, releaseResolution, request, ungate: () => { gate = false; } };
}

test("disconnect guard starts no run during controlled request resolution (S8)", async () => {
  const f = await fixture(), first = f.request();
  try {
    await f.resolving.promise;
    first.response.destroyed = true;
    first.response.emit("close");
    f.releaseResolution.resolve();
    // A disabled pre-start guard invokes execution even with an aborted signal.
    await first.finished;
    assert.equal(f.calls.length, 0);
    assert.equal(f.audits.length, 0);
    assert.equal(f.service.activeRuns.size, 0);
    f.ungate();
    const retry = f.request();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 1, "disconnect releases the only slot and port block");
    f.calls[0].finish(); await retry.finished;
    assert.equal(retry.response.status, 200);
  } finally {
    f.releaseResolution.resolve();
    for (const call of f.calls) call.finish();
    await first.finished;
  }
});

test("server aborts a controlled run when the client disconnects before it finishes", async () => {
  const f = await fixture(); f.ungate();
  const first = f.request();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].signal.aborted, false);
    const burst = Array.from({ length: 50 }, () => f.request());
    await Promise.all(burst.map(request => request.finished));
    assert.ok(burst.every(request => request.response.status === 429));
    assert.equal(f.calls.length, 1, "all 50 excess callers must be refused");
    first.response.destroyed = true; first.response.emit("close");
    assert.equal(f.calls[0].signal.aborted, true, "a running command must receive cancellation");
    await first.finished;
    assert.equal(f.audits[0].cancelled, true);
    assert.equal(f.service.activeRuns.size, 0);
    const retry = f.request();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1].block, f.calls[0].block);
    f.calls[1].finish(); await retry.finished;
    assert.equal(retry.response.status, 200);
  } finally {
    for (const call of f.calls) call.finish();
    await first.finished;
  }
});
