export const PROJECT_EVENT_INPUT_V1 = "control-room-project-event-input/v1" as const;
export const PROJECT_EVENT_V1 = "control-room-project-event/v1" as const;
export const PROJECT_EVENT_PAGE_V1 = "control-room-project-event-page/v1" as const;

export const projectEventKindsV1 = [
  "project", "work", "agent", "review", "attention", "artifact", "automation", "transport", "system",
] as const;
export const projectEventSourceKindsV1 = [
  "control_room", "idea_lab", "harness", "job", "review", "node", "automation", "project_adapter",
] as const;
export const projectEventSubjectKindsV1 = [
  "project", "work_item", "agent", "worker", "review", "artifact", "automation", "node", "system",
] as const;
export const projectEventTonesV1 = ["neutral", "good", "warn", "bad"] as const;

export interface ProjectEventInputV1 {
  schemaVersion: typeof PROJECT_EVENT_INPUT_V1;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  eventId: string;
  eventKind: (typeof projectEventKindsV1)[number];
  source: {
    kind: (typeof projectEventSourceKindsV1)[number];
    sourceId: string;
    sourceVersion: string;
    sourceEventKeyDigest: string;
  };
  subject: { kind: (typeof projectEventSubjectKindsV1)[number]; subjectId: string };
  safeSummary: string;
  safeDetail?: string;
  tone: (typeof projectEventTonesV1)[number];
  deepLinkPath?: string;
  occurredAt: string;
  presentationOnly: true;
  grantsApproval: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
}

export interface ProjectEventV1 extends Omit<ProjectEventInputV1, "schemaVersion"> {
  schemaVersion: typeof PROJECT_EVENT_V1;
  sequence: number;
  previousEventDigest: string | null;
  recordedAt: string;
  eventDigest: string;
}

export interface ProjectEventCursorV1 {
  projectId: string;
  sequence: number;
  eventDigest: string;
}

export interface ProjectEventPageV1 {
  contractVersion: typeof PROJECT_EVENT_PAGE_V1;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  mode: "snapshot" | "replay" | "reset";
  events: ProjectEventV1[];
  nextCursor: string | null;
  hasMore: boolean;
  truncatedBefore: boolean;
  presentationOnly: true;
  grantsApproval: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
  pageDigest: string;
}

export interface ProjectEventReadRequestV1 {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  afterCursor?: string;
  limit: number;
}

export interface ProjectEventReadSourceV1 {
  read(request: ProjectEventReadRequestV1): Promise<ProjectEventPageV1>;
}
