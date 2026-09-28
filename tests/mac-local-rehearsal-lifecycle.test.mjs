import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRehearsalOwnership,
  installRehearsalSignalCleanup,
  runBoundedChild,
} from "../scripts/mac-local/rehearsal/lifecycle.mjs";

async function temporaryRoot(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "acr-rehearsal-lifecycle-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("ownership refuses a nonempty root, reserved ports, and an owner protected root", async t => {
  const root = await temporaryRoot(t), registryDirectory = join(root, "registry"), rehearsal = join(root, "run");
  await mkdir(rehearsal, { mode: 0o700 });
  await writeFile(join(rehearsal, "existing"), "x");
  const input = { root: rehearsal, databasePort: 15499, webPort: 3217,
    repositoryRoot: await realpath(process.cwd()), registryDirectory };
  await assert.rejects(createRehearsalOwnership(input), /rehearsal_root_not_empty/u);
  await rm(join(rehearsal, "existing"));
  await assert.rejects(createRehearsalOwnership({ ...input, databasePort: 5432 }), /reserved_port/u);
  await assert.rejects(createRehearsalOwnership({ ...input, webPort: 3210 }), /reserved_port/u);
  await assert.rejects(createRehearsalOwnership({ ...input, forbiddenProtectedRoots: [rehearsal] }), /protected_root_refused/u);
});

test("bounded child reports its process group and kills it after the timeout", async () => {
  let spawned;
  const result = await runBoundedChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 50,
    terminateGraceMs: 20,
    onSpawn: record => { spawned = record; },
  });
  assert.ok(spawned.pid > 1);
  assert.equal(spawned.group, true);
  assert.deepEqual(spawned.command.slice(0, 2), [process.execPath, "-e"]);
  assert.equal(result.timedOut, true);
  assert.notEqual(result.signal, null);
});

test("a failed child-registration hook terminates the child before returning", async () => {
  const result = await runBoundedChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 5_000,
    terminateGraceMs: 20,
    onSpawn: async () => { throw new Error("registry write failed"); },
  });
  assert.match(result.error?.message ?? "", /registry write failed/u);
  assert.notEqual(result.signal, null);
});

test("a fast child cannot resolve before its asynchronous process registration settles", async () => {
  let registered = false;
  const resultPromise = runBoundedChild(process.execPath, ["-e", "process.exit(0)"], {
    timeoutMs: 5_000,
    onSpawn: async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      registered = true;
    },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(registered, false);
  const result = await resultPromise;
  assert.equal(registered, true);
  assert.equal(result.status, 0);
});

test("a closed child is never signalled when late process registration fails", async () => {
  let kills = 0;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 999_999;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { kills++; };
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };
  const result = await runBoundedChild("fake", [], {
    spawnImpl,
    onSpawn: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      throw new Error("late registration failure");
    },
  });
  assert.match(result.error?.message ?? "", /late registration failure/u);
  assert.equal(kills, 0);
});

test("a timed-out child that closes during registration is never killed through a recycled PID", async () => {
  const signals = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 999_998;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = signal => {
      signals.push(signal);
      if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    };
    return child;
  };
  const result = await runBoundedChild("fake", [], {
    spawnImpl,
    timeoutMs: 5,
    terminateGraceMs: 10,
    onSpawn: async () => { await new Promise(resolve => setTimeout(resolve, 40)); },
  });
  assert.equal(result.timedOut, true);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("signal cleanup exits only after one awaited cleanup", async () => {
  const processObject = new EventEmitter();
  let cleaned = false, exits = [];
  const installed = installRehearsalSignalCleanup(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    cleaned = true;
  }, { processObject, exit: code => exits.push({ code, cleaned }) });
  processObject.emit("SIGINT");
  processObject.emit("SIGTERM");
  await installed.wait();
  assert.deepEqual(exits, [{ code: 130, cleaned: true }]);
  installed.dispose();
});
