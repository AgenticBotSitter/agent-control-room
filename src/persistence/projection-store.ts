import type {
  AgentProjection,
  AttentionProjection,
  BlockerProjection,
  ChangeEnvelope,
  ChangePage,
  CommandReceipt,
  ExecutionProjection,
  ProjectManifest,
  ProjectSummaryProjection,
  WorkerProjection,
  WorkItemProjection,
} from "@/src/contracts/v1";
import {
  assertSafeProjection,
  commandReceiptSchema,
  projectSummarySchema,
  workerSchema,
} from "@/src/contracts/v1";
import { appendAuditWith, type AuditInput } from "../audit";
import type { DatabaseClient, DatabaseSession } from "./database";

interface Scope {
  tenantId: string;
  workspaceId: string;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export class ProjectionStore {
  constructor(private readonly db: DatabaseClient) {}

  async ensureTenantWorkspace(tenantId: string, workspaceId: string, workspaceName: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO tenants (id, display_name) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
        [tenantId, "Control Room Owner"],
      );
      await tx.query(
        `INSERT INTO workspaces (id, tenant_id, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name
         WHERE workspaces.tenant_id = EXCLUDED.tenant_id`,
        [workspaceId, tenantId, workspaceName],
      );
    });
  }

  async registerAdapter(tenantId: string, manifest: ProjectManifest): Promise<void> {
    assertSafeProjection(manifest);
    await this.db.query(
      `INSERT INTO adapter_registry (
        id, tenant_id, source_system, contract_version, authority_mode, status,
        project_types, supported_read_operations, supported_commands,
        redaction_policy_version, cursor_retention_days, last_seen_at
      ) VALUES ($1,$2,$3,$4,$5,'fixture',$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,now())
      ON CONFLICT (id) DO UPDATE SET
        contract_version = EXCLUDED.contract_version,
        authority_mode = EXCLUDED.authority_mode,
        project_types = EXCLUDED.project_types,
        supported_read_operations = EXCLUDED.supported_read_operations,
        supported_commands = EXCLUDED.supported_commands,
        redaction_policy_version = EXCLUDED.redaction_policy_version,
        cursor_retention_days = EXCLUDED.cursor_retention_days,
        last_seen_at = now(),
        updated_at = now()
      WHERE adapter_registry.tenant_id = EXCLUDED.tenant_id`,
      [
        manifest.adapterId,
        tenantId,
        manifest.sourceSystem,
        manifest.contractVersion,
        manifest.authorityMode,
        json(manifest.projectTypes),
        json(manifest.supportedReadOperations),
        json(manifest.supportedCommands),
        manifest.redactionPolicyVersion,
        manifest.changeFeed.retentionDays,
      ],
    );
  }

  async getCursor(adapterId: string, stream = "changes"): Promise<string | undefined> {
    const result = await this.db.query<{ cursor_value: string }>(
      `SELECT cursor_value FROM projection_cursors WHERE adapter_id = $1 AND stream = $2`,
      [adapterId, stream],
    );
    return result.rows[0]?.cursor_value;
  }

  async applyChangePage(scope: Scope, page: ChangePage, stream = "changes"): Promise<number> {
    assertSafeProjection(page);
    return this.db.transaction(async (tx) => {
      let applied = 0;
      for (const change of page.changes) {
        const inserted = await tx.query<{ sequence: number }>(
          `INSERT INTO projection_changes (
            adapter_id, stream, sequence, cursor_value, operation, record_kind,
            record_id, source_version, occurred_at, payload
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
          ON CONFLICT DO NOTHING
          RETURNING sequence`,
          [
            page.adapterId,
            stream,
            change.sequence,
            change.cursor,
            change.operation,
            change.recordKind,
            change.recordId,
            change.sourceVersion,
            change.occurredAt,
            json(change.payload),
          ],
        );
        if (!inserted.rows.length) continue;
        applied += 1;
        await this.applyChange(tx, scope, page.adapterId, change);
      }

      await tx.query(
        `INSERT INTO projection_cursors (adapter_id, stream, cursor_value)
         VALUES ($1,$2,$3)
         ON CONFLICT (adapter_id, stream) DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()`,
        [page.adapterId, stream, page.nextCursor],
      );
      if (applied > 0) {
        await appendAuditWith(tx, {
          id: `audit.sync.${page.adapterId}.${page.nextCursor.replace(/[^a-zA-Z0-9._-]/g, "-")}`,
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          actorId: page.adapterId,
          actorType: "adapter",
          action: "projection_page_applied",
          targetType: "adapter",
          targetId: page.adapterId,
          correlationId: page.nextCursor,
          safeMetadata: { applied, hasMore: page.hasMore, stream },
          occurredAt: page.changes.at(-1)?.occurredAt ?? "1970-01-01T00:00:00.000Z",
        });
      }
      return applied;
    });
  }

  private async applyChange(
    tx: DatabaseSession,
    scope: Scope,
    adapterId: string,
    change: ChangeEnvelope,
  ): Promise<void> {
    if (change.operation === "remove") {
      const table = {
        project: "projects",
        work_item: "work_items",
        execution: "executions",
        blocker: "blockers",
        attention: "attention_items",
        worker: "worker_runtimes",
        agent: "agent_identities",
      }[change.recordKind];
      await tx.query(`DELETE FROM ${table} WHERE id = $1 AND tenant_id = $2`, [change.recordId, scope.tenantId]);
      return;
    }

    if (!change.payload) throw new Error(`Upsert ${change.recordId} has no payload`);

    switch (change.recordKind) {
      case "project":
        return this.upsertProject(tx, scope, adapterId, projectSummarySchema.parse(change.payload));
      case "work_item":
        return this.upsertWorkItem(tx, scope, adapterId, change.payload as WorkItemProjection);
      case "execution":
        return this.upsertExecution(tx, scope, adapterId, change.payload as ExecutionProjection);
      case "blocker":
        return this.upsertBlocker(tx, scope, adapterId, change.payload as BlockerProjection);
      case "attention":
        return this.upsertAttention(tx, scope, adapterId, change.payload as AttentionProjection);
      case "worker":
        return this.upsertWorker(tx, scope.tenantId, workerSchema.parse(change.payload));
      case "agent":
        return this.upsertAgent(tx, scope.tenantId, change.payload as AgentProjection);
    }
  }

  private async upsertProject(tx: DatabaseSession, scope: Scope, adapterId: string, item: ProjectSummaryProjection): Promise<void> {
    await tx.query(
      `INSERT INTO projects (
        id, tenant_id, workspace_id, adapter_id, source_record_id, source_version,
        source_checksum, title, description, deep_link, normalized_state, domain_state,
        health, progress_percent, forecast_at, attention_count, blocker_count, priority,
        authority_mode, observed_at, payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        source_version = EXCLUDED.source_version, source_checksum = EXCLUDED.source_checksum,
        title = EXCLUDED.title, description = EXCLUDED.description, deep_link = EXCLUDED.deep_link,
        normalized_state = EXCLUDED.normalized_state, domain_state = EXCLUDED.domain_state,
        health = EXCLUDED.health, progress_percent = EXCLUDED.progress_percent,
        forecast_at = EXCLUDED.forecast_at, attention_count = EXCLUDED.attention_count,
        blocker_count = EXCLUDED.blocker_count, priority = EXCLUDED.priority,
        authority_mode = EXCLUDED.authority_mode, observed_at = EXCLUDED.observed_at,
        payload = EXCLUDED.payload, updated_at = now()
      WHERE projects.tenant_id = EXCLUDED.tenant_id AND projects.workspace_id = EXCLUDED.workspace_id`,
      [
        item.id, scope.tenantId, scope.workspaceId, adapterId, item.source.recordId,
        item.source.sourceVersion, item.source.sourceChecksum ?? null, item.title,
        item.description ?? null, item.deepLink ?? null, item.normalizedState, item.domainState,
        item.health, item.progressPercent ?? null, item.forecastAt ?? null, item.attentionCount,
        item.blockerCount, item.priority, item.authorityMode, item.source.observedAt, json(item),
      ],
    );
  }

  private async upsertWorkItem(tx: DatabaseSession, scope: Scope, adapterId: string, item: WorkItemProjection): Promise<void> {
    assertSafeProjection(item);
    await tx.query(
      `INSERT INTO work_items (
        id,tenant_id,workspace_id,project_id,adapter_id,source_record_id,source_version,title,
        deep_link,normalized_state,domain_state,priority,progress_percent,required_capability,
        current_worker_id,current_agent_id,placement_policy,downstream_unlock_count,observed_at,payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        source_version=EXCLUDED.source_version,title=EXCLUDED.title,deep_link=EXCLUDED.deep_link,
        normalized_state=EXCLUDED.normalized_state,domain_state=EXCLUDED.domain_state,
        priority=EXCLUDED.priority,progress_percent=EXCLUDED.progress_percent,
        required_capability=EXCLUDED.required_capability,current_worker_id=EXCLUDED.current_worker_id,
        current_agent_id=EXCLUDED.current_agent_id,placement_policy=EXCLUDED.placement_policy,
        downstream_unlock_count=EXCLUDED.downstream_unlock_count,observed_at=EXCLUDED.observed_at,
        payload=EXCLUDED.payload,updated_at=now()
      WHERE work_items.tenant_id=EXCLUDED.tenant_id AND work_items.workspace_id=EXCLUDED.workspace_id`,
      [item.id,scope.tenantId,scope.workspaceId,item.source.projectId,adapterId,item.source.recordId,item.source.sourceVersion,item.title,item.deepLink??null,item.normalizedState,item.domainState,item.priority,item.progressPercent??null,item.requiredCapability??null,item.currentWorkerId??null,item.currentAgentId??null,json(item.placementPolicy),item.downstreamUnlockCount??0,item.source.observedAt,json(item)],
    );
  }

  private async upsertExecution(tx: DatabaseSession, scope: Scope, adapterId: string, item: ExecutionProjection): Promise<void> {
    assertSafeProjection(item);
    await tx.query(
      `INSERT INTO executions (
        id,tenant_id,workspace_id,project_id,work_item_id,adapter_id,source_record_id,source_version,
        attempt,state,worker_id,agent_id,route_id,progress_percent,lease_observed_at,started_at,
        finished_at,safe_failure_code,observed_at,payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        source_version=EXCLUDED.source_version,state=EXCLUDED.state,worker_id=EXCLUDED.worker_id,
        agent_id=EXCLUDED.agent_id,route_id=EXCLUDED.route_id,progress_percent=EXCLUDED.progress_percent,
        lease_observed_at=EXCLUDED.lease_observed_at,started_at=EXCLUDED.started_at,
        finished_at=EXCLUDED.finished_at,safe_failure_code=EXCLUDED.safe_failure_code,
        observed_at=EXCLUDED.observed_at,payload=EXCLUDED.payload,updated_at=now()
      WHERE executions.tenant_id=EXCLUDED.tenant_id AND executions.workspace_id=EXCLUDED.workspace_id`,
      [item.id,scope.tenantId,scope.workspaceId,item.source.projectId,item.workItemId,adapterId,item.source.recordId,item.source.sourceVersion,item.attempt,item.state,item.workerId??null,item.agentId??null,item.routeId??null,item.progressPercent??null,item.leaseObservedAt??null,item.startedAt??null,item.finishedAt??null,item.safeFailureCode??null,item.source.observedAt,json(item)],
    );
  }

  private async upsertBlocker(tx: DatabaseSession, scope: Scope, adapterId: string, item: BlockerProjection): Promise<void> {
    assertSafeProjection(item);
    await tx.query(
      `INSERT INTO blockers (
        id,tenant_id,workspace_id,project_id,work_item_id,adapter_id,source_record_id,source_version,
        blocker_type,title,severity,responsible_role,safe_remedy,deep_link,opened_at,observed_at,payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        source_version=EXCLUDED.source_version,work_item_id=EXCLUDED.work_item_id,
        blocker_type=EXCLUDED.blocker_type,title=EXCLUDED.title,severity=EXCLUDED.severity,
        responsible_role=EXCLUDED.responsible_role,safe_remedy=EXCLUDED.safe_remedy,
        deep_link=EXCLUDED.deep_link,opened_at=EXCLUDED.opened_at,observed_at=EXCLUDED.observed_at,
        payload=EXCLUDED.payload,updated_at=now()
      WHERE blockers.tenant_id=EXCLUDED.tenant_id AND blockers.workspace_id=EXCLUDED.workspace_id`,
      [item.id,scope.tenantId,scope.workspaceId,item.source.projectId,item.workItemId??null,adapterId,item.source.recordId,item.source.sourceVersion,item.type,item.title,item.severity,item.responsibleRole,item.safeRemedy??null,item.deepLink??null,item.openedAt,item.source.observedAt,json(item)],
    );
  }

  private async upsertAttention(tx: DatabaseSession, scope: Scope, adapterId: string, item: AttentionProjection): Promise<void> {
    assertSafeProjection(item);
    await tx.query(
      `INSERT INTO attention_items (
        id,tenant_id,workspace_id,project_id,work_item_id,adapter_id,source_record_id,source_version,
        attention_type,title,summary,deep_link,due_at,created_at_source,observed_at,payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        source_version=EXCLUDED.source_version,work_item_id=EXCLUDED.work_item_id,
        attention_type=EXCLUDED.attention_type,title=EXCLUDED.title,summary=EXCLUDED.summary,
        deep_link=EXCLUDED.deep_link,due_at=EXCLUDED.due_at,observed_at=EXCLUDED.observed_at,
        payload=EXCLUDED.payload,updated_at=now()
      WHERE attention_items.tenant_id=EXCLUDED.tenant_id AND attention_items.workspace_id=EXCLUDED.workspace_id`,
      [item.id,scope.tenantId,scope.workspaceId,item.source.projectId,item.workItemId??null,adapterId,item.source.recordId,item.source.sourceVersion,item.type,item.title,item.summary,item.deepLink??null,item.dueAt??null,item.createdAt,item.source.observedAt,json(item)],
    );
  }

  async upsertWorker(tx: DatabaseSession, tenantId: string, item: WorkerProjection): Promise<void> {
    assertSafeProjection(item);
    await tx.query(
      `INSERT INTO machine_nodes (id, tenant_id, editable_name, os, inventory)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (id) DO UPDATE SET editable_name=EXCLUDED.editable_name,os=EXCLUDED.os,inventory=EXCLUDED.inventory,updated_at=now()
       WHERE machine_nodes.tenant_id=EXCLUDED.tenant_id`,
      [item.machineId, tenantId, item.displayName, item.os, json({ scratchClass: item.scratchClass })],
    );
    await tx.query(
      `INSERT INTO worker_runtimes (
        id,tenant_id,machine_id,editable_name,state,state_reason,available_slots,total_slots,
        scratch_class,allocation_mode,last_heartbeat_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET editable_name=EXCLUDED.editable_name,state=EXCLUDED.state,
        state_reason=EXCLUDED.state_reason,available_slots=EXCLUDED.available_slots,total_slots=EXCLUDED.total_slots,
        scratch_class=EXCLUDED.scratch_class,allocation_mode=EXCLUDED.allocation_mode,
        last_heartbeat_at=EXCLUDED.last_heartbeat_at,updated_at=now()
      WHERE worker_runtimes.tenant_id=EXCLUDED.tenant_id`,
      [item.id,tenantId,item.machineId,item.displayName,item.state,item.stateReason??null,item.availableSlots,item.totalSlots,item.scratchClass,item.allocationMode,item.lastHeartbeatAt],
    );
  }

  async upsertAgent(tx: DatabaseSession, tenantId: string, item: AgentProjection): Promise<void> {
    assertSafeProjection(item);
    await tx.query(
      `INSERT INTO agent_identities (id,tenant_id,editable_name,agent_type,state,allowed_actions,current_work_item_id,last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (id) DO UPDATE SET editable_name=EXCLUDED.editable_name,state=EXCLUDED.state,
         allowed_actions=EXCLUDED.allowed_actions,current_work_item_id=EXCLUDED.current_work_item_id,
         last_seen_at=EXCLUDED.last_seen_at,updated_at=now()
       WHERE agent_identities.tenant_id=EXCLUDED.tenant_id`,
      [item.id,tenantId,item.displayName,item.agentType,item.state,json(item.allowedActions),item.currentWorkItemId??null,item.lastSeenAt],
    );
  }

  async listProjects(tenantId: string, workspaceId?: string): Promise<ProjectSummaryProjection[]> {
    const result = await this.db.query<{ payload: ProjectSummaryProjection }>(
      workspaceId
        ? `SELECT payload FROM projects WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY priority DESC, title`
        : `SELECT payload FROM projects WHERE tenant_id=$1 ORDER BY priority DESC, title`,
      workspaceId ? [tenantId, workspaceId] : [tenantId],
    );
    return result.rows.map((row) => row.payload);
  }

  async appendAudit(input: AuditInput): Promise<void> {
    assertSafeProjection(input.safeMetadata ?? {});
    await this.db.transaction((tx) => appendAuditWith(tx, input));
  }

  async recordCommandReceipt(scope: Scope & { projectId: string }, adapterId: string, receipt: CommandReceipt, actor: { id: string; type: "human" | "agent" | "service" }): Promise<void> {
    commandReceiptSchema.parse(receipt);
    assertSafeProjection(receipt);
    await this.db.query(
      `INSERT INTO command_receipts (
        id,tenant_id,adapter_id,workspace_id,project_id,idempotency_key,source_command_id,status,
        applied_version,safe_reason_code,safe_message,requested_by_id,requested_by_type,received_at,completed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (adapter_id,idempotency_key) DO NOTHING`,
      [receipt.receiptId,scope.tenantId,adapterId,scope.workspaceId,scope.projectId,receipt.idempotencyKey,receipt.sourceCommandId??null,receipt.status,receipt.appliedVersion??null,receipt.safeReasonCode??null,receipt.message,actor.id,actor.type,receipt.receivedAt,receipt.completedAt??null],
    );
  }
}
