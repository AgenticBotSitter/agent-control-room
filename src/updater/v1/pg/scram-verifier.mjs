// The SCRAM-SHA-256 verifier for a service login, computed HERE rather than by
// psql or by the server. Blocker 2 of the M1b review.
//
// WHY. The phase used psql's `\password`, feeding the value on stdin. psql's
// prompt opens `/dev/tty` whenever the process has a controlling terminal, and on
// install night the installer runs under `sudo` in Terminal, so (MEASURED, probe
// G) the owner's screen showed `Enter new password for user "control_room_web":`
// and the phase hung; pressing Enter (probe I) set an EMPTY password, ran the
// real password lines as SQL, and the server wrote the whole password into
// `logs/postgresql17/out.log`.
//
// A verifier is not a secret in that sense: it is what the server stores and
// what `pg_authid.rolpassword` holds, and the server accepts it verbatim in
// `ALTER ROLE … PASSWORD 'SCRAM-SHA-256$…'` without ever seeing the password. So
// the password stays in this process, the statement psql runs carries only the
// verifier, and there is nothing for a terminal, a log line or an error message
// to leak. (PostgreSQL's own `\password` and libpq's `PQencryptPasswordConn` do
// exactly this computation client-side; this is the same RFC 5802/7677 formula.)
//
// SASLprep. PostgreSQL applies SASLprep to the password before hashing, and for a
// password that is pure ASCII its `pg_saslprep` returns the input unchanged. The
// phase accepts only printable ASCII passwords (`parseDatabasePhasePasswordsV1`),
// so the bytes hashed here are the bytes the server would hash. A non-ASCII
// password is refused rather than normalised, because a normaliser written here
// would be a second SASLprep that could disagree with the server's.

import { createHash, createHmac, pbkdf2Sync, randomBytes as defaultRandomBytes, timingSafeEqual } from "node:crypto";

const refuse = code => { throw new Error(code); };

/** PostgreSQL's own default (`scram_iterations`), and the value it writes. */
export const SCRAM_ITERATIONS_V1 = 4096;
/** PostgreSQL's own salt length (`SCRAM_DEFAULT_SALT_LEN`). */
export const SCRAM_SALT_BYTES_V1 = 16;

/** Printable ASCII only: the set for which SASLprep is the identity. */
export const SCRAM_PASSWORD_PATTERN_V1 = /^[\x21-\x7e]+$/u;

export function scramVerifierV1(password, { salt = defaultRandomBytes(SCRAM_SALT_BYTES_V1),
  iterations = SCRAM_ITERATIONS_V1 } = {}) {
  if (typeof password !== "string" || !SCRAM_PASSWORD_PATTERN_V1.test(password)) refuse("scram_password_refused");
  if (!Buffer.isBuffer(salt) || salt.length < 8 || !Number.isSafeInteger(iterations) || iterations < 4096) {
    refuse("scram_parameters_refused");
  }
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}`
    + `:${serverKey.toString("base64")}`;
}

/** The verifier's exact shape, so the statement built from it can be checked. */
export const SCRAM_VERIFIER_PATTERN_V1 = /^SCRAM-SHA-256\$[0-9]{4,7}:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/u;

/**
 * `ALTER ROLE <login> PASSWORD '<verifier>'`. The literal can hold no quote — the
 * verifier is base64, `$` and `:` — and that is CHECKED rather than assumed,
 * because this string is concatenated into SQL.
 */
export function setVerifierStatementV1(login, verifier) {
  if (typeof login !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(login)) refuse("scram_login_refused");
  if (typeof verifier !== "string" || !SCRAM_VERIFIER_PATTERN_V1.test(verifier)) refuse("scram_verifier_refused");
  return `ALTER ROLE ${login} PASSWORD '${verifier}'`;
}

/**
 * Does `password` produce the STORED verifier? (N2 of the M1c review.)
 *
 * A peer-mapped login (the migrator) authenticates by BEING the database account,
 * so a `psql -w` connection with its password succeeds whatever the password is —
 * MEASURED: a wrong password answered `authenticated: true`. The only proof that
 * the password the installer wrote down is the login's password is the server's
 * own record of it: recompute the stored and server keys from the password, the
 * verifier's salt and its iteration count, and compare in constant time.
 */
export function scramVerifierMatchesV1(password, verifier) {
  if (typeof verifier !== "string" || !SCRAM_VERIFIER_PATTERN_V1.test(verifier)) return false;
  if (typeof password !== "string" || !SCRAM_PASSWORD_PATTERN_V1.test(password)) return false;
  const [, iterations, salt] = /^SCRAM-SHA-256\$([0-9]+):([^$]+)\$/u.exec(verifier);
  let recomputed;
  try {
    recomputed = scramVerifierV1(password, { salt: Buffer.from(salt, "base64"), iterations: Number(iterations) });
  } catch { return false; }
  const left = Buffer.from(recomputed);
  const right = Buffer.from(verifier);
  return left.length === right.length && timingSafeEqual(left, right);
}
