// Release path acceptance tests: archive, integrity refusal, staged update,
// rollback and refusal, and preservation of durable and uncertain work.
//
// These drive the real builder/verifier/update scripts against real archives in
// a throwaway temporary root. Nothing is mocked: the archive is genuinely packed
// with tar, genuinely unpacked, and genuinely re-hashed, so an integrity failure
// is a real refusal rather than a simulated one.
//
// Fixtures are genuine git repositories because the builder's provenance gate
// refuses a revision that is not the checkout's clean HEAD — testing that gate
// requires the real thing rather than a stub.
//
// NOT covered here: running systemd itself. These tests exercise the release
// path's activate/rollback contract, which is exactly what the supervised unit
// invokes. Real start/stop/drain under systemd is a Linux integration check and
// is declared as such in docs/operations/supervisor.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { assembleRelease, MANIFEST_NAME } from "../../scripts/release/build-release.mjs";
import { verifyRelease, verifyUnpacked } from "../../scripts/release/verify-artifact.mjs";
import {
  stage, update, rollback, resolveUncertain, currentRelease, releaseVersion, listUncertain,
} from "../../scripts/release/update.mjs";
import { checkConfiguration, checkArtifact, compareVersions } from "../../scripts/release/preflight.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@local",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@local",
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

/**
 * A disposable git-backed fixture standing in for a built checkout.
 * Commits once so the worktree is clean and HEAD is a real revision.
 */
function fixture({ runtimeFiles = 3, withMembers = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "release-fixture-"));
  git(root, ["init", "-q"]);
  mkdirSync(join(root, "dist-vps"), { recursive: true });
  for (let i = 0; i < runtimeFiles; i++) {
    writeFileSync(join(root, "dist-vps", `chunk-${i}.js`), `export const n = ${i};\n`);
  }
  const sources = {
    examples: "examples/release",
    migrations: "db/migrations",
    notices: ["NOTICE", "THIRD_PARTY.md", "third_party"],
    tooling: "scripts/release",
  };
  if (withMembers) {
    mkdirSync(join(root, "examples/release"), { recursive: true });
    writeFileSync(join(root, "examples/release/operator.env.example"), "CONTROL_ROOM_PORT=8787\n");
    mkdirSync(join(root, "db/migrations"), { recursive: true });
    writeFileSync(join(root, "db/migrations/0001_core.sql"), "-- core\n");
    mkdirSync(join(root, "third_party/pkg"), { recursive: true });
    writeFileSync(join(root, "third_party/pkg/NOTICE.md"), "notice\n");
    writeFileSync(join(root, "NOTICE"), "top notice\n");
    writeFileSync(join(root, "THIRD_PARTY.md"), "third party\n");
    mkdirSync(join(root, "scripts/release"), { recursive: true });
    writeFileSync(join(root, "scripts/release/tool.mjs"), "// tool\n");
  }
  writeFileSync(join(root, ".gitignore"), "dist-release*/\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return { root, sources, revision: git(root, ["rev-parse", "HEAD"]) };
}

function build(fx, { version = "1.0.0", revision, members, outDir = "dist-release" } = {}) {
  return assembleRelease({
    repoRoot: fx.root,
    revision: revision ?? fx.revision,
    version,
    outDir,
    members: members ?? fx.sources,
  });
}

function cleanup(...roots) {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- */
/* Archive build and clean unpack                                     */
/* ---------------------------------------------------------------- */

test("release: builds one versioned archive carrying every required member", () => {
  const fx = fixture();
  try {
    const out = build(fx, { version: "2.3.4" });
    assert.ok(existsSync(out.archivePath), "archive must exist");
    assert.match(out.archivePath, /control-room-2\.3\.4\.tar\.gz$/);
    assert.ok(out.fileCount > 0);

    const manifest = JSON.parse(readFileSync(out.manifestPath, "utf8"));
    assert.equal(manifest.version, "2.3.4");
    assert.equal(manifest.revision, fx.revision);
    // Every member the outcome requires is present in the archive.
    for (const member of manifest.requiredMembers) {
      assert.ok(manifest.members.some(m => m.path.startsWith(`${member}/`)), `missing member ${member}`);
    }
    // Integrity metadata covers the archive itself.
    assert.equal(manifest.archive.name, "control-room-2.3.4.tar.gz");
    assert.equal(manifest.archive.sha256.length, 64);
  } finally { cleanup(fx.root); }
});

test("release: the archive verifies clean AND needs no source checkout", () => {
  const fx = fixture();
  try {
    const out = build(fx);
    const result = verifyRelease({ archivePath: out.archivePath, manifestPath: out.manifestPath });
    assert.equal(result.ok, true, `expected clean verify, got ${result.problems.join(",")}`);
    assert.equal(result.stage, "unpacked");
    assert.ok(result.checked > 0);

    // Copy archive + manifest somewhere unrelated and verify there: the archive
    // must operate without the checkout it was built from.
    const elsewhere = mkdtempSync(join(tmpdir(), "release-elsewhere-"));
    try {
      // Keep the recorded filename: the manifest names its archive, so a rename
      // is itself a refusal. Only the LOCATION changes here.
      const a = join(elsewhere, out.archivePath.split("/").pop());
      const m = join(elsewhere, MANIFEST_NAME);
      writeFileSync(a, readFileSync(out.archivePath));
      writeFileSync(m, readFileSync(out.manifestPath));
      const remote = verifyRelease({ archivePath: a, manifestPath: m });
      assert.equal(remote.ok, true, `archive must verify outside its checkout: ${remote.problems.join(",")}`);
    } finally { cleanup(elsewhere); }
  } finally { cleanup(fx.root); }
});

/* ---------------------------------------------------------------- */
/* Integrity refusal                                                  */
/* ---------------------------------------------------------------- */

test("release: a tampered archive is refused on its own digest", () => {
  const fx = fixture();
  try {
    const out = build(fx);
    const bytes = readFileSync(out.archivePath);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff; // flip one byte
    writeFileSync(out.archivePath, bytes);
    const result = verifyRelease({ archivePath: out.archivePath, manifestPath: out.manifestPath });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "archive");
    assert.ok(result.problems.includes("archive_hash"), `got ${result.problems.join(",")}`);
  } finally { cleanup(fx.root); }
});

test("release: a changed member is refused even when the archive is intact", () => {
  const fx = fixture();
  const unpacked = mkdtempSync(join(tmpdir(), "release-unpacked-"));
  try {
    const out = build(fx);
    execFileSync("tar", ["--extract", "--gzip", "--file", out.archivePath, "--directory", unpacked]);
    const target = join(unpacked, "runtime/chunk-0.js");
    writeFileSync(target, "export const n = 999;\n");
    const result = verifyUnpacked({ unpackedRoot: unpacked, manifestPath: join(unpacked, MANIFEST_NAME) });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some(p => p.startsWith("size:runtime/chunk-0.js") || p.startsWith("hash:runtime/chunk-0.js")),
      `got ${result.problems.join(",")}`);
  } finally { cleanup(fx.root, unpacked); }
});

test("release: a missing member is refused", () => {
  const fx = fixture();
  const unpacked = mkdtempSync(join(tmpdir(), "release-unpacked-"));
  try {
    const out = build(fx);
    execFileSync("tar", ["--extract", "--gzip", "--file", out.archivePath, "--directory", unpacked]);
    rmSync(join(unpacked, "runtime/chunk-0.js"), { force: true });
    const result = verifyUnpacked({ unpackedRoot: unpacked, manifestPath: join(unpacked, MANIFEST_NAME) });
    assert.equal(result.ok, false);
    assert.ok(result.problems.includes("missing:runtime/chunk-0.js"), `got ${result.problems.join(",")}`);
  } finally { cleanup(fx.root, unpacked); }
});

test("release: an unlisted extra file is refused", () => {
  const fx = fixture();
  const unpacked = mkdtempSync(join(tmpdir(), "release-unpacked-"));
  try {
    const out = build(fx);
    execFileSync("tar", ["--extract", "--gzip", "--file", out.archivePath, "--directory", unpacked]);
    writeFileSync(join(unpacked, "runtime/smuggled.js"), "// not in the manifest\n");
    const result = verifyUnpacked({ unpackedRoot: unpacked, manifestPath: join(unpacked, MANIFEST_NAME) });
    assert.equal(result.ok, false);
    assert.ok(result.problems.includes("unlisted_extra:runtime/smuggled.js"), `got ${result.problems.join(",")}`);
  } finally { cleanup(fx.root, unpacked); }
});

/* ---------------------------------------------------------------- */
/* Build refusals happen BEFORE any effect                            */
/* ---------------------------------------------------------------- */

test("release: a revision that is not this checkout's clean HEAD is refused", () => {
  const fx = fixture();
  try {
    assert.throws(() => build(fx, { revision: "b".repeat(40) }), /release_revision_mismatch/);
    // A dirty worktree is refused too: the manifest must prove built provenance.
    writeFileSync(join(fx.root, "dirties.txt"), "x\n");
    assert.throws(() => build(fx), /release_worktree_unclean/);
  } finally { cleanup(fx.root); }
});

test("release: a missing required member refuses with no partial archive", () => {
  const fx = fixture({ withMembers: false });
  try {
    const outDir = join(fx.root, "dist-release");
    assert.throws(() => build(fx), /release_member_missing/);
    // Refusal-first: nothing was created.
    assert.equal(existsSync(join(outDir, MANIFEST_NAME)), false, "no manifest after refusal");
    const archives = existsSync(outDir) ? readdirSync(outDir).filter(n => n.endsWith(".tar.gz")) : [];
    assert.equal(archives.length, 0, "no archive after refusal");
  } finally { cleanup(fx.root); }
});

/* ---------------------------------------------------------------- */
/* Staged update, rollback and refusal                                */
/* ---------------------------------------------------------------- */

function releaseRootWithTwoVersions(fx) {
  const root = mkdtempSync(join(tmpdir(), "release-root-"));
  // Each version gets its own output directory: a release build refuses to
  // overwrite an existing release, so one directory holds one release.
  const v1 = build(fx, { version: "1.0.0", outDir: "dist-release-1" });
  const v2 = build(fx, { version: "2.0.0", outDir: "dist-release-2" });
  return { root, v1, v2 };
}

test("update: stages then activates, and leaves durable state untouched", () => {
  const fx = fixture();
  const { root, v1, v2 } = releaseRootWithTwoVersions(fx);
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "durable.json"), '{"work":"accepted"}\n');
    mkdirSync(join(root, "uncertain"), { recursive: true });

    update({ root, archivePath: v1.archivePath, manifestPath: v1.manifestPath });
    assert.equal(releaseVersion(currentRelease(root)), "1.0.0");
    update({ root, archivePath: v2.archivePath, manifestPath: v2.manifestPath });
    assert.equal(releaseVersion(currentRelease(root)), "2.0.0");

    // Durable state survives both updates untouched.
    assert.equal(readFileSync(join(root, "state", "durable.json"), "utf8"), '{"work":"accepted"}\n');
  } finally { cleanup(fx.root, root); }
});

test("update: refuses while uncertain work exists and names the markers", () => {
  const fx = fixture();
  const { root, v1 } = releaseRootWithTwoVersions(fx);
  try {
    mkdirSync(join(root, "uncertain"), { recursive: true });
    writeFileSync(join(root, "uncertain", "run-7.json"), '{"id":"run-7"}\n');
    assert.equal(listUncertain(root).length, 1);
    assert.throws(() => update({ root, archivePath: v1.archivePath, manifestPath: v1.manifestPath }),
      /release_update_refused_uncertain_work:run-7\.json/);
    // The refusal is complete: nothing became live.
    assert.equal(currentRelease(root), null, "no release may go live while uncertain work is held");
  } finally { cleanup(fx.root, root); }
});

test("update: resolves uncertain work explicitly, then proceeds", () => {
  const fx = fixture();
  const { root, v1 } = releaseRootWithTwoVersions(fx);
  try {
    mkdirSync(join(root, "uncertain"), { recursive: true });
    writeFileSync(join(root, "uncertain", "run-7.json"), '{"id":"run-7"}\n');
    resolveUncertain({ root, marker: "run-7.json", resolution: "accepted" });
    assert.equal(listUncertain(root).length, 0);
    // The resolution is recorded, not silently dropped.
    assert.equal(readFileSync(join(root, "resolved", "run-7.json"), "utf8").includes("accepted"), true);
    update({ root, archivePath: v1.archivePath, manifestPath: v1.manifestPath });
    assert.equal(releaseVersion(currentRelease(root)), "1.0.0");
  } finally { cleanup(fx.root, root); }
});

test("rollback: returns to the previous release", () => {
  const fx = fixture();
  const { root, v1, v2 } = releaseRootWithTwoVersions(fx);
  try {
    mkdirSync(join(root, "uncertain"), { recursive: true });
    update({ root, archivePath: v1.archivePath, manifestPath: v1.manifestPath });
    update({ root, archivePath: v2.archivePath, manifestPath: v2.manifestPath });
    assert.equal(releaseVersion(currentRelease(root)), "2.0.0");
    const result = rollback({ root });
    assert.equal(result.to || result.version, "1.0.0");
    assert.equal(releaseVersion(currentRelease(root)), "1.0.0");
  } finally { cleanup(fx.root, root); }
});

test("rollback: refuses an unsafe target whose manifest does not verify", () => {
  const fx = fixture();
  const { root, v1, v2 } = releaseRootWithTwoVersions(fx);
  try {
    mkdirSync(join(root, "uncertain"), { recursive: true });
    update({ root, archivePath: v1.archivePath, manifestPath: v1.manifestPath });
    update({ root, archivePath: v2.archivePath, manifestPath: v2.manifestPath });
    // Corrupt the previous release so rolling back to it would install bad bytes.
    const target = join(root, "releases", "1.0.0");
    writeFileSync(join(target, "runtime", "chunk-0.js"), "export const n = 666;\n");
    assert.throws(() => rollback({ root }), /release_rollback_refused_unsafe:1\.0\.0/);
    // Still on the known-good release.
    assert.equal(releaseVersion(currentRelease(root)), "2.0.0");
  } finally { cleanup(fx.root, root); }
});

test("rollback: refuses when uncertain work exists", () => {
  const fx = fixture();
  const { root, v1, v2 } = releaseRootWithTwoVersions(fx);
  try {
    mkdirSync(join(root, "uncertain"), { recursive: true });
    update({ root, archivePath: v1.archivePath, manifestPath: v1.manifestPath });
    update({ root, archivePath: v2.archivePath, manifestPath: v2.manifestPath });
    writeFileSync(join(root, "uncertain", "run-9.json"), '{"id":"run-9"}\n');
    assert.throws(() => rollback({ root }), /release_rollback_refused_uncertain_work:run-9\.json/);
  } finally { cleanup(fx.root, root); }
});

test("rollback: refuses when there is no previous release", () => {
  const fx = fixture();
  const { root, v1 } = releaseRootWithTwoVersions(fx);
  try {
    mkdirSync(join(root, "uncertain"), { recursive: true });
    update({ root, archivePath: v1.archivePath, manifestPath: v1.manifestPath });
    assert.throws(() => rollback({ root }), /release_rollback_refused_no_previous/);
  } finally { cleanup(fx.root, root); }
});

/* ---------------------------------------------------------------- */
/* Preflight: configuration custody and artifact gate                 */
/* ---------------------------------------------------------------- */

test("preflight: refuses a world-readable, group-readable or symlinked configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-config-"));
  try {
    const cfg = join(dir, "operator-config.mjs");
    writeFileSync(cfg, "export default {};\n");
    chmodSync(cfg, 0o644);
    assert.equal(checkConfiguration(cfg).ok, false, "0644 must be refused");
    assert.match(checkConfiguration(cfg).detail, /must be 600/);

    chmodSync(cfg, 0o600);
    assert.equal(checkConfiguration(cfg).ok, true, "0600 must pass");

    // A symlink is refused even when the target itself is 0600, because the
    // link can be repointed at another file between check and use.
    const link = join(dir, "linked.mjs");
    symlinkSync(cfg, link);
    assert.equal(checkConfiguration(link).ok, false, "symlink must be refused");
    assert.match(checkConfiguration(link).detail, /symlink/);
  } finally { cleanup(dir); }
});

test("preflight: refuses a missing configuration and an unreadable artifact", () => {
  assert.equal(checkConfiguration("").ok, false);
  assert.equal(checkConfiguration("/nonexistent/config.mjs").ok, false);
  const artifact = checkArtifact({ archive: "/nonexistent/release.tar.gz" });
  assert.equal(artifact.ok, false, "a missing archive must fail preflight");
});

test("preflight: passes a real release archive and its manifest", () => {
  const fx = fixture();
  try {
    const out = build(fx);
    const result = checkArtifact({ archive: out.archivePath, manifest: out.manifestPath });
    assert.equal(result.ok, true, `expected artifact ok, got ${result.detail}`);
    assert.match(result.detail, /members verified/);
  } finally { cleanup(fx.root); }
});

test("preflight: version comparison is numeric, not lexicographic", () => {
  assert.equal(compareVersions("22.13.0", "22.13.0"), 0);
  assert.equal(compareVersions("22.13.1", "22.13.0"), 1);
  assert.equal(compareVersions("22.9.0", "22.13.0"), -1, "22.9 must be below 22.13");
  assert.equal(compareVersions("23.0.0", "22.13.0"), 1);
});