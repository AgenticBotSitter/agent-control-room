import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
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

/** The production-oriented loader has no caller-selected JSON filename. The
 * protected root is selected by the installer; from there this exact file is
 * the only Mac-local configuration source. */
export async function loadMacLocalProtectedConfigurationFromRootV1(protectedRoot: string,
  runtime: Runtime = production): Promise<MacLocalProtectedConfigurationV1> {
  if (!isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot) throw new Error("mac_local_protected_configuration_root_invalid");
  const configRoot = join(protectedRoot, "config"), path = join(configRoot, "mac-local.json");
  if (resolve(path) !== path) throw new Error("mac_local_protected_configuration_root_invalid");
  try {
    for (const directory of [protectedRoot, configRoot]) {
      const entry = await runtime.lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error();
    }
    return await loadMacLocalProtectedConfigurationV1(path, runtime);
  } catch { throw new Error("mac_local_protected_configuration_root_invalid"); }
}
