import { directoryCustodyV1, sameFileV1, stableFileBytesV1 } from "../../installer/shared/file-custody.mjs";
import { parseStrictJsonV1 } from "../../installer/shared/strict-json.mjs";
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { captureMacLocalProtectedConfigurationV1, type MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";
import { captureMacLocalDatabaseRolesV1, MAC_LOCAL_DATABASE_ROLES_V1, type MacLocalDatabaseRolesV1 } from "./mac-local-database-roles";
import { validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "./private-postgres";
import { captureWorkIntakeServerConfigurationV1, type WorkIntakeServerConfigurationV1 } from
  "../../work-intake/v1/installed-configuration";
import { captureOwnerWebPushConfigV1, type OwnerWebPushConfigV1 } from "../../web-push/v1";

type Runtime = Readonly<{ lstat(path: string): Promise<Stats>; readFile(path: string, encoding: "utf8", expected?: Stats): Promise<string>;
  getuid?: () => number; getgid?: () => number; getgroups?: () => number[] }>;
const production: Runtime = Object.freeze({ lstat, readFile: async (path: string, _encoding: "utf8", expected?: Stats) =>
  (await stableFileBytesV1(path, 64 * 1024, (entry: Stats) => {
    if (expected && !sameFileV1(expected, entry)) throw new Error("file_custody_refused");
  })).toString("utf8") });

// Private owner files remain supported for development. Shared installed files
// must be root-owned and readable only by the service group.
function protectedMetadata(entry: Stats, runtime: Runtime, expected?: Readonly<{ uid: number; gid: number }>) {
  const uid = runtime.getuid?.() ?? process.getuid?.() ?? -1;
  const gid = runtime.getgid?.() ?? process.getgid?.() ?? -1;
  const groups = runtime.getgroups?.() ?? process.getgroups?.() ?? [];
  if ((entry.mode & 0o027) !== 0 || (entry.uid !== 0 && entry.uid !== uid)) throw new Error();
  if ((entry.mode & 0o050) !== 0 && (entry.uid !== 0
    || uid !== 0 && entry.gid !== gid && !groups.includes(entry.gid))) throw new Error();
  if (expected !== undefined && (entry.uid !== expected.uid || entry.gid !== expected.gid)) throw new Error();
}

async function protectedDirectories(protectedRoot: string, runtime: Runtime) {
  const check = await directoryCustodyV1(protectedRoot, runtime.lstat);
  const checkConfig = await directoryCustodyV1(join(protectedRoot, "config"), runtime.lstat);
  const root = await runtime.lstat(protectedRoot);
  const config = await runtime.lstat(join(protectedRoot, "config"));
  for (const entry of [root, config]) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error();
    protectedMetadata(entry, runtime, { uid: root.uid, gid: root.gid });
  }
  return Object.freeze({ uid: root.uid, gid: root.gid, check: async () => { await check(); await checkConfig(); } });
}

/**
 * The release-owned, side-effect-free reader for the one protected Mac-local
 * configuration. It intentionally has no environment fallback and never
 * opens PostgreSQL, starts a listener, or starts a worker.
 */
export async function loadMacLocalProtectedConfigurationV1(path: string,
  runtime: Runtime = production, context: Readonly<{ installRoot?: string }> = {}): Promise<MacLocalProtectedConfigurationV1> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("mac_local_protected_configuration_file_invalid");
  try {
    const entry = await runtime.lstat(path);
    protectedMetadata(entry, runtime);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 64 * 1024)
      throw new Error();
    const bytes = await runtime.readFile(path, "utf8", entry);
    if (Buffer.byteLength(bytes) > 64 * 1024 || !sameFileV1(entry, await runtime.lstat(path))) throw new Error();
    return captureMacLocalProtectedConfigurationV1(parseStrictJsonV1(bytes), context);
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
    const owner = await protectedDirectories(protectedRoot, runtime);
    protectedMetadata(await runtime.lstat(path), runtime, owner);
    const captured = await loadMacLocalProtectedConfigurationV1(path, runtime, { installRoot: dirname(protectedRoot) });
    await owner.check();
    return captured;
  } catch { throw new Error("mac_local_protected_configuration_root_invalid"); }
}

/** The protected-file checks every database-role read shares. Returns the
 * parsed `database-roles.json`, or throws. A link, a world- or group-readable
 * file, an oversized file, or a lax directory is refused before any JSON is
 * parsed, so no caller gets a record out of a file the owner did not protect. */
async function readProtectedDatabaseRolesFileV1(protectedRoot: string, runtime: Runtime): Promise<Record<string, unknown>> {
  if (!isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot) throw new Error("mac_local_database_roles_root_invalid");
  const configRoot = join(protectedRoot, "config"), path = join(configRoot, "database-roles.json");
  if (resolve(path) !== path) throw new Error("mac_local_database_roles_root_invalid");
  try {
    const owner = await protectedDirectories(protectedRoot, runtime);
    const entry = await runtime.lstat(path);
    protectedMetadata(entry, runtime, owner);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 64 * 1024) throw new Error();
    const bytes = await runtime.readFile(path, "utf8", entry);
    if (Buffer.byteLength(bytes) > 64 * 1024 || !sameFileV1(entry, await runtime.lstat(path))) throw new Error();
    await owner.check();
    return parseStrictJsonV1(bytes) as Record<string, unknown>;
  } catch { throw new Error("mac_local_database_roles_root_invalid"); }
}

/** Reads the fixed six-role map beside mac-local.json. Every role is checked
 * by the existing one-authority-database validator before any pool can open. */
export async function loadMacLocalDatabaseRolesFromRootV1(protectedRoot: string,
  runtime: Runtime = production): Promise<MacLocalDatabaseRolesV1> {
  try { return captureMacLocalDatabaseRolesV1(await readProtectedDatabaseRolesFileV1(protectedRoot, runtime), { installRoot: dirname(protectedRoot) }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.message === "mac_local_database_roles_root_invalid") throw error;
    throw new Error("mac_local_database_roles_invalid");
  }
}

/**
 * Reads ONLY the `web` login out of the same protected record, under the same
 * no-follow/mode/size/directory checks, validated by the same one-authority
 * configuration validator.
 *
 * Why this exists: the full-map loader requires the six-role record a
 * COMPLETED install writes. An install that has not yet run `--finish` carries
 * only the four always-present logins, so anything that runs BEFORE the
 * database handoff — `mac:upgrade`'s own ledger-head read — could not read the
 * record it was about to upgrade. That made `pnpm mac:upgrade` refuse on
 * exactly the installs it exists for, with an unrecognised
 * `mac_local_database_roles_root_invalid` that the CLI collapsed to the opaque
 * `upgrade_failed`. This reader is narrower rather than laxer: it accepts a
 * record with fewer logins, but still reads it as a protected file, still
 * validates the one database, and still cannot invent a username.
 */
export async function loadMacLocalWebRoleFromRootV1(protectedRoot: string,
  runtime: Runtime = production): Promise<PrivatePostgresConfiguration> {
  const record = await readProtectedDatabaseRolesFileV1(protectedRoot, runtime);
  try {
    if (record.schema !== MAC_LOCAL_DATABASE_ROLES_V1 || !record.web || typeof record.web !== "object"
      || Array.isArray(record.web)) throw new Error();
    return validatePrivatePostgresConfiguration(record.web as PrivatePostgresConfiguration, { installRoot: dirname(protectedRoot) });
  } catch { throw new Error("mac_local_database_roles_invalid"); }
}

/** Optional installed child of the existing Mac-local host. A missing record
 * keeps intake disabled; an unsafe or malformed record fails closed. */
export async function loadWorkIntakeServerConfigurationFromRootV1(protectedRoot: string,
  runtime: Runtime = production): Promise<WorkIntakeServerConfigurationV1 | undefined> {
  if (!isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot)
    throw new Error("work_intake_installed_configuration_root_invalid");
  const configRoot = join(protectedRoot, "config"), path = join(configRoot, "work-intake-server.json");
  try {
    const owner = await protectedDirectories(protectedRoot, runtime);
    let entry;
    try { entry = await runtime.lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > 64 * 1024) throw new Error();
    const bytes = await runtime.readFile(path, "utf8", entry);
    if (Buffer.byteLength(bytes) > 64 * 1024 || !sameFileV1(entry, await runtime.lstat(path))) throw new Error();
    await owner.check();
    return captureWorkIntakeServerConfigurationV1(parseStrictJsonV1(bytes), { installRoot: dirname(protectedRoot) });
  } catch { throw new Error("work_intake_installed_configuration_root_invalid"); }
}

/** Optional owner-only VAPID credentials. Missing keeps phone push off; malformed fails closed. */
export async function loadOwnerWebPushConfigFromRootV1(protectedRoot: string,
  runtime: Runtime = production): Promise<OwnerWebPushConfigV1 | undefined> {
  if (!isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot) throw new Error("owner_web_push_config_root_invalid");
  const configRoot = join(protectedRoot, "config"), path = join(configRoot, "owner-web-push.json");
  try {
    const owner = await protectedDirectories(protectedRoot, runtime);
    let entry; try { entry = await runtime.lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > 4096) throw new Error();
    const bytes = await runtime.readFile(path, "utf8", entry);
    if (Buffer.byteLength(bytes) > 4096 || !sameFileV1(entry, await runtime.lstat(path))) throw new Error();
    await owner.check();
    return captureOwnerWebPushConfigV1(parseStrictJsonV1(bytes));
  } catch { throw new Error("owner_web_push_config_invalid"); }
}

// The installer validates output with these same release-owned parsers.
export { captureMacLocalProtectedConfigurationV1, captureMacLocalDatabaseRolesV1 };
