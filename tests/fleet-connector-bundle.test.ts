import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
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

const builtFrom = "1".repeat(40);
let sandbox: string, firstRoot: string, secondRoot: string;
let release: Awaited<ReturnType<typeof buildFleetConnectorReleaseForTestV1>>;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "fleet-bundle-test-"));
  firstRoot = join(sandbox, "first"); secondRoot = join(sandbox, "second");
  release = await buildFleetConnectorReleaseForTestV1({ root: firstRoot, builtFrom });
  await buildFleetConnectorReleaseForTestV1({ root: secondRoot, builtFrom });
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

test("standalone bundle runs help and an MCP handshake from a repo-free directory with a fake gateway", async t => {
  const runRoot = join(sandbox, "empty-machine");
  await mkdir(runRoot);
  const bundle = join(runRoot, release.manifest.file);
  await copyFile(join(firstRoot, release.manifest.file), bundle);
  const help = await child(process.execPath, [bundle, "--help"], { cwd: runRoot,
    env: { PATH: process.env.PATH, HOME: join(sandbox, "injected-home"), NODE_ENV: "test" } });
  assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /Control Room worker connector/u);

  let requests = 0;
  const gateway: Server = createServer((_request, response) => { requests += 1; response.writeHead(500); response.end(); });
  await new Promise<void>(done => gateway.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => gateway.close(() => done())));
  const config = join(sandbox, "connector.json");
  await writeFile(config, JSON.stringify({ schema: "control-room.fleet-connector/v1",
    server: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
    workerId: `fleet-worker:${"a".repeat(32)}`, secret: `crf_${"A".repeat(43)}` }), { mode: 0o600 });
  await chmod(config, 0o600);
  // cook/connect made the workspace explicit and required, so the bundled
  // server can never fall back to the process working directory. Opus review
  // round 2 section 4 requires this explicit, absolute, existing check.
  const handshake = await child(process.execPath,
    [bundle, "mcp", "--config", config, "--workspace", runRoot], { cwd: runRoot,
    env: { PATH: process.env.PATH, HOME: join(sandbox, "injected-home"), NODE_ENV: "test" },
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n` });
  assert.equal(handshake.code, 0, handshake.stderr);
  const reply = JSON.parse(handshake.stdout.trim());
  assert.equal(reply.result.serverInfo.name, "control-room"); assert.equal(requests, 0);
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
  const captured = await loadFleetConnectorReleaseV1(firstRoot);
  const changedBundle = Buffer.from(captured.bundle); changedBundle[changedBundle.length - 2] ^= 1;
  const corruptRoot = join(sandbox, "corrupt-release"); await mkdir(corruptRoot);
  await copyFile(join(firstRoot, "manifest.json"), join(corruptRoot, "manifest.json"));
  await writeFile(join(corruptRoot, captured.manifest.file), changedBundle);
  await assert.rejects(loadFleetConnectorReleaseV1(corruptRoot), /fleet_connector_release_refused/u);
  assert.throws(() => createFleetGatewayHandlerV1({ store: {} as FleetGatewayStoreV1,
    connectorRelease: { ...captured, bundle: changedBundle } }),
  /fleet_connector_release_refused/u);
  assert.throws(() => createFleetGatewayHandlerV1({ store: {} as FleetGatewayStoreV1,
    connectorRelease: { ...captured, manifest: { ...captured.manifest, builtFrom: "2".repeat(40) } } }),
  /fleet_connector_release_refused/u);
  assert.throws(() => captureFleetConnectorReleaseManifestV1({ ...captured.manifest, extra: true }),
    /fleet_connector_release_refused/u);
  const handler = createFleetGatewayHandlerV1({ store: {} as FleetGatewayStoreV1, connectorRelease: captured });
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

  const withoutRelease = createFleetGatewayHandlerV1({ store: {} as FleetGatewayStoreV1 });
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
