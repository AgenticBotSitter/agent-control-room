import { DatabaseSync } from "node:sqlite";
import { assertNoSecretMaterial, sha256Digest } from "../security";
import {
  opaqueTokenDigest,
  signedNodeFrameSchema,
  reconciliationAttemptSchema,
  type JobEventBody,
  type NodeOperationAcknowledgementBody,
  type NodeOperationRequestBody,
  type ReplayGuard,
  type SignedNodeFrame,
} from "../node-protocol/v1";
import type { ArtifactLineageRecordV1 } from "../node-executor/artifact-evidence";
import { assertNativeSnapshotProgress, nativeTaskSnapshotBodySchema, type NativeTaskSnapshotBody } from "../harness/v1/native-observation";
import { matchNativeTaskDispatchReceipt, type NativeTaskDispatchReceiptBody } from "../harness/v1/native-delivery";
import { localId } from "../harness/v1/native-run-identifiers";
import { parseWorkspaceIntent, parseWorkspaceCreation } from "./workspace-intent";

export class BridgeBackpressureError extends Error {
  constructor() {
    super("Bridge journal reached its pending-frame ceiling");
    this.name = "BridgeBackpressureError";
  }
}

export interface JournalAttemptSummary {
  attemptId: string;
  jobId: string;
  leaseId: string;
  leaseEpoch: number;
  state: "leased" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  lastEventSequence: number;
  checkpointIds: string[];
}

export interface JournalOutboundFrame {
  frame: SignedNodeFrame;
  status: "pending" | "sent" | "acknowledged" | "expired";
  essential: boolean;
  sendAttempts: number;
}

export interface JournalJobEvent {
  event: JobEventBody;
  eventDigest: string;
  deliveryAttempt: number;
  messageId: string;
  status: "pending" | "staged" | "acknowledged";
}

export interface JournalNodeControlState {
  nodeId: string;
  nodeVersion: number;
  state: "active" | "draining" | "quarantined";
  safeReasonCode?: string;
  updatedAt: string;
}

export interface JournalNodeOperationResult {
  acknowledgement: NodeOperationAcknowledgementBody;
  cancellationRequired: boolean;
  replayed: boolean;
}

const terminalEvents = new Set<JobEventBody["event"]>(["completed", "failed", "cancelled"]);

function attemptState(event: JobEventBody["event"]): JournalAttemptSummary["state"] {
  if (event === "completed" || event === "failed" || event === "cancelled" || event === "waiting") return event;
  return "running";
}

function assertEventShape(event: JobEventBody): void {
  if (!Number.isInteger(event.sequence) || event.sequence < 1) throw new Error("Job event sequence must be a positive integer");
  if (!Number.isInteger(event.leaseEpoch) || event.leaseEpoch < 1) throw new Error("Job event lease epoch must be positive");
  if (event.event === "progress" ? event.progressPercent === undefined : event.progressPercent !== undefined) {
    throw new Error("Only progress events may carry progressPercent");
  }
  if (event.event === "checkpointed" ? !event.checkpointId : event.checkpointId !== undefined) {
    throw new Error("Only checkpointed events may carry checkpointId");
  }
  if ((event.event === "failed" || event.event === "cancelled") ? !event.safeReasonCode : event.safeReasonCode !== undefined) {
    throw new Error("Only failed and cancelled events must carry a safe reason code");
  }
  if (event.event !== "completed" && event.artifactManifestIds.length) {
    throw new Error("Only completed events may expose artifact manifest IDs");
  }
  if (event.event !== "completed" && event.artifactLineage) {
    throw new Error("Only completed events may expose artifact lineage");
  }
}

function assertArtifactLineage(event: JobEventBody, lineage: ArtifactLineageRecordV1 | undefined): void {
  if (event.event !== "completed") {
    if (lineage) throw new Error("Only a completed event may carry artifact lineage");
    return;
  }
  if (!lineage || event.artifactManifestIds.length !== 1) throw new Error("Completed event requires exactly one artifact lineage record");
  const { lineageDigest, ...unsigned } = lineage;
  if (
    lineageDigest !== sha256Digest(unsigned) ||
    lineage.artifactId !== event.artifactManifestIds[0] ||
    lineage.jobId !== event.jobId ||
    lineage.attemptId !== event.attemptId ||
    lineage.manifest.id !== lineage.artifactId ||
    lineage.producerClaim.artifactId !== lineage.artifactId ||
    lineage.independentVerification.status !== "not_run"
  ) {
    throw new Error("Completed event artifact lineage is inconsistent");
  }
  assertNoSecretMaterial(lineage, "durable artifact lineage");
}

function deliveryEvent(event: JobEventBody, lineage: ArtifactLineageRecordV1 | undefined): JobEventBody {
  if (!lineage) return event;
  return { ...event, artifactLineage: structuredClone(lineage) };
}

export class SqliteBridgeJournal implements ReplayGuard {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly maximumPendingFrames = 10_000) {
    if (!Number.isInteger(maximumPendingFrames) || maximumPendingFrames < 1) throw new Error("Pending-frame ceiling must be positive");
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      this.migrate();
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void {
    this.db.close();
  }

  /** Trusted post-admission node composition only. Durable reservation is not
   * execution authority. Replays remain held pending physical reconciliation.
   * Paths are protected local material; never expose this record in diagnostics.
   */
  reserveWorkspaceIntent(input: unknown, assertCurrent: () => void): "recorded" | "existing" {
    const value = parseWorkspaceIntent(input), digest = sha256Digest(value);
    const target = sha256Digest(value.checkoutPath);
    return this.transaction(() => {
      assertCurrent();
      const prior = this.db.prepare("SELECT run_id,intent_json,intent_digest,target_digest FROM bridge_workspace_intents WHERE target_digest=? OR run_id=?")
        .all(target, value.runId) as { run_id: string; intent_json: string; intent_digest: string; target_digest: string }[];
      if (prior.length) {
        if (prior.length !== 1) throw new Error("workspace_intent_conflict");
        const saved = parseWorkspaceIntent(JSON.parse(prior[0].intent_json));
        if (saved.runId !== prior[0].run_id || sha256Digest(saved) !== prior[0].intent_digest || sha256Digest(saved.checkoutPath) !== prior[0].target_digest)
          throw new Error("workspace_intent_integrity_invalid");
        if (prior[0].intent_digest !== digest) throw new Error("workspace_intent_conflict");
        assertCurrent(); return "existing";
      }
      const count = this.db.prepare("SELECT count(*) AS count FROM bridge_workspace_intents").get() as { count: number };
      if (count.count >= 1024) throw new BridgeBackpressureError();
      this.db.prepare("INSERT INTO bridge_workspace_intents(target_digest,run_id,intent_digest,intent_json) VALUES(?,?,?,?)")
        .run(target, value.runId, digest, JSON.stringify(value));
      assertCurrent(); return "recorded";
    });
  }

  /** Protected node-only recovery input. Historical intents, never permission to retry. */
  workspaceIntentInventory() {
    const rows = this.db.prepare("SELECT target_digest,run_id,intent_digest,intent_json FROM bridge_workspace_intents ORDER BY target_digest LIMIT 1025")
      .all() as { target_digest: string; run_id: string; intent_digest: string; intent_json: string }[];
    if (rows.length > 1024) throw new BridgeBackpressureError();
    return rows.map(row => {
      const intent = parseWorkspaceIntent(JSON.parse(row.intent_json));
      if (intent.runId !== row.run_id || sha256Digest(intent) !== row.intent_digest || sha256Digest(intent.checkoutPath) !== row.target_digest)
        throw new Error("workspace_intent_integrity_invalid");
      const created = this.db.prepare("SELECT evidence_json,evidence_digest FROM bridge_workspace_creations WHERE intent_digest=?")
        .get(row.intent_digest) as { evidence_json: string; evidence_digest: string } | undefined;
      const evidence = created ? parseWorkspaceCreation(JSON.parse(created.evidence_json), intent) : undefined;
      if (created && sha256Digest(evidence) !== created.evidence_digest) throw new Error("workspace_creation_integrity_invalid");
      const removal = this.db.prepare("SELECT creation_digest,removed FROM bridge_workspace_removals WHERE intent_digest=?")
        .get(row.intent_digest) as { creation_digest: string; removed: number } | undefined;
      if (removal && (!evidence || removal.creation_digest !== sha256Digest(evidence) || ![0,1].includes(removal.removed)))
        throw new Error("workspace_removal_integrity_invalid");
      return { intent, intentDigest: row.intent_digest, ...(evidence ? { creation: evidence } : {}),
        ...(removal ? { removal: removal.removed === 1 ? "removed" as const : "pending" as const } : {}),
        disposition: "reconciliation_required" as const };
    });
  }

  /** Record trusted physical readback, not a lease renewal or execution grant. */
  recordWorkspaceCreation(intentDigest: string, input: unknown, assertCurrent: () => void): "recorded" | "existing" {
    return this.transaction(() => {
      assertCurrent();
      const saved = this.workspaceIntentInventory().find(value => value.intentDigest === intentDigest);
      if (!saved) throw new Error("workspace_intent_missing");
      const evidence = parseWorkspaceCreation(input, saved.intent), digest = sha256Digest(evidence);
      if (saved.creation) {
        if (sha256Digest(saved.creation) !== digest) throw new Error("workspace_creation_conflict");
        assertCurrent(); return "existing";
      }
      this.db.prepare("INSERT INTO bridge_workspace_creations(intent_digest,evidence_json,evidence_digest) VALUES(?,?,?)")
        .run(intentDigest, JSON.stringify(evidence), digest);
      assertCurrent(); return "recorded";
    });
  }

  reserveWorkspaceRemoval(intentDigest: string, assertRemovalCurrent: () => void): "recorded" | "existing" {
    return this.transaction(() => {
      assertRemovalCurrent();
      const saved = this.workspaceIntentInventory().find(value => value.intentDigest === intentDigest);
      if (!saved?.creation) throw new Error("workspace_creation_missing");
      if (saved.removal) { assertRemovalCurrent(); return "existing"; }
      this.db.prepare("INSERT INTO bridge_workspace_removals(intent_digest,creation_digest,removed) VALUES(?,?,0)")
        .run(intentDigest, sha256Digest(saved.creation));
      assertRemovalCurrent(); return "recorded";
    });
  }

  /** Trusted port must have confirmed physical absence; this records observation only. */
  recordWorkspaceRemoved(intentDigest: string): "recorded" | "existing" {
    return this.transaction(() => {
      const saved = this.workspaceIntentInventory().find(value => value.intentDigest === intentDigest);
      if (!saved?.removal) throw new Error("workspace_removal_intent_missing");
      if (saved.removal === "removed") return "existing";
      this.db.prepare("UPDATE bridge_workspace_removals SET removed=1 WHERE intent_digest=? AND removed=0").run(intentDigest);
      return "recorded";
    });
  }

  /** Authenticated/owner-verified delivery only. This records intake, not admission or execution.
   * Host composition must place this journal in protected node storage; no payload goes to diagnostics. */
  recordNativeDelivery(input: SignedNodeFrame<"harness.native.dispatch">, receipt: NativeTaskDispatchReceiptBody, assertCurrent: () => void) {
    const parsed = signedNodeFrameSchema.parse(input);
    if (parsed.type !== "harness.native.dispatch") throw new Error("native_delivery_type_invalid");
    const r = matchNativeTaskDispatchReceipt(receipt, parsed), q = parsed.body.request;
    assertNoSecretMaterial(parsed.body, "native delivery");
    if (r.disposition !== "recorded" || Date.parse(r.recordedAt) < Date.parse(parsed.sentAt)
      || Date.parse(r.recordedAt) >= Date.parse(parsed.expiresAt)) throw new Error("native_delivery_time_invalid");
    return this.transaction(() => {
      assertCurrent();
      if (this.db.prepare("SELECT message_id FROM bridge_native_deliveries WHERE queue_id=? OR message_id=?").get(parsed.body.queueId, parsed.messageId))
        throw new Error("native_delivery_already_recorded");
      const count = this.db.prepare("SELECT count(*) AS count FROM bridge_native_deliveries").get() as { count: number };
      if (count.count >= 1024) throw new BridgeBackpressureError();
      this.db.prepare(`INSERT INTO bridge_native_deliveries(queue_id,message_id,tenant_id,job_id,attempt_id,frame_json,frame_digest,receipt_json,receipt_digest)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(parsed.body.queueId, parsed.messageId, q.tenantId, q.jobId, q.attemptId,
          JSON.stringify(parsed), sha256Digest(parsed), JSON.stringify(r), sha256Digest(r));
      assertCurrent(); return structuredClone(r);
    });
  }

  /** Private historical evidence, never current execution authority. No packet or prompt is returned. */
  nativeDeliveryReceipt(queueId: string): NativeTaskDispatchReceiptBody | undefined {
    return this.acceptedNativeDelivery(queueId)?.receipt;
  }

  /** Trusted node execution composition only. Must reverify signatures/current policy before use.
   * Contains private project input; never expose through browser, diagnostics or a worker receipt. */
  acceptedNativeDelivery(queueId: string) {
    const row = this.db.prepare("SELECT message_id,frame_json,frame_digest,receipt_json,receipt_digest FROM bridge_native_deliveries WHERE queue_id=?").get(queueId) as
      { message_id: string; frame_json: string; frame_digest: string; receipt_json: string; receipt_digest: string } | undefined;
    if (!row) return undefined;
    const frame = signedNodeFrameSchema.parse(JSON.parse(row.frame_json));
    if (frame.type !== "harness.native.dispatch" || frame.body.queueId !== queueId || frame.messageId !== row.message_id
      || sha256Digest(frame) !== row.frame_digest) throw new Error("native_delivery_integrity_invalid");
    const r = matchNativeTaskDispatchReceipt(JSON.parse(row.receipt_json), frame);
    if (sha256Digest(r) !== row.receipt_digest) throw new Error("native_delivery_integrity_invalid");
    return { frame, receipt: r };
  }

  /** Bounded historical restart metadata only. Contains no prompts, approvals or
   * result bytes. Unknown attempts are included, never filtered out as irrelevant. */
  nativeRestartInventory() {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT queue_id,tenant_id,job_id,attempt_id FROM bridge_native_deliveries ORDER BY queue_id LIMIT 1025")
        .all() as { queue_id: string; tenant_id: string; job_id: string; attempt_id: string }[];
      const attempts = this.db.prepare("SELECT attempt_id FROM bridge_attempts ORDER BY attempt_id LIMIT 1025").all() as { attempt_id: string }[];
      if (rows.length > 1024 || attempts.length > 1024) throw new BridgeBackpressureError();
      return { deliveries: rows.map(row => {
        const saved = this.acceptedNativeDelivery(row.queue_id); if (!saved) throw new Error("native_delivery_integrity_invalid");
        const body = saved.frame.body, request = body.request;
        if (request.tenantId !== row.tenant_id || request.jobId !== row.job_id || request.attemptId !== row.attempt_id)
          throw new Error("native_delivery_integrity_invalid");
        return { queueId: row.queue_id, tenantId: request.tenantId, nodeId: request.nodeId,
          projectId: request.projectId, jobId: request.jobId, attemptId: request.attemptId,
          leaseId: request.leaseId, leaseEpoch: request.leaseEpoch, runId: body.start.runId,
          bindingDigest: body.bindingDigest, deliveryDigest: sha256Digest(saved) };
      }), attempts: attempts.map(row => {
        const saved = this.attemptSummary(row.attempt_id);
        if (!saved) throw new Error("native_attempt_inventory_invalid");
        const { jobId, ...summary } = saved;
        return { ...reconciliationAttemptSchema.parse(summary), jobId: localId.parse(jobId) };
      }) };
    });
  }

  appendNativeSnapshot(input: NativeTaskSnapshotBody, recordedAt: string): "recorded" | "duplicate" {
    const body = nativeTaskSnapshotBodySchema.parse(input), digest = sha256Digest(body);
    assertNoSecretMaterial(body, "native snapshot outbox");
    if (!Number.isFinite(Date.parse(recordedAt)) || Date.parse(recordedAt) < Date.parse(body.observedAt)) throw new Error("native snapshot time invalid");
    return this.transaction(() => {
      const prior = this.db.prepare(`SELECT body_digest FROM bridge_native_snapshots WHERE run_id=? AND snapshot_version=?`)
        .get(body.runId, body.snapshotVersion) as { body_digest: string } | undefined;
      if (prior) {
        if (prior.body_digest !== digest) throw new Error("native snapshot outbox conflict");
        return "duplicate";
      }
      const count = this.db.prepare(`SELECT count(*) AS count FROM bridge_native_snapshots`).get() as { count: number };
      if (count.count >= 2048) throw new BridgeBackpressureError();
      const latest = this.db.prepare(`SELECT snapshot_version,body_json,body_digest FROM bridge_native_snapshots WHERE run_id=? ORDER BY snapshot_version DESC LIMIT 1`)
        .get(body.runId) as { snapshot_version: number; body_json: string; body_digest: string } | undefined;
      if (latest && latest.snapshot_version >= body.snapshotVersion) throw new Error("native snapshot version regression");
      if (latest) {
        const preceding = nativeTaskSnapshotBodySchema.parse(JSON.parse(latest.body_json));
        if (sha256Digest(preceding) !== latest.body_digest) throw new Error("native snapshot outbox integrity failure");
        assertNativeSnapshotProgress(preceding, body);
      }
      this.db.prepare(`INSERT INTO bridge_native_snapshots(run_id,snapshot_version,body_digest,body_json,status,recorded_at)
        VALUES(?,?,?,?,'pending',?)`).run(body.runId, body.snapshotVersion, digest, JSON.stringify(body), recordedAt);
      return "recorded";
    });
  }

  pendingNativeSnapshots(): NativeTaskSnapshotBody[] {
    const rows = this.db.prepare(`SELECT n.body_json,n.body_digest FROM bridge_native_snapshots n WHERE n.status='pending'
      AND NOT EXISTS(SELECT 1 FROM bridge_native_snapshots p WHERE p.run_id=n.run_id
        AND p.snapshot_version<n.snapshot_version AND p.status IN ('pending','staged'))
      ORDER BY n.recorded_at,n.run_id,n.snapshot_version LIMIT 32`).all() as Array<{ body_json: string; body_digest: string }>;
    return rows.map(row => {
      const body = nativeTaskSnapshotBodySchema.parse(JSON.parse(row.body_json));
      if (sha256Digest(body) !== row.body_digest) throw new Error("native snapshot outbox integrity failure");
      return body;
    });
  }

  stageNativeSnapshotOutbound(frame: SignedNodeFrame<"harness.native.snapshot">, stagedAt: string): "staged" | "duplicate" | "coalesced" {
    if (frame.type !== "harness.native.snapshot") throw new Error("native snapshot staging conflict");
    const body = nativeTaskSnapshotBodySchema.parse(frame.body);
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT body_digest,status FROM bridge_native_snapshots WHERE run_id=? AND snapshot_version=?`)
        .get(body.runId, body.snapshotVersion) as { body_digest: string; status: string } | undefined;
      if (!row || row.status !== "pending" || row.body_digest !== sha256Digest(body) || frame.bodyDigest !== row.body_digest) throw new Error("native snapshot staging conflict");
      const disposition = this.stageOutboundWithinTransaction(frame, true, stagedAt);
      if (disposition === "coalesced") throw new Error("native snapshot cannot be coalesced");
      this.db.prepare(`UPDATE bridge_native_snapshots SET status='staged',outbound_message_id=? WHERE run_id=? AND snapshot_version=?`)
        .run(frame.messageId, body.runId, body.snapshotVersion);
      return disposition;
    });
  }

  requeueNativeSnapshotsForConnection(connectionId: string): void {
    this.transaction(() => {
      const rows = this.db.prepare(`SELECT n.outbound_message_id FROM bridge_native_snapshots n JOIN bridge_outbox o
        ON o.message_id=n.outbound_message_id WHERE n.status='staged' AND o.connection_id<>?`).all(connectionId) as Array<{ outbound_message_id: string }>;
      for (const row of rows) {
        this.db.prepare(`UPDATE bridge_outbox SET status='expired' WHERE message_id=? AND status IN ('pending','sent')`).run(row.outbound_message_id);
        this.db.prepare(`UPDATE bridge_native_snapshots SET status='pending',outbound_message_id=NULL WHERE outbound_message_id=? AND status='staged'`).run(row.outbound_message_id);
      }
    });
  }

  nativeSnapshotAcknowledgementExpired(connectionId: string, now: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM bridge_native_snapshots n JOIN bridge_outbox o ON o.message_id=n.outbound_message_id
      WHERE n.status='staged' AND o.connection_id=? AND o.status IN ('pending','sent') AND o.expires_at<=? LIMIT 1`).get(connectionId, now));
  }

  initializeNodeControlState(state: JournalNodeControlState): "initialized" | "duplicate" {
    assertNoSecretMaterial(state, "local node control state");
    if (!Number.isInteger(state.nodeVersion) || state.nodeVersion < 0) throw new Error("Local node version must be nonnegative");
    return this.transaction(() => {
      const prior = this.db.prepare(
        `SELECT node_version,state,safe_reason_code,updated_at FROM bridge_node_control_state WHERE node_id=?`,
      ).get(state.nodeId) as { node_version: number; state: JournalNodeControlState["state"]; safe_reason_code: string | null; updated_at: string } | undefined;
      if (prior) {
        const exact = prior.node_version === state.nodeVersion && prior.state === state.state
          && prior.safe_reason_code === (state.safeReasonCode ?? null) && prior.updated_at === state.updatedAt;
        if (!exact) throw new Error("Local node control state is already initialized differently");
        return "duplicate" as const;
      }
      this.db.prepare(
        `INSERT INTO bridge_node_control_state(node_id,node_version,state,safe_reason_code,updated_at) VALUES (?,?,?,?,?)`,
      ).run(state.nodeId,state.nodeVersion,state.state,state.safeReasonCode ?? null,state.updatedAt);
      return "initialized" as const;
    });
  }

  nodeControlState(nodeId: string): JournalNodeControlState | undefined {
    const row = this.db.prepare(
      `SELECT node_id,node_version,state,safe_reason_code,updated_at FROM bridge_node_control_state WHERE node_id=?`,
    ).get(nodeId) as { node_id: string; node_version: number; state: JournalNodeControlState["state"]; safe_reason_code: string | null; updated_at: string } | undefined;
    return row ? { nodeId: row.node_id, nodeVersion: row.node_version, state: row.state,
      ...(row.safe_reason_code ? { safeReasonCode: row.safe_reason_code } : {}), updatedAt: row.updated_at } : undefined;
  }

  applyNodeOperation(command: NodeOperationRequestBody, appliedAt: string): JournalNodeOperationResult {
    assertNoSecretMaterial(command, "local node operation command");
    const commandDigest = sha256Digest(command);
    return this.transaction(() => {
      const prior = this.db.prepare(
        `SELECT command_digest,acknowledgement_json,cancellation_required,cancellation_recorded_at
         FROM bridge_node_operation_receipts WHERE request_id=?`,
      ).get(command.requestId) as { command_digest: string; acknowledgement_json: string; cancellation_required: number; cancellation_recorded_at: string | null } | undefined;
      if (prior) {
        if (prior.command_digest !== commandDigest) throw new Error("Node operation request ID conflicts with different content");
        return { acknowledgement: JSON.parse(prior.acknowledgement_json) as NodeOperationAcknowledgementBody,
          cancellationRequired: prior.cancellation_required === 1 && prior.cancellation_recorded_at === null, replayed: true };
      }
      const local = this.db.prepare(
        `SELECT node_version,state FROM bridge_node_control_state WHERE node_id=?`,
      ).get(command.nodeId) as { node_version: number; state: JournalNodeControlState["state"] } | undefined;
      if (!local) throw new Error("Local node control state is not initialized");
      const allowed = (command.operation === "request_drain" && local.state === "active")
        || (command.operation === "request_resume" && local.state === "draining")
        || (command.operation === "request_quarantine" && local.state !== "quarantined");
      const canApply = local.node_version === command.expectedNodeVersion && allowed;
      const resultingNodeVersion = canApply ? local.node_version + 1 : undefined;
      const acknowledgement: NodeOperationAcknowledgementBody = canApply ? {
        requestId: command.requestId,
        nodeId: command.nodeId,
        operation: command.operation,
        expectedNodeVersion: command.expectedNodeVersion,
        disposition: "applied",
        acknowledgementId: `ack:${command.requestDigest.slice("sha256:".length)}`,
        resultingNodeVersion: resultingNodeVersion as number,
      } : {
        requestId: command.requestId,
        nodeId: command.nodeId,
        operation: command.operation,
        expectedNodeVersion: command.expectedNodeVersion,
        disposition: "rejected",
        acknowledgementId: `ack:${command.requestDigest.slice("sha256:".length)}`,
        safeResultCode: local.node_version === command.expectedNodeVersion ? "local_state_conflict" : "stale_node_version",
      };
      const cancellationRequired = canApply && command.operation !== "request_resume";
      if (canApply) {
        this.db.prepare(
          `UPDATE bridge_node_control_state SET node_version=?,state=?,safe_reason_code=?,updated_at=? WHERE node_id=? AND node_version=?`,
        ).run(resultingNodeVersion as number,command.desiredState,command.safeReasonCode ?? null,appliedAt,command.nodeId,local.node_version);
      }
      this.db.prepare(
        `INSERT INTO bridge_node_operation_receipts
         (request_id,request_digest,command_json,command_digest,acknowledgement_json,disposition,cancellation_required,recorded_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(command.requestId,command.requestDigest,JSON.stringify(command),commandDigest,JSON.stringify(acknowledgement),
        acknowledgement.disposition,cancellationRequired ? 1 : 0,appliedAt);
      return { acknowledgement, cancellationRequired, replayed: false };
    });
  }

  pendingNodeControlCancellations(): Array<{ requestId: string; operation: NodeOperationRequestBody["operation"] }> {
    return (this.db.prepare(
      `SELECT request_id,command_json FROM bridge_node_operation_receipts
       WHERE cancellation_required=1 AND cancellation_recorded_at IS NULL ORDER BY recorded_at`,
    ).all() as Array<{ request_id: string; command_json: string }>).map((row) => ({
      requestId: row.request_id,
      operation: (JSON.parse(row.command_json) as NodeOperationRequestBody).operation,
    }));
  }

  markNodeControlCancellationRequested(requestId: string, recordedAt: string): void {
    const changed = this.db.prepare(
      `UPDATE bridge_node_operation_receipts SET cancellation_recorded_at=?
       WHERE request_id=? AND cancellation_required=1 AND cancellation_recorded_at IS NULL`,
    ).run(recordedAt,requestId).changes;
    if (changed !== 1) throw new Error("Node control cancellation is not pending");
  }

  nextOutboundSequence(connectionId: string): number {
    const prior = this.db.prepare(`SELECT last_sequence FROM bridge_sequences WHERE connection_id=? AND direction='node_to_server'`).get(connectionId) as { last_sequence: number } | undefined;
    return (prior?.last_sequence ?? 0) + 1;
  }

  stageOutbound(frame: SignedNodeFrame, essential: boolean, createdAt: string): "staged" | "duplicate" | "coalesced" {
    return this.transaction(() => this.stageOutboundWithinTransaction(frame, essential, createdAt));
  }

  appendJobEvent(event: JobEventBody, recordedAt: string, artifactLineage?: ArtifactLineageRecordV1): "recorded" | "duplicate" {
    assertNoSecretMaterial(event, "durable job event");
    assertEventShape(event);
    assertArtifactLineage(event, artifactLineage);
    const durableEvent = deliveryEvent(event, artifactLineage);
    const eventDigest = sha256Digest(durableEvent);
    return this.transaction(() => {
      const duplicate = this.db.prepare(
        `SELECT event_digest,artifact_lineage_digest FROM bridge_job_events WHERE attempt_id=? AND event_sequence=?`,
      ).get(event.attemptId,event.sequence) as { event_digest: string; artifact_lineage_digest: string | null } | undefined;
      if (duplicate) {
        if (duplicate.event_digest !== eventDigest || duplicate.artifact_lineage_digest !== (artifactLineage?.lineageDigest ?? null)) {
          throw new Error("Job event sequence conflicts with different content");
        }
        return "duplicate" as const;
      }
      const prior = this.db.prepare(
        `SELECT job_id,lease_id,lease_epoch,state,last_event_sequence,checkpoint_ids
         FROM bridge_attempts WHERE attempt_id=?`,
      ).get(event.attemptId) as {
        job_id: string; lease_id: string; lease_epoch: number; state: JournalAttemptSummary["state"];
        last_event_sequence: number; checkpoint_ids: string;
      } | undefined;
      if (prior) {
        if (prior.job_id !== event.jobId || prior.lease_id !== event.leaseId || prior.lease_epoch !== event.leaseEpoch) {
          throw new Error("Job event authority conflicts with the durable attempt identity");
        }
        if (terminalEvents.has(prior.state as JobEventBody["event"])) throw new Error("A terminal attempt cannot accept another job event");
        if (event.sequence !== prior.last_event_sequence + 1) throw new Error("Job event sequence is not monotonic");
      } else if (event.sequence !== 1) {
        throw new Error("A durable attempt must begin at job event sequence 1");
      }
      const checkpointIds = prior ? JSON.parse(prior.checkpoint_ids) as string[] : [];
      if (event.checkpointId && !checkpointIds.includes(event.checkpointId)) checkpointIds.push(event.checkpointId);
      this.db.prepare(
        `INSERT INTO bridge_attempts(attempt_id,job_id,lease_id,lease_epoch,state,last_event_sequence,checkpoint_ids,updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(attempt_id) DO UPDATE SET state=excluded.state,last_event_sequence=excluded.last_event_sequence,
           checkpoint_ids=excluded.checkpoint_ids,updated_at=excluded.updated_at`,
      ).run(event.attemptId,event.jobId,event.leaseId,event.leaseEpoch,attemptState(event.event),event.sequence,JSON.stringify(checkpointIds),recordedAt);
      if (artifactLineage) {
        this.db.prepare(
          `INSERT INTO bridge_artifact_lineage
           (artifact_id,attempt_id,lineage_json,lineage_digest,manifest_digest,claim_digest,verification_state,recorded_at)
           VALUES (?,?,?,?,?,?,'not_run',?)`,
        ).run(
          artifactLineage.artifactId,event.attemptId,JSON.stringify(artifactLineage),artifactLineage.lineageDigest,
          artifactLineage.producerClaim.manifestDigest,artifactLineage.producerClaim.claimDigest,recordedAt,
        );
      }
      this.db.prepare(
        `INSERT INTO bridge_job_events
         (attempt_id,event_sequence,event_json,event_digest,status,delivery_attempt,recorded_at,artifact_id,artifact_lineage_digest)
         VALUES (?,?,?,?,'pending',0,?,?,?)`,
      ).run(
        event.attemptId,event.sequence,JSON.stringify(durableEvent),eventDigest,recordedAt,
        artifactLineage?.artifactId ?? null,artifactLineage?.lineageDigest ?? null,
      );
      return "recorded" as const;
    });
  }

  artifactLineage(artifactId: string): ArtifactLineageRecordV1 | undefined {
    const row = this.db.prepare(
      `SELECT lineage_json,lineage_digest FROM bridge_artifact_lineage WHERE artifact_id=?`,
    ).get(artifactId) as { lineage_json: string; lineage_digest: string } | undefined;
    if (!row) return undefined;
    const lineage = JSON.parse(row.lineage_json) as ArtifactLineageRecordV1;
    if (lineage.lineageDigest !== row.lineage_digest) throw new Error("Durable artifact lineage digest mismatch");
    assertArtifactLineage({
      jobId: lineage.jobId,
      attemptId: lineage.attemptId,
      leaseId: "durable-read-validation",
      leaseEpoch: 1,
      event: "completed",
      sequence: 1,
      occurredAt: lineage.recordedAt,
      artifactManifestIds: [lineage.artifactId],
    }, lineage);
    return structuredClone(lineage);
  }

  pendingJobEvents(): JournalJobEvent[] {
    const rows = this.db.prepare(
      `SELECT event_json,event_digest,status,delivery_attempt,outbound_message_id
       FROM bridge_job_events WHERE status='pending' ORDER BY row_id`,
    ).all() as Array<{
      event_json: string; event_digest: string; status: "pending"; delivery_attempt: number; outbound_message_id: string | null;
    }>;
    return rows.map((row) => ({
      event: JSON.parse(row.event_json) as JobEventBody,
      eventDigest: row.event_digest,
      deliveryAttempt: row.delivery_attempt,
      messageId: row.outbound_message_id ?? `message:job-event:${row.event_digest}:${row.delivery_attempt + 1}`,
      status: row.status,
    }));
  }

  jobEventStatus(attemptId: string, eventSequence: number): JournalJobEvent["status"] | undefined {
    return (this.db.prepare(
      `SELECT status FROM bridge_job_events WHERE attempt_id=? AND event_sequence=?`,
    ).get(attemptId,eventSequence) as { status: JournalJobEvent["status"] } | undefined)?.status;
  }

  stageJobEventOutbound(
    frame: SignedNodeFrame<"job.event">,
    attemptId: string,
    eventSequence: number,
    createdAt: string,
  ): "staged" | "duplicate" {
    return this.transaction(() => {
      const row = this.db.prepare(
        `SELECT event_digest,status,delivery_attempt,outbound_message_id FROM bridge_job_events
         WHERE attempt_id=? AND event_sequence=?`,
      ).get(attemptId,eventSequence) as {
        event_digest: string; status: JournalJobEvent["status"]; delivery_attempt: number; outbound_message_id: string | null;
      } | undefined;
      if (!row) throw new Error("Job event is not durably recorded");
      const expectedMessageId = `message:job-event:${row.event_digest}:${row.delivery_attempt + 1}`;
      if (row.status === "acknowledged") throw new Error("Acknowledged job event cannot be staged again");
      if (row.status === "staged") {
        if (row.outbound_message_id !== frame.messageId) throw new Error("Job event is already linked to another outbound frame");
        const disposition = this.stageOutboundWithinTransaction(frame, true, createdAt);
        if (disposition === "coalesced") throw new Error("Essential job event cannot be coalesced");
        return disposition;
      }
      if (frame.messageId !== expectedMessageId || sha256Digest(frame.body) !== row.event_digest) {
        throw new Error("Outbound job event does not match its durable record");
      }
      const disposition = this.stageOutboundWithinTransaction(frame, true, createdAt);
      if (disposition === "coalesced") throw new Error("Essential job event cannot be coalesced");
      this.db.prepare(
        `UPDATE bridge_job_events SET status='staged',delivery_attempt=delivery_attempt+1,outbound_message_id=?,staged_at=?
         WHERE attempt_id=? AND event_sequence=? AND status='pending'`,
      ).run(frame.messageId,createdAt,attemptId,eventSequence);
      return disposition;
    });
  }

  private stageOutboundWithinTransaction(frame: SignedNodeFrame, essential: boolean, createdAt: string): "staged" | "duplicate" | "coalesced" {
      if (frame.direction !== "node_to_server" || frame.senderKind !== "node") throw new Error("Only node-to-server frames enter the bridge outbox");
      assertNoSecretMaterial(frame.body, "bridge outbox frame");
      const frameDigest = sha256Digest(frame);
      const prior = this.db.prepare(`SELECT frame_digest FROM bridge_outbox WHERE message_id=?`).get(frame.messageId) as { frame_digest: string } | undefined;
      if (prior) {
        if (prior.frame_digest !== frameDigest) throw new Error("Outbound message ID conflicts with different content");
        return "duplicate" as const;
      }
      const count = this.db.prepare(`SELECT count(*) AS count FROM bridge_outbox WHERE status IN ('pending','sent')`).get() as { count: number };
      if (count.count >= this.maximumPendingFrames && frame.type === "node.heartbeat" && !essential) {
        const retained = this.db.prepare(
          `SELECT message_id FROM bridge_outbox WHERE type='node.heartbeat' AND status='pending' AND essential=0 LIMIT 1`,
        ).get();
        if (retained) return "coalesced" as const;
      }
      const after = this.db.prepare(`SELECT count(*) AS count FROM bridge_outbox WHERE status IN ('pending','sent')`).get() as { count: number };
      const effectiveLimit = essential ? this.maximumPendingFrames + 64 : this.maximumPendingFrames;
      if (after.count >= effectiveLimit) throw new BridgeBackpressureError();
      const sequence = this.db.prepare(
        `SELECT last_sequence FROM bridge_sequences WHERE connection_id=? AND direction='node_to_server'`,
      ).get(frame.connectionId) as { last_sequence: number } | undefined;
      const expectedSequence = (sequence?.last_sequence ?? 0) + 1;
      if (frame.sequence !== expectedSequence) throw new Error("Outbound frame sequence is not the next journal sequence");
      this.db.prepare(
        `INSERT INTO bridge_sequences(connection_id,direction,last_sequence) VALUES (?,'node_to_server',?)
         ON CONFLICT(connection_id,direction) DO UPDATE SET last_sequence=excluded.last_sequence`,
      ).run(frame.connectionId,frame.sequence);
      this.db.prepare(
        `INSERT INTO bridge_outbox
         (message_id,connection_id,sequence,type,frame_json,frame_digest,status,essential,send_attempts,created_at,expires_at)
         VALUES (?,?,?,?,?,?,'pending',?,0,?,?)`,
      ).run(frame.messageId,frame.connectionId,frame.sequence,frame.type,JSON.stringify(frame),frameDigest,essential ? 1 : 0,createdAt,frame.expiresAt);
      return "staged" as const;
  }

  markSent(messageId: string, sentAt: string): void {
    const result = this.db.prepare(
      `UPDATE bridge_outbox SET status='sent',send_attempts=send_attempts+1,last_sent_at=?
       WHERE message_id=? AND status IN ('pending','sent')`,
    ).run(sentAt,messageId);
    if (result.changes !== 1) throw new Error("Outbound frame is not sendable");
  }

  acknowledge(messageIds: readonly string[], acknowledgedAt: string): number {
    if (!messageIds.length) return 0;
    return this.transaction(() => {
      let changed = 0;
      const statement = this.db.prepare(
        `UPDATE bridge_outbox SET status='acknowledged',acknowledged_at=?
         WHERE message_id=? AND status IN ('pending','sent')`,
      );
      const acknowledgeEvent = this.db.prepare(
        `UPDATE bridge_job_events SET status='acknowledged',acknowledged_at=?
         WHERE outbound_message_id=? AND status='staged'`,
      );
      for (const messageId of new Set(messageIds)) {
        changed += Number(statement.run(acknowledgedAt,messageId).changes);
        acknowledgeEvent.run(acknowledgedAt,messageId);
        this.db.prepare(`UPDATE bridge_native_snapshots SET status='acknowledged' WHERE outbound_message_id=? AND status='staged'`).run(messageId);
      }
      return changed;
    });
  }

  expireBefore(now: string): number {
    return this.transaction(() => {
      const expired = this.db.prepare(
        `SELECT message_id FROM bridge_outbox WHERE status IN ('pending','sent') AND expires_at<=?`,
      ).all(now) as Array<{ message_id: string }>;
      if (!expired.length) return 0;
      const expireFrame = this.db.prepare(
        `UPDATE bridge_outbox SET status='expired' WHERE message_id=? AND status IN ('pending','sent')`,
      );
      const retryEvent = this.db.prepare(
        `UPDATE bridge_job_events SET status='pending',outbound_message_id=NULL,staged_at=NULL
         WHERE outbound_message_id=? AND status='staged'`,
      );
      let changed = 0;
      for (const row of expired) {
        changed += Number(expireFrame.run(row.message_id).changes);
        retryEvent.run(row.message_id);
        this.db.prepare(`UPDATE bridge_native_snapshots SET status='pending',outbound_message_id=NULL WHERE outbound_message_id=? AND status='staged'`).run(row.message_id);
      }
      return changed;
    });
  }

  retireSupersededControlFrames(currentConnectionId: string): number {
    return Number(this.db.prepare(
      `UPDATE bridge_outbox SET status='expired'
       WHERE status IN ('pending','sent') AND connection_id<>?
         AND type IN ('connection.hello','node.heartbeat','protocol.ack')`,
    ).run(currentConnectionId).changes);
  }

  pendingOutbound(excludeConnectionId?: string): JournalOutboundFrame[] {
    const rows = this.db.prepare(
      `SELECT frame_json,status,essential,send_attempts FROM bridge_outbox
       WHERE status IN ('pending','sent') AND (? IS NULL OR connection_id<>?) ORDER BY created_at,sequence`,
    ).all(excludeConnectionId ?? null,excludeConnectionId ?? null) as Array<{ frame_json: string; status: "pending" | "sent"; essential: number; send_attempts: number }>;
    return rows.map((row) => ({
      frame: JSON.parse(row.frame_json) as SignedNodeFrame,
      status: row.status,
      essential: row.essential === 1,
      sendAttempts: row.send_attempts,
    }));
  }

  recordCommand(frame: SignedNodeFrame, receivedAt: string): "queued" | "duplicate" {
    if (frame.direction !== "server_to_node") throw new Error("Only server commands may enter the local command queue");
    assertNoSecretMaterial(frame.body, "bridge command");
    const digest = sha256Digest(frame);
    const prior = this.db.prepare(`SELECT frame_digest FROM bridge_commands WHERE message_id=?`).get(frame.messageId) as { frame_digest: string } | undefined;
    if (prior) {
      if (prior.frame_digest !== digest) throw new Error("Command message ID conflicts with different content");
      return "duplicate";
    }
    this.db.prepare(
      `INSERT INTO bridge_commands(message_id,type,frame_json,frame_digest,state,received_at) VALUES (?,?,?,?,'queued',?)`,
    ).run(frame.messageId,frame.type,JSON.stringify(frame),digest,receivedAt);
    return "queued";
  }

  queuedCommandCount(): number {
    return (this.db.prepare(`SELECT count(*) AS count FROM bridge_commands WHERE state='queued'`).get() as { count: number }).count;
  }

  /** Exact accepted transport record, not current signing trust or lease permission. */
  acceptedCommand(messageId: string): { frame: SignedNodeFrame; receivedAt: string } | undefined {
    return this.transaction(() => this.acceptedCommandWithinTransaction(messageId));
  }

  private acceptedCommandWithinTransaction(messageId: string): { frame: SignedNodeFrame; receivedAt: string } | undefined {
      const command = this.db.prepare("SELECT frame_json,frame_digest,received_at FROM bridge_commands WHERE message_id=?").get(messageId) as
        { frame_json: string; frame_digest: string; received_at: string } | undefined;
      const inbox = this.db.prepare("SELECT frame_digest,received_at,connection_id,sequence,nonce_digest,expires_at FROM bridge_inbox WHERE message_id=?").get(messageId) as
        { frame_digest: string; received_at: string; connection_id: string; sequence: number; nonce_digest: string; expires_at: string } | undefined;
      if (!command && !inbox) return undefined;
      if (!command || !inbox) throw new Error("Accepted command evidence unavailable");
      const frame = signedNodeFrameSchema.parse(JSON.parse(command.frame_json));
      if (frame.messageId !== messageId || frame.direction !== "server_to_node" || frame.senderKind !== "control_room"
        || sha256Digest(frame) !== command.frame_digest || command.frame_digest !== inbox.frame_digest
        || command.received_at !== inbox.received_at || frame.connectionId !== inbox.connection_id
        || frame.sequence !== inbox.sequence || opaqueTokenDigest(frame.nonce) !== inbox.nonce_digest
        || frame.expiresAt !== inbox.expires_at) throw new Error("Accepted command evidence unavailable");
      return { frame, receivedAt: inbox.received_at };
  }

  /** Trusted intake only, after authenticated replay consumption. Atomically records
   * an initial grant and its attempt; does not verify signing trust, admit execution,
   * renew a lease or reconcile unknown prior state. The supplied synchronous fence
   * must recheck the captured channel, exact task binding and current authority. */
  recordInitialLease(input: SignedNodeFrame<"job.lease.grant">, receivedAt: string, assertFresh: () => true): "recorded" | "duplicate" {
    const frame = signedNodeFrameSchema.parse(input);
    if (frame.type !== "job.lease.grant" || frame.direction !== "server_to_node" || frame.senderKind !== "control_room")
      throw new Error("Initial lease evidence unavailable");
    const at = Date.parse(receivedAt), grant = frame.body;
    if (!Number.isFinite(at) || at < Date.parse(frame.sentAt) || at >= Date.parse(frame.expiresAt)
      || at < Date.parse(grant.acquiredAt) || at >= Date.parse(grant.expiresAt)
      || at >= Date.parse(grant.authority.expiresAt)) throw new Error("Initial lease evidence unavailable");
    const fence = () => {
      const result: unknown = assertFresh();
      if (result !== true) {
        if (result instanceof Promise) void result.catch(() => {});
        throw new Error("Initial lease freshness unavailable");
      }
    };
    return this.transaction(() => {
      fence();
      const priorCommand = this.db.prepare("SELECT message_id FROM bridge_commands WHERE message_id=?").get(frame.messageId);
      const prior = this.attemptSummary(grant.attemptId);
      if (prior) {
        const { jobId, ...reported } = prior; void jobId;
        reconciliationAttemptSchema.parse(reported);
      }
      let disposition: "recorded" | "duplicate";
      if (priorCommand || prior) {
        if (!priorCommand || !prior || prior.jobId !== grant.jobId || prior.leaseId !== grant.leaseId
          || prior.leaseEpoch !== grant.leaseEpoch || !["leased", "running", "waiting"].includes(prior.state))
          throw new Error("Initial lease conflicts with retained attempt");
        disposition = "duplicate";
      } else {
        this.recordCommand(frame, receivedAt);
        this.upsertAttempt({ attemptId: grant.attemptId, jobId: grant.jobId, leaseId: grant.leaseId,
          leaseEpoch: grant.leaseEpoch, state: "leased", lastEventSequence: 0, checkpointIds: [] }, receivedAt);
        disposition = "recorded";
      }
      const verify = () => {
        const saved = this.acceptedCommandWithinTransaction(frame.messageId);
        if (!saved || sha256Digest(saved.frame) !== sha256Digest(frame) || saved.receivedAt !== receivedAt)
          throw new Error("Initial lease receipt unavailable");
      };
      verify();
      const attemptDigest = sha256Digest(this.attemptSummary(grant.attemptId));
      fence(); verify();
      if (sha256Digest(this.attemptSummary(grant.attemptId)) !== attemptDigest)
        throw new Error("Initial lease changed during acceptance");
      return disposition;
    });
  }

  attemptSummary(attemptId: string): JournalAttemptSummary | undefined {
    const row = this.db.prepare("SELECT attempt_id,job_id,lease_id,lease_epoch,state,last_event_sequence,checkpoint_ids FROM bridge_attempts WHERE attempt_id=?").get(attemptId) as
      { attempt_id: string; job_id: string; lease_id: string; lease_epoch: number; state: JournalAttemptSummary["state"]; last_event_sequence: number; checkpoint_ids: string } | undefined;
    return row ? { attemptId: row.attempt_id, jobId: row.job_id, leaseId: row.lease_id, leaseEpoch: row.lease_epoch,
      state: row.state, lastEventSequence: row.last_event_sequence, checkpointIds: JSON.parse(row.checkpoint_ids) as string[] } : undefined;
  }

  highestInboundSequence(connectionId?: string): number {
    if (connectionId !== undefined) return (this.db.prepare(`SELECT COALESCE(max(sequence),0) AS sequence FROM bridge_inbox WHERE connection_id=?`)
      .get(connectionId) as { sequence: number }).sequence;
    return (this.db.prepare(`SELECT COALESCE(max(sequence),0) AS sequence FROM bridge_inbox`).get() as { sequence: number }).sequence;
  }

  inboundStatus(messageId: string): "received" | "processed" | undefined {
    return (this.db.prepare(`SELECT status FROM bridge_inbox WHERE message_id=?`).get(messageId) as { status: "received" | "processed" } | undefined)?.status;
  }

  markInboundProcessed(messageId: string, processedAt: string): void {
    const result = this.db.prepare(
      `UPDATE bridge_inbox SET status='processed',processed_at=? WHERE message_id=? AND status IN ('received','processed')`,
    ).run(processedAt,messageId);
    if (result.changes !== 1) throw new Error("Inbound frame is not recorded");
  }

  upsertAttempt(summary: JournalAttemptSummary, updatedAt: string): void {
    assertNoSecretMaterial(summary, "attempt summary");
    this.db.prepare(
      `INSERT INTO bridge_attempts(attempt_id,job_id,lease_id,lease_epoch,state,last_event_sequence,checkpoint_ids,updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(attempt_id) DO UPDATE SET
         job_id=excluded.job_id,lease_id=excluded.lease_id,lease_epoch=excluded.lease_epoch,state=excluded.state,
         last_event_sequence=excluded.last_event_sequence,checkpoint_ids=excluded.checkpoint_ids,updated_at=excluded.updated_at`,
    ).run(summary.attemptId,summary.jobId,summary.leaseId,summary.leaseEpoch,summary.state,summary.lastEventSequence,JSON.stringify(summary.checkpointIds),updatedAt);
  }

  unresolvedAttempts(): JournalAttemptSummary[] {
    const rows = this.db.prepare(
      `SELECT attempt_id,job_id,lease_id,lease_epoch,state,last_event_sequence,checkpoint_ids
       FROM bridge_attempts WHERE state IN ('leased','running','waiting') ORDER BY attempt_id`,
    ).all() as Array<{ attempt_id: string; job_id: string; lease_id: string; lease_epoch: number; state: JournalAttemptSummary["state"]; last_event_sequence: number; checkpoint_ids: string }>;
    return rows.map((row) => ({
      attemptId: row.attempt_id, jobId: row.job_id, leaseId: row.lease_id, leaseEpoch: row.lease_epoch,
      state: row.state, lastEventSequence: row.last_event_sequence, checkpointIds: JSON.parse(row.checkpoint_ids) as string[],
    }));
  }

  async consume(frame: SignedNodeFrame, receivedAt: string): Promise<"accepted" | "duplicate"> {
    if (frame.direction !== "server_to_node" || frame.senderKind !== "control_room") throw new Error("Local replay guard accepts only server frames");
    return this.transaction(() => {
      const frameDigest = sha256Digest(frame);
      const nonceDigest = opaqueTokenDigest(frame.nonce);
      const prior = this.db.prepare(
        `SELECT message_id,nonce_digest,connection_id,sequence,frame_digest FROM bridge_inbox
         WHERE message_id=? OR nonce_digest=?`,
      ).all(frame.messageId,nonceDigest) as Array<{ message_id: string; nonce_digest: string; connection_id: string; sequence: number; frame_digest: string }>;
      if (prior.length) {
        const exact = prior.length === 1 && prior[0].message_id === frame.messageId && prior[0].nonce_digest === nonceDigest
          && prior[0].connection_id === frame.connectionId && prior[0].sequence === frame.sequence && prior[0].frame_digest === frameDigest;
        if (exact) return "duplicate" as const;
        throw new Error("Server message or nonce replay conflict");
      }
      const sequence = this.db.prepare(`SELECT last_sequence FROM bridge_sequences WHERE connection_id=? AND direction='server_to_node'`).get(frame.connectionId) as { last_sequence: number } | undefined;
      if (!sequence) {
        if (frame.sequence !== 1 || !["connection.accepted", "protocol.error"].includes(frame.type)) throw new Error("Server connection must begin at sequence 1");
        this.db.prepare(`INSERT INTO bridge_sequences(connection_id,direction,last_sequence) VALUES (?,'server_to_node',?)`).run(frame.connectionId,frame.sequence);
      } else {
        if (frame.sequence !== sequence.last_sequence + 1) throw new Error("Non-monotonic server sequence");
        this.db.prepare(`UPDATE bridge_sequences SET last_sequence=? WHERE connection_id=? AND direction='server_to_node'`).run(frame.sequence,frame.connectionId);
      }
      this.db.prepare(
        `INSERT INTO bridge_inbox(message_id,nonce_digest,connection_id,sequence,frame_digest,status,received_at,expires_at)
         VALUES (?,?,?,?,?,'received',?,?)`,
      ).run(frame.messageId,nonceDigest,frame.connectionId,frame.sequence,frameDigest,receivedAt,frame.expiresAt);
      return "accepted" as const;
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_workspace_intents (
        target_digest TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        intent_digest TEXT NOT NULL UNIQUE,
        intent_json TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS bridge_workspace_intents_no_update BEFORE UPDATE ON bridge_workspace_intents
        BEGIN SELECT RAISE(ABORT,'workspace intent is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS bridge_workspace_intents_no_delete BEFORE DELETE ON bridge_workspace_intents
        BEGIN SELECT RAISE(ABORT,'workspace intent is immutable'); END;
      CREATE TABLE IF NOT EXISTS bridge_workspace_creations (
        intent_digest TEXT PRIMARY KEY NOT NULL REFERENCES bridge_workspace_intents(intent_digest),
        evidence_json TEXT NOT NULL,
        evidence_digest TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS bridge_workspace_creations_no_update BEFORE UPDATE ON bridge_workspace_creations
        BEGIN SELECT RAISE(ABORT,'workspace creation is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS bridge_workspace_creations_no_delete BEFORE DELETE ON bridge_workspace_creations
        BEGIN SELECT RAISE(ABORT,'workspace creation is immutable'); END;
      CREATE TABLE IF NOT EXISTS bridge_workspace_removals (
        intent_digest TEXT PRIMARY KEY NOT NULL REFERENCES bridge_workspace_creations(intent_digest),
        creation_digest TEXT NOT NULL,
        removed INTEGER NOT NULL CHECK(removed IN (0,1))
      );
      CREATE TRIGGER IF NOT EXISTS bridge_workspace_removals_monotonic BEFORE UPDATE ON bridge_workspace_removals
        WHEN NEW.intent_digest<>OLD.intent_digest OR NEW.creation_digest<>OLD.creation_digest OR OLD.removed<>0 OR NEW.removed<>1
        BEGIN SELECT RAISE(ABORT,'workspace removal transition invalid'); END;
      CREATE TRIGGER IF NOT EXISTS bridge_workspace_removals_no_delete BEFORE DELETE ON bridge_workspace_removals
        BEGIN SELECT RAISE(ABORT,'workspace removal is immutable'); END;
      CREATE TABLE IF NOT EXISTS bridge_sequences (
        connection_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('node_to_server','server_to_node')),
        last_sequence INTEGER NOT NULL CHECK(last_sequence>0),
        PRIMARY KEY(connection_id,direction)
      );
      CREATE TABLE IF NOT EXISTS bridge_outbox (
        message_id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence>0),
        type TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        frame_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','sent','acknowledged','expired')),
        essential INTEGER NOT NULL CHECK(essential IN (0,1)),
        send_attempts INTEGER NOT NULL CHECK(send_attempts>=0),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_sent_at TEXT,
        acknowledged_at TEXT,
        UNIQUE(connection_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS bridge_inbox (
        message_id TEXT PRIMARY KEY,
        nonce_digest TEXT NOT NULL UNIQUE,
        connection_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence>0),
        frame_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('received','processed')),
        received_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        processed_at TEXT,
        UNIQUE(connection_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS bridge_commands (
        message_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        frame_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','handled','rejected')),
        received_at TEXT NOT NULL,
        handled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS bridge_native_snapshots (
        run_id TEXT NOT NULL,
        snapshot_version INTEGER NOT NULL CHECK(snapshot_version>0),
        body_digest TEXT NOT NULL,
        body_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','staged','acknowledged')),
        outbound_message_id TEXT,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(run_id,snapshot_version),
        CHECK((status='pending')=(outbound_message_id IS NULL))
      );
      CREATE TABLE IF NOT EXISTS bridge_native_deliveries (
        queue_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        frame_digest TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        receipt_digest TEXT NOT NULL,
        UNIQUE(tenant_id,job_id,attempt_id)
      );
      CREATE TRIGGER IF NOT EXISTS bridge_native_deliveries_no_update BEFORE UPDATE ON bridge_native_deliveries
        BEGIN SELECT RAISE(ABORT,'native delivery is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS bridge_native_deliveries_no_delete BEFORE DELETE ON bridge_native_deliveries
        BEGIN SELECT RAISE(ABORT,'native delivery is immutable'); END;
      CREATE TABLE IF NOT EXISTS bridge_node_control_state (
        node_id TEXT PRIMARY KEY,
        node_version INTEGER NOT NULL CHECK(node_version>=0),
        state TEXT NOT NULL CHECK(state IN ('active','draining','quarantined')),
        safe_reason_code TEXT,
        updated_at TEXT NOT NULL,
        CHECK((state='quarantined' AND safe_reason_code IS NOT NULL) OR state<>'quarantined')
      );
      CREATE TABLE IF NOT EXISTS bridge_node_operation_receipts (
        request_id TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL UNIQUE,
        command_json TEXT NOT NULL,
        command_digest TEXT NOT NULL,
        acknowledgement_json TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('applied','rejected')),
        cancellation_required INTEGER NOT NULL CHECK(cancellation_required IN (0,1)),
        cancellation_recorded_at TEXT,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_attempts (
        attempt_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL CHECK(lease_epoch>0),
        state TEXT NOT NULL CHECK(state IN ('leased','running','waiting','completed','failed','cancelled')),
        last_event_sequence INTEGER NOT NULL CHECK(last_event_sequence>=0),
        checkpoint_ids TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_artifact_lineage (
        artifact_id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        lineage_json TEXT NOT NULL,
        lineage_digest TEXT NOT NULL UNIQUE,
        manifest_digest TEXT NOT NULL,
        claim_digest TEXT NOT NULL,
        verification_state TEXT NOT NULL CHECK(verification_state IN ('not_run')),
        recorded_at TEXT NOT NULL,
        FOREIGN KEY(attempt_id) REFERENCES bridge_attempts(attempt_id)
      );
      CREATE TABLE IF NOT EXISTS bridge_job_events (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT NOT NULL,
        event_sequence INTEGER NOT NULL CHECK(event_sequence>0),
        event_json TEXT NOT NULL,
        event_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','staged','acknowledged')),
        delivery_attempt INTEGER NOT NULL CHECK(delivery_attempt>=0),
        outbound_message_id TEXT,
        recorded_at TEXT NOT NULL,
        staged_at TEXT,
        acknowledged_at TEXT,
        artifact_id TEXT,
        artifact_lineage_digest TEXT,
        UNIQUE(attempt_id,event_sequence),
        FOREIGN KEY(attempt_id) REFERENCES bridge_attempts(attempt_id),
        FOREIGN KEY(artifact_id) REFERENCES bridge_artifact_lineage(artifact_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS bridge_job_events_outbound_message
        ON bridge_job_events(outbound_message_id) WHERE outbound_message_id IS NOT NULL;
    `);
    const eventColumns = new Set((this.db.prepare(`PRAGMA table_info(bridge_job_events)`).all() as Array<{ name: string }>).map((row) => row.name));
    if (!eventColumns.has("artifact_id")) this.db.exec(`ALTER TABLE bridge_job_events ADD COLUMN artifact_id TEXT REFERENCES bridge_artifact_lineage(artifact_id)`);
    if (!eventColumns.has("artifact_lineage_digest")) this.db.exec(`ALTER TABLE bridge_job_events ADD COLUMN artifact_lineage_digest TEXT`);
    this.db.exec("PRAGMA user_version=7;");
  }
}
