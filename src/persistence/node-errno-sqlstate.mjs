// The Node errno that are indistinguishable from a SQLSTATE by shape alone.
//
// Why this file exists
// --------------------
// Every adapter reads its SQLSTATE through one reader, and `code` is also where
// Node puts its OWN system errors. Fifteen of those are exactly five UPPERCASE
// LETTERS, so the SQLSTATE shape (five characters, `[0-9A-Z]`) admits them. A
// refusal classification that read one of those as a server state would turn a
// dropped connection into a "clean refusal"; a reader that hid every E-prefixed
// string instead would do the opposite and worse: it would discard a REAL
// server refusal, because PostgreSQL accepts and transmits an ERRCODE a
// function author chose -- `RAISE ... USING ERRCODE = 'E1234'` -- and that
// refusal must keep the pool serving.
//
// So the exclusion has to be by NAME over a closed set, not by PREFIX. Node's
// errno names are a closed, platform-defined table, so the set is DERIVED from
// `os.constants.errno` (the exactly-five-character names) and frozen here, and
// `tests/database-sqlstate-regressions.test.ts` pins this list against that
// live table in both directions -- a platform whose errno table gains a
// five-letter name must add it here or the pin fails, rather than a caller
// quietly reading it as a SQLSTATE.
//
// Measured on this repository's pinned drivers (pg 8.23.0, pg-pool 3.14.0,
// pg-protocol 1.16.0): the ONLY five-character code any of them puts on
// `error.code` is EPIPE (pg/lib/connection.js), which is already in the table.
// ECONNRESET also appears and is ten characters, so the shape excludes it
// anyway. There was no code to add beyond the derived set.
//
// Plain Node only, by design: the operator scripts that run under bare `node`
// as the `postgres` account (scripts/mac-local/database-upgrade-remote.mjs) and
// the TypeScript reader in src/persistence/database.ts must agree on this list
// by construction rather than by a second hand-maintained copy.

/**
 * Every `os.constants.errno` name that is exactly five characters. Frozen: a
 * reader that answers "is this a SQLSTATE" must be a pure function of its input,
 * so this is a literal, not a per-call computation.
 *
 * The other 64 errno names are 3, 4 or 6+ characters and are therefore already
 * outside the SQLSTATE shape (EIO, EAGAIN, ENOENT, ECONNRESET, ...). Note that
 * the five-character set is a mix of real errno (EPIPE, EBADF, ESRCH, ETIME,
 * EPERM) and their numeric OS spellings (E2BIG, ENXIO, EFBIG, ENOSR), because
 * Node exposes both forms and the table decides, not a hand-picked subset.
 */
export const NODE_ERRNO_SQLSTATE_NAMES_V1 = Object.freeze([
  "E2BIG", "EBADF", "EBUSY", "EFBIG", "EIDRM", "EINTR", "ELOOP", "ENOSR", "ENXIO",
  "EPERM", "EPIPE", "EROFS", "ESRCH", "ETIME", "EXDEV",
]);

const nodeErrnoSqlStateNames = new Set(NODE_ERRNO_SQLSTATE_NAMES_V1);

/** True only for a name in the frozen errno set above.
 * @param {string} value */
export function isNodeErrnoSqlStateNameV1(value) {
  return nodeErrnoSqlStateNames.has(value);
}

const sqlStateShape = /^[0-9A-Z]{5}$/u;

/**
 * The one accept test every SQLSTATE reader uses: the five-character
 * PostgreSQL shape, minus the Node errno that share it.
 *
 * An E-prefixed value that is NOT one of those errno is a server code, and is
 * kept: the reader's job is "did the server refuse this statement", and a
 * refusal the installed database raised itself is the most definite answer
 * there is.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isSqlStateCodeV1(value) {
  return typeof value === "string" && sqlStateShape.test(value) && !nodeErrnoSqlStateNames.has(value);
}
