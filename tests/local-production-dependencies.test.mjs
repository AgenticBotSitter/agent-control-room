import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareLocalProductionDependenciesV1 } from "../src/installer/v1/local-production-dependencies.mjs";

const sha256Hex = bytes => createHash("sha256").update(bytes).digest("hex");
const sha256 = bytes => `sha256:${sha256Hex(bytes)}`;

async function fixture() {
  const root = await realpath(await mkdtemp(join(os.tmpdir(), "acr-production-dependencies-")));
  const installRoot = join(root, "install");
  const versionsRoot = join(installRoot, "versions");
  const version = "1.2.3";
  const versionRoot = join(versionsRoot, version);
  await mkdir(versionRoot, { recursive: true });
  const packageBytes = Buffer.from(`${JSON.stringify({
    name: "control-room",
    version,
    packageManager: "pnpm@11.19.0",
    engines: { node: ">=22.13.0" },
    scripts: { postinstall: "definitely-must-not-run" },
    dependencies: { alpha: "1.0.0", "@scope/bravo": "2.0.0" },
    devDependencies: { forbidden: "3.0.0" },
    type: "module",
  }, null, 2)}\n`);
  const lockBytes = Buffer.from("lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\nimporters:\n\n  .:\n    dependencies: {}\n");
  await writeFile(join(versionRoot, "package.json"), packageBytes);
  await writeFile(join(versionRoot, "pnpm-lock.yaml"), lockBytes);
  const files = [
    { path: "package.json", bytes: packageBytes.byteLength, sha256: sha256Hex(packageBytes), mode: "0644" },
    { path: "pnpm-lock.yaml", bytes: lockBytes.byteLength, sha256: sha256Hex(lockBytes), mode: "0644" },
  ];
  const manifest = {
    schema: "control-room.local-release-manifest/v1",
    layoutVersion: 1,
    product: "agent-control-room",
    version,
    platform: { artifact: "portable-node", operatingSystems: ["darwin", "linux"],
      architectures: ["arm64", "x64"], node: ">=22.13.0" },
    entrypoint: "scripts/run-private-vps.mjs",
    preflight: "scripts/prepare-local-installation.mjs",
    dependencyPreparation: { packageManager: "pnpm@11.19.0", lockfile: "pnpm-lock.yaml",
      mode: "frozen-production-install-before-activation" },
    fileCount: files.length,
    byteCount: files.reduce((total, file) => total + file.bytes, 0),
    license: { inventoryDigest: "a".repeat(64), completeDistributionClearance: true },
    files,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestDigest = sha256(manifestBytes);
  await writeFile(join(versionRoot, "RELEASE_MANIFEST.json"), manifestBytes);
  await writeFile(join(versionsRoot, `.publish-${version}.json`), `${JSON.stringify({
    schema: "control-room.local-release-publication-claim/v1", version,
    manifestSha256: manifestDigest.slice("sha256:".length),
  })}\n`, { mode: 0o600 });
  return { root, installRoot, versionRoot, version, manifestDigest };
}

async function writeFakeDependencies(cwd) {
  const modules = join(cwd, "node_modules");
  await mkdir(join(modules, "alpha"), { recursive: true });
  await mkdir(join(modules, "@scope", "bravo"), { recursive: true });
  await mkdir(join(modules, ".pnpm"), { recursive: true });
  await writeFile(join(modules, "alpha", "package.json"), JSON.stringify({ name: "alpha", version: "1.0.0" }));
  await writeFile(join(modules, "@scope", "bravo", "package.json"), JSON.stringify({ name: "@scope/bravo", version: "2.0.0" }));
  await writeFile(join(modules, ".modules.yaml"), "layoutVersion: 5\n");
  await writeFile(join(modules, ".pnpm", "lock.yaml"), "verified fixture\n");
}

async function rewriteManifestBinding(value, change) {
  const path = join(value.versionRoot, "RELEASE_MANIFEST.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  change(manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  value.manifestDigest = sha256(bytes);
  await writeFile(path, bytes);
  await writeFile(join(value.installRoot, "versions", `.publish-${value.version}.json`), `${JSON.stringify({
    schema: "control-room.local-release-publication-claim/v1", version: value.version,
    manifestSha256: value.manifestDigest.slice("sha256:".length),
  })}\n`);
}

function successfulRunner(calls, gate) {
  return async spec => {
    calls.push(spec);
    if (spec.args[0] === "--version") return { exitCode: 0, signal: null, stdout: "11.19.0\n", stderr: "" };
    if (gate) await gate();
    await writeFakeDependencies(spec.cwd);
    return { exitCode: 0, signal: null, stdout: "prepared\n", stderr: "" };
  };
}

const input = value => ({ ownerAttended: true, installRoot: value.installRoot,
  version: value.version, expectedManifestDigest: value.manifestDigest });

test("prepares exact production dependencies in isolation and publishes no lifecycle effect", async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const calls = [];
  const report = await prepareLocalProductionDependenciesV1(input(value), { runner: successfulRunner(calls) });
  assert.equal(report.state, "production_dependencies_prepared");
  assert.equal(report.alreadyPrepared, false);
  assert.equal(report.switchesCurrentRelease, false);
  assert.equal(report.installsOrStartsService, false);
  assert.equal(report.createsOrMigratesDatabase, false);
  assert.equal(report.readsOrWritesCredentials, false);
  assert.equal(report.startsWorkers, false);
  assert.equal(report.runsPackageScripts, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.deepEqual(calls[1].args.slice(0, 4), ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"]);
  assert.equal(calls[1].cwd.startsWith(value.installRoot), true);
  assert.deepEqual(Object.keys(calls[1].environment).sort(), ["CI", "COREPACK_ENABLE_PROJECT_SPEC", "COREPACK_HOME",
    "HOME", "NO_COLOR", "PATH", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    "NPM_CONFIG_GLOBALCONFIG", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_IGNORE_SCRIPTS",
    "npm_config_globalconfig", "npm_config_userconfig", "npm_config_ignore_scripts"].sort());
  assert.equal((await readdir(join(value.versionRoot, "node_modules"))).includes("forbidden"), false);
  assert.equal((await readdir(value.versionRoot)).includes(".control-room-production-dependencies.lock"), false);
});

test("exact retry is read-only and a changed staged release is refused", async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const calls = [];
  const first = await prepareLocalProductionDependenciesV1(input(value), { runner: successfulRunner(calls) });
  const second = await prepareLocalProductionDependenciesV1(input(value), { runner: async () => assert.fail("retry ran pnpm") });
  assert.equal(first.dependencyTreeDigest, second.dependencyTreeDigest);
  assert.equal(second.alreadyPrepared, true);
  await writeFile(join(value.versionRoot, "package.json"), "{}\n");
  await assert.rejects(prepareLocalProductionDependenciesV1(input(value), { runner: successfulRunner([]) }),
    /local_production_dependency_preparation_refused/u);
});

test("known package-manager failure cleans only owned attempt state and can be retried", async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(prepareLocalProductionDependenciesV1(input(value), { runner: async spec => {
    calls += 1;
    if (spec.args[0] === "--version") return { exitCode: 0, signal: null, stdout: "11.19.0\n", stderr: "" };
    return { exitCode: 1, signal: null, stdout: "", stderr: "registry unavailable" };
  } }), /local_production_dependency_preparation_refused/u);
  assert.equal(calls, 2);
  assert.equal((await readdir(value.versionRoot)).includes(".control-room-production-dependencies.lock"), false);
  assert.equal((await readdir(value.installRoot)).some(name => name.startsWith(".dependency-staging-")), false);
  const report = await prepareLocalProductionDependenciesV1(input(value), { runner: successfulRunner([]) });
  assert.equal(report.state, "production_dependencies_prepared");
});

test("uncertain tool call is retained and never guessed safe to retry", async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  let invocations = 0;
  await assert.rejects(prepareLocalProductionDependenciesV1(input(value), { runner: async spec => {
    invocations += 1;
    if (spec.args[0] === "--version") return { exitCode: 0, signal: null, stdout: "11.19.0\n", stderr: "" };
    throw new Error("connection to child lost");
  } }), error => error.code === "local_production_dependency_preparation_uncertain");
  await assert.rejects(prepareLocalProductionDependenciesV1(input(value), { runner: async () => {
    invocations += 1;
    return { exitCode: 0, signal: null, stdout: "11.19.0\n", stderr: "" };
  } }), error => error.code === "local_production_dependency_preparation_uncertain");
  assert.equal(invocations, 2);
  assert.equal((await readdir(value.versionRoot)).includes(".control-room-production-dependencies.lock"), true);
  assert.equal((await readdir(value.installRoot)).some(name => name.startsWith(".dependency-staging-")), true);
});

test("concurrent attempts invoke one installer and leave the other visibly blocked", async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  let release;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = () => new Promise(resolve => { release = resolve; entered(); });
  const calls = [];
  const first = prepareLocalProductionDependenciesV1(input(value), { runner: successfulRunner(calls, gate) });
  await enteredPromise;
  await assert.rejects(prepareLocalProductionDependenciesV1(input(value), { runner: successfulRunner(calls) }),
    error => ["local_production_dependency_preparation_uncertain",
      "local_production_dependency_preparation_in_progress"].includes(error.code));
  release();
  const report = await first;
  assert.equal(report.state, "production_dependencies_prepared");
  assert.equal(calls.length, 2);
});

test("wrong release binding and package-manager version are refused", async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await assert.rejects(prepareLocalProductionDependenciesV1({ ...input(value),
    expectedManifestDigest: `sha256:${"0".repeat(64)}` }, { runner: successfulRunner([]) }),
  /local_production_dependency_preparation_refused/u);
  await assert.rejects(prepareLocalProductionDependenciesV1(input(value), { runner: async () => ({
    exitCode: 0, signal: null, stdout: "11.18.0\n", stderr: "",
  }) }), /local_production_dependency_preparation_refused/u);
});

test("re-verifies the published location and leaves a moved absolute symlink uncertain", async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await assert.rejects(prepareLocalProductionDependenciesV1(input(value), { runner: async spec => {
    if (spec.args[0] === "--version") return { exitCode: 0, signal: null, stdout: "11.19.0\n", stderr: "" };
    const modules = join(spec.cwd, "node_modules");
    const alpha = join(modules, ".pnpm", "alpha@1.0.0", "node_modules", "alpha");
    await mkdir(alpha, { recursive: true });
    await mkdir(join(modules, "@scope", "bravo"), { recursive: true });
    await writeFile(join(alpha, "package.json"), JSON.stringify({ name: "alpha", version: "1.0.0" }));
    await writeFile(join(modules, "@scope", "bravo", "package.json"), JSON.stringify({ name: "@scope/bravo", version: "2.0.0" }));
    await writeFile(join(modules, ".modules.yaml"), "layoutVersion: 5\n");
    await symlink(alpha, join(modules, "alpha"));
    return { exitCode: 0, signal: null, stdout: "prepared\n", stderr: "" };
  } }), error => error.code === "local_production_dependency_preparation_uncertain");
  const names = await readdir(value.versionRoot);
  assert.equal(names.includes("node_modules"), true);
  assert.equal(names.includes(".control-room-production-dependencies.lock"), true);
  assert.equal(names.includes(".control-room-production-dependencies.json"), false);
});

test("an exact durable receipt safely finalizes a retained success lock", async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await prepareLocalProductionDependenciesV1(input(value), { runner: successfulRunner([]) });
  const packageDigest = sha256(await readFile(join(value.versionRoot, "package.json")));
  const lockfileDigest = sha256(await readFile(join(value.versionRoot, "pnpm-lock.yaml")));
  const operationDigest = sha256(Buffer.from(JSON.stringify({ version: value.version,
    manifestDigest: value.manifestDigest, packageDigest, lockfileDigest,
    nodeVersion: process.versions.node, platform: process.platform, architecture: process.arch,
    packageManager: "pnpm@11.19.0" }), "utf8"));
  await writeFile(join(value.versionRoot, ".control-room-production-dependencies.lock"),
    `${JSON.stringify({ schema: "control-room.local-production-dependency-lock/v1", operationDigest })}\n`);
  const report = await prepareLocalProductionDependenciesV1(input(value), { runner: async () => assert.fail("retry ran pnpm") });
  assert.equal(report.alreadyPrepared, true);
  assert.equal((await readdir(value.versionRoot)).includes(".control-room-production-dependencies.lock"), false);
});

test("refuses a hand-built claim when an exact manifest contract field changes", async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await rewriteManifestBinding(value, manifest => { manifest.preflight = "scripts/other-preflight.mjs"; });
  await assert.rejects(prepareLocalProductionDependenciesV1(input(value), { runner: successfulRunner([]) }),
    /local_production_dependency_preparation_refused/u);
});

test("matches the accepted zero-byte file contract and rejects unexpected empty directories", async t => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.versionRoot, "empty.txt"), "");
  await rewriteManifestBinding(value, manifest => {
    manifest.files.push({ path: "empty.txt", bytes: 0, sha256: sha256Hex(Buffer.alloc(0)), mode: "0644" });
    manifest.files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    manifest.fileCount = manifest.files.length;
  });
  await mkdir(join(value.versionRoot, "unexpected-empty"));
  await assert.rejects(prepareLocalProductionDependenciesV1(input(value), { runner: successfulRunner([]) }),
    /local_production_dependency_preparation_refused/u);
  await rm(join(value.versionRoot, "unexpected-empty"), { recursive: true });
  const report = await prepareLocalProductionDependenciesV1(input(value), { runner: successfulRunner([]) });
  assert.equal(report.state, "production_dependencies_prepared");
});
