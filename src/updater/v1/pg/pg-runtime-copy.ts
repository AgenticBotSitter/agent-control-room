// PostgreSQL runtime copy (updater safety design item 3b, R9b).
//
// What this decides and why it is decided here rather than by the installer.
//
// The design offers PostgreSQL 17 for `runtime/pg-17.<n>/` in two orders:
//   (a) a pinned, sha256-checked self-contained binary archive (EDB-style);
//   (b) the Homebrew keg plus its whole library closure, rewritten with
//       `install_name_tool` and re-signed.
// This module MEASURED both on this machine and the measurement is the answer,
// so the code does not branch on a preference:
//
//   MEASURED, PostgreSQL 17.11, macOS 26.6.2, arm64:
//     EDB `postgresql-17.11-4-osx-binaries.zip` → `pgsql/bin/postgres` is a
//       universal binary whose ONLY non-system dependencies are `@rpath/…` and
//     whose only LC_RPATH is `@loader_path/../lib`. Every library it needs
//     (zstd, lz4, xml2, ssl, crypto, gssapi_krb5, z, icuuc, icui18n) ships
//     inside `pgsql/lib/` of the same archive. Nothing resolves outside the
//     unpacked tree.
//     → (a) needs no `install_name_tool`, no `codesign -s -`, and no trust in
//       Homebrew. It is the T1 answer with no rewriting step.
//     Homebrew `postgres` → links by ABSOLUTE path into
//       `/opt/homebrew/opt/{gettext,zstd,lz4,openssl@3,krb5,icu4c@78}/lib`,
//       which is owner-writable (H14). (b) would need a full closure walk,
//       `install_name_tool -change` on every image, re-signing, and a
//       `DYLD_PRINT_LIBRARIES` proof, and on install night it trusts files the
//       owner owns (residual risk 7).
//
// So (a) is selected, the closure is COMPUTED (never hard-coded), and the
// refusal is a refusal: a runtime that cannot be proven self-contained is
// refused, not patched.
//
// ONE CORRECTION TO THIS FILE'S OWN EARLIER TEXT, and it matters more than the
// selection above. An earlier version said, of `lib/postgresql/`: "a PostgreSQL
// extension is one level deeper and is loaded from the cluster's own pkglibdir,
// so it is excluded by depth". The first half is right — extensions ARE one
// level deeper — and the conclusion is wrong. `pkglibdir` is not a property of
// the cluster: PostgreSQL resolves `sharedir` and `pkglibdir` RELATIVE TO ITS OWN
// BINARY, so with the runtime's `initdb` they point inside `runtime/`. Under that
// runtime, `lib/postgresql/*.dylib` is where `plpgsql` and `dict_snowball` live,
// and `share/postgresql/postgres.bki` is what `initdb` reads to create a catalog
// at all. Excluding both directories produces a runtime that cannot start.
// Finding 6 measured this and the extended allow-list below is the fix; the
// extraction itself is `pg-runtime-vendor.ts`.
//
// The `cp -c` question §8.6 assigns here is answered in `pg-preimage-clone.ts`
// and, after finding 12, in `pg-clone-probe.ts`. The answer is that `cp -c`
// SILENTLY FULL-COPIES, and that no free-space measurement can decide it.

/** The schema string every value this module returns carries. */
export const PG_RUNTIME_COPY_V1 = "control-room.pg-runtime-copy/v1" as const;

export type PgRuntimeCopyV1 = Readonly<{
  schema: typeof PG_RUNTIME_COPY_V1;
  status:
    /** Every file landed in the runtime, every digest matched, nothing resolves outside it. */
    | "self_contained_runtime_copy_built"
    /** The source cannot be proven self-contained. Nothing was written; say why. */
    | "self_contained_runtime_copy_refused";
  /** Where the runtime lives, e.g. `<root>/runtime/pg-17.11`. */
  runtimeDirectory: string;
  /** The resolved symlink target, so a later run compares the same tree. */
  runtimeDirectoryRealPath: string;
  /** `bin/postgres` and everything in the closure, as absolute paths. */
  files: readonly string[];
  /** sha256 per file. The manifest item 3's runtime manifest is built from. */
  fileDigests: ReadonlyArray<Readonly<{ path: string; sha256: string }>>;
  /** The absolute install names every image in the closure declares. */
  dependencies: readonly string[];
  /**
   * Every dependency resolved to a file inside this runtime, by dyld itself.
   * Recorded because it is the only evidence that is not our own arithmetic.
   */
  loadedFromRuntimeOnly: boolean;
  /** sha256 of the archive the copy came from, for the runtime manifest. */
  sourceArchiveSha256?: string;
  /** Why a refusal happened, in words a person can act on. */
  refusal?: string;
}>;

const refuse = (message: string): never => {
  throw new Error(`pg_runtime_copy_refused: ${message}`);
};

export function emptyPgRuntimeCopyV1(runtimeDirectory: string,
  refusal: string): PgRuntimeCopyV1 {
  return Object.freeze({
    schema: PG_RUNTIME_COPY_V1,
    status: "self_contained_runtime_copy_refused" as const,
    runtimeDirectory,
    runtimeDirectoryRealPath: runtimeDirectory,
    files: Object.freeze([] as readonly string[]),
    fileDigests: Object.freeze([] as readonly { path: string; sha256: string }[]),
    dependencies: Object.freeze([] as readonly string[]),
    loadedFromRuntimeOnly: false,
    refusal,
  });
}

/**
 * The file names a relocatable archive layout is allowed to contain, and where.
 *
 * Deliberately a closed list rather than a glob. A glob here would copy
 * `pgAdmin 4.app`, `stackbuilder.app` and `doc/`, which is 400 MB of GraphQL
 * tooling and doc HTML that nothing in the design runs and that a bot could
 * later find writable paths inside. A closed list means the runtime contains
 * exactly the server, the client programs the updater spawns, and the libraries
 * those link.
 */
export const PG_RUNTIME_BIN_V1 = Object.freeze([
  "postgres", "initdb", "pg_ctl", "pg_controldata", "psql",
  "pg_dump", "pg_restore", "pg_basebackup", "pg_verifybackup",
]);

/**
 * The one shape a shared library may have, and the only one `runtime/lib/` holds.
 *
 * Narrow on purpose: `lib[\w.+-]+\.dylib` rejects a data file, a header, a
 * README and a subdirectory, all of which an archive's `lib/` contains.
 */
export const PG_RUNTIME_LIB_KINDS_V1 = Object.freeze({
  /** Shared libraries any image in the closure may link. */
  libraries: /^lib[\w.+-]+\.dylib$/u,
  /**
   * The same shape ONE LEVEL DOWN, which is where a PostgreSQL extension lives.
   *
   * This branch did not exist before finding 6, and its absence is why the
   * allow-list could not produce a working server: `plpgsql` (which `initdb`
   * itself creates) and `dict_snowball` (the proof the design asks for) are
   * `lib/postgresql/*.dylib` in the archive. MEASURED: 88 such files,
   * 17,875,776 uncompressed bytes.
   *
   * Only `.dylib` is admitted. The archive's `lib/postgresql/` also carries
   * `_int.dylib` (admitted, and harmless — it is a real module) and nothing
   * else, but the pattern is what keeps a stray data file out rather than the
   * observation that there happens not to be one.
   */
  extensions: /^[\w.+-]+\.dylib$/u,
});

/**
 * The ONE root segment an EDB macOS archive may have, and the closed list of
 * extension modules the runtime may carry.
 *
 * FINDING 5, and the first half of it. The classifier used to destructure
 * `[, first, ...rest]` and never look at the segment it threw away, so an
 * archive holding both `pgsql/bin/postgres` and `evil/bin/postgres` produced a
 * runtime whose `bin/postgres` was the `evil/` bytes: the later `rename` in the
 * vendor step replaces the earlier target, and the runtime still passed every
 * floor. MEASURED by the review. A root that is not `pgsql` is now REFUSED
 * rather than stripped, because "the segment we ignore" is exactly the segment
 * that chooses which copy of `bin/postgres` wins.
 *
 * The closed list is finding 6's other half. `lib/postgresql/*.dylib` as a
 * GLOB admits 89 modules, and MEASURED on the 17.11 archive, three of them link
 * outside any system prefix:
 *
 *   plperl.dylib, hstore_plperl.dylib, jsonb_plperl.dylib, bool_plperl.dylib,
 *     → /Library/edb/languagepack/v5/Perl-5.40/lib/CORE/libperl.dylib
 *   plpython3.dylib, jsonb_plpython3.dylib, hstore_plpython3.dylib, ltree_plpython3.dylib
 *     → /Library/edb/languagepack/v5/Python-3.12/lib/libpython3.12.dylib
 *   pltcl.dylib
 *     → /Library/edb/languagepack/v5/Tcl-8.6/lib/libtcl8.6.dylib
 *
 * `/Library` is ADMIN-WRITABLE, which is owner-writable on this Mac, and the
 * review's `/Library/Frameworks` worry is the same shape one directory over.
 * A superuser `LOAD` of one of those modules dlopens a library from a path the
 * account can write into the `_crdb` postmaster. The finding is ranked MEDIUM
 * because it needs superuser SQL and there is no path from the owner uid alone
 * — but the fix is a closed list, which is the rule this file already states
 * for `bin/`, so the glob goes.
 *
 * The list is what this product actually uses, measured rather than guessed:
 * `grep` finds no `CREATE EXTENSION` anywhere in `db/` or `src/`, and the
 * modules `initdb` and the design's own proof need are `plpgsql` and
 * `dict_snowball`. `plpgsql` is not optional — `initdb` creates it — so a
 * runtime without it cannot make a cluster.
 */
export const PG_RUNTIME_ROOT_SEGMENT_V1 = "pgsql" as const;

export const PG_RUNTIME_EXTENSION_MODULES_V1 = Object.freeze([
  // Created by `initdb` itself. Without it there is no catalog, so this is
  // part of making a cluster rather than optional extension functionality.
  "plpgsql.dylib",
  // The proof the design asks for: `CREATE EXTENSION dict_snowball` loads this
  // module and reads `share/postgresql/snowball_create.sql`. MEASURED: the EDB
  // archive ships the dylib and the SQL but no `dict_snowball.control`, so the
  // module load is what a real run can prove and `CREATE EXTENSION` is not.
  "dict_snowball.dylib",
] as readonly string[]);

/**
 * The `share/` subtree the runtime must carry, whole.
 *
 * The names are RELATIVE TO `share/` — they are matched against everything after
 * the directory segment, which is why they read `postgresql` and not
 * `share/postgresql`. An earlier version wrote them with the `share/` prefix
 * while matching against the stripped path, so every `share/postgresql/**` entry
 * was excluded and the vendor step refused with three missing required paths.
 * MEASURED failure, and the kind that a unit test on the destination strings
 * alone would not have caught, because the pure classifier still looked right.
 *
 * `share/postgresql` is 917 entries / 2,283,773 uncompressed bytes, and it is
 * required three times over: `initdb` reads `postgres.bki` from it or the
 * cluster is never created; `timezone = 'UTC'` resolves through its `timezone/`
 * directory; and `CREATE EXTENSION dict_snowball` reads `snowball_create.sql`
 * from it. The earlier allow-list excluded `share/` on the reasoning that "the
 * config templates in `share/` are not the runtime's" — which is true of
 * `postgresql.conf.sample` and false of the three files above, and the reason
 * the review called the specified allow-list unable to produce a working server.
 *
 * The whole directory is taken rather than a file list because the catalog,
 * the timezone set and the extension SQL are 900+ files whose names vary by
 * extension, and a hand-written list of the ones this release happens to use is
 * exactly the list that goes stale on the next minor upgrade. `share/man`,
 * `share/postgresql.conf.sample` and the archive's own `etc/` stay out.
 */
export const PG_RUNTIME_SHARE_SUBTREES_V1 = Object.freeze([
  "postgresql",
] as readonly string[]);

/**
 * Classify one central-directory entry name from an archive layout.
 *
 * `null` means "not part of the runtime": those are never written, so a
 * poisoned archive cannot put something in `runtime/` that the design does not
 * list. A name that looks like a path traversal is refused outright rather
 * than classified as uninteresting, because a traversal that is merely ignored
 * is one `..` away from being written.
 */
export function classifyPgRuntimeArchiveEntryV1(name: string): Readonly<{
  kind: "binary" | "library" | "extension" | "shared" | "excluded";
  /** The path inside the runtime this entry lands at. */
  destination?: string;
}> {
  if (!name || name.length > 256 || name.includes("\0") || name.startsWith("/"))
    refuse(`archive entry name is not a safe relative name: ${JSON.stringify(name)}`);
  // A central directory names a DIRECTORY with a trailing slash, and
  // `share/postgresql/timezone` arrives as `share/postgresql/timezone/`. The
  // trailing separator is stripped before the segment check, because the empty
  // final segment it creates would otherwise trip the escape guard below and
  // refuse every directory in the archive.
  //
  // MEASURED, and the reason the required-path floor named
  // `share/postgresql/timezone`: with the slash left on, the vendor step
  // extracted 1053 members and still refused on that one path, because the only
  // record of the directory's existence in the archive IS the slash-suffixed
  // entry. A directory entry is still classified by what is inside it, so
  // `share/man/` is excluded by the same subtree rule that excludes its files.
  const segments = name.replace(/\/+$/u, "").split("/");
  if (segments.some(segment => segment === ".." || segment === ""))
    refuse(`archive entry name escapes the archive: ${JSON.stringify(name)}`);
  // The FIRST segment is the archive's own root (`pgsql`) and the second is the
  // directory under test. There is deliberately no "name has no directory"
  // check: there was one, and it was MUTATION-SURVIVING, because relaxing it
  // changed no test result — a one-segment name leaves `first` undefined and
  // the allow-list below excludes it anyway. Two guards doing one job is how the
  // second one rots unnoticed, so the redundant branch is gone and
  // `tests/pg-runtime-copy.test.ts` asserts the OUTCOME for `README` instead.
  const [, first, ...rest] = segments;
  // FINDING 5, first half: the root segment is REQUIRED to be the one this
  // product's archive is known to use, and a refusal rather than a skip. The
  // previous line destructured it away and never looked at it, so a second root
  // segment decided which copy of a runtime file won the rename — MEASURED by
  // the review with `evil/bin/postgres` overwriting `pgsql/bin/postgres` and the
  // runtime still passing every floor. Refusing costs a different archive name
  // on a pin bump; not refusing costs the runtime's integrity on a hostile one.
  //
  // A one-segment name (`README`) has no root at all and is refused here rather
  // than falling through to the allow-list. That is the one behaviour change for
  // `README`-shaped entries, and it is the safer one: a name with no root has no
  // provenance in this layout, and the old test asserted `excluded` only because
  // the allow-list happened to drop it.
  if (segments[0] !== PG_RUNTIME_ROOT_SEGMENT_V1)
    refuse(`the archive's root segment is not ${PG_RUNTIME_ROOT_SEGMENT_V1}: ${JSON.stringify(name)}`);
  // The allow-list is a list of the directories whose contents may be copied,
  // and it is the load-bearing filter: with the check off, `pgsql/doc/libfoo.dylib`
  // and `pgsql/pgAdmin 4.app/lib/libpq.5.dylib` reach the `.dylib` test below and
  // are copied into the runtime — 400 MB of tooling this item never meant to
  // trust.
  //
  // `etc` is deliberately NOT on it. The archive's `pgsql/etc/openssl.cnf`
  // configures OpenSSL, and importing it would import whatever providers it
  // enables, which is precisely what R9b exists to prevent. The runtime's
  // `etc/openssl.cnf` is written by us, empty and fixed.
  if (first !== "bin" && first !== "lib" && first !== "share")
    return Object.freeze({ kind: "excluded" });
  const file = rest.join("/");
  if (first === "bin") {
    return PG_RUNTIME_BIN_V1.includes(file)
      ? Object.freeze({ kind: "binary" as const, destination: `bin/${file}` })
      : Object.freeze({ kind: "excluded" });
  }
  // `share/postgresql/**`, and nothing else under share. `share/man` and the
  // archive's config samples stay out: they are documentation, and
  // `postgresql.conf.sample` is a config file that must never be reachable by
  // name from a runtime root.
  //
  // MUTATION-CHECKED: dropping the subtree prefix admits
  // `pgsql/share/man/postgres.1` and `pgsql/share/postgresql.conf.sample`.
  if (first === "share") {
    return PG_RUNTIME_SHARE_SUBTREES_V1.some(subtree => file === subtree || file.startsWith(`${subtree}/`))
      ? Object.freeze({ kind: "shared" as const, destination: `share/${file}` })
      : Object.freeze({ kind: "excluded" });
  }
  // `lib/postgresql/<name>.dylib` is an extension module, and which ones is a
  // CLOSED LIST rather than a glob (finding 6). The two directories are still
  // separated by depth rather than by name, because the shapes are identical
  // and the difference is what loads them — but "any `.dylib` at that depth" is
  // 89 modules of which nine dlopen `/Library/edb/languagepack/…`, an
  // admin-writable path. MEASURED; see `PG_RUNTIME_EXTENSION_MODULES_V1`.
  if (rest[0] === "postgresql") {
    const name = rest.slice(1).join("/");
    return PG_RUNTIME_LIB_KINDS_V1.extensions.test(name)
      && PG_RUNTIME_EXTENSION_MODULES_V1.includes(name)
      ? Object.freeze({ kind: "extension" as const, destination: `lib/postgresql/${name}` })
      : Object.freeze({ kind: "excluded" });
  }
  // Only a dylib directly under lib/. There is deliberately no "direct child of
  // lib/" check beside it: the pattern is anchored `^lib…\.dylib$` and a
  // subdirectory arrives as `postgresql/foo.dylib` or `icudt68l.dat`, neither of
  // which that pattern matches. MEASURED, both.
  //
  // MUTATION-CHECKED: accepting anything lets `pgsql/lib/README` and
  // `pgsql/lib/openssl.cnf` into a root-owned 0555 tree, and the test fails.
  return PG_RUNTIME_LIB_KINDS_V1.libraries.test(file)
    ? Object.freeze({ kind: "library" as const, destination: `lib/${file}` })
    : Object.freeze({ kind: "excluded" });
}

/**
 * The libraries the design pins for the PG family, and what a refusal looks
 * like when one is missing.
 *
 * MEASURED against the 17.11 archive's central directory: the unversioned
 * names (`libssl.dylib`, `libzstd.dylib`, `libicuuc.dylib`, …) are present
 * beside the versioned real files.
 *
 * A CORRECTION to what an earlier version of this file recorded here. It said
 * those unversioned names "are present as SYMLINKS beside the versioned real
 * files, exactly as a Homebrew keg or an EDB install lays them out". MEASURED
 * against the downloaded archive, they are not: `pgsql/lib/libssl.dylib` is a
 * REGULAR FILE of 2,759,744 bytes whose contents are byte-identical to
 * `libssl.3.dylib`, and every one of the archive's 78 symlinks lives inside
 * `pgAdmin 4.app` or `stackbuilder.app` — neither of which is allow-listed.
 * The copy still needs the unversioned names, because `@rpath/libssl.dylib` is
 * what the server asks for; but they are copies, not links, and the vendor step
 * verifies their digests rather than carrying them through as symlinks.
 *
 * The list is a *floor*, not an exact match: the EDB archive also ships
 * `libxml2`, `libxslt`, `libintl`, `libiconv`, `libexpat` and friends that the
 * server does not link. A runtime containing more libraries than the floor is
 * fine, and refusing it would be refusing a working build over a harmless
 * extra. What must never happen is one of the *linked* ones being absent,
 * which is why the check is the resolved dependency set, not the file list.
 */
export const PG_RUNTIME_REQUIRED_LIBRARY_FLOOR_V1 = Object.freeze([
  "libssl.3.dylib", "libcrypto.3.dylib", "libgssapi_krb5.2.2.dylib",
  "libzstd.1.dylib", "liblz4.1.dylib", "libxml2.dylib", "libz.dylib",
  "libicuuc.dylib", "libicui18n.dylib", "libicudata.dylib",
]);

/**
 * Build the file list of a runtime copy from a set of archive entry names.
 *
 * Pure, so the decision "what goes in the runtime" is testable without a zip
 * file, an archive or a Mac, and so a reviewer can see the allow-list without
 * unpacking 437 MB.
 */
export function planPgRuntimeCopyV1(entryNames: readonly string[]): Readonly<{
  files: readonly string[];
  excluded: readonly string[];
}> {
  const files = new Set<string>();
  const excluded: string[] = [];
  for (const name of entryNames) {
    const classified = classifyPgRuntimeArchiveEntryV1(name);
    if (classified.kind === "excluded") { excluded.push(name); continue; }
    // `refuse` returns `never`, so the guard is only here for the type: a
    // classified non-excluded entry with no destination would mean the
    // classifier and this function disagree about what "included" means.
    const destination: string = classified.destination ?? refuse(
      `entry classified ${classified.kind} with no destination`);
    files.add(destination);
  }
  // `excluded.sort()` is applied in place and the same array is frozen, so the
  // returned value cannot be reordered by a caller either.
  return Object.freeze({
    files: Object.freeze([...files].sort()),
    excluded: Object.freeze(excluded.sort()),
  });
}

/**
 * Decide (a) versus (b), and say why in the terms the design used.
 *
 * `probe` is the `otool -L` output of one image plus its LC_RPATH list, passed
 * in rather than read from disk so the decision is testable everywhere. The
 * rule is narrow on purpose: (a) wins when every non-system dependency is an
 * `@rpath` reference whose only rpath is `@loader_path/../lib`, because that is
 * exactly the property that makes the copy relocatable and T1-clean without
 * rewriting anything.
 */
export function selectPgRuntimeSourceV1(probe: Readonly<{
  /** The `otool -L` dependency lines, absolute or `@rpath/`. */
  dependencies: readonly string[];
  /** The LC_RPATH entries, in order. */
  rpaths: readonly string[];
  /** Absolute prefixes a dependency may NOT come from. */
  forbiddenPrefixes?: readonly string[];
}>): Readonly<{ selected: "self_contained_archive" | "homebrew_closure"; reason: string }> {
  const forbidden = probe.forbiddenPrefixes ?? ["/opt/homebrew", "/usr/local", "/Users"];
  const systemPrefixes = ["/usr/lib/", "/System/", "/Library/Apple/"];
  // A dependency that is an ABSOLUTE path outside the system is decisive on its
  // own: that file is where the binary will load it from, and if the path is
  // outside the system it is outside the runtime too.
  const absoluteExternal = probe.dependencies.filter(dependency => {
    if (!dependency.startsWith("/")) return false;
    return !systemPrefixes.some(prefix => dependency.startsWith(prefix));
  });
  if (absoluteExternal.length > 0)
    return Object.freeze({
      selected: "homebrew_closure" as const,
      reason: `${absoluteExternal.length} dependency/deps load from an absolute path outside the system: ${
        absoluteExternal.slice(0, 4).join(", ")} — a copy would need install_name_tool rewriting and ad-hoc re-signing`,
    });
  // A dependency that is RELATIVE (`@rpath/…`) is not by itself a problem, but
  // the RPATH that resolves it is part of the answer, and it must be checked
  // whenever any dependency needs one. The first version of this function
  // filtered `@rpath` dependencies out of the set before looking at the rpaths,
  // so a binary whose single rpath was `/opt/homebrew/lib` reported itself
  // self-contained — which is the exact property this function exists to
  // establish, and the most expensive way to get it wrong. MEASURED by the
  // counter-case in the test, not assumed.
  const needsRpath = probe.dependencies.some(dependency => dependency.startsWith("@rpath/"));
  if (needsRpath && !(probe.rpaths.length === 1 && probe.rpaths[0] === "@loader_path/../lib"))
    return Object.freeze({
      selected: "homebrew_closure" as const,
      reason: `dependency/deps use @rpath but the only rpaths are ${JSON.stringify(
        probe.rpaths)}; a copy that resolves them from anywhere but its own lib/ is not self-contained`,
    });
  // A binary with no rpath and no absolute non-system dependency needs nothing
  // rewritten, so it is already self-contained.
  return Object.freeze({
    selected: "self_contained_archive" as const,
    reason: needsRpath
      ? `every non-system dependency is @rpath resolved by the single rpath @loader_path/../lib, so the tree resolves inside itself once unpacked`
      : `every dependency is a system library, so nothing is loaded from outside the runtime`,
  });
}
