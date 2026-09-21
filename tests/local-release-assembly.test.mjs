import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
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

async function extract(archive, destination) {
  await run("tar", ["-xzf", archive, "-C", destination]);
  return join(destination, "agent-control-room-0.1.0");
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
    assert.equal(paths.has("src/installer/v1/local-installation-release.mjs"), true);
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
