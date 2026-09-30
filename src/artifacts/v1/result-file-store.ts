import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
// The content digest is over the BYTES, never over a JSON encoding of them.
// `sha256Digest` from the security module digests a canonical JSON value, which
// is the right tool for a record and the wrong one here: it would make the
// catalog's `sha256(convert_to(...))` disagree with the store's, and the two
// must agree exactly or a file is visible and undownloadable.
const bytesDigest = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * The result-file byte store: the sibling of `PersistentLocalArtifactStorageV1`
 * that holds the files a job produced, on the Mac, beside the existing 64 KiB
 * native text path (which it never touches).
 *
 * What makes it safe to hand to a worker in the next part:
 *
 *   * The storage key is DERIVED from the tenant, the project, the file's own id
 *     and its content digest. No caller supplies a key, a name or a path, and
 *     `resultFileStorageKeyV1` is the identical derivation the 0206 insert
 *     trigger performs, so the catalog and the store agree on exactly one name
 *     per file. Because the project is inside the digest, two projects holding
 *     identical bytes get two different keys and two different files: there is
 *     no cross-project dedupe, and therefore no "do you already have it" answer
 *     to probe.
 *   * On disk the key is a flat name under one root — no directory tree, so
 *     there is no path segment for a caller to influence and no traversal is
 *     expressible. The root must be canonical and mode 0700, and its device and
 *     inode are re-checked on every operation, so replacing it with a symlink
 *     mid-run fails closed.
 *   * Create-once. A second write of the same key with the same bytes replays,
 *     so an exact retry is idempotent; the same key with different bytes is a
 *     conflict, never an overwrite.
 *   * No symlinks and no hard links: every entry is opened `O_NOFOLLOW` and must
 *     be a regular file with link count 1, so a substituted payload cannot be
 *     substituted past the digest check.
 *   * Reads re-verify the digest of what came back, so a truncated or swapped
 *     file is a refusal, not a download.
 *
 * Every refusal is a `ResultFileStoreError` with a fixed code. These codes reach
 * logs, so none of them carries a path, a display name or a digest.
 */
export type ResultFileStoreErrorCodeV1 =
  | "store_invalid"     // a caller passed something the store refuses to interpret
  | "store_missing"     // no file under that key
  | "store_conflict"    // the key exists and holds different bytes
  | "store_capacity"    // past a declared limit
  | "store_ambiguous";  // a read could not be proven exact

export class ResultFileStoreError extends Error {
  constructor(readonly code: ResultFileStoreErrorCodeV1) {
    super(`result_file_store_${code}`);
    this.name = "ResultFileStoreError";
  }
}

export interface ResultFileStoreConfigurationV1 {
  /** An existing, canonical, private directory. The store never creates it. */
  rootPath: string;
  /** The installation's declared ceilings. They are configuration, not policy. */
  maximumFiles: number;
  maximumFileBytes: number;
  maximumSetBytes: number;
  maximumTotalBytes: number;
  operationTimeoutMs: number;
}

export interface ResultFileIdentityV1 {
  tenantId: string;
  projectId: string;
  fileId: string;
  contentDigest: string;
}

export interface ResultFileStoreWriteV1 extends ResultFileIdentityV1 {
  bytes: Uint8Array;
  /** What the set already holds, for the per-set ceiling. Omitted means "unknown". */
  setBytes?: number;
  setFiles?: number;
  signal?: AbortSignal;
}

export interface ResultFileStoreReadV1 extends ResultFileIdentityV1 {
  signal?: AbortSignal;
}

export interface ResultFileStoredV1 {
  storageKey: string;
  contentDigest: string;
  sizeBytes: number;
}

/** The v1 defaults from plan §2.6. A configuration may go lower; never higher. */
export const RESULT_FILE_LIMITS_V1 = Object.freeze({
  maximumFilesPerSet: 32,
  maximumFileBytes: 268_435_456,
  maximumSetBytes: 536_870_912,
  maximumTotalBytes: 10_737_418_240,
});

const projectPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;
const tenantPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;
const fileIdPattern = /^result-file:[a-f0-9]{32}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const onDiskPattern = /^[a-f0-9]{64}\.crbf$/u;
const keyPrefix = "crbf1-";
const lockName = ".control-room-result-file-store.lock";
const pendingPrefix = ".control-room-result-file-store-pending-";
const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlock = constants.O_NONBLOCK ?? 0;

class DeadlineError extends Error {}

/**
 * The one derivation of a result file's storage key.
 *
 * Deliberately identical, byte for byte, to the expression in 0206's
 * `guard_result_file_insert`. The two must not drift: the database writes the
 * catalog row and this names the file, and a disagreement would be a file the
 * owner can see and cannot download. `tests/result-file-catalog-postgres.test.ts`
 * proves the two agree against a real cluster, by reading the key the database
 * itself wrote.
 */
export function resultFileStorageKeyV1(tenantId: string, projectId: string, fileId: string,
  contentDigest: string): string {
  if (!tenantPattern.test(tenantId) || !projectPattern.test(projectId) || !fileIdPattern.test(fileId)
    || !digestPattern.test(contentDigest)) throw new ResultFileStoreError("store_invalid");
  return `${keyPrefix}${createHash("sha256")
    .update(`control-room.result-file-store/v1:${tenantId}:${projectId}:${fileId}:${contentDigest}`, "utf8")
    .digest("hex")}`;
}

/** The on-disk name. The key's own hex, so the key is never parsed back. */
const onDiskName = (storageKey: string): string => `${storageKey.slice(keyPrefix.length)}.crbf`;

function abortError(): Error {
  const error = new Error("result_file_store_aborted");
  error.name = "AbortError";
  return error;
}

function validPrivateMode(mode: bigint): boolean {
  return process.platform === "win32" || (Number(mode) & 0o077) === 0;
}

interface RootIdentity { device: bigint; inode: bigint }

function safe(error: unknown): ResultFileStoreError {
  return error instanceof ResultFileStoreError ? error : new ResultFileStoreError("store_ambiguous");
}

/** A whole-operation context. One deadline for the operation, not per call. */
interface Operation { deadline: number; signal?: AbortSignal }

/**
 * Runs one filesystem call under the operation's deadline, and marks the
 * operation uncertain if the call was interrupted after a mutation started.
 *
 * A promise that loses the race is abandoned, not awaited: the point of the
 * deadline is that a wedged disk fails closed instead of hanging a request. The
 * abandoned call is caught so it cannot surface as an unhandled rejection.
 */
async function bounded<T>(operation: Operation, begin: () => Promise<T>,
  afterMutation: () => void): Promise<T> {
  if (operation.signal?.aborted) { afterMutation(); throw abortError(); }
  if (Date.now() >= operation.deadline) { afterMutation(); throw new DeadlineError(); }
  const running = Promise.resolve().then(begin);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError()), Math.max(0, operation.deadline - Date.now()));
    if (operation.signal) {
      onAbort = () => reject(abortError());
      operation.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([running, stopped]);
  } catch (error) {
    if (error instanceof DeadlineError || error instanceof Error && error.name === "AbortError") afterMutation();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (operation.signal && onAbort) operation.signal.removeEventListener("abort", onAbort);
    void running.catch(() => {});
  }
}

export class ResultFileStoreV1 {
  /** Serialises writes, so two publishers cannot race the create-once lock. */
  private queue: Promise<void> = Promise.resolve();
  /** Set once an operation's outcome became unprovable. Refuses everything after. */
  private poisoned = false;

  private constructor(
    private readonly root: string,
    private readonly identity: RootIdentity,
    private readonly configuration: Readonly<ResultFileStoreConfigurationV1>,
  ) {}

  /** Opens one already-existing private root. It creates nothing and repairs nothing. */
  static async create(configuration: ResultFileStoreConfigurationV1): Promise<ResultFileStoreV1> {
    if (!configuration || typeof configuration !== "object" || typeof configuration.rootPath !== "string"
      || configuration.rootPath.length > 4096 || !isAbsolute(configuration.rootPath)
      || resolve(configuration.rootPath) !== configuration.rootPath
      || !Number.isSafeInteger(configuration.maximumFiles) || configuration.maximumFiles < 1
 // The per-set file ceiling is a v1 limit (32), not a free parameter: a
 // configuration may go lower, never higher, exactly as for the byte
 // ceilings below.
 || configuration.maximumFiles > RESULT_FILE_LIMITS_V1.maximumFilesPerSet
      || !Number.isSafeInteger(configuration.maximumFileBytes) || configuration.maximumFileBytes < 1
      || configuration.maximumFileBytes > RESULT_FILE_LIMITS_V1.maximumFileBytes
      || !Number.isSafeInteger(configuration.maximumSetBytes) || configuration.maximumSetBytes < 1
      || configuration.maximumSetBytes > RESULT_FILE_LIMITS_V1.maximumSetBytes
      || !Number.isSafeInteger(configuration.maximumTotalBytes) || configuration.maximumTotalBytes < 1
 // The installation quota is a v1 limit too (10 GiB). A configuration may
 // go lower so an operator can shrink it, never higher.
 || configuration.maximumTotalBytes > RESULT_FILE_LIMITS_V1.maximumTotalBytes
      || !Number.isSafeInteger(configuration.operationTimeoutMs) || configuration.operationTimeoutMs < 1
      || configuration.operationTimeoutMs > 30_000) throw new ResultFileStoreError("store_invalid");
    const operation: Operation = { deadline: Date.now() + configuration.operationTimeoutMs };
    let canonical: string;
    let stats: BigIntStats;
    try {
      const [resolved, listed] = await Promise.all([
        bounded(operation, () => realpath(configuration.rootPath), () => {}),
        bounded(operation, () => lstat(configuration.rootPath, { bigint: true }), () => {}),
      ]);
      canonical = resolved; stats = listed;
    } catch (error) {
      if (error instanceof DeadlineError) throw error;
      throw new ResultFileStoreError("store_invalid");
    }
    if (canonical !== configuration.rootPath || !stats.isDirectory() || stats.isSymbolicLink()
      || !validPrivateMode(stats.mode)) throw new ResultFileStoreError("store_invalid");
    const store = new ResultFileStoreV1(canonical, { device: stats.dev, inode: stats.ino },
      Object.freeze({ ...configuration }));
    const opened: Operation = { deadline: Date.now() + configuration.operationTimeoutMs };
    await store.assertRootIdentity(opened);
    await store.inventory(opened);
    return store;
  }

  private usable(operation: Operation): void {
    if (operation.signal?.aborted) { this.poisoned = true; throw abortError(); }
    if (this.poisoned || Date.now() >= operation.deadline) { this.poisoned = true; throw new DeadlineError(); }
  }

  async put(input: ResultFileStoreWriteV1): Promise<ResultFileStoredV1> {
    if (!(input.bytes instanceof Uint8Array)) throw new ResultFileStoreError("store_invalid");
    const bytes = Uint8Array.from(input.bytes);
    const key = resultFileStorageKeyV1(input.tenantId, input.projectId, input.fileId, input.contentDigest);
    if (bytesDigest(bytes) !== input.contentDigest) throw new ResultFileStoreError("store_invalid");
    if (bytes.byteLength > this.configuration.maximumFileBytes) throw new ResultFileStoreError("store_capacity");
    if (input.setBytes !== undefined || input.setFiles !== undefined) {
      if (!Number.isSafeInteger(input.setBytes ?? 0) || !Number.isSafeInteger(input.setFiles ?? 0)
        || (input.setBytes ?? 0) < 0 || (input.setFiles ?? 0) < 0)
        throw new ResultFileStoreError("store_invalid");
      if ((input.setBytes ?? 0) + bytes.byteLength > this.configuration.maximumSetBytes
        || (input.setFiles ?? 0) + 1 > this.configuration.maximumFiles)
        throw new ResultFileStoreError("store_capacity");
    }
    const run = this.queue.then(() => this.writeExclusive(input, bytes, key),
      () => this.writeExclusive(input, bytes, key));
    this.queue = run.then(() => undefined, () => undefined);
    return run.then(() => Object.freeze({ storageKey: key, contentDigest: input.contentDigest,
      sizeBytes: bytes.byteLength }));
  }

  async read(input: ResultFileStoreReadV1): Promise<Uint8Array | undefined> {
    const key = resultFileStorageKeyV1(input.tenantId, input.projectId, input.fileId, input.contentDigest);
    const operation: Operation = { deadline: Date.now() + this.configuration.operationTimeoutMs,
      ...(input.signal ? { signal: input.signal } : {}) };
    try {
      this.usable(operation);
      await this.assertRootIdentity(operation);
      // The whole directory is accounted for before any byte is served, not just
      // the one file being read. A store that read its own path and ignored what
      // else was in the directory could not tell "this file is missing" from
      // "something else replaced this store's contents", and would serve the
      // first as an empty result. An entry the store cannot account for is a
      // refusal — and never a deletion, because the store cleans up nothing.
      await this.assertDirectoryIsAccountedFor(operation);
      const bytes = await this.readRecord(join(this.root, onDiskName(key)), operation, true);
      if (!bytes) return undefined;
      // The digest is re-proved on every read. A store that returned bytes it
      // had not just checked would be serving whatever is on disk today.
      if (bytes.byteLength > this.configuration.maximumFileBytes
        || bytesDigest(bytes) !== input.contentDigest) throw new ResultFileStoreError("store_ambiguous");
      await this.assertRootIdentity(operation);
      this.usable(operation);
      return bytes;
    } catch (error) {
      if (error instanceof DeadlineError) this.poisoned = true;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw safe(error);
    }
  }

  private async writeExclusive(input: ResultFileStoreWriteV1, bytes: Uint8Array, key: string) {
    const operation: Operation = { deadline: Date.now() + this.configuration.operationTimeoutMs,
      ...(input.signal ? { signal: input.signal } : {}) };
    const lockPath = join(this.root, lockName);
    const targetPath = join(this.root, onDiskName(key));
    const name = onDiskName(key);
    let lock: FileHandle | undefined;
    let ownedLock = false;
    let pendingPath: string | undefined;
    let mutationStarted = false;
    let uncertain = false;
    // The refusal, if this operation ended in one. It is re-thrown after the
    // lock is retired, so a caller is told the write did not happen and not
    // merely that the store is in some state.
    let refusal: ResultFileStoreError | undefined;
    const mutating = () => { if (mutationStarted) uncertain = true; };
    try {
      this.usable(operation);
      await this.assertRootIdentity(operation);
      // The lock is created O_EXCL, so a second writer cannot proceed. A
      // surviving lock from a crashed writer is never repaired here: the next
      // operation fails closed and the owner sees an error, which is the honest
      // outcome for a store whose state is unknown.
      lock = await bounded(operation,
        () => open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600),
        mutating);
      ownedLock = true;
      mutationStarted = true;
      await bounded(operation, async () => { await lock!.writeFile("control-room-result-file-store-write\n", "utf8"); }, mutating);
      await bounded(operation, () => lock!.sync(), mutating);
      const inventory = await this.inventory(operation, true);
      if (inventory.names.has(name)) {
        // Create-once with an exact replay: the same bytes are a retry, and
        // anything else is a conflict rather than an overwrite.
        //
        // Both sides are compared to the NAME, not only to each other. The name
        // is a digest, so a file whose bytes no longer hash to it is not a
        // replay of anything: it is a tampered or mis-restored file, and
        // overwriting it here would destroy the only evidence that it went wrong.
        const existing = await this.readRecord(targetPath, operation, false);
        if (!existing) throw new ResultFileStoreError("store_ambiguous");
        if (bytesDigest(existing) !== input.contentDigest
          || existing.byteLength !== bytes.byteLength || bytesDigest(bytes) !== bytesDigest(existing))
          throw new ResultFileStoreError("store_conflict");
      } else {
        if (inventory.count >= this.configuration.maximumFiles
          || inventory.totalBytes + bytes.byteLength > this.configuration.maximumTotalBytes)
          throw new ResultFileStoreError("store_capacity");
        pendingPath = join(this.root, `${pendingPrefix}${randomUUID()}`);
        const pending = await bounded(operation,
          () => open(pendingPath!, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600),
          mutating);
        try {
          await bounded(operation, async () => { await pending.writeFile(bytes); }, mutating);
          await bounded(operation, () => pending.sync(), mutating);
        } finally { await pending.close().catch(() => {}); }
        // link() is atomic and refuses to overwrite, so the file appears whole
        // or not at all; the directory sync is what makes it survive a crash.
        await bounded(operation, () => link(pendingPath!, targetPath), mutating);
        await this.syncRoot(operation);
        await this.discard(pendingPath, operation);
        pendingPath = undefined;
        await this.syncRoot(operation);
        const proven = await this.readRecord(targetPath, operation, false);
        if (!proven || bytesDigest(proven) !== input.contentDigest)
          throw new ResultFileStoreError("store_ambiguous");
      }
    } catch (error) {
      // A refusal must REACH THE CALLER. This block only decides whether the
      // store's own state is still knowable afterwards; it never converts a
      // refusal into a success. A `store_conflict` or `store_capacity` is a
      // definite answer — nothing was written — so the store stays usable and
      // the error is re-thrown below. Anything else after a mutation started
      // leaves the outcome unprovable, and the store poisons itself.
      if (error instanceof DeadlineError) this.poisoned = true;
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof ResultFileStoreError
        && (error.code === "store_conflict" || error.code === "store_capacity"
          || error.code === "store_invalid")) {
        uncertain = false;
        refusal = error;
      } else if (uncertain) this.poisoned = true;
      else throw error;
    } finally {
      try {
        if (!uncertain && pendingPath) { await this.discard(pendingPath, operation); pendingPath = undefined; }
        if (lock) await lock.close().catch(() => {});
        if (ownedLock && !uncertain) {
          await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
          ownedLock = false;
          await this.syncRoot(operation);
        }
      } catch { uncertain = true; this.poisoned = true; }
    }
    if (refusal) throw refusal;
    if (uncertain) throw new ResultFileStoreError("store_ambiguous");
  }

  private async discard(path: string, operation: Operation): Promise<void> {
    try { await bounded(operation, () => unlink(path), () => {}); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof DeadlineError)) throw error;
    }
  }

  private async inventory(operation: Operation, ownLock = false) {
    await this.assertRootIdentity(operation);
    const names = new Set<string>();
    let totalBytes = 0;
    const entries = await bounded(operation, () => readdir(this.root), () => {});
    for (const entry of entries) {
      if (entry === lockName && ownLock) continue;
      // Any entry this store did not write is a refusal, never a deletion: the
      // store never cleans up an unknown file it cannot account for.
      if (!onDiskPattern.test(entry)) throw new ResultFileStoreError("store_ambiguous");
      const bytes = await this.readRecord(join(this.root, entry), operation, false);
      if (!bytes) throw new ResultFileStoreError("store_ambiguous");
      names.add(entry);
      totalBytes += bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > this.configuration.maximumTotalBytes)
        throw new ResultFileStoreError("store_ambiguous");
    }
    await this.assertRootIdentity(operation);
    return { names, count: names.size, totalBytes };
  }

  /** One file, proven unchanged across the read, or a refusal. */
  private async readRecord(path: string, operation: Operation,
    missingAllowed: boolean): Promise<Uint8Array | undefined> {
    this.usable(operation);
    let listed: BigIntStats;
    try { listed = await bounded(operation, () => lstat(path, { bigint: true }), () => {}); }
    catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== BigInt(1)
      || listed.size > BigInt(this.configuration.maximumFileBytes) || !validPrivateMode(listed.mode))
      throw new ResultFileStoreError("store_ambiguous");
    const handle = await bounded(operation,
      () => open(path, constants.O_RDONLY | noFollow | nonBlock), () => {});
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== listed.dev || opened.ino !== listed.ino
        || opened.nlink !== BigInt(1) || opened.size !== listed.size || !validPrivateMode(opened.mode))
        throw new ResultFileStoreError("store_ambiguous");
      const allocation = new Uint8Array(Number(listed.size));
      let length = 0;
      while (length < allocation.byteLength) {
        const next = await bounded(operation,
          () => handle.read(allocation, length, allocation.byteLength - length, length), () => {});
        if (next.bytesRead === 0) break;
        length += next.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const current = await bounded(operation, () => lstat(path, { bigint: true }), () => {});
      if (length !== Number(listed.size) || after.size !== listed.size
        || after.mtimeNs !== listed.mtimeNs || after.ctimeNs !== listed.ctimeNs
        || after.dev !== listed.dev || after.ino !== listed.ino || after.nlink !== BigInt(1)
        || current.isSymbolicLink() || current.dev !== listed.dev || current.ino !== listed.ino
        || current.size !== listed.size || current.mtimeNs !== listed.mtimeNs
        || current.ctimeNs !== listed.ctimeNs) throw new ResultFileStoreError("store_ambiguous");
      return allocation;
    } finally { await handle.close().catch(() => {}); }
  }

  /** Every entry under the root is one this store could have written. Anything
   * else — a stray file, a directory, a name that is not a content digest — means
   * the directory's state is not what the catalog believes, so nothing is served
   * until that is resolved. The entries are listed, not read: this proves the
   * NAMES are ours, and the individual read still proves its own bytes. */
  private async assertDirectoryIsAccountedFor(operation: Operation): Promise<void> {
    const entries = await bounded(operation, () => readdir(this.root), () => {});
    for (const entry of entries) {
      if (entry === lockName) continue;
      if (!onDiskPattern.test(entry)) throw new ResultFileStoreError("store_ambiguous");
    }
  }

  private async assertRootIdentity(operation: Operation): Promise<void> {
    this.usable(operation);
    const [canonical, stats] = await Promise.all([
      bounded(operation, () => realpath(this.root), () => {}),
      bounded(operation, () => lstat(this.root, { bigint: true }), () => {}),
    ]);
    if (canonical !== this.root || !stats.isDirectory() || stats.isSymbolicLink()
      || stats.dev !== this.identity.device || stats.ino !== this.identity.inode
      || !validPrivateMode(stats.mode)) throw new ResultFileStoreError("store_ambiguous");
  }

  private async syncRoot(operation: Operation): Promise<void> {
    this.usable(operation);
    const directory = await bounded(operation, () => open(this.root, constants.O_RDONLY | noFollow), () => {});
    try { await bounded(operation, () => directory.sync(), () => {}); }
    finally { await directory.close().catch(() => {}); }
  }
}

export async function openResultFileStoreV1(
  configuration: ResultFileStoreConfigurationV1,
): Promise<ResultFileStoreV1> {
  return ResultFileStoreV1.create(configuration);
}
