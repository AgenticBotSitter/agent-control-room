// M3: the PostgreSQL half of `registerInitialPasskeyV1`, plus `recordPasskeyStatus`.
//
// §5.4 splits the install-night passkey ceremony in two. Codex built the TERMINAL
// and QR half, and it is in `install/stage-one-ports.mjs`
// (`registerInitialPasskeyWithAuthorityV1`): begin → render → read the typed code
// → complete. That half had no database behind it, so the port
// `registerInitialPasskeyV1` refused with `database_port_not_yet_supplied` and a
// fresh install ended with no passkey at all. This file is the other half.
//
// THE TRUST-DOMAIN RULE IS WHY THIS IS A SESSION AND NOT AN IMPORT. The updater
// bundle carries no `pg` and no release code, so this port does not import
// `PasskeyStoreV1` — that class needs a `pg` client. It receives a session from
// the caller: a `pg`-shaped object over the installer's own transport, exactly
// as M4's ports receive `sample`/`readCounts`. What crosses the boundary is a
// session and a request, not a module, so the bundle's rule still holds and the
// authority and the store stay in the process that already owns them.
//
// WHY THE SESSION IS THE DEPLOYER. §5.4 names it: a `pg.Client` over
// `updater.json`'s socket as `control_room_deployer` (root peer map
// `cr root control_room_deployer`). `PasskeyStoreV1.initialize()` asserts that
// role, and the assertion stays where it is — this port does not re-implement it,
// because a port that checked the role a second time would be a second place for
// the answer to change.

import { directoryCustodyV1, removeOwnedFileV1 } from "../../../installer/shared/file-custody.mjs";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const refuse = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

/** A canonical absolute path with no trailing slash, matching `safeRoot` in stage-one-ports. */
const safeRoot = value => typeof value === "string" && value.length > 1 && value.length <= 4095
  && isAbsolute(value) && resolve(value) === value && value !== "/" && !value.includes("\0");
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
/** The status file's whole body. Anything larger is a refusal, not a truncation. */
const MAXIMUM_STATUS_BYTES_V1 = 64 * 1024;
const STATUS_SCHEMA_V1 = "control-room.install-passkey-status/v1";

/** The one session shape this port accepts. A `pg` client satisfies it; so does a
 * test double, which is why the shape is checked here rather than assumed. */
function assertSessionV1(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)
    || typeof session.query !== "function") refuse("passkey_session_refused");
  return session;
}

/**
 * `registerInitialPasskey.pg` — §5.4's loop, with the database in it.
 *
 * The sequence, and each step's reason for existing:
 *
 *   1. `beginRegistration({ mode: "initial" })`. INITIAL, never `add`: §5.4 step 1
 *      and the H2 finding. `mode: "add"` is the ceremony that makes a NEW passkey
 *      wait 24 hours unless an active passkey approves it, and on a fresh install
 *      there is none — so the first passkey would be born inactive and the owner
 *      would have to wait out a cooling-off window before anything worked. The
 *      authority already refuses `initial` when the ledger holds any passkey, so
 *      this cannot become a second way to bypass the rule for a later passkey.
 *   2. `registrationOptions(secret)`. The challenge, RP ID and user handle come
 *      from the authority and from nowhere else, so the options published for the
 *      web are the same bytes the owner will be verified against.
 *   3. `openRegistration(...)`. Publishing is what makes the web's page able to
 *      render options at all, and it is keyed on the digest, so a retried begin
 *      cannot swap the challenge under a page that already rendered one.
 *   4. the typed code, six characters, upper-cased. Read by the caller's terminal
 *      — this port never touches the TTY.
 *   5. `completeRegistration({ registrationSecret, typedCode })`.
 *   6. `consumeRegistration(digest)` in EVERY outcome, including the refusal
 *      paths, because the open row is what the web polls and a live open
 *      registration for a burnt secret is a page that keeps asking the owner to
 *      touch Face ID for a ceremony that can no longer complete.
 *
 * @param {object} input §5.4's input, unchanged
 * @param {object} runtime `{ authority, session }` — the authority owns the ledger
 *   and the cryptography; the session is the installer's deployer connection
 * @returns {Promise<{status: "registered", credentialIdDigest: string, attempts: number}>}
 */
export async function registerInitialPasskeyV1(input, runtime = {}) {
  const authority = runtime.authority;
  if (!authority) refuse("passkey_authority_port_unbound");
  assertSessionV1(runtime.session);
  const keys = input?.authenticator === undefined
    ? ["root", "config", "ownerCode", "terminal", "qr", "maxAttempts"]
    : ["root", "config", "ownerCode", "terminal", "qr", "maxAttempts", "authenticator"];
  // The key check is the installer's own `exactKeys`, kept here so a caller cannot
  // smuggle an extra field past a contract that is checked in two places.
  const exactKeys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
  if (!exactKeys(input, keys)
    || !safeRoot(input.root) || !input.config || typeof input.config !== "object" || Array.isArray(input.config)
    || !/^[A-Za-z0-9_-]{16,512}$/u.test(input.ownerCode ?? "") || input.maxAttempts !== 5
    || input.authenticator !== undefined && input.authenticator !== "software"
    || typeof authority.beginRegistration !== "function" || typeof authority.registrationOptions !== "function"
    || typeof authority.completeRegistration !== "function") {
    refuse("passkey_registration_input_refused");
  }
  // THE PRACTICE INSTALL'S PHONE. `authenticator: "software"` and a
  // `runtime.softwareAuthenticator` come together or not at all: the flag alone
  // would print a QR nobody can scan and wait for a code nothing can produce, and
  // the phone alone would answer for an owner on an install that never asked for
  // practice mode. The phone is built (and gated) by
  // `install/rehearsal-authenticator.mjs`; this port only calls it where the
  // owner's typed code would otherwise be read.
  const phone = runtime.softwareAuthenticator;
  if (input.authenticator === "software" && typeof phone?.answer !== "function")
    refuse("passkey_software_authenticator_unbound");
  if (phone !== undefined && input.authenticator !== "software") refuse("passkey_registration_input_refused");
  // `renderInitialPasskeyV1` prints the QR; `readCodeV1` is the installer's own
  // typed reader, imported from where it lives rather than re-implemented. It
  // already upper-cases and validates the six characters, so this port does not
  // repeat that check — a second validation of the same value in two places is a
  // second place for the rule to differ, and there is nothing to add to it.
  const { renderInitialPasskeyV1 } = await import("../terminal/qr.mjs");
  const { readCodeV1 } = await import("../terminal/read-code.mjs");
  const session = runtime.session;
  for (let attempts = 1; attempts <= input.maxAttempts; attempts += 1) {
    const registration = await authority.beginRegistration({ mode: "initial",
      ...(input.authenticator ? { authenticator: input.authenticator } : {}) });
    const digest = registration?.registrationDigest;
    if (typeof digest !== "string" || !DIGEST.test(digest)) refuse("passkey_registration_result_refused");
    // Published with the authority's OWN options object, whole. The web renders
    // these bytes and hands them to `navigator.credentials.create`; there is no
    // code on the web side that could compute a challenge, an RP ID or an origin,
    // so the parity requirement is satisfied by there being nothing to diverge.
    // `await` MATTERS, and the first version of this line omitted it. The
    // authority's `registrationOptions` is asynchronous because it re-reads the
    // ledger under the serial lock, so without `await` this compared a PROMISE to
    // a digest and every attempt refused with
    // `passkey_registration_result_refused` — a refusal that names neither the
    // missing await nor the authority.
    const options = await authority.registrationOptions(registration.registrationSecret);
    if (options?.registrationDigest !== digest) refuse("passkey_registration_result_refused");
    const installationId = input.config.installationId;
    if (typeof installationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(installationId))
      refuse("passkey_registration_result_refused");
    // THE ROW COUNT IS THE ANSWER, and it is checked.
    //
    // `ON CONFLICT (registration_digest) DO NOTHING` with `RETURNING` returns
    // ZERO rows when the digest is already open — which is exactly what a retried
    // `beginRegistration` for the same secret would produce. Without checking,
    // the port would report a publish it did not perform, and the owner would be
    // asked to type a code against a row holding a DIFFERENT registration's
    // options. `PasskeyStoreV1.openRegistration` refuses that case with
    // `updater_registration_already_open`, and this port must refuse it too rather
    // than inherit the store's check by accident.
    let published;
    try { published = await session.query(`INSERT INTO updater.passkey_open_registrations
        (registration_digest, installation_id, mode, options_json, authorization_challenge, expires_at)
      VALUES ($1,$2,'initial',$3::jsonb,NULL,$4::timestamptz)
      ON CONFLICT (registration_digest) DO NOTHING
      RETURNING registration_digest`,
    [digest, installationId, JSON.stringify(options), registration.expiresAt]); }
    catch (error) {
      // A deployer that cannot publish is a refusal, never a silent success: the
      // owner would be asked to type a code for a registration the web cannot see.
      refuse(`passkey_registration_publish_refused:${String(error?.code ?? "unknown").slice(0, 40)}`);
    }
    if (published?.rows?.length !== 1) refuse("passkey_registration_already_open");
    const rpId = options.publicKey?.rp?.id ?? input.config.rpId;
    if (phone) {
      input.terminal.write("Practice install: no phone is needed for Face ID. The built-in practice "
        + "authenticator is registering a practice passkey for you...\n");
    } else {
      renderInitialPasskeyV1({ rpId, ownerCode: input.ownerCode,
        registrationSecret: registration.registrationSecret }, input.terminal);
    }
    try {
      // The practice phone answers through the installed web host exactly as the
      // owner's phone would, and its code then takes the typed code's place: the
      // authority below compares it with the web's row and verifies the
      // attestation the same way for both.
      const typedCode = phone
        ? await phone.answer({ registrationSecret: registration.registrationSecret,
          expectedChallenge: options.publicKey?.challenge })
        : await readCodeV1(input.terminal);
      if (phone) input.terminal.write(`Practice passkey code: ${typedCode} (entered for you)\n`);
      const completed = await authority.completeRegistration({ registrationSecret: registration.registrationSecret,
        typedCode });
      if (typeof completed?.credentialId !== "string" || completed.credentialId.length < 1) {
        refuse("passkey_registration_result_refused");
      }
      if (phone) input.terminal.write("Practice passkey registered. No phone was used.\n");
      return Object.freeze({ status: "registered", credentialIdDigest: sha256(completed.credentialId), attempts });
    } catch (error) {
      // §5.4 step 8: only these two codes are worth another attempt, and only
      // while attempts remain. Anything else stops the loop and is reported, so a
      // broken database or a missing store is not retried five times.
      if (attempts === input.maxAttempts || !["updater_passkey_code_refused", "updater_registration_expired",
        "updater_registration_row_count_refused"].includes(error?.code)) {
        if (phone) {
          input.terminal.write(`Practice passkey did not register (${String(error?.code ?? "unknown").slice(0, 80)}).\n`);
        }
        throw error;
      }
    } finally {
      // Burned in EVERY outcome, including the success. The row is the web's only
      // reason to keep rendering options, and a consumed registration makes the
      // next read refuse by name rather than leaving the page live.
      await session.query(`UPDATE updater.passkey_open_registrations SET consumed_at = pg_catalog.now()
        WHERE registration_digest = $1 AND consumed_at IS NULL`, [digest]).catch(() => {});
    }
  }
  refuse("passkey_registration_result_refused");
}

/**
 * `recordPasskeyStatus` — the installer's record of how the ceremony ended.
 *
 * The installer's `runInitialPasskeyTransactionV1` calls this with either
 * `{status: "registered", credentialIdDigest, attempts}` or
 * `{status: "stopped", reason}`, and then writes its own journal line. This port
 * writes the FILE the rest of the install reads back: the updater's status
 * directory is what `control-room status` and the web's setup page consult, and
 * without it a passkey that failed looks identical to a passkey that was never
 * attempted.
 *
 * The credential is recorded as a DIGEST. The install journal and this file are
 * both readable by more than one principal over the install's life, and the
 * credential id is the value an attacker with either of them would replay.
 */
export async function recordPasskeyStatusV1(input) {
  const registered = input?.status === "registered", stopped = input?.status === "stopped";
  if (!input || typeof input !== "object" || Array.isArray(input) || (!registered && !stopped)
    || !safeRoot(input.root)
    || registered && (!DIGEST.test(input.credentialIdDigest ?? "")
      || !Number.isSafeInteger(input.attempts) || input.attempts < 1 || input.attempts > 5)
    || stopped && (typeof input.reason !== "string" || !/^[a-z][a-z0-9_-]{0,79}$/u.test(input.reason))
    || Object.keys(input).some(key => !["root", "status", "credentialIdDigest", "attempts", "reason"].includes(key))) {
    refuse("passkey_status_input_refused");
  }
  // A `registered` line carries NO reason, and a `stopped` line carries NO digest.
  // A record that carried both would be a claim that a passkey exists and that the
  // ceremony failed, and every later reader would have to guess which was true.
  if (registered && input.reason !== undefined) refuse("passkey_status_input_refused");
  if (stopped && input.credentialIdDigest !== undefined) refuse("passkey_status_input_refused");
  const body = registered
    ? { schema: STATUS_SCHEMA_V1, status: "registered", credentialIdDigest: input.credentialIdDigest,
      attempts: input.attempts }
    : { schema: STATUS_SCHEMA_V1, status: "stopped", reason: input.reason };
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  if (bytes.byteLength > MAXIMUM_STATUS_BYTES_V1) refuse("passkey_status_write_refused");
  const path = join(input.root, "status", "passkey.json");
  const check = await directoryCustodyV1(dirname(path)).catch(() => refuse("passkey_status_write_refused"));
  for (const directory of [input.root, dirname(path)]) {
    const entry = await lstat(directory).catch(() => refuse("passkey_status_write_refused"));
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o022) !== 0
      || entry.uid !== process.geteuid?.()) refuse("passkey_status_write_refused");
  }
  const temporary = join(dirname(path), `.passkey-${process.pid}-${randomBytes(8).toString("hex")}`);
  // O_EXCL|O_NOFOLLOW, 0600, then an atomic rename. The install root is
  // root-owned and the file is read by services running as other uids, so the
  // mode is the boundary and a writer that could be raced through a symlink would
  // be a writer for someone else.
  const handle = await open(temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
    .catch(() => refuse("passkey_status_write_refused"));
  const owned = await handle.stat();
  try {
    try { await check(); await handle.writeFile(bytes); await handle.chmod(0o600); await handle.sync(); }
    finally { await handle.close(); }
    await check(); await rename(temporary, path); await check();
  } finally { await removeOwnedFileV1(temporary, owned); }
  return Object.freeze({ recorded: true, status: body.status });
}
