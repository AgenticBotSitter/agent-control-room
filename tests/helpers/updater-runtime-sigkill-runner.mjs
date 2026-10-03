import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadRuntimeInventoryV1, vendorRuntimeV1 } from "../../src/updater/v1/install/runtime.mjs";

const root = process.argv[2], transactionId = process.argv[3], tool = process.argv[4] ?? "node";
if (!root || !transactionId) process.exit(64);
const fixture = join(root, "kill-fixture"), tree = join(fixture, "tree"), archive = join(fixture, `${tool}.tgz`);
if (!['node', 'postgresql'].includes(tool)) process.exit(64);
if (tool === "postgresql") {
  const body = Buffer.from("postgres-fixture-archive"), executableBody = Buffer.from("postgres-binary");
  await mkdir(fixture, { recursive: true }); await writeFile(archive, body, { mode: 0o600 });
  const digest = value => createHash("sha256").update(value).digest("hex"), checked = await loadRuntimeInventoryV1();
  const postgresql = { tool, version: "17.11", linkBase: "pg", archiveName: "postgresql.tgz",
    url: "https://invalid.example/postgresql.tgz", archiveSha256: digest(body), archiveBytes: body.length,
    extraction: "edb-zip-allowlist-v1", executableRelativePath: "bin/postgres",
    executableSha256: digest(executableBody),
    // Finding 9 made both of these REQUIRED for PostgreSQL: `teamIdentifier` is
    // the publisher check the self-attested digest is not, and the proof names
    // the same identifier. This fixture's archive is fake, so nothing here is a
    // real signature — the fields exist because the inventory validator refuses
    // an artifact without them, and a fixture that omitted them would be
    // asserting the pre-finding shape.
    teamIdentifier: "26QKX55P9K",
    publisherProof: { kind: "developer-id", teamIdentifier: "26QKX55P9K",
      identifier: "com.edb.postgresql", measured: "fixture" },
    provenance: { etag: null, lastModified: null } };
  const inventory = { ...checked, artifacts: checked.artifacts.map(value => value.tool === tool ? postgresql : value) };
  await writeFile(join(fixture, "inventory.json"), `${JSON.stringify(inventory)}\n`, { mode: 0o600 });
  const fakeCurl = join(fixture, "curl.mjs");
  await writeFile(fakeCurl, `import{copyFile}from'node:fs/promises';let a=process.argv.slice(2),o=a[a.indexOf('--output')+1];await copyFile(${JSON.stringify(archive)},o);\n`,
    { mode: 0o500 });
  await vendorRuntimeV1(Object.freeze({ root, inventory, tools: Object.freeze([tool]), fresh: true,
    download: Object.freeze({ uid: process.getuid(), gid: process.getgid() }), transactionId }),
  { skipMacMetadata: true, curlPath: process.execPath, curlArgumentsPrefix: [fakeCurl],
    async vendorPostgresql({ archivePath, runtimeDirectory }) {
      if (!(await readFile(archivePath)).equals(body)) throw new Error("fixture_archive_changed");
      await mkdir(join(runtimeDirectory, "bin"), { recursive: true });
      await writeFile(join(runtimeDirectory, "bin/postgres"), executableBody, { mode: 0o555 });
      return { status: "pg_runtime_vendored" };
    }, async afterRuntimeTreeInstalled() {
      await writeFile(join(fixture, "tree-installed"), "yes\n", { mode: 0o600 });
      process.kill(process.pid, "SIGKILL");
    } });
  process.exit(66);
}
const executable = join(tree, "node-v1.2.3/bin/node");
const body = Buffer.from("#!/bin/sh\nprintf 'node 1.2.3\\n'\n");
await mkdir(dirname(executable), { recursive: true });
await writeFile(executable, body, { mode: 0o755 });
const packed = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", tree, "node-v1.2.3"], { env: {}, encoding: "utf8" });
if (packed.status !== 0) process.exit(65);
await chmod(archive, 0o600);
const bytes = await readFile(archive), digest = value => createHash("sha256").update(value).digest("hex");
const checked = await loadRuntimeInventoryV1();
const node = { tool: "node", version: "1.2.3", linkBase: "node", archiveName: "node.tgz",
  url: "https://invalid.example/node.tgz", archiveSha256: digest(bytes), archiveBytes: bytes.length,
  extraction: "tar-gz-strip-1", executableRelativePath: "bin/node", executableSha256: digest(body),
  publisherProof: { kind: "none" } };
const inventory = { ...checked, artifacts: checked.artifacts.map(value => value.tool === "node" ? node : value) };
await writeFile(join(fixture, "inventory.json"), `${JSON.stringify(inventory)}\n`, { mode: 0o600 });
await vendorRuntimeV1(Object.freeze({ root, inventory, tools: Object.freeze(["node"]), fresh: true,
  snapshots: Object.freeze({ node: archive }), download: Object.freeze({ uid: process.getuid(), gid: process.getgid() }),
  transactionId }), { skipMacMetadata: true, async afterRuntimeTreeInstalled() {
    await writeFile(join(fixture, "tree-installed"), "yes\n", { mode: 0o600 });
    process.kill(process.pid, "SIGKILL");
  } });
