import { appendAuditWith } from "../audit";
import type { NodeRecord } from "../domain/v1";
import type { NodeOperationRequestBody } from "../node-protocol/v1";
import type { DatabaseClient } from "../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../security";

export type NodeControlOperationV1 = "request_drain" | "request_resume" | "request_quarantine";

export interface RequestNodeOperationInputV1 {
  tenantId: string;
  nodeId: string;
  operation: NodeControlOperationV1;
  expectedNodeVersion: number;
  actorId: string;
  idempotencyKey: string;
  requestedAt: string;
  safeReasonCode?: string;
}

export interface NodeOperationRequestV1 {
  requestId: string;
  tenantId: string;
  nodeId: string;
  operation: NodeControlOperationV1;
  desiredState: "active" | "draining" | "quarantined";
  expectedNodeVersion: number;
  state: "requested" | "applied" | "rejected";
  safeReasonCode?: string;
  requestedAt: string;
  resultingNodeVersion?: number;
  replayed: boolean;
}

export interface AcknowledgeNodeOperationInputV1 {
  tenantId: string;
  nodeId: string;
  requestId: string;
  acknowledgementId: string;
  disposition: "applied" | "rejected";
  acknowledgedAt: string;
  safeResultCode?: string;
}

export interface NodeOperationAcknowledgementV1 {
  requestId: string;
  nodeId: string;
  state: "applied" | "rejected";
  applied: boolean;
  safeResultCode?: string;
  resultingNodeVersion?: number;
  replayed: boolean;
}

export class NodeControlError extends Error {
  constructor(readonly safeCode: "invalid_request" | "node_not_found" | "stale_node_version" | "operation_not_allowed" | "idempotency_conflict") {
    super(safeCode);
    this.name = "NodeControlError";
  }
}

const desiredState: Record<NodeControlOperationV1, NodeOperationRequestV1["desiredState"]> = {
  request_drain: "draining",
  request_resume: "active",
  request_quarantine: "quarantined",
};

const allowedFrom: Record<NodeControlOperationV1, ReadonlySet<NodeRecord["state"]>> = {
  request_drain: new Set(["active"]),
  request_resume: new Set(["draining"]),
  request_quarantine: new Set(["active", "draining", "offline"]),
};

function requireSafeIdentifier(value: string): void {
  if (!value || value.length > 200) throw new NodeControlError("invalid_request");
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/u.test(character)) throw new NodeControlError("invalid_request");
  }
}

function normalizeTime(value: string): string {
  const normalized = new Date(value).toISOString();
  if (normalized !== value) throw new NodeControlError("invalid_request");
  return normalized;
}

export class NodeControlService {
  constructor(private readonly db: DatabaseClient) {}

  async request(input: RequestNodeOperationInputV1): Promise<NodeOperationRequestV1> {
    requireSafeIdentifier(input.tenantId);
    requireSafeIdentifier(input.nodeId);
    requireSafeIdentifier(input.actorId);
    requireSafeIdentifier(input.idempotencyKey);
    if (!Number.isInteger(input.expectedNodeVersion) || input.expectedNodeVersion < 0) throw new NodeControlError("invalid_request");
    if (input.operation === "request_quarantine") {
      if (!input.safeReasonCode) throw new NodeControlError("invalid_request");
      requireSafeIdentifier(input.safeReasonCode);
    } else if (input.safeReasonCode !== undefined) throw new NodeControlError("invalid_request");
    const requestedAt = normalizeTime(input.requestedAt);
    assertNoSecretMaterial(input, "node operation request");
    const material = { ...input, requestedAt, desiredState: desiredState[input.operation] };
    const requestDigest = sha256Digest(material);
    const requestId = `node-operation:${requestDigest.slice("sha256:".length)}`;

    return this.db.transaction(async (tx) => {
      const replay = await tx.query<{
        id: string; request_digest: string; desired_state: NodeOperationRequestV1["desiredState"];
        state: NodeOperationRequestV1["state"]; resulting_node_version: number | null;
      }>(
        `SELECT id,request_digest,desired_state,state,resulting_node_version FROM control_node_operation_requests
         WHERE tenant_id=$1 AND requested_by=$2 AND idempotency_key=$3`,
        [input.tenantId,input.actorId,input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_digest !== requestDigest) throw new NodeControlError("idempotency_conflict");
        return { requestId: replay.rows[0].id, tenantId: input.tenantId, nodeId: input.nodeId, operation: input.operation,
          desiredState: replay.rows[0].desired_state, expectedNodeVersion: input.expectedNodeVersion,
          state: replay.rows[0].state, ...(input.safeReasonCode ? { safeReasonCode: input.safeReasonCode } : {}), requestedAt,
          ...(replay.rows[0].resulting_node_version === null ? {} : { resultingNodeVersion: replay.rows[0].resulting_node_version }), replayed: true };
      }
      const node = await tx.query<{ state: NodeRecord["state"]; version: number }>(
        `SELECT state,version FROM control_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [input.tenantId,input.nodeId],
      );
      if (!node.rows[0]) throw new NodeControlError("node_not_found");
      if (node.rows[0].version !== input.expectedNodeVersion) throw new NodeControlError("stale_node_version");
      if (!allowedFrom[input.operation].has(node.rows[0].state)) throw new NodeControlError("operation_not_allowed");
      const pending = await tx.query<{ id: string }>(
        `SELECT id FROM control_node_operation_requests WHERE tenant_id=$1 AND node_id=$2 AND state='requested'`,
        [input.tenantId,input.nodeId],
      );
      if (pending.rows[0]) throw new NodeControlError("operation_not_allowed");
      await tx.query(
        `INSERT INTO control_node_operation_requests
         (id,tenant_id,node_id,operation,desired_state,expected_node_version,state,safe_reason_code,requested_by,idempotency_key,request_digest,requested_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'requested',$7,$8,$9,$10,$11,$11)`,
        [requestId,input.tenantId,input.nodeId,input.operation,desiredState[input.operation],input.expectedNodeVersion,
          input.safeReasonCode ?? null,input.actorId,input.idempotencyKey,requestDigest,requestedAt],
      );
      const command: NodeOperationRequestBody = {
        requestId,
        nodeId: input.nodeId,
        operation: input.operation,
        desiredState: desiredState[input.operation],
        expectedNodeVersion: input.expectedNodeVersion,
        requestDigest,
        ...(input.safeReasonCode ? { safeReasonCode: input.safeReasonCode } : {}),
      };
      assertNoSecretMaterial(command, "node operation command");
      await tx.query(
        `INSERT INTO control_outbox(id,tenant_id,topic,aggregate_type,aggregate_id,idempotency_key,available_at,payload)
         VALUES ($1,$2,'node.operation.request','node',$3,$4,$5,$6::jsonb)`,
        [`outbox:${requestId}`,input.tenantId,input.nodeId,requestId,requestedAt,JSON.stringify(command)],
      );
      await appendAuditWith(tx, {
        id: `audit:${requestId}`, tenantId: input.tenantId, actorId: input.actorId, actorType: "human",
        action: "node.operation.requested", targetType: "node", targetId: input.nodeId,
        correlationId: requestId, idempotencyKey: input.idempotencyKey,
        safeMetadata: { operation: input.operation, expectedNodeVersion: input.expectedNodeVersion, requestDigest }, occurredAt: requestedAt,
      });
      return { requestId, tenantId: input.tenantId, nodeId: input.nodeId, operation: input.operation,
        desiredState: desiredState[input.operation], expectedNodeVersion: input.expectedNodeVersion,
        state: "requested", ...(input.safeReasonCode ? { safeReasonCode: input.safeReasonCode } : {}), requestedAt, replayed: false };
    });
  }

  async acknowledge(input: AcknowledgeNodeOperationInputV1): Promise<NodeOperationAcknowledgementV1> {
    for (const value of [input.tenantId,input.nodeId,input.requestId,input.acknowledgementId]) requireSafeIdentifier(value);
    if (input.disposition === "rejected") {
      if (!input.safeResultCode) throw new NodeControlError("invalid_request");
      requireSafeIdentifier(input.safeResultCode);
    } else if (input.safeResultCode !== undefined) throw new NodeControlError("invalid_request");
    const acknowledgedAt = normalizeTime(input.acknowledgedAt);
    assertNoSecretMaterial(input, "node operation acknowledgement");
    const acknowledgementDigest = sha256Digest({ ...input, acknowledgedAt });

    return this.db.transaction(async (tx) => {
      const request = await tx.query<{
        node_id: string; operation: NodeControlOperationV1; desired_state: NodeOperationRequestV1["desiredState"];
        expected_node_version: number; state: NodeOperationRequestV1["state"]; acknowledgement_digest: string | null;
        safe_reason_code: string | null; safe_result_code: string | null; resulting_node_version: number | null;
      }>(
        `SELECT node_id,operation,desired_state,expected_node_version,state,acknowledgement_digest,safe_reason_code,safe_result_code,resulting_node_version
         FROM control_node_operation_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [input.tenantId,input.requestId],
      );
      const row = request.rows[0];
      if (!row || row.node_id !== input.nodeId) throw new NodeControlError("node_not_found");
      if (row.state !== "requested") {
        if (row.acknowledgement_digest !== acknowledgementDigest) throw new NodeControlError("idempotency_conflict");
        return { requestId: input.requestId, nodeId: input.nodeId, state: row.state, applied: row.state === "applied",
          ...(row.safe_result_code ? { safeResultCode: row.safe_result_code } : {}),
          ...(row.resulting_node_version === null ? {} : { resultingNodeVersion: row.resulting_node_version }), replayed: true };
      }
      const node = await tx.query<{ state: NodeRecord["state"]; version: number; payload: NodeRecord }>(
        `SELECT state,version,payload FROM control_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [input.tenantId,input.nodeId],
      );
      if (!node.rows[0]) throw new NodeControlError("node_not_found");
      let finalState: "applied" | "rejected" = input.disposition;
      let safeResultCode = input.safeResultCode;
      let resultingNodeVersion: number | undefined;
      if (input.disposition === "applied" && node.rows[0].version !== row.expected_node_version) {
        finalState = "rejected";
        safeResultCode = "stale_node_version";
      } else if (input.disposition === "applied") {
        resultingNodeVersion = node.rows[0].version + 1;
        const payload: NodeRecord = {
          ...node.rows[0].payload,
          state: row.desired_state,
          version: resultingNodeVersion,
          updatedAt: acknowledgedAt,
          ...(row.desired_state === "quarantined" ? { quarantineReasonCode: row.safe_reason_code ?? "operator_requested" } : {}),
        };
        await tx.query(
          `UPDATE control_nodes SET state=$1,version=$2,payload=$3::jsonb,updated_at=$4
           WHERE tenant_id=$5 AND id=$6 AND version=$7`,
          [row.desired_state,resultingNodeVersion,JSON.stringify(payload),acknowledgedAt,input.tenantId,input.nodeId,row.expected_node_version],
        );
      }
      await tx.query(
        `UPDATE control_node_operation_requests SET state=$1,acknowledgement_id=$2,acknowledgement_digest=$3,
         safe_result_code=$4,acknowledged_at=$5,resulting_node_version=$6,updated_at=$5 WHERE tenant_id=$7 AND id=$8`,
        [finalState,input.acknowledgementId,acknowledgementDigest,safeResultCode ?? null,acknowledgedAt,
          resultingNodeVersion ?? null,input.tenantId,input.requestId],
      );
      await appendAuditWith(tx, {
        id: `audit:${input.acknowledgementId}`, tenantId: input.tenantId, actorId: input.nodeId, actorType: "worker",
        action: `node.operation.${finalState}`, targetType: "node", targetId: input.nodeId,
        correlationId: input.requestId, safeMetadata: { operation: row.operation, acknowledgementDigest,
          ...(safeResultCode ? { safeResultCode } : {}), ...(resultingNodeVersion === undefined ? {} : { resultingNodeVersion }) },
        occurredAt: acknowledgedAt,
      });
      return { requestId: input.requestId, nodeId: input.nodeId, state: finalState, applied: finalState === "applied",
        ...(safeResultCode ? { safeResultCode } : {}),
        ...(resultingNodeVersion === undefined ? {} : { resultingNodeVersion }), replayed: false };
    });
  }
}
