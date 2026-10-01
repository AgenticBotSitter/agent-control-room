import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REFUSAL_CODE_V1 = "direct_entry_guard_refused";

function refuseV1(reason, cause) {
  const error = new Error(`${REFUSAL_CODE_V1}: ${reason}`, cause === undefined ? undefined : { cause });
  error.code = REFUSAL_CODE_V1;
  throw error;
}

/**
 * Returns whether a module is the process entry point after resolving symlinks
 * on both spellings of the path.
 *
 * A missing or unresolvable entry path is not a safe "imported" result: it can
 * also mean an entry guard would silently skip the command. Refuse loudly so a
 * caller never mistakes an unexecuted script for success.
 *
 * @param {string | undefined} entryPath process.argv[1]
 * @param {string} moduleUrl import.meta.url
 * @returns {boolean}
 */
export function isMainModuleV1(entryPath, moduleUrl) {
  if (typeof entryPath !== "string" || entryPath.length === 0)
    refuseV1("process.argv[1] is missing");

  let canonicalEntry;
  try { canonicalEntry = realpathSync(entryPath); }
  catch (error) { refuseV1("process.argv[1] could not be resolved", error); }

  let canonicalModule;
  try { canonicalModule = realpathSync(fileURLToPath(moduleUrl)); }
  catch (error) { refuseV1("import.meta.url could not be resolved", error); }

  return canonicalEntry === canonicalModule;
}
