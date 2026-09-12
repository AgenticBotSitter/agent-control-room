// Release artifact tests: manifest completeness, tamper detection, refusal before effects,
// provenance binding and exact inventory agreement (maintainer review corrections).
// Fixture trees only — never the real dist-vps, never the network.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleRelease, buildManifest, MANIFEST_NAME, listTreeFiles } from "../scripts/release/build-release.mjs";
import { verifyManifest } from "../scripts/release/verify-artifact.mjs";

function gitConfig(root) {
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "test"]);
}

// Real disposable Git checkout so the provenance gate can pass. dist-vps is
// gitignored so the build tree never dirties the worktree.
function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "release-prov-"));
  execFileSync("git", ["-C", root, "init"]);
  gitConfig(root);
  writeFileSync(join(root, ".gitignore"), "dist-vps\ndist-release\ndist-prev\n");
  execFileSync("git", ["-C", root, "add", ".gitignore"]);
  execFileSync("git", ["-C", root, "commit", "-m", "fixture"]);
  return { root, head: execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim() };
}

// Non-git plain fixture: used where the provenance gate is expected to refuse.
function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), "release-test-"));
  const tree = join(root, "dist-vps", "server");
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, "index.js"), "console.log(1);\n");
  writeFileSync(join(tree, "serving.js"), "export {};\n");
  return root;
}
const cleanup = root => rmSync(root, { recursive: true, force: true });
const GOOD_MANIFEST = files =>
  ({ schema: "control-room.release-manifest/v1", revision: "1".repeat(40), previousRevision: "", builtAt: "x", nodeVersion: "22", treeDir: "dist-vps", files });

test("manifest lists every tree file with byte-exact sha256", () => {
  const { root, head } = gitFixture();
  try {
    const tree = join(root, "dist-vps", "server");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "index.js"), "console.log(1);\n");
    writeFileSync(join(tree, "serving.js"), "export {};\n");
    const out = assembleRelease({ repoRoot: root, revision: head });
    assert.equal(out.fileCount, 2);
    const manifest = JSON.parse(readFileSync(out.manifestPath, "utf8"));
    assert.equal(manifest.schema, "control-room.release-manifest/v1");
    assert.equal(manifest.revision, head);
    assert.deepEqual(manifest.files.map(f => f.path).sort(),
      ["dist-vps/server/index.js", "dist-vps/server/serving.js"]);
    assert.equal(manifest.totalBytes, manifest.files.reduce((n, f) => n + f.bytes, 0));
    const verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, true);
    assert.equal(verify.checked, 2);
  } finally { cleanup(root); }
});

test("tampered file fails verification with a hash problem, not an exception", () => {
  const { root, head } = gitFixture();
  try {
    const tree = join(root, "dist-vps", "server");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "index.js"), "console.log(1);\n");
    writeFileSync(join(tree, "serving.js"), "export {};\n");
    assembleRelease({ repoRoot: root, revision: head });
    writeFileSync(join(root, "dist-vps", "server", "index.js"), "console.log(2);\n");
    const verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, false);
    assert.match(verify.problems.join(" "), /hash:dist-vps\/server\/index\.js/);
  } finally { cleanup(root); }
});

test("missing build tree refuses BEFORE creating any output", () => {
  const { root, head } = gitFixture();
  try {
    assert.throws(() => assembleRelease({ repoRoot: root, revision: head }), /release_build_tree_missing/);
    assert.equal(existsSync(join(root, "dist-release")), false);
  } finally { cleanup(root); }
});

test("bad revision refuses before any effect", () => {
  const root = fixtureTree();
  try {
    assert.throws(() => assembleRelease({ repoRoot: root, revision: "not-a-sha" }), /release_revision_invalid/);
    assert.throws(() => buildManifest({ repoRoot: root, treeDir: "x", revision: "", files: [] }), /release_revision_invalid/);
    assert.throws(() => buildManifest({ repoRoot: root, treeDir: "x", revision: "a".repeat(40), files: [] }), /release_files_required/);
    assert.equal(existsSync(join(root, "dist-release")), false);
  } finally { cleanup(root); }
});

test("existing output refuses without --overwrite, proceeds with it", () => {
  const { root, head } = gitFixture();
  try {
    const tree = join(root, "dist-vps", "server");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "index.js"), "console.log(1);\n");
    writeFileSync(join(tree, "serving.js"), "export {};\n");
    assembleRelease({ repoRoot: root, revision: head });
    assert.throws(() => assembleRelease({ repoRoot: root, revision: head }), /release_output_exists/);
    const second = assembleRelease({ repoRoot: root, revision: head, overwrite: true });
    assert.equal(second.fileCount, 2);
  } finally { cleanup(root); }
});

test("previous manifest records the rollback target revision", () => {
  const { root, head } = gitFixture();
  try {
    const tree = join(root, "dist-vps", "server");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "index.js"), "console.log(1);\n");
    const first = assembleRelease({ repoRoot: root, revision: head, outDir: "dist-prev" });
    // A second commit so the new revision differs from the previous one.
    writeFileSync(join(root, "chg.txt"), "z");
    execFileSync("git", ["-C", root, "add", "chg.txt"]);
    execFileSync("git", ["-C", root, "commit", "-m", "second"]);
    const head2 = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
    const out = assembleRelease({ repoRoot: root, revision: head2, previousManifestPath: join("dist-prev", MANIFEST_NAME) });
    const manifest = JSON.parse(readFileSync(out.manifestPath, "utf8"));
    assert.equal(manifest.previousRevision, head);
    assert.notEqual(manifest.previousRevision, head2);
    assert.equal(first.fileCount, 1);
  } finally { cleanup(root); }
});

// ---- Provenance gate (maintainer review point 2) ----

test("revision outside a Git checkout is refused as unverified", () => {
  const root = fixtureTree();
  try {
    assert.throws(() => assembleRelease({ repoRoot: root, revision: "f".repeat(40) }), /release_revision_unverified/);
    assert.throws(() => assembleRelease({ repoRoot: root, revision: "1".repeat(40) }), /release_revision_unverified/);
    assert.equal(existsSync(join(root, "dist-release")), false);
  } finally { cleanup(root); }
});

test("revision that is not the exact Git HEAD is refused as a mismatch", () => {
  const { root, head } = gitFixture();
  try {
    const tree = join(root, "dist-vps", "server");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "index.js"), "console.log(1);\n");
    const other = "a".repeat(40);
    assert.throws(() => assembleRelease({ repoRoot: root, revision: other }), /release_revision_mismatch/);
    assert.equal(existsSync(join(root, "dist-release")), false);
    // The exact HEAD passes and records THIS revision, not a caller label.
    const out = assembleRelease({ repoRoot: root, revision: head });
    const manifest = JSON.parse(readFileSync(out.manifestPath, "utf8"));
    assert.equal(manifest.revision, head);
    assert.notEqual(manifest.revision, other);
  } finally { cleanup(root); }
});

test("unclean worktree refuses to build a release", () => {
  const { root, head } = gitFixture();
  try {
    const tree = join(root, "dist-vps", "server");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "tracked.js"), "console.log(1);\n");
    writeFileSync(join(root, "untracked.txt"), "dirty worktree");
    assert.throws(() => assembleRelease({ repoRoot: root, revision: head }), /release_worktree_unclean/);
    assert.equal(existsSync(join(root, "dist-release")), false);
  } finally { cleanup(root); }
});

// ---- Tree hygiene (symlinks/special files in build tree) ----

test("builder refuses symlinks and special files inside the build tree", () => {
  const root = fixtureTree();
  try {
    symlinkSync("/etc/passwd", join(root, "dist-vps", "server", "lnk.js"));
    assert.throws(() => listTreeFiles(join(root, "dist-vps")), /release_tree_symlink/);
  } finally { cleanup(root); }
});

// ---- Exact inventory agreement (maintainer review points 1) ----

test("verifier refuses an empty-files manifest", () => {
  const root = fixtureTree();
  try {
    mkdirSync(join(root, "dist-release"));
    writeFileSync(join(root, "dist-release", MANIFEST_NAME), JSON.stringify(GOOD_MANIFEST([])));
    const verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, false);
    assert.match(verify.problems.join(" "), /manifest_empty/);
  } finally { cleanup(root); }
});

test("verifier refuses extra unlisted files in the build tree", () => {
  const { root, head } = gitFixture();
  try {
    const tree = join(root, "dist-vps", "server");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "index.js"), "console.log(1);\n");
    assembleRelease({ repoRoot: root, revision: head });
    writeFileSync(join(root, "dist-vps", "server", "evil-extra.js"), "evil");
    const verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, false);
    assert.match(verify.problems.join(" "), /unlisted_extra:dist-vps\/server\/evil-extra\.js/);
  } finally { cleanup(root); }
});

test("verifier refuses duplicate manifest entries", () => {
  const root = fixtureTree();
  const entry = { path: "dist-vps/server/index.js", bytes: 14, sha256: "a".repeat(64) };
  try {
    writeFileSync(join(root, "dist-vps", "server", "index.js"), "console.log(1);\n");
    writeFileSync(join(root, "dist-vps", "server", "serving.js"), "export {};\n");
    mkdirSync(join(root, "dist-release"));
    writeFileSync(join(root, "dist-release", MANIFEST_NAME), JSON.stringify(GOOD_MANIFEST([entry, { ...entry }])));

    const verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, false);
    assert.match(verify.problems.join(" "), /duplicate:dist-vps\/server\/index\.js/);
  } finally { cleanup(root); }
});

test("verifier refuses escaped and absolute paths", () => {
  const root = fixtureTree();
  try {
    writeFileSync(join(root, "dist-vps", "server", "index.js"), "console.log(1);\n");
    writeFileSync(join(root, "outside.txt"), "escap");
    mkdirSync(join(root, "dist-release"));
    const cases = [
      "dist-vps/../outside.txt",
      "/etc/passwd",
      "dist-vps/server/../../outside.txt",
    ];
    for (const [i, bad] of cases.entries()) {
      const files = [{ path: "dist-vps/server/index.js", bytes: 14, sha256: "b".repeat(64) }, { path: bad, bytes: 5, sha256: "a".repeat(64) }];
      writeFileSync(join(root, "dist-release", MANIFEST_NAME), JSON.stringify(GOOD_MANIFEST(files)));
      const verify = verifyManifest({ repoRoot: root });
      assert.equal(verify.ok, false, `case ${i}`);
      assert.match(verify.problems.join(" "), /entry_path_escaped|entry_outside_tree/, `case ${i}: ${bad}`);
    }
  } finally { cleanup(root); }
});

test("verifier refuses entries outside the build tree", () => {
  const root = fixtureTree();
  try {
    writeFileSync(join(root, "stray.txt"), "stray");
    writeFileSync(join(root, "dist-vps", "server", "index.js"), "console.log(1);\n");
    mkdirSync(join(root, "dist-release"));
    const files = [
      { path: "dist-vps/server/index.js", bytes: 14, sha256: "b".repeat(64) },
      { path: "scripts/release/build-release.mjs", bytes: 4, sha256: "a".repeat(64) },
    ];
    writeFileSync(join(root, "dist-release", MANIFEST_NAME), JSON.stringify(GOOD_MANIFEST(files)));
    const verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, false);
    assert.match(verify.problems.join(" "), /entry_outside_tree:scripts\/release\/build-release\.mjs/);
  } finally { cleanup(root); }
});

test("verifier refuses missing listed files and invalid byte/hash fields", () => {
  const root = fixtureTree();
  try {
    writeFileSync(join(root, "dist-vps", "server", "index.js"), "console.log(1);\n");
    mkdirSync(join(root, "dist-release"));
    const INDEX = { path: "dist-vps/server/index.js", bytes: Buffer.byteLength("console.log(1);\n"), sha256: "b".repeat(64) };
    // hash mismatches will be caught alongside missing — we only assert field-invalid + missing here
    // listed-but-absent file
    writeFileSync(join(root, "dist-release", MANIFEST_NAME), JSON.stringify(GOOD_MANIFEST([
      INDEX,
      { path: "dist-vps/server/absent.js", bytes: 10, sha256: "a".repeat(64) },
    ])));
    let verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, false);
    assert.match(verify.problems.join(" "), /missing:dist-vps\/server\/absent\.js/);
    // malformed byte/hash fields
    writeFileSync(join(root, "dist-release", MANIFEST_NAME), JSON.stringify(GOOD_MANIFEST([
      INDEX,
      { path: "dist-vps/server/serving.js", bytes: -1, sha256: "a".repeat(64) },
      { path: "dist-vps/server/bad.js", bytes: 1.5, sha256: "not-a-hash" },
    ])));
    writeFileSync(join(root, "dist-vps", "server", "serving.js"), "export {};\n");
    writeFileSync(join(root, "dist-vps", "server", "bad.js"), "x");
    verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, false);
    const all = verify.problems.join(" ");
    assert.match(all, /entry_bytes_invalid:dist-vps\/server\/serving\.js/);
    assert.match(all, /entry_bytes_invalid:dist-vps\/server\/bad\.js/);
    // valid bytes but malformed hash field
    writeFileSync(join(root, "dist-release", MANIFEST_NAME), JSON.stringify(GOOD_MANIFEST([
      INDEX,
      { path: "dist-vps/server/bad.js", bytes: 1, sha256: "not-a-hash" },
    ])));
    verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, false);
    assert.match(verify.problems.join(" "), /entry_hash_invalid:dist-vps\/server\/bad\.js/);
    // invalid manifest revision field
    writeFileSync(join(root, "dist-release", MANIFEST_NAME), JSON.stringify({
      schema: "control-room.release-manifest/v1", revision: "short", files: [
        { path: "dist-vps/server/index.js", bytes: Buffer.byteLength("console.log(1);\n"), sha256: "b".repeat(64) },
      ],
    }));
    verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, false);
    assert.match(verify.problems.join(" "), /manifest_revision_invalid/);
  } finally { cleanup(root); }
});

test("verifier refuses a symlink listed in the manifest and a symlink present in the tree", () => {
  const root = fixtureTree();
  try {
    // symlink present in tree, manifest honest
    writeFileSync(join(root, "dist-vps", "server", "index.js"), "console.log(1);\n");
    symlinkSync("/etc/passwd", join(root, "dist-vps", "server", "lnk.js"));
    mkdirSync(join(root, "dist-release"));
    writeFileSync(join(root, "dist-release", MANIFEST_NAME), JSON.stringify(GOOD_MANIFEST([
      { path: "dist-vps/server/index.js", bytes: 14, sha256: "b".repeat(64) },
    ])));
    let verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, false);
    assert.match(verify.problems.join(" "), /unlisted_extra:dist-vps\/server\/lnk\.js/);
    // symlink listed IN the manifest
    symlinkSync(join(root, "outside.txt"), join(root, "dist-vps", "server", "listed.js"));
    writeFileSync(join(root, "outside.txt"), "real");
    writeFileSync(join(root, "dist-release", MANIFEST_NAME), JSON.stringify(GOOD_MANIFEST([
      { path: "dist-vps/server/listed.js", bytes: 4, sha256: "c".repeat(64) },
    ])));
    verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, false);
    assert.match(verify.problems.join(" "), /symlink:dist-vps\/server\/listed\.js/);
  } finally { cleanup(root); }
});

test("clean manifest over exact tree verifies OK", () => {
  const { root, head } = gitFixture();
  try {
    const tree = join(root, "dist-vps", "server");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "index.js"), "console.log(1);\n");
    writeFileSync(join(tree, "serving.js"), "export {};\n");
    const out = assembleRelease({ repoRoot: root, revision: head });
    const verify = verifyManifest({ repoRoot: root, manifestPath: out.manifestPath });
    assert.equal(verify.ok, true, JSON.stringify(verify));
    assert.equal(verify.checked, 2);
  } finally { cleanup(root); }
});

// ---- Update via a separate checkout preserves the old release tree ----
// (maintainer review correction 2: update must not mutate the live checkout.)

test("building the next release in a separate checkout leaves the previous manifest and files untouched", () => {
  // Two independent disposable checkouts representing (previous) live and (next) candidate.
  const prev = gitFixture();
  const next = gitFixture();
  // Give them divergent content so the manifests are distinguishable.
  const prevTree = join(prev.root, "dist-vps", "server");
  mkdirSync(prevTree, { recursive: true });
  writeFileSync(join(prevTree, "index.js"), "console.log(1);\n");
  writeFileSync(join(prevTree, "serving.js"), "export {};\n");
  const nextTree = join(next.root, "dist-vps", "server");
  mkdirSync(nextTree, { recursive: true });
  writeFileSync(join(nextTree, "index.js"), "console.log(2);\n");
  writeFileSync(join(nextTree, "serving.js"), "export {};\n");

  try {
    // Build the previous release.
    const prevOut = assembleRelease({ repoRoot: prev.root, revision: prev.head });
    const prevManifestBytes = readFileSync(prevOut.manifestPath, "utf8");
    const prevIndexBytes = readFileSync(join(prev.root, "dist-vps", "server", "index.js"), "utf8");
    const prevServingBytes = readFileSync(join(prev.root, "dist-vps", "server", "serving.js"), "utf8");
    // Now simulate the documented update procedure: a separate sibling checkout
    // for the new SHA. We do not write to prev.root at all.
    mkdirSync(join(next.root, "dist-prev"), { recursive: true });
    writeFileSync(join(next.root, "dist-prev", MANIFEST_NAME), prevManifestBytes);
    const nextOut = assembleRelease({
      repoRoot: next.root,
      revision: next.head,
      previousManifestPath: join("dist-prev", MANIFEST_NAME),
    });
    const nextManifest = JSON.parse(readFileSync(nextOut.manifestPath, "utf8"));
    assert.equal(nextManifest.previousRevision, prev.head);
    assert.equal(nextManifest.revision, next.head);

    // The previous release tree must be byte-identical to its pre-update state.
    assert.equal(readFileSync(prevOut.manifestPath, "utf8"), prevManifestBytes, "previous manifest must be untouched");
    assert.equal(readFileSync(join(prev.root, "dist-vps", "server", "index.js"), "utf8"), prevIndexBytes, "previous index.js must be untouched");
    assert.equal(readFileSync(join(prev.root, "dist-vps", "server", "serving.js"), "utf8"), prevServingBytes, "previous serving.js must be untouched");
  } finally {
    cleanup(prev.root);
    cleanup(next.root);
  }
});
