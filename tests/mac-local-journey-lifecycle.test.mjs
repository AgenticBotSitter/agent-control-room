import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { runMacLocalJourneyV1 } from "../scripts/mac-local/rehearsal/journey-lifecycle.ts";

function runtimeFixture() {
  const runtime = new EventEmitter(), diagnostics = [], exits = [];
  runtime.stderr = { write: message => diagnostics.push(message) };
  runtime.exit = code => exits.push(code);
  return { runtime, diagnostics, exits };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}

const disconnects = [
  Object.assign(new Error("raw shutdown"), { code: "57P01" }),
  Object.assign(new Error("wrapped shutdown"), { code: "database_unavailable", sqlState: "57P01" }),
  Object.assign(new Error("reset"), { code: "ECONNRESET" }),
  Object.assign(new Error("pipe"), { code: "EPIPE" }),
  new Error("terminating connection due to administrator command"),
  new Error("Connection terminated unexpectedly"),
  new Error("Client has encountered a connection error and is not queryable"),
];

test("a connection error during a running journey fails only after all owned cleanup finishes", async () => {
  for (const event of ["uncaughtException", "unhandledRejection"]) {
    for (const error of disconnects) {
      const f = runtimeFixture(), started = deferred(), draining = deferred(), finish = deferred();
      const resources = new Set(["supervisor", "website", "intake", "gateway", "database"]);
      let signal, cleaned = false, settled = false;
      const run = runMacLocalJourneyV1(async abort => {
        signal = abort;
        started.resolve();
        await once(abort, "abort");
        abort.throwIfAborted();
      }, async settleWork => {
        draining.resolve();
        await finish.promise;
        resources.clear();
        await settleWork();
        cleaned = true;
      }, { runtime: f.runtime, isStoppingDatabase: () => false });
      const rejected = assert.rejects(run, actual => actual === error).finally(() => { settled = true; });
      await started.promise;
      f.runtime.emit(event, error);
      assert.equal(signal.aborted, true);
      assert.equal(f.runtime.exitCode, 1);
      assert.deepEqual(f.exits, [], "explicit exit would bypass the actual journey's finally");
      await within(draining.promise, "cleanup did not start after the process error");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, "failure cannot finish while cleanup is still blocked");
      assert.equal(resources.size, 5);
      finish.resolve();
      await rejected;
      assert.equal(cleaned, true);
      assert.equal(resources.size, 0);
      assert.match(f.diagnostics.join(""), /journey process error:/u);
      assert.equal(f.runtime.listenerCount(event), 0);
    }
  }
});

test("only an expected disconnect during deliberate database shutdown is tolerated", async () => {
  const f = runtimeFixture();
  f.runtime.exitCode = 7;
  let stopping = false, cleanups = 0;
  await runMacLocalJourneyV1(async () => {}, async () => {
    cleanups++;
    stopping = true;
    for (const error of disconnects) {
      f.runtime.emit("uncaughtException", error);
      f.runtime.emit("unhandledRejection", error);
    }
  }, { runtime: f.runtime, isStoppingDatabase: () => stopping });
  assert.equal(cleanups, 1);
  assert.equal(f.runtime.exitCode, 7, "teardown cannot erase an earlier failed exit code");
  assert.deepEqual(f.diagnostics, []);
  assert.deepEqual(f.exits, []);
});

test("unrelated and missing error data during database shutdown still fail", async () => {
  for (const error of [new Error("unexpected failure"), null, undefined, "bad input",
    { code: "XX000", message: "database fault" }]) {
    const f = runtimeFixture();
    await assert.rejects(runMacLocalJourneyV1(async () => {}, async () => {
      f.runtime.emit("uncaughtException", error);
    }, { runtime: f.runtime, isStoppingDatabase: () => true }),
    actual => error === undefined ? actual?.name === "AbortError" : actual === error);
    assert.equal(f.runtime.exitCode, 1);
    assert.equal(f.diagnostics.length, 1);
    assert.equal(f.runtime.listenerCount("uncaughtException"), 0);
    assert.equal(f.runtime.listenerCount("unhandledRejection"), 0);
  }
});

test("an error while stopping the host is not a database teardown success", async () => {
  const f = runtimeFixture(), error = disconnects[0];
  await assert.rejects(runMacLocalJourneyV1(async () => {}, async () => {
    f.runtime.emit("unhandledRejection", error);
  }, { runtime: f.runtime, isStoppingDatabase: () => false }), actual => actual === error);
  assert.equal(f.runtime.exitCode, 1);
});

test("a failed diagnostic stream cannot prevent cancellation or cleanup", async () => {
  const f = runtimeFixture(), started = deferred(), error = new Error("journey failure");
  f.runtime.stderr.write = () => { throw new Error("diagnostic stream failed"); };
  let cleanups = 0;
  const run = runMacLocalJourneyV1(async signal => {
    started.resolve();
    await once(signal, "abort");
    signal.throwIfAborted();
  }, async () => { cleanups++; }, { runtime: f.runtime, isStoppingDatabase: () => false });
  const rejected = assert.rejects(run, actual => actual === error);
  await started.promise;
  assert.doesNotThrow(() => f.runtime.emit("uncaughtException", error));
  await rejected;
  assert.equal(cleanups, 1);
  assert.equal(f.runtime.exitCode, 1);
  assert.deepEqual(f.exits, []);
});

test("ordinary work and cleanup failures propagate, remove handlers, and allow a retry", async () => {
  const f = runtimeFixture();
  for (const stage of ["work", "cleanup"]) {
    const error = new Error(`${stage} failed`);
    let cleanupCalls = 0;
    await assert.rejects(runMacLocalJourneyV1(async () => {
      if (stage === "work") throw error;
    }, async () => {
      cleanupCalls++;
      if (stage === "cleanup") throw error;
    }, { runtime: f.runtime, isStoppingDatabase: () => false }), actual => actual === error);
    assert.equal(cleanupCalls, 1);
    assert.equal(f.runtime.listenerCount("uncaughtException"), 0);
    assert.equal(f.runtime.listenerCount("unhandledRejection"), 0);
    await runMacLocalJourneyV1(async () => {}, async () => { cleanupCalls++; },
      { runtime: f.runtime, isStoppingDatabase: () => false });
    assert.equal(cleanupCalls, 2);
  }
});

test("a burst of 50 failures owns one shutdown and waits for cancelled work before file removal", async () => {
  const f = runtimeFixture(), started = deferred(), finishWork = deferred(), stopped = deferred();
  const error = new Error("first failure"), order = [];
  let signal, cleanupCalls = 0, settled = false;
  const run = runMacLocalJourneyV1(async abort => {
    signal = abort;
    started.resolve();
    await finishWork.promise;
    order.push("last pending write");
    abort.throwIfAborted();
  }, async settleWork => {
    cleanupCalls++;
    order.push("stop owned transports");
    stopped.resolve();
    await settleWork();
    order.push("remove owned files");
  }, { runtime: f.runtime, isStoppingDatabase: () => false });
  const rejected = assert.rejects(run, actual => actual === error).finally(() => { settled = true; });
  await started.promise;
  await Promise.all(Array.from({ length: 50 }, (_, index) => Promise.resolve().then(() => {
    f.runtime.emit(index % 2 ? "uncaughtException" : "unhandledRejection", index === 0 ? error : new Error("later failure"));
  })));
  await within(stopped.promise, "shutdown must start before stalled work finishes");
  assert.equal(signal.reason, error);
  assert.equal(settled, false);
  assert.equal(cleanupCalls, 1);
  assert.equal(f.diagnostics.length, 1);
  finishWork.resolve();
  await rejected;
  assert.deepEqual(order, ["stop owned transports", "last pending write", "remove owned files"]);
  assert.deepEqual(f.exits, []);
});

test("even a cleanup that omits the drain cannot return while cancelled work is active", async () => {
  const f = runtimeFixture(), started = deferred(), finishWork = deferred(), cleaned = deferred();
  const error = new Error("stop halfway");
  let settled = false;
  const run = runMacLocalJourneyV1(async () => { started.resolve(); await finishWork.promise; },
    async () => { cleaned.resolve(); }, { runtime: f.runtime, isStoppingDatabase: () => false });
  const rejected = assert.rejects(run, actual => actual === error).finally(() => { settled = true; });
  await started.promise;
  f.runtime.emit("unhandledRejection", error);
  await cleaned.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finishWork.resolve();
  await rejected;
});

test("the actual journey cancels helper launches, requests and polling after a fatal error", async () => {
  const source = await readFile(new URL("../scripts/mac-local/rehearsal/journey.ts", import.meta.url), "utf8");
  const helpers = source.slice(source.indexOf("function invoke("), source.indexOf("async function main("));
  const compiled = ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const controller = new AbortController(), calls = [], failure = new Error("journey aborted");
  const { invoke, journeyFetch, waitFor } = Function("spawnSync", "fetch", "process", "journeySignal", "protectedRoot",
    `${compiled}\nreturn { invoke, journeyFetch, waitFor };`)(
    (...args) => calls.push(["spawn", ...args]), (...args) => calls.push(["request", ...args]),
    { execPath: "/runtime/node", cwd: () => "/worktree", env: {} }, controller.signal, "/protected");
  invoke(["probe.mjs"]);
  journeyFetch("http://example.invalid");
  assert.equal(calls.length, 2, "live controls must reach the real wrappers");
  assert.equal(calls[1][2].signal, controller.signal);
  controller.abort(failure);
  assert.throws(() => invoke(["probe.mjs"]), actual => actual === failure);
  assert.throws(() => journeyFetch("http://example.invalid"), actual => actual === failure);
  await assert.rejects(waitFor(async () => { calls.push(["poll"]); return true; }, 1), actual => actual === failure);
  assert.equal(calls.length, 2, "cancelled work cannot restart transports or issue requests");
});

test("the real entry wires cleanup through the lifecycle and arms shutdown only for its verified database", async () => {
  const source = await readFile(new URL("../scripts/mac-local/rehearsal/journey.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ runMacLocalJourneyV1 \} from "\.\/journey-lifecycle"/u);
  assert.match(source, /await runMacLocalJourneyV1\(async signal => \{\s*journeySignal = signal;\s*await main\(\);/u);
  assert.doesNotMatch(source, /process\.on\("(?:uncaughtException|unhandledRejection)"/u);
  assert.match(source, /stackMayBeUp = true;\s*const start1 = invoke\(upArgs\);/u);
  assert.match(source, /if \(verifiedThisRehearsalCluster\) \{[\s\S]*stoppingDatabase = true;\s*const down = spawnSync/u);
  assert.match(source, /finally \{\s*await settleWork\(\);[\s\S]*await removeJourneyConnectorWorkspacesV1\(\);/u);
  assert.match(source, /await once\(process\.stdin, "data", \{ signal: journeySignal \}\)/u);
  assert.match(source, /isStoppingDatabase: \(\) => stoppingDatabase/u);
});
