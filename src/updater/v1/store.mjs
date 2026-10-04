import { assertPlainObjectV1, assertSafeIdV1, SAFE_STEP_V1, updaterRefuseV1 } from "./contracts.mjs";
import { updaterPushBodyV1 } from "./alerts.mjs";

const RUN_STATES_V1 = new Set(["approved", "prechecked", "staged", "quick_backup", "draining", "quiesced",
  "backup_verified", "preimage_taken", "migrating", "migrated", "switched", "restarted", "healthy",
  "succeeded", "rollback_started", "restore_started", "db_restored", "code_restored", "rolled_back",
  "needs_attention", "uncertain", "attended_upgrade_required", "refused"]);
const UPDATER_LEASE_LOCK_V1 = Object.freeze([1128354389, 1431323730]);
const OPEN_PLAN_STATES_V1 = Object.freeze(["building", "ready_for_approval", "approved", "approval_required"]);
/** R7U-01: the run states whose OUTCOME is the owner's published state, plus the
 * one that clears it. The same set as the CHECK on
 * `updater.owner_run_attention.state`, stated here so a caller is refused at the
 * store boundary with a readable code rather than by a `22023` from SQL that
 * knows nothing about this product's error vocabulary. */
const RUN_ATTENTION_STATES_V1 = new Set(["needs_attention", "uncertain", "attended_upgrade_required",
  "refused", "rolled_back", "succeeded"]);
/** R7U-01 (lead decision 2): a runner ERROR, which is the one value here that is
 * not a run state. The updater failing while working on a run is a fact about
 * the updater, and the run row says whatever state that run was last in — so it
 * is recorded against the run that was live, and it is raised and cleared the
 * same way every other outstanding outcome is. Deliberately separate from the set
 * above: the SQL function treats it differently (the run must be OPEN rather than
 * IN that state) and conflating the two here would hide that. */
const RUN_ATTENTION_ERROR_STATE_V1 = "error";

/** A claim token's alphabet, byte for byte the CHECK in 0004_push_claims.sql.
 *
 * It is duplicated here rather than left to the database so a caller that
 * passes something which is not a token gets the named refusal at the store
 * boundary — with a readable code — instead of a `22023` from a SQL function
 * that knows nothing about this product's error vocabulary. The database CHECK
 * is still the authority; this is the first of the two walls, not the only. */
const CLAIM_TOKEN_V1 = /^claim:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function assertClaimTokenV1(token) {
  if (typeof token !== "string" || !CLAIM_TOKEN_V1.test(token))
    throw updaterRefuseV1("updater_push_claim_token_refused");
  return token;
}

/** Typed adapter over item 7's fixed updater schema. The client is the
 * production peer-authenticated control_room_deployer login. */
export class PostgresUpdaterStoreV1 {
  #leaseHeld = false;
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

  /** @param {{bootId:string,leaseToken:string,state:string,step?:string|null}} input */
  async heartbeat(input) {
    const { bootId, leaseToken, state, step = null } = input;
    assertSafeIdV1(bootId); assertSafeIdV1(leaseToken);
    if (step !== null && (typeof step !== "string" || !SAFE_STEP_V1.test(step)))
      throw updaterRefuseV1("updater_heartbeat_step_refused");
    await this.client.query(`UPDATE updater.heartbeat SET boot_id=$1,lease_token=$2,reported_state=$3,
      heartbeat_at=pg_catalog.now(),step=$4 WHERE singleton=true`, [bootId, leaseToken, state, step]);
  }

  async liveRun() {
    const result = await this.client.query(`SELECT run_id,plan_id,state,run_class,lease_token,started_at,detail
      FROM updater.runs WHERE finished_at IS NULL ORDER BY started_at,run_id LIMIT 2`);
    if (result.rows.length > 1) throw updaterRefuseV1("updater_multiple_live_runs");
    return result.rows[0];
  }

  /** Hold the singleton updater lease for this PostgreSQL session. A fresh
   * process may reuse a live run's durable token only after the old session's
   * advisory lock has disappeared; the token itself is never rewritten. */
  async acquire(requestedLeaseToken) {
    assertSafeIdV1(requestedLeaseToken);
    if (!this.#leaseHeld) {
      const result = await this.client.query(`SELECT pg_catalog.pg_try_advisory_lock($1::integer,$2::integer)
        AS acquired`, UPDATER_LEASE_LOCK_V1);
      if (result.rows[0]?.acquired !== true)
        return Object.freeze({ status: "busy", run: await this.liveRun() });
      this.#leaseHeld = true;
    }
    const run = await this.liveRun();
    return Object.freeze({ status: "acquired", run,
      leaseToken: run?.lease_token ?? requestedLeaseToken,
      resumed: Boolean(run && run.lease_token !== requestedLeaseToken) });
  }

  async release() {
    if (!this.#leaseHeld) return;
    await this.client.query(`SELECT pg_catalog.pg_advisory_unlock($1::integer,$2::integer)`,
      UPDATER_LEASE_LOCK_V1);
    this.#leaseHeld = false;
  }

  /** B4: the run row and its journal mirror move in ONE statement.
   *
   * `updater.record_run_step` does both inside a single PostgreSQL statement,
   * which commits or rolls back as a unit. The two-statement form this replaced
   * had a window between the row's move and its event, and a kill in that window
   * left the run wedged at the new state with no way forward: `guard_run_state`
   * refuses any later non-terminal move whose last event disagrees with the row,
   * so at `switched` the updater could not restart, roll back, or be measured.
   *
   * The lease token is re-checked INSIDE the statement, so ownership and the move
   * are one fact rather than a read followed by a write. A caller without the
   * token gets `42501 updater run lease lost`, which is what the previous
   * `updater_run_lease_lost` refusal meant. The code is kept distinct so the
   * failure is still identifiable at the call site.
   *
   * A terminal step writes no mirror row (the insert guard requires an unfinished
   * run), and the function derives the ordinal from the run's own last event, so
   * this method no longer needs an ordinal from the caller. */
  async transition(runId, leaseToken, state, detail = {}, { terminal = false } = {}) {
    assertSafeIdV1(leaseToken);
    if (typeof runId !== "string" || !/^run:[0-9a-f-]{36}$/u.test(runId) || !RUN_STATES_V1.has(state))
      throw updaterRefuseV1("updater_transition_refused");
    let result;
    try {
      result = await this.client.query(`SELECT pg_catalog.to_jsonb(m) AS run FROM updater.record_run_step($1,$2,$3,$4::jsonb,$5) m`,
        [runId, leaseToken, state, JSON.stringify(detail), terminal]);
    } catch (error) {
      if (error?.code === "42501" && String(error?.message ?? "").includes("updater run lease lost"))
        throw updaterRefuseV1("updater_run_lease_lost");
      throw error;
    }
    const row = result.rows[0]?.run;
    if (!row || typeof row !== "object") throw updaterRefuseV1("updater_run_lease_lost");
    return row;
  }

  async events(runId) {
    if (typeof runId !== "string" || !/^run:[0-9a-f-]{36}$/u.test(runId))
      throw updaterRefuseV1("updater_event_refused");
    // run_events.ordinal is bigint: node-pg returns int8 as a string, and `"1" + 1` is "11".
    // Convert here, and refuse anything that is not a safe integer, so callers only ever see numbers.
    return (await this.client.query(`SELECT ordinal,state,detail,recorded_at FROM updater.run_events
      WHERE run_id=$1 ORDER BY ordinal`, [runId])).rows.map(row => {
      const ordinal = typeof row.ordinal === "string" && /^[1-9][0-9]{0,15}$/u.test(row.ordinal) ? Number(row.ordinal) : row.ordinal;
      if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw updaterRefuseV1("updater_event_refused");
      return { ...row, ordinal };
    });
  }

  async unhandledOwnerRequests(limit = 50) {
    const bounded = Math.max(1, Math.min(50, Number(limit) || 1));
    return (await this.client.query(`SELECT id,request_kind,requires_passkey,approval_id,detail,requested_at
      FROM updater.owner_requests WHERE handled_at IS NULL ORDER BY requested_at,id LIMIT $1`, [bounded])).rows;
  }

  /** R7U-01 (lead decision 3): the owner's button, as a durable request row.
   *
   * The WEB LOGIN holds INSERT on this table and no UPDATE, so this is the only
   * way the owner can ask the updater to do anything — and the request row is what
   * makes the answer survive a restart of either side. A press that arrives while
   * the updater is restarting is still answered on its next tick rather than
   * dropped, which a direct call to the store from a web request could not
   * promise.
   *
   * `ownerSessionDigest` is the caller's already-computed digest, never the
   * session token: the column is a digest and the table's CHECK says so, and the
   * updater only ever sees the digest. The subject travels in `detail` because
   * the acknowledgement row records WHO answered, and the digest cannot be
   * inverted back into a subject.
   */
  async requestAttentionAcknowledgement(ownerSessionDigest, { ownerSubject } = {}) {
    if (typeof ownerSessionDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(ownerSessionDigest)
        || typeof ownerSubject !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/u.test(ownerSubject))
      throw updaterRefuseV1("updater_owner_attention_identity_refused");
    const result = await this.client.query(`INSERT INTO updater.owner_requests
      (id, request_kind, requires_passkey, approval_id, detail, owner_session_digest)
      VALUES ('owner-request:' || gen_random_uuid()::text, 'acknowledge_attention', false, NULL,
        jsonb_build_object('ownerSubject', $2::text), $1::text)
      RETURNING id, requested_at`,
      [ownerSessionDigest, ownerSubject]);
    const row = result.rows[0];
    if (!row || typeof row.id !== "string") throw updaterRefuseV1("updater_owner_request_refused");
    return Object.freeze({ id: row.id, requestedAt: row.requested_at });
  }

  async finishOwnerRequest(id, outcome) {
    if (!/^owner-request:[0-9a-f-]{36}$/u.test(id) || !["acted", "refused", "ignored"].includes(outcome))
      throw updaterRefuseV1("updater_owner_request_refused");
    const result = await this.client.query(`UPDATE updater.owner_requests SET handled_at=pg_catalog.now(),
      handled_outcome=$2 WHERE id=$1 AND handled_at IS NULL RETURNING id`, [id, outcome]);
    return result.rows.length === 1;
  }

  /** Item 17 plan port. The transaction uses the same DB lock as the schema
   * trigger so two updater processes cannot manufacture two open plans. */
  async openPlan() {
    const result = await this.client.query(`SELECT plan_id,state,plan_json,plan_digest FROM updater.plans
      WHERE state = ANY($1::text[]) ORDER BY created_at,plan_id LIMIT 2`, [OPEN_PLAN_STATES_V1]);
    if (result.rows.length > 1) throw updaterRefuseV1("updater_multiple_open_plans");
    const row = result.rows[0];
    return row ? { planId: row.plan_id, state: row.state, plan: row.plan_json, planDigest: row.plan_digest } : null;
  }

  async databaseNow() {
    const row = (await this.client.query("SELECT pg_catalog.now() AS now")).rows[0];
    const value = row?.now instanceof Date ? row.now : new Date(row?.now);
    if (!Number.isFinite(value.getTime())) throw updaterRefuseV1("updater_database_time_refused");
    return value;
  }

  async replaceOpenPlan(input) {
    const value = assertPlainObjectV1(input, "updater_plan_refused"), plan = assertPlainObjectV1(value.plan, "updater_plan_refused");
    assertSafeIdV1(plan.planId, "updater_plan_refused"); assertSafeIdV1(plan.installationId, "updater_plan_refused");
    if (plan.schema !== "control-room.install-plan/v2" || !["code", "database", "updater"].includes(plan.kind)
        || typeof value.planDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.planDigest))
      throw updaterRefuseV1("updater_plan_refused");
    if (value.expectedOpenPlanId !== null && value.expectedOpenPlanId !== undefined)
      assertSafeIdV1(value.expectedOpenPlanId, "updater_plan_refused");
    await this.client.query("BEGIN");
    try {
      await this.client.query(`SELECT pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('updater:open-plan', 0))`);
      const current = await this.client.query(`SELECT plan_id,state,plan_json,plan_digest FROM updater.plans
        WHERE state = ANY($1::text[]) ORDER BY created_at,plan_id LIMIT 2 FOR UPDATE`, [OPEN_PLAN_STATES_V1]);
      if (current.rows.length > 1) throw updaterRefuseV1("updater_multiple_open_plans");
      const existing = current.rows[0];
      if ((existing?.plan_id ?? null) !== (value.expectedOpenPlanId ?? null)) {
        await this.client.query("COMMIT");
        return existing ? { status: "raced", plan: existing.plan_json, planId: existing.plan_id, planDigest: existing.plan_digest }
          : { status: "raced", plan: null };
      }
      if (existing?.plan_json?.candidate?.commit === plan.candidate?.commit) {
        await this.client.query("COMMIT");
        return { status: "existing", plan: existing.plan_json, planId: existing.plan_id, planDigest: existing.plan_digest };
      }
      if (existing) await this.client.query(`UPDATE updater.plans SET state='superseded',superseded_by_plan_id=$1
        WHERE plan_id=$2`, [plan.planId, existing.plan_id]);
      await this.client.query(`INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,changes_database,
        changes_updater,plan_digest,plan_json,needs_mac_confirm,expires_at) VALUES($1,$2,$3,'building',$4,$5,$6,$7,$8::jsonb,$9,
        pg_catalog.now() + interval '72 hours')`, [plan.planId, plan.installationId, plan.kind, plan.updaterDerived.classes,
        plan.updaterDerived.changesDatabase, plan.updaterDerived.changesUpdater, value.planDigest, JSON.stringify(plan),
        plan.kind === "updater"]);
      await this.client.query("COMMIT");
      return { status: "created", plan, planId: plan.planId, planDigest: value.planDigest };
    } catch (error) { await this.client.query("ROLLBACK").catch(() => {}); throw error; }
  }

  /** Item 21 alert port: the owner's live push subscriptions. */
  async subscriptions() {
    return (await this.client.query(`SELECT id,endpoint,p256dh,auth,expires_at FROM public.owner_web_push_subscriptions
      WHERE expires_at IS NULL OR expires_at > pg_catalog.now() ORDER BY tenant_id,id LIMIT 100`)).rows;
  }

  async pending(limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw updaterRefuseV1("updater_push_limit_refused");
    // U06: `not_before` is the row's DUE TIME, and both halves of the scheduler
    // have to honour it. Selection returning a row that is not yet due means
    // the 12-hour passkey repeat is pushed twelve hours early — the requirement
    // is that the owner is told AGAIN at 12 h, and a first-and-only push at
    // queue time is not that. The comparison is one-sided so a NULL (send at
    // once, every ordinary warning) is always sendable.
    //
    // `not_before IS NULL OR not_before <= now()` is evaluated by the DATABASE
    // clock, not the sender's injected one, so a host with a wrong clock cannot
    // either send a scheduled notice early or hold it forever.
    return (await this.client.query(`SELECT id,template,title,body,link_path,attempts FROM updater.push_queue
      WHERE sent_at IS NULL AND attempts < 10 AND coalesce(last_error_code,'') <> 'updater_push_reserved'
        AND (not_before IS NULL OR not_before <= pg_catalog.now())
      ORDER BY queued_at,id LIMIT $1`, [limit])).rows;
  }

  /** Claim one row, enforcing the same due-time rule `pending()` selected on.
   *
   * U06: a row that is not yet due is NOT claimable even if a caller asks for
   * it by id. Without this, selection would be the only thing standing between
   * a scheduled notice and an early send, and the sender is exactly the caller
   * that already holds every row's id. The claim is the exclusive one — it is
   * the statement that spends the attempt — so the due time is re-checked here,
   * and it returns false rather than throwing: "not due yet" is an ordinary
   * outcome for the caller, not an error.
   *
   * U02/U03/U07: the claim carries a fencing TOKEN and a deadline rather than
   * only the `updater_push_reserved` flag, so a reservation is attributable
   * and its liveness is one value. `claimToken` is this store instance's
   * identity: every process that claims gets its own, and a settle is refused
   * unless it presents the token that took the row. A dead process's claim
   * therefore expires and is recoverable, and a live one cannot be stolen.
   *
   * `claim_hold_seconds` is the deadline for the WHOLE attempt. It is a
   * parameter rather than a constant because the sender knows how long its own
   * fan-out can take, and a deadline that is a guess in the database would be
   * either too short (stealing a live send) or too long (a dead row invisible
   * for too long).
   *
   * @param {string} id
   * @param {{claimToken?: string|null, claimHoldSeconds?: number|null}} [options] */
  async begin(id, { claimToken = null, claimHoldSeconds = null } = {}) {
    if (!/^push:[0-9a-f-]{36}$/u.test(id)) throw updaterRefuseV1("updater_push_id_refused");
    // A caller that wants no claim ownership keeps the OLD single-argument
    // behaviour, which is the pre-existing `updater_push_reserved` reservation
    // and is what the offline sender fixtures exercise. It is not silent: the
    // caller that takes this path has no token, so it cannot settle through
    // `settleClaim`, and must use `finish()`. Production composition always
    // passes a token (see the default in UpdaterAlertSenderV1).
    if (claimToken === null) {
      return (await this.client.query(`UPDATE updater.push_queue SET attempts=attempts+1,last_error_code='updater_push_reserved'
        WHERE id=$1 AND sent_at IS NULL AND attempts < 10 AND coalesce(last_error_code,'') <> 'updater_push_reserved'
          AND (not_before IS NULL OR not_before <= pg_catalog.now())
        RETURNING id,attempts`, [id])).rows.length === 1;
    }
    assertClaimTokenV1(claimToken);
    if (!Number.isSafeInteger(claimHoldSeconds) || claimHoldSeconds < 5 || claimHoldSeconds > 3600)
      throw updaterRefuseV1("updater_push_claim_hold_refused");
    return (await this.client.query("SELECT updater.claim_push($1,$2,$3::integer) AS claimed",
      [id, claimToken, claimHoldSeconds])).rows[0]?.claimed === true;
  }

  /** Push a held claim's deadline out, mid-attempt. Returns false when this
   * store no longer owns the row (a recovery took it over), so a sender that
   * has been slow enough to lose the row stops rather than sends on top of a
   * dispatcher that now owns it.
   *
   * @param {string} id
   * @param {string} claimToken
   * @param {number} claimHoldSeconds */

  async renewClaim(id, claimToken, claimHoldSeconds) {
    if (!/^push:[0-9a-f-]{36}$/u.test(id)) throw updaterRefuseV1("updater_push_id_refused");
    assertClaimTokenV1(claimToken);
    if (!Number.isSafeInteger(claimHoldSeconds) || claimHoldSeconds < 5 || claimHoldSeconds > 3600)
      throw updaterRefuseV1("updater_push_claim_hold_refused");
    return (await this.client.query("SELECT updater.renew_push_claim($1,$2,$3::integer) AS renewed",
      [id, claimToken, claimHoldSeconds])).rows[0]?.renewed === true;
  }

  /** Settle a row this store still holds. Returns false when the claim is no
   * longer ours — which is a DELIVERY THAT MUST NOT BE REPORTED, not an error
   * to swallow: the row now belongs to another dispatcher.
   *
   * @param {string} id
   * @param {string} claimToken
   * @param {{sent: boolean, errorCode?: string|null}} options */

  async settleClaim(id, claimToken, { sent, errorCode = null } = {}) {
    if (!/^push:[0-9a-f-]{36}$/u.test(id) || typeof sent !== "boolean"
      || errorCode !== null && (typeof errorCode !== "string" || !/^[a-z][a-z0-9_]{1,63}$/u.test(errorCode)))
      throw updaterRefuseV1("updater_push_finish_refused");
    assertClaimTokenV1(claimToken);
    return (await this.client.query("SELECT updater.settle_push_claim($1,$2,$3::boolean,$4::text) AS settled",
      [id, claimToken, sent, errorCode])).rows[0]?.settled === true;
  }

  /** Sweep claims whose deadline has passed. A row with budget left is
   * RELEASED and becomes claimable again; a row at its attempt bound becomes
   * an explicit terminal `updater_push_claim_expired` rather than staying
   * reserved forever (U03). Called once per tick by the sender. */
  async recoverExpiredClaims(limit = 64) {
    const bounded = Math.max(1, Math.min(512, Number(limit) || 1));
    return (await this.client.query(
      "SELECT id,outcome FROM updater.recover_expired_push_claims($1::integer) ORDER BY id", [bounded])).rows;
  }

  async finish(id, { sent, errorCode = null } = {}) {
    if (!/^push:[0-9a-f-]{36}$/u.test(id) || typeof sent !== "boolean"
      || errorCode !== null && (typeof errorCode !== "string" || !/^[a-z][a-z0-9_]{1,63}$/u.test(errorCode)))
      throw updaterRefuseV1("updater_push_finish_refused");
    await this.client.query(`UPDATE updater.push_queue SET sent_at=CASE WHEN $2::boolean THEN pg_catalog.now() ELSE NULL END,
      last_error_code=$3 WHERE id=$1 AND sent_at IS NULL`, [id, sent, errorCode]);
  }

  async queue(template) {
    if (typeof template !== "string" || !/^control-room-updater\.[a-z-]{3,63}$/u.test(template))
      throw updaterRefuseV1("updater_push_template_refused");
    // `push_queue.body` is NOT NULL and CHECKed to 1..400 characters, so a
    // queued row has to carry the fixed text it will be sent with. An empty
    // body was refused by the real cluster on the first run of the alert lane
    // ("new row ... violates check constraint push_queue_body_check"), which
    // would have meant no alert could ever be queued. The text is the SAME
    // fixed template the sender renders, not a second copy of it: the title and
    // body are what the owner's phone shows if a row is ever read outside the
    // sender, and the sender's payload is still built from the template id.
    const text = updaterPushBodyV1(template);
    await this.client.query(`INSERT INTO updater.push_queue(id,template,title,body,link_path)
      VALUES($1,$2,'Control Room updater',$3, '/needs-me')`,
    [`push:${globalThis.crypto.randomUUID()}`, template, text]);
  }

  // -------------------------------------------------------------------------
  // R7U-01: the owner's durable answer about a run's outcome.
  // -------------------------------------------------------------------------

  /** The one run outcome the owner has not answered yet, or null.
   *
   * R7U-01: this is the SOURCE of the owner-visible state, and it is the
   * DATABASE rather than a cached name. `needs_attention`, `uncertain` and
   * `refused` are terminal run states, so the run sets `finished_at` and leaves
   * `liveRun()`'s `WHERE finished_at IS NULL` result set — which is why an
   * in-memory two-name cache could keep `refused` and `rolled_back` alive and
   * nothing else. This row answers the question the run row cannot: which run
   * left the installation needing the owner, and whether they have said so.
   *
   * It returns the raw columns and nothing derived, so the caller cannot read a
   * reason out of a field this store did not write. @returns {Promise<null|
   * {runId:string,state:string,code:string|null,lastObservedAt:Date}>} */
  async openRunAttention() {
    const result = await this.client.query("SELECT run_id,state,code,last_observed_at FROM updater.open_run_attention");
    const row = result.rows[0];
    if (!row) return null;
    if (typeof row.run_id !== "string" || typeof row.state !== "string"
        || row.code !== null && typeof row.code !== "string")
      throw updaterRefuseV1("updater_run_attention_refused");
    const lastObservedAt = row.last_observed_at instanceof Date ? row.last_observed_at : new Date(row.last_observed_at);
    if (!Number.isFinite(lastObservedAt.getTime())) throw updaterRefuseV1("updater_run_attention_refused");
    return Object.freeze({ runId: row.run_id, state: row.state, code: row.code ?? null,
      lastObservedAt });
  }

  /** Record that this run's terminal outcome is the published state.
   *
   * The updater's own write, and the reason it is a FUNCTION in SQL rather than
   * an upsert here: the state vocabulary, the "the run really is in that state"
   * check, the one-open-row bound and the re-open-after-acknowledgement rule are
   * all one statement, so no caller can reach a half-applied version of them.
   *
   * `succeeded` is the other direction of the same write and closes whatever was
   * outstanding, so the two cannot be applied separately and disagree.
   *
   * @param {'needs_attention'|'uncertain'|'attended_upgrade_required'|'refused'|'rolled_back'|'succeeded'} state
   * @param {{runId: string, code?: string|null, at?: string|null}} [options] */
  async observeRunAttention(state, { runId, code = null, at = null } = {}) {
    if (!RUN_ATTENTION_STATES_V1.has(state) && state !== RUN_ATTENTION_ERROR_STATE_V1)
      throw updaterRefuseV1("updater_run_attention_refused");
    if (typeof runId !== "string") throw updaterRefuseV1("updater_run_attention_refused");
    if (code !== null && typeof code !== "string") throw updaterRefuseV1("updater_run_attention_refused");
    return (await this.client.query("SELECT updater.observe_run_attention($1::text,$2::text,$3::text,$4::timestamptz) AS state",
      [runId, state, code, at])).rows[0]?.state;
  }

  /** The owner has read the warning and says so. False when there was nothing
   * outstanding, which the caller must treat as "the button did nothing" rather
   * than as an acknowledgement — the same distinction `acknowledgeOwnerReview`
   * makes.
   *
   * @param {string} runId
   * @param {string} identity
   * @param {{at?: string|null}} [options] */
  async acknowledgeRunAttention(runId, identity, { at = null } = {}) {
    if (typeof runId !== "string" || typeof identity !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/u.test(identity))
      throw updaterRefuseV1("updater_run_attention_refused");
    return (await this.client.query(
      "SELECT updater.acknowledge_run_attention($1::text,$2::text,$3::timestamptz) AS acknowledged",
      [runId, identity, at])).rows[0]?.acknowledged === true;
  }

  /** R7U-01 (lead decision 3): the owner's answer, bound to whatever run is
   * CURRENTLY outstanding rather than to one the caller names.
   *
   * THIS IS THE SHAPE THE OWNER'S BUTTON USES, and it is the reason the owner's
   * answer is not a column write. `acknowledge_run_attention` takes a run id
   * because it is the run-bound port that the reviewer's forgery probe tested
   * (a stale tab must not answer a newer failure, and it may not). The owner
   * holding a phone card has no run id — the web login is not even granted the
   * column — so the button reads the outstanding row and answers about THAT run.
   *
   * The replay property is therefore stronger than the run-bound port's, not
   * weaker: there is no run id in the request at all, so there is nothing to
   * replay. A double press is still distinguishable, because the first press
   * clears the row and the second finds nothing outstanding and returns false.
   *
   * @param {string} identity the owner's session subject or a stable digest of it
   * @param {{at?: string|null}} [options]
   * @returns {Promise<false|{runId: string}>} false when nothing was outstanding */
  async acknowledgeOpenRunAttention(identity, { at = null } = {}) {
    if (typeof identity !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/u.test(identity))
      throw updaterRefuseV1("updater_run_attention_refused");
    const outstanding = await this.openRunAttention();
    if (!outstanding) return false;
    return await this.acknowledgeRunAttention(outstanding.runId, identity, { at })
      ? { runId: outstanding.runId } : false;
  }

  // -------------------------------------------------------------------------
  // N06: the owner's review of an update outcome.
  // -------------------------------------------------------------------------

  /** Record that an update errored or was rolled back. Idempotent per kind, so
   * a main loop that ticks every five seconds while the condition persists
   * leaves ONE row and not five hundred. This is the call that makes the
   * warning survive the next tick: the push queue is delivery bookkeeping and
   * the main loop's outcome is transient, and this row is neither.
   *
   * @param {'update_error'|'update_rolled_back'} kind
   * @param {{runId?: string|null, at?: string|null}} [options] */
  async observeUpdateOutcome(kind, { runId = null, at = null } = {}) {
    if (kind !== "update_error" && kind !== "update_rolled_back")
      throw updaterRefuseV1("updater_review_kind_refused");
    if (runId !== null && typeof runId !== "string") throw updaterRefuseV1("updater_review_run_refused");
    return (await this.client.query("SELECT updater.observe_update_outcome($1::text,$2::text,$3::timestamptz) AS kind",
      [kind, runId, at])).rows[0]?.kind;
  }

  /** The owner's outstanding reviews, and optionally every review this
   * installation has ever raised. Ordered by the instant the condition was LAST
   * seen, so the freshest warning is first.
   *
   * @param {{onlyOpen?: boolean}} [options] */
  async ownerReviews({ onlyOpen = true } = {}) {
    if (typeof onlyOpen !== "boolean") throw updaterRefuseV1("updater_reviews_filter_refused");
    return (await this.client.query("SELECT * FROM updater.owner_reviews($1::boolean)",
      [onlyOpen])).rows.map(row => Object.freeze({ ...row }));
  }

  /** The owner has read a warning and says so. Returns false when there was
   * nothing outstanding, which the caller must treat as "the button did
   * nothing" rather than as an acknowledgement.
   *
   * @param {'update_error'|'update_rolled_back'} kind
   * @param {string} identity
   * @param {{at?: string|null}} [options] */
  async acknowledgeOwnerReview(kind, identity, { at = null } = {}) {
    if (kind !== "update_error" && kind !== "update_rolled_back")
      throw updaterRefuseV1("updater_review_kind_refused");
    if (typeof identity !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/u.test(identity))
      throw updaterRefuseV1("updater_review_identity_refused");
    return (await this.client.query(
      "SELECT updater.acknowledge_owner_review($1::text,$2::text,$3::timestamptz) AS acknowledged",
      [kind, identity, at])).rows[0]?.acknowledged === true;
  }
}
