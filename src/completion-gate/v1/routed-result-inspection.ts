import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1 } from "../../harness/hermes-021-v1";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../../harness/claude-code-v1";
import { NativeResultSubmissionService } from "./native-result-submission";
import type { NativeQualityConfiguration } from "./native-result-verification";
import type { SubmittedTaskResultInspectionV1, TaskResultInspectionSourceV1 } from "./task-result-inspection";
import { DurableLocalResultInspectionServiceV1 } from "./durable-local-result-inspection";

const unavailable = (): never => { throw new Error("routed_result_inspection_unavailable"); };
const required = <T>(value: T | undefined): T => value === undefined ? unavailable() : value;
const localAdapters = new Set<string>([HERMES_021_MACOS_LOCAL_ADAPTER_V1, CLAUDE_CODE_LOCAL_ADAPTER_V1]);

/**
 * One read-only selector for the existing native and admitted-local result
 * readers. `adapter_id` is only a routing hint: the selected reader still
 * rechecks every signed binding before returning a result. This adds no
 * storage, scheduler, delivery, retry, or completion authority.
 */
export class RoutedTaskResultInspectionServiceV1 implements TaskResultInspectionSourceV1 {
  private readonly native: NativeResultSubmissionService;
  private readonly local?: TaskResultInspectionSourceV1;
  private readonly configuration: NativeQualityConfiguration;

  constructor(private readonly db: DatabaseClient, config: NativeQualityConfiguration,
    local?: TaskResultInspectionSourceV1) {
    if (local !== undefined && typeof local.inspectSubmitted !== "function") unavailable();
    this.configuration = config;
    this.native = new NativeResultSubmissionService(db, config);
    // Preserve the private durable-inspector identity only inside this router
    // so the separately branded Claude composition may add its distinct
    // receipt verifier. Other sources are captured as read-only callbacks.
    this.local = local instanceof DurableLocalResultInspectionServiceV1 ? local
      : local && Object.freeze({ inspectSubmitted: local.inspectSubmitted.bind(local) });
  }

  /** Private composition extension for an already-installed Claude route. */
  withClaudeDeliveryIntegrityKey(key: Uint8Array): RoutedTaskResultInspectionServiceV1 {
    const local = this.local as DurableLocalResultInspectionServiceV1 | undefined;
    if (!(local instanceof DurableLocalResultInspectionServiceV1)) return unavailable();
    return new RoutedTaskResultInspectionServiceV1(this.db, this.configuration,
      local.withClaudeDeliveryIntegrityKey(key));
  }

  async inspectSubmitted(tx: DatabaseSession, tenantId: string, runId: string): Promise<SubmittedTaskResultInspectionV1> {
    const row = (await tx.query<{ adapter_id: string }>("SELECT adapter_id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenantId, runId])).rows[0];
    if (!row) unavailable();
    if (localAdapters.has(row.adapter_id)) {
      const local = required(this.local);
      return local.inspectSubmitted(tx, tenantId, runId);
    }
    const context = await this.native.inspectSubmitted(tx, tenantId, runId);
    const native = context.run.nativeTask, terminal = context.events.at(-1), startedAt = context.run.startedAt,
      completedAt = context.run.finishedAt;
    if (context.result.receipt.schema !== "control-room.native-result-receipt/v1"
      || terminal?.payload.category !== "native_snapshot" || terminal.payload.snapshot.state !== "completed"
      || !startedAt || !completedAt) unavailable();
    const execution = required(native), start = required(startedAt), completed = required(completedAt);
    return { ...context, execution: { leaseId: execution.leaseId, leaseEpoch: execution.leaseEpoch,
      startedAt: start, completedAt: completed, completedBefore: execution.deadline } };
  }
}
