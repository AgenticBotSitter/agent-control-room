import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createPrivateNodeTool } from "./support/private-node-tool.mjs";
import test from "node:test";
import { inToolTimerScope, withToolTimerScope, preparedToolRunner, retireToolProcess,
  preserveToolFailure } from "./support/prepared-tool-runner.mjs";
import * as connector from "../scripts/fleet/connector.mjs";
import { RELEASE_TRUST_SCHEMA_V1, connectorReleaseSignatureMaterialV1,
  releaseKeyIdV1 } from "../scripts/release-signing.mjs";

/** The gateway ships the agreement metadata; a fake that omits it is refused. */
const WORKING_AGREEMENT = Object.freeze({ version: connector.WORKING_AGREEMENT.version,
  digest: connector.WORKING_AGREEMENT.digest, startsWork: false, grantsAuthority: false });

const scratchRoot = join(process.cwd(), ".test-tmp", "e078", "fixtures");
async function toolTemporaryRoot() { await mkdir(scratchRoot, { recursive: true, mode: 0o700 }); return scratchRoot; }
let privateToolDirectory, privateTool;
test.after(async () => {
  if (privateToolDirectory) await rm(privateToolDirectory, { recursive: true, force: true });
});

async function workspaceNodeTool(dir) {
  privateTool ??= (async () => {
    privateToolDirectory = await mkdtemp(join(await toolTemporaryRoot(), "fleet-tool-runtime-"));
    return createPrivateNodeTool(privateToolDirectory);
  })();
  const path = join(dir, "node-tool");
  // Workspaces have private names and directories, but share one immutable copy.
  // Never link the installed executable: its owner/mode may be unsafe for tools.
  await link(await privateTool, path);
  return path;
}

// Setup bounds diagnose a missing observation; they never release a gate.
async function waitForToolSignal(signal, message, { timeoutMs = 10_000 } = {}) {
  let timer;
  try {
    return await Promise.race([signal, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new assert.AssertionError({ message })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitForToolState(observe, message, options = {}) {
  let finished = false;
  try {
    await waitForToolSignal((async () => {
      while (!finished && !await observe()) {
        await new Promise(done => setImmediate(done));
      }
    })(), message, options);
  } finally { finished = true; }
}

// One hook owns process retirement and workspace removal. A removal error must
// never prevent killing/reaping another child, or leave a writer racing rm.
const resources = new WeakMap();
function toolResources(t) {
  let state = resources.get(t);
  if (!state) {
    state = { children: [], removals: [] };
    resources.set(t, state);
    t.after(() => cleanupToolResources(t));
  }
  return state;
}
function removeToolWorkspace(t, remove) {
  toolResources(t).removals.push(remove);
}
const observedCloses = new WeakMap();
function trackToolProcess(t, child) {
  if (observedCloses.has(child)) return observedCloses.get(child);
  const closed = new Promise(done => child.once("close", done));
  observedCloses.set(child, closed);
  toolResources(t).children.push({ child, closed });
  return closed;
}
async function cleanupToolProcesses(state) {
  const children = state.children.splice(0);
  const results = await Promise.allSettled(children.map(async ({ child, closed }) => {
    await retireToolProcess({ child, closed }, { wait: waitForToolSignal });
  }));
  for (const [index, result] of results.entries()) if (result.status === "rejected") state.children.push(children[index]);
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
}
async function cleanupToolResources(t) {
  const state = resources.get(t);
  if (!state) return;
  let primaryError;
  try { await cleanupToolProcesses(state); }
  catch (error) { primaryError = error; }
  finally {
    const removals = primaryError ? [] : state.removals.splice(0);
    const results = await Promise.allSettled(removals.map(remove => remove()));
    const failure = results.find(result => result.status === "rejected");
    if (failure && !primaryError) primaryError = failure.reason;
  }
  if (primaryError) throw primaryError;
}

async function waitForProcessGone(pid, message) {
  await waitForToolState(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error?.code !== "ESRCH") throw error; return true; }
  }, message);
  assert.throws(() => process.kill(pid, 0), /ESRCH/u, message);
}


async function workspace(t) {
  const dir = await mkdtemp(join(await toolTemporaryRoot(), "fleet-tool-adapter-"));
  removeToolWorkspace(t, () => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  await workspaceNodeTool(dir);
  return dir;
}

test("workspaces share one private executable while keeping their files isolated", async t => {
  const first = await workspace(t), second = await workspace(t);
  const a = await stat(join(first, "node-tool")), b = await stat(join(second, "node-tool"));
  assert.deepEqual([a.dev, a.ino], [b.dev, b.ino], "workspaces reuse the private executable copy");
  assert.equal(a.mode & 0o777, 0o700, "the shared executable stays private");
  const installed = await stat(process.execPath);
  assert.notDeepEqual([a.dev, a.ino], [installed.dev, installed.ino], "the installed executable is not linked");
  await writeFile(join(first, "workspace-only"), "first");
  await assert.rejects(readFile(join(second, "workspace-only")), { code: "ENOENT" });
});

async function readyTool(t, script, marker, heartbeat, { stdin = "ignore", control = false, observation = () => {}, startProcess = nodeSpawn, clock = () => performance.now() } = {}) {
  const child = startProcess(join(dirname(script), "node-tool"), [script], {
    env: {}, shell: false, detached: process.platform !== "win32", stdio: [stdin, "pipe", "pipe", ...(control ? ["pipe"] : [])],
  });
  let failure;
  child.on("error", error => { failure = error; });
  trackToolProcess(t, child);
  // The adapter's clock measures killing a live group, not two Node startups.
  // Setup observes the real child files; it never creates readiness itself.
  const deadline = clock() + 10_000;
  while (true) {
    if (failure) throw failure;
    assert.ok(child.exitCode === null && child.signalCode === null, "the fixture must stay alive until adapter handoff");
    try {
      const values = await Promise.all([readFile(marker), readFile(heartbeat)]);
      observation(values);
      const pid = Number(values[0].toString());
      if (Number.isSafeInteger(pid) && pid > 0 && values[1].length > 0) break;
    }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    assert.ok(clock() < deadline, "the tool must write its PID and heartbeat within the setup bound");
    await new Promise(done => setTimeout(done, 10));
  }
  return child;
}

// Capture a real exit before testing the pipe-drain seam. A busy parent may
// take longer to exit than the adapter's timeout even after its child is ready.
// The caller replays this recorded tuple after the adapter installs listeners;
// stdout/stderr remain the real pipes held open by the escaped descendant.
async function exitedTool(child, release = () => child.stdin.end()) {
  let timer, observed;
  const exited = new Promise((resolveExit, rejectExit) => {
    observed = (code, signal) => resolveExit([code, signal]);
    child.once("exit", observed);
    timer = setTimeout(() => rejectExit(new Error("The fixture must exit within the original 10s setup bound.")), 10_000);
  });
  try {
    release();
    return await exited;
  } finally {
    clearTimeout(timer);
    child.off("exit", observed);
  }
}

test("exit barrier waits for the real parent exit before drain handoff", async t => {
  const dir = await workspace(t), marker = join(dir, "pid"), ready = join(dir, "ready");
  const gated = join(dir, "gated");
  const script = await executable(dir, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, String(process.pid));
writeFileSync(${JSON.stringify(ready)}, "ready");
process.stdin.on("data", bytes => {
  if (bytes.toString() === "exit") process.exit(0);
  writeFileSync(${JSON.stringify(gated)}, "gated");
});`);
  const child = await readyTool(t, script, marker, ready, { stdin: "pipe" });
  let handedOff = false;
  const pending = exitedTool(child, () => child.stdin.write("gate")).then(exit => { handedOff = true; return exit; });
  try {
    await waitForToolState(async () => {
      try { await readFile(gated); return true; }
      catch (error) { if (error?.code !== "ENOENT") throw error; return false; }
    }, "the real parent must reach its exit gate");
    await new Promise(done => setImmediate(done));
    assert.equal(handedOff, false, "drain handoff must wait for actual exit, not merely readiness");
  } finally {
    child.stdin.end("exit");
    await pending;
  }
  assert.deepEqual(await pending, [0, null], "exit arguments come from the real parent");
});

test("readiness barrier waits for the real tool PID and heartbeat before handoff", async t => {
  const dir = await workspace(t), marker = join(dir, "pid"), heartbeat = join(dir, "heartbeat");
  const started = join(dir, "started"), release = join(dir, "release");
  const script = await executable(dir, `import { existsSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "started");
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(release)})) return;
  writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  writeFileSync(${JSON.stringify(heartbeat)}, "ready");
  clearInterval(timer); setInterval(() => {}, 1000);
}, 10);`);
  let handedOff = false;
  const pending = readyTool(t, script, marker, heartbeat).then(child => { handedOff = true; return child; });
  pending.catch(() => {}); // Handle setup refusal while observing the startup gate.
  try {
    const deadline = performance.now() + 10_000;
    while (true) {
      try { await readFile(started); break; }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      assert.ok(performance.now() < deadline, "the real tool must reach its startup gate");
      await new Promise(done => setTimeout(done, 10));
    }
    await new Promise(done => setImmediate(done));
    assert.equal(handedOff, false, "handoff must wait for PID and heartbeat, not merely spawn");
  } finally {
    // Release the live fixture even when the readiness assertion fails.
    await writeFile(release, "release");
    await pending;
  }
  assert.equal(handedOff, true);
  assert.equal(await readFile(heartbeat, "utf8"), "ready");
});

test("readiness barrier refuses partial PID and heartbeat files", async t => {
  for (const [name, partialPid, partialHeartbeat, expectedPublications] of [
    ["partial PID", true, false, [2, 1]], ["partial heartbeat", false, true, [1, 2]], ["both partial", true, true, [2, 2]],
  ]) await t.test(name, async sub => {
    const dir = await workspace(sub), marker = join(dir, "pid"), heartbeat = join(dir, "heartbeat"), started = join(dir, "partial-started"), completed = join(dir, "partial-completed");
    const completionRelease = join(dir, "partial-release");
    const script = await executable(dir, `import { existsSync, writeFileSync } from "node:fs";
  const publications = [0, 0];
  const publish = (index, path, value) => { writeFileSync(path, value); publications[index] += 1; };
  const timer = setInterval(() => {
    if (!existsSync(${JSON.stringify(completionRelease)})) return;
    clearInterval(timer);
    // Complete only partial fields: rewriting ready content can truncate it
    // after the reader has already observed a valid PID/heartbeat pair.
    if (${JSON.stringify(partialPid)}) publish(0, ${JSON.stringify(marker)}, String(process.pid));
    if (${JSON.stringify(partialHeartbeat)}) publish(1, ${JSON.stringify(heartbeat)}, "ready");
    writeFileSync(${JSON.stringify(completed)}, JSON.stringify(publications));
  }, 10);
  publish(0, ${JSON.stringify(marker)}, ${JSON.stringify(partialPid)} ? "" : String(process.pid));
  publish(1, ${JSON.stringify(heartbeat)}, ${JSON.stringify(partialHeartbeat)} ? "" : "ready");
  writeFileSync(${JSON.stringify(started)}, String(process.pid)); process.stdin.resume();`);
    let handedOff = false, pid, observedPartial, readinessError;
    const partialRead = new Promise(done => { observedPartial = done; });
    const pending = readyTool(sub, script, marker, heartbeat, { stdin: "pipe", observation: values => {
      if ((values[0].length === 0) === partialPid && (values[1].length === 0) === partialHeartbeat) observedPartial();
    } }).then(child => { handedOff = true; return child; });
    pending.catch(() => {}); // A missing file must fail the body, not become an unhandled rejection.
    try {
      await waitForToolState(async () => {
        try { pid = Number(await readFile(started, "utf8")); return Number.isSafeInteger(pid) && pid > 0; }
        catch (error) { if (error?.code !== "ENOENT") throw error; return false; }
      }, "the real child must reach the partial-write gate");
      await waitForToolSignal(Promise.race([partialRead, pending]),
        "the real child must expose its partial readiness before the setup bound");
      await new Promise(done => setImmediate(done));
      assert.equal(handedOff, false, "partial readiness files cannot release handoff before their real contents arrive");
    } catch (error) { readinessError = error; throw error; }
    finally {
      // A persistent release survives delayed scheduling; no signal is needed.
      await writeFile(completionRelease, "release");
      await pending.catch(error => {
        if (!readinessError) throw new assert.AssertionError({
          message: "the partial-write gate was observed but completion stimulus did not publish readiness",
          cause: error,
        });
      });
    }
    let actualPublications;
    await waitForToolState(async () => {
      try { actualPublications = JSON.parse(await readFile(completed, "utf8")); return true; }
      catch (error) { if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; return false; }
    }, "the real child must acknowledge completed partial publication within the setup bound");
    assert.deepEqual(actualPublications, expectedPublications,
      "already-ready fixture content must never be republished after handoff");
    assert.equal(await readFile(marker, "utf8"), String(pid));
    assert.equal(await readFile(heartbeat, "utf8"), "ready");
  });
});

test("state barrier waits for observation and process disappearance", async t => {
  let ready = false, settled = false;
  const pending = waitForToolState(() => ready, "test state must become ready").then(() => { settled = true; });
  try {
    await new Promise(done => setImmediate(done));
    assert.equal(settled, false, "state barrier cannot release before its independent observation");
  } finally { ready = true; await pending; }

  const dir = await workspace(t), pidFile = join(dir, "pid"), initialized = join(dir, "initialized");
  const script = await executable(dir, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
writeFileSync(${JSON.stringify(initialized)}, "initialized"); process.stdin.resume();`);
  const child = await readyTool(t, script, pidFile, initialized, { stdin: "pipe" });
  let gone = false;
  const disappearance = waitForProcessGone(child.pid, "the owned process must disappear").then(() => { gone = true; },
    error => { gone = true; return error; });
  try {
    await new Promise(done => setImmediate(done));
    assert.equal(gone, false, "process barrier cannot release while the owned child is alive");
  } finally {
    child.stdin.end();
    const result = await disappearance;
    assert.equal(result, undefined, "the owned process must disappear");
  }
});


test("state barrier bounds an unresolved asynchronous observation", async () => {
  let release, observer;
  const observation = new Promise(done => { release = done; });
  const pending = waitForToolState(() => observation, "unresolved readiness observation exceeded its bound", { timeoutMs: 50 })
    .then(() => ({ refused: false }), error => ({ refused: true, error }));
  try {
    const result = await Promise.race([pending, new Promise(done => { observer = setTimeout(() => done({ refused: false }), 1000); })]);
    assert.equal(result.refused, true, "an unresolved observation must fail at its setup bound");
    assert.equal(result.error.message, "unresolved readiness observation exceeded its bound");
  } finally { clearTimeout(observer); release(true); await pending; }
});

test("signal barrier refuses a missing acknowledgement and propagates preparation failure", async () => {
  let release, observer;
  const signal = new Promise(done => { release = done; });
  const pending = waitForToolSignal(signal, "missing work acknowledgement exceeded its bound", { timeoutMs: 50 })
    .then(() => ({ refused: false }), error => ({ refused: true, error }));
  try {
    const result = await Promise.race([pending, new Promise(done => { observer = setTimeout(() => done({ refused: false }), 1000); })]);
    assert.equal(result.refused, true, "a missing acknowledgement must fail at its setup bound");
    assert.equal(result.error.message, "missing work acknowledgement exceeded its bound");
    const error = new Error("recorded preparation refusal");
    await assert.rejects(waitForToolSignal(Promise.reject(error), "missing acknowledgement"), value => value === error);
  } finally { clearTimeout(observer); release(); await pending; }
});

test("readiness checks propagate spawn failure and refuse a signal-dead parent", async t => {
  const dir = await workspace(t), marker = join(dir, "missing.pid"), heartbeat = join(dir, "missing.ready");
  const script = await executable(dir, "process.stdin.resume();");
  await assert.rejects(readyTool(t, script, marker, heartbeat, { stdin: "pipe", startProcess: (_command, args, options) =>
    nodeSpawn(join(dir, "absent-node-tool"), args, options) }), { code: "ENOENT" },
    "the original real spawn error must reach the readiness caller");
  await assert.rejects(readyTool(t, script, marker, heartbeat, { stdin: "pipe", startProcess: (...args) => {
    const child = nodeSpawn(...args);
    child.once("spawn", () => child.kill("SIGKILL"));
    return child;
  } }), { message: "the fixture must stay alive until adapter handoff" },
  "a signal-dead parent must fail its liveness check before handoff");
});

test("readiness setup bound refuses missing publication and permits a fresh retry", async t => {
  const dir = await workspace(t), marker = join(dir, "pid"), heartbeat = join(dir, "ready"), release = join(dir, "release");
  const script = await executable(dir, `import { existsSync, writeFileSync } from "node:fs";
process.stdin.resume(); const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(release)})) return;
  writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  writeFileSync(${JSON.stringify(heartbeat)}, "ready"); clearInterval(timer);
}, 10);`);
  let elapsed = 0;
  const pending = readyTool(t, script, marker, heartbeat, { stdin: "pipe", clock: () => elapsed })
    .then(child => ({ child }), error => ({ error }));
  // A virtual monotonic clock crosses the independently specified 10s bound.
  // A separate observer releases the real fixture even when this guard is disabled.
  elapsed = 10_001;
  let result;
  try {
    result = await waitForToolSignal(pending, "the readiness bound did not refuse", { timeoutMs: 1_000 })
      .catch(() => ({}));
  } finally { await writeFile(release, "release"); await pending; }
  assert.equal(result.error?.message, "the tool must write its PID and heartbeat within the setup bound",
    "missing publication must fail the readiness setup bound");
  await cleanupToolProcesses(resources.get(t));
  await rm(marker, { force: true }); await rm(heartbeat, { force: true });
  const retry = await executable(dir, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, String(process.pid)); writeFileSync(${JSON.stringify(heartbeat)}, "ready"); process.stdin.resume();`);
  const child = await readyTool(t, retry, marker, heartbeat, { stdin: "pipe" });
  assert.equal(await readFile(marker, "utf8"), String(child.pid), "fresh readiness retry observes its own producer");
});

test("workspace removal refusal follows retirement of every live fixture writer", async t => {
  const dir = await workspace(t), marker = join(dir, "writer.pid"), heartbeat = join(dir, "writer.ready");
  const script = await executable(dir, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, String(process.pid)); writeFileSync(${JSON.stringify(heartbeat)}, "ready");
process.stdin.resume(); setInterval(() => writeFileSync(${JSON.stringify(join(dir, "writing"))}, "writing"), 1);`);
  const hooks = [], context = { after: hook => hooks.push(hook) };
  let liveAtRemoval, removalEntered = false;
  const child = await readyTool(context, script, marker, heartbeat, { stdin: "pipe" });
  const refusal = Object.assign(new Error("recorded workspace removal refusal"), { code: "ENOTEMPTY" });
  removeToolWorkspace(context, async () => {
    removalEntered = true;
    try { process.kill(child.pid, 0); liveAtRemoval = true; }
    catch (error) { if (error?.code !== "ESRCH") throw error; liveAtRemoval = false; }
    throw refusal;
  });
  try {
    await assert.rejects(hooks[0](), error => error === refusal);
    assert.equal(removalEntered, true, "removal refusal was reached");
    assert.equal(liveAtRemoval, false, "live fixture writer must be retired before workspace removal can refuse");
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/u, "removal failure cannot skip fixture retirement");
  } finally {
    // Independent safety cleanup also runs when retirement is deliberately disabled.
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    child.stdin.destroy(); await cleanupToolProcesses(resources.get(context));
  }
});

async function executable(dir, source) {
  const path = join(dir, `tool-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

const entry = (script, extra = {}) => ({
  id: "whisper_local",
  capability: "tool.whisper",
  executable: join(dirname(script), "node-tool"),
  arguments: [script, "{input:audio}", "{output:transcript}"],
  timeoutMs: 2_000,
  maxOutputBytes: 64 * 1024,
  envAllowlist: [],
  ...extra,
});

async function manifest(dir, adapters, maxConcurrent = 2, name = "tool-adapters.json") {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify({ schema: "control-room.local-tool-adapters/v1", maxConcurrent, adapters }), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function createToolRunner(registry, options = {}) {
  return connector.createLocalToolAdapterRunner(registry, { temporaryRoot: scratchRoot, ...options });
}

const input = (text = "audio bytes", name = "interview.wav") => ({ adapterId: "whisper_local",
  inputs: { audio: { name, contentBase64: Buffer.from(text).toString("base64") } } });

test("manifest validation refuses relative executables, shell syntax, and missing named placeholders", async t => {
  const dir = await workspace(t);
  const script = await executable(dir, "process.exit(0);\n");
  const rejects = async (name, candidate, pattern) => assert.rejects(
    connector.loadToolAdapters(await manifest(dir, [candidate], 1, name)), pattern);
  await rejects("relative.json", entry(script, { executable: "whisper" }), /executable must be an absolute path/u);
  await rejects("shell.json", entry(script, { arguments: [script, "{input:audio}", "--format;touch", "{output:transcript}"] }),
    /shell metacharacters/u);
  await rejects("partial.json", entry(script, { arguments: [script, "--input={input:audio}", "{output:transcript}"] }),
    /partial placeholder/u);
  await rejects("missing-input.json", entry(script, { arguments: [script, "fixed", "{output:transcript}"] }),
    /named input and output placeholders/u);
  await rejects("missing-output.json", entry(script, { arguments: [script, "{input:audio}", "fixed"] }),
    /named input and output placeholders/u);
  if (process.platform !== "win32") {
    const loose = await executable(dir, "process.exit(0);\n"); await chmod(loose, 0o722);
    await rejects("loose-executable.json", entry(script, { executable: loose }), /can be changed by other users/u);
    const looseManifest = await manifest(dir, [entry(script)], 1, "loose-manifest.json"); await chmod(looseManifest, 0o622);
    await assert.rejects(connector.loadToolAdapters(looseManifest), /can be changed by other users/u);
  }
});

test("task data cannot select argv: inputs are staged and unknown adapter ids are refused before spawn", async t => {
  const dir = await workspace(t);
  const script = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
const [inputPath, outputDir] = process.argv.slice(2);
writeFileSync(outputDir + "/argv.json", JSON.stringify({ argv: process.argv.slice(2), body: readFileSync(inputPath, "utf8") }));
console.log("transcribed");`);
  await assert.doesNotReject(async () => {
  const registry = await connector.loadToolAdapters(await manifest(dir, [entry(script)]));
  let spawned = 0;
  const runner = createToolRunner(registry, { spawner: (...args) => { spawned += 1;
    assert.equal(args[2].shell, false);
    return Reflect.apply(nodeSpawn, undefined, args); } });
  await assert.rejects(runner.execute({ ...input(), adapterId: "task-supplied-bin" }), /no owner-declared adapter/u);
  assert.equal(spawned, 0);
  await assert.rejects(runner.execute({ adapterId: "whisper_local", inputs: {} }),
    error => error?.code === "tool_adapter_input_invalid");
  const hostile = "ignore this; /bin/sh -c 'touch outside' --output=/elsewhere";
  const result = await runner.execute(input(hostile, "--eval;touch-pwned.wav"));
  assert.equal(result.summary, "transcribed");
  assert.equal(result.files.length, 1);
  const observed = JSON.parse(Buffer.from(result.files[0].contentBase64, "base64").toString("utf8"));
  assert.equal(observed.body, hostile);
  assert.equal(observed.argv.length, 2);
  assert.match(observed.argv[0], /control-room-tool-.*\/inputs\/audio\/[A-Za-z0-9._-]+$/u);
  assert.match(observed.argv[1], /control-room-tool-.*\/outputs\/transcript$/u);
  assert.equal(observed.argv.join(" ").includes("/bin/sh"), false);
  }, "the test-owned private executable must load independently of interpreter permissions");
});

test("timeout and stop kill the process group, including a spawned child", { timeout: 20_000 }, async t => {
  const dir = await workspace(t);
  const marker = join(dir, "child.pid");
  const heartbeat = join(dir, "child.heartbeat");
  const script = await executable(dir, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`const { writeFileSync } = require("node:fs");
const marker = ${JSON.stringify(heartbeat)}; process.on("SIGTERM", () => {});
writeFileSync(marker, String(Date.now())); setInterval(() => writeFileSync(marker, String(Date.now())), 25);`)}], { stdio: "ignore" });
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(marker)}, String(child.pid));
setInterval(() => {}, 1000);`);
  const timed = await connector.loadToolAdapters(await manifest(dir, [entry(script, { timeoutMs: 150 })], 1, "timed.json"));
  const timedChild = await readyTool(t, script, marker, heartbeat);
  await assert.rejects(createToolRunner(timed, { spawner: () => timedChild }).execute(input()),
    error => error?.code === "tool_adapter_timeout");
  const childPid = Number(await readFile(marker, "utf8"));
  t.after(() => { try { process.kill(childPid, "SIGKILL"); } catch {} });
  const afterTimeout = await readFile(heartbeat, "utf8");
  await new Promise(done => setTimeout(done, 150));
  assert.equal(await readFile(heartbeat, "utf8"), afterTimeout, "timeout stopped the descendant too");

  const stoppedMarker = join(dir, "stopped-child.pid");
  const stoppedHeartbeat = join(dir, "stopped-child.heartbeat");
  const stoppedScript = await executable(dir, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`const { writeFileSync } = require("node:fs");
const marker = ${JSON.stringify(stoppedHeartbeat)}; process.on("SIGTERM", () => {});
writeFileSync(marker, String(Date.now())); setInterval(() => writeFileSync(marker, String(Date.now())), 25);`)}], { stdio: "ignore" });
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(stoppedMarker)}, String(child.pid));
setInterval(() => {}, 1000);`);
  const stoppable = await connector.loadToolAdapters(await manifest(dir, [entry(stoppedScript, { timeoutMs: 10_000 })], 1, "stop.json"));
  const controller = new AbortController();
  const stoppedChild = await readyTool(t, stoppedScript, stoppedMarker, stoppedHeartbeat);
  let handedOff;
  const handoff = new Promise(done => { handedOff = done; });
  const pending = createToolRunner(stoppable, { spawner: () => {
    // This runs after the adapter installs its listeners in the same turn.
    queueMicrotask(handedOff);
    return stoppedChild;
  } }).execute(input(), controller.signal);
  await Promise.race([handoff, pending.then(() => assert.fail("the live tool must reach adapter handoff"))]);
  controller.abort();
  await assert.rejects(pending, error => error?.code === "tool_adapter_aborted");
  const stoppedPid = Number(await readFile(stoppedMarker, "utf8"));
  t.after(() => { try { process.kill(stoppedPid, "SIGKILL"); } catch {} });
  const afterStop = await readFile(stoppedHeartbeat, "utf8");
  await new Promise(done => setTimeout(done, 150));
  assert.equal(await readFile(stoppedHeartbeat, "utf8"), afterStop, "stop killed the descendant too");
});

test("oversize and secret-bearing output are refused, while a retry after process failure succeeds", async t => {
  const dir = await workspace(t);
  const oversized = await executable(dir, `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + "/large.txt", "x".repeat(2048));`);
  const oversizeRegistry = await connector.loadToolAdapters(await manifest(dir,
    [entry(oversized, { maxOutputBytes: 1024 })], 1, "oversize.json"));
  await assert.rejects(createToolRunner(oversizeRegistry).execute(input()),
    error => error?.code === "tool_adapter_output_too_large");

  const leaky = await executable(dir, `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + "/transcript.txt", "api_key=sk_test_1234567890abcdef");`);
  const leakRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(leaky)], 1, "leak.json"));
  await assert.rejects(createToolRunner(leakRegistry).execute(input()),
    error => error?.code === "tool_adapter_secret_refused");

  const retry = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
const body = readFileSync(process.argv[2], "utf8");
if (body === "fail") process.exit(2);
writeFileSync(process.argv[3] + "/ok.txt", body);`);
  const retryRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(retry)], 1, "retry.json"));
  const runner = createToolRunner(retryRegistry);
  await assert.rejects(runner.execute(input("fail")), error => error?.code === "tool_adapter_failed");
  const result = await runner.execute(input("retry worked"));
  assert.equal(Buffer.from(result.files[0].contentBase64, "base64").toString(), "retry worked");

  const scoped = await executable(dir, `import { dirname } from "node:path";
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + "/inside.txt", "inside");
writeFileSync(dirname(process.argv[3]) + "/outside.txt", "outside");`);
  const scopedRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(scoped)], 1, "scoped.json"));
  const scopedResult = await createToolRunner(scopedRegistry).execute(input());
  assert.deepEqual(scopedResult.files.map(file => file.name), ["transcript__inside.txt"]);
});

test("a tool claim submits only scanned collected files; an unknown adapter is handed back", async t => {
  const dir = await workspace(t);
  const script = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + "/transcript.txt", readFileSync(process.argv[2]));
console.log("Whisper finished.");`);
  const registry = await connector.loadToolAdapters(await manifest(dir, [entry(script)], 1, "claim.json"));
  const calls = [];
  const client = {
    progress: async (...args) => { calls.push(["progress", ...args]); return {}; },
    result: async (...args) => { calls.push(["result", ...args]);
      if (calls.filter(call => call[0] === "result").length < 3) throw Object.assign(new Error("dropped"), { code: "unavailable" });
      return { resultId: "fleet-result:test" }; },
    blocker: async (...args) => { calls.push(["blocker", ...args]); return {}; },
  };
  const claim = { claimId: `fleet-claim:${"a".repeat(32)}`, jobId: "job:tool", ...input("hello") };
  const completed = await connector.runClaimedToolTask({ client, claim,
    runner: createToolRunner(registry) });
  assert.equal(completed.outcome, "submitted");
  assert.equal(calls.filter(call => call[0] === "result").length, 3, "a dropped upload is retried with the same payload");
  const upload = calls.find(call => call[0] === "result");
  assert.equal(upload[2], "Whisper finished.");
  assert.equal(Buffer.from(upload[3][0].contentBase64, "base64").toString(), "hello");

  calls.length = 0;
  client.result = async (...args) => { calls.push(["result", ...args]); return { resultId: "fleet-result:test" }; };
  const refused = await connector.runClaimedToolTask({ client, claim: { ...claim, adapterId: "unknown_tool" },
    runner: createToolRunner(registry) });
  assert.equal(refused.outcome, "blocked");
  assert.equal(calls.some(call => call[0] === "result"), false);
  assert.equal(calls.find(call => call[0] === "blocker")[4], true, "the refused claim is released");
});

test("tool output drains after exit before summary and refusal checks", { timeout: 10_000 }, async t => {
  const dir = await workspace(t);
  const script = await executable(dir, "process.exit(0)");
  const registry = await connector.loadToolAdapters(await manifest(dir,
    [entry(script, { maxOutputBytes: 1024 })], 1, "drain.json"));
  for (const [stream, output, refusal] of [
    ["stdout", "Whisper finished.", null],
    ["stdout", "x".repeat(2048), "tool_adapter_output_too_large"],
    ["stdout", "fixture-output-marker", "tool_adapter_secret_refused"],
    ["stderr", "fixture-output-marker", "tool_adapter_secret_refused"],
  ]) {
    let exited;
    const exitSeen = new Promise(done => { exited = done; });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let destroyed = false;
    child.stdout.destroy = child.stderr.destroy = () => { destroyed = true; };
    const runner = createToolRunner(registry, {
      secrets: ["fixture-output-marker"], killProcess() {},
      spawner: () => {
        queueMicrotask(() => { child.emit("exit", 0, null); exited(); });
        return child;
      },
    });
    let settled = false;
    const controller = new AbortController();
    const pending = runner.execute(input(), controller.signal);
    const observed = pending.then(value => { settled = true; return { value }; },
      error => { settled = true; return { error }; });
    await exitSeen;
    // Let the exit handler's promise callbacks run, while the pipes stay open.
    await new Promise(done => setImmediate(done));
    assert.equal(settled, false, "exit alone must not complete the tool run");
    assert.equal(destroyed, false, "stdout and stderr must remain readable until close");
    child[stream].emit("data", Buffer.from(output));
    child.emit("close", 0, null);
    // Once the pipes close, cancellation of later work cannot change this result.
    await new Promise(done => setImmediate(done));
    controller.abort();
    const result = await observed;
    if (refusal) assert.equal(result.error?.code, refusal);
    else { assert.equal(result.error, undefined); assert.equal(result.value.summary, "Whisper finished."); }
    assert.equal(runner.active, 0);
  }
});

test("stress: 20 parallel tool runs never exceed the per-machine cap", { timeout: 30_000 }, async t => {
  const dir = await workspace(t);
  const script = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
await new Promise(done => setTimeout(done, 100));
writeFileSync(process.argv[3] + "/result.txt", readFileSync(process.argv[2]));`);
  const registry = await connector.loadToolAdapters(await manifest(dir, [entry(script, { timeoutMs: 5_000 })], 3));
  let peak = 0;
  const runner = await prepareRunner(t, registry, { count: 20, temporaryRoot: dir,
    onLaunch: () => { peak = Math.max(peak, runner.active); },
  });
  const pending = Array.from({ length: 20 }, (_, index) => runner.execute(input(`run-${index}`)));
  let results;
  try { results = await Promise.all(pending); }
  finally { await Promise.allSettled(pending); }
  assert.equal(peak, 3, "observable admissions must reach the independently declared cap three");
  assert.equal(runner.active, 0);
  assert.equal(results.length, 20);
  for (const [index, result] of results.entries()) assert.equal(
    Buffer.from(result.files[0].contentBase64, "base64").toString(), `run-${index}`,
    "every admitted caller returns its own staged input through the real reader");
});

test("overflow terminates once, an escaped pipe holder is bounded, and same-group children die", { timeout: 20_000 }, async t => {
  const dir = await workspace(t);
  const overflow = await executable(dir, "process.exit(0)");
  const kills = [];
  const overflowRunner = createToolRunner(await connector.loadToolAdapters(await manifest(dir,
    [entry(overflow, { maxOutputBytes: 1024, timeoutMs: 1_000 })], 1, "overflow.json")), { spawner: () => {
      const child = new EventEmitter(); child.pid = 43210; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.destroy = () => {}; child.stderr.destroy = () => {};
      queueMicrotask(() => { child.stdout.emit("data", Buffer.alloc(4096)); child.stdout.emit("data", Buffer.alloc(4096));
        child.stdout.emit("data", Buffer.alloc(4096)); child.emit("exit", 0, null); });
      return child;
    }, killProcess: (child, signal = "SIGTERM") => {
      kills.push(signal); try { child.kill(signal); } catch {} } });
  await assert.rejects(overflowRunner.execute(input()), error => error?.code === "tool_adapter_output_too_large");
  assert.equal(kills.filter(signal => signal === "SIGTERM").length, 1, "overflow has one termination attempt");

  const escapedPid = join(dir, "escaped.pid");
  const escapedReady = join(dir, "escaped.ready");
  const escaped = await executable(dir, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(escapedReady)}, "ready");
process.stdin.on("data", () => {
  process.stdout.write("held"); process.stderr.write("held");
});
process.stdin.once("end", () => process.exit(0));`)}], { detached: true, stdio: [3, "inherit", "inherit"] });
writeFileSync(${JSON.stringify(escapedPid)}, String(child.pid));
process.stdin.resume(); process.stdin.once("end", () => process.exit(0));`);
  const escapedRegistry = await connector.loadToolAdapters(await manifest(dir,
    [entry(escaped, { timeoutMs: 1_500 })], 1, "escaped.json"));
  try {
    const escapedChild = await readyTool(t, escaped, escapedPid, escapedReady, { stdin: "pipe", control: true });
    let controlError;
    // Record transport errors as test data, so teardown can report a named
    // assertion rather than a late uncaught socket error.
    escapedChild.stdio[3].on("error", error => { controlError = error; });
    const exit = await exitedTool(escapedChild);
    assert.deepEqual(exit, [0, null], "the real escaped-pipe parent exits successfully before handoff");
    // Read fresh bytes after the parent exits: paused streams can report
    // readableEnded=false even after EOF, so that property alone proves nothing.
    async function heldPipe(stream) {
      let timer, data, end;
      try {
        return await new Promise(resolve => {
          data = () => resolve(true);
          end = () => resolve(false);
          stream.once("data", data); stream.once("end", end);
          timer = setTimeout(() => resolve(false), 10_000);
          stream.resume();
        });
      } finally {
        clearTimeout(timer);
        stream.off("data", data); stream.off("end", end);
        stream.pause();
      }
    }
    const heldReply = Promise.all([heldPipe(escapedChild.stdout), heldPipe(escapedChild.stderr)]);
    escapedChild.stdio[3].write("probe");
    const held = await heldReply;
    assert.equal(held[0], true, "the real escaped stdout pipe produces bytes after parent exit at handoff");
    assert.equal(held[1], true, "the real escaped stderr pipe produces bytes after parent exit at handoff");
    // Observe only product timers through settlement, including scheduled
    // post-drain work. Pipes and filesystem operations stay real; observation
    // latency and CPU stalls do not consume the independent declared budget.
    const declaredDrainMs = 250;
    let registeringDrain = false, elapsed = 0, started, handoff;
    const drainTimers = new Set(), productTimers = new Set();
    const performance = { now: () => elapsed };
    const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
    const timeoutMock = t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
      if (!registeringDrain && !inToolTimerScope()) return realSetTimeout(callback, delay, ...args);
      const timer = { at: elapsed + delay, callback: () => withToolTimerScope(() => callback(...args)) };
      productTimers.add(timer);
      if (registeringDrain) drainTimers.add(timer);
      return timer;
    });
    const clearMock = t.mock.method(globalThis, "clearTimeout", timer => {
      drainTimers.delete(timer);
      if (!productTimers.delete(timer)) realClearTimeout(timer);
    });
    const handedOff = new Promise(done => { handoff = done; });
    const advanceDrain = ms => {
      elapsed += ms;
      for (const timer of productTimers) if (timer.at <= elapsed) {
        productTimers.delete(timer); drainTimers.delete(timer); timer.callback();
      }
    };
    const pipesClosed = Promise.all([escapedChild.stdout, escapedChild.stderr, escapedChild.stdio[3]].map(stream =>
      new Promise(done => stream.once("close", done))));
    let productSettled = false;
    const pending = withToolTimerScope(() => createToolRunner(escapedRegistry, { spawner: () => {
      assert.equal(escapedChild.exitCode, 0, "drain clock starts only after a real parent exit");
      // Preserve the base execute guard's origin at adapter handoff, including
      // time the product takes to attach its listeners after the spawner returns.
      started = performance.now();
      // Replay the recorded exit; the holder keeps the real pipes open until
      // the test explicitly releases its attached control pipe below.
      queueMicrotask(() => {
        registeringDrain = true;
        try { escapedChild.emit("exit", ...exit); }
        finally { registeringDrain = false; handoff(); }
      });
      return escapedChild;
    } }).execute(input())).then(value => ({ value }), error => ({ error }))
      .then(result => { productSettled = true; return result; });
    let handoffError;
    try {
      await waitForToolSignal(Promise.race([handedOff, pending.then(result => {
        throw result.error ?? new Error("execute settled before drain handoff");
      })]), "the recorded parent exit must reach the drain listener");
      assert.equal(drainTimers.size, 1, "the real exit listener must declare one drain deadline");
      advanceDrain(declaredDrainMs - 1);
      await new Promise(done => setImmediate(done));
      assert.equal(escapedChild.stdout.destroyed || escapedChild.stderr.destroyed, false,
        "the product must preserve both held pipes before the declared drain deadline");
      advanceDrain(1);
      await new Promise(done => setImmediate(done));
      assert.equal(escapedChild.stdout.destroyed, true,
        "escaped stdout must close at the independently declared 250ms drain bound");
      assert.equal(escapedChild.stderr.destroyed, true,
        "escaped stderr must close at the independently declared 250ms drain bound");
      // Let the resolved drain reach its finally and clear the hard deadline.
      await new Promise(done => setImmediate(done));
      while (!productSettled) {
        await waitForToolState(() => productSettled || productTimers.size > 0,
          "the product must settle or declare its remaining scheduled delay");
        if (productSettled) break;
        const next = Math.min(...[...productTimers].map(timer => timer.at));
        advanceDrain(Math.max(0, next - elapsed));
        await new Promise(done => setImmediate(done));
      }
      const result = await pending;
      assert.equal(result.error?.code, "tool_adapter_failed", "unclosed pipes cannot submit truncated output");
      assert.ok(performance.now() - started < 700, "an escaped stdout holder cannot wedge execute");
    } catch (error) { handoffError = error; throw error; }
    finally {
      // Also release a live parent when a broken exit barrier is refused.
      // Preserve the first assertion if later pipe cleanup fails too.
      escapedChild.stdin.end();
      // Release controls natural EOF. It never races a fixture lifetime timer.
      escapedChild.stdio[3].end();
      // Close our unused read half before group retirement. Otherwise a
      // holder exiting with unread control bytes can reset the duplex socket.
      escapedChild.stdio[3].destroy();
      advanceDrain(20_000);
      timeoutMock.mock.restore(); clearMock.mock.restore();
      await pending;
      try {
        await waitForToolSignal(pipesClosed, "both real inherited pipes must close after controlled release");
        assert.equal(controlError, undefined, "controlled holder release must not leave a transport error");
      } catch (error) { if (!handoffError) throw error; }
    }

  } finally {
    try {
      const pid = Number(await readFile(escapedPid, "utf8"));
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) { if (error?.code !== "EPERM") throw error; process.kill(pid, "SIGKILL"); }
    }
    catch (error) { if (!["ENOENT", "ESRCH"].includes(error?.code)) throw error; }
  }

  const groupedPid = join(dir, "grouped.pid"), groupedReady = join(dir, "grouped.ready");
  const grouped = await executable(dir, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(groupedReady)}, "ready"); setInterval(() => {}, 1000);`)}], { stdio: ["pipe", "ignore", "ignore"] });
writeFileSync(${JSON.stringify(groupedPid)}, String(child.pid));
process.stdin.resume(); process.stdin.once("end", () => process.exit(0));`);
  const groupedRegistry = await connector.loadToolAdapters(await manifest(dir,
    [entry(grouped, { timeoutMs: 1_000 })], 1, "grouped.json"));
  const groupedChild = await readyTool(t, grouped, groupedPid, groupedReady, { stdin: "pipe" });
  const groupedClosed = new Promise(done => groupedChild.once("close", (code, signal) => done([code, signal])));
  const groupedExit = await exitedTool(groupedChild);
  const groupedClose = await waitForToolSignal(groupedClosed, "the same-group pipes must close within the setup bound");
  assert.deepEqual(groupedExit, [0, null], "the real same-group parent exits successfully before handoff");
  const pid = Number(await readFile(groupedPid, "utf8"));
  assert.doesNotThrow(() => process.kill(pid, 0), "the real same-group descendant is alive before product termination");
  await assert.doesNotReject(createToolRunner(groupedRegistry, { spawner: () => {
    assert.equal(groupedChild.exitCode, 0, "same-group clock starts only after a real parent exit");
    queueMicrotask(() => { groupedChild.emit("exit", ...groupedExit); groupedChild.emit("close", ...groupedClose); });
    return groupedChild;
  } }).execute(input()), "an observed same-group exit and close must succeed");
  await waitForProcessGone(pid, "same-group child is gone after group termination");
});

test("rechecks executable identity, refuses output hard links, and cleanup failure still releases the slot", async t => {
  const dir = await workspace(t);
  const original = await executable(dir, "process.exit(0)");
  const registry = await connector.loadToolAdapters(await manifest(dir, [entry(original, { executable: original })], 1, "recheck.json"));
  const replacement = await executable(dir, "process.exit(0)");
  await rename(replacement, original);
  await assert.rejects(createToolRunner(registry).execute(input()), error => error?.code === "tool_adapter_executable_changed");

  const source = join(dir, "private.txt"); await writeFile(source, "ordinary private text");
  const hardlink = await executable(dir, `import { linkSync } from "node:fs"; linkSync(${JSON.stringify(source)}, process.argv[3] + "/linked.txt");`);
  await assert.rejects(createToolRunner(await connector.loadToolAdapters(await manifest(dir,
    [entry(hardlink)], 1, "links.json"))).execute(input()), error => error?.code === "tool_adapter_output_invalid");

  const cleanup = await executable(dir, "process.exit(0)");
  const cleanRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(cleanup)], 1, "cleanup.json"));
  const runner = createToolRunner(cleanRegistry, { removeWork: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
  await runner.execute(input());
  assert.equal(runner.active, 0, "cleanup trouble does not retain a concurrency slot");

  const locked = await executable(dir, `import { chmodSync, mkdirSync } from "node:fs";
mkdirSync(process.argv[3] + "/locked"); chmodSync(process.argv[3] + "/locked", 0);`);
  const lockedRunner = createToolRunner(await connector.loadToolAdapters(await manifest(dir,
    [entry(locked)], 1, "locked.json")), { temporaryRoot: dir });
  await assert.rejects(lockedRunner.execute(input()), /EACCES/u);
  assert.equal((await readdir(dir)).some(name => name.startsWith("control-room-tool-")), false,
    "cleanup restores user access before removing a tool-owned locked directory");
});

test("stress: 50 runs cap at four with one third aborted", { timeout: 30_000 }, async t => {
  const dir = await workspace(t);
  const script = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
await new Promise(done => setTimeout(done, 80)); writeFileSync(process.argv[3] + "/ok.txt", readFileSync(process.argv[2]));`);
  let started = 0, fourStarted, peak = 0, removedWork = 0;
  const executing = new Promise(done => { fourStarted = done; });
  const runner = await prepareRunner(t, await connector.loadToolAdapters(await manifest(dir,
    [entry(script, { timeoutMs: 2_000 })], 4, "stress-50.json")), { count: 50, temporaryRoot: dir,
    removeWork: async (...args) => { removedWork += 1; await rm(...args); },
    onLaunch: () => {
      peak = Math.max(peak, runner.active);
      if (++started === 4) fourStarted();
    },
  });
  const controllers = Array.from({ length: 50 }, () => new AbortController());
  const pending = controllers.map((controller, i) => runner.execute(input(`run-${i}`), controller.signal));
  let settled;
  try {
    await Promise.race([executing, Promise.allSettled(pending).then(() => {
      throw new Error("tool burst settled before four processes started");
    })]);
    controllers.filter((_, i) => i % 3 === 0).forEach(controller => controller.abort());
    settled = await Promise.allSettled(pending);
  } finally {
    controllers.forEach(controller => controller.abort());
    await Promise.allSettled(pending);
  }
  assert.equal(peak, 4, "observable admissions must reach the independently declared cap four");
  assert.equal(runner.active, 0);
  assert.equal(removedWork, 35, "queued aborts must refuse before creating product work or consuming a slot");
  const refused = settled.filter(result => result.status === "rejected");
  assert.equal(refused.length, 17, "exactly the independently selected running and queued callers abort");
  for (const result of refused) assert.equal(result.reason.code, "tool_adapter_aborted",
    "queued cancellation cannot turn into timeout or an unrelated refusal");
});

test("enrollment and heartbeat advertise manifest capabilities as evidence without changing approved capabilities", async t => {
  const dir = await workspace(t);
  const configPath = join(dir, "connector.json");
  const script = await executable(dir, "process.exit(0);\n");
  await manifest(dir, [entry(script), { ...entry(script), id: "gpu_script", capability: "gpu.metal" }]);
  const requests = [];
  const workerId = `fleet-worker:${"a".repeat(32)}`;
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const releaseTrust = Object.freeze({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1,
    keyId: releaseKeyIdV1(publicKey), publicKey, versionFloor: connector.CONNECTOR_VERSION, revokedKeyIds: [] });
  const connectorBytes = await readFile(join(process.cwd(), "scripts/fleet/connector.mjs"));
  const unsignedRelease = { version: connector.CONNECTOR_VERSION, file: `connector-${connector.CONNECTOR_VERSION}.mjs`,
    size: connectorBytes.length, sha256: createHash("sha256").update(connectorBytes).digest("hex"),
    builtFrom: "a".repeat(40), minVersion: connector.CONNECTOR_VERSION };
  const release = Object.freeze({ ...unsignedRelease,
    signature: sign(null, connectorReleaseSignatureMaterialV1(unsignedRelease), keys.privateKey).toString("base64url") });
  const fetcher = async (url, init = {}) => {
    if (new URL(url).pathname === "/fleet/v1/connector-manifest.json") return new Response("missing", { status: 404 });
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) return Response.json({ ok: true, result: { workerId, displayName: "Tools", projectIds: ["project:one"],
      capabilities: ["owner.approved"], workerKind: "tool", workingAgreement: WORKING_AGREEMENT,
      credentialExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), releaseTrust, connector: release } });
    return Response.json({ ok: true, result: { workerId, displayName: "Tools", workerKind: "tool", capabilities: ["owner.approved"], workingAgreement: WORKING_AGREEMENT } });
  };
  const code = `crj_${"A".repeat(43)}`;
  const joined = await connector.join({ server: "https://control.example", code, workerKind: "tool", configPath, fetcher });
  assert.deepEqual(joined.capabilities, ["owner.approved"]);
  assert.deepEqual(requests[0].adapterCapabilities, ["gpu.metal", "tool.whisper"]);
  const client = connector.createClient(await connector.loadConfig(configPath), fetcher);
  const registry = await connector.loadToolAdapters(connector.defaultToolAdaptersPath(configPath));
  await client.heartbeat(registry.capabilities);
  assert.deepEqual(requests[1].adapterCapabilities, ["gpu.metal", "tool.whisper"]);
});

test("tool cancellation during staging and spawn is never lost", async t => {
  const dir = await workspace(t), script = await executable(dir, 'console.log("inert fixture");');
  const registry = await connector.loadToolAdapters(await manifest(dir, [entry(script, { envAllowlist: ["QA_STOP"] })]));
  await t.test("staging", async () => {
    const staged = new AbortController(); let spawned = 0;
    const environment = { get QA_STOP() { staged.abort(); return "fixture"; } };
    const stagedRunner = createToolRunner(registry, { environment,
      spawner: () => { spawned++; throw new Error("stopped staging must not spawn"); } });
    await assert.rejects(stagedRunner.execute(input(), staged.signal), e => e.code === "tool_adapter_aborted");
    assert.equal(spawned, 0); assert.equal(stagedRunner.active, 0);
  });
  await t.test("spawn", async () => {
    const duringSpawn = new AbortController();
    const spawnedRunner = createToolRunner(registry, { environment: {}, spawner: (...args) => {
      duringSpawn.abort(); return nodeSpawn(...args);
    } });
    await assert.rejects(spawnedRunner.execute(input(), duringSpawn.signal), e => e.code === "tool_adapter_aborted");
    assert.equal(spawnedRunner.active, 0);
  });
});

function prepareRunner(t, registry, options = {}) {
  return preparedToolRunner(t, registry, { track: trackToolProcess, wait: waitForToolSignal,
    retire: context => cleanupToolProcesses(resources.get(context)), ...options });
}

test("E078: artificial releases precede the product deadline", { timeout: 20_000 }, async t => {
  for (const holdMs of [0, 100, 2200]) {
    const dir = await workspace(t);
    const script = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + "/literal.txt", readFileSync(process.argv[2])); console.log("prepared result");`);
    const registry = await connector.loadToolAdapters(await manifest(dir, [entry(script)]));
    const phases = [];
    const original = globalThis.setTimeout;
    const timerMock = t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
      if (delay === 2000) phases.push("product deadline");
      return original(callback, delay, ...args);
    });
    let runner, outcome;
    try {
      runner = await prepareRunner(t, registry, {
        temporaryRoot: dir,
        prepare: async () => {
          phases.push("preparation starts");
          if (holdMs) await new Promise(done => setTimeout(done, holdMs));
          phases.push("preparation finished");
        },
        onPhase: phase => phases.push(phase),
      });
      assert.equal(phases.at(-1), "released", "preparation returns only after the real release acknowledgement");
      assert.equal((await readdir(dir)).some(name => name.startsWith("control-room-tool-")), false,
        "setup must leave product work and staged output absent");
      outcome = await runner.execute(input("independent literal")).then(value => ({ value }), error => ({ error }));
    } finally { timerMock.mock.restore(); }
    assert.deepEqual(phases, ["initialized", "probed", "preparation starts", "preparation finished", "released", "product deadline"],
      "latest artificial release must precede the product deadline");
    assert.equal(outcome.error, undefined, "prepared work must retain the unchanged production budget");
    const result = outcome.value;
    assert.equal(result.summary, "prepared result");
    assert.equal(Buffer.from(result.files[0].contentBase64, "base64").toString(), "independent literal",
      "real staging and the real reader preserve the independently supplied literal");
    assert.equal(runner.active, 0);
  }
});

test("E078: prepared launch preserves production fields and output", { timeout: 20_000 }, async t => {
  const dir = await workspace(t);
  const script = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + "/observed.json", JSON.stringify({ argv: process.argv.slice(1),
 cwd: process.cwd(), executable: process.execPath, env: process.env, input: readFileSync(process.argv[2], "utf8") }));
process.stdout.write("literal stdout"); process.stderr.write("literal stderr");`);
  const registry = await connector.loadToolAdapters(await manifest(dir,
    [entry(script, { envAllowlist: ["E078_ALLOWED"] })]));
  let launch, stderr = "";
  const runner = await prepareRunner(t, registry, { temporaryRoot: dir,
    environment: { E078_ALLOWED: "ordinary value", E078_EXCLUDED: "excluded value" },
    onLaunch: (executable, argv, options, child) => {
      launch = { executable, argv, options };
      child.stderr.on("data", bytes => { stderr += bytes; });
    },
  });
  const result = await runner.execute(input("independent literal"));
  assert.equal(launch?.executable, join(dir, "node-tool"), "the prepared seam forwards the declared executable");
  assert.equal(launch.options.shell, false, "the real launch retains shell=false");
  assert.equal(result.summary, "literal stdout");
  assert.equal(stderr, "literal stderr", "the prepared launch retains its real stderr pipe");
  const observed = JSON.parse(Buffer.from(result.files[0].contentBase64, "base64"));
  assert.equal(observed.executable, join(dir, "node-tool"), "the real worker is the declared private executable");
  assert.deepEqual(observed.env, { E078_ALLOWED: "ordinary value" }, "only the independently declared environment is forwarded");
  assert.match(observed.cwd, /\/control-room-tool-[^/]+$/u);
  assert.deepEqual(observed.argv, [script, join(observed.cwd, "inputs", "audio", "interview.wav"),
    join(observed.cwd, "outputs", "transcript")], "exact product argv and cwd reach the real script");
  assert.equal(observed.input, "independent literal");

  const refusal = new assert.AssertionError({ message: "preparation stopped halfway" });
  await assert.rejects(prepareRunner(t, registry, { prepare: () => { throw refusal; } }),
    error => error === refusal, "preparation refusal survives retirement");
  await assert.rejects(prepareRunner(t, registry, { startProcess: (_executable, argv, options) =>
    nodeSpawn(join(dir, "missing-tool"), argv, options) }), { code: "ENOENT" }, "original spawn error is preserved");
  await assert.rejects(prepareRunner(t, registry, {
    startProcess: (...args) => { const child = nodeSpawn(...args); child.once("spawn", () => child.kill("SIGKILL")); return child; },
  }), /a prepared tool must stay alive before launch/u, "signal death refuses preparation");
  // A dropped acknowledgement must refuse, then a fresh preparation can retry.
  await assert.rejects(prepareRunner(t, registry, {
    wait: (signal, message) => waitForToolSignal(signal, message, { timeoutMs: 500 }),
    startProcess: (...args) => { const child = nodeSpawn(...args), send = child.send.bind(child);
      child.send = (message, ...rest) => message === "release" ? true : send(message, ...rest); return child; },
  }), /acknowledge released/u, "missing release acknowledgement must refuse before admission");
  const dropped = await prepareRunner(t, registry, { prepare: child => {
    child.send("disconnect"); return trackToolProcess(t, child);
  } }).then(value => ({ value }), error => ({ error }));
  assert.ok(dropped.error, "dropped IPC must refuse preparation");
  let retiringChild;
  const deadRunner = await prepareRunner(t, registry, { temporaryRoot: dir,
    onPhase: (_phase, child) => { retiringChild = child; },
  });
  await retireToolProcess({ child: retiringChild, closed: trackToolProcess(t, retiringChild) }, { wait: waitForToolSignal });
  await assert.rejects(deadRunner.execute(input("independent literal")), /a prepared launch requires a live connected child/u,
    "a dead prepared child must refuse at the real launch seam");
  const retry = await prepareRunner(t, registry, { temporaryRoot: dir,
    environment: { E078_ALLOWED: "ordinary value" } });
  assert.equal((await retry.execute(input("independent literal"))).summary, "literal stdout", "fresh preparation retries successfully");
});

test("E078: zombie cleanup preserves the primary assertion and refuses live EPERM", { timeout: 20_000 }, async t => {
  const dir = await workspace(t), marker = join(dir, "zombie.pid"), heartbeat = join(dir, "zombie.ready");
  const script = await executable(dir, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, String(process.pid)); writeFileSync(${JSON.stringify(heartbeat)}, "ready"); process.stdin.resume();`);
  const child = await readyTool(t, script, marker, heartbeat, { stdin: "pipe" });
  const closed = trackToolProcess(t, child);
  assert.equal(closed, trackToolProcess(t, child), "owned child retirement must reuse the original close observation");
  const eperm = Object.assign(new Error("independently injected live EPERM"), { code: "EPERM" });
  await assert.rejects(retireToolProcess({ child, closed }, { kill: () => { throw eperm; }, wait: () => assert.fail("live EPERM must refuse without reaping a live group") }),
    error => error === eperm, "live EPERM must remain a refusal");
  await assert.rejects(retireToolProcess({ child: { pid: child.pid }, closed }, {
    kill: () => { throw eperm; }, wait: () => assert.fail("unknown EPERM must refuse without assuming death"),
  }), error => error === eperm, "unknown EPERM must remain a refusal");
  const exited = new Promise(done => child.once("exit", done));
  child.stdin.end(); await exited;
  let reaped = false, deadDisappearanceChecked = false;
  await assert.doesNotReject(() => retireToolProcess({ child, closed }, { kill: (_pid, signal) => {
    if (signal === "SIGKILL") throw eperm;
    assert.equal(reaped, true, "dead EPERM requires close/reaping before disappearance");
    deadDisappearanceChecked = true;
    throw Object.assign(new Error("observed disappearance"), { code: "ESRCH" });
  }, wait: async promise => { await waitForToolSignal(promise, "real dead child must close"); reaped = true; } }), "known-dead EPERM must reap then disappear");
  assert.equal(reaped, true, "dead EPERM must wait for the real child's close");
  assert.equal(deadDisappearanceChecked, true, "dead EPERM must verify disappearance after reaping");
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/u, "the real child is absent after retirement");
  let disappearanceChecks = 0;
  await retireToolProcess({ child, closed }, { kill: (_pid, signal) => {
    if (signal === "SIGKILL") return;
    disappearanceChecks += 1;
    if (disappearanceChecks === 3) throw Object.assign(new Error("observed final group disappearance"), { code: "ESRCH" });
  }, wait: waitForToolSignal });
  assert.equal(disappearanceChecks, 3, "group retirement must observe disappearance after close");
  // A real unreaped child checks OS semantics; injected refusals above then
  // exercise the cleanup branches independently of whether Darwin returns EPERM.
  const zombie = nodeSpawn("python3", ["-c", `import os, sys, time, signal, json
pid=os.fork()
if pid == 0:
 os.setpgid(0,0); os._exit(0)
try:
 # Observe actual waitable death without reaping it.
 os.waitid(os.P_PID,pid,os.WEXITED | os.WNOWAIT)
 error=None
 try: os.kill(-pid, signal.SIGKILL)
 except OSError as exc: error=exc.errno
 print(json.dumps({"unreaped":True,"errno":error}),flush=True)
 sys.stdin.readline()
finally:
 os.waitpid(pid,0)
 try: os.kill(-pid,0); gone=False
 except ProcessLookupError: gone=True
 print(json.dumps({"reaped":True,"gone":gone}),flush=True)
`], { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const zombieClosed = trackToolProcess(t, zombie);
  let output = "", firstLine;
  const zombieReady = new Promise(done => { firstLine = done; });
  zombie.stdout.on("data", bytes => { output += bytes; if (output.includes("\n")) firstLine(); });
  zombie.stderr.resume();
  try {
    await waitForToolSignal(zombieReady, "real zombie must reach observed unreaped death");
    const real = JSON.parse(output.split("\n")[0]);
    assert.equal(real.unreaped, true, "OS probe observes actual zombie death");
    assert.ok(real.errno === null || real.errno === 1, "owned zombie kill is success or Darwin EPERM");
  } finally { zombie.stdin.end("reap\n"); await waitForToolSignal(zombieClosed, "real zombie probe must reap and close"); }
  assert.deepEqual(JSON.parse(output.trim().split("\n")[1]), { reaped: true, gone: true },
    "real zombie group must disappear after reaping");
  const hooks = [], context = { after: hook => hooks.push(hook) };
  await rm(marker, { force: true }); await rm(heartbeat, { force: true });
  const writer = await readyTool(context, script, marker, heartbeat, { stdin: "pipe" });
  let removed = false;
  removeToolWorkspace(context, async () => { removed = true; });
  const realKill = process.kill.bind(process);
  const killMock = t.mock.method(process, "kill", (pid, signal) => {
    if (pid === -writer.pid && signal === "SIGKILL") throw eperm;
    return realKill(pid, signal);
  });
  try {
    await assert.rejects(hooks[0](), error => error === eperm, "live cleanup permission refusal must remain primary");
    assert.equal(removed, false, "a live retirement refusal must retain its workspace");
    assert.equal(resources.get(context).children.length, 1, "failed live retirement must remain owned for retry");
    assert.doesNotThrow(() => realKill(writer.pid, 0), "the refused writer is independently observed still alive");
  } finally {
    killMock.mock.restore();
    await retireToolProcess({ child: writer, closed: observedCloses.get(writer) }, { wait: waitForToolSignal });
    await hooks[0]();
  }
  assert.equal(removed, true, "cleanup retries removal only after actual retirement");
  const primary = new assert.AssertionError({ message: "independent primary body assertion" });
  const teardown = Object.assign(new Error("independent teardown refusal"), { code: "ENOTEMPTY" });
  await assert.rejects(preserveToolFailure(async () => { throw primary; }, async () => { throw teardown; }),
    error => error === primary, "teardown failure must preserve the primary body assertion");
  await assert.rejects(preserveToolFailure(async () => "body succeeded", async () => { throw teardown; }),
    error => error === teardown, "successful bodies must still report cleanup refusal");
});
