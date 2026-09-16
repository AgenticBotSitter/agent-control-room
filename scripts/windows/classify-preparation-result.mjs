/**
 * Maps PowerShell probe child-process results to safe error categories.
 *
 * Pure function: no spawn, no I/O. The CLI wrapper in
 * `check-windows-preparation.mjs` calls this with the real child-process
 * result; tests substitute synthetic results.
 *
 * Two layers, in order:
 *   1. Process layer — did the child run and report? Spawn refusal
 *      (ENOENT) is unavailable_platform; OS access denial (EACCES/EPERM)
 *      is permission_denied; any other error, signal, non-zero status or
 *      empty stdout is locked.
 *   2. Capability layer — the probe prints one `key: value` line per tool
 *      (`ps`, `node`, `pnpm`). Every required capability must be present
 *      and meet its minimum version, otherwise the result is missing.
 *      Extra lines (for example a legacy `dpapi:` line) are ignored:
 *      DPAPI is not a required capability because MVP worker preparation
 *      neither uses nor verifies it.
 *
 * Categories and exit codes come from the single canonical table in
 * `windows-exit-codes.mjs`, shared with the line-endings and launcher
 * scripts.
 */

import {
  windowsExitCategories,
  windowsExitCodeFor,
} from "./windows-exit-codes.mjs";

// Kept names so existing importers keep working; both are the canonical table.
export const preparationCategories = windowsExitCategories;
export const exitCodeFor = windowsExitCodeFor;

/** Minimum versions for already-installed tools (inspected, never downloaded). */
export const REQUIRED_NODE_VERSION = "22.13.0";
export const REQUIRED_PNPM_VERSION = "11.19.0";

/** Capabilities the probe must report; each maps to its minimum version ("" = presence only). */
const REQUIRED_CAPABILITIES = /** @type {const} */ ({
  ps: "",
  node: REQUIRED_NODE_VERSION,
  pnpm: REQUIRED_PNPM_VERSION,
});

/**
 * Numeric `major.minor.patch` comparison. Returns true when `actual`
 * meets or exceeds `minimum`. Non-numeric or short versions fail closed.
 *
 * @param {string} actual
 * @param {string} minimum
 * @returns {boolean}
 */
export function meetsMinimumVersion(actual, minimum) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[+-].*)?$/.exec((v ?? "").trim());
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const a = parse(actual);
  const b = parse(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/**
 * @typedef {Object} ChildResult
 * @property {Error & { code?: string }} | null | undefined error
 * @property {string | null} signal
 * @property {number | null} status
 * @property {string | null} stdout
 * @property {string | null} stderr
 */

/**
 * Validate the probe's `key: value` capability lines. Every required
 * capability must be present, not `missing`, and meet its minimum version.
 *
 * @param {string} stdout
 * @returns {{ ok: boolean, detail: string }}
 */
export function validateProbeCapabilities(stdout) {
  const reported = new Map();
  for (const line of (stdout ?? "").split(/\r?\n/)) {
    const m = /^([a-z0-9_]+):\s*(.*)$/.exec(line.trim());
    if (m) reported.set(m[1], m[2].trim());
  }
  for (const [key, minimum] of Object.entries(REQUIRED_CAPABILITIES)) {
    const value = reported.get(key);
    if (value === undefined || value === "" || value === "missing") {
      return { ok: false, detail: `${key}: missing` };
    }
    if (minimum && !meetsMinimumVersion(value, minimum)) {
      return { ok: false, detail: `${key}: ${value} below minimum ${minimum}` };
    }
  }
  return { ok: true, detail: "all required capabilities verified" };
}

/**
 * @param {ChildResult} result
 * @returns {{ category: (typeof preparationCategories)[number], exit: number }}
 */
export function classifyPreparationResult(result) {
  if (result.error) {
    if (result.error.code === "ENOENT") {
      return { category: "unavailable_platform", exit: exitCodeFor("unavailable_platform") };
    }
    if (result.error.code === "EACCES" || result.error.code === "EPERM") {
      return { category: "permission_denied", exit: exitCodeFor("permission_denied") };
    }
    return { category: "locked", exit: exitCodeFor("locked") };
  }
  if (result.signal) return { category: "locked", exit: exitCodeFor("locked") };
  if (result.status === 0 && !(result.stdout ?? "").trim()) {
    return { category: "locked", exit: exitCodeFor("locked") };
  }
  if (result.status !== 0) return { category: "locked", exit: exitCodeFor("locked") };
  const capabilities = validateProbeCapabilities(result.stdout ?? "");
  if (!capabilities.ok) {
    return { category: "missing", exit: exitCodeFor("missing") };
  }
  return { category: "available", exit: exitCodeFor("available") };
}
