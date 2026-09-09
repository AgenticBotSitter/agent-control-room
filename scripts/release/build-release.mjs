// Release artifact builder: assembles dist-release/manifest.json for a built tree.
// Refuses before ANY effect when inputs are missing (no partial artifact).
// No new dependencies; stdlib only.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";

export const MANIFEST_NAME = "manifest.json";
export const BUILD_TREE = "dist-vps";

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function listTreeFiles(root) {
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

// Pure manifest construction over an explicit file list (bytes + hashes read here).
// revision: exact git SHA the tree was built from. previousRevision: rollback target or "".
export function buildManifest({ repoRoot, treeDir, revision, previousRevision = "", builtAt = new Date().toISOString(), nodeVersion = process.versions.node, files }) {
  if (!revision || !/^[0-9a-f]{40}$/.test(revision)) throw new Error("release_revision_invalid");
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

// Refusal-first assembly. Returns { manifestPath, fileCount }.
// Throws release_* BEFORE creating or writing anything when inputs are invalid.
export function assembleRelease({ repoRoot = resolve("."), outDir = "dist-release", revision, previousRevision: previousRevisionArg = "", previousManifestPath = "", overwrite = false } = {}) {
  const root = resolve(repoRoot);
  const tree = join(root, BUILD_TREE);
  if (!existsSync(tree) || !statSync(tree).isDirectory()) throw new Error("release_build_tree_missing");
  if (!revision || !/^[0-9a-f]{40}$/.test(revision)) throw new Error("release_revision_invalid");
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
