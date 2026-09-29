import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { captureMacLocalProtectedConfigurationV1, type MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";
import { captureMacLocalDatabaseRolesV1, type MacLocalDatabaseRolesV1 } from "./mac-local-database-roles";
import { captureWorkIntakeServerConfigurationV1, type WorkIntakeServerConfigurationV1 } from
  "../../work-intake/v1/installed-configuration";
import { captureOwnerWebPushConfigV1, type OwnerWebPushConfigV1 } from "../../web-push/v1";

type Runtime = Readonly<{ lstat: typeof lstat; readFile: typeof readFile }>;
const production: Runtime = Object.freeze({ lstat, readFile });

/**
 * The release-owned, side-effect-free reader for the one protected Mac-local
 * configuration. It intentionally has no environment fallback and never
 * opens PostgreSQL, starts a listener, or starts a worker.
 */
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

/** The installer selects the protected root; callers cannot select a JSON
 * filename below it. */
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

/** Reads the fixed six-role map beside mac-local.json. Every role is checked
 * by the existing one-authority-database validator before any pool can open. */
export async function loadMacLocalDatabaseRolesFromRootV1(protectedRoot: string,
  runtime: Runtime = production): Promise<MacLocalDatabaseRolesV1> {
  if (!isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot) throw new Error("mac_local_database_roles_root_invalid");
  const configRoot = join(protectedRoot, "config"), path = join(configRoot, "database-roles.json");
  if (resolve(path) !== path) throw new Error("mac_local_database_roles_root_invalid");
  try {
    for (const directory of [protectedRoot, configRoot]) {
      const entry = await runtime.lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error();
    }
    const entry = await runtime.lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > 64 * 1024) throw new Error();
    return captureMacLocalDatabaseRolesV1(JSON.parse(await runtime.readFile(path, "utf8")));
  } catch { throw new Error("mac_local_database_roles_root_invalid"); }
}

/** Optional installed child of the existing Mac-local host. A missing record
 * keeps intake disabled; an unsafe or malformed record fails closed. */
export async function loadWorkIntakeServerConfigurationFromRootV1(protectedRoot: string,
  runtime: Runtime = production): Promise<WorkIntakeServerConfigurationV1 | undefined> {
  if (!isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot)
    throw new Error("work_intake_installed_configuration_root_invalid");
  const configRoot = join(protectedRoot, "config"), path = join(configRoot, "work-intake-server.json");
  try {
    for (const directory of [protectedRoot, configRoot]) {
      const entry = await runtime.lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error();
    }
    let entry;
    try { entry = await runtime.lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > 64 * 1024) throw new Error();
    return captureWorkIntakeServerConfigurationV1(JSON.parse(await runtime.readFile(path, "utf8")));
  } catch { throw new Error("work_intake_installed_configuration_root_invalid"); }
}

/** Optional owner-only VAPID credentials. Missing keeps phone push off; malformed fails closed. */
export async function loadOwnerWebPushConfigFromRootV1(protectedRoot: string,
  runtime: Runtime = production): Promise<OwnerWebPushConfigV1 | undefined> {
  if (!isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot) throw new Error("owner_web_push_config_root_invalid");
  const configRoot = join(protectedRoot, "config"), path = join(configRoot, "owner-web-push.json");
  try {
    for (const directory of [protectedRoot, configRoot]) { const entry = await runtime.lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error(); }
    let entry; try { entry = await runtime.lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > 4096) throw new Error();
    return captureOwnerWebPushConfigV1(JSON.parse(await runtime.readFile(path, "utf8")));
  } catch { throw new Error("owner_web_push_config_invalid"); }
}
