// Staged update, safe rollback and refusal for the release path.
//
// LAYOUT (all under an operator-owned root; no privileged paths)
//
//   <root>/releases/<version>/     unpacked, verified releases
//   <root>/current                 symlink -> releases/<version>   (the live one)
//   <root>/state/                  durable operator state  — NEVER written here
//   <root>/uncertain/              one marker file per unfinished unit of work
//   <root>/update.log              bounded append-only log
//
// WHY THE ORDER MATTERS
//
// Update is staged, not in-place: the new release is unpacked and fully verified
// in `releases/<version>` BEFORE `current` is repointed. A failure at any point
// before the switch leaves the running release exactly as it was.
//
// UNCERTAIN WORK
//
// A marker in `uncertain/` means a unit of work was interrupted with no recorded
// outcome — the release must not decide for the operator. Update and rollback
// therefore REFUSE while markers exist, naming them, rather than proceeding and
// losing the ability to reconcile. Clearing a marker is an explicit operator act
// (`resolve-uncertain`), which records the resolution in the log.
//
// stdlib only. Every refusal is a named release_* error, never a silent pass.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, lstatSync,
  symlinkSync, rmSync, renameSync, appendFileSync, statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve, basename } from "node:path";
import { verifyRelease, verifyUnpacked } from "./verify-artifact.mjs";
import { MANIFEST_NAME } from "./build-release.mjs";

export const LOG_NAME = "update.log";
export const CURRENT_LINK = "current";
export const LOG_MAX_BYTES = 256 * 1024;

/** Bounded append-only log: rotates once past the cap so logs stay bounded. */
export function logLine(root, message, now = new Date().toISOString()) {
  const logPath = join(root, LOG_NAME);
  if (existsSync(logPath) && statSync(logPath).size > LOG_MAX_BYTES) {
    try { renameSync(logPath, `${logPath}.1`); } catch { /* rotation is best effort */ }
  }
  appendFileSync(logPath, `${now} ${message}\n`);
}

/** Marker files representing work whose outcome was never recorded. */
export function listUncertain(root) {
  const dir = join(root, "uncertain");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.endsWith(".json")).sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Resolve the currently active release directory, or null when none. */
export function currentRelease(root) {
  const link = join(root, CURRENT_LINK);
  if (!existsSync(link)) return null;
  const st = lstatSync(link);
  if (!st.isSymbolicLink()) throw new Error("release_current_not_symlink");
  const target = resolve(root, readFileSync(link, "utf8").trim() || ".");
  return existsSync(target) ? target : null;
}

/** The version of a release dir, taken from its manifest. */
export function releaseVersion(releaseDir) {
  return readJson(join(releaseDir, MANIFEST_NAME)).version;
}

/**
 * Stage: unpack+verify an archive into releases/<version>.
 * Refuses on any verification failure and leaves no partial release dir.
 */
export function stage({ root, archivePath, manifestPath } = {}) {
  const check = verifyRelease({ archivePath, manifestPath });
  if (!check.ok) throw new Error(`release_stage_refused:${check.problems.slice(0, 3).join(",")}`);
  const manifest = readJson(manifestPath);
  const target = join(root, "releases", manifest.version);
  if (existsSync(target)) throw new Error("release_version_exists");
  mkdirSync(join(root, "releases"), { recursive: true });
  const tmp = `${target}.staging`;
  rmSync(tmp, { recursive: true, force: true });
  const extract = spawnTar(archivePath, tmp);
  if (extract !== 0) { rmSync(tmp, { recursive: true, force: true }); throw new Error("release_unpack_failed"); }
  renameSync(tmp, target);
  logLine(root, `stage ok version=${manifest.version} revision=${manifest.revision}`);
  return { version: manifest.version, dir: target, revision: manifest.revision };
}

function spawnTar(archivePath, dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("tar", ["--extract", "--gzip", "--file", archivePath, "--directory", dir], { encoding: "utf8" });
  return r.status;
}

/** Point `current` at an already-staged release. Atomic-ish: write then rename. */
export function activate({ root, version, now = new Date().toISOString() } = {}) {
  const target = join(root, "releases", version);
  if (!existsSync(target)) throw new Error("release_version_missing");
  // A staged release only goes live when its own tree still matches its
  // manifest: an already-staged release can drift before activation.
  const unpacked = verifyUnpacked({ unpackedRoot: target, manifestPath: join(target, MANIFEST_NAME) });
  if (!unpacked.ok) throw new Error(`release_activate_refused_unverified:${unpacked.problems.slice(0, 3).join(",")}`);

  const link = join(root, CURRENT_LINK);
  const tmpLink = join(root, `.current.${process.pid}`);
  rmSync(tmpLink, { force: true });
  symlinkSync(join("releases", version), tmpLink);
  renameSync(tmpLink, link);

  // Record the activation history so rollback knows where to return to.
  const historyPath = join(root, "history.json");
  const history = existsSync(historyPath) ? readJson(historyPath) : { schema: "control-room.release-history/v1", entries: [] };
  history.entries.push({ version, at: now });
  writeFileSync(historyPath, JSON.stringify(history, null, 2) + "\n");
  logLine(root, `activate ok version=${version}`);
  return { version, dir: target };
}

/**
 * Staged update: stage then activate, refusing while uncertain work exists.
 * Never touches `state/`.
 */
export function update({ root, archivePath, manifestPath, now = new Date().toISOString() } = {}) {
  const uncertain = listUncertain(root);
  if (uncertain.length > 0) {
    logLine(root, `update refused uncertain=${uncertain.join(",")}`);
    throw new Error(`release_update_refused_uncertain_work:${uncertain.join(",")}`);
  }
  const staged = stage({ root, archivePath, manifestPath });
  const active = currentRelease(root);
  if (active && releaseVersion(active) === staged.version) {
    logLine(root, `update no-op version=${staged.version}`);
    return { ...staged, changed: false };
  }
  activate({ root, version: staged.version, now });
  return { ...staged, changed: true };
}

/**
 * Roll back to the previous release.
 *
 * Refusals:
 *   - uncertain work present
 *   - no previous release recorded in history
 *   - the target release is absent or its manifest does not verify (UNSAFE)
 */
export function rollback({ root, to = "", now = new Date().toISOString() } = {}) {
  const uncertain = listUncertain(root);
  if (uncertain.length > 0) {
    logLine(root, `rollback refused uncertain=${uncertain.join(",")}`);
    throw new Error(`release_rollback_refused_uncertain_work:${uncertain.join(",")}`);
  }
  const historyPath = join(root, "history.json");
  if (!existsSync(historyPath)) throw new Error("release_rollback_refused_no_history");
  const history = readJson(historyPath);
  const entries = Array.isArray(history.entries) ? history.entries : [];
  const active = currentRelease(root);
  const activeVersion = active ? releaseVersion(active) : "";

  let targetVersion = to;
  if (!targetVersion) {
    // Previous distinct version before the active one.
    const prior = entries.map(e => e.version).filter(v => v !== activeVersion);
    targetVersion = prior[prior.length - 1] || "";
  }
  if (!targetVersion) throw new Error("release_rollback_refused_no_previous");
  if (targetVersion === activeVersion) throw new Error("release_rollback_refused_same_version");

  const dir = join(root, "releases", targetVersion);
  if (!existsSync(dir)) throw new Error(`release_rollback_refused_target_missing:${targetVersion}`);
  // Unsafe rollback: a target whose own tree does not match its manifest would
  // put an unverifiable release live, so it is refused rather than attempted.
  if (!existsSync(join(dir, MANIFEST_NAME))) {
    logLine(root, `rollback refused unsafe=${targetVersion}`);
    throw new Error(`release_rollback_refused_unsafe:${targetVersion}`);
  }

  activate({ root, version: targetVersion, now });
  logLine(root, `rollback ok from=${activeVersion} to=${targetVersion}`);
  return { version: targetVersion, from: activeVersion };
}

/**
 * Resolve one uncertain marker — the explicit operator act that allows the next
 * update or rollback. Records the resolution so the decision is auditable.
 */
export function resolveUncertain({ root, marker, resolution = "resolved", now = new Date().toISOString() } = {}) {
  const dir = join(root, "uncertain");
  const path = join(dir, basename(marker));
  if (!existsSync(path)) throw new Error("release_uncertain_marker_missing");
  const record = readJson(path);
  const resolvedDir = join(root, "resolved");
  mkdirSync(resolvedDir, { recursive: true });
  writeFileSync(join(resolvedDir, basename(marker)), JSON.stringify({ ...record, resolution, resolvedAt: now }, null, 2) + "\n");
  rmSync(path, { force: true });
  logLine(root, `resolve-uncertain ${basename(marker)} resolution=${resolution}`);
  return { marker: basename(marker), resolution };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const pick = name => { const i = args.indexOf(name); return i === -1 ? "" : (args[i + 1] || ""); };
  const command = args[0];
  const root = resolve(pick("--root") || ".");
  try {
    if (!command || command === "--help") {
      console.log("Usage: node scripts/release/update.mjs <stage|activate|update|rollback|resolve-uncertain|status> --root <dir> [...]");
      console.log("  update --archive <path> [--manifest <path>]     staged update; refuses on uncertain work");
      console.log("  rollback [--to <version>]                       safe rollback; refuses unsafe targets");
      console.log("  resolve-uncertain --marker <file> [--resolution <text>]");
      console.log("  status");
      process.exit(command ? 0 : 1);
    }
    if (command === "status") {
      const active = currentRelease(root);
      console.log(`root: ${root}`);
      console.log(`current: ${active ? releaseVersion(active) : "(none)"}`);
      console.log(`uncertain: ${listUncertain(root).join(",") || "(none)"}`);
      process.exit(0);
    }
    if (command === "resolve-uncertain") {
      const r = resolveUncertain({ root, marker: pick("--marker"), resolution: pick("--resolution") || "resolved" });
      console.log(`resolved ${r.marker} as ${r.resolution}`);
      process.exit(0);
    }
    const archivePath = resolve(pick("--archive"));
    const manifestPath = resolve(pick("--manifest") || join(archivePath, "..", MANIFEST_NAME));
    const result = command === "stage"
      ? stage({ root, archivePath, manifestPath })
      : command === "activate" ? activate({ root, version: pick("--version") })
        : command === "update" ? update({ root, archivePath, manifestPath })
          : rollback({ root, to: pick("--to") });
    console.log(`${command}: ${JSON.stringify(result)}`);
    process.exit(0);
  } catch (error) {
    console.error(`${command || "update"}: ${error.message}`);
    process.exit(1);
  }
}