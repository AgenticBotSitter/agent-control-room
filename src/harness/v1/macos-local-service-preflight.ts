import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createMacosLocalServicePackageV1, type MacosLocalServicePackageV1 } from "./macos-local-service-package";

export type MacosLocalServicePreflightV1 = Readonly<{
  schema: "control-room.macos-local-service-preflight/v1";
  ready: true;
  package: MacosLocalServicePackageV1;
  startsWork: false;
}>;

const unavailable = (): never => { throw new Error("macos_local_service_preflight_refused"); };
const within = (child: string, parent: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const privateDirectory = async (path: string, ownerUid: number) => {
  const result = await lstat(path);
  if (!result.isDirectory() || result.isSymbolicLink() || result.uid !== ownerUid || (result.mode & 0o077) !== 0) unavailable();
};

const safeExistingLog = async (path: string, ownerUid: number) => {
  try {
    const result = await lstat(path);
    if (!result.isFile() || result.isSymbolicLink() || result.uid !== ownerUid || (result.mode & 0o077) !== 0) unavailable();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

/** Read-only verification of the files a separately authorized macOS
 * LaunchAgent would use. It creates no directory, service, listener, task, or
 * log file. All application-owned paths must already be canonical paths under
 * the selected release/protected roots. */
export async function preflightMacosLocalServiceV1(input: unknown): Promise<MacosLocalServicePreflightV1> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return unavailable();
  const value = input as Record<string, unknown>;
  const expected = ["configurationPath", "label", "launcherPath", "nodePath", "ownerUid", "protectedRoot",
    "releaseRoot", "standardErrorPath", "standardOutPath", "workingDirectory"].join(",");
  if (Object.keys(value).sort().join(",") !== expected
    || !Number.isSafeInteger(value.ownerUid) || (value.ownerUid as number) < 0
    || Object.entries(value).some(([key, item]) => key !== "ownerUid" && typeof item !== "string")) return unavailable();
  const paths = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "label" && key !== "ownerUid")) as Record<string, string>;
  if (typeof value.label !== "string" || Object.values(paths).some(path => !isAbsolute(path) || resolve(path) !== path)) return unavailable();
  let canonical: Record<string, string>;
  try { canonical = Object.fromEntries(await Promise.all(Object.entries(paths)
    .filter(([name]) => name !== "standardOutPath" && name !== "standardErrorPath")
    .map(async ([name, path]) => [name, await realpath(path)])));
    canonical.standardOutPath = paths.standardOutPath!; canonical.standardErrorPath = paths.standardErrorPath!;
    const [outDirectory, errorDirectory] = await Promise.all([realpath(dirname(paths.standardOutPath!)), realpath(dirname(paths.standardErrorPath!))]);
    if (outDirectory !== dirname(paths.standardOutPath!) || errorDirectory !== dirname(paths.standardErrorPath!)) unavailable();
  }
  catch { return unavailable(); }
  if (Object.entries(paths).filter(([name]) => name !== "standardOutPath" && name !== "standardErrorPath")
    .some(([name, path]) => canonical[name] !== path)) return unavailable();
  const stat = async (name: string) => {
    const result = await lstat(canonical[name]!);
    if (result.isSymbolicLink()) unavailable();
    return result;
  };
  try {
    const [release, protectedRoot, node, launcher, configuration, working] = await Promise.all([
      stat("releaseRoot"), stat("protectedRoot"), stat("nodePath"), stat("launcherPath"), stat("configurationPath"),
      stat("workingDirectory"),
    ]);
    if (!release.isDirectory() || !protectedRoot.isDirectory() || !working.isDirectory()
      || !node.isFile() || !launcher.isFile() || !configuration.isFile()
      || release.uid !== value.ownerUid || protectedRoot.uid !== value.ownerUid || working.uid !== value.ownerUid
      || launcher.uid !== value.ownerUid || configuration.uid !== value.ownerUid
      || (release.mode & 0o077) !== 0 || (protectedRoot.mode & 0o077) !== 0 || (working.mode & 0o077) !== 0
      || (launcher.mode & 0o022) !== 0 || (configuration.mode & 0o077) !== 0
      || !within(canonical.launcherPath!, canonical.releaseRoot!) || !within(canonical.workingDirectory!, canonical.releaseRoot!)
      || !within(canonical.configurationPath!, canonical.protectedRoot!)
      || !within(canonical.standardOutPath!, canonical.protectedRoot!) || !within(canonical.standardErrorPath!, canonical.protectedRoot!)) unavailable();
    await Promise.all([
      privateDirectory(dirname(canonical.standardOutPath!), value.ownerUid as number),
      privateDirectory(dirname(canonical.standardErrorPath!), value.ownerUid as number),
      safeExistingLog(canonical.standardOutPath!, value.ownerUid as number),
      safeExistingLog(canonical.standardErrorPath!, value.ownerUid as number),
    ]);
  } catch { return unavailable(); }
  const package_ = createMacosLocalServicePackageV1({ label: value.label, nodePath: canonical.nodePath,
    launcherPath: canonical.launcherPath, configurationPath: canonical.configurationPath,
    workingDirectory: canonical.workingDirectory, standardOutPath: canonical.standardOutPath,
    standardErrorPath: canonical.standardErrorPath });
  return Object.freeze({ schema: "control-room.macos-local-service-preflight/v1", ready: true,
    package: package_, startsWork: false });
}
