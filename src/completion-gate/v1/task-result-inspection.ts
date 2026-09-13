import type { TaskResultReceipt } from "../../artifacts/v1/native-results";
import type { JobRecord } from "../../domain/v1";
import type { HarnessRunV1 } from "../../harness/v1/types";
import type { DatabaseSession } from "../../persistence/database";
import type { CompletionAcceptanceProfileV1 } from "./types";
import type { CompletionGateStoreV1 } from "./store";

export type SubmittedTaskResultInspectionV1 = {
  run: HarnessRunV1;
  job: JobRecord;
  profile: CompletionAcceptanceProfileV1;
  result: { receipt: TaskResultReceipt; text: string };
  snapshot: Awaited<ReturnType<CompletionGateStoreV1["snapshot"]>>;
  gate: CompletionGateStoreV1;
  execution: { leaseId: string; leaseEpoch: number; startedAt: string; completedAt: string; completedBefore: string };
};

/** Trusted control-plane reader only. It performs no transition, review, retry, or native I/O. */
export interface TaskResultInspectionSourceV1 {
  inspectSubmitted(tx: DatabaseSession, tenantId: string, runId: string): Promise<SubmittedTaskResultInspectionV1>;
}
