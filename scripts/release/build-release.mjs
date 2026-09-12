// Release artifact builder: assembles dist-release/manifest.json for a built tree.
// Refuses before ANY effect when inputs are missing (no partial artifact).
// No new dependencies; stdlib only.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";

export const MANIFEST_NAME = "manifest.json";
export const BUILD_TREE = "dist-vps";

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Walks one build tree. Refuses symlinks and non-regular files rather than
// recording them: a manifest entry must address a real file, and a symlinked
// entry could differ between build and verify time.
export function listTreeFiles(root) {
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error("release_tree_symlink");
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(full);
      else throw new Error("release_tree_special_file");
    }
  };
  walk(root);
  return out.sort();
}

// Pure manifest construction over an explicit file list (bytes + hashes read here).
// revision: exact git SHA the tree was built from. previousRevision: rollback target or "".
export function buildManifest({ repoRoot, treeDir, revision, previousRevision = "", builtAt = new Date().toISOString(), nodeVersion = process.versions.node, files }) {
  if (!revision || !/^[0-9a-f]{40}$/.test(revision)) throw new Error("release_revision_invalid");
  if (!Array.isArray(files) || files.length === 0) throw new Error("release_files_required");
  const entries = files.map(full => {
    const st = statSync(full);
    if (!st.isFile()) throw new Error("release_tree_changed_during_manifest");
    return { path: relative(repoRoot, full), bytes: st.size, sha256: sha256File(full) };
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    schema: "control-room.release-manifest/v1",
    revision,
    previousRevision,
    builtAt,
    nodeVersion,
    treeDir,
    files: entries,
    totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
  };
}

// Provenance gate: the recorded revision must BE the checkout the build tree
// came from, not a caller label. Refuses (release_revision_unverified) when the
// tree was built outside a clean Git checkout of a different SHA.
export function verifyRevisionProvenance(repoRoot, revision) {
  let head = "", dirty = null;
  try {
    head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    dirty = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], { encoding: "utf8" });
  } catch {
    throw new Error("release_revision_unverified");
  }
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("release_revision_unverified");
  if (head !== revision) throw new Error("release_revision_mismatch");
  if (dirty.trim() !== "") throw new Error("release_worktree_unclean");
  return head;
}

// Refusal-first assembly. Returns { manifestPath, fileCount }.
// Throws release_* BEFORE creating or writing anything when inputs are invalid.
export function assembleRelease({ repoRoot = resolve("."), outDir = "dist-release", revision, previousRevision: previousRevisionArg = "", previousManifestPath = "", overwrite = false } = {}) {
  const root = resolve(repoRoot);
  const tree = join(root, BUILD_TREE);
  if (!existsSync(tree) || !statSync(tree).isDirectory()) throw new Error("release_build_tree_missing");
  if (!revision || !/^[0-9a-f]{40}$/.test(revision)) throw new Error("release_revision_invalid");
  verifyRevisionProvenance(root, revision);
  let previousRevision = previousRevisionArg;
  if (previousManifestPath) {
    const raw = JSON.parse(readFileSync(resolve(root, previousManifestPath), "utf8"));
    if (raw.schema !== "control-room.release-manifest/v1" || !raw.revision) throw new Error("release_previous_manifest_invalid");
    previousRevision = raw.revision;
  }
  const out = join(root, outDir);
  if (existsSync(out) && !overwrite) throw new Error("release_output_exists");
  const files = listTreeFiles(tree);
  if (files.length === 0) throw new Error("release_build_tree_empty");
  const manifest = buildManifest({ repoRoot: root, treeDir: BUILD_TREE, revision, previousRevision, files });
  mkdirSync(out, { recursive: true });
  const manifestPath = join(out, MANIFEST_NAME);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { manifestPath, fileCount: manifest.files.length, totalBytes: manifest.totalBytes };
}

function printUsage() {
  console.log("Usage: node scripts/release/build-release.mjs --revision <40-hex-sha> [--out <dir>] [--previous-manifest <path>] [--overwrite]");
  console.log("Assembles dist-release/manifest.json over the dist-vps build tree. Refuses before any effect when inputs are missing.");
  console.log("The revision must be the exact clean Git HEAD of the checkout being released: the manifest proves built provenance, not a caller label.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--help")) { printUsage(); process.exit(0); }
    const pick = name => { const i = args.indexOf(name); return i === -1 ? "" : (args[i + 1] || ""); };
    const revision = pick("--revision");
    const outDir = pick("--out") || "dist-release";
    const previousManifestPath = pick("--previous-manifest");
    const overwrite = args.includes("--overwrite");
    const result = assembleRelease({ revision, outDir, previousManifestPath, overwrite });
    console.log(`release manifest: ${result.manifestPath} (${result.fileCount} files, ${result.totalBytes} bytes)`);
  } catch (error) {
    console.error(`build-release: ${error.message}`);
    process.exit(1);
  }
}
