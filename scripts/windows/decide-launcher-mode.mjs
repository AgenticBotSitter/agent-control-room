/**
 * Windows launcher-mode decision.
 *
 * The Control Room Windows portability package supports a small, fixed set of
 * launcher modes. Anything outside that set must be refused explicitly with
 * one of the safe categories from `src/node-policy/v1/types.ts:keyAvailabilityStates`.
 *
 * Supported modes:
 *   - 'contributor-demo' — disposable pglite demo on 127.0.0.1:3000/local-preview
 *   - 'remote-worker-prep' — preparation probe only (this package)
 *
 * Refused modes:
 *   - 'production-server'   → unavailable_platform (Linux is the initial production target)
 *   - 'live-harness-launch' → permission_denied (native harness activation is Q2/Q3/Q6 gated)
 *   - 'posix-vps-custody'   → unavailable_platform (POSIX getuid-only path; not portable)
 *   - anything else         → corrupt (closest canonical member for malformed input)
 *
 * Pure ESM, no spawn, no I/O. Designed for unit tests + small CLI wrapper.
 */

export const supportedLauncherModes = /** @type {const} */ ([
  "contributor-demo",
  "remote-worker-prep",
]);

export const unsupportedLauncherModes = /** @type {const} */ ([
  "production-server",
  "live-harness-launch",
  "posix-vps-custody",
]);

import { windowsExitCodeFor } from "./windows-exit-codes.mjs";

/** @typedef {supportedLauncherModes[number] | unsupportedLauncherModes[number] | string} LauncherMode */

/** @typedef {"available" | "unavailable_platform" | "permission_denied" | "corrupt"} LauncherDecision */

const LAUNCHER_CATEGORY_TO_EXIT = /** @type {const} */ ({
  available: windowsExitCodeFor("available"),
  unavailable_platform: windowsExitCodeFor("unavailable_platform"),
  permission_denied: windowsExitCodeFor("permission_denied"),
  corrupt: windowsExitCodeFor("corrupt"),
});

/**
 * @param {LauncherMode} mode
 * @returns {{ ok: true, mode: typeof supportedLauncherModes[number] } | { ok: false, reason: Exclude<LauncherDecision, "available">, mode: LauncherMode }}
 */
export function decideLauncherMode(mode) {
  if (supportedLauncherModes.includes(/** @type {typeof supportedLauncherModes[number]} */ (mode))) {
    return { ok: true, mode: /** @type {typeof supportedLauncherModes[number]} */ (mode) };
  }
  if (mode === "production-server" || mode === "posix-vps-custody") {
    return { ok: false, reason: "unavailable_platform", mode };
  }
  if (mode === "live-harness-launch") {
    return { ok: false, reason: "permission_denied", mode };
  }
  return { ok: false, reason: "corrupt", mode };
}

/**
 * CLI wrapper: prints a single-line decision and exits with the matching code.
 * Exit codes come from the single canonical table in
 * `windows-exit-codes.mjs` (shared with the preparation and line-endings
 * scripts):
 *   available             → exit 0
 *   unavailable_platform  → exit 4
 *   permission_denied     → exit 5
 *   corrupt               → exit 3
 */
export function runLauncherModeCli(argv = process.argv.slice(2)) {
  const mode = argv[0];
  if (!mode) {
    process.stderr.write("usage: launcher-mode.mjs <mode>\n");
    process.exit(LAUNCHER_CATEGORY_TO_EXIT.corrupt);
  }
  const decision = decideLauncherMode(mode);
  if (decision.ok) {
    process.stdout.write(`ok: ${decision.mode}\n`);
    process.exit(LAUNCHER_CATEGORY_TO_EXIT.available);
  }
  process.stderr.write(`refused: ${decision.mode} (${decision.reason})\n`);
  process.exit(LAUNCHER_CATEGORY_TO_EXIT[decision.reason]);
}

// Direct invocation: when this module is the entry point, run the CLI.
// `import.meta.url === pathToFileURL(process.argv[1]).href` is true only when
// the module is the entry script, not when imported by another module.
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLauncherModeCli();
}
