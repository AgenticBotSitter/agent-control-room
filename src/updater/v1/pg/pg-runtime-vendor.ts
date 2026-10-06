// The PostgreSQL runtime copy, as an item-3-style vendor step that really runs
// (updater safety design item 3b, finding 6; §3, §4, §16 #6).
//
// The previous cut of this item shipped planners only: `planPgRuntimeCopyV1`
// decided which archive entries were allowed, `selectPgRuntimeSourceV1` decided
// (a) versus (b), and nothing downloaded, extracted, wrote a manifest or proved
// anything. Every real test ran Homebrew's `postgres`, so the design's central
// claim — that option (a) yields a working server from a root-owned tree — had
// never been executed. Finding 6 is right about both halves:
//
//   1. The allow-list as specified could not produce a working server.
//      `share/` and `lib/postgresql/` were excluded on the theory that
//      "extensions load from the cluster's pkglibdir". That is true of
//      *pkglibdir* and false of the two directories the review names, and the
//      distinction is what makes the difference between a cluster that starts
//      and one that cannot:
//        - `initdb` reads `share/postgresql/postgres.bki`. Without it there is
//          no catalog, so initdb cannot finish at all.
//        - `timezone = 'UTC'` resolves through `share/postgresql/timezone/`.
//        - `plpgsql` (which initdb itself creates) is `lib/postgresql/plpgsql.dylib`.
//        - `dict_snowball` is `lib/postgresql/dict_snowball.dylib` plus
//          `share/postgresql/snowball_create.sql`.
//
//      MEASURED against the 17.11 archive's central directory: `share/postgresql`
//      is 917 entries / 2,283,773 bytes, and `lib/postgresql/*.dylib` is 88
//      files / 17,875,776 bytes. Both are small, and both are required.
//
//   2. PostgreSQL finds `sharedir` and `pkglibdir` RELATIVE TO ITS OWN BINARY,
//      not per cluster. So they must ship inside the runtime next to `bin/`, and
//      the runtime is what has to carry them.
//
// THE ARCHIVE, PINNED
//
//   postgresql-17.11-4-osx-binaries.zip, 437,510,312 bytes
//     sha256 a61d220546ae10517db8e688d10c06fc3ac639ab0242b92f7b81aa0913da422f
//
// Measured on this machine, macOS 26.6.2, arm64, from the downloaded bytes:
//   - 24,676 entries, all under `pgsql/`; 20,459 regular files, 4,139
//     directories, 78 symlinks. EVERY symlink is inside `pgAdmin 4.app` or
//     `stackbuilder.app`, neither of which is allow-listed, so the allow-list
//     region contains no symlink at all.
//   - The unversioned libraries are NOT symlinks. `pgsql/lib/libssl.dylib` is a
//     regular file with the same size and the same bytes as `libssl.3.dylib`.
//     The previous report recorded them as symlinks; they are duplicates, and
//     the copy still needs them because `@rpath/libssl.dylib` is what
//     `postgres` actually names.
//   - `pgsql/etc/openssl.cnf` exists in the archive and is still excluded: the
//     runtime's OpenSSL config is written by us, empty and fixed (R9b).
//
// SHA SOURCE, stated honestly: EDB publishes no sidecar checksum
// (`…zip.sha256` and `…zip.sha256sum` both return S3 AccessDenied — measured),
// so the pin is a digest of what this machine downloaded and the provenance
// recorded beside it is the server's own `ETag` and `Last-Modified`. That is
// weaker than a publisher-signed digest and is why the runtime manifest records
// `archiveSha256` against a file whose own bytes were verified after download.

import { createHash } from "node:crypto";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { constants as fsConstants, readFileSync } from "node:fs";
import {
  chmod, lchmod, lchown, lstat, mkdir, open, readdir, rename, rm, writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  classifyPgRuntimeArchiveEntryV1, PG_RUNTIME_REQUIRED_LIBRARY_FLOOR_V1,
} from "./pg-runtime-copy.ts";

/** The schema string every value this module returns carries. */
export const PG_RUNTIME_VENDOR_V1 = "control-room.pg-runtime-vendor/v1" as const;

/**
 * The pin. `sourceArchiveSha256` is REQUIRED here, not optional: an item-3
 * vendor step whose digest is optional is a step that can run against whatever
 * was in the download folder, which is the exact race the digest exists to stop.
 */
export type PgRuntimePinV1 = Readonly<{
  schema: typeof PG_RUNTIME_VENDOR_V1;
  /** The archive's own version, e.g. `17.11`. */
  version: string;
  /** `postgresql-17.11-4-osx-binaries.zip` */
  archiveName: string;
  url: string;
  /** REQUIRED. Lowercase hex, 64 characters. */
  archiveSha256: string;
  archiveBytes: number;
  /**
   * REQUIRED. The Developer ID Team Identifier every Mach-O in the archive must
   * be signed by, and the publisher check the digest is not.
   *
   * FINDING 9. The digest is of bytes this Mac downloaded and EDB publishes no
   * sidecar checksum for this archive (MEASURED: `…zip.sha256` and
   * `…zip.sha256sum` both return S3 AccessDenied), so a pin bump is a source
   * change that can carry any archive at all. A signature cannot: re-packing a
   * Developer ID signed binary invalidates its seal, and an attacker cannot mint
   * EDB's Team Identifier.
   *
   * MEASURED on the pinned 17.11 archive — `codesign -dv --verbose=4` on
   * `bin/postgres`, `bin/initdb` and `lib/libssl.3.dylib` all report
   * `TeamIdentifier=26QKX55P9K` and `Identifier=com.edb.postgresql`, and
   * `codesign --verify --strict` exits 0 on each.
   */
  teamIdentifier: string;
  /** Where the vendor expects the archive to already be, for provenance. */
  provenance: Readonly<{ etag: string | null; lastModified: string | null }>;
}>;

/**
 * The pinned PostgreSQL runtime this item vendors.
 *
 * The digest was computed from the archive downloaded to this machine on
 * 2026-09-30 from the URL below, and re-verified after extraction. EDB
 * publishes no sidecar digest for this file, so the pin cannot be cross-checked
 * against the publisher; `provenance` records what the origin server said, and
 * the runtime manifest records the digest of the file that was actually opened.
 */
function pgRuntimePinFromInventoryV1(): PgRuntimePinV1 {
  const inventory = JSON.parse(readFileSync(
    new URL("../policy/runtime-inventory.json", import.meta.url), "utf8")) as {
      schema?: unknown;
      artifacts?: Array<Record<string, unknown>>;
    };
  const artifact = inventory.schema === "control-room.runtime-inventory/v1"
    ? inventory.artifacts?.find(value => value.tool === "postgresql") : undefined;
  if (!artifact) throw new Error("pg_runtime_vendor_refused: runtime inventory has no PostgreSQL artifact");
  return validatePgRuntimePinV1({
    schema: PG_RUNTIME_VENDOR_V1,
    version: artifact.version,
    archiveName: artifact.archiveName,
    url: artifact.url,
    archiveSha256: artifact.archiveSha256,
    archiveBytes: artifact.archiveBytes,
    teamIdentifier: artifact.teamIdentifier,
    provenance: artifact.provenance,
  });
}

/** The PostgreSQL pin is a reader of the one checked-in runtime inventory. */
export const PG_RUNTIME_PIN_V1: PgRuntimePinV1 = pgRuntimePinFromInventoryV1();

/**
 * Refuse a pin that cannot be a pin.
 *
 * Every field is checked rather than trusted because this value is what stands
 * between "the archive we reviewed" and "whatever is in the download folder on
 * install night". An absent or malformed digest is a refusal, not a default —
 * which is the change from the earlier type, where `sourceArchiveSha256` was
 * optional and unset.
 */
export function validatePgRuntimePinV1(pin: unknown): PgRuntimePinV1 {
  const refuse = (why: string): never => { throw new Error(`pg_runtime_vendor_refused: ${why}`); };
  if (typeof pin !== "object" || pin === null) return refuse("the pin is not an object");
  const value = pin as Record<string, unknown>;
  if (value.schema !== PG_RUNTIME_VENDOR_V1) return refuse("the pin's schema is not the vendor schema");
  if (typeof value.version !== "string" || !/^\d+\.\d+$/u.test(value.version))
    return refuse(`the version must be <major>.<minor>, got ${JSON.stringify(value.version)}`);
  if (typeof value.archiveName !== "string" || !/^postgresql-[\d.]+-\d+-osx-binaries\.zip$/u.test(value.archiveName))
    return refuse(`the archive name must be the macOS binaries zip, got ${JSON.stringify(value.archiveName)}`);
  if (typeof value.url !== "string" || !/^https:\/\//u.test(value.url))
    return refuse(`the archive must come over https, got ${JSON.stringify(value.url)}`);
  if (value.url.endsWith("/") || value.url.includes(".."))
    return refuse("the archive URL must be a plain file URL with no traversal");
  // The one the review made required.
  if (typeof value.archiveSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.archiveSha256))
    return refuse(`archiveSha256 is REQUIRED and must be 64 lowercase hex characters, got ${JSON.stringify(value.archiveSha256)}`);
  if (!Number.isInteger(value.archiveBytes) || (value.archiveBytes as number) <= 0)
    return refuse(`archiveBytes must be a positive whole number, got ${JSON.stringify(value.archiveBytes)}`);
  // Finding 9's second half: the Team Identifier is REQUIRED and is the shape
  // Apple gives one — ten uppercase alphanumerics. MEASURED: EDB's is
  // `26QKX55P9K`. A loose pattern would accept a lowercase or short string and
  // then compare it against what `codesign` reports, which is the failure this
  // check exists to make impossible.
  if (typeof value.teamIdentifier !== "string" || !/^[0-9A-Z]{10}$/u.test(value.teamIdentifier))
    return refuse(`teamIdentifier is REQUIRED and must be 10 uppercase alphanumerics, got ${JSON.stringify(value.teamIdentifier)}`);
  return Object.freeze({
    schema: PG_RUNTIME_VENDOR_V1,
    version: value.version,
    archiveName: value.archiveName,
    url: value.url,
    archiveSha256: value.archiveSha256,
    archiveBytes: value.archiveBytes as number,
    teamIdentifier: value.teamIdentifier,
    provenance: Object.freeze({
      etag: typeof (value.provenance as { etag?: unknown })?.etag === "string" ? (value.provenance as { etag: string }).etag : null,
      lastModified: typeof (value.provenance as { lastModified?: unknown })?.lastModified === "string" ? (value.provenance as { lastModified: string }).lastModified : null,
    }),
  });
}

/**
 * What the runtime must contain for `initdb` and the server to work, as a FLOOR
 * over paths relative to the runtime root.
 *
 * The two directories finding 6 names are here, and the reason each entry is
 * load-bearing is recorded next to it. Everything else in the allow-list is
 * permitted but not required, so a future archive that ships an extra
 * dictionary is not a refusal.
 */
export const PG_RUNTIME_REQUIRED_PATHS_V1 = Object.freeze([
  "bin/postgres", "bin/initdb", "bin/pg_ctl", "bin/pg_controldata",
  // initdb builds the catalog from this file. Without it, `initdb` fails with
  // "could not open file .../share/postgresql/postgres.bki" and no cluster is
  // ever created.
  "share/postgresql/postgres.bki",
  // `timezone = 'UTC'` (a GUC the design pins) is resolved through this
  // directory; with it absent the server cannot answer a timestamp.
  "share/postgresql/timezone",
  // plpgsql is created by initdb itself, so this is not optional "extension"
  // functionality -- it is part of making a cluster.
  "lib/postgresql/plpgsql.dylib",
  // The proof the design asks for, and the reason the allow-list is extended at
  // all: `CREATE EXTENSION dict_snowball` needs this dylib and
  // share/postgresql/snowball_create.sql.
  "lib/postgresql/dict_snowball.dylib",
  "share/postgresql/snowball_create.sql",
] as readonly string[]);

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const UNZIP = "/usr/bin/unzip";
/**
 * `unzip` and `chflags`/`chmod` are spawned with a stripped environment on
 * purpose: this is a root-run step, and a PG-family or Node process must never
 * inherit the caller's locale, PATH or library overrides (R9b, §4). Cast
 * through `Record<string, string>` rather than adding `NODE_ENV`, because no
 * node process runs here and inventing one would put a variable in front of a
 * real tool that production would never set.
 */
const SAFE_ENVIRONMENT = Object.freeze({ LANG: "C", LC_ALL: "C" }) as unknown as NodeJS.ProcessEnv;
/** `unzip` is told to list only what we selected; nothing else is ever named. */
const MAX_ARCHIVE_ENTRIES = 40_000;

/**
 * How many bytes the SELECTED archive members may inflate to, and why the number
 * is what it is.
 *
 * FINDING 10. The entry count and the listing's own output were both capped, but
 * nothing bounded the inflated size of the members the allow-list selects, so a
 * pinned archive carrying a bomb inside `share/postgresql/**` fills the install
 * root while every other check passes.
 *
 * MEASURED against the pinned 17.11 archive with the allow-list as it stands
 * after finding 6's closed list: 1,073 selected members, 326,552,493
 * uncompressed bytes; the whole archive inflates to 1,188,102,308. The ceiling
 * is 1 GiB — about 3.1x the selected region and below the whole archive, so it
 * cannot refuse an honest PG 17.x build whose allow-listed region is what it is
 * today, and it caps a bomb inside the allow-listed paths at a third of a
 * terabyte rather than at "whatever the disk had".
 *
 * A pin bump that legitimately doubles the runtime does not need this raised
 * silently: it needs the number re-measured with
 * `scripts/dev/pgrt-measure-archive.mts` and the reasoning rewritten, which is
 * why that script exists and why the measurement is quoted here.
 */
export const PG_RUNTIME_MAX_UNCOMPRESSED_BYTES_V1 = 1_073_741_824;

export type PgRuntimeVendorResultV1 = Readonly<{
  schema: typeof PG_RUNTIME_VENDOR_V1;
  status: "pg_runtime_vendored" | "pg_runtime_vendor_refused";
  runtimeDirectory: string;
  /** Files written, relative to the runtime root, sorted. */
  files: readonly string[];
  /** sha256 per file, the manifest item 3 names. */
  fileDigests: ReadonlyArray<Readonly<{ path: string; sha256: string; bytes: number }>>;
  /** The libraries the server's own images resolved to, all inside the runtime. */
  dependencies: readonly string[];
  /** The manifest path written, relative to the runtime root. */
  manifestPath: string;
  archiveSha256: string;
  /** Set when the refusal happened, in words a person can act on. */
  refusal?: string;
}>;

export type PgRuntimeVendorHooksV1 = Readonly<{
  /**
   * Called after the archive has been copied into staging and hashed, and before
   * extraction. The reason it exists is the review's 1b: a download directory is
   * owner-writable, so the archive must be read exactly once, from a copy this
   * process made, and every later step must use that copy.
   */
  afterArchiveSnapshot?: (pin: PgRuntimePinV1) => Promise<void>;
  /**
   * Called with each `unzip` argv before it runs. The test lane asserts the
   * allow-list actually reached the extractor, which is the only way to catch a
   * classifier change that never gets exercised end to end.
   */
  observeExtract?: (arguments_: readonly string[]) => void;
  /**
   * Called after every selected member has been moved into place and before the
   * post-write `lstat` check, with the staging root.
   *
   * It exists for ONE reason: the post-write check refuses a member that is not
   * a regular file with one link, and no archive can produce that state — a
   * symlink is visible in the central directory and is refused earlier, and
   * `zip(1)` plus `unzip` turn a hard link into two independent files. So without
   * this hook the check is unreachable from a test, and an unreachable guard is
   * a guard nobody has run.
   *
   * It is the review's "what if the extractor is replaced" case made testable:
   * a substitution between the move loop and the check is precisely where a
   * replaced extractor would do its work, and the check is what notices.
   */
  afterMembersMoved?: (staging: string) => Promise<void>;
  /** Test-only crash boundary after the sealed tree becomes the final path. */
  afterDestinationRename?: (destination: string) => Promise<void>;
  /**
   * Set to false in tests to skip the ownership normalisation, which needs a uid
   * the test process may not have. It is a TEST HOOK and the production path
   * never sets it: a runtime that skipped the chown would be root-writable by
   * the account, which is the finding the review raises as item 1.
   */
  normaliseOwnership?: boolean;
  /** Override the uid/gid used by the chown. Defaults to 0:0. */
  ownership?: Readonly<{ uid: number; gid: number }>;
}>;

const refuse = (why: string): never => { throw new Error(`pg_runtime_vendor_refused: ${why}`); };

function run(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    // `stdio: ["ignore", "pipe", "pipe"]` is what makes the child a
    // ChildProcessByStdio with readable stdout/stderr and no stdin, which is
    // the shape the append handlers below need. Typed explicitly because the
    // overload that also demands a ProcessEnv resolves to `never` here.
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(file, args, {
      env: SAFE_ENVIRONMENT, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", size = 0;
    // The listing of a 24,676-entry archive is bounded here rather than
    // unbounded, because this is a root-run process reading a file that a
    // download folder produced.
    const append = (current: string, chunk: Buffer): string => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) { child.kill("SIGKILL"); reject(new Error("pg_runtime_vendor_output_limit")); }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    child.once("close", (code: number | null) => code === 0
      ? resolvePromise({ stdout, stderr })
      : reject(new Error(`pg_runtime_vendor_command_failed:${code}:${stderr.trim().slice(0, 400)}`)));
  });
}

/**
 * Is this file a Mach-O image, and therefore something a signature can apply to?
 *
 * FINDING 9 runs `codesign` only on images, because `codesign` on a data file
 * refuses for a reason that has nothing to do with the publisher: a
 * `postgres.bki` or a `.sql` is not signed, and treating that as a signature
 * failure would refuse the pinned archive.
 *
 * The check is the first four bytes, read through `O_NOFOLLOW` so a symlink
 * cannot make it answer about a different file. The magics are the four Mach-O
 * and FAT headers:
 *
 *   FEEDFACE  32-bit Mach-O     CFFAEDFE  64-bit Mach-O (byte-swapped)
 *   CEFAEDFE  32-bit Mach-O     FEEDFACF  64-bit Mach-O
 *   CAFEBABE  universal (FAT)  BEBAFECA  universal, byte-swapped
 *
 * MEASURED: the EDB `postgres` is a universal binary and reports
 * `Format=Mach-O universal (x86_64 arm64)`, so the FAT magic is the one that
 * actually fires for it; the thin ones are covered so a future single-arch
 * archive is not silently skipped.
 */
async function isMachO(path: string): Promise<boolean> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null);
  if (handle === null) return false;
  try {
    const header = Buffer.allocUnsafe(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    if (bytesRead !== 4) return false;
    return MACH_O_MAGICS.has(header.readUInt32BE(0));
  } finally { await handle.close(); }
}

const MACH_O_MAGICS = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

/**
 * `codesign --verify --strict` on one image, plus the Team Identifier it
 * reports.
 *
 * Two properties, both required, and both from the review:
 *
 *   - `--strict`. Without it `codesign` accepts a resource- or seal-only
 *     mismatch, which is the case a re-packed archive most easily produces.
 *   - the Team Identifier, COMPARED against the pin. `--verify` alone only says
 *     "some valid signature", and a valid signature from any Developer ID is not
 *     EDB's. The identifier is read from `--verbose=4` on stderr, which is where
 *     `codesign` writes it, and the parse is anchored so a signature with no
 *     identifier (an ad-hoc one) reports "" rather than the previous match.
 *
 * The output is checked and not only the exit status: a zero exit with text on
 * stderr means the tool complained and succeeded, and a refusal that ignores
 * that is a refusal with a hole in it.
 */
async function verifyCodeSignature(path: string): Promise<
  Readonly<{ ok: boolean; teamIdentifier: string; why: string }>
> {
  const refusal = (why: string) => Object.freeze({ ok: false, teamIdentifier: "", why });
  // TWO codesign calls, and the reason is MEASURED: `--verify` does not print the
  // Team Identifier, and `--verbose=4` on `-dv` does. Asking for both in one call
  // looked economical and was wrong twice over — `--verify --verbose=4` prints
  // "valid on disk" on SUCCESS, so a rule that refused on any stderr would refuse
  // every correctly signed image, and `-dv --verify` does not verify at all.
  //
  // So the exit status comes from the call that verifies, and the identifier comes
  // from the call that describes. Neither is read off the other.
  try {
    await run("/usr/bin/codesign", ["--verify", "--strict", path]);
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith("pg_runtime_vendor_command_failed:")) {
      const parts = message.split(":");
      return refusal(`codesign exited ${parts[1]}: ${parts.slice(2).join(":").trim().slice(0, 200)}`);
    }
    return refusal(message.slice(0, 200));
  }
  let described: { stdout: string; stderr: string };
  try {
    // `--verbose=4` prints the whole CodeDirectory description, and `run` keeps
    // only the first 400 characters of stderr in its failure message — which is
    // shorter than the distance to `TeamIdentifier=`. MEASURED: the first
    // version truncated the identifier away and reported "" for a correctly
    // signed image. The description is read through a dedicated call with its own
    // budget rather than through `run`, and the budget is the size of a real
    // `codesign -dv --verbose=4` output with room to spare.
    described = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
      const child: ChildProcessByStdio<null, Readable, Readable> = spawn("/usr/bin/codesign",
        ["-dv", "--verbose=4", path], { env: SAFE_ENVIRONMENT, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      // A spawn error is a refusal; a non-zero exit is NOT, because `-dv` exits
      // non-zero on success. Both resolve, and the output is what is read.
      child.once("error", reject);
      child.once("close", () => resolvePromise({ stdout, stderr }));
    });
  } catch (error) {
    return refusal(`codesign could not describe ${path}: ${(error as Error).message.slice(0, 200)}`);
  }
  // The identifier, read from the description.
  //
  // MEASURED, and this is the shape of the answer: an ad-hoc signature makes
  // `codesign -dv --verbose=4` print `TeamIdentifier=not set`, not an absent
  // line. Carried through as the empty string, so it fails the comparison against
  // any real ten-character pin — which is the correct outcome and the reason a
  // strip of `TeamIdentifier=` values has to be normalised rather than compared
  // raw.
  const teamIdentifier = /^TeamIdentifier=(.*)$/mu.exec(`${described.stdout}\n${described.stderr}`)?.[1]?.trim() ?? "";
  const identifier = teamIdentifier === "not set" ? "" : teamIdentifier;
  // A description that names no identifier AND no format is not something this
  // module can reason about, so it is a refusal. A description that names the
  // format but no Team Identifier is an ad-hoc signature, which is a real answer
  // and is carried through to the comparison as "".
  if (identifier === "" && !/^Format=/mu.test(`${described.stdout}\n${described.stderr}`))
    return refusal("codesign described the image without naming a format or an identifier");
  return Object.freeze({ ok: true, teamIdentifier: identifier, why: "" });
}

async function sha256File(path: string): Promise<string> {
  const input = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally { await input.close(); }
}

/**
 * Copy the archive into root-only staging, once, through file descriptors.
 *
 * This is the fix for the review's finding 1b in the shape this item needs. The
 * archive lives in a download folder the owner can write, so it is read a single
 * time, through O_NOFOLLOW, into a file this process created with O_EXCL. Every
 * later step — the digest, the listing, the extraction — reads THAT copy, so a
 * bot that swaps the download mid-vendor changes a file nothing else looks at.
 */
async function snapshotArchiveOnce(source: string, destination: string): Promise<{ bytes: number; sha256: string }> {
  const input = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    .catch(() => refuse(`the archive is not readable as a regular file: ${source}`));
  const output = await open(destination, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
    .catch(() => refuse(`staging refused to create ${destination}; a prior run's staging may survive`));
  try {
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1) return refuse("the archive must be a regular file with one link");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead === 0) return refuse("the archive shrank while it was being read");
      hash.update(buffer.subarray(0, bytesRead));
      await output.write(buffer, 0, bytesRead, position);
      position += bytesRead;
    }
    const after = await input.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size)
      return refuse("the archive was replaced while it was being read");
    await output.chmod(0o600);
    await output.sync();
    return { bytes: before.size, sha256: hash.digest("hex") };
  } finally { await input.close(); await output.close(); }
}

/**
 * One row of `unzip -Z`'s long listing: the name, the uncompressed size, and the
 * entry's TYPE.
 *
 * FINDINGS 3 AND 10, and both need the same listing, so it is read once.
 *
 * FINDING 3 is that Apple's `/usr/bin/unzip` is "UnZip 6.00 … with modifications
 * by Apple" and, unlike upstream Info-ZIP, it does NOT defer symlink creation
 * to the end of extraction. An archive holding
 * `pgsql/share/postgresql/tz2` as a symlink to a directory outside the run
 * followed by `pgsql/share/postgresql/tz2/pwn` writes `pwn` through the link —
 * as root, anywhere the link points — and the scratch cleanup never sees it.
 * MEASURED by the review. The long listing's mode column answers the question
 * before a single byte is inflated, so this module never has to trust what
 * `unzip` did with a symlink.
 *
 * FINDING 10 is that nothing bounded the inflated size of the selected members,
 * so a pinned zip bomb fills the install root. `unzip -Z` prints the
 * uncompressed size of every entry; summing the SELECTED ones and comparing with
 * a ceiling is one addition.
 *
 * The parse is deliberately strict, and refuses rather than guesses. A row that
 * does not match the reviewed shape — an entry type, a whole number, a
 * plausible size — is a listing this module does not understand, and a parser
 * that skipped it would be a parser whose skips are the attacker's choice.
 *
 * The shape, measured against `/usr/bin/unzip -Z` on macOS 26.6.2:
 *
 *   drwxr-xr-x  3.0 unx        0 bx stor 26-Sep-30 23:26 pgsql/bin/
 *   -rw-r--r--  3.0 unx        3 tx stor 26-Sep-30 23:26 pgsql/bin/postgres
 *   lrwxr-xr-x  3.0 unx       18 bx stor 26-Sep-30 23:26 pgsql/bin/link
 *   \ Archive:  …                 ← header, no mode column
 *   \ 4 files, 21 bytes uncompressed…  ← summary, no mode column
 *
 * The type is the FIRST character of the mode column, which is `-` for a regular
 * file, `d` for a directory and `l` for a symlink. The size is the fourth field.
 * The NAME is everything after the date field, and it may contain spaces —
 * `pgsql/share/postgresql/has space.txt` is a legal member and MEASURED as one.
 *
 * THE MODE CHARACTER CAN BE `?`, AND THAT IS NOT AN ERROR.
 *
 * `?` is what `unzip -Z` prints when a member records no Unix mode — a zip
 * written by Python's `zipfile` on a system that did not set `external_attr`, a
 * Windows-authored zip, or any writer that sets the MS-DOS attribute bit alone.
 * MEASURED: a `zipfile`-built archive prints `?rw------- 2.0 unx 3 b- defN …`
 * and, crucially, a member it marks as a symlink still prints `lrwxrwxrwx` because
 * that one DID record a Unix mode.
 *
 * So `?` is treated as UNKNOWN, not as "regular file". A `?` member whose
 * classification would select it is refused, because the guard this listing
 * exists for cannot be satisfied by a member whose type it cannot see. That is
 * fail-closed and it is the safe direction: the honest archives (EDB's, and
 * `zip(1)`'s with `-y`) record a mode for every member, so nothing in production
 * is refused for this.
 *
 * The DATE is `HH:MM`, a `DD-Mon-YY`, or the literal `defN` when the member
 * records no timestamp at all — MEASURED, and a parser that only accepted
 * `HH:MM` reduced a whole `zipfile`-built archive to zero entries and refused it
 * as "empty", which is a refusal for the wrong reason on an archive that might
 * have been fine.
 */
type ArchiveEntryTypeV1 = "file" | "directory" | "symlink" | "unknown" | "other";

export type ArchiveEntryV1 = Readonly<{
  /** The central-directory name, verbatim, with a directory's trailing slash. */
  name: string;
  bytes: number;
  kind: ArchiveEntryTypeV1;
}>;

/**
 * One long-listing row, parsed by ANCHOR rather than by fixed columns.
 *
 * MEASURED, twice, and the first two attempts at this were wrong in ways a
 * fixed-column pattern cannot see:
 *
 *   1. The columns are right-aligned and their widths change with the values:
 *      `3.0 unx        3 tx` and `2.0 unx       14 b-` are both legal, and a
 *      pattern that assumed one space between fields matched DIRECTORY rows and
 *      symlink rows while missing every regular file whose size had fewer digits
 *      — which is most of them. A parser that quietly matched only some rows is
 *      worse than one that matches none, because the "listing is empty" refusal
 *      is the only thing that caught it.
 *   2. The date is `HH:MM` after a `DD-Mon-YY`, or `defN` with no date at all,
 *      and the NAME may contain spaces.
 *
 * So the row is taken apart from both ends: the mode is the first ten
 * characters and must be a real mode; the name is everything after the final
 * time token; and the size is the first whole-number run after the OS field.
 * Three anchors, each checked, rather than one pattern that guesses.
 */
/**
 * Parse one `unzip -Z` long-listing row, or return null for a line that is not
 * an entry (the `Archive:` header and the trailing summary).
 *
 * EXPORTED, and only so `scripts/dev/pgrt-check-listing.mts` can hold this
 * parser against the real archive's 24,676 rows and `unzip -Z1`. It is not
 * part of the runtime surface: nothing in `vendorPgRuntimeV1` outside this
 * module calls it, and a private function a tool cannot check is a private
 * function that gets checked by hand, which is how two of the three measured
 * bugs below survived as long as they did.
 */
export function parsePgArchiveRowV1(line: string): ArchiveEntryV1 | null {
  // The mode column is TEN characters — a type character and nine permission
  // characters — followed by AT LEAST ONE space, and MEASURED, `unzip -Z`
  // separates it with two.
  //
  // The character classes are DELIBERATELY not ranges, and that is the third
  // measured bug in this parser. `[?-dlbcps]` reads as "one of these" but is a
  // RANGE from `?` (0x3F) to `d` (0x64), which contains `A`–`Z`, `[`, `\`,
  // `_` and `a`–`c` but NOT `-` (0x2D) — so every regular file row was rejected
  // while every directory and symlink row parsed. On the pinned archive that
  // dropped 20,462 of 24,676 entries and left a plan of 25 directories and
  // zero files, which then failed the floors. Each alternative is now its own
  // position: `[?-]` for the file marker, then the directory, link and other
  // types individually.
  const match = /^([?-][rwxXstTsSA!-]{9}|d[rwxXstTsSA!-]{9}|l[rwxXstTsSA!-]{9}|[bcps][rwxXstTsSA!-]{9})\s/u.exec(line);
  if (!match) return null;
  const mode = match[1]!;
  // The tail is ` <date> <time> <name>`; the name may hold spaces, so the split
  // is anchored on the LAST time token (`\d{2}:\d{2}`) rather than on the first
  // run of whitespace.
  const time = /(\d{2}:\d{2})\s(\S.*)$/u.exec(line);
  if (!time) return null;
  // The size is the fourth space-delimited field of the head: mode, zip version,
  // zip OS, uncompressed size. MEASURED: the version may itself be `10.1`, and
  // the OS column is `unx` or `fat`, so counting fields is what works and
  // assuming a column width is what does not.
  const head = line.slice(0, time.index);
  const fields = head.trim().split(/\s+/u);
  if (fields.length < 4) return null;
  const size = Number(fields[3]);
  if (!Number.isInteger(size) || size < 0) return null;
  const name = time[2]!;
  if (name.length === 0 || name.includes("\0") || name.startsWith("/") || name.split("/").includes(".."))
    refuse(`the archive contains an entry that escapes its root: ${JSON.stringify(name)}`);
  return Object.freeze({ name, bytes: size, kind: archiveEntryKind(mode[0]!) });
}

function archiveEntryKind(modeCharacter: string): ArchiveEntryTypeV1 {
  if (modeCharacter === "-") return "file";
  if (modeCharacter === "d") return "directory";
  if (modeCharacter === "l") return "symlink";
  // MEASURED: `?` is what a member with no recorded Unix mode prints, and this
  // module cannot tell what such a member is. See the note above.
  if (modeCharacter === "?") return "unknown";
  return "other";
}

async function listArchiveEntriesTyped(archive: string): Promise<readonly ArchiveEntryV1[]> {
  const { stdout } = await run(UNZIP, ["-Z", archive]);
  const entries: ArchiveEntryV1[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    // The header and the summary line are not entries, and a row this parser
    // cannot read is dropped rather than guessed at. A listing where EVERY row
    // was dropped fails the emptiness check below, so a parser that stopped
    // understanding the format is a refusal and not a silent short plan.
    const entry = parsePgArchiveRowV1(line);
    if (entry === null) continue;
    entries.push(entry);
  }
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES)
    refuse(`the archive listing is empty or implausibly large (${entries.length} entries)`);
  return Object.freeze(entries);
}

/**
 * Split a central-directory name into the path the runtime uses.
 *
 * A directory entry keeps its trailing slash in `unzip -Z1` output, so the
 * destination for a directory is its name without the slash, and the caller
 * creates it. A file's destination is decided by the allow-list classifier,
 * which is the same function the pure lane tests — there is one allow-list, and
 * a reviewer reading the test sees the rule the extractor uses.
 */
function planEntry(name: string): Readonly<{ kind: "directory" | "file"; archivePath: string; destination?: string }> {
  const isDirectory = name.endsWith("/");
  const archivePath = isDirectory ? name.slice(0, -1) : name;
  if (isDirectory) return Object.freeze({ kind: "directory", archivePath });
  const classified = classifyPgRuntimeArchiveEntryV1(archivePath);
  if (classified.kind === "excluded" || !classified.destination)
    return Object.freeze({ kind: "file", archivePath });
  return Object.freeze({ kind: "file", archivePath, destination: classified.destination });
}

/**
 * The set of archive paths to extract, and the set of runtime paths they become.
 *
 * `share/postgresql` is whole-directory and `lib/postgresql` is `*.dylib` only.
 * Both are additions to the previous allow-list and both are measured sizes, so
 * the cost of the addition is known rather than assumed: 917 entries and 88 dylibs
 * out of 24,676.
 *
 * A DIRECTORY that the allow-list selects is emitted as a member too. That is
 * not cosmetic: `unzip` only writes a directory entry if the archive contains
 * one, and `share/postgresql/timezone` exists in this archive as a
 * slash-suffixed entry with no files of its own directly under it being
 * directories — the files are one level deeper (`timezone/UTC`). Without the
 * directory in the plan the runtime has the timezone FILES but not the
 * `timezone` directory the required-paths floor names, and the vendor step
 * refuses. MEASURED.
 */
export function planPgRuntimeExtractionV1(entryNames: readonly string[]): Readonly<{
  files: readonly Readonly<{ archivePath: string; destination: string }>[];
  directories: readonly string[];
  excludedCount: number;
}> {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  // FINDING 5, second half, and the guard belongs HERE rather than in the move
  // loop. The plan is a `Map` keyed by ARCHIVE path, so two central-directory
  // rows naming the same member collapse before the vendor ever sees them — and
  // a collision that has already collapsed is invisible to any check
  // downstream. MEASURED by the review: two `pgsql/bin/psql` entries, and the
  // second won the `rename`.
  //
  // A zip CAN carry two rows with one name — `zipfile` writes them, `zip(1)`
  // does not — so this is reachable, and it is refused at the point where both
  // rows are still in hand. The second map records which archive paths the
  // allow-list has already taken a destination for, so the refusal names BOTH
  // members, which is what makes the message actionable: an operator reading it
  // can see which two entries to look at.
  const takenDestinations = new Map<string, string>();
  const claim = (archivePath: string, destination: string): void => {
    const existing = takenDestinations.get(destination);
    if (existing !== undefined)
      refuse(`${existing} and ${archivePath} both land at ${destination} in the runtime`);
    takenDestinations.set(destination, archivePath);
  };
  let excludedCount = 0;
  for (const name of entryNames) {
    const planned = planEntry(name);
    if (planned.kind === "directory") {
      // A directory is in the plan only when the allow-list selects it, judged by
      // the same classifier as a file. `pgAdmin 4.app/` is not; `share/postgresql/`
      // is.
      const classified = classifyPgRuntimeArchiveEntryV1(planned.archivePath);
      if (classified.kind !== "excluded" && classified.destination) {
        directories.add(classified.destination);
        claim(`${planned.archivePath}/`, `${classified.destination}/`);
        files.set(`${planned.archivePath}/`, `${classified.destination}/`);
      }
      continue;
    }
    if (planned.destination === undefined) { excludedCount += 1; continue; }
    // A file whose parent directory is not itself allow-listed must not be
    // written, and the classifier is what decided this one is in.
    claim(planned.archivePath, planned.destination);
    files.set(planned.archivePath, planned.destination);
  }
  // Parent directories of every selected file, so `unzip` is never asked to
  // write into a path whose parent it would have to create on its own.
  const derived = new Set<string>();
  for (const archivePath of files.keys()) {
    const segments = archivePath.replace(/\/+$/u, "").split("/");
    for (let index = 2; index < segments.length; index++)
      derived.add(segments.slice(0, index).join("/"));
  }
  for (const path of derived) {
    const classified = classifyPgRuntimeArchiveEntryV1(path);
    if (classified.kind !== "excluded" && classified.destination && !directories.has(classified.destination))
      directories.add(classified.destination);
  }
  return Object.freeze({
    files: Object.freeze([...files.entries()].map(([archivePath, destination]) => Object.freeze({ archivePath, destination }))),
    directories: Object.freeze([...directories].sort()),
    excludedCount,
  });
}

/** Walk a tree, following no symlink, for normalisation and inventory. */
async function treeEntries(root: string): Promise<string[]> {
  const values: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const entry = await lstat(path);
      values.push(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path);
    }
  };
  await visit(root);
  return values;
}

/**
 * Make the staging tree root-owned, and clear everything an archive may carry.
 *
 * The rules, and why each is here:
 *  - `lchown`, never `chown` (R-FS). A symlink swapped in by a process with
 *    write access to the parent would redirect a following-symlink chown onto an
 *    arbitrary path.
 *  - `chflags -R 0` clears uchg/appended/immutable, so a later update can
 *    actually remove these files.
 *  - `chmod -RN` removes every inherited ACL, because an ACL granting a
 *    non-root principal write is a hole that uid 0 does not close.
 *  - uid/gid 0:0 explicitly, never "the current owner". Extracting as root
 *    restores whatever the archive recorded, and an archive built on a CI machine
 *    records that machine's build user — which on this Mac is the account every
 *    bot runs as. That is finding 1 in the review, and it applies to this item's
 *    archive too.
 */
async function normaliseRootMetadata(root: string, ownership: Readonly<{ uid: number; gid: number }>): Promise<void> {
  await run("/usr/bin/chflags", ["-R", "0", root]);
  await run("/bin/chmod", ["-RN", root]);
  for (const path of await treeEntries(root)) await lchown(path, ownership.uid, ownership.gid);
}

/**
 * Build the runtime from a pinned archive.
 *
 * The sequence, and the reason for the order:
 *   1. validate the pin, so a malformed one is refused before anything is written;
 *   2. refuse if the destination exists, so a second run cannot half-merge;
 *   3. copy the archive ONCE into staging, through descriptors;
 *   4. hash the STAGING COPY and compare with the pin;
 *   5. list the staging copy and plan the extraction;
 *   6. extract only the planned paths;
 *   7. normalise ownership, then write `etc/openssl.cnf` (our empty, fixed one)
 *      and the manifest, then re-normalise so the manifest is root-owned too;
 *   8. verify the required floor, then seal and rename into place.
 *
 * Step 4 after step 3 is the point: the digest is of the bytes this process
 * extracted, not of whatever was in the folder when the vendor started.
 */
export async function vendorPgRuntimeV1(input: Readonly<{
  /** The pinned archive, already downloaded. */
  archivePath: string;
  /** Where `runtime/pg-<version>` goes. Must not exist. */
  runtimeDirectory: string;
  pin?: PgRuntimePinV1;
  /** The fixed, empty OpenSSL config the layout names. */
  opensslConf: string;
  hooks?: PgRuntimeVendorHooksV1;
}>): Promise<PgRuntimeVendorResultV1> {
  let pin: PgRuntimePinV1;
  try {
    pin = validatePgRuntimePinV1(input.pin ?? PG_RUNTIME_PIN_V1);
  } catch (error) {
    const prefix = "pg_runtime_vendor_refused: ";
    if (!(error instanceof Error) || !error.message.startsWith(prefix)) throw error;
    return Object.freeze({
      schema: PG_RUNTIME_VENDOR_V1, status: "pg_runtime_vendor_refused",
      runtimeDirectory: typeof input.runtimeDirectory === "string" ? input.runtimeDirectory : "",
      files: Object.freeze([]), fileDigests: Object.freeze([]), dependencies: Object.freeze([]),
      manifestPath: "", archiveSha256: "", refusal: error.message.slice(prefix.length),
    });
  }
  const destination = input.runtimeDirectory;
  if (typeof destination !== "string" || !isAbsolute(destination) || resolve(destination) !== destination
    || destination.endsWith("/") || destination === "/")
    refuse(`the runtime directory must be an absolute canonical path, got ${JSON.stringify(destination)}`);
  const archivePath = input.archivePath;
  if (typeof archivePath !== "string" || !isAbsolute(archivePath) || resolve(archivePath) !== archivePath)
    refuse("the archive path must be absolute and canonical");
  if (await lstat(destination).then(() => true, (error: { code?: string }) => error?.code === "ENOENT" ? false : Promise.reject(error)))
    refuse(`the runtime directory already exists: ${destination}`);

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const staging = join(parent, `.pg-runtime-stage-${process.pid}`);
  const archiveStaging = join(parent, `.pg-runtime-archive-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await rm(archiveStaging, { recursive: true, force: true });
  await mkdir(staging, { mode: 0o700 });
  await mkdir(archiveStaging, { mode: 0o700 });
  const refused = (why: string): PgRuntimeVendorResultV1 => Object.freeze({
    schema: PG_RUNTIME_VENDOR_V1, status: "pg_runtime_vendor_refused", runtimeDirectory: destination,
    files: Object.freeze([]), fileDigests: Object.freeze([]), dependencies: Object.freeze([]),
    manifestPath: "", archiveSha256: pin.archiveSha256, refusal: why,
  });
  try {
    // MEASURED BUG, and the test that found it asserts it: the refusal paths
    // inside the `try` used to `return refused(...)` directly, which skipped the
    // `catch`/`finally` cleanup entirely and left a 315 MB `.pg-runtime-stage-<pid>`
    // behind. A refusal that leaves staging on the install root is a refusal that
    // made things worse, and the next run would then hit its own leftovers.
    //
    // The fix is the shape rather than a cleanup call at each site: the happy path
    // renames `staging` away (so there is nothing to remove), and every refusal
    // THROWS a refusal that the one `catch` turns into the refusal value after
    // removing staging. One exit, one cleanup, no path that can forget it.
    const refuseWith = (why: string): never => { throw new Error(`pg_runtime_vendor_refused: ${why}`); };

    const snapshot = join(archiveStaging, pin.archiveName);
    const read = await snapshotArchiveOnce(archivePath, snapshot);
    if (read.bytes !== pin.archiveBytes)
      refuseWith(`the archive is ${read.bytes} bytes; the pin says ${pin.archiveBytes}`);
    if (read.sha256 !== pin.archiveSha256)
      refuseWith(`the archive digest is ${read.sha256}; the pin says ${pin.archiveSha256}`);
    await input.hooks?.afterArchiveSnapshot?.(pin);

    const entries = await listArchiveEntriesTyped(snapshot);
    const plan = planPgRuntimeExtractionV1(entries.map(entry => entry.name));
    if (plan.files.length === 0) refuseWith("the allow-list selected no files from this archive");

    // FINDING 3, BEFORE extraction: every selected member must be a regular file
    // or a directory, read from the central directory rather than inferred from
    // what `unzip` does with it. Apple's unzip follows a symlinked directory
    // during extraction, so a symlink member plus a member beneath it is an
    // arbitrary write as root; a symlink member on its own lands in the runtime
    // as a link, is skipped by the digest loop and then has its TARGET chmod'ed
    // by the seal (finding 4). MEASURED by the review, both.
    //
    // This runs before `unzip` is spawned, so a hostile archive is refused
    // rather than half-extracted. The post-write check below is the second half:
    // it is what makes the property hold even if the extractor is replaced.
    const byName = new Map(entries.map(entry => [entry.name, entry]));
    for (const file of plan.files) {
      // `?? refuse(...)` rather than an `if`: `refuse` is the module's
      // `never`-returning thrower, and this is the same narrowing shape
      // `classifyPgRuntimeArchiveEntryV1`'s callers use for `destination`.
      const entry = byName.get(file.archivePath)
        ?? refuse(`the archive listing has no row for ${file.archivePath}, which the allow-list selected`);
      // `unknown` and `other` are in the refusal on purpose. A member that
      // records no Unix mode at all (`?`, MEASURED) cannot be shown to be a
      // regular file, and the whole point of this check is that nothing enters
      // the runtime without being shown to be one. The honest archives record a
      // mode for every member, so this costs nothing in production.
      const wanted = file.destination.endsWith("/") ? "directory" : "file";
      if (entry.kind !== wanted)
        refuseWith(`the archive holds ${file.archivePath} as a ${entry.kind}, and only a regular file or a directory may be extracted`);
    }

    // FINDING 10, and the number is a measurement rather than a guess. MEASURED
    // against the pinned 17.11 archive: the allow-list selects 1,073 members
    // totalling 326,552,493 uncompressed bytes, and the whole archive inflates
    // to 1,188,102,308. The ceiling is roughly 4x the selected region, which is
    // enough that no honest PG 17.x archive comes near it and small enough that a
    // bomb inside the allow-listed paths cannot fill the install root.
    const selectedBytes = plan.files.reduce((sum, file) => sum + (byName.get(file.archivePath)?.bytes ?? 0), 0);
    if (selectedBytes > PG_RUNTIME_MAX_UNCOMPRESSED_BYTES_V1)
      refuseWith(`the selected archive members inflate to ${selectedBytes} bytes, over the ${PG_RUNTIME_MAX_UNCOMPRESSED_BYTES_V1}-byte ceiling`);

    // Extract the selected paths only, WITHOUT `-j`.
    //
    // MEASURED, and the reason `-j` is not used: `unzip -j` flattens every
    // member to its basename, so `share/postgresql/extension/plpgsql.control`
    // and `lib/postgresql/plpgsql.dylib` and `bin/pg_config` all land in one
    // directory and two of them collide on name. Keeping the archive's own
    // structure and moving each member to the path the allow-list computed is
    // the only way the three directories coexist. Extraction happens into a
    // scratch root so nothing outside the plan can be written into the runtime.
    const scratch = join(staging, ".extract");
    await mkdir(scratch, { recursive: true, mode: 0o755 });
    const extractArguments = ["-q", "-o", snapshot, "-d", scratch, ...plan.files.map(file => file.archivePath)];
    input.hooks?.observeExtract?.(extractArguments);
    await run(UNZIP, extractArguments);

    // Move each selected member from `pgsql/<…>` to the runtime path the
    // allow-list computed. The archive's root segment is dropped here and
    // nowhere else, so a member that is not in the plan has no way to arrive.
    //
    // There is no destination-collision check here, and that is deliberate:
    // `planPgRuntimeExtractionV1` refuses a collision at the point where both
    // central-directory rows are still in hand, which is before the first
    // `rename`. A check here could only fire after the earlier copy had already
    // been written, which leaves the question of which copy won.
    const written: string[] = [];
    for (const file of plan.files) {
      const isDirectoryMember = file.destination.endsWith("/");
      const extracted = join(scratch, file.archivePath);
      const relativeDestination = isDirectoryMember ? file.destination.slice(0, -1) : file.destination;
      const target = join(staging, relativeDestination);
      // `unzip` writes a directory member as the directory itself, so it is
      // created here rather than moved; a file member must exist or the
      // archive did not yield what the plan selected.
      if (isDirectoryMember) {
        await mkdir(target, { recursive: true, mode: 0o755 });
        written.push(relativeDestination);
        continue;
      }
      if (!await lstat(extracted).catch(() => null))
        refuseWith(`the archive did not yield ${file.archivePath}, which the allow-list selected`);
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await rename(extracted, target);
      written.push(relativeDestination);
    }
    // FINDING 3, AFTER extraction: every path the move loop wrote is `lstat`ed
    // again, and anything that is not a directory or a regular file with one
    // link is a refusal. This is the half that does not depend on the central
    // directory's honesty: it reads what is actually on disk, so a substituted
    // extractor, a `unzip` that creates a link the listing never named, or a
    // writer that swaps a file between the listing and the move are all caught
    // here. `nlink === 1` is included because a hard link in a sealed tree is a
    // second name for a file this manifest hashed under a different path, and
    // after the seal both names are 0444 over one inode.
    //
    // The hook is called first and is the seam that makes this reachable from a
    // test: no archive can produce a hard-linked member, because `zip(1)` and
    // `unzip` both turn one into two independent files, and a symlink is refused
    // above. See `afterMembersMoved`.
    await input.hooks?.afterMembersMoved?.(staging);
    for (const relativeDestination of written) {
      const stat = await lstat(join(staging, relativeDestination));
      if (stat.isDirectory()) continue;
      if (!stat.isFile() || stat.nlink !== 1)
        refuseWith(`${relativeDestination} is not a regular file with one link after extraction, and nothing else may enter the runtime`);
    }
    // FINDING 9, and the publisher check the pin was never making. It runs HERE,
    // after the move loop and before the floors, because that is the first point
    // at which the files exist as real files in a real tree.
    //
    // The pin is SELF-ATTESTED: the digest is of bytes this Mac downloaded, the
    // URL may be any https host, and MEASURED, EDB publishes no sidecar
    // checksum for this archive (`…zip.sha256` and `…zip.sha256sum` both return
    // S3 AccessDenied). So a pin bump — which is a source change like any other,
    // and is reachable through self-update — is the moment the digest stops
    // meaning anything: change the digest in source to match a re-packed
    // archive and every other check in this function passes.
    //
    // What cannot be re-written in source is a Developer ID signature. The EDB
    // binaries carry one, so `codesign --verify --strict` over every Mach-O in
    // the tree plus a pinned Team Identifier is the publisher check the pin is
    // not. MEASURED on the pinned 17.11 archive: `postgres`, `initdb` and
    // `libssl.3.dylib` all report `TeamIdentifier=26QKX55P9K` and
    // `Identifier=com.edb.postgresql`, and `--verify --strict` exits 0.
    //
    // Every image the runtime will execute or load is inside the allow-list, so
    // every image the runtime will execute or load is verified here. pgAdmin and
    // StackBuilder are not vendored, so verifying them would verify files the
    // runtime does not contain.
    for (const relative of written) {
      // `written` carries DIRECTORY members as well as files, and opening a
      // directory for reading is EISDIR. MEASURED: the first version read every
      // entry and the vendor refused with EISDIR on `share/postgresql/timezone`
      // — the `lstat` in `isMachO` says it is a directory, and the guard has to
      // act on that rather than only on the exception.
      const stat = await lstat(join(staging, relative));
      if (stat.isDirectory()) continue;
      if (!(await isMachO(join(staging, relative)))) continue;
      const verified = await verifyCodeSignature(join(staging, relative));
      if (!verified.ok) refuseWith(`codesign refused ${relative}: ${verified.why}`);
      if (verified.teamIdentifier !== pin.teamIdentifier)
        refuseWith(`${relative} is signed by TeamIdentifier ${verified.teamIdentifier || "(none)"}, and the pin names ${pin.teamIdentifier}`);
    }

    // Whatever is left under `.extract` was not in the plan, so it is removed
    // with the scratch root rather than left where a later rename would carry
    // it into the runtime.
    await rm(scratch, { recursive: true, force: true });

    // The runtime's own OpenSSL config, written by us and empty. The archive's
    // `etc/openssl.cnf` is excluded by the allow-list and never arrives here;
    // this is the file R9b requires, and its digest goes in the manifest.
    const etc = join(staging, "etc");
    await mkdir(etc, { recursive: true, mode: 0o755 });
    await writeFile(join(etc, "openssl.cnf"), input.opensslConf, { mode: 0o444, flag: "wx" });
    // `lib/ossl-modules` is named by the layout's OPENSSL_MODULES pin, and an
    // empty directory is what an empty OpenSSL config needs: with no provider
    // module present there is nothing to load from anywhere.
    await mkdir(join(staging, "lib", "ossl-modules"), { recursive: true, mode: 0o755 });

    const ownership = input.hooks?.ownership ?? { uid: 0, gid: 0 };
    if (input.hooks?.normaliseOwnership !== false) await normaliseRootMetadata(staging, ownership);

    // The floor, checked against what is actually on disk. This is where a
    // classifier that quietly stopped copying `share/postgresql` becomes a
    // refusal instead of a cluster that will not start.
    const present = new Set(written);
    present.add("etc/openssl.cnf");
    const missing = PG_RUNTIME_REQUIRED_PATHS_V1.filter(path => !present.has(path));
    if (missing.length > 0)
      refuseWith(`the archive did not supply ${missing.length} required runtime path(s): ${missing.join(", ")}`);

    // The library floor, as separate names as the program list.
    for (const library of PG_RUNTIME_REQUIRED_LIBRARY_FLOOR_V1) {
      if (!present.has(`lib/${library}`))
        refuseWith(`the archive did not supply the required library lib/${library}`);
    }

    const fileDigests: Array<{ path: string; sha256: string; bytes: number }> = [];
    for (const path of [...present].sort()) {
      const absolute = join(staging, path);
      const entry = await lstat(absolute);
      // A symlink and a directory both appear in `present` — a directory because
      // the required-paths floor names `share/postgresql/timezone`, whose only
      // record in the archive is a slash-suffixed entry. Neither has content to
      // hash, and hashing one is an EISDIR rather than a digest. MEASURED: this
      // line existed only for symlinks until the floor required a directory.
      if (entry.isSymbolicLink() || entry.isDirectory()) continue;
      fileDigests.push({ path, sha256: await sha256File(absolute), bytes: entry.size });
    }

    const inventory = [] as Array<Readonly<Record<string, unknown>>>;
    for (const path of await treeEntries(staging)) {
      const local = path.slice(staging.length + 1);
      const entry = await lstat(path);
      if (entry.isDirectory()) {
        inventory.push(Object.freeze({ path: local, type: "directory", mode: "0555" }));
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        const executable = (entry.mode & 0o111) !== 0;
        inventory.push(Object.freeze({ path: local, type: "file", mode: executable ? "0555" : "0444",
          bytes: entry.size, sha256: await sha256File(path) }));
      } else {
        refuseWith(`the installed tree contains a non-regular entry at ${local}`);
      }
    }
    inventory.sort((left, right) => String(left.path).localeCompare(String(right.path)));

    const manifestPath = "manifest.json";
    const manifest = {
      schema: "control-room.pg-runtime-manifest/v1",
      version: pin.version,
      archive: { name: pin.archiveName, url: pin.url, sha256: pin.archiveSha256, bytes: pin.archiveBytes },
      provenance: pin.provenance,
      // The `otool -L` closure is filled in by the caller after it runs the
      // probe, and starts empty here rather than claiming a property this
      // function did not verify.
      dependencies: [] as string[],
      files: inventory,
    };
    await writeFile(join(staging, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444, flag: "wx" });
    if (input.hooks?.normaliseOwnership !== false) await normaliseRootMetadata(staging, ownership);

    // Seal: 0555 directories, 0555 executables, 0444 everything else. A runtime
    // the service account can write to is a runtime the service account can
    // replace, so this is the T1 property in file modes.
    //
    // The file loop keeps the 0555/0444 split by the execute bit, and the
    // directory loop below touches DIRECTORIES ONLY.
    //
    // FINDING 1, and the report's "0555/0444" claim was false because of it. The
    // second loop walked every tree entry and set 0555, files included, so after
    // the seal a data file measured 555:
    //
    //   share/postgresql/postgres.bki 555
    //   lib/libssl.3.dylib            555
    //   etc/openssl.cnf               555
    //
    // The existing tests asserted only `bin/postgres` and the root directory,
    // both of which are meant to be 0555, so they passed. It matters because the
    // manifest says 0444 for data, because an executable bit on 900 catalog,
    // timezone and SQL files is the kind of thing an exec allow-list has to
    // reason about, and because item 25's rehearsal asserts modes and the
    // builder's report told it the wrong answer.
    //
    // `lchmod`, not `chmod` (finding 4): the seal is the last thing that touches
    // these paths as root, and `chmod` FOLLOWS a symlink, so a symlink that
    // survived into the tree would have its target's mode set. The post-write
    // check above already refuses any non-regular file, and `lchmod` is the call
    // that is still correct if that ever stops being true.
    //
    // THE TWO LOOPS USE DIFFERENT TOOLS, and the reasons are measured:
    //
    //   1. `lchmod` for FILES, `chmod` for DIRECTORIES. Node's macOS `lchmod`
    //      opens a regular file and then applies `fchmod`; it is not an
    //      `fchmodat(..., AT_SYMLINK_NOFOLLOW)` wrapper and it fails on a
    //      directory. MEASURED: the first version used `lchmod` for both and
    //      the vendor refused on `share/postgresql/timezone`.
    //
    //   2. "Set it unless it is already there", because Node's macOS `lchmod`
    //      opens the path for writing before `fchmod`. As a non-root owner that
    //      open is EACCES on a 0444 file, while `chmod` succeeds. Our fixed
    //      `etc/openssl.cnf` is already 0444, so skipping a no-op avoids that
    //      failure; production runs this step as root.
    //
    //   A NOTE ON WHAT THE `lchmod` HERE BUYS, because it is less than it looks.
    //   This loop iterates the archive's regular members plus our fixed OpenSSL
    //   config; `manifest.json` is not in it. The two calls are equivalent when
    //   this step runs as root, but not for the non-root synthetic lane: an
    //   archive member without owner-write permission makes `lchmod` fail where
    //   `chmod` succeeds. Keep the mutation and its non-root regression test.
    //
    //   `lchmod` is still the right call, and the reason is finding 4 rather than
    //   a property this loop can currently exercise: the seal is the last thing
    //   that touches these paths as root, `chmod` FOLLOWS a symlink, and the
    //   post-write `lstat` above is what currently makes a symlink impossible
    //   here. If that check is ever weakened or the archive gains a member type
    //   the listing cannot see, `chmod` is the call that reaches through the link
    //   and `lchmod` is not. The guard is there for the case where the other
    //   guard is not, and a test that could not fail is worse than none — so this
    //   is recorded rather than asserted.
    for (const entry of fileDigests) {
      const absolute = join(staging, entry.path);
      const stat = await lstat(absolute);
      const sealed = (stat.mode & 0o111) !== 0 ? 0o555 : 0o444;
      if ((stat.mode & 0o7777) !== sealed) await lchmod(absolute, sealed);
    }
    for (const path of (await treeEntries(staging)).sort().reverse()) {
      const stat = await lstat(path);
      if (!stat.isDirectory()) continue;
      if ((stat.mode & 0o7777) !== 0o555) await chmod(path, 0o555);
    }
    if (((await lstat(staging)).mode & 0o7777) !== 0o555) await chmod(staging, 0o555);

    try { await rename(staging, destination); }
    catch (error) {
      const exists = await lstat(destination).then(() => true, () => false);
      if (exists) refuse("the runtime directory appeared while it was being built");
      throw error;
    }
    await input.hooks?.afterDestinationRename?.(destination);
    return Object.freeze({
      schema: PG_RUNTIME_VENDOR_V1, status: "pg_runtime_vendored", runtimeDirectory: destination,
      files: Object.freeze(fileDigests.map(entry => entry.path)),
      fileDigests: Object.freeze(fileDigests),
      dependencies: Object.freeze([]), manifestPath, archiveSha256: pin.archiveSha256,
    });
  } catch (error) {
    // A staging tree that cannot be made writable again cannot be removed, and
    // the next run would then refuse on its own leftovers. Restore write
    // permission before removing, which is a real bug the previous teardown in
    // this item's test lane had.
    await run("/bin/chmod", ["-R", "u+rwX", staging]).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await rm(archiveStaging, { recursive: true, force: true }).catch(() => undefined);
    // BOTH refusal prefixes, because two modules refuse and the caller must get
    // the same shape from either.
    //
    // `refuseWith` here throws `pg_runtime_vendor_refused: …`. The allow-list
    // classifier in `pg-runtime-copy.ts` throws `pg_runtime_copy_refused: …` —
    // it is a separate module with its own `refuse`, and finding 5's root-segment
    // check is the first guard in it that a pinned archive can actually reach.
    // MEASURED: before this, a hostile root segment escaped as a thrown
    // `Error` rather than a refusal value, so the caller got a stack trace where
    // every other refusal gives it a loggable, displayable reason. A refusal
    // that throws is a refusal the installer cannot explain to the owner.
    for (const prefix of ["pg_runtime_vendor_refused: ", "pg_runtime_copy_refused: "]) {
      if (error instanceof Error && error.message.startsWith(prefix))
        return refused(error.message.slice(prefix.length));
    }
    throw error;
  } finally {
    await rm(archiveStaging, { recursive: true, force: true }).catch(() => undefined);
  }
}
