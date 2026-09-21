import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assembleLocalReleaseV1 } from "../src/installer/v1/local-release-assembly.mjs";

const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const topologyDigest = `sha256:${"a".repeat(64)}`;
const temporaryRoot = async prefix => realpath(await mkdtemp(join(tmpdir(), prefix)));

async function extract(archive, destination) {
  await run("tar", ["-xzf", archive, "-C", destination]);
  return join(destination, "agent-control-room-0.1.0");
}

async function controlledPnpm(root) {
  const bin = join(root, "controlled-bin"), calls = join(root, "pnpm-calls.jsonl"), executable = join(bin, "pnpm");
  await mkdir(bin);
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "--version") { process.stdout.write("11.19.0\\n"); process.exit(0); }
const cwd = process.cwd(), pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
fs.mkdirSync(path.join(cwd, "node_modules", ".pnpm"), { recursive: true });
fs.writeFileSync(path.join(cwd, "node_modules", ".modules.yaml"), "layoutVersion: 5\\n");
fs.writeFileSync(path.join(cwd, "node_modules", ".pnpm", "lock.yaml"), "controlled source-only rehearsal\\n");
for (const [name, version] of Object.entries(pkg.dependencies)) {
  const directory = path.join(cwd, "node_modules", ...name.split("/"));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version }) + "\\n");
}
process.stdout.write("prepared by controlled fixture\\n");
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { bin, calls };
}

function args({ mode, releaseDirectory, installRoot, journalRoot }) {
  return ["--owner-attended", "--mode", mode,
    ...(releaseDirectory ? ["--release-directory", releaseDirectory] : []),
    "--install-root", installRoot, "--journal-root", journalRoot,
    "--installation-id", "acceptance-local-one", "--topology-plan-digest", topologyDigest];
}

test("an extracted release runs the shipped clean-install rehearsal across separate processes", async t => {
  const root = await temporaryRoot("acr-clean-install-release-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const download = join(root, "download");
  const assembled = await assembleLocalReleaseV1({ releaseRoot: repository, outputDirectory: download });
  const extracted = await extract(join(download, assembled.archiveName), root);
  const installRoot = join(root, "private-install"), journalRoot = join(root, "private-journal");
  await mkdir(installRoot, { mode: 0o700 }); await mkdir(journalRoot, { mode: 0o700 });
  const fake = await controlledPnpm(root), cli = join(extracted, "scripts", "launch-local-setup.mjs");
  const environment = { ...process.env, PATH: `${fake.bin}:${process.env.PATH ?? ""}` };

  const begun = JSON.parse((await run(process.execPath, [cli, ...args({ mode: "begin", releaseDirectory: download, installRoot, journalRoot })],
    { env: environment })).stdout);
  assert.equal(begun.state, "source_only_rehearsal_begun");
  assert.equal(begun.extractedReleaseVerified, true);
  assert.equal(begun.dependenciesPrepared, true);
  assert.equal(begun.createsDatabase, false);
  assert.equal(begun.startsService, false);
  assert.equal(begun.startsWorker, false);
  assert.equal(begun.mayUseNetworkForDependencies, true);
  assert.equal(begun.networkUseControlledByPackageManager, true);
  assert.equal(begun.servicePlan.simulated, true);
  assert.ok(begun.servicePlan.steps.indexOf("start_service") > begun.servicePlan.steps.indexOf("install_service_definition"));

  const resumed = JSON.parse((await run(process.execPath, [cli, ...args({ mode: "resume", installRoot, journalRoot })],
    { env: environment })).stdout);
  assert.equal(resumed.state, "source_only_rehearsal_resumed");
  assert.equal(resumed.journalResumed, true);
  assert.equal(resumed.releaseManifestDigest, begun.releaseManifestDigest);
  const callsBeforeMutation = (await readFile(fake.calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(callsBeforeMutation[0], ["--version"]);
  assert.deepEqual(callsBeforeMutation[1].slice(0, 4), ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"]);
  assert.equal(callsBeforeMutation.length, 2, "the restarted process used the durable receipt rather than rerunning pnpm");

  const packagePath = join(installRoot, "versions", begun.version, "package.json");
  await writeFile(packagePath, `${await readFile(packagePath, "utf8")}\n`);
  await assert.rejects(() => run(process.execPath, [cli, ...args({ mode: "resume", installRoot, journalRoot })], { env: environment }),
    error => error?.code === 1 && /local setup rehearsal refused/u.test(error.stderr));
  const callsAfterMutation = (await readFile(fake.calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(callsAfterMutation.length, 2, "changed releases refuse before another package-manager call");
});

test("the shipped rehearsal CLI rejects malformed input without staging", async t => {
  const root = await temporaryRoot("acr-clean-install-cli-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const download = join(root, "download");
  const assembled = await assembleLocalReleaseV1({ releaseRoot: repository, outputDirectory: download });
  const extracted = await extract(join(download, assembled.archiveName), root);
  await assert.rejects(() => run(process.execPath, [join(extracted, "scripts", "launch-local-setup.mjs"), "--owner-attended" ]),
    error => error?.code === 2 && /Usage:/u.test(error.stderr));
});
