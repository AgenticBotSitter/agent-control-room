import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * THE OWNER'S BACKUP, AND WHETHER IT IS STILL THERE.
 *
 * R5B-01 was two defects wearing one coat. The dump could not read the queue
 * schema, so it failed every night; and nothing read the OUTPUT, so the failure
 * was one stderr line into a launchd log the owner never opens. Granting the
 * read (0285) fixes the first. This module is the second: it answers "how old is
 * the newest good backup" from the directory the nightly writes, so the updater
 * can turn "older than the owner's tolerance" into a phone push that already has
 * a reviewed template (`control-room-updater.backup-missing`, "Control Room
 * backup is missing or too old").
 *
 * WHY 36 HOURS AND NOT 24. The schedule is daily, so a 24-hour threshold fires
 * on every ordinary night's boundary — the warning would be noise, and a warning
 * that cries wolf is a warning nobody reads. One MISSED night is normal (the Mac
 * was asleep, the cluster was restarting) and the following night recovers it.
 * Two missed nights is a broken backup, and that is the case where the owner has
 * to know before they need it.
 *
 * WHY METADATA AND NOT THE FOLDER NAME. The folder name is the wall clock at
 * the moment the generation was RESERVED; `createdAt` is stamped when the dump
 * and its evidence committed. A clock that steps backwards (NTP, a timezone
 * repair, a Mac waking from months asleep) names a generation in the future and
 * would make a stale backup look brand new. `runNightlyBackupV1` already guards
 * the retention side of the same clock step; this is the reading side.
 *
 * EVERY FAILURE IS "OVERDUE", NEVER "FINE". An absent root, an unreadable root,
 * a permission error, a corrupt metadata file, a clock this process cannot read
 * — all of them answer `overdue: true`. A backup checker that fails open is a
 * backup checker that reports the owner has backups when nobody has verified any.
 */
export const NIGHTLY_BACKUP_OVERDUE_HOURS_V1 = 36 as const;
export const NIGHTLY_BACKUP_RECENCY_SCHEMA_V1 = "control-room.nightly-backup-recency/v1" as const;

/** The nightly's own generation naming, so a reader cannot drift from the writer. */
const GENERATION_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/u;
const IDENTITY_PATTERN = /^sha256:[a-f0-9]{64}$/u;
/** Metadata is small and bounded; an oversized or slow-parsing file is a refusal, not a read. */
const MAX_METADATA_BYTES_V1 = 4 * 1024 * 1024;
/** Bounded so a directory someone filled by hand cannot turn this into a long walk. */
const MAX_GENERATIONS_V1 = 4_096;

export type NewestGoodBackupV1 = Readonly<{
  schema: typeof NIGHTLY_BACKUP_RECENCY_SCHEMA_V1;
  /** The newest COMPLETED generation's folder name, or null when there is none. */
  generation: string | null;
  identityDigest: string | null;
  /** Whole hours old, rounded UP so 36h01m reads as 37. Negative if the clock stepped. */
  hoursSinceNewest: number | null;
  /** True when there is no good backup, when its age is unknown, or past the threshold. */
  overdue: boolean;
  thresholdHours: typeof NIGHTLY_BACKUP_OVERDUE_HOURS_V1;
}>;

const readMetadataV1 = async (path: string): Promise<Record<string, unknown> | undefined> => {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch { return undefined; }
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size < 2 || entry.size > MAX_METADATA_BYTES_V1) return undefined;
    const text = await handle.readFile("utf8");
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
  finally { await handle.close().catch(() => {}); }
};

/** An instant in milliseconds from a metadata `createdAt`, or from the folder
 * name when the metadata carries none, or undefined when neither is usable. */
function instantV1(metadata: Record<string, unknown> | undefined, name: string): number | undefined {
  const created = metadata?.createdAt;
  if (typeof created === "string") {
    const parsed = Date.parse(created);
    if (Number.isFinite(parsed)) return parsed;
  }
  // The generation name IS the reserved instant in a different spelling; a
  // metadata file without `createdAt` is still a real backup.
  const restored = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u.exec(name);
  if (!restored) return undefined;
  const parsed = Date.parse(`${restored[1]}T${restored[2]}:${restored[3]}:${restored[4]}.${restored[5]}Z`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The newest COMPLETED generation in a nightly backup root.
 *
 * COMPLETED is the same rule `runNightlyBackupV1` applies before it spends
 * retention: a real `database.dump` and a metadata file of version 1 carrying an
 * identity digest. A crash between the two leaves a folder that is not a backup
 * and must never be counted as one — that is exactly the window in which the
 * nightly fails, so counting it would hide the very failure being measured.
 *
 * @param outputRoot the nightly's `outputRoot`, from the shipped configuration.
 * @param options.nowMs this process's clock; omitted means `Date.now()`.
 */
export async function readNewestGoodBackupV1(outputRoot: string,
  options: { nowMs?: number } = {}): Promise<NewestGoodBackupV1> {
  const threshold = NIGHTLY_BACKUP_OVERDUE_HOURS_V1;
  const overdue = (hoursSinceNewest: number | null) => Object.freeze({
    schema: NIGHTLY_BACKUP_RECENCY_SCHEMA_V1, generation: null, identityDigest: null,
    hoursSinceNewest, overdue: true, thresholdHours: threshold,
  } satisfies NewestGoodBackupV1);
  if (typeof outputRoot !== "string" || !isAbsolute(outputRoot)) return overdue(null);
  // A DIRECTORY, not a link, and never followed: the backup root is under the
  // protected root and a link at its name must not redirect this read.
  try {
    const root = await lstat(outputRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) return overdue(null);
    const entries = (await readdir(outputRoot, { withFileTypes: true })).slice(0, MAX_GENERATIONS_V1);
    let newest: { name: string; digest: string; instant: number | undefined } | undefined;
    for (const entry of entries) {
      // The writer's own rule, rechecked: a symlink or a non-directory at a
      // generation name is not read, whatever its target says.
      if (!entry.isDirectory() || entry.isSymbolicLink() || !GENERATION_PATTERN.test(entry.name)) continue;
      const folder = join(outputRoot, entry.name);
      let dump;
      try { dump = await lstat(join(folder, "database.dump")); } catch { continue; }
      if (!dump.isFile() || dump.isSymbolicLink() || dump.size === 0) continue;
      const metadata = await readMetadataV1(join(folder, "metadata.json"));
      const identity = metadata?.identity as { identityDigest?: unknown } | undefined;
      const digest = identity?.identityDigest;
      if (metadata?.version !== 1 || typeof digest !== "string" || !IDENTITY_PATTERN.test(digest)) continue;
      const instant = instantV1(metadata, entry.name);
      // An unknown instant is OLDER than any known one, so a nameless-corrupt
      // folder cannot displace a dated backup — and the check below still makes
      // an all-unknown root overdue rather than fresh.
      if (!newest || (instant ?? Number.NEGATIVE_INFINITY) > (newest.instant ?? Number.NEGATIVE_INFINITY)
        || instant === undefined && newest.instant === undefined && entry.name > newest.name) {
        newest = { name: entry.name, digest, instant };
      }
    }
    if (!newest) return overdue(null);
    const now = options.nowMs ?? Date.now();
    if (newest.instant === undefined || !Number.isFinite(now)) {
      return Object.freeze({ ...overdue(null), generation: newest.name, identityDigest: newest.digest });
    }
    const hours = Math.ceil((now - newest.instant) / 3_600_000);
    // A stamp meaningfully in the FUTURE is not a young backup, it is an
    // untrustworthy clock: the dump recorded a time this Mac did not believe, and
    // a forward jump at backup time would make a months-old backup read as new.
    // So it is overdue even though the arithmetic says otherwise, and the
    // negative age is still REPORTED so the number is visible rather than
    // rounded to a reassuring zero. One hour of slack absorbs the ordinary
    // skew between the dump's stamp and this read.
    const credible = hours >= -1;
    return Object.freeze({ schema: NIGHTLY_BACKUP_RECENCY_SCHEMA_V1, generation: newest.name,
      identityDigest: newest.digest, hoursSinceNewest: hours,
      overdue: hours > threshold || !credible, thresholdHours: threshold });
  } catch { return overdue(null); }
}