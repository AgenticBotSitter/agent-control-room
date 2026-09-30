import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkForConnectorUpdateV1, compareConnectorVersionsV1, connectorReleaseSignatureMaterialV1,
  connectorInstallRootFromConfigPathV1, connectorUpdatePathsV1, connectorUpdatesPausedV1, installConnectorLauncherV1,
  launchCurrentConnectorV1, pinConnectorReleaseTrustV1, recoverPendingConnectorUpdateV1, setConnectorUpdatesPausedV1,
  verifyConnectorReleaseAdvertisementV1 } from "../scripts/fleet/connector-update.mjs";
import { applyReleaseKeyRevocationsV1, applyReleaseKeyRotationV1, createReleaseKeyRevocationsV1,
  createReleaseKeyRotationV1, releaseKeyIdV1, RELEASE_TRUST_SCHEMA_V1 } from "../scripts/release-signing.mjs";
import * as connector from "../scripts/fleet/connector.mjs";

const keys = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const trust = Object.freeze({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1, keyId: releaseKeyIdV1(publicKey),
  publicKey, versionFloor: "1.0.0", revokedKeyIds: [] });

function advertised(bytes, overrides = {}, key = keys.privateKey) {
  const unsigned = { version: "1.1.0", file: "connector-1.1.0.mjs", sha256: bytesDigest(bytes), size: bytes.length,
    builtFrom: "b".repeat(40), minVersion: "1.0.0", ...overrides };
  return { ...unsigned, signature: sign(null, connectorReleaseSignatureMaterialV1(unsigned), key).toString("base64url") };
}

function bytesDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(t, label = "connector-update-") {
  const root = await mkdtemp(join(tmpdir(), label));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "mcp"), configPath = join(root, "config", "bots", "worker.json");
  const sourcePath = join(root, "connector.mjs"), shimPath = join(installRoot, "bin", "control-room-mcp");
  const sourceBytes = Buffer.from("export const fixture = true;\n");
  await writeFile(sourcePath, sourceBytes, { mode: 0o700 });
  await installConnectorLauncherV1({ installRoot, sourcePath, version: "1.0.0", platform: "linux", shimPath,
    trust, advertisement: advertised(sourceBytes, { version: "1.0.0", file: "connector-1.0.0.mjs" }) });
  const config = { schema: "control-room.fleet-connector/v1", server: "http://127.0.0.1:1",
    workerId: `fleet-worker:${"a".repeat(32)}`, secret: `crf_${"A".repeat(43)}`, installation: {
      bot: "codex", name: "fixture", workspace: join(root, "work"), state: "installed",
      updates: { releasePublicKey: publicKey, floorVersion: "1.0.0", keyId: trust.keyId, epoch: 1,
        revokedKeyIds: [], paused: false },
    } };
  await mkdir(join(root, "config", "bots"), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 }); await chmod(configPath, 0o600);
  return { root, installRoot, configPath, config, paths: connectorUpdatePathsV1(installRoot) };
}

function releaseFetcher(bytes, { delay = 0, failAfter = null, count } = {}) {
  return async (_url, init) => {
    assert.match(init.headers.authorization, /^Bearer crf_/u);
    if (count) count.value += 1;
    if (delay) await new Promise(done => setTimeout(done, delay));
    if (failAfter !== null) {
      const body = new ReadableStream({ start(controller) {
        controller.enqueue(bytes.subarray(0, failAfter)); controller.error(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
      } });
      return new Response(body, { status: 200, headers: { "content-length": String(bytes.length) } });
    }
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  };
}

async function currentVersion(f) { return JSON.parse(await readFile(f.paths.current, "utf8")).version; }

test("signed updater installs atomically, keeps the previous version and supports owner pause", async t => {
  const f = await fixture(t), bytes = Buffer.from("export const version = '1.1.0';\n"), release = advertised(bytes);
  let health = 0;
  const result = await checkForConnectorUpdateV1({ ...f, advertised: release, currentVersion: "1.0.0",
    fetcher: releaseFetcher(bytes), healthCheck: async path => { health += 1; assert.match(path, /versions\/1\.1\.0/u); return true; } });
  assert.deepEqual(result, { state: "updated", version: "1.1.0" }); assert.equal(health, 1);
  assert.equal(await currentVersion(f), "1.1.0");
  assert.equal(JSON.parse(await readFile(f.paths.previous, "utf8")).version, "1.0.0");
  assert.deepEqual(await readFile(join(f.paths.versions, "1.1.0", "connector.mjs")), bytes);
  await setConnectorUpdatesPausedV1({ ...f, paused: true });
  const secondConfigPath = join(f.root, "config", "bots", "second.json");
  await writeFile(secondConfigPath, `${JSON.stringify({ ...f.config, workerId: `fleet-worker:${"b".repeat(32)}` })}\n`, { mode: 0o600 });
  assert.deepEqual(await checkForConnectorUpdateV1({ ...f, configPath: secondConfigPath, advertised: advertised(Buffer.from("next"), {
    version: "1.2.0", file: "connector-1.2.0.mjs" }), currentVersion: "1.1.0", fetcher: () => {
    throw new Error("machine-paused update contacted gateway"); } }), { state: "paused" });
  assert.equal(await connectorUpdatesPausedV1(f.installRoot), true);
  await writeFile(f.paths.policy, '{"paused":"yes"}\n');
  await assert.rejects(connectorUpdatesPausedV1(f.installRoot), /policy/u);
});

test("hostile advertisements and swapped, truncated or oversized downloads never move current", async t => {
  const f = await fixture(t), bytes = Buffer.from("trusted connector bytes"), valid = advertised(bytes);
  assert.throws(() => verifyConnectorReleaseAdvertisementV1(advertised(bytes, {}, stranger.privateKey), trust), /signature/u);
  assert.throws(() => verifyConnectorReleaseAdvertisementV1(advertised(bytes, { size: 16 * 1024 * 1024 + 1 }), trust),
    /advertisement/u);
  for (const hostile of [
    { release: advertised(bytes, { version: "0.9.0", file: "connector-0.9.0.mjs", minVersion: "0.9.0" }), fetcher: releaseFetcher(bytes) },
    { release: valid, fetcher: releaseFetcher(Buffer.alloc(bytes.length, 1)) },
    { release: valid, fetcher: async () => new Response(bytes.subarray(0, 3), { status: 200 }) },
  ]) {
    await assert.rejects(checkForConnectorUpdateV1({ ...f, advertised: hostile.release, currentVersion: "1.0.0",
      fetcher: hostile.fetcher, healthCheck: async () => true }));
    assert.equal(await currentVersion(f), "1.0.0");
  }
});

test("the real update path verifies the advertisement before downloading", async t => {
  const f = await fixture(t), bytes = Buffer.from("stranger signed bytes"), count = { value: 0 };
  await assert.rejects(checkForConnectorUpdateV1({ ...f,
    advertised: advertised(bytes, {}, stranger.privateKey), currentVersion: "1.0.0",
    fetcher: releaseFetcher(bytes, { count }), healthCheck: async () => true }), /signature/u);
  assert.equal(count.value, 0, "a bad signature must fail before the download route is called");
  assert.equal(await currentVersion(f), "1.0.0");
});

test("a stalled body hits a held download deadline and releases the update lock", async t => {
  const f = await fixture(t), bytes = Buffer.from("deadline bytes"), release = advertised(bytes);
  const fetcher = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.subarray(0, 1));
  } }), { status: 200, headers: { "content-length": String(bytes.length) } });
  const started = Date.now();
  await assert.rejects(checkForConnectorUpdateV1({ ...f, advertised: release, currentVersion: "1.0.0",
    fetcher, healthCheck: async () => true, downloadDeadlineMs: 75 }), /download_timeout/u);
  assert.ok(Date.now() - started < 1_000, "the stalled stream must not outlive its deadline");
  await assert.rejects(readFile(f.paths.lock), error => error.code === "ENOENT");
  assert.equal(await currentVersion(f), "1.0.0");
});

test("disk-full and stopped-halfway downloads clean up and retain the runnable connector", async t => {
  const f = await fixture(t), bytes = Buffer.alloc(4096, 7), release = advertised(bytes);
  await assert.rejects(checkForConnectorUpdateV1({ ...f, advertised: release, currentVersion: "1.0.0",
    fetcher: releaseFetcher(bytes, { failAfter: 100 }), healthCheck: async () => true }), /disk full/u);
  assert.equal(await currentVersion(f), "1.0.0");
  assert.deepEqual((await readdir(join(f.paths.versions, "1.1.0"))).filter(name => name.endsWith(".tmp")), []);
});

test("a crashing candidate auto-reverts and a retry can replace it", async t => {
  const f = await fixture(t), bytes = Buffer.from("process.exit(1);\n"), release = advertised(bytes);
  const failed = await checkForConnectorUpdateV1({ ...f, advertised: release, currentVersion: "1.0.0",
    fetcher: releaseFetcher(bytes), healthCheck: async () => false, clock: () => 1_000 });
  assert.deepEqual(failed, { state: "reverted", version: "1.0.0", failedVersion: "1.1.0" });
  assert.equal(await currentVersion(f), "1.0.0");
  const retry = await checkForConnectorUpdateV1({ ...f, advertised: release, currentVersion: "1.0.0",
    fetcher: () => { throw new Error("failed release downloaded during backoff"); }, healthCheck: async () => true,
    clock: () => 1_001 });
  assert.deepEqual(retry, { state: "failed_recently", version: "1.1.0" });
  const later = await checkForConnectorUpdateV1({ ...f, advertised: release, currentVersion: "1.0.0",
    fetcher: releaseFetcher(bytes), healthCheck: async () => true, clock: () => 1_000 + 6 * 60 * 60_000 });
  assert.deepEqual(later, { state: "updated", version: "1.1.0" });
});

test("candidate health waits for three consecutive gateway failures before reverting", async t => {
  const f = await fixture(t); let calls = 0, stderr = "";
  const code = await connector.main(["health-check", "--config", f.configPath], {
    out: { write() {} }, err: { write(value) { stderr += value; } },
  }, { installRoot: f.installRoot, fetcher: async () => { calls += 1;
    return new Response(JSON.stringify({ ok: false, error: "unreachable" }), { status: 503 }); } });
  assert.equal(code, 1); assert.equal(calls, 3); assert.match(stderr, /refused/u);
});

test("run mode checks between tasks and exits cleanly to restart a healthy update", async t => {
  const f = await fixture(t); let checked = 0;
  const pass = await connector.runWorker({ configPath: f.configPath, once: true,
    fetcher: async url => {
      assert.equal(new URL(url).pathname, "/fleet/v1/heartbeat");
      return new Response(JSON.stringify({ ok: true, result: { displayName: "Fixture", workerKind: "codex",
        operationsMode: "running", connector: advertised(Buffer.from("new")) } }), { status: 200 });
    }, updateCheck: async () => { checked += 1; return { state: "updated", version: "1.1.0" }; }, log() {} });
  assert.equal(checked, 1); assert.deepEqual(pass, { state: "updated", version: "1.1.0" });
  let stderr = "";
  const direct = await connector.main(["run", "--once", "--config", f.configPath], {
    out: { write() {} }, err: { write(value) { stderr += value; } },
  }, { installRoot: f.installRoot, env: {}, fetcher: async () => { throw new Error("direct run contacted gateway"); } });
  assert.equal(direct, 1); assert.match(stderr, /through launcher\.mjs launch run/u);
});

test("MCP-style checks are persisted and happen at most once per day", async t => {
  const f = await fixture(t), bytes = Buffer.from("same"), release = advertised(bytes, {
    version: "1.0.0", file: "connector-1.0.0.mjs", minVersion: "1.0.0",
  });
  const first = await checkForConnectorUpdateV1({ ...f, advertised: release, currentVersion: "1.0.0",
    fetcher: () => { throw new Error("current release downloaded"); }, minimumCheckIntervalMs: 86_400_000,
    clock: () => 1_000_000 });
  const second = await checkForConnectorUpdateV1({ ...f, advertised: release, currentVersion: "1.0.0",
    fetcher: () => { throw new Error("recent release checked again"); }, minimumCheckIntervalMs: 86_400_000,
    clock: () => 1_001_000 });
  assert.equal(first.state, "current"); assert.equal(second.state, "recently_checked");
});

test("crashes at each switch boundary recover with an old or health-checked connector", async t => {
  const stages = ["downloaded", "version_ready", "previous_written", "pending_written", "pointer_switched"];
  for (const stage of stages) await t.test(stage, async t => {
    const f = await fixture(t, `connector-crash-${stage}-`), bytes = Buffer.from(`export const stage = '${stage}';\n`);
    await assert.rejects(checkForConnectorUpdateV1({ ...f, advertised: advertised(bytes), currentVersion: "1.0.0",
      fetcher: releaseFetcher(bytes), healthCheck: async () => true,
      fault: point => point === stage ? Promise.reject(new Error(`crash:${stage}`)) : Promise.resolve() }), /crash/u);
    if (stage === "pointer_switched") {
      const recovered = await recoverPendingConnectorUpdateV1({ ...f, healthCheck: async () => false });
      assert.equal(recovered.state, "reverted");
    } else await recoverPendingConnectorUpdateV1({ ...f, healthCheck: async () => true });
    assert.equal(await currentVersion(f), "1.0.0");
  });
});

test("two concurrent updaters on one machine coalesce behind one download", async t => {
  const f = await fixture(t), bytes = Buffer.from("export default 2;\n"), count = { value: 0 }, release = advertised(bytes);
  const calls = await Promise.all(Array.from({ length: 2 }, () => checkForConnectorUpdateV1({ ...f,
    advertised: release, currentVersion: "1.0.0", fetcher: releaseFetcher(bytes, { delay: 30, count }),
    healthCheck: async () => true })));
  assert.equal(count.value, 1); assert.equal(await currentVersion(f), "1.1.0");
  assert.deepEqual(calls.map(value => value.state).sort(), ["coalesced", "updated"]);
});

test("a second process never breaks a live update lock during a health check longer than 30 seconds", async t => {
  const f = await fixture(t, "connector-cross-process-lock-"), bytes = Buffer.from("export default 'slow';\n");
  const release = advertised(bytes), inputPath = join(f.root, "child-input.json"); let downloads = 0;
  const server = (await import("node:http")).createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    downloads += 1;
    response.writeHead(200, { "content-length": String(bytes.length), "content-type": "text/javascript" });
    response.end(bytes);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const address = server.address(); assert.ok(address && typeof address === "object");
  f.config.server = `http://127.0.0.1:${address.port}`;
  await writeFile(f.configPath, `${JSON.stringify(f.config)}\n`, { mode: 0o600 });
  const childInput = { installRoot: f.installRoot, configPath: f.configPath, advertised: release,
    currentVersion: "1.0.0", healthDelayMs: 35_000 };
  await writeFile(inputPath, `${JSON.stringify(childInput)}\n`, { mode: 0o600 });
  const runChild = () => {
    const child = spawn(process.execPath, ["tests/support/fleet-connector-update-child.mjs", inputPath], {
      cwd: process.cwd(), env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const complete = new Promise((resolveChild, reject) => {
      child.once("error", reject); child.once("close", code => resolveChild({ code, stdout, stderr }));
    });
    return { child, complete };
  };
  const owner = runChild();
  const pendingDeadline = Date.now() + 5_000;
  while (Date.now() < pendingDeadline) {
    try { await readFile(f.paths.pending); break; } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await new Promise(done => setTimeout(done, 20));
  }
  assert.ok(await readFile(f.paths.pending), "the first process reached its slow health check");
  const contenderStarted = Date.now(), contender = runChild();
  const contenderResult = await contender.complete;
  assert.equal(contenderResult.code, 0, contenderResult.stderr);
  assert.deepEqual(JSON.parse(contenderResult.stdout), { ok: false, message: "connector_update_refused:busy" });
  assert.ok(Date.now() - contenderStarted >= 29_000, "the contender waited for the live owner instead of breaking its lock");
  assert.equal(owner.child.exitCode, null, "the owner is still alive after the contender's 30 second deadline");
  const ownerResult = await owner.complete;
  assert.equal(ownerResult.code, 0, ownerResult.stderr);
  assert.deepEqual(JSON.parse(ownerResult.stdout), { ok: true, result: { state: "updated", version: "1.1.0" } });
  assert.equal(downloads, 1); assert.equal(await currentVersion(f), "1.1.0");
});

test("launch never waits for the update lock, verifies bytes and passes its root to the child", async t => {
  const f = await fixture(t), started = Date.now(), calls = []; let childEnv;
  await writeFile(f.paths.lock, JSON.stringify({ pid: process.pid, token: "held", createdAt: Date.now() }), { mode: 0o600 });
  const code = await launchCurrentConnectorV1({ ...f, args: ["mcp"], spawnProcess(_command, args, options) {
    childEnv = options.env;
    calls.push(args); const child = new EventEmitter(); setImmediate(() => child.emit("close", 0, null)); return child;
  } });
  assert.equal(code, 0); assert.ok(Date.now() - started < 1_000); assert.equal(calls.length, 1);
  assert.equal(childEnv.CONTROL_ROOM_CONNECTOR_INSTALL_ROOT, f.installRoot);
  await writeFile(join(f.paths.versions, "1.0.0", "connector.mjs"), "planted\n");
  let fallback;
  assert.equal(await launchCurrentConnectorV1({ ...f, args: ["mcp"], spawnProcess(_command, args) {
    fallback = args[0]; const child = new EventEmitter(); setImmediate(() => child.emit("close", 0, null)); return child;
  } }), 0);
  assert.equal(fallback, f.paths.launcher, "a planted current version must not be executed");
  await rm(f.paths.lock, { force: true });
});

test("run launch relaunches the newly selected version after the dedicated update exit", async t => {
  const f = await fixture(t), bytes = Buffer.from("export const next = true;\n"), release = advertised(bytes);
  await checkForConnectorUpdateV1({ ...f, advertised: release, currentVersion: "1.0.0",
    fetcher: releaseFetcher(bytes), healthCheck: async () => true });
  await writeFile(f.paths.current, `${JSON.stringify({ schema: "control-room.fleet-connector-update-state/v1",
    version: "1.0.0", file: "versions/1.0.0/connector.mjs" })}\n`);
  const targets = [];
  const code = await launchCurrentConnectorV1({ ...f, args: ["run"], spawnProcess(_command, args) {
    targets.push(args[0]); const child = new EventEmitter();
    setImmediate(async () => {
      if (targets.length === 1) {
        await writeFile(f.paths.current, `${JSON.stringify({ schema: "control-room.fleet-connector-update-state/v1",
          version: "1.1.0", file: "versions/1.1.0/connector.mjs" })}\n`);
        child.emit("close", 75, null);
      } else child.emit("close", 0, null);
    });
    return child;
  } });
  assert.equal(code, 0);
  assert.deepEqual(targets, [join(f.paths.versions, "1.0.0", "connector.mjs"),
    join(f.paths.versions, "1.1.0", "connector.mjs")]);
});

test("a dead updater lock is recovered without trusting a symlinked versions directory", async t => {
  const f = await fixture(t), bytes = Buffer.from("export default 'recovered';\n"), release = advertised(bytes);
  await writeFile(f.paths.lock, JSON.stringify({ pid: 999_999_999, token: "dead", createdAt: 0 }), { mode: 0o600 });
  const old = new Date(Date.now() - 60_000); await utimes(f.paths.lock, old, old);
  assert.equal((await checkForConnectorUpdateV1({ ...f, advertised: release, currentVersion: "1.0.0",
    fetcher: releaseFetcher(bytes), healthCheck: async () => true })).state, "updated");

  const hostile = await fixture(t, "connector-symlink-");
  const outside = join(hostile.root, "outside"); await mkdir(outside); await rm(hostile.paths.versions, { recursive: true });
  await symlink(outside, hostile.paths.versions, "dir");
  await assert.rejects(checkForConnectorUpdateV1({ ...hostile, advertised: release, currentVersion: "1.0.0",
    fetcher: releaseFetcher(bytes), healthCheck: async () => true }), /directory/u);
  assert.deepEqual(await readdir(outside), []);
});

test("a reused live PID does not preserve a stale updater lock", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t), bytes = Buffer.from("export default 'pid-reuse';\n"), release = advertised(bytes);
  await writeFile(f.paths.lock, JSON.stringify({ pid: process.pid, token: "old-owner", createdAt: 0,
    identity: "not-this-process-generation" }), { mode: 0o600 });
  const old = new Date(Date.now() - 60_000); await utimes(f.paths.lock, old, old);
  const result = await checkForConnectorUpdateV1({ ...f, advertised: release, currentVersion: "1.0.0",
    fetcher: releaseFetcher(bytes), healthCheck: async () => true });
  assert.equal(result.state, "updated");
});

test("twenty connectors update from one fake gateway without sharing locks or state", async t => {
  const bytes = Buffer.from("export const stressed = true;\n"), release = advertised(bytes), count = { value: 0 };
  const fixtures = [];
  for (let index = 0; index < 20; index += 1) fixtures.push(await fixture(t, `connector-stress-${index}-`));
  const results = await Promise.all(fixtures.map(f => checkForConnectorUpdateV1({ ...f, advertised: release,
    currentVersion: "1.0.0", fetcher: releaseFetcher(bytes, { delay: 5, count }), healthCheck: async () => true })));
  assert.equal(count.value, 20); assert.ok(results.every(value => value.state === "updated"));
  assert.deepEqual(await Promise.all(fixtures.map(currentVersion)), Array(20).fill("1.1.0"));
});

test("version ordering and Windows launch layout reject downgrade tricks without symlinks", async t => {
  assert.equal(compareConnectorVersionsV1("1.10.0", "1.9.9"), 1);
  assert.equal(compareConnectorVersionsV1("2.0.0", "2.0.0"), 0);
  assert.throws(() => compareConnectorVersionsV1("1.0.0-beta", "1.0.0"));
  assert.equal(connectorInstallRootFromConfigPathV1("/config/control-room/bots/test.json",
    { XDG_DATA_HOME: "/separate/data" }, "darwin"), "/separate/data/control-room/mcp");
  assert.equal(connectorInstallRootFromConfigPathV1("/stock/.config/control-room/bots/test.json",
    { HOME: "/stock" }, "darwin"), "/stock/.local/share/control-room/mcp");
  assert.equal(connectorInstallRootFromConfigPathV1("/windows/config/bots/test.json",
    { LOCALAPPDATA: "/windows/local" }, "win32"), "/windows/local/ControlRoom/mcp");
  assert.equal(connectorInstallRootFromConfigPathV1("C:\\Users\\stock\\config\\bots\\test.json",
    { USERPROFILE: "C:\\Users\\stock" }, "win32"), resolve("C:\\Users\\stock", "AppData", "Local", "ControlRoom", "mcp"));
  const root = await mkdtemp(join(tmpdir(), "connector-windows-layout-")); t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.mjs"), shimPath = join(root, "mcp", "bin", "control-room-mcp.cmd");
  await writeFile(sourcePath, "export {};\n");
  const windowsBytes = await readFile(sourcePath);
  const paths = await installConnectorLauncherV1({ installRoot: join(root, "mcp"), sourcePath, version: "1.0.0",
    platform: "win32", nodePath: "C:\\Program Files\\nodejs\\node.exe", shimPath, trust,
    advertisement: advertised(windowsBytes, { version: "1.0.0", file: "connector-1.0.0.mjs" }) });
  assert.match(await readFile(shimPath, "utf8"), /launcher\.mjs" launch mcp %\*/u);
  assert.equal(JSON.parse(await readFile(paths.current, "utf8")).file, "versions/1.0.0/connector.mjs");
  await assert.rejects(installConnectorLauncherV1({ installRoot: join(root, "mcp"), sourcePath, version: "0.9.0",
    platform: "win32", nodePath: "C:\\Program Files\\nodejs\\node.exe", shimPath, trust,
    advertisement: advertised(windowsBytes, { version: "0.9.0", file: "connector-0.9.0.mjs", minVersion: "0.9.0" }) }));
  assert.equal(JSON.parse(await readFile(paths.current, "utf8")).version, "1.0.0", "an older installer cannot lower current");
});

test("one machine-wide trust refuses a second profile with another release key", async t => {
  const root = await mkdtemp(join(tmpdir(), "connector-machine-trust-")); t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "mcp");
  await pinConnectorReleaseTrustV1({ installRoot, trust });
  const attackerKey = stranger.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  await assert.rejects(pinConnectorReleaseTrustV1({ installRoot, trust: { ...trust,
    keyId: releaseKeyIdV1(attackerKey), publicKey: attackerKey } }), /machine_trust_mismatch/u);
  assert.deepEqual(JSON.parse(await readFile(join(installRoot, "release-trust.json"), "utf8")), trust);
});

test("machine-wide trust keeps the highest floor for the same installation key", async t => {
  const root = await mkdtemp(join(tmpdir(), "connector-machine-floor-")); t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "mcp");
  await pinConnectorReleaseTrustV1({ installRoot, trust: { ...trust, versionFloor: "1.2.0" } });
  const stale = await pinConnectorReleaseTrustV1({ installRoot, trust });
  assert.equal(stale.versionFloor, "1.2.0");
  const raised = await pinConnectorReleaseTrustV1({ installRoot, trust: { ...trust, versionFloor: "1.3.0" } });
  assert.equal(raised.versionFloor, "1.3.0");
  assert.equal(JSON.parse(await readFile(join(installRoot, "release-trust.json"), "utf8")).versionFloor, "1.3.0");
});

test("machine-side key rotation is refused without changing the runnable connector", async t => {
  const root = await mkdtemp(join(tmpdir(), "connector-machine-rotation-")); t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(t, "connector-machine-rotation-install-"), installRoot = f.installRoot;
  const oldKeyPath = join(root, "old.pem");
  const nextKeys = generateKeyPairSync("ed25519");
  await writeFile(oldKeyPath, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const nextPublicKey = nextKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const rotation = await createReleaseKeyRotationV1({ currentTrust: trust, toPublicKey: nextPublicKey,
    epoch: 2, versionFloor: "1.1.0", oldPrivateKeyPath: oldKeyPath });
  const rotated = applyReleaseKeyRotationV1(rotation, trust);
  await assert.rejects(pinConnectorReleaseTrustV1({ installRoot, trust: rotated, rotation }), /key_rotation_requires_reinstall/u);
  assert.deepEqual(JSON.parse(await readFile(join(installRoot, "release-trust.json"), "utf8")), trust);
  const emptyInstallRoot = join(root, "empty-machine");
  await assert.rejects(pinConnectorReleaseTrustV1({ installRoot: emptyInstallRoot, trust: rotated, rotation }),
    /key_rotation_requires_reinstall/u);
  await assert.rejects(readFile(join(emptyInstallRoot, "release-trust.json")), error => error?.code === "ENOENT");
  let launched;
  assert.equal(await launchCurrentConnectorV1({ ...f, args: ["mcp"], spawnProcess(_command, args) {
    launched = args[0]; const child = new EventEmitter(); setImmediate(() => child.emit("close", 0, null)); return child;
  } }), 0);
  assert.equal(launched, join(installRoot, "versions", "1.0.0", "connector.mjs"));
});

test("a signed same-key revocation record remains applicable on the machine", async t => {
  const root = await mkdtemp(join(tmpdir(), "connector-machine-revocation-")); t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "mcp"), keyPath = join(root, "key.pem");
  await writeFile(keyPath, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  await pinConnectorReleaseTrustV1({ installRoot, trust });
  const revokedKey = stranger.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const revocations = await createReleaseKeyRevocationsV1({ currentTrust: trust, epoch: 2,
    revokedKeyIds: [releaseKeyIdV1(revokedKey)], privateKeyPath: keyPath });
  const finalTrust = applyReleaseKeyRevocationsV1(revocations, trust);
  await pinConnectorReleaseTrustV1({ installRoot, trust: finalTrust, revocations });
  assert.deepEqual(JSON.parse(await readFile(join(installRoot, "release-trust.json"), "utf8")), finalTrust);
});
