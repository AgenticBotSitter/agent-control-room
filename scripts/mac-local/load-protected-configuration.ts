import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { captureMacLocalProtectedConfigurationV1, type MacLocalProtectedConfigurationV1 } from "../../src/web/v1/mac-local-protected-configuration";

type Runtime = Readonly<{ lstat: typeof lstat; readFile: typeof readFile }>;
const production: Runtime = Object.freeze({ lstat, readFile });

/** Loads exactly one owner-controlled JSON file. This is deliberately not an
 * environment loader and has no fallback path, credential lookup, database,
 * listener, or worker side effect. */
export async function loadMacLocalProtectedConfigurationV1(path: string,
  runtime: Runtime = production): Promise<MacLocalProtectedConfigurationV1> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("mac_local_protected_configuration_file_invalid");
  try {
    const entry = await runtime.lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > 64 * 1024)
      throw new Error();
    return captureMacLocalProtectedConfigurationV1(JSON.parse(await runtime.readFile(path, "utf8")));
  } catch { throw new Error("mac_local_protected_configuration_file_invalid"); }
}
