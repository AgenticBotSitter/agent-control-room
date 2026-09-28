import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { attemptRecordSchema, jobRecordSchema, requestRecordSchema, workflowRecordSchema } from "../../domain/v1";
import { verifyStoredHarnessRunV1, type StoredHarnessRunRowV1 } from "../../harness/v1/store";
import type { HarnessEventPayloadV1, HarnessRunState, HarnessRunV1 } from "../../harness/v1/types";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { catalogProjectIdSchema } from "./project-wire";
import { WebSessionAuthority } from "./session-authority";
import { SESSION_WATCH_EXPECTED_HEARTBEAT_MS_V1, SESSION_WATCH_PAGE_SIZE_V1,
  sessionWatchItemSchemaV1, sessionWatchPageSchemaV1, type SessionWatchItemV1 } from "./session-watch-wire";

type SessionWatchRow = {
  session_id: string;
  attempt_state: string;
  attempt_version: number | string;
  attempt_updated_at: string | Date;
  attempt_payload: unknown;
  job_id: string;
  job_state: string;
  job_version: number | string;
  project_id: string;
  workflow_id: string;
  job_payload: unknown;
  workflow_payload: unknown;
  request_payload: unknown;
  run_id: string | null;
  run_tenant_id: string | null;
  run_project_id: string | null;
  run_job_id: string | null;
  run_attempt_id: string | null;
  run_node_id: string | null;
  run_adapter_id: string | null;
  run_harness: string | null;
  run_native_session_key_digest: string | null;
  run_parent_run_id: string | null;
  run_revision_of_run_id: string | null;
  run_payload: HarnessRunV1 | null;
  run_last_sequence: number | string | null;
  run_digest: string | null;
  run_auth_tag: string | null;
  run_state: string | null;
  run_created_at: string | null;
  run_updated_at: string | null;
  run_last_observed_at: string | null;
  event_rows: StoredHarnessRunRowV1["event_rows"];
  selected_model: string | null;
  selected_effort: string | null;
};

function progressLabel(payload: HarnessEventPayloadV1 | undefined, state: HarnessRunState): string {
  if (!payload) return state.replaceAll("_", " ");
  if (payload.category === "native_snapshot") return `${payload.snapshot.state.replaceAll("_", " ")} · ${payload.snapshot.lastActivity.replaceAll("_", " ")}`;
  if (payload.category === "activity") return `${payload.activity} ${payload.phase}`;
  if (payload.category === "attention") return `${payload.attention} ${payload.state}`;
  if (payload.category === "transport") return `transport ${payload.state}`;
  if (payload.category === "lifecycle") return payload.state.replaceAll("_", " ");
  return "usage reported";
}

export function projectSessionWatchStateV1(input: Readonly<{ runState: HarnessRunState; jobState: string;
  lastObservedAt: string; observedAt: string }>): SessionWatchItemV1["state"] {
  if (input.runState === "succeeded" && input.jobState === "waiting_approval") return "waiting_for_review";
  const age = Date.parse(input.observedAt) - Date.parse(input.lastObservedAt);
  if (!Number.isFinite(age) || age < 0 || age > SESSION_WATCH_EXPECTED_HEARTBEAT_MS_V1
    || input.runState === "disconnected") return "stalled";
  if (input.runState === "waiting_approval" || input.jobState === "waiting_approval") return "waiting_for_review";
  if (input.runState === "waiting_input") return "blocked";
  return "running";
}

export function projectSessionWatchItemV1(input: Readonly<{ run: HarnessRunV1; event?: HarnessEventPayloadV1;
  eventAt?: string; jobState: string; taskTitle: string; attemptId: string; attemptNumber: number;
  worker: string | null; model: string | null; effort: string | null; observedAt: string }>): SessionWatchItemV1 {
  const started = input.run.startedAt ?? input.run.createdAt;
  const ended = input.run.finishedAt ?? input.observedAt;
  const durationSeconds = Math.max(0, Math.floor((Date.parse(ended) - Date.parse(started)) / 1000));
  return sessionWatchItemSchemaV1.parse({ sessionId: input.attemptId, runId: input.run.id, projectId: input.run.projectId, jobId: input.run.jobId,
    taskTitle: input.taskTitle, attemptId: input.attemptId, attemptNumber: input.attemptNumber, worker: input.worker,
    harness: input.run.harness, model: input.run.modelSelection?.model ?? input.model,
    effort: input.run.modelSelection?.effort ?? input.effort, stage: progressLabel(input.event, input.run.state),
    state: projectSessionWatchStateV1({ runState: input.run.state, jobState: input.jobState,
      lastObservedAt: input.run.lastObservedAt, observedAt: input.observedAt }), durationSeconds,
    lastProgressAt: input.eventAt ?? input.run.lastObservedAt, lastProgress: progressLabel(input.event, input.run.state),
    expectedHeartbeatSeconds: SESSION_WATCH_EXPECTED_HEARTBEAT_MS_V1 / 1000 });
}

function validateCanonical(row: SessionWatchRow, tenantId: string) {
  const attempt = attemptRecordSchema.parse(row.attempt_payload), job = jobRecordSchema.parse(row.job_payload);
  const workflow = workflowRecordSchema.parse(row.workflow_payload), request = requestRecordSchema.parse(row.request_payload);
  if (attempt.id !== row.session_id || attempt.jobId !== row.job_id || attempt.state !== row.attempt_state
    || attempt.version !== Number(row.attempt_version) || job.id !== row.job_id || job.state !== row.job_state
    || job.version !== Number(row.job_version) || job.projectId !== row.project_id || job.workflowId !== row.workflow_id
    || workflow.id !== row.workflow_id || workflow.projectId !== row.project_id || request.id !== workflow.requestId
    || request.projectId !== row.project_id || !workflow.jobIds.includes(job.id)
    || attempt.tenantId !== tenantId || job.tenantId !== tenantId || workflow.tenantId !== tenantId
    || request.tenantId !== tenantId) throw new Error("session_watch_lineage_unavailable");
  return { attempt, request };
}

/** Owner-only, workspace-wide projection over signed saved run evidence. It has no command port. */
export class SessionWatchServiceV1 {
  private readonly authority: WebSessionAuthority;
  private readonly key?: Uint8Array;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    harnessIntegrityKey?: Uint8Array, private readonly clock: () => number = Date.now) {
    this.authority = new WebSessionAuthority(db, scope, clock, "session_watch");
    if (harnessIntegrityKey !== undefined && (!(harnessIntegrityKey instanceof Uint8Array) || harnessIntegrityKey.length !== 32))
      throw new Error("session_watch_key_invalid");
    this.key = harnessIntegrityKey ? Uint8Array.from(harnessIntegrityKey) : undefined;
  }

  private authenticated<T>(identity: VerifiedWebIdentity, operation: (tx: DatabaseSession, now: string) => Promise<T>) {
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", undefined, true);
      actor.require("projects.read", undefined, true);
      return operation(tx, actor.now);
    }, { readOnly: true });
  }

  async authorize(identity: VerifiedWebIdentity): Promise<void> {
    await this.authenticated(identity, async () => undefined);
  }

  async read(identity: VerifiedWebIdentity, after?: string) {
    if (after !== undefined && !catalogProjectIdSchema.safeParse(after).success) throw new WebAccessError("invalid_request");
    return this.authenticated(identity, async (tx, observedAt) => {
      if (!this.key) return sessionWatchPageSchemaV1.parse({ source: "not_configured", sessions: [], nextCursor: null,
        observedAt, startsWork: false });
      if (after !== undefined) {
        const cursor = await tx.query(`SELECT 1 FROM control_attempts a
          JOIN control_jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
          JOIN projects p ON p.tenant_id=j.tenant_id AND p.id=j.project_id AND p.workspace_id=$2
          WHERE a.tenant_id=$1 AND a.id=$3`, [this.scope.tenantId, this.scope.workspaceId, after]);
        if (cursor.rows.length !== 1) throw new WebAccessError("invalid_request");
      }
      const rows = (await tx.query<SessionWatchRow>(`WITH cursor AS (
          SELECT COALESCE(cr.last_observed_at,ca.updated_at) AS observed_at,ca.id FROM control_attempts ca
          JOIN control_jobs cj ON cj.tenant_id=ca.tenant_id AND cj.id=ca.job_id
          JOIN projects cp ON cp.tenant_id=cj.tenant_id AND cp.id=cj.project_id AND cp.workspace_id=$2
          LEFT JOIN LATERAL (SELECT last_observed_at FROM control_harness_runs
            WHERE tenant_id=ca.tenant_id AND attempt_id=ca.id ORDER BY created_at DESC,id DESC LIMIT 1) cr ON true
          WHERE ca.tenant_id=$1 AND ca.id=$3
        ) SELECT a.id AS session_id,a.state AS attempt_state,a.version AS attempt_version,a.updated_at AS attempt_updated_at,
          a.payload AS attempt_payload,j.id AS job_id,j.state AS job_state,j.version AS job_version,j.project_id,
          j.workflow_id,j.payload AS job_payload,w.payload AS workflow_payload,q.payload AS request_payload,
          r.id AS run_id,r.tenant_id AS run_tenant_id,r.project_id AS run_project_id,r.job_id AS run_job_id,
          r.attempt_id AS run_attempt_id,r.node_id AS run_node_id,r.adapter_id AS run_adapter_id,r.harness AS run_harness,
          r.native_session_key_digest AS run_native_session_key_digest,r.parent_run_id AS run_parent_run_id,
          r.revision_of_run_id AS run_revision_of_run_id,r.payload AS run_payload,r.last_sequence AS run_last_sequence,
          r.run_digest,r.run_auth_tag,r.state AS run_state,r.created_at AS run_created_at,r.updated_at AS run_updated_at,
          r.last_observed_at AS run_last_observed_at,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('tenant_id',e.tenant_id,'run_id',e.run_id,'sequence',e.sequence,
            'occurred_at',e.occurred_at,'source',e.source,'source_event_key_digest',e.source_event_key_digest,
            'event_digest',e.event_digest,'event_auth_tag',e.event_auth_tag,'payload',e.payload,'recorded_at',e.recorded_at)
            ORDER BY e.sequence) FROM (SELECT * FROM control_harness_run_events re WHERE re.tenant_id=r.tenant_id
              AND re.run_id=r.id ORDER BY re.sequence LIMIT 1025) e),'[]'::jsonb) AS event_rows,
          m.model AS selected_model,m.effort AS selected_effort
        FROM control_attempts a
        JOIN control_jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
        JOIN control_workflows w ON w.tenant_id=j.tenant_id AND w.id=j.workflow_id AND w.project_id=j.project_id
        JOIN control_requests q ON q.tenant_id=w.tenant_id AND q.id=w.request_id AND q.project_id=j.project_id
        JOIN projects p ON p.tenant_id=j.tenant_id AND p.id=j.project_id AND p.workspace_id=$2
        LEFT JOIN LATERAL (SELECT * FROM control_harness_runs hr WHERE hr.tenant_id=a.tenant_id AND hr.attempt_id=a.id
          ORDER BY hr.created_at DESC,hr.id DESC LIMIT 1) r ON true
        LEFT JOIN control_task_model_selections m ON m.tenant_id=a.tenant_id AND m.job_id=a.job_id
        WHERE a.tenant_id=$1 AND ((r.id IS NULL AND a.state IN ('running','waiting'))
          OR r.state IN ('discovered','starting','running','waiting_input','waiting_approval','cancelling','disconnected')
          OR (r.state='succeeded' AND j.state='waiting_approval'))
          AND ($3::text IS NULL OR (COALESCE(r.last_observed_at,a.updated_at),a.id) <
            ((SELECT observed_at FROM cursor),(SELECT id FROM cursor)))
        ORDER BY COALESCE(r.last_observed_at,a.updated_at) DESC,a.id DESC LIMIT $4`, [this.scope.tenantId, this.scope.workspaceId, after ?? null,
        SESSION_WATCH_PAGE_SIZE_V1 + 1])).rows;
      const sessions: SessionWatchItemV1[] = [];
      for (const row of rows.slice(0, SESSION_WATCH_PAGE_SIZE_V1)) {
        const { attempt, request } = validateCanonical(row, this.scope.tenantId);
        if (!row.run_id) {
          const started = attempt.startedAt ?? attempt.offeredAt;
          sessions.push(sessionWatchItemSchemaV1.parse({ sessionId: attempt.id, runId: null, projectId: row.project_id,
            jobId: row.job_id, taskTitle: request.title, attemptId: attempt.id, attemptNumber: attempt.attemptNumber,
            worker: attempt.workerId ?? null, harness: null, model: row.selected_model, effort: row.selected_effort,
            stage: "run evidence unavailable", state: "stalled",
            durationSeconds: Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(started)) / 1000)),
            lastProgressAt: new Date(row.attempt_updated_at).toISOString(), lastProgress: `canonical attempt ${attempt.state}`,
            expectedHeartbeatSeconds: SESSION_WATCH_EXPECTED_HEARTBEAT_MS_V1 / 1000 }));
          continue;
        }
        if (row.event_rows.length > 1024) throw new Error("session_watch_event_history_unavailable");
        const stored: StoredHarnessRunRowV1 = { id: row.run_id, tenant_id: row.run_tenant_id!, project_id: row.run_project_id!,
          job_id: row.run_job_id!, attempt_id: row.run_attempt_id!, node_id: row.run_node_id!, adapter_id: row.run_adapter_id!,
          harness: row.run_harness!, native_session_key_digest: row.run_native_session_key_digest!,
          parent_run_id: row.run_parent_run_id, revision_of_run_id: row.run_revision_of_run_id, payload: row.run_payload!,
          last_sequence: row.run_last_sequence!, run_digest: row.run_digest!, run_auth_tag: row.run_auth_tag!, state: row.run_state!,
          created_at: row.run_created_at!, updated_at: row.run_updated_at!, last_observed_at: row.run_last_observed_at!,
          event_rows: row.event_rows };
        const run = verifyStoredHarnessRunV1(stored, this.key);
        if (run.attemptId !== attempt.id || run.jobId !== row.job_id || run.projectId !== row.project_id
          || run.nodeId !== attempt.nodeId) throw new Error("session_watch_lineage_unavailable");
        const latest = row.event_rows.at(-1)?.payload;
        sessions.push(projectSessionWatchItemV1({ run, event: latest?.payload, eventAt: latest?.occurredAt,
          jobState: row.job_state, taskTitle: request.title, attemptId: attempt.id, attemptNumber: attempt.attemptNumber,
          worker: attempt.workerId ?? null, model: row.selected_model, effort: row.selected_effort, observedAt }));
      }
      return sessionWatchPageSchemaV1.parse({ source: "configured", sessions,
        nextCursor: rows.length > SESSION_WATCH_PAGE_SIZE_V1 ? rows[SESSION_WATCH_PAGE_SIZE_V1 - 1]!.session_id : null,
        observedAt, startsWork: false });
    });
  }
}
