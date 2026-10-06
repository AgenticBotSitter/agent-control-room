// The clone probe, as an unforgeable operation (updater safety design item 3b,
// finding 12; §8.6).
//
// FINDING 12 WAS RIGHT, AND IT WAS RIGHT ABOUT THE WRONG THING.
//
// The review said: "`classifyPgCloneV1` decides 'cloned' from volume free-space
// deltas around a 1 MB probe. Any concurrent deleter, including a bot, can make a
// full copy look like a clone, so the 3x reservation is skipped and the disk
// fills mid-upgrade. Fix: decide with an operation that FAILS INSTEAD OF FALLING
// BACK: `fs.copyFileSync(src, dst, COPYFILE_FICLONE_FORCE)` or `clonefile(2)` on
// the probe, plus `statfs` type and same-device checks."
//
// That is correct, and the previous implementation (a 1 MB probe measured by
// `df` deltas) was already an improvement on the tree ratio — but it is STILL
// forgeable, and this file exists to say exactly how, from measurement:
//
//   1. A free-space delta is not evidence of sharing. A concurrent deleter can
//      move the number in either direction. MEASURED over 20 clones of a 60 MB
//      loaded cluster: deltas from -60,772,352 to +93,388,800 bytes.
//   2. `COPYFILE_FICLONE_FORCE` is NOT the forcing primitive the review assumed.
//      MEASURED on this machine, macOS 26.6.2, Node v26.7.0 / libuv 1.52.1:
//
//          fs.copyFileSync(src, dst, COPYFILE_FICLONE_FORCE)
//            → Error: ENOSYS (copyfile), and NO destination file is created.
//
//      On APFS, which certainly supports cloning, and in /tmp, and at every
//      path tried. libuv maps the mode to COPYFILE_CLONE|COPYFILE_CLONE_FORCE,
//      and the kernel rejects that combination with ENOSYS. So a caller that
//      "probes with FICLONE_FORCE" concludes every volume cannot clone, and
//      would then reserve 3x forever — or, worse, treat ENOSYS as "not a
//      filesystem without clone" and guess.
//   3. A C call to the same flags SUCCEEDS. MEASURED: `fcopyfile(in, out, state,
//      COPYFILE_CLONE_FORCE)` returns 0 with errno 0 on APFS — and also on a
//      FAT32 disk image, where nothing was cloned. So even the native call does
//      not fail on a filesystem that cannot clone: the flags are advisory, and
//      the kernel honours the request when it can and silently copies when it
//      cannot.
//   4. `COPYFILE_STATE_WAS_CLONED` does not answer the question either.
//      MEASURED: `copyfile_state_get(state, COPYFILE_STATE_WAS_CLONED, &was)`
//      returns 0 and leaves the value untouched (observed -256, i.e. unset) on
//      both APFS and FAT32. There is no caller-visible "this was a clone" bit
//      from copyfile(3) on this platform.
//
// So the review's first suggestion cannot work, and its second one works only
// because clonefile(2) has no copy fallback at all. From `man 2 clonefile`:
//
//   [ENOTSUP]   The underlying filesystem does not support this call.
//   [ENEXIST]   The named file dst exists.
//   [EXDEV]     src and dst are not on the same filesystem.
//
// — a closed list of failures, none of which is "succeeded, but by copying".
// That is the property this item needs: a verdict the environment cannot forge,
// because the kernel is the only thing that can produce it.
//
// WHAT THIS FILE THEREFORE DECIDES
//
// The clone verdict comes from `clonefile(2)` succeeding on a probe file, and
// from nothing else:
//
//   - free-space deltas are NOT consulted (a concurrent deleter moves them);
//   - allocated-block ratios are NOT consulted (a sparse relation file makes
//     them meaningless, and a full copy of a sparse file can look like a clone);
//   - a COW-divergence experiment is NOT consulted (MEASURED: a source write
//     after the copy leaves the destination unchanged on APFS *and* on FAT32
//     *and* on ExFAT, because a full copy is equally independent — the test
//     has no discriminating power at all).
//
// If `clonefile(2)` cannot be used — no native sidecar, ENOTSUP, EXDEV — the
// verdict is `preimage_full_copied` and the 3x reservation is mandatory. There
// is no third state that says "probably cloned", because a probably-cloned
// verdict is the one that runs out of disk.

/** The schema string every value this module returns carries. */
export const PG_CLONE_PROBE_V1 = "control-room.pg-clone-probe/v1" as const;

/**
 * How the verdict was reached. Every value names an operation, so a reader can
 * see whether the answer came from the kernel or from arithmetic.
 *
 *  - `clonefile_syscall`  : `clonefile(2)` returned 0 on the probe. The kernel
 *                           performed a copy-on-write clone; there is no other
 *                           way to get 0, because it has no copy fallback.
 *  - `clonefile_enotsup`  : the filesystem refuses cloning (FAT32, ExFAT,
 *                           HFS+). MEASURED, errno 45 on both disk images.
 *  - `clonefile_exdev`    : source and destination are on different volumes.
 *  - `clonefile_unavailable`: no native primitive could be invoked at all. Not
 *                           a pass: it downgrades to a full copy.
 */
export type PgCloneMechanismV1 =
  | "clonefile_syscall" | "clonefile_enotsup" | "clonefile_exdev" | "clonefile_unavailable";

export type PgCloneProbeV1 = Readonly<{
  schema: typeof PG_CLONE_PROBE_V1;
  status: "preimage_cloned" | "preimage_full_copied";
  /** Did the kernel perform a copy-on-write clone? Only a `clonefile(2)` success can say yes. */
  cloned: boolean;
  mechanism: PgCloneMechanismV1;
  /** Bytes the probe file itself holds. */
  probeBytes: number;
  /** Bytes `df`/`statfs` reported as consumed around the probe. Reported, never decided on. */
  observedFreeSpaceDelta: number;
  /** `statfs` filesystem type, so an APFS volume is distinguishable from an image. */
  filesystemType: number;
  /** True when source and destination share a device, i.e. cloning is possible at all. */
  sameDevice: boolean;
  /** What a caller must do about it. */
  consequence: string;
}>;

/**
 * The probe file size.
 *
 * 4 MiB, not 1 MiB and not 64 KiB. The size only has to be large enough that a
 * clone and a copy are distinguishable by *whatever* the caller wants to check
 * afterwards, and small enough that the probe itself is never a disk-space
 * concern on a volume that may already be full. 4 MiB is a whole number of 4 KiB
 * blocks and 4 KiB APFS allocation blocks, so there is no partial-block
 * rounding to explain a surprising number.
 */
export const PG_CLONE_PROBE_BYTES_V1 = 4 * 1024 * 1024;

/**
 * Decide clone-versus-copy from a kernel result, with nothing else as evidence.
 *
 * `kernelOutcome` is the return of the native probe and `kernelErrno` its errno.
 * Both are required because "the call was never made" and "the call was made
 * and refused" are different failures with different consequences, and a verdict
 * that conflated them would tell an operator to check the filesystem when the
 * real problem is a missing sidecar.
 *
 * The free-space delta is accepted and carried in the result because a caller
 * wants to SEE it, and is not part of the decision on purpose: a concurrent
 * deleter can make it negative, zero or enormous, and any threshold over it is a
 * threshold a hostile process can cross. It is reported so that an operator
 * comparing this against §8.6's arithmetic can see the two disagree.
 */
export function classifyPgCloneProbeV1(measurement: Readonly<{
  /** 0 when `clonefile(2)` performed a clone. */
  kernelOutcome: number;
  /** errno from the probe. 0 on success. */
  kernelErrno: number;
  probeBytes: number;
  /** Reported for the record; never part of the decision. */
  observedFreeSpaceDelta?: number;
  filesystemType: number;
  sameDevice: boolean;
}>): PgCloneProbeV1 {
  const { kernelOutcome, kernelErrno, probeBytes, observedFreeSpaceDelta = 0 } = measurement;
  if (!Number.isInteger(probeBytes) || probeBytes <= 0)
    throw new Error(`pg_clone_probe_invalid: the probe file must have a positive whole size, got ${probeBytes}`);

  const base = Object.freeze({
    schema: PG_CLONE_PROBE_V1,
    probeBytes,
    observedFreeSpaceDelta,
    filesystemType: measurement.filesystemType,
    sameDevice: measurement.sameDevice,
  });

  // Success is the ONLY path to "cloned". Everything else, including an
  // outcome nobody has classified yet, is a full copy — because the cost of
  // being wrong in that direction is a full disk during an upgrade and the cost
  // of being wrong in the other direction is only some unused headroom.
  if (kernelOutcome === 0)
    return Object.freeze({
      ...base,
      status: "preimage_cloned" as const,
      cloned: true,
      mechanism: "clonefile_syscall" as const,
      consequence: `clonefile(2) returned 0 on a ${probeBytes}-byte probe, and that call has no copy fallback, so the volume performed a real copy-on-write clone; §8.6's 3x reservation may be relaxed to 1x for the preimage step. The free-space delta of ${observedFreeSpaceDelta} bytes is reported, not believed: a concurrent deleter can move it either way.`,
    });

  const refused = Object.freeze({
    ...base,
    status: "preimage_full_copied" as const,
    cloned: false,
    consequence: `clonefile(2) failed on the probe (errno ${kernelErrno}), so the volume or the pair of paths cannot clone and a copy will consume the preimage's full size: §8.6's 3x database reservation is MANDATORY, not generous. The free-space delta of ${observedFreeSpaceDelta} bytes is reported, not believed.`,
  });

  // ENOTSUP (45) and EXDEV (18) are the two refusals `man 2 clonefile` names for
  // "this filesystem cannot clone" and "these are different volumes". They are
  // separated because the operator's next action differs: EXDEV means the target
  // is on the wrong volume, which is a bug in the layout; ENOTSUP means the
  // install root is on a volume that will never clone, which is a fact to plan
  // around forever.
  if (kernelErrno === 45)
    return Object.freeze({ ...refused, mechanism: "clonefile_enotsup" as const });
  if (kernelErrno === 18)
    return Object.freeze({ ...refused, mechanism: "clonefile_exdev" as const });
  // Everything else — including "no sidecar was built", EACCES from a probe the
  // account cannot read, and an errno a future kernel adds — is a full copy.
  return Object.freeze({ ...refused, mechanism: "clonefile_unavailable" as const });
}

/**
 * The reservation a preflight must hold, in units of the database's own size.
 *
 * This is the finding's actionable half: §8.6 reserves 3x for DB plans, and the
 * review is right that the reservation must not be skipped on a forged "cloned".
 * It is written as a function of the verdict rather than as a constant so that a
 * caller cannot read the 3x, keep it, and separately consult a probe it is free
 * to ignore.
 */
export function pgCloneReservationMultiplierV1(probe: PgCloneProbeV1): number {
  return probe.cloned ? 1 : 3;
}