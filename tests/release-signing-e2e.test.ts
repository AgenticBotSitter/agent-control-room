import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createFleetGatewayHandlerV1, type FleetGatewayStoreV1 } from "../src/fleet/v1";
import { buildFleetConnectorReleaseForTestV1 } from "../scripts/build-fleet-connector.mjs";
import { checkForConnectorUpdateV1 } from "../scripts/fleet/connector-update.mjs";
import { loadFleetConnectorReleaseV1 } from "../scripts/run-fleet-gateway";
import { generateInstallationReleaseKeyV1, releaseKeyIdV1, signConnectorReleaseAdvertisementV1,
  signReleaseArtifactsV1 } from "../scripts/release-signing.mjs";
import { recordInstallerInstalledReleaseV1 } from "../src/installer/v1/signed-release-verifier.mjs";
import { FLEET_WORKING_AGREEMENT_METADATA_V1 } from "../src/fleet/v1/working-agreement";

const uid = process.geteuid?.() ?? 0;
const BUILT_FROM = "a".repeat(40);

async function signedRelease(root: string, version: string, connectorBytes: Buffer, installed: Awaited<ReturnType<typeof generateInstallationReleaseKeyV1>>) {
  await mkdir(root, { mode: 0o700 }); await chmod(root, 0o700);
  const connectorPath = join(root, `connector-${version}.mjs`), manifestPath = join(root, "manifest.json");
  await writeFile(connectorPath, connectorBytes);
  const manifest = { schema: "control-room.fleet-connector-release/v1", version,
    file: `connector-${version}.mjs`, sha256: createHash("sha256").update(connectorBytes).digest("hex"),
    size: connectorBytes.length, builtFrom: BUILT_FROM };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const updaterPath = join(root, `updater-${version}.tgz`), webManifestPath = join(root, "web-build-manifest.json");
  await writeFile(updaterPath, `updater ${version}\n`); await writeFile(webManifestPath, "{\"files\":[]}\n");
  await signReleaseArtifactsV1({ releaseDirectory: root, version, configPath: installed.configPath,
    connectorPath, connectorManifestPath: manifestPath, connectorMinVersion: "0.5.0",
    updaterPath, webManifestPath }, { expectedUid: uid });
  return loadFleetConnectorReleaseV1(root, installed.trust);
}

async function startGateway(release: Awaited<ReturnType<typeof loadFleetConnectorReleaseV1>>, releaseTrust: object,
  port = 0, authentication = { credentials: new Map<string, string>(), nextWorker: 1, enrollments: 0 }) {
  const store = {
    async enroll(body: Record<string, unknown>) {
      if (process.env.CONTROL_ROOM_SIGNING_FAIL_AT === "enrollment") throw new Error("signing_fixture_enrollment_failed");
      const workerId = `fleet-worker:${authentication.nextWorker.toString(16).padStart(32, "0")}`;
      authentication.nextWorker += 1; authentication.enrollments += 1;
      authentication.credentials.set(workerId, String(body.credentialDigest));
      return { workerId, displayName: "Signing E2E", projectIds: ["project:e2e"],
        workerKind: body.workerKind, capabilities: ["writing"], credentialExpiresAt: "2099-01-01T00:00:00.000Z",
        replayed: false, workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1 };
    },
    async authenticate(input: { bearer?: string; declaredWorkerId?: string }) {
      const digest = `sha256:${createHash("sha256").update(input.bearer ?? "").digest("hex")}`;
      if (!input.declaredWorkerId || authentication.credentials.get(input.declaredWorkerId) !== digest)
        throw new Error("unauthenticated");
      return { workerId: input.declaredWorkerId };
    },
    me() { return { credentialExpiresAt: "2099-01-01T00:00:00.000Z",
      workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1 }; },
    async heartbeat() { return { workerKind: "cursor", displayName: "Signing E2E", operationsMode: "running",
      workingAgreement: FLEET_WORKING_AGREEMENT_METADATA_V1 }; },
  } as unknown as FleetGatewayStoreV1;
  const handler = createFleetGatewayHandlerV1({ store, releaseTrust: releaseTrust as never,
    connectorRelease: release, onUnexpectedError: error => { if (process.env.CONTROL_ROOM_SIGNING_FAIL_AT === "enrollment") console.error(error); } });
  const server = createServer((request, response) => { void handler.handle(request, response); });
  await new Promise<void>(resolveListen => server.listen(port, "127.0.0.1", resolveListen));
  return { server, port: (server.address() as AddressInfo).port,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function stopGateway(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}

async function waitFor(read: () => Promise<boolean>, message: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise(done => setTimeout(done, 25));
  }
  assert.fail(message);
}

test("generated trust signs install, recorded floor, new joins and self-update end to end", async t => {
  const root = await mkdtemp(join(tmpdir(), "release-signing-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const protectedRoot = join(root, "install", "Protected"), configDirectory = join(protectedRoot, "config");
  await mkdir(configDirectory, { recursive: true, mode: 0o750 });
  await chmod(protectedRoot, 0o750); await chmod(configDirectory, 0o750);
  const gatewayConfigPath = join(configDirectory, "gateway.json");
  await writeFile(gatewayConfigPath, "{\"schema\":\"control-room.fleet-gateway/v1\"}\n", { mode: 0o640 });
  await chmod(gatewayConfigPath, 0o640);
  const installed = await generateInstallationReleaseKeyV1({ protectedRoot, gatewayConfigPath,
    versionFloor: "0.5.0" }, { expectedUid: uid });

  const bundleRoot = join(root, "embedded-bundle");
  const built = await buildFleetConnectorReleaseForTestV1({ root: bundleRoot, builtFrom: BUILT_FROM,
    releaseTrust: installed.trust });
  const initialBytes = await readFile(join(bundleRoot, built.manifest.file));
  const initialRelease = await signedRelease(join(root, "release-0.5.0"), "0.5.0", initialBytes, installed);
  const versionMarker = 'CONNECTOR_VERSION = "0.5.0"';
  assert.equal(initialBytes.toString("utf8").split(versionMarker).length - 1, 1,
    "the E2E changes only the connector version declaration");
  const updateBytes = Buffer.from(initialBytes.toString("utf8").replace(versionMarker,
    'CONNECTOR_VERSION = "0.6.0"'), "utf8");
  const updateRoot = join(root, "release-0.6.0");
  await signedRelease(updateRoot, "0.6.0", updateBytes, installed);

  const authentication = { credentials: new Map<string, string>(), nextWorker: 1, enrollments: 0 };
  let gateway = await startGateway(initialRelease, installed.trust, 0, authentication);
  t.after(async () => { if (gateway.server.listening) await stopGateway(gateway.server); });
  if (process.env.CONTROL_ROOM_TEST_SIGNING_SETUP_FAILURE === "1") throw new Error("signing_setup_failure");
  const stablePort = gateway.port;
  const bundled = await import(`${pathToFileURL(join(bundleRoot, built.manifest.file)).href}?e2e=${Date.now()}`);
  assert.deepEqual(bundled.embeddedConnectorReleaseTrustV1(), installed.trust);
  const homeDir = join(root, "worker-home"); await mkdir(homeDir, { mode: 0o700 });
  const joined = await bundled.installConnector({ server: gateway.origin, code: `crj_${"J".repeat(43)}`,
    bot: "cursor", name: "e2e", homeDir, platform: "linux", env: {}, sourcePath: join(bundleRoot, built.manifest.file),
    runner: async () => ({ stdout: "", stderr: "" }) });
  let config = await bundled.loadConfig(joined.paths.configPath);

  await stopGateway(gateway.server);
  await recordInstallerInstalledReleaseV1({ trustPath: installed.trustPath, installedVersion: "0.6.0" },
    { expectedUid: uid });
  const raisedTrust = JSON.parse(await readFile(installed.trustPath, "utf8"));
  assert.equal(raisedTrust.versionFloor, "0.6.0");
  const updateRelease = await loadFleetConnectorReleaseV1(updateRoot, raisedTrust);
  gateway = await startGateway(updateRelease, raisedTrust, stablePort, authentication);
  if (process.env.CONTROL_ROOM_SIGNING_FAIL_AT === "update") throw new Error("signing_fixture_update_failed");

  const cursor = JSON.parse(await readFile(join(homeDir, ".cursor", "mcp.json"), "utf8"));
  const registered = cursor.mcpServers["control-room-e2e"];
  const shim = spawn(registered.command, registered.args, { detached: false, stdio: ["pipe", "pipe", "pipe"], env: {
    PATH: process.env.PATH, HOME: homeDir, NODE_ENV: "test", CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1",
  } });
  t.after(() => {
    shim.stdin.end();
    shim.kill("SIGKILL");
  });
  if (process.env.CONTROL_ROOM_SIGNING_FAIL_AT === "shim") throw new Error("signing_fixture_shim_failed");
  let shimOutput = "", shimError = "";
  shim.stdout.on("data", chunk => { shimOutput += chunk; }); shim.stderr.on("data", chunk => { shimError += chunk; });
  shim.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18" } })}\n`);
  const currentPath = join(joined.paths.installRoot, "current.json");
  const machineTrustPath = join(joined.paths.installRoot, "release-trust.json");
  await waitFor(async () => JSON.parse(await readFile(currentPath, "utf8")).version === "0.6.0",
    "the stock-HOME MCP shim did not self-update current.json");
  await waitFor(async () => JSON.parse(await readFile(machineTrustPath, "utf8")).versionFloor === "0.6.0",
    "the self-update did not raise the machine floor");
  shim.stdin.end();
  const shimCode = await new Promise<number | null>((resolveClose, reject) => {
    shim.once("error", reject); shim.once("close", resolveClose);
  });
  assert.equal(shimCode, 0, shimError); assert.match(shimOutput, /"control-room"/u);

  const servedPath = join(root, "served-connector-0.6.0.mjs");
  const servedResponse = await fetch(`${gateway.origin}/fleet/v1/connector.mjs`);
  assert.equal(servedResponse.status, 200);
  await writeFile(servedPath, Buffer.from(await servedResponse.arrayBuffer()), { mode: 0o700 });
  const served = await import(`${pathToFileURL(servedPath).href}?served=${Date.now()}`);
  assert.equal(served.CONNECTOR_VERSION, "0.6.0");

  const newHome = join(root, "new-worker-home"); await mkdir(newHome, { mode: 0o700 });
  const newMachine = await served.installConnector({ server: gateway.origin, code: `crj_${"N".repeat(43)}`,
    bot: "cursor", name: "new-machine", homeDir: newHome, platform: "linux", env: {}, sourcePath: servedPath,
    runner: async () => ({ stdout: "", stderr: "" }) });
  assert.equal((await served.loadConfig(newMachine.paths.configPath)).installation.updates.floorVersion, "0.6.0",
    "a newly joined machine receives the recorded floor even though the served bundle embedded the earlier floor");

  const secondBot = await served.installConnector({ server: gateway.origin, code: `crj_${"S".repeat(43)}`,
    bot: "cursor", name: "second-bot", homeDir, platform: "linux", env: {}, sourcePath: servedPath,
    runner: async () => ({ stdout: "", stderr: "" }) });
  assert.equal((await served.loadConfig(secondBot.paths.configPath)).installation.updates.floorVersion, "0.6.0");
  assert.equal(authentication.enrollments, 3);

  config = await bundled.loadConfig(joined.paths.configPath);
  await assert.rejects(checkForConnectorUpdateV1({ installRoot: joined.paths.installRoot,
    configPath: joined.paths.configPath, config, advertised: initialRelease.advertisement, currentVersion: "0.6.0",
    healthCheck: async () => true }), /version_floor/u);
  await stopGateway(gateway.server);

  const attacker = generateKeyPairSync("ed25519"), attackerPrivatePath = join(root, "attacker.pem");
  await writeFile(attackerPrivatePath, attacker.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  await chmod(attackerPrivatePath, 0o600);
  const attackerPublic = attacker.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const attackerTrust = { ...installed.trust, keyId: releaseKeyIdV1(attackerPublic), publicKey: attackerPublic };
  const attackerAdvertisement = await signConnectorReleaseAdvertisementV1({ ...initialRelease.advertisement,
    signature: undefined }, attackerPrivatePath, { expectedUid: uid });
  gateway = await startGateway({ ...initialRelease, advertisement: attackerAdvertisement }, attackerTrust);
  if (process.env.CONTROL_ROOM_SIGNING_FAIL_AT === "attacker") throw new Error("signing_fixture_attacker_failed");
  await assert.rejects(bundled.join({ server: gateway.origin, code: `crj_${"K".repeat(43)}`, workerKind: "cursor",
    configPath: join(root, "substituted.json") }), /did not provide a valid installation release key/u);
});

test("SELFUPD-05: failures close every gateway and shim and the E2E child exits", async t => {
 for (const phase of ["enrollment", "update", "shim", "attacker"]) await t.test(phase, async () => {
  const { NODE_TEST_CONTEXT: _context, ...childEnvironment } = process.env;
  const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-name-pattern=generated trust",
    "tests/release-signing-e2e.test.ts"], { detached: false, stdio: ["ignore", "pipe", "pipe"],
    env: { ...childEnvironment, CONTROL_ROOM_SIGNING_FAIL_AT: phase, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" } });
  let output = "", timer: ReturnType<typeof setTimeout> | undefined;
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  try {
    const result = await Promise.race([
      new Promise<{ code: number | null; signal: string | null }>((resolveExit, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => resolveExit({ code, signal }));
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("E2E leaked its gateway after enrollment failure")), 10_000); }),
    ]);
    assert.equal(result.signal, null); assert.equal(result.code, 1);
    assert.match(output, new RegExp(`signing_fixture_${phase}_failed`, "u"));
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
});
});
