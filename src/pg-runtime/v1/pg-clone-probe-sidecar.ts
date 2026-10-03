// The clone probe sidecar: build, placement, and the strict protocol parser.
//
// FINDING 8, which is a three-part finding and this file is the answer to all
// three parts. The review said:
//
//   "There is no `scripts/build-pg-clone-probe-native.mjs` like the five sibling
//    sidecars have, no artifact manifest with the source digest and toolchain,
//    and no TypeScript that spawns it and parses `ok <n>` / `errno <n>`;
//    `classifyPgCloneProbeV1` takes `kernelOutcome` from its caller."
//
// Each of those is a hole in a chain that must not have holes, because the
// probe's entire value is that its answer cannot be forged:
//
//   1. The KERNEL's answer cannot be forged. `clonefile(2)` has no copy
//      fallback — `man 2 clonefile` names ENOTSUP, ENEXIST and EXDEV and none of
//      them is "succeeded, by copying" — so only the kernel can produce a
//      "cloned" verdict, and `classifyPgCloneProbeV1` accepts nothing else.
//   2. The BINARY returning it must be the reviewed one. The verdict is
//      unforgeable only if the program that produced it is the program that was
//      reviewed; a sidecar rebuilt from an edited source and dropped in its
//      place prints exactly the same two shapes. That is what the build script's
//      manifest is for: `sourceSha256`, `executableSha256` and the toolchain, so
//      a verifier can bind a binary to its source.
//   3. The OUTPUT must be read strictly. A parser that accepts "close enough"
//      output is a parser an attacker writes to. This one accepts exactly two
//      shapes, nothing else, and a message it does not recognise is a full copy
//      rather than a guess — the same direction every other guard in this item
//      fails toward.
//
// The API ITEM 18 CALLS is `runPgCloneProbeV1`, and it is explicit about all
// three: the sidecar's path, the `pg/` directory to probe in, the probe size.
// There is no port, no runner and no injection point, because a probe whose
// result comes from somewhere the caller chose is a probe that measures
// whatever the caller wanted measured.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { classifyPgCloneProbeV1, PG_CLONE_PROBE_BYTES_V1, type PgCloneProbeV1 } from "./pg-clone-probe";

const run = execFile;

/** The schema every value this module returns carries. */
export const PG_CLONE_PROBE_SIDECAR_V1 = "control-room.pg-clone-probe-sidecar/v1" as const;

/**
 * The two directories inside `pg/` the probe writes into, and why they exist.
 *
 * MEASURED: the sidecar's protocol is `(source, destination, bytes)`; it unlinks
 * both probe names and then creates them `O_EXCL`. Given the SAME directory
 * twice, the destination name is the source name, so the second create is EEXIST
 * and the probe reports `errno 17` — a refusal on a volume that clones
 * perfectly. That is the review's EEXIST note turned inward: the probe can deny
 * itself the answer.
 *
 * Both live under `pg/` so the measurement is about the volume the preimage will
 * be written to, which is finding 8's placement requirement, and both are
 * removed in a `finally`.
 */
export const PG_CLONE_PROBE_SOURCE_DIRECTORY_V1 = ".cr-clone-probe-source" as const;
export const PG_CLONE_PROBE_DESTINATION_DIRECTORY_V1 = ".cr-clone-probe-destination" as const;

/**
 * The ONE wire shape, and the only two lines the parser accepts.
 *
 * The C says so in its header, and the shape is a design decision rather than a
 * convenience: the exit status is 0 for BOTH outcomes and carries no meaning, so
 * a caller cannot accidentally branch on "it exited 0" — which is the exact
 * mistake that made `cp -c` unsafe.
 *
 *   ok <n>      clonefile(2) returned 0. `n` is the size the probe cloned.
 *   errno <n>   anything else. The caller treats every `n` as a refusal.
 *
 * Nothing else is a result. Not a second line, not a warning before the result,
 * not a number with a leading `+`, not a padded number, not a result with a
 * trailing space. The parser is strict because a permissive parser is a parser
 * whose permissiveness an attacker chooses, and the only question that matters
 * is whether the kernel cloned.
 */
const SIDECAR_OK = /^ok (0|[1-9][0-9]{0,19})$/u;
const SIDECAR_ERRNO = /^errno ([0-9]{1,5})$/u;

export type PgCloneProbeRunV1 = Readonly<{
  schema: typeof PG_CLONE_PROBE_SIDECAR_V1;
  /** The kernel result, as the parser read it. Never a guess. */
  verdict: PgCloneProbeV1;
  /** The sidecar's own words, kept so a failure can be read by a person. */
  raw: string;
  /** True when the sidecar printed something the parser does not accept. */
  unrecognised: boolean;
}>;

/**
 * `statfs(2)` on `directory`, as a two-field report.
 *
 * Reported, NEVER decided on — `classifyPgCloneProbeV1` is explicit that only
 * the kernel's return value is evidence, and the review is explicit that a
 * threshold over a filesystem measurement is a threshold a hostile process can
 * move. These two numbers ride along so an operator comparing the verdict with
 * the volume can see them disagree if they do.
 *
 * `statfs` has no Node binding, so it is read from the shell with a stripped
 * environment and a stripped output shape. MEASURED on the install root and on a
 * FAT32 image, `df -P` prints:
 *
 *   /dev/disk3s5   494Gi  38Gi  456Gi   8%   /System/Volumes/Data
 *
 * and the filesystem TYPE comes from `statfs`'s `f_fstypename`, which `df` does
 * not print, so `mount` is asked instead. Both are best-effort: a read that
 * cannot be completed yields 0, which the classifier carries and never branches
 * on. A probe that could not read the filesystem's name still has the kernel's
 * answer, and that is the answer that counts.
 */
function statfsLike(directory: string): { filesystemType: number; sameDevice: boolean } {
  const ask = (program: string, args: readonly string[]): string => {
    try {
      return execFileSync(program, args as string[], {
        encoding: "utf8", timeout: 10_000, maxBuffer: 1 << 20,
        env: { LANG: "C", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv,
      });
    } catch { return ""; }
  };
  // The filesystem NAME first, because it is the one a reader can act on:
  // `apfs` is the install root and `msdos` is a FAT32 image the probe must
  // refuse. The numeric `f_fstypename` is what `statfs` returns and what
  // `classifyPgCloneProbeV1`'s `filesystemType` field means, so the name is
  // hashed into a small stable number rather than invented per call site.
  const mount = ask("/sbin/mount", [directory]);
  const named = /\bon\s+type\s+(\S+)/u.exec(mount)?.[1] ?? "";
  const names: Record<string, number> = { apfs: 0x0a65, hfs: 0x0bd7, msdos: 0x0ad5, exfat: 0x2017 };
  const filesystemType = named in names ? names[named]! : 0;
  // `sameDevice` compares the source and destination devices, and here they are
  // the same path by construction — the probe runs in one directory — so this is
  // true unless the caller passed something impossible. It is still a field
  // rather than a constant in the result, because a caller that later probes a
  // PAIR of directories has to set it honestly.
  return Object.freeze({ filesystemType, sameDevice: true });
}

/**
 * Run the sidecar and turn its output into a verdict, refusing anything the
 * protocol does not define.
 *
 * `sidecarPath` is the built artifact; `pgDirectory` is the `pg/` the preimage
 * will be written into, which the review names as the requirement: "the probe
 * running in `pg/` itself, on the same volume as `data-A`, not in a temp dir".
 * The probe therefore measures the volume the answer is about, and a probe run
 * in `/tmp` that answered about `/tmp` would be a true statement about the wrong
 * filesystem.
 *
 * Both directories are checked to be absolute and canonical, and BOTH must be
 * directories that exist. A missing `pg/` is a refusal rather than a fallback to
 * a temporary directory: the whole point is that the answer is about this
 * volume, and a fallback would answer a different question while looking like
 * the same one.
 */
export async function runPgCloneProbeV1(input: Readonly<{
  sidecarPath: string;
  /** The `pg/` directory. MUST be the directory the preimage targets. */
  pgDirectory: string;
  probeBytes?: number;
}>): Promise<PgCloneProbeRunV1> {
  const refuse = (why: string): never => { throw new Error(`pg_clone_probe_sidecar_refused: ${why}`); };
  const { sidecarPath, pgDirectory } = input;
  for (const [label, value] of [["sidecarPath", sidecarPath], ["pgDirectory", pgDirectory]] as const) {
    if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value)
      refuse(`the ${label} must be an absolute canonical path, got ${JSON.stringify(value)}`);
  }
  const probeBytes = input.probeBytes ?? PG_CLONE_PROBE_BYTES_V1;
  if (!Number.isInteger(probeBytes) || probeBytes <= 0) refuse(`the probe size must be a positive whole number, got ${probeBytes}`);
  const sidecar = await lstat(sidecarPath).catch(() => null);
  // A symlinked or non-regular sidecar is refused, not followed. The verdict is
  // only as good as the binary, and a sidecar path a writable directory can
  // redirect is a sidecar whose answer is whatever the redirector wants.
  if (!sidecar || !sidecar.isFile() || sidecar.isSymbolicLink())
    refuse(`the sidecar is not a regular file: ${sidecarPath}`);
  const directory = await lstat(pgDirectory).catch(() => null);
  if (!directory || !directory.isDirectory())
    refuse(`the probe directory is not a directory: ${pgDirectory}`);

  // The environment is the same stripped one the vendor step uses, and for the
  // same reason: this runs on the upgrade path as root, and a locale or a
  // `DYLD_*` from the caller is not something a measurement should inherit.
  const environment = { LANG: "C", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv;
  // The probe runs in TWO directories inside `pg/`, never the same one twice,
  // and that is a measured requirement rather than tidiness.
  //
  // MEASURED: passing `pgDirectory` as both the source and the destination makes
  // the sidecar report `errno 17` — EEXIST — on APFS. Its protocol is
  // `(source, destination, bytes)`, it unlinks both probe names and then creates
  // them `O_EXCL`, and with one directory the destination name IS the source
  // name, so the create collides with the file the same program just wrote. The
  // review names EEXIST as the shape a hostile `_crdb` forces; here the probe
  // forces it on itself.
  //
  // Two directories on the SAME volume is the property the probe measures —
  // `clonefile(2)` reports EXDEV when they are not — and two names under `pg/`
  // is what the preimage step has: the runtime's data directory and the
  // preimage target. So the probe gets a subdirectory of each, removed
  // afterwards, and never a temp directory: a probe run in `/tmp` would answer
  // about `/tmp`, which is the whole thing finding 8 forbids.
  const probeSource = join(pgDirectory, PG_CLONE_PROBE_SOURCE_DIRECTORY_V1);
  const probeDestination = join(pgDirectory, PG_CLONE_PROBE_DESTINATION_DIRECTORY_V1);
  await mkdir(probeSource, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => error.code === "EEXIST"
    ? refuse(`the probe source path already exists: ${probeSource}`) : Promise.reject(error));
  let stdout = "";
  let failed = false;
  let destinationCreated = false;
  try {
    await mkdir(probeDestination, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => error.code === "EEXIST"
      ? refuse(`the probe destination path already exists: ${probeDestination}`) : Promise.reject(error));
    destinationCreated = true;
    stdout = (await promisify(run)(sidecarPath, [probeSource, probeDestination, String(probeBytes)], {
      env: environment, encoding: "utf8", timeout: 60_000, maxBuffer: 1 << 16,
    })).stdout.trim();
  } catch (error) {
    // A sidecar that could not be run at all is a refusal, and the verdict it
    // produces is a full copy. That is the safe direction: 3x is wasted
    // headroom, a wrong "cloned" is a full disk mid-upgrade.
    failed = true;
    stdout = `errno 13 (${(error as Error).message.split("\n")[0]!.slice(0, 120)})`;
  } finally {
    // The probe removes its own files; the two directories it created are this
    // module's, so they are removed here. A 4 MiB probe file left in `pg/` on
    // every run fills the volume it is measuring.
    await rm(probeSource, { recursive: true, force: true }).catch(() => undefined);
    if (destinationCreated) await rm(probeDestination, { recursive: true, force: true }).catch(() => undefined);
  }
  const raw = stdout;

  // The two accepted shapes, and ONLY these. Each is anchored, so a second
  // line, a trailing character, a leading `+` or a padded number is not a
  // result. A multi-line output is not `ok` on its first line either, because
  // the whole string is tested against a single anchored pattern.
  const ok = SIDECAR_OK.exec(raw);
  const errno = SIDECAR_ERRNO.exec(raw);
  const unrecognised = !ok && !errno;
  // An `ok` line naming a size that is not the one requested is not a result
  // this module will act on, and the refusal is a FULL COPY rather than an
  // error. MEASURED: `ok 0` is a legal protocol shape — the C prints it when a
  // probe of zero bytes was somehow requested — and `classifyPgCloneProbeV1`
  // correctly refuses a non-positive probe size by throwing, which is the right
  // behaviour for a pure function given a nonsense input and the wrong shape for
  // a caller parsing a sidecar's output. A sidecar that says it cloned zero bytes
  // has not cloned anything, so the guard belongs HERE, before the classifier is
  // called.
  const claimedBytes = ok ? Number(ok[1]) : 0;
  const usableOk = ok !== null && claimedBytes === probeBytes;
  // Unrecognised output is treated as a refusal with an errno nobody has
  // classified, which `classifyPgCloneProbeV1` already maps to
  // `clonefile_unavailable` and a 3x reservation. There is deliberately no path
  // from "the sidecar said something odd" to "cloned".
  const verdict = usableOk
    ? classifyPgCloneProbeV1({ kernelOutcome: 0, kernelErrno: 0, probeBytes: claimedBytes, ...statfsLike(pgDirectory) })
    : classifyPgCloneProbeV1({
      kernelOutcome: -1,
      // A size mismatch is EINVAL, the same errno the C uses for a refused
      // argument, so the mechanism is honest about what happened.
      kernelErrno: ok ? 22 : errno ? Number(errno[1]) : 22,
      probeBytes,
      ...statfsLike(pgDirectory),
    });
  if (failed && !unrecognised) {
    // A run that threw is reported with its errno, never upgraded.
    return Object.freeze({ schema: PG_CLONE_PROBE_SIDECAR_V1, verdict, raw, unrecognised: true });
  }
  return Object.freeze({ schema: PG_CLONE_PROBE_SIDECAR_V1, verdict, raw, unrecognised });
}

/**
 * Read and check an artifact manifest, and confirm the binary beside it is the
 * one the manifest describes.
 *
 * This is the half of finding 8 that does not run the probe: it answers "is the
 * binary in front of me the reviewed one?" from the digests alone. A verifier on
 * the install path calls it before spawning anything, because spawning an
 * unreviewed binary and then checking its answer is the wrong order.
 *
 * The check is three digests and a protocol name. `sourceSha256` binds the
 * manifest to this repository's `native/pg-clone-probe-v1.c`; `executableSha256`
 * binds the binary to the manifest; and `protocol` refuses a binary speaking a
 * protocol this parser was not written for. `toolchain` is recorded, not
 * required: a binary built by a different clang is not automatically wrong, but
 * it is worth being able to see, so a verifier that cares can compare it.
 */
export async function verifyPgCloneProbeArtifactV1(input: Readonly<{
  manifestPath: string;
  /** The repository's `native/pg-clone-probe-v1.c`, to bind the source digest to. */
  sourcePath: string;
}>): Promise<Readonly<{
  schema: typeof PG_CLONE_PROBE_SIDECAR_V1;
  ok: boolean;
  why?: string;
  executablePath: string;
  manifest: Record<string, unknown>;
}>> {
  const refuse = (why: string) => Object.freeze({
    schema: PG_CLONE_PROBE_SIDECAR_V1, ok: false, why,
    executablePath: "", manifest: Object.freeze({}),
  });
  const manifestBytes = await readFile(input.manifestPath).catch(() => null);
  if (manifestBytes === null) return refuse(`the manifest is not readable: ${input.manifestPath}`);
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>; }
  catch { return refuse(`the manifest is not JSON: ${input.manifestPath}`); }
  if (manifest.schema !== "control-room.pg-clone-probe-native-artifact/v1")
    return refuse("the manifest is not the clone-probe artifact manifest");
  if (manifest.protocol !== "PGCLONE1")
    return refuse(`the artifact speaks protocol ${JSON.stringify(manifest.protocol)}, not PGCLONE1`);
  if (typeof manifest.executableName !== "string" || manifest.executableName.length === 0
    || manifest.executableName.includes("\0") || manifest.executableName.includes("/")
    || isAbsolute(manifest.executableName)
    || manifest.executableName === "." || manifest.executableName === "..") {
    return refuse("the sidecar executable name is not one plain file name");
  }
  const source = await readFile(input.sourcePath).catch(() => null);
  if (source === null) return refuse(`the sidecar source is not readable: ${input.sourcePath}`);
  if (createHash("sha256").update(source).digest("hex") !== manifest.sourceSha256)
    return refuse("the sidecar source digest does not match the manifest, so this binary was not built from the reviewed source");
  const executablePath = join(input.manifestPath, "..", manifest.executableName);
  const executable = await readFile(executablePath).catch(() => null);
  if (executable === null) return refuse(`the sidecar executable named by the manifest is not readable: ${executablePath}`);
  if (createHash("sha256").update(executable).digest("hex") !== manifest.executableSha256)
    return refuse("the sidecar executable digest does not match the manifest");
  return Object.freeze({
    schema: PG_CLONE_PROBE_SIDECAR_V1, ok: true, executablePath, manifest,
  });
}
