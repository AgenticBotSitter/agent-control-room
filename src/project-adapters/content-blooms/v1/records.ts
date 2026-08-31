import { z } from "zod";
import { sha256Digest } from "../../../security";
import { ContentBloomsContractErrorV1 } from "./errors";
import { parseExactContentBloomsV1 } from "./exact";
import {
  contentBloomsOperationalRecordSchemaV1,
  contentBloomsProjectionSchemasByKindV1,
  contentBloomsSafeIdSchemaV1,
  contentBloomsTimeSchemaV1,
} from "./schemas";
import {
  CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
  type ContentBloomsOperationalRecordV1,
  type ContentBloomsProjectionV1,
  type ContentBloomsRecordKindV1,
} from "./types";

const recordInputSchemaV1 = z.object({
  kind: z.enum(["project", "work_item", "execution", "blocker", "worker", "attention"]),
  operation: z.enum(["upsert", "remove"]),
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  sourceRecordId: contentBloomsSafeIdSchemaV1,
  sourceVersion: z.string().min(1).max(180).refine(
    (value) => [...value].every((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f),
  ),
  observedAt: contentBloomsTimeSchemaV1,
  projection: z.unknown().optional(),
}).strict();

function atOrAfter(later: string, earlier: string): boolean {
  return Date.parse(later) >= Date.parse(earlier);
}

function validateProjectionChronology(kind: ContentBloomsRecordKindV1, projection: ContentBloomsProjectionV1, observedAt: string): void {
  if (kind === "work_item") {
    const value = projection as { createdAt: string; updatedAt: string };
    if (!atOrAfter(value.updatedAt, value.createdAt) || !atOrAfter(observedAt, value.updatedAt)) {
      throw new ContentBloomsContractErrorV1("sequence_invalid");
    }
  } else if (kind === "execution") {
    const value = projection as { startedAt?: string; finishedAt?: string; leaseObservedAt?: string };
    if ((value.startedAt && !atOrAfter(observedAt, value.startedAt))
      || (value.finishedAt && (!value.startedAt || !atOrAfter(value.finishedAt, value.startedAt) || !atOrAfter(observedAt, value.finishedAt)))
      || (value.leaseObservedAt && !atOrAfter(observedAt, value.leaseObservedAt))) {
      throw new ContentBloomsContractErrorV1("sequence_invalid");
    }
  } else if (kind === "blocker") {
    if (!atOrAfter(observedAt, (projection as { openedAt: string }).openedAt)) {
      throw new ContentBloomsContractErrorV1("sequence_invalid");
    }
  } else if (kind === "worker") {
    if (!atOrAfter(observedAt, (projection as { observedAt: string }).observedAt)) {
      throw new ContentBloomsContractErrorV1("sequence_invalid");
    }
  } else if (kind === "attention") {
    if (!atOrAfter(observedAt, (projection as { createdAt: string }).createdAt)) {
      throw new ContentBloomsContractErrorV1("sequence_invalid");
    }
  }
}

function canonicalSourceFact(record: Omit<ContentBloomsOperationalRecordV1, "sourceChecksum" | "recordDigest">): Record<string, unknown> {
  return {
    contractVersion: record.contractVersion,
    kind: record.kind,
    operation: record.operation,
    tenantId: record.tenantId,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    adapterId: record.adapterId,
    sourceRecordId: record.sourceRecordId,
    sourceVersion: record.sourceVersion,
    observedAt: record.observedAt,
    ...(record.projection === undefined ? {} : { projection: record.projection }),
  };
}

function parseProjection(kind: ContentBloomsRecordKindV1, operation: "upsert" | "remove", value: unknown): ContentBloomsProjectionV1 | undefined {
  if (operation === "remove") {
    if (value !== undefined) throw new ContentBloomsContractErrorV1("invalid_input");
    return undefined;
  }
  if (value === undefined) throw new ContentBloomsContractErrorV1("invalid_input");
  const schema = contentBloomsProjectionSchemasByKindV1[kind] as { parse(value: unknown): unknown };
  return parseExactContentBloomsV1(schema, value) as ContentBloomsProjectionV1;
}

export function buildContentBloomsOperationalRecordV1(inputValue: unknown): ContentBloomsOperationalRecordV1 {
  const input = parseExactContentBloomsV1(recordInputSchemaV1, inputValue);
  const projection = parseProjection(input.kind, input.operation, input.projection);
  if (projection) validateProjectionChronology(input.kind, projection, input.observedAt);
  const sourceFact: Omit<ContentBloomsOperationalRecordV1, "sourceChecksum" | "recordDigest"> = {
    contractVersion: CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
    kind: input.kind,
    operation: input.operation,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    adapterId: input.adapterId,
    sourceRecordId: input.sourceRecordId,
    sourceVersion: input.sourceVersion,
    observedAt: input.observedAt,
    ...(projection === undefined ? {} : { projection }),
  };
  const sourceChecksum = sha256Digest(canonicalSourceFact(sourceFact));
  const unsigned = { ...sourceFact, sourceChecksum };
  return parseExactContentBloomsV1(contentBloomsOperationalRecordSchemaV1, {
    ...unsigned,
    recordDigest: sha256Digest(unsigned),
  }) as ContentBloomsOperationalRecordV1;
}

export function parseContentBloomsOperationalRecordV1(value: unknown): ContentBloomsOperationalRecordV1 {
  const record = parseExactContentBloomsV1(contentBloomsOperationalRecordSchemaV1, value) as ContentBloomsOperationalRecordV1;
  const projection = parseProjection(record.kind, record.operation, record.projection);
  if (projection) validateProjectionChronology(record.kind, projection, record.observedAt);
  const sourceFact: Omit<ContentBloomsOperationalRecordV1, "sourceChecksum" | "recordDigest"> = {
    contractVersion: record.contractVersion,
    kind: record.kind,
    operation: record.operation,
    tenantId: record.tenantId,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    adapterId: record.adapterId,
    sourceRecordId: record.sourceRecordId,
    sourceVersion: record.sourceVersion,
    observedAt: record.observedAt,
    ...(projection === undefined ? {} : { projection }),
  };
  if (sha256Digest(canonicalSourceFact(sourceFact)) !== record.sourceChecksum
    || sha256Digest({ ...sourceFact, sourceChecksum: record.sourceChecksum }) !== record.recordDigest) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return record;
}
