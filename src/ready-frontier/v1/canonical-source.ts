import { timingSafeEqual } from "node:crypto";
import { canonicalJson, hmacSha256Tag, sha256Digest } from "../../security";
import { exactHostDataArrayV1, exactHostUint8ArrayV1 } from "../../security/host-value";
import { buildReadyFrontierSourceV1 } from "./controller";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { exactReadyFrontierJsonV1, parseExactReadyFrontierV1 } from "./exact";
import { readyFrontierCanonicalReadSchemaV1, readyFrontierManualCycleRequestSchemaV1 } from "./integration-schemas";
import {
  READY_FRONTIER_CANONICAL_READ_V1,
  type ReadyFrontierAttentionCanonicalReadV1,
  type ReadyFrontierCanonicalReadV1,
  type ReadyFrontierCapacityCanonicalReadV1,
  type ReadyFrontierManualCycleRequestV1,
  type ReadyFrontierProjectCanonicalReadV1,
  type ReadyFrontierUnsignedCanonicalReadV1,
  type ReadyFrontierWorkCanonicalReadV1,
} from "./integration-types";
import { READY_FRONTIER_SOURCE_V1, type ReadyFrontierSourceSnapshotV1 } from "./types";

const zeroDigest = "sha256:" + "0".repeat(64);
const zeroTag = "hmac-sha256:" + "0".repeat(64);

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
function same(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
function sortedUnique(values: readonly string[]): string[] {
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) fail("invalid_input");
  return sorted;
}
function exactInstant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("invalid_input");
  return parsed;
}

function canonicalReadUnsigned(read: ReadyFrontierCanonicalReadV1): ReadyFrontierUnsignedCanonicalReadV1 {
  const common = {
    schema: READY_FRONTIER_CANONICAL_READ_V1,
    channel: read.channel,
    readGroupId: read.readGroupId,
    tenantId: read.tenantId,
    revision: read.revision,
    observedAt: read.observedAt,
    projectIds: sortedUnique(read.projectIds),
    retainsRawInputContent: false as const,
    retainsUsableAccessData: false as const,
    retainsPrivateLocators: false as const,
  };
  if (read.channel === "projects") return {
    ...common, channel: "projects", payload: {
      projects: [...read.payload.projects].sort((left, right) => left.projectId.localeCompare(right.projectId)),
    },
  };
  if (read.channel === "work") return {
    ...common, channel: "work", payload: {
      candidates: [...read.payload.candidates].map((candidate) => ({ ...candidate,
        dependencyCandidateIds: sortedUnique(candidate.dependencyCandidateIds),
        evidenceDigests: sortedUnique(candidate.evidenceDigests),
      })).sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
      canonicalWork: [...read.payload.canonicalWork].sort((left, right) => left.workItemId.localeCompare(right.workItemId)),
      dependencyTruth: [...read.payload.dependencyTruth].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    },
  };
  if (read.channel === "attention") return {
    ...common, channel: "attention", payload: {
      attention: [...read.payload.attention].map((item) => ({ ...item, blockerCodes: sortedUnique(item.blockerCodes) }))
        .sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    },
  };
  return {
    ...common, channel: "capacity", payload: {
      routes: [...read.payload.routes].map((route) => ({ ...route, supportedPlatforms: sortedUnique(route.supportedPlatforms) as typeof route.supportedPlatforms }))
        .sort((left, right) => left.routeId.localeCompare(right.routeId)),
    },
  };
}

function readTag(key: Uint8Array, read: Pick<ReadyFrontierCanonicalReadV1,
  "schema" | "channel" | "readGroupId" | "tenantId" | "revision" | "observedAt" | "readDigest">): string {
  return hmacSha256Tag(key, { schema: read.schema, channel: read.channel, readGroupId: read.readGroupId,
    tenantId: read.tenantId, revision: read.revision, observedAt: read.observedAt, readDigest: read.readDigest });
}

export function buildReadyFrontierCanonicalReadV1(value: ReadyFrontierUnsignedCanonicalReadV1,
  integrityKeyValue: unknown): ReadyFrontierCanonicalReadV1 {
  const hostKey = exactHostUint8ArrayV1(integrityKeyValue, 128);
  if (!hostKey || hostKey.byteLength < 32) fail("integrity_failed");
  const key = hostKey.copy();
  try {
    const copied = exactReadyFrontierJsonV1(value);
    if (!copied || typeof copied !== "object" || Array.isArray(copied)) fail("invalid_input");
    const seeded = parseExactReadyFrontierV1(readyFrontierCanonicalReadSchemaV1, {
      ...copied, payloadDigest: zeroDigest, readDigest: zeroDigest, readAuthTag: zeroTag,
    }) as ReadyFrontierCanonicalReadV1;
    const unsigned = canonicalReadUnsigned(seeded);
    const payloadDigest = sha256Digest(unsigned.payload);
    const readDigest = sha256Digest({ ...unsigned, payloadDigest });
    return deepFreeze(parseExactReadyFrontierV1(readyFrontierCanonicalReadSchemaV1, {
      ...unsigned, payloadDigest, readDigest,
      readAuthTag: readTag(key, { ...unsigned, readDigest }),
    }) as ReadyFrontierCanonicalReadV1);
  } finally { key.fill(0); }
}

export function parseReadyFrontierCanonicalReadV1(value: unknown, integrityKeyValue: unknown): ReadyFrontierCanonicalReadV1 {
  const hostKey = exactHostUint8ArrayV1(integrityKeyValue, 128);
  if (!hostKey || hostKey.byteLength < 32) fail("integrity_failed");
  const key = hostKey.copy();
  try {
    const read = parseExactReadyFrontierV1(readyFrontierCanonicalReadSchemaV1, value) as ReadyFrontierCanonicalReadV1;
    const unsigned = canonicalReadUnsigned(read), payloadDigest = sha256Digest(unsigned.payload);
    const readDigest = sha256Digest({ ...unsigned, payloadDigest });
    const { payloadDigest: _payload, readDigest: _read, readAuthTag: _tag, ...actualUnsigned } = read;
    void _payload; void _read; void _tag;
    if (!same(read.payloadDigest, payloadDigest) || !same(read.readDigest, readDigest)
      || !same(read.readAuthTag, readTag(key, { ...unsigned, readDigest }))
      || canonicalJson(actualUnsigned) !== canonicalJson(unsigned)) {
      fail("integrity_failed");
    }
    return deepFreeze(read);
  } finally { key.fill(0); }
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertReadBinding(read: ReadyFrontierCanonicalReadV1, request: ReadyFrontierManualCycleRequestV1): void {
  if (read.readGroupId !== request.readGroupId || read.tenantId !== request.tenantId || read.revision !== request.sourceRevision
    || read.observedAt !== request.sourceObservedAt || !equalStrings(read.projectIds, request.projectIds)) fail("scope_mismatch");
}

export function composeReadyFrontierCanonicalSourceV1(requestValue: unknown, readValuesValue: unknown,
  integrityKeyValue: unknown): ReadyFrontierSourceSnapshotV1 {
  const request = parseExactReadyFrontierV1(readyFrontierManualCycleRequestSchemaV1, requestValue) as ReadyFrontierManualCycleRequestV1;
  const requestedProjects = sortedUnique(request.projectIds);
  const readValues = exactHostDataArrayV1(readValuesValue, 4);
  if (!equalStrings(requestedProjects, request.projectIds)
    || exactInstant(request.sourceObservedAt) > exactInstant(request.evaluatedAt)
    || !readValues || readValues.length !== 4) fail("invalid_input");
  const reads = readValues.map((value) => parseReadyFrontierCanonicalReadV1(value, integrityKeyValue));
  if (new Set(reads.map((read) => read.channel)).size !== 4) fail("scope_mismatch");
  for (const read of reads) assertReadBinding(read, request);
  const projectsRead = reads.find((read): read is ReadyFrontierProjectCanonicalReadV1 => read.channel === "projects");
  const workRead = reads.find((read): read is ReadyFrontierWorkCanonicalReadV1 => read.channel === "work");
  const attentionRead = reads.find((read): read is ReadyFrontierAttentionCanonicalReadV1 => read.channel === "attention");
  const capacityRead = reads.find((read): read is ReadyFrontierCapacityCanonicalReadV1 => read.channel === "capacity");
  if (!projectsRead || !workRead || !attentionRead || !capacityRead) fail("scope_mismatch");

  const projectIds = projectsRead.payload.projects.map((project) => project.projectId);
  if (!equalStrings(projectIds, requestedProjects)) fail("scope_mismatch");
  const projectSet = new Set(projectIds), candidateIds = workRead.payload.candidates.map((candidate) => candidate.candidateId);
  const attentionIds = attentionRead.payload.attention.map((item) => item.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length || new Set(attentionIds).size !== attentionIds.length
    || !equalStrings(candidateIds, attentionIds)) fail("scope_mismatch");
  for (const value of [...workRead.payload.candidates, ...workRead.payload.canonicalWork, ...workRead.payload.dependencyTruth,
    ...attentionRead.payload.attention]) {
    if (!projectSet.has(value.projectId)) fail("scope_mismatch");
  }
  const attentionByCandidate = new Map(attentionRead.payload.attention.map((item) => [item.candidateId, item]));
  const candidates = workRead.payload.candidates.map((candidate) => {
    const attention = attentionByCandidate.get(candidate.candidateId);
    if (!attention || attention.projectId !== candidate.projectId || exactInstant(attention.observedAt) > exactInstant(request.sourceObservedAt)) {
      fail("scope_mismatch");
    }
    return { ...candidate, reviewTruth: attention.reviewTruth, blockerCodes: attention.blockerCodes,
      evidenceDigests: sortedUnique([...candidate.evidenceDigests, attention.evidenceDigest]) };
  });
  const readDigests = reads.map((read) => `${read.channel}:${read.readDigest}`).sort();
  return buildReadyFrontierSourceV1({
    schema: READY_FRONTIER_SOURCE_V1,
    tenantId: request.tenantId,
    snapshotId: `frontier.snapshot.${sha256Digest({ readGroupId: request.readGroupId, readDigests }).slice(7, 39)}`,
    sourceRevision: request.sourceRevision,
    historyRevision: request.historyRevision,
    observedAt: request.sourceObservedAt,
    projects: projectsRead.payload.projects,
    routes: capacityRead.payload.routes,
    dependencyTruth: workRead.payload.dependencyTruth,
    candidates,
    canonicalWork: workRead.payload.canonicalWork,
    priorProposals: [],
    retainsRawInputContent: false,
    retainsUsableAccessData: false,
    retainsPrivateLocators: false,
  });
}
