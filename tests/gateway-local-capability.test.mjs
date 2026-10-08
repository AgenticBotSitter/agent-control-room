import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import filesystem from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildAttendedReleaseV1 } from "../src/updater/v1/build-attended-release.mjs";
import { fixture as installerFixture } from "./helpers/installer-round2-fixture.mjs";
import { installControlRoomV1 } from "../src/updater/v1/install/installer.mjs";
import { checkGatewayHealthV1, checkHealthV1 } from "../src/updater/v1/install/health.mjs";

const COMMIT = "a".repeat(40), ID = "1.2.3-aaaaaaaaaaaa", RELEASE = `releases/${ID}`;
const KEY = Buffer.alloc(32, 9), DIGEST = `sha256:${"b".repeat(64)}`;
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
// Literal independent inventory from the reviewed attended builder policy. Setup
// supplies source inputs only; the producer must create the declaration and manifest.
const INPUTS = ["LICENSE", "NOTICE", "THIRD_PARTY.md", "package.json", "pnpm-lock.yaml",
  "deploy/operator-config.mjs", "deploy/agent-task-operator-config.mjs",
  "scripts/prepare-local-installation.mjs", "scripts/prepare-local-production-dependencies.mjs",
  "scripts/launch-local-setup.mjs", "scripts/initialize-local-installation-plan.mjs",
  "scripts/run-local-setup-host.mjs", "scripts/preflight-private-local-owner-host.mjs",
  "scripts/run-private-local-installation-operator.mjs", "scripts/run-private-vps.mjs",
  "scripts/activate-private-vps.mjs", "scripts/bootstrap-private-vps-owner.mjs",
  "scripts/check-private-vps-database.mjs", "deploy/FIRST_ACTIVATION.md",
  "scripts/mac-local/task-host-supervisor.mjs", "scripts/mac-local/stack.mjs",
  "scripts/mac-local/start-task-host.mjs", "scripts/mac-local/start-web-host.mjs",
  "src/installer/shared/is-main-module.mjs", "src/installer/shared/file-custody.mjs",
  "src/installer/shared/private-process-lock.mjs", "src/installer/shared/mac-local-runtime-directory.mjs",
  "src/installer/shared/vapid.mjs", "src/installer/shared/backup-files.mjs",
  "src/installer/shared/nightly-backup-constants.mjs"];
const DIRS = ["db/migrations", "db/roles", "db/setup", "deploy/postgres", "dist-vps/client", "dist-vps/server", "third_party"];

// Synthetic wrong-owner boundary only: this lane cannot chown to a second UID.
// Positive transport/custody cases use the real filesystem and effective UID.
// Installed root custody remains a separately required native observation.
function custodyFilesystem(uid = process.geteuid()) {
  const identity = stat => new Proxy(stat, { get(target, key) {
    return key === "uid" ? uid : typeof target[key] === "function" ? target[key].bind(target) : target[key];
  } });
  return { lstat: async path => identity(await filesystem.lstat(path)),
    open: async (...args) => {
      const handle = await filesystem.open(...args);
      return { stat: async () => identity(await handle.stat()), read: (...values) => handle.read(...values),
        close: () => handle.close() };
    } };
}
async function fixture(t) {
  await filesystem.mkdir(resolve(".test-tmp"), { recursive: true, mode: 0o700 });
  const root = await filesystem.mkdtemp(resolve(".test-tmp/gateway-r1-"));
  t.after(() => filesystem.rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), releaseRoot = join(root, RELEASE);
  await filesystem.mkdir(source); await filesystem.mkdir(releaseRoot, { recursive: true });
  for (const path of INPUTS) {
    await filesystem.mkdir(join(source, path, ".."), { recursive: true });
    await filesystem.writeFile(join(source, path), path === "package.json" ? '{"name":"control-room","version":"1.2.3"}\n' : `${path}\n`);
  }
  for (const path of DIRS) await filesystem.mkdir(join(source, path), { recursive: true });
  const declaration = join(releaseRoot, "gateway-local-capability.json");
  assert.equal(await filesystem.lstat(declaration).then(() => true, () => false), false, "producer starts with no declaration");
  const manifest = await buildAttendedReleaseV1({ source, output: releaseRoot, commit: COMMIT });
  assert.ok(manifest.files.some(value => value.path === "gateway-local-capability.json"),
    "reviewed builder must emit gateway-local-capability.json");
  const original = JSON.parse(await filesystem.readFile(declaration, "utf8"));
  assert.deepEqual(original, { schema: "control-room.gateway-local-capability/v1", commit: COMMIT,
    version: "1.2.3", releaseId: ID, gatewayLocalHost: "127.0.0.1", updaterSupportsGatewayHosts: ["127.0.0.1", "::1"] });
  return { root, source, releaseRoot, declaration, original,
    runtime: { healthProbeKey: KEY } };
}
async function receipt(f, changes = {}, raw) {
  const bytes = Buffer.from(raw ?? `${JSON.stringify({ ...f.original, ...changes })}\n`);
  await filesystem.chmod(f.declaration, 0o600); await filesystem.writeFile(f.declaration, bytes); await filesystem.chmod(f.declaration, 0o400);
  const path = join(f.releaseRoot, "RELEASE_MANIFEST.json"), manifest = JSON.parse(await filesystem.readFile(path, "utf8"));
  const entry = manifest.files.find(value => value.path === "gateway-local-capability.json");
  // Synthetic signed-target fixture: independent literal input is re-signed here
  // by updating the manifest entry, as the real verified staging boundary does.
  entry.sha256 = hash(bytes); entry.bytes = bytes.length;
  await filesystem.chmod(path, 0o600); await filesystem.writeFile(path, JSON.stringify(manifest)); await filesystem.chmod(path, 0o400);
}
async function listener(t, host, kind = "gateway", behavior) {
  const seen = [];
  // Synthetic cryptographic stand-in using the published health HMAC material.
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const { nonce } = JSON.parse(Buffer.concat(chunks).toString("utf8")); seen.push({ url: req.url, nonce, host: req.headers.host });
    if (behavior && await behavior(req, res, nonce)) return;
    const value = kind === "web" ? { schema: "control-room.local-host-health/v1", ready: true, pid: 4242, nonce,
      releaseId: ID, startedAt: "2026-09-30T12:00:00.000Z" } : { schema: "control-room.fleet-gateway-health/v1", ready: true, pid: 4343, nonce };
    const material = kind === "web" ? { nonce, pid: value.pid, purpose: "local-host-health/v1", ready: true,
      releaseId: ID, startedAt: value.startedAt } : { nonce, pid: value.pid, purpose: "fleet-gateway-health/v1", ready: true };
    value.tag = `hmac-sha256:${createHmac("sha256", KEY).update(JSON.stringify(material)).digest("hex")}`;
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value));
  });
  await new Promise((done, fail) => server.once("error", fail).listen(0, host, done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  return { server, seen, port: server.address().port };
}
const input = (f, gatewayPort, webPort = 1) => ({ root: f.root, expectedRelease: RELEASE, gatewayPort, webPort });
async function refuses(f, pattern = /gateway_capability_refused/u) {
  const requests = [];
  await assert.rejects(checkGatewayHealthV1(input(f, 43999), { ...f.runtime, transport: async url => {
    requests.push(url); throw new Error("unexpected request");
  } }), pattern, "invalid declaration must refuse before request");
  assert.deepEqual(requests, [], "no request before capability refusal");
}

async function preSwitchRefusal(t, f, mutateStage) {
  const manifestDigest = hash(await filesystem.readFile(join(f.releaseRoot, "RELEASE_MANIFEST.json")));
  // Synthetic OS/service ports from the existing installer fixture. The real
  // installer transaction and real capability reader execute; no native service.
  const install = await installerFixture(t, "gateway-r1-before-switch", {
    buildResult: async () => ({ source: f.releaseRoot, version: "1.2.3", digest: manifestDigest }),
  });
  if (mutateStage) {
    const stage = install.ports.stageReleaseV1;
    install.ports.stageReleaseV1 = async input => { const result = await stage(input); await mutateStage(result.target); return result; };
  }
  await assert.rejects(installControlRoomV1(install.options), /gateway_capability_refused/u,
    "invalid signed target must refuse in the real installer before switch");
  assert.equal(install.ports.calls.filter(call => call[0] === "switch-pair").length, 0, "no pointer switch on capability refusal");
  assert.equal(await filesystem.readlink(join(install.root, "current")).catch(error => error.code === "ENOENT" ? null : Promise.reject(error)), null);
}

test("R1 signed gateway health accepts legacy target", async t => {
  const f = await fixture(t), server = await listener(t, "127.0.0.1");
  const result = await checkGatewayHealthV1(input(f, server.port), f.runtime); assert.equal(result.pid, 4343);
  await filesystem.rm(f.declaration);
  const beforeMissing = server.seen.length;
  await assert.rejects(checkGatewayHealthV1(input(f, server.port), f.runtime), /gateway_capability_refused/u,
    "manifest-listed missing declaration must refuse before request");
  assert.equal(server.seen.length, beforeMissing, "missing listed bytes cause zero health requests");
  await preSwitchRefusal(t, f);
  // Legacy-on-manifest-absence: OLD installing R1 lists no declaration.
  const manifestPath = join(f.releaseRoot, "RELEASE_MANIFEST.json");
  const manifest = JSON.parse(await filesystem.readFile(manifestPath, "utf8"));
  const removed = manifest.files.find(value => value.path === "gateway-local-capability.json");
  manifest.files = manifest.files.filter(value => value.path !== "gateway-local-capability.json");
  manifest.fileCount--; manifest.byteCount -= removed.bytes;
  await filesystem.chmod(manifestPath, 0o600);
  await filesystem.writeFile(manifestPath, JSON.stringify(manifest));
  await filesystem.chmod(manifestPath, 0o400);
  let legacy;
  await assert.doesNotReject(async () => { legacy = await checkGatewayHealthV1(input(f, server.port), f.runtime); },
    "legacy-on-absence must accept the independently specified IPv4 signed answer");
  assert.equal(legacy.pid, 4343);
  assert.equal(server.seen.length, 2);
  const legacyManifestBytes = await filesystem.readFile(manifestPath);
  for (const changes of [{ schema: "unknown" }, { commit: "c".repeat(40) }, { files: null }]) {
    await filesystem.chmod(manifestPath, 0o600);
    await filesystem.writeFile(manifestPath, JSON.stringify({ ...manifest, ...changes }));
    await filesystem.chmod(manifestPath, 0o400);
    await assert.rejects(checkGatewayHealthV1(input(f, server.port), f.runtime), /gateway_capability_refused/u,
      "legacy absence still requires a valid matching manifest");
    assert.equal(server.seen.length, 2);
  }
  await filesystem.chmod(manifestPath, 0o600);
  await filesystem.writeFile(manifestPath, legacyManifestBytes);
  await filesystem.chmod(manifestPath, 0o400);
  await filesystem.rm(manifestPath);
  let emptyLegacy;
  await assert.doesNotReject(async () => { emptyLegacy = await checkGatewayHealthV1(input(f, server.port), f.runtime); },
    "empty historical staged release must accept the independently specified IPv4 answer");
  assert.equal(emptyLegacy.pid, 4343);
  // Manifest-backed legacy absence still validates parent custody and races.
  await filesystem.writeFile(manifestPath, legacyManifestBytes, { mode: 0o400 });
  await filesystem.chmod(f.releaseRoot, 0o777);
  await assert.rejects(checkGatewayHealthV1(input(f, server.port), f.runtime), /gateway_capability_refused/u,
    "missing declaration cannot bypass parent custody");
  await filesystem.chmod(f.releaseRoot, 0o755);
  const heldEntry = await filesystem.lstat(join(f.releaseRoot, "LICENSE"));
  let absentReads = 0;
  await assert.rejects(checkGatewayHealthV1(input(f, server.port), { ...f.runtime,
    capabilityFileSystem: { ...filesystem, lstat: async path => {
      // Synthetic scheduling boundary replaying a recorded real file stat.
      if (path === f.declaration && ++absentReads > 1) return heldEntry;
      return filesystem.lstat(path);
    } },
  }), /gateway_capability_refused/u, "declaration appearing during legacy validation must refuse");
  let parentReads = 0;
  await assert.rejects(checkGatewayHealthV1(input(f, server.port), { ...f.runtime,
    capabilityFileSystem: { ...filesystem, lstat: async path => {
      const entry = await filesystem.lstat(path);
      if (path === f.releaseRoot && ++parentReads > 1) {
        return new Proxy(entry, { get(target, key) {
          return key === "mtimeMs" ? target.mtimeMs + 1
            : typeof target[key] === "function" ? target[key].bind(target) : target[key];
        } });
      }
      return entry;
    } },
  }), /gateway_capability_refused/u, "legacy parent changed during validation must refuse");
  const noRoot = await checkGatewayHealthV1({ gatewayPort: server.port, webPort: 1 }, { healthProbeKey: KEY });
  assert.equal(noRoot.pid, 4343);
  const policy = join(f.source, "src/updater/v1/policy/gateway-local-origin.json");
  await filesystem.mkdir(join(policy, ".."), { recursive: true });
  await filesystem.writeFile(policy, '{"schema":"control-room.gateway-local-host/v1","gatewayLocalHost":"::1"}\n');
  const futureOutput = join(f.root, "future"); await filesystem.mkdir(futureOutput);
  await buildAttendedReleaseV1({ source: f.source, output: futureOutput, commit: COMMIT });
  assert.equal(JSON.parse(await filesystem.readFile(join(futureOutput, "gateway-local-capability.json"))).gatewayLocalHost, "::1",
    "running R1 builder derives future host from fixed verified-source policy");
});

test("R1 signed gateway health accepts IPv6 target", async t => {
  const f = await fixture(t); await receipt(f, { gatewayLocalHost: "::1" });
  const server = await listener(t, "::1");
  for (const count of [20, 50]) {
    let results;
    await assert.doesNotReject(async () => {
      results = await Promise.all(Array.from({ length: count }, () => checkGatewayHealthV1(input(f, server.port), f.runtime)));
    }, "verified IPv6 target must accept its own signed answer");
    assert.equal(results.length, count); assert.ok(results.every(value => value.pid === 4343));
  }
  assert.equal(server.seen.length, 70); assert.equal(new Set(server.seen.map(value => value.nonce)).size, 70);
  assert.ok(server.seen.every(value => value.host === `[::1]:${server.port}`));
});

test("R1 health refuses cross-address answers without fallback", async t => {
  const f = await fixture(t); await receipt(f, { gatewayLocalHost: "::1" });
  const wrong = await listener(t, "127.0.0.1");
  await assert.rejects(checkGatewayHealthV1(input(f, wrong.port), { ...f.runtime, timeoutMs: 150 }), /health_gateway_refused/u);
  assert.equal(wrong.seen.length, 0, "failed IPv6 must never try IPv4");
  let mode = "redirect";
  const selected = await listener(t, "::1", "gateway", async (_req, res) => {
    if (mode === "redirect") { res.writeHead(307, { location: `http://127.0.0.1:${wrong.port}/fleet/v1/local-health` }); res.end(); return true; }
    if (mode === "oversize") { res.writeHead(200, { "content-type": "application/json", "content-length": "4097" }); res.end("x".repeat(4097)); return true; }
    if (mode === "stalled") { res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders(); return true; }
    if (mode === "drop") { res.destroy(); return true; }
    return false;
  });
  for (mode of ["redirect", "oversize", "stalled", "drop"]) {
    await assert.rejects(checkGatewayHealthV1(input(f, selected.port), { ...f.runtime, timeoutMs: 150 }), /health_(?:gateway_refused|web_response_too_large)/u);
    assert.equal(wrong.seen.length, 0);
  }
  mode = "healthy"; assert.equal((await checkGatewayHealthV1(input(f, selected.port), f.runtime)).pid, 4343);
  await receipt(f, { gatewayLocalHost: "127.0.0.1" });
  const reverseWrong = await listener(t, "::1");
  await assert.rejects(checkGatewayHealthV1(input(f, reverseWrong.port), { ...f.runtime, timeoutMs: 150 }), /health_gateway_refused/u);
  assert.equal(reverseWrong.seen.length, 0, "failed IPv4 must never try IPv6");
  const reverseSelected = await listener(t, "127.0.0.1", "gateway", async (_req, res) => {
    res.writeHead(307, { location: `http://[::1]:${reverseWrong.port}/fleet/v1/local-health` }); res.end(); return true;
  });
  await assert.rejects(checkGatewayHealthV1(input(f, reverseSelected.port), f.runtime), /health_gateway_refused/u);
  assert.equal(reverseWrong.seen.length, 0, "an IPv4 request cannot accept a redirected IPv6 answer");
});

test("unknown target origin refuses before request", async t => {
  const f = await fixture(t);
  for (const host of ["localhost", "http://127.0.0.1:43999", "127.0.0.1:43999", "[::1]", "::ffff:127.0.0.1", "0.0.0.0", " ::1", "::1 ", "é", "", null]) {
    await receipt(f, { gatewayLocalHost: host }); await refuses(f);
  }
  await receipt(f, { gatewayLocalHost: "localhost" }); await preSwitchRefusal(t, f);
});

test("malformed or duplicate capability receipt refuses before request", async t => {
  const f = await fixture(t);
  for (const changes of [{ extra: true }, { schema: "unknown" }, { updaterSupportsGatewayHosts: ["::1"] }, { updaterSupportsGatewayHosts: ["::1", "127.0.0.1"] }]) {
    await receipt(f, changes); await refuses(f);
  }
  for (const raw of ["{", "null", "[]", JSON.stringify(f.original).replace('"schema":', '"gatewayLocalHost":"::1","schema":'),
    JSON.stringify(f.original).replace('"schema":', '"gatewayLocal\\u0048ost":"::1","schema":'), " ".repeat(4097)]) {
    await receipt(f, {}, raw); await refuses(f);
  }
  await receipt(f, { extra: true }); await preSwitchRefusal(t, f);
  const policy = join(f.source, "src/updater/v1/policy/gateway-local-origin.json");
  await filesystem.mkdir(join(policy, ".."), { recursive: true });
  for (const [index, bytes] of [
    '{"schema":"control-room.gateway-local-host/v1","gatewayLocalHost":"localhost"}\n',
    '{"schema":"control-room.gateway-local-host/v1","gatewayLocalHost":"::1","extra":1}\n',
    '{"schema":"control-room.gateway-local-host/v1","gatewayLocalHost":"::1","gatewayLocalHost":"127.0.0.1"}\n',
  ].entries()) {
    await filesystem.writeFile(policy, bytes);
    const output = join(f.root, `bad-policy-${index}`); await filesystem.mkdir(output);
    await assert.rejects(buildAttendedReleaseV1({ source: f.source, output, commit: COMMIT }), /updater_gateway_host_refused/u);
  }
});

test("mismatched release receipt refuses before request", async t => {
  const f = await fixture(t);
  for (const changes of [{ commit: "c".repeat(40) }, { releaseId: "another-release" }, { version: "2.0.0" }]) {
    await receipt(f, changes); await refuses(f);
  }
  await receipt(f); await filesystem.chmod(f.declaration, 0o600);
  await filesystem.writeFile(f.declaration, JSON.stringify({ ...f.original, gatewayLocalHost: "::1" })); await filesystem.chmod(f.declaration, 0o400);
  await refuses(f);
  await preSwitchRefusal(t, f);
  await receipt(f);
  await preSwitchRefusal(t, f, async target => {
    const manifestPath = join(target, "RELEASE_MANIFEST.json");
    const bytes = await filesystem.readFile(manifestPath);
    await filesystem.chmod(manifestPath, 0o600); await filesystem.writeFile(manifestPath, Buffer.concat([bytes, Buffer.from(" ")]));
    await filesystem.chmod(manifestPath, 0o440);
  });
});

test("untrusted capability custody refuses before request", async t => {
  const f = await fixture(t); await filesystem.chmod(f.declaration, 0o600); await refuses(f);
  await filesystem.chmod(f.declaration, 0o400);
  const originalRuntime = f.runtime; f.runtime = { ...f.runtime, capabilityFileSystem: custodyFilesystem(process.geteuid() + 1) }; await refuses(f); f.runtime = originalRuntime;
  const saved = f.declaration + ".saved"; await filesystem.rename(f.declaration, saved); await filesystem.symlink(saved, f.declaration); await refuses(f);
  await filesystem.rm(f.declaration); await filesystem.link(saved, f.declaration); await refuses(f);
  await filesystem.rm(f.declaration); await filesystem.rename(saved, f.declaration);
  await filesystem.chmod(f.releaseRoot, 0o777); await refuses(f); await filesystem.chmod(f.releaseRoot, 0o700);
  await preSwitchRefusal(t, f, async target => {
    await filesystem.chmod(join(target, "gateway-local-capability.json"), 0o600);
  });
  const target = f.releaseRoot + ".saved"; await filesystem.rename(f.releaseRoot, target); await filesystem.symlink(target, f.releaseRoot); await refuses(f);
});

test("R1 health leaves web IPv4 and route dormant", async t => {
  const f = await fixture(t); await receipt(f, { gatewayLocalHost: "::1" });
  const gateway = await listener(t, "::1"), web = await listener(t, "127.0.0.1", "web");
  const routeActions = [], result = await checkHealthV1({ ...input(f, gateway.port, web.port), pgDataId: "data-one",
    schemaDigest: DIGEST, updaterSchemaDigest: DIGEST }, {
    readCurrentRelease: async () => RELEASE,
    checkDatabase: async () => ({ healthy: true, schemaDigest: DIGEST, updaterSchemaDigest: DIGEST }),
    // Historical installer Serve actions are outside this reader's seam.
    routeGateway: async value => routeActions.push(value),
  }, { ...f.runtime, delay: async () => {} });
  assert.deepEqual(result, { healthy: true, samples: 3, schemaDigest: DIGEST });
  assert.equal(web.seen.length, 3); assert.equal(gateway.seen.length, 3); assert.deepEqual(routeActions, []);
  assert.ok(web.seen.every(value => value.host === `127.0.0.1:${web.port}`));
});
