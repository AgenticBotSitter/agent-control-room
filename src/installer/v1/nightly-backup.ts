import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { reserveBackupGenerationV1 } from "../shared/backup-files.mjs";
import { acquireRecoverablePrivateProcessLockV1 } from "../shared/private-process-lock.mjs";
import { BACKUP_MANIFEST_SCHEMA_V1, parseNightlyBackupConfigurationV1 } from "./nightly-backup-configuration";

type BackupResultV1 = Readonly<{ planned: boolean; identityDigest?: string }>;
/** What a completed run wants the caller to say beyond "it worked". */
type NightlyBackupReportV1 = Readonly<{ laterDatedGenerations: readonly string[] }>;
type BackupRuntimeV1 = Readonly<{
  readConfiguration: (path: string) => Promise<string>;
  readPassword: (path: string) => Promise<string>;
  inspectPath: (path: string) => Promise<Readonly<{ directory: boolean; file: boolean; symbolicLink: boolean }>>;
  acquireLock: (path: string) => Promise<() => Promise<void>>;
  prepareBackup: (path: string) => Promise<object | void>;
  backup: (configuration: Record<string, unknown>) => Promise<BackupResultV1>;
  listBackups: (path: string) => Promise<readonly Readonly<{
    name: string; directory: boolean; symbolicLink: boolean; completed?: boolean;
  }>[] >;
  /** Does the generation this run just wrote bind its own dump and metadata? */
  readGeneratedGeneration: (path: string) => Promise<Readonly<{ bound: boolean }>>;
  removeBackup: (path: string) => Promise<void>;
  now: () => string;
}>;

const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error
  ? String((error as { code?: unknown }).code) : "";

/**
 * How old an INCOMPLETE generation has to be before a run removes it.
 *
 * A generation folder with no usable metadata is what a SIGKILL, a power cut or
 * a full disk leaves behind. It is never a backup anybody can restore, but it is
 * still bytes on the owner's disk, and the one that removes it has to be sure it
 * is not removing a dump that is still being written by a concurrent attempt.
 * One day is long enough that any live attempt is finished, and short enough
 * that the disk does not fill between nights.
 */
const PARTIAL_GENERATION_MINIMUM_AGE_MS_V1 = 24 * 60 * 60 * 1000;

/**
 * The instant a generation name encodes, or NaN when it does not parse.
 *
 * The name is the ONLY age evidence available here: an incomplete folder has no
 * metadata to read a timestamp from, and its mtime is whatever the interrupted
 * write left. The name is what this module itself chose, from the clock it read,
 * so it is the same evidence every other decision here uses.
 */
const generationInstant = (name: string): number => {
  const parsed = new Date(name.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u, "$1T$2:$3:$4.$5Z"));
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : Number.NaN;
};

async function readNightlyBackupFileV1(path: string, maxBytes: number, ownerOnly = false): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) throw new Error("nightly_backup_credential_refused");
    // R4S-16: a database password that any other account on the Mac can read
    // is a password every one of those accounts can connect with, and this
    // module's own installer writes the file 0600 (`writeDatabaseLoginsV1`
    // refuses anything wider). It is checked HERE, through the open handle, and
    // not through the path: a name swapped between the check and the read is
    // exactly the race O_NOFOLLOW exists to close, and a path-level check would
    // reintroduce it. `mode & 0o077` is the group and other bits, which is the
    // whole question — the owner bits are what we must already have to read it.
    if (ownerOnly && (entry.mode & 0o077) !== 0) throw new Error("nightly_backup_credential_refused");
    const bytes = Buffer.alloc(64 * 1024), chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, maxBytes + 1 - size), size);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error("nightly_backup_credential_refused");
      chunks.push(Buffer.from(bytes.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await handle.close(); }
}

export function readNightlyBackupCredentialV1(path: string): Promise<string> {
  return readNightlyBackupFileV1(path, 64 * 1024, true);
}

export async function inspectNightlyBackupPathV1(path: string,
  afterLstat: () => Promise<void> = async () => {}) {
  const info = await lstat(path);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await afterLstat();
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { if (!(await handle.stat()).isDirectory()) throw new Error("nightly_backup_output_refused"); }
    finally { await handle.close(); }
  }
  return Object.freeze({ directory: info.isDirectory(), file: info.isFile(), symbolicLink: info.isSymbolicLink() });
}

/** Descriptor ownership survives a partial stamp and is released by the kernel on death.
 *
 * A wrong-mode, directory or dangling-symlink entry left in the private runtime is not "another
 * backup running": it is damage the owner can clear, and the recoverable acquire quarantines one
 * such entry inside the private directory and retries. A real holder still gets
 * `nightly_backup_concurrent_refused`, which is the only refusal that means "wait". */
export async function acquireNightlyBackupLockV1(path: string): Promise<() => Promise<void>> {
  const lock = acquireRecoverablePrivateProcessLockV1(path,
    { busyCode: "nightly_backup_concurrent_refused", unusableCode: "nightly_backup_lock_unusable" });
  return async () => lock.release();
}

/**
 * Does this generation's manifest still describe the bytes on disk?
 *
 * The same three facts the documented verifier requires, and computed the same
 * way: the manifest's schema, its digests against the real files, and its
 * restore identity against the metadata's own. Anything else — a missing
 * manifest, an edited one, a truncated dump, a swapped metadata file — is
 * `false`, which is what stops a damaged generation from spending retention.
 *
 * Every file is opened `O_NOFOLLOW` and read THROUGH the handle, for the same
 * reason the credential reader is: a generation folder is attacker-reachable
 * space on the owner's disk, and a path-level check would let a name be
 * swapped between the check and the read.
 *
 * A dump is hashed STREAMED rather than read whole. A production backup of this
 * database is gigabytes, and this runs for every generation on every night
 * under the run lock — reading fourteen of them into memory would be worse than
 * the problem it solves.
 */
async function generationBindsItsOwnDumpV1(folder: string,
  metadata: Record<string, unknown>): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readNightlyBackupFileV1(join(folder, "manifest.json"), 1024 * 1024));
    if (manifest?.schema !== BACKUP_MANIFEST_SCHEMA_V1) return false;
    if (manifest.restoreIdentityDigest !== (metadata.identity as { identityDigest?: unknown } | undefined)?.identityDigest)
      return false;
    const dumpDigest = await sha256OfNightlyFileV1(join(folder, "database.dump"));
    const metadataDigest = await sha256OfNightlyFileV1(join(folder, "metadata.json"));
    return manifest.dumpDigest === dumpDigest && manifest.metadataDigest === metadataDigest;
  } catch { /* Unreadable, unparsable or absent binding: not a completed generation. */ }
  return false;
}

/** The digest of a file, read through an `O_NOFOLLOW` descriptor in bounded chunks. */
async function sha256OfNightlyFileV1(path: string): Promise<string> {
  const digest = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("nightly_backup_binding_refused");
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    return `sha256:${digest.digest("hex")}`;
  } finally { await handle.close(); }
}

const runtimeV1: BackupRuntimeV1 = Object.freeze({
  readConfiguration: path => readFile(path, "utf8"),
  readPassword: readNightlyBackupCredentialV1,
  inspectPath: inspectNightlyBackupPathV1,
  acquireLock: acquireNightlyBackupLockV1,
  prepareBackup: reserveBackupGenerationV1,
  backup: async configuration => {
    try { return await (await import("../../../deploy/postgres/backup-database.mjs")).backupDatabase(configuration); }
    catch (error) {
      if (errorCode(error) === "ERR_MODULE_NOT_FOUND" && /(?:package\s+['"]pg['"]|\/pg\/)/u.test(String(error))) {
        throw new Error("nightly_backup_dependency_missing");
      }
      throw error;
    }
  },
  listBackups: async path => Promise.all((await readdir(path, { withFileTypes: true })).map(async entry => {
    let completed = false;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      try {
        const folder = join(path, entry.name);
        const dump = await lstat(join(folder, "database.dump"));
        // Full schema and grant evidence is larger than the password file.
        const metadata = JSON.parse(await readNightlyBackupFileV1(join(folder, "metadata.json"), 16 * 1024 * 1024));
        completed = dump.isFile() && !dump.isSymbolicLink() && dump.size > 0 && metadata.version === 1
          && /^sha256:[a-f0-9]{64}$/u.test(metadata.identity?.identityDigest ?? "")
          // R4B-01. Everything above is what the OLD scanner decided `completed`
          // from: a nonempty dump and a digest-SHAPED metadata field, with
          // nothing tying one to the other. Truncate the dump to one byte and
          // that test still passed — so damaged generations spent retention,
          // and the intact older history they displaced was deleted to make
          // room. Fourteen nights of corruption could evict the only undamaged
          // backup the owner had.
          //
          // The binding that does tie them is the manifest this module's own
          // backup producer now writes (R4B-10), and the SAME digest comparison
          // `scripts/ops/verify-database-backup.mjs` already refuses a backup
          // for. Retention and verification therefore agree by construction:
          // a generation the verifier would refuse can never be spent as
          // history, and one it would accept can.
          //
          // A generation with NO manifest is not counted either. That is the
          // transition cost R4B-01's own report asked for — "preserve existing
          // unverified history during transition" — and it is the SAFE
          // direction: an unverified generation becomes a partial one, which
          // R4S-10 already removes once it is a day old, so nothing is kept
          // forever and nothing intact is deleted to keep the damaged.
          && await generationBindsItsOwnDumpV1(folder, metadata);
      } catch { /* A partial generation cannot spend retention. */ }
    }
    return Object.freeze({ name: entry.name, directory: entry.isDirectory(), symbolicLink: entry.isSymbolicLink(), completed });
  })),
  removeBackup: path => rm(path, { recursive: true }),
  readGeneratedGeneration: async path => {
    const dump = await lstat(join(path, "database.dump"));
    if (!dump.isFile() || dump.isSymbolicLink() || dump.size < 1) return Object.freeze({ bound: false });
    const metadata = JSON.parse(await readNightlyBackupFileV1(join(path, "metadata.json"), 16 * 1024 * 1024));
    return Object.freeze({ bound: await generationBindsItsOwnDumpV1(path, metadata) });
  },
  now: () => new Date().toISOString(),
});

const backupName = (now: string) => {
  const parsed = typeof now === "string" ? new Date(now) : new Date(Number.NaN);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== now) throw new Error("nightly_backup_clock_refused");
  return now.replace(/[:.]/gu, "-");
};
const backupNamePattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/u;
let active = false;

export function nightlyBackupConfigurationPathV1(args: readonly string[]): string | undefined {
  return args.length === 2 && args[0] === "--configuration" && isAbsolute(args[1]!)
    && resolve(args[1]!) === args[1] && !args[1]!.startsWith("-") ? args[1] : undefined;
}

/**
 * Runs one nightly dump from the exact installer-generated protected
 * configuration, then applies retention under the same lock.
 *
 * The report is what a run wants the owner to be told even though it SUCCEEDED.
 * A clock that ran ahead once leaves a generation dated in the future, and
 * nothing about a success line says so; `laterDatedGenerations` names it so the
 * caller can put it in the log instead of leaving a puzzling directory behind.
 */
export async function runNightlyBackupV1(configurationPath: string | undefined,
  overrides: Partial<BackupRuntimeV1> = {}): Promise<NightlyBackupReportV1> {
  if (active) throw new Error("nightly_backup_concurrent_refused");
  active = true;
  const runtime = Object.freeze({ ...runtimeV1, ...overrides });
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    if (!configurationPath) throw new Error("nightly_backup_configuration_refused");
    let configuration: unknown;
    try { configuration = JSON.parse(await runtime.readConfiguration(configurationPath)); }
    catch { throw new Error("nightly_backup_configuration_refused"); }
    let parsed;
    try { parsed = parseNightlyBackupConfigurationV1(configurationPath, configuration); }
    catch { throw new Error("nightly_backup_configuration_refused"); }
    try {
      const output = await runtime.inspectPath(parsed.outputRoot);
      if (!output.directory || output.symbolicLink) throw new Error();
    } catch { throw new Error("nightly_backup_output_refused"); }
    try {
      const credential = await runtime.inspectPath(parsed.database.passwordFile);
      if (!credential.file || credential.symbolicLink) throw new Error();
    } catch { throw new Error("nightly_backup_credential_refused"); }
    releaseLock = await runtime.acquireLock(parsed.lockFile);
    let password: string;
    try { password = (await runtime.readPassword(parsed.database.passwordFile)).replace(/[\r\n]+$/u, ""); }
    catch { throw new Error("nightly_backup_credential_refused"); }
    if (password.length < 1 || password.length > 4096 || /[\u0000\r\n]/u.test(password)) {
      throw new Error("nightly_backup_credential_refused");
    }
    const name = backupName(runtime.now()), out = join(parsed.outputRoot, name);
    // Reserve a fresh generation before the dump; failure cleanup must never remove an older backup.
    let generation: object | void;
    try { generation = await runtime.prepareBackup(out); } catch { throw new Error("nightly_backup_output_refused"); }
    let result: BackupResultV1;
    try {
      result = await runtime.backup({
        source: { host: parsed.database.host, port: parsed.database.port, database: parsed.database.name,
          user: parsed.database.login, password },
        out, generation, pgBin: parsed.pgBin, ledgerDigest: parsed.ledgerDigest,
        requiredTables: [...parsed.requiredTables], release: "mac-local-nightly",
      });
      if (result.planned !== false || !/^sha256:[a-f0-9]{64}$/u.test(result.identityDigest ?? "")) {
        throw new Error("nightly_backup_incomplete");
      }
    } catch (error) {
      await runtime.removeBackup(out);
      if (error instanceof Error && error.message === "nightly_backup_incomplete") throw error;
      if (error instanceof Error && error.message === "nightly_backup_dependency_missing") throw error;
      throw new Error("nightly_backup_execution_failed");
    }
    // R4B-01: the run's OWN generation is checked before it is allowed to
    // count as this night's backup.
    //
    // Every other generation is verified by the scanner in `listBackups`, which
    // is what stops damaged history from spending retention. This one has not
    // been scanned yet at this point in the run — it was created by
    // `prepareBackup` seconds ago and the scan happens below, after retention is
    // decided — so without this line a run whose OWN dump was silently damaged
    // would still print "completed", and the nightly row in the owner's head
    // would be a night with no backup on it. That is the same silent-failure
    // shape as R4S-03, one layer up and reachable without any failure at all.
    //
    // A generation that cannot bind its own bytes is REMOVED rather than left:
    // it is not a partial folder somebody will recognise as one, it is a folder
    // with a dump and a metadata file in it that looks exactly like a backup.
    //
    // `removeBackup` failing must not mask the refusal, so the removal is its
    // own best-effort step and the code is thrown either way: a generation this
    // run cannot vouch for is never reported as this night's backup, whether or
    // not its bytes could be cleaned up.
    let bound = false;
    try { bound = (await runtime.readGeneratedGeneration(out)).bound; } catch { bound = false; }
    if (!bound) {
      try { await runtime.removeBackup(out); } catch {}
      throw new Error("nightly_backup_unbound_generation");
    }
    try {
      const generations = (await runtime.listBackups(parsed.outputRoot))
        .filter(entry => backupNamePattern.test(entry.name));
      if (generations.some(entry => !entry.directory || entry.symbolicLink)) throw new Error("unsafe_generation");
      const ordered = generations.filter(entry => entry.completed).map(entry => entry.name).sort();
      // R4S-09: a generation dated LATER than this run is not a reason to stop
      // retiring. That early return is what one clock glitch did: the early
      // return matched the future-dated generation, so every later night
      // returned at the same line, nothing was ever retired again, and the
      // backup root grew without bound until the calendar caught up with the
      // bad date — months of disk, one bad clock.
      //
      // The two protections the early return was actually written for both
      // survive, and survive more precisely:
      //
      //   - A CLOCK STEP BACKWARDS still keeps every later-dated generation. This
      //     run is a genuine backup; the generations after it are the only copies
      //     of nights this run cannot replace, and nothing here can know whether
      //     their names are a bad clock or a real future. They are kept, and the
      //     names are REPORTED, so the owner can see the bad date rather than
      //     have this module decide it is a fault.
      //   - A FUTURE-DATED generation cannot be used as the yardstick for
      //     "latest by day", or a single bad name would silently retire good
      //     history one day at a time on its own schedule. Retention is measured
      //     against this run's own date, so only this run's own past is spent.
      //
      // R4S-10: an incomplete generation is not spendable (a partial folder is
      // not a restore point) but it is disk, and nothing else ever removed it,
      // because both the retention filter and the old clean-up skipped it. One
      // older than a day is removed HERE, under the same lock as everything
      // else, so the removal is serialized with any other run. The age comes
      // from the generation's own name, and a name that does not parse is left
      // alone rather than guessed at — `backupNamePattern` already proved the
      // shape, so this only guards a calendar date the runtime cannot represent.
      const laterDated = ordered.filter(generation => generation > name);
      const thisRunInstant = generationInstant(name);
      const partial = generations.filter(entry => !entry.completed)
        .filter(entry => Number.isFinite(thisRunInstant) && generationInstant(entry.name) <= thisRunInstant - PARTIAL_GENERATION_MINIMUM_AGE_MS_V1)
        .map(entry => entry.name);
      // History this run can retire: completed generations on or before this
      // run's own date. Anything later is the clock-backwards case above.
      const spendable = ordered.filter(generation => generation <= name);
      const latestByDay = new Map(spendable.map(generation => [generation.slice(0, 10), generation]));
      const kept = new Set([...latestByDay.values()].slice(-parsed.retention.dailyBackups));
      kept.add(name);
      const retired = spendable.filter(generation => !kept.has(generation));
      for (const retiredName of [...retired, ...partial]) {
        await runtime.removeBackup(join(parsed.outputRoot, retiredName));
      }
      return Object.freeze({ laterDatedGenerations: Object.freeze([...laterDated]) });
    } catch (error) {
      if (error instanceof Error && error.message === "unsafe_generation") throw error;
      throw new Error("nightly_backup_retention_failed");
    }
  } finally {
    try { if (releaseLock) await releaseLock(); }
    finally { active = false; }
  }
}
