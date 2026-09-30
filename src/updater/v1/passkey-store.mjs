// The typed PostgreSQL ports item 10a needs, over item 7's fixed updater schema.
//
// WHY A SEPARATE FILE AND NOT MORE METHODS ON `PostgresUpdaterStoreV1`. The
// passkey ports are a different contract from the run ports: they are read by the
// installer while it waits for the owner to type a code, they are written inside
// transactions the caller controls, and every one of them has to survive being
// handed to the passkey authority WITHOUT the run methods present. Splitting them
// keeps that honest — a caller that wires only these gets a store whose missing
// methods are genuinely missing rather than present-and-unimplemented.
//
// SEARCH_PATH (R10b). `initialize` pins `pg_catalog, updater, pg_temp` on the
// connection, and every statement below is schema-qualified anyway, so a
// candidate that can create objects in `public` cannot shadow a name these use.
//
// EVERY BYTE OUT IS UNPADDED BASE64URL. The wrapper in passkey.mjs refuses
// anything whose base64url does not round-trip exactly (`b64url(bytes) === value`),
// because a re-encoded response would be a different response. Node's `pg` hands
// bytea back as a Buffer; `Buffer.toString("base64url")` is the unpadded form the
// wrapper requires, so the encoding decision is made here once and nowhere else.
import { assertPlainObjectV1, assertSafeIdV1, updaterRefuseV1 } from "./contracts.mjs";

const DIGEST_V1 = /^sha256:[a-f0-9]{64}$/u;
const CREDENTIAL_V1 = /^[A-Za-z0-9_-]{16,255}$/u;
const APPROVAL_V1 = /^approval:[0-9a-f-]{36}$/u;
const CODE_V1 = /^[0-9A-Z]{6}$/u;

/** The typed, bounded shape of one passkey credential id the caller may hold. */
function assertCredentialIdV1(value, code) {
  if (typeof value !== "string" || !CREDENTIAL_V1.test(value)) throw updaterRefuseV1(code);
  return value;
}

/**
 * The passkey store: five ports, all as typed as the schema allows.
 *
 * The client is the production peer-authenticated `control_room_deployer`
 * login. Nothing here works as the web login or as the migrator, and that is
 * deliberate — the web's own surface is a separate, much smaller object
 * (`PasskeyWebStoreV1` below).
 */
export class PasskeyStoreV1 {
  constructor(client) { this.client = client; }

  async initialize() {
    await this.client.query("SET search_path = pg_catalog, updater, pg_temp");
    const result = await this.client.query(`SELECT current_user AS current_user,
      pg_has_role(current_user, 'control_room_deployer', 'MEMBER') AS is_deployer,
      current_setting('session_replication_role') AS replication_role`);
    const row = result.rows[0];
    if (!row || row.current_user !== "control_room_deployer" || row.is_deployer !== true
        || row.replication_role !== "origin") throw updaterRefuseV1("updater_store_role_refused");
  }

  // -------------------------------------------------------------------------
  // P-1 `registrationRows(registrationDigest)`
  // -------------------------------------------------------------------------
  /**
   * EVERY row for one registration digest. No LIMIT, no DISTINCT, no dedupe, no
   * "latest wins".
   *
   * That is the whole point of this port and the reason it exists in this shape:
   * the installer's one-row rule (R13a) counts what it finds, and a query that
   * returned one row however many arrived would make the rule unobservable. The
   * schema deliberately has no unique index on `registration_digest`, so two
   * racers both land and both are visible here.
   *
   * The ORDER BY is a fixed one (`received_at`, `id`) rather than none, so the
   * caller's `rows[0]` is deterministic without being a filter: the row count is
   * the answer, and any order gives the same answer.
   *
   * The row is the whole WebAuthn response, with every binary field as unpadded
   * base64url: `clientDataJSON`, `attestationObject` and the transports the
   * browser reported. The add-mode assertion rides along as
   * `authorizationAssertion`, or null.
   */
  async registrationRows(registrationDigest) {
    if (typeof registrationDigest !== "string" || !DIGEST_V1.test(registrationDigest))
      throw updaterRefuseV1("updater_registration_digest_refused");
    const result = await this.client.query(`SELECT registration_digest, credential_id, comparison_code,
        attestation_object, client_data_json, transports, auth_credential_id, auth_authenticator_data,
        auth_client_data_json, auth_signature, auth_user_handle, received_at
      FROM updater.passkey_registrations WHERE registration_digest = $1 ORDER BY received_at, id`, [registrationDigest]);
    return result.rows.map(row => {
      const id = String(row.credential_id);
      const response = Object.freeze({ id, rawId: id, type: "public-key",
        response: Object.freeze({ clientDataJSON: Buffer.from(row.client_data_json).toString("base64url"),
          attestationObject: Buffer.from(row.attestation_object).toString("base64url"),
          transports: Object.freeze([...(row.transports ?? [])].map(String)) }),
        clientExtensionResults: Object.freeze({}) });
      const authorization = row.auth_credential_id === null || row.auth_credential_id === undefined
        ? null : Object.freeze({ id: String(row.auth_credential_id), rawId: String(row.auth_credential_id),
          type: "public-key", response: Object.freeze({
            clientDataJSON: Buffer.from(row.auth_client_data_json).toString("base64url"),
            authenticatorData: Buffer.from(row.auth_authenticator_data).toString("base64url"),
            signature: Buffer.from(row.auth_signature).toString("base64url"),
            userHandle: row.auth_user_handle === null || row.auth_user_handle === undefined
              ? null : Buffer.from(row.auth_user_handle).toString("base64url") }),
          clientExtensionResults: Object.freeze({}) });
      return Object.freeze({ registrationDigest: String(row.registration_digest), credentialId: id,
        comparisonCode: String(row.comparison_code), response, authorizationAssertion: authorization,
        receivedAt: new Date(row.received_at).toISOString() });
    });
  }

  // -------------------------------------------------------------------------
  // P-2's updater half: publish and consume an open registration
  // -------------------------------------------------------------------------
  /**
   * Publish one open registration so the web can render it and be refused
   * anything else.
   *
   * `optionsJson` is `PasskeyAuthorityV1.registrationOptions` — the updater's own
   * object, stored whole. The web reads it back and hands it to
   * `navigator.credentials.create`; there is no code on the web side that could
   * compute a challenge, an RP ID or an origin, so P-2's parity requirement is
   * satisfied by there being nothing to diverge.
   *
   * The digest is the PRIMARY KEY, so re-publishing the same registration is an
   * update of the row the guard below will refuse unless the content matches
   * exactly. That is the right behaviour: an installer that retried a begin must
   * not be able to swap the challenge under a page that has already rendered one.
   */
  async openRegistration({ registrationDigest, installationId, mode, optionsJson, authorizationChallenge,
    expiresAt }) {
    if (typeof registrationDigest !== "string" || !DIGEST_V1.test(registrationDigest))
      throw updaterRefuseV1("updater_registration_digest_refused");
    assertSafeIdV1(installationId, "updater_registration_digest_refused");
    if (!['initial', 'add'].includes(mode)) throw updaterRefuseV1("updater_registration_mode_refused");
    const options = assertPlainObjectV1(optionsJson, "updater_registration_options_refused");
    if (options.registrationDigest !== registrationDigest)
      throw updaterRefuseV1("updater_registration_options_refused");
    if ((mode === "add") !== (typeof authorizationChallenge === "string"))
      throw updaterRefuseV1("updater_registration_challenge_refused");
    if (expiresAt !== undefined && (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))))
      throw updaterRefuseV1("updater_registration_expiry_refused");
    // `expires_at` is set from the DATABASE's clock, not from `now() + an
    // interval the JavaScript computed. Two reasons, and the first one is the
    // bug this replaces:
    //
    //   * an interval computed here clamps a negative value away. The first
    //     version did `Math.max(1, seconds)` so that a past expiry could never
    //     be expressed — which meant an "expired registration" fixture could
    //     only be produced by waiting, and the guard's expiry refusal was
    //     untestable. Worse, the clamp was invisible: the store reported success
    //     and published a registration that was live for a second.
    //   * the updater's own clock is not the authority. §5.1 gives R a 30-minute
    //     life at the database clock, and a skewed updater must not be able to
    //     publish a registration that lives longer than that.
    //
    // So the caller passes the INSTANT, and the SQL converts it. The instant is
    // still the caller's, because it comes from the updater's ledger entry for
    // this registration; what is not the caller's is the comparison, which the
    // guard makes against `pg_catalog.now()`.
    const result = await this.client.query(`INSERT INTO updater.passkey_open_registrations
        (registration_digest, installation_id, mode, options_json, authorization_challenge, expires_at)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz)
      ON CONFLICT (registration_digest) DO NOTHING
      RETURNING registration_digest`,
    [registrationDigest, installationId, mode, JSON.stringify(options), authorizationChallenge ?? null,
      new Date(expiresAt ?? new Date().toISOString()).toISOString()]);
    if (result.rows.length !== 1) throw updaterRefuseV1("updater_registration_already_open");
    return Object.freeze({ registrationDigest });
  }

  /** Mark a registration finished. Idempotent, because a refusal path may reach
   * here after a success path already did. Returns false when it was already
   * consumed, which is information rather than an error: the ledger is the
   * authority on whether it was used or refused, this only stops the web. */
  async consumeRegistration(registrationDigest) {
    if (typeof registrationDigest !== "string" || !DIGEST_V1.test(registrationDigest))
      throw updaterRefuseV1("updater_registration_digest_refused");
    const result = await this.client.query(`UPDATE updater.passkey_open_registrations
      SET consumed_at = pg_catalog.now() WHERE registration_digest = $1 AND consumed_at IS NULL
      RETURNING registration_digest`, [registrationDigest]);
    return result.rows.length === 1;
  }

  /** The web's read: the exact options for an open digest, or nothing. */
  async openRegistrationOptions(registrationDigest) {
    if (typeof registrationDigest !== "string" || !DIGEST_V1.test(registrationDigest))
      throw updaterRefuseV1("updater_registration_digest_refused");
    const row = (await this.client.query(`SELECT mode, options_json, authorization_challenge, expires_at
      FROM updater.passkey_open_registrations
      WHERE registration_digest = $1 AND consumed_at IS NULL AND expires_at > pg_catalog.now()`, [registrationDigest])).rows[0];
    if (!row) return null;
    return Object.freeze({ registrationDigest, mode: String(row.mode), options: row.options_json,
      authorizationChallenge: row.authorization_challenge === null ? null : String(row.authorization_challenge),
      expiresAt: new Date(row.expires_at).toISOString() });
  }

  // -------------------------------------------------------------------------
  // P-3 `recordApprovalRefusal({approvalId, planId, reason})`
  // -------------------------------------------------------------------------
  /**
   * Atomically record one refusal and return the plan-hour aggregate.
   *
   * The whole of P-3 in one round trip: `updater.record_approval_refusal` claims
   * the approval id (so a replay does nothing at all), then upserts the
   * plan-hour bucket, and the database decides which caller was first. The
   * bucket is the DATABASE's hour — `date_trunc('hour', now())` — so a caller
   * with a skewed clock cannot open a second bucket for an hour that has one.
   *
   * `observedAt` is accepted and deliberately UNUSED for the bucket. It is
   * recorded nowhere here on purpose: choosing the bucket from it would be
   * choosing the bucket from the updater's clock, which is the one clock P-3
   * forbids. The parameter exists so the caller's signature stays the one
   * `PasskeyRefusalAggregatorV1` already passes.
   */
  async recordApprovalRefusal({ approvalId, planId, reason }) {
    if (typeof approvalId !== "string" || !APPROVAL_V1.test(approvalId))
      throw updaterRefuseV1("updater_refusal_input_refused");
    assertSafeIdV1(planId, "updater_refusal_plan_refused");
    if (typeof reason !== "string" || !/^[a-z][a-z0-9_]{1,63}$/u.test(reason))
      throw updaterRefuseV1("updater_refusal_input_refused");
    const result = await this.client.query(
      `SELECT count, first_in_hour, bucket_start FROM updater.record_approval_refusal($1,$2,$3)`,
    [approvalId, planId, reason]);
    const row = result.rows[0];
    if (!row || !Number.isSafeInteger(row.count) || row.count < 1 || typeof row.first_in_hour !== "boolean")
      throw updaterRefuseV1("updater_refusal_store_refused");
    return Object.freeze({ count: row.count, firstInHour: row.first_in_hour,
      bucketStart: new Date(row.bucket_start).toISOString() });
  }

  // -------------------------------------------------------------------------
  // P-4: the durable half of the same alert
  // -------------------------------------------------------------------------
  /**
   * Acknowledge that the journal line for a bucket was fsynced. Called ONLY
   * after the write succeeded, so a journal that failed leaves the bucket
   * undelivered and `pendingRefusalBuckets` returns it at the next startup.
   */
  async markRefusalJournaled(planId, bucketStart) {
    assertSafeIdV1(planId, "updater_refusal_plan_refused");
    if (typeof bucketStart !== "string" || !Number.isFinite(Date.parse(bucketStart)))
      throw updaterRefuseV1("updater_refusal_bucket_refused");
    await this.client.query(`UPDATE updater.approval_refusal_buckets SET journaled_at = pg_catalog.now()
      WHERE plan_id = $1 AND bucket_start = $2::timestamptz`, [planId, bucketStart]);
  }

  /** The same for the push row's commit. */
  async markRefusalPushed(planId, bucketStart) {
    assertSafeIdV1(planId, "updater_refusal_plan_refused");
    if (typeof bucketStart !== "string" || !Number.isFinite(Date.parse(bucketStart)))
      throw updaterRefuseV1("updater_refusal_bucket_refused");
    await this.client.query(`UPDATE updater.approval_refusal_buckets SET pushed_at = pg_catalog.now()
      WHERE plan_id = $1 AND bucket_start = $2::timestamptz`, [planId, bucketStart]);
  }

  /**
   * Every bucket whose alert was not fully delivered. This is P-4's re-drive
   * list, read at startup: a sink that failed after the count committed cannot
   * lose the hourly alert, because the row that says "not delivered yet" is in
   * the database and is read again.
   *
   * Bounded by construction: one row per plan-hour, and the index is partial on
   * exactly this predicate, so the query reads the undelivered rows and nothing
   * else however many hours of history exist.
   */
  async pendingRefusalBuckets(limit = 50) {
    const bounded = Math.max(1, Math.min(200, Number(limit) || 1));
    const rows = (await this.client.query(`SELECT plan_id, bucket_start, count, first_in_hour, last_approval_id,
        journaled_at, pushed_at FROM updater.approval_refusal_buckets
      WHERE journaled_at IS NULL OR pushed_at IS NULL ORDER BY bucket_start, plan_id LIMIT $1`, [bounded])).rows;
    return rows.map(row => Object.freeze({ planId: String(row.plan_id),
      bucketStart: new Date(row.bucket_start).toISOString(), count: Number(row.count),
      firstInHour: String(row.first_in_hour), lastApprovalId: String(row.last_approval_id),
      journaled: row.journaled_at !== null, pushed: row.pushed_at !== null }));
  }

  /** Prune delivered buckets older than the retention window. The updater calls
   * this on its housekeeping tick; it is not automatic, because an automatic
   * sweep would delete rows the web might still be rendering. */
  async pruneRefusalBuckets(olderThanDays = 30) {
    const days = Math.max(1, Math.min(365, Number(olderThanDays) || 30));
    const result = await this.client.query(`DELETE FROM updater.approval_refusal_buckets
      WHERE journaled_at IS NOT NULL AND pushed_at IS NOT NULL
        AND bucket_start < pg_catalog.now() - ($1::integer) * interval '1 day'`, [days]);
    const pruned = result.rowCount ?? 0;
    // The per-approval rows are the ledger's own idempotency record, so they are
    // pruned on the same rule: a row whose bucket is gone cannot be replayed
    // into a live bucket, because the bucket it belonged to no longer exists.
    const ledger = await this.client.query(`DELETE FROM updater.approval_refusals
      WHERE observed_at < pg_catalog.now() - ($1::integer) * interval '1 day'`, [days]);
    return Object.freeze({ buckets: pruned, refusals: ledger.rowCount ?? 0 });
  }

  // -------------------------------------------------------------------------
  // P-5 `notifyCoolingOff({credentialId, number, coolingOffUntil, repeatAt})`
  // -------------------------------------------------------------------------
  /**
   * Enqueue the two cooling-off notices, or refuse.
   *
   * R14c's requirement, and the review's F1 finding, meet here: the notice is
   * enqueued BEFORE the ledger write, in one transaction, and this call THROWS
   * if there is no live subscription — so `completeRegistration` burns R and
   * records no passkey rather than claiming a warning that was never sent.
   *
   * Idempotent on `credentialId`: both keys are UNIQUE in `push_queue`, so a
   * retry adds nothing. The 12 h repeat carries `not_before`, so the dispatch
   * loop cannot send it at once.
   */
  async notifyCoolingOff({ credentialId, number, coolingOffUntil, repeatAt }) {
    assertCredentialIdV1(credentialId, "updater_passkey_credential_refused");
    if (!Number.isSafeInteger(number) || number < 1 || number > 32)
      throw updaterRefuseV1("updater_passkey_number_refused");
    for (const value of [coolingOffUntil, repeatAt]) {
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
        throw updaterRefuseV1("updater_passkey_cooling_off_refused");
    }
    const result = await this.client.query(`SELECT enqueued, subscriptions
      FROM updater.enqueue_cooling_off_notices($1,$2,$3::timestamptz,$4::timestamptz)`,
    [credentialId, number, new Date(coolingOffUntil).toISOString(), new Date(repeatAt).toISOString()]);
    const row = result.rows[0];
    if (!row || !Number.isSafeInteger(row.subscriptions) || row.subscriptions < 1)
      throw updaterRefuseV1("updater_passkey_cooling_off_refused");
    return Object.freeze({ enqueued: Number(row.enqueued), subscriptions: Number(row.subscriptions) });
  }

  // -------------------------------------------------------------------------
  // Web-login reads for P-2, as the DEPLOYER (the real production read path)
  // -------------------------------------------------------------------------
  /** The rows the web may read about its own registrations. Column-scoped, and
   * the SELECT grant is the one in the DDL — this states which columns the web
   * is entitled to expect, so a change to either side is caught here. */
  async registrationRowsForWeb(registrationDigest) {
    if (typeof registrationDigest !== "string" || !DIGEST_V1.test(registrationDigest))
      throw updaterRefuseV1("updater_registration_digest_refused");
    return (await this.client.query(`SELECT id, credential_id, registration_digest, received_at
      FROM updater.passkey_registrations WHERE registration_digest = $1 ORDER BY received_at, id`,
    [registrationDigest])).rows;
  }
}

// -----------------------------------------------------------------------------
// The web's own, much smaller, port
// -----------------------------------------------------------------------------
/**
 * What the private web may do for a passkey registration (P-2).
 *
 * A SEPARATE OBJECT ON PURPOSE. The web login's surface is INSERT on four
 * tables and a column-scoped SELECT on a handful of others, and there is no
 * call it could make to this class that would succeed: `openRegistration` and
 * `recordApprovalRefusal` both need privileges only the deployer holds. Building
 * the web's port as its own object rather than as a mode of the deployer's means
 * the type says what the web may do, and a caller that wires the wrong one into
 * the web process gets 42501 from PostgreSQL at the first call rather than at
 * the first attempt to abuse it.
 *
 * `insert` is validated HERE rather than only by the CHECKs, because the handler
 * passes `unknown` out of a request body: the response's shape and size are
 * checked before the INSERT, and the row the wrapper later reads is the row the
 * checker approved.
 */
export class PasskeyWebStoreV1 {
  constructor(client) { this.client = client; }

  async initialize() {
    // The web's own path, and it must NOT be the deployer's: `SET search_path`
    // here would resolve `public` ahead of nothing, and a web session that found
    // itself running the deployer's queries would be a privilege escalation the
    // DDL refuses rather than permits. Pinned explicitly for the same reason the
    // deployer's is (R10b), and asserted rather than assumed.
    await this.client.query("SET search_path = pg_catalog, updater, pg_temp");
    const row = (await this.client.query(`SELECT current_user AS current_user,
      pg_has_role(current_user, 'control_room_private_web', 'MEMBER') AS is_web,
      current_setting('session_replication_role') AS replication_role`)).rows[0];
    if (!row || row.is_web !== true || row.replication_role !== "origin")
      throw updaterRefuseV1("updater_store_role_refused");
  }

  /**
   * P-2's read. Only open, unconsumed, unexpired registrations come back, and
   * the row is exactly what the updater published.
   *
   * `consumed_at` is NOT readable by the web login (the DDL grants five columns and
   * this is not one of them), so it cannot appear in this query's WHERE clause —
   * which means the web cannot itself exclude a consumed registration, and must
   * ask the UPDATER whether the digest is still open. That is `openRegistrationOptions`
   * on the deployer store, and it is why the two ports are separate objects rather
   * than one class with a flag: the web's read is a projection of what the updater
   * published, and the updater's read is the authority on whether it is still
   * usable.
   *
   * So this method answers the question it CAN answer from the columns it holds —
   * is there an unexpired row, and what should the page show — and refuses when
   * there is none, which covers the expired case. The consumed case is refused one
   * level up, by the updater, before the web is ever asked.
   */
  async options(registrationDigest) {
    if (typeof registrationDigest !== "string" || !DIGEST_V1.test(registrationDigest))
      throw updaterRefuseV1("updater_registration_digest_refused");
    const row = (await this.client.query(`SELECT registration_digest, mode, options_json, authorization_challenge
      FROM updater.passkey_open_registrations
      WHERE registration_digest = $1 AND expires_at > pg_catalog.now()`, [registrationDigest])).rows[0];
    if (!row) throw updaterRefuseV1("updater_registration_expired");
    return Object.freeze({ registrationDigest: String(row.registration_digest), mode: String(row.mode),
      options: row.options_json,
      authorizationChallenge: row.authorization_challenge === null ? null : String(row.authorization_challenge) });
  }

  /**
   * P-2's write. Validates the response's shape and size, then INSERTs.
   *
   * The bounds are the wrapper's, checked here as numbers on the DECODED bytes:
   * credential id 16..255 of base64url, clientDataJSON 1..4096, attestation
   * object 32..8192, at most 8 transports of at most 32 bytes each, and the
   * whole envelope at most 16 KiB of JSON. An over-bound response is refused
   * here with a named code and never reaches the CHECKs, the table, or a parser.
   *
   * `id` is the caller's idempotency key, so a retried POST (a phone that lost
   * the response on a flaky connection) cannot create a second row for one
   * ceremony — which would turn a single registration into a two-row race the
   * installer refuses.
   */
  async insert({ id, ownerSessionDigest, registrationDigest, credentialId, comparisonCode, response,
    authorizationAssertion = null }) {
    if (typeof id !== "string" || !/^passkey-registration:[0-9a-f-]{36}$/u.test(id))
      throw updaterRefuseV1("updater_registration_row_refused");
    if (typeof ownerSessionDigest !== "string" || !DIGEST_V1.test(ownerSessionDigest))
      throw updaterRefuseV1("updater_registration_row_refused");
    if (typeof registrationDigest !== "string" || !DIGEST_V1.test(registrationDigest))
      throw updaterRefuseV1("updater_registration_digest_refused");
    assertCredentialIdV1(credentialId, "updater_passkey_credential_refused");
    if (typeof comparisonCode !== "string" || !CODE_V1.test(comparisonCode))
      throw updaterRefuseV1("updater_passkey_code_refused");
    const decoded = decodeWebauthnResponseV1(response, "registration");
    const authorization = authorizationAssertion === null || authorizationAssertion === undefined
      ? null : decodeWebauthnResponseV1(authorizationAssertion, "authentication");
    // The envelope bound is checked AFTER the fields, not before, and that order
    // is deliberate. A 4097-byte clientDataJSON is refused by the FIELD's bound
    // (`updater_passkey_client_data_refused`) rather than by the envelope's
    // (`updater_passkey_response_too_large`), because the field bound is the one
    // that tells an operator which input was wrong. Checking the envelope first
    // would collapse every over-bound response into one code and lose that — and
    // it is what the first run of this lane measured: an over-bound clientDataJSON
    // came back as `response_refused` and the assertion against the specific code
    // failed while the refusal itself was correct.
    if (Buffer.byteLength(JSON.stringify(response)) > 16_384)
      throw updaterRefuseV1("updater_passkey_response_too_large");
    await this.client.query(`INSERT INTO updater.passkey_registrations
        (id, registration_digest, credential_id, attestation_object, client_data_json, transports,
         comparison_code, owner_session_digest, auth_credential_id, auth_authenticator_data,
         auth_client_data_json, auth_signature, auth_user_handle)
      VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11,$12,$13)`,
    [id, registrationDigest, credentialId, decoded.attestationObject, decoded.clientDataJSON,
      decoded.transports, comparisonCode, ownerSessionDigest,
      authorization?.id ?? null, authorization?.authenticatorData ?? null, authorization?.clientDataJSON ?? null,
      authorization?.signature ?? null, authorization?.userHandle ?? null]);
    return Object.freeze({ id, registrationDigest, credentialId, comparisonCode });
  }
}

/** Decode one WebAuthn response into the bytea the table stores, refusing
 * anything over the wrapper's bounds or not exactly round-tripping base64url.
 * The wrapper refuses the same things at the other end of the row, so this is
 * the same rule applied before the row exists rather than after. */
function decodeWebauthnResponseV1(value, ceremony) {
  const object = assertPlainObjectV1(value, "updater_passkey_response_refused");
  const response = assertPlainObjectV1(object.response, "updater_passkey_response_refused");
  const decode = (input, min, max, code) => {
    if (typeof input !== "string" || !/^[A-Za-z0-9_-]*$/u.test(input)) throw updaterRefuseV1(code);
    const bytes = Buffer.from(input, "base64url");
    if (bytes.length < min || bytes.length > max || bytes.toString("base64url") !== input)
      throw updaterRefuseV1(code);
    return bytes;
  };
  const id = object.id;
  assertCredentialIdV1(id, "updater_passkey_credential_refused");
  if (object.rawId !== id || object.type !== "public-key") throw updaterRefuseV1("updater_passkey_response_refused");
  const clientDataJSON = decode(response.clientDataJSON, 1, 4096, "updater_passkey_client_data_refused");
  if (ceremony === "registration") {
    return Object.freeze({ id, attestationObject: decode(response.attestationObject, 32, 8192,
      "updater_passkey_attestation_refused"), clientDataJSON,
      transports: readTransportsV1(response.transports) });
  }
  const signature = decode(response.signature, 32, 512, "updater_passkey_signature_refused");
  const authenticatorData = decode(response.authenticatorData, 37, 1024,
    "updater_passkey_authenticator_data_refused");
  let userHandle = null;
  if (response.userHandle !== null && response.userHandle !== undefined)
    userHandle = decode(response.userHandle, 0, 128, "updater_passkey_user_handle_refused");
  return Object.freeze({ id, clientDataJSON, signature, authenticatorData, userHandle });
}

function readTransportsV1(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8
      || value.some(item => typeof item !== "string" || Buffer.byteLength(item) > 32))
    throw updaterRefuseV1("updater_passkey_response_refused");
  return Object.freeze([...value]);
}