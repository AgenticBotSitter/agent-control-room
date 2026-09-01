import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1,
  projectWorkspaceLabelSchemaV1,
  projectWorkspaceRelativePathSchemaV1,
  projectWorkspaceSafeCodeSchemaV1,
  projectWorkspaceSafeIdSchemaV1,
  projectWorkspaceSummarySchemaV1,
  projectWorkspaceTimeSchemaV1,
} from "../../project-workspace/v1";
import {
  PROJECT_EVENT_INPUT_V1,
  PROJECT_EVENT_PAGE_V1,
  PROJECT_EVENT_V1,
  projectEventKindsV1,
  projectEventSourceKindsV1,
  projectEventSubjectKindsV1,
  projectEventTonesV1,
} from "./types";

const sourceSchema = z.object({
  kind: z.enum(projectEventSourceKindsV1),
  sourceId: projectWorkspaceSafeIdSchemaV1,
  sourceVersion: projectWorkspaceSafeCodeSchemaV1,
  sourceEventKeyDigest: projectWorkspaceDigestSchemaV1,
}).strict();
const subjectSchema = z.object({
  kind: z.enum(projectEventSubjectKindsV1),
  subjectId: projectWorkspaceSafeIdSchemaV1,
}).strict();
const authorityFields = {
  presentationOnly: z.literal(true),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
} as const;
const canonicalProjectEventTimeSchemaV1=projectWorkspaceTimeSchemaV1.refine(value=>{
  try{return value.endsWith("Z")&&new Date(value).toISOString()===value;}catch{return false;}
},"project event times must use canonical UTC milliseconds");

export const projectEventInputSchemaV1 = z.object({
  schemaVersion: z.literal(PROJECT_EVENT_INPUT_V1),
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  eventId: projectWorkspaceSafeIdSchemaV1,
  eventKind: z.enum(projectEventKindsV1),
  source: sourceSchema,
  subject: subjectSchema,
  safeSummary: projectWorkspaceLabelSchemaV1,
  safeDetail: projectWorkspaceSummarySchemaV1.optional(),
  tone: z.enum(projectEventTonesV1),
  deepLinkPath: projectWorkspaceRelativePathSchemaV1.optional(),
  occurredAt: canonicalProjectEventTimeSchemaV1,
  ...authorityFields,
}).strict();

export const projectEventSchemaV1 = projectEventInputSchemaV1.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal(PROJECT_EVENT_V1),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  previousEventDigest: projectWorkspaceDigestSchemaV1.nullable(),
  recordedAt: canonicalProjectEventTimeSchemaV1,
  eventDigest: projectWorkspaceDigestSchemaV1,
}).strict().superRefine((event, context) => {
  if ((event.sequence === 1) !== (event.previousEventDigest === null)) {
    context.addIssue({ code: "custom", message: "project event origin and prior digest must agree" });
  }
});

export const projectEventCursorSchemaV1 = z.object({
  projectId: projectWorkspaceSafeIdSchemaV1,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  eventDigest: projectWorkspaceDigestSchemaV1,
}).strict();

export const projectEventPageSchemaV1 = z.object({
  contractVersion: z.literal(PROJECT_EVENT_PAGE_V1),
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  mode: z.enum(["snapshot", "replay", "reset"]),
  events: z.array(projectEventSchemaV1).max(100),
  nextCursor: z.string().min(1).max(500).nullable(),
  hasMore: z.boolean(),
  truncatedBefore: z.boolean(),
  ...authorityFields,
  pageDigest: projectWorkspaceDigestSchemaV1,
}).strict();

export const projectEventReadRequestSchemaV1 = z.object({
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  afterCursor: z.string().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100),
}).strict();
