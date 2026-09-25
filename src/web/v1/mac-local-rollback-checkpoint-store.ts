import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parseRollbackCheckpointV1, rollbackCheckpointDigestV1, type AwaitableRollbackCheckpointStoreV1,
  type RollbackCheckpointV1 } from "../../security/rollback-checkpoint";

export const MAC_LOCAL_ROLLBACK_CHECKPOINTS_V1 = "control-room.mac-local-rollback-checkpoints/v1" as const;

const conflict = (): never => { throw new Error("mac_local_rollback_checkpoint_conflict"); };
const unavailable = (): never => { throw new Error("mac_local_rollback_checkpoint_unavailable"); };
const scopePattern = /^[A-Za-z0-9:._-]{3,240}$/u;
const MAX_FILE_BYTES = 256 * 1024;

type Runtime = Readonly<{ pid: number; alive(pid: number): boolean }>;
const production: Runtime = Object.freeze({ pid: process.pid, alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException)?.code === "EPERM"; }
} });

export type MacLocalRollbackCheckpointStoreV1 = AwaitableRollbackCheckpointStoreV1 & Readonly<{ close(): Promise<void> }>;

async function privateEntry(path: string, kind: "directory" | "file") {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || (kind === "directory" ? !entry.isDirectory() : !entry.isFile())
    || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.()) unavailable();
  return entry;
}

/**
 * The rollback checkpoint for the mac-local task host, kept in a protected file
 * on the Mac, outside the VPS PostgreSQL it protects
 * (docs/claude/MAC_LOCAL_TASK_RUNTIME_TRUST_DECISION.md section 5). Initialize
 * succeeds only for an absent scope at revision 1, advance is a compare-and-swap,
 * every write is fsynced and renamed into place before it returns, and one
 * process at a time holds the store through an exclusive lock file.
 */
export async function openMacLocalRollbackCheckpointStoreV1(protectedRoot: string,
  runtime: Runtime = production): Promise<MacLocalRollbackCheckpointStoreV1> {
  if (typeof protectedRoot !== "string" || !isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot) unavailable();
  const directory = join(protectedRoot, "state"), file = join(directory, "rollback-checkpoints.json");
  const lock = join(directory, "rollback-checkpoints.lock");
  await privateEntry(protectedRoot, "directory").catch(unavailable);
  await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") unavailable(); });
  await privateEntry(directory, "directory").catch(unavailable);
  await acquire(lock, runtime);

  let closed = false, queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(() => { if (closed) unavailable(); return work(); });
    queue = next.catch(() => {});
    return next;
  };

  async function load(): Promise<Record<string, RollbackCheckpointV1>> {
    try { await privateEntry(file, "file"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
      return unavailable();
    }
    try {
      if ((await privateEntry(file, "file")).size > MAX_FILE_BYTES) unavailable();
      const text = await readFile(file, "utf8");
      const value = JSON.parse(text) as Record<string, unknown>;
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2
        || value.schema !== MAC_LOCAL_ROLLBACK_CHECKPOINTS_V1 || !value.checkpoints || typeof value.checkpoints !== "object"
        || Array.isArray(value.checkpoints)) unavailable();
      const out: Record<string, RollbackCheckpointV1> = {};
      for (const [scope, item] of Object.entries(value.checkpoints as Record<string, unknown>)) {
        const checkpoint = parseRollbackCheckpointV1(item);
        if (!scopePattern.test(scope) || checkpoint.scope !== scope) unavailable();
        out[scope] = checkpoint;
      }
      return out;
    } catch { return unavailable(); }
  }

  async function save(checkpoints: Record<string, RollbackCheckpointV1>) {
    const temporary = `${file}.new-${runtime.pid}-${randomBytes(8).toString("hex")}`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ schema: MAC_LOCAL_ROLLBACK_CHECKPOINTS_V1, checkpoints })}\n`, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, file);
      const dir = await open(directory, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } catch {
      await unlink(temporary).catch(() => {});
      unavailable();
    }
  }

  const scoped = (scope: unknown) => { if (typeof scope !== "string" || !scopePattern.test(scope)) unavailable(); return scope as string; };
  const aborted = (signal?: AbortSignal) => { if (signal?.aborted) unavailable(); };

  return Object.freeze({
    read: (scope: string, signal?: AbortSignal) => serial(async () => {
      aborted(signal);
      const value = (await load())[scoped(scope)];
      return value ? structuredClone(value) : undefined;
    }),
    initialize: (value: RollbackCheckpointV1, signal?: AbortSignal) => serial(async () => {
      aborted(signal);
      const next = parseRollbackCheckpointV1(value), all = await load();
      if (Object.hasOwn(all, scoped(next.scope)) || next.revision !== 1) conflict();
      aborted(signal);
      await save({ ...all, [next.scope]: next });
    }),
    advance: (expected: string, value: RollbackCheckpointV1, signal?: AbortSignal) => serial(async () => {
      aborted(signal);
      const next = parseRollbackCheckpointV1(value), all = await load(), current = all[scoped(next.scope)];
      if (!current || rollbackCheckpointDigestV1(current) !== expected || next.revision !== current.revision + 1) conflict();
      aborted(signal);
      await save({ ...all, [next.scope]: next });
    }),
    close: () => serial(async () => { closed = true; await release(lock, runtime); }),
  });
}

/** One live holder at a time. A lock left by a dead process (a crash that launchd
 * restarts) is taken over; a live holder, including a second host, is refused.
 * The takeover itself is exclusive (a `.takeover` file created with `wx`), and the
 * lock is only removed if it is still the same file whose holder was found dead,
 * so two processes starting together can never both end up holding it. A crash
 * that leaves a takeover file or an empty lock behind fails closed; the operator
 * removes it after confirming no host is running. */
async function acquire(lock: string, runtime: Runtime) {
  const create = async () => {
    const handle = await open(lock, "wx", 0o600);
    try { await handle.writeFile(`${runtime.pid}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  };
  try { await create(); return; }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") unavailable(); }
  const takeover = `${lock}.takeover`;
  const guard = await open(takeover, "wx", 0o600).catch(unavailable);
  try {
    const before = await privateEntry(lock, "file").catch(unavailable);
    const holder = Number((await readFile(lock, "utf8").catch(unavailable)).trim());
    if (!Number.isSafeInteger(holder) || holder < 1 || holder === runtime.pid || runtime.alive(holder)) unavailable();
    const after = await privateEntry(lock, "file").catch(unavailable);
    if (after.ino !== before.ino || after.dev !== before.dev) unavailable();
    await unlink(lock).catch(unavailable);
    await create().catch(unavailable);
  } finally {
    await guard.close().catch(() => {});
    await unlink(takeover).catch(() => {});
  }
}

async function release(lock: string, runtime: Runtime) {
  try { if (Number((await readFile(lock, "utf8")).trim()) === runtime.pid) await unlink(lock); } catch {}
}
