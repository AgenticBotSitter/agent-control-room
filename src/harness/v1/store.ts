import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { canTransitionHarnessRun, isTerminalHarnessRunState } from "./lifecycle";
import { harnessRunEventSchemaV1, harnessRunSchemaV1 } from "./schemas";
import type { HarnessRunEventV1, HarnessRunState, HarnessRunV1 } from "./types";
import { assertNativeSnapshotProgress, nativeTaskSnapshotBodySchema, type NativeTaskSnapshotBody } from "./native-observation";

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
    if (run.nativeTask && (run.startedAt !== undefined || run.finishedAt !== undefined || run.safeReasonCode !== undefined
      || run.cancelState !== "not_requested" || run.updatedAt !== run.createdAt || run.lastObservedAt !== run.createdAt)) {
      throw new Error("native registration must contain only initial evidence");
    }
    return this.db.transaction(async (tx) => {
      const existing = await tx.query<RunRow>(`SELECT ${runProjection} FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE`, [run.tenantId, run.id]);
      if (existing.rows[0]) {
        const verified = verifiedRun(existing.rows[0],this.integrityKey);
        if (verified.nativeTask && run.nativeTask) {
          const initial: HarnessRunV1 = { ...verified, state: "discovered", cancelState: "not_requested",
            updatedAt: verified.createdAt, lastObservedAt: verified.createdAt };
          delete initial.startedAt; delete initial.finishedAt; delete initial.safeReasonCode;
          if (sha256Digest(initial) !== sha256Digest(run)) throw new Error("harness run replay conflict");
          return { run: verified, replayed: true };
        }
        if (existing.rows[0].run_digest !== sha256Digest(run)) throw new Error("harness run replay conflict");
        return { run: verified, replayed: true };
      }
      const attempt = await tx.query<{ state: string }>(`SELECT state FROM control_attempts WHERE tenant_id=$1 AND id=$2 AND job_id=$3 AND node_id=$4`, [run.tenantId,run.attemptId,run.jobId,run.nodeId]);
      if (!attempt.rows[0] || !["leased","running","waiting"].includes(attempt.rows[0].state)) throw new Error("harness run requires the bound active attempt and node");
      if (run.nativeTask) await this.assertNativeCanonicalBinding(tx, run, true);
      await this.assertLineage(tx, run);
      const runDigest=sha256Digest(run); const authTag=hmacSha256Tag(this.integrityKey,runAuthMaterial({id:run.id,tenant_id:run.tenantId,project_id:run.projectId,job_id:run.jobId,attempt_id:run.attemptId,node_id:run.nodeId,adapter_id:run.adapterId,harness:run.harness,native_session_key_digest:run.nativeSessionKeyDigest,parent_run_id:run.parentRunId??null,revision_of_run_id:run.revisionOfRunId??null,payload:run,last_sequence:0,run_digest:runDigest,state:run.state,created_at:run.createdAt,updated_at:run.updatedAt,last_observed_at:run.lastObservedAt}));
      await tx.query(`INSERT INTO control_harness_runs (id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,parent_run_id,revision_of_run_id,state,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)`, [run.id,run.tenantId,run.projectId,run.jobId,run.attemptId,run.nodeId,run.adapterId,run.harness,run.nativeSessionKeyDigest,run.parentRunId ?? null,run.revisionOfRunId ?? null,run.state,runDigest,authTag,JSON.stringify(run),run.createdAt,run.updatedAt,run.lastObservedAt]);
      return { run, replayed: false };
    });
  }

  async append(input: HarnessRunEventV1): Promise<{ run: HarnessRunV1; replayed: boolean }> {
    const event = harnessRunEventSchemaV1.parse(input) as HarnessRunEventV1;
    if (event.payload.category === "native_snapshot") throw new Error("native snapshots require authenticated node ingestion");
    return this.db.transaction(tx => this.appendWithin(tx, event));
  }

  /** Trusted ingestion seam, called only after node-frame authentication. The row lock serializes
   * server event numbering; native snapshot versions may skip because these are snapshots, not SSE replay. */
  async recordNativeSnapshot(tenantId: string, nodeId: string, input: NativeTaskSnapshotBody,
    assertCurrent: () => void = () => {}): Promise<{ run: HarnessRunV1; replayed: boolean }> {
    const snapshot = nativeTaskSnapshotBodySchema.parse(input);
    assertNoSecretMaterial(snapshot, "native task snapshot");
    return this.db.transactionWithPreCommitCheck(async tx => {
      const row = (await tx.query<RunRow>(`SELECT ${runProjection} FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE`, [tenantId, snapshot.runId])).rows[0];
      if (!row) throw new Error("native task not registered");
      const run = verifiedRun(row, this.integrityKey), registration = run.nativeTask;
      if (!registration || run.nodeId !== nodeId || run.projectId !== snapshot.projectId || run.jobId !== snapshot.jobId
        || run.attemptId !== snapshot.attemptId || run.nativeSessionKeyDigest !== snapshot.sessionKeyDigest
        || registration.bindingDigest !== snapshot.bindingDigest || registration.leaseId !== snapshot.leaseId
        || registration.leaseEpoch !== snapshot.leaseEpoch) throw new Error("native task identity mismatch");
      await this.assertNativeCanonicalBinding(tx, run, false);
      const prior = row.event_rows.find(item => item.payload.payload.category === "native_snapshot"
        && item.payload.payload.snapshot.snapshotVersion === snapshot.snapshotVersion);
      if (prior) {
        if (sha256Digest(prior.payload.payload) !== sha256Digest({ category: "native_snapshot", snapshot })) throw new Error("native snapshot replay conflict");
        assertCurrent(); return { run, replayed: true };
      }
      if (Number(row.last_sequence) >= 1024) throw new Error("native observation history capacity reached");
      const last = row.event_rows.at(-1)?.payload.payload;
      if (last?.category === "native_snapshot") assertNativeSnapshotProgress(last.snapshot, snapshot);
      if (isTerminalHarnessRunState(run.state)) throw new Error("native terminal observation is immutable");
      const event: HarnessRunEventV1 = { schemaVersion: "control-room-harness-event/v1", tenantId, runId: run.id,
        sequence: Number(row.last_sequence) + 1, occurredAt: snapshot.observedAt, source: "harness_read",
        sourceEventKeyDigest: sha256Digest({ bindingDigest: snapshot.bindingDigest, snapshotVersion: snapshot.snapshotVersion }),
        payload: { category: "native_snapshot", snapshot } };
      const result = await this.appendWithin(tx, event, true);
      assertCurrent(); return result;
    }, assertCurrent);
  }

  private async appendWithin(tx: DatabaseSession, event: HarnessRunEventV1, native = false): Promise<{ run: HarnessRunV1; replayed: boolean }> {
    assertNoSecretMaterial(event, "harness event");
    const eventDigest = sha256Digest(event);
      const current = await tx.query<RunRow>(`SELECT ${runProjection} FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE`, [event.tenantId,event.runId]);
      const row = current.rows[0];
      if (!row) throw new Error("harness run not found");
      const run = verifiedRun(row,this.integrityKey);
      if (Boolean(run.nativeTask) !== native) throw new Error("native and legacy observation paths cannot be mixed");
      const prior = await tx.query<EventRow>(`SELECT tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,event_auth_tag,payload,recorded_at FROM control_harness_run_events WHERE tenant_id=$1 AND run_id=$2 AND (sequence=$3 OR source_event_key_digest=$4)`, [event.tenantId,event.runId,event.sequence,event.sourceEventKeyDigest]);
      if (prior.rows[0]) {
        verifiedEvent(prior.rows[0],this.integrityKey);
        if (prior.rows[0].event_digest !== eventDigest) throw new Error("harness event replay conflict");
        return { run, replayed: true };
      }
      const lastSequence = Number(row.last_sequence);
      if (event.sequence !== lastSequence + 1) throw new Error("harness event sequence gap");
      if (Date.parse(event.occurredAt) < Date.parse(run.lastObservedAt)) throw new Error("harness event time regression");
      const nextState = event.payload.category === "native_snapshot" ? this.nativeState(event.payload.snapshot)
        : event.payload.category === "lifecycle" ? event.payload.state
        : event.payload.category === "attention" && event.payload.state === "requested" ? (event.payload.attention === "approval" ? "waiting_approval" : "waiting_input")
        : event.payload.category === "transport" && event.payload.state === "disconnected" ? "disconnected"
        : run.state;
      if (native ? isTerminalHarnessRunState(run.state) : !canTransitionHarnessRun(run.state, nextState)) throw new Error(`illegal harness run transition ${run.state} -> ${nextState}`);
      const updated = this.updatedRun(run, nextState, event);
      const eventAuthTag=hmacSha256Tag(this.integrityKey,eventAuthMaterial({tenant_id:event.tenantId,run_id:event.runId,sequence:event.sequence,occurred_at:event.occurredAt,source:event.source,source_event_key_digest:event.sourceEventKeyDigest,event_digest:eventDigest,payload:event,recorded_at:event.occurredAt}));
      await tx.query(`INSERT INTO control_harness_run_events (tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,event_auth_tag,payload,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`, [event.tenantId,event.runId,event.sequence,event.occurredAt,event.source,event.sourceEventKeyDigest,eventDigest,eventAuthTag,JSON.stringify(event),event.occurredAt]);
      const updatedDigest=sha256Digest(updated); const runAuthTag=hmacSha256Tag(this.integrityKey,runAuthMaterial({...row,payload:updated,last_sequence:event.sequence,run_digest:updatedDigest,state:updated.state,updated_at:event.occurredAt,last_observed_at:event.occurredAt}));
      await tx.query(`UPDATE control_harness_runs SET state=$1,last_sequence=$2,run_digest=$3,run_auth_tag=$4,payload=$5::jsonb,updated_at=$6,last_observed_at=$6 WHERE tenant_id=$7 AND id=$8`, [updated.state,event.sequence,updatedDigest,runAuthTag,JSON.stringify(updated),event.occurredAt,event.tenantId,event.runId]);
      return { run: updated, replayed: false };
  }

  private nativeState(snapshot: NativeTaskSnapshotBody): HarnessRunState {
    if (snapshot.state === "completed") return "succeeded";
    if (snapshot.state === "failed" || snapshot.state === "interrupted") return "failed";
    if (snapshot.state === "cancelled") return "cancelled";
    if (snapshot.state === "ambiguous" || snapshot.availability === "offline" || snapshot.availability === "expired") return "disconnected";
    if (snapshot.state === "waiting_approval") return "waiting_approval";
    if (snapshot.state === "stopping") return "cancelling";
    if (snapshot.state === "running") return "running";
    return snapshot.state === "prepared" ? "discovered" : "starting";
  }

  private async assertNativeCanonicalBinding(tx: DatabaseSession, run: HarnessRunV1, registration: boolean): Promise<void> {
    const native = run.nativeTask!;
    const row = (await tx.query<{ input_digest: string; epoch: number | string; state: string; expires_at: string | Date; acquired_at: string | Date }>(
      `SELECT j.payload->>'inputDigest' AS input_digest,l.epoch,l.state,l.expires_at,l.acquired_at
       FROM control_jobs j JOIN control_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
       JOIN control_leases l ON l.tenant_id=a.tenant_id AND l.attempt_id=a.id
       WHERE j.tenant_id=$1 AND j.id=$2 AND j.project_id=$3 AND a.id=$4 AND a.node_id=$5
         AND l.id=$6 AND l.node_id=$5 AND a.lease_epoch=$7 AND l.epoch=$7 FOR SHARE OF j,l ${registration ? "FOR UPDATE OF a" : "FOR SHARE OF a"}`,
      [run.tenantId, run.jobId, run.projectId, run.attemptId, run.nodeId, native.leaseId, native.leaseEpoch])).rows[0];
    if (!row || row.input_digest !== native.inputDigest || registration && (row.state !== "active"
      || Date.parse(run.createdAt) < Date.parse(iso(row.acquired_at)) || Date.parse(native.deadline) > Date.parse(iso(row.expires_at))
      || Date.parse(run.createdAt) >= Date.parse(native.deadline))) throw new Error("native canonical task binding mismatch");
    if (registration && (await tx.query(`SELECT id FROM control_harness_runs
      WHERE tenant_id=$1 AND attempt_id=$2 AND adapter_id=$3 AND id<>$4`, [run.tenantId, run.attemptId, run.adapterId, run.id])).rows.length) {
      throw new Error("native attempt already has a registered run");
    }
    // Late observations for this exact historical attempt/lease are evidence, never renewed execution authority.
  }

  async get(tenantId: string, runId: string): Promise<HarnessRunV1 | undefined> {
    const result = await this.db.query<RunRow>(`SELECT ${runProjection} FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=$2`, [tenantId,runId]);
    return result.rows[0] ? verifiedRun(result.rows[0],this.integrityKey) : undefined;
  }

  /** A single SQL snapshot verifies the run and its history together. Presentation may omit older
   * points only after full existing integrity verification; it must not mix two observation revisions. */
  async inspect(tenantId: string, runId: string): Promise<{ run: HarnessRunV1; events: HarnessRunEventV1[] } | undefined> {
    const row = (await this.db.query<RunRow>(`SELECT ${runProjection} FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=$2`,
      [tenantId, runId])).rows[0];
    return row ? { run: verifiedRun(row, this.integrityKey), events: row.event_rows.map(event => verifiedEvent(event, this.integrityKey)) } : undefined;
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
    // For native observations this is the first observed execution state, not an invented start time.
    const observedExecution = event.payload.category === "native_snapshot"
      ? event.payload.snapshot.nativeRunKeyDigest !== null && ["running", "waiting_approval", "completed"].includes(event.payload.snapshot.state)
      : ["running","waiting_input","waiting_approval","cancelling","succeeded","failed","cancelled"].includes(state);
    const startedAt = !run.startedAt && observedExecution ? event.occurredAt : run.startedAt;
    const finishedAt = isTerminalHarnessRunState(state) ? event.occurredAt : undefined;
    const cancelState = state === "cancelling" ? "requested" : state === "cancelled" ? (run.nativeTask ? "reported" : "confirmed") : run.cancelState;
    const safeReasonCode = event.payload.category === "native_snapshot" ? event.payload.snapshot.safeReason
      : event.payload.category === "lifecycle" ? event.payload.reasonCode : run.safeReasonCode;
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
