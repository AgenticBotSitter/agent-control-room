// The install-night database phase's immutable process contract (§5.3 of
// INSTALL_COMPOSITION.md), shared by the two scripts that implement it and by
// the root-side port that spawns them.
//
// This file is DATA. It parses and validates requests and results and decides
// nothing about the host, so every guard in it is reachable by a test that runs
// anywhere. The parts that touch PostgreSQL live in the scripts beside it.
//
// WHY A SEPARATE CONTRACT FILE. The root-side port (`initializeDatabaseV1` in
// cli/control-room-native-ports.mjs) and the script it spawns must agree
// exactly, and they are compiled and bundled by different steps: the port is
// part of `cli.mjs`, the scripts are separate bundle entries. A schema string
// typed twice is a string that can drift, and the failure mode of drifted
// request keys is a refusal on install night with no local reproduction — the
// exact class of failure §5.3's "Any code not listed is a bug" rule exists to
// stop. So both sides import these functions and neither spells a key.

// The request the root port sends, and the result it demands back.
export const DATABASE_INIT_REQUEST_V1 = "control-room.database-init/v1";
export const DATABASE_INIT_RESULT_V1 = "control-room.database-init-result/v1";
export const RELEASE_SCHEMA_REQUEST_V1 = "control-room.release-schema/v1";
export const RELEASE_SCHEMA_RESULT_V1 = "control-room.release-schema-result/v1";

/**
 * One active call per install root, per script.
 *
 * The port holds this set for the root side; the scripts hold it for the
 * script side, because the two are separate processes and a lock in one cannot
 * be seen by the other. Both exist because a second concurrent init would race
 * on the same data directory, and a second concurrent ledger apply would race
 * on the same schema.
 */
export const activeDatabasePhaseCalls = new Set();

/**
 * A POSIX account name, as `pg_ident.conf`'s system-username column needs it.
 *
 * MEASURED, and the reason this is NOT the `^_[a-z][a-z0-9]{1,30}$` the
 * live-database-move port uses: the peer map is keyed on the SYSTEM-username
 * column, and libpq reports the identity of the process, so that column has to
 * name an account that actually exists on the machine. In production it is the
 * installer's `_crdb`; in a rehearsal or a test lane standing in for it, it is
 * the invoking user, whose name has no leading underscore. A pattern that only
 * accepted the underscore form would make the peer map untestable without root
 * — and a rule that cannot be reached by a test is a rule nobody has checked.
 *
 * What the pattern does enforce is what the map actually depends on: an
 * unquoted identifier, so a name carrying a quote, a space or a semicolon
 * cannot become a second rule in `pg_ident.conf`. `ROOT` is refused by name as
 * well as by uid below, because a database account that is root would make the
 * map's `cr root postgres` line true and hand the superuser to every process on
 * the Mac.
 */
export const DATABASE_ACCOUNT_PATTERN_V1 = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/u;

/** The one account name the phase refuses even though the grammar allows it. */
export const FORBIDDEN_DATABASE_ACCOUNTS_V1 = Object.freeze(["root"]);

/** `data-<id>`: short, and impossible to confuse with `pg/current` itself. */
const DATA_ID_PATTERN_V1 = /^data-[A-Za-z0-9._-]{1,32}$/u;

/** A SQL identifier used as a login name: no quoting, no placeholders. */
const ROLE_NAME_PATTERN_V1 = /^[a-z][a-z0-9_]{0,62}$/u;

/**
 * Logins that must NEVER hold a password, refused by name wherever a login list
 * is parsed.
 *
 * The deployer's whole authority is "a root process on the local socket" (`cr
 * root control_room_deployer`) and `postgres` is the database account's peer
 * line; a SCRAM verifier on either is a second way in that the design does not
 * have. MEASURED by the M1b review (probe H3): the installer's login list carried
 * `control_room_deployer`, init set a verifier on it (`has_verifier: true`), and
 * the release phase would then have refused it as unverifiable — after the
 * verifier already existed. Refusing it here, in the one parser the port and both
 * scripts share, stops it before any statement runs.
 */
export const PASSWORDLESS_LOGINS_V1 = Object.freeze(["control_room_deployer", "postgres"]);

/** SCRAM passwords reach the script on stdin and are never shorter than this. */
export const MINIMUM_LOGIN_PASSWORD_BYTES_V1 = 24;

/** One bounded JSON line, so a request can never grow into a memory problem. */
export const MAXIMUM_REQUEST_BYTES_V1 = 64 * 1024;
/** One result line. Smaller: the result is four fixed fields. */
export const MAXIMUM_RESULT_BYTES_V1 = 8 * 1024;

const refuse = code => { throw new Error(code); };

const isPlainRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** A canonical absolute path with no trailing slash, so two spellings cannot differ. */
export function canonicalRootPathV1(value, code) {
  if (typeof value !== "string" || !value.startsWith("/") || value.endsWith("/") || value === "/"
    || value.includes("\0") || value.includes("//") || value.split("/").includes("..")) refuse(code);
  return value;
}

/**
 * The OS accounts the phase runs under, exactly the three the installer created.
 *
 * `uid` and `gid` are REQUIRED rather than looked up, because the script must
 * spawn its children as that account and a name it resolves itself would be a
 * name a replacement `/etc/passwd` entry could move. A uid of 0 is refused: the
 * whole point of the database account is that PostgreSQL is not run as root, and
 * `postgres` itself refuses to start as root, so accepting it here would only
 * push the refusal somewhere less legible.
 */
export function parseDatabasePhaseAccountsV1(value, code) {
  if (!isPlainRecord(value) || Object.keys(value).sort().join(",") !== "database,service") refuse(code);
  const account = entry => {
    if (!isPlainRecord(entry) || Object.keys(entry).sort().join(",") !== "gid,name,uid") refuse(code);
    if (typeof entry.name !== "string" || !DATABASE_ACCOUNT_PATTERN_V1.test(entry.name)
      || FORBIDDEN_DATABASE_ACCOUNTS_V1.includes(entry.name)) refuse(code);
    if (!Number.isSafeInteger(entry.uid) || entry.uid < 1 || entry.uid > 0x7fffffff) refuse(code);
    if (!Number.isSafeInteger(entry.gid) || entry.gid < 1 || entry.gid > 0x7fffffff) refuse(code);
    return Object.freeze({ name: entry.name, uid: entry.uid, gid: entry.gid });
  };
  const database = account(value.database), service = account(value.service);
  if (database.name === service.name || database.uid === service.uid) refuse(code);
  return Object.freeze({ database, service });
}

/**
 * The logins the phase creates, each with a password that arrives on stdin.
 *
 * `passwordStdin` must be literally `true` and is carried in the request rather
 * than inferred, so the key that says "do not expect a password in argv" is
 * present in the artifact the port journals rather than being a property of the
 * code that reads it.
 */
export function parseDatabasePhaseLoginsV1(value, code) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) refuse(code);
  const names = new Set();
  const logins = value.map(entry => {
    if (!isPlainRecord(entry) || Object.keys(entry).sort().join(",") !== "name,passwordStdin") refuse(code);
    if (typeof entry.name !== "string" || !ROLE_NAME_PATTERN_V1.test(entry.name)) refuse(code);
    if (entry.passwordStdin !== true) refuse(code);
    if (PASSWORDLESS_LOGINS_V1.includes(entry.name)) refuse(`${code}:passwordless_login:${entry.name}`);
    if (names.has(entry.name)) refuse(code);
    names.add(entry.name);
    return Object.freeze({ name: entry.name });
  });
  return Object.freeze(logins);
}

/**
 * The shared request shape, minus the script-specific half.
 *
 * `runtime` and `socketDir` are RELATIVE to `root` rather than absolute, which
 * is the decision that makes the contract checkable: an absolute socket
 * directory is a second place the database is reachable from, and a relative
 * one cannot name anything outside the install root. `socketDir` is additionally
 * required to be exactly `pg/socket`, which is the path the launch daemon's
 * Seatbelt profile exempts and the path `pg/current` is relative to.
 */
// THE PORT IS PART OF THE REQUEST, and that is a change this round forced.
//
// The cluster is socket-only, so the port is not a network fact — it is part of
// the SOCKET PATH, and the socket lives at `pg/socket/.s.PGSQL.<port>`. Both phases
// compute that path, and if they compute it from different numbers one of them
// connects to a socket the other never created. MEASURED: with the port only in
// the release's role-manifest data, a lane running the cluster on 59910 had the
// INIT phase honour its override and the RELEASE phase (spawned as a child, with
// no override available) read 5432 from the manifest and answer
//
//   connection to server on socket "…/pg/socket/.s.PGSQL.5432" failed:
//   No such file or directory
//
// — a connection error naming the wrong port rather than the disagreement that
// caused it, and one that appears only in the cross-process test because the
// in-process tests pass the port as a dependency.
//
// So the port travels with the request, is CHECKED against the same range the
// socket path needs, and the role manifest's copy is the PRODUCTION value the
// port's own caller falls back to. Two spellings of the port is one too many, and
// the request is the one place the port, the data id and the socket directory all
// already live.
export function parseDatabasePhaseRequestV1(value, { schema, code, extraKeys, optionalKeys = [] }) {
  const sharedKeys = ["accounts", "logins", "pgDataId", "port", "root", "runtime", "schema", "socketDir"];
  const required = [...sharedKeys, ...extraKeys].sort().join(",");
  const optional = [...optionalKeys].sort().join(",");
  if (!isPlainRecord(value) || value.schema !== schema) refuse(code);
  const present = Object.keys(value).sort().join(",");
  // The key set is EXACT: every required key present, and every present key
  // either required or explicitly optional. Checking it as two halves rather
  // than one joined string is what makes an OPTIONAL key expressible at all —
  // MEASURED: `expectedLedgerHead` is optional (a fresh install has no head to
  // expect) and declaring it in `extraKeys` refused every release request that
  // did not pin one.
  if (present.split(",").filter(key => !required.split(",").includes(key)
    && !optional.split(",").includes(key)).length > 0) refuse(code);
  if (required.split(",").filter(key => !present.split(",").includes(key)).length > 0) refuse(code);
  const root = canonicalRootPathV1(value.root, code);
  const pgDataId = value.pgDataId;
  if (typeof pgDataId !== "string" || !DATA_ID_PATTERN_V1.test(pgDataId)) refuse(code);
  if (typeof value.runtime !== "string" || value.runtime !== "runtime/pg-current") refuse(code);
  if (value.socketDir !== "pg/socket") refuse(code);
  // Bounded to the TCP range because that is the range PostgreSQL itself accepts
  // for `unix_socket_directories`-adjacent port selection, and because
  // `planPgClusterLayoutV1` builds the socket PATH from this number — a port of 0
  // or 70000 would produce a path PostgreSQL never publishes.
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) refuse(code);
  return Object.freeze({
    root, pgDataId, port: value.port, runtime: value.runtime, socketDir: value.socketDir,
    accounts: parseDatabasePhaseAccountsV1(value.accounts, code),
    logins: parseDatabasePhaseLoginsV1(value.logins, code),
  });
}

/**
 * The passwords that came on stdin, matched to the request's login list.
 *
 * This is a separate parse from the request because it is a different
 * channel: the request is on argv (and therefore in `ps` output and in the
 * journal) and the passwords are not. The pairing is by name, both lists must
 * be exactly the same set, and a password that is not a string, is too short, or
 * contains a NUL is a refusal rather than a truncation — a short password is a
 * refusal because PostgreSQL would accept it and the next login would be weaker
 * than the installer promised.
 */
export function parseDatabasePhasePasswordsV1(value, logins, code) {
  if (!isPlainRecord(value)) refuse(code);
  const names = Object.keys(value).sort().join(",");
  if (names !== logins.map(login => login.name).sort().join(",")) refuse(code);
  const passwords = {};
  for (const login of logins) {
    const password = value[login.name];
    // PRINTABLE ASCII ONLY. The phase computes the SCRAM verifier itself
    // (`scram-verifier.mjs`) and PostgreSQL's SASLprep is the identity exactly on
    // ASCII, so this is the set for which the verifier computed here is the one
    // the server would compute. The installer's passwords are base64url (43
    // characters), well inside it. Newlines, NUL and spaces are outside it too.
    if (typeof password !== "string" || password.length < MINIMUM_LOGIN_PASSWORD_BYTES_V1
      || !/^[\x21-\x7e]+$/u.test(password) || password.length > 1024) refuse(code);
    Object.defineProperty(passwords, login.name, {
      value: Object.freeze(password), enumerable: true, writable: false, configurable: false,
    });
  }
  return Object.freeze(passwords);
}

/**
 * The request, from the `--request` argv the port sends, and ONLY from there.
 *
 * §5.3's contract is one JSON value in argv and one JSON value on stdin, and the
 * argv half was the one that was never implemented: both scripts' entries read
 * TWO values from stdin, so `initializeDatabaseV1` — which sends the request on
 * argv and ONE line on stdin — could not start either phase.
 *
 * The argv shape is EXACT: `[--request, <json>]` and nothing else, length 2, the
 * flag spelled `--request`, one value with no NUL, and a value within
 * `maximumBytes`. A bare `--request` with no value, an unknown flag, a second
 * flag, or a repeated `--request` is a refusal rather than a "use whatever was
 * there", because a script that guessed which of its arguments was the request
 * would be guessing about the one argument whose contents decide what it does to
 * the cluster.
 *
 * The value is returned as TEXT, not parsed. Parsing is
 * `parseDatabasePhaseRequestV1`'s job, and it is the SAME function the port ran
 * against the identical object before it spawned this process — so a request the
 * port would send is the request the script accepts, by construction rather than
 * by two parsers agreeing.
 */
export function readRequestArgumentV1(argv, maximumBytes, code) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--request"
    || typeof argv[1] !== "string" || argv[1] === "" || argv[1].includes("\0")
    || Buffer.byteLength(argv[1]) > maximumBytes) {
    refuse(code);
  }
  return argv[1];
}

/**
 * Is this process the script the port spawned?
 *
 * MEASURED, and the obvious guard is wrong: `import.meta.url === \`file://${
 * process.argv[1]}\`` compares the module's URL against the path the OS was given,
 * and those DIFFER when the script is reached through a SYMLINK. MEASURED:
 *
 *   $ node /private/tmp/guard.mjs        → argv1 /private/tmp/guard.mjs
 *                                            meta  file:///private/tmp/guard.mjs
 *                                            guard fires: true
 *   $ node /private/tmp/gtest/link.mjs   → argv1 /private/tmp/gtest/link.mjs
 *                                            meta  file:///private/tmp/guard.mjs
 *                                            guard fires: false
 *
 * A script installed through a link is a NORMAL arrangement — an install root's
 * `runtime/` and `updater/current` are both links — and a guard that does not fire
 * means the script runs, does nothing, and EXITS ZERO with empty stdout. That is
 * the worst shape a phase entry can have: the port saw a zero exit and an empty
 * result and refused with `database_phase_result_refused`, naming neither the
 * script nor the reason.
 *
 * So the comparison is made on REALPATHS, which is what makes it true through a
 * link. There is no guard HERE any more: the one entry guard for the tree lives
 * in `src/installer/shared/is-main-module.mjs` and is re-exported below, so a
 * caller that asks this module for the answer and a caller that imports the
 * shared helper cannot disagree. The silent no-op this comment warns about is
 * what the shared helper REFUSES instead of returning `false` for.
 */
// `moduleUrl` is the CALLER's `import.meta.url` (M1b Low). Comparing against this
// contract module's own URL fired only in the BUNDLE, where every module shares one
// URL; run from source, `node --import tsx src/…/init-database.mjs --request '{}'`
// exited 0 with no output — the silent no-op this comment warns about. In the
// bundle the two URLs are the same file, so both arrangements now agree.
export { isMainModuleV1 } from "../../../installer/shared/is-main-module.mjs";

 /** Read the WHOLE of stdin as ONE bounded JSON value, once.
 *
 * This reader REPLACES the line reader both scripts' entries used, and it is a
 * replacement rather than an addition because the old one could not be called
 * TWICE on one stream and both entries had been calling it twice. MEASURED:
 *
 *   first: {"a":1}
 *   threw: AbortError The operation was aborted  destroyed= true
 *
 * `for await (const chunk of stream)` acquires an async iterator, and `break`ing
 * out of that loop calls the iterator's `return()` — which DESTROYS the stream.
 * So the second read never saw a byte, and with the port's own transport
 * (`runWithStdin` writes ONE line and closes) the child exited non-zero before
 * the first SQL statement:
 *
 *   The operation was aborted
 *   exit=1
 *
 * So "read it all, then parse" is NOT a weakening of the line contract: the port
 * writes exactly one JSON line and nothing else, so this reads the same single
 * line — with the line ENDURED rather than found by a reader that had to destroy
 * the pipe to find it. The bound is the same `maximumBytes`, and the parse
 * requires a SINGLE line, so a two-line payload is a refusal: a script cannot be
 * handed a request on one line and a password on the next by a caller that meant
 * to use argv.
 */
export async function readBoundedJsonValueV1(stream, maximumBytes, code) {
  let text = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    text += chunk;
    if (Buffer.byteLength(text) > maximumBytes) refuse(code);
  }
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.split("\n").length !== 1) refuse(code);
  let value;
  try { value = JSON.parse(trimmed); } catch { refuse(code); }
  return value;
}

/**
 * Parse and validate a result the script printed.
 *
 * Every field is checked, including the two proofs (`clusterShutDownClean` and
 * the digest's shape) — a result whose proof is `false`, or whose digest is the
 * empty string, is a result the port must refuse rather than journal. The
 * expected key set is given by the caller because the two scripts have
 * different result shapes, and the ONE thing both share is that no extra key is
 * ever tolerated: a script that learned to add a field would otherwise be able
 * to add a field the port journals without review.
 */
export function parseDatabasePhaseResultV1(text, { schema, keys, code, proofs = {} }) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAXIMUM_RESULT_BYTES_V1 || text.includes("\0")) refuse(code);
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.split("\n").length !== 1) refuse(code);
  let value;
  try { value = JSON.parse(trimmed); } catch { refuse(code); }
  if (!isPlainRecord(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    || value.schema !== schema) refuse(code);
  for (const [key, expected] of Object.entries(proofs)) {
    const actual = value[key];
    if (typeof actual === "boolean" ? actual !== expected
      : typeof actual !== "string" || actual !== expected) refuse(code);
  }
  // The SHAPED FIELDS, checked only for keys this result actually declares.
  //
  // Not hardcoded per-schema, because the two results carry different fields and
  // a list here would be a second place to keep in step with the key set above.
  // What matters is the rule: a field the contract says is a digest or a ledger
  // head is checked for being one. MEASURED: `updaterSchemaDigest` was in the
  // init result's exact key set with NO shape check anywhere, so
  // `updaterSchemaDigest: "not-a-digest"` was journaled as a success — and the
  // install journal is exactly the record a later health check compares against,
  // so a value that is not a digest is not a weaker record, it is no record.
  if (keys.includes("ledgerHead") && (typeof value.ledgerHead !== "string"
    || !LEDGER_HEAD_SHAPE_V1.test(value.ledgerHead))) refuse(code);
  for (const key of DIGEST_KEYS_V1) {
    if (keys.includes(key) && (typeof value[key] !== "string" || !DIGEST_SHAPE_V1.test(value[key]))) refuse(code);
  }
  return Object.freeze({ ...value });
}

/**
 * The keys whose value must be `sha256:<64 lowercase hex>`.
 *
 * Named as a constant rather than inlined at the call site because the PORT and
 * the SCRIPTS must agree, and a digest shape spelled twice is a digest shape
 * that can drift.
 */
export const DIGEST_SHAPE_V1 = /^sha256:[a-f0-9]{64}$/u;

const DIGEST_KEYS_V1 = Object.freeze(["updaterSchemaDigest", "schemaDigest"]);

/** `NNNN_name.sql`: the ledger head the release script reports. */
const LEDGER_HEAD_SHAPE_V1 = /^[0-9]{4}_[a-z0-9_]+\.sql$/u;

/** `sha256:<64 hex>`: the one digest shape both scripts record. */
export function isDigestV1(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

/** The ledger head, `NNNN_name.sql`: what `apply-release-schema` reports. */
export function isLedgerHeadV1(value) {
  return typeof value === "string" && /^[0-9]{4}_[a-z0-9_]+\.sql$/u.test(value);
}
