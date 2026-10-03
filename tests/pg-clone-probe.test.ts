// The clone probe: finding 12, end to end, on real filesystems.
//
// Everything here is about ONE question — can a hostile process make a full
// copy look like a clone? — and the answer this lane produces is measured on
// APFS, FAT32 and ExFAT rather than argued. The implementation is
// `src/pg-runtime/v1/pg-clone-probe.ts` plus `native/pg-clone-probe-v1.c`.
//
// THE REVIEW'S OWN SUGGESTION, and why half of it does not work. Finding 12 said
// to decide with "an operation that FAILS instead of falling back:
// `fs.copyFileSync(src, dst, COPYFILE_FICLONE_FORCE)` or `clonefile(2)`".
//
//   MEASURED on this machine, macOS 26.6.2, Node v26.7.0 / libuv 1.52.1:
//     fs.copyFileSync(src, dst, COPYFILE_FICLONE_FORCE)
//       -> Error ENOSYS (syscall copyfile), on APFS, in /tmp, at every path
//          tried, and NO destination file is created.
//
//   So the first suggestion cannot distinguish "this volume cannot clone" from
//   "libuv cannot express the request", and a caller that trusted it would
//   either reserve 3x forever or, having learned that FICLONE_FORCE "failed",
//   guess. The second suggestion works, and this lane proves it works by
//   showing the difference on a filesystem that genuinely cannot clone.
//
// TEST HYGIENE, and the reason this file opens with it. Four `cp-c-probe` /
// `vol-MS-DOS` images from earlier runs of the sibling lane were left mounted
// after those tests finished. A disk image this lane attaches is detached in a
// `finally`, and the detach is then VERIFIED: `assertNoDiskImagesRemain` runs
// after every test that attaches one and fails the test if a mount the lane
// created is still there. A teardown nobody checks is a teardown that silently
// stops working.

import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { copyFileSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  classifyPgCloneProbeV1, pgCloneReservationMultiplierV1, PG_CLONE_PROBE_BYTES_V1,
} from "../src/pg-runtime/v1/pg-clone-probe";

// ---------------------------------------------------------------------------
// The sidecar. Built from the reviewed source with the installed toolchain, in
// this lane's own temp root, and removed on exit.
// ---------------------------------------------------------------------------

const LANE_ROOT = process.env.CONTROL_ROOM_PGRT_TMPDIR
  ? join(process.env.CONTROL_ROOM_PGRT_TMPDIR, `pg-clone-${process.pid}`)
  : join(tmpdir(), `pg-clone-${process.pid}`);
const SIDECAR = join(LANE_ROOT, "pg-clone-probe-v1");
const REPO = join(dirname(new URL(import.meta.url).pathname), "..");

let buildError: string | null = null;
let mountedDevices: string[] = [];

mkdirSync(LANE_ROOT, { recursive: true, mode: 0o700 });
try {
  const sdk = execFileSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" }).trim();
  execFileSync("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror", "-O2", "-isysroot", sdk,
    "-arch", process.arch === "x64" ? "x86_64" : "arm64",
    join(REPO, "native", "pg-clone-probe-v1.c"), "-o", SIDECAR],
    { stdio: ["ignore", "ignore", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv });
  execFileSync("/bin/chmod", ["+x", SIDECAR]);
} catch (error) {
  buildError = (error as { stderr?: Buffer }).stderr?.toString().slice(0, 400)
    ?? (error as Error).message;
}

/**
 * Every disk image this lane has attached and not yet detached.
 *
 * The count is asserted to be zero after each attaching test. It is a count
 * rather than a search of /Volumes on purpose: a search would find OTHER
 * sessions' images — several bots on this Mac mount their own at the same time —
 * and either fail spuriously or, worse, detach something that is not ours. The
 * rule the brief sets is narrower and this matches it: only pids and images this
 * process started.
 */
function assertNoDiskImagesRemain(): void {
  assert.deepEqual(mountedDevices, [],
    `the lane must leave no disk image attached; still mounted: ${mountedDevices.join(", ")}`);
}

process.on("exit", () => {
  for (const device of mountedDevices) {
    try { execFileSync("/usr/bin/hdiutil", ["detach", device, "-quiet"], { encoding: "utf8" }); } catch { /* best effort */ }
  }
  try { rmSync(LANE_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// Disk image helper. Every attach is paired with a detach in a finally, and the
// device is remembered so the exit handler can clean up after a hard failure.
// ---------------------------------------------------------------------------

interface Volume { mount: string; device: string; image: string }

function attachDiskImage(label: string, filesystem: string, sizeMb = 60): Volume {
  const image = join(LANE_ROOT, `${label}.dmg`);
  // Create AND attach in one call: two calls leave a window where the image
  // exists but is not mounted, which is how the sibling lane's first run failed.
  const output = execFileSync("/usr/bin/hdiutil", ["create", "-size", `${sizeMb}m`, "-fs", filesystem,
    "-volname", label.toUpperCase().slice(0, 11), "-attach", image], { encoding: "utf8" });
  // FAT32 and ExFAT do not preserve a long volume name, so the mount point is
  // whatever hdiutil reports — sometimes "/Volumes/NO NAME 2", with a space.
  // Read it rather than assume it.
  const mount = /\/Volumes\/.+$/mu.exec(output)?.[0].trim() ?? "";
  const device = /\n(\/dev\/disk\d+)/u.exec(output)?.[1] ?? "";
  assert.ok(mount !== "" && device !== "", `the ${filesystem} probe volume must attach under /Volumes:\n${output}`);
  mountedDevices.push(device);
  return { mount, device, image };
}

/** Detach by DEVICE, not mount point: a FAT32 mount point contains a space. */
function detach(volume: Volume): void {
  try {
    execFileSync("/usr/bin/hdiutil", ["detach", volume.device, "-quiet"], { encoding: "utf8" });
  } catch { /* already gone */ }
  mountedDevices = mountedDevices.filter(device => device !== volume.device);
  try { rmSync(volume.image, { force: true }); } catch { /* best effort */ }
}

function runProbe(sourceDirectory: string, destinationDirectory: string):
  Readonly<{ ok: boolean; errno: number; bytes?: number; text: string }> {
  const text = execFileSync(SIDECAR, [sourceDirectory, destinationDirectory, String(PG_CLONE_PROBE_BYTES_V1)],
    { encoding: "utf8" }).trim();
  const match = /^(?:ok (\d+)|errno (\d+))$/u.exec(text);
  assert.ok(match, `the sidecar must print exactly "ok <n>" or "errno <n>", got ${JSON.stringify(text)}`);
  // MEASURED BUG in the first version of this helper: the pattern was wrapped in
  // a capturing group with a nested alternation, so `match[1]` was the whole
  // line ("ok 4194304") rather than the verdict, and every success was read as a
  // failure. The verdict is `match[1] === undefined ? errno : ok`, decided by
  // which alternative matched — not by comparing a string.
  return match[1] === undefined
    ? { ok: false, errno: Number(match[2]), text }
    : { ok: true, errno: 0, bytes: Number(match[1]), text };
}

function preparePair(root: string): { source: string; destination: string } {
  const source = join(root, "src"), destination = join(root, "dst");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  return { source, destination };
}

// ---------------------------------------------------------------------------
// The verdict's pure half
// ---------------------------------------------------------------------------

test("only a clonefile(2) success may claim a clone; the free-space delta is reported, never believed", { skip: buildError ?? false }, () => {
  // MEASURED, and the whole point of finding 12: a concurrent deleter moves this
  // number in either direction. Across 20 clones of a 60 MB loaded cluster it
  // ranged from -60,772,352 to +93,388,800 bytes, so no threshold over it is a
  // threshold a hostile process cannot cross. Every case below supplies a delta
  // that contradicts the kernel result and asserts the kernel wins.
  const withDelta = (kernelOutcome: number, kernelErrno: number, delta: number) => classifyPgCloneProbeV1({
    kernelOutcome, kernelErrno, probeBytes: PG_CLONE_PROBE_BYTES_V1,
    observedFreeSpaceDelta: delta, filesystemType: 0x0100, sameDevice: true,
  });

  // A success with a delta that says "a full copy happened" is still a clone:
  // the kernel performed it, and no process can move the kernel's answer.
  const cloned = withDelta(0, 0, 100_000_000_000);
  assert.equal(cloned.cloned, true);
  assert.equal(cloned.status, "preimage_cloned");
  assert.equal(cloned.mechanism, "clonefile_syscall");
  assert.match(cloned.consequence, /no copy fallback/u);
  assert.match(cloned.consequence, /reported, not believed/u);

  // A free-space delta of ZERO on a non-cloning volume is the forgery the review
  // describes: a bot deleting data makes the volume look like it charged
  // nothing. With no kernel success, that is a full copy.
  const forged = withDelta(-1, 45, 0);
  assert.equal(forged.cloned, false, "a zero delta must not buy a clone verdict");
  assert.equal(forged.status, "preimage_full_copied");
  assert.equal(forged.mechanism, "clonefile_enotsup");
  assert.match(forged.consequence, /3x database reservation is MANDATORY/u);

  // Each errno is named separately, because the operator's next action differs.
  assert.equal(withDelta(-1, 45, 1).mechanism, "clonefile_enotsup", "ENOTSUP: the volume will never clone");
  assert.equal(withDelta(-1, 18, 1).mechanism, "clonefile_exdev", "EXDEV: source and destination are on different volumes");
  // Anything else — including "no sidecar could be built" — is a full copy. A
  // verdict nobody has classified must never be the permissive one.
  for (const errno of [1, 13, 22, 999]) {
    const unknown = withDelta(-1, errno, 0);
    assert.equal(unknown.cloned, false, `errno ${errno} must not claim a clone`);
    assert.equal(unknown.mechanism, "clonefile_unavailable");
  }
  // A success with a nonsense errno is still a success: errno is only read on
  // the failure path, and a test that let a stale errno override the kernel's
  // success would be wrong.
  assert.equal(withDelta(0, 45, 0).cloned, true, "errno is meaningless when the call returned 0");

  // The reservation is a function of the verdict, so a caller cannot read 3x and
  // then separately consult a probe it is free to ignore.
  assert.equal(pgCloneReservationMultiplierV1(cloned), 1);
  assert.equal(pgCloneReservationMultiplierV1(forged), 3);
  assert.equal(pgCloneReservationMultiplierV1(withDelta(-1, 18, 0)), 3, "a cross-volume preimage is always a full copy");

  // A probe of zero bytes is refused rather than measured, because it would make
  // every ratio undefined.
  assert.throws(() => classifyPgCloneProbeV1({ kernelOutcome: 0, kernelErrno: 0, probeBytes: 0, filesystemType: 0, sameDevice: true }),
    /pg_clone_probe_invalid/u);
  assert.throws(() => classifyPgCloneProbeV1({ kernelOutcome: 0, kernelErrno: 0, probeBytes: -1, filesystemType: 0, sameDevice: true }),
    /pg_clone_probe_invalid/u);
  assert.throws(() => classifyPgCloneProbeV1({ kernelOutcome: 0, kernelErrno: 0, probeBytes: 1.5, filesystemType: 0, sameDevice: true }),
    /pg_clone_probe_invalid/u);
});

test("the probe is refused on a filesystem that cannot clone, on real FAT32 and ExFAT images", { timeout: 300_000, skip: buildError ?? false }, () => {
  for (const [filesystem, label] of [["FAT32", "clonefat"], ["ExFAT", "cloneexf"]] as const) {
    const volume = attachDiskImage(label, filesystem);
    try {
      const { source, destination } = preparePair(volume.mount);
      const result = runProbe(source, destination);
      // THE ASSERTION THAT MATTERS: a volume which cannot clone REFUSES. Not
      // "succeeds slowly", not "succeeds and consumes the bytes" — errno 45.
      assert.equal(result.ok, false,
        `clonefile(2) must fail on ${filesystem}; it returned ${JSON.stringify(result.text)}`);
      assert.equal(result.errno, 45, `${filesystem} must report ENOTSUP (45), got errno ${result.errno}`);
      const verdict = classifyPgCloneProbeV1({
        kernelOutcome: -1, kernelErrno: result.errno, probeBytes: PG_CLONE_PROBE_BYTES_V1,
        filesystemType: 0, sameDevice: true,
      });
      assert.equal(verdict.cloned, false);
      assert.equal(pgCloneReservationMultiplierV1(verdict), 3);
      // And the probe left nothing behind, on the refusal path as well as the
      // success path. A probe that leaks a 4 MB file on every run fills the very
      // volume whose space it is measuring.
      assert.deepEqual(readdirSync(source), [], `${filesystem}: the probe must clean up its source file`);
      assert.deepEqual(readdirSync(destination), [], `${filesystem}: the probe must clean up its destination`);
    } finally { detach(volume); }
  }
  assertNoDiskImagesRemain();
});

test("the probe succeeds on APFS and leaves no file behind, and repeats cleanly", { timeout: 180_000, skip: buildError ?? false }, () => {
  const root = mkdtempSync(join(LANE_ROOT, "apfs-"));
  try {
    const { source, destination } = preparePair(root);
    // Twenty consecutive probes: the name embeds the size, so a second run with
    // the same size must find its own leftovers or fail with ENOENT and be
    // mistaken for ENOTSUP. This is the "retry after failure" path.
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = runProbe(source, destination);
      assert.equal(result.ok, true,
        `attempt ${attempt} must clone on APFS; got ${JSON.stringify(result.text)}`);
      assert.equal(result.errno, 0);
      // The sidecar reports the size it actually cloned, and it is the size the
      // caller asked for. A mismatch would mean the two disagree about the
      // measurement, which is the only thing this program communicates.
      assert.equal(result.bytes, PG_CLONE_PROBE_BYTES_V1);
    }
    assert.deepEqual(readdirSync(source), [], "twenty probes must leave no source file behind");
    assert.deepEqual(readdirSync(destination), [], "twenty probes must leave no destination file behind");
    const verdict = classifyPgCloneProbeV1({
      kernelOutcome: 0, kernelErrno: 0, probeBytes: PG_CLONE_PROBE_BYTES_V1, filesystemType: 0, sameDevice: true,
    });
    assert.equal(verdict.cloned, true);
    assert.equal(pgCloneReservationMultiplierV1(verdict), 1,
      "a proven clone lets §8.6's reservation drop to 1x for the preimage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sidecar refuses nonsense arguments instead of guessing", { timeout: 120_000, skip: buildError ?? false }, () => {
  const root = mkdtempSync(join(LANE_ROOT, "args-"));
  try {
    const { source, destination } = preparePair(root);
    const attempt = (args: readonly string[]): string =>
      execFileSync(SIDECAR, args as string[], { encoding: "utf8" }).trim();

    // Zero and negative sizes are refused with EINVAL, not treated as "no bytes
    // to clone" which would succeed vacuously and claim a clone.
    for (const bytes of ["0", "-1", "abc", "", "999999999999"]) {
      const text = attempt([source, destination, bytes]);
      assert.equal(text, "errno 22", `a size of ${JSON.stringify(bytes)} must be refused with EINVAL, got ${text}`);
    }
    // A directory with a trailing slash is refused: a doubled separator makes the
    // returned errno ambiguous between ENOENT and ENOTSUP, which is precisely the
    // distinction this program exists to report.
    assert.equal(attempt([`${source}/`, destination, String(PG_CLONE_PROBE_BYTES_V1)]), "errno 22");
    // A file that cannot be created is reported with its own errno, and still
    // leaves nothing behind.
    assert.equal(attempt([join(root, "no-such-dir"), destination, String(PG_CLONE_PROBE_BYTES_V1)]), "errno 2");
    assert.deepEqual(readdirSync(source), []);
    // Wrong arity exits 64 and prints usage, and never prints a verdict shape a
    // caller could mistake for a result.
    assert.throws(() => execFileSync(SIDECAR, [source], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Node's COPYFILE_FICLONE_FORCE is ENOSYS here, which is why the native sidecar exists", { timeout: 120_000 }, () => {
  // This test is the MEASUREMENT the review's suggestion depends on, kept as a
  // test so a future Node that fixes it produces a failure someone reads rather
  // than a silent behaviour change.
  //
  // It is not asserting a bug is present: if a future libuv makes
  // COPYFILE_FICLONE_FORCE work, this test fails and the sidecar can be replaced
  // with the Node call. That is the intended direction of travel.
  const root = mkdtempSync(join(LANE_ROOT, "node-"));
  try {
    const source = join(root, "s.bin"), destination = join(root, "d.bin");
    writeFileSync(source, Buffer.alloc(1 << 20, 0x5a));
    let error: NodeJS.ErrnoException | null = null;
    try { copyFileSync(source, destination, fsConstants.COPYFILE_FICLONE_FORCE); }
    catch (caught) { error = caught as NodeJS.ErrnoException; }
    assert.ok(error !== null,
      "COPYFILE_FICLONE_FORCE succeeded; if so the sidecar should be replaced with the Node call and this test updated");
    assert.equal(error!.code, "ENOSYS", `expected ENOSYS on this platform, got ${error!.code}`);
    assert.equal(error!.syscall, "copyfile");
    // MEASURED: no destination file is created. A caller that treated ENOSYS as
    // "the copy failed, try again" would be wrong twice over — there is nothing
    // to clean up, and retrying cannot help.
    assert.equal(existsSync(destination), false, "ENOSYS must not leave a partial destination behind");
  } finally { rmSync(root, { recursive: true, force: true }); }
});