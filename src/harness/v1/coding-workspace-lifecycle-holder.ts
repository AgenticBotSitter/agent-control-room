import type { CodexWorkspaceLeaseV1, CodexWorkspacePortV1 } from "../codex-v1/workspace";
import { CodexWorkspaceManagerV1 } from "../codex-v1/workspace";
import { controllerWorkerDeliverySchemaV1 } from "./controller-worker-delivery";
import { createManagedWorktreeChangeAuditAuthorityV1 } from "./worktree-change-audit-authority";
import { createWorktreeChangeAuditPlanV1, type WorktreeChangeAuditPlanV1 } from "./worktree-change-audit";
import { sha256Digest } from "../../security/canonical-digest";

export const CODING_WORKSPACE_LIFECYCLE_HOLDER_V1 = "control-room.coding-workspace-lifecycle-holder/v1" as const;

export type CodingWorkspaceLifecycleDispositionV1 =
  | "workspace_held"
  | "workspace_reconciliation_required"
  | "cleanup_retained"
  | "workspace_cleaned";

export type CodingWorkspaceLifecycleObservationV1 = Readonly<{
  schema: typeof CODING_WORKSPACE_LIFECYCLE_HOLDER_V1;
  runId: string;
  deliveryDigest: string;
  disposition: CodingWorkspaceLifecycleDispositionV1;
  reconciliationRequired: boolean;
  workspaceCapacityHeld: boolean;
  auditPlan?: WorktreeChangeAuditPlanV1;
  startsAdapter: false;
  releasesCapacity: false;
}>;

type RecordV1 = {
  runId: string;
  deliveryDigest: string;
  acquisitionDigest: string;
  disposition: CodingWorkspaceLifecycleDispositionV1 | "acquiring";
  lease?: CodexWorkspaceLeaseV1;
  auditPlan?: WorktreeChangeAuditPlanV1;
};

/**
 * Process-private owner of the existing workspace manager and its lease for one
 * controller delivery. The supplied port may be the existing journaled port;
 * this holder neither replaces nor weakens that port's durable reconciliation
 * rules. It launches no adapter and has no scheduler-capacity release port.
 */
export class CodingWorkspaceLifecycleHolderV1 {
  private readonly manager: CodexWorkspaceManagerV1;
  private readonly auditAuthority: ReturnType<typeof createManagedWorktreeChangeAuditAuthorityV1>;
  private readonly records = new Map<string, RecordV1>();
  private serial: Promise<void> = Promise.resolve();
  private creationAttempts = 0;

  constructor(input: Readonly<{
    workspacePort: CodexWorkspacePortV1;
    maximumConcurrentWorkspaces: number;
    allowedPaths: readonly string[];
    maximumChangedFiles: number;
    maximumChangedBytes: number;
  }>) {
    if (!input.workspacePort || typeof input.workspacePort.createDetachedWorktree !== "function"
      || typeof input.workspacePort.inspectExisting !== "function" || typeof input.workspacePort.removeWorktree !== "function") {
      throw new Error("coding_workspace_port_unavailable");
    }
    if (!Number.isSafeInteger(input.maximumConcurrentWorkspaces)
      || input.maximumConcurrentWorkspaces < 1 || input.maximumConcurrentWorkspaces > 64) {
      throw new Error("coding_workspace_capacity_invalid");
    }
    this.maximumConcurrentWorkspaces = input.maximumConcurrentWorkspaces;

    // Reuse the shared validator before any workspace effect and retain its
    // canonical, immutable policy values for every later delivery.
    const validated = createWorktreeChangeAuditPlanV1({
      deliveryDigest: `sha256:${"0".repeat(64)}`,
      worktreeLeaseDigest: `sha256:${"1".repeat(64)}`,
      baseRevision: "0".repeat(40),
      allowedPaths: [...input.allowedPaths],
      maximumChangedFiles: input.maximumChangedFiles,
      maximumChangedBytes: input.maximumChangedBytes,
    });
    const trackedPort: CodexWorkspacePortV1 = {
      inspectExisting: path => input.workspacePort.inspectExisting(path),
      createDetachedWorktree: request => {
        this.creationAttempts += 1;
        return input.workspacePort.createDetachedWorktree(request);
      },
      removeWorktree: request => input.workspacePort.removeWorktree(request),
    };
    this.manager = new CodexWorkspaceManagerV1(trackedPort);
    this.auditAuthority = createManagedWorktreeChangeAuditAuthorityV1({
      workspaceManager: this.manager,
      allowedPaths: validated.allowedPaths,
      maximumChangedFiles: validated.maximumChangedFiles,
      maximumChangedBytes: validated.maximumChangedBytes,
    });
  }

  private readonly maximumConcurrentWorkspaces: number;

  acquire(input: Readonly<{
    delivery: unknown;
    repositoryRoot: string;
    workspaceRoot: string;
    revision: string;
  }>): Promise<CodingWorkspaceLifecycleObservationV1> {
    const delivery = controllerWorkerDeliverySchemaV1.parse(input.delivery);
    const request = Object.freeze({ repositoryRoot: input.repositoryRoot,
      workspaceRoot: input.workspaceRoot, revision: input.revision });
    const acquisitionDigest = sha256Digest({ deliveryDigest: delivery.deliveryDigest, ...request });
    return this.exclusive(async () => {
      const runId = delivery.identity.runId;
      const existing = this.records.get(runId);
      if (existing) {
        if (existing.deliveryDigest !== delivery.deliveryDigest || existing.acquisitionDigest !== acquisitionDigest) {
          throw new Error("coding_workspace_delivery_binding_mismatch");
        }
        if (existing.disposition === "acquiring") throw new Error("coding_workspace_operation_pending");
        return observe(existing);
      }
      if (this.heldCount() >= this.maximumConcurrentWorkspaces) {
        throw new Error("coding_workspace_capacity_exhausted");
      }

      const record: RecordV1 = { runId, deliveryDigest: delivery.deliveryDigest, acquisitionDigest, disposition: "acquiring" };
      this.records.set(runId, record);
      const attemptsBefore = this.creationAttempts;
      try {
        const lease = await this.manager.prepare({ runId, ...request });
        const auditPlan = this.auditAuthority.derive({ delivery, lease });
        record.lease = lease;
        record.auditPlan = auditPlan;
        record.disposition = "workspace_held";
        return observe(record);
      } catch (error) {
        if (this.creationAttempts > attemptsBefore) {
          record.disposition = "workspace_reconciliation_required";
          return observe(record);
        }
        this.records.delete(runId);
        throw error;
      }
    });
  }

  cleanup(deliveryValue: unknown): Promise<CodingWorkspaceLifecycleObservationV1> {
    const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue);
    return this.exclusive(async () => {
      const record = this.records.get(delivery.identity.runId);
      if (!record || record.deliveryDigest !== delivery.deliveryDigest) {
        throw new Error("coding_workspace_delivery_binding_mismatch");
      }
      if (record.disposition === "workspace_reconciliation_required" || record.disposition === "workspace_cleaned") {
        return observe(record);
      }
      if (record.disposition === "acquiring" || !record.lease) throw new Error("coding_workspace_operation_pending");
      try {
        await this.manager.cleanup(record.lease);
        record.disposition = "workspace_cleaned";
      } catch {
        // Manager ownership and its lease are intentionally retained. With a
        // journaled port, a post-effect uncertainty remains reconciliation-only.
        record.disposition = "cleanup_retained";
      }
      return observe(record);
    });
  }

  observation(runId: string): CodingWorkspaceLifecycleObservationV1 | undefined {
    const record = this.records.get(runId);
    return record && record.disposition !== "acquiring" ? observe(record) : undefined;
  }

  private heldCount(): number {
    let count = 0;
    for (const record of this.records.values()) if (record.disposition !== "workspace_cleaned") count += 1;
    return count;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }
}

function observe(record: RecordV1): CodingWorkspaceLifecycleObservationV1 {
  if (record.disposition === "acquiring") throw new Error("coding_workspace_operation_pending");
  const workspaceCapacityHeld = record.disposition !== "workspace_cleaned";
  return Object.freeze({
    schema: CODING_WORKSPACE_LIFECYCLE_HOLDER_V1,
    runId: record.runId,
    deliveryDigest: record.deliveryDigest,
    disposition: record.disposition,
    reconciliationRequired: record.disposition === "workspace_reconciliation_required"
      || record.disposition === "cleanup_retained",
    workspaceCapacityHeld,
    ...(record.auditPlan ? { auditPlan: record.auditPlan } : {}),
    startsAdapter: false,
    releasesCapacity: false,
  });
}
