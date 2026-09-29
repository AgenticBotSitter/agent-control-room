import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { prepareLocalInstallationPackageV1 } from "../src/installer/v1/local-installation-package";

const ownerUid = process.getuid?.() ?? -1;
const fixtureOperatorCli = "export {};\n";
const fixtureOperatorRunner = "export {};\n";

async function release(t: import("node:test").TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-local-installer-")));
  const paths = ["deploy", "dist-vps/client", "dist-vps/server", "scripts"];
  await Promise.all(paths.map(path => mkdir(join(root, path), { recursive: true })));
  const files: Record<string, string> = {
    "deploy/operator-config.mjs": "export const createConfiguration = () => ({});\n",
    "deploy/agent-task-operator-config.mjs": "export const createConfiguration = () => ({});\n",
    "dist-vps/client/favicon.svg": "<svg/>\n",
    "dist-vps/client/vinext-client-entry-manifest.json": "{}\n",
    "dist-vps/server/index.js": "export default {};\n",
    "dist-vps/server/runtime.js": "export {};\n",
    "dist-vps/server/serving.js": "export {};\n",
    "dist-vps/server/taskApplication.js": "export {};\n",
    "dist-vps/server/agentTaskOperator.js": "export {};\n",
    "dist-vps/server/privateLocalInstallationOperatorCli.js": fixtureOperatorCli,
    "package.json": JSON.stringify({ name: "control-room", version: "0.1.0", packageManager: "pnpm@11.19.0", engines: { node: ">=22.13.0" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "RELEASE_MANIFEST.json": "{\"schema\":\"fixture\"}\n",
    "scripts/prepare-local-installation.mjs": await readFile("scripts/prepare-local-installation.mjs", "utf8"),
    "scripts/run-private-vps.mjs": "export {};\n",
    "scripts/run-private-local-installation-operator.mjs": fixtureOperatorRunner,
    "src/installer/v1/local-installation-release.mjs": await readFile("src/installer/v1/local-installation-release.mjs", "utf8"),
  };
  await mkdir(join(root, "src/installer/v1"), { recursive: true });
  await Promise.all(Object.entries(files).map(([path, contents]) => writeFile(join(root, path), contents)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function serviceDefinition(root: string) {
  const protectedRoot = join(root, "protected");
  const logs = join(protectedRoot, "logs");
  await mkdir(logs, { recursive: true });
  await Promise.all([chmod(root, 0o700), chmod(protectedRoot, 0o700), chmod(logs, 0o700)]);
  const configurationPath = join(protectedRoot, "operator.mjs");
  await writeFile(configurationPath, "export {};\n", { mode: 0o600 });
  return { label: "xyz.agentcontrolroom.local", nodePath: await realpath(process.execPath),
    launcherPath: join(root, "scripts/run-private-vps.mjs"), configurationPath,
    workingDirectory: root, standardOutPath: join(logs, "service.out.log"),
    standardErrorPath: join(logs, "service.err.log"), releaseRoot: root, protectedRoot, ownerUid };
}

test("installer validates a built bundle and reports only safe next steps", async t => {
  const root = await release(t);
  const report = await prepareLocalInstallationPackageV1({ releaseRoot: root });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.bundle.state, "fingerprinted");
  assert.equal(report.bundle.version, "0.1.0");
  assert.ok(report.bundle.fileCount >= 10);
  assert.match(report.bundle.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(report.releaseManifestDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(report.service.state, "awaiting_owner_setup");
  assert.equal(report.startsService, false);
  assert.equal(report.createsDatabase, false);
  assert.equal(report.writesCredentials, false);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("installer reuses service preflight but never installs the service", async t => {
  const root = await release(t);
  const definition = await serviceDefinition(root);
  await assert.rejects(prepareLocalInstallationPackageV1({ releaseRoot: root,
    serviceDefinition: definition }), /refused/);
  const report = await prepareLocalInstallationPackageV1({ releaseRoot: root,
    serviceDefinition: definition, ownerAttended: true });
  assert.equal(report.service.state, "validated_not_installed");
  assert.equal(report.startsService, false);
  assert.equal(report.readyForOwnerSetup, true);
});

test("installer refuses altered or linked bundle inputs", async t => {
  const root = await release(t);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "control-room", version: "0.1.0", packageManager: "pnpm@12.0.0", engines: { node: ">=22.13.0" } }));
  await assert.rejects(prepareLocalInstallationPackageV1({ releaseRoot: root }), /refused/);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "control-room", version: "0.1.0", packageManager: "pnpm@11.19.0", engines: { node: ">=22.13.0" } }));
  const target = join(root, "real-index.js");
  await writeFile(target, "export {};\n");
  await rm(join(root, "dist-vps/server/index.js"));
  await symlink(target, join(root, "dist-vps/server/index.js"));
  await assert.rejects(prepareLocalInstallationPackageV1({ releaseRoot: root }), /refused/);
});

test("installer requires the compiled operator CLI and runner as unchanged regular release assets", async t => {
  const root = await release(t);
  const cli = join(root, "dist-vps/server/privateLocalInstallationOperatorCli.js");
  const runner = join(root, "scripts/run-private-local-installation-operator.mjs");

  await rm(cli);
  await assert.rejects(prepareLocalInstallationPackageV1({ releaseRoot: root }), /refused/);
  await writeFile(cli, fixtureOperatorCli);

  const fingerprint = await prepareLocalInstallationPackageV1({ releaseRoot: root });
  await writeFile(cli, "export const altered = true;\n");
  await assert.rejects(prepareLocalInstallationPackageV1({ releaseRoot: root,
    expectedDigest: fingerprint.bundle.digest }), /refused/);
  await writeFile(cli, fixtureOperatorCli);

  await rm(runner);
  await symlink(join(root, "scripts/run-private-vps.mjs"), runner);
  await assert.rejects(prepareLocalInstallationPackageV1({ releaseRoot: root }), /refused/);
});

test("installer bounds metadata and binds the package version into the digest report", async t => {
  const root = await release(t);
  const first = await prepareLocalInstallationPackageV1({ releaseRoot: root });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "control-room", version: "0.1.1",
    packageManager: "pnpm@11.19.0", engines: { node: ">=22.13.0" } }));
  const changed = await prepareLocalInstallationPackageV1({ releaseRoot: root });
  assert.equal(changed.bundle.version, "0.1.1");
  assert.notEqual(changed.bundle.digest, first.bundle.digest);
  await writeFile(join(root, "package.json"), `{\"name\":\"control-room\",\"version\":\"0.1.1\",\"padding\":\"${"x".repeat(70_000)}\"}`);
  await assert.rejects(prepareLocalInstallationPackageV1({ releaseRoot: root }), /refused/);
});

test("expected digest rejects an altered application payload", async t => {
  const root = await release(t);
  const first = await prepareLocalInstallationPackageV1({ releaseRoot: root });
  const matched = await prepareLocalInstallationPackageV1({ releaseRoot: root, expectedDigest: first.bundle.digest });
  assert.equal(matched.bundle.state, "matched_expected_digest");
  assert.equal(matched.bundle.authenticityVerified, false);
  await writeFile(join(root, "dist-vps/server/runtime.js"), "export const altered = true;\n");
  await assert.rejects(prepareLocalInstallationPackageV1({ releaseRoot: root,
    expectedDigest: first.bundle.digest }), /refused/);
});

test("public preparation command runs from a clean extracted release without tsx or node_modules", async t => {
  const root = await release(t);
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "scripts/prepare-local-installation.mjs")],
      { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(report.mode, "dry-run");
  assert.equal(report.startsService, false);
  assert.equal((report.bundle as Record<string, unknown>).state, "fingerprinted");
  assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});
