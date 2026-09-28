import type { VerifiedWebIdentity } from "./access-verifier";
import type { TaskBlockerOwnerActionV1, TaskBlockerRecordV1, TaskBlockerReportV1 } from "./task-blocker-wire";

export type TaskBlockerOperationV1 = Readonly<{
  tenantId: string;
  workspaceId: string;
  report: (input: TaskBlockerReportV1, assertCurrent: () => void | Promise<void>) => Promise<Readonly<{
    blocker: TaskBlockerRecordV1; replayed: boolean;
  }>>;
  listOpenForOwner: (identity: VerifiedWebIdentity, jobIds: readonly string[]) => Promise<readonly TaskBlockerRecordV1[]>;
  readForWorker: (blockerId: string, workerId: string, assertCurrent: () => void | Promise<void>) => Promise<TaskBlockerRecordV1>;
  act: (identity: VerifiedWebIdentity, projectId: string, jobId: string, blockerId: string,
    action: TaskBlockerOwnerActionV1) => Promise<Readonly<{ blocker: TaskBlockerRecordV1; replayed: boolean }>>;
}>;
