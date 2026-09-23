import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { OwnerBootstrapLifecycleStoreV1 } from ".";

const CLAIMED = "claimed\n";
const COMPLETE = "complete\n";
const noFollow = constants.O_NOFOLLOW ?? 0;

type FilesystemOwnerBootstrapLifecycleConfigurationV1 = Readonly<{
  runtimeDirectory: string;
  markerPath: string;
  ownerUid: number;
}>;

const unavailable = (): never => { throw new Error("owner_bootstrap_lifecycle_unavailable"); };

function capture(input: unknown): FilesystemOwnerBootstrapLifecycleConfigurationV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) return unavailable();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "markerPath,ownerUid,runtimeDirectory"
    || typeof value.runtimeDirectory !== "string" || typeof value.markerPath !== "string"
    || !Number.isSafeInteger(value.ownerUid) || (value.ownerUid as number) < 0
    || !isAbsolute(value.runtimeDirectory) || !isAbsolute(value.markerPath)
    || resolve(value.runtimeDirectory) !== value.runtimeDirectory || resolve(value.markerPath) !== value.markerPath
    || basename(value.markerPath) !== "owner-bootstrap.lifecycle") return unavailable();
  const inside = relative(value.runtimeDirectory, value.markerPath);
  if (inside !== "owner-bootstrap.lifecycle") return unavailable();
  return Object.freeze({ runtimeDirectory: value.runtimeDirectory, markerPath: value.markerPath, ownerUid: value.ownerUid as number });
}

/** A narrow durable record for the first-owner ceremony. Construction is inert.
 * The runtime directory must already have been created and privately owned by
 * the separately reviewed supervisor; this class never creates it. Any IO or
 * shape uncertainty fails closed, leaving an existing marker intact. */
export function createFilesystemOwnerBootstrapLifecycleStoreV1(input: unknown): OwnerBootstrapLifecycleStoreV1 {
  const config = capture(input);
  const assertDirectory = async () => {
    const [stat, canonical] = await Promise.all([lstat(config.runtimeDirectory), realpath(config.runtimeDirectory)]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== config.runtimeDirectory
      || stat.uid !== config.ownerUid || (stat.mode & 0o077) !== 0) unavailable();
  };
  const inspectMarker = async (): Promise<"available" | "claimed" | "complete"> => {
    await assertDirectory();
    let stat;
    try { stat = await lstat(config.markerPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "available"; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== config.ownerUid || stat.nlink !== 1
      || (stat.mode & 0o077) !== 0 || await realpath(config.markerPath) !== config.markerPath) unavailable();
    const bytes = await readFile(config.markerPath, "utf8");
    if (bytes === CLAIMED) return "claimed";
    if (bytes === COMPLETE) return "complete";
    return unavailable();
  };
  const syncDirectory = async () => {
    const handle = await open(config.runtimeDirectory, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  return Object.freeze({
    inspect: inspectMarker,
    async claim(signal: AbortSignal) {
      if (signal.aborted || await inspectMarker() !== "available") unavailable();
      let handle;
      try {
        handle = await open(config.markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
        if (signal.aborted) unavailable();
        await handle.writeFile(CLAIMED, "utf8");
        await handle.sync();
      } catch { unavailable(); }
      finally { try { await handle?.close(); } catch { unavailable(); } }
      if (signal.aborted) unavailable();
      try { await syncDirectory(); } catch { unavailable(); }
      if (signal.aborted || await inspectMarker() !== "claimed") unavailable();
    },
    async complete(signal: AbortSignal) {
      if (signal.aborted || await inspectMarker() !== "claimed") unavailable();
      let handle;
      try {
        handle = await open(config.markerPath, constants.O_WRONLY | noFollow);
        if (signal.aborted) unavailable();
        await handle.truncate(0);
        await handle.writeFile(COMPLETE, "utf8");
        await handle.sync();
      } catch { unavailable(); }
      finally { try { await handle?.close(); } catch { unavailable(); } }
      if (signal.aborted) unavailable();
      try { await syncDirectory(); } catch { unavailable(); }
      if (signal.aborted || await inspectMarker() !== "complete") unavailable();
    },
  });
}
