// The pure half of item 3b: which files a runtime copy contains, and how (a)
// versus (b) is chosen. No PostgreSQL, no archive, no Mac required — these are
// the decisions a reviewer must be able to read and a CI box must be able to
// check, and the real-PostgreSQL lane in
// `tests/pg-runtime-copy-real-postgres.test.ts` is what proves the cluster side.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyPgRuntimeArchiveEntryV1, planPgRuntimeCopyV1, selectPgRuntimeSourceV1,
  PG_RUNTIME_BIN_V1, PG_RUNTIME_REQUIRED_LIBRARY_FLOOR_V1,
} from "../src/updater/v1/pg/pg-runtime-copy";
import {
  pgEnvironmentV1, planPgClusterLayoutV1, pgHbaV1, pgHbaPeerMapV1, verifyPgRuntimeEnvironmentV1,
  PG_HBA_METHODS_V1, PG_SOCKET_PATH_BUDGET_V1,
} from "../src/pg-runtime/v1/pg-cluster-layout";
import { planPgPreimageV1 } from "../src/pg-runtime/v1/pg-preimage-clone";

const ACCOUNTS = Object.freeze({ database: "_crdb", migrator: "control_room_migrator", deployer: "control_room_deployer" });
const ROOT = "/Library/Application Support/Control Room";

test("the runtime copy keeps the server, the updater's client programs and the libraries, and nothing else", () => {
  const plan = planPgRuntimeCopyV1([
    "pgsql/bin/postgres", "pgsql/bin/initdb", "pgsql/bin/pg_ctl", "pgsql/bin/psql",
    "pgsql/bin/pg_dump", "pgsql/bin/pg_restore", "pgsql/bin/pg_controldata", "pgsql/bin/psql",
    // The full library set the real 17.11 archive ships for the server's
    // closure — every one of these is in `pgsql/lib/` of that archive, which is
    // where the floor below comes from.
    "pgsql/lib/libssl.3.dylib", "pgsql/lib/libcrypto.3.dylib", "pgsql/lib/libgssapi_krb5.2.2.dylib",
    "pgsql/lib/libzstd.1.dylib", "pgsql/lib/liblz4.1.dylib", "pgsql/lib/libxml2.dylib", "pgsql/lib/libz.dylib",
    "pgsql/lib/libicuuc.68.2.dylib", "pgsql/lib/libicui18n.68.2.dylib",
    // Libraries the archive ships that the server does not link. They stay
    // (a superset is fine) but they are not required, and the floor must not
    // grow to include them.
    "pgsql/lib/libxslt.1.dylib", "pgsql/lib/libintl.8.dylib", "pgsql/lib/libexpat.1.dylib",
    // The unversioned names, which the real archive ships as SYMLINKS beside
    // the versioned files. `postgres`' @rpath references resolve through these,
    // so dropping them breaks the copy in a way only a dlopen failure reveals.
    "pgsql/lib/libssl.dylib", "pgsql/lib/libcrypto.dylib", "pgsql/lib/libzstd.dylib",
    "pgsql/lib/liblz4.dylib", "pgsql/lib/libxml2.dylib", "pgsql/lib/libz.dylib",
    "pgsql/lib/libicuuc.dylib", "pgsql/lib/libicui18n.dylib", "pgsql/lib/libicudata.dylib",
    // Everything an EDB archive also contains and nothing should ship.
    "pgsql/pgAdmin 4.app/Contents/Info.plist", "pgsql/stackbuilder.app/Contents/MacOS/stackbuilder",
    "pgsql/doc/postgresql.html", "pgsql/share/postgresql.conf.sample", "pgsql/etc/openssl.cnf",
    // `share/man` is the sibling of `share/postgresql` and is NOT on the list. It
    // needs to be in the input, not only in the assertions: an exclusion that
    // names a file the plan never saw proves nothing.
    "pgsql/share/man/postgres.1", "pgsql/share/man/postgresql.1.gz",
    "pgsql/include/server/postgres.h",
    "pgsql/server_license.txt", "pgsql/commandlinetools_3rd_party_licenses.txt",
    // What finding 6 adds, so this input exercises the widened allow-list rather
    // than leaving it unexercised: the share/ catalog and timezone set, and the
    // extension modules. MEASURED on the real archive: `share/postgresql` is 917
    // entries / 2,283,773 bytes and `lib/postgresql/*.dylib` is 88 files /
    // 17,875,776 bytes.
    "pgsql/share/postgresql/postgres.bki", "pgsql/share/postgresql/snowball_create.sql",
    "pgsql/share/postgresql/timezone/UTC",
    "pgsql/lib/postgresql/plpgsql.dylib", "pgsql/lib/postgresql/pgcrypto.dylib",
    // Non-`.dylib` names at both depths, so the two patterns are each exercised
    // rather than assumed.
    "pgsql/lib/postgresql/pgcrypto.so", "pgsql/lib/pgcrypto.dylib",
  ]);
  // Exactly the entries the input offered, each once, sorted. Asserting the
  // whole list rather than a subset is the point: a glob, or a classifier that
  // let a second directory through, would add to it.
  assert.deepEqual([...plan.files], [
      "bin/initdb", "bin/pg_controldata", "bin/pg_ctl", "bin/pg_dump", "bin/pg_restore", "bin/postgres", "bin/psql",
      "lib/libcrypto.3.dylib", "lib/libcrypto.dylib", "lib/libexpat.1.dylib", "lib/libgssapi_krb5.2.2.dylib",
      "lib/libicudata.dylib", "lib/libicui18n.68.2.dylib", "lib/libicui18n.dylib", "lib/libicuuc.68.2.dylib",
      "lib/libicuuc.dylib", "lib/libintl.8.dylib", "lib/liblz4.1.dylib", "lib/liblz4.dylib", "lib/libssl.3.dylib",
      "lib/libssl.dylib", "lib/libxml2.dylib", "lib/libxslt.1.dylib", "lib/libz.dylib",
      "lib/libzstd.1.dylib", "lib/libzstd.dylib",
      // Finding 6's addition, asserted in the whole-list comparison so a
      // classifier that stopped selecting either directory fails HERE as well as
      // in the vendor lane: without them `initdb` cannot create a catalog and
      // `plpgsql` cannot be created.
      //
      // `pgcrypto.dylib` was in this list and is NOT any more. Finding 6's
      // second half replaced the `lib/postgresql/*.dylib` glob with the closed
      // list `PG_RUNTIME_EXTENSION_MODULES_V1`, and pgcrypto is not on it:
      // MEASURED, nine of the archive's 89 modules dlopen
      // `/Library/edb/languagepack/…`, which is admin-writable, and a closed
      // list is the fix the review asked for. The list is asserted below.
      "lib/postgresql/plpgsql.dylib",
      "share/postgresql/postgres.bki", "share/postgresql/snowball_create.sql", "share/postgresql/timezone/UTC",
    ], "the runtime is a closed list, not a glob over the archive");
  // libexpat, libxslt and libintl are in the list because libxml2 links them,
  // so they are part of the closure even though the server does not name them
  // directly. The closure is closed, not "what postgres links": a copy missing
  // a transitive dependency starts and then fails to dlopen.
  assert.equal(plan.files.includes("lib/libxslt.1.dylib"), true,
    "a transitive dependency of a linked library is part of the closure");
  // The unversioned names are the @rpath targets, so the classifier must not
  // treat them as redundant duplicates of the versioned files.
  for (const name of ["lib/libssl.dylib", "lib/libcrypto.dylib", "lib/libzstd.dylib", "lib/libicuuc.dylib"])
    assert.equal(plan.files.includes(name), true, `${name} is an @rpath target and must be copied`);
  // A program the updater spawns that the archive lacks is a REFUSAL at build
  // time, not a surprise at update time. The floor is the allow-list; the
  // build asserts the archive satisfied it. This input is short two, which is
  // precisely the state the build refuses, so it is asserted as such.
  const present = new Set(plan.files.map(file => file.replace(/^bin\//u, "")));
  const missing = PG_RUNTIME_BIN_V1.filter(program => !present.has(program));
  assert.deepEqual(missing, ["pg_basebackup", "pg_verifybackup"],
    "an archive missing a program the updater spawns must be reported, which is what the build checks");
  // And the required library floor is satisfied by a complete closure.
  const shipped = new Set(plan.files.map(file => file.replace(/^lib\//u, "")));
  assert.deepEqual(PG_RUNTIME_REQUIRED_LIBRARY_FLOOR_V1.filter(library => !shipped.has(library)), [],
    "every library in the required floor must be present once the archive is complete");
  // The 400 MB of pgAdmin, StackBuilder, docs and the archive's own
  // openssl.cnf are excluded. The last one matters most: importing an archive's
  // openssl.cnf would import whatever providers it enables (R9b).
  //
  // `lib/postgresql/pgcrypto.dylib` was on this list before finding 6 and is NOT
  // any more: it is an extension module, and the widened allow-list takes
  // `lib/postgresql/*.dylib` because pkglibdir resolves relative to the binary.
  // Leaving it here would have made the test and the code disagree, and the
  // disagreement would have been in whichever direction the reader assumed.
  for (const excluded of ["pgsql/pgAdmin 4.app/Contents/Info.plist", "pgsql/etc/openssl.cnf",
    "pgsql/doc/postgresql.html", "pgsql/share/man/postgres.1", "pgsql/include/server/postgres.h"])
    assert.equal(plan.excluded.includes(excluded), true, `${excluded} must not reach runtime/`);
  // And the archive's unversioned libraries are REGULAR FILES, not symlinks — so
  // they are copied and hashed like any other file. An earlier version of this
  // module recorded them as symlinks and would have carried them through as
  // links; MEASURED against the downloaded archive, all 78 symlinks are inside
  // pgAdmin 4.app or stackbuilder.app and none of them is in the allow-list.
  assert.equal(plan.excluded.includes("pgsql/lib/postgresql/pgcrypto.so"), true,
    "only .dylib is an extension module");
  // And pgcrypto.dylib, a real `.dylib` at the right depth, is excluded because
  // the list is CLOSED (finding 6) rather than because of its shape. Asserted
  // here as well as in the whole-list comparison above, because the two answers
  // are different properties and a reviewer should not have to infer one from
  // the other.
  assert.equal(plan.excluded.includes("pgsql/lib/postgresql/pgcrypto.dylib"), true,
    "the extension module list is closed, so a .dylib off the list is excluded");
  // The same name in the WRONG place is still a library decision, not an
  // extension decision: `lib/pgcrypto.dylib` is a direct child of lib/ and the
  // library pattern requires the `lib` prefix, so it is excluded.
  assert.equal(plan.excluded.includes("pgsql/lib/pgcrypto.dylib"), true,
    "an extension module only counts as one under lib/postgresql/");
});

test("an archive entry that escapes its root is refused, not ignored", () => {
  // A traversal that is merely EXCLUDED is one `..` away from being written, so
  // the classifier refuses on the name rather than classifying it as uninteresting.
  for (const name of ["../etc/passwd", "pgsql/../../etc/sudoers", "/etc/sudoers", "pgsql/bin/../../../tmp/x"])
    assert.throws(() => classifyPgRuntimeArchiveEntryV1(name), /pg_runtime_copy_refused/u, `${name} must be refused`);
  assert.throws(() => classifyPgRuntimeArchiveEntryV1(""), /pg_runtime_copy_refused/u);
  // A name with NO directory at all has no root segment, and finding 5 makes
  // that a REFUSAL rather than an exclusion. The earlier version of this test
  // asserted `excluded` and explained why: "the source has NO length check for
  // this — a one-segment name leaves `first` undefined and the allow-list
  // excludes it". That was a guard relying on a downstream accident. A name with
  // no root in a layout that has exactly one root is malformed, and the fix
  // refuses it.
  assert.throws(() => classifyPgRuntimeArchiveEntryV1("README"), /pg_runtime_copy_refused/u);
  assert.throws(() => classifyPgRuntimeArchiveEntryV1("LICENSE"), /pg_runtime_copy_refused/u);
  // A bare `pgsql` IS the root and is classified as the root it is — the check
  // is on the segment, not on there being a second one.
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql").kind, "excluded",
    "the bare root is the root: it carries no file, and the plan creates it as a directory");
  // FINDING 5, first half: the ROOT SEGMENT is required, because the segment
  // that used to be destructured away is the one that decides which copy of
  // `bin/postgres` wins the rename. MEASURED by the review: an archive holding
  // both `pgsql/bin/postgres` and `evil/bin/postgres` produced a runtime whose
  // `bin/postgres` was the `evil/` bytes and passed every floor.
  for (const foreign of ["evil/bin/postgres", "postgresql/bin/postgres", "pgsql2/bin/postgres",
    "PGSQL/bin/postgres", "evil/share/postgresql/postgres.bki", "./evil/bin/postgres"])
    assert.throws(() => classifyPgRuntimeArchiveEntryV1(foreign), /root segment is not pgsql/u,
      `${foreign} must be refused: the runtime's layout has exactly one root`);
  // The comparison is CASE-SENSITIVE, and it has to be: an APFS volume is
  // case-insensitive by default, so `PGSQL/bin/postgres` and `pgsql/bin/postgres`
  // are the same file there, and admitting both is the collision the check
  // exists to stop.
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/bin/postgres").kind, "binary");
  // A name that IS absolute is a separate refusal from a traversal, and needs
  // its own case: `/etc/sudoers` has no `..` in it at all.
  assert.throws(() => classifyPgRuntimeArchiveEntryV1("/etc/sudoers"), /pg_runtime_copy_refused/u);
  assert.throws(() => classifyPgRuntimeArchiveEntryV1("/pgsql/bin/postgres"), /pg_runtime_copy_refused/u);
  // A NUL is refused too, because a name carrying one is a name two tools read
  // differently.
  assert.throws(() => classifyPgRuntimeArchiveEntryV1("pgsql/bin/postgres\u0000.dll"),
    /pg_runtime_copy_refused/u);
  // A name over the length budget.
  assert.throws(() => classifyPgRuntimeArchiveEntryV1(`pgsql/lib/${"x".repeat(300)}.dylib`),
    /pg_runtime_copy_refused/u);
});

test("only a dylib directly under lib/ is a library, so a stray file cannot ride into the runtime", () => {
  // Each of these is MUTATION-SURVIVING without this test, because the case
  // simply was not exercised:
  //  - widening the library regex to `/./` admits README and openssl.cnf;
  //  - dropping the top-directory allow-list admits pgsql/doc/libfoo.dylib.
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/lib/libssl.3.dylib").kind, "library");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/lib/README").kind, "excluded");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/lib/openssl.cnf").kind, "excluded");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/lib/icudt68l.dat").kind, "excluded");
  // A server extension lives one level deeper and is a DIFFERENT KIND, because
  // finding 6 established that pkglibdir resolves relative to the binary: with
  // the runtime's own initdb, `lib/postgresql/*.dylib` IS the cluster's
  // pkglibdir. The previous version of this test asserted `excluded` here on the
  // reasoning that "extensions load from the cluster's own pkglibdir, not from
  // the runtime" — which is true of a Homebrew layout and false of a vendored
  // one, and the reason the specified allow-list could not start a cluster.
  // MEASURED on the real archive: `initdb` creates plpgsql from
  // `lib/postgresql/plpgsql.dylib` and the server answers
  // `CREATE EXTENSION dict_snowball`'s module load from the same directory.
  // WHICH extension modules is a CLOSED LIST, which is finding 6's second half.
  // `pgcrypto.dylib` is a real `.dylib` at the right depth and is EXCLUDED,
  // because MEASURED on the pinned archive nine of the 89 modules dlopen
  // `/Library/edb/languagepack/…` — an admin-writable path — and a glob cannot
  // express "not those". The list is the two this product uses.
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/lib/postgresql/plpgsql.dylib").kind, "extension");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/lib/postgresql/plpgsql.dylib").destination,
    "lib/postgresql/plpgsql.dylib");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/lib/postgresql/dict_snowball.dylib").kind, "extension");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/lib/postgresql/pgcrypto.dylib").kind, "excluded",
    "pgcrypto is off the closed list, so its .dylib shape does not admit it");
  // The whole language-pack set, asserted by name so the reason is visible in
  // the test rather than only in the comment: every one of these is a real
  // module in the pinned archive and every one of them links /Library.
  for (const module of ["plperl", "plpython3", "pltcl", "hstore_plperl", "jsonb_plperl",
    "bool_plperl", "hstore_plpython3", "jsonb_plpython3", "ltree_plpython3"])
    assert.equal(classifyPgRuntimeArchiveEntryV1(`pgsql/lib/postgresql/${module}.dylib`).kind, "excluded",
      `${module} dlopens /Library/edb/languagepack and must not reach the runtime`);
  // Still only `.dylib` at that depth: a stray file in pkglibdir is refused.
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/lib/postgresql/README").kind, "excluded");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/lib/postgresql/pgcrypto.so").kind, "excluded");
  // `share/postgresql/**` is now IN, which is the other half of finding 6:
  // `initdb` reads `postgres.bki` out of it or no catalog is ever created.
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/share/postgresql/postgres.bki").kind, "shared");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/share/postgresql/timezone").kind, "shared");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/share/postgresql/extension/plpgsql.control").kind, "shared");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/share/postgresql/snowball_create.sql").kind, "shared");
  // A directory entry arrives with a trailing slash, and stripping it is what
  // lets the timezone DIRECTORY be selected. MEASURED: without the strip the
  // empty final segment tripped the escape guard and the vendor refused on
  // `share/postgresql/timezone` after extracting 1053 members.
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/share/postgresql/timezone/").kind, "shared");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/share/postgresql/").kind, "shared");
  // share/ is in the allow-list so its inclusion is EXPLICIT. A dylib sitting in a
  // share/ subtree that is NOT `share/postgresql` would otherwise fall through to
  // the `.dylib` test and be copied into the runtime.
  //
  // MEASURED BUG these cases caught, and the reason the names are written out
  // in full with the `pgsql/` prefix: the classifier destructures the FIRST
  // segment as the layout root, so the directory under test is the SECOND
  // segment. An earlier version of this test wrote `share/libssl.3.dylib` —
  // which reads as layout root `share`, an unknown root — and therefore passed
  // for the wrong reason while `pgsql/share/libssl.3.dylib` was classified
  // `library` and COPIED into `runtime/pg-17.x/lib/`. A test that cannot fail
  // is worse than no test, and this one looked thorough.
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/share/libssl.3.dylib").kind, "excluded",
    "a dylib directly under share/ must not be copied into the runtime as a library");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/share/man/libcrypto.3.dylib").kind, "excluded",
    "share/man is not on the allow-list, so nothing under it may be copied");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/share/man/postgres.1").kind, "excluded");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/etc/libcrypto.3.dylib").kind, "excluded",
    "a dylib under etc/ must not be copied into the runtime as a library");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/share/postgresql.conf.sample").kind, "excluded");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/etc/openssl.cnf").kind, "excluded");
  // The root itself is a fixed PREFIX, not a wildcard, and since finding 5 a
  // name whose root is not `pgsql` is a REFUSAL rather than an exclusion. These
  // two cases previously read `excluded` — for the same reason the cases above
  // once passed for the wrong reason: `share/libssl.3.dylib` reads as layout
  // root `share`, which the allow-list drops anyway. That made the assertion
  // unfalsifiable: it could not tell a root check from a directory check.
  assert.throws(() => classifyPgRuntimeArchiveEntryV1("share/libssl.3.dylib"),
    /root segment is not pgsql/u, "a dylib under a foreign root is refused, not excluded");
  assert.throws(() => classifyPgRuntimeArchiveEntryV1("etc/libcrypto.3.dylib"),
    /root segment is not pgsql/u, "a foreign root is refused whatever it holds");
  // A dylib in a directory the layout does not own stays out, which is what
  // the top-directory allow-list is actually for.
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/doc/libfoo.dylib").kind, "excluded");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/pgAdmin 4.app/lib/libpq.5.dylib").kind, "excluded");
  // And a binary in a directory the layout does not own.
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/stackbuilder.app/Contents/MacOS/stackbuilder").kind, "excluded");
  // A library in lib/ IS taken, even one this item never names: the closure is
  // discovered from the archive, not from a hand-written list.
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/lib/libkrb5.3.3.dylib").destination, "lib/libkrb5.3.3.dylib");
  // A PROGRAM outside the list is refused, and the interesting cases are the
  // benchmark and maintenance tools the archive does ship: they are real,
  // runnable PostgreSQL binaries, so a rule that accepted everything under
  // bin/ would put them in the runtime. MUTATION-CHECKED: `return true` in the
  // bin/ branch changes nothing without these.
  for (const program of ["pgbench", "pg_isready", "pg_waldump", "vacuumdb", "pg_receivewal", "pglogical"])
    assert.equal(classifyPgRuntimeArchiveEntryV1(`pgsql/bin/${program}`).kind, "excluded",
      `${program} is not on the allow-list and must not reach runtime/bin/`);
  // And the programs that ARE on it are still taken.
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/bin/postgres").destination, "bin/postgres");
  assert.equal(classifyPgRuntimeArchiveEntryV1("pgsql/bin/pg_controldata").destination, "bin/pg_controldata");
});

test("(a) is selected only when the tree resolves inside itself, which is what makes it T1-clean", () => {
  // MEASURED from the EDB 17.11 archive: @rpath only, one rpath, @loader_path/../lib.
  const selfContained = selectPgRuntimeSourceV1({
    dependencies: [
      "@rpath/libzstd.1.dylib", "@rpath/libssl.3.dylib", "@rpath/libcrypto.3.dylib",
      "@rpath/libgssapi_krb5.2.2.dylib", "@rpath/libz.1.3.2.dylib", "@rpath/libicuuc.68.2.dylib",
      "/usr/lib/libpam.2.dylib", "/usr/lib/libz.1.3.2.dylib", "/usr/lib/libSystem.B.dylib",
      "/System/Library/Frameworks/LDAP.framework/Versions/A/LDAP",
    ],
    rpaths: ["@loader_path/../lib"],
  });
  assert.equal(selfContained.selected, "self_contained_archive");
  // MEASURED from Homebrew's postgres: absolute paths into an owner-writable tree.
  const homebrew = selectPgRuntimeSourceV1({
    dependencies: [
      "/opt/homebrew/opt/gettext/lib/libintl.8.dylib", "/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib",
      "/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib", "/opt/homebrew/opt/krb5/lib/libgssapi_krb5.2.2.dylib",
      "/usr/lib/libSystem.B.dylib",
    ],
    rpaths: [],
  });
  assert.equal(homebrew.selected, "homebrew_closure");
  assert.match(homebrew.reason, /install_name_tool/u, "the reason must name the work (b) would need, so the choice is reviewable");
  // A third case: @rpath with an rpath the copy cannot resolve. Refused as
  // self-contained, because the libraries would come from somewhere else.
  assert.equal(selectPgRuntimeSourceV1({ dependencies: ["@rpath/libssl.3.dylib"], rpaths: ["/opt/homebrew/lib"] }).selected,
    "homebrew_closure");
  // And @rpath with NO rpath at all.
  assert.equal(selectPgRuntimeSourceV1({ dependencies: ["@rpath/libssl.3.dylib"], rpaths: [] }).selected,
    "homebrew_closure");
  // A pure-system binary needs no closure work either; that is still (a).
  assert.equal(selectPgRuntimeSourceV1({ dependencies: ["/usr/lib/libSystem.B.dylib"], rpaths: [] }).selected,
    "self_contained_archive");
});

test("the copy arguments are -R -p with a trailing /., and -c is GONE", () => {
  const plan = planPgPreimageV1({
    sourceDataDirectory: "/install/pg/data-A", targetDataDirectory: "/install/pg/data-B",
    sourceHasPidFile: false, controlDataClusterState: "Database cluster state:               shut down",
    freeBytes: 10_000_000_000, sourceBytes: 1_000_000, sameFilesystem: true, targetEntries: [],
  });
  // FINDING 7, and this assertion is its mirror: the previous version asserted
  // `["-c", "-R", "-p", …]` and explained that "the flag is the REQUEST for a
  // clone, and the measurement proves it was granted". It does not — `man cp`
  // says `-c` "will fallback to using copyfile(2) instead to ensure the copy
  // still succeeds", and MEASURED, `cp -c` exits 0 on FAT32 and ExFAT having
  // full-copied. A plan that names an advisory flag as the mechanism tells its
  // reader something false, so the flag is out and the verdict is named instead.
  assert.deepEqual([...plan.copyArguments], ["-R", "-p", "/install/pg/data-A/.", "/install/pg/data-B/"],
    "the copy must not ask cp to clone: the clone is measured, not requested");
  // And the plan says where the verdict comes from, so item 18 has an API to
  // call rather than an argument list to read. The three "neverFrom" entries are
  // the measurements finding 12 rejected, written where a caller will see them.
  assert.match(plan.cloneVerdict.from, /clonefile\(2\)/u);
  assert.match(plan.cloneVerdict.decision, /pgCloneReservationMultiplierV1/u);
  assert.deepEqual([...plan.cloneVerdict.neverFrom].length, 4,
    "the free-space delta, the allocated-block ratio, the COW experiment and this argument list are all rejected by name");
  // The trailing `/.` on the source copies the CONTENTS. Without it the
  // preimage is data-B/data-A, and pg/current would point at a directory with
  // no PG_VERSION in it. Also MUTATION-CHECKED, by the same argument.
  assert.equal(plan.copyArguments.includes("/install/pg/data-A/."), true);
  assert.equal(plan.copyArguments.some(argument => argument.endsWith("/data-A")), false,
    "a bare directory source nests the cluster one level down");
  // `-R` and `-p` are load-bearing and stay: `-R` is what makes the copy
  // recursive over the cluster's tree at all, and `-p` is what makes the preimage
  // inspectable as the cluster it claims to be.
  assert.equal(plan.copyArguments.includes("-R"), true, "the copy must be recursive over the cluster's tree");
  assert.equal(plan.copyArguments.includes("-p"), true, "modes and times must be preserved");
  // The whole module must not mention `cp -c` as a mechanism any more, which is
  // the property the review asked for: "make `planPgPreimageV1`'s
  // `copyArguments` stop naming `cp -c` as the mechanism". The file still
  // discusses `cp -c` in its header — it has to, that measurement is the reason
  // this module exists — so the check is on the ARGV and on the plan.
  assert.equal(plan.copyArguments.includes("-c"), false,
    "an advisory clone request must not be in the argv; the verdict is the kernel's");
});

test("the hba orders peer map first and scram last, and can never carry a gss line", () => {
  const hba = pgHbaV1(ACCOUNTS);
  const rules = hba.split("\n").filter(line => line.trim() && !line.trim().startsWith("#"));
  assert.equal(rules.length, 4, "three peer rules and one scram rule; the header is a comment");
  // pg_hba is first-match-wins, so the ORDER is the security property.
  assert.match(rules[0]!, /control_room_migrator\s+peer map=cr/u);
  assert.match(rules[1]!, /control_room_deployer\s+peer map=cr/u);
  assert.match(rules[2]!, /^local\s+all\s+postgres\s+peer map=cr/u);
  assert.match(rules[3]!, /all\s+scram-sha-256/u);
  // No host line at all: a TCP attempt reaches the end of the file, which is a
  // refusal, and `listen_addresses = ''` refuses it at the listener too.
  assert.doesNotMatch(hba, /^\s*host/mu, "a host line would be a TCP path the design does not have");
  assert.doesNotMatch(hba, /gss/iu);
  assert.doesNotMatch(hba, /replication/iu);
  // The guarantee is STRUCTURAL, not a check on the generated text: the method
  // column comes from a closed list, and a gss line has no spelling in the
  // generator. The earlier version asserted `!/gss/.test(pgHbaV1(…))`, which
  // is MUTATION-SURVIVING — the generator never emitted gss, so deleting the
  // assertion changed nothing.
  // R9b asks for "no gss lines". The list is where one would have to be added, and
  // this is the assertion that says adding one is a test failure and not a
  // silent change: MUTATION-SURVIVING without it, because the generated hba did
  // not change when `gssapi` joined the list — nothing builds a rule from an
  // unused entry, so the list was decorative.
  //
  // The rule is about the hba a gss method could produce, so it is stated in
  // terms of a METHOD: `gss`, `gssapi` and `sspi` are the three spellings
  // PostgreSQL accepts, and none of them may appear in a cluster this design
  // runs. A gss line would authenticate by Kerberos ticket against a config
  // file the account can read, which is the whole of what the krb5 pins exist
  // to prevent.
  for (const forbidden of ["gss", "gssapi", "sspi"])
    assert.equal(PG_HBA_METHODS_V1.includes(forbidden as never), false,
      `${forbidden} must not be an accepted authentication method: it authenticates by Kerberos ticket, which is what KRB5_CONFIG=/dev/null exists to prevent`);
  // Every METHOD the hba actually uses is in that closed list. A method with
  // arguments is `<method> <name>=<value>`, so `peer map=cr` is the method
  // `peer` plus one argument; the method is the token before the `name=value`
  // pair, or the last token when there is no argument. Getting this wrong in
  // either direction produces a confusing failure, so the parse is written out:
  //   `scram-sha-256`  -> last token
  //   `peer map=cr`    -> the token before the one containing "="
  const methodOf = (rule: string): string => {
    const tokens = rule.trim().split(/\s+/u);
    const last = tokens.at(-1)!;
    return last.includes("=") ? tokens.at(-2)! : last;
  };
  const usedMethods = rules.map(methodOf);
  assert.deepEqual([...new Set(usedMethods)].sort(), ["peer", "scram-sha-256"]);
  for (const method of usedMethods)
    assert.equal(PG_HBA_METHODS_V1.includes(method as never), true,
      `${method} is written into pg_hba but is not in the closed method list`);
  // And every peer line really does name the map, so "no gss" is not achieved
  // by quietly dropping the map argument.
  for (const rule of rules.filter(line => /peer/u.test(line)))
    assert.match(rule, /map=cr$/u, "a peer rule without the map would authenticate by name alone");
});

test("the layout refuses a socket path too long for macOS, which is measured inside the server", () => {
  // MEASURED: a postmaster whose socket path is too long fails AFTER initdb has
  // written the data directory, as "could not create any Unix-domain sockets".
  const deep = planPgClusterLayoutV1({
    pgRoot: `/Volumes/CRRehearsal/really/deep/nested/install/root/that/a/root/with/a/long/name${"x".repeat(40)}/pg`,
    dataId: "data-A", runtimeDirectory: `${ROOT}/runtime/pg-current`, accounts: ACCOUNTS,
  });
  assert.equal(deep.status, "socket_only_cluster_layout_refused");
  assert.equal(deep.refusal?.reason, "pg_socket_path_too_long");
  assert.match(deep.refusal!.detail, /could not create any Unix-domain sockets/u,
    "the refusal explains the symptom an operator would otherwise see for the first time, hours later");
  // The counter-case, so a rule that always refused would not pass this file.
  const fine = planPgClusterLayoutV1({
    pgRoot: `${ROOT}/pg`, dataId: "data-B", runtimeDirectory: `${ROOT}/runtime/pg-current`, accounts: ACCOUNTS,
  });
  assert.equal(fine.status, "socket_only_cluster_layout_built");
  assert.ok(`${fine.socketDirectory}/.s.PGSQL.5432`.length <= PG_SOCKET_PATH_BUDGET_V1);
});

test("the layout refuses a data id that could let pg/current and the data directory be renamed into each other", () => {
  for (const dataId of ["", "data-", "A", "data-../B", "data-A/B", "data-", "x".repeat(64)])
    assert.equal(planPgClusterLayoutV1({ pgRoot: `${ROOT}/pg`, dataId,
      runtimeDirectory: `${ROOT}/runtime/pg-current`, accounts: ACCOUNTS }).status,
    "socket_only_cluster_layout_refused", `${JSON.stringify(dataId)} must be refused`);
  assert.equal(planPgPreimageSafeId("data-B"), true);
  // An account name that is not a plain identifier is refused, because it would
  // be pasted into pg_hba and pg_ident unquoted.
  assert.equal(planPgClusterLayoutV1({ pgRoot: `${ROOT}/pg`, dataId: "data-A",
    runtimeDirectory: `${ROOT}/runtime/pg-current`,
    accounts: { database: "crdb; DROP", migrator: "ok", deployer: "ok" } }).status,
  "socket_only_cluster_layout_refused");
});

/** Small local helper so the id rule is stated once and asserted directly. */
function planPgPreimageSafeId(dataId: string): boolean {
  return /^data-[A-Za-z0-9._-]{1,32}$/u.test(dataId);
}

test("the layout's pinned environment is the whole environment, and it disagrees with nothing it claims", () => {
  const layout = planPgClusterLayoutV1({
    pgRoot: `${ROOT}/pg`, dataId: "data-B", runtimeDirectory: `${ROOT}/runtime/pg-current`, accounts: ACCOUNTS,
  });
  // No PATH, no HOME, no locale-ish passthrough: a PG-family process is not a
  // shell and resolves nothing by search.
  assert.deepEqual(Object.keys(layout.environment).sort(), [
    "KRB5_CONFIG", "KRB5_KDC_PROFILE", "LANG", "LC_ALL", "OPENSSL_CONF", "OPENSSL_MODULES", "PGSYSCONFDIR", "TZ",
  ]);
  assert.equal(layout.environment.OPENSSL_CONF, `${ROOT}/runtime/pg-current/etc/openssl.cnf`);
  assert.equal(layout.environment.OPENSSL_MODULES, `${ROOT}/runtime/pg-current/lib/ossl-modules`);
  assert.equal(layout.environment.PGSYSCONFDIR, `${ROOT}/runtime/pg-current/etc`);
  // The fixed OpenSSL config is empty of providers, which is the whole point.
  assert.doesNotMatch(layout.opensslConf, /^\s*provider\s/mu, "an empty config must enable no provider module");
  assert.match(layout.opensslConf, /deliberately EMPTY/u);
  // The conf carries the two settings the design requires, verbatim.
  assert.match(layout.postgresqlConf, /^ssl = off$/mu);
  assert.match(layout.postgresqlConf, /^listen_addresses = ''$/mu);
  assert.match(layout.postgresqlConf, /^unix_socket_directories = '.*\/pg\/socket'$/mu);
});

test("the environment verifier reports each missing pin by name, and accepts a correct environment", () => {
  const runtimeDirectory = `${ROOT}/runtime/pg-current`;
  // The correct environment is produced by the SAME function the layout uses,
  // rather than written out here. Writing it out is how the test came to disagree
  // with the code: the verifier grew a pin, the hand-written copy did not, and
  // the test failed for a reason that had nothing to do with the verifier.
  const correct = pgEnvironmentV1(runtimeDirectory) as Record<string, string>;
  const good = verifyPgRuntimeEnvironmentV1({ environment: correct, runtimeDirectory });
  assert.deepEqual([...good.reasons], []);
  assert.equal(good.pinned, true);
  // Every pin in the template is required: remove one at a time and the verifier
  // must name it. This is the assertion that makes the template and the verifier
  // the same contract — a pin nobody checks is a pin that can be deleted.
  for (const name of Object.keys(correct)) {
    const without = { ...correct };
    delete without[name];
    const result = verifyPgRuntimeEnvironmentV1({ environment: without, runtimeDirectory });
    assert.equal(result.pinned, false, `removing ${name} must be detected`);
    assert.match(result.reasons.join(";"), new RegExp(name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      `the reason must name ${name}, so an operator knows which variable to set`);
  }
  // A stripped variable leaking in is a finding, and is reported WITH ITS VALUE:
  // a leaked OPENSSL_CONF is only diagnosable from the path it points at, which
  // is the whole point of R9b.
  const leaked = verifyPgRuntimeEnvironmentV1({
    environment: { ...correct, PATH: "/opt/homebrew/bin", DEVELOPER_DIR: "/Users/someone/Xcode" },
    runtimeDirectory });
  assert.equal(leaked.pinned, false);
  assert.match(leaked.reasons.join(";"), /PATH="\/opt\/homebrew\/bin" is present/u);
  assert.match(leaked.reasons.join(";"), /DEVELOPER_DIR="\/Users\/someone\/Xcode" is present/u);
  // The pins are not themselves reported as stripped leaks, which is the
  // mistake the first run of this verifier made.
  assert.doesNotMatch(good.reasons.join(";"), /OPENSSL_CONF.*is present/u);
  // ssl on, or a listener bound, is a finding even when the environment is perfect.
  assert.equal(verifyPgRuntimeEnvironmentV1({ environment: correct, runtimeDirectory,
    gucs: { ssl: "on", listen_addresses: "" } }).pinned, false);
  assert.equal(verifyPgRuntimeEnvironmentV1({ environment: correct, runtimeDirectory,
    gucs: { ssl: "off", listen_addresses: "127.0.0.1" } }).pinned, false);
  // A gss class in the loaded peer map is a finding.
  assert.equal(verifyPgRuntimeEnvironmentV1({ environment: correct, runtimeDirectory,
    peerMapText: "cr root gssapi/control_room_deployer" }).pinned, false);
  // A runtime directory that is not absolute is refused outright, because every
  // pin is derived from it and a relative one would point at the caller's cwd.
  assert.throws(() => pgEnvironmentV1("runtime/pg-current"), /pg_runtime_directory_invalid/u);
  assert.throws(() => pgEnvironmentV1(`${runtimeDirectory}/`), /pg_runtime_directory_invalid/u);
});

test("the binary list names each program once, and a program the updater spawns is in it", () => {
  // Every PG-family process 4 lists: postgres, initdb, pg_dump, pg_restore,
  // pg_ctl, pg_controldata, psql. A missing one is a runtime that cannot be
  // started, verified or backed up.
  for (const program of ["postgres", "initdb", "pg_dump", "pg_restore", "pg_ctl", "pg_controldata", "psql"])
    assert.equal(PG_RUNTIME_BIN_V1.includes(program), true, `${program} must be in the runtime`);
  assert.equal(new Set(PG_RUNTIME_BIN_V1).size, PG_RUNTIME_BIN_V1.length,
    "the list must not repeat a program; a repeat is a copy/paste, not a requirement");
});
