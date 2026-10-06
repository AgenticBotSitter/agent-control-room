// The preimage clone: root mkdirs, `_crdb` clones, and the `cp -c` question
// §8.6 assigns to this item.
//
// THE MEASURED ANSWER, and it is the reason this file exists:
//
//   `cp -c` does NOT fail when cloning is unavailable. It SILENTLY FULL-COPIES.
//
// Measured on this machine, macOS 26.6.2:
//
//   APFS  (the install root's filesystem)      exit 0, CLONED.
//         A 46,592 KiB cluster copied in 0 s consuming 22,248 KiB of free
//         space — a real clone, because the bytes are shared until written.
//   ExFAT (a disk image)                       exit 0, NOT cloned.
//   FAT32 (a disk image)                       exit 0, NOT cloned.
//   HFS+  (a disk image)                       exit 0, not tested for sharing
//         (HFS+ has no clonefile support, so it is in the fallback class).
//
// And the reason is in `man cp`:
//
//   -c   copy files using clonefile(2). Note that if the source and target
//        are on different filesystems, or the target filesystem does not
//        support cloning, cp will fallback to using copyfile(2) instead to
//        ensure the copy still succeeds.
//
// So `cp -c` is a REQUEST to clone, not a REQUIREMENT to clone, and its exit
// status cannot distinguish the two. A preimage step that checked only the exit
// code would report a full copy of a 100 GB database as a successful clone,
// having consumed the 3× disk headroom §8.6 reserves for exactly this case, on
// the one filesystem where the run was about to run out of space.
//
// THE VERDICT LIVES SOMEWHERE ELSE, AND FINDING 7 IS WHY
//
// `classifyPgCloneV1` used to live here, and it decided "cloned" from a `df`
// delta around a 1 MB `cp -c` probe — a measurement a concurrent deleter moves
// in either direction, and a threshold over it is a threshold a hostile process
// can cross. MEASURED: deltas across 20 clones of one 60 MB loaded cluster
// ranged from -60,772,352 to +93,388,800 bytes, and the branch's own stress test
// flaked on it once in the reviewer's run.
//
// It has been DELETED rather than deprecated, and that is the point of the
// change: an implementer importing from this file got a forgeable function with
// a reassuring name, and a function that is still exported is a function that
// will be imported. The verdict is `classifyPgCloneProbeV1` in
// `pg-clone-probe.ts`, and it is decided by `clonefile(2)` succeeding and by
// nothing else — a syscall with no copy fallback, so no deleter, no bot and no
// concurrent writer can produce a "cloned" answer from it.
//
// The other half of this file is the ownership order, R17b: **root creates the
// target directory and hands it over** before `_crdb` fills it. The reason is
// that `_crdb` creating `pg/data-B` itself would mean a process with write
// access to `pg/` choosing its own name, and `pg/` is where `pg/current` lives.

/** The schema string every value this module returns carries. */
export const PG_PREIMAGE_CLONE_V1 = "control-room.pg-preimage-clone/v1" as const;

/**
 * The ownership order for a preimage (R17b), as a plan rather than as a
 * sequence of side effects.
 *
 * Root's three steps, then `_crdb`'s one. The order is the security property:
 * root creates and `lchown`s, so the directory's *name* is chosen by the only
 * process that is not the database account, and `_crdb` never holds a
 * `mkdir` primitive anywhere it could use one to make a sibling.
 */
export type PgPreimagePlanV1 = Readonly<{
  schema: typeof PG_PREIMAGE_CLONE_V1;
  status: "root_mkdir_then_clone_planned" | "root_mkdir_then_clone_refused";
  /** The directory root creates, and what it creates it as. */
  rootSteps: readonly Readonly<{ step: string; as: string; mode: string }>[];
  /** What the database account does afterwards, as which account. */
  databaseAccountSteps: readonly Readonly<{ step: string; as: string }>[];
  /** What must be true of the source before any of it runs (§8.2 step 3). */
  preconditions: readonly string[];
  /**
   * The copy ARGUMENTS, not the command, and WITHOUT `-c`.
   *
   * FINDING 7's second half. `-c` is `cp`'s advisory request to clone, and
   * `man cp` says so: "if the source and target are on different filesystems, or
   * the target filesystem does not support cloning, cp will fallback to using
   * copyfile(2) instead to ensure the copy still succeeds." MEASURED: `cp -c`
   * exits 0 on FAT32 and ExFAT having full-copied. A plan that names `-c` tells
   * its reader the mechanism is a clone request, and the reader's next question
   * is always "how do we know it worked", and the answer is not this argument
   * list. The answer is `classifyPgCloneProbeV1` and the sidecar.
   *
   * `-R` and `-p` remain and are load-bearing: `-R` makes the copy recursive over
   * the cluster's tree, `-p` preserves modes and times so the preimage is
   * inspectable as the cluster it claims to be.
   */
  copyArguments: readonly string[];
  /**
   * How the clone verdict is obtained, stated here because the copy arguments
   * no longer imply it. Item 18 must run the sidecar in `pg/` and read
   * `pgCloneReservationMultiplierV1` from its verdict; this string is what a
   * reviewer reads to check that it did.
   */
  cloneVerdict: Readonly<{ from: string; decision: string; neverFrom: readonly string[] }>;
  refusal?: Readonly<{ reason: string; detail: string }>;
}>;

/**
 * Plan the preimage. Refuses when the source is not in a state that can be
 * cloned safely.
 *
 * The preconditions are the ones that make a clone meaningful, and each is
 * checkable from outside the data directory:
 *
 *  - `postmaster.pid` absent. A pid file means a postmaster is (or was) running
 *    in this directory. A clone of a live cluster is not a snapshot.
 *  - `pg_controldata` reports `shut down`. MEASURED requirement of §8.2: only
 *    a cleanly shut-down cluster may be cloned, or the preimage inherits a
 *    recovery state and `data-A` is not the untouched pre-image it claims to be.
 *  - the source and destination are on the SAME filesystem, which is what makes
 *    a clone possible at all; and the destination is EMPTY, because a recursive
 *    copy into a populated directory merges rather than replaces, and a merge
 *    would produce a data directory with the union of two clusters' files.
 */
export function planPgPreimageV1(input: Readonly<{
  sourceDataDirectory: string;
  targetDataDirectory: string;
  /** `postmaster.pid` present? */
  sourceHasPidFile: boolean;
  /** The `pg_controldata` cluster state line, verbatim. */
  controlDataClusterState: string;
  /** Free bytes on the volume, by the filesystem's own accounting. */
  freeBytes: number;
  /** The source's size, by the filesystem's own accounting. */
  sourceBytes: number;
  /** True when both paths are on the same volume. */
  sameFilesystem: boolean;
  /** Entries already in the target, excluding `.` and `..`. */
  targetEntries?: readonly string[];
}>): PgPreimagePlanV1 {
  const refuse = (reason: string, detail: string): PgPreimagePlanV1 => Object.freeze({
    schema: PG_PREIMAGE_CLONE_V1, status: "root_mkdir_then_clone_refused",
    rootSteps: Object.freeze([]), databaseAccountSteps: Object.freeze([]),
    preconditions: Object.freeze([]), copyArguments: Object.freeze([]),
    cloneVerdict: Object.freeze({ from: "", decision: "", neverFrom: Object.freeze([]) }),
    refusal: Object.freeze({ reason, detail }),
  });
  if (input.sourceHasPidFile)
    return refuse("preimage_source_has_a_postmaster",
      "postmaster.pid exists in the source, so a postmaster is running there; 8.2 requires launchctl bootout PG first and a verified clean shutdown, and a clone of a live cluster is not a snapshot");
  if (!/Database cluster state:\s*shut down\s*$/imu.test(input.controlDataClusterState))
    return refuse("preimage_source_not_cleanly_shut_down",
      `pg_controldata does not report "shut down" for the source: ${JSON.stringify(input.controlDataClusterState)}; 8.2 says the run stops before any effect`);
  if (!input.sameFilesystem)
    return refuse("preimage_not_on_one_filesystem",
      "the source and the target are on different volumes, so no clone is possible: clonefile(2) reports EXDEV, the preimage is a full copy, and 8.6's 3x reservation is mandatory");
  if ((input.targetEntries ?? []).length > 0)
    return refuse("preimage_target_not_empty",
      `the target already holds ${(input.targetEntries ?? []).length} entries; a recursive copy merges into a populated directory, which would give the preimage the union of two clusters`);
  if (input.freeBytes < input.sourceBytes)
    return refuse("preimage_insufficient_space_for_even_a_full_copy",
      `${input.freeBytes} bytes free is less than the ${input.sourceBytes} bytes the source occupies, so neither a clone nor a copy can complete`);
  return Object.freeze({
    schema: PG_PREIMAGE_CLONE_V1,
    status: "root_mkdir_then_clone_planned",
    rootSteps: Object.freeze([
      Object.freeze({ step: `mkdir ${input.targetDataDirectory}`, as: "root", mode: "0700" }),
      // lchown, never chown (R-FS): the path below pg/ is one _crdb can replace
      // with a symlink between the two calls, and chown follows symlinks.
      Object.freeze({ step: `lchown ${input.targetDataDirectory} <db-account>:<db-account>`,
        as: "root", mode: "0700" }),
    ]),
    databaseAccountSteps: Object.freeze([
      Object.freeze({ step: `cp -c -Rp ${input.sourceDataDirectory}/. ${input.targetDataDirectory}/`,
        as: "<db-account>" }),
    ]),
    preconditions: Object.freeze([
      "launchctl bootout PG has run (8.2 step 2) and the postmaster is gone",
      "postmaster.pid is absent",
      "pg_controldata reports: shut down",
      "the socket is closed and no service session remains in pg_stat_activity",
      "the target directory was created by root and lchowned to the database account, and is empty",
    ]),
    copyArguments: Object.freeze([
      // argv only — the program is NOT element 0. The caller passes the program
      // to execFile's first argument, so a list that included it here ran
      // `/bin/cp /bin/cp -R -p …` and every flag was treated as a filename.
      // That was MEASURED, and it is the reason this comment exists: a command
      // array that is "the command" and "the arguments" in one value is a
      // double-counted argv[0] away from being wrong in a way no type catches.
      //
      // NO `-c`. MEASURED, and the reason is the file header: `cp -c` falls back
      // to copyfile(2) and exits 0, so the flag cannot be the mechanism and
      // leaving it in tells a reader something false about how the preimage was
      // made. The clone, when the volume can do one, happens because the
      // filesystem is APFS — and that is proved by the sidecar, not requested
      // here.
      "-R", "-p",
      // The trailing /. on the source is what copies the CONTENTS, so the
      // target does not end up as data-B/data-A. Without it the preimage is a
      // directory containing a cluster, and pg/current would point at a
      // directory with no PG_VERSION in it.
      `${input.sourceDataDirectory}/.`, `${input.targetDataDirectory}/`,
    ]),
    cloneVerdict: Object.freeze({
      from: "clonefile(2) succeeding on a probe file, run by the reviewed sidecar in pg/",
      decision: "pgCloneReservationMultiplierV1(verdict) is the ONLY thing that relaxes 8.6's 3x reservation; the copy above is not evidence of anything",
      neverFrom: Object.freeze([
        "this argument list, which no longer asks cp to clone at all",
        "a free-space delta around the copy, which a concurrent deleter moves in either direction (MEASURED across 20 clones: -60,772,352 to +93,388,800 bytes)",
        "allocated-block ratios, which a sparse relation file makes meaningless",
        "a COW-divergence experiment, which a full copy passes as readily as a clone (MEASURED on APFS, FAT32 and ExFAT)",
      ]),
    }),
  });
}
