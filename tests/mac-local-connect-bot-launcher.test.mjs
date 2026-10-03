import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

async function fixture(t) {
  await mkdir(join(process.cwd(), ".test-tmp"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".test-tmp", "connect-bot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Copy the actual entry, rather than reimplementing its URL arithmetic. This
  // is the installed release layout; the signed bundle is outside scripts/.
  const release = join(root, "releases", "0.1.0-fixture"), scripts = join(release, "scripts", "mac-local");
  const shared = join(release, "src", "installer", "shared");
  await mkdir(scripts, { recursive: true }); await mkdir(shared, { recursive: true });
  await copyFile("scripts/mac-local/start-web-host.mjs", join(scripts, "start-web-host.mjs"));
  await copyFile("src/installer/shared/is-main-module.mjs", join(shared, "is-main-module.mjs"));
  const launcher = await import(pathToFileURL(join(scripts, "start-web-host.mjs")).href);
  const protectedRoot = join(root, "Protected"), config = join(protectedRoot, "config", "fleet-gateway.json");
  await mkdir(join(protectedRoot, "config"), { recursive: true });
  const installed = join(release, "dist-vps", "server", "fleet", "release");
  const dev = join(release, "scripts", "fleet", "release");
  const trust = Object.freeze({ keyId: "fixture" }), calls = [], prepared = [];
  let fleetCloses = 0, hostCloses = 0;
  const modules = {
    "macLocalProtectedLoader.js": {
      loadMacLocalProtectedConfigurationFromRootV1: async () => ({}),
      loadWorkIntakeServerConfigurationFromRootV1: async () => undefined,
      loadOwnerWebPushConfigFromRootV1: async () => undefined,
      loadMacLocalDatabaseRolesFromRootV1: async () => ({}),
    },
    "macLocalFleet.js": {
      loadMacLocalFleetReleaseTrustV1: async () => trust,
      async loadMacLocalFleetConnectorReleaseV1(path, givenTrust) {
        calls.push(resolve(path)); assert.equal(givenTrust, trust);
        try { return JSON.parse(await readFile(join(path, "manifest.json"), "utf8")); }
        catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
      },
      prepareMacLocalFleetOwnerV1(input) {
        prepared.push(input);
        return { fleet: {}, async close() { fleetCloses++; } };
      },
    },
    "macLocalHost.js": { createMacLocalProtectedHostV1: () => ({ async start() {
      return { isReady: () => true, async close() { hostCloses++; } };
    } }) },
    "privatePostgres.js": { createPrivatePostgresDatabase() { assert.fail("unit must not open a database"); } },
    "serving.js": { loadPrivateClientAssets: async () => ({}) },
    "index.js": { default() {} },
    "workIntakePrivateService.js": { prepareWorkIntakePrivateServiceV1() {} },
  };
  const start = () => launcher.startMacLocalWebHost({ protectedRoot }, {
    loadHealthProbeKey: async () => Buffer.alloc(32), hostReleaseIdentity: async () => "fixture",
    load: async url => modules[new URL(url).pathname.split("/").at(-1)],
  });
  const connector = async (directory, value) => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "manifest.json"), JSON.stringify(value));
  };
  return { start, modules, calls, prepared, installed, dev, config, connector,
    closes: () => ({ fleet: fleetCloses, host: hostCloses }) };
}

test("C-1: installed launcher prefers the connector beside its built server and forwards the configured gateway port", async t => {
  const f = await fixture(t);
  await f.connector(f.installed, { source: "installed" }); await f.connector(f.dev, { source: "dev" });
  await writeFile(f.config, JSON.stringify({ port: 59891, host: "127.0.0.1" }));
  const active = await f.start();
  try {
    assert.deepEqual(f.calls, [f.installed]);
    assert.deepEqual(f.prepared[0].connectorRelease, { source: "installed" });
    assert.equal(f.prepared[0].gatewayOrigin, "http://127.0.0.1:59891");
  } finally { await active.close(); }
  assert.deepEqual(f.closes(), { fleet: 1, host: 1 });
});

test("C-1: only an undefined installed connector enables the dev fallback; missing config preserves the default", async t => {
  const f = await fixture(t); await f.connector(f.dev, { source: "dev" });
  const active = await f.start();
  try {
    assert.deepEqual(f.calls, [f.installed, f.dev]);
    assert.deepEqual(f.prepared[0].connectorRelease, { source: "dev" });
    assert.equal(Object.hasOwn(f.prepared[0], "gatewayOrigin"), false);
  } finally { await active.close(); }
  await rm(f.dev, { recursive: true });
  const empty = await f.start();
  try { assert.equal(Object.hasOwn(f.prepared[1], "connectorRelease"), false); }
  finally { await empty.close(); }
  f.modules["macLocalFleet.js"].loadMacLocalFleetConnectorReleaseV1 = async path => {
    assert.equal(resolve(path), f.installed); return null;
  };
  const noFallback = await f.start(); await noFallback.close();
});

test("C-1: an invalid installed connector refuses without loading the dev connector or preparing a fleet owner", async t => {
  const f = await fixture(t); await f.connector(f.dev, { source: "dev" });
  await mkdir(f.installed, { recursive: true });
  await writeFile(join(f.installed, "manifest.json"), "bad json");
  await assert.rejects(f.start(), SyntaxError);
  assert.deepEqual(f.calls, [f.installed]); assert.equal(f.prepared.length, 0);
});

test("C-1: gateway config refuses malformed or non-integer/out-of-range ports before database or listeners, then retries", async t => {
  const f = await fixture(t);
  for (const body of ["bad json", "null", "{}", "[]", ...[1023, 65536, 3211.5, "3211", null, true].map(port => JSON.stringify({ port }))]) {
    await writeFile(f.config, body);
    await assert.rejects(f.start(), /mac_local_fleet_gateway_port_invalid/u);
    assert.equal(f.prepared.length, 0);
  }
  // An existing but unreadable-as-a-file configuration is never the dev case.
  await rm(f.config); await mkdir(f.config);
  await assert.rejects(f.start()); assert.equal(f.prepared.length, 0);
  await rm(f.config, { recursive: true });
  for (const port of [1024, 65535]) {
    await writeFile(f.config, JSON.stringify({ port }));
    const active = await f.start();
    try { assert.equal(f.prepared.at(-1).gatewayOrigin, `http://127.0.0.1:${port}`); }
    finally { await active.close(); }
  }
});

test("C-1: 50 concurrent startup callers use the same installed port and each closes its own host and fleet owner", async t => {
  const f = await fixture(t); await f.connector(f.installed, { source: "installed" });
  await writeFile(f.config, JSON.stringify({ port: 3211 }));
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => f.start()));
  try {
    assert.ok(results.every(result => result.status === "fulfilled"));
    assert.equal(f.prepared.length, 50);
    assert.ok(f.prepared.every(input => input.gatewayOrigin === "http://127.0.0.1:3211" && input.connectorRelease.source === "installed"));
    assert.deepEqual(f.calls, Array(50).fill(f.installed));
  } finally { await Promise.all(results.filter(result => result.status === "fulfilled").map(result => result.value.close())); }
  assert.deepEqual(f.closes(), { fleet: 50, host: 50 });
});

test("C-1: a stop during host startup closes the prepared fleet owner and allows a fresh retry", async t => {
  const f = await fixture(t); await writeFile(f.config, JSON.stringify({ port: 3211 }));
  const original = f.modules["macLocalHost.js"].createMacLocalProtectedHostV1;
  f.modules["macLocalHost.js"].createMacLocalProtectedHostV1 = () => ({ async start() { throw new Error("startup stopped"); } });
  await assert.rejects(f.start(), /startup stopped/u);
  assert.deepEqual(f.closes(), { fleet: 1, host: 0 });
  f.modules["macLocalHost.js"].createMacLocalProtectedHostV1 = original;
  const active = await f.start(); await active.close();
  assert.deepEqual(f.closes(), { fleet: 2, host: 1 });
});
