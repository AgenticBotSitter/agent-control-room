export interface AuditInput {
  id: string;
  tenantId: string;
  workspaceId?: string;
  projectId?: string;
  actorId: string;
  actorType: "human" | "agent" | "worker" | "service" | "adapter";
  action: string;
  targetType: string;
  targetId: string;
  correlationId?: string;
  idempotencyKey?: string;
  safeMetadata?: Record<string, unknown>;
  occurredAt: string;
}

export interface AuditAnchor {
  id: string;
  tenantId: string;
  chainPartition: string;
  headHash: string;
  eventCount: number;
  anchorKind: string;
  safeReference?: string;
  anchoredAt: string;
}

export interface AuditAnchorPublisher {
  publish(anchor: AuditAnchor): Promise<{ safeReference?: string }>;
}

export interface AuditVerification {
  valid: boolean;
  chainPartition: string;
  checkedEvents: number;
  headHash?: string;
  reasonCode?: string;
}
