/**
 * Windows PowerShell preparation probe.
 *
 * Runs a small, fixed PowerShell probe that reports the host's installed
 * tools for the Windows portability package. No harness is launched, no real
 * credentials are read, no native effect is produced. The probe reads only:
 *   - PowerShell version
 *   - Node version (via `node --version`, already-installed only)
 *   - pnpm version (via `pnpm --version`, already-installed only)
 *
 * The probe never downloads code: `npx --yes` is forbidden here because on
 * an unprepared machine it would fetch and execute remote code and write to
 * the npm cache. Installing or upgrading tools is a separate, explicitly
 * authorized step. DPAPI is not probed — MVP worker preparation neither
 * uses nor verifies it.
 *
 * The classifier (`classify-preparation-result.mjs`) validates every
 * reported capability and its minimum version; a miss or an under-minimum
 * version is `missing`, never `available`.
 *
 * Exit codes come from the single canonical table in
 * `windows-exit-codes.mjs` (shared with the line-endings and launcher
 * scripts):
 *   0  available             — every required tool/version verified
 *   1  missing               — required capability absent or below minimum
 *   2  locked                — PowerShell child failed / signal / timeout /
 *                              empty output
 *   3  corrupt               — probe script missing on disk
 *   4  unavailable_platform  — PowerShell itself is not on PATH
 *   5  permission_denied     — the OS refused the spawn (EACCES/EPERM)
 *   6  interaction_required  — reserved; not produced here
 *
 * Hygiene (per `ziggy-machine-profile` §4):
 *   - `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass`
 *   - PowerShell child spawned with `windowsHide: true` equivalent,
 *     bounded output (64 KiB) and a 60 s timeout
 *   - Secrets (if any) are stdin-only; this probe reads none
 *   - Never invokes a harness to discover a version
 *
 * Usage:
 *   node scripts/windows/check-windows-preparation.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPreparationResult } from "./classify-preparation-result.mjs";
import { windowsExitCodeFor } from "./windows-exit-codes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(here, "windows-preparation-probe.ps1");
if (!existsSync(PROBE)) {
  process.stderr.write(`probe script not found: ${PROBE}\n`);
  process.exit(windowsExitCodeFor("corrupt"));
}

const POWERSHELL_ARGS = [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
  "-File", PROBE,
];

const proc = spawnSync("powershell.exe", POWERSHELL_ARGS, {
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 64 * 1024,
  timeout: 60_000,
});
const { category, exit } = classifyPreparationResult(proc);
const stdout = proc.stdout ?? "";
const stderr = proc.stderr ?? "";

if (category !== "available") {
  process.stderr.write(`${category}: preparation probe did not verify every capability\n`);
  for (const line of stdout.split(/\r?\n/)) if (line) process.stderr.write(`  ${line}\n`);
  if (stderr) process.stderr.write(stderr);
  process.exit(exit);
}

for (const line of stdout.split(/\r?\n/)) if (line) process.stdout.write(`${line}\n`);
process.stdout.write("ok: PowerShell preparation probe passed\n");
process.exit(exit);
