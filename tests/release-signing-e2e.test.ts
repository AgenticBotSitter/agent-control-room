import assert from "node:assert/strict";
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

const uid = process.geteuid?.() ?? 0;
const BUILT_FROM = "a".repeat(40);
const WORKER_ID = `fleet-worker:${"b".repeat(32)}`;

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
    connectorPath, connectorManifestPath: manifestPath, connectorMinVersion: "0.4.0",
    updaterPath, webManifestPath }, { expectedUid: uid });
  return loadFleetConnectorReleaseV1(root, installed.trust);
}

async function startGateway(release: Awaited<ReturnType<typeof loadFleetConnectorReleaseV1>>, releaseTrust: object,
  port = 0, authentication = { credentialDigest: "" }) {
  const store = {
    async enroll(body: Record<string, unknown>) {
      authentication.credentialDigest = String(body.credentialDigest);
      return { workerId: WORKER_ID, displayName: "Signing E2E", projectIds: ["project:e2e"],
        workerKind: body.workerKind, capabilities: ["writing"], credentialExpiresAt: "2099-01-01T00:00:00.000Z",
        replayed: false };
    },
    async authenticate(input: { bearer?: string; declaredWorkerId?: string }) {
      const digest = `sha256:${createHash("sha256").update(input.bearer ?? "").digest("hex")}`;
      if (digest !== authentication.credentialDigest || input.declaredWorkerId !== WORKER_ID) throw new Error("unauthenticated");
      return { workerId: WORKER_ID };
    },
    async heartbeat() { return { displayName: "Signing E2E", operationsMode: "running" }; },
  } as unknown as FleetGatewayStoreV1;
  const handler = createFleetGatewayHandlerV1({ store, releaseTrust: releaseTrust as never,
    connectorRelease: release, onUnexpectedError: () => {} });
  const server = createServer((request, response) => { void handler.handle(request, response); });
  await new Promise<void>(resolveListen => server.listen(port, "127.0.0.1", resolveListen));
  return { server, port: (server.address() as AddressInfo).port,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function stopGateway(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}

test("generated trust signs releases end to end and refuses replay plus gateway key substitution", async t => {
  const root = await mkdtemp(join(tmpdir(), "release-signing-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const protectedRoot = join(root, "install", "Protected"), configDirectory = join(protectedRoot, "config");
  await mkdir(configDirectory, { recursive: true, mode: 0o750 });
  await chmod(protectedRoot, 0o750); await chmod(configDirectory, 0o750);
  const gatewayConfigPath = join(configDirectory, "gateway.json");
  await writeFile(gatewayConfigPath, "{\"schema\":\"control-room.fleet-gateway/v1\"}\n", { mode: 0o640 });
  await chmod(gatewayConfigPath, 0o640);
  const installed = await generateInstallationReleaseKeyV1({ protectedRoot, gatewayConfigPath,
    versionFloor: "0.4.0" }, { expectedUid: uid });

  const bundleRoot = join(root, "embedded-bundle");
  const built = await buildFleetConnectorReleaseForTestV1({ root: bundleRoot, builtFrom: BUILT_FROM,
    releaseTrust: installed.trust });
  const initialBytes = await readFile(join(bundleRoot, built.manifest.file));
  const initialRelease = await signedRelease(join(root, "release-0.4.0"), "0.4.0", initialBytes, installed);
  const updateBytes = Buffer.from(initialBytes.toString("utf8").replaceAll('"0.4.0"', '"0.5.0"'), "utf8");
  const updateRelease = await signedRelease(join(root, "release-0.5.0"), "0.5.0", updateBytes, installed);

  const authentication = { credentialDigest: "" };
  let gateway = await startGateway(initialRelease, installed.trust, 0, authentication);
  const stablePort = gateway.port;
  const bundled = await import(`${pathToFileURL(join(bundleRoot, built.manifest.file)).href}?e2e=${Date.now()}`);
  assert.deepEqual(bundled.embeddedConnectorReleaseTrustV1(), installed.trust);
  const homeDir = join(root, "worker-home"); await mkdir(homeDir, { mode: 0o700 });
  const joined = await bundled.installConnector({ server: gateway.origin, code: `crj_${"J".repeat(43)}`,
    bot: "cursor", name: "e2e", homeDir, platform: "linux", env: {}, sourcePath: join(bundleRoot, built.manifest.file),
    runner: async () => ({ stdout: "", stderr: "" }) });
  let config = await bundled.loadConfig(joined.paths.configPath);

  await stopGateway(gateway.server);
  gateway = await startGateway(updateRelease, installed.trust, stablePort, authentication);
  const advertisedUpdate = (await bundled.createClient(config).heartbeat()).connector;
  const updated = await checkForConnectorUpdateV1({ installRoot: joined.paths.installRoot,
    configPath: joined.paths.configPath, config, advertised: advertisedUpdate, currentVersion: "0.4.0",
    healthCheck: async () => true });
  assert.deepEqual(updated, { state: "updated", version: "0.5.0" });

  await stopGateway(gateway.server);
  gateway = await startGateway(initialRelease, installed.trust, stablePort, authentication);
  config = await bundled.loadConfig(joined.paths.configPath);
  const replay = (await bundled.createClient(config).heartbeat()).connector;
  await assert.rejects(checkForConnectorUpdateV1({ installRoot: joined.paths.installRoot,
    configPath: joined.paths.configPath, config, advertised: replay, currentVersion: "0.5.0",
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
  t.after(() => stopGateway(gateway.server).catch(() => {}));
  await assert.rejects(bundled.join({ server: gateway.origin, code: `crj_${"K".repeat(43)}`, workerKind: "cursor",
    configPath: join(root, "substituted.json") }), /did not provide a valid installation release key/u);
});
