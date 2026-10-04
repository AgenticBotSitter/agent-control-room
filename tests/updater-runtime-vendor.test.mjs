import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:https";
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { PG_RUNTIME_PIN_V1 } from "../src/updater/v1/pg/pg-runtime-vendor.ts";
import { loadRuntimeInventoryV1, recoverPlannedRuntimeV1, undoVendoredRuntimeV1,
  vendorRuntimeV1 } from "../src/updater/v1/install/runtime.mjs";
import { adoptBootstrapV1 } from "../src/updater/v1/install/bootstrap.mjs";
import { abortAttendedV1, fetchVerifiedSourceV1 } from "../src/updater/v1/attended-source.mjs";
import { verifyRuntimeInventoryV1 } from "../scripts/ci/verify-runtime-inventory.mjs";

const repositoryRoot = dirname(dirname(new URL(import.meta.url).pathname));
const sha256 = value => createHash("sha256").update(value).digest("hex");
const sha512 = value => createHash("sha512").update(value).digest("base64");

async function cleanup(root) {
  const visit = async path => {
    const entry = await lstat(path).catch(() => undefined);
    if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) return;
    await chmod(path, 0o700).catch(() => {});
    for (const name of await readdir(path).catch(() => [])) await visit(join(path, name));
  };
  await visit(root); await rm(root, { recursive: true, force: true });
}

async function archiveFixture(root, tool) {
  const tree = join(root, `${tool}-tree`), archive = join(root, `${tool}.tgz`);
  const executableRelativePath = tool === "node" ? "bin/node" : tool === "pnpm" ? "pnpm" : "esbuild";
  const archivePath = tool === "node" ? `node-v1.2.3/${executableRelativePath}`
    : tool === "esbuild" ? "package/bin/esbuild" : executableRelativePath;
  const executable = join(tree, archivePath), body = Buffer.from(`#!/bin/sh\nprintf '${tool} 1.2.3\\n'\n`);
  await mkdir(dirname(executable), { recursive: true }); await writeFile(executable, body, { mode: 0o755 });
  const member = tool === "node" ? "node-v1.2.3" : tool === "esbuild" ? "package" : "pnpm";
  const packed = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", tree, member], { encoding: "utf8", env: {} });
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = await readFile(archive);
  return { tool, version: "1.2.3", linkBase: tool, archiveName: `${tool}.tgz`, bytes,
    archiveSha256: sha256(bytes), archiveBytes: bytes.length,
    extraction: tool === "node" ? "tar-gz-strip-1" : tool === "pnpm" ? "tar-gz" : "npm-tgz-bin-esbuild",
    executableRelativePath, executableSha256: sha256(body), publisherProof: { kind: "none" } };
}

function inventoryFor(origin, artifacts, pgBytes = Buffer.from("fake-pg-archive")) {
  const rows = artifacts.map(({ bytes: _bytes, ...artifact }) => ({ ...artifact, url: `${origin}/${artifact.tool}` }));
  rows.push({ tool: "postgresql", version: "17.11", linkBase: "pg", archiveName: "postgresql-17.11-4-osx-binaries.zip",
    url: `${origin}/postgresql`, archiveSha256: sha256(pgBytes), archiveBytes: pgBytes.length,
    extraction: "edb-zip-allowlist-v1", executableRelativePath: "bin/postgres",
    executableSha256: sha256(Buffer.from("postgres-binary")),
    // Finding 9: the Developer ID proof the pin now carries. The digest in this
    // fixture is of a fake archive, so the signature is the only field that
    // would be a real publisher check in production, and omitting the field here
    // would assert the inventory shape as it was before the finding.
    teamIdentifier: "26QKX55P9K",
    publisherProof: { kind: "developer-id", teamIdentifier: "26QKX55P9K",
      identifier: "com.edb.postgresql", measured: "fixture" },
    provenance: { etag: null, lastModified: null } });
  return { inventory: { schema: "control-room.runtime-inventory/v1", platform: "darwin", architecture: "arm64",
    artifacts: rows }, pgBytes };
}

async function httpsFixture(t, bodies) {
  const root = await mkdtemp(join(tmpdir(), "acr-runtime-https-")); t.after(() => cleanup(root));
  const key = join(root, "key.pem"), certificate = join(root, "certificate.pem");
  const generated = spawnSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-keyout", key, "-out", certificate], { encoding: "utf8", env: {} });
  assert.equal(generated.status, 0, generated.stderr);
  const routes = new Map(Object.entries(bodies));
  const server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
    const route = routes.get(request.url);
    if (route?.drop) { request.socket.destroy(); return; }
    if (route?.delay) { setTimeout(() => { response.writeHead(200); response.end(route.body); }, route.delay); return; }
    const body = Buffer.isBuffer(route) ? route : route?.body;
    if (!body) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-length": String(body.length) }); response.end(body);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise);
  });
  t.after(() => new Promise(resolvePromise => server.close(resolvePromise)));
  const curl = join(root, "fake-curl.mjs");
  await writeFile(curl, `#!/usr/bin/env node
import https from "node:https";
import { createWriteStream, rmSync } from "node:fs";
const args=process.argv.slice(2), output=args[args.indexOf("--output")+1], maximum=Number(args[args.indexOf("--max-filesize")+1]);
const url=args.at(-1), file=createWriteStream(output,{flags:"wx",mode:0o600}); let bytes=0, finished=false;
const fail=()=>{if(finished)return;finished=true;file.destroy();try{rmSync(output)}catch{}process.exitCode=63;};
https.get(url,{rejectUnauthorized:false},response=>{const declared=Number(response.headers["content-length"]??0);if(declared>maximum){response.destroy();fail();return;}response.on("data",chunk=>{bytes+=chunk.length;if(bytes>maximum){response.destroy();fail();}});response.pipe(file);file.on("finish",()=>{if(!finished){finished=true;file.close();}});}).on("error",fail);
`, { mode: 0o755 });
  await chmod(curl, 0o755);
  return { origin: `https://127.0.0.1:${server.address().port}`, routes, curl, root };
}

function frozenInput(root, inventory, transactionId = "tx-one") {
  return Object.freeze({ root, inventory, tools: Object.freeze(["node", "pnpm", "esbuild", "postgresql"]), fresh: true,
    download: Object.freeze({ uid: process.getuid(), gid: process.getgid() }), transactionId });
}

function runtimeFor(fixture, observations = {}) {
  return { curlPath: process.execPath, curlArgumentsPrefix: [fixture.curl], skipMacMetadata: true,
    spawn(file, args, options) { (observations.spawnOptions ??= []).push(options); return spawn(file, args, options); },
    observeDownloadSpawn(value) { (observations.downloads ??= []).push(value); },
    observeExtraction(tool) { (observations.extractions ??= []).push(tool); },
    async afterArchiveSnapshot(tool, source) {
      (observations.snapshots ??= []).push(tool);
      if (observations.swapAfterSnapshot) await writeFile(source, "swapped-after-root-snapshot");
    },
    async vendorPostgresql({ archivePath, runtimeDirectory, pin }) {
      const archive = await readFile(archivePath);
      if (archive.length !== pin.archiveBytes || sha256(archive) !== pin.archiveSha256) {
        return { status: "pg_runtime_vendor_refused", refusal: "fixture archive did not match its pin" };
      }
      await mkdir(join(runtimeDirectory, "bin"), { recursive: true });
      const executable = Buffer.from("postgres-binary");
      await writeFile(join(runtimeDirectory, "bin/postgres"), executable, { mode: 0o555 });
      await writeFile(join(runtimeDirectory, "manifest.json"), `${JSON.stringify({
        schema: "control-room.pg-runtime-manifest/v1", version: pin.version,
        archive: { name: pin.archiveName, url: pin.url, sha256: pin.archiveSha256, bytes: pin.archiveBytes },
        provenance: pin.provenance, dependencies: [], files: [
          { path: "bin", type: "directory", mode: "0555" },
          { path: "bin/postgres", type: "file", mode: "0555", bytes: executable.length, sha256: sha256(executable) },
        ],
      }, null, 2)}\n`, { mode: 0o444 });
      await chmod(join(runtimeDirectory, "bin"), 0o555);
      await chmod(runtimeDirectory, 0o555);
      return { status: "pg_runtime_vendored" };
    } };
}

test("the one inventory equals the bootstrap literals and PostgreSQL vendor reader", async () => {
  const inventory = await loadRuntimeInventoryV1(), node = inventory.artifacts.find(row => row.tool === "node");
  const pg = inventory.artifacts.find(row => row.tool === "postgresql");
  const bootstrap = await readFile(join(repositoryRoot, "scripts/install-night/bootstrap.sh"), "utf8");
  for (const [name, value] of [["NODE_VERSION", node.version], ["NODE_ARCHIVE_NAME", node.archiveName],
    ["NODE_ARCHIVE_URL", node.url], ["NODE_ARCHIVE_SHA256", node.archiveSha256],
    ["NODE_ARCHIVE_BYTES", String(node.archiveBytes)]]) assert.match(bootstrap, new RegExp(`${name}='${value.replaceAll(".", "\\.")}'`, "u"));
  assert.deepEqual(node, {
    tool: "node", version: "22.23.3", linkBase: "node", archiveName: "node-v22.23.3-darwin-arm64.tar.gz",
    url: "https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-arm64.tar.gz",
    archiveSha256: "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53", archiveBytes: 49963763,
    extraction: "tar-gz-strip-1", executableRelativePath: "bin/node",
    executableSha256: "68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b",
    publisherProof: { kind: "nodejs-shasums-gpg",
      shasumsUrl: "https://nodejs.org/dist/v22.23.3/SHASUMS256.txt",
      signatureUrl: "https://nodejs.org/dist/v22.23.3/SHASUMS256.txt.asc",
      keyringUrl: "https://github.com/nodejs/release-keys/raw/refs/heads/main/gpg/pubring.kbx",
      signerFingerprints: ["5BE8A3F6C8A5C01D106C0AD820B1A390B168D356"] },
  });
  assert.deepEqual(PG_RUNTIME_PIN_V1, { schema: "control-room.pg-runtime-vendor/v1", version: pg.version,
    archiveName: pg.archiveName, url: pg.url, archiveSha256: pg.archiveSha256, archiveBytes: pg.archiveBytes,
    teamIdentifier: pg.teamIdentifier, provenance: pg.provenance });
});

test("vendorRuntimeV1 downloads as builder, snapshots once, and creates exactly eight fresh links", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-runtime-"))); t.after(() => cleanup(root));
  const artifacts = await Promise.all(["node", "pnpm", "esbuild"].map(tool => archiveFixture(root, tool)));
  const bodies = Object.fromEntries(artifacts.map(row => [`/${row.tool}`, row.bytes]));
  const fixture = await httpsFixture(t, bodies), { inventory, pgBytes } = inventoryFor(fixture.origin, artifacts);
  fixture.routes.set("/postgresql", pgBytes);
  const observations = { swapAfterSnapshot: true };
  const result = await vendorRuntimeV1(frozenInput(root, inventory), runtimeFor(fixture, observations));
  assert.equal(observations.downloads.length, 4);
  assert(observations.downloads.every(row => row.args[1] === "-q"), "-q is the first curl option after the test shim");
  assert(observations.downloads.every(row => row.uid === process.getuid() && row.gid === process.getgid()));
  assert(observations.spawnOptions.every(options => options.uid === process.getuid() && options.gid === process.getgid()));
  assert.deepEqual(observations.extractions, ["node", "pnpm", "esbuild"]);
  assert.deepEqual(observations.snapshots, ["node", "pnpm", "esbuild"]);
  assert.deepEqual(Object.keys(result.links).sort(), ["esbuild-current", "esbuild-previous", "node-current", "node-previous",
    "pg-current", "pg-previous", "pnpm-current", "pnpm-previous"]);
  for (const base of ["node", "pnpm", "esbuild", "pg"]) {
    assert.equal(result.links[`${base}-previous`], result.links[`${base}-current`]);
    assert.equal(await readlink(join(root, `runtime/${base}-previous`)), await readlink(join(root, `runtime/${base}-current`)));
  }
});

test("real vendoring feeds the default source fetch and remains valid after PostgreSQL is added", async t => {
  // Keep the fixture inside the checkout and give extracted archives a bare
  // repository boundary. Git must not resolve their paths against the enclosing
  // worktree; the private scratch directory also preserves runtime ancestry checks.
  const scratchRoot = join(repositoryRoot, ".test-tmp", "vendor-scratch");
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  assert.equal(spawnSync("/usr/bin/git", ["init", "--bare", scratchRoot]).status, 0);
  const fixtureRoot = await realpath(await mkdtemp(join(scratchRoot, "acr-vendor-fetch-fixture-"))); t.after(() => cleanup(fixtureRoot));
  const artifacts = await Promise.all(["node", "pnpm", "esbuild"].map(tool => archiveFixture(fixtureRoot, tool)));
  const https = await httpsFixture(t, Object.fromEntries(artifacts.map(row => [`/${row.tool}`, row.bytes])));
  const { inventory, pgBytes } = inventoryFor(https.origin, artifacts); https.routes.set("/postgresql", pgBytes);
  const root = await realpath(await mkdtemp(join(scratchRoot, "acr-vendor-fetch-root-"))); t.after(() => cleanup(root));
  for (const path of ["build", "updater", "updater-state"]) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, "updater-state/self-update"), "Off\n", { mode: 0o600 });
  await vendorRuntimeV1(Object.freeze({ root, inventory, tools: Object.freeze(["node", "pnpm", "esbuild"]), fresh: true,
    download: Object.freeze({ uid: process.getuid(), gid: process.getgid() }), transactionId: "fetch-tools" }), runtimeFor(https));

  const checkout = join(fixtureRoot, "checkout"), remote = join(fixtureRoot, "remote.git"); await mkdir(checkout);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"],
    ["config", "user.email", "fixture@example.invalid"]]) assert.equal(spawnSync("/usr/bin/git", args, { cwd: checkout }).status, 0);
  await writeFile(join(checkout, "package.json"), '{"name":"control-room","version":"1.0.0"}\n');
  assert.equal(spawnSync("/usr/bin/git", ["add", "."], { cwd: checkout }).status, 0);
  assert.equal(spawnSync("/usr/bin/git", ["commit", "-m", "fixture"], { cwd: checkout }).status, 0);
  const commit = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).stdout.trim();
  assert.equal(spawnSync("/usr/bin/git", ["clone", "--bare", checkout, remote], { encoding: "utf8" }).status, 0);
  const bootstrap = join(fixtureRoot, "bootstrap"); await mkdir(bootstrap);
  await mkdir(join(bootstrap, "mirror.git")); await rm(join(bootstrap, "mirror.git"), { recursive: true });
  assert.equal(spawnSync("/usr/bin/git", ["clone", "--bare", checkout, join(bootstrap, "mirror.git")], { encoding: "utf8" }).status, 0);
  await writeFile(join(bootstrap, "github-read.token"), "fixture-token\n", { mode: 0o600 });
  await adoptBootstrapV1({ root, bootstrapRoot: bootstrap, transactionId: "abcdef12",
    remoteUrl: `file://${remote}` }, { expectedUid: process.geteuid(), allowFileRemote: true });

  const toolRoot = join(root, "updater/current"); await mkdir(join(toolRoot, "bin"), { recursive: true });
  await mkdir(join(toolRoot, "policy"));
  for (const [source, target] of [
    [join(repositoryRoot, "src/updater/v1/bin/git-credential-control-room"), join(toolRoot, "bin/git-credential-control-room")],
    [join(repositoryRoot, "src/updater/v1/build-attended-release.mjs"), join(toolRoot, "bin/build-attended-release.mjs")],
    [join(repositoryRoot, "scripts/updater/build-fixed-updater-bundle.mjs"), join(toolRoot, "bin/build-fixed-bundle.mjs")],
    [join(repositoryRoot, "src/updater/v1/policy/bundle.json"), join(toolRoot, "policy/bundle.json")],
  ]) await copyFile(source, target);
  for (const name of ["git-credential-control-room", "build-attended-release.mjs", "build-fixed-bundle.mjs"])
    await chmod(join(toolRoot, "bin", name), 0o500);
  await chmod(join(toolRoot, "policy/bundle.json"), 0o400); await chmod(join(toolRoot, "bin"), 0o555);
  await chmod(join(toolRoot, "policy"), 0o555); await chmod(toolRoot, 0o555);

  const rootMetadata = {
    async lstat(path) {
      const entry = await lstat(path);
      return new Proxy(entry, { get(target, property) {
        if (property === "uid" || property === "gid") return 0;
        const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    }, realpath, readlink, async inspectAcl() { return []; }, async inspectFlags() { return "-"; },
    async execFile(file, args) {
      if (args[0] === "-L" || args[0] === "-l") return { stdout: `${args[1]}:\n`, stderr: "" };
      const result = spawnSync(file, args, { encoding: "utf8", env: { LANG: "C", LC_ALL: "C" } });
      if (result.status !== 0) throw new Error(`${file}:${result.status}:${result.stderr}`);
      return { stdout: result.stdout, stderr: result.stderr };
    },
  };
  const initPolicy = JSON.parse(await readFile(join(repositoryRoot, "src/updater/v1/policy/init-config.json"), "utf8"));
  const identities = { rootUid: process.getuid(), rootGid: process.getgid(), builderUid: process.getuid() + 10_000,
    builderGid: process.getgid() + 10_000, serviceGid: process.getgid(), builderAccount: "_crbuild" };
  const sourceInput = { root, commit, toolRoot, allowFileRemote: true, identities,
    trustedRuntimePolicies: [inventory, initPolicy], trustedRuntimeRuntime: rootMetadata,
    builderProcessControl: { async listPids() { return []; }, async hasScheduledEntries() { return false; }, async killPid() {} },
    async changeOwnership() {} };
  const firstFetch = await fetchVerifiedSourceV1(sourceInput);
  assert.equal(firstFetch.mainCommit, commit); await abortAttendedV1(firstFetch);
  const nodeManifestPath = join(root, "runtime/node-1.2.3/manifest.json");
  const nodeManifestText = await readFile(nodeManifestPath, "utf8"), nodeManifest = JSON.parse(nodeManifestText);
  await chmod(join(root, "runtime/node-1.2.3"), 0o755); await chmod(nodeManifestPath, 0o644);
  await writeFile(nodeManifestPath, `${JSON.stringify({ ...nodeManifest, unexpected: true })}\n`); await chmod(nodeManifestPath, 0o444);
  await chmod(join(root, "runtime/node-1.2.3"), 0o555);
  await assert.rejects(fetchVerifiedSourceV1(sourceInput), /trusted_runtime_installation_invalid/u);
  await chmod(join(root, "runtime/node-1.2.3"), 0o755); await chmod(nodeManifestPath, 0o644);
  await writeFile(nodeManifestPath, nodeManifestText); await chmod(nodeManifestPath, 0o444);
  await chmod(join(root, "runtime/node-1.2.3"), 0o555);
  await vendorRuntimeV1(Object.freeze({ root, inventory, tools: Object.freeze(["postgresql"]), fresh: true,
    download: Object.freeze({ uid: process.getuid(), gid: process.getgid() }), transactionId: "fetch-pg" }), runtimeFor(https));
  const secondFetch = await fetchVerifiedSourceV1(sourceInput);
  assert.equal(secondFetch.mainCommit, commit, "the added PostgreSQL runtime passes its full manifest verification");
  await abortAttendedV1(secondFetch);
  await chmod(join(root, "runtime/pg-17.11"), 0o755);
  await writeFile(join(root, "runtime/pg-17.11/unlisted"), "not in the PostgreSQL manifest", { mode: 0o444 });
  await chmod(join(root, "runtime/pg-17.11"), 0o555);
  await assert.rejects(fetchVerifiedSourceV1(sourceInput), /trusted_runtime_inventory_mismatch/u,
    "repeat verification must reject a PostgreSQL tree containing an unmanifested path");
  await chmod(join(root, "runtime/pg-17.11"), 0o755); await rm(join(root, "runtime/pg-17.11/unlisted"));
  await chmod(join(root, "runtime/pg-17.11"), 0o555);
  const retryFetch = await fetchVerifiedSourceV1(sourceInput);
  assert.equal(retryFetch.mainCommit, commit, "a clean repeat verification succeeds after the hostile path is removed");
  await abortAttendedV1(retryFetch);
});

test("PostgreSQL refusal reasons survive step 18", async t => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-pg-reason-fixture-")));
  t.after(() => cleanup(fixtureRoot));
  const artifacts = await Promise.all(["node", "pnpm", "esbuild"].map(tool => archiveFixture(fixtureRoot, tool)));
  const fixture = await httpsFixture(t, {}), { inventory, pgBytes } = inventoryFor(fixture.origin, artifacts);
  fixture.routes.set("/postgresql", pgBytes);
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-pg-reason-root-"))); t.after(() => cleanup(root));
  await assert.rejects(vendorRuntimeV1(Object.freeze({ ...frozenInput(root, inventory), tools: Object.freeze(["postgresql"]) }), {
    ...runtimeFor(fixture), async vendorPostgresql() {
      return { status: "pg_runtime_vendor_refused", refusal: "the Team Identifier does not match the pinned publisher" };
    },
  }), /pg_runtime_vendor_refused: the Team Identifier does not match the pinned publisher/u);
});

test("runtime undo removes transaction-owned trees and links, refuses a forged receipt, and permits a clean retry", async t => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-undo-fixture-"))); t.after(() => cleanup(fixtureRoot));
  const artifacts = await Promise.all(["node", "pnpm", "esbuild"].map(tool => archiveFixture(fixtureRoot, tool)));
  const fixture = await httpsFixture(t, { "/node": artifacts[0].bytes });
  const { inventory } = inventoryFor(fixture.origin, artifacts);
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-undo-"))); t.after(() => cleanup(root));
  const input = Object.freeze({ ...frozenInput(root, inventory), tools: Object.freeze(["node"]) });
  const result = await vendorRuntimeV1(input, runtimeFor(fixture));
  const forged = structuredClone(result.undo); forged.trees[0] = "runtime/../outside";
  await writeFile(join(root, "outside"), "untouched");
  await assert.rejects(undoVendoredRuntimeV1({ root, receipt: forged }), /runtime_undo_refused/u);
  assert.equal(await readFile(join(root, "outside"), "utf8"), "untouched");
  const removed = [];
  assert.deepEqual(await undoVendoredRuntimeV1({ root, receipt: result.undo }, {
    async rm(path, options) { removed.push(path); await rm(path, options); },
  }), { status: "runtime_undone" });
  assert.deepEqual(removed, [join(root, "runtime/node-1.2.3")]);
  assert.deepEqual(await readdir(join(root, "runtime")), [], "undo retains no renamed runtime tree");
  await undoVendoredRuntimeV1({ root, receipt: result.undo });
  await vendorRuntimeV1(input, runtimeFor(fixture));
  assert.equal(await readlink(join(root, "runtime/node-current")), "node-1.2.3");
});

async function undoState(t, name) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `acr-vendor-undo-${name}-`))); t.after(() => cleanup(root));
  await mkdir(join(root, "runtime/node-1.2.3/bin"), { recursive: true });
  await writeFile(join(root, "runtime/node-1.2.3/bin/node"), "fixture");
  await symlink("node-1.2.3", join(root, "runtime/node-current"));
  await symlink("node-1.2.3", join(root, "runtime/node-previous"));
  return { root, receipt: { schema: "control-room.runtime-vendor-undo/v1", trees: ["runtime/node-1.2.3"], links: [
    { path: "runtime/node-previous", installedTarget: "node-1.2.3", previousTarget: null },
    { path: "runtime/node-current", installedTarget: "node-1.2.3", previousTarget: null },
  ] } };
}

test("runtime undo refuses malformed receipts and filesystem drift before deletion", async t => {
  const input = await undoState(t, "input");
  await assert.rejects(undoVendoredRuntimeV1({ ...input, extra: true }), /runtime_undo_refused/u);
  assert.ok(await lstat(join(input.root, input.receipt.trees[0])));

  for (const [name, mutate] of [
    ["tree-path", receipt => { receipt.trees[0] = "runtime/../outside"; }],
    ["link-target", receipt => { receipt.links[0].previousTarget = "pnpm-1.2.3"; }],
  ]) {
    const state = await undoState(t, name), receipt = structuredClone(state.receipt); mutate(receipt);
    await assert.rejects(undoVendoredRuntimeV1({ root: state.root, receipt }), /runtime_undo_refused/u);
    assert.ok(await lstat(join(state.root, state.receipt.trees[0])));
  }

  const aliased = await undoState(t, "aliased-root");
  const aliasParent = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-undo-alias-"))); t.after(() => cleanup(aliasParent));
  const alias = join(aliasParent, "root-link");
  await symlink(aliased.root, alias);
  await assert.rejects(undoVendoredRuntimeV1({ root: alias, receipt: aliased.receipt }), /runtime_undo_refused/u);
  assert.ok(await lstat(join(aliased.root, aliased.receipt.trees[0])));
  assert.equal(await readlink(join(aliased.root, "runtime/node-current")), "node-1.2.3",
    "a symlinked root is refused before managed links change");

  const bound = await undoState(t, "current-binding"), boundReceipt = structuredClone(bound.receipt);
  boundReceipt.links.find(link => link.path.endsWith("node-current")).installedTarget = "node-9.9.9";
  await rm(join(bound.root, "runtime/node-current")); await symlink("node-9.9.9", join(bound.root, "runtime/node-current"));
  await assert.rejects(undoVendoredRuntimeV1({ root: bound.root, receipt: boundReceipt }), /runtime_undo_refused/u);
  assert.ok(await lstat(join(bound.root, bound.receipt.trees[0])));

  const ordinary = await undoState(t, "ordinary-link");
  await rm(join(ordinary.root, "runtime/node-current")); await writeFile(join(ordinary.root, "runtime/node-current"), "not-a-link");
  await assert.rejects(undoVendoredRuntimeV1({ root: ordinary.root, receipt: ordinary.receipt }), /runtime_undo_refused/u);
  assert.ok(await lstat(join(ordinary.root, ordinary.receipt.trees[0])));

  const drifted = await undoState(t, "drifted-link");
  await rm(join(drifted.root, "runtime/node-current")); await symlink("node-9.9.9", join(drifted.root, "runtime/node-current"));
  await assert.rejects(undoVendoredRuntimeV1({ root: drifted.root, receipt: drifted.receipt }), /runtime_undo_refused/u);
  assert.ok(await lstat(join(drifted.root, drifted.receipt.trees[0])));

  const linkedTree = await undoState(t, "linked-tree"), outside = join(linkedTree.root, "outside");
  await mkdir(outside); await rm(join(linkedTree.root, linkedTree.receipt.trees[0]), { recursive: true });
  await symlink(outside, join(linkedTree.root, linkedTree.receipt.trees[0]));
  await assert.rejects(undoVendoredRuntimeV1({ root: linkedTree.root, receipt: linkedTree.receipt }), /runtime_undo_refused/u);
  assert.ok((await lstat(join(linkedTree.root, linkedTree.receipt.trees[0]))).isSymbolicLink());
});

test("swapped, truncated and oversized HTTPS archives are refused before extraction", async t => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-refusal-"))); t.after(() => cleanup(fixtureRoot));
  const artifacts = await Promise.all(["node", "pnpm", "esbuild"].map(tool => archiveFixture(fixtureRoot, tool)));
  const good = artifacts[0].bytes, cases = [
    ["swapped", Buffer.from(good.map(byte => byte ^ 1))], ["truncated", good.subarray(0, good.length - 1)],
    ["oversized", Buffer.concat([good, Buffer.from("x")])],
  ];
  const fixture = await httpsFixture(t, Object.fromEntries(cases.map(([name, bytes]) => [`/${name}`, bytes])));
  for (const [name] of cases) {
    const root = await realpath(await mkdtemp(join(tmpdir(), `acr-vendor-${name}-`))); t.after(() => cleanup(root));
    const { inventory } = inventoryFor(fixture.origin, artifacts);
    inventory.artifacts[0].url = `${fixture.origin}/${name}`;
    const observations = {};
    await assert.rejects(vendorRuntimeV1(Object.freeze({ ...frozenInput(root, inventory), tools: Object.freeze(["node"]) }),
      runtimeFor(fixture, observations)), /runtime_(?:vendor_archive_invalid|download_failed)/u);
    assert.deepEqual(observations.extractions ?? [], [], name);
  }
});

test("a dropped or slow download fails closed, stop-halfway cleans up, and retry converges", async t => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-retry-fixture-"))); t.after(() => cleanup(fixtureRoot));
  const artifacts = await Promise.all(["node", "pnpm", "esbuild"].map(tool => archiveFixture(fixtureRoot, tool)));
  const fixture = await httpsFixture(t, { "/node": artifacts[0].bytes, "/drop": { drop: true },
    "/slow": { delay: 250, body: artifacts[0].bytes } });
  for (const [route, extra] of [["drop", {}], ["slow", { downloadTimeoutMs: 30 }]]) {
    const root = await realpath(await mkdtemp(join(tmpdir(), `acr-vendor-${route}-`))); t.after(() => cleanup(root));
    const { inventory } = inventoryFor(fixture.origin, artifacts); inventory.artifacts[0].url = `${fixture.origin}/${route}`;
    await assert.rejects(vendorRuntimeV1(Object.freeze({ ...frozenInput(root, inventory), tools: Object.freeze(["node"]) }),
      { ...runtimeFor(fixture), ...extra }), /runtime_download_failed/u);
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-stop-"))); t.after(() => cleanup(root));
  const { inventory } = inventoryFor(fixture.origin, artifacts), input = Object.freeze({ ...frozenInput(root, inventory), tools: Object.freeze(["node"]) });
  await assert.rejects(vendorRuntimeV1(input, { ...runtimeFor(fixture), afterArchiveSnapshot() { throw new Error("injected_stop"); } }),
    /injected_stop/u);
  await vendorRuntimeV1(input, runtimeFor(fixture));
  assert.equal(await readlink(join(root, "runtime/node-current")), "node-1.2.3");
});

test("SIGKILL after a runtime tree rename is recovered and the real vendor reruns", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-sigkill-")));
  t.after(() => cleanup(root));
  const transactionId = "sigkill-runtime", helper = join(repositoryRoot, "tests/helpers/updater-runtime-sigkill-runner.mjs");
  const child = spawn(process.execPath, [helper, root, transactionId], { detached: true, stdio: "ignore" });
  const stopped = new Promise((resolvePromise, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } });
  const marker = join(root, "kill-fixture/tree-installed");
  for (let attempt = 0; attempt < 400 && !await lstat(marker).then(() => true, () => false); attempt += 1) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  assert.equal(await lstat(marker).then(() => true, () => false), true, "child reached the in-function crash boundary");
  assert.deepEqual(await stopped, { code: null, signal: "SIGKILL" });
  const inventory = JSON.parse(await readFile(join(root, "kill-fixture/inventory.json"), "utf8"));
  await recoverPlannedRuntimeV1({ root, tools: ["node"], transactionId }, { inventory });
  await vendorRuntimeV1(Object.freeze({ root, inventory, tools: Object.freeze(["node"]), fresh: true,
    snapshots: Object.freeze({ node: join(root, "kill-fixture/node.tgz") }),
    download: Object.freeze({ uid: process.getuid(), gid: process.getgid() }), transactionId }),
  { skipMacMetadata: true });
  assert.equal(await readlink(join(root, "runtime/node-current")), "node-1.2.3");
});

test("SIGKILL inside PostgreSQL vendoring is recovered and the fixture archive reruns", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-pg-sigkill-")));
  t.after(() => cleanup(root));
  const transactionId = "sigkill-postgresql", helper = join(repositoryRoot, "tests/helpers/updater-runtime-sigkill-runner.mjs");
  const child = spawn(process.execPath, [helper, root, transactionId, "postgresql"], { detached: true, stdio: "ignore" });
  const stopped = new Promise((resolvePromise, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } });
  const marker = join(root, "kill-fixture/tree-installed");
  for (let attempt = 0; attempt < 400 && !await lstat(marker).then(() => true, () => false); attempt += 1)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  assert.equal(await lstat(marker).then(() => true, () => false), true, "PostgreSQL reached the in-function crash boundary");
  assert.deepEqual(await stopped, { code: null, signal: "SIGKILL" });
  const inventory = JSON.parse(await readFile(join(root, "kill-fixture/inventory.json"), "utf8"));
  await recoverPlannedRuntimeV1({ root, tools: ["postgresql"], transactionId }, { inventory });
  const executable = Buffer.from("postgres-binary"), archive = join(root, "kill-fixture/postgresql.tgz"),
    fakeCurl = join(root, "kill-fixture/curl.mjs");
  await vendorRuntimeV1(Object.freeze({ root, inventory, tools: Object.freeze(["postgresql"]), fresh: true,
    download: Object.freeze({ uid: process.getuid(), gid: process.getgid() }), transactionId }),
  { skipMacMetadata: true, curlPath: process.execPath, curlArgumentsPrefix: [fakeCurl],
    async vendorPostgresql({ archivePath, runtimeDirectory }) {
      assert.equal((await readFile(archivePath)).toString(), "postgres-fixture-archive");
      await mkdir(join(runtimeDirectory, "bin"), { recursive: true });
      await writeFile(join(runtimeDirectory, "bin/postgres"), executable, { mode: 0o555 });
      return { status: "pg_runtime_vendored" };
    } });
  assert.equal(await readlink(join(root, "runtime/pg-current")), "pg-17.11");
});

test("twenty concurrent callers serialize to one winner", async t => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-burst-fixture-"))); t.after(() => cleanup(fixtureRoot));
  const artifacts = await Promise.all(["node", "pnpm", "esbuild"].map(tool => archiveFixture(fixtureRoot, tool)));
  const fixture = await httpsFixture(t, { "/node": artifacts[0].bytes }), root = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-burst-")));
  t.after(() => cleanup(root));
  const { inventory } = inventoryFor(fixture.origin, artifacts), input = Object.freeze({ ...frozenInput(root, inventory), tools: Object.freeze(["node"]) });
  const burst = await Promise.allSettled(Array.from({ length: 20 }, () => vendorRuntimeV1(input, runtimeFor(fixture))));
  assert.equal(burst.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(burst.filter(row => row.status === "rejected").length, 19);
});

test("bad input, missing snapshots and a symlinked runtime root fail before extraction", async t => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-input-fixture-"))); t.after(() => cleanup(fixtureRoot));
  const artifacts = await Promise.all(["node", "pnpm", "esbuild"].map(tool => archiveFixture(fixtureRoot, tool)));
  const fixture = await httpsFixture(t, { "/node": artifacts[0].bytes });
  const { inventory } = inventoryFor(fixture.origin, artifacts);
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-input-"))); t.after(() => cleanup(root));
  await assert.rejects(vendorRuntimeV1(Object.freeze({ ...frozenInput(root, inventory), tools: Object.freeze(["unknown"]) }),
    runtimeFor(fixture)), /runtime_inventory_refused/u);
  await assert.rejects(vendorRuntimeV1(Object.freeze({ ...frozenInput(root, inventory), tools: Object.freeze(["node"]),
    snapshots: Object.freeze({ node: join(root, "missing-node.tgz") }) }), runtimeFor(fixture)),
  /runtime_vendor_archive_invalid/u);
  const linkedRoot = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-linked-"))), outside = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-outside-")));
  t.after(() => cleanup(linkedRoot)); t.after(() => cleanup(outside)); await symlink(outside, join(linkedRoot, "runtime"));
  await assert.rejects(vendorRuntimeV1(Object.freeze({ ...frozenInput(linkedRoot, inventory), tools: Object.freeze(["node"]) }),
    runtimeFor(fixture)), /runtime_vendor_destination_exists/u);
  assert.deepEqual(await readdir(outside), []);
});

test("independent size, archive digest, executable digest and fresh-link guards fail closed", async t => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-guards-fixture-"))); t.after(() => cleanup(fixtureRoot));
  const artifacts = await Promise.all(["node", "pnpm", "esbuild"].map(tool => archiveFixture(fixtureRoot, tool)));
  const fixture = await httpsFixture(t, { "/node": artifacts[0].bytes });
  for (const [label, mutate] of [
    ["archiveBytes", row => { row.archiveBytes += 1; }],
    ["archiveSha256", row => { row.archiveSha256 = "0".repeat(64); }],
    ["executableSha256", row => { row.executableSha256 = "0".repeat(64); }],
  ]) {
    const root = await realpath(await mkdtemp(join(tmpdir(), `acr-vendor-${label}-`))); t.after(() => cleanup(root));
    const { inventory } = inventoryFor(fixture.origin, artifacts); mutate(inventory.artifacts[0]);
    await assert.rejects(vendorRuntimeV1(Object.freeze({ ...frozenInput(root, inventory), tools: Object.freeze(["node"]) }),
      runtimeFor(fixture)), /runtime_vendor_archive_invalid/u, label);
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-fresh-link-"))); t.after(() => cleanup(root));
  await mkdir(join(root, "runtime")); await symlink("attacker-target", join(root, "runtime/node-previous"));
  const { inventory } = inventoryFor(fixture.origin, artifacts), observations = {};
  await assert.rejects(vendorRuntimeV1(Object.freeze({ ...frozenInput(root, inventory), tools: Object.freeze(["node"]) }),
    runtimeFor(fixture, observations)), /runtime_link_refused/u);
  assert.deepEqual(observations.downloads ?? [], []);
  const pgRoot = await realpath(await mkdtemp(join(tmpdir(), "acr-vendor-pg-digest-"))); t.after(() => cleanup(pgRoot));
  const pgFixture = inventoryFor(fixture.origin, artifacts); fixture.routes.set("/postgresql", pgFixture.pgBytes);
  pgFixture.inventory.artifacts[3].executableSha256 = "0".repeat(64);
  await assert.rejects(vendorRuntimeV1(Object.freeze({ ...frozenInput(pgRoot, pgFixture.inventory),
    tools: Object.freeze(["postgresql"]) }), runtimeFor(fixture)), /pg_runtime_vendor_refused/u);
});

function verifierInventory(bodies, nodeProof = { kind: "none" }) {
  const names = ["node", "pnpm", "esbuild", "postgresql"], links = ["node", "pnpm", "esbuild", "pg"],
    extractions = ["tar-gz-strip-1", "tar-gz", "npm-tgz-bin-esbuild", "edb-zip-allowlist-v1"];
  return { schema: "control-room.runtime-inventory/v1", platform: "darwin", architecture: "arm64", artifacts: names.map((tool, index) => ({
    tool, version: tool === "postgresql" ? "17.11" : "1.2.3", linkBase: links[index],
    archiveName: tool === "postgresql" ? "postgresql-17.11-4-osx-binaries.zip" : `${tool}.tgz`, url: `https://fixture.invalid/${tool}`,
    archiveSha256: sha256(bodies[tool]), archiveBytes: bodies[tool].length, extraction: extractions[index],
    executableRelativePath: tool === "node" ? "bin/node" : tool === "postgresql" ? "bin/postgres" : tool,
    executableSha256: String(index + 1).repeat(64), publisherProof: tool === "node" ? nodeProof : { kind: "none" },
    // `teamIdentifier` and the developer-id proof are REQUIRED for PostgreSQL by
    // finding 9: the digest in this fixture is of a fake archive, so the only
    // thing that would be real in a production run is the signature, and a
    // fixture that omitted the field would be asserting the inventory shape as
    // it was before the finding rather than as it is now.
    ...(tool === "postgresql"
      ? { provenance: { etag: null, lastModified: null }, teamIdentifier: "26QKX55P9K",
        publisherProof: { kind: "developer-id", teamIdentifier: "26QKX55P9K",
          identifier: "com.edb.postgresql", measured: "fixture" } }
      : {}),
  })) };
}

test("CI verifier rejects a one-byte archive change and a bad Node GPG signature", async t => {
  const bodies = { node: Buffer.from("node"), pnpm: Buffer.from("pnpm"), esbuild: Buffer.from("esbuild"), postgresql: Buffer.from("pg") };
  const nodeProof = { kind: "nodejs-shasums-gpg", shasumsUrl: "https://fixture.invalid/sums",
    signatureUrl: "https://fixture.invalid/sums.asc", keyringUrl: "https://fixture.invalid/keys", signerFingerprints: ["A".repeat(40)] };
  const inventory = verifierInventory(bodies, nodeProof);
  const run = async (overrides = {}) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "acr-runtime-ci-"))); t.after(() => cleanup(root));
    return verifyRuntimeInventoryV1({ inventory, workDirectory: root }, { async downloadToFile(url, destination) {
      const tool = url.split("/").at(-1), body = overrides[tool] ?? bodies[tool];
      await writeFile(destination, body); return body.length;
    }, async verifyNodeGpg() { if (overrides.badSignature) throw new Error("bad signature"); } });
  };
  await run();
  await assert.rejects(run({ pnpm: Buffer.from("pnpo") }), /runtime_inventory_verification_failed/u);
  await assert.rejects(run({ badSignature: true }), /bad signature/u);
});

test("CI verifier binds esbuild bytes to the npm registry integrity proof", async t => {
  const bodies = { node: Buffer.from("node"), pnpm: Buffer.from("pnpm"), esbuild: Buffer.from("esbuild"), postgresql: Buffer.from("pg") };
  const inventory = verifierInventory(bodies);
  const esbuild = inventory.artifacts.find(row => row.tool === "esbuild");
  esbuild.publisherProof = { kind: "npm-integrity", metadataUrl: "https://fixture.invalid/esbuild-metadata",
    sha512: sha512(bodies.esbuild) };
  const run = async integrity => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "acr-runtime-npm-"))); t.after(() => cleanup(root));
    return verifyRuntimeInventoryV1({ inventory, workDirectory: root }, { async downloadToFile(url, destination) {
      const name = url.split("/").at(-1);
      const body = name === "esbuild-metadata" ? Buffer.from(JSON.stringify({ dist: {
        integrity: `sha512-${integrity}`, tarball: esbuild.url } })) : bodies[name];
      await writeFile(destination, body); return body.length;
    } });
  };
  await run(esbuild.publisherProof.sha512);
  await assert.rejects(run(Buffer.from("wrong").toString("base64")), /runtime_inventory_verification_failed/u);
});
