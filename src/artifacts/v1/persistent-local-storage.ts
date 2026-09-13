import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  ArtifactStorageError,
  type ArtifactReadPortV1,
  type ArtifactStoragePortV1,
  type ArtifactStorageWriteV1,
  type StoredArtifactV1,
} from "../../node-executor/artifact-storage";
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

const artifactIdPattern = /^artifact:native:[a-f0-9]{64}$/u;
const artifactNamePattern = /^[a-f0-9]{64}\.artifact$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const lockName = ".control-room-persistent-artifact.lock";
const pendingPrefix = ".control-room-persistent-artifact-pending-";
const headerLimitBytes = 512;
const resultLimitBytes = 65_536;
const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlock = constants.O_NONBLOCK ?? 0;

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
 * It does not create directories, resolve caller paths, repair locks, or delete unknown entries.
 */
export class PersistentLocalArtifactStorageV1 implements ArtifactStoragePortV1, ArtifactReadPortV1 {
  private queue: Promise<void> = Promise.resolve();
  private poisoned = false;

  private constructor(
    private readonly root: string,
    private readonly rootIdentity: RootIdentity,
    private readonly maximumArtifacts: number,
    private readonly maximumFileBytes: number,
    private readonly maximumTotalBytes: number,
    private readonly operationTimeoutMs: number,
  ) {}

  static async create(
    configuration: PersistentLocalArtifactStorageConfigurationV1,
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
      configuration.operationTimeoutMs);
    try {
      await adapter.assertRootIdentity(context);
      const inventory = await adapter.inventory(context);
      if (inventory.count > configuration.maximumArtifacts || inventory.totalBytes > configuration.maximumTotalBytes) {
        throw new ArtifactStorageError("storage_capacity");
      }
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
    let lock: FileHandle | undefined;
    let ownedLock = false;
    let pending: FileHandle | undefined;
    let pendingPath: string | undefined;
    let result: StoredArtifactV1 | undefined;
    let operationError: unknown;
    let cleanupError: unknown;
    try {
      lock = await this.io(() => open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600), context, true);
      ownedLock = true;
      await this.io(() => lock!.writeFile("control-room-persistent-artifact-write\n", "utf8"), context);
      await this.io(() => lock!.sync(), context);
      const inventory = await this.inventory(context, true);
      const targetPath = join(this.root, storageName(input.artifactId));
      if (inventory.names.has(storageName(input.artifactId))) {
        result = await this.replay(input.artifactId, targetPath, input.bytes, context);
      } else {
        if (inventory.count >= this.maximumArtifacts
          || inventory.totalBytes + input.bytes.byteLength > this.maximumTotalBytes) {
          throw new ArtifactStorageError("storage_capacity");
        }
        pendingPath = join(this.root, `${pendingPrefix}${randomUUID()}`);
        pending = await this.io(() => open(pendingPath!,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600), context);
        const envelope = encodeEnvelope(input.artifactId, input.bytes);
        await this.io(() => pending!.writeFile(envelope), context);
        await this.io(() => pending!.sync(), context);
        await this.io(() => pending!.close(), context); pending = undefined;
        this.checkpoint(context);
        try {
          await this.io(() => link(pendingPath!, targetPath), context);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          result = await this.replay(input.artifactId, targetPath, input.bytes, context);
        }
        await this.syncRoot(context);
        await this.io(() => unlink(pendingPath!), context); pendingPath = undefined;
        await this.syncRoot(context);
        await this.assertRootIdentity(context);
        result ??= await this.replay(input.artifactId, targetPath, input.bytes, context);
      }
    } catch (error) {
      operationError = error;
    } finally {
      if (!context.uncertain) {
        try {
          if (pending) { await this.io(() => pending!.close(), context); pending = undefined; }
          if (pendingPath) {
            await this.io(() => unlink(pendingPath!).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            }), context);
            pendingPath = undefined;
          }
          if (lock) { await this.io(() => lock!.close(), context); lock = undefined; }
          if (ownedLock) {
            await this.io(() => unlink(lockPath), context);
            ownedLock = false;
            await this.syncRoot(context);
          }
        } catch (error) {
          context.uncertain = true;
          cleanupError = error;
        }
      } else {
        void pending?.close().catch(() => {});
        void lock?.close().catch(() => {});
      }
    }
    if (context.uncertain || cleanupError) {
      this.poisoned = true;
      throw new ArtifactStorageError("storage_ambiguous");
    }
    if (operationError) {
      if (operationError instanceof Error && operationError.name === "AbortError") throw operationError;
      throw safeStorageError(operationError);
    }
    if (!result) throw new ArtifactStorageError("storage_ambiguous");
    return result;
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
    const entries = await this.io(() => readdir(this.root), context);
    for (const entry of entries) {
      if (entry === lockName && ownLock) continue;
      if (!artifactNamePattern.test(entry)) throw new ArtifactStorageError("storage_ambiguous");
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
      before = await this.io(() => lstat(path, { bigint: true }), context);
    } catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const maximumPhysicalBytes = BigInt(headerLimitBytes + this.maximumFileBytes + 1);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(1)
      || before.size < BigInt(2) || before.size > maximumPhysicalBytes || !validPrivateMode(before.mode)) {
      throw new ArtifactStorageError("storage_ambiguous");
    }
    const handle = await this.io(() => open(path, constants.O_RDONLY | noFollow | nonBlock), context);
    try {
      const opened = await this.io(() => handle.stat({ bigint: true }), context);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== BigInt(1)
        || opened.size !== before.size || !validPrivateMode(opened.mode)) throw new ArtifactStorageError("storage_ambiguous");
      const allocation = new Uint8Array(Number(before.size) + 1);
      let length = 0;
      while (length < allocation.byteLength) {
        const next = await this.io(() => handle.read(allocation, length, allocation.byteLength - length, length), context);
        if (next.bytesRead === 0) break;
        length += next.bytesRead;
      }
      const after = await this.io(() => handle.stat({ bigint: true }), context);
      const current = await this.io(() => lstat(path, { bigint: true }), context);
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
      else await this.io(() => handle.close(), context);
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

  private async io<T>(begin: () => Promise<T>, context: OperationContext, beginsMutation = false): Promise<T> {
    this.checkpoint(context);
    if (beginsMutation) context.mutationStarted = true;
    const operation = begin();
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
        this.io(() => realpath(this.root), context),
        this.io(() => lstat(this.root, { bigint: true }), context),
      ]);
      if (canonical !== this.root || !stats.isDirectory() || stats.isSymbolicLink()
        || stats.dev !== this.rootIdentity.device || stats.ino !== this.rootIdentity.inode
        || !validPrivateMode(stats.mode)) throw new ArtifactStorageError("storage_ambiguous");
    } catch (error) {
      throw safeStorageError(error);
    }
  }

  private async syncRoot(context: OperationContext): Promise<void> {
    const directory = await this.io(() => open(this.root, constants.O_RDONLY | noFollow), context);
    try {
      await this.io(() => directory.sync(), context);
    } finally {
      if (context.uncertain) void directory.close().catch(() => {});
      else await this.io(() => directory.close(), context);
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
