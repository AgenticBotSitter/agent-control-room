import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { actionInboxItemSchemaV1 } from "../../operator-surfaces/v1/validators";
import { ServiceIncidentStore } from "../../services/v1/incident-store";

type Candidate = Readonly<{ project_id: string; job_id: string; job_state: string; job_version: number | string;
  job_payload: Record<string, unknown>; attempt_id: string; attempt_state: string; attempt_version: number | string;
  attempt_payload: Record<string, unknown>; worker_id: string | null; node_id: string; lease_id: string;
  lease_state: string; lease_version: number | string; lease_payload: Record<string, unknown>;
  outcome_uncertain: boolean }>;

export type SupervisorReconciliationOutcomeV1 = Readonly<{
  jobId: string;
  attemptId: string;
  disposition: "queued" | "needs_attention" | "uncertain";
  lapseNumber: 1 | 2;
  replayed: boolean;
}>;

const iso = (value: string | Date) => new Date(value).toISOString();
const safeNow = (clock: () => number) => {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("supervisor_clock_invalid");
  return new Date(now).toISOString();
};

function nextPayload(payload: Record<string, unknown>, state: string, version: number, at: string,
  terminalReason?: string): Record<string, unknown> {
  return { ...payload, state, version, updatedAt: at,
    ...(terminalReason ? { finishedAt: at, safeFailureCode: terminalReason } : {}) };
}

async function transitionCanonical(tx: DatabaseSession, tenantId: string, row: Candidate,
  jobState: "ready" | "orphaned", reasonCode: string, at: string, eventPrefix: string): Promise<void> {
  const leaseVersion = Number(row.lease_version) + 1;
  const attemptVersion = Number(row.attempt_version) + 1;
  const jobVersion = Number(row.job_version) + 1;
  const leasePayload = nextPayload(row.lease_payload,"expired",leaseVersion,at);
  const attemptPayload = nextPayload(row.attempt_payload,"orphaned",attemptVersion,at,reasonCode);
  const jobPayload = nextPayload(row.job_payload,jobState,jobVersion,at);
  const lease = await tx.query(`UPDATE control_leases SET state='expired',version=$1,payload=$2::jsonb,updated_at=$3
    WHERE tenant_id=$4 AND id=$5 AND state='active' AND version=$6`,
  [leaseVersion,JSON.stringify(leasePayload),at,tenantId,row.lease_id,row.lease_version]);
  const attempt = await tx.query(`UPDATE control_attempts SET state='orphaned',version=$1,payload=$2::jsonb,updated_at=$3
    WHERE tenant_id=$4 AND id=$5 AND state IN ('leased','running','waiting') AND version=$6`,
  [attemptVersion,JSON.stringify(attemptPayload),at,tenantId,row.attempt_id,row.attempt_version]);
  const job = await tx.query(`UPDATE control_jobs SET state=$1,version=$2,payload=$3::jsonb,updated_at=$4
    WHERE tenant_id=$5 AND id=$6 AND state IN ('leased','running') AND version=$7`,
  [jobState,jobVersion,JSON.stringify(jobPayload),at,tenantId,row.job_id,row.job_version]);
  if (lease.rows.length !== 0 || attempt.rows.length !== 0 || job.rows.length !== 0) {
    // PostgreSQL UPDATE without RETURNING has no rows. Fake/alternate clients may
    // return rows, but affected-row counts are not part of DatabaseClient.
  }
  await tx.query("DELETE FROM control_assignment_lease_scopes WHERE tenant_id=$1 AND lease_id=$2",
    [tenantId,row.lease_id]);
  const transitions = [
    { kind:"lease",id:row.lease_id,from:row.lease_state,to:"expired",fromVersion:Number(row.lease_version),toVersion:leaseVersion },
    { kind:"attempt",id:row.attempt_id,from:row.attempt_state,to:"orphaned",fromVersion:Number(row.attempt_version),toVersion:attemptVersion },
    { kind:"job",id:row.job_id,from:row.job_state,to:jobState,fromVersion:Number(row.job_version),toVersion:jobVersion },
  ];
  for (const value of transitions) await tx.query(`INSERT INTO control_transition_events
    (id,tenant_id,entity_kind,entity_id,from_state,to_state,from_version,to_version,actor_id,actor_type,
     idempotency_key,safe_metadata,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'service:supervisor:v1','service',$9,$10::jsonb,$11) ON CONFLICT DO NOTHING`,
  [`transition:${eventPrefix}:${value.kind}`,tenantId,value.kind,value.id,value.from,value.to,value.fromVersion,value.toVersion,
    `${eventPrefix}:${value.kind}`,JSON.stringify({ reasonCode }),at]);
}

const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const value = await work(tx); await check(); return value; } });

async function attention(tx: DatabaseSession, tenantId: string, row: Candidate, reasonCode: string,
  disposition: "needs_attention" | "uncertain", at: string, reconciliationEventId: string): Promise<void> {
  const incident = disposition === "needs_attention" ? (await new ServiceIncidentStore(joined(tx)).apply({
    tenantId,serviceId:"service:supervisor:v1",correlationKey:`supervisor.lapse.${reconciliationEventId}`,
    observedAt:at,action:"open_or_update",severity:"warning",safeReasonCode:reasonCode,
    safeRemedyCode:"review_stalled_task",
  })).incident : undefined;
  const digest = createHash("sha256").update(incident?.id ?? reconciliationEventId).digest("hex").slice(0,32);
  const id = `attention:supervisor:${digest}`;
  const item = actionInboxItemSchemaV1.parse({ id,tenantId,projectId:row.project_id,
    kind: disposition === "uncertain" ? "ambiguity" : "incident", state:"open",
    requestedAction: disposition === "uncertain"
      ? "Inspect the recorded attempt before deciding whether to retry."
      : "Review this task after two stalled attempts.",
    reasonCode,blockedWorkItemIds:[row.job_id],legalResponses:[
      { id:`response:${id}:review`,kind:"open_source",label:"Review recorded task evidence",
        requiresConfirmation:false,available:true },
      { id:`response:${id}:retry`,kind:"request_retry",label:"Request a new attempt",
        requiresConfirmation:true,available:disposition!=="uncertain",
        ...(disposition==="uncertain"?{unavailableReasonCode:"outcome_uncertain"}: {}) },
    ],evidence:incident
      ? [{id:`incident:${digest}`,kind:"incident" as const,observedAt:at}]
      : [{id:`reconciliation:${row.attempt_id}`,kind:"service_observation" as const,observedAt:at}],
    createdAt:at,deliveryState:"not_requested" });
  await tx.query(`INSERT INTO control_action_inbox
    (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
    VALUES($1,$2,$3,NULL,$4,'open','not_requested',$5,NULL,$6::jsonb) ON CONFLICT DO NOTHING`,
  [item.id,item.tenantId,item.projectId,item.kind,item.createdAt,JSON.stringify(item)]);
}

export class SupervisorReconcilerV1 {
  constructor(private readonly db: DatabaseClient, private readonly tenantId: string,
    private readonly clock: () => number = Date.now) {}

  async reconcileStalled(limit = 16): Promise<readonly SupervisorReconciliationOutcomeV1[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("supervisor_limit_invalid");
    const at = safeNow(this.clock);
    const candidates = await this.db.query<{ attempt_id: string }>(`SELECT a.id AS attempt_id
      FROM control_attempts a JOIN control_jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
      JOIN control_leases l ON l.tenant_id=a.tenant_id AND l.attempt_id=a.id AND l.job_id=j.id
      WHERE a.tenant_id=$1 AND a.state IN ('leased','running','waiting') AND j.state IN ('leased','running')
        AND l.state='active' AND l.expires_at<=$2
      ORDER BY l.expires_at,a.id LIMIT $3`, [this.tenantId,at,limit]);
    const outcomes: SupervisorReconciliationOutcomeV1[] = [];
    for (const candidate of candidates.rows) {
      const outcome = await this.reconcileAttempt(candidate.attempt_id,at);
      if (outcome) outcomes.push(outcome);
    }
    return Object.freeze(outcomes);
  }

  private async reconcileAttempt(attemptId: string, at: string): Promise<SupervisorReconciliationOutcomeV1 | undefined> {
    return this.db.transaction(async tx => {
      const prior = (await tx.query<{ job_id:string;attempt_id:string;disposition:"queued"|"needs_attention"|"uncertain";
        lapse_number:number|string }>(`SELECT job_id,attempt_id,disposition,lapse_number
        FROM control_supervisor_reconciliation_events WHERE tenant_id=$1 AND attempt_id=$2`,
      [this.tenantId,attemptId])).rows[0];
      if (prior) return Object.freeze({jobId:prior.job_id,attemptId:prior.attempt_id,disposition:prior.disposition,
        lapseNumber:Number(prior.lapse_number) as 1|2,replayed:true});
      const row = (await tx.query<Candidate>(`SELECT j.project_id,j.id AS job_id,j.state AS job_state,j.version AS job_version,
        j.payload AS job_payload,a.id AS attempt_id,a.state AS attempt_state,a.version AS attempt_version,
        a.payload AS attempt_payload,a.worker_id,a.node_id,l.id AS lease_id,l.state AS lease_state,
        l.version AS lease_version,l.payload AS lease_payload,
        ((j.payload->'authority'->>'effectPolicy') IS DISTINCT FROM 'none'
          OR EXISTS(SELECT 1 FROM control_effect_intents e WHERE e.tenant_id=j.tenant_id AND e.attempt_id=a.id
            AND e.state IN ('executing','confirmed','ambiguous'))
          OR EXISTS(SELECT 1 FROM control_native_transmission_intents n WHERE n.tenant_id=j.tenant_id
            AND n.job_id=j.id AND n.attempt_id=a.id AND NOT EXISTS(SELECT 1 FROM control_native_delivery_receipts r
              WHERE r.tenant_id=n.tenant_id AND r.job_id=n.job_id AND r.attempt_id=n.attempt_id))
          OR EXISTS(SELECT 1 FROM control_codex_transmission_intents c WHERE c.tenant_id=j.tenant_id
            AND c.job_id=j.id AND c.attempt_id=a.id AND NOT EXISTS(SELECT 1 FROM control_codex_delivery_receipts r
              WHERE r.tenant_id=c.tenant_id AND r.job_id=c.job_id AND r.attempt_id=c.attempt_id))) AS outcome_uncertain
        FROM control_attempts a JOIN control_jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
        JOIN control_leases l ON l.tenant_id=a.tenant_id AND l.attempt_id=a.id AND l.job_id=j.id
        WHERE a.tenant_id=$1 AND a.id=$2 AND a.state IN ('leased','running','waiting')
          AND j.state IN ('leased','running') AND l.state='active' AND l.expires_at<=$3
        FOR UPDATE OF j,a,l`, [this.tenantId,attemptId,at])).rows[0];
      if (!row) return undefined;
      const head = (await tx.query<{lapse_count:number|string}>(`SELECT lapse_count FROM control_supervisor_task_heads
        WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE`,[this.tenantId,row.job_id])).rows[0];
      const lapseNumber = Math.min(2,Number(head?.lapse_count ?? 0)+1) as 1|2;
      const disposition = row.outcome_uncertain ? "uncertain" as const
        : lapseNumber === 1 ? "queued" as const : "needs_attention" as const;
      const reasonCode = disposition === "uncertain" ? "stalled_outcome_uncertain"
        : disposition === "queued" ? "first_stall_requeued" : "second_stall_needs_attention";
      const eventId=`supervisor-reconcile:${randomUUID()}`;
      await transitionCanonical(tx,this.tenantId,row,disposition==="queued"?"ready":"orphaned",reasonCode,at,eventId);
      await tx.query(`INSERT INTO control_supervisor_task_heads
        (tenant_id,job_id,project_id,lapse_count,last_attempt_id,state,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(tenant_id,job_id) DO UPDATE SET lapse_count=EXCLUDED.lapse_count,
          last_attempt_id=EXCLUDED.last_attempt_id,state=EXCLUDED.state,updated_at=EXCLUDED.updated_at`,
      [this.tenantId,row.job_id,row.project_id,lapseNumber,row.attempt_id,disposition,at]);
      await tx.query(`INSERT INTO control_supervisor_reconciliation_events
        (id,tenant_id,project_id,job_id,attempt_id,lease_id,node_id,lapse_number,disposition,safe_reason_code,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [eventId,this.tenantId,row.project_id,row.job_id,row.attempt_id,row.lease_id,row.node_id,
        lapseNumber,disposition,reasonCode,at]);
      if (disposition !== "queued") await attention(tx,this.tenantId,row,reasonCode,disposition,at,eventId);
      return Object.freeze({jobId:row.job_id,attemptId:row.attempt_id,disposition,lapseNumber,replayed:false});
    });
  }

  async releaseDueProviderWaits(limit = 16): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("supervisor_limit_invalid");
    const at=safeNow(this.clock);
    const due=await this.db.query<{id:string}>(`SELECT id FROM control_provider_waits
      WHERE tenant_id=$1 AND state='waiting' AND retry_after<=$2 ORDER BY retry_after,id LIMIT $3`,
    [this.tenantId,at,limit]);
    let released=0;
    for(const item of due.rows) released += await this.db.transaction(async tx => {
      const wait=(await tx.query<{id:string;job_id:string;attempt_id:string;node_id:string;reason:string}>(
        `SELECT id,job_id,attempt_id,node_id,reason FROM control_provider_waits
         WHERE tenant_id=$1 AND id=$2 AND state='waiting' AND retry_after<=$3 FOR UPDATE`,
        [this.tenantId,item.id,at])).rows[0];
      if(!wait)return 0;
      const row=(await tx.query<Candidate>(`SELECT j.project_id,j.id AS job_id,j.state AS job_state,j.version AS job_version,
        j.payload AS job_payload,a.id AS attempt_id,a.state AS attempt_state,a.version AS attempt_version,
        a.payload AS attempt_payload,a.worker_id,a.node_id,l.id AS lease_id,l.state AS lease_state,
        l.version AS lease_version,l.payload AS lease_payload,false AS outcome_uncertain
        FROM control_jobs j JOIN control_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
        JOIN control_leases l ON l.tenant_id=a.tenant_id AND l.attempt_id=a.id AND l.job_id=j.id
        WHERE j.tenant_id=$1 AND j.id=$2 AND a.id=$3 AND a.node_id=$4
          AND j.state IN ('leased','running') AND a.state='waiting' AND l.state='active' FOR UPDATE OF j,a,l`,
      [this.tenantId,wait.job_id,wait.attempt_id,wait.node_id])).rows[0];
      if(row)await transitionCanonical(tx,this.tenantId,row,"ready",`provider_wait_${wait.reason}`,at,wait.id);
      await tx.query(`UPDATE control_provider_waits SET state='released',released_at=$3
        WHERE tenant_id=$1 AND id=$2 AND state='waiting'`,[this.tenantId,wait.id,at]);
      return 1;
    });
    return released;
  }

  async refreshAgentHeartbeatHealth(limit = 64): Promise<number> {
    if(!Number.isInteger(limit)||limit<1||limit>256)throw new Error("supervisor_limit_invalid");
    const at=safeNow(this.clock);
    const rows=await this.db.query<{worker_id:string;node_id:string;expires_at:string|Date|null}>(`SELECT DISTINCT ON(a.worker_id)
      a.worker_id,a.node_id,f.expires_at FROM control_attempts a
      JOIN control_jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
      LEFT JOIN control_node_fleet_current f ON f.tenant_id=a.tenant_id AND f.node_id=a.node_id
        AND f.signal_kind='telemetry' AND f.signal_subject_id='node'
      WHERE a.tenant_id=$1 AND a.worker_id IS NOT NULL AND a.node_id IS NOT NULL
        AND a.state IN ('leased','running','waiting') AND j.state IN ('leased','running')
      ORDER BY a.worker_id,a.attempt_number DESC LIMIT $2`,[this.tenantId,limit]);
    let suspect=0;
    for(const row of rows.rows){
      const heartbeat=row.expires_at?iso(row.expires_at):null;
      const lost=!heartbeat||Date.parse(heartbeat)<=Date.parse(at);
      await this.db.query(`INSERT INTO control_supervisor_agent_health
        (tenant_id,worker_id,node_id,state,safe_reason_code,last_heartbeat_at,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(tenant_id,worker_id) DO UPDATE SET node_id=EXCLUDED.node_id,state=EXCLUDED.state,
          safe_reason_code=EXCLUDED.safe_reason_code,last_heartbeat_at=EXCLUDED.last_heartbeat_at,observed_at=EXCLUDED.observed_at`,
      [this.tenantId,row.worker_id,row.node_id,lost?"suspect":"healthy",lost?"heartbeat_lost":null,heartbeat,at]);
      if(lost)suspect+=1;
      // U05: the health row is the supervisor's own record; the OWNER item is the
      // escalation, and the two are separate statements on purpose. A health row
      // that lands without an item is the silent outage this fixes, so a failure
      // in the escalation is reported rather than swallowed -- the health row
      // still stands, and the operator sees that the warning did not go out.
      await this.attentionFor(row.worker_id,lost,at);
    }
    return suspect;
  }
  /** Open, re-open, or resolve the ONE owner attention item for one worker.
   *
   * This is the whole of U05, as a named method rather than as a statement
   * buried in the health loop: the review found that a lost heartbeat produced
   * zero inbox rows, and the defect is easier to keep fixed when the escalation
   * is something a test can call on its own.
   *
   * It is PUBLIC and takes the worker id and the instant, rather than being
   * inferred, for the same reason `reconcileStalled` is callable directly: the
   * decision "this worker is offline" belongs to the health loop, and the
   * consequence of that decision is a separate, testable fact.
   */
  async attentionFor(workerId:string,lost:boolean,at:string):Promise<boolean>{
    // The digest is (tenant, worker), so one worker has one item for the whole
    // life of the installation: a flap re-opens the same row rather than
    // filling the owner's list, and 0250's guard checks the id against exactly
    // this expression.
    const digest=await this.db.query<{digest:string}>(`SELECT substring(pg_catalog.md5($1||'/'||$2)
      from 1 for 32) AS digest`,[this.tenantId,workerId]);
    const hex=digest.rows[0]?.digest;
    if(typeof hex!=="string"||!/^[0-9a-f]{32}$/u.test(hex))throw new Error("supervisor_offline_digest_refused");
    if(!lost){
      // Idempotent and one-directional. The WHERE clause names 'open', so a
      // healthy cycle after a healthy cycle updates nothing and the method
      // reports that it had nothing to close -- the difference between a cycle
      // that did work and one that found nothing wrong.
      // `RETURNING id` and not a bare UPDATE: this method's whole answer is
      // WHETHER IT CLOSED SOMETHING, and PostgreSQL's UPDATE without RETURNING
      // has no rows at all. An earlier version read `rows.length` off a
      // RETURNING-less UPDATE and so reported false for every resolution it had
      // actually performed (measured on real PostgreSQL 17: the row's state was
      // 'resolved' and the method said it had closed nothing). That is the worst
      // shape of bug -- the state is right and the report is wrong -- and it is
      // why the count is read from RETURNING rather than inferred.
      const closed=await this.db.query(`UPDATE control_action_inbox SET state='resolved',
          payload=pg_catalog.jsonb_set(payload,'{state}','"resolved"'::jsonb,true)
        WHERE tenant_id=$1 AND id=$2 AND state='open'
        RETURNING id`,[this.tenantId,`attention:supervisor-agent:${hex}`]);
      return (closed.rows.length??0)>0;
    }
    // Fixed text, and the worker id appears only inside the evidence, where
    // 0250's own CHECK pattern for it already applies. Nothing here is
    // caller-chosen prose: the reason code and the action are this feature's,
    // and 0250's insert guard refuses any other.
    // `workerId` is carried in the payload as a NAMED field, alongside the
    // schema's own keys, because 0250's insert guard has to recompute the
    // digest in order to check the id -- and a digest cannot be inverted back
    // into the worker it came from. The schema validates unknown keys, so it is
    // added AFTER the parse rather than smuggled through it.
    const item=actionInboxItemSchemaV1.parse({id:`attention:supervisor-agent:${hex}`,tenantId:this.tenantId,
      kind:"incident",state:"open",requestedAction:"Check this worker before trusting its work.",
      reasonCode:"worker_heartbeat_lost",blockedWorkItemIds:[],
      legalResponses:[{id:`response:${hex}:inspect`,kind:"open_source",label:"Inspect the worker",
        requiresConfirmation:false,available:true}],
      evidence:[{id:`worker:${hex}`,kind:"service_observation",observedAt:at}],
      createdAt:at,deliveryState:"not_requested"});
    // `ON CONFLICT DO NOTHING` with `RETURNING id`, and the boolean is read off
    // the RETURNING rather than returned as a literal true. The distinction is
    // the difference between "this cycle opened a new question for the owner"
    // and "there was already one open, which is the normal case on every cycle
    // after the first", and a caller that cannot tell them cannot log
    // anything useful about a worker that flaps.
    //
    // It is ALSO the honest report of whether the item is open afterwards, which
    // matters for the flap case: a worker that was resolved and then goes
    // offline again does NOT re-open by this INSERT, because the row exists and
    // the conflict does nothing. So this returns false and the item stays
    // resolved -- which is the N06 shape of a bug, and the next statement is
    // where it is handled.
    const opened = await this.db.query(`INSERT INTO control_action_inbox
      (id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
      VALUES($1,$2,NULL,NULL,'incident','open','not_requested',$3,NULL,$4::jsonb)
      ON CONFLICT DO NOTHING RETURNING id`,
    [item.id,item.tenantId,item.createdAt,
      JSON.stringify({ ...item, workerId: workerId })]);
    if ((opened.rows.length ?? 0) > 0) return true;
    // ALREADY THERE. If it is resolved, the worker is offline again and the
    // owner has not seen THAT, so the item is re-opened -- the same row, the
    // same id, and the reason code and evidence it already carries. A flap
    // therefore leaves one outstanding question rather than none.
    const reopened = await this.db.query(`UPDATE control_action_inbox
        SET state='open', payload=pg_catalog.jsonb_set(payload,'{state}','"open"'::jsonb,true)
      WHERE tenant_id=$1 AND id=$2 AND state<>'open' RETURNING id`,
    [this.tenantId, item.id]);
    return (reopened.rows.length ?? 0) > 0;
  }
  /** Open (or re-open) the owner attention item for an offline worker.
   *
   * Named separately from `attentionFor` so the DIRECTION is in the name at the
   * call site: a caller that wants to escalate reads `escalateOfflineWorker`, and
   * cannot pass `false` by accident and quietly resolve an item instead. */
  async escalateOfflineWorker(workerId:string,at:string):Promise<boolean>{
    return this.attentionFor(workerId,true,at);
  }
  /** Resolve the owner attention item for a worker that is answering again.
   * Returns true when an open item was closed, false when there was none. */
  async resolveOfflineWorker(workerId:string,at:string):Promise<boolean>{
    return this.attentionFor(workerId,false,at);
  }
}
