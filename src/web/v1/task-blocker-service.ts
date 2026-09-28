import { timingSafeEqual } from "node:crypto";
import { attemptRecordSchema, jobRecordSchema, leaseRecordSchema, requestRecordSchema, workflowRecordSchema } from "../../domain/v1";
import { OperatorSurfaceStoreV1 } from "../../operator-surfaces/v1/store";
import type { ActionInboxItemV1 } from "../../operator-surfaces/v1/types";
import { CanonicalStore } from "../../persistence/canonical-store";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { appendAuditWith } from "../../audit/audit-store";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { WebProjectService } from "./project-service";
import { WebSessionAuthority } from "./session-authority";
import { taskBlockerOwnerActionSchema, taskBlockerRecordSchema, taskBlockerReportSchema,
  type TaskBlockerOwnerActionV1, type TaskBlockerRecordV1, type TaskBlockerReportV1 } from "./task-blocker-wire";
import type { TaskAssignmentOperation } from "./task-assignment-coordinator";

type BlockerRow = { payload: unknown; auth_tag: string; disposition_digest: string | null };

const unavailable = (): never => { throw new Error("task_blocker_unavailable"); };
const conflict = (): never => { throw new WebAccessError("conflict"); };
const joined = (tx: DatabaseSession): DatabaseClient => Object.freeze({ query: tx.query.bind(tx),
  transaction: async <T>(run: (session: DatabaseSession) => Promise<T>) => run(tx),
  transactionWithPreCommitCheck: async <T>(run: (session: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) => {
    const result = await run(tx); await check(); return result;
  } });

/** Durable blocker state and linked-work hand-off. Reporting is an internal worker operation;
 * browser callers receive only the separately authenticated owner action boundary. */
export class TaskBlockerServiceV1 {
  private readonly key: Uint8Array;
  private readonly projects: WebProjectService;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    integrityKey: Uint8Array, private readonly clock: () => number = Date.now,
    private readonly handoffAssign?: TaskAssignmentOperation["assign"]) {
    if (!(integrityKey instanceof Uint8Array) || integrityKey.byteLength !== 32) unavailable();
    this.key = Uint8Array.from(integrityKey);
    this.projects = new WebProjectService(db, scope, clock);
  }
  webOperation() {
    return Object.freeze({ ...this.scope, report: this.report.bind(this), listOpenForOwner: this.listOpenForOwner.bind(this),
      readForWorker: this.readForWorker.bind(this), act: this.act.bind(this) });
  }
  private tag(record: TaskBlockerRecordV1) {
    return hmacSha256Tag(this.key, { purpose: "task-blocker/v1", record });
  }
  private parse(row: BlockerRow | undefined): TaskBlockerRecordV1 {
    if (!row) return unavailable();
    const record = taskBlockerRecordSchema.parse(row.payload);
    const expected = Buffer.from(this.tag(record)), actual = Buffer.from(row.auth_tag);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return unavailable();
    assertNoSecretMaterial(record, "task blocker");
    return record;
  }
  private attention(record: TaskBlockerRecordV1, state: "open" | "resolved"): ActionInboxItemV1 {
    const kind = record.kind === "owner_decision" ? "question" as const
      : record.kind === "environment_broken" ? "failure" as const : "ambiguity" as const;
    return {
      id: `attention:blocker:${sha256Digest({ tenantId: this.scope.tenantId, blockerId: record.blockerId }).slice(7, 39)}`,
      tenantId: this.scope.tenantId, ownerIdentityId: record.taskOwnerId, projectId: record.projectId, workItemId: record.jobId,
      kind, state, requestedAction: state === "open" ? record.summary : "Task blocker was resolved by its owner",
      reasonCode: state === "open" ? `task_blocker_${record.kind}` : "task_blocker_resolved",
      blockedWorkItemIds: state === "open" ? [record.jobId] : [],
      legalResponses: [
        { id: "response.blocker.unblock", kind: "record_decision", label: "Answer and resume this task", requiresConfirmation: true, available: state === "open",
          ...(state === "open" ? {} : { unavailableReasonCode: "blocker_closed" }) },
        { id: "response.blocker.handoff", kind: "request_retry", label: "Hand off as linked work", requiresConfirmation: true, available: state === "open",
          ...(state === "open" ? {} : { unavailableReasonCode: "blocker_closed" }) },
        { id: "response.blocker.cancel", kind: "decline", label: "Cancel this task", requiresConfirmation: true, available: state === "open",
          ...(state === "open" ? {} : { unavailableReasonCode: "blocker_closed" }) },
      ],
      evidence: record.evidence.map((entry, index) => ({
        id: `audit:blocker-evidence:${sha256Digest({ blockerId: record.blockerId, index, entry }).slice(7, 39)}`,
        kind: "audit" as const, digest: sha256Digest(entry), observedAt: record.reportedAt,
      })),
      createdAt: record.reportedAt, deliveryState: "not_requested",
    };
  }
  private async current(tx: DatabaseSession, report: Pick<TaskBlockerReportV1, "jobId" | "attemptId" | "projectId">) {
    const jobRow = (await tx.query<{ payload: unknown; state: string; version: number }>(
      "SELECT payload,state,version FROM control_jobs WHERE tenant_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",
      [this.scope.tenantId, report.projectId, report.jobId])).rows[0];
    const attemptRow = (await tx.query<{ payload: unknown; state: string; version: number }>(
      "SELECT payload,state,version FROM control_attempts WHERE tenant_id=$1 AND job_id=$2 AND id=$3 FOR UPDATE",
      [this.scope.tenantId, report.jobId, report.attemptId])).rows[0];
    const leaseRow = (await tx.query<{ payload: unknown; state: string; version: number }>(`SELECT payload,state,version
      FROM control_leases WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3 ORDER BY epoch DESC LIMIT 1 FOR UPDATE`,
    [this.scope.tenantId, report.jobId, report.attemptId])).rows[0];
    if (!jobRow || !attemptRow || !leaseRow) return unavailable();
    const job = jobRecordSchema.parse(jobRow.payload), attempt = attemptRecordSchema.parse(attemptRow.payload), lease = leaseRecordSchema.parse(leaseRow.payload);
    if (job.state !== jobRow.state || job.version !== Number(jobRow.version) || attempt.state !== attemptRow.state
      || attempt.version !== Number(attemptRow.version) || lease.state !== leaseRow.state || lease.version !== Number(leaseRow.version)
      || job.tenantId !== this.scope.tenantId || attempt.tenantId !== this.scope.tenantId || lease.tenantId !== this.scope.tenantId
      || job.projectId !== report.projectId || attempt.jobId !== job.id || lease.jobId !== job.id || lease.attemptId !== attempt.id
      || lease.nodeId !== attempt.nodeId || lease.epoch !== attempt.leaseEpoch) return unavailable();
    return { job, attempt, lease };
  }
  async listOpenForOwner(identity: VerifiedWebIdentity, jobIds: readonly string[]) {
    if (jobIds.length > 25 || new Set(jobIds).size !== jobIds.length
      || jobIds.some(id => !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/.test(id))) return unavailable();
    if (!jobIds.length) return [];
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      const rows = (await tx.query<BlockerRow & { project_id: string }>(`SELECT payload,auth_tag,disposition_digest,project_id
        FROM control_task_blockers WHERE tenant_id=$1 AND task_owner_id=$2 AND state IN ('open','handoff_pending') AND job_id=ANY($3::text[])
        ORDER BY job_id,id`, [this.scope.tenantId, actor.id, jobIds])).rows;
      for (const row of rows) actor.require("tasks.read", row.project_id, true);
      await this.projects.getViewsInSession(tx, actor, rows.map(row => row.project_id));
      return rows.map(row => this.parse(row));
    }, { readOnly: true });
  }
  async readForWorker(blockerId: string, workerId: string, assertCurrent: () => void | Promise<void>) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/.test(blockerId)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/.test(workerId) || typeof assertCurrent !== "function") return unavailable();
    await assertCurrent();
    return this.db.transactionWithPreCommitCheck(async tx => {
      const row = (await tx.query<BlockerRow>(`SELECT payload,auth_tag,disposition_digest FROM control_task_blockers
        WHERE tenant_id=$1 AND id=$2`, [this.scope.tenantId, blockerId])).rows[0];
      const blocker = this.parse(row);
      if (blocker.workerId !== workerId || !["open", "resolved", "cancelled"].includes(blocker.state)) return unavailable();
      return blocker;
    }, assertCurrent);
  }
  async report(value: TaskBlockerReportV1, assertCurrent: () => void | Promise<void>) {
    const report = taskBlockerReportSchema.parse(value); assertNoSecretMaterial(report, "task blocker report");
    const reportedAt = Date.parse(report.reportedAt), now = this.clock();
    if (!Number.isSafeInteger(reportedAt) || reportedAt > now || now - reportedAt > 10_000) conflict();
    const { expectedJobVersion: _expectedJobVersion, expectedAttemptVersion: _expectedAttemptVersion, ...reportRecord } = report;
    if (report.projectId !== value.projectId || typeof assertCurrent !== "function") return unavailable();
    await assertCurrent();
    return this.db.transactionWithPreCommitCheck(async tx => {
      await assertCurrent();
      const prior = (await tx.query<BlockerRow>("SELECT payload,auth_tag,disposition_digest FROM control_task_blockers WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.tenantId, report.blockerId])).rows[0];
      if (prior) {
        const blocker = this.parse(prior);
        const expected = taskBlockerRecordSchema.parse({ ...reportRecord, schema: "control-room.task-blocker/v1", state: "open",
          resumeJobState: blocker.resumeJobState, resumeAttemptState: blocker.resumeAttemptState,
          taskOwnerId: blocker.taskOwnerId, startsWork: false, grantsExecutionAuthority: false });
        if (sha256Digest(blocker) !== sha256Digest(expected)) conflict();
        return { blocker, replayed: true };
      }
      const { job, attempt, lease } = await this.current(tx, report);
      if (job.version !== report.expectedJobVersion || attempt.version !== report.expectedAttemptVersion
        || !["leased", "running", "waiting_approval"].includes(job.state)
        || !["leased", "running", "waiting"].includes(attempt.state)
        || (attempt.workerId ?? attempt.nodeId) !== report.workerId || lease.state !== "active" || Date.parse(lease.expiresAt) <= this.clock()) conflict();
      const workflow = workflowRecordSchema.parse(await new CanonicalStore(joined(tx)).get(this.scope.tenantId, "workflow", job.workflowId));
      const request = requestRecordSchema.parse(await new CanonicalStore(joined(tx)).get(this.scope.tenantId, "request", workflow.requestId));
      if (request.requestedBy.actorType !== "human") conflict();
      const blocker = taskBlockerRecordSchema.parse({ ...reportRecord, schema: "control-room.task-blocker/v1", state: "open",
        resumeJobState: job.state, resumeAttemptState: attempt.state, taskOwnerId: request.requestedBy.actorId,
        startsWork: false, grantsExecutionAuthority: false });
      const canonical = new CanonicalStore(joined(tx));
      const actor = { actorId: report.workerId, actorType: "agent" as const };
      await canonical.transitionTaskBlocker({ tenantId: this.scope.tenantId, blockerId: report.blockerId, mode: "report",
        jobId: job.id, attemptId: attempt.id, leaseId: lease.id, expectedJobVersion: job.version,
        expectedAttemptVersion: attempt.version, expectedLeaseVersion: lease.version,
        actor, occurredAt: report.reportedAt });
      await tx.query(`INSERT INTO control_task_blockers
        (id,tenant_id,project_id,job_id,attempt_id,worker_id,task_owner_id,kind,state,reported_at,payload,auth_tag)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10::jsonb,$11)`, [blocker.blockerId, this.scope.tenantId,
        blocker.projectId, blocker.jobId, blocker.attemptId, blocker.workerId, blocker.taskOwnerId, blocker.kind, blocker.reportedAt,
        JSON.stringify(blocker), this.tag(blocker)]);
      await tx.query(`INSERT INTO control_task_blocker_events
        (event_id,tenant_id,blocker_id,event_kind,actor_id,actor_type,occurred_at,payload_digest)
        VALUES($1,$2,$3,'reported',$4,'agent',$5,$6)`, [`blocker-event:${blocker.blockerId}:reported`, this.scope.tenantId, blocker.blockerId, blocker.workerId,
        blocker.reportedAt, sha256Digest(blocker)]);
      await new OperatorSurfaceStoreV1(joined(tx)).upsertInbox(this.attention(blocker, "open"));
      await appendAuditWith(tx, { id: `audit:blocker:${blocker.blockerId}:reported`, tenantId: this.scope.tenantId,
        projectId: blocker.projectId, actorId: blocker.workerId, actorType: "agent", action: "tasks.blocker.report",
        targetType: "job", targetId: blocker.jobId, idempotencyKey: `blocker:${blocker.blockerId}:reported`,
        occurredAt: blocker.reportedAt, safeMetadata: { blockerId: blocker.blockerId, blockerKind: blocker.kind,
          evidenceDigests: blocker.evidence.map(sha256Digest), startsWork: false } });
      return { blocker, replayed: false };
    }, assertCurrent);
  }
  private async reassign(identity: VerifiedWebIdentity, projectId: string, jobId: string, blockerId: string,
    action: Extract<TaskBlockerOwnerActionV1, { action: "handoff" | "unblock" }>) {
    if (!this.handoffAssign) return unavailable();
    const dispositionDigest = sha256Digest(action), targetNodeId = action.action === "handoff" ? action.targetNodeId : undefined;
    const prepared = await new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.assign", projectId, true);
      await this.projects.getViewInSession(tx, actor, projectId);
      const row = (await tx.query<BlockerRow>("SELECT payload,auth_tag,disposition_digest FROM control_task_blockers WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3 AND id=$4 FOR UPDATE",
        [this.scope.tenantId, projectId, jobId, blockerId])).rows[0];
      const blocker = this.parse(row);
      if (actor.id !== blocker.taskOwnerId) throw new WebAccessError("access_denied");
      if (blocker.state === (action.action === "handoff" ? "handed_off" : "resolved")) {
        if (row?.disposition_digest !== dispositionDigest || blocker.pendingAction !== action.action) conflict();
        return { blocker, inputDigest: "", complete: true as const };
      }
      if (blocker.state === "handoff_pending") {
        if (row?.disposition_digest !== dispositionDigest || blocker.pendingAction !== action.action) conflict();
        const { job } = await this.current(tx, blocker);
        // A prior call may have assigned the replacement and crashed before the
        // completion link was committed. The assignment coordinator replays the
        // exact target in that case; no second execution is created.
        if (!["ready", "leased"].includes(job.state)) conflict();
        return { blocker, inputDigest: job.inputDigest, complete: false as const };
      }
      if (blocker.state !== "open") conflict();
      const { job, attempt, lease } = await this.current(tx, blocker);
      const selectedNodeId = targetNodeId ?? attempt.nodeId;
      if (action.action === "unblock" && actor.id === blocker.workerId) throw new WebAccessError("access_denied");
      if (job.state !== "blocked" || attempt.state !== "blocked" || lease.state !== "revoked"
        || action.action === "handoff" && selectedNodeId === attempt.nodeId) conflict();
      const target = (await tx.query<{ id: string }>("SELECT id FROM control_nodes WHERE tenant_id=$1 AND id=$2 AND state='active' FOR SHARE",
        [this.scope.tenantId, selectedNodeId])).rows[0];
      if (!target) conflict();
      const now = new Date(this.clock()).toISOString(), canonical = new CanonicalStore(joined(tx));
      const owner = { actorId: actor.id, actorType: "human" as const };
      await canonical.transitionTaskBlocker({ tenantId: this.scope.tenantId, blockerId, mode: "handoff",
        jobId: job.id, attemptId: attempt.id, leaseId: lease.id, expectedJobVersion: job.version,
        expectedAttemptVersion: attempt.version, expectedLeaseVersion: lease.version, actor: owner, occurredAt: now });
      const pending = taskBlockerRecordSchema.parse({ ...blocker, state: "handoff_pending", resolvedByOwnerId: actor.id,
        targetNodeId: selectedNodeId, priorAttemptId: attempt.id, pendingAction: action.action,
        ...(action.action === "unblock" ? { ownerAnswer: action.answer } : {}), resolvedAt: now });
      const updated = await tx.query(`UPDATE control_task_blockers SET state='handoff_pending',resolved_at=$1,payload=$2::jsonb,
        auth_tag=$3,disposition_digest=$4 WHERE tenant_id=$5 AND id=$6 AND state='open' RETURNING id`,
      [now, JSON.stringify(pending), this.tag(pending), dispositionDigest, this.scope.tenantId, blockerId]);
      if (updated.rows.length !== 1) conflict();
      await tx.query(`INSERT INTO control_task_blocker_handoffs
        (tenant_id,blocker_id,job_id,prior_attempt_id,target_node_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6)`, [this.scope.tenantId, blockerId, job.id, attempt.id, selectedNodeId, now]);
      return { blocker: pending, inputDigest: job.inputDigest, complete: false as const };
    });
    if (prepared.complete) return { blocker: prepared.blocker, replayed: true };
    const assignment = await this.handoffAssign(identity, projectId, jobId, prepared.blocker.targetNodeId!, prepared.inputDigest);
    if (assignment.receipt.jobId !== jobId || assignment.receipt.nodeId !== prepared.blocker.targetNodeId
      || assignment.receipt.attemptId === prepared.blocker.priorAttemptId) return unavailable();
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.assign", projectId, true);
      const row = (await tx.query<BlockerRow>("SELECT payload,auth_tag,disposition_digest FROM control_task_blockers WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.tenantId, blockerId])).rows[0];
      const blocker = this.parse(row);
      if (actor.id !== blocker.taskOwnerId || row?.disposition_digest !== dispositionDigest) throw new WebAccessError("access_denied");
      if (blocker.state === (action.action === "handoff" ? "handed_off" : "resolved")) {
        if (blocker.nextAttemptId !== assignment.receipt.attemptId) conflict();
        return { blocker, replayed: true };
      }
      if (blocker.state !== "handoff_pending" || blocker.pendingAction !== action.action
        || blocker.priorAttemptId === assignment.receipt.attemptId) conflict();
      await tx.query(`INSERT INTO control_task_blocker_handoff_completions
        (tenant_id,blocker_id,prior_attempt_id,next_attempt_id,completed_at) VALUES($1,$2,$3,$4,$5)`,
      [this.scope.tenantId, blockerId, blocker.priorAttemptId, assignment.receipt.attemptId, new Date(this.clock()).toISOString()]);
      const finalState = action.action === "handoff" ? "handed_off" as const : "resolved" as const;
      const completed = taskBlockerRecordSchema.parse({ ...blocker, state: finalState, nextAttemptId: assignment.receipt.attemptId });
      const updated = await tx.query(`UPDATE control_task_blockers SET state=$1,payload=$2::jsonb,auth_tag=$3
        WHERE tenant_id=$4 AND id=$5 AND state='handoff_pending' RETURNING id`,
      [finalState, JSON.stringify(completed), this.tag(completed), this.scope.tenantId, blockerId]);
      if (updated.rows.length !== 1) conflict();
      const now = new Date(this.clock()).toISOString();
      await tx.query(`INSERT INTO control_task_blocker_events
        (event_id,tenant_id,blocker_id,event_kind,actor_id,actor_type,occurred_at,payload_digest)
        VALUES($1,$2,$3,$4,$5,'human',$6,$7)`, [`blocker-event:${blockerId}:${action.action}`, this.scope.tenantId,
        blockerId, action.action, actor.id, now, sha256Digest(completed)]);
      await new OperatorSurfaceStoreV1(joined(tx)).upsertInbox(this.attention(completed, "resolved"));
      await appendAuditWith(tx, { id: `audit:blocker:${blockerId}:${action.action}`, tenantId: this.scope.tenantId,
        projectId, actorId: actor.id, actorType: "human", action: `tasks.blocker.${action.action}`, targetType: "job", targetId: jobId,
        idempotencyKey: `blocker:${blockerId}:${action.action}`, occurredAt: now,
        safeMetadata: { blockerId, dispositionDigest, priorAttemptId: completed.priorAttemptId,
          nextAttemptId: completed.nextAttemptId, targetNodeId: completed.targetNodeId, startsWork: false } });
      return { blocker: completed, replayed: assignment.replayed };
    });
  }
  async act(identity: VerifiedWebIdentity, projectId: string, jobId: string, blockerId: string, value: TaskBlockerOwnerActionV1) {
    const action = taskBlockerOwnerActionSchema.parse(value); assertNoSecretMaterial(action, "task blocker owner action");
    if (action.action === "handoff" || action.action === "unblock") return this.reassign(identity, projectId, jobId, blockerId, action);
    return new WebSessionAuthority(this.db, this.scope, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.assign", projectId, true);
      await this.projects.getViewInSession(tx, actor, projectId);
      const row = (await tx.query<BlockerRow>("SELECT payload,auth_tag,disposition_digest FROM control_task_blockers WHERE tenant_id=$1 AND project_id=$2 AND job_id=$3 AND id=$4 FOR UPDATE",
        [this.scope.tenantId, projectId, jobId, blockerId])).rows[0];
      const blocker = this.parse(row), dispositionDigest = sha256Digest(action);
      if (actor.id !== blocker.taskOwnerId) throw new WebAccessError("access_denied");
      if (blocker.state !== "open" && blocker.state !== "handoff_pending") {
        if (row?.disposition_digest !== dispositionDigest) conflict();
        return { blocker, replayed: true };
      }
      const { job, attempt, lease } = await this.current(tx, blocker);
      const pending = blocker.state === "handoff_pending";
      if (!pending && (job.state !== "blocked" || attempt.state !== "blocked" || lease.state !== "revoked")) conflict();
      if (pending && (job.state !== "ready" || attempt.state !== "cancelled" || lease.state !== "revoked")) conflict();
      const now = new Date(this.clock()).toISOString(), canonical = new CanonicalStore(joined(tx));
      await canonical.transitionTaskBlocker({ tenantId: this.scope.tenantId, blockerId,
        mode: pending ? "cancel_pending" : "cancel", jobId: job.id, attemptId: attempt.id, leaseId: lease.id,
        expectedJobVersion: job.version, expectedAttemptVersion: attempt.version, expectedLeaseVersion: lease.version,
        actor: { actorId: actor.id, actorType: "human" }, occurredAt: now });
      const next = taskBlockerRecordSchema.parse({ ...blocker, state: "cancelled",
        resolvedByOwnerId: actor.id, ownerAnswer: action.reason, resolvedAt: now });
      const tag = this.tag(next);
      const updated = await tx.query(`UPDATE control_task_blockers SET state=$1,resolved_at=$2,payload=$3::jsonb,auth_tag=$4,disposition_digest=$5
        WHERE tenant_id=$6 AND id=$7 AND state=$8 RETURNING id`, [next.state, now, JSON.stringify(next), tag,
        dispositionDigest, this.scope.tenantId, blockerId, blocker.state]);
      if (updated.rows.length !== 1) conflict();
      await tx.query(`INSERT INTO control_task_blocker_events
        (event_id,tenant_id,blocker_id,event_kind,actor_id,actor_type,occurred_at,payload_digest)
        VALUES($1,$2,$3,$4,$5,'human',$6,$7)`, [`blocker-event:${blockerId}:${action.action}`, this.scope.tenantId, blockerId, action.action, actor.id, now, sha256Digest(next)]);
      await new OperatorSurfaceStoreV1(joined(tx)).upsertInbox(this.attention(next, "resolved"));
      await appendAuditWith(tx, { id: `audit:blocker:${blockerId}:${action.action}`, tenantId: this.scope.tenantId,
        projectId, actorId: actor.id, actorType: "human", action: `tasks.blocker.${action.action}`, targetType: "job", targetId: jobId,
        idempotencyKey: `blocker:${blockerId}:${action.action}`, occurredAt: now,
        safeMetadata: { blockerId, dispositionDigest, startsWork: false } });
      return { blocker: next, replayed: false };
    });
  }
}
