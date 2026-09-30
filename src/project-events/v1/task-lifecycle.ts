import type { DatabaseSession } from "../../persistence/database";
import { sha256Digest } from "../../security";
import { PROJECT_EVENT_INPUT_V1, type ProjectEventInputV1 } from "./types";
import type { ProjectEventStoreV1 } from "./store";

export const taskProjectEventActionsV1 = [
  "task_created", "task_started", "task_finished", "task_failed", "task_review_ready",
  "task_accepted", "task_changes_requested", "task_revised", "task_completed",
  "task_handed_off", "project_completed", "project_archived",
] as const;
export type TaskProjectEventActionV1 = typeof taskProjectEventActionsV1[number];

export type TaskProjectEventWriteV1 = Readonly<{
  tenantId: string; workspaceId: string; projectId: string; subjectId: string;
  action: TaskProjectEventActionV1; sourceId: string; sourceVersion: string;
  occurredAt: string;
  /** Bounded, already-sanitized presentation text only (e.g. a worker's
   * required hand-off note, truncated to the safeDetail bound). Never a raw
   * prompt, credential or unbounded payload. */
  safeDetail?: string;
}>;

const presentation: Record<TaskProjectEventActionV1, Pick<ProjectEventInputV1,"eventKind"|"safeSummary"|"tone">> = {
  task_created: { eventKind: "work", safeSummary: "Task created", tone: "neutral" },
  task_started: { eventKind: "agent", safeSummary: "Task started", tone: "neutral" },
  task_finished: { eventKind: "agent", safeSummary: "Task run finished", tone: "good" },
  task_failed: { eventKind: "attention", safeSummary: "Task run failed", tone: "bad" },
  task_review_ready: { eventKind: "review", safeSummary: "Task result ready for review", tone: "neutral" },
  task_accepted: { eventKind: "review", safeSummary: "Task result accepted", tone: "good" },
  task_changes_requested: { eventKind: "review", safeSummary: "Task changes requested", tone: "warn" },
  task_revised: { eventKind: "work", safeSummary: "Task revision created", tone: "neutral" },
  task_completed: { eventKind: "work", safeSummary: "Task completed", tone: "good" },
  task_handed_off: { eventKind: "attention", safeSummary: "Worker handed this task back", tone: "warn" },
  project_completed: { eventKind: "project", safeSummary: "Project completed", tone: "good" },
  project_archived: { eventKind: "project", safeSummary: "Project archived", tone: "warn" },
};

/** Fixed presentation text only: source payloads, prompts, result text,
 * feedback, worker identities and private actor data never enter the stream. */
export class TaskProjectEventWriterV1 {
  constructor(private readonly store: Pick<ProjectEventStoreV1,"appendInSession">) { Object.freeze(this); }
  appendInSession(tx: DatabaseSession, value: TaskProjectEventWriteV1) {
    const shown = presentation[value.action];
    const sourceEventKeyDigest = sha256Digest({ kind: "task_project_lifecycle", ...value });
    const suffix = sourceEventKeyDigest.slice("sha256:".length, "sha256:".length + 32);
    return this.store.appendInSession(tx, {
      schemaVersion: PROJECT_EVENT_INPUT_V1, tenantId: value.tenantId, workspaceId: value.workspaceId,
      projectId: value.projectId, eventId: `event:task-lifecycle:${suffix}`, ...shown,
      source: { kind: value.action.startsWith("project_") ? "control_room" : "job",
        sourceId: value.sourceId, sourceVersion: value.sourceVersion, sourceEventKeyDigest },
      subject: { kind: value.action.startsWith("project_") ? "project" : "work_item", subjectId: value.subjectId },
      ...(value.safeDetail !== undefined ? { safeDetail: value.safeDetail } : {}),
      deepLinkPath: value.action.startsWith("project_") ? `/projects/${value.projectId}/activity`
        : `/projects/${value.projectId}/tasks/${value.subjectId}`,
      occurredAt: new Date(value.occurredAt).toISOString(), presentationOnly: true,
      grantsApproval: false, grantsCommandAuthority: false, grantsExecutionAuthority: false,
    });
  }
}
