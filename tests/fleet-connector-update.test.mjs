import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkForConnectorUpdateV1, compareConnectorVersionsV1, connectorReleaseSignatureMaterialV1,
  connectorInstallRootFromConfigPathV1, connectorUpdatePathsV1, connectorUpdatesPausedV1, installConnectorLauncherV1,
  recoverPendingConnectorUpdateV1, setConnectorUpdatesPausedV1,
  verifyConnectorReleaseAdvertisementV1 } from "../scripts/fleet/connector-update.mjs";
import { createConnectorReleaseKeyV1 } from "../scripts/fleet/create-connector-release-key.mjs";
import * as connector from "../scripts/fleet/connector.mjs";

const keys = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");

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
  await writeFile(sourcePath, "export const fixture = true;\n", { mode: 0o700 });
  await installConnectorLauncherV1({ installRoot, sourcePath, version: "1.0.0", platform: "linux", shimPath });
  const config = { schema: "control-room.fleet-connector/v1", server: "http://127.0.0.1:1",
    workerId: `fleet-worker:${"a".repeat(32)}`, secret: `crf_${"A".repeat(43)}`, installation: {
      bot: "codex", name: "fixture", workspace: join(root, "work"), state: "installed",
      updates: { releasePublicKey: publicKey, floorVersion: "1.0.0" },
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
  assert.throws(() => verifyConnectorReleaseAdvertisementV1(advertised(bytes, {}, stranger.privateKey), publicKey), /signature/u);
  assert.throws(() => verifyConnectorReleaseAdvertisementV1(advertised(bytes, { size: 16 * 1024 * 1024 + 1 }), publicKey),
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
    fetcher: releaseFetcher(bytes), healthCheck: async () => false });
  assert.deepEqual(failed, { state: "reverted", version: "1.0.0", failedVersion: "1.1.0" });
  assert.equal(await currentVersion(f), "1.0.0");
  const retry = await checkForConnectorUpdateV1({ ...f, advertised: release, currentVersion: "1.0.0",
    fetcher: releaseFetcher(bytes), healthCheck: async () => true });
  assert.deepEqual(retry, { state: "updated", version: "1.1.0" });
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
  assert.equal(connectorInstallRootFromConfigPathV1("/windows/config/bots/test.json",
    { LOCALAPPDATA: "/windows/local" }, "win32"), "/windows/local/ControlRoom/mcp");
  const root = await mkdtemp(join(tmpdir(), "connector-windows-layout-")); t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.mjs"), shimPath = join(root, "mcp", "bin", "control-room-mcp.cmd");
  await writeFile(sourcePath, "export {};\n");
  const paths = await installConnectorLauncherV1({ installRoot: join(root, "mcp"), sourcePath, version: "1.0.0",
    platform: "win32", nodePath: "C:\\Program Files\\nodejs\\node.exe", shimPath });
  assert.match(await readFile(shimPath, "utf8"), /launcher\.mjs" launch mcp %\*/u);
  assert.equal(JSON.parse(await readFile(paths.current, "utf8")).file, "versions/1.0.0/connector.mjs");
  await installConnectorLauncherV1({ installRoot: join(root, "mcp"), sourcePath, version: "0.9.0",
    platform: "win32", nodePath: "C:\\Program Files\\nodejs\\node.exe", shimPath });
  assert.equal(JSON.parse(await readFile(paths.current, "utf8")).version, "1.0.0", "an older installer cannot lower current");
});

test("installation creates one private release key and refuses to replace it", async t => {
  const root = await mkdtemp(join(tmpdir(), "connector-release-key-")); t.after(() => rm(root, { recursive: true, force: true }));
  const privateKeyPath = join(root, "protected", "connector-release.pem");
  const created = await createConnectorReleaseKeyV1({ privateKeyPath });
  assert.equal(createPublicKey({ key: Buffer.from(created.publicKeySpki, "base64url"), format: "der", type: "spki" }).asymmetricKeyType,
    "ed25519");
  if (process.platform !== "win32") assert.equal((await stat(privateKeyPath)).mode & 0o777, 0o600);
  await assert.rejects(createConnectorReleaseKeyV1({ privateKeyPath }), /EEXIST/u);
});
