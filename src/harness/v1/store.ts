import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { canTransitionHarnessRun, isTerminalHarnessRunState } from "./lifecycle";
import { harnessRunEventSchemaV1, harnessRunSchemaV1 } from "./schemas";
import type { HarnessRunEventV1, HarnessRunState, HarnessRunV1 } from "./types";

interface RunRow { payload: HarnessRunV1; last_sequence: number | string; }

export class HarnessRunStoreV1 {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: HarnessRunV1): Promise<{ run: HarnessRunV1; replayed: boolean }> {
    const run = harnessRunSchemaV1.parse(input) as HarnessRunV1;
    assertNoSecretMaterial(run, "harness run");
    if (run.state !== "discovered") throw new Error("harness run must be created as discovered");
    return this.db.transaction(async (tx) => {
      const existing = await tx.query<RunRow>(`SELECT payload,last_sequence FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [run.tenantId, run.id]);
      if (existing.rows[0]) {
        if (sha256Digest(existing.rows[0].payload) !== sha256Digest(run)) throw new Error("harness run replay conflict");
        return { run: existing.rows[0].payload, replayed: true };
      }
      const attempt = await tx.query<{ state: string }>(`SELECT state FROM control_attempts WHERE tenant_id=$1 AND id=$2 AND job_id=$3 AND node_id=$4`, [run.tenantId,run.attemptId,run.jobId,run.nodeId]);
      if (!attempt.rows[0] || !["leased","running","waiting"].includes(attempt.rows[0].state)) throw new Error("harness run requires the bound active attempt and node");
      await this.assertLineage(tx, run);
      await tx.query(`INSERT INTO control_harness_runs (id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,parent_run_id,revision_of_run_id,state,payload,created_at,updated_at,last_observed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`, [run.id,run.tenantId,run.projectId,run.jobId,run.attemptId,run.nodeId,run.adapterId,run.harness,run.nativeSessionKeyDigest,run.parentRunId ?? null,run.revisionOfRunId ?? null,run.state,JSON.stringify(run),run.createdAt,run.updatedAt,run.lastObservedAt]);
      return { run, replayed: false };
    });
  }

  async append(input: HarnessRunEventV1): Promise<{ run: HarnessRunV1; replayed: boolean }> {
    const event = harnessRunEventSchemaV1.parse(input) as HarnessRunEventV1;
    assertNoSecretMaterial(event, "harness event");
    const eventDigest = sha256Digest(event);
    return this.db.transaction(async (tx) => {
      const current = await tx.query<RunRow>(`SELECT payload,last_sequence FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [event.tenantId,event.runId]);
      const row = current.rows[0];
      if (!row) throw new Error("harness run not found");
      const prior = await tx.query<{ event_digest: string }>(`SELECT event_digest FROM control_harness_run_events WHERE tenant_id=$1 AND run_id=$2 AND (sequence=$3 OR source_event_key_digest=$4)`, [event.tenantId,event.runId,event.sequence,event.sourceEventKeyDigest]);
      if (prior.rows[0]) {
        if (prior.rows[0].event_digest !== eventDigest) throw new Error("harness event replay conflict");
        return { run: row.payload, replayed: true };
      }
      const lastSequence = Number(row.last_sequence);
      if (event.sequence !== lastSequence + 1) throw new Error("harness event sequence gap");
      if (Date.parse(event.occurredAt) < Date.parse(row.payload.lastObservedAt)) throw new Error("harness event time regression");
      const nextState = event.payload.category === "lifecycle" ? event.payload.state
        : event.payload.category === "attention" && event.payload.state === "requested" ? (event.payload.attention === "approval" ? "waiting_approval" : "waiting_input")
        : event.payload.category === "transport" && event.payload.state === "disconnected" ? "disconnected"
        : row.payload.state;
      if (!canTransitionHarnessRun(row.payload.state, nextState)) throw new Error(`illegal harness run transition ${row.payload.state} -> ${nextState}`);
      const updated = this.updatedRun(row.payload, nextState, event);
      await tx.query(`INSERT INTO control_harness_run_events (tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,payload,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [event.tenantId,event.runId,event.sequence,event.occurredAt,event.source,event.sourceEventKeyDigest,eventDigest,JSON.stringify(event),event.occurredAt]);
      await tx.query(`UPDATE control_harness_runs SET state=$1,last_sequence=$2,payload=$3::jsonb,updated_at=$4,last_observed_at=$4 WHERE tenant_id=$5 AND id=$6`, [updated.state,event.sequence,JSON.stringify(updated),event.occurredAt,event.tenantId,event.runId]);
      return { run: updated, replayed: false };
    });
  }

  async get(tenantId: string, runId: string): Promise<HarnessRunV1 | undefined> {
    const result = await this.db.query<{ payload: HarnessRunV1 }>(`SELECT payload FROM control_harness_runs WHERE tenant_id=$1 AND id=$2`, [tenantId,runId]);
    return result.rows[0]?.payload;
  }

  async events(tenantId: string, runId: string, limit = 200): Promise<HarnessRunEventV1[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid harness event limit");
    const result = await this.db.query<{ payload: HarnessRunEventV1 }>(`SELECT payload FROM control_harness_run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence ASC LIMIT $3`, [tenantId,runId,limit]);
    return result.rows.map((row) => row.payload);
  }

  async watch(tenantId: string, limit = 100): Promise<HarnessRunV1[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("invalid session watch limit");
    const result = await this.db.query<{ payload: HarnessRunV1 }>(`SELECT payload FROM control_harness_runs WHERE tenant_id=$1 ORDER BY last_observed_at DESC,id ASC LIMIT $2`, [tenantId,limit]);
    return result.rows.map((row) => harnessRunSchemaV1.parse(row.payload) as HarnessRunV1);
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
