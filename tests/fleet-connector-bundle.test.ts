import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { assertFleetConnectorBundledLicensesV1, assertFleetConnectorBundleImportsV1,
  buildFleetConnectorReleaseForTestV1 } from "../scripts/build-fleet-connector.mjs";
import { loadFleetConnectorReleaseV1 } from "../scripts/run-fleet-gateway";
import { createFleetGatewayHandlerV1, type FleetGatewayStoreV1 } from "../src/fleet/v1";
import { captureFleetConnectorReleaseManifestV1 } from "../src/fleet/v1/connector-release";
import { FLEET_CONNECTOR_INSTALLER_CHECK_BASE64_V1 } from "../src/web/v1/fleet-owner-http";
import { connectorReleaseSignatureMaterialV1, releaseKeyIdV1,
  RELEASE_TRUST_SCHEMA_V1 } from "../scripts/release-signing.mjs";
import { FLEET_WORKING_AGREEMENT_METADATA_V1 } from "../src/fleet/v1/working-agreement";
import { loadMacLocalFleetConnectorReleaseV1,
  loadMacLocalFleetReleaseTrustV1 } from "../src/fleet/v1/mac-local-composition";

const builtFrom = "1".repeat(40);
let sandbox: string, firstRoot: string, secondRoot: string;
let release: Awaited<ReturnType<typeof buildFleetConnectorReleaseForTestV1>>;
const releaseKeys = generateKeyPairSync("ed25519");
const releasePublicKey = releaseKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const releaseTrust = Object.freeze({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1,
  keyId: releaseKeyIdV1(releasePublicKey), publicKey: releasePublicKey, versionFloor: "0.4.0", revokedKeyIds: [] });

async function writeAdvertisement(root: string, built: Awaited<ReturnType<typeof buildFleetConnectorReleaseForTestV1>>) {
  const unsigned = { version: built.manifest.version, file: built.manifest.file, sha256: built.manifest.sha256,
    size: built.manifest.size, builtFrom: built.manifest.builtFrom, minVersion: "0.4.0" };
  const advertisement = { ...unsigned,
    signature: sign(null, connectorReleaseSignatureMaterialV1(unsigned), releaseKeys.privateKey).toString("base64url") };
  await writeFile(join(root, "connector-release.json"), `${JSON.stringify(advertisement, null, 2)}\n`);
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "fleet-bundle-test-"));
  firstRoot = join(sandbox, "first"); secondRoot = join(sandbox, "second");
  release = await buildFleetConnectorReleaseForTestV1({ root: firstRoot, builtFrom, releaseTrust });
  const second = await buildFleetConnectorReleaseForTestV1({ root: secondRoot, builtFrom, releaseTrust });
  await writeAdvertisement(firstRoot, release); await writeAdvertisement(secondRoot, second);
});
after(async () => { if (sandbox) await rm(sandbox, { recursive: true, force: true }); });

function child(executable: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const process = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { process.kill("SIGKILL"); reject(new Error("child timed out")); }, 10_000);
    process.stdout.on("data", chunk => { stdout += chunk; });
    process.stderr.on("data", chunk => { stderr += chunk; });
    process.once("error", reject);
    process.once("close", code => { clearTimeout(timer); done({ code, stdout, stderr }); });
    process.stdin.end(options.input ?? "");
  });
}

test("connector build is byte-identical and its manifest binds version, size, digest and source commit", async () => {
  const firstBundle = await readFile(join(firstRoot, release.manifest.file));
  const secondBundle = await readFile(join(secondRoot, release.manifest.file));
  assert.deepEqual(firstBundle, secondBundle);
  assert.deepEqual(await readFile(join(firstRoot, "manifest.json")), await readFile(join(secondRoot, "manifest.json")));
  assert.equal(release.manifest.size, firstBundle.length);
  assert.equal(release.manifest.sha256, createHash("sha256").update(firstBundle).digest("hex"));
  assert.equal(release.manifest.builtFrom, builtFrom);
  assert.match(firstBundle.toString("utf8"), /createFleetHarnessAdapter/u, "the harness adapters are in the one file");
  assert.match(firstBundle.toString("utf8"), /Bundled third-party licence notice: zod@4\.1\.12/u);
  assert.match(firstBundle.toString("utf8"), /Copyright \(c\) 2025 Colin McDonnell/u);
  assert.match(firstBundle.toString("utf8"), /Permission is hereby granted, free of charge/u);
  const connector = await import(`${pathToFileURL(join(firstRoot, release.manifest.file)).href}?trust-test=1`);
  assert.deepEqual(connector.embeddedConnectorReleaseTrustV1(), releaseTrust);
  assert.throws(() => assertFleetConnectorBundleImportsV1({ outputs: { out: { imports: [
    { path: "left-in-worker-package", external: true },
  ] } } }), /fleet_connector_build_refused/u);
  assert.doesNotThrow(() => assertFleetConnectorBundleImportsV1({ outputs: { out: { imports: [
    { path: "node:crypto", external: true },
  ] } } }));
  assert.doesNotThrow(() => assertFleetConnectorBundledLicensesV1({ inputs: {
    "node_modules/.pnpm/zod@4.1.12/node_modules/zod/index.js": {},
  } }));
  assert.throws(() => assertFleetConnectorBundledLicensesV1({ inputs: {
    "node_modules/.pnpm/other@1.0.0/node_modules/other/index.js": {},
  } }), /fleet_connector_build_refused/u);
});

test("Mac-local release loading pins one protected trust and refuses a substituted trust file", async t => {
  const protectedRoot = join(sandbox, "protected-release-trust"), configRoot = join(protectedRoot, "config");
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  await chmod(protectedRoot, 0o700); await chmod(configRoot, 0o700);
  const trustPath = join(configRoot, "release-trust.json");
  // Root-owned installation trust can be service-group readable. A disposable
  // trust owned by the test user must stay owner-only under the same loader policy.
  const trustMode = process.getuid?.() === 0 ? 0o640 : 0o600;
  await writeFile(trustPath, `${JSON.stringify(releaseTrust)}\n`, { mode: trustMode }); await chmod(trustPath, trustMode);
  const loadedTrust = await loadMacLocalFleetReleaseTrustV1(protectedRoot);
  assert.deepEqual(loadedTrust, releaseTrust);
  const loadedRelease = await loadMacLocalFleetConnectorReleaseV1(firstRoot, loadedTrust);
  assert.equal(loadedRelease?.advertisement.sha256, release.manifest.sha256);
  const otherKeys = generateKeyPairSync("ed25519");
  const otherKey = otherKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const otherTrust = { ...releaseTrust, keyId: releaseKeyIdV1(otherKey), publicKey: otherKey };
  const mismatchedRoot = join(sandbox, "mismatched-embedded-key"); await mkdir(mismatchedRoot);
  await copyFile(join(firstRoot, "manifest.json"), join(mismatchedRoot, "manifest.json"));
  await copyFile(join(firstRoot, release.manifest.file), join(mismatchedRoot, release.manifest.file));
  const unsigned = { version: release.manifest.version, file: release.manifest.file, sha256: release.manifest.sha256,
    size: release.manifest.size, builtFrom: release.manifest.builtFrom, minVersion: "0.4.0" };
  const mismatchedAdvertisement = { ...unsigned,
    signature: sign(null, connectorReleaseSignatureMaterialV1(unsigned), otherKeys.privateKey).toString("base64url") };
  await writeFile(join(mismatchedRoot, "connector-release.json"), `${JSON.stringify(mismatchedAdvertisement)}\n`);
  await assert.rejects(loadMacLocalFleetConnectorReleaseV1(mismatchedRoot, otherTrust), /fleet_connector_release_refused/u);

  const realTrustPath = join(configRoot, "real-release-trust.json");
  await writeFile(realTrustPath, `${JSON.stringify(releaseTrust)}\n`, { mode: 0o640 });
  await unlink(trustPath); await symlink(realTrustPath, trustPath);
  await assert.rejects(loadMacLocalFleetReleaseTrustV1(protectedRoot), /mac_local_fleet_release_trust_refused/u);
  t.after(() => rm(trustPath, { force: true }));
});

test("Mac-local release loading treats a built-but-unsigned connector as no release yet, not a malformed one", async () => {
  // `mac:up` can build a bare connector bundle + manifest entirely on its own (it has
  // no private signing key), but `connector-release.json` is only ever written by the
  // separate owner-attended `release:sign` step. A standalone machine that never ran
  // that step must still start the web host in "web-only" mode (codes still work),
  // exactly like the already-covered case of no manifest.json at all.
  const unsignedRoot = join(sandbox, "built-but-unsigned");
  await mkdir(unsignedRoot);
  await copyFile(join(firstRoot, "manifest.json"), join(unsignedRoot, "manifest.json"));
  await copyFile(join(firstRoot, release.manifest.file), join(unsignedRoot, release.manifest.file));
  assert.equal(await loadMacLocalFleetConnectorReleaseV1(unsignedRoot, releaseTrust), undefined);
});

test("standalone bundle runs help and an MCP handshake from a repo-free directory with a fake gateway", async t => {
  const runRoot = join(sandbox, "empty-machine"), injectedHome = join(sandbox, "injected-home");
  await mkdir(runRoot); await mkdir(injectedHome);
  const bundle = join(runRoot, release.manifest.file);
  await copyFile(join(firstRoot, release.manifest.file), bundle);
  const help = await child(process.execPath, [bundle, "--help"], { cwd: runRoot,
    env: { PATH: process.env.PATH, HOME: injectedHome, NODE_ENV: "test" } });
  assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /Control Room worker connector/u);

  let requests = 0;
  const gateway: Server = createServer((_request, response) => { requests += 1; response.writeHead(500); response.end(); });
  await new Promise<void>(done => gateway.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => gateway.close(() => done())));
  const credentialDirectory = join(sandbox, "credentials");
  await mkdir(credentialDirectory);
  const config = join(credentialDirectory, "connector.json");
  await writeFile(config, JSON.stringify({ schema: "control-room.fleet-connector/v1",
    server: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
    workerId: `fleet-worker:${"a".repeat(32)}`, secret: `crf_${"A".repeat(43)}` }), { mode: 0o600 });
  await chmod(config, 0o600);
  // cook/connect made the workspace explicit and required, so the bundled
  // server can never fall back to the process working directory. Opus review
  // round 2 section 4 requires this explicit, absolute, existing check.
  const handshake = await child(process.execPath,
    [bundle, "mcp", "--config", config, "--workspace", runRoot], { cwd: runRoot,
    env: { PATH: process.env.PATH, HOME: injectedHome, NODE_ENV: "test" },
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n` });
  assert.equal(handshake.code, 0, handshake.stderr);
  const reply = JSON.parse(handshake.stdout.trim());
  assert.equal(reply.result.serverInfo.name, "control-room"); assert.equal(requests, 0);
});

test("a default-home install runs its registered MCP shim end to end", async t => {
  const home = join(sandbox, "default-home-install"); await mkdir(home);
  const advertisement = JSON.parse(await readFile(join(firstRoot, "connector-release.json"), "utf8"));
  const gateway = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    for await (const _chunk of request) { /* drain request */ }
    const result = path === "/fleet/v1/enroll" ? { workerId: `fleet-worker:${"a".repeat(32)}`,
      displayName: "Default home", projectIds: ["project:test"], workerKind: "cursor", capabilities: ["writing"],
      credentialExpiresAt: "2099-01-01T00:00:00.000Z", releaseTrust, connector: advertisement,
      workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1 }
      : path === "/fleet/v1/heartbeat" ? { displayName: "Default home", workerKind: "cursor", operationsMode: "running", connector: advertisement,
        workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1 }
        : path === "/fleet/v1/me" ? { displayName: "Default home", connector: advertisement, releaseTrust,
          workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1 }
          : null;
    response.writeHead(result ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(result ? { ok: true, result } : { ok: false, error: "not_found" }));
  });
  await new Promise<void>(done => gateway.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => gateway.close(() => done())));
  const server = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  const bundle = join(firstRoot, release.manifest.file);
  const installed = await child(process.execPath, [bundle, "install", "--server", server,
    "--code", `crj_${"A".repeat(43)}`, "--bot", "cursor", "--name", "default", "--i-am-the-installer"], {
    env: { PATH: process.env.PATH, HOME: home, NODE_ENV: "test", CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" },
  });
  assert.equal(installed.code, 0, installed.stderr);
  const cursor = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8"));
  const registered = cursor.mcpServers["control-room-default"];
  const shim = await child(registered.command, registered.args, { env: { PATH: process.env.PATH, HOME: home,
    NODE_ENV: "test", CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" },
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n` });
  assert.equal(shim.code, 0, shim.stderr);
  assert.equal(JSON.parse(shim.stdout.trim()).result.serverInfo.name, "control-room");
});

test("an enrolled gateway cannot substitute the release key embedded in the bundle", async t => {
  const attacker = generateKeyPairSync("ed25519");
  const attackerPublicKey = attacker.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const attackerTrust = { ...releaseTrust, keyId: releaseKeyIdV1(attackerPublicKey), publicKey: attackerPublicKey };
  const unsigned = JSON.parse(await readFile(join(firstRoot, "connector-release.json"), "utf8"));
  delete unsigned.signature;
  const attackerAdvertisement = { ...unsigned,
    signature: sign(null, connectorReleaseSignatureMaterialV1(unsigned), attacker.privateKey).toString("base64url") };
  const gateway = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    if (new URL(request.url ?? "/", "http://fixture.invalid").pathname === "/fleet/v1/connector-manifest.json") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: { workerId: `fleet-worker:${"b".repeat(32)}`,
      displayName: "Hostile gateway", projectIds: [], workerKind: "cursor", capabilities: [],
      credentialExpiresAt: "2099-01-01T00:00:00.000Z", releaseTrust: attackerTrust,
      connector: attackerAdvertisement } }));
  });
  await new Promise<void>(done => gateway.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => gateway.close(() => done())));
  const home = join(sandbox, "substituted-key-home"); await mkdir(home);
  const result = await child(process.execPath, [join(firstRoot, release.manifest.file), "install", "--server",
    `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`, "--code", `crj_${"B".repeat(43)}`,
    "--bot", "cursor", "--name", "hostile", "--i-am-the-installer"], {
    env: { PATH: process.env.PATH, HOME: home, NODE_ENV: "test", CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" },
  });
  assert.equal(result.code, 1); assert.match(result.stderr, /valid installation release key/u);
});

test("a connector from another Control Room is refused before its join code is redeemed", async t => {
  const home = join(sandbox, "cross-control-room-home"); await mkdir(home);
  const advertisement = JSON.parse(await readFile(join(firstRoot, "connector-release.json"), "utf8"));
  let enrollments = 0;
  const firstGateway = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    if (path === "/fleet/v1/enroll") enrollments += 1;
    const result = path === "/fleet/v1/enroll" ? { workerId: `fleet-worker:${"c".repeat(32)}`,
      displayName: "First Control Room", projectIds: [], workerKind: "cursor", capabilities: [],
      credentialExpiresAt: "2099-01-01T00:00:00.000Z", releaseTrust, connector: advertisement,
      workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1 }
      : path === "/fleet/v1/heartbeat" ? { displayName: "First Control Room", workerKind: "cursor", operationsMode: "running",
        workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1 } : null;
    response.writeHead(result ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(result ? { ok: true, result } : { ok: false, error: "not_found" }));
  });
  await new Promise<void>(done => firstGateway.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => firstGateway.close(() => done())));
  const firstOrigin = `http://127.0.0.1:${(firstGateway.address() as AddressInfo).port}`;
  const first = await child(process.execPath, [join(firstRoot, release.manifest.file), "install", "--server", firstOrigin,
    "--code", `crj_${"C".repeat(43)}`, "--bot", "cursor", "--name", "first", "--i-am-the-installer"], {
    env: { PATH: process.env.PATH, HOME: home, NODE_ENV: "test", CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" },
  });
  assert.equal(first.code, 0, first.stderr); assert.equal(enrollments, 1);

  const otherKeys = generateKeyPairSync("ed25519");
  const otherPublicKey = otherKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const otherTrust = { ...releaseTrust, keyId: releaseKeyIdV1(otherPublicKey), publicKey: otherPublicKey };
  const otherRoot = join(sandbox, "other-control-room-bundle");
  const otherRelease = await buildFleetConnectorReleaseForTestV1({ root: otherRoot, builtFrom, releaseTrust: otherTrust });
  const second = await child(process.execPath, [join(otherRoot, otherRelease.manifest.file), "install", "--server", firstOrigin,
    "--code", `crj_${"D".repeat(43)}`, "--bot", "cursor", "--name", "second", "--i-am-the-installer"], {
    env: { PATH: process.env.PATH, HOME: home, NODE_ENV: "test", CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" },
  });
  assert.equal(second.code, 1); assert.match(second.stderr, /different Control Room.*Reinstalling/u);
  assert.equal(enrollments, 1, "the second Control Room's join code was not sent or spent");
});

test("bundled harness adapter needs no checkout module path", async () => {
  const connector = await import(`${pathToFileURL(join(firstRoot, release.manifest.file)).href}?adapter-test=1`);
  const settingsPath = join(sandbox, "bundled-harnesses.json");
  await writeFile(settingsPath, JSON.stringify({ schema: "control-room.fleet-harnesses/v1", harnesses: {
    codex: { enabled: true, executablePath: "/usr/bin/true", workingDirectory: sandbox, deadlineMs: 1000 },
  } }), { mode: 0o600 });
  await chmod(settingsPath, 0o600);
  const settings = await connector.loadHarnessSettings(settingsPath);
  const adapter = await connector.loadHarnessAdapter(settings, "codex");
  assert.equal(typeof adapter.execute, "function");
  assert.equal(settings.adapterModule, null);
});

test("installer check refuses a tampered bundle, then accepts an intact retry", async () => {
  const bundle = join(firstRoot, release.manifest.file), manifest = join(firstRoot, "manifest.json");
  const check = ["-e", `eval(Buffer.from('${FLEET_CONNECTOR_INSTALLER_CHECK_BASE64_V1}','base64').toString())`,
    bundle, manifest, release.manifest.version!, release.manifest.sha256, String(release.manifest.size), release.manifest.builtFrom];
  const altered = join(sandbox, "tampered.mjs");
  const alteredBytes = Buffer.from(await readFile(bundle)); alteredBytes[alteredBytes.length - 2] ^= 1;
  await writeFile(altered, alteredBytes);
  const refused = await child(process.execPath, [...check.slice(0, 2), altered, ...check.slice(3)]);
  assert.equal(refused.code, 1); assert.match(refused.stderr, /Nothing was installed/u);
  const accepted = await child(process.execPath, check);
  assert.equal(accepted.code, 0, accepted.stderr);
});

test("gateway serves only the captured bundle and manifest through a burst, a dropped caller and a retry", async t => {
  const captured = await loadFleetConnectorReleaseV1(firstRoot, releaseTrust);
  const otherKeys = generateKeyPairSync("ed25519");
  const otherPublicKey = otherKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const wrongEmbeddedRoot = join(sandbox, "wrong-embedded-key");
  const wrongEmbedded = await buildFleetConnectorReleaseForTestV1({ root: wrongEmbeddedRoot, builtFrom,
    releaseTrust: { ...releaseTrust, keyId: releaseKeyIdV1(otherPublicKey), publicKey: otherPublicKey } });
  await writeAdvertisement(wrongEmbeddedRoot, wrongEmbedded);
  await assert.rejects(loadFleetConnectorReleaseV1(wrongEmbeddedRoot, releaseTrust), /fleet_connector_release_refused/u,
    "gateway startup must refuse a signed bundle embedding another installation key");
  const changedBundle = Buffer.from(captured.bundle); changedBundle[changedBundle.length - 2] ^= 1;
  const corruptRoot = join(sandbox, "corrupt-release"); await mkdir(corruptRoot);
  await copyFile(join(firstRoot, "manifest.json"), join(corruptRoot, "manifest.json"));
  await writeFile(join(corruptRoot, captured.manifest.file), changedBundle);
  await copyFile(join(firstRoot, "connector-release.json"), join(corruptRoot, "connector-release.json"));
  await assert.rejects(loadFleetConnectorReleaseV1(corruptRoot, releaseTrust), /fleet_connector_release_refused/u);
  const wrongSignatureRoot = join(sandbox, "wrong-signature-release"); await mkdir(wrongSignatureRoot);
  await copyFile(join(firstRoot, "manifest.json"), join(wrongSignatureRoot, "manifest.json"));
  await copyFile(join(firstRoot, captured.manifest.file), join(wrongSignatureRoot, captured.manifest.file));
  const signatureRecord = JSON.parse(await readFile(join(firstRoot, "connector-release.json"), "utf8"));
  signatureRecord.signature = `${signatureRecord.signature[0] === "A" ? "B" : "A"}${signatureRecord.signature.slice(1)}`;
  await writeFile(join(wrongSignatureRoot, "connector-release.json"), `${JSON.stringify(signatureRecord)}\n`);
  await assert.rejects(loadFleetConnectorReleaseV1(wrongSignatureRoot, releaseTrust), /fleet_connector_release_refused/u);
  assert.throws(() => createFleetGatewayHandlerV1({ store: {} as FleetGatewayStoreV1,
    releaseTrust, connectorRelease: { ...captured, bundle: changedBundle } }),
  /fleet_connector_release_refused/u);
  assert.throws(() => createFleetGatewayHandlerV1({ store: {} as FleetGatewayStoreV1,
    releaseTrust, connectorRelease: { ...captured, manifest: { ...captured.manifest, builtFrom: "2".repeat(40) } } }),
  /fleet_connector_release_refused/u);
  assert.throws(() => captureFleetConnectorReleaseManifestV1({ ...captured.manifest, extra: true }),
    /fleet_connector_release_refused/u);
  const handler = createFleetGatewayHandlerV1({ store: {} as FleetGatewayStoreV1, releaseTrust, connectorRelease: captured });
  const server = createServer((request, response) => { void handler.handle(request, response); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const port = (server.address() as AddressInfo).port, origin = `http://127.0.0.1:${port}`;
  const responses = await Promise.all(Array.from({ length: 40 }, (_, index) => fetch(`${origin}/fleet/v1/${index % 2
    ? release.manifest.file : "connector-manifest.json"}`)));
  assert.ok(responses.every(response => response.status === 200));
  for (let index = 0; index < responses.length; index += 1) {
    if (index % 2) assert.equal((await responses[index]!.arrayBuffer()).byteLength, release.manifest.size);
    else assert.deepEqual(await responses[index]!.json(), release.manifest);
  }
  const dropped = netConnect(port, "127.0.0.1", () => {
    dropped.write(`GET /fleet/v1/${release.manifest.file} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`); dropped.destroy();
  });
  await new Promise<void>(done => dropped.once("close", () => done()));
  const retry = await fetch(`${origin}/fleet/v1/${release.manifest.file}`);
  assert.equal(retry.status, 200); assert.equal((await retry.arrayBuffer()).byteLength, release.manifest.size);

  const withoutRelease = createFleetGatewayHandlerV1({ store: {} as FleetGatewayStoreV1, releaseTrust });
  const absentServer = createServer((request, response) => { void withoutRelease.handle(request, response); });
  await new Promise<void>(done => absentServer.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => absentServer.close(() => done())));
  const absentPort = (absentServer.address() as AddressInfo).port;
  assert.equal((await fetch(`http://127.0.0.1:${absentPort}/fleet/v1/connector-manifest.json`)).status, 404);
});

test("build CLI refuses an injected real home without the installer acknowledgement", async () => {
  const home = join(sandbox, "real-home");
  await mkdir(home);
  const result = await child(process.execPath, [resolve("scripts/build-fleet-connector.mjs"), "--root", home], {
    env: { PATH: process.env.PATH, HOME: home, NODE_ENV: "test" }, cwd: sandbox });
  assert.equal(result.code, 1); assert.match(result.stderr, /build refused/u);
  assert.deepEqual(await readdir(home), []);
});

test("build CLI refuses to claim HEAD when tracked or untracked checkout input is dirty", async () => {
  const dirty = resolve(`scripts/fleet/.connector-dirty-test-${process.pid}`);
  await writeFile(dirty, "export const dirty = true;\n");
  let result;
  try {
    result = await child(process.execPath, [resolve("scripts/build-fleet-connector.mjs"), "--root", join(sandbox, "dirty-build")]);
  } finally {
    await unlink(dirty);
  }
  assert.equal(result.code, 1); assert.match(result.stderr, /build refused/u);
});
