/**
 * Canonical Windows package exit-code table.
 *
 * Single source of truth for every script under `scripts/windows/`. Each
 * category is a member of `src/node-policy/v1/types.ts:keyAvailabilityStates`,
 * and each exit code is stable per category so callers can match on exit
 * status without inspecting stdout.
 *
 *   available             → exit 0 — every required capability verified
 *   missing               → exit 1 — required capability absent or below minimum
 *   locked                → exit 2 — child failed, was signalled, timed out, or
 *                                    produced no output
 *   corrupt               → exit 3 — malformed input, unexpected content, or a
 *                                    required package file missing on disk
 *   unavailable_platform  → exit 4 — wrong CLI usage, missing path, not a git
 *                                    root, or the required launcher (PowerShell,
 *                                    git) not on PATH
 *   permission_denied     → exit 5 — the OS refused the spawn (EACCES/EPERM)
 *   interaction_required  → exit 6 — reserved; not produced by any current script
 *
 * Pure ESM, no spawn, no I/O.
 */

export const windowsExitCategories = /** @type {const} */ ([
  "available",
  "missing",
  "locked",
  "corrupt",
  "unavailable_platform",
  "permission_denied",
  "interaction_required",
]);

/** @typedef {typeof windowsExitCategories[number]} WindowsExitCategory */

const WINDOWS_CATEGORY_TO_EXIT = /** @type {const} */ ({
  available: 0,
  missing: 1,
  locked: 2,
  corrupt: 3,
  unavailable_platform: 4,
  permission_denied: 5,
  interaction_required: 6,
});

/**
 * @param {WindowsExitCategory} category
 * @returns {number}
 */
export function windowsExitCodeFor(category) {
  if (!windowsExitCategories.includes(category)) {
    throw new Error(`unknown windows exit category: ${category}`);
  }
  return WINDOWS_CATEGORY_TO_EXIT[category];
}
