import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleLocalReleaseV1,
  validateRuntimeLicenseEvidenceV1,
  verifyExtractedLocalReleaseV1,
} from "../src/installer/v1/local-release-assembly.mjs";

const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const refusal = { message: "local_release_assembly_refused" };
const temporaryRoot = async prefix => realpath(await mkdtemp(join(tmpdir(), prefix)));
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function extract(archive, destination) {
  await run("tar", ["-xzf", archive, "-C", destination]);
  return join(destination, "agent-control-room-0.1.0");
}

async function stagedExtractedRelease(extractedRoot, root, manifest) {
  const installRoot = join(root, "install");
  const versionsRoot = join(installRoot, "versions");
  const versionRoot = join(versionsRoot, manifest.version);
  await cp(extractedRoot, versionRoot, { recursive: true });
  const manifestBytes = await readFile(join(versionRoot, "RELEASE_MANIFEST.json"));
  const manifestDigest = sha256(manifestBytes);
  await writeFile(join(versionsRoot, `.publish-${manifest.version}.json`), `${JSON.stringify({
    schema: "control-room.local-release-publication-claim/v1",
    version: manifest.version,
    manifestSha256: manifestDigest.slice("sha256:".length),
  })}\n`);
  return { installRoot, versionRoot, manifestDigest };
}

test("assembles the same reviewed release bytes twice with no installation effect", async () => {
  const root = await temporaryRoot("acr-release-assembly-");
  try {
    const first = await assembleLocalReleaseV1({ releaseRoot: repository, outputDirectory: join(root, "first") });
    const second = await assembleLocalReleaseV1({ releaseRoot: repository, outputDirectory: join(root, "second") });
    assert.deepEqual(first, second);
    assert.equal(first.publishes, false);
    assert.equal(first.signs, false);
    assert.equal(first.installs, false);
    assert.deepEqual(await readdir(join(root, "first")), [
      "SHA256SUMS",
      "agent-control-room-0.1.0.manifest.json",
      "agent-control-room-0.1.0.tar.gz",
    ]);
    assert.deepEqual(
      await readFile(join(root, "first", first.archiveName)),
      await readFile(join(root, "second", second.archiveName)),
    );
    const checksum = await readFile(join(root, "first", first.checksumName), "utf8");
    assert.equal(checksum, `${first.archiveSha256}  ${first.archiveName}\n`);
    const manifest = JSON.parse(await readFile(join(root, "first", first.manifestName), "utf8"));
    const paths = new Set(manifest.files.map(entry => entry.path));
    assert.equal(paths.has("scripts/prepare-local-installation.mjs"), true);
    assert.equal(paths.has("scripts/prepare-local-production-dependencies.mjs"), true);
    assert.equal(paths.has("scripts/launch-local-setup.mjs"), true);
    assert.equal(paths.has("scripts/initialize-local-installation-plan.mjs"), true);
    assert.equal(paths.has("scripts/run-local-setup-host.mjs"), true);
    assert.equal(paths.has("src/installer/v1/local-clean-install-acceptance.mjs"), true);
    assert.equal(paths.has("src/installer/v1/local-installation-release.mjs"), true);
    assert.equal(paths.has("src/installer/v1/local-production-dependencies.mjs"), true);
    assert.equal(paths.has("src/installer/v1/local-release-assembly.mjs"), true);
    assert.equal(paths.has("src/installer/v1/local-release-stager.mjs"), true);
    assert.equal(paths.has("deploy/postgres/migration-ledger.json"), true);
    assert.equal(paths.has("db/migrations/0084_installation_transition_revisions.sql"), true);
    assert.equal(paths.has("research/runtime-license-manifest.json"), true);
    assert.equal(paths.has("THIRD_PARTY.md"), true);
    assert.deepEqual(manifest.platform, {
      artifact: "portable-node",
      operatingSystems: ["darwin", "linux"],
      architectures: ["arm64", "x64"],
      node: ">=22.13.0",
    });
    assert.equal(manifest.license.completeDistributionClearance, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an extracted release runs its shipped dependency-preparation CLI with a controlled package runner", async () => {
  const root = await temporaryRoot("acr-release-dependency-entrypoint-");
  try {
    const report = await assembleLocalReleaseV1({ releaseRoot: repository, outputDirectory: join(root, "output") });
    const manifest = JSON.parse(await readFile(join(root, "output", report.manifestName), "utf8"));
    const extractedRoot = await extract(join(root, "output", report.archiveName), root);
    const { installRoot, versionRoot, manifestDigest } = await stagedExtractedRelease(extractedRoot, root, manifest);
    const fakeBin = join(root, "controlled-bin"), callsPath = join(root, "pnpm-calls.jsonl");
    await mkdir(fakeBin);
    const fakePnpm = join(fakeBin, "pnpm");
    await writeFile(fakePnpm, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "--version") { process.stdout.write("11.19.0\\n"); process.exit(0); }
const cwd = process.cwd(), pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
fs.mkdirSync(path.join(cwd, "node_modules", ".pnpm"), { recursive: true });
fs.writeFileSync(path.join(cwd, "node_modules", ".modules.yaml"), "layoutVersion: 5\\n");
for (const [name, version] of Object.entries(pkg.dependencies)) {
  const dir = path.join(cwd, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }) + "\\n");
}
process.stdout.write("prepared by controlled test fixture\\n");
`, { mode: 0o700 });
    await chmod(fakePnpm, 0o700);
    const cli = join(versionRoot, "scripts/prepare-local-production-dependencies.mjs");
    const execution = await run(process.execPath, [cli, "--owner-attended", "--install-root", installRoot,
      "--version", manifest.version, "--expected-manifest-digest", manifestDigest], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    });
    const prepared = JSON.parse(execution.stdout);
    assert.equal(prepared.state, "production_dependencies_prepared");
    assert.equal(prepared.runsPackageScripts, false);
    assert.equal(prepared.installsOrStartsService, false);
    assert.equal(prepared.createsOrMigratesDatabase, false);
    const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(calls[0], ["--version"]);
    assert.deepEqual(calls[1].slice(0, 4), ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"]);
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function copyLicenseFixture(destination) {
  await mkdir(destination);
  for (const path of ["package.json", "pnpm-lock.yaml", "THIRD_PARTY.md"]) {
    await cp(join(repository, path), join(destination, path));
  }
  for (const path of ["research", "third_party", "src/vendor"]) {
    await cp(join(repository, path), join(destination, path), { recursive: true });
  }
}

test("license qualification fails closed on dependency, retained source or saved evidence drift", async () => {
  const root = await temporaryRoot("acr-release-license-");
  try {
    const changes = [
      async fixture => {
        const path = join(fixture, "package.json");
        const value = JSON.parse(await readFile(path, "utf8"));
        value.dependencies["unexpected-package"] = "1.0.0";
        await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
      },
      fixture => writeFile(join(fixture, "pnpm-lock.yaml"), "# changed lock\n"),
      fixture => writeFile(join(fixture, "third_party/pg/LICENSE"), "changed license\n"),
      async fixture => {
        const path = join(fixture, "research/runtime-license-artifact-inventory.json");
        const value = JSON.parse(await readFile(path, "utf8"));
        value.inventoryDigest = "0".repeat(64);
        await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
      },
    ];
    for (let index = 0; index < changes.length; index += 1) {
      const fixture = join(root, `fixture-${index}`);
      await copyLicenseFixture(fixture);
      assert.equal((await validateRuntimeLicenseEvidenceV1(fixture)).verified, true);
      await changes[index](fixture);
      await assert.rejects(validateRuntimeLicenseEvidenceV1(fixture), refusal);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the extracted archive verifies and refuses changed, missing, extra or linked content", async () => {
  const root = await temporaryRoot("acr-release-verification-");
  try {
    const report = await assembleLocalReleaseV1({ releaseRoot: repository, outputDirectory: join(root, "output") });
    const manifest = JSON.parse(await readFile(join(root, "output", report.manifestName), "utf8"));
    const extractRoot = await extract(join(root, "output", report.archiveName), root);
    assert.deepEqual(await verifyExtractedLocalReleaseV1(extractRoot, manifest), {
      verified: true,
      fileCount: manifest.fileCount,
      byteCount: manifest.byteCount,
    });
    await assert.rejects(verifyExtractedLocalReleaseV1(extractRoot, { ...manifest, unexpected: true }), refusal);

    await writeFile(join(extractRoot, "unexpected.txt"), "not listed\n");
    await assert.rejects(verifyExtractedLocalReleaseV1(extractRoot, manifest), refusal);
    await unlink(join(extractRoot, "unexpected.txt"));

    await writeFile(join(extractRoot, "NOTICE"), "changed\n");
    await assert.rejects(verifyExtractedLocalReleaseV1(extractRoot, manifest), refusal);
    const notice = manifest.files.find(entry => entry.path === "NOTICE");
    const sourceNotice = await readFile(join(repository, "NOTICE"));
    assert.equal(sourceNotice.byteLength, notice.bytes);
    await writeFile(join(extractRoot, "NOTICE"), sourceNotice);

    await unlink(join(extractRoot, "LICENSE"));
    await assert.rejects(verifyExtractedLocalReleaseV1(extractRoot, manifest), refusal);
    await writeFile(join(extractRoot, "LICENSE"), await readFile(join(repository, "LICENSE")));

    await symlink("package.json", join(extractRoot, "unexpected-link"));
    await assert.rejects(verifyExtractedLocalReleaseV1(extractRoot, manifest), refusal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the extracted release refuses an altered or missing shipped dependency preparer", async () => {
  const root = await temporaryRoot("acr-release-dependency-integrity-");
  try {
    const report = await assembleLocalReleaseV1({ releaseRoot: repository, outputDirectory: join(root, "output") });
    const manifest = JSON.parse(await readFile(join(root, "output", report.manifestName), "utf8"));
    await mkdir(join(root, "altered"));
    const alteredRoot = await extract(join(root, "output", report.archiveName), join(root, "altered"));
    await writeFile(join(alteredRoot, "scripts/prepare-local-production-dependencies.mjs"), "changed\n");
    await assert.rejects(verifyExtractedLocalReleaseV1(alteredRoot, manifest), refusal);

    await mkdir(join(root, "missing"));
    const missingRoot = await extract(join(root, "output", report.archiveName), join(root, "missing"));
    await unlink(join(missingRoot, "src/installer/v1/local-production-dependencies.mjs"));
    await assert.rejects(verifyExtractedLocalReleaseV1(missingRoot, manifest), refusal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assembly refuses output paths inside the checkout and existing output directories", async () => {
  const root = await temporaryRoot("acr-release-refusal-");
  try {
    await assert.rejects(assembleLocalReleaseV1({
      releaseRoot: repository,
      outputDirectory: join(repository, "dist-vps", "release"),
    }), refusal);
    await writeFile(join(root, "occupied"), "file");
    await assert.rejects(assembleLocalReleaseV1({
      releaseRoot: repository,
      outputDirectory: join(root, "occupied"),
    }), refusal);
    await assert.rejects(run(process.execPath, [
      join(repository, "scripts/assemble-local-release.mjs"),
      "--release-root", ".",
      "--output-directory", join(root, "relative-refused"),
    ], { cwd: repository }), error => error?.code === 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
