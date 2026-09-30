import { assertSafeIdV1, SAFE_STEP_V1, updaterRefuseV1 } from "./contracts.mjs";

const RUN_STATES_V1 = new Set(["approved", "prechecked", "staged", "quick_backup", "draining", "quiesced",
  "backup_verified", "preimage_taken", "migrating", "migrated", "switched", "restarted", "healthy",
  "succeeded", "rollback_started", "restore_started", "db_restored", "code_restored", "rolled_back",
  "needs_attention", "uncertain", "attended_upgrade_required", "refused"]);

/** Typed adapter over item 7's fixed updater schema. The client is the
 * production peer-authenticated control_room_deployer login. */
export class PostgresUpdaterStoreV1 {
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

  async transition(runId, leaseToken, state, detail = {}, { terminal = false } = {}) {
    assertSafeIdV1(leaseToken);
    if (typeof runId !== "string" || !/^run:[0-9a-f-]{36}$/u.test(runId) || !RUN_STATES_V1.has(state))
      throw updaterRefuseV1("updater_transition_refused");
    const result = await this.client.query(`UPDATE updater.runs SET state=$3,detail=$4::jsonb,
      finished_at=CASE WHEN $5::boolean THEN pg_catalog.now() ELSE NULL END
      WHERE run_id=$1 AND lease_token=$2 AND finished_at IS NULL RETURNING *`,
    [runId, leaseToken, state, JSON.stringify(detail), terminal]);
    if (result.rows.length !== 1) throw updaterRefuseV1("updater_run_lease_lost");
    return result.rows[0];
  }

  async appendEvent(runId, ordinal, state, detail = {}) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || !RUN_STATES_V1.has(state))
      throw updaterRefuseV1("updater_event_refused");
    await this.client.query(`INSERT INTO updater.run_events(run_id,ordinal,state,detail)
      VALUES($1,$2,$3,$4::jsonb)`, [runId, ordinal, state, JSON.stringify(detail)]);
  }

  async events(runId) {
    if (typeof runId !== "string" || !/^run:[0-9a-f-]{36}$/u.test(runId))
      throw updaterRefuseV1("updater_event_refused");
    return (await this.client.query(`SELECT ordinal,state,detail,recorded_at FROM updater.run_events
      WHERE run_id=$1 ORDER BY ordinal`, [runId])).rows;
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

  async subscriptions() {
    return (await this.client.query(`SELECT id,endpoint,p256dh,auth,expires_at FROM public.owner_web_push_subscriptions
      WHERE expires_at IS NULL OR expires_at > pg_catalog.now() ORDER BY tenant_id,id LIMIT 100`)).rows;
  }

  async pending(limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw updaterRefuseV1("updater_push_limit_refused");
    return (await this.client.query(`SELECT id,template,title,body,link_path,attempts FROM updater.push_queue
      WHERE sent_at IS NULL AND attempts < 10 AND coalesce(last_error_code,'') <> 'updater_push_reserved'
      ORDER BY queued_at,id LIMIT $1`, [limit])).rows;
  }

  async begin(id) {
    if (!/^push:[0-9a-f-]{36}$/u.test(id)) throw updaterRefuseV1("updater_push_id_refused");
    return (await this.client.query(`UPDATE updater.push_queue SET attempts=attempts+1,last_error_code='updater_push_reserved'
      WHERE id=$1 AND sent_at IS NULL AND attempts < 10 AND coalesce(last_error_code,'') <> 'updater_push_reserved'
      RETURNING id,attempts`, [id])).rows.length === 1;
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
    await this.client.query(`INSERT INTO updater.push_queue(id,template,title,body,link_path)
      VALUES($1,$2,'Control Room updater','', '/needs-me')`, [`push:${globalThis.crypto.randomUUID()}`, template]);
  }
}
