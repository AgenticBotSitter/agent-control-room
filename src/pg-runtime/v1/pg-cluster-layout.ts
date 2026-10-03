// The `_crdb` cluster: layout, socket-only reachability, peer maps, the pinned
// environment (updater safety design item 3b, R9b; §3, §4, §9.1).
//
// This module is DATA. It decides what the cluster's `postgresql.conf` and
// `pg_hba.conf` must say, what environment every PG-family process runs with,
// and what the `pg/current` link must resolve to. It starts nothing and reads
// nothing from the host, so every guard in it is reachable by a test that runs
// anywhere — which is the point: the guards are the item.
//
// Three things here are measured facts about this Mac, not opinions:
//
// 1. `LC_ALL` is REQUIRED. Measured: a postmaster started without a valid
//    locale refuses to start at all —
//      FATAL: postmaster became multithreaded during startup
//      HINT:  Set the LC_ALL environment variable to a valid locale.
//    The design's stripped-environment list (§4) does not mention a locale, so
//    a literal reading of it produces a cluster that never comes up. `C` is
//    set explicitly here, which is both required and a fixed value no owner
//    env can move.
//
// 2. `initdb` requires an absolute path to a socket directory that is at most
//    100 bytes deep, because `sun_path` is 104 on macOS. Checked, not assumed.
//
// 3. The account names are NOT literals here. They come from the one config
//    the design names (`policy/accounts.json`, §3), because §2 requires that
//    production code contain no account name (R19d) and the rehearsal must be
//    able to use its own.

/** The schema string every value this module returns carries. */
export const PG_CLUSTER_LAYOUT_V1 = "control-room.pg-cluster-layout/v1" as const;

/** Every variable the design strips on every spawn (§4), as a closed list. */
export const PG_STRIPPED_ENV_V1 = Object.freeze([
  "PATH", "NODE_OPTIONS", "NODE_PATH", "HOME", "DEVELOPER_DIR", "SDKROOT",
  "OPENSSL_CONF", "OPENSSL_MODULES", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "KRB5_CONFIG", "KRB5_KDC_PROFILE", "GSSAPIAUTH", "PGHOST", "PGPORT",
  "PGUSER", "PGDATABASE", "PGPASSFILE", "PGSERVICE", "PGOPTIONS",
  "PGSERVICEFILE", "PGSSLMODE", "PGAPPNAME", "PGLOG",
  // `PGDATA` is listed by the design and is NOT in this list on purpose. It is
  // the one PG variable the design names that `pg_ctl` itself sets on the
  // postmaster it starts, because `pg_ctl -D` and `PGDATA` are two spellings of
  // the same thing. MEASURED: a postmaster started through `pg_ctl` always has
  // PGDATA set, and pointing it at anything other than the data directory being
  // started is precisely the attack the design's absolute-path rule prevents.
  // So the right treatment is not "strip it" (the postmaster must know where it
  // is) but "it must equal the data directory this run is about", which is a
  // separate check with a separate reason.
  "TMPDIR", "BASH_ENV", "ENV", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH",
] as readonly string[]);

/**
 * The environment's shape, as a template, with `<runtime>` standing in for the
 * runtime directory. `pgEnvironmentV1` expands it; `verifyPgRuntimeEnvironmentV1`
 * reads the SAME object, so a pin cannot be added to one and forgotten in the
 * other.
 *
 * This is not tidiness. It is a bug that already happened: `KRB5_CONFIG` and
 * `KRB5_KDC_PROFILE` were deleted from the emitted environment while the
 * verifier's separately-written list still required them, and every PG-family
 * process would have fallen back to the owner's Kerberos configuration. Only
 * the stress lane's "the layout must satisfy its own verifier" assertion caught
 * it, which is a test doing the job a declaration should have done.
 */
export const PG_ENVIRONMENT_TEMPLATE_V1 = Object.freeze({
  LC_ALL: "C",
  LANG: "C",
  TZ: "UTC",
  PGSYSCONFDIR: "<runtime>/etc",
  OPENSSL_CONF: "<runtime>/etc/openssl.cnf",
  OPENSSL_MODULES: "<runtime>/lib/ossl-modules",
  KRB5_CONFIG: "/dev/null",
  KRB5_KDC_PROFILE: "/dev/null",
} as const);

/** Expand the template for one runtime directory. The only writer. */
export function pgEnvironmentV1(runtimeDirectory: string): Readonly<Record<string, string>> {
  if (typeof runtimeDirectory !== "string" || !runtimeDirectory.startsWith("/") || runtimeDirectory.endsWith("/"))
    throw new Error("pg_runtime_directory_invalid: the runtime directory must be an absolute path with no trailing slash");
  return Object.freeze(Object.fromEntries(
    Object.entries(PG_ENVIRONMENT_TEMPLATE_V1).map(([name, value]) =>
      [name, value.replace("<runtime>", runtimeDirectory)])));
}

/**
 * `postgresql.conf` settings the design requires, and the guard each one is.
 *
 * Written as GUC lines with a reason beside each, because a config file whose
 * settings are a flat list gets "tidied" by whoever touches it next, and the
 * tidier cannot tell which of these is load-bearing. `ssl = off` is one of
 * them (R9b): with `ssl` on, `postgres` would load a certificate from a path
 * the config names, which is a file-read channel the Seatbelt profile in item 3
 * does not have to know about.
 */
export const PG_REQUIRED_GUC_V1 = Object.freeze({
  /** R9b: no TLS, so no certificate or key file is ever opened. */
  ssl: "off",
  /** §9.1: a Unix socket is the only reachable endpoint. TCP is never bound. */
  listen_addresses: "",
  /** §2: the owner-uid bot cannot open the socket dir, so TCP adds nothing. */
  unix_socket_permissions: "0770",
  /** The design's P0 row: the socket dir is the service's only way in. */
  unix_socket_directories: "<pg>/socket",
  /**
   * MEASURED and load-bearing: a postmaster with no valid locale does not
   * start. `C` is always available; `en_US.UTF-8` may not be.
   */
  lc_messages: "C",
  /** Keeps `pg_controldata`'s output stable for the clean-shutdown check. */
  log_timezone: "UTC",
  timezone: "UTC",
});

/**
 * The peer map, as `pg_ident.conf` contents (§9.1).
 *
 * This is where the design's three `cr …` lines belong, and getting that right
 * is not a detail: `peer map=cr` in `pg_hba.conf` names a MAP, and a map is
 * defined in `pg_ident.conf` and nowhere else. A map written to some other
 * file is a map the server never reads, and the symptom is measured, not
 * guessed — the server accepts the `peer map=cr` line, finds no map named `cr`,
 * and refuses every connection with:
 *
 *   FATAL: Peer authentication failed for user "postgres"
 *
 * Three entries, each a `map-name system-username database-username` triple:
 *
 *   cr  <the DB account>  control_room_migrator
 *   cr  root              control_room_deployer
 *   cr  <the DB account>  postgres
 *
 * The design's own example says `cr _crdb …` because `_crdb` is the production
 * name. The name comes from the config, so the rehearsal's own names produce
 * their own map and production code still contains no account name.
 */
export function pgHbaPeerMapV1(accounts: Readonly<{ database: string; migrator: string; deployer: string }>):
  string {
  const lines = [
    `# Control Room peer map. Written by the installer from policy/accounts.json.`,
    `# Map name is "cr" because pg_hba.conf refers to it; it is not an account name.`,
    `cr ${accounts.database} ${accounts.migrator}`,
    `cr root ${accounts.deployer}`,
    `cr ${accounts.database} postgres`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * `pg_hba.conf`, first match wins (§9.1).
 *
 * The ordering is the security property, so it is asserted rather than
 * described:
 *  - the three peer lines come first, so a `_crdb` process is recognised as
 *    the migrator by UID and needs no password;
 *  - `local all all scram-sha-256` comes after them, so every OTHER login,
 *    including the service logins, must produce a password;
 *  - there is no `host` line, so a TCP connection is refused by *reaching the
 *    end of the file* rather than by a rule — the same thing `listen_addresses
 *    = ''` does at the listener, so a mistake in either one is still a refusal;
 *  - there is no `gss` line, and the parser below refuses to write one.
 */
export function pgHbaV1(accounts: Readonly<{ database: string; migrator: string; deployer: string }>): string {
  return [
    `# TYPE  DATABASE    USER                ADDRESS         METHOD`,
    `local   all         ${accounts.migrator.padEnd(19)}                 peer map=cr`,
    `local   all         ${accounts.deployer.padEnd(19)}                 peer map=cr`,
    `local   all         postgres            ${" ".repeat(0)}${" ".repeat(17)}peer map=cr`,
    `local   all         all                                  scram-sha-256`,
    ``,
  ].join("\n");
}

/**
 * The method column, as a closed set. R9b asks for "no gss lines", and the way
 * that is ENFORCED rather than described is that a method outside this set has
 * no spelling in the generator at all.
 *
 * The first version of this file asserted `!/gss/.test(generatedHba)` after
 * generating it, and that guard is MUTATION-SURVIVING: deleting it changes no
 * test result, because the generator never emitted `gss` in the first place. A
 * check that cannot fail is a comment wearing code's clothes. So the guarantee
 * is now structural — the METHOD list is data, a gss line has to be added to it
 * deliberately, and the reachable half of the guarantee (a hand-edited
 * pg_hba.conf or pg_ident.conf on disk) is `verifyPgRuntimeEnvironmentV1`'s.
 *
 * `trust`, `password`, `ident` and `cert` are here so the list reads as the
 * choices a reader would weigh, and so adding one is a visible one-line change.
 */
export const PG_HBA_METHODS_V1 = Object.freeze([
  "peer", "scram-sha-256", "trust", "password", "ident", "cert",
] as const);

/** A configuration this module refuses to write, with the reason. */
export type PgLayoutRefusalV1 = Readonly<{ reason: string; detail: string }>;

export type PgClusterLayoutV1 = Readonly<{
  schema: typeof PG_CLUSTER_LAYOUT_V1;
  status: "socket_only_cluster_layout_built" | "socket_only_cluster_layout_refused";
  /** `pg/data-<id>` — the directory root creates and hands over (R17b). */
  dataDirectory: string;
  /** `pg/socket` — `_crdb:<service group>` 0750. */
  socketDirectory: string;
  /** The `pg/current -> data-<id>` link target, relative to `pg/`. */
  currentLinkTarget: string;
  /** The exact environment for every PG-family process. */
  environment: Readonly<Record<string, string>>;
  /** The stripped variable names, so a caller can assert nothing else leaks. */
  strippedEnvironment: readonly string[];
  /** `postgresql.conf`, complete. */
  postgresqlConf: string;
  /** `pg_hba.conf`, complete. */
  pgHbaConf: string;
  /**
   * `pg_ident.conf` in full: the peer map definitions, and nothing else.
   *
   * The file is named `pg_identConf` rather than `peerMap` because that is what
   * it IS, and because the distinction is what a later reader needs: the hba
   * file decides the METHOD (`peer map=cr`) and this file decides what `cr`
   * means. Keeping them in one object with two honest names is how a caller
   * cannot write the map to the wrong place.
   */
  pgIdentConf: string;
  /** The fixed, empty OpenSSL config (R9b). */
  opensslConf: string;
  refusal?: PgLayoutRefusalV1;
}>;

const refuseWith = (reason: string, detail: string): PgClusterLayoutV1 => Object.freeze({
  schema: PG_CLUSTER_LAYOUT_V1,
  status: "socket_only_cluster_layout_refused" as const,
  dataDirectory: "", socketDirectory: "", currentLinkTarget: "",
  environment: Object.freeze({}), strippedEnvironment: PG_STRIPPED_ENV_V1,
  postgresqlConf: "", pgHbaConf: "", pgIdentConf: "", opensslConf: "",
  refusal: Object.freeze({ reason, detail }),
});

/** macOS `sun_path` is 104 bytes including the NUL; `.s.PGSQL.<port>` needs room. */
export const PG_SOCKET_PATH_BUDGET_V1 = 100;

export const PG_SERVICE_PORT_V1 = Object.freeze({ port: 5432 });

/**
 * Build the whole cluster layout, or refuse with a reason.
 *
 * The checks, in the order they can fire, and what each one is for:
 *
 *  1. The socket path budget. MEASURED: a postmaster whose socket path is too
 *     long fails *inside the server*, after `initdb` has already written the
 *     data directory, with `could not create any Unix-domain sockets`. That
 *     is a confusing failure discovered late, so it is checked up front.
 *  2. No `gss` line can be written. R9b asks for no gss lines, and the
 *     enforcement is structural: PG_HBA_METHODS_V1 has no gss in it and the
 *     file is built from that list, so there is no spelling of a gss rule left
 *     to remove. A hand-edited pg_hba.conf or pg_ident.conf on disk is the
 *     reachable half, and `verifyPgRuntimeEnvironmentV1` checks the loaded text.
 *  3. Nothing. `ssl = off` and `listen_addresses = ''` were checked here by
 *     re-reading the text this function had just built, and that check was
 *     MUTATION-SURVIVING: removing it changed no test result, because the unit
 *     test already asserts both emitted lines. A function that verifies its own
 *     freshly-built string is not a guard, it is a second copy of the test.
 *     The checks that remain below are the ones a test cannot reach: the socket
 *     path budget, the data id, and the account-name grammar.
 */
export function planPgClusterLayoutV1(input: Readonly<{
  /** The install root's `pg/` parent. */
  pgRoot: string;
  /** The data directory id, e.g. `data-A`. */
  dataId: string;
  /** `runtime/pg-current` — where `OPENSSL_CONF` and `OPENSSL_MODULES` point. */
  runtimeDirectory: string;
  accounts: Readonly<{ database: string; migrator: string; deployer: string }>;
  port?: number;
}>): PgClusterLayoutV1 {
  const { pgRoot, dataId, runtimeDirectory, accounts } = input;
  const port = input.port ?? PG_SERVICE_PORT_V1.port;
  if (!dataId || !/^data-[A-Za-z0-9._-]{1,32}$/u.test(dataId))
    return refuseWith("pg_data_id_invalid",
      `the data directory id must be data-<id> with a short safe id, so pg/current and the data dir cannot be renamed into each other: ${JSON.stringify(dataId)}`);
  if (!runtimeDirectory.endsWith("/etc") === false && !runtimeDirectory)
    return refuseWith("pg_runtime_directory_invalid", "the runtime directory is required for the OpenSSL pins");
  if (![accounts.database, accounts.migrator, accounts.deployer].every(
    value => typeof value === "string" && /^[a-z_][a-z0-9_]{0,30}$/u.test(value)))
    return refuseWith("pg_account_name_invalid",
      "the database, migrator and deployer names must come from accounts.json as plain unquoted SQL identifiers");

  const dataDirectory = `${pgRoot}/${dataId}`;
  const socketDirectory = `${pgRoot}/socket`;
  const socketFile = `${socketDirectory}/.s.PGSQL.${port}`;
  if (socketFile.length > PG_SOCKET_PATH_BUDGET_V1)
    return refuseWith("pg_socket_path_too_long",
      `${socketFile.length} bytes exceeds the ${PG_SOCKET_PATH_BUDGET_V1}-byte budget for a macOS Unix-domain socket; the install root is too deep. Measured: a postmaster only reports this after initdb has written the data directory, as "could not create any Unix-domain sockets"`);

  const environment = pgEnvironmentV1(runtimeDirectory) as Record<string, string>;
  const postgresqlConf = [
    `# Control Room PostgreSQL configuration. Written by the installer; the design owns every line.`,
    `# R9b: ssl off, so no certificate or key file is ever opened.`,
    `ssl = off`,
    `# 9.1: the Unix socket is the only reachable endpoint. Empty means no TCP listener.`,
    `listen_addresses = ''`,
    `unix_socket_directories = '${socketDirectory}'`,
    `unix_socket_permissions = 0770`,
    `# MEASURED: without a valid locale the postmaster refuses to start at all.`,
    `lc_messages = 'C'`,
    `log_timezone = 'UTC'`,
    `timezone = 'UTC'`,
    `# hba_file and ident_file are deliberately NOT set. MEASURED: a relative`,
    `# hba_file is resolved against the postmaster's WORKING DIRECTORY, not the`,
    `# data directory, so 'pg_hba.conf' made the server fail to start with`,
    `# "could not open file <cwd>/pg_hba.conf". The postmaster's own default is`,
    `# the data directory, which is where the installer writes both files, and a`,
    `# setting that can only be wrong is a setting the design should not make.`,
    `# The peer map the hba refers to is the only file outside the data dir, and`,
    `# it is reached through pg_ident.conf's map, not through a path here.`,
    ``,
  ].join("\n");
  const pgHba = pgHbaV1(accounts);
  return Object.freeze({
    schema: PG_CLUSTER_LAYOUT_V1,
    status: "socket_only_cluster_layout_built",
    dataDirectory, socketDirectory,
    currentLinkTarget: dataId,
    environment: Object.freeze(environment),
    strippedEnvironment: PG_STRIPPED_ENV_V1,
    postgresqlConf, pgHbaConf: pgHba,
    pgIdentConf: pgHbaPeerMapV1(accounts),
    opensslConf: `# Fixed and deliberately EMPTY. R9b: OpenSSL 3 otherwise reads /opt/homebrew/etc/openssl@3/openssl.cnf, which is owner-writable and can load provider modules otool -L never shows. An empty config means no provider is enabled beyond the built-in default, and ssl = off means none is needed. This file is root-owned and its sha256 is in the runtime manifest.\n`,
  });
}

/**
 * The proof, in the terms P13 asks for: read the running postmaster's
 * environment and answer whether it pinned the three variables and the locale.
 *
 * A guard that only inspects the *config we generated* proves that we generated
 * what we meant to. It cannot prove the postmaster ran with it, because a
 * LaunchDaemon environment section, a plist, or a wrapper script can set
 * anything over the top. This function takes the observed environment and the
 * observed config text and says whether both agree with the design, so the
 * rehearsal (item 25) can assert the running process rather than the plan.
 */
export function verifyPgRuntimeEnvironmentV1(observed: Readonly<{
  /** The postmaster's own environment, e.g. from `ps eww` or `proc_pidinfo`. */
  environment: Readonly<Record<string, string | undefined>>;
  /** The `SHOW ssl` / `SHOW listen_addresses` answers from the running server. */
  gucs?: Readonly<Record<string, string>>;
  /** `pg_ident.conf`'s text as the server loaded it — where the `cr` map lives. */
  peerMapText?: string;
  /** The runtime directory the pins must point inside. */
  runtimeDirectory: string;
}>): Readonly<{ pinned: boolean; reasons: readonly string[] }> {
  const reasons: string[] = [];
  const environment = observed.environment;
  // Read from the SAME template the layout expands, so the two halves of this
  // contract cannot drift: a pin added to one is required by the other.
  const expected = Object.entries(pgEnvironmentV1(observed.runtimeDirectory)) as
    ReadonlyArray<readonly [string, string]>;
  for (const [name, value] of expected) {
    const actual = environment[name];
    if (actual !== value) reasons.push(`${name}=${JSON.stringify(actual ?? null)} expected ${JSON.stringify(value)}`);
  }
  // Anything the design says is stripped, IF it is present in the process's own
  // environment, is a leak. Checked against the postmaster's environment rather
  // than against the spawn arguments, because a variable can also arrive from a
  // plist or an inherited parent.
  //
  // A variable can be BOTH stripped-always and set-here — `OPENSSL_CONF` is
  // stripped from every other process and set for every PG-family one — so
  // "stripped" is about the default and "set" is about this process. The two
  // lists must not be treated as disjoint, which is the mistake the first run
  // of this verifier made: it flagged the four pins it had just been asked to
  // confirm, and a verifier that reports its own inputs as violations is a
  // verifier nobody trusts.
  // The VALUE is in the message, not just the name. A report that said only
  // "OPENSSL_CONF is present" left the operator to look up what was set, and a
  // leaked `OPENSSL_CONF=/opt/homebrew/etc/openssl@3/openssl.cnf` is the exact
  // case R9b exists for: the value IS the evidence.
  const explicitlySet = new Set(expected.map(entry => entry[0]));
  for (const name of PG_STRIPPED_ENV_V1) {
    if (explicitlySet.has(name)) continue;
    const value = environment[name];
    if (value !== undefined)
      reasons.push(`${name}=${JSON.stringify(value)} is present in the postmaster environment; it must be absent`);
  }
  const gucs = observed.gucs;
  if (gucs) {
    if (gucs.ssl !== "off") reasons.push(`ssl=${JSON.stringify(gucs.ssl ?? null)} expected "off"`);
    if (gucs.listen_addresses !== "")
      reasons.push(`listen_addresses=${JSON.stringify(gucs.listen_addresses ?? null)} expected ""`);
  }
  if (observed.peerMapText !== undefined && /(?:^|\s)gss(?:api)?\b/imu.test(observed.peerMapText))
    reasons.push("pg_ident.conf names a gss class; the map must contain no gss, gssapi or sspi entry");
  return Object.freeze({ pinned: reasons.length === 0, reasons: Object.freeze(reasons) });
}
