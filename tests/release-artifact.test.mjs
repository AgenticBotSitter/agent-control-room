// Release artifact tests: manifest completeness, tamper detection, refusal before effects.
// Fixture trees only — never the real dist-vps, never the network.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleRelease, buildManifest, MANIFEST_NAME } from "../scripts/release/build-release.mjs";
import { verifyManifest } from "../scripts/release/verify-artifact.mjs";

const REV = "cf9197d2feeab5696c50f76121a37480255d462d";

function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), "release-test-"));
  const tree = join(root, "dist-vps", "server");
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, "index.js"), "console.log(1);\n");
  writeFileSync(join(tree, "serving.js"), "export {};\n");
  return root;
}
const cleanup = root => rmSync(root, { recursive: true, force: true });

test("manifest lists every tree file with byte-exact sha256", () => {
  const root = fixtureTree();
  try {
    const out = assembleRelease({ repoRoot: root, revision: REV });
    assert.equal(out.fileCount, 2);
    const manifest = JSON.parse(readFileSync(out.manifestPath, "utf8"));
    assert.equal(manifest.schema, "control-room.release-manifest/v1");
    assert.equal(manifest.revision, REV);
    assert.deepEqual(manifest.files.map(f => f.path).sort(),
      ["dist-vps/server/index.js", "dist-vps/server/serving.js"]);
    assert.equal(manifest.totalBytes, manifest.files.reduce((n, f) => n + f.bytes, 0));
    const verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, true);
    assert.equal(verify.checked, 2);
  } finally { cleanup(root); }
});

test("tampered file fails verification with a hash problem, not an exception", () => {
  const root = fixtureTree();
  try {
    assembleRelease({ repoRoot: root, revision: REV });
    writeFileSync(join(root, "dist-vps", "server", "index.js"), "console.log(2);\n");
    const verify = verifyManifest({ repoRoot: root });
    assert.equal(verify.ok, false);
    assert.match(verify.problems.join(" "), /hash:dist-vps\/server\/index\.js/);
  } finally { cleanup(root); }
});

test("missing build tree refuses BEFORE creating any output", () => {
  const root = mkdtempSync(join(tmpdir(), "release-test-"));
  try {
    assert.throws(() => assembleRelease({ repoRoot: root, revision: REV }), /release_build_tree_missing/);
    assert.equal(existsSync(join(root, "dist-release")), false);
  } finally { cleanup(root); }
});

test("bad revision refuses before any effect", () => {
  const root = fixtureTree();
  try {
    assert.throws(() => assembleRelease({ repoRoot: root, revision: "not-a-sha" }), /release_revision_invalid/);
    assert.throws(() => buildManifest({ repoRoot: root, treeDir: "x", revision: "", files: [] }), /release_revision_invalid/);
    assert.equal(existsSync(join(root, "dist-release")), false);
  } finally { cleanup(root); }
});

test("existing output refuses without --overwrite, proceeds with it", () => {
  const root = fixtureTree();
  try {
    assembleRelease({ repoRoot: root, revision: REV });
    assert.throws(() => assembleRelease({ repoRoot: root, revision: REV }), /release_output_exists/);
    const second = assembleRelease({ repoRoot: root, revision: REV, overwrite: true });
    assert.equal(second.fileCount, 2);
  } finally { cleanup(root); }
});

test("previous manifest records the rollback target revision", () => {
  const root = fixtureTree();
  try {
    const first = assembleRelease({ repoRoot: root, revision: REV, outDir: "dist-prev" });
    const out = assembleRelease({
      repoRoot: root, revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      previousManifestPath: join("dist-prev", MANIFEST_NAME),
    });
    const manifest = JSON.parse(readFileSync(out.manifestPath, "utf8"));
    assert.equal(manifest.previousRevision, REV);
    assert.equal(first.fileCount, 2);
  } finally { cleanup(root); }
});
