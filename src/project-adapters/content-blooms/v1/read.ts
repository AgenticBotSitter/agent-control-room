import { z } from "zod";
import { sha256Digest } from "../../../security";
import { parseContentBloomsControlStateV1 } from "./control";
import { ContentBloomsContractErrorV1 } from "./errors";
import { parseExactContentBloomsV1 } from "./exact";
import { parseContentBloomsOperationalRecordV1 } from "./records";
import { parseContentBloomsAdapterReleaseV1 } from "./release";
import {
  contentBloomsReadPageSchemaV1,
  contentBloomsReadReceiptSchemaV1,
  contentBloomsReadRequestSchemaV1,
  contentBloomsSafeIdSchemaV1,
  contentBloomsTimeSchemaV1,
} from "./schemas";
import {
  CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
  CONTENT_BLOOMS_READ_OPERATIONS_V1,
  type ContentBloomsOperationalRecordV1,
  type ContentBloomsReadOperationV1,
  type ContentBloomsReadPageV1,
  type ContentBloomsReadReceiptV1,
  type ContentBloomsReadRequestV1,
  type ContentBloomsRecordKindV1,
  type ContentBloomsValidatedReadV1,
} from "./types";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const cursor = z.string().min(1).max(512).refine(
  (value) => [...value].every((character) => character.charCodeAt(0) >= 0x21 && character.charCodeAt(0) <= 0x7e),
);
const sourceVersion = z.string().min(1).max(180).refine(
  (value) => [...value].every((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f),
);

const readRequestInputSchemaV1 = z.object({
  requestId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  expectedReleaseDigest: digest,
  operation: z.enum(CONTENT_BLOOMS_READ_OPERATIONS_V1),
  afterCursor: cursor.optional(),
  limit: z.number().int().min(1).max(100),
  requestedAt: contentBloomsTimeSchemaV1,
}).strict().superRefine((value, context) => {
  if (value.operation === "getProjectSummary" && (value.afterCursor !== undefined || value.limit !== 1)) {
    context.addIssue({ code: "custom", message: "project summary is an unpaginated singleton read" });
  }
});

const readPageInputSchemaV1 = z.object({
  request: z.unknown(),
  release: z.unknown(),
  pageId: contentBloomsSafeIdSchemaV1,
  nextCursor: cursor,
  hasMore: z.boolean(),
  sourceSnapshotVersion: sourceVersion,
  sourceObservedAt: contentBloomsTimeSchemaV1,
  records: z.array(z.unknown()).max(100),
}).strict();

const readReceiptInputSchemaV1 = z.object({
  request: z.unknown(),
  page: z.unknown(),
  release: z.unknown(),
  controlState: z.unknown(),
  recordedAt: contentBloomsTimeSchemaV1,
}).strict();

const operationKind: Partial<Record<ContentBloomsReadOperationV1, ContentBloomsRecordKindV1>> = {
  getProjectSummary: "project",
  listWorkItems: "work_item",
  listExecutions: "execution",
  listBlockers: "blocker",
  listWorkers: "worker",
  listAttentionItems: "attention",
};

function withoutRequestDigest(request: ContentBloomsReadRequestV1): Omit<ContentBloomsReadRequestV1, "requestDigest"> {
  const { requestDigest: _requestDigest, ...unsigned } = request;
  void _requestDigest;
  return unsigned;
}

function withoutPageDigest(page: ContentBloomsReadPageV1): Omit<ContentBloomsReadPageV1, "pageDigest"> {
  const { pageDigest: _pageDigest, ...unsigned } = page;
  void _pageDigest;
  return unsigned;
}

function withoutReceiptDigest(receipt: ContentBloomsReadReceiptV1): Omit<ContentBloomsReadReceiptV1, "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...unsigned } = receipt;
  void _receiptDigest;
  return unsigned;
}

function sameScope(
  left: Pick<ContentBloomsReadRequestV1, "tenantId" | "workspaceId" | "projectId" | "adapterId">,
  right: Pick<ContentBloomsReadRequestV1, "tenantId" | "workspaceId" | "projectId" | "adapterId">,
): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId
    && left.projectId === right.projectId && left.adapterId === right.adapterId;
}

function atOrAfter(later: string, earlier: string): boolean {
  return Date.parse(later) >= Date.parse(earlier);
}

function cursorDigest(request: ContentBloomsReadRequestV1, value: string): string {
  return sha256Digest({ adapterId: request.adapterId, projectId: request.projectId, cursor: value });
}

function validateRecords(
  request: Pick<ContentBloomsReadRequestV1, "tenantId" | "workspaceId" | "projectId" | "adapterId" | "operation" | "limit">,
  records: ContentBloomsOperationalRecordV1[],
  sourceObservedAt: string,
): void {
  if (records.length > request.limit) throw new ContentBloomsContractErrorV1("invalid_input");
  const expectedKind = operationKind[request.operation], identities = new Set<string>();
  for (const record of records) {
    if (!sameScope(request, record)) throw new ContentBloomsContractErrorV1("scope_mismatch");
    if ((expectedKind && record.kind !== expectedKind) || (request.operation !== "readChanges" && record.operation !== "upsert")) {
      throw new ContentBloomsContractErrorV1("authority_conflation");
    }
    if (!atOrAfter(sourceObservedAt, record.observedAt)) throw new ContentBloomsContractErrorV1("sequence_invalid");
    const identity = `${record.kind}\0${record.sourceRecordId}\0${record.sourceVersion}`;
    if (identities.has(identity)) throw new ContentBloomsContractErrorV1("replay_drift");
    identities.add(identity);
  }
  if (request.operation === "getProjectSummary" && records.length !== 1) {
    throw new ContentBloomsContractErrorV1("invalid_input");
  }
}

export function buildContentBloomsReadRequestV1(inputValue: unknown): ContentBloomsReadRequestV1 {
  const input = parseExactContentBloomsV1(readRequestInputSchemaV1, inputValue);
  const unsigned: Omit<ContentBloomsReadRequestV1, "requestDigest"> = {
    contractVersion: CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
    requestId: input.requestId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    adapterId: input.adapterId,
    expectedReleaseDigest: input.expectedReleaseDigest,
    operation: input.operation,
    ...(input.afterCursor === undefined ? {} : { afterCursor: input.afterCursor }),
    limit: input.limit,
    requestedAt: input.requestedAt,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(contentBloomsReadRequestSchemaV1, {
    ...unsigned,
    requestDigest: sha256Digest(unsigned),
  }) as ContentBloomsReadRequestV1;
}

export function parseContentBloomsReadRequestV1(value: unknown): ContentBloomsReadRequestV1 {
  const request = parseExactContentBloomsV1(contentBloomsReadRequestSchemaV1, value) as ContentBloomsReadRequestV1;
  if (sha256Digest(withoutRequestDigest(request)) !== request.requestDigest) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return request;
}

export function buildContentBloomsReadPageV1(inputValue: unknown): ContentBloomsReadPageV1 {
  const input = parseExactContentBloomsV1(readPageInputSchemaV1, inputValue);
  const request = parseContentBloomsReadRequestV1(input.request);
  const release = parseContentBloomsAdapterReleaseV1(input.release);
  if (!sameScope(request, release)) throw new ContentBloomsContractErrorV1("scope_mismatch");
  if (request.expectedReleaseDigest !== release.releaseDigest) throw new ContentBloomsContractErrorV1("release_untrusted");
  if (!atOrAfter(request.requestedAt, release.acceptedAt)) throw new ContentBloomsContractErrorV1("sequence_invalid");
  if (!atOrAfter(input.sourceObservedAt, request.requestedAt)) throw new ContentBloomsContractErrorV1("sequence_invalid");
  const records = input.records.map((record) => parseContentBloomsOperationalRecordV1(record));
  validateRecords(request, records, input.sourceObservedAt);
  if ((request.operation === "getProjectSummary" && input.hasMore)
    || (input.hasMore && records.length === 0)
    || (records.length > 0 && input.nextCursor === request.afterCursor)) {
    throw new ContentBloomsContractErrorV1("cursor_drift");
  }
  const unsigned: Omit<ContentBloomsReadPageV1, "pageDigest"> = {
    contractVersion: CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
    pageId: input.pageId,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    adapterId: request.adapterId,
    releaseDigest: release.releaseDigest,
    operation: request.operation,
    ...(request.afterCursor === undefined ? {} : { afterCursor: request.afterCursor }),
    nextCursor: input.nextCursor,
    hasMore: input.hasMore,
    sourceSnapshotVersion: input.sourceSnapshotVersion,
    sourceObservedAt: input.sourceObservedAt,
    records,
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    sourceOwnsDomainTransitions: true,
    controlRoomMayLease: false,
    controlRoomMayMutateSource: false,
  };
  return parseExactContentBloomsV1(contentBloomsReadPageSchemaV1, {
    ...unsigned,
    pageDigest: sha256Digest(unsigned),
  }) as ContentBloomsReadPageV1;
}

export function parseContentBloomsReadPageV1(value: unknown): ContentBloomsReadPageV1 {
  const page = parseExactContentBloomsV1(contentBloomsReadPageSchemaV1, value) as ContentBloomsReadPageV1;
  const records = page.records.map((record) => parseContentBloomsOperationalRecordV1(record));
  validateRecords({
    tenantId: page.tenantId,
    workspaceId: page.workspaceId,
    projectId: page.projectId,
    adapterId: page.adapterId,
    operation: page.operation,
    limit: page.operation === "getProjectSummary" ? 1 : 100,
  }, records, page.sourceObservedAt);
  if ((page.operation === "getProjectSummary" && (page.afterCursor !== undefined || page.hasMore))
    || (page.hasMore && records.length === 0)
    || (records.length > 0 && page.nextCursor === page.afterCursor)) {
    throw new ContentBloomsContractErrorV1("cursor_drift");
  }
  if (sha256Digest({ ...withoutPageDigest(page), records }) !== page.pageDigest) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return page;
}

export function buildContentBloomsReadReceiptV1(inputValue: unknown): ContentBloomsValidatedReadV1 {
  const input = parseExactContentBloomsV1(readReceiptInputSchemaV1, inputValue);
  const request = parseContentBloomsReadRequestV1(input.request);
  const page = parseContentBloomsReadPageV1(input.page);
  const release = parseContentBloomsAdapterReleaseV1(input.release);
  const controlState = parseContentBloomsControlStateV1(input.controlState);
  if (![page, release, controlState].every((value) => sameScope(request, value))) {
    throw new ContentBloomsContractErrorV1("scope_mismatch");
  }
  if (controlState.status !== "enabled" || !controlState.readsEligible
    || controlState.activeReleaseDigest !== release.releaseDigest) {
    throw new ContentBloomsContractErrorV1("adapter_disabled");
  }
  if (request.expectedReleaseDigest !== release.releaseDigest || page.releaseDigest !== release.releaseDigest) {
    throw new ContentBloomsContractErrorV1("release_untrusted");
  }
  if (page.requestId !== request.requestId || page.requestDigest !== request.requestDigest
    || page.operation !== request.operation || page.afterCursor !== request.afterCursor) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  validateRecords(request, page.records, page.sourceObservedAt);
  if (!atOrAfter(request.requestedAt, release.acceptedAt)
    || !atOrAfter(page.sourceObservedAt, request.requestedAt)
    || !atOrAfter(input.recordedAt, page.sourceObservedAt)
    || !atOrAfter(input.recordedAt, controlState.updatedAt)) {
    throw new ContentBloomsContractErrorV1("sequence_invalid");
  }
  const unsigned: Omit<ContentBloomsReadReceiptV1, "receiptDigest"> = {
    contractVersion: CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
    receiptId: `cb-read:${page.pageDigest.slice(7, 39)}`,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    pageId: page.pageId,
    pageDigest: page.pageDigest,
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    adapterId: request.adapterId,
    releaseDigest: release.releaseDigest,
    controlStateDigest: controlState.stateDigest,
    operation: request.operation,
    sourceSnapshotVersion: page.sourceSnapshotVersion,
    nextCursorDigest: cursorDigest(request, page.nextCursor),
    recordDigests: page.records.map((record) => record.recordDigest),
    recordCount: page.records.length,
    sourceObservedAt: page.sourceObservedAt,
    recordedAt: input.recordedAt,
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    sourceOwnsDomainTransitions: true,
    controlRoomMayLease: false,
    controlRoomMayMutateSource: false,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  const receipt = parseExactContentBloomsV1(contentBloomsReadReceiptSchemaV1, {
    ...unsigned,
    receiptDigest: sha256Digest(unsigned),
  }) as ContentBloomsReadReceiptV1;
  return { page, records: [...page.records], nextCursor: page.nextCursor, receipt };
}

export function parseContentBloomsReadReceiptV1(value: unknown): ContentBloomsReadReceiptV1 {
  const receipt = parseExactContentBloomsV1(contentBloomsReadReceiptSchemaV1, value) as ContentBloomsReadReceiptV1;
  if (sha256Digest(withoutReceiptDigest(receipt)) !== receipt.receiptDigest
    || receipt.receiptId !== `cb-read:${receipt.pageDigest.slice(7, 39)}`
    || receipt.recordDigests.length !== receipt.recordCount
    || new Set(receipt.recordDigests).size !== receipt.recordDigests.length) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return receipt;
}

export function requireExactContentBloomsReadReplayV1(existingValue: unknown, candidateValue: unknown): ContentBloomsReadReceiptV1 {
  const existing = parseContentBloomsReadReceiptV1(existingValue);
  const candidate = parseContentBloomsReadReceiptV1(candidateValue);
  if (existing.requestId !== candidate.requestId || existing.pageId !== candidate.pageId) {
    throw new ContentBloomsContractErrorV1("invalid_input");
  }
  if (existing.receiptId !== candidate.receiptId || existing.receiptDigest !== candidate.receiptDigest) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return existing;
}
