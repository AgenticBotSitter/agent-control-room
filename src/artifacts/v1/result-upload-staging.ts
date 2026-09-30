import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The staging area for a chunked upload: where a chunk lands between the
 * connector sending it and the file being written to the byte store.
 *
 * It is a sibling of `ResultFileStoreV1`, under its own root, because the two
 * have opposite jobs. The byte store is create-once, content-addressed and
 * final: a file is there or it is not, and it is never rewritten. A chunked
 * upload is neither — it is a promise that arrives in pieces, and the pieces
 * have to live somewhere before the whole exists. Putting them in the byte
 * store would mean either partial files under a content-addressed name (which
 * the byte store's own digest-on-read would rightly refuse) or a second naming
 * scheme inside a directory whose whole contract is that it has exactly one.
 *
 * What it guarantees, and why each one matters:
 *
 *   * The name is DERIVED, from the tenant, the project, the upload id and the
 *     chunk ordinal. No caller supplies a name, a path or a directory, and there
 *     is no directory tree to traverse, so a traversal is not expressible.
 *   * The root must be canonical and mode 0700, and its device and inode are
 *     re-checked on every operation, so replacing it with a symlink mid-upload
 *     fails closed rather than diverting the bytes.
 *   * A chunk is create-once. An exact retry replays; a different chunk for the
 *     same ordinal is refused, and refused WITHOUT overwriting what is there —
 *     the earlier bytes are the evidence of what went wrong.
 *   * Every entry in the root must be one this staging area could have written,
 *     or the whole directory is unaccounted for and nothing is served. An
 *     unknown entry is a refusal, never a deletion.
 *   * O_NOFOLLOW, link count 1 and a regular file, on every read, so a
 *     substituted payload cannot be substituted past the digest check.
 *
 * A staged chunk is proved twice: once against the digest the chunk row in the
 * database records, and once as part of the whole file, at finalise, against the
 * digest the OWNER approved. Neither proof trusts the other, and the file only
 * reaches the byte store when both hold.
 */
export type ResultUploadStagingErrorCodeV1 =
  | "staging_invalid"    // a caller passed something the staging area refuses to interpret
  | "staging_missing"    // no chunk staged under that name
  | "staging_conflict"   // that ordinal is already staged with different bytes
  | "staging_ambiguous"; // a read could not be proven exact

export class ResultUploadStagingError extends Error {
  constructor(readonly code: ResultUploadStagingErrorCodeV1) {
    super(`result_upload_staging_${code}`);
    this.name = "ResultUploadStagingError";
  }
}

export interface ResultUploadStagingConfigurationV1 {
  /** An existing, canonical, private directory. The staging area creates
   * nothing outside it and never creates the root itself. */
  rootPath: string;
  maximumChunkBytes: number;
  operationTimeoutMs: number;
}

export interface StagedChunkIdentityV1 {
  tenantId: string;
  projectId: string;
  uploadId: string;
  ordinal: number;
}

const tenantPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;
const projectPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;
const uploadPattern = /^result-upload:[a-f0-9]{32}$/u;
const onDiskPattern = /^[a-f0-9]{64}\.chunk$/u;
const suffix = ".chunk";
// An in-flight scratch file, written under a name of its own and renamed into
// place. It is tolerated by the accounting rather than refused, because a chunk
// arriving in parallel would otherwise be refused by a reader that caught the
// write in progress. It is never READ (a read only ever uses a derived chunk
// name) and it carries its session's own hash, so a discard can reclaim the
// leftovers of a process that died mid-write.
const scratchPattern = /^\.staging-[a-f0-9]{64}-[a-z0-9]+-\d+\.part$/u;
const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlock = constants.O_NONBLOCK ?? 0;

const bytesDigest = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

class DeadlineError extends Error {}

/**
 * The one derivation of a staged chunk's on-disk name. The same derivation the
 * sweeper uses, so a chunk left behind by an expired session is findable by
 * name without a database read, and so two projects uploading the same bytes to
 * two different uploads stage them in two different places.
 */
export function stagedChunkNameV1(tenantId: string, projectId: string, uploadId: string, ordinal: number): string {
  if (!tenantPattern.test(tenantId) || !projectPattern.test(projectId) || !uploadPattern.test(uploadId)
    || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 32)
    throw new ResultUploadStagingError("staging_invalid");
  return `${createHash("sha256")
    .update(`control-room.result-upload-staging/v1:${tenantId}:${projectId}:${uploadId}:${ordinal}`, "utf8")
    .digest("hex")}${suffix}`;
}

/** The upload a staged chunk belongs to, recovered from its own name. Used by
 * the sweeper to decide which staged bytes an expired session still holds. The
 * project and ordinal are recovered from a sidecar-free path because the name is
 * a digest; what the sweeper needs is the UPLOAD, and the name cannot supply
 * that, so the sweeper works from the database and this exists only to prove
 * the name is not reversible into anything. */
export function stagedChunkNameIsDerivedV1(name: string): boolean {
  return onDiskPattern.test(name);
}

function validPrivateMode(mode: bigint): boolean {
  return process.platform === "win32" || (Number(mode) & 0o077) === 0;
}

interface RootIdentity { device: bigint; inode: bigint }
interface Operation { deadline: number }

function abortError(): Error {
  const error = new Error("result_upload_staging_aborted");
  error.name = "AbortError";
  return error;
}

function safe(error: unknown): ResultUploadStagingError {
  return error instanceof ResultUploadStagingError ? error : new ResultUploadStagingError("staging_ambiguous");
}

/** Serialised so two writers cannot interleave a readdir and a link. */
let writeQueue: Promise<void> = Promise.resolve();

export class ResultUploadStagingV1 {
  private poisoned = false;
  private constructor(
    private readonly root: string,
    private readonly identity: RootIdentity,
    private readonly configuration: Readonly<ResultUploadStagingConfigurationV1>,
  ) {}

  static async create(configuration: ResultUploadStagingConfigurationV1): Promise<ResultUploadStagingV1> {
    if (!configuration || typeof configuration.rootPath !== "string" || configuration.rootPath.length > 4096
      || !isAbsolute(configuration.rootPath) || resolve(configuration.rootPath) !== configuration.rootPath
      || !Number.isSafeInteger(configuration.maximumChunkBytes) || configuration.maximumChunkBytes < 1
      || configuration.maximumChunkBytes > 8 * 1024 * 1024
      || !Number.isSafeInteger(configuration.operationTimeoutMs) || configuration.operationTimeoutMs < 1
      || configuration.operationTimeoutMs > 600_000) throw new ResultUploadStagingError("staging_invalid");
    const operation: Operation = { deadline: Date.now() + configuration.operationTimeoutMs };
    let canonical: string, stats: BigIntStats;
    try {
      [canonical, stats] = await Promise.all([
        realpath(configuration.rootPath), lstat(configuration.rootPath, { bigint: true }),
      ]);
    } catch { throw new ResultUploadStagingError("staging_invalid"); }
    if (canonical !== configuration.rootPath || !stats.isDirectory() || stats.isSymbolicLink()
      || !validPrivateMode(stats.mode)) throw new ResultUploadStagingError("staging_invalid");
    const staging = new ResultUploadStagingV1(canonical, { device: stats.dev, inode: stats.ino },
      Object.freeze({ ...configuration }));
    await staging.assertAccountedFor(operation);
    return staging;
  }

  private usable(operation: Operation): void {
    if (this.poisoned || Date.now() >= operation.deadline) { this.poisoned = true; throw new DeadlineError(); }
  }

  private async assertRoot(operation: Operation) {
    this.usable(operation);
    const [canonical, stats] = await Promise.all([realpath(this.root), lstat(this.root, { bigint: true })]);
    if (canonical !== this.root || !stats.isDirectory() || stats.isSymbolicLink()
      || stats.dev !== this.identity.device || stats.ino !== this.identity.inode
      || !validPrivateMode(stats.mode)) throw new ResultUploadStagingError("staging_ambiguous");
  }

  /** Every entry under the root is a staged chunk this area could have written.
   * Anything else — a stray file, a directory, a lock left by another process —
   * means the directory's state is not what the uploads believe, so nothing is
   * read or written until it is resolved. Nothing is ever deleted here. */
  private async assertAccountedFor(operation: Operation) {
    this.usable(operation);
    for (const entry of await readdir(this.root))
      if (!onDiskPattern.test(entry) && !scratchPattern.test(entry))
        throw new ResultUploadStagingError("staging_ambiguous");
    await this.assertRoot(operation);
  }

  /** The set of chunk names this area currently holds, for a sweeper that has
   * to tell "still uploading" from "left behind". Deliberately derived, never
   * parsed: a name is a digest, so it cannot be reversed into an upload id and
   * the answer to "whose bytes are these" is always the database's. */
  async stagedNames(): Promise<string[]> {
    const operation: Operation = { deadline: Date.now() + this.configuration.operationTimeoutMs };
    await this.assertAccountedFor(operation);
    return (await readdir(this.root)).filter((entry) => onDiskPattern.test(entry)).sort();
  }

  /** Writes one chunk, create-once. An exact retry replays; different bytes for
   * an ordinal already staged are refused and the earlier chunk is left intact,
   * because it is the record of what the first attempt sent. */
  async stage(identity: StagedChunkIdentityV1, bytes: Uint8Array): Promise<{ digest: string; replayed: boolean }> {
    const name = stagedChunkNameV1(identity.tenantId, identity.projectId, identity.uploadId, identity.ordinal);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1
      || bytes.byteLength > this.configuration.maximumChunkBytes)
      throw new ResultUploadStagingError("staging_invalid");
    const run = writeQueue.then(() => this.stageExclusive(name, Uint8Array.from(bytes)),
      () => this.stageExclusive(name, Uint8Array.from(bytes)));
    writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async stageExclusive(name: string, bytes: Uint8Array) {
    const operation: Operation = { deadline: Date.now() + this.configuration.operationTimeoutMs };
    const target = join(this.root, name);
    await this.assertAccountedFor(operation);
    const existing = await this.readFile(target, operation, true);
    if (existing) {
      if (bytesDigest(existing) !== bytesDigest(bytes) || existing.byteLength !== bytes.byteLength)
        throw new ResultUploadStagingError("staging_conflict");
      return { digest: bytesDigest(bytes), replayed: true };
    }
    // Written to a name of its own and then renamed into place: `rename` is
    // atomic and overwrites, so a partial chunk is never visible under a name a
    // reader would accept. A reader that arrives between the two sees the
    // missing chunk, not a short one.
    const scratch = join(this.root,
      `.staging-${name.slice(0, 64)}-${process.pid.toString(36)}-${bytes.byteLength}.part`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(scratch, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle?.close().catch(() => {}); }
    try {
      await rename(scratch, target);
      const directory = await open(this.root, constants.O_RDONLY | noFollow);
      try { await directory.sync(); } finally { await directory.close().catch(() => {}); }
    } catch (error) {
      await unlink(scratch).catch(() => {});
      throw safe(error);
    }
    const proven = await this.readFile(target, operation, false);
    if (!proven || bytesDigest(proven) !== bytesDigest(bytes))
      throw new ResultUploadStagingError("staging_ambiguous");
    return { digest: bytesDigest(bytes), replayed: false };
  }

  /** One staged chunk, proven unchanged across the read, or a refusal. */
  async read(identity: StagedChunkIdentityV1): Promise<Uint8Array | undefined> {
    const name = stagedChunkNameV1(identity.tenantId, identity.projectId, identity.uploadId, identity.ordinal);
    const operation: Operation = { deadline: Date.now() + this.configuration.operationTimeoutMs };
    try {
      this.usable(operation);
      // The accounting runs on a READ as well as a write. A reader that arrived
      // while something else in the root could not be accounted for would be
      // reading from a directory whose state is not what the uploads believe,
      // and the only honest answer there is to refuse rather than to serve one
      // file out of a directory it does not understand.
      await this.assertAccountedFor(operation);
      return await this.readFile(join(this.root, name), operation, true);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw safe(error);
    }
  }

  /**
   * The whole file, assembled in ordinal order, and the digest it hashes to.
   * The count is checked here as well as in the database, because a chunk that
   * is missing ON DISK while its row exists is a different failure from one
   * whose row is missing, and only this can see the difference.
   *
   * `maxChunks` is passed by the caller from the session's own promise, so a
   * store cannot be walked into assembling an unbounded number of pieces.
   */
  async assemble(identity: Omit<StagedChunkIdentityV1, "ordinal">, maxChunks: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 32)
      throw new ResultUploadStagingError("staging_invalid");
    const operation: Operation = { deadline: Date.now() + this.configuration.operationTimeoutMs };
    const pieces: Uint8Array[] = [];
    let total = 0;
    for (let ordinal = 1; ordinal <= maxChunks; ordinal += 1) {
      const bytes = await this.read({ ...identity, ordinal });
      if (!bytes) throw new ResultUploadStagingError("staging_missing");
      total += bytes.byteLength;
      if (!Number.isSafeInteger(total) || total > 268_435_456)
        throw new ResultUploadStagingError("staging_ambiguous");
      pieces.push(bytes);
    }
    const assembled = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) { assembled.set(piece, offset); offset += piece.byteLength; }
    return assembled;
  }

  /** Removes one session's staged chunks. Used after a finalise, and by the
   * sweeper for an expired or voided session. It removes exactly the names this
   * area derives for that one upload, so it cannot be pointed at anything else,
   * and it treats an already-absent chunk as done. */
  async discardSession(identity: Omit<StagedChunkIdentityV1, "ordinal">, maxChunks: number): Promise<number> {
    if (!Number.isSafeInteger(maxChunks) || maxChunks < 0 || maxChunks > 32)
      throw new ResultUploadStagingError("staging_invalid");
    let removed = 0;
    for (let ordinal = 1; ordinal <= Math.max(maxChunks, 1); ordinal += 1) {
      const name = stagedChunkNameV1(identity.tenantId, identity.projectId, identity.uploadId, ordinal);
      try { await unlink(join(this.root, name)); removed += 1; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw safe(error);
      }
    }
    return removed;
  }

  private async readFile(path: string, operation: Operation, missingAllowed: boolean): Promise<Uint8Array | undefined> {
    this.usable(operation);
    let listed: BigIntStats;
    try { listed = await lstat(path, { bigint: true }); }
    catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== BigInt(1)
      || listed.size > BigInt(this.configuration.maximumChunkBytes) || !validPrivateMode(listed.mode))
      throw new ResultUploadStagingError("staging_ambiguous");
    const handle = await open(path, constants.O_RDONLY | noFollow | nonBlock);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== listed.dev || opened.ino !== listed.ino
        || opened.nlink !== BigInt(1) || opened.size !== listed.size || !validPrivateMode(opened.mode))
        throw new ResultUploadStagingError("staging_ambiguous");
      const allocation = new Uint8Array(Number(listed.size));
      let length = 0;
      while (length < allocation.byteLength) {
        const next = await handle.read(allocation, length, allocation.byteLength - length, length);
        if (next.bytesRead === 0) break;
        length += next.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const current = await lstat(path, { bigint: true });
      if (length !== Number(listed.size) || after.size !== listed.size
        || after.mtimeNs !== listed.mtimeNs || after.ctimeNs !== listed.ctimeNs
        || after.dev !== listed.dev || after.ino !== listed.ino || after.nlink !== BigInt(1)
        || current.isSymbolicLink() || current.dev !== listed.dev || current.ino !== listed.ino
        || current.size !== listed.size || current.mtimeNs !== listed.mtimeNs)
        throw new ResultUploadStagingError("staging_ambiguous");
      return allocation;
    } finally { await handle.close().catch(() => {}); }
  }
}

export async function openResultUploadStagingV1(
  configuration: ResultUploadStagingConfigurationV1,
): Promise<ResultUploadStagingV1> {
  return ResultUploadStagingV1.create(configuration);
}
