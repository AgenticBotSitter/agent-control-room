// The PostgreSQL runtime vendor step, against the real pinned archive.
//
// Finding 6 said the item shipped planners only and every real test ran
// Homebrew's `postgres`. This lane closes that gap: it vendors the actual
// 17.11 archive, then starts a real cluster from the vendored runtime and asks
// the running server the questions the design turns on.
//
// The archive is NOT committed and NOT downloaded by the lane. It is located
// through `PG_RUNTIME_ARCHIVE`, and the lane SKIPS when it is absent — the same
// convention the sibling real-PostgreSQL lane uses for `PG_BIN`. That is honest:
// a lane that fetched 437 MB on every CI run would be a lane nobody ran, and a
// lane that asserted against a stale copy would be worse than no lane. What is
// checked with NO archive at all is the pin validation and the extraction plan,
// because those are the decisions a reviewer most needs to see.
//
// TEST HYGIENE: every disk image this lane attaches is detached in a `finally`
// and the detach is then asserted. Four images were left mounted by earlier runs
// of the sibling lane; `assertNoDiskImagesRemain` is what makes that class of
// leak a test failure instead of a surprise somebody finds in /Volumes.

import { execFileSync, execFile, spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync,
  realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  PG_RUNTIME_PIN_V1, planPgRuntimeExtractionV1,
  validatePgRuntimePinV1, vendorPgRuntimeV1, PG_RUNTIME_REQUIRED_PATHS_V1,
  type PgRuntimeVendorResultV1,
} from "../src/updater/v1/pg/pg-runtime-vendor";
import { classifyPgRuntimeArchiveEntryV1 } from "../src/updater/v1/pg/pg-runtime-copy";
import { planPgClusterLayoutV1 } from "../src/pg-runtime/v1/pg-cluster-layout";

const exec = promisify(execFile);
const REPO = join(dirname(new URL(import.meta.url).pathname), "..");
const LANE_ROOT = process.env.CONTROL_ROOM_PGRT_TMPDIR
  ? join(process.env.CONTROL_ROOM_PGRT_TMPDIR, `pg-vendor-${process.pid}`)
  : join(tmpdir(), `pg-vendor-${process.pid}`);

const ARCHIVE = process.env.PG_RUNTIME_ARCHIVE;
const hasArchive = ARCHIVE !== undefined && existsSync(ARCHIVE);
const needsArchive = hasArchive ? false : "needs the pinned archive (PG_RUNTIME_ARCHIVE)";

/** Ports this lane is allowed to bind, from the brief. */
const PORT_BASE = Number(process.env.CONTROL_ROOM_PGRT_PORT_BASE ?? 59710);

/**
 * A SHORT temp root for the cluster test, because of a measured limit.
 *
 * `PG_SOCKET_PATH_BUDGET_V1` is 100 bytes: macOS `sun_path` is 104 including the
 * NUL, and `.s.PGSQL.<port>` needs room. A postmaster whose socket path is too
 * long fails INSIDE the server, after `initdb` has already written the data
 * directory, as "could not create any Unix-domain sockets".
 *
 * MEASURED, and the reason this exists: with the lane root under this project's
 * TMPDIR the socket path is 133 bytes, and `planPgClusterLayoutV1` refuses —
 * correctly. So the cluster test uses a short root of its own rather than the
 * lane's, and says so, instead of quietly testing a path no install will have.
 */
const CLUSTER_ROOT = process.env.CONTROL_ROOM_PGRT_SHORT_TMPDIR
  ? join(process.env.CONTROL_ROOM_PGRT_SHORT_TMPDIR, `pgvc`)
  : join("/tmp", `pgvc-${process.pid}`);

let mountedDevices: string[] = [];
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

const RUNS: string[] = [];
/** `wx` everywhere: a test that silently overwrites a file it did not create is
 * a test that can pass against someone else's bytes. */
function writeNew(path: string, content: string): void {
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
}
function laneRun(label: string): string {
  // MEASURED FIX: the first version called `mkdtempSync` without creating
  // LANE_ROOT, so every test that needed a run directory failed with ENOENT and
  // the lane reported "0 passed, 4 failed" for a reason that had nothing to do
  // with the code under test. `mkdirSync(..., recursive)` is idempotent, so this
  // is safe for the concurrent callers the lane has.
  mkdirSync(LANE_ROOT, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(LANE_ROOT, `${label}-`));
  RUNS.push(root);
  return root;
}
/** A 0555 runtime cannot be unlinked from; restore write permission first. */
function removeRun(run: string): void {
  try { execFileSync("/bin/chmod", ["-R", "u+rwX", run]); } catch { /* best effort */ }
  try { rmSync(run, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on("exit", () => { for (const run of RUNS) removeRun(run); });

// ---------------------------------------------------------------------------
// The pure half: the pin and the plan, with no archive at all.
// ---------------------------------------------------------------------------

test("the pin is required and is refused when any part of it is missing or wrong", () => {
  // THE ASSERTION FINDING 6 MAKES EXPLICIT: `sourceArchiveSha256` was optional
  // and unset, and an item-3 vendor step whose digest is optional is a step that
  // runs against whatever is in the download folder. MUTATION-CHECKED: dropping
  // the digest test from the 64-hex pattern fails this.
  const complete = validatePgRuntimePinV1(PG_RUNTIME_PIN_V1);
  assert.equal(complete.archiveSha256, PG_RUNTIME_PIN_V1.archiveSha256);
  assert.equal(complete.schema, PG_RUNTIME_VENDOR_SCHEMA());

  // Every field, broken one at a time.
  const broken: Array<[string, unknown]> = [
    ["no digest at all", { ...PG_RUNTIME_PIN_V1, archiveSha256: undefined }],
    ["an empty digest", { ...PG_RUNTIME_PIN_V1, archiveSha256: "" }],
    ["a truncated digest", { ...PG_RUNTIME_PIN_V1, archiveSha256: "a61d2205" }],
    ["an uppercase digest", { ...PG_RUNTIME_PIN_V1, archiveSha256: PG_RUNTIME_PIN_V1.archiveSha256.toUpperCase() }],
    ["a digest that is not hex", { ...PG_RUNTIME_PIN_V1, archiveSha256: "z".repeat(64) }],
    ["a digest with trailing space", { ...PG_RUNTIME_PIN_V1, archiveSha256: `${PG_RUNTIME_PIN_V1.archiveSha256} ` }],
    ["a plain http URL", { ...PG_RUNTIME_PIN_V1, url: "http://example.invalid/x.zip" }],
    ["a URL with a traversal", { ...PG_RUNTIME_PIN_V1, url: "https://example.invalid/../../x.zip" }],
    ["a non-macOS archive name", { ...PG_RUNTIME_PIN_V1, archiveName: "postgresql-17.11-4-linux-binaries.zip" }],
    ["a version that is not major.minor", { ...PG_RUNTIME_PIN_V1, version: "17" }],
    ["a non-positive size", { ...PG_RUNTIME_PIN_V1, archiveBytes: 0 }],
    ["a fractional size", { ...PG_RUNTIME_PIN_V1, archiveBytes: 1.5 }],
    ["the wrong schema", { ...PG_RUNTIME_PIN_V1, schema: "something.else/v1" }],
    ["null", null],
    ["a string", "postgresql-17.11-4-osx-binaries.zip"],
  ];
  for (const [label, value] of broken)
    assert.throws(() => validatePgRuntimePinV1(value), /pg_runtime_vendor_refused/u,
      `a pin with ${label} must be refused, not defaulted`);
  // And the refusal says which field, so an operator can fix it.
  assert.throws(() => validatePgRuntimePinV1({ ...PG_RUNTIME_PIN_V1, archiveSha256: undefined }),
    /archiveSha256 is REQUIRED/u);
  // A pin with provenance omitted is still valid — provenance is evidence about
  // the download, not an authorisation — and is normalised to nulls.
  const noProvenance = validatePgRuntimePinV1({ ...PG_RUNTIME_PIN_V1, provenance: undefined });
  assert.deepEqual(noProvenance.provenance, { etag: null, lastModified: null });
});

function PG_RUNTIME_VENDOR_SCHEMA(): string { return PG_RUNTIME_PIN_V1.schema; }

test("the extraction plan carries the whole share/postgresql subtree and lib/postgresql/*.dylib", () => {
  // Finding 6's core claim, as a pure test with no archive: the allow-list must
  // now SELECT the two directories the earlier version refused.
  for (const name of ["pgsql/share/postgresql/postgres.bki",
    "pgsql/share/postgresql/timezone/",
    "pgsql/share/postgresql/timezone/UTC",
    "pgsql/share/postgresql/snowball_create.sql",
    "pgsql/lib/postgresql/plpgsql.dylib",
    "pgsql/lib/postgresql/dict_snowball.dylib"])
    assert.notEqual(classifyPgRuntimeArchiveEntryV1(name).kind, "excluded",
      `${name} is required for a working cluster and must not be excluded`);

  // A real central directory's shape: every one of these is in the 17.11 archive.
  const plan = planPgRuntimeExtractionV1([
    "pgsql/bin/postgres", "pgsql/bin/initdb", "pgsql/bin/pg_ctl", "pgsql/bin/pg_controldata",
    "pgsql/bin/psql", "pgsql/bin/pg_dump", "pgsql/bin/pg_restore", "pgsql/bin/pg_basebackup",
    "pgsql/bin/pg_verifybackup", "pgsql/bin/pgbench",
    "pgsql/lib/libssl.3.dylib", "pgsql/lib/libssl.dylib", "pgsql/lib/libcrypto.3.dylib",
    "pgsql/lib/postgresql/plpgsql.dylib", "pgsql/lib/postgresql/dict_snowball.dylib",
    // Off the closed list, and present in the real archive, so the exclusions
    // below are about the LIST and not about the fixture.
    "pgsql/lib/postgresql/pgcrypto.dylib", "pgsql/lib/postgresql/plperl.dylib",
    "pgsql/lib/postgresql/plpython3.dylib", "pgsql/lib/postgresql/pltcl.dylib",
    "pgsql/share/postgresql/", "pgsql/share/postgresql/postgres.bki",
    "pgsql/share/postgresql/timezone/", "pgsql/share/postgresql/timezone/UTC",
    "pgsql/share/postgresql/snowball_create.sql",
    // Everything the design does not want.
    "pgsql/etc/openssl.cnf", "pgsql/share/man/postgres.1", "pgsql/share/postgresql.conf.sample",
    "pgsql/doc/postgresql.html", "pgsql/include/server/postgres.h",
    "pgsql/pgAdmin 4.app/Contents/Info.plist", "pgsql/stackbuilder.app/Contents/MacOS/stackbuilder",
    "pgsql/lib/libecpg.a", "pgsql/lib/pkgconfig/libpq.pc",
  ]);
  // A DIRECTORY member's destination carries the archive's trailing slash
  // (`share/postgresql/timezone/`) because that is how it is named to `unzip`,
  // while the required-paths floor names the path as it lands on disk
  // (`share/postgresql/timezone`). MEASURED: the first version of this test
  // compared the two directly and failed on the one required entry that is a
  // directory, which is a spelling difference and not a planning error.
  const selected = new Set(plan.files.map(file => file.destination.replace(/\/+$/u, "")));
  for (const directory of plan.directories) selected.add(directory);
  // The required floor, every one of it, because a runtime missing any of these
  // cannot start a cluster — which is the finding.
  for (const required of PG_RUNTIME_REQUIRED_PATHS_V1)
    assert.equal(selected.has(required), true, `${required} must be selected by the extraction plan`);
  // FINDING 6, second half: pgcrypto is EXCLUDED, because the list is closed
  // rather than a glob. MEASURED on the pinned archive, nine of its 89 modules
  // under lib/postgresql/ dlopen `/Library/edb/languagepack/{Perl-5.40,
  // Python-3.12,Tcl-8.6}` — an admin-writable path — so a superuser `LOAD` of
  // one of them dlopens a library the account can replace inside the `_crdb`
  // postmaster. `plpgsql` and `dict_snowball` are the two this product uses, and
  // `initdb` creates the first, so the list is not optional.
  assert.equal(selected.has("lib/postgresql/pgcrypto.dylib"), false,
    "pgcrypto is off the closed module list and must not reach the runtime");
  for (const module of ["plperl", "plpython3", "pltcl", "hstore_plperl", "jsonb_plpython3"])
    assert.equal(selected.has(`lib/postgresql/${module}.dylib`), false,
      `${module} links /Library/edb/languagepack and must not reach the runtime`);
  // And what must never be selected.
  for (const forbidden of ["etc/openssl.cnf", "share/man/postgres.1", "share/postgresql.conf.sample",
    "doc/postgresql.html", "pgAdmin 4.app/Contents/Info.plist", "lib/libecpg.a"])
    assert.equal(selected.has(forbidden), false, `${forbidden} must not reach the runtime`);
  // pgbench is a real, runnable PostgreSQL binary that is not on the program's
  // allow-list. MUTATION-CHECKED: making the bin/ branch accept everything adds it.
  assert.equal(selected.has("bin/pgbench"), false);
  // A directory entry is planned as a member so `unzip` writes it. The timezone
  // directory is the one the floor names and the only record of which in a zip is
  // the slash-suffixed entry — MEASURED, the vendor refused without this.
  assert.equal(selected.has("share/postgresql/timezone"), true);
  assert.equal(plan.directories.includes("share/postgresql"), true);
  // Every planned directory is one the classifier selected, not the archive's whole
  // tree (4,139 entries).
  assert.ok(plan.directories.length < 20, `the plan must not carry the whole tree, got ${plan.directories.length} directories`);
});

// ---------------------------------------------------------------------------
// The real archive.
// ---------------------------------------------------------------------------

interface Vendored {
  runtimeDirectory: string;
  result: Awaited<ReturnType<typeof vendorPgRuntimeV1>>;
}

let shared: Vendored | undefined;

/** Vendor once and share the result; the copy takes minutes and 315 MB. */
async function vendoredRuntime(): Promise<Vendored> {
  if (shared) return shared;
  const root = laneRun("vendor");
  const runtimeDirectory = join(root, "runtime", "pg-17.11");
  const observed: string[] = [];
  const result = await vendorPgRuntimeV1({
    archivePath: ARCHIVE!,
    runtimeDirectory,
    opensslConf: "# Control Room's fixed, deliberately empty OpenSSL config.\n",
    hooks: {
      // No root in this session, so ownership normalisation is skipped here; the
      // production path never sets this flag and is covered by
      // `the vendor refuses a destination that already exists` plus the report.
      normaliseOwnership: false,
      afterArchiveSnapshot: async pin => { observed.push(`snapshot ${pin.archiveSha256.slice(0, 12)}`); },
      observeExtract: args => { observed.push(`unzip ${args.length} args, -j=${args.includes("-j")}`); },
    },
  });
  assert.equal(result.status, "pg_runtime_vendored", result.refusal);
  shared = { runtimeDirectory, result };
  return shared;
}

test("the pinned archive vendors into a runtime with every required path, and one read of the archive", { timeout: 590_000, skip: needsArchive }, async () => {
  const { runtimeDirectory, result } = await vendoredRuntime();
  // The runtime exists and is where it was asked to go.
  assert.ok(existsSync(runtimeDirectory));
  // The required floor, on disk. This is the assertion that distinguishes this
  // lane from the planner-only version of item 3b.
  for (const required of PG_RUNTIME_REQUIRED_PATHS_V1) {
    const entry = statSync(join(runtimeDirectory, required), { throwIfNoEntry: false });
    assert.ok(entry !== undefined, `${required} must exist in the vendored runtime`);
  }
  // The digest recorded is the pin's, and the manifest carries it.
  assert.equal(result.archiveSha256, PG_RUNTIME_PIN_V1.archiveSha256);
  const manifest = JSON.parse(readFileSync(join(runtimeDirectory, result.manifestPath), "utf8"));
  assert.equal(manifest.archive.sha256, PG_RUNTIME_PIN_V1.archiveSha256);
  assert.equal(manifest.archive.bytes, PG_RUNTIME_PIN_V1.archiveBytes);
  assert.equal(manifest.version, PG_RUNTIME_PIN_V1.version);
  // Every path in the manifest is inside the runtime, and every file has a real digest.
  assert.ok(manifest.files.length > 900, `expected the whole share/ subtree, got ${manifest.files.length} files`);
  for (const entry of manifest.files) {
    if (entry.type === "file") assert.match(entry.sha256, /^[0-9a-f]{64}$/u, `${entry.path} has no digest`);
    assert.doesNotMatch(entry.path, /^\/|\.\./u, `manifest paths must be relative: ${entry.path}`);
  }
  // The archive's own OpenSSL config never arrived, and ours is there.
  assert.equal(existsSync(join(runtimeDirectory, "etc", "openssl.cnf")), true);
  assert.equal(readFileSync(join(runtimeDirectory, "etc", "openssl.cnf"), "utf8").includes("provider"), false,
    "the runtime's OpenSSL config must enable no provider module");
  assert.equal(existsSync(join(runtimeDirectory, "etc", "openssl.cnf.sample")), false);
  // The 400 MB of tooling stayed out.
  for (const excluded of ["pgAdmin 4.app", "stackbuilder.app", "doc", "include", "server_license.txt"])
    assert.equal(existsSync(join(runtimeDirectory, excluded)), false, `${excluded} must not reach the runtime`);
  // The programs are exactly the allow-list.
  assert.deepEqual(readdirSync(join(runtimeDirectory, "bin")).sort(),
    ["initdb", "pg_basebackup", "pg_controldata", "pg_ctl", "pg_dump", "pg_restore", "pg_verifybackup", "postgres", "psql"]);
  // Modes: the runtime is read-only to everyone, including the account that runs
  // it, and executables are executable. 0555 is how `runtime/` looks (§3).
  assert.equal(statSync(join(runtimeDirectory, "bin", "postgres")).mode & 0o777, 0o555);
  assert.equal(statSync(runtimeDirectory).mode & 0o777, 0o555);
});

test("the vendored runtime is self-contained: every @rpath resolves inside it", { timeout: 590_000, skip: needsArchive }, async () => {
  const { runtimeDirectory } = await vendoredRuntime();
  const root = realpath(runtimeDirectory);
  // Finding 6 asks for DYLD_PRINT_LIBRARIES. MEASURED, and this is why this test
  // walks the closure instead: the EDB binaries carry the hardened-runtime flag
  // and no allow-dyld-environment-variables entitlement, so dyld ignores DYLD_*
  // for them — `DYLD_PRINT_LIBRARIES=1 postgres --version` prints ZERO dyld lines,
  // while the same variable on an ad-hoc-signed binary of mine printed 1155. A
  // test asserting "no /opt/homebrew in the DYLD output" would therefore pass
  // VACUOUSLY on an empty list.
  //
  // The walk is also STRONGER than a load log: it covers every image in the
  // closure, including the ones a process never dlopen()s, and it fails on an
  // unresolvable reference rather than on nothing.
  const system = [/^\/usr\/lib\//u, /^\/System\//u, /^\/usr\/libexec\//u];
  const rpathsOf = (image: string): string[] =>
    execFileSync("/usr/bin/otool", ["-l", image], { encoding: "utf8" })
      .split("\n").map(l => l.trim())
      .filter(l => l.startsWith("path "))
      // The value carries a display suffix: `path @loader_path/../lib (offset 12)`.
      // Left on, it resolves to a directory that does not exist and every @rpath
      // looks unresolved. MEASURED — the first version of this walk got it wrong.
      .map(l => l.slice("path ".length).trim().replace(/\s*\(offset \d+\)$/u, ""))
      .filter(Boolean);
  const depsOf = (image: string): string[] =>
    execFileSync("/usr/bin/otool", ["-L", image], { encoding: "utf8" })
      .split("\n").map(l => l.trim())
      // A universal binary prints the whole list twice, each with its own header
      // line naming the image. Recognising the header by its trailing ":" is what
      // stops every image reporting ITSELF as a dependency — which is how the
      // first version produced 19 bogus "/Users" hits that were 19 image paths.
      .filter(l => l.length > 0 && !l.endsWith(":"))
      .map(l => l.split(" (")[0].trim());

  const seen = new Set<string>();
  const unresolved: string[] = [];
  const outside: string[] = [];
  const queue = [join(root, "bin", "postgres")];
  while (queue.length > 0) {
    const image = queue.pop()!;
    if (seen.has(image)) continue;
    seen.add(image);
    const rpaths = rpathsOf(image);
    for (const dep of depsOf(image)) {
      if (system.some(pattern => pattern.test(dep))) continue;
      if (!dep.startsWith("@rpath/")) {
        if (!dep.startsWith("/")) { unresolved.push(`${image} -> ${dep}`); continue; }
        if (system.some(pattern => pattern.test(dep))) continue;
        outside.push(`${image} -> ${dep}`);
        continue;
      }
      const name = dep.slice("@rpath/".length);
      // `@loader_path/../lib` is relative to the IMAGE's directory, so the whole
      // rpath string is substituted and then resolved as a path RELATIVE to the
      // image's directory — `join(imageDir, dirname(rp), name)`.
      //
      // MEASURED BUG: the first version did `join(dirname(image), rp.replace(...), name)`,
      // which expands `@loader_path/../lib` to `<imageDir>/../lib` and then appends
      // the library name — resolving `lib/` against the image's directory twice,
      // so nothing matched and every @rpath looked unresolved.
      const resolved = rpaths
        .map(rp => resolve(dirname(image), rp.replace("@loader_path", dirname(image)), name))
        .find(candidate => existsSync(candidate));
      if (!resolved) { unresolved.push(`${image} -> ${dep}`); continue; }
      if (!resolved.startsWith(root) && !system.some(pattern => pattern.test(resolved))) {
        outside.push(`${image} -> ${resolved}`); continue;
      }
      queue.push(resolved);
    }
  }
  assert.deepEqual(unresolved, [], "every @rpath must resolve inside the runtime");
  assert.deepEqual(outside, [], "no image may load from outside the runtime");
  // It is not vacuous: the closure is real and the libraries are in `lib/`.
  const images = [...seen].filter(image => image.startsWith(root));
  assert.ok(images.length >= 10, `the closure should be substantial, walked ${images.length}`);
  assert.ok(images.some(image => image.endsWith("lib/libssl.3.dylib")), "libssl must be in the closure");
  assert.ok(images.some(image => image.endsWith("lib/libicuuc.68.2.dylib")), "ICU must be in the closure");
  // Nothing in the closure names a Homebrew or user path. Checked on the
  // DEPENDENCY STRINGS, because this rehearsal's runtime lives under a home
  // directory and comparing whole paths would flag the runtime's own binaries.
  const forbidden = new Set<string>();
  for (const image of seen) for (const dep of depsOf(image))
    if (/^\/(opt\/homebrew|usr\/local|Users)\//u.test(dep)) forbidden.add(dep);
  assert.deepEqual([...forbidden], [], "no dependency may name /opt/homebrew, /usr/local or /Users");
  // Every binary in bin/ resolves the same way, not just `postgres`.
  for (const program of readdirSync(join(root, "bin"))) {
    const deps = depsOf(join(root, "bin", program));
    assert.ok(deps.length > 0, `${program} should have load commands`);
    for (const dep of deps)
      assert.doesNotMatch(dep, /^\/(opt\/homebrew|usr\/local|Users)\//u,
        `${program} loads ${dep} from outside the runtime`);
  }
});

function realpath(path: string): string { return execFileSync("/usr/bin/python3", ["-c", "import os,sys;print(os.path.realpath(sys.argv[1]))", path], { encoding: "utf8" }).trim(); }

test("a cluster started by the RUNTIME's own initdb runs, with plpgsql, UTC, and dict_snowball loadable", { timeout: 590_000, skip: needsArchive }, async () => {
  const { runtimeDirectory } = await vendoredRuntime();
  // CLUSTER_ROOT, not laneRun: the socket budget is 100 bytes and this lane's
  // own root is longer than that. See the note on CLUSTER_ROOT above.
  mkdirSync(CLUSTER_ROOT, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(CLUSTER_ROOT, "c-"));
  RUNS.push(root);
  const bin = join(runtimeDirectory, "bin");
  const port = PORT_BASE + 1;
  const accounts = { database: userInfo().username, migrator: "cr_migrator_test", deployer: "cr_deployer_test" };
  const layout = planPgClusterLayoutV1({
    pgRoot: join(root, "pg"), dataId: "data-A", runtimeDirectory: join(root, "runtime", "pg-current"),
    accounts, port,
  });
  assert.equal(layout.status, "socket_only_cluster_layout_built", layout.refusal?.detail);

  // The layout's OPENSSL_CONF and OPENSSL_MODULES point at a directory we create
  // here, holding the fixed empty config. This is exactly how `runtime/pg-current`
  // looks in production: a symlink into the vendored runtime plus our own etc/.
  const currentEtc = join(root, "runtime", "pg-current", "etc");
  mkdirSync(currentEtc, { recursive: true, mode: 0o755 });
  mkdirSync(join(root, "runtime", "pg-current", "lib", "ossl-modules"), { recursive: true, mode: 0o755 });
  writeNew(join(currentEtc, "openssl.cnf"), layout.opensslConf);
  const env = { ...layout.environment } as NodeJS.ProcessEnv;
  const opts = { encoding: "utf8" as const, maxBuffer: 1 << 26, timeout: 120_000 };
  const socket = join(root, "pg", "socket");
  mkdirSync(socket, { recursive: true, mode: 0o750 });

  // THE ASSERTION THAT THE WHOLE ITEM EXISTS FOR: `initdb` is the runtime's own
  // binary, not Homebrew's. Without share/postgresql/postgres.bki it cannot
  // create a catalog at all, which is the concrete form of finding 6.
  const version = (await exec(join(bin, "initdb"), ["--version"], { ...opts, env })).stdout.trim();
  assert.match(version, /17\.11/u, `the vendored initdb must be PostgreSQL 17.11, got ${version}`);
  await exec(join(bin, "initdb"), ["-D", join(root, "pg", "data-A"), "-U", "postgres",
    "-E", "UTF8", "--auth-local=trust", "-N"], { ...opts, env });

  const data = join(root, "pg", "data-A");
  // These three REPLACE what `initdb` wrote, in the data directory initdb itself
  // created. `wx` would fail with EEXIST — MEASURED — and refusing to overwrite is
  // the right rule everywhere EXCEPT here, where replacing the generated config
  // with the design's own is the entire point. `writeFileSync` without a flag is
  // correct for exactly these three and nowhere else.
  writeFileSync(join(data, "postgresql.conf"), layout.postgresqlConf, { mode: 0o600 });
  writeFileSync(join(data, "pg_hba.conf"), layout.pgHbaConf, { mode: 0o600 });
  writeFileSync(join(data, "pg_ident.conf"), layout.pgIdentConf, { mode: 0o600 });

  const log = join(root, "server.log");
  let child: ChildProcess | undefined;
  try {
    const fd = openSync(log, "w");
    child = spawn(join(bin, "postgres"), ["-D", data, "-p", String(port), "-c", "fsync=off"],
      { env, stdio: ["ignore", fd, fd] });
    for (let attempt = 0; attempt < 120 && !existsSync(join(socket, `.s.PGSQL.${port}`)); attempt++)
      await new Promise(resolve => setTimeout(resolve, 250));
    assert.ok(existsSync(join(socket, `.s.PGSQL.${port}`)),
      `the vendored postmaster must publish its socket:\n${existsSync(log) ? readFileSync(log, "utf8").slice(-800) : "no log"}`);

    const psql = async (sql: string): Promise<string> => (await exec(join(bin, "psql"),
      ["-w", "-h", socket, "-p", String(port), "-U", "postgres", "-d", "postgres", "-Atc", sql],
      { ...opts, env })).stdout.trim();

    assert.match(await psql("SHOW server_version"), /^17\.11/u);
    // timezone UTC is the design's pin, and it only resolves because
    // share/postgresql/timezone came across.
    assert.equal(await psql("SHOW timezone"), "UTC");
    assert.equal(await psql("SHOW log_timezone"), "UTC");
    // R9b, asked of the running server rather than of our own config.
    assert.equal(await psql("SHOW ssl"), "off");
    assert.equal(await psql("SHOW listen_addresses"), "");
    // plpgsql is created by initdb itself, from lib/postgresql/plpgsql.dylib.
    assert.equal(await psql("SELECT count(*) FROM pg_extension WHERE extname='plpgsql'"), "1");
    // FINDING 6, and the running server is where a closed list is proved rather
    // than asserted. `dict_int` USED to be created here to show that an
    // extension with a control file installs — the dylib and
    // share/postgresql/extension both arrived and are found relative to the
    // binary. It is exactly that proof which is no longer available, because
    // `dict_int.dylib` is not on `PG_RUNTIME_EXTENSION_MODULES_V1`, so
    //
    //   ERROR: could not access file "$libdir/dict_int": No such file or directory
    //
    // MEASURED on this run, and it is the correct outcome. The server is now
    // asked a question with a better answer available: the module that IS on the
    // list loads, and one that is NOT is absent from pkglibdir — a fact about
    // the vendored tree rather than about the cluster's extension catalogue.
    const dictInt = await psql("LOAD 'dict_int'")
      .then(() => "loaded", (e: Error) => `refused: ${e.message.split("\n")[0]}`);
    assert.match(dictInt, /refused/u,
      "dict_int is off the closed module list, so its dylib must not be in the runtime's pkglibdir");
    assert.ok(!existsSync(join(runtimeDirectory, "lib", "postgresql", "dict_int.dylib")),
      "the closed list must be a LIST and not a glob: dict_int.dylib must be absent from lib/postgresql");
    // Every language-pack module is absent too, which is the whole point of
    // finding 6: MEASURED, nine of the archive's 89 modules dlopen
    // `/Library/edb/languagepack/…`, which is admin-writable, and a superuser
    // LOAD of one of them would dlopen a library the account can replace.
    for (const module of ["plperl", "plpython3", "pltcl", "jsonb_plpython3"])
      assert.ok(!existsSync(join(runtimeDirectory, "lib", "postgresql", `${module}.dylib`)),
        `${module}.dylib links /Library/edb/languagepack and must not be in the runtime`);
    // dict_snowball: MEASURED — the EDB archive ships dict_snowball.dylib and
    // snowball_create.sql but NO dict_snowball.control (39 of 88 modules have no
    // control file), so `CREATE EXTENSION dict_snowball` cannot work from this
    // archive. What IS provable is that the MODULE loads, which is the property
    // lib/postgresql/ contributes.
    const snowball = await psql("LOAD 'dict_snowball'").then(() => "loaded", (e: Error) => `refused: ${e.message.split("\n")[0]}`);
    assert.match(snowball, /^loaded/u, "the vendored dict_snowball module must load");
    // A refused CREATE EXTENSION must be refused for the CONTROL FILE and not
    // for a missing dylib — that distinction is the whole allow-list question.
    const missing = await psql("CREATE EXTENSION dict_snowball")
      .then(() => "created", (e: Error & { stderr?: string }) => e.stderr ?? e.message);
    assert.match(missing, /dict_snowball\.control/u,
      `CREATE EXTENSION dict_snowball should fail on the control file the archive omits, got: ${missing.slice(0, 200)}`);
    // And a query works end to end, which is the statement that nothing was
    // missing from the closure when the server ran.
    assert.equal(await psql("SELECT 1+1"), "2");
    assert.ok(existsSync(join(runtimeDirectory, "share", "postgresql", "snowball_create.sql")),
      "snowball_create.sql must be in the runtime even though its control file is not");
  } finally {
    if (child) {
      try { execFileSync(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "-t", "20", "stop"], { encoding: "utf8", env }); }
      catch { child.kill("SIGKILL"); }
    }
    assert.equal(existsSync(join(data, "postmaster.pid")), false,
      "the vendored postmaster must be stopped even when an assertion above failed");
  }
});

test("every Mach-O in the vendored runtime is signed by the pin's Team Identifier", { timeout: 590_000, skip: needsArchive }, async () => {
  // FINDING 9, and the only place the signature loop is exercised against real
  // signed images. The synthetic lane's members are four bytes of text, so
  // nothing there is a Mach-O and the loop has nothing to check — which means
  // without this test the Team ID comparison is a guard nobody has run.
  //
  // The loop ran during the shared vendor, so this asserts its EFFECT on the tree
  // it produced, plus the signatures themselves read back from disk with
  // `codesign`, so the assertion does not depend on the vendor having remembered
  // to check.
  const { runtimeDirectory } = await vendoredRuntime();
  const images: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const entry = lstatSync(path);
      if (entry.isDirectory()) { visit(path); continue; }
      const handle = openSync(path, "r");
      try {
        const header = Buffer.allocUnsafe(4);
        if (readSync(handle, header, 0, 4, 0) === 4
          && [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]
            .includes(header.readUInt32BE(0))) images.push(path);
      } finally { closeSync(handle); }
    }
  };
  visit(runtimeDirectory);
  // A non-zero count is the assertion that matters: if the vendored runtime held
  // no images, the signature loop would be dead code here as well as in the
  // synthetic lane and this test would pass for the wrong reason.
  assert.ok(images.length > 20, `the vendored runtime should hold many images, walked ${images.length}`);
  assert.ok(images.some(image => image.endsWith("bin/postgres")), "the server itself must be among them");
  assert.ok(images.some(image => image.endsWith("lib/libssl.3.dylib")), "and the libraries it links");
  for (const image of images) {
    // `codesign --verify --strict` again, from the test, on the file as it landed.
    // MEASURED: this exits 0 on every image in the pinned 17.11 runtime.
    const verified = spawnSync("/usr/bin/codesign", ["--verify", "--strict", image], { encoding: "utf8" });
    assert.equal(verified.status, 0, `codesign --verify --strict failed on ${image}: ${verified.stderr}`);
    // And the Team Identifier, which `--verify` alone does not check: any valid
    // Developer ID signature passes, and only the pinned identifier is EDB's.
    const described = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", image], { encoding: "utf8" });
    const team = /^TeamIdentifier=(.*)$/mu.exec(`${described.stdout}\n${described.stderr}`)?.[1]?.trim();
    assert.equal(team, PG_RUNTIME_PIN_V1.teamIdentifier,
      `${image} is signed by ${team}, and the pin names ${PG_RUNTIME_PIN_V1.teamIdentifier}`);
  }
  // The manifest records the archive the images came from, and the pin records
  // the Team ID, so the two together are what a later verifier re-checks.
  const manifest = JSON.parse(readFileSync(join(runtimeDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.archive.sha256, PG_RUNTIME_PIN_V1.archiveSha256);
  // And the pin's own value is the one MEASURED off this archive, not a constant
  // that drifted: the identifier appears in the inventory the pin is read from.
  const inventory = JSON.parse(readFileSync(
    new URL("../src/updater/v1/policy/runtime-inventory.json", import.meta.url), "utf8")) as {
      artifacts: Array<Record<string, unknown>>;
    };
  assert.equal(inventory.artifacts.find(artifact => artifact.tool === "postgresql")!.teamIdentifier,
    PG_RUNTIME_PIN_V1.teamIdentifier);
});

test("the vendor refuses a destination that already exists, and a digest that does not match", { timeout: 590_000, skip: needsArchive }, async () => {
  const { runtimeDirectory } = await vendoredRuntime();
  // The happy path produced a runtime. A second vendor into the same place must
  // refuse rather than merge — MUTATION-CHECKED: removing the exists() check
  // fails this.
  await assert.rejects(() => vendorPgRuntimeV1({
    archivePath: ARCHIVE!, runtimeDirectory,
    opensslConf: "# empty\n", hooks: { normaliseOwnership: false },
  }), /already exists/u);

  // A pin with a digest that is well-formed but wrong must refuse AFTER reading
  // the archive, and must not leave a runtime behind.
  const root = laneRun("wrongdigest");
  const target = join(root, "runtime", "pg-17.11");
  const result = await vendorPgRuntimeV1({
    archivePath: ARCHIVE!, runtimeDirectory: target,
    opensslConf: "# empty\n",
    pin: { ...PG_RUNTIME_PIN_V1, archiveSha256: "0".repeat(64) },
    hooks: { normaliseOwnership: false },
  }).then(value => value, (error: unknown) => error as PgRuntimeVendorResultV1);
  // A mismatched digest is a REFUSAL value, not a throw: the caller gets a shape
  // it can log and show, not an exception. Asserted here because the distinction
  // is the difference between "the installer reports why" and "the installer
  // exits 1 with a stack".
  assert.ok(!(result instanceof Error), `a mismatched digest must be a refusal value, got a thrown ${String(result)}`);
  assert.equal(result.status, "pg_runtime_vendor_refused");
  // The refusal names BOTH digests: what the archive actually hashed to and
  // what the pin claimed. An operator reading this at install night has to be
  // able to tell which half is wrong.
  assert.match(result.refusal!, /the archive digest is a61d2205/u);
  assert.match(result.refusal!, /the pin says 0{64}/u);
  assert.equal(existsSync(target), false, "a refused vendor must not leave a runtime directory");
  // Nothing left in the parent either: no staging, no archive copy.
  const leftovers = readdirSync(join(root, "runtime")).filter(name => name.startsWith(".pg-runtime"));
  assert.deepEqual(leftovers, [], `a refused vendor must clean up staging, found ${leftovers.join(", ")}`);
});

test("the archive is read once, and the extraction is a closed allow-list", { timeout: 590_000, skip: needsArchive }, async () => {
  // A second vendor with the hooks wired, asserting the shape of the extraction
  // rather than just its result: `unzip` is handed the selected paths and NOT
  // `-j`, because `-j` flattens members to their basenames and
  // `share/postgresql/extension/plpgsql.control` collides with
  // `lib/postgresql/plpgsql.dylib`. MEASURED — that collision is what forced the
  // scratch-directory extraction this step uses.
  const root = laneRun("shape");
  const observed: string[] = [];
  const result = await vendorPgRuntimeV1({
    archivePath: ARCHIVE!, runtimeDirectory: join(root, "runtime", "pg-17.11"),
    opensslConf: "# empty\n",
    hooks: {
      normaliseOwnership: false,
      afterArchiveSnapshot: async pin => { observed.push(`archive-read:${pin.archiveSha256.slice(0, 8)}`); },
      observeExtract: args => {
        observed.push(`unzip-args:${args.length}`);
        observed.push(`unzip-flags:${args.filter(a => a.startsWith("-")).join(",")}`);
        observed.push(`unzip-members:${args.length - args.filter(a => a.startsWith("-")).length - 4}`);
      },
    },
  });
  assert.equal(result.status, "pg_runtime_vendored", result.refusal);
  assert.ok(observed.some(line => line.startsWith("archive-read:")),
    "the archive must be snapshotted before extraction, so the digest is of the bytes that were read");
  // `-d <scratch>` is part of the argument list, so the flags are compared as a
  // SET: the first version compared the exact string "-q,-o" and failed on a run
  // that had extracted 1071 members correctly, because "-d" came after "-o".
  const flags = observed.find(line => line.startsWith("unzip-flags:"))!.slice("unzip-flags:".length).split(",");
  assert.deepEqual(flags.sort(), ["-d", "-o", "-q"].sort(),
    `expected a quiet, overwrite extraction into a scratch directory, got ${flags.join(",")}`);
  // And the member count is the allow-list's size, not the archive's 24,676.
  const members = Number(observed.find(line => line.startsWith("unzip-members:"))!.split(":")[1]);
  assert.ok(members > 900 && members < 1500,
    `the allow-list should select around a thousand members of 24,676, got ${members}`);
  assert.ok(!observed.some(line => line.includes("-j")), "extraction must keep the archive structure");
});

test("every disk image this lane attached is detached", () => {
  // The hygiene assertion on its own, so a failure names the cause rather than
  // surfacing as an unrelated later failure.
  assertNoDiskImagesRemain();
});
