import { assertPlainObjectV1, assertSafeIdV1, SAFE_STEP_V1, updaterRefuseV1 } from "./contracts.mjs";

const RUN_STATES_V1 = new Set(["approved", "prechecked", "staged", "quick_backup", "draining", "quiesced",
  "backup_verified", "preimage_taken", "migrating", "migrated", "switched", "restarted", "healthy",
  "succeeded", "rollback_started", "restore_started", "db_restored", "code_restored", "rolled_back",
  "needs_attention", "uncertain", "attended_upgrade_required", "refused"]);
const UPDATER_LEASE_LOCK_V1 = Object.freeze([1128354389, 1431323730]);
const OPEN_PLAN_STATES_V1 = Object.freeze(["building", "ready_for_approval", "approved", "approval_required"]);

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
   * run), so `appendEvent`'s ordinal bookkeeping is not needed here at all: the
   * function derives the ordinal from the run's own last event. */
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

  /** The journal mirror, for callers that append one row without moving the run.
   *
   * The runner no longer uses this — `transition()` writes the mirror itself —
   * and it is kept because it is the one way to say "this event already exists",
   * which the atomic function makes a duplicate rather than a gap. Two callers
   * that both try to record the same ordinal get one success and one primary-key
   * refusal, which is the retry-safe property §11 wants. */
  async appendEvent(runId, ordinal, state, detail = {}) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || !RUN_STATES_V1.has(state))
      throw updaterRefuseV1("updater_event_refused");
    await this.client.query(`INSERT INTO updater.run_events(run_id,ordinal,state,detail)
      VALUES($1,$2,$3,$4::jsonb)`, [runId, ordinal, state, JSON.stringify(detail)]);
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
}
