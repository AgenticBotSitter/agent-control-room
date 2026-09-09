import { BrowserRequestError } from "./browser-client";
import { catalogProjectIdSchema } from "./project-wire";
import { taskSubmissionDraftSchema } from "./task-submission-wire";
import { createTaskPlanningBrowserClient } from "./task-planning-browser-client";
import { createTaskAssignmentBrowserClient } from "./task-assignment-browser-client";
import { createTaskApprovalBrowserClient } from "./task-approval-browser-client";
import { createTaskSubmissionBrowserClient } from "./task-submission-browser-client";

export type TaskSubmissionBinding = { projectId: string; jobId: string; inputDigest: string; packetDigest: string };

/** Task-page-owned command memory, mirroring review/verification workspaces.
 * No persistence or automatic operation. Protected reads still gate every control. */
export function createTaskExecutionWorkspace(factories: Partial<{
  planning: typeof createTaskPlanningBrowserClient;
  assignment: typeof createTaskAssignmentBrowserClient;
  approval: typeof createTaskApprovalBrowserClient;
  submission: typeof createTaskSubmissionBrowserClient;
}> = {}) {
  const planning = (factories.planning ?? createTaskPlanningBrowserClient)();
  const assignment = (factories.assignment ?? createTaskAssignmentBrowserClient)();
  const approval = (factories.approval ?? createTaskApprovalBrowserClient)();
  const makeSubmission = factories.submission ?? createTaskSubmissionBrowserClient;
  const submissions = new Map<string, ReturnType<typeof createTaskSubmissionBrowserClient>>();
  return Object.freeze({
    planning, assignment, approval,
    hasPending: () => planning.hasPending() || assignment.hasPending() || approval.hasPending()
      || [...submissions.values()].some(client => client.hasPending()),
    submission(binding: TaskSubmissionBinding) {
      if (![binding.projectId, binding.jobId].every(value => catalogProjectIdSchema.safeParse(value).success)
        || !taskSubmissionDraftSchema.safeParse({ expectedInputDigest: binding.inputDigest,
          expectedPacketDigest: binding.packetDigest }).success) throw new BrowserRequestError("invalid_request");
      const key = JSON.stringify([binding.projectId, binding.jobId, binding.inputDigest, binding.packetDigest]);
      let client = submissions.get(key);
      if (!client) {
        // Never evict an unresolved submission to admit a different binding.
        if (submissions.size >= 128) throw new BrowserRequestError("unavailable");
        client = makeSubmission(); submissions.set(key, client);
      }
      return client;
    },
  });
}
export type TaskExecutionWorkspace = ReturnType<typeof createTaskExecutionWorkspace>;
