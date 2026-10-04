import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REFUSAL_CODE_V1 = "direct_entry_guard_refused";

function refuseV1(reason, cause) {
  const error = new Error(`${REFUSAL_CODE_V1}: ${reason}`, cause === undefined ? undefined : { cause });
  error.code = REFUSAL_CODE_V1;
  throw error;
}

// ONE entry guard for the whole tree (lead decision, 2026-10-01). It replaces
// the two copies this repository used to keep:
//
//   - `src/updater/v1/pg/database-phase-contract.mjs`'s `isMainModuleV1`, which
//     returned `false` for a missing or unresolvable `process.argv[1]`. That
//     `false` is the silent no-op its own comment warns about: a phase entry
//     installed through a link whose spelling cannot be resolved would run, do
//     nothing and EXIT ZERO, and the port would then refuse with
//     `database_phase_result_refused` naming neither the script nor the reason.
//
//   - the `typeof process.argv[1] === "string" && … && !startsWith("file:")`
//     pre-guards that `cli.mjs`, `updater.mjs` and `build-attended-release.mjs`
//     each wrapped around this helper. They existed only to stop this guard's
//     refusal from firing on an IMPORT, and they re-implemented the decision in
//     three places.
//
// The two halves of the contract, and why they differ:
//
//   `process.argv[1]` MISSING  -> `false`. MEASURED: `node --input-type=module
//     --eval "<code>"` with no extra argument leaves `argv` at one element, so
//     this is the ordinary import context (a bundle loaded by other code, an
//     `--eval` program that imports this module). There is no entry to be wrong
//     about, so there is nothing to refuse.
//
//   `process.argv[1]` PRESENT but unresolvable -> refuse loudly. An entry that
//     was genuinely started under a path that cannot be resolved would silently
//     skip its own body, and the port above it would see a zero exit and an
//     empty result. The refusal is the only outcome that cannot be mistaken for
//     success.
//
// A `file:` URL in `argv[1]` is an import context too, but it is NOT the missing
// case and must not be treated as one here. MEASURED: `node <a file: URL>`
// fails with `Cannot find module '<cwd>/file:/…'`, so a `file:` URL can never be
// a real entry; and under `--eval` the first extra argument lands in `argv[1]`
// verbatim, which is how `--eval "await import(process.argv[1])" <url>` works.
// The callers that must tolerate that shape ask the question themselves; this
// helper refuses the unresolvable path, which is the case it exists for.
const FILE_URL_PREFIX_V1 = "file:";

/**
 * Returns whether a module is the process entry point after resolving symlinks
 * on both spellings of the path.
 *
 * @param {string | undefined} entryPath process.argv[1]
 * @param {string} moduleUrl import.meta.url of the module asking
 * @returns {boolean} true only when the two canonical paths are the same file
 * @throws {Error & { code: "direct_entry_guard_refused" }} when `entryPath` is
 *   present but neither it nor `moduleUrl` can be resolved
 */
export function isMainModuleV1(entryPath, moduleUrl) {
  if (entryPath === undefined || entryPath === null) return false;
  if (typeof entryPath !== "string") refuseV1("process.argv[1] is not a string");
  if (entryPath.length === 0) refuseV1("process.argv[1] is empty");
  if (entryPath.startsWith(FILE_URL_PREFIX_V1)) {
    return refuseV1("process.argv[1] is a file: URL, not a path this process was started with");
  }

  let canonicalEntry;
  try { canonicalEntry = realpathSync(entryPath); }
  catch (error) { refuseV1("process.argv[1] could not be resolved", error); }

  let canonicalModule;
  try { canonicalModule = realpathSync(fileURLToPath(moduleUrl)); }
  catch (error) { refuseV1("import.meta.url could not be resolved", error); }

  return canonicalEntry === canonicalModule;
}

// A source CLI folded into another entry has no independent runtime identity.
// Vite defines this marker only in bundles; ordinary source execution keeps the
// same canonical-path and refusal semantics as isMainModuleV1.
export function isUnbundledMainModuleV1(entryPath, moduleUrl) {
  return !import.meta.controlRoomBundled && isMainModuleV1(entryPath, moduleUrl);
}
