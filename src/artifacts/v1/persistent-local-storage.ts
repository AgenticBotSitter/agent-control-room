import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  ArtifactStorageError,
  type ArtifactReadPortV1,
  type ArtifactStoragePortV1,
  type ArtifactStorageWriteV1,
  type StoredArtifactV1,
} from "../../node-executor/artifact-storage";
import { tryPersistentKernelLockV1 } from "../../installer/shared/persistent-kernel-lock.mjs";
import { checkedResultBytes, resultBytesHash } from "./native-results";

export interface PersistentLocalArtifactStorageConfigurationV1 {
  /** Existing, canonical, private directory. The adapter never creates it. */
  rootPath: string;
  maximumArtifacts: number;
  maximumFileBytes: number;
  maximumTotalBytes: number;
  /** Whole-operation deadline, including directory synchronization. Zero refuses before I/O. */
  operationTimeoutMs: number;
}

interface RootIdentity {
  device: bigint;
  inode: bigint;
}

interface OperationContext {
  readonly signal?: AbortSignal;
  readonly deadline: number;
  mutationStarted: boolean;
  uncertain: boolean;
}

interface ArtifactEnvelopeHeaderV1 {
  schema: "control-room.persistent-local-artifact/v1";
  artifactId: string;
  contentHash: string;
  sizeBytes: number;
}

interface StoredRecord {
  readonly header: ArtifactEnvelopeHeaderV1;
  readonly bytes: Uint8Array;
}

export type PersistentLocalArtifactStorageIoBoundaryV1 =
  | "root_realpath" | "root_stat" | "inventory_read" | "artifact_lstat" | "artifact_open"
  | "artifact_stat" | "artifact_read" | "artifact_recheck" | "artifact_close"
  | "lock_open" | "lock_write" | "lock_sync" | "pending_open" | "pending_write" | "pending_sync"
  | "pending_close" | "target_link" | "pending_unlink" | "lock_close" | "lock_unlink"
  | "kernel_stamp" | "kernel_sync"
  | "kernel_lock" | "lock_wait" | "recovery_stat" | "recovery_open" | "recovery_unlink"
  | "root_sync_open" | "root_sync" | "root_sync_close";

/** Test-only fault gate. The production factory never accepts an injected filesystem implementation. */
export interface PersistentLocalArtifactStorageTestIoV1 {
  run<T>(boundary: PersistentLocalArtifactStorageIoBoundaryV1, operation: () => Promise<T>): Promise<T>;
}

const artifactIdPattern = /^artifact:(native|result):[a-f0-9]{64}$/u;
const artifactNamePattern = /^[a-f0-9]{64}\.artifact$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const lockName = ".control-room-persistent-artifact.lock";
const pendingPrefix = ".control-room-persistent-artifact-pending-";
const kernelName = ".control-room-artifact-kernel.lock";
const writerSchema = "control-room.persistent-artifact-writer/v1";
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const headerLimitBytes = 512;
const resultLimitBytes = 65_536;
const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlock = constants.O_NONBLOCK ?? 0;

const retiringGuards = new Set<FileHandle>();

class DeadlineError extends Error {}

function abortError(): Error {
  const error = new Error("artifact_storage_aborted");
  error.name = "AbortError";
  return error;
}

function storageName(artifactId: string): string {
  return `${createHash("sha256").update(artifactId).digest("hex")}.artifact`;
}

function opaqueLocator(artifactId: string): string {
  return `control-room-artifact:v1:${storageName(artifactId).slice(0, -".artifact".length)}`;
}

function validateArtifactId(artifactId: string): void {
  if (!artifactIdPattern.test(artifactId)) throw new ArtifactStorageError("storage_invalid");
}

function validateConfiguration(input: PersistentLocalArtifactStorageConfigurationV1): void {
  if (!input || typeof input !== "object" || !isAbsolute(input.rootPath) || resolve(input.rootPath) !== input.rootPath
    || !Number.isSafeInteger(input.maximumArtifacts) || input.maximumArtifacts < 1
    || !Number.isSafeInteger(input.maximumFileBytes) || input.maximumFileBytes < 1
    || input.maximumFileBytes > resultLimitBytes
    || !Number.isSafeInteger(input.maximumTotalBytes) || input.maximumTotalBytes < 1
    || !Number.isSafeInteger(input.operationTimeoutMs) || input.operationTimeoutMs < 0
    || input.operationTimeoutMs > 30_000) {
    throw new ArtifactStorageError("storage_invalid");
  }
}

function safeStorageError(error: unknown): ArtifactStorageError {
  return error instanceof ArtifactStorageError ? error : new ArtifactStorageError("storage_ambiguous");
}

function validPrivateMode(mode: bigint): boolean {
  return process.platform === "win32" || (Number(mode) & 0o077) === 0;
}

function encodeEnvelope(artifactId: string, bytes: Uint8Array): Uint8Array {
  const header: ArtifactEnvelopeHeaderV1 = {
    schema: "control-room.persistent-local-artifact/v1",
    artifactId,
    contentHash: resultBytesHash(bytes),
    sizeBytes: bytes.byteLength,
  };
  const prefix = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  if (prefix.byteLength > headerLimitBytes) throw new ArtifactStorageError("storage_invalid");
  return Buffer.concat([prefix, bytes]);
}

function decodeEnvelope(value: Uint8Array, expectedArtifactId?: string): StoredRecord {
  const newline = value.indexOf(0x0a);
  if (newline < 1 || newline >= headerLimitBytes) throw new ArtifactStorageError("storage_ambiguous");
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value.slice(0, newline));
    if (Buffer.from(text, "utf8").compare(Buffer.from(value.slice(0, newline))) !== 0) throw new Error();
    parsed = JSON.parse(text);
  } catch {
    throw new ArtifactStorageError("storage_ambiguous");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ArtifactStorageError("storage_ambiguous");
  const keys = Object.keys(parsed).sort();
  if (keys.join(",") !== "artifactId,contentHash,schema,sizeBytes") throw new ArtifactStorageError("storage_ambiguous");
  const header = parsed as Partial<ArtifactEnvelopeHeaderV1>;
  if (header.schema !== "control-room.persistent-local-artifact/v1"
    || typeof header.artifactId !== "string" || !artifactIdPattern.test(header.artifactId)
    || expectedArtifactId !== undefined && header.artifactId !== expectedArtifactId
    || typeof header.contentHash !== "string" || !digestPattern.test(header.contentHash)
    || !Number.isSafeInteger(header.sizeBytes) || (header.sizeBytes as number) < 0
    || (header.sizeBytes as number) > resultLimitBytes) {
    throw new ArtifactStorageError("storage_ambiguous");
  }
  const bytes = value.slice(newline + 1);
  try {
    checkedResultBytes(bytes, { contentHash: header.contentHash, sizeBytes: header.sizeBytes as number });
  } catch {
    throw new ArtifactStorageError("storage_ambiguous");
  }
  return { header: header as ArtifactEnvelopeHeaderV1, bytes };
}

/**
 * Persistent, create-once native-result bytes rooted in one explicitly supplied private directory.
 * Kernel exclusion permits recovery of identified abandoned bookkeeping only.
 * Complete targets and unknown entries are preserved.
 */
export class PersistentLocalArtifactStorageV1 implements ArtifactStoragePortV1, ArtifactReadPortV1 {
  private queue: Promise<void> = Promise.resolve();
  private poisoned = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  private constructor(
    private readonly root: string,
    private readonly rootIdentity: RootIdentity,
    private readonly maximumArtifacts: number,
    private readonly maximumFileBytes: number,
    private readonly maximumTotalBytes: number,
    private readonly operationTimeoutMs: number,
    private readonly testIo?: PersistentLocalArtifactStorageTestIoV1,
  ) {}

  static async create(
    configuration: PersistentLocalArtifactStorageConfigurationV1,
  ): Promise<PersistentLocalArtifactStorageV1> {
    return this.createInternal(configuration);
  }

  static async createForTest(
    configuration: PersistentLocalArtifactStorageConfigurationV1,
    testIo: PersistentLocalArtifactStorageTestIoV1,
  ): Promise<PersistentLocalArtifactStorageV1> {
    if (!testIo || typeof testIo.run !== "function") throw new ArtifactStorageError("storage_invalid");
    return this.createInternal(configuration, testIo);
  }

  private static async createInternal(
    configuration: PersistentLocalArtifactStorageConfigurationV1,
    testIo?: PersistentLocalArtifactStorageTestIoV1,
  ): Promise<PersistentLocalArtifactStorageV1> {
    validateConfiguration(configuration);
    const context: OperationContext = {
      deadline: Date.now() + configuration.operationTimeoutMs,
      mutationStarted: false,
      uncertain: false,
    };
    let canonical: string;
    let stats;
    try {
      const checked = await Promise.all([
        PersistentLocalArtifactStorageV1.initialIo(() => realpath(configuration.rootPath), context),
        PersistentLocalArtifactStorageV1.initialIo(() => lstat(configuration.rootPath, { bigint: true }), context),
      ]);
      canonical = checked[0];
      stats = checked[1];
    } catch (error) {
      throw safeStorageError(error);
    }
    if (canonical !== configuration.rootPath || !stats.isDirectory() || stats.isSymbolicLink()
      || !validPrivateMode(stats.mode)) throw new ArtifactStorageError("storage_invalid");
    const adapter = new PersistentLocalArtifactStorageV1(canonical, { device: stats.dev, inode: stats.ino },
      configuration.maximumArtifacts, configuration.maximumFileBytes, configuration.maximumTotalBytes,
      configuration.operationTimeoutMs, testIo);
    try {
      await adapter.assertRootIdentity(context);
      // An empty fresh root needs no recovery or mutation. Once a writer has
      // installed the permanent guard, every opener participates in exclusion.
      const entries = await adapter.io("inventory_read", () => readdir(canonical), context);
      let guard: FileHandle | undefined;
      try {
        if (entries.some(name => name === kernelName || name === lockName || name.startsWith(pendingPrefix))) {
          guard = await adapter.acquireGuard(context);
          await adapter.recover(context);
        }
        const inventory = await adapter.inventory(context);
        if (inventory.count > configuration.maximumArtifacts || inventory.totalBytes > configuration.maximumTotalBytes) {
          throw new ArtifactStorageError("storage_capacity");
        }
      } finally { if (guard) await adapter.retireGuard(guard); }
      return adapter;
    } catch (error) {
      throw safeStorageError(error);
    }
  }

  async put(input: ArtifactStorageWriteV1): Promise<StoredArtifactV1> {
    const { artifactId, bytes, signal } = input;
    this.assertUsable();
    signal?.throwIfAborted();
    validateArtifactId(artifactId);
    if (!(bytes instanceof Uint8Array)) throw new ArtifactStorageError("storage_invalid");
    const submitted = Uint8Array.from(bytes);
    if (submitted.byteLength > this.maximumFileBytes) throw new ArtifactStorageError("storage_capacity");
    try {
      checkedResultBytes(submitted, { contentHash: resultBytesHash(submitted), sizeBytes: submitted.byteLength });
    } catch {
      throw new ArtifactStorageError("storage_invalid");
    }
    const queuedAt = Date.now();
    const result = this.queue.then(
      () => this.putExclusive({ artifactId, bytes: submitted, signal }, queuedAt),
      () => this.putExclusive({ artifactId, bytes: submitted, signal }, queuedAt),
    );
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async read(artifactId: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    this.assertUsable();
    signal?.throwIfAborted();
    validateArtifactId(artifactId);
    const context = this.context(signal);
    try {
      await this.assertRootIdentity(context);
      const record = await this.readRecord(join(this.root, storageName(artifactId)), context, artifactId, true);
      if (!record) {
        await this.assertRootIdentity(context);
        return undefined;
      }
      if (record.bytes.byteLength > this.maximumFileBytes) throw new ArtifactStorageError("storage_ambiguous");
      await this.assertRootIdentity(context);
      this.checkpoint(context);
      return Uint8Array.from(record.bytes);
    } catch (error) {
      if (error instanceof DeadlineError) this.poisoned = true;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw safeStorageError(error);
    }
  }

  private async putExclusive(input: ArtifactStorageWriteV1, queuedAt: number): Promise<StoredArtifactV1> {
    this.assertUsable();
    const context = this.context(input.signal, queuedAt);
    this.checkpoint(context);
    await this.assertRootIdentity(context);
    const lockPath = join(this.root, lockName);
    let guard: FileHandle | undefined;
    const token = randomUUID();
    let lock: FileHandle | undefined;
    let ownedLock = false;
    let pending: FileHandle | undefined;
    let pendingPath: string | undefined;
    let result: StoredArtifactV1 | undefined;
    let operationError: unknown;
    let cleanupError: unknown;
    try {
      guard = await this.acquireGuard(context);
      await this.recover(context);
      await this.io("kernel_stamp", async () => { await guard!.truncate(0); await guard!.writeFile(JSON.stringify({ schema: writerSchema, pid: process.pid, token })); }, context);
      await this.io("kernel_sync", () => guard!.sync(), context);
      lock = await this.io("lock_open",
        () => open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600), context, true);
      ownedLock = true;
      context.mutationStarted = true;
      await this.io("lock_write", () => lock!.writeFile(`${JSON.stringify({ schema: writerSchema, pid: process.pid, token })}\n`, "utf8"), context);
      await this.io("lock_sync", () => lock!.sync(), context);
      const inventory = await this.inventory(context, true);
      const targetPath = join(this.root, storageName(input.artifactId));
      if (inventory.names.has(storageName(input.artifactId))) {
        result = await this.replay(input.artifactId, targetPath, input.bytes, context);
      } else {
        if (inventory.count >= this.maximumArtifacts
          || inventory.totalBytes + input.bytes.byteLength > this.maximumTotalBytes) {
          throw new ArtifactStorageError("storage_capacity");
        }
        pendingPath = join(this.root, `${pendingPrefix}${token}`);
        pending = await this.io("pending_open", () => open(pendingPath!,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600), context);
        const envelope = encodeEnvelope(input.artifactId, input.bytes);
        await this.io("pending_write", () => pending!.writeFile(envelope), context);
        await this.io("pending_sync", () => pending!.sync(), context);
        await this.io("pending_close", () => pending!.close(), context); pending = undefined;
        this.checkpoint(context);
        await this.io("target_link", () => link(pendingPath!, targetPath), context);
        await this.syncRoot(context);
        await this.io("pending_unlink", () => unlink(pendingPath!), context); pendingPath = undefined;
        await this.syncRoot(context);
        await this.assertRootIdentity(context);
        result ??= await this.replay(input.artifactId, targetPath, input.bytes, context);
      }
    } catch (error) {
      operationError = error;
      const definiteLogicalRefusal = error instanceof ArtifactStorageError
        && (error.safeFailureCode === "storage_conflict" || error.safeFailureCode === "storage_capacity");
      if (context.mutationStarted && !definiteLogicalRefusal) {
        context.uncertain = true;
        this.poisoned = true;
      }
    } finally {
      if (!context.uncertain) {
        try {
          if (pending) { await this.io("pending_close", () => pending!.close(), context); pending = undefined; }
          if (pendingPath) {
            await this.io("pending_unlink", () => unlink(pendingPath!).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            }), context);
            pendingPath = undefined;
          }
          if (lock) { await this.io("lock_close", () => lock!.close(), context); lock = undefined; }
          if (ownedLock) {
            await this.io("lock_unlink", () => unlink(lockPath), context);
            ownedLock = false;
            await this.syncRoot(context);
          }
        } catch (error) {
          context.uncertain = true;
          cleanupError = error;
        }
      }
      const remainingPending = pending, remainingLock = lock;
      const closeRemaining = async () => {
        await remainingPending?.close().catch(() => {});
        await remainingLock?.close().catch(() => {});
      };
      // A timed-out syscall can still be running. Keep exclusion and its
      // descriptors until it settles; SIGKILL releases them regardless.
      if (guard) await this.retireGuard(guard, closeRemaining);
      else await closeRemaining();
    }
    if (context.uncertain || cleanupError) {
      this.poisoned = true;
      // The artifact result is set only after its link and pending-file retirement have both been
      // directory-synchronized and its exact envelope has been read back. A later failure can make
      // lock retirement uncertain, but it cannot make that already-proven artifact ambiguous. The
      // current adapter still retires; startup can recover its abandoned bookkeeping.
      if (result) return result;
      throw new ArtifactStorageError("storage_ambiguous");
    }
    if (operationError) {
      if (operationError instanceof Error && operationError.name === "AbortError") throw operationError;
      throw safeStorageError(operationError);
    }
    if (!result) throw new ArtifactStorageError("storage_ambiguous");
    return result;
  }

  private async retireGuard(guard: FileHandle, cleanup = async () => {}): Promise<void> {
    const finish = async () => {
      try { await cleanup(); } finally { await guard.close(); }
    };
    if (this.inFlight.size) {
      retiringGuards.add(guard);
      void Promise.allSettled([...this.inFlight]).then(finish)
        .finally(() => retiringGuards.delete(guard)).catch(() => {});
    } else await finish();
  }

  private recoveryError(reason: string): ArtifactStorageError {
    return Object.assign(new ArtifactStorageError("storage_ambiguous"), { safeReasonCode: reason, message: `storage_ambiguous: ${reason}` });
  }

  private async acquireGuard(context: OperationContext): Promise<FileHandle> {
    for (;;) {
      let acquired: FileHandle | null = null;
      let guard: FileHandle | null;
      try {
        guard = await this.io("kernel_lock", async () => {
          acquired = await tryPersistentKernelLockV1(join(this.root, kernelName));
          if (context.uncertain || context.signal?.aborted || Date.now() >= context.deadline) {
            await acquired?.close(); acquired = null;
          }
          return acquired;
        }, context);
      } catch (error) { await (acquired as FileHandle | null)?.close(); throw error; }
      if (guard) {
        try { await this.assertRootIdentity(context); return guard; }
        catch (error) { await guard.close(); throw error; }
      }
      await this.io("lock_wait", () => new Promise<void>(done => setTimeout(done, 10)), context);
    }
  }

  /** The permanent kernel guard is held for the entire inventory and recovery.
   * Empty records arise before lock_write; no pending file can exist yet. A
   * legacy anonymous writer did not use this guard, so it needs a stopped-host
   * migration and is refused here with a named reason. */
  private async recover(context: OperationContext): Promise<void> {
    await this.assertRootIdentity(context);
    const entries = await this.io("inventory_read", () => readdir(this.root), context);
    const pendingNames = entries.filter(name => name.startsWith(pendingPrefix));
    for (const name of entries) {
      if (name !== kernelName && name !== lockName && !artifactNamePattern.test(name)
        && !pendingNames.includes(name)) throw this.recoveryError("storage_unknown_entry");
    }
    let token: string | undefined;
    let writerInfo: BigIntStats | undefined;
    if (entries.includes(lockName)) {
      const path = join(this.root, lockName);
      writerInfo = await this.privateBookkeeping(context, path, false);
      if (writerInfo.size > BigInt(1024)) throw this.recoveryError("storage_writer_unidentified");
      const handle = await this.io("recovery_open", () => open(path, constants.O_RDONLY | noFollow | nonBlock), context);
      try {
        const info = await handle.stat({ bigint: true });
        if (info.dev !== writerInfo.dev || info.ino !== writerInfo.ino) throw this.recoveryError("storage_writer_changed");
        const raw = await handle.readFile("utf8");
        if (!raw) {
          // The new writer durably identifies itself on the permanent guard
          // BEFORE lock_open. An old anonymous/empty lock has no such proof.
          const stampHandle = await open(join(this.root, kernelName), constants.O_RDONLY | noFollow | nonBlock);
          try {
            const stampInfo = await stampHandle.stat();
            if (stampInfo.size > 1024) throw this.recoveryError("storage_writer_unidentified");
            let stamp;
            try { stamp = JSON.parse(await stampHandle.readFile("utf8")); }
            catch { throw this.recoveryError("storage_writer_unidentified"); }
            if (stamp?.schema !== writerSchema || !Number.isSafeInteger(stamp.pid) || stamp.pid < 1
              || !uuidPattern.test(stamp.token)) throw this.recoveryError("storage_writer_unidentified");
            token = stamp.token;
          } finally { await stampHandle.close(); }
        } else {
          let owner;
          try { owner = JSON.parse(raw); } catch { throw this.recoveryError("storage_writer_unidentified"); }
          if (owner?.schema !== writerSchema || !Number.isSafeInteger(owner.pid) || owner.pid < 1
            || !uuidPattern.test(owner.token)) throw this.recoveryError("storage_writer_unidentified");
          token = owner.token;
        }
      } finally { await handle.close(); }
    }
    // Validate the complete recovery set before deleting anything. A named
    // pending file belongs only to the identified writer's unique token.
    for (const name of pendingNames) {
      if (!token || name !== `${pendingPrefix}${token}`) throw this.recoveryError("storage_pending_unidentified");
      await this.privateBookkeeping(context, join(this.root, name), true);
    }
    for (const name of pendingNames) {
      const path = join(this.root, name);
      await this.io("recovery_unlink", () => unlink(path), context);
    }
    if (writerInfo) {
      const current = await this.privateBookkeeping(context, join(this.root, lockName), false);
      if (current.dev !== writerInfo.dev || current.ino !== writerInfo.ino) throw this.recoveryError("storage_writer_changed");
      await this.io("recovery_unlink", () => unlink(join(this.root, lockName)), context);
    }
    if (pendingNames.length || writerInfo) await this.syncRoot(context);
  }

  private async privateBookkeeping(context: OperationContext, path: string, pending: boolean): Promise<BigIntStats> {
    const info = await this.io("recovery_stat", () => lstat(path, { bigint: true }), context);
    if (!info.isFile() || info.isSymbolicLink() || !validPrivateMode(info.mode)
      || info.uid !== BigInt(process.getuid!()) || (pending ? info.nlink < BigInt(1) || info.nlink > BigInt(2) : info.nlink !== BigInt(1))) {
      throw this.recoveryError("storage_bookkeeping_invalid");
    }
    return info;
  }

  private async replay(
    artifactId: string,
    path: string,
    expected: Uint8Array,
    context: OperationContext,
  ): Promise<StoredArtifactV1> {
    const record = await this.readRecord(path, context, artifactId, false);
    if (!record) throw new ArtifactStorageError("storage_ambiguous");
    if (record.bytes.byteLength !== expected.byteLength
      || resultBytesHash(record.bytes) !== resultBytesHash(expected)) {
      throw new ArtifactStorageError("storage_conflict");
    }
    return {
      artifactId,
      opaqueLocator: opaqueLocator(artifactId),
      contentHash: record.header.contentHash,
      sizeBytes: record.header.sizeBytes,
    };
  }

  private async inventory(context: OperationContext, ownLock = false): Promise<{
    names: Set<string>;
    count: number;
    totalBytes: number;
  }> {
    await this.assertRootIdentity(context);
    const names = new Set<string>();
    let totalBytes = 0;
    const entries = await this.io("inventory_read", () => readdir(this.root), context);
    for (const entry of entries) {
      if (entry === kernelName || entry === lockName && ownLock) continue;
      if (!artifactNamePattern.test(entry)) throw this.recoveryError("storage_unknown_entry");
      const record = await this.readRecord(join(this.root, entry), context, undefined, false);
      if (!record || storageName(record.header.artifactId) !== entry
        || record.header.sizeBytes > this.maximumFileBytes) throw new ArtifactStorageError("storage_ambiguous");
      names.add(entry);
      totalBytes += record.header.sizeBytes;
      if (!Number.isSafeInteger(totalBytes)) throw new ArtifactStorageError("storage_ambiguous");
    }
    await this.assertRootIdentity(context);
    return { names, count: names.size, totalBytes };
  }

  private async readRecord(
    path: string,
    context: OperationContext,
    expectedArtifactId: string | undefined,
    missingAllowed: boolean,
  ): Promise<StoredRecord | undefined> {
    let before;
    try {
      before = await this.io("artifact_lstat", () => lstat(path, { bigint: true }), context);
    } catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const maximumPhysicalBytes = BigInt(headerLimitBytes + this.maximumFileBytes + 1);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(1)
      || before.size < BigInt(2) || before.size > maximumPhysicalBytes || !validPrivateMode(before.mode)) {
      throw new ArtifactStorageError("storage_ambiguous");
    }
    const handle = await this.io("artifact_open", () => open(path, constants.O_RDONLY | noFollow | nonBlock), context);
    try {
      const opened = await this.io("artifact_stat", () => handle.stat({ bigint: true }), context);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== BigInt(1)
        || opened.size !== before.size || !validPrivateMode(opened.mode)) throw new ArtifactStorageError("storage_ambiguous");
      const allocation = new Uint8Array(Number(before.size) + 1);
      let length = 0;
      while (length < allocation.byteLength) {
        const next = await this.io("artifact_read",
          () => handle.read(allocation, length, allocation.byteLength - length, length), context);
        if (next.bytesRead === 0) break;
        length += next.bytesRead;
      }
      const after = await this.io("artifact_stat", () => handle.stat({ bigint: true }), context);
      const current = await this.io("artifact_recheck", () => lstat(path, { bigint: true }), context);
      if (length !== Number(before.size) || length > Number(before.size)
        || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
        || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== BigInt(1)
        || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
        || current.size !== before.size || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) {
        throw new ArtifactStorageError("storage_ambiguous");
      }
      return decodeEnvelope(allocation.slice(0, length), expectedArtifactId);
    } finally {
      if (context.uncertain) void handle.close().catch(() => {});
      else await this.io("artifact_close", () => handle.close(), context);
    }
  }

  private context(signal?: AbortSignal, began = Date.now()): OperationContext {
    return { signal, deadline: began + this.operationTimeoutMs, mutationStarted: false, uncertain: false };
  }

  private checkpoint(context: OperationContext): void {
    if (context.signal?.aborted) {
      if (context.mutationStarted) { context.uncertain = true; this.poisoned = true; }
      throw abortError();
    }
    if (Date.now() >= context.deadline) {
      context.uncertain = true;
      this.poisoned = true;
      throw new DeadlineError();
    }
    if (this.poisoned) throw new ArtifactStorageError("storage_ambiguous");
  }

  private async io<T>(boundary: PersistentLocalArtifactStorageIoBoundaryV1,
    begin: () => Promise<T>, context: OperationContext, uncertainAcquisition = false): Promise<T> {
    this.checkpoint(context);
    const operation = this.testIo ? Promise.resolve().then(() => this.testIo!.run(boundary, begin)) : begin();
    this.inFlight.add(operation);
    void operation.finally(() => this.inFlight.delete(operation)).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      const remaining = Math.max(0, context.deadline - Date.now());
      timer = setTimeout(() => { context.uncertain = true; this.poisoned = true; reject(new DeadlineError()); }, remaining);
      if (context.signal) {
        onAbort = () => {
          if (context.mutationStarted) { context.uncertain = true; this.poisoned = true; }
          reject(abortError());
        };
        context.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([operation, stopped]);
    } catch (error) {
      if (context.mutationStarted || uncertainAcquisition &&
        (error instanceof DeadlineError || error instanceof Error && error.name === "AbortError")) {
        context.uncertain = true;
        this.poisoned = true;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (context.signal && onAbort) context.signal.removeEventListener("abort", onAbort);
      void operation.catch(() => {});
    }
  }

  private static async initialIo<T>(begin: () => Promise<T>, context: OperationContext): Promise<T> {
    if (Date.now() >= context.deadline) throw new DeadlineError();
    const operation = begin();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineError()), Math.max(0, context.deadline - Date.now()));
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      void operation.catch(() => {});
    }
  }

  private async assertRootIdentity(context: OperationContext): Promise<void> {
    try {
      const [canonical, stats] = await Promise.all([
        this.io("root_realpath", () => realpath(this.root), context),
        this.io("root_stat", () => lstat(this.root, { bigint: true }), context),
      ]);
      if (canonical !== this.root || !stats.isDirectory() || stats.isSymbolicLink()
        || stats.dev !== this.rootIdentity.device || stats.ino !== this.rootIdentity.inode
        || !validPrivateMode(stats.mode)) throw new ArtifactStorageError("storage_ambiguous");
    } catch (error) {
      throw safeStorageError(error);
    }
  }

  private async syncRoot(context: OperationContext): Promise<void> {
    const directory = await this.io("root_sync_open", () => open(this.root, constants.O_RDONLY | noFollow), context);
    try {
      await this.io("root_sync", () => directory.sync(), context);
    } finally {
      if (context.uncertain) void directory.close().catch(() => {});
      else await this.io("root_sync_close", () => directory.close(), context);
    }
  }

  private assertUsable(): void {
    if (this.poisoned) throw new ArtifactStorageError("storage_ambiguous");
  }
}

export async function createPersistentLocalArtifactStorageV1(
  configuration: PersistentLocalArtifactStorageConfigurationV1,
): Promise<PersistentLocalArtifactStorageV1> {
  return PersistentLocalArtifactStorageV1.create(configuration);
}

/** Deterministic fault injection for disposable tests only; never select this factory in production. */
export async function createPersistentLocalArtifactStorageForTestV1(
  configuration: PersistentLocalArtifactStorageConfigurationV1,
  testIo: PersistentLocalArtifactStorageTestIoV1,
): Promise<PersistentLocalArtifactStorageV1> {
  return PersistentLocalArtifactStorageV1.createForTest(configuration, testIo);
}
