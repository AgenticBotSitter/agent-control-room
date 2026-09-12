// Artifact integrity verifier: recomputes every hash in a release manifest AND
// proves the manifest covers the complete build-tree inventory (no missing,
// no extra/unlisted files). Read-only; exits 0 only when everything agrees.
import { existsSync, readFileSync, statSync, lstatSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, normalize, sep, isAbsolute } from "node:path";
import { MANIFEST_NAME, sha256File, BUILD_TREE } from "./build-release.mjs";

function listTreeFiles(root) {
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) { out.push({ full, symlink: true }); continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push({ full, symlink: false });
    }
  };
  walk(root);
  return out.sort((a, b) => (a.full < b.full ? -1 : 1));
}

// Returns { ok, checked, problems[] }. Never throws on content mismatch —
// mismatch is data, reported in problems.
export function verifyManifest({ repoRoot = resolve("."), manifestPath, expectedFiles } = {}) {
  const problems = [];
  const root = resolve(repoRoot);
  const manifestFile = manifestPath || join(root, "dist-release", MANIFEST_NAME);
  if (!existsSync(manifestFile)) return { ok: false, checked: 0, problems: ["manifest_missing"] };
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, "utf8")); }
  catch { return { ok: false, checked: 0, problems: ["manifest_unreadable"] }; }
  if (manifest.schema !== "control-room.release-manifest/v1" || !Array.isArray(manifest.files)) {
    return { ok: false, checked: 0, problems: ["manifest_schema_invalid"] };
  }
  if (manifest.files.length === 0) {
    return { ok: false, checked: 0, problems: ["manifest_empty"] };
  }
  if (typeof manifest.revision !== "string" || !/^[0-9a-f]{40}$/.test(manifest.revision)) {
    problems.push("manifest_revision_invalid");
  }

  // Path and field validation of every entry BEFORE any hash check.
  const seen = new Set();
  const valid = [];
  const treePrefix = normalize(BUILD_TREE) + sep;
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== "object") { problems.push("entry_invalid"); continue; }
    const { path, bytes, sha256 } = entry;
    if (typeof path !== "string" || path === "") { problems.push("entry_path_invalid"); continue; }
    if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")
      || normalize(path) !== path || path.startsWith("/")
      || path.includes("\0") || path.trim() !== path) {
      problems.push(`entry_path_escaped:${path}`); continue;
    }
    if (!path.startsWith(treePrefix)) { problems.push(`entry_outside_tree:${path}`); continue; }
    if (seen.has(path)) { problems.push(`duplicate:${path}`); continue; }
    seen.add(path);
    if (!Number.isSafeInteger(bytes) || bytes < 0) { problems.push(`entry_bytes_invalid:${path}`); continue; }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) { problems.push(`entry_hash_invalid:${path}`); continue; }
    valid.push(entry);
  }
  if (valid.length === 0) { problems.push("manifest_no_valid_entries"); }

  // Optional stronger mode: exact agreement with an externally supplied
  // expected inventory (paths must match exactly, nothing missing/extra).
  if (expectedFiles) {
    const expected = new Set(expectedFiles);
    for (const p of expected) if (!seen.has(p)) problems.push(`unlisted_missing:${p}`);
    for (const p of seen) if (!expected.has(p) && seen.has(p) && !manifest.files.some(e => e.path === p)) continue;
    for (const p of seen) if (!expected.has(p)) problems.push(`unlisted_extra:${p}`);
  }

  let checked = 0;
  for (const entry of valid) {
    const full = join(root, entry.path);
    let st;
    try { st = lstatSync(full); } catch { problems.push(`missing:${entry.path}`); continue; }
    if (st.isSymbolicLink()) { problems.push(`symlink:${entry.path}`); continue; }
    if (!st.isFile()) { problems.push(`not_a_file:${entry.path}`); continue; }
    if (statSync(full).size !== entry.bytes) { problems.push(`size:${entry.path}`); continue; }
    if (sha256File(full) !== entry.sha256) { problems.push(`hash:${entry.path}`); continue; }
    checked++;
  }

  if (expectedFiles === undefined) {
    // Default mode: verify against the tree on disk if it exists — every file
    // in the tree must be listed; nothing unlisted may pass silently.
    const tree = join(root, BUILD_TREE);
    if (existsSync(tree)) {
      const onDisk = new Set(listTreeFiles(tree).map(f => relative_path(root, f.full)));
      for (const p of onDisk) if (!seen.has(p)) problems.push(`unlisted_extra:${p}`);
    }
  }
  return { ok: problems.length === 0, checked, problems: problems.sort() };
}

function relative_path(root, full) {
  let p = full.slice(root.length + 1);
  return normalize(p);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node scripts/release/verify-artifact.mjs [--artifact <dir>]");
    console.log("Verifies manifest-vs-tree exact agreement, then every listed hash. Exit 0 only when everything agrees.");
    process.exit(0);
  }
  const i = args.indexOf("--artifact");
  const manifestPath = i === -1 ? undefined : join(resolve(args[i + 1] || "dist-release"), MANIFEST_NAME);
  const result = verifyManifest({ manifestPath });
  console.log(`artifact: ${result.ok ? "OK" : "MISMATCH"} (${result.checked} files verified)`);
  for (const p of result.problems) console.log(`  ${p}`);
  process.exit(result.ok ? 0 : 1);
}
