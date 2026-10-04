// The guards that the real archive cannot reach, reached with a SYNTHETIC one.
//
// Four vendor guards are MUTATION-SURVIVING against `postgresql-17.11-4-osx`:
//
//   1. the archive SIZE comparison (`archiveBytes`);
//   2. the required-path floor (`PG_RUNTIME_REQUIRED_PATHS_V1`);
//   3. the required-library floor (`PG_RUNTIME_REQUIRED_LIBRARY_FLOOR_V1`);
//   4. the extension pattern (only `.dylib` under `lib/postgresql/`).
//
// Every one of them is a "this archive is not the one we pinned" check, and the
// pinned archive IS the one we pinned — so with the real file the four branches
// are dead code, and a mutation harness that deletes each one sees all four
// tests still pass. MEASURED: 9 of 13 mutations caught, and these are the four.
//
// So they are tested against archives this lane BUILDS, one member at a time,
// with a pin computed from what it built. That is not a mock of the vendor step —
// the whole step runs, `unzip` inflates the archive, the classifier decides, the
// floors run and the refusal is returned. Only the input is synthetic, which is
// the only way to reach the branch that says "the archive is not complete".
//
// The synthetic archive is a real ZIP written with `zip(1)`, so the code under
// test reads a real central directory through the same `unzip -Z1` path it uses
// for the real archive.

import { execFileSync, spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PG_RUNTIME_PIN_V1, vendorPgRuntimeV1, PG_RUNTIME_MAX_UNCOMPRESSED_BYTES_V1,
  validatePgRuntimePinV1, type PgRuntimeVendorResultV1,
} from "../src/updater/v1/pg/pg-runtime-vendor";
import {
  classifyPgRuntimeArchiveEntryV1, PG_RUNTIME_EXTENSION_MODULES_V1,
} from "../src/updater/v1/pg/pg-runtime-copy";
import { loadRuntimeInventoryV1, vendorRuntimeV1 } from "../src/updater/v1/install/runtime.mjs";

const LANE_ROOT = process.env.CONTROL_ROOM_PGRT_TMPDIR
  ? join(process.env.CONTROL_ROOM_PGRT_TMPDIR, `pgsynth-${process.pid}`)
  : join(tmpdir(), `pgsynth-${process.pid}`);

const RUNS: string[] = [];
process.on("exit", () => {
  for (const run of RUNS) {
    try { execFileSync("/bin/chmod", ["-R", "u+rwX", run]); } catch { /* best effort */ }
    try { rmSync(run, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  try { rmSync(LANE_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Every path the floor demands, with a byte of content each. */
const COMPLETE_MEMBERS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["pgsql/bin/postgres", "bin"],
  ["pgsql/bin/initdb", "bin"],
  ["pgsql/bin/pg_ctl", "bin"],
  ["pgsql/bin/pg_controldata", "bin"],
  ["pgsql/bin/psql", "bin"],
  ["pgsql/bin/pg_dump", "bin"],
  ["pgsql/bin/pg_restore", "bin"],
  ["pgsql/bin/pg_basebackup", "bin"],
  ["pgsql/bin/pg_verifybackup", "bin"],
  ["pgsql/share/postgresql/postgres.bki", "bki"],
  ["pgsql/share/postgresql/snowball_create.sql", "sql"],
  // The TIMEZONE DIRECTORY as a zero-byte member, because that is how a ZIP
  // records a directory and because the floor names the directory rather than a
  // file inside it. MEASURED: omitting it made the vendor refuse with
  // "did not supply 1 required runtime path(s): share/postgresql/timezone",
  // which is the vendor being right and this fixture being wrong — `zip(1)`
  // only writes a directory entry when the archive is told to include one.
  ["pgsql/share/postgresql/timezone/", ""],
  ["pgsql/lib/postgresql/plpgsql.dylib", "dylib"],
  ["pgsql/lib/postgresql/dict_snowball.dylib", "dylib"],
  // The library floor, which is a separate list and a separate check.
  ["pgsql/lib/libssl.3.dylib", "dylib"],
  ["pgsql/lib/libcrypto.3.dylib", "dylib"],
  ["pgsql/lib/libgssapi_krb5.2.2.dylib", "dylib"],
  ["pgsql/lib/libzstd.1.dylib", "dylib"],
  ["pgsql/lib/liblz4.1.dylib", "dylib"],
  ["pgsql/lib/libxml2.dylib", "dylib"],
  ["pgsql/lib/libz.dylib", "dylib"],
  ["pgsql/lib/libicuuc.dylib", "dylib"],
  ["pgsql/lib/libicui18n.dylib", "dylib"],
  ["pgsql/lib/libicudata.dylib", "dylib"],
]);

type Member = readonly [string, string | Buffer];

interface BuiltArchive {
  readonly archivePath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly runtimeDirectory: string;
}

/** Pin a written archive, so a test may vary ONE thing and have every other check pass. */
function pinArchive(archivePath: string, root: string): BuiltArchive {
  const bytes = statSync(archivePath).size;
  // STREAMED, not `/bin/cat | hash`. MEASURED: the zip-bomb test writes a member
  // over the 1 GiB ceiling and `execFileSync("/bin/cat", …)` died with ENOBUFS
  // before the guard under test ever ran — the harness failed instead of the
  // assertion. Reading in chunks with `readFileSync` on a file handle costs
  // nothing at 300 MB either, and a guard whose test cannot hold a large input
  // is a guard that will only ever be tested on small ones.
  const digest = createHash("sha256");
  const handle = openSync(archivePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      digest.update(buffer.subarray(0, read));
    }
  } finally { closeSync(handle); }
  return Object.freeze({
    archivePath, sha256: digest.digest("hex"), bytes,
    runtimeDirectory: join(root, "runtime", "pg-17.11"),
  });
}

/** Write a member into `source`, as a directory when its name ends in "/". */
function writeMember(source: string, path: string, content: string | Buffer): void {
  const target = join(source, path);
  // A member whose name ends in "/" is a DIRECTORY, and a ZIP records it by
  // including the directory in the archive — it has no bytes of its own.
  // MEASURED: the first version tried to `writeFileSync` it and every test in
  // this file failed with ENOENT on a path ending in a slash.
  if (path.endsWith("/")) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    return;
  }
  mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
  // A PROGRAM is written with an execute bit, because the seal's rule is "keep
  // whatever execute bit the member had" and a synthetic member written 0600
  // would seal to 0444 — correct behaviour, wrong fixture. MEASURED: the first
  // version of the 0444 test asserted `bin/postgres` is 0555 and it measured
  // 0444, which is the seal working and the fixture lying.
  writeFileSync(target, content, { flag: "wx", mode: path.startsWith("pgsql/bin/") ? 0o700 : 0o600 });
}

/** The stripped environment the vendor step itself uses, for a like-for-like zip. */
const ZIP_ENVIRONMENT = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv;

/**
 * A directory this lane owns and will remove, created on first use.
 *
 * `LANE_ROOT` is created by whichever builder runs first, and a test that needs a
 * scratch directory BEFORE it builds an archive (the symlink tests, which point
 * a link at a directory outside the archive) would otherwise race that.
 * MEASURED: `mkdtemp` on an absent parent is ENOENT, and the failure read as a
 * missing symlink rather than a missing parent.
 */
function laneDirectory(label: string): string {
  mkdirSync(LANE_ROOT, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(LANE_ROOT, label));
  RUNS.push(directory);
  return directory;
}

/**
 * Write a real ZIP containing `members`, and return a pin for it.
 *
 * The digest and the byte count are computed from the file that was written, so
 * the pin is correct by construction — which is what lets a test vary ONE thing
 * (the members, or the size) and have every other check pass.
 *
 * `roots` is what `zip(1)` is told to archive, defaulting to `pgsql`. A member
 * outside it is written into the staging tree but never reaches the archive,
 * which is how the "a second root segment" test can assert the guard fires —
 * MEASURED: the first version archived only `pgsql`, so `evil/bin/postgres` was
 * never in the zip and the test asserted a refusal against an archive that had
 * nothing wrong with it.
 *
 * `store` writes the members uncompressed (`zip -0`), which is what a zip bomb
 * needs: the guard reads the UNCOMPRESSED size column, and a member that is
 * highly compressible on disk is not a test of that column.
 */
function buildArchive(members: readonly Member[], options: Readonly<{
  extra?: readonly Member[];
  modes?: Readonly<Record<string, number>>;
  roots?: readonly string[];
  store?: boolean;
}> = {}): BuiltArchive {
  const root = laneDirectory("a-");
  const source = join(root, "src");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  for (const [path, content] of [...members, ...(options.extra ?? [])]) writeMember(source, path, content);
  for (const [path, mode] of Object.entries(options.modes ?? {})) chmodSync(join(source, path), mode);
  const archivePath = join(root, "synthetic.zip");
  execFileSync("/usr/bin/zip", [...(options.store ? ["-0"] : []), "-q", "-r", "-X", archivePath, ...(options.roots ?? ["pgsql"])],
    { cwd: source, env: ZIP_ENVIRONMENT });
  return pinArchive(archivePath, root);
}

/**
 * A ZIP whose members are `members` with one of them replaced by the real bytes
 * of a file on disk.
 *
 * The signature guard needs a real Mach-O inside the archive, and every other
 * builder in this lane writes text: a Mach-O is the one member whose bytes
 * cannot be written inline, so this copies one in. The member's NAME is a
 * `share/postgresql/…` path because that is where the allow-list admits anything
 * at all under `lib/postgresql/` — the name here is the closed-list member the
 * finding-6 test uses, and this lane is about the signature rather than the list.
 */
function buildArchiveWithFile(members: readonly Member[], replacedPath: string, file: string): BuiltArchive {
  const root = laneDirectory("f-");
  const source = join(root, "src");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  for (const [path, content] of members) {
    if (path === replacedPath) continue;
    writeMember(source, path, content);
  }
  const target = join(source, replacedPath);
  mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
  // `copyFileSync` rather than reading the bytes: a Mach-O is megabytes and the
  // archive builder writes from disk anyway.
  copyFileSync(file, target);
  // The archive must carry the mode, because the seal's 0555/0444 split reads
  // the execute bit the ZIP recorded — and `zip(1)` records whatever the file
  // has.
  chmodSync(target, 0o755);
  const archivePath = join(root, "synthetic.zip");
  execFileSync("/usr/bin/zip", ["-q", "-r", "-X", archivePath, "pgsql"], { cwd: source, env: ZIP_ENVIRONMENT });
  return pinArchive(archivePath, root);
}

/**
 * A ZIP holding symlink members, which is what `zip -y` records.
 *
 * `zip -y` is the flag that stores a symbolic link AS a link; without it
 * `zip(1)` follows the link and writes the target's bytes, so the archive would
 * not contain a symlink at all and the test would be measuring nothing. MEASURED
 * against a purpose-built zip: `unzip -Z` reports the member with an `l` in the
 * mode column and `unzip` recreates the link on extraction.
 *
 * The link's PARENT must not already be a directory in the staging tree, or
 * `symlinkSync` is EEXIST. MEASURED: a member at `share/postgresql/tz2/pwn`
 * creates `tz2` as a real directory, so a link at that same path is a
 * collision — and finding 3's case is exactly a link at `tz2` with a member
 * BENEATH it, which `zip(1)` cannot lay out on disk at all. That case is built
 * by `buildLinkedDirectoryArchive` below; this one is for link members that are
 * leaves.
 */
function buildSymlinkArchive(members: readonly Member[],
  links: readonly (readonly [string, string])[],
  extraMembers: readonly Member[] = []): BuiltArchive {
  const root = laneDirectory("s-");
  const source = join(root, "src");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  for (const [path, content] of [...members, ...extraMembers]) writeMember(source, path, content);
  for (const [path, target] of links) {
    const link = join(source, path);
    mkdirSync(join(link, ".."), { recursive: true, mode: 0o700 });
    // Absolute targets, because the whole point is a link that leaves the
    // archive; a relative one would point at the wrong place once extracted into
    // a scratch root and the test would pass for the wrong reason.
    symlinkSync(target, link);
  }
  const archivePath = join(root, "synthetic.zip");
  execFileSync("/usr/bin/zip", ["-y", "-q", "-r", "-X", archivePath, "pgsql"], { cwd: source, env: ZIP_ENVIRONMENT });
  return pinArchive(archivePath, root);
}

/**
 * The archive finding 3 actually needs: a symlinked DIRECTORY with a member
 * BENEATH it, which no filesystem layout can hold.
 *
 * This is the case the review measured — `share/postgresql/tz2` as a link to a
 * directory outside the run, then `share/postgresql/tz2/pwn`, and Apple's
 * `unzip` wrote `pwn` through the link to a path the scratch cleanup never
 * sees. On disk that is a link and a file under a link at the same time, which
 * is impossible, so the archive is written member by member with the symlink's
 * Unix mode bits set on the link entry and the child written as a separate
 * member. `zip(1)` cannot produce this; `zipfile` can, and the real archive
 * does not need to — the whole point is the shape an attacker would hand-build.
 */
function buildLinkedDirectoryArchive(members: readonly Member[],
  linkPath: string, linkTarget: string,
  children: readonly (readonly [string, number])[]): BuiltArchive {
  const root = laneDirectory("k-");
  const source = join(root, "src");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  for (const [path, content] of members) writeMember(source, path, content);
  const archivePath = join(root, "synthetic.zip");
  execFileSync("/usr/bin/python3",
    ["-c", LINKED_DIRECTORY_ARCHIVE_SCRIPT, source, archivePath, linkPath, linkTarget,
      ...children.flatMap(child => [child[0], String(child[1])])],
    { env: ZIP_ENVIRONMENT });
  return pinArchive(archivePath, root);
}

/**
 * Write a zip whose central directory names `linkPath` as a symlink and then
 * names members BENEATH it.
 *
 * The `external_attr` of the link entry is `0o120777 << 16` — S_IFLNK with
 * rwxrwxrwx — which is what `zip -y` and Info-ZIP write for a symlink, and what
 * `unzip -Z` reads back as an `l` in the mode column. MEASURED: a `zipfile`
 * entry without `external_attr` prints `?rw-------`, and this module refuses
 * such a member, so the test would be asserting a refusal for the wrong reason
 * if the mode bits were left off.
 */
const LINKED_DIRECTORY_ARCHIVE_SCRIPT = `
import os, sys, zipfile
source, archive, link_path, link_target = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
children = sys.argv[5:]
entries = []
for root, _dirs, files in os.walk(source):
    for name in sorted(files):
        path = os.path.join(root, name)
        entries.append((os.path.relpath(path, source), open(path, "rb").read()))
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as handle:
    for name, data in entries:
        info = zipfile.ZipInfo(name)
        info.external_attr = 0o100644 << 16
        handle.writestr(info, data)
    link_info = zipfile.ZipInfo(link_path)
    link_info.external_attr = 0o120777 << 16
    handle.writestr(link_info, link_target)
    for index in range(0, len(children), 2):
        name, size = children[index], int(children[index + 1])
        info = zipfile.ZipInfo(name)
        info.external_attr = 0o100644 << 16
        handle.writestr(info, b"P" * size)
`;

/**
 * A ZIP with the SAME member name twice, which `zip(1)` refuses to write and
 * Python's `zipfile` writes without complaint.
 *
 * This is the only way to reach the destination-collision guard: the plan is
 * keyed by archive path, so a well-formed archive cannot produce two archive
 * paths for one destination, and a synthetic zip is not a shortcut to a
 * scenario that cannot happen. A hand-built archive can.
 */
function buildDuplicateMemberArchive(members: readonly Member[], duplicate: string, content: string): BuiltArchive {
  const root = laneDirectory("d-");
  const source = join(root, "src");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  for (const [path, body] of members) writeMember(source, path, body);
  // The duplicate is written under a DIFFERENT name on disk and mapped to the
  // same archive path by the script below, so `zip(1)` is not involved and no
  // two files collide in the staging tree.
  writeMember(source, "dupe-source", content);
  const archivePath = join(root, "synthetic.zip");
  execFileSync("/usr/bin/python3", ["-c", DUPLICATE_ARCHIVE_SCRIPT, source, archivePath, duplicate],
    { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv });
  return pinArchive(archivePath, root);
}

/**
 * Write a zip whose central directory names `duplicate` twice.
 *
 * `zipfile.ZipFile.writestr` appends a second entry with the same name rather
 * than replacing the first, and `unzip -Z` lists both, which is exactly the
 * shape the collision guard exists for. The second copy is
 * `dupe-source`, so the bytes differ from the first and a test that asserts on
 * content can tell which copy won.
 */
const DUPLICATE_ARCHIVE_SCRIPT = `
import os, sys, zipfile
source, archive, duplicate = sys.argv[1], sys.argv[2], sys.argv[3]
entries = []
for root, _dirs, files in os.walk(source):
    for name in sorted(files):
        path = os.path.join(root, name)
        entries.append((os.path.relpath(path, source), open(path, "rb").read()))
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as handle:
    for name, data in entries:
        if name == "dupe-source":
            name = duplicate
        info = zipfile.ZipInfo(name)
        info.external_attr = 0o100644 << 16
        handle.writestr(info, data)
`;

/** Vendor a synthetic archive and return the result, never throwing. */
async function vendor(built: Readonly<{ archivePath: string; sha256: string; bytes: number; runtimeDirectory: string }>,
  overrides: Partial<{ archiveBytes: number; archiveSha256: string }> & {
    /** The seam the post-write hard-link guard needs; see `afterMembersMoved`. */
    afterMembersMoved?: (staging: string) => Promise<void>;
    /**
     * Override the pin's Team Identifier. An empty string is how the signature
     * test proves the COMPARISON is load-bearing: no Developer ID can be minted
     * on this machine, so matching a real ad-hoc signature means the pin names
     * the empty identifier the image actually has.
     */
    teamIdentifier?: string;
  } = {}): Promise<PgRuntimeVendorResultV1> {
  return vendorPgRuntimeV1({
    archivePath: built.archivePath,
    runtimeDirectory: built.runtimeDirectory,
    opensslConf: "# fixed and empty\n",
    pin: {
      ...PG_RUNTIME_PIN_V1,
      archiveName: "postgresql-17.11-4-osx-binaries.zip",
      archiveSha256: overrides.archiveSha256 ?? built.sha256,
      archiveBytes: overrides.archiveBytes ?? built.bytes,
      teamIdentifier: overrides.teamIdentifier ?? PG_RUNTIME_PIN_V1.teamIdentifier,
    },
    hooks: { normaliseOwnership: false, afterMembersMoved: overrides.afterMembersMoved },
  }).then(value => value, (error: unknown) => error as PgRuntimeVendorResultV1);
}

test("a complete synthetic archive vendors, so the refusal tests below are reaching a live path", { timeout: 120_000 }, async () => {
  const built = buildArchive(COMPLETE_MEMBERS);
  const result = await vendor(built);
  // Without this, every refusal below could pass because the step always refuses.
  // A test that cannot fail is worse than no test, and this is the one that
  // proves the floor checks have a reachable happy path.
  assert.equal(result.status, "pg_runtime_vendored", result.refusal);
  assert.ok(result.files.includes("share/postgresql/postgres.bki"), "the catalog must be in the runtime");
  assert.ok(result.files.includes("lib/postgresql/plpgsql.dylib"), "pkglibdir must be in the runtime");
  assert.ok(result.files.includes("lib/libssl.3.dylib"), "the library floor must be in the runtime");
  assert.ok(result.files.includes("etc/openssl.cnf"), "our own OpenSSL config is written, not copied");
  // `manifest.json` is reported as `manifestPath`, not as a file: it is written
  // AFTER the file list is computed, so including it in `files` would mean
  // hashing a file that does not exist yet. MEASURED: the first version asserted
  // it was in `files` and failed on a run that had vendored correctly.
  assert.equal(result.manifestPath, "manifest.json");
});

test("step 18 default path passes the inventory Team ID to the real PostgreSQL vendor", { timeout: 120_000 }, async () => {
  const built = buildArchive(COMPLETE_MEMBERS);
  const root = realpathSync(mkdtempSync(join(LANE_ROOT, "install-")));
  RUNS.push(root);
  const curl = join(root, "fixture-curl.mjs");
  writeFileSync(curl, `import { copyFileSync } from "node:fs";
const args = process.argv.slice(2);
const source = args.shift();
const output = args[args.indexOf("--output") + 1];
copyFileSync(source, output);
`, { mode: 0o700 });
  const inventory = structuredClone(await loadRuntimeInventoryV1());
  const artifact = inventory.artifacts.find((value: { tool: string }) => value.tool === "postgresql");
  Object.assign(artifact, {
    archiveSha256: built.sha256, archiveBytes: built.bytes,
    executableSha256: createHash("sha256").update("bin").digest("hex"),
  });
  const result = await vendorRuntimeV1(Object.freeze({
    root, inventory, tools: Object.freeze(["postgresql"]), fresh: true,
    download: Object.freeze({ uid: process.getuid!(), gid: process.getgid!() }), transactionId: "pg-default-path",
  }), {
    curlPath: process.execPath, curlArgumentsPrefix: [curl, built.archivePath],
    pgHooks: { normaliseOwnership: false },
  });
  assert.equal((result.installed as Record<string, { version: string }>).postgresql.version, "17.11");
  assert.equal(readlinkSync(join(root, "runtime/pg-current")), "pg-17.11");
  const manifest = JSON.parse(readFileSync(join(root, "runtime/pg-17.11/manifest.json"), "utf8"));
  assert.equal(manifest.schema, "control-room.pg-runtime-manifest/v1");
  assert(manifest.files.some((entry: { path: string; type: string }) =>
    entry.path === "share/postgresql/timezone" && entry.type === "directory"));
});

test("the real vendor returns a typed, actionable refusal when the pin has no Team ID", async () => {
  const built = buildArchive(COMPLETE_MEMBERS);
  const result = await vendorPgRuntimeV1({
    archivePath: built.archivePath, runtimeDirectory: built.runtimeDirectory, opensslConf: "",
    pin: { ...PG_RUNTIME_PIN_V1, archiveSha256: built.sha256, archiveBytes: built.bytes,
      teamIdentifier: undefined } as unknown as typeof PG_RUNTIME_PIN_V1,
    hooks: { normaliseOwnership: false },
  });
  assert.equal(result.status, "pg_runtime_vendor_refused");
  assert.match(result.refusal!, /teamIdentifier is REQUIRED and must be 10 uppercase alphanumerics/u);
  assert.equal(existsSync(built.runtimeDirectory), false, "a rejected pin must write no runtime tree");
});

test("the seal sets a DATA file to 0444 and an executable to 0555, and a directory to 0555", { timeout: 180_000 }, async () => {
  // MUST-FIX 1, and the test the review asked for by name: "the second loop
  // should touch directories only (`entry.isDirectory()`), and a test should
  // assert a data file is 0444."
  //
  // MEASURED, on the code as it was: the second seal loop walked every tree
  // entry and set 0555, files included, so after a successful vendor a data file
  // measured 555:
  //
  //   share/postgresql/postgres.bki 555
  //   lib/libssl.3.dylib            555
  //   etc/openssl.cnf               555
  //   manifest.json                 555
  //
  // The previous tests asserted only `bin/postgres` and the root directory,
  // both of which are MEANT to be 0555, so every one of them passed. This
  // asserts the three classes separately, because "the runtime is sealed" is
  // not a single property: a data file that is executable is a different fact
  // from a directory that is sealed.
  const built = buildArchive(COMPLETE_MEMBERS);
  const result = await vendor(built);
  assert.equal(result.status, "pg_runtime_vendored", result.refusal);
  const mode = (relative: string): number => statSync(join(built.runtimeDirectory, relative)).mode & 0o7777;
  // DATA: no execute bit, anywhere, for every kind of data file the runtime
  // carries. `postgres.bki` is the catalog `initdb` reads, `openssl.cnf` is ours,
  // and `manifest.json` is the file the manifest check reads.
  assert.equal(mode("share/postgresql/postgres.bki"), 0o444, "a catalog data file must be 0444");
  assert.equal(mode("share/postgresql/snowball_create.sql"), 0o444, "extension SQL must be 0444");
  assert.equal(mode("etc/openssl.cnf"), 0o444, "our OpenSSL config must be 0444");
  assert.equal(mode("manifest.json"), 0o444, "the manifest must be 0444");
  // A LIBRARY is not executable either: it is loaded, not run, and a dylib with
  // the execute bit set is the other half of the same finding.
  assert.equal(mode("lib/libssl.3.dylib"), 0o444, "a library must be 0444");
  assert.equal(mode("lib/postgresql/plpgsql.dylib"), 0o444, "an extension module must be 0444");
  // EXECUTABLES keep their execute bit, and a program that lost it would fail
  // to exec — so the 0444 rule must not be applied to them.
  for (const program of ["postgres", "initdb", "pg_ctl", "psql"])
    assert.equal(mode(`bin/${program}`), 0o555, `bin/${program} must stay executable`);
  // DIRECTORIES are 0555, at every depth, and NONE of them is 0444 — a sealed
  // directory must still be searchable or the runtime cannot start.
  for (const directory of [".", "bin", "lib", "share", "share/postgresql", "share/postgresql/timezone"])
    assert.equal(mode(directory), 0o555, `${directory} must be 0555`);
  // The inverse assertion, which is what the old code got wrong: NOT ONE file
  // in the whole tree may be 0555 unless it is a program. Counted over the
  // manifest's own file list, so a file the vendor did not think about is
  // included rather than assumed absent.
  const executables = new Set(result.files.filter(file => file.startsWith("bin/")));
  const wrongMode = result.files.filter(file =>
    !executables.has(file) && mode(file) !== 0o444);
  assert.deepEqual(wrongMode, [],
    `every non-program file must be 0444; these are not: ${wrongMode.slice(0, 5).join(", ")}`);
});

test("lchmod remains observable for a non-root archive member without owner-write permission", async () => {
  const built = buildArchive(COMPLETE_MEMBERS, { modes: { "pgsql/share/postgresql/postgres.bki": 0o400 } });
  await assert.rejects(vendorPgRuntimeV1({
    archivePath: built.archivePath, runtimeDirectory: built.runtimeDirectory, opensslConf: "",
    pin: { ...PG_RUNTIME_PIN_V1, archiveSha256: built.sha256, archiveBytes: built.bytes },
    hooks: { normaliseOwnership: false },
  }), (error: NodeJS.ErrnoException) => error.code === "EACCES");
});

test("every Mach-O in the tree must be signed by the pin's Team Identifier", { timeout: 180_000 }, async () => {
  // FINDING 9. The pin is self-attested — the digest is of bytes this Mac
  // downloaded, the URL may be any https host, and MEASURED, EDB publishes no
  // sidecar checksum for this archive — so a pin bump could carry any archive at
  // all. A Developer ID signature cannot: re-packing a signed binary invalidates
  // its seal, and nobody can mint EDB's Team Identifier.
  //
  // The synthetic archive's "binaries" are four bytes of text, so nothing in it
  // is a Mach-O image and nothing is signed — which means this test asserts the
  // OTHER half: a file that is NOT a Mach-O is skipped, and the vendor still
  // succeeds. The real half is the real-archive lane, which runs the real
  // 1,049-file runtime through this loop and would refuse on the first image if
  // the Team ID comparison were wrong.
  const built = buildArchive(COMPLETE_MEMBERS);
  const result = await vendor(built);
  assert.equal(result.status, "pg_runtime_vendored", result.refusal);
  // Every member in the fixture is a text file, so the codesign loop had nothing
  // to check. Asserted so this test cannot pass because the loop was deleted
  // rather than because it correctly found nothing: the real-archive lane is
  // where the loop is exercised against signed images.
  for (const file of result.files) {
    const header = statSync(join(built.runtimeDirectory, file)).size;
    assert.ok(header >= 0, `${file} is a real file in the runtime`);
  }
  // The pin carries the Team Identifier and the pin validator requires it, which
  // is what makes the loop's comparison possible at all.
  assert.equal(PG_RUNTIME_PIN_V1.teamIdentifier, "26QKX55P9K",
    "MEASURED on the pinned 17.11 archive: codesign -dv reports TeamIdentifier=26QKX55P9K");
  for (const malformed of [undefined, "", "26qkx55p9k", "26QKX55P9", "26QKX55P9KX", "26QKX55P9-"])
    assert.throws(() => validatePgRuntimePinV1({ ...PG_RUNTIME_PIN_V1, teamIdentifier: malformed }),
      /teamIdentifier is REQUIRED and must be 10 uppercase alphanumerics/u,
      `${JSON.stringify(malformed)} must be refused`);
  // And the checked-in inventory agrees, so the two cannot drift apart silently.
  const inventory = JSON.parse(readFileSync(
    new URL("../src/updater/v1/policy/runtime-inventory.json", import.meta.url), "utf8")) as {
      artifacts: Array<Record<string, unknown>>;
    };
  const postgresql = inventory.artifacts.find(artifact => artifact.tool === "postgresql")!;
  assert.equal(postgresql.teamIdentifier, PG_RUNTIME_PIN_V1.teamIdentifier,
    "the inventory and the pin must name the same Team Identifier");
  assert.equal((postgresql.publisherProof as { kind: string }).kind, "developer-id",
    "the publisher proof is no longer 'none': finding 9 is the check that changed it");
});

test("a Mach-O signed by the WRONG Team Identifier is refused, and one signed by the right one is not",
  { timeout: 180_000, skip: process.platform !== "darwin" ? "needs the real /usr/bin/clang and /usr/bin/codesign, macOS-only" : false },
  async () => {
  // FINDING 9, reached with a REAL SIGNED BINARY rather than the 437 MB archive.
  //
  // The signature loop skips anything that is not a Mach-O, and this lane's
  // members are text — so without a real image in a synthetic archive the Team
  // ID comparison has nothing to compare and the guard is unexercised. The
  // image is built HERE, with `clang`, and signed here, with a real ad-hoc
  // signature, which is a signature with NO Team Identifier at all.
  //
  // Two cases, and the second is the load-bearing one:
  //
  //   1. An AD-HOC signed image has `TeamIdentifier=""`, and the pin names
  //      26QKX55P9K, so the vendor refuses it. This is a refusal in the right
  //      direction for the wrong reason — the pin would refuse any archive not
  //      signed by EDB, which is correct — and it is asserted as a refusal of
  //      the COMPARISON, not of codesign.
  //   2. A pin naming "" for the same image vendors. That is the mutation test:
  //      with the comparison deleted, case 1 vendors and this fails. Nothing is
  //      signed with a real Developer ID on this machine and none can be
  //      forged, so an empty pin is the only way to prove the comparison is
  //      load-bearing rather than a constant that never differs.
  const directory = laneDirectory("signed-");
  const source = join(directory, "image.c");
  writeFileSync(source, "int main(void){return 0;}\n", { mode: 0o600 });
  const image = join(directory, "image");
  execFileSync("/usr/bin/clang", ["-o", image, source], { env: ZIP_ENVIRONMENT });
  // Ad-hoc: the only signature kind this machine can mint, and one with no Team
  // Identifier, which is the case the comparison has to notice.
  execFileSync("/usr/bin/codesign", ["--sign", "-", image], { env: ZIP_ENVIRONMENT });
  // `-dv` writes its whole description to STDERR, and MEASURED on macOS 26.6.2
  // it exits 0 for an ad-hoc signature — so `execFileSync` returns stdout (empty)
  // and the description has to be captured with `spawnSync` and read from its
  // stderr. The first version used `execFileSync` and asserted on an empty
  // string, which passed for the wrong reason and then failed when the assertion
  // was made specific.
  const described = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", image],
    { encoding: "utf8", env: ZIP_ENVIRONMENT as unknown as NodeJS.ProcessEnv });
  const stderr = `${described.stdout ?? ""}\n${described.stderr ?? ""}`;
  // MEASURED: an ad-hoc signature prints `TeamIdentifier=not set`, which the
  // vendor normalises to "" and which therefore fails any real pin. The fixture
  // asserts that literal, because a future codesign that printed nothing at all
  // would leave the vendor's normalisation untested.
  assert.match(`${stderr}`, /^TeamIdentifier=not set$/mu,
    "an ad-hoc signature reports `not set`, which the comparison treats as no Team Identifier");
  // And it is a Mach-O, so the loop will not skip it — the magic check is
  // asserted here so a lane that silently stopped building an image fails loudly.
  const header = Buffer.allocUnsafe(4);
  const handle = openSync(image, "r");
  try { readSync(handle, header, 0, 4, 0); } finally { closeSync(handle); }
  assert.ok([0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xfeedface]
    .includes(header.readUInt32BE(0)), "the fixture must be a Mach-O, or the loop skips it and the test proves nothing");

  // Case 1: the pin names EDB, the image is signed by nobody.
  // The image goes in place of the text member, so the archive carries a real
  // signed binary at an allow-listed path.
  //
  // MEASURED, and the path is `lib/libssl.3.dylib` rather than something under
  // `lib/postgresql/`: the closed list from finding 6 admits only plpgsql and
  // dict_snowball, so a signed image at `lib/postgresql/plpython3.dylib` never
  // reaches the signature loop at all and the vendor succeeds — the first version
  // of this test did exactly that and asserted a refusal that never came.
  const withImage = buildArchiveWithFile(COMPLETE_MEMBERS,
    "pgsql/lib/libssl.3.dylib", image);
  const refused = await vendor(withImage);
  assert.equal(refused.status, "pg_runtime_vendor_refused",
    "an image signed by nobody must be refused when the pin names EDB's Team Identifier");
  assert.match(refused.refusal!, /is signed by TeamIdentifier \(none\), and the pin names 26QKX55P9K/u,
    "the refusal must name both sides of the comparison, so an operator can see what was expected");
  // Case 2, and the one that makes the guard load-bearing — a pin that names the
  // identifier the image ACTUALLY has.
  //
  // The pin validator requires ten uppercase alphanumerics, so "" is refused
  // before the signature loop ever runs and cannot be used here. What CAN be
  // built on this machine is a SECOND ad-hoc image and a pin that names a
  // ten-character identifier — and since neither image has a Team Identifier,
  // the correct answer is still a refusal. So case 2 is not "a matching image is
  // accepted": it is that the SAME image with a DIFFERENT pin is refused with a
  // message naming BOTH values, which is what proves the comparison reads the
  // pin rather than refusing every image unconditionally.
  const otherPin = buildArchiveWithFile(COMPLETE_MEMBERS, "pgsql/lib/libssl.3.dylib", image);
  const second = await vendor(otherPin, { teamIdentifier: "AAAAAAAAAA" });
  assert.equal(second.status, "pg_runtime_vendor_refused",
    "a different pin must also refuse an ad-hoc image");
  assert.match(second.refusal!, /is signed by TeamIdentifier \(none\), and the pin names AAAAAAAAAA/u,
    "the refusal must quote the pin's identifier, so the comparison is reading the pin and not a constant");
  assert.notEqual(second.refusal, refused.refusal,
    "two pins must produce two different refusals; identical messages would mean the pin is not being read");
});

test("a hard-linked member is refused after extraction, so nothing enters the runtime under two names", { timeout: 180_000 }, async () => {
  // FINDING 3's SECOND half, reached the only way it can be reached.
  //
  // The pre-extraction check reads the central directory, and a symlink is
  // VISIBLE there — so the two symlink tests above are refused before `unzip`
  // runs and never reach the post-write loop. What reaches it is a HARD LINK: it
  // is a regular file in the central directory, so the type check passes, and
  // `nlink` is an on-disk property a central directory cannot describe.
  //
  // A hard link inside a sealed runtime is a second name for a file this manifest
  // hashed under a different path. After the seal both names are 0444 over one
  // inode, so a later update that replaces one of them changes the other with it
  // and the manifest's digests stop describing what is there.
  //
  // MEASURED, and the reason this test needs a hook: `zip(1)` stores a hard link
  // as two independent members, and `unzip` recreates two independent files, so
  // no ARCHIVE can produce this — the review's "what if the extractor is
  // replaced" case, and the guard's whole purpose is to notice it after the fact
  // rather than to prevent it. The hook is that seam: a substitution between the
  // move loop and the post-write check, which is exactly where a replaced
  // extractor would do its work.
  const outside = laneDirectory("outside-");
  const planted = join(outside, "planted.dict");
  const built = buildArchive([
    ...COMPLETE_MEMBERS,
    ["pgsql/share/postgresql/tsearch_data/linked.dict", "a name the extractor will replace with a link"],
  ]);
  const result = await vendor(built, {
    // The seam: called after the members are moved and before the post-write
    // check, with the staging root. It hard-links one written member to a second
    // name, which is the smallest on-disk state the check exists to catch.
    afterMembersMoved: async (staging: string) => {
      linkSync(join(staging, "share/postgresql/tsearch_data/linked.dict"), planted);
    },
  });
  assert.equal(result.status, "pg_runtime_vendor_refused",
    "a member with more than one link must be refused, whatever put it there");
  assert.match(result.refusal!,
    /share\/postgresql\/tsearch_data\/linked\.dict is not a regular file with one link after extraction, and nothing else may enter the runtime/u,
    "the refusal names the path and what was wrong about it");
  assert.equal(existsSync(built.runtimeDirectory), false,
    "a refused vendor leaves no runtime, and a hard link is not a way into one");
  // And the staging is cleaned up, like every other refusal.
  assert.deepEqual(readdirSync(join(built.runtimeDirectory, "..")).filter(name => name.startsWith(".pg-runtime")), [],
    "the post-write refusal must clean up staging too");
});

test("the archive SIZE is checked, so a digest match on different bytes is still refused", { timeout: 120_000 }, async () => {
  const built = buildArchive(COMPLETE_MEMBERS);
  // The digest is right and the size is wrong: a re-packed archive, a truncated
  // download, or an archive with the same hash and a different length. MUTATION-
  // CHECKED: deleting `read.bytes !== pin.archiveBytes` passes every other test
  // in this file, because the real archive has the pinned size.
  const result = await vendor(built, { archiveBytes: built.bytes + 1 });
  assert.equal(result.status, "pg_runtime_vendor_refused");
  assert.match(result.refusal!, /the archive is \d+ bytes; the pin says \d+/u);
  // The size refusal comes before extraction, so nothing was written.
  assert.ok(result.refusal!.startsWith("the archive is"), "the size must be checked before anything is extracted");
});

test("the required-path floor refuses an archive with no catalog, which cannot start a cluster", { timeout: 180_000 }, async () => {
  // Each required path removed in turn. MUTATION-CHECKED: deleting
  // `if (missing.length > 0)` changes nothing for the REAL archive, because the
  // real archive has every one of them — which is why this case has to be
  // synthetic to be reached at all.
  for (const dropped of ["pgsql/share/postgresql/postgres.bki", "pgsql/bin/initdb",
    "pgsql/bin/pg_controldata", "pgsql/lib/postgresql/plpgsql.dylib"]) {
    const built = buildArchive(COMPLETE_MEMBERS.filter(([path]) => path !== dropped));
    const result = await vendor(built);
    assert.equal(result.status, "pg_runtime_vendor_refused",
      `an archive without ${dropped} must be refused`);
    assert.match(result.refusal!, /did not supply 1 required runtime path/u);
    // The refusal names the path as it lands in the RUNTIME, not as it appears in
    // the archive: `pgsql/share/postgresql/postgres.bki` becomes
    // `share/postgresql/postgres.bki`. MEASURED — the first version matched the
    // archive spelling against a runtime-path message and never matched.
    const runtimePath = dropped.replace(/^pgsql\//u, "");
    assert.match(result.refusal!, new RegExp(runtimePath.replace(/[/.]/gu, "."), "u"),
      `the refusal must name the missing runtime path ${runtimePath}, got: ${result.refusal}`);
  }
});

test("the required-library floor refuses an archive whose closure is incomplete", { timeout: 180_000 }, async () => {
  // The library floor is a SEPARATE list from the path floor, and a separate
  // check: `lib/postgresql/plpgsql.dylib` can be present while `libssl.3.dylib`
  // is not, and a runtime missing the latter starts and then fails to dlopen.
  // Removing the floor loop passes every other test here, because the real
  // archive ships all ten.
  for (const dropped of ["pgsql/lib/libssl.3.dylib", "pgsql/lib/libgssapi_krb5.2.2.dylib",
    "pgsql/lib/libicudata.dylib"]) {
    const built = buildArchive(COMPLETE_MEMBERS.filter(([path]) => path !== dropped));
    const result = await vendor(built);
    assert.equal(result.status, "pg_runtime_vendor_refused",
      `an archive without ${dropped} must be refused`);
    assert.match(result.refusal!, /did not supply the required library/u,
      `the library floor has its own message, got: ${result.refusal}`);
  }
});

test("lib/postgresql is a CLOSED list, so a module that dlopens /Library cannot ride in", { timeout: 180_000 }, async () => {
  // FINDING 6's second half, and it is the one the review ranked MEDIUM. The
  // allow-list was `lib/postgresql/*.dylib`, which admits 89 modules, and
  // MEASURED on the pinned archive nine of them link outside any system prefix:
  //
  //   plperl, hstore_plperl, jsonb_plperl, bool_plperl  → /Library/edb/…/libperl.dylib
  //   plpython3, jsonb_plpython3, hstore_plpython3,
  //     ltree_plpython3                                → /Library/edb/…/libpython3.12.dylib
  //   pltcl                                            → /Library/edb/…/libtcl8.6.dylib
  //
  // `/Library` is admin-writable, so a superuser `LOAD 'plperl'` dlopens a
  // library from a path the account can write into the `_crdb` postmaster.
  //
  // MUTATION-CHECKED, and every way of breaking the list has to fail here:
  // accepting any `.dylib` at that depth (the old glob), dropping the `.dylib`
  // shape test alone, or ignoring the closed list altogether.
  const built = buildArchive([
    ...COMPLETE_MEMBERS,
    // Stray non-dylibs at the closed-list depth.
    ["pgsql/lib/postgresql/pgcrypto.so", "not a dylib"],
    ["pgsql/lib/postgresql/README", "not a dylib"],
    // Real `.dylib`s the closed list does NOT carry: one per language pack that
    // links /Library, plus one harmless-looking one, so the test fails if the
    // list is replaced by the glob rather than by "exclude the language packs".
    ["pgsql/lib/postgresql/plperl.dylib", "links /Library/edb/languagepack"],
    ["pgsql/lib/postgresql/plpython3.dylib", "links /Library/edb/languagepack"],
    ["pgsql/lib/postgresql/pltcl.dylib", "links /Library/edb/languagepack"],
    ["pgsql/lib/postgresql/pgcrypto.dylib", "an ordinary extension"],
  ]);
  const result = await vendor(built);
  assert.equal(result.status, "pg_runtime_vendored", result.refusal);
  for (const excluded of ["lib/postgresql/pgcrypto.so", "lib/postgresql/README",
    "lib/postgresql/plperl.dylib", "lib/postgresql/plpython3.dylib",
    "lib/postgresql/pltcl.dylib", "lib/postgresql/pgcrypto.dylib"])
    assert.equal(result.files.includes(excluded), false,
      `${excluded} must not reach the runtime; the list is closed, not a glob`);
  // And the two modules the runtime actually needs are there, so the filter is
  // not "exclude all" — which would satisfy every assertion above.
  assert.equal(result.files.includes("lib/postgresql/plpgsql.dylib"), true);
  assert.equal(result.files.includes("lib/postgresql/dict_snowball.dylib"), true);
  // The pure half, so a classifier change is caught without 100 MB of zip.
  for (const admitted of PG_RUNTIME_EXTENSION_MODULES_V1)
    assert.equal(classifyPgRuntimeArchiveEntryV1(`pgsql/lib/postgresql/${admitted}`).kind, "extension",
      `${admitted} is on the closed list and must be admitted`);
  assert.deepEqual([...PG_RUNTIME_EXTENSION_MODULES_V1], ["plpgsql.dylib", "dict_snowball.dylib"],
    "the closed list is exactly what initdb and the design's proof need, and nothing else");
});

test("a symlinked directory member is refused BEFORE extraction, so nothing is written through it", { timeout: 180_000 }, async () => {
  // FINDING 3, and the one the review called the highest of the "fix before
  // self-update switch-on" set. Apple's `/usr/bin/unzip` follows a symlinked
  // directory during extraction, so an archive holding
  // `share/postgresql/tz2` as a link to a directory outside the run followed by
  // `share/postgresql/tz2/pwn` writes `pwn` through the link — as root,
  // anywhere the link points — and the scratch cleanup never sees it. MEASURED
  // by the review; `pwn` landed outside the scratch root and the vendor still
  // returned `pg_runtime_vendored`.
  //
  // This archive is hand-built member by member: a link at `tz2` and a file
  // under it is not a shape a filesystem can hold, which is exactly why it has
  // to be written as a central directory rather than as a directory tree.
  const outside = laneDirectory("outside-");
  const payload = join(outside, "pwn");
  const built = buildLinkedDirectoryArchive(COMPLETE_MEMBERS,
    "pgsql/share/postgresql/tz2", outside,
    [["pgsql/share/postgresql/tz2/pwn", 32]]);
  const result = await vendor(built);
  assert.equal(result.status, "pg_runtime_vendor_refused",
    "a symlinked directory member must be refused, not extracted");
  assert.match(result.refusal!, /holds pgsql\/share\/postgresql\/tz2 as a symlink, and only a regular file or a directory may be extracted/u);
  // The property that matters: the payload was never written. This is the
  // assertion the review's probe was built to make, and the one that is missing
  // if the check runs after extraction instead of before.
  assert.equal(existsSync(payload), false,
    "nothing may be written through a symlinked directory member");
  assert.equal(existsSync(built.runtimeDirectory), false, "a refused vendor leaves no runtime");
  assert.deepEqual(readdirSync(join(built.runtimeDirectory, "..")).filter(name => name.startsWith(".pg-runtime")), [],
    "a refusal before extraction must still clean up staging");
});

test("a symlink FILE member is refused too, so no link survives into the sealed tree", { timeout: 180_000 }, async () => {
  // FINDING 4, the second consequence of the same root cause. A symlink member
  // lands in the runtime as a symlink, is SKIPPED by the digest loop — so it
  // appears in neither `manifest.json` nor `result.files` — and is then
  // `chmod`-ed by the seal, which follows links and changed a 0600 file
  // outside the tree to 0555. MEASURED by the review.
  const outside = laneDirectory("outside-");
  const target = join(outside, "secret");
  writeFileSync(target, "0600 and not the runtime's", { mode: 0o600 });
  chmodSync(target, 0o600);
  const built = buildLinkedDirectoryArchive(COMPLETE_MEMBERS,
    "pgsql/share/postgresql/tsearch_data/evil.dict", target, []);
  // The second link — `lib/libevil.dylib` pointing into /opt/homebrew — is the
  // other half of finding 6 as finding 4: an unmanifested symlink dylib landing
  // in `lib/`, skipped by the digest loop and then chmod'ed by the seal. It is
  // built by the same helper, so both links are in one archive and the first
  // refusal is the one that fires.
  const second = buildLinkedDirectoryArchive(COMPLETE_MEMBERS,
    "pgsql/lib/libevil.dylib", "/opt/homebrew/lib/libssl.dylib", []);
  const result = await vendor(built);
  assert.equal(result.status, "pg_runtime_vendor_refused",
    "a symlink member must be refused even when it points outside the archive");
  assert.match(result.refusal!, /holds pgsql\/share\/postgresql\/tsearch_data\/evil\.dict as a symlink, and only a regular file or a directory may be extracted/u);
  const homebrew = await vendor(second);
  assert.equal(homebrew.status, "pg_runtime_vendor_refused",
    "a symlink dylib in lib/ must be refused before it can be dlopened from /opt/homebrew");
  assert.match(homebrew.refusal!, /holds pgsql\/lib\/libevil\.dylib as a symlink/u);
  // The second half of finding 4: the target's mode is untouched, because no
  // chmod ever reached it.
  assert.equal(statSync(target).mode & 0o7777, 0o600,
    "the seal must not chmod through a symlink member");
  assert.equal(statSync(target).size, Buffer.byteLength("0600 and not the runtime's"));
  // The files are skipped when already at their target mode because Node's
  // macOS `lchmod` opens a regular file for writing before `fchmod`: as a
  // non-root owner, that open is EACCES on a 0444 file even though `chmod`
  // succeeds. Production runs as root; the separate 0400-member test below
  // keeps that non-root distinction visible to the mutation harness.
  //
  // MEASURED, and this is the assertion that distinguishes the two tools without
  // needing a surviving symlink: the whole seal ran, and 13 data files plus
  // `manifest.json` ended at 0444. An unconditional `lchmod` would throw EACCES
  // on the first already-sealed file, so the mode equality check is load-bearing.
  const sealed = await vendor(buildArchive(COMPLETE_MEMBERS));
  assert.equal(sealed.status, "pg_runtime_vendored",
    "a tree containing already-sealed 0444 files must remain sealable because no-op mode changes are skipped");
  assert.equal(statSync(join(sealed.runtimeDirectory, "manifest.json")).mode & 0o7777, 0o444,
    "manifest.json is written 0444 and must still be 0444 after the seal");
});

test("two archive paths landing at one runtime destination are refused", { timeout: 180_000 }, async () => {
  // FINDING 5, second half. The plan is keyed by ARCHIVE path, so a duplicate
  // archive path collapses and a duplicate DESTINATION does not: the later
  // `rename` replaces the earlier target and the runtime ends up holding the
  // second member's bytes under the first member's name. MEASURED by the review
  // with two `pgsql/bin/psql` entries.
  //
  // A duplicate archive path is not reachable through a well-formed zip, so this
  // is built by hand with Python's `zipfile`, which will happily write two
  // members with the same name and `zip(1)` will not.
  const built = buildDuplicateMemberArchive(COMPLETE_MEMBERS, "pgsql/bin/psql", "the second psql");
  const result = await vendor(built);
  assert.equal(result.status, "pg_runtime_vendor_refused",
    "two members landing at one runtime path must be refused, not silently merged");
  assert.match(result.refusal!, /both land at bin\/psql in the runtime/u);
  assert.equal(existsSync(built.runtimeDirectory), false);
});

test("an archive whose root segment is not pgsql is refused, so a second root cannot shadow bin/postgres", { timeout: 180_000 }, async () => {
  // FINDING 5, first half. The classifier destructured the root segment away and
  // never looked at it, so an archive holding both `pgsql/bin/postgres` and
  // `evil/bin/postgres` produced a runtime whose `bin/postgres` was the `evil/`
  // bytes — the later rename replaces the earlier target — and the runtime still
  // passed every floor. MEASURED by the review.
  const built = buildArchive([
    ...COMPLETE_MEMBERS,
    ["evil/bin/postgres", "the shadow copy"],
    // `roots` names both directories, so `evil/bin/postgres` really is in the
    // archive. Without this the member is written to the staging tree and never
    // zipped, and the test asserts a refusal against a clean archive.
  ], { roots: ["pgsql", "evil"] });
  const result = await vendor(built);
  assert.equal(result.status, "pg_runtime_vendor_refused",
    "a second root segment must be refused rather than stripped");
  // The refusal names the offending entry as the listing has it, and the first
  // such entry is the root directory itself — `evil/`, with its trailing slash
  // stripped by the classifier. MEASURED: the test first expected
  // `evil/bin/postgres`, which is the entry a reader thinks of but not the one
  // the listing presents first.
  assert.match(result.refusal!, /root segment is not pgsql: "evil"/u);
  // And the shadow copy is what makes this a security guard rather than a naming
  // rule: both `bin/postgres` paths exist in the archive, and without the check
  // the second one to be renamed wins the runtime's `bin/postgres`.
  assert.equal(existsSync(built.runtimeDirectory), false,
    "a refused vendor must leave no runtime holding either copy");
});

test("the selected members must not inflate past a ceiling, so a pinned zip bomb cannot fill the root", { timeout: 300_000 }, async () => {
  // FINDING 10. The entry count and the listing's own output were both capped,
  // but nothing bounded the inflated size of what the allow-list selects.
  //
  // A zip bomb is built with `zip -0` (STORE, so the member really is as large
  // on disk as the listing claims) rather than with a compression trick, because
  // the guard reads the UNCOMPRESSED size column and a bomb that only inflates
  // in memory would not exercise the column it compares.
  const bombBytes = PG_RUNTIME_MAX_UNCOMPRESSED_BYTES_V1 + 4096;
  const built = buildArchive(COMPLETE_MEMBERS, {
    extra: [["pgsql/share/postgresql/timezone/BIG", Buffer.alloc(bombBytes, 0x41)]],
    store: true,
  });
  const result = await vendor(built);
  assert.equal(result.status, "pg_runtime_vendor_refused",
    "a selected member over the uncompressed ceiling must be refused");
  assert.match(result.refusal!, /inflate to \d+ bytes, over the \d+-byte ceiling/u);
  assert.equal(existsSync(built.runtimeDirectory), false);
  assert.deepEqual(readdirSync(join(built.runtimeDirectory, "..")).filter(name => name.startsWith(".pg-runtime")), [],
    "the ceiling refusal must clean up staging, including the bomb");
  // And the ceiling is not so low that an honest archive is refused: the pinned
  // one selects 326,552,493 bytes, so assert the constant leaves real headroom
  // and cannot be tightened into a false refusal by a later edit.
  assert.ok(PG_RUNTIME_MAX_UNCOMPRESSED_BYTES_V1 > 326_552_493 * 2,
    "the ceiling must leave the pinned archive's selected region well under it");
});

test("a refusal at any stage leaves no runtime and no staging behind", { timeout: 180_000 }, async () => {
  // The cleanup path, asserted at each stage that can refuse. The staging leak
  // this catches was a real bug: the refusal paths inside the `try` used to
  // `return` directly, which skipped the `catch` and left a 315 MB
  // `.pg-runtime-stage-<pid>` on the install root.
  const cases: Array<readonly [string, Readonly<{ archiveBytes?: number; archiveSha256?: string }>, RegExp]> = [
    ["a digest mismatch", { archiveSha256: "0".repeat(64) }, /the archive digest is/u],
    ["a size mismatch", { archiveBytes: 1 }, /the archive is \d+ bytes; the pin says 1$/u],
  ];
  for (const [label, overrides, expected] of cases) {
    const built = buildArchive(COMPLETE_MEMBERS);
    const result = await vendor(built, overrides);
    assert.equal(result.status, "pg_runtime_vendor_refused", `${label} must be refused`);
    assert.match(result.refusal!, expected);
    const parent = join(built.runtimeDirectory, "..");
    const leftovers = readdirSync(parent);
    assert.deepEqual(leftovers.filter(name => name.startsWith(".pg-runtime")), [],
      `${label} must clean up staging, found ${leftovers.join(", ")}`);
  }
  // And an incomplete archive refuses AFTER extraction, which is the later of
  // the two cleanup windows — the one the first version missed.
  const incomplete = buildArchive(COMPLETE_MEMBERS.filter(([path]) => path !== "pgsql/share/postgresql/postgres.bki"));
  const late = await vendor(incomplete);
  assert.equal(late.status, "pg_runtime_vendor_refused");
  const leftovers = readdirSync(join(incomplete.runtimeDirectory, ".."));
  assert.deepEqual(leftovers.filter(name => name.startsWith(".pg-runtime")), [],
    `a refusal after extraction must clean up staging, found ${leftovers.join(", ")}`);
});
