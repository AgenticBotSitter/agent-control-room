import { randomUUID } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { actionInboxItemSchemaV1 } from "../../operator-surfaces/v1/validators";
import { FLEET_PRESENCE_TIMING_V1 } from "../../fleet/v1/presence";

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

async function attention(tx: DatabaseSession, tenantId: string, row: Candidate, reasonCode: string,
  disposition: "needs_attention" | "uncertain", at: string): Promise<void> {
  const id = `attention:supervisor:${randomUUID()}`;
  const item = actionInboxItemSchemaV1.parse({ id,tenantId,projectId:row.project_id,
    kind: disposition === "uncertain" ? "ambiguity" : "failure", state:"open",
    requestedAction: disposition === "uncertain"
      ? "Inspect the recorded attempt before deciding whether to retry."
      : "Review this task after two stalled attempts.",
    reasonCode,blockedWorkItemIds:[row.job_id],legalResponses:[
      { id:`response:${id}:review`,kind:"open_source",label:"Review recorded task evidence",
        requiresConfirmation:false,available:true },
      { id:`response:${id}:retry`,kind:"request_retry",label:"Request a new attempt",
        requiresConfirmation:true,available:disposition!=="uncertain",
        ...(disposition==="uncertain"?{unavailableReasonCode:"outcome_uncertain"}: {}) },
    ],evidence:[{id:`reconciliation:${row.attempt_id}`,kind:"service_observation",observedAt:at}],
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
      if (disposition !== "queued") await attention(tx,this.tenantId,row,reasonCode,disposition,at);
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
    for(const row of rows.rows){const heartbeat=row.expires_at?iso(row.expires_at):null;
      const suspect=!heartbeat||Date.parse(heartbeat)<=Date.parse(at);
      await this.db.query(`INSERT INTO control_supervisor_agent_health
        (tenant_id,worker_id,node_id,state,safe_reason_code,last_heartbeat_at,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(tenant_id,worker_id) DO UPDATE SET node_id=EXCLUDED.node_id,state=EXCLUDED.state,
          safe_reason_code=EXCLUDED.safe_reason_code,last_heartbeat_at=EXCLUDED.last_heartbeat_at,observed_at=EXCLUDED.observed_at`,
      [this.tenantId,row.worker_id,row.node_id,suspect?"suspect":"healthy",suspect?"heartbeat_lost":null,heartbeat,at]);}
    return rows.rows.filter(row=>!row.expires_at||Date.parse(iso(row.expires_at))<=Date.parse(at)).length;
  }

  /** The only time-driven presence transition. Connector writes can report an
   * authenticated online check-in or a clean stop; they cannot manufacture
   * this missed-window conclusion. Concurrent sweeps lock and transition each
   * session at most once. */
  async markFleetPresenceUnreachable(limit = 64): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("supervisor_limit_invalid");
    const at = safeNow(this.clock);
    const candidates = (await this.db.query<{ worker_id: string }>(`SELECT worker_id FROM fleet_worker_presence
      WHERE tenant_id=$1 AND presence_state='online'
        AND last_seen_at<=$2::timestamptz-interval '90 seconds'
      ORDER BY last_seen_at,worker_id LIMIT $3`, [this.tenantId, at, limit])).rows;
    let changed = 0;
    for (const candidate of candidates) changed += await this.db.transaction(async tx => {
      const machine = (await tx.query<{ session_id: string; last_seen_at: string | Date }>(`SELECT session_id,last_seen_at
        FROM fleet_worker_presence WHERE tenant_id=$1 AND worker_id=$2 AND presence_state='online'
          AND last_seen_at<=$3::timestamptz-interval '90 seconds' FOR UPDATE`,
      [this.tenantId, candidate.worker_id, at])).rows[0];
      if (!machine?.session_id) return 0;
      // Keep the TypeScript constant and SQL interval tied together even though
      // PostgreSQL owns the final comparison and lock.
      if (Date.parse(at) - Date.parse(iso(machine.last_seen_at)) < FLEET_PRESENCE_TIMING_V1.unreachableMs) return 0;
      await tx.query(`UPDATE fleet_worker_presence SET presence_state='unreachable',state_changed_at=$3
        WHERE tenant_id=$1 AND worker_id=$2 AND session_id=$4 AND presence_state='online'`,
      [this.tenantId, candidate.worker_id, at, machine.session_id]);
      await tx.query(`INSERT INTO fleet_presence_transitions(tenant_id,transition_id,worker_id,subject_kind,agent_id,
        session_id,from_state,to_state,source,occurred_at)
        VALUES($1,$2,$3,'machine',NULL,$4,'online','unreachable','supervisor',$5)`,
      [this.tenantId, `fleet-presence:${randomUUID().replaceAll("-", "")}`, candidate.worker_id, machine.session_id, at]);
      const agents = (await tx.query<{ agent_id: string }>(`SELECT agent_id FROM fleet_worker_agents
        WHERE tenant_id=$1 AND worker_id=$2 AND session_id=$3 AND presence_state='online'
          AND last_reported_at<=$4::timestamptz-interval '90 seconds' FOR UPDATE`,
      [this.tenantId, candidate.worker_id, machine.session_id, at])).rows;
      for (const agent of agents) {
        await tx.query(`UPDATE fleet_worker_agents SET presence_state='unreachable',state_changed_at=$4
          WHERE tenant_id=$1 AND worker_id=$2 AND agent_id=$3 AND session_id=$5 AND presence_state='online'`,
        [this.tenantId, candidate.worker_id, agent.agent_id, at, machine.session_id]);
        await tx.query(`INSERT INTO fleet_presence_transitions(tenant_id,transition_id,worker_id,subject_kind,agent_id,
          session_id,from_state,to_state,source,occurred_at)
          VALUES($1,$2,$3,'agent',$4,$5,'online','unreachable','supervisor',$6)`,
        [this.tenantId, `fleet-presence:${randomUUID().replaceAll("-", "")}`, candidate.worker_id,
          agent.agent_id, machine.session_id, at]);
      }
      return 1;
    });
    return changed;
  }
}
