import { randomBytes } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { captureMacLocalTaskRunLimitsV1, DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1,
  type MacLocalTaskRunLimitsV1 } from "../../harness/v1/owner-trusted-local-run-limits";

const unavailable = (): never => { throw new Error("mac_local_task_run_limits_unavailable"); };
const MAX_FILE_BYTES = 4 * 1024;

function paths(protectedRoot: string) {
  if (typeof protectedRoot !== "string" || !isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot) unavailable();
  return { directory: join(protectedRoot, "config"), file: join(protectedRoot, "config", "task-run-limits.json") };
}

async function privateEntry(path: string, kind: "directory" | "file") {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || (kind === "directory" ? !entry.isDirectory() : !entry.isFile())
    || kind === "file" && entry.nlink !== 1
    || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.()) unavailable();
  return entry;
}

async function requirePrivateDirectories(protectedRoot: string, directory: string) {
  await privateEntry(protectedRoot, "directory");
  await privateEntry(directory, "directory");
}

async function loadExisting(file: string): Promise<MacLocalTaskRunLimitsV1 | undefined> {
  let entry;
  try { entry = await privateEntry(file, "file"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    return unavailable();
  }
  if (entry.size > MAX_FILE_BYTES) unavailable();
  try { return captureMacLocalTaskRunLimitsV1(JSON.parse(await readFile(file, "utf8"))); }
  catch { return unavailable(); }
}

/** Loads the owner-controlled settings. An absent file uses safe defaults;
 * an existing invalid or non-private file fails closed. */
export async function loadMacLocalTaskRunLimitsFromRootV1(protectedRoot: string): Promise<MacLocalTaskRunLimitsV1> {
  const { directory, file } = paths(protectedRoot);
  try {
    await requirePrivateDirectories(protectedRoot, directory);
    return (await loadExisting(file)) ?? DEFAULT_MAC_LOCAL_TASK_RUN_LIMITS_V1;
  } catch { return unavailable(); }
}

/** Atomically replaces the owner-controlled settings after validating both
 * the requested value and any existing file. No setting value is logged. */
export async function writeMacLocalTaskRunLimitsToRootV1(protectedRoot: string,
  value: unknown): Promise<void> {
  const limits = captureMacLocalTaskRunLimitsV1(value);
  const { directory, file } = paths(protectedRoot);
  await requirePrivateDirectories(protectedRoot, directory).catch(unavailable);
  // A malformed or unsafe existing file is evidence to inspect, not something
  // this command may silently repair or replace.
  await loadExisting(file);
  const temporary = `${file}.new-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(limits)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, file);
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch {
    await unlink(temporary).catch(() => {});
    unavailable();
  }
}
