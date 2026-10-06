import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as connector from "../scripts/fleet/connector.mjs";
import { RELEASE_TRUST_SCHEMA_V1, connectorReleaseSignatureMaterialV1,
  releaseKeyIdV1 } from "../scripts/release-signing.mjs";

/** The gateway ships the agreement metadata; a fake that omits it is refused. */
const WORKING_AGREEMENT = Object.freeze({ version: connector.WORKING_AGREEMENT.version,
  digest: connector.WORKING_AGREEMENT.digest, startsWork: false, grantsAuthority: false });

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "fleet-tool-adapter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function executable(dir, source) {
  const path = join(dir, `tool-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

const entry = (script, extra = {}) => ({
  id: "whisper_local",
  capability: "tool.whisper",
  executable: process.execPath,
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

test("task data cannot select argv: inputs are staged and unknown adapter ids are refused before spawn", async t => {
  const dir = await workspace(t);
  const script = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
const [inputPath, outputDir] = process.argv.slice(2);
writeFileSync(outputDir + "/argv.json", JSON.stringify({ argv: process.argv.slice(2), body: readFileSync(inputPath, "utf8") }));
console.log("transcribed");`);
  const registry = await connector.loadToolAdapters(await manifest(dir, [entry(script)]));
  let spawned = 0;
  const runner = connector.createLocalToolAdapterRunner(registry, { spawner: (...args) => { spawned += 1;
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
writeFileSync(${JSON.stringify(marker)}, String(child.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);`);
  const timed = await connector.loadToolAdapters(await manifest(dir, [entry(script, { timeoutMs: 150 })], 1, "timed.json"));
  await assert.rejects(connector.createLocalToolAdapterRunner(timed).execute(input()), error => error?.code === "tool_adapter_timeout");
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
writeFileSync(${JSON.stringify(stoppedMarker)}, String(child.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);`);
  const stoppable = await connector.loadToolAdapters(await manifest(dir, [entry(stoppedScript, { timeoutMs: 10_000 })], 1, "stop.json"));
  const controller = new AbortController();
  const pending = connector.createLocalToolAdapterRunner(stoppable).execute(input(), controller.signal);
  while (true) { try { await Promise.all([readFile(stoppedMarker), readFile(stoppedHeartbeat)]); break; }
    catch { await new Promise(done => setTimeout(done, 10)); } }
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
  await assert.rejects(connector.createLocalToolAdapterRunner(oversizeRegistry).execute(input()),
    error => error?.code === "tool_adapter_output_too_large");

  const leaky = await executable(dir, `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + "/transcript.txt", "api_key=sk_test_1234567890abcdef");`);
  const leakRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(leaky)], 1, "leak.json"));
  await assert.rejects(connector.createLocalToolAdapterRunner(leakRegistry).execute(input()),
    error => error?.code === "tool_adapter_secret_refused");

  const retry = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
const body = readFileSync(process.argv[2], "utf8");
if (body === "fail") process.exit(2);
writeFileSync(process.argv[3] + "/ok.txt", body);`);
  const retryRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(retry)], 1, "retry.json"));
  const runner = connector.createLocalToolAdapterRunner(retryRegistry);
  await assert.rejects(runner.execute(input("fail")), error => error?.code === "tool_adapter_failed");
  const result = await runner.execute(input("retry worked"));
  assert.equal(Buffer.from(result.files[0].contentBase64, "base64").toString(), "retry worked");

  const scoped = await executable(dir, `import { dirname } from "node:path";
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[3] + "/inside.txt", "inside");
writeFileSync(dirname(process.argv[3]) + "/outside.txt", "outside");`);
  const scopedRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(scoped)], 1, "scoped.json"));
  const scopedResult = await connector.createLocalToolAdapterRunner(scopedRegistry).execute(input());
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
    runner: connector.createLocalToolAdapterRunner(registry) });
  assert.equal(completed.outcome, "submitted");
  assert.equal(calls.filter(call => call[0] === "result").length, 3, "a dropped upload is retried with the same payload");
  const upload = calls.find(call => call[0] === "result");
  assert.equal(upload[2], "Whisper finished.");
  assert.equal(Buffer.from(upload[3][0].contentBase64, "base64").toString(), "hello");

  calls.length = 0;
  client.result = async (...args) => { calls.push(["result", ...args]); return { resultId: "fleet-result:test" }; };
  const refused = await connector.runClaimedToolTask({ client, claim: { ...claim, adapterId: "unknown_tool" },
    runner: connector.createLocalToolAdapterRunner(registry) });
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
  const runner = connector.createLocalToolAdapterRunner(registry);
  let peak = 0, done = false;
  const monitor = (async () => { while (!done) { peak = Math.max(peak, runner.active); await new Promise(resolve => setTimeout(resolve, 2)); } })();
  const pending = Array.from({ length: 20 }, (_, index) => runner.execute(input(`run-${index}`)));
  let results;
  try { results = await Promise.all(pending); }
  finally { await Promise.allSettled(pending); done = true; await monitor; }
  assert.equal(peak, 3);
  assert.equal(runner.active, 0);
  assert.equal(results.length, 20);
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
  const escaped = await executable(dir, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 5000)"], { detached: true, stdio: "inherit" });
writeFileSync(${JSON.stringify(escapedPid)}, String(child.pid)); process.exit(0);`);
  const started = Date.now();
  try {
    await assert.rejects(connector.createLocalToolAdapterRunner(await connector.loadToolAdapters(await manifest(dir,
      [entry(escaped, { timeoutMs: 1_500 })], 1, "escaped.json"))).execute(input()),
      error => error?.code === "tool_adapter_failed", "unclosed pipes cannot submit truncated output");
    assert.ok(Date.now() - started < 700, "an escaped stdout holder cannot wedge execute");
  } finally {
    try {
      const pid = Number(await readFile(escapedPid, "utf8"));
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) { if (error?.code !== "EPERM") throw error; process.kill(pid, "SIGKILL"); }
    }
    catch (error) { if (!["ENOENT", "ESRCH"].includes(error?.code)) throw error; }
  }

  const groupedPid = join(dir, "grouped.pid");
  const grouped = await executable(dir, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(groupedPid)}, String(child.pid)); process.exit(0);`);
  await connector.createLocalToolAdapterRunner(await connector.loadToolAdapters(await manifest(dir,
    [entry(grouped, { timeoutMs: 1_000 })], 1, "grouped.json"))).execute(input());
  const pid = Number(await readFile(groupedPid, "utf8"));
  await new Promise(done => setTimeout(done, 40));
  assert.throws(() => process.kill(pid, 0), /ESRCH/u, "same-group child is gone before execute returns");
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
  await assert.rejects(connector.createLocalToolAdapterRunner(await connector.loadToolAdapters(await manifest(dir,
    [entry(hardlink)], 1, "links.json"))).execute(input()), error => error?.code === "tool_adapter_output_invalid");

  const cleanup = await executable(dir, "process.exit(0)");
  const cleanRegistry = await connector.loadToolAdapters(await manifest(dir, [entry(cleanup)], 1, "cleanup.json"));
  const runner = connector.createLocalToolAdapterRunner(cleanRegistry, { removeWork: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
  await runner.execute(input());
  assert.equal(runner.active, 0, "cleanup trouble does not retain a concurrency slot");

  const locked = await executable(dir, `import { chmodSync, mkdirSync } from "node:fs";
mkdirSync(process.argv[3] + "/locked"); chmodSync(process.argv[3] + "/locked", 0);`);
  const lockedRunner = connector.createLocalToolAdapterRunner(await connector.loadToolAdapters(await manifest(dir,
    [entry(locked)], 1, "locked.json")), { temporaryRoot: dir });
  await assert.rejects(lockedRunner.execute(input()), /EACCES/u);
  assert.equal((await readdir(dir)).some(name => name.startsWith("control-room-tool-")), false,
    "cleanup restores user access before removing a tool-owned locked directory");
});

test("stress: 50 runs cap at four with one third aborted", { timeout: 30_000 }, async t => {
  const dir = await workspace(t);
  const script = await executable(dir, `import { readFileSync, writeFileSync } from "node:fs";
await new Promise(done => setTimeout(done, 80)); writeFileSync(process.argv[3] + "/ok.txt", readFileSync(process.argv[2]));`);
  let started = 0, fourStarted;
  const executing = new Promise(done => { fourStarted = done; });
  const runner = connector.createLocalToolAdapterRunner(await connector.loadToolAdapters(await manifest(dir,
    [entry(script, { timeoutMs: 2_000 })], 4, "stress-50.json")), { spawner: (...args) => {
    const child = Reflect.apply(nodeSpawn, undefined, args);
    child.once("spawn", () => { if (++started === 4) fourStarted(); });
    return child;
  } });
  let peak = 0, watching = true;
  const watch = (async () => { while (watching) { peak = Math.max(peak, runner.active); await new Promise(done => setTimeout(done, 2)); } })();
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
    await Promise.allSettled(pending); watching = false; await watch;
  }
  assert.equal(peak, 4); assert.equal(runner.active, 0);
  assert.ok(settled.filter(result => result.status === "rejected").length >= 16);
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
