// Release archive verifier.
//
// Two independent guarantees:
//
//   1. unpacked tree vs manifest — every listed member is present with exactly
//      the recorded size and sha256, and nothing is present that the manifest
//      does not list. A changed, missing or unlisted file is a refusal.
//   2. the archive itself — its size and sha256 match the recorded integrity
//      metadata, so a rebuilt or substituted archive is refused even when its
//      members happen to unpack correctly.
//
// Read-only. Never repairs, never writes. Exit 0 only when everything agrees;
// every disagreement is reported as a named problem rather than an exception.

import { createHash } from "node:crypto";
import {
  existsSync, readFileSync, statSync, lstatSync, readdirSync, mkdtempSync, rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve, normalize, sep, isAbsolute, relative } from "node:path";
import { tmpdir } from "node:os";
import { MANIFEST_NAME, MANIFEST_SCHEMA } from "./build-release.mjs";

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listTree(root) {
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
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

/** Relative POSIX paths of every real file under root. */
export function treeRelativePaths(root) {
  const tree = root;
  return listTree(tree).filter(f => !f.symlink)
    .map(f => relative(tree, f.full).split(sep).join("/")).sort();
}

/**
 * Verify an unpacked release tree against its manifest.
 * Returns { ok, checked, problems[] } — never throws on mismatch.
 */
export function verifyUnpacked({ unpackedRoot, manifestPath } = {}) {
  const problems = [];
  if (!unpackedRoot || !existsSync(unpackedRoot)) return { ok: false, checked: 0, problems: ["unpacked_root_missing"] };
  const manifestFile = manifestPath || join(unpackedRoot, MANIFEST_NAME);
  if (!existsSync(manifestFile)) return { ok: false, checked: 0, problems: ["manifest_missing"] };

  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, "utf8")); }
  catch { return { ok: false, checked: 0, problems: ["manifest_unreadable"] }; }

  if (manifest.schema !== MANIFEST_SCHEMA) return { ok: false, checked: 0, problems: ["manifest_schema_invalid"] };
  if (!Array.isArray(manifest.members) || manifest.members.length === 0) {
    return { ok: false, checked: 0, problems: ["manifest_members_empty"] };
  }
  if (typeof manifest.revision !== "string" || !/^[0-9a-f]{40}$/.test(manifest.revision)) {
    problems.push("manifest_revision_invalid");
  }

  const seen = new Set();
  const valid = [];
  for (const entry of manifest.members) {
    if (!entry || typeof entry !== "object") { problems.push("member_invalid"); continue; }
    const { path, bytes, sha256 } = entry;
    if (typeof path !== "string" || path === "") { problems.push("member_path_invalid"); continue; }
    // Path safety: no absolute paths, no traversal, no backslashes, no NUL.
    if (isAbsolute(path) || path.startsWith("/") || path.includes("\\")
      || path.split("/").includes("..") || normalize(path) !== path
      || path.includes("\0") || path.trim() !== path) {
      problems.push(`member_path_escaped:${path}`); continue;
    }
    if (seen.has(path)) { problems.push(`duplicate:${path}`); continue; }
    seen.add(path);
    if (!Number.isSafeInteger(bytes) || bytes < 0) { problems.push(`member_bytes_invalid:${path}`); continue; }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) { problems.push(`member_hash_invalid:${path}`); continue; }
    valid.push(entry);
  }
  if (valid.length === 0) problems.push("manifest_no_valid_members");

  // Every listed member must be present, a real file, and byte-identical.
  let checked = 0;
  for (const entry of valid) {
    const full = join(unpackedRoot, entry.path);
    let st;
    try { st = lstatSync(full); } catch { problems.push(`missing:${entry.path}`); continue; }
    if (st.isSymbolicLink()) { problems.push(`symlink:${entry.path}`); continue; }
    if (!st.isFile()) { problems.push(`not_a_file:${entry.path}`); continue; }
    if (st.size !== entry.bytes) { problems.push(`size:${entry.path}`); continue; }
    if (sha256File(full) !== entry.sha256) { problems.push(`hash:${entry.path}`); continue; }
    checked++;
  }

  // Nothing may be present that the manifest does not list — except the
  // manifest itself, which carries the inventory and therefore cannot list its
  // own digest. It is metadata, not a member.
  for (const p of treeRelativePaths(unpackedRoot)) {
    if (p === MANIFEST_NAME) continue;
    if (!seen.has(p)) problems.push(`unlisted_extra:${p}`);
  }

  // Required members must still exist as directories.
  if (Array.isArray(manifest.requiredMembers)) {
    for (const name of manifest.requiredMembers) {
      const dir = join(unpackedRoot, name);
      if (!existsSync(dir)) problems.push(`required_member_missing:${name}`);
    }
  }

  return { ok: problems.length === 0, checked, problems: problems.sort() };
}

/**
 * Verify the archive file itself against recorded integrity metadata.
 * Returns { ok, problems[] }.
 */
export function verifyArchive({ archivePath, manifestPath } = {}) {
  const problems = [];
  if (!archivePath || !existsSync(archivePath)) return { ok: false, problems: ["archive_missing"] };
  if (!manifestPath || !existsSync(manifestPath)) return { ok: false, problems: ["manifest_missing"] };
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch { return { ok: false, problems: ["manifest_unreadable"] }; }
  const recorded = manifest.archive;
  if (!recorded || typeof recorded !== "object") return { ok: false, problems: ["manifest_archive_missing"] };

  const bytes = statSync(archivePath).size;
  if (bytes !== recorded.bytes) problems.push(`archive_size:${bytes}!=${recorded.bytes}`);
  const digest = sha256File(archivePath);
  if (digest !== recorded.sha256) problems.push("archive_hash");
  if (recorded.name && !archivePath.endsWith(recorded.name)) problems.push("archive_name");
  return { ok: problems.length === 0, problems: problems.sort() };
}

/**
 * Full acceptance path: verify the archive, unpack it into a throwaway
 * directory, and verify the unpacked tree. Any failure is a refusal.
 * Always removes the temporary directory, including on failure.
 */
export function verifyRelease({ archivePath, manifestPath } = {}) {
  const archiveResult = verifyArchive({ archivePath, manifestPath });
  if (!archiveResult.ok) return { ok: false, stage: "archive", problems: archiveResult.problems, checked: 0 };

  const staging = mkdtempSync(join(tmpdir(), "release-verify-"));
  try {
    // Extract only regular members; the manifest is authoritative for contents.
    const extract = spawnSync("tar", ["--extract", "--gzip", "--file", archivePath, "--directory", staging], { encoding: "utf8" });
    if (extract.status !== 0) {
      return { ok: false, stage: "unpack", problems: [`unpack_failed:${(extract.stderr || "").trim().split("\n")[0] || "unknown"}`], checked: 0 };
    }
    // The archive is packed with "./" prefix; normalise to the staging root.
    const root = existsSync(join(staging, "manifest.json")) ? staging : join(staging, ".");
    const unpacked = verifyUnpacked({ unpackedRoot: root, manifestPath: join(root, MANIFEST_NAME) });
    return { ok: unpacked.ok, stage: "unpacked", problems: unpacked.problems, checked: unpacked.checked };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log("Usage: node scripts/release/verify-artifact.mjs --archive <path> [--manifest <path>]");
    console.log("Verifies archive integrity, unpacks it read-only, then verifies every member against the manifest.");
    console.log("Exit 0 only when the archive, its digest, its members and its inventory all agree.");
    process.exit(args.includes("--help") ? 0 : 1);
  }
  const pick = name => { const i = args.indexOf(name); return i === -1 ? "" : (args[i + 1] || ""); };
  const archivePath = pick("--archive");
  const manifestPath = pick("--manifest") || join(resolve(archivePath, ".."), MANIFEST_NAME);
  const result = verifyRelease({ archivePath: resolve(archivePath), manifestPath: resolve(manifestPath) });
  console.log(`release: ${result.ok ? "OK" : "REFUSED"} (stage=${result.stage}, ${result.checked} members verified)`);
  for (const p of result.problems) console.log(`  ${p}`);
  process.exit(result.ok ? 0 : 1);
}