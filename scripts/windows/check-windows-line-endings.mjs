/**
 * Windows line-ending verification probe.
 *
 * Walks a clone root and reports any tracked file whose worktree bytes use
 * CRLF (`\r\n`) or mixed (`\n` and `\r\n`) line endings instead of LF (`\n`).
 * The Control Room public repo pins `* text=auto eol=lf` via
 * `.gitattributes`; default Windows checkouts apply CRLF for text files and
 * break byte-pinned evidence (see `docs/platforms/windows.md` §1).
 *
 * `git ls-files --eol` prints `<index-flag> <worktree-flag> <attr> TAB <path>`;
 * the path is parsed separately from the `attr/...` field so attribute text can never
 * leak into the reported path. Both `w/crlf` and `w/mixed` worktree flags
 * are findings — Git reports mixed LF/CRLF content as `w/mixed`, and it
 * must not pass.
 *
 * Usage:
 *   node scripts/windows/check-windows-line-endings.mjs <repo-root>
 *
 * Exit codes come from the single canonical table in
 * `windows-exit-codes.mjs` (shared with the preparation and launcher
 * scripts):
 *   0  available             — every tracked file is LF
 *   3  corrupt               — one or more CRLF/mixed files (listed on stdout)
 *   4  unavailable_platform  — wrong CLI args / missing path / not a git root /
 *                              git not on PATH / `ls-files --eol` failed
 *
 * No mutations: this script only reads. It does NOT delete or rewrite files.
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { windowsExitCodeFor } from "./windows-exit-codes.mjs";

const usage = (message) => {
  process.stderr.write(`usage: check-windows-line-endings.mjs <repo-root>\n  ${message}\n`);
  process.exit(windowsExitCodeFor("unavailable_platform"));
};

const repoArg = process.argv[2];
if (!repoArg) usage("missing <repo-root>");
if (!isAbsolute(repoArg)) usage("<repo-root> must be an absolute path");
const repoRoot = resolve(repoArg);

try {
  const stat = statSync(repoRoot);
  if (!stat.isDirectory()) usage("<repo-root> is not a directory");
} catch {
  usage("<repo-root> does not exist");
}

const proc = spawnSync("git", ["ls-files", "--eol"], { cwd: repoRoot, encoding: "utf8" });
if (proc.error) {
  if (proc.error.code === "ENOENT") {
    process.stderr.write("git not on PATH (unavailable_platform)\n");
  } else {
    process.stderr.write(`git ls-files failed: ${proc.error.message}\n`);
  }
  process.exit(windowsExitCodeFor("unavailable_platform"));
}
if (proc.status !== 0) {
  process.stderr.write(`git ls-files --eol exited ${proc.status}\n${proc.stderr ?? ""}`);
  process.exit(windowsExitCodeFor("unavailable_platform"));
}

const lines = (proc.stdout ?? "").split(/\r?\n/).filter(Boolean);
const bad = [];
for (const line of lines) {
  // Format: `<i-flag> <w-flag> <attr> TAB <path>`. The index/worktree/attr
  // fields are space-separated; the path follows the first TAB, so
  // `attr/...` text (which may itself contain spaces) never leaks into the
  // reported path.
  const tab = line.indexOf("\t");
  if (tab === -1) continue;
  const head = line.slice(0, tab).split(/\s+/);
  if (head.length < 2) continue;
  const worktreeFlag = head[1];
  const path = line.slice(tab + 1);
  if (!path) continue;
  if (worktreeFlag === "w/crlf" || worktreeFlag === "w/mixed") {
    bad.push(`${worktreeFlag} ${path}`);
  }
}

if (bad.length === 0) {
  process.stdout.write(`ok: ${lines.length} tracked files, all LF\n`);
  process.exit(windowsExitCodeFor("available"));
}
process.stdout.write(`bad-endings: ${bad.length} tracked files use CRLF or mixed endings in worktree\n`);
for (const entry of bad) process.stdout.write(`  ${entry}\n`);
process.exit(windowsExitCodeFor("corrupt"));
