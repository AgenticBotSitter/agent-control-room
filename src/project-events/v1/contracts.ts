import { sha256Digest } from "../../security";
import { parseExactProjectWorkspaceV1 } from "../../project-workspace/v1";
import { ProjectEventErrorV1 } from "./errors";
import {
  projectEventCursorSchemaV1,
  projectEventInputSchemaV1,
  projectEventPageSchemaV1,
  projectEventSchemaV1,
} from "./schemas";
import {
  PROJECT_EVENT_PAGE_V1,
  PROJECT_EVENT_V1,
  type ProjectEventCursorV1,
  type ProjectEventInputV1,
  type ProjectEventPageV1,
  type ProjectEventV1,
} from "./types";

function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return parseExactProjectWorkspaceV1(schema, value); }
  catch { throw new ProjectEventErrorV1("invalid_input"); }
}

export function parseProjectEventInputV1(value: unknown): ProjectEventInputV1 {
  return parse(projectEventInputSchemaV1, value) as ProjectEventInputV1;
}

export function parseProjectEventV1(value: unknown): ProjectEventV1 {
  const event = parse(projectEventSchemaV1, value) as ProjectEventV1;
  const { eventDigest, ...material } = event;
  if (sha256Digest(material) !== eventDigest) throw new ProjectEventErrorV1("integrity_failed");
  return event;
}

export function buildProjectEventV1(inputValue: unknown, sequence: number, previousEventDigest: string | null,
  recordedAt: string): ProjectEventV1 {
  const input = parseProjectEventInputV1(inputValue);
  const material = { ...input, schemaVersion: PROJECT_EVENT_V1, sequence, previousEventDigest, recordedAt };
  return parseProjectEventV1({ ...material, eventDigest: sha256Digest(material) });
}

export function encodeProjectEventCursorV1(event: ProjectEventV1): string {
  return Buffer.from(JSON.stringify({ projectId:event.projectId,sequence:event.sequence,eventDigest:event.eventDigest }),"utf8")
    .toString("base64url");
}

export function decodeProjectEventCursorV1(value: unknown): ProjectEventCursorV1 | undefined {
  if (typeof value !== "string" || value.length < 16 || value.length > 500 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try { return parse(projectEventCursorSchemaV1, JSON.parse(Buffer.from(value,"base64url").toString("utf8"))) as ProjectEventCursorV1; }
  catch { return undefined; }
}

export function buildProjectEventPageV1(input: Omit<ProjectEventPageV1,"contractVersion"|"pageDigest"|
  "presentationOnly"|"grantsApproval"|"grantsCommandAuthority"|"grantsExecutionAuthority">): ProjectEventPageV1 {
  const material = { contractVersion:PROJECT_EVENT_PAGE_V1,...input,presentationOnly:true as const,grantsApproval:false as const,
    grantsCommandAuthority:false as const,grantsExecutionAuthority:false as const };
  return parse(projectEventPageSchemaV1,{...material,pageDigest:sha256Digest(material)}) as ProjectEventPageV1;
}

export function parseProjectEventPageV1(value: unknown): ProjectEventPageV1 {
  const page=parse(projectEventPageSchemaV1,value) as ProjectEventPageV1,{pageDigest,...material}=page;
  if(sha256Digest(material)!==pageDigest)throw new ProjectEventErrorV1("integrity_failed");return page;
}
