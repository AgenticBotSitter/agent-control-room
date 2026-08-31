import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { canTransitionHarnessRun, isTerminalHarnessRunState } from "./lifecycle";
import { harnessRunEventSchemaV1, harnessRunSchemaV1 } from "./schemas";
import type { HarnessRunEventV1, HarnessRunState, HarnessRunV1 } from "./types";

interface EventRow {
  tenant_id: string; run_id: string; sequence: number | string; occurred_at: string | Date; source: string;
  source_event_key_digest: string; event_digest: string; event_auth_tag: string; payload: HarnessRunEventV1; recorded_at: string | Date;
}
interface RunRow {
  id: string; tenant_id: string; project_id: string; job_id: string; attempt_id: string; node_id: string; adapter_id: string;
  harness: string; native_session_key_digest: string; parent_run_id: string | null; revision_of_run_id: string | null;
  payload: HarnessRunV1; last_sequence: number | string; run_digest: string; run_auth_tag: string; state: string;
  created_at: string | Date; updated_at: string | Date; last_observed_at: string | Date; event_rows: EventRow[];
}

const runProjection = `r.id,r.tenant_id,r.project_id,r.job_id,r.attempt_id,r.node_id,r.adapter_id,r.harness,
  r.native_session_key_digest,r.parent_run_id,r.revision_of_run_id,r.payload,r.last_sequence,r.run_digest,r.run_auth_tag,
  r.state,r.created_at,r.updated_at,r.last_observed_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('tenant_id',e.tenant_id,'run_id',e.run_id,'sequence',e.sequence,
    'occurred_at',e.occurred_at,'source',e.source,'source_event_key_digest',e.source_event_key_digest,
    'event_digest',e.event_digest,'event_auth_tag',e.event_auth_tag,'payload',e.payload,'recorded_at',e.recorded_at)
    ORDER BY e.sequence) FROM control_harness_run_events e WHERE e.tenant_id=r.tenant_id AND e.run_id=r.id),'[]'::jsonb) AS event_rows`;

function iso(value: string | Date): string { return new Date(value).toISOString(); }

function runAuthMaterial(row: Omit<RunRow,"event_rows"|"run_auth_tag">): Record<string,unknown> {
  return { id:row.id,tenantId:row.tenant_id,projectId:row.project_id,jobId:row.job_id,attemptId:row.attempt_id,nodeId:row.node_id,
    adapterId:row.adapter_id,harness:row.harness,nativeSessionKeyDigest:row.native_session_key_digest,parentRunId:row.parent_run_id,
    revisionOfRunId:row.revision_of_run_id,state:row.state,lastSequence:Number(row.last_sequence),runDigest:row.run_digest,
    createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),lastObservedAt:iso(row.last_observed_at) };
}

function eventAuthMaterial(row: Omit<EventRow,"event_auth_tag">): Record<string,unknown> {
  return { tenantId:row.tenant_id,runId:row.run_id,sequence:Number(row.sequence),occurredAt:iso(row.occurred_at),source:row.source,
    sourceEventKeyDigest:row.source_event_key_digest,eventDigest:row.event_digest,recordedAt:iso(row.recorded_at) };
}

function verifiedEvent(row: EventRow, integrityKey: Uint8Array): HarnessRunEventV1 {
  const event = harnessRunEventSchemaV1.parse(row.payload) as HarnessRunEventV1;
  const material = eventAuthMaterial(row);
  if (sha256Digest(event) !== row.event_digest || hmacSha256Tag(integrityKey,material) !== row.event_auth_tag
    || event.tenantId!==row.tenant_id || event.runId!==row.run_id || event.sequence!==Number(row.sequence)
    || event.occurredAt!==iso(row.occurred_at) || event.source!==row.source || event.sourceEventKeyDigest!==row.source_event_key_digest
    || iso(row.recorded_at)!==event.occurredAt) throw new Error("harness event integrity failure");
  return event;
}

function verifiedRun(row: RunRow, integrityKey: Uint8Array): HarnessRunV1 {
  const run = harnessRunSchemaV1.parse(row.payload) as HarnessRunV1;
  const events=row.event_rows.map((event)=>verifiedEvent(event,integrityKey)); const lastSequence=Number(row.last_sequence);
  if (sha256Digest(run)!==row.run_digest || hmacSha256Tag(integrityKey,runAuthMaterial(row))!==row.run_auth_tag
    || row.id!==run.id || row.tenant_id!==run.tenantId || row.project_id!==run.projectId || row.job_id!==run.jobId
    || row.attempt_id!==run.attemptId || row.node_id!==run.nodeId || row.adapter_id!==run.adapterId || row.harness!==run.harness
    || row.native_session_key_digest!==run.nativeSessionKeyDigest || row.parent_run_id!==(run.parentRunId??null)
    || row.revision_of_run_id!==(run.revisionOfRunId??null) || row.state!==run.state || iso(row.created_at)!==run.createdAt
    || iso(row.updated_at)!==run.updatedAt || iso(row.last_observed_at)!==run.lastObservedAt || events.length!==lastSequence
    || events.some((event,index)=>event.sequence!==index+1 || event.tenantId!==run.tenantId || event.runId!==run.id)) {
    throw new Error("harness run integrity failure");
  }
  return run;
}

export class HarnessRunStoreV1 {
  constructor(private readonly db: DatabaseClient, private readonly integrityKey: Uint8Array) {
    hmacSha256Tag(integrityKey,{ purpose:"harness-run-store-key-check" });
  }

  async create(input: HarnessRunV1): Promise<{ run: HarnessRunV1; replayed: boolean }> {
    const run = harnessRunSchemaV1.parse(input) as HarnessRunV1;
    assertNoSecretMaterial(run, "harness run");
    if (run.state !== "discovered") throw new Error("harness run must be created as discovered");
    return this.db.transaction(async (tx) => {
      const existing = await tx.query<RunRow>(`SELECT ${runProjection} FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE`, [run.tenantId, run.id]);
      if (existing.rows[0]) {
        const verified = verifiedRun(existing.rows[0],this.integrityKey);
        if (existing.rows[0].run_digest !== sha256Digest(run)) throw new Error("harness run replay conflict");
        return { run: verified, replayed: true };
      }
      const attempt = await tx.query<{ state: string }>(`SELECT state FROM control_attempts WHERE tenant_id=$1 AND id=$2 AND job_id=$3 AND node_id=$4`, [run.tenantId,run.attemptId,run.jobId,run.nodeId]);
      if (!attempt.rows[0] || !["leased","running","waiting"].includes(attempt.rows[0].state)) throw new Error("harness run requires the bound active attempt and node");
      await this.assertLineage(tx, run);
      const runDigest=sha256Digest(run); const authTag=hmacSha256Tag(this.integrityKey,runAuthMaterial({id:run.id,tenant_id:run.tenantId,project_id:run.projectId,job_id:run.jobId,attempt_id:run.attemptId,node_id:run.nodeId,adapter_id:run.adapterId,harness:run.harness,native_session_key_digest:run.nativeSessionKeyDigest,parent_run_id:run.parentRunId??null,revision_of_run_id:run.revisionOfRunId??null,payload:run,last_sequence:0,run_digest:runDigest,state:run.state,created_at:run.createdAt,updated_at:run.updatedAt,last_observed_at:run.lastObservedAt}));
      await tx.query(`INSERT INTO control_harness_runs (id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,parent_run_id,revision_of_run_id,state,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)`, [run.id,run.tenantId,run.projectId,run.jobId,run.attemptId,run.nodeId,run.adapterId,run.harness,run.nativeSessionKeyDigest,run.parentRunId ?? null,run.revisionOfRunId ?? null,run.state,runDigest,authTag,JSON.stringify(run),run.createdAt,run.updatedAt,run.lastObservedAt]);
      return { run, replayed: false };
    });
  }

  async append(input: HarnessRunEventV1): Promise<{ run: HarnessRunV1; replayed: boolean }> {
    const event = harnessRunEventSchemaV1.parse(input) as HarnessRunEventV1;
    assertNoSecretMaterial(event, "harness event");
    const eventDigest = sha256Digest(event);
    return this.db.transaction(async (tx) => {
      const current = await tx.query<RunRow>(`SELECT ${runProjection} FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE`, [event.tenantId,event.runId]);
      const row = current.rows[0];
      if (!row) throw new Error("harness run not found");
      const run = verifiedRun(row,this.integrityKey);
      const prior = await tx.query<EventRow>(`SELECT tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,event_auth_tag,payload,recorded_at FROM control_harness_run_events WHERE tenant_id=$1 AND run_id=$2 AND (sequence=$3 OR source_event_key_digest=$4)`, [event.tenantId,event.runId,event.sequence,event.sourceEventKeyDigest]);
      if (prior.rows[0]) {
        verifiedEvent(prior.rows[0],this.integrityKey);
        if (prior.rows[0].event_digest !== eventDigest) throw new Error("harness event replay conflict");
        return { run, replayed: true };
      }
      const lastSequence = Number(row.last_sequence);
      if (event.sequence !== lastSequence + 1) throw new Error("harness event sequence gap");
      if (Date.parse(event.occurredAt) < Date.parse(run.lastObservedAt)) throw new Error("harness event time regression");
      const nextState = event.payload.category === "lifecycle" ? event.payload.state
        : event.payload.category === "attention" && event.payload.state === "requested" ? (event.payload.attention === "approval" ? "waiting_approval" : "waiting_input")
        : event.payload.category === "transport" && event.payload.state === "disconnected" ? "disconnected"
        : run.state;
      if (!canTransitionHarnessRun(run.state, nextState)) throw new Error(`illegal harness run transition ${run.state} -> ${nextState}`);
      const updated = this.updatedRun(run, nextState, event);
      const eventAuthTag=hmacSha256Tag(this.integrityKey,eventAuthMaterial({tenant_id:event.tenantId,run_id:event.runId,sequence:event.sequence,occurred_at:event.occurredAt,source:event.source,source_event_key_digest:event.sourceEventKeyDigest,event_digest:eventDigest,payload:event,recorded_at:event.occurredAt}));
      await tx.query(`INSERT INTO control_harness_run_events (tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,event_auth_tag,payload,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`, [event.tenantId,event.runId,event.sequence,event.occurredAt,event.source,event.sourceEventKeyDigest,eventDigest,eventAuthTag,JSON.stringify(event),event.occurredAt]);
      const updatedDigest=sha256Digest(updated); const runAuthTag=hmacSha256Tag(this.integrityKey,runAuthMaterial({...row,payload:updated,last_sequence:event.sequence,run_digest:updatedDigest,state:updated.state,updated_at:event.occurredAt,last_observed_at:event.occurredAt}));
      await tx.query(`UPDATE control_harness_runs SET state=$1,last_sequence=$2,run_digest=$3,run_auth_tag=$4,payload=$5::jsonb,updated_at=$6,last_observed_at=$6 WHERE tenant_id=$7 AND id=$8`, [updated.state,event.sequence,updatedDigest,runAuthTag,JSON.stringify(updated),event.occurredAt,event.tenantId,event.runId]);
      return { run: updated, replayed: false };
    });
  }

  async get(tenantId: string, runId: string): Promise<HarnessRunV1 | undefined> {
    const result = await this.db.query<RunRow>(`SELECT ${runProjection} FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=$2`, [tenantId,runId]);
    return result.rows[0] ? verifiedRun(result.rows[0],this.integrityKey) : undefined;
  }

  async events(tenantId: string, runId: string, limit = 200): Promise<HarnessRunEventV1[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid harness event limit");
    const run=await this.get(tenantId,runId); if (!run) return [];
    const result = await this.db.query<EventRow>(`SELECT tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,event_auth_tag,payload,recorded_at FROM control_harness_run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence ASC LIMIT $3`, [tenantId,runId,limit]);
    return result.rows.map((row)=>verifiedEvent(row,this.integrityKey));
  }

  async watch(tenantId: string, limit = 100): Promise<HarnessRunV1[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("invalid session watch limit");
    const result = await this.db.query<RunRow>(`SELECT ${runProjection} FROM control_harness_runs r WHERE r.tenant_id=$1 ORDER BY r.last_observed_at DESC,r.id ASC LIMIT $2`, [tenantId,limit]);
    return result.rows.map((row)=>verifiedRun(row,this.integrityKey));
  }

  private updatedRun(run: HarnessRunV1, state: HarnessRunState, event: HarnessRunEventV1): HarnessRunV1 {
    const startedAt = !run.startedAt && ["running","waiting_input","waiting_approval","cancelling","succeeded","failed","cancelled"].includes(state) ? event.occurredAt : run.startedAt;
    const finishedAt = isTerminalHarnessRunState(state) ? event.occurredAt : undefined;
    const cancelState = state === "cancelling" ? "requested" : state === "cancelled" ? "confirmed" : run.cancelState;
    const safeReasonCode = event.payload.category === "lifecycle" ? event.payload.reasonCode : run.safeReasonCode;
    return harnessRunSchemaV1.parse({ ...run,state,updatedAt:event.occurredAt,lastObservedAt:event.occurredAt,...(startedAt ? { startedAt } : {}),...(finishedAt ? { finishedAt } : {}),cancelState,...(safeReasonCode ? { safeReasonCode } : {}) }) as HarnessRunV1;
  }

  private async assertLineage(tx: DatabaseSession, run: HarnessRunV1): Promise<void> {
    for (const lineageId of [run.parentRunId,run.revisionOfRunId]) {
      if (!lineageId) continue;
      const parent = await tx.query<{ attempt_id: string; project_id: string }>(`SELECT attempt_id,project_id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2`, [run.tenantId,lineageId]);
      if (!parent.rows[0] || parent.rows[0].project_id !== run.projectId) throw new Error("harness run lineage not found in project");
    }
  }
}
