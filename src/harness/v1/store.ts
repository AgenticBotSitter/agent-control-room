import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { canTransitionHarnessRun, isTerminalHarnessRunState } from "./lifecycle";
import { harnessRunEventSchemaV1, harnessRunSchemaV1 } from "./schemas";
import type { HarnessRunEventV1, HarnessRunState, HarnessRunV1 } from "./types";
import { assertNativeSnapshotProgress, nativeTaskSnapshotBodySchema, type NativeTaskSnapshotBody } from "./native-observation";
import type { UsageRollupGroupV1 } from "../../usage/v1/usage-cost";

export interface StoredHarnessRunEventRowV1 {
  tenant_id: string; run_id: string; sequence: number | string; occurred_at: string | Date; source: string;
  source_event_key_digest: string; event_digest: string; event_auth_tag: string; payload: HarnessRunEventV1; recorded_at: string | Date;
}
export interface StoredHarnessRunRowV1 {
  id: string; tenant_id: string; project_id: string; job_id: string; attempt_id: string; node_id: string; adapter_id: string;
  harness: string; native_session_key_digest: string; parent_run_id: string | null; revision_of_run_id: string | null;
  payload: HarnessRunV1; last_sequence: number | string; run_digest: string; run_auth_tag: string; state: string;
  created_at: string | Date; updated_at: string | Date; last_observed_at: string | Date; event_rows: StoredHarnessRunEventRowV1[];
}

export const harnessRunProjectionV1 = (alias = "r") => `${alias}.id,${alias}.tenant_id,${alias}.project_id,${alias}.job_id,${alias}.attempt_id,${alias}.node_id,${alias}.adapter_id,${alias}.harness,
  ${alias}.native_session_key_digest,${alias}.parent_run_id,${alias}.revision_of_run_id,${alias}.payload,${alias}.last_sequence,${alias}.run_digest,${alias}.run_auth_tag,
  ${alias}.state,${alias}.created_at,${alias}.updated_at,${alias}.last_observed_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('tenant_id',e.tenant_id,'run_id',e.run_id,'sequence',e.sequence,
    'occurred_at',e.occurred_at,'source',e.source,'source_event_key_digest',e.source_event_key_digest,
    'event_digest',e.event_digest,'event_auth_tag',e.event_auth_tag,'payload',e.payload,'recorded_at',e.recorded_at)
    ORDER BY e.sequence) FROM control_harness_run_events e WHERE e.tenant_id=${alias}.tenant_id AND e.run_id=${alias}.id),'[]'::jsonb) AS event_rows`;

function iso(value: string | Date): string { return new Date(value).toISOString(); }

function runAuthMaterial(row: Omit<StoredHarnessRunRowV1,"event_rows"|"run_auth_tag">): Record<string,unknown> {
  return { id:row.id,tenantId:row.tenant_id,projectId:row.project_id,jobId:row.job_id,attemptId:row.attempt_id,nodeId:row.node_id,
    adapterId:row.adapter_id,harness:row.harness,nativeSessionKeyDigest:row.native_session_key_digest,parentRunId:row.parent_run_id,
    revisionOfRunId:row.revision_of_run_id,state:row.state,lastSequence:Number(row.last_sequence),runDigest:row.run_digest,
    createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),lastObservedAt:iso(row.last_observed_at) };
}

function eventAuthMaterial(row: Omit<StoredHarnessRunEventRowV1,"event_auth_tag">): Record<string,unknown> {
  return { tenantId:row.tenant_id,runId:row.run_id,sequence:Number(row.sequence),occurredAt:iso(row.occurred_at),source:row.source,
    sourceEventKeyDigest:row.source_event_key_digest,eventDigest:row.event_digest,recordedAt:iso(row.recorded_at) };
}

function verifiedEvent(row: StoredHarnessRunEventRowV1, integrityKey: Uint8Array): HarnessRunEventV1 {
  const event = harnessRunEventSchemaV1.parse(row.payload) as HarnessRunEventV1;
  const material = eventAuthMaterial(row);
  if (sha256Digest(event) !== row.event_digest || hmacSha256Tag(integrityKey,material) !== row.event_auth_tag
    || event.tenantId!==row.tenant_id || event.runId!==row.run_id || event.sequence!==Number(row.sequence)
    || event.occurredAt!==iso(row.occurred_at) || event.source!==row.source || event.sourceEventKeyDigest!==row.source_event_key_digest
    || iso(row.recorded_at)!==event.occurredAt) throw new Error("harness event integrity failure");
  return event;
}

export function verifyStoredHarnessRunV1(row: StoredHarnessRunRowV1, integrityKey: Uint8Array): HarnessRunV1 {
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
      const existing = await tx.query<StoredHarnessRunRowV1>(`SELECT ${harnessRunProjectionV1()} FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE`, [run.tenantId, run.id]);
      if (existing.rows[0]) {
        const verified = verifyStoredHarnessRunV1(existing.rows[0],this.integrityKey);
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
      const row = (await tx.query<StoredHarnessRunRowV1>(`SELECT ${harnessRunProjectionV1()} FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE`, [tenantId, snapshot.runId])).rows[0];
      if (!row) throw new Error("native task not registered");
      const run = verifyStoredHarnessRunV1(row, this.integrityKey), registration = run.nativeTask;
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
      const current = await tx.query<StoredHarnessRunRowV1>(`SELECT ${harnessRunProjectionV1()} FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE`, [event.tenantId,event.runId]);
      const row = current.rows[0];
      if (!row) throw new Error("harness run not found");
      const run = verifyStoredHarnessRunV1(row,this.integrityKey);
      if (Boolean(run.nativeTask) !== native) throw new Error("native and legacy observation paths cannot be mixed");
      if (run.remoteTask && !native) throw new Error("remote task observations require private remote ingestion");
      const prior = await tx.query<StoredHarnessRunEventRowV1>(`SELECT tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,event_auth_tag,payload,recorded_at FROM control_harness_run_events WHERE tenant_id=$1 AND run_id=$2 AND (sequence=$3 OR source_event_key_digest=$4)`, [event.tenantId,event.runId,event.sequence,event.sourceEventKeyDigest]);
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
    const result = await this.db.query<StoredHarnessRunRowV1>(`SELECT ${harnessRunProjectionV1()} FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=$2`, [tenantId,runId]);
    return result.rows[0] ? verifyStoredHarnessRunV1(result.rows[0],this.integrityKey) : undefined;
  }

  /** A single SQL snapshot verifies the run and its history together. Presentation may omit older
   * points only after full existing integrity verification; it must not mix two observation revisions. */
  async inspect(tenantId: string, runId: string): Promise<{ run: HarnessRunV1; events: HarnessRunEventV1[] } | undefined> {
    const row = (await this.db.query<StoredHarnessRunRowV1>(`SELECT ${harnessRunProjectionV1()} FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=$2`,
      [tenantId, runId])).rows[0];
    return row ? { run: verifyStoredHarnessRunV1(row, this.integrityKey), events: row.event_rows.map(event => verifiedEvent(event, this.integrityKey)) } : undefined;
  }

  /** Fixed-query equivalent of inspect for bounded presentation reads. */
  async inspectMany(tenantId: string, runIds: readonly string[]): Promise<ReadonlyMap<string,
    { run: HarnessRunV1; events: HarnessRunEventV1[] }>> {
    const ids = [...new Set(runIds)];
    if (!ids.length) return new Map();
    const rows = (await this.db.query<StoredHarnessRunRowV1>(`SELECT ${harnessRunProjectionV1()}
      FROM control_harness_runs r WHERE r.tenant_id=$1 AND r.id=ANY($2::text[]) ORDER BY r.id COLLATE "C"`,
    [tenantId, ids])).rows;
    const requested = new Set(ids), output = new Map<string, { run: HarnessRunV1; events: HarnessRunEventV1[] }>();
    for (const row of rows) {
      if (!requested.has(row.id) || output.has(row.id)) throw new Error("harness run integrity failure");
      const run = verifyStoredHarnessRunV1(row, this.integrityKey);
      output.set(row.id, { run, events: row.event_rows.map(event => verifiedEvent(event, this.integrityKey)) });
    }
    return output;
  }

  /** One bounded query for task-detail attempt histories. */
  async inspectAttempts(tenantId: string, projectId: string, jobId: string,
    attemptIds: readonly string[]): Promise<ReadonlyMap<string, readonly { run: HarnessRunV1; events: HarnessRunEventV1[] }[]>> {
    const ids = [...new Set(attemptIds)];
    if (!ids.length) return new Map();
    const rows = (await this.db.query<StoredHarnessRunRowV1>(`SELECT ${harnessRunProjectionV1()}
      FROM unnest($4::text[]) WITH ORDINALITY wanted(attempt_id,attempt_order)
      CROSS JOIN LATERAL (SELECT candidate.* FROM control_harness_runs candidate
        WHERE candidate.tenant_id=$1 AND candidate.project_id=$2 AND candidate.job_id=$3
          AND candidate.attempt_id=wanted.attempt_id
        ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 11) r
      ORDER BY wanted.attempt_order,r.created_at DESC,r.id DESC`, [tenantId, projectId, jobId, ids])).rows;
    const requested = new Set(ids), output = new Map<string, { run: HarnessRunV1; events: HarnessRunEventV1[] }[]>();
    for (const row of rows) {
      const run = verifyStoredHarnessRunV1(row, this.integrityKey);
      if (!requested.has(run.attemptId) || run.tenantId !== tenantId || run.projectId !== projectId || run.jobId !== jobId)
        throw new Error("harness run integrity failure");
      const values = output.get(run.attemptId) ?? [];
      if (values.some(value => value.run.id === run.id)) throw new Error("harness run integrity failure");
      values.push({ run, events: row.event_rows.map(event => verifiedEvent(event, this.integrityKey)) });
      output.set(run.attemptId, values);
    }
    return output;
  }

  /** Bounded, exact usage aggregation source for a whole scope.
   *
   * The page displays a bounded number of runs, but its TOTALS must cover every
   * run in scope, so the totals cannot be summed from a bounded row set — and
   * reading every run to sum them is exactly the unbounded read this replaces
   * (see the #412 review). So the summation happens in PostgreSQL and the
   * application receives one row per distinct pricing shape, never one row per
   * run.
   *
   * The grouping key is every value that decides a run's pricing BRANCH:
   * attempt, harness, model, the nullness of each token field, whether any
   * cached tokens were reported, and whether any billable input count is
   * negative (which forces the `partial_token_usage` refusal the per-run path
   * returns). Token MAGNITUDES are deliberately NOT in the key: within a group
   * the cost is linear in the sums, so pricing one representative branch and
   * applying its rates to the group's sums is exact rather than an average
   * multiplied back by a count. See `rollupUsageGroupsV1`.
   *
   * The bound is therefore a function of the priceable shapes, not of history:
   * `attempts x 4 harnesses x the project's models x 2^5 shape flags`. It does
   * not grow as runs accumulate.
   *
   * Two details of the stored shape this has to respect, both measured on a real
   * cluster rather than assumed:
   *   - `control_harness_run_events.payload` holds the WHOLE event record, so the
   *     event's own `category` is at `payload->'payload'->>'category'`;
   *   - `EXTRACT(EPOCH FROM ...)` needs the timestamp DIFFERENCE parenthesised,
   *     not each operand, or the statement is a syntax error.
   *
   * Read amplification is what this defends, so the rows it returns carry no
   * event payload and are not digest-verified here: verified rows stay on the
   * presentation path (`inspectAttempts`), which is unchanged.
   */
  async inspectUsageRollup(tenantId: string, projectId: string, jobId?: string):
    Promise<readonly UsageRollupGroupV1[]> {
    const parameters: unknown[] = [tenantId, projectId];
    const job = jobId === undefined ? "" : ` AND r.job_id=$${parameters.push(jobId)} `;
    const rows = (await this.db.query<{ attempt_id: string; harness: string; model: string | null;
      runs: string | number; input_tokens: string | null;
      billable_input_tokens: string | null; output_tokens: string | null; total_tokens: string | null;
      wall_time_ms: string | null; cached_input_tokens: string | null; negative_billable_runs: string | number }>(
      `WITH scoped AS (
         SELECT r.attempt_id,r.harness,r.payload->'modelSelection'->>'model' AS model,
           u.input_tokens,u.output_tokens,u.total_tokens,u.wall_time_ms,u.cached_input_tokens
         FROM control_harness_runs r
         LEFT JOIN LATERAL (
           -- The same precedence the application applies: the LAST usage event,
           -- else the LAST native snapshot carrying usage, else nothing. One
           -- LATERAL row per run (LIMIT 1), never one row per event.
           SELECT
             CASE WHEN e.payload->'payload'->>'category'='usage'
               THEN (e.payload->'payload'->>'inputTokens')::bigint
               ELSE (e.payload->'payload'->'snapshot'->'usage'->>'inputTokens')::bigint END AS input_tokens,
             CASE WHEN e.payload->'payload'->>'category'='usage'
               THEN (e.payload->'payload'->>'outputTokens')::bigint
               ELSE (e.payload->'payload'->'snapshot'->'usage'->>'outputTokens')::bigint END AS output_tokens,
             CASE WHEN e.payload->'payload'->>'category'='usage'
               THEN COALESCE((e.payload->'payload'->>'totalTokens')::bigint,
                   CASE WHEN (e.payload->'payload'->>'inputTokens')::bigint IS NOT NULL
                       AND (e.payload->'payload'->>'outputTokens')::bigint IS NOT NULL
                     THEN (e.payload->'payload'->>'inputTokens')::bigint
                        +(e.payload->'payload'->>'outputTokens')::bigint END)
               ELSE (e.payload->'payload'->'snapshot'->'usage'->>'totalTokens')::bigint END AS total_tokens,
             -- Wall time is the event's own when it reports one, else the run's
             -- observed duration. One expression covers both shapes: a usage
             -- event may omit wallTimeMs, and a native snapshot never carries
             -- one, so both fall through to the duration the application
             -- computes from startedAt/finishedAt.
             COALESCE((e.payload->'payload'->>'wallTimeMs')::bigint,
               CASE WHEN r.payload->>'startedAt' IS NOT NULL AND r.payload->>'finishedAt' IS NOT NULL
                 THEN (EXTRACT(EPOCH FROM ((r.payload->>'finishedAt')::timestamptz
                       -(r.payload->>'startedAt')::timestamptz))*1000)::bigint END) AS wall_time_ms,
             CASE WHEN e.payload->'payload'->>'category'='usage'
               THEN COALESCE((e.payload->'payload'->>'cachedInputTokens')::bigint,0)
               ELSE 0 END AS cached_input_tokens
           FROM control_harness_run_events e WHERE e.tenant_id=r.tenant_id AND e.run_id=r.id
             AND (e.payload->'payload'->>'category'='usage'
               OR (e.payload->'payload'->>'category'='native_snapshot'
                 AND e.payload->'payload'->'snapshot'->'usage' IS NOT NULL))
           ORDER BY (e.payload->'payload'->>'category'='usage') DESC,e.sequence DESC LIMIT 1
         ) u ON true
         WHERE r.tenant_id=$1 AND r.project_id=$2${job}
       ), resolved AS (
         -- A run with no usage event and no native usage still reports wall time
         -- when it started and finished; every other field stays null, which is
         -- exactly what the application's own evidence reader produced for it.
         SELECT attempt_id,harness,model,
           input_tokens,
           output_tokens,
           COALESCE(total_tokens,CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL
             THEN input_tokens+output_tokens END) AS total_tokens,
           wall_time_ms,
           cached_input_tokens
         FROM scoped
       )
       SELECT attempt_id,harness,model,count(*)::text AS runs,
         CASE WHEN count(*) FILTER (WHERE input_tokens IS NULL)=0 THEN sum(input_tokens)::text END AS input_tokens,
         CASE WHEN count(*) FILTER (WHERE input_tokens IS NULL)=0 THEN
           sum(input_tokens-(CASE WHEN harness='codex' THEN cached_input_tokens ELSE 0 END))::text END AS billable_input_tokens,
         CASE WHEN count(*) FILTER (WHERE output_tokens IS NULL)=0 THEN sum(output_tokens)::text END AS output_tokens,
         CASE WHEN count(*) FILTER (WHERE total_tokens IS NULL)=0 THEN sum(total_tokens)::text END AS total_tokens,
         CASE WHEN count(*) FILTER (WHERE wall_time_ms IS NULL)=0 THEN sum(wall_time_ms)::text END AS wall_time_ms,
         sum(cached_input_tokens)::text AS cached_input_tokens,
         count(*) FILTER (WHERE harness='codex' AND input_tokens-cached_input_tokens<0)::text AS negative_billable_runs
       FROM resolved GROUP BY attempt_id,harness,model,input_tokens IS NULL,output_tokens IS NULL,
         total_tokens IS NULL,wall_time_ms IS NULL,cached_input_tokens>0,
         (harness<>'codex' OR input_tokens IS NULL OR input_tokens-cached_input_tokens>=0)`,
      parameters)).rows;
    return rows.map(row => ({
      attemptId: row.attempt_id,
      harness: row.harness as UsageRollupGroupV1["harness"],
      model: row.model, runs: Number(row.runs), inputTokens: row.input_tokens,
      billableInputTokens: row.billable_input_tokens,
      outputTokens: row.output_tokens, totalTokens: row.total_tokens, wallTimeMs: row.wall_time_ms,
      cachedInputTokens: row.cached_input_tokens ?? "0", negativeBillableRuns: Number(row.negative_billable_runs) }));
  }

  async events(tenantId: string, runId: string, limit = 200): Promise<HarnessRunEventV1[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid harness event limit");
    const run=await this.get(tenantId,runId); if (!run) return [];
    const result = await this.db.query<StoredHarnessRunEventRowV1>(`SELECT tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,event_auth_tag,payload,recorded_at FROM control_harness_run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence ASC LIMIT $3`, [tenantId,runId,limit]);
    return result.rows.map((row)=>verifiedEvent(row,this.integrityKey));
  }

  async watch(tenantId: string, limit = 100): Promise<HarnessRunV1[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("invalid session watch limit");
    const result = await this.db.query<StoredHarnessRunRowV1>(`SELECT ${harnessRunProjectionV1()} FROM control_harness_runs r WHERE r.tenant_id=$1 ORDER BY r.last_observed_at DESC,r.id ASC LIMIT $2`, [tenantId,limit]);
    return result.rows.map((row)=>verifyStoredHarnessRunV1(row,this.integrityKey));
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
