import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

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
  | "staging_capacity"   // the aggregate staging disk budget is full
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
  /** Completed chunks and live scratch reservations share this installation budget. */
  maximumTotalBytes?: number;
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
// The PID is durable in the scratch name. Reclamation requires ESRCH; an
// inaccessible or reused live PID is conservatively retained, never guessed dead.
const scratchPattern = /^\.staging-[a-f0-9]{64}-[a-z0-9]+-\d+\.part$/u;
const directoryLock = process.platform === "darwin" ? 0x20 : 0;
const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlock = constants.O_NONBLOCK ?? 0;

const bytesDigest = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

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
    .update(JSON.stringify(["control-room.result-upload-staging/v2", tenantId, projectId, uploadId, ordinal]), "utf8")
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
interface Operation { deadline: number; expired?: boolean }

function safe(error: unknown): ResultUploadStagingError {
  return error instanceof ResultUploadStagingError ? error : new ResultUploadStagingError("staging_ambiguous");
}

/** Same-root operations wait for outstanding I/O and cleanup, even after their
 * caller times out. An uncertain root must not be reused by another instance.
 * Different roots have independent queues. Queue wait spends the same deadline
 * as disk I/O; expired queued work never starts touching the filesystem. */
interface RootQueue { tail: Promise<void>; uncertain: boolean }
const rootQueues = new Map<string, RootQueue>();

function usable(operation: Operation): void {
  if (operation.expired || Date.now() >= operation.deadline)
    throw new ResultUploadStagingError("staging_ambiguous");
}

async function io<T>(operation: Operation, action: () => Promise<T>): Promise<T> {
  usable(operation);
  const value = await action();
  usable(operation);
  return value;
}

function enqueue<T>(root: string, timeoutMs: number, action: ((operation: Operation) => Promise<T>) | undefined): Promise<T> {
  const queue = rootQueues.get(root) ?? { tail: Promise.resolve(), uncertain: false };
  if (queue.uncertain) return Promise.reject(new ResultUploadStagingError("staging_ambiguous"));
  const operation: Operation = { deadline: Date.now() + timeoutMs };
  const pending = queue.tail.then(async () => {
    usable(operation);
    const execute = action!;
    action = undefined;
    const value = await execute(operation);
    usable(operation);
    return value;
  }).catch((error: unknown) => { throw safe(error); });
  const tail = pending.then(() => {}, () => {});
  queue.tail = tail;
  rootQueues.set(root, queue);
  void tail.then(() => { if (rootQueues.get(root) === queue && queue.tail === tail) rootQueues.delete(root); });
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      operation.expired = true;
      // Drop an expired queued callback (and its chunk snapshot). Do not keep
      // admitting retries to a root whose disk operation has not settled.
      action = undefined;
      queue.uncertain = true;
      reject(new ResultUploadStagingError("staging_ambiguous"));
    }, Math.max(0, operation.deadline - Date.now()));
  });
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
}

export class ResultUploadStagingV1 {
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
      || configuration.maximumTotalBytes !== undefined && (!Number.isSafeInteger(configuration.maximumTotalBytes)
        || configuration.maximumTotalBytes < configuration.maximumChunkBytes)
      || !Number.isSafeInteger(configuration.operationTimeoutMs) || configuration.operationTimeoutMs < 1
      || configuration.operationTimeoutMs > 600_000) throw new ResultUploadStagingError("staging_invalid");
    return enqueue(configuration.rootPath, configuration.operationTimeoutMs, async operation => {
      let canonical: string, stats: BigIntStats;
      try {
        [canonical, stats] = await io(operation, () => Promise.all([
          realpath(configuration.rootPath), lstat(configuration.rootPath, { bigint: true }),
        ]));
      } catch (error) {
        if (error instanceof ResultUploadStagingError) throw error;
        throw new ResultUploadStagingError("staging_invalid");
      }
      if (canonical !== configuration.rootPath || !stats.isDirectory() || stats.isSymbolicLink()
        || !validPrivateMode(stats.mode)) throw new ResultUploadStagingError("staging_invalid");
      const staging = new ResultUploadStagingV1(canonical, { device: stats.dev, inode: stats.ino },
        Object.freeze({ ...configuration }));
      await staging.proveDirectoryLock(operation);
      await staging.reclaimAbandoned(operation);
      await staging.assertAccountedFor(operation);
      return staging;
    });
  }

  private usable(operation: Operation): void {
    usable(operation);
  }

  private async assertRoot(operation: Operation) {
    this.usable(operation);
    const [canonical, stats] = await io(operation, () => Promise.all([realpath(this.root), lstat(this.root, { bigint: true })]));
    if (canonical !== this.root || !stats.isDirectory() || stats.isSymbolicLink()
      || stats.dev !== this.identity.device || stats.ino !== this.identity.inode
      || !validPrivateMode(stats.mode)) throw new ResultUploadStagingError("staging_ambiguous");
  }

  private async proveDirectoryLock(operation: Operation): Promise<void> {
    await this.assertRoot(operation);
    if (!directoryLock) throw new ResultUploadStagingError("staging_invalid");
    let first: FileHandle | undefined, second: FileHandle | undefined;
    try {
      try { first = await open(this.root, constants.O_RDONLY | noFollow | directoryLock | nonBlock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EAGAIN") return; throw error; }
      try { second = await open(this.root, constants.O_RDONLY | noFollow | directoryLock | nonBlock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EAGAIN") return; throw error; }
      throw new ResultUploadStagingError("staging_invalid");
    } catch (error) { throw safe(error); }
    finally { await second?.close(); await first?.close(); }
  }

  private async reclaimAbandoned(operation: Operation): Promise<void> {
    await this.assertRoot(operation);
    const abandoned: string[] = [];
    for (const name of await readdir(this.root)) {
      if (!scratchPattern.test(name)) continue;
      const pid = Number.parseInt(name.split("-")[2], 36);
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") abandoned.push(name); }
    }
    if (abandoned.length) await this.removeBoundNames(abandoned, operation, true);
  }

  /** cwd is a kernel-held directory reference. Relative unlink cannot follow a
   * replacement of the root pathname after the child verifies its inode. */
  private async removeBoundNames(names: string[], operation: Operation, abandoned = false, ownedScratch = false): Promise<number> {
    await this.assertRoot(operation);
    const script = `
      const fs = require("node:fs");
      const [device, inode, abandoned, ownedScratch, parentPid, ...names] = process.argv.slice(1);
      const root = fs.lstatSync(".", { bigint: true });
      if (!root.isDirectory() || root.dev.toString() !== device || root.ino.toString() !== inode
        || (Number(root.mode) & 0o077) !== 0) throw Error("root_changed");
      let removed = 0;
      for (const name of names) {
        const scratch = /^\\.staging-[a-f0-9]{64}-[a-z0-9]+-\\d+\\.part$/u.test(name);
        if (!/^[a-f0-9]{64}\\.chunk$/u.test(name) && !(scratch && (abandoned === "true" || ownedScratch === "true"))) throw Error("name_invalid");
        if (scratch && ownedScratch === "true" && parseInt(name.split("-")[2], 36) !== Number(parentPid)) throw Error("owner_changed");
        if (scratch && abandoned === "true") {
          try { process.kill(parseInt(name.split("-")[2], 36), 0); continue; }
          catch (error) { if (error.code !== "ESRCH") continue; }
        }
        let entry;
        try { entry = fs.lstatSync(name, { bigint: true }); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (!entry.isFile() || entry.isSymbolicLink() || (Number(entry.mode) & 0o077) !== 0
          || (entry.nlink !== 1n && !(scratch && entry.nlink === 2n))) throw Error("entry_changed");
        if (scratch && entry.nlink === 2n) {
          const final = fs.lstatSync(name.slice(9, 73) + ".chunk", { bigint: true });
          if (final.dev !== entry.dev || final.ino !== entry.ino) throw Error("entry_changed");
        }
        const current = fs.lstatSync(name, { bigint: true });
        if (current.dev !== entry.dev || current.ino !== entry.ino || current.nlink !== entry.nlink) throw Error("entry_changed");
        try { fs.unlinkSync(name); removed++; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      const directory = fs.openSync(".", fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      process.stdout.write(JSON.stringify(removed));
    `;
    const child = spawn(process.execPath, ["-e", script, this.identity.device.toString(),
      this.identity.inode.toString(), String(abandoned), String(ownedScratch), String(process.pid), ...names], {
      cwd: this.root, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", value => { output += String(value); });
    child.stderr!.resume();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The group is this process's own detached child, and it is not reaped until
    // "close", so its id cannot be reused meanwhile. ESRCH means it is gone; EPERM
    // is what macOS answers for a group whose only member has exited and is not
    // yet reaped (measured: kill(-pgid) on such a group returns EPERM, then ESRCH
    // after close). Neither is a reason to fail the removal. The deadline kill runs
    // in a timer, where a throw would be an uncaught exception that ends the whole
    // host process, so it never throws; a child that really refuses to die still
    // fails the removal through the close/exit code below.
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "EPERM") throw safe(error);
      }
    };
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject); child.once("close", resolve);
        timer = setTimeout(() => { try { kill("SIGKILL"); } catch { /* the close/exit result decides */ } },
          Math.max(1, operation.deadline - Date.now()));
      });
      if (code !== 0 || !/^\d+$/u.test(output)) throw new ResultUploadStagingError("staging_ambiguous");
      return Number(output);
    } catch (error) { throw safe(error); }
    finally { clearTimeout(timer); kill("SIGKILL"); }
  }

  private async withDiskBudget<T>(operation: Operation, work: () => Promise<T>): Promise<T> {
    // This store targets the Mac. Refuse an unsupported kernel rather than
    // silently substituting a process-local lock for a cross-process quota.
    if (!directoryLock) throw new ResultUploadStagingError("staging_ambiguous");
    let lock: FileHandle | undefined;
    while (!lock) {
      await this.assertRoot(operation);
      try { lock = await open(this.root, constants.O_RDONLY | noFollow | directoryLock | nonBlock); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw safe(error);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try {
      const held = await lock.stat({ bigint: true });
      if (held.dev !== this.identity.device || held.ino !== this.identity.inode)
        throw new ResultUploadStagingError("staging_ambiguous");
      return await work();
    } finally { await lock.close(); }
  }

  private async assertDiskBudget(additionalBytes: number, operation: Operation): Promise<void> {
    await this.reclaimAbandoned(operation);
    let total = additionalBytes;
    for (const name of await readdir(this.root)) {
      let entry: BigIntStats;
      try { entry = await lstat(join(this.root, name), { bigint: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw safe(error); }
      if (!entry.isFile() || entry.isSymbolicLink()) throw new ResultUploadStagingError("staging_ambiguous");
      total += scratchPattern.test(name) ? Math.max(Number(entry.size), Number(name.split("-")[3].split(".")[0])) : Number(entry.size);
    }
    if (!Number.isSafeInteger(total) || total > (this.configuration.maximumTotalBytes ?? 2 * 512 * 1024 * 1024))
      throw new ResultUploadStagingError("staging_capacity");
  }

  /** Every entry under the root is a staged chunk this area could have written.
   * Anything else — a stray file, a directory, a lock left by another process —
   * means the directory's state is not what the uploads believe, so nothing is
   * read or written until it is resolved. Nothing is ever deleted here. */
  private async assertAccountedFor(operation: Operation) {
    this.usable(operation);
    for (const entry of await io(operation, () => readdir(this.root)))
      if (!onDiskPattern.test(entry) && !scratchPattern.test(entry))
        throw new ResultUploadStagingError("staging_ambiguous");
    await this.assertRoot(operation);
  }

  /** The set of chunk names this area currently holds, for a sweeper that has
   * to tell "still uploading" from "left behind". Deliberately derived, never
   * parsed: a name is a digest, so it cannot be reversed into an upload id and
   * the answer to "whose bytes are these" is always the database's. */
  async stagedNames(): Promise<string[]> {
    return this.run(async operation => {
      await this.assertAccountedFor(operation);
      return (await io(operation, () => readdir(this.root))).filter((entry) => onDiskPattern.test(entry)).sort();
    });
  }

  /** Writes one chunk, create-once, across processes as well as within one. An
   * exact retry replays; different bytes for an ordinal already staged are
   * refused and the earlier chunk is left intact, because it is the record of
   * what the first attempt sent. */
  async stage(identity: StagedChunkIdentityV1, bytes: Uint8Array): Promise<{ digest: string; replayed: boolean }> {
    const name = stagedChunkNameV1(identity.tenantId, identity.projectId, identity.uploadId, identity.ordinal);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1
      || bytes.byteLength > this.configuration.maximumChunkBytes)
      throw new ResultUploadStagingError("staging_invalid");
    const snapshot = Uint8Array.from(bytes);
    return this.run(operation => this.withDiskBudget(operation, () => this.stageExclusive(name, snapshot, operation)));
  }

  private run<T>(action: (operation: Operation) => Promise<T>): Promise<T> {
    return enqueue(this.root, this.configuration.operationTimeoutMs, action);
  }

  /** A fresh budget for removing this process's OWN scratch or late-linked chunk.
   * The caller's deadline may already have passed (that is why the cleanup is
   * running), and an expired operation would make `removeBoundNames` refuse at
   * once and kill its child, leaving the scratch behind. The root's queue is still
   * held (and the root is marked uncertain) until this work settles, so the extra
   * time is spent by nobody else. */
  private cleanupOperation(): Operation {
    return { deadline: Date.now() + this.configuration.operationTimeoutMs };
  }

  private async stageExclusive(name: string, bytes: Uint8Array, operation: Operation) {
    const target = join(this.root, name);
    await this.assertAccountedFor(operation);
    const existing = await this.readFile(target, operation, true);
    if (existing) return this.settleAgainst(existing, bytes);
    await this.assertDiskBudget(bytes.byteLength, operation);
    // Written to a name of its own, then LINKED into place. `link` refuses with
    // EEXIST when the name is already taken, so exactly one writer's bytes ever
    // become the chunk, even across processes: the loser reads the winner's
    // bytes and answers replay or conflict from them. An earlier version used
    // `rename`, which OVERWRITES -- two processes racing different bytes for one
    // chunk both answered "created" in 30 of 320 rounds (review files2up S2),
    // and the second silently replaced the first. A partial chunk is still never
    // visible under the final name, because the link happens after the fsync.
    const scratch = join(this.root,
      `.staging-${name.slice(0, 64)}-${process.pid.toString(36)}-${bytes.byteLength}.part`);
    let handle: FileHandle | undefined;
    try {
      this.usable(operation);
      handle = await open(scratch, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
      this.usable(operation);
      await io(operation, () => handle!.writeFile(bytes));
      await io(operation, () => handle!.sync());
    } catch (error) {
      // A scratch name left by an earlier process with a reused pid answers
      // EEXIST here; that, and any other errno, is one of this area's codes.
      if (handle) await this.removeBoundNames([basename(scratch)], this.cleanupOperation(), false, true).catch(() => {});
      throw safe(error);
    } finally { await handle?.close().catch(() => {}); }
    // A late open/write/sync/close may clean its scratch, but cannot publish.
    try { this.usable(operation); }
    catch (error) {
      await this.removeBoundNames([basename(scratch)], this.cleanupOperation(), false, true).catch(() => {});
      throw error;
    }
    let won = true;
    try { await link(scratch, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await this.removeBoundNames([basename(scratch)], this.cleanupOperation(), false, true).catch(() => {});
        throw safe(error);
      }
      won = false;
    }
    // link itself cannot be cancelled. If it completes after the deadline,
    // retire only our own newly linked inode before releasing this root.
    // Both removals are descriptor-bound. The scratch goes first: with the chunk
    // still linked it has two links, which the helper accepts only when the final
    // name is the same inode. The chunk is then removed only if it was OUR inode;
    // this process still holds the root's disk-budget lock, so no other writer can
    // link a different chunk under that name in between.
    try { this.usable(operation); }
    catch (error) {
      const cleanup = this.cleanupOperation();
      let ours = false;
      if (won) {
        const [source, current] = await Promise.all([lstat(scratch, { bigint: true }), lstat(target, { bigint: true })])
          .catch(() => [undefined, undefined]);
        ours = !!source && !!current && source.dev === current.dev && source.ino === current.ino;
      }
      await this.removeBoundNames([basename(scratch)], cleanup, false, true).catch(() => {});
      if (ours) await this.removeBoundNames([name], cleanup).catch(() => {});
      throw error;
    }
    try {
      await this.removeBoundNames([basename(scratch)], this.cleanupOperation(), false, true);
      this.usable(operation);
      const directory = await open(this.root, constants.O_RDONLY | noFollow);
      try { this.usable(operation); await io(operation, () => directory.sync()); } finally { await directory.close().catch(() => {}); }
    } catch (error) { throw safe(error); }
    if (!won) {
      // Another writer holds the name. Its bytes ARE the chunk; ours are either
      // the same (a replay) or a conflict. A winner still between its own link
      // and its scratch unlink has two links for a moment, which the read below
      // refuses as ambiguous -- an honest refusal, never a second "created".
      const winner = await this.readFile(target, operation, true).catch((error: unknown) => { throw safe(error); });
      if (!winner) throw new ResultUploadStagingError("staging_ambiguous");
      return this.settleAgainst(winner, bytes);
    }
    // Re-read the chunk that was just linked into place, and prove it. The
    // `false` is deliberate and stays deliberate: a chunk that vanished between
    // the link and this proof has NOT been proven, and `staging_ambiguous` is
    // the honest answer -- which is why this call cannot translate ENOENT into
    // "absent". What it must not do is leak the errno either.
    let proven: Uint8Array | undefined;
    try { proven = await this.readFile(target, operation, false); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ResultUploadStagingError("staging_ambiguous");
      throw error;
    }
    if (!proven || bytesDigest(proven) !== bytesDigest(bytes))
      throw new ResultUploadStagingError("staging_ambiguous");
    return { digest: bytesDigest(bytes), replayed: false };
  }

  /** The answer for a writer that found the name already taken: the same bytes
   * are a replay, anything else is a conflict and the earlier chunk stays. */
  private settleAgainst(existing: Uint8Array, bytes: Uint8Array) {
    if (bytesDigest(existing) !== bytesDigest(bytes) || existing.byteLength !== bytes.byteLength)
      throw new ResultUploadStagingError("staging_conflict");
    return { digest: bytesDigest(bytes), replayed: true };
  }

  /** One staged chunk, proven unchanged across the read, or a refusal. */
  async read(identity: StagedChunkIdentityV1): Promise<Uint8Array | undefined> {
    const name = stagedChunkNameV1(identity.tenantId, identity.projectId, identity.uploadId, identity.ordinal);
    return this.run(operation => this.readExclusive(name, operation));
  }

  private async readExclusive(name: string, operation: Operation): Promise<Uint8Array | undefined> {
    await this.assertAccountedFor(operation);
    return this.readFile(join(this.root, name), operation, true);
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
    if (!Number.isSafeInteger(maxChunks) || maxChunks < 0 || maxChunks > 32)
      throw new ResultUploadStagingError("staging_invalid");
    return this.run(async operation => {
      stagedChunkNameV1(identity.tenantId, identity.projectId, identity.uploadId, 1);
      await this.assertAccountedFor(operation);
      const pieces: Uint8Array[] = [];
      let total = 0;
      for (let ordinal = 1; ordinal <= maxChunks; ordinal += 1) {
        const bytes = await this.readExclusive(stagedChunkNameV1(identity.tenantId, identity.projectId, identity.uploadId, ordinal), operation);
        if (!bytes) throw new ResultUploadStagingError("staging_missing");
        total += bytes.byteLength;
        if (!Number.isSafeInteger(total) || total > 268_435_456)
          throw new ResultUploadStagingError("staging_ambiguous");
        pieces.push(bytes);
      }
      const assembled = new Uint8Array(total);
      let offset = 0;
      for (const piece of pieces) { assembled.set(piece, offset); offset += piece.byteLength; }
      this.usable(operation);
      return assembled;
    });
  }

  /** Removes one session's staged chunks: EVERY ordinal the grammar allows,
   * 1..32, not just the ones the session promised. A chunk refused by the
   * database after it was staged, or one sent for an ordinal past the promise,
   * is exactly the leftover a promise-bounded sweep would miss (review files2up
   * B6), and the name derivation means nothing here can reach another upload. */
  async discardSession(identity: Omit<StagedChunkIdentityV1, "ordinal">): Promise<number> {
    return this.run(async operation => {
      const names = Array.from({ length: 32 }, (_, i) => stagedChunkNameV1(identity.tenantId, identity.projectId, identity.uploadId, i + 1));
      await this.assertAccountedFor(operation);
      await this.reclaimAbandoned(operation);
      return await this.removeBoundNames(names, operation);
    });
  }

  async discardChunk(identity: StagedChunkIdentityV1): Promise<boolean> {
    return this.run(operation => this.discardExclusive(identity, operation));
  }

  private async discardExclusive(identity: StagedChunkIdentityV1, operation: Operation): Promise<boolean> {
    const name = stagedChunkNameV1(identity.tenantId, identity.projectId, identity.uploadId, identity.ordinal);
    // An unaccounted entry refuses before anything is removed (r6flfix); the
    // removal itself is the descriptor-bound helper, which proves each name is a
    // private regular file with one link, in the root's own inode, and treats an
    // already-absent name as done.
    await this.assertAccountedFor(operation);
    return (await this.removeBoundNames([name], operation)) === 1;
  }

  private async readFile(path: string, operation: Operation, missingAllowed: boolean): Promise<Uint8Array | undefined> {
    this.usable(operation);
    let listed: BigIntStats;
    try { listed = await io(operation, () => lstat(path, { bigint: true })); }
    catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== BigInt(1)
      || listed.size > BigInt(this.configuration.maximumChunkBytes) || !validPrivateMode(listed.mode))
      throw new ResultUploadStagingError("staging_ambiguous");
    // The name was there a moment ago. It may not be now: a concurrent
    // `discardSession` -- the sweeper, or the owner voiding an upload, or the
    // cleanup after a finalise -- removes exactly these derived names while
    // another process is reading them. An `ENOENT` from the OPEN is therefore
    // the same "there is no such chunk" the lstat above already answers with
    // `undefined`, and the area's contract is its four fixed codes, so it is
    // translated here rather than escaping as a raw errno.
    //
    // Measured by this branch's own race lane (tests/result-upload-race.test.ts)
    // before the translation: two writer processes against one chunk for 40
    // seconds produced `ENOENT` from `open` and from `lstat` hundreds of times
    // per run, which a connector would see as an unhandled system error rather
    // than as "that chunk is gone". `ELOOP`, `EMFILE` and `ENFILE` are refusals
    // for the same reason a store that cannot ASK must not answer.
    let handle: FileHandle;
    try { this.usable(operation); handle = await open(path, constants.O_RDONLY | noFollow | nonBlock); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (missingAllowed && (code === "ENOENT" || code === "ENXIO")) return undefined;
      if (code === "ELOOP" || code === "EMFILE" || code === "ENFILE")
        throw new ResultUploadStagingError("staging_ambiguous");
      throw error;
    }
    try {
      this.usable(operation);
      const opened = await io(operation, () => handle.stat({ bigint: true }));
      if (!opened.isFile() || opened.dev !== listed.dev || opened.ino !== listed.ino
        || opened.nlink !== BigInt(1) || opened.size !== listed.size || !validPrivateMode(opened.mode))
        throw new ResultUploadStagingError("staging_ambiguous");
      const allocation = new Uint8Array(Number(listed.size));
      let length = 0;
      while (length < allocation.byteLength) {
        const next = await io(operation, () => handle.read(allocation, length, allocation.byteLength - length, length));
        if (next.bytesRead === 0) break;
        length += next.bytesRead;
      }
      const after = await io(operation, () => handle.stat({ bigint: true }));
      // The name may have gone between the open and this check -- the same
      // concurrent `discardSession` window as above. The descriptor is still a
      // valid handle on the bytes that were read, so when the read itself is
      // complete and the descriptor still points at the very inode that was
      // listed, the honest answer is that read rather than a raw errno. The
      // identity check exists to catch a file CHANGED under a name; a name that
      // no longer exists is not that.
      let current: BigIntStats | undefined;
      try { current = await io(operation, () => lstat(path, { bigint: true })); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (length === Number(listed.size) && after.size === listed.size
          && after.dev === listed.dev && after.ino === listed.ino && after.nlink === BigInt(1))
          return allocation;
        throw new ResultUploadStagingError("staging_ambiguous");
      }
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
