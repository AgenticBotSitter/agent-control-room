import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createPrivateNodeTool } from "./support/private-node-tool.mjs";
import { preparedToolRunner, waitForToolSignal, waitForToolState, waitForProcessGone,
  trackToolProcess, removeToolWorkspace, cleanupToolResources } from "./support/prepared-tool-runner.mjs";
import test from "node:test";
import * as connector from "../scripts/fleet/connector.mjs";
import { RELEASE_TRUST_SCHEMA_V1, connectorReleaseSignatureMaterialV1,
  releaseKeyIdV1 } from "../scripts/release-signing.mjs";

/** The gateway ships the agreement metadata; a fake that omits it is refused. */
const WORKING_AGREEMENT = Object.freeze({ version: connector.WORKING_AGREEMENT.version,
  digest: connector.WORKING_AGREEMENT.digest, startsWork: false, grantsAuthority: false });

let privateToolDirectory, privateTool;
test.after(async () => {
  if (privateToolDirectory) await rm(privateToolDirectory, { recursive: true, force: true });
});

async function workspaceNodeTool(dir) {
  privateTool ??= (async () => {
    privateToolDirectory = await mkdtemp(join(tmpdir(), "fleet-tool-runtime-"));
    return createPrivateNodeTool(privateToolDirectory);
  })();
  const path = join(dir, "node-tool");
  // Workspaces have private names and directories, but share one immutable copy.
  // Never link the installed executable: its owner/mode may be unsafe for tools.
  await link(await privateTool, path);
  return path;
}

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-tool-adapter-"));
  removeToolWorkspace(t, () => rm(dir, { recursive: true, force: true }));
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

async function readyTool(t, script, marker, heartbeat, { stdin = "ignore", observation = () => {} } = {}) {
  const child = nodeSpawn(join(dirname(script), "node-tool"), [script], {
    env: {}, shell: false, detached: process.platform !== "win32", stdio: [stdin, "pipe", "pipe"],
  });
  let failure;
  child.on("error", error => { failure = error; });
  trackToolProcess(t, child);
  // The adapter's clock measures killing a live group, not two Node startups.
  // Setup observes the real child files; it never creates readiness itself.
  await waitForToolState(async () => {
    if (failure) throw failure;
    assert.equal(child.exitCode, null, "the fixture must stay alive until adapter handoff");
    try {
      const values = await Promise.all([readFile(marker), readFile(heartbeat)]);
      observation(values);
      const pid = Number(values[0].toString());
      return Number.isSafeInteger(pid) && pid > 0 && values[1].length > 0;
    }
    catch (error) { if (error?.code !== "ENOENT") throw error; return false; }
  }, "the tool must write its PID and heartbeat within the setup bound");
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
  pending.catch(() => {}); // Handle setup refusal immediately, including while waiting for started.
  try {
    await waitForToolState(async () => {
      try { await readFile(started); return true; }
      catch (error) { if (error?.code !== "ENOENT") throw error; return false; }
    }, "the real tool must reach its startup gate");
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
  for (const [name, partialPid, partialHeartbeat] of [
    ["partial PID", true, false], ["partial heartbeat", false, true], ["both partial", true, true],
  ]) await t.test(name, async sub => {
    const dir = await workspace(sub), marker = join(dir, "pid"), heartbeat = join(dir, "heartbeat"), started = join(dir, "partial-started");
    const script = await executable(dir, `import { writeFileSync } from "node:fs";
  process.once("SIGUSR2", () => {
    writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    writeFileSync(${JSON.stringify(heartbeat)}, "ready");
  });
  writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(partialPid)} ? "" : String(process.pid));
  writeFileSync(${JSON.stringify(heartbeat)}, ${JSON.stringify(partialHeartbeat)} ? "" : "ready");
  writeFileSync(${JSON.stringify(started)}, String(process.pid)); process.stdin.resume();`);
    let handedOff = false, pid, observedPartial;
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
    } finally { if (pid) process.kill(pid, "SIGUSR2"); await pending; }
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
  } finally { child.stdin.end(); await disappearance; }
});

test("module readiness barrier waits for real initialization before admission", async t => {
  const dir = await workspace(t), started = join(dir, "module-started");
  const module = await executable(dir, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, "started");
await new Promise(done => process.once("message", done));`);
  const script = await executable(dir, `import ${JSON.stringify("./" + basename(module))};
console.log("module initialized");`);
  const registry = await connector.loadToolAdapters(await manifest(dir, [entry(script)]));
  let child, admitted = false;
  const pending = preparedToolRunner(t, registry, { startProcess: (...args) => { child = nodeSpawn(...args); return child; } })
    .then(runner => { admitted = true; return runner; });
  pending.catch(() => {});
  try {
    await waitForToolState(async () => {
      try { await readFile(started); return true; }
      catch (error) { if (error?.code !== "ENOENT") throw error; return false; }
    }, "the real fixture module must reach its initialization gate");
    await new Promise(done => setImmediate(done));
    assert.equal(admitted, false, "admission must wait for real module initialization, not process spawn");
  } finally { child.send("initialize"); await pending; }
  const result = await (await pending).execute(input());
  assert.equal(result.summary, "module initialized");
});

test("prepared tools initialize before admission and wait for explicit work release", async t => {
  const dir = await workspace(t), resultMarker = join(dir, "executed");
  const script = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(resultMarker)}, "executed");
writeFileSync(process.argv[3] + "/result.txt", readFileSync(process.argv[2]));`);
  const registry = await connector.loadToolAdapters(await manifest(dir, [entry(script)]));
  let child, handedOff;
  const handoff = new Promise(done => { handedOff = done; });
  const runner = await preparedToolRunner(t, registry, { hold: true, onHandoff: value => { child = value; handedOff(); } });
  const pending = runner.execute(input("independent literal"));
  try {
    await waitForToolSignal(Promise.race([handoff, pending.then(() => assert.fail("the prepared tool must reach handoff"))]),
      "the prepared tool must reach handoff within the setup bound");
    const gated = await waitForToolSignal(new Promise(done => {
      const message = value => { if (value === "gated") finish(true); };
      const closed = () => finish(false);
      const finish = value => { child.off("message", message); child.off("close", closed); done(value); };
      child.on("message", message); child.once("close", closed);
      child.send("probe", error => { if (error) finish(false); });
    }), "the initialized tool must acknowledge its work gate within the setup bound");
    assert.equal(gated, true, "the real initialized tool must acknowledge its work gate before release");
    await assert.rejects(readFile(resultMarker), { code: "ENOENT" }, "work must remain behind the explicit release gate");
  } finally { child?.release(); }
  const result = await pending;
  assert.equal(await readFile(resultMarker, "utf8"), "executed");
  assert.equal(Buffer.from(result.files[0].contentBase64, "base64").toString(), "independent literal");
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

test("preparation failure reaps every started child before rejecting", async t => {
  const dir = await workspace(t), script = await executable(dir, "process.stdin.resume();");
  const registry = await connector.loadToolAdapters(await manifest(dir, [entry(script)]));
  const hooks = [], context = { after: hook => hooks.push(hook) }, children = [];
  const recorded = new Error("recorded launch refusal");
  try {
    await assert.rejects(preparedToolRunner(context, registry, { count: 2, startProcess: (...args) => {
      if (children.length === 1) throw recorded;
      const child = nodeSpawn(...args); children.push(child); return child;
    } }), error => error === recorded);
    assert.equal(children.length, 1, "the preparation failure follows one actual child launch");
    assert.throws(() => process.kill(children[0].pid, 0), /ESRCH/u,
      "preparation refusal must reap every child before rejecting");
  } finally { for (const hook of hooks) await hook(); }
});

test("cleanup refusal kills and reaps the whole prepared process group before removal", async t => {
  const dir = await workspace(t), pidFile = join(dir, "cleanup-child.pid"), heartbeat = join(dir, "cleanup-child.ready");
  const script = await executable(dir, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(heartbeat)}, "ready"); process.stdin.resume(); setInterval(() => {}, 1000);`)}], { stdio: ["pipe", "ignore", "ignore"] });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);`);
  const hooks = [], context = { after: hook => hooks.push(hook) };
  const recorded = Object.assign(new Error("ENOTEMPTY: recorded workspace removal failure"), { code: "ENOTEMPTY" });
  let child, descendant, removalEntered = false;
  removeToolWorkspace(context, async () => { removalEntered = true; throw recorded; });
  const registry = await connector.loadToolAdapters(await manifest(dir, [entry(script, { timeoutMs: 10_000 })]));
  const runner = await preparedToolRunner(context, registry, { onHandoff: value => { child = value; } });
  const pending = runner.execute(input()).then(value => ({ value }), error => ({ error }));
  try {
    await waitForToolState(async () => {
      try {
        descendant = Number(await readFile(pidFile, "utf8"));
        return (await readFile(heartbeat, "utf8")) === "ready";
      } catch (error) { if (error?.code !== "ENOENT") throw error; return false; }
    }, "the real descendant must become ready before cleanup refusal");
    await assert.rejects(hooks[0](), error => error === recorded);
    assert.equal(removalEntered, true, "the recorded removal refusal is reached");
    assert.throws(() => process.kill(child.pid, 0), /ESRCH/u,
      "the prepared child must be reaped before a workspace removal refusal");
    await waitForProcessGone(descendant, "the entire prepared process group must die despite removal refusal");
    assert.equal((await pending).error?.code, "tool_adapter_failed");
    assert.equal(runner.active, 0);
  } finally {
    if (child?.pid) {
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
      catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
    await pending;
    await cleanupToolResources(context);
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

test("manifest validation refuses a writable non-sticky executable folder", async t => {
  const dir = await workspace(t);
  const folder = join(dir, "shared-tool-folder");
  await mkdir(folder, { mode: 0o700 });
  const tool = await workspaceNodeTool(folder);
  const script = await executable(dir, "process.exit(0);\n");
  const path = await manifest(dir, [entry(script, { executable: tool })]);
  await chmod(folder, 0o777);
  assert.equal((await stat(tool)).mode & 0o777, 0o700, "the executable itself is private");
  assert.equal((await stat(folder)).mode & 0o1777, 0o777, "the folder is writable and non-sticky");
  await assert.rejects(connector.loadToolAdapters(path),
    /the folder containing the tool executable for whisper_local can be changed by other users/u);
  await chmod(folder, 0o700);
  assert.equal((await connector.loadToolAdapters(path)).adapters.size, 1, "repairing the folder permits retry");

  const temporaryParent = await stat(tmpdir());
  if (temporaryParent.uid === 0 && (temporaryParent.mode & 0o1000) !== 0) {
    const stickyTool = join(tmpdir(), `${basename(dir)}-node-tool`);
    // An exclusive hard link keeps this test-owned name in the existing root-owned sticky folder.
    await link(tool, stickyTool);
    t.after(() => rm(stickyTool, { force: true }));
    const stickyManifest = await manifest(dir, [entry(script, { executable: stickyTool })], 1, "sticky-root.json");
    assert.equal((await connector.loadToolAdapters(stickyManifest)).adapters.size, 1,
      "a root-owned sticky folder protects the private executable");
  } else {
    t.diagnostic("sticky root-owned folder case unproven: TMPDIR is private and creating a root-owned folder requires root");
  }
});

test("task data cannot select argv: inputs are staged and unknown adapter ids are refused before spawn", async t => {
  const dir = await workspace(t);
  const script = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
const [inputPath, outputDir] = process.argv.slice(2);
writeFileSync(outputDir + "/argv.json", JSON.stringify({ argv: process.argv.slice(2), body: readFileSync(inputPath, "utf8") }));
console.log("transcribed");`);
  const registry = await connector.loadToolAdapters(await manifest(dir, [entry(script)]));
  let spawned = 0;
  const runner = await preparedToolRunner(t, registry, { onHandoff: (_child, _argv, options) => { spawned += 1;
    assert.equal(options.shell, false); } });
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
  await assert.rejects(connector.createLocalToolAdapterRunner(timed, { spawner: () => timedChild }).execute(input()),
    error => error?.code === "tool_adapter_timeout");
  const childPid = Number(await readFile(marker, "utf8"));
  t.after(() => { try { process.kill(childPid, "SIGKILL"); } catch {} });
  await waitForProcessGone(childPid, "timeout stopped the descendant too");

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
  const pending = connector.createLocalToolAdapterRunner(stoppable, { spawner: () => {
    // This runs after the adapter installs its listeners in the same turn.
    queueMicrotask(handedOff);
    return stoppedChild;
  } }).execute(input(), controller.signal);
  await waitForToolSignal(Promise.race([handoff, pending.then(() => assert.fail("the live tool must reach adapter handoff"))]),
    "the live tool must reach adapter handoff within the setup bound");
  controller.abort();
  await assert.rejects(pending, error => error?.code === "tool_adapter_aborted");
  const stoppedPid = Number(await readFile(stoppedMarker, "utf8"));
  t.after(() => { try { process.kill(stoppedPid, "SIGKILL"); } catch {} });
  await waitForProcessGone(stoppedPid, "stop killed the descendant too");
});

test("oversize and secret-bearing output are refused, while a retry after process failure succeeds", async t => {
  const dir = await workspace(t);
  const oversized = await executable(dir, `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + "/large.txt", "x".repeat(2048));`);
  const oversizeRegistry = await connector.loadToolAdapters(await manifest(dir,
    [entry(oversized, { maxOutputBytes: 1024 })], 1, "oversize.json"));
  await assert.rejects((await preparedToolRunner(t, oversizeRegistry)).execute(input()),
    error => error?.code === "tool_adapter_output_too_large");

  const leaky = await executable(dir, `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + "/transcript.txt", "api_key=sk_test_1234567890abcdef");`);
  const leakRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(leaky)], 1, "leak.json"));
  await assert.rejects((await preparedToolRunner(t, leakRegistry)).execute(input()),
    error => error?.code === "tool_adapter_secret_refused");

  const retry = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
const body = readFileSync(process.argv[2], "utf8");
if (body === "fail") process.exit(2);
writeFileSync(process.argv[3] + "/ok.txt", body);`);
  const retryRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(retry)], 1, "retry.json"));
  const runner = await preparedToolRunner(t, retryRegistry, { count: 2 });
  await assert.rejects(runner.execute(input("fail")), error => error?.code === "tool_adapter_failed");
  const result = await runner.execute(input("retry worked"));
  assert.equal(Buffer.from(result.files[0].contentBase64, "base64").toString(), "retry worked");

  const scoped = await executable(dir, `import { dirname } from "node:path";
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + "/inside.txt", "inside");
writeFileSync(dirname(process.argv[3]) + "/outside.txt", "outside");`);
  const scopedRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(scoped)], 1, "scoped.json"));
  const scopedResult = await (await preparedToolRunner(t, scopedRegistry)).execute(input());
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
    runner: await preparedToolRunner(t, registry) });
  assert.equal(completed.outcome, "submitted");
  assert.equal(calls.filter(call => call[0] === "result").length, 3, "a dropped upload is retried with the same payload");
  const upload = calls.find(call => call[0] === "result");
  assert.equal(upload[2], "Whisper finished.");
  assert.equal(Buffer.from(upload[3][0].contentBase64, "base64").toString(), "hello");

  calls.length = 0;
  client.result = async (...args) => { calls.push(["result", ...args]); return { resultId: "fleet-result:test" }; };
  const refused = await connector.runClaimedToolTask({ client, claim: { ...claim, adapterId: "unknown_tool" },
    runner: await preparedToolRunner(t, registry) });
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
    const runner = connector.createLocalToolAdapterRunner(registry, {
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
    await waitForToolSignal(exitSeen, "the recorded exit must be replayed within the setup bound");
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
writeFileSync(process.argv[3] + "/result.txt", readFileSync(process.argv[2]));`);
  const registry = await connector.loadToolAdapters(await manifest(dir, [entry(script, { timeoutMs: 5_000 })], 3));
  let peak = 0, firstWave;
  const admitted = new Promise(done => { firstWave = done; });
  const held = [];
  const runner = await preparedToolRunner(t, registry, { count: 20, hold: true, onHandoff: (child) => {
    peak = Math.max(peak, runner.active);
    held.push(child);
    if (held.length === 3) firstWave();
    if (held.length > 3) child.release();
  } });
  const pending = Array.from({ length: 20 }, (_, index) => runner.execute(input(`run-${index}`)));
  try {
    await waitForToolSignal(Promise.race([admitted, Promise.allSettled(pending).then(() => {
      throw new Error("tool burst settled before three processes were admitted");
    })]), "the first tool burst must reach its observed admission gate within the setup bound");
    assert.equal(runner.active, 3, "three initialized tools hold the first wave at the work gate");
    held.forEach(child => child.release());
    const results = await Promise.all(pending);
    assert.deepEqual(results.map(result => Buffer.from(result.files[0].contentBase64, "base64").toString()),
      Array.from({ length: 20 }, (_, index) => `run-${index}`), "every caller reads its own staged result");
  } finally { held.forEach(child => child.release()); await Promise.allSettled(pending); }
  assert.equal(peak, 3);
  assert.equal(runner.active, 0);
});

test("overflow terminates once, an escaped pipe holder is bounded, and same-group children die", { timeout: 20_000 }, async t => {
  const dir = await workspace(t);
  const overflow = await executable(dir, "process.exit(0)");
  const kills = [];
  const overflowRunner = connector.createLocalToolAdapterRunner(await connector.loadToolAdapters(await manifest(dir,
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
  const escapedProbe = join(dir, "escaped.probe");
  const escaped = await executable(dir, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`const { existsSync, writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(escapedReady)}, "ready");
setInterval(() => {
  if (!existsSync(${JSON.stringify(escapedProbe)})) return;
  process.stdout.write("held"); process.stderr.write("held");
}, 100);
setTimeout(() => process.exit(0), 30_000);`)}], { detached: true, stdio: "inherit" });
writeFileSync(${JSON.stringify(escapedPid)}, String(child.pid));
process.stdin.resume(); process.stdin.once("end", () => process.exit(0));`);
  const escapedRegistry = await connector.loadToolAdapters(await manifest(dir,
    [entry(escaped, { timeoutMs: 1_500 })], 1, "escaped.json"));
  try {
    const escapedChild = await readyTool(t, escaped, escapedPid, escapedReady, { stdin: "pipe" });
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
    await writeFile(escapedProbe, "probe");
    const held = await Promise.all([heldPipe(escapedChild.stdout), heldPipe(escapedChild.stderr)]);
    assert.equal(held[0], true, "the real escaped stdout pipe produces bytes after parent exit at handoff");
    assert.equal(held[1], true, "the real escaped stderr pipe produces bytes after parent exit at handoff");
    let drainStarted;
    await assert.rejects(connector.createLocalToolAdapterRunner(escapedRegistry, { spawner: () => {
      assert.equal(escapedChild.exitCode, 0, "drain clock starts only after a real parent exit");
      // Replay only the recorded exit, with real still-open inherited pipes.
      // The launch seam is synthetic; pipes and recorded process events are real.
      queueMicrotask(() => {
        drainStarted = performance.now();
        escapedChild.emit("exit", ...exit);
      });
      return escapedChild;
    } }).execute(input()),
      error => error?.code === "tool_adapter_failed", "unclosed pipes cannot submit truncated output");
    assert.ok(performance.now() - drainStarted < 700,
      "an escaped stdout holder cannot wedge execute beyond the declared drain bound after handoff");
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
  await assert.doesNotReject(connector.createLocalToolAdapterRunner(groupedRegistry, { spawner: () => {
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
  await assert.rejects(connector.createLocalToolAdapterRunner(registry).execute(input()), error => error?.code === "tool_adapter_executable_changed");

  const source = join(dir, "private.txt"); await writeFile(source, "ordinary private text");
  const hardlink = await executable(dir, `import { linkSync } from "node:fs"; linkSync(${JSON.stringify(source)}, process.argv[3] + "/linked.txt");`);
  const linkRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(hardlink)], 1, "links.json"));
  await assert.rejects((await preparedToolRunner(t, linkRegistry)).execute(input()), error => error?.code === "tool_adapter_output_invalid");

  const cleanup = await executable(dir, "process.exit(0)");
  const cleanRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(cleanup)], 1, "cleanup.json"));
  const runner = await preparedToolRunner(t, cleanRegistry, { removeWork: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
  await runner.execute(input());
  assert.equal(runner.active, 0, "cleanup trouble does not retain a concurrency slot");

  const locked = await executable(dir, `import { chmodSync, mkdirSync } from "node:fs";
mkdirSync(process.argv[3] + "/locked"); chmodSync(process.argv[3] + "/locked", 0);`);
  const lockedRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(locked)], 1, "locked.json"));
  const lockedRunner = await preparedToolRunner(t, lockedRegistry, { temporaryRoot: dir });
  await assert.rejects(lockedRunner.execute(input()), /EACCES/u);
  assert.equal((await readdir(dir)).some(name => name.startsWith("control-room-tool-")), false,
    "cleanup restores user access before removing a tool-owned locked directory");
});

test("stress: 50 runs cap at four with one third aborted", { timeout: 30_000 }, async t => {
  const dir = await workspace(t);
  const script = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + "/ok.txt", readFileSync(process.argv[2]));`);
  const registry = await connector.loadToolAdapters(await manifest(dir, [entry(script, { timeoutMs: 2_000 })], 4, "stress-50.json"));
  let fourStarted, peak = 0;
  const executing = new Promise(done => { fourStarted = done; });
  const held = [];
  const runner = await preparedToolRunner(t, registry, { count: 50, hold: true, onHandoff: child => {
    peak = Math.max(peak, runner.active); held.push(child);
    if (held.length === 4) fourStarted();
    if (held.length > 4) child.release();
  } });
  const controllers = Array.from({ length: 50 }, () => new AbortController());
  const pending = controllers.map((controller, i) => runner.execute(input(`run-${i}`), controller.signal));
  let settled;
  try {
    await waitForToolSignal(Promise.race([executing, Promise.allSettled(pending).then(() => {
      throw new Error("tool burst settled before four processes were admitted");
    })]), "the second tool burst must reach its observed admission gate within the setup bound");
    assert.equal(runner.active, 4, "four initialized tools hold the first wave at the work gate");
    controllers.filter((_, i) => i % 3 === 0).forEach(controller => controller.abort());
    held.forEach(child => child.release());
    settled = await Promise.allSettled(pending);
  } finally {
    controllers.forEach(controller => controller.abort()); held.forEach(child => child.release());
    await Promise.allSettled(pending);
  }
  assert.equal(peak, 4); assert.equal(runner.active, 0);
  assert.equal(settled.filter(result => result.status === "rejected").length, 17,
    "exactly the seventeen explicitly stopped callers are refused");
  settled.forEach((result, i) => {
    if (i % 3 === 0) assert.equal(result.reason?.code, "tool_adapter_aborted");
    else assert.equal(Buffer.from(result.value.files[0].contentBase64, "base64").toString(), `run-${i}`);
  });
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
    const stagedRunner = connector.createLocalToolAdapterRunner(registry, { environment,
      spawner: () => { spawned++; throw new Error("stopped staging must not spawn"); } });
    await assert.rejects(stagedRunner.execute(input(), staged.signal), e => e.code === "tool_adapter_aborted");
    assert.equal(spawned, 0); assert.equal(stagedRunner.active, 0);
  });
  await t.test("spawn", async () => {
    const duringSpawn = new AbortController();
    const spawnedRunner = connector.createLocalToolAdapterRunner(registry, { environment: {}, spawner: (...args) => {
      duringSpawn.abort(); return nodeSpawn(...args);
    } });
    await assert.rejects(spawnedRunner.execute(input(), duringSpawn.signal), e => e.code === "tool_adapter_aborted");
    assert.equal(spawnedRunner.active, 0);
  });
});
