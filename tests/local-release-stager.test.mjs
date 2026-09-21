import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { assembleLocalReleaseV1 } from "../src/installer/v1/local-release-assembly.mjs";
import { stageLocalReleaseV1 } from "../src/installer/v1/local-release-stager.mjs";

const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const refused = { message: "local_release_staging_refused" };
const claimName = ".publish-0.1.0.json";
let suiteRoot;
let releaseDirectory;

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function writeOctal(buffer, offset, length, number) {
  buffer.write(number.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function tarHeader(path, size, type = "0") {
  const header = Buffer.alloc(512, 0);
  header.write(path, 0, 100, "ascii");
  writeOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function tarSize(header) {
  return Number.parseInt(header.subarray(124, 136).toString("ascii").replaceAll("\0", "").trim(), 8);
}

function appendTarEntry(archive, path, type) {
  const tar = gunzipSync(archive);
  assert.equal(tar.subarray(-1024).every(byte => byte === 0), true);
  const entry = tarHeader(path, 0, type);
  return gzipSync(Buffer.concat([tar.subarray(0, -1024), entry, Buffer.alloc(1024)]), { level: 9, mtime: 0 });
}

function alterNotice(archive) {
  const tar = Buffer.from(gunzipSync(archive));
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = tarSize(header);
    const name = header.subarray(0, 100).toString("ascii").replaceAll("\0", "");
    if (name.endsWith("/NOTICE")) {
      assert.ok(size > 0);
      tar[offset + 512] ^= 1;
      return gzipSync(tar, { level: 9, mtime: 0 });
    }
    offset += 512 + size + ((512 - (size % 512)) % 512);
  }
  throw new Error("NOTICE not found");
}

async function replaceArchive(directory, bytes) {
  const archive = "agent-control-room-0.1.0.tar.gz";
  await writeFile(join(directory, archive), bytes);
  await writeFile(join(directory, "SHA256SUMS"), `${sha256(bytes)}  ${archive}\n`);
}

async function copiedRelease(name) {
  const target = join(suiteRoot, name);
  await cp(releaseDirectory, target, { recursive: true });
  return realpath(target);
}

async function installRoot(name) {
  const path = join(suiteRoot, name);
  await mkdir(path);
  return realpath(path);
}

before(async () => {
  suiteRoot = await realpath(await mkdtemp(join(tmpdir(), "acr-release-stager-")));
  releaseDirectory = join(suiteRoot, "release");
  await assembleLocalReleaseV1({ releaseRoot: repository, outputDirectory: releaseDirectory });
});

after(async () => {
  await rm(suiteRoot, { recursive: true, force: true });
});

test("stages an exact release once, retries idempotently and never creates current", async () => {
  const root = await installRoot("install-exact");
  await assert.rejects(stageLocalReleaseV1({ ownerAttended: false, releaseDirectory, installRoot: root }), refused);
  const first = await stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot: root });
  assert.equal(first.state, "verified_release_staged");
  assert.equal(first.alreadyStaged, false);
  assert.equal(first.remainingCategory, "production_dependencies_not_prepared");
  assert.equal(first.switchesCurrentRelease, false);
  assert.equal(first.installsOrStartsService, false);
  await assert.rejects(access(join(root, "current")), error => error?.code === "ENOENT");
  assert.deepEqual((await readdir(join(root, "versions"))).sort(), [claimName, "0.1.0"]);
  const second = await stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot: root });
  assert.equal(second.alreadyStaged, true);
  assert.deepEqual({ ...second, alreadyStaged: false }, first);
});

test("refuses a changed occupied version and preserves it", async () => {
  const root = await installRoot("install-occupied");
  const occupied = join(root, "versions/0.1.0");
  await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, "owner-file"), "keep\n");
  await assert.rejects(stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot: root }), refused);
  assert.equal(await readFile(join(occupied, "owner-file"), "utf8"), "keep\n");

  const emptyRoot = await installRoot("install-occupied-empty");
  const emptyOccupied = join(emptyRoot, "versions/0.1.0");
  await mkdir(emptyOccupied, { recursive: true });
  await assert.rejects(stageLocalReleaseV1({ ownerAttended: true,
    releaseDirectory, installRoot: emptyRoot }), refused);
  assert.deepEqual(await readdir(emptyOccupied), []);
});

test("concurrent exact staging converges without replacing the claimed version", async () => {
  const root = await installRoot("install-concurrent");
  const results = await Promise.all([
    stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot: root }),
    stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot: root }),
  ]);
  assert.deepEqual(results.map(result => result.alreadyStaged).sort(), [false, true]);
  assert.deepEqual((await readdir(join(root, "versions"))).sort(), [claimName, "0.1.0"]);
});

test("many concurrent exact attempts converge behind one durable publication marker", async () => {
  const root = await installRoot("install-concurrent-many");
  const results = await Promise.all(Array.from({ length: 8 }, () => stageLocalReleaseV1({
    ownerAttended: true, releaseDirectory, installRoot: root,
  })));
  assert.equal(results.filter(result => result.alreadyStaged === false).length, 1);
  assert.equal(results.filter(result => result.alreadyStaged === true).length, 7);
  assert.deepEqual((await readdir(join(root, "versions"))).sort(), [claimName, "0.1.0"]);
  const claim = JSON.parse(await readFile(join(root, "versions", claimName), "utf8"));
  assert.equal(claim.schema, "control-room.local-release-publication-claim/v1");
  assert.equal(claim.version, "0.1.0");
});

test("cleans its temporary directory when extracted bytes fail manifest verification", async () => {
  const release = await copiedRelease("release-tampered-content");
  const archivePath = join(release, "agent-control-room-0.1.0.tar.gz");
  await replaceArchive(release, alterNotice(await readFile(archivePath)));
  const root = await installRoot("install-tampered-content");
  await assert.rejects(stageLocalReleaseV1({ ownerAttended: true, releaseDirectory: release, installRoot: root }), refused);
  assert.deepEqual(await readdir(join(root, "versions")), []);
});

test("refuses traversal and link archive entries before extraction", async () => {
  for (const [name, path, type] of [
    ["traversal", "agent-control-room-0.1.0/../escape", "0"],
    ["link", "agent-control-room-0.1.0/unexpected-link", "2"],
  ]) {
    const release = await copiedRelease(`release-${name}`);
    const archivePath = join(release, "agent-control-room-0.1.0.tar.gz");
    await replaceArchive(release, appendTarEntry(await readFile(archivePath), path, type));
    const root = await installRoot(`install-${name}`);
    await assert.rejects(stageLocalReleaseV1({ ownerAttended: true, releaseDirectory: release, installRoot: root }), refused);
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(access(join(suiteRoot, "escape")), error => error?.code === "ENOENT");
  }
});

test("fully refuses invalid external manifest contracts before creating versions", async () => {
  const mutations = [
    value => { value.product = "different-product"; },
    value => { value.platform.operatingSystems = ["darwin", "windows"]; },
    value => { value.dependencyPreparation.mode = "unfrozen"; },
    value => { value.unexpected = true; },
  ];
  for (let index = 0; index < mutations.length; index += 1) {
    const release = await copiedRelease(`release-invalid-manifest-${index}`);
    const manifestPath = join(release, "agent-control-room-0.1.0.manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    mutations[index](manifest);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const root = await installRoot(`install-invalid-manifest-${index}`);
    await assert.rejects(stageLocalReleaseV1({ ownerAttended: true,
      releaseDirectory: release, installRoot: root }), refused);
    assert.deepEqual(await readdir(root), []);
  }
});

test("resumes a complete hidden ready tree after an interrupted publication", async () => {
  const root = await installRoot("install-ready-recovery");
  await stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot: root });
  const manifestBytes = await readFile(join(releaseDirectory,
    "agent-control-room-0.1.0.manifest.json"));
  const ready = join(root, `versions/.ready-0.1.0-${sha256(manifestBytes)}`);
  await rename(join(root, "versions/0.1.0"), ready);
  const recovered = await stageLocalReleaseV1({ ownerAttended: true,
    releaseDirectory, installRoot: root });
  assert.equal(recovered.state, "verified_release_staged");
  assert.deepEqual((await readdir(join(root, "versions"))).sort(), [claimName, "0.1.0"]);
});

test("an unrelated interrupted staging directory is never mistaken for a release", async () => {
  const root = await installRoot("install-interrupted");
  await mkdir(join(root, "versions/.staging-interrupted"), { recursive: true });
  await writeFile(join(root, "versions/.staging-interrupted/evidence"), "uncertain\n");
  const result = await stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot: root });
  assert.equal(result.state, "verified_release_staged");
  assert.equal(await readFile(join(root, "versions/.staging-interrupted/evidence"), "utf8"), "uncertain\n");
  assert.deepEqual((await readdir(join(root, "versions"))).sort(),
    [claimName, ".staging-interrupted", "0.1.0"].sort());
});

test("CLI requires owner attendance and raw canonical absolute paths", async () => {
  const script = join(repository, "scripts/stage-local-release.mjs");
  const root = await installRoot("install-cli-refusal");
  await assert.rejects(run(process.execPath, [script,
    "--release-directory", releaseDirectory, "--install-root", root,
  ]), error => error?.code === 2);
  await assert.rejects(run(process.execPath, [script,
    "--owner-attended", "--release-directory", ".", "--install-root", root,
  ], { cwd: repository }), error => error?.code === 2);
});
