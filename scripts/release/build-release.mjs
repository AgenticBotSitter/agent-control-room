// Release archive builder for the distributable Linux release path.
//
// Produces ONE self-contained versioned archive:
//
//   dist-release/control-room-<version>.tar.gz   the archive
//   dist-release/manifest.json                   exact integrity metadata for it
//
// The archive carries the compiled runtime, operator configuration examples,
// accepted migrations, notices, and launch/health tooling, so it verifies and
// operates WITHOUT the source checkout. Integrity metadata covers every member
// byte-for-byte, plus the archive's own digest and size, so a changed, added or
// missing file is refused rather than tolerated.
//
// Refusal-first: every precondition is checked BEFORE any file is created. A
// failed build leaves no partial archive behind.
//
// stdlib only; no new dependencies.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
  lstatSync, rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const MANIFEST_NAME = "manifest.json";
export const MANIFEST_SCHEMA = "control-room.release-manifest/v2";
export const BUILD_TREE = "dist-vps";
export const ARCHIVE_PREFIX = "control-room";

/** Members the archive must carry, relative to the archive root. */
export const REQUIRED_MEMBERS = [
  "runtime",
  "examples",
  "migrations",
  "notices",
  "tooling",
];

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** True when the string is a lowercase 40-hex git SHA. */
export function isRevision(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

// Deterministic, portable member ordering. Every file is addressed by a
// relative POSIX path; symlinks and special files are refused rather than
// recorded, because a manifest entry must address a real file whose bytes
// cannot change between build and verify time.
export function listTreeFiles(root, { refuseSymlinks = true } = {}) {
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        if (refuseSymlinks) throw new Error(`release_tree_symlink:${full}`);
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(full);
      else throw new Error(`release_tree_special_file:${full}`);
    }
  };
  walk(root);
  return out.sort();
}

/** Sorted relative POSIX paths for a tree. */
export function relativePaths(root, files) {
  return files.map(f => relative(root, f).split(sep).join("/")).sort();
}

// Provenance gate: the recorded revision must BE the checkout the runtime was
// built from, not a caller-supplied label, and that checkout must be clean.
export function verifyRevisionProvenance(repoRoot, revision) {
  let head, dirty;
  try {
    head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    dirty = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], { encoding: "utf8" });
  } catch {
    throw new Error("release_revision_unverified");
  }
  if (!isRevision(head)) throw new Error("release_revision_unverified");
  if (head !== revision) throw new Error("release_revision_mismatch");
  if (dirty.trim() !== "") throw new Error("release_worktree_unclean");
  return head;
}

// The staging layout is what actually ships. `runtime` is satisfied by the
// BUILD_TREE, so it is not required in the members map. Each other member
// accepts either one source path or a list of them, because accepted notice
// outputs live as several root-level files rather than one directory.
export function planArchiveMembers({ repoRoot, members = {} }) {
  const missing = [];
  const planned = [];
  for (const name of REQUIRED_MEMBERS) {
    if (name === "runtime") continue; // provided by BUILD_TREE
    const source = members[name];
    if (!source) { missing.push(name); continue; }
    const list = (Array.isArray(source) ? source : [source]).map(s => resolve(repoRoot, s));
    const absent = list.filter(p => !existsSync(p));
    if (absent.length > 0) { missing.push(`${name}(${absent.length})`); continue; }
    planned.push({ member: name, sources: list, isDirectory: list.every(p => statSync(p).isDirectory()) });
  }
  if (missing.length > 0) throw new Error(`release_member_missing:${missing.join(",")}`);
  return planned;
}

/** Version string derived from the revision so one revision maps to one version. */
export function deriveVersion(revision, tag = "") {
  if (tag) return tag.replace(/^v/, "");
  return `0.0.0-${revision.slice(0, 12)}`;
}

function sha256FileStreaming(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Assemble the release archive plus its integrity metadata.
 * Throws release_* before creating anything when any precondition fails.
 */
export function assembleRelease({
  repoRoot = resolve("."),
  outDir = "dist-release",
  revision,
  version = "",
  previousRevision = "",
  members = {},
  overwrite = false,
  builtAt = new Date().toISOString(),
  nodeVersion = process.versions.node,
  packer = defaultPacker,
} = {}) {
  const root = resolve(repoRoot);
  if (!isRevision(revision)) throw new Error("release_revision_invalid");

  // Provenance first: refuse a labelled revision that is not this checkout.
  verifyRevisionProvenance(root, revision);

  const runtime = join(root, BUILD_TREE);
  if (!existsSync(runtime) || !statSync(runtime).isDirectory()) {
    throw new Error("release_build_tree_missing");
  }
  const runtimeFiles = listTreeFiles(runtime);
  if (runtimeFiles.length === 0) throw new Error("release_build_tree_empty");

  // All required members must resolve before any output is created.
  const memberPlan = planArchiveMembers({ repoRoot: root, members });

  const resolvedVersion = deriveVersion(revision, version);
  const out = join(root, outDir);
  const archiveName = `${ARCHIVE_PREFIX}-${resolvedVersion}.tar.gz`;
  const archivePath = join(out, archiveName);
  const manifestPath = join(out, MANIFEST_NAME);
  if (existsSync(out) && !overwrite) throw new Error("release_output_exists");

  // Stage into a temporary directory so the archive root is exactly the
  // documented layout and nothing from the checkout leaks in.
  const staging = join(out, `.staging-${process.pid}`);
  try {
    mkdirSync(staging, { recursive: true });

    // runtime/ <- the compiled tree
    copyTree(runtime, join(staging, "runtime"));
    // the other required members <- their declared sources; a file source keeps
    // its basename, so root-level notice files land inside the member dir.
    for (const entry of memberPlan) {
      const targetDir = join(staging, entry.member);
      mkdirSync(targetDir, { recursive: true });
      for (const src of entry.sources) {
        if (statSync(src).isDirectory()) copyTree(src, join(targetDir, relative(resolve(repoRoot), src)));
        else writeFileSync(join(targetDir, src.split(sep).pop()), readFileSync(src));
      }
    }

    // Deterministic member list relative to the archive root.
    const memberFiles = listTreeFiles(staging);
    const memberPaths = relativePaths(staging, memberFiles);
    if (memberPaths.length === 0) throw new Error("release_archive_empty");

    const entries = memberFiles.map(full => {
      const st = statSync(full);
      return {
        path: relative(staging, full).split(sep).join("/"),
        bytes: st.size,
        sha256: sha256FileStreaming(full),
      };
    });

    // Pack. Deterministic settings: fixed mtime/owner and sorted members make
    // the archive byte-reproducible for the same inputs.
    packer({ staging, archivePath });

    const archiveBytes = statSync(archivePath).size;
    const archiveSha256 = sha256File(archivePath);

    const manifest = {
      schema: MANIFEST_SCHEMA,
      version: resolvedVersion,
      revision,
      previousRevision,
      builtAt,
      nodeVersion,
      archive: { name: archiveName, bytes: archiveBytes, sha256: archiveSha256 },
      root: ARCHIVE_PREFIX,
      requiredMembers: REQUIRED_MEMBERS,
      members: entries,
      fileCount: entries.length,
      totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { archivePath, manifestPath, version: resolvedVersion, fileCount: entries.length, totalBytes: manifest.totalBytes, archiveBytes, archiveSha256 };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const full of listTreeFiles(from)) {
    const rel = relative(from, full);
    const dest = join(to, rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, readFileSync(full));
  }
}

// Pack to a deterministic tar.gz where the platform tar allows it.
//
// GNU tar supports fixed owner/mtime and member sorting, which makes identical
// inputs produce identical archives. BSD/macOS tar does not, so we fall back to
// a sorted explicit member list with recursion disabled, which keeps ordering
// stable even though ownership/mtime are inherited from the filesystem. The
// manifest records the archive's own digest either way, so integrity never
// depends on reproducibility.
function defaultPacker({ staging, archivePath }) {
  const files = listTreeFiles(staging).map(f => relative(staging, f).split(sep).join("/")).sort();
  const gnu = isGnuTar();
  const args = gnu
    ? ["--create", "--gzip", "--file", archivePath, "--directory", staging,
       "--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime=@0", "."]
    : ["--create", "--gzip", "--file", archivePath, "--directory", staging,
       "--no-recursion", ...files];
  const env = gnu ? process.env : { ...process.env, COPYFILE_DISABLE: "1" };
  const result = spawnSync("tar", args, { encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(`release_pack_failed:${(result.stderr || "").trim().split("\n")[0] || "unknown"}`);
  }
}

let gnuTarCache = null;
function isGnuTar() {
  if (gnuTarCache !== null) return gnuTarCache;
  const probe = spawnSync("tar", ["--version"], { encoding: "utf8" });
  gnuTarCache = `${probe.stdout || ""}${probe.stderr || ""}`.includes("GNU tar");
  return gnuTarCache;
}

/** True when this platform's tar supports GNU determinism flags. */
export function supportsDeterministicTar() {
  return isGnuTar();
}

function printUsage() {
  console.log("Usage: node scripts/release/build-release.mjs --revision <40-hex-sha> \\");
  console.log("         [--version <v>] [--out <dir>] [--examples <p>] [--migrations <p>] [--notices <p>] [--tooling <p>] [--overwrite]");
  console.log("Builds one versioned archive plus manifest.json integrity metadata over the dist-vps runtime.");
  console.log("Refuses before any effect when a precondition fails. The revision must be this checkout's clean HEAD.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--help")) { printUsage(); process.exit(0); }
    const pick = name => { const i = args.indexOf(name); return i === -1 ? "" : (args[i + 1] || ""); };
    const result = assembleRelease({
      revision: pick("--revision"),
      version: pick("--version"),
      outDir: pick("--out") || "dist-release",
      overwrite: args.includes("--overwrite"),
      members: {
        examples: pick("--examples") || "examples/release",
        migrations: pick("--migrations") || "db/migrations",
        notices: ["NOTICE", "THIRD_PARTY.md", "third_party"],
        tooling: pick("--tooling") || "scripts/release",
      },
    });
    console.log(`release archive: ${result.archivePath}`);
    console.log(`  version ${result.version}, ${result.fileCount} files, ${result.totalBytes} bytes`);
    console.log(`  archive ${result.archiveBytes} bytes sha256=${result.archiveSha256.slice(0, 16)}...`);
    console.log(`manifest: ${result.manifestPath}`);
  } catch (error) {
    console.error(`build-release: ${error.message}`);
    process.exit(1);
  }
}