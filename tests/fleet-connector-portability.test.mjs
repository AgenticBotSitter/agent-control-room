import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as c from "../scripts/fleet/connector.mjs";
import * as s from "../scripts/release-signing.mjs";
import { buildFleetConnectorReleaseForTestV1 } from "../scripts/build-fleet-connector.mjs";

const keys = generateKeyPairSync("ed25519");
function trustFor(key = keys, versionFloor = "0.5.0") {
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return { schema: s.RELEASE_TRUST_SCHEMA_V1, epoch: 1, keyId: s.releaseKeyIdV1(publicKey),
    publicKey, versionFloor, revokedKeyIds: [] };
}
const trust = trustFor(), agreement = { version: c.WORKING_AGREEMENT.version, digest: c.WORKING_AGREEMENT.digest,
  startsWork: false, grantsAuthority: false };
function advertisement(key = keys, version = "0.5.0") {
  const value = { version, file: `connector-${version}.mjs`, sha256: createHash("sha256").update("fixture").digest("hex"),
    size: 7, builtFrom: "a".repeat(40), minVersion: "0.5.0" };
  return { ...value, signature: sign(null, s.connectorReleaseSignatureMaterialV1(value), key.privateKey).toString("base64url") };
}
const workerId = `fleet-worker:${"a".repeat(32)}`;
const me = () => ({ workerId, workerKind: "codex", releaseTrust: trust, connector: advertisement(), workingAgreement: agreement });
const reply = value => new Response(JSON.stringify({ ok: true, result: value }));
const unauthenticated = () => new Response(JSON.stringify({ ok: false, error: "unauthenticated" }), { status: 401 });
async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "connector-portability-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t, extra = {}) {
  const root = await temporary(t), configPath = join(root, "bot.json");
  const config = { schema: "control-room.fleet-connector/v1", server: "https://old.example", workerId,
    workerKind: "codex", secret: c.newSecret(), credentialExpiresAt: "2099-01-01T00:00:00.000Z",
    updates: c.connectorUpdateSettingsFromReleaseTrustV1(trust), ...extra };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  return { root, configPath, config };
}
const sink = { out: { write() {} }, err: { write() {} } };
// r6kfix's POSIX rotation lock keeps ONE permanent kernel-lock inode beside the
// profile (`<profile>.rotate.lock.guard`, empty, never removed by design; see its
// own fleet-connector-round2 listings). Everything else must still be exactly the
// profile: no temporary, backup or lock directory may be left behind.
const besideProfile = async (root, profile = "bot.json") =>
  (await readdir(root)).filter(name => name !== `${profile}.rotate.lock.guard`);

test("R5V-02: actual dispatcher repoints with only the new gateway and preserves the profile", async t => {
  const { root, configPath, config } = await fixture(t, { safetyHalt: true,
    installation: { bot: "codex", name: "fixture", workspace: "/fixture/work", unattended: true,
      updates: c.connectorUpdateSettingsFromReleaseTrustV1(trust) } });
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push(String(url));
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, `Bearer ${config.secret}`);
    assert.equal(init.headers["x-control-room-worker"], workerId);
    return reply({ ...me(), credentialExpiresAt: "2026-10-09T00:00:00.000Z" });
  };
  assert.equal(await c.main(["set-server", "https://new.example/", "--config", configPath], sink,
    { fetcher, installRoot: root }), 0);
  // The repoint adopts the new gateway's credential expiry, not the old one.
  assert.deepEqual(await c.loadConfig(configPath),
    { ...config, server: "https://new.example", credentialExpiresAt: "2026-10-09T00:00:00.000Z" });
  assert.deepEqual(calls, ["https://new.example/fleet/v1/me"]);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.deepEqual(await besideProfile(root), ["bot.json"]);
  let help = "";
  await c.main(["help"], { ...sink, out: { write(value) { help += value; } } });
  assert.match(help, /set-server <address>/u);
});

test("R5V-02: invalid commands, URLs, pending enrollment and absent pins never contact a gateway", async t => {
  for (const [name, argv, extra, expected] of [
    ["unknown", ["setserver", "https://new.example"], {}, 2],
    ["missing address", ["set-server"], {}, 1],
    ["extra address", ["set-server", "https://new.example", "extra"], {}, 1],
    ["downgrade", ["set-server", "http://public.example"], {}, 1],
    ["userinfo", ["set-server", "https://user:password@new.example"], {}, 1],
    ["path", ["set-server", "https://new.example/path"], {}, 1],
    ["pending enrollment", ["set-server", "https://new.example"], { workerId: null }, 1],
    ["no pin", ["set-server", "https://new.example"], { updates: undefined }, 1],
  ]) await t.test(name, async t => {
    const { root, configPath } = await fixture(t, extra), before = await readFile(configPath);
    let calls = 0;
    assert.equal(await c.main([...argv, "--config", configPath], sink, { installRoot: root,
      fetcher: async () => { calls++; return reply(me()); } }), expected);
    assert.equal(calls, 0);
    assert.deepEqual(await readFile(configPath), before);
    assert.deepEqual(await besideProfile(root), ["bot.json"]);
  });
  const root = await temporary(t);
  await assert.rejects(c.setServer({ server: "https://new.example", configPath: join(root, "missing.json") }), /has not joined/u);
  // The refusal is read under the rotation lock, so only that lock's permanent inode may exist.
  assert.deepEqual(await besideProfile(root, "missing.json"), []);
});

test("R5V-02: failed verification or write preserves exact credentials and allows retry", async t => {
  const otherKeys = generateKeyPairSync("ed25519");
  for (const [name, fetcher, options] of [
    ["different trust", async () => reply({ ...me(), releaseTrust: trustFor(otherKeys), connector: advertisement(otherKeys) })],
    ["different trust with pinned signature", async () => reply({ ...me(), releaseTrust: trustFor(otherKeys) })],
    ["bad signature", async () => reply({ ...me(), connector: advertisement(otherKeys) })],
    ["missing trust", async () => reply({ ...me(), releaseTrust: undefined })],
    ["missing release", async () => reply({ ...me(), connector: undefined })],
    ["wrong worker", async () => reply({ ...me(), workerId: `fleet-worker:${"b".repeat(32)}` })],
    ["wrong kind", async () => reply({ ...me(), workerKind: "hermes" })],
    ["agreement drift", async () => reply({ ...me(), workingAgreement: { ...agreement, digest: "wrong" } })],
    ["unauthenticated", async () => unauthenticated()],
    ["dropped connection", async () => { throw new TypeError("connection dropped"); }],
    ["slow aborted connection", async (_url, init) => { assert.ok(init.signal); throw new DOMException("aborted", "AbortError"); }],
    ["write failure", async () => reply(me()), { writeConfig: async () => { throw new Error("injected write failure"); } }],
  ]) await t.test(name, async t => {
    const { root, configPath } = await fixture(t), before = await readFile(configPath);
    await assert.rejects(c.setServer({ server: "https://new.example", configPath, fetcher, ...options }));
    assert.deepEqual(await readFile(configPath), before);
    assert.deepEqual(await besideProfile(root), ["bot.json"]);
    await c.setServer({ server: "https://new.example", configPath, fetcher: async () => reply(me()) });
    assert.equal((await c.loadConfig(configPath)).server, "https://new.example");
  });
});

test("R5V-02: machine floor and bundled key remain authoritative", async t => {
  const { root, configPath } = await fixture(t);
  await writeFile(join(root, "release-trust.json"), JSON.stringify(trustFor(keys, "0.6.0")));
  await assert.rejects(c.setServer({ server: "https://new.example", configPath, installRoot: root,
    fetcher: async () => reply(me()) }), /version_floor/u);
  const otherKeys = generateKeyPairSync("ed25519"), otherTrust = trustFor(otherKeys);
  await writeFile(join(root, "release-trust.json"), JSON.stringify(otherTrust));
  let calls = 0;
  await assert.rejects(c.setServer({ server: "https://new.example", configPath, installRoot: root,
    fetcher: async () => { calls++; return reply(me()); } }), /machine_trust_mismatch/u);
  assert.equal(calls, 0);
  // A lower machine floor must not erase a profile's higher floor.
  await writeFile(join(root, "release-trust.json"), JSON.stringify(trust));
  const config = await c.loadConfig(configPath);
  await writeFile(configPath, JSON.stringify({ ...config, updates: c.connectorUpdateSettingsFromReleaseTrustV1(trustFor(keys, "0.6.0")) }));
  await assert.rejects(c.setServer({ server: "https://new.example", configPath, installRoot: root,
    fetcher: async () => reply(me()) }), /version_floor/u);
  await writeFile(configPath, JSON.stringify(config));
  const built = await buildFleetConnectorReleaseForTestV1({ root: join(root, "bundle"), builtFrom: "a".repeat(40), releaseTrust: otherTrust });
  const bundled = await import(pathToFileURL(join(root, "bundle", built.manifest.file)).href);
  await assert.rejects(bundled.setServer({ server: "https://new.example", configPath,
    fetcher: async () => { calls++; return reply(me()); } }), /different Control Room/u);
  assert.equal(calls, 0);
  const higher = await buildFleetConnectorReleaseForTestV1({ root: join(root, "higher-bundle"), builtFrom: "a".repeat(40),
    releaseTrust: trustFor(keys, "0.6.0") });
  const higherBundled = await import(pathToFileURL(join(root, "higher-bundle", higher.manifest.file)).href);
  await assert.rejects(higherBundled.setServer({ server: "https://new.example", configPath,
    fetcher: async () => reply(me()) }), /version_floor/u);
});

test("R5V-02: pending renewal never masks a transient failure or sends an invalid pending key", async t => {
  for (const [pendingSecret, first] of [[c.newSecret(), new Response(JSON.stringify({ ok: false, error: "unavailable" }), { status: 503 })],
    ["invalid", unauthenticated()]]) {
    const { configPath } = await fixture(t, { pendingSecret }), before = await readFile(configPath);
    let calls = 0;
    await assert.rejects(c.setServer({ server: "https://new.example", configPath, fetcher: async () => {
      calls++; return calls === 1 ? first : reply(me());
    } }));
    assert.equal(calls, 1);
    assert.deepEqual(await readFile(configPath), before);
  }
});

test("R5V-02: pending renewal is resolved at the new endpoint with no intermediate write", async t => {
  for (const usePending of [false, true]) {
    const pendingSecret = c.newSecret(), { configPath, config } = await fixture(t, { pendingSecret });
    const calls = [];
    await c.setServer({ server: "https://new.example", configPath, fetcher: async (url, init) => {
      assert.equal(String(url), "https://new.example/fleet/v1/me");
      const key = init.headers.authorization.slice(7); calls.push(key);
      return usePending && key === config.secret ? unauthenticated() : reply(me());
    } });
    assert.deepEqual(calls, usePending ? [config.secret, pendingSecret] : [config.secret]);
    const { pendingSecret: _pending, ...rest } = config;
    assert.deepEqual(await c.loadConfig(configPath), { ...rest, server: "https://new.example",
      secret: usePending ? pendingSecret : config.secret });
  }
});

test("R5V-02: 50 repoints and a queued rotation serialize without losing the new credential", async t => {
  const { configPath, config } = await fixture(t);
  let active = 0, peak = 0, digest = c.sha256(config.secret);
  const fetcher = async (url, init) => {
    active++; peak = Math.max(peak, active);
    try {
      assert.equal(c.sha256(init.headers.authorization.slice(7)), digest);
      await new Promise(done => setTimeout(done, 2));
      if (new URL(url).pathname === "/fleet/v1/rotate") {
        digest = JSON.parse(init.body).newCredentialDigest;
        return reply({ credentialExpiresAt: "2099-02-01T00:00:00.000Z" });
      }
      return reply(me());
    } finally { active--; }
  };
  await Promise.all([...Array.from({ length: 50 }, () => c.setServer({ server: "https://new.example", configPath,
    fetcher, lock: { deadlineMs: 30_000 } })), c.rotate({ configPath, fetcher, lock: { deadlineMs: 30_000 } })]);
  const current = await c.loadConfig(configPath);
  assert.equal(peak, 1);
  assert.equal(current.server, "https://new.example");
  assert.equal(c.sha256(current.secret), digest);
  assert.notEqual(current.secret, config.secret);
  assert.equal(current.pendingSecret, undefined);
});

test("R5V-02: killing a repoint during verification preserves the old file and a retry recovers its lock", async t => {
  const { root, configPath } = await fixture(t), before = await readFile(configPath), ready = join(root, "ready");
  const script = `import { setServer } from ${JSON.stringify(pathToFileURL(resolve("scripts/fleet/connector.mjs")).href)};
    import { writeFile } from "node:fs/promises";
    setInterval(() => {}, 1000);
    await setServer({ server: "https://new.example", configPath: ${JSON.stringify(configPath)},
      fetcher: async () => { await writeFile(${JSON.stringify(ready)}, "ready"); await new Promise(() => {}); } });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { detached: true, stdio: "ignore" });
  const exited = new Promise(done => child.once("exit", done));
  try {
    for (let i = 0; i < 200 && !(await stat(ready).catch(() => null)); i++) await new Promise(done => setTimeout(done, 10));
    assert.ok(await stat(ready).catch(() => null), "child reached verification while holding the credential lock");
    process.kill(-child.pid, "SIGKILL");
    await exited;
    assert.deepEqual(await readFile(configPath), before);
    await c.setServer({ server: "https://new.example", configPath, fetcher: async () => reply(me()), lock: { staleMs: 0 } });
    assert.equal((await c.loadConfig(configPath)).server, "https://new.example");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await exited;
  }
});

// Parse the renderer's quoted argv and apply documented systemd substitutions.
// This is a command-semantics simulation, not a native service-manager test.
function systemdArguments(unit) {
  const line = unit.split("\n").find(line => line.startsWith("ExecStart=")).slice("ExecStart=".length);
  return [...line.matchAll(/"((?:\\.|[^"\\])*)"/gu)].map(match => match[1]
    .replace(/\\([\\"])/gu, "$1").replace(/%%/gu, "%")
    .replace(/\$\$|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/gu, value => value === "$$" ? "$" : ""));
}
test("R5V-03: systemd argv preserves dollars, variables, percents, spaces, quotes and backslashes", () => {
  const paths = c.connectorInstallPaths({ homeDir: '/fixture/${UNSET}/$HOME/price$5/%d/space "quote"/back\\slash',
    platform: "linux", env: {}, name: "literal" });
  const nodePath = '/fixture/${NODE}/%n/space "quote"/back\\slash/node';
  assert.deepEqual(systemdArguments(c.connectorServiceDefinition(paths, { platform: "linux", nodePath })),
    [nodePath, paths.connectorPath, "launch", "run", "--profile", "literal", "--config", paths.configPath,
      "--harnesses", paths.harnessesPath, "--service-log", paths.serviceLogPath]);
  assert.ok(c.connectorServiceDefinition(paths, { platform: "darwin", nodePath }).includes("${UNSET}"));
});

test("R5V-04: real command wrapper accepts fake systemctl exit-4 not-found and repeated cleanup", async t => {
  const root = await temporary(t), paths = c.connectorInstallPaths({ homeDir: root, platform: "linux", env: {}, name: "absent" });
  await mkdir(dirname(paths.servicePath), { recursive: true });
  await writeFile(paths.servicePath, c.connectorServiceDefinition(paths, { platform: "linux" }));
  const stub = join(root, "systemctl");
  await writeFile(stub, '#!/bin/sh\nif [ "$2" = "is-enabled" ]; then echo not-found; exit 4; fi\nexit 0\n');
  await chmod(stub, 0o700);
  const env = { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1", CONTROL_ROOM_TEST_SERVICE_CLI_DIR: root };
  await c.uninstallConnectorService(paths, { platform: "linux", env, ownerUid: 501 });
  await assert.rejects(stat(paths.servicePath), error => error.code === "ENOENT");
  await c.uninstallConnectorService(paths, { platform: "linux", env, ownerUid: 501 });
  await writeFile(paths.servicePath, "foreign unit\n");
  await assert.rejects(c.uninstallConnectorService(paths, { platform: "linux", env, ownerUid: 501 }), /unrecognized/u);
  assert.equal(await readFile(paths.servicePath, "utf8"), "foreign unit\n");
});

test("R5V-04: missing manager, wrong exit and other failures retain the owned definition", async t => {
  for (const [platform, error] of [["linux", Object.assign(new Error("spawn systemctl ENOENT"), { code: "ENOENT" })],
    ["linux", Object.assign(new Error("not-found"), { exitCode: 1, stdout: "not-found" })],
    ["linux", Object.assign(new Error("permission denied"), { exitCode: 4, stderr: "permission denied" })],
    ["darwin", Object.assign(new Error("not-found"), { exitCode: 4, stdout: "not-found" })]]) {
    const root = await temporary(t), paths = c.connectorInstallPaths({ homeDir: root, platform, env: {}, name: "refused" });
    await mkdir(dirname(paths.servicePath), { recursive: true });
    const body = c.connectorServiceDefinition(paths, { platform });
    await writeFile(paths.servicePath, body);
    await assert.rejects(c.uninstallConnectorService(paths, { platform, ownerUid: 501,
      runner: async () => { throw error; } }));
    assert.equal(await readFile(paths.servicePath, "utf8"), body);
  }
});
