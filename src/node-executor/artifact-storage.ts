import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface ArtifactStorageWriteV1 {
  artifactId: string;
  bytes: Uint8Array;
  signal?: AbortSignal;
}

export interface StoredArtifactV1 {
  artifactId: string;
  opaqueLocator: string;
  contentHash: string;
  sizeBytes: number;
}

export interface ArtifactStoragePortV1 {
  put(input: ArtifactStorageWriteV1): Promise<StoredArtifactV1>;
}

/** Explicitly supplied private artifact storage. Never resolves a caller-provided URL or path. */
export interface ArtifactReadPortV1 {
  read(artifactId: string, signal?: AbortSignal): Promise<Uint8Array | undefined>;
}

export class ArtifactStorageError extends Error {
  readonly safeFailureCode: "storage_conflict" | "storage_capacity" | "storage_invalid" | "storage_ambiguous";

  constructor(safeFailureCode: ArtifactStorageError["safeFailureCode"]) {
    super(safeFailureCode);
    this.name = "ArtifactStorageError";
    this.safeFailureCode = safeFailureCode;
  }
}

interface RootIdentity {
  device: bigint;
  inode: bigint;
}

const artifactNamePattern = /^[a-f0-9]{64}\.artifact$/u;
const lockName = ".control-room-artifact.lock";
const noFollow = constants.O_NOFOLLOW ?? 0;

function storageName(artifactId: string): string {
  return `${createHash("sha256").update(artifactId).digest("hex")}.artifact`;
}

function safeStorageError(error: unknown): ArtifactStorageError {
  return error instanceof ArtifactStorageError ? error : new ArtifactStorageError("storage_ambiguous");
}

function contentHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function validateArtifactId(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    /\s/u.test(value) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ArtifactStorageError("storage_invalid");
  }
}

export class InMemoryArtifactStorage implements ArtifactStoragePortV1 {
  private readonly artifacts = new Map<string, Uint8Array>();
  private totalBytes = 0;

  constructor(
    private readonly maximumArtifacts = 100,
    private readonly maximumTotalBytes = 6_553_600,
  ) {
    if (!Number.isSafeInteger(maximumArtifacts) || maximumArtifacts < 1) {
      throw new ArtifactStorageError("storage_invalid");
    }
    if (!Number.isSafeInteger(maximumTotalBytes) || maximumTotalBytes < 1) {
      throw new ArtifactStorageError("storage_invalid");
    }
  }

  async put(input: ArtifactStorageWriteV1): Promise<StoredArtifactV1> {
    input.signal?.throwIfAborted();
    validateArtifactId(input.artifactId);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > 65_536) {
      throw new ArtifactStorageError("storage_invalid");
    }

    const bytes = Uint8Array.from(input.bytes);
    const prior = this.artifacts.get(input.artifactId);
    if (prior) {
      if (contentHash(prior) !== contentHash(bytes) || prior.byteLength !== bytes.byteLength) {
        throw new ArtifactStorageError("storage_conflict");
      }
      return this.describe(input.artifactId, prior);
    }

    if (this.artifacts.size >= this.maximumArtifacts || this.totalBytes + bytes.byteLength > this.maximumTotalBytes) {
      throw new ArtifactStorageError("storage_capacity");
    }
    this.artifacts.set(input.artifactId, bytes);
    this.totalBytes += bytes.byteLength;
    return this.describe(input.artifactId, bytes);
  }

  get(artifactId: string): Uint8Array | undefined {
    const bytes = this.artifacts.get(artifactId);
    return bytes ? Uint8Array.from(bytes) : undefined;
  }

  async read(artifactId: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    signal?.throwIfAborted();
    validateArtifactId(artifactId);
    return this.get(artifactId);
  }

  count(): number {
    return this.artifacts.size;
  }

  sizeBytes(): number {
    return this.totalBytes;
  }

  private describe(artifactId: string, bytes: Uint8Array): StoredArtifactV1 {
    return {
      artifactId,
      opaqueLocator: `memory://artifact/${encodeURIComponent(artifactId)}`,
      contentHash: contentHash(bytes),
      sizeBytes: bytes.byteLength,
    };
  }
}

export class DisposableFilesystemArtifactStorage implements ArtifactStoragePortV1 {
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly rootIdentity: RootIdentity,
    private readonly maximumArtifacts: number,
    private readonly maximumTotalBytes: number,
  ) {}

  static async create(
    root: string,
    maximumArtifacts = 100,
    maximumTotalBytes = 6_553_600,
  ): Promise<DisposableFilesystemArtifactStorage> {
    if (!isAbsolute(root) || resolve(root) !== root || !Number.isSafeInteger(maximumArtifacts) || maximumArtifacts < 1
      || !Number.isSafeInteger(maximumTotalBytes) || maximumTotalBytes < 1) {
      throw new ArtifactStorageError("storage_invalid");
    }
    let canonical: string;
    let stats;
    try {
      canonical = await realpath(root);
      stats = await lstat(root, { bigint: true });
    } catch {
      throw new ArtifactStorageError("storage_invalid");
    }
    if (canonical !== root || !stats.isDirectory() || stats.isSymbolicLink()) throw new ArtifactStorageError("storage_invalid");
    if (process.platform !== "win32" && (Number(stats.mode) & 0o077) !== 0) throw new ArtifactStorageError("storage_invalid");
    const adapter = new DisposableFilesystemArtifactStorage(
      root,
      { device: stats.dev, inode: stats.ino },
      maximumArtifacts,
      maximumTotalBytes,
    );
    await adapter.assertRootIdentity();
    return adapter;
  }

  async put(input: ArtifactStorageWriteV1): Promise<StoredArtifactV1> {
    // Snapshot before the queue or filesystem awaits. A caller may reuse its
    // buffer/draft immediately; that must not rename or alter this write.
    const { artifactId, bytes, signal } = input;
    signal?.throwIfAborted();
    validateArtifactId(artifactId);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 65_536) throw new ArtifactStorageError("storage_invalid");
    const submitted = { artifactId, bytes: Uint8Array.from(bytes), signal };
    const result = this.queue.then(() => this.putExclusive(submitted), () => this.putExclusive(submitted));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async read(artifactId: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    signal?.throwIfAborted();
    validateArtifactId(artifactId);
    await this.assertRootIdentity();
    const path = join(this.root, storageName(artifactId));
    let handle: FileHandle;
    try { handle = await open(path, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { await this.assertRootIdentity(); return undefined; }
      throw new ArtifactStorageError("storage_ambiguous");
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== BigInt(1) || before.size > BigInt(65_536)
        || process.platform !== "win32" && (Number(before.mode) & 0o077) !== 0) throw new Error();
      // Fixed allocation and an extra byte detect growth without an unbounded readFile allocation.
      const bytes = new Uint8Array(65_537); let length = 0;
      while (length < bytes.byteLength) {
        signal?.throwIfAborted();
        const next = await handle.read(bytes, length, bytes.byteLength - length, length);
        if (next.bytesRead === 0) break;
        length += next.bytesRead;
      }
      const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true });
      if (length !== Number(before.size) || length > 65_536 || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.nlink !== BigInt(1)
        || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) throw new Error();
      await this.assertRootIdentity();
      signal?.throwIfAborted();
      return bytes.slice(0, length);
    } catch { throw new ArtifactStorageError("storage_ambiguous"); }
    finally { await handle.close(); }
  }

  private async putExclusive(input: ArtifactStorageWriteV1): Promise<StoredArtifactV1> {
    input.signal?.throwIfAborted();
    validateArtifactId(input.artifactId);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > 65_536) throw new ArtifactStorageError("storage_invalid");
    await this.assertRootIdentity();
    const lockPath = join(this.root, lockName);
    let lock: FileHandle;
    try {
      lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
      await lock.writeFile("control-room-artifact-write\n", "utf8");
      await lock.sync();
    } catch {
      throw new ArtifactStorageError("storage_ambiguous");
    }

    let pendingPath: string | undefined;
    let result: StoredArtifactV1 | undefined;
    let operationError: unknown;
    let cleanupError: unknown;
    try {
      const inventory = await this.inventory();
      const name = storageName(input.artifactId);
      const targetPath = join(this.root, name);
      const bytes = Uint8Array.from(input.bytes);
      if (inventory.names.has(name)) {
        result = await this.readExisting(input.artifactId, targetPath, bytes);
      } else {
        if (inventory.count >= this.maximumArtifacts || inventory.totalBytes + bytes.byteLength > this.maximumTotalBytes) {
          throw new ArtifactStorageError("storage_capacity");
        }

        pendingPath = join(this.root, `.pending-${randomUUID()}`);
        const pending = await open(pendingPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
        try {
          await pending.writeFile(bytes);
          await pending.sync();
        } finally {
          await pending.close();
        }
        try {
          input.signal?.throwIfAborted();
          await link(pendingPath, targetPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          result = await this.readExisting(input.artifactId, targetPath, bytes);
        }
        await this.syncRoot();
        await unlink(pendingPath);
        pendingPath = undefined;
        await this.syncRoot();
        await this.assertRootIdentity();
        result ??= await this.readExisting(input.artifactId, targetPath, bytes);
      }
    } catch (error) {
      operationError = error;
    } finally {
      try {
        if (pendingPath) await unlink(pendingPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        await lock.close();
        await unlink(lockPath);
        await this.syncRoot();
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) throw new ArtifactStorageError("storage_ambiguous");
    if (operationError) throw safeStorageError(operationError);
    if (!result) throw new ArtifactStorageError("storage_ambiguous");
    return result;
  }

  private async inventory(): Promise<{ names: Set<string>; count: number; totalBytes: number }> {
    const names = new Set<string>();
    let totalBytes = 0;
    for (const entry of await readdir(this.root)) {
      if (entry === lockName) continue;
      if (!artifactNamePattern.test(entry)) throw new ArtifactStorageError("storage_ambiguous");
      const stats = await lstat(join(this.root, entry), { bigint: true });
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== BigInt(1) || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ArtifactStorageError("storage_ambiguous");
      }
      names.add(entry);
      totalBytes += Number(stats.size);
      if (!Number.isSafeInteger(totalBytes)) throw new ArtifactStorageError("storage_ambiguous");
    }
    return { names, count: names.size, totalBytes };
  }

  private async readExisting(artifactId: string, path: string, expected: Uint8Array): Promise<StoredArtifactV1> {
    const before = await lstat(path, { bigint: true }).catch(() => { throw new ArtifactStorageError("storage_ambiguous"); });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(1) || before.size > BigInt(65_536)) {
      throw new ArtifactStorageError("storage_ambiguous");
    }
    const handle = await open(path, constants.O_RDONLY | noFollow).catch(() => { throw new ArtifactStorageError("storage_ambiguous"); });
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.nlink !== BigInt(1)) {
        throw new ArtifactStorageError("storage_ambiguous");
      }
      const bytes = Uint8Array.from(await handle.readFile());
      if (bytes.byteLength !== expected.byteLength || contentHash(bytes) !== contentHash(expected)) {
        throw new ArtifactStorageError("storage_conflict");
      }
      return {
        artifactId,
        opaqueLocator: `local-artifact://${storageName(artifactId).replace(".artifact", "")}`,
        contentHash: contentHash(bytes),
        sizeBytes: bytes.byteLength,
      };
    } finally {
      await handle.close();
    }
  }

  private async assertRootIdentity(): Promise<void> {
    try {
      const [canonical, stats] = await Promise.all([realpath(this.root), lstat(this.root, { bigint: true })]);
      if (canonical !== this.root || !stats.isDirectory() || stats.isSymbolicLink()
        || stats.dev !== this.rootIdentity.device || stats.ino !== this.rootIdentity.inode) {
        throw new ArtifactStorageError("storage_ambiguous");
      }
    } catch (error) {
      throw safeStorageError(error);
    }
  }

  private async syncRoot(): Promise<void> {
    const directory = await open(this.root, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
