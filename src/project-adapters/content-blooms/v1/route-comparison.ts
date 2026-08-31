import { z } from "zod";
import { sha256Digest } from "../../../security";
import { ContentBloomsContractErrorV1 } from "./errors";
import { parseExactContentBloomsV1 } from "./exact";
import { parseContentBloomsOperationalRecordV1 } from "./records";
import { contentBloomsDigestSchemaV1, contentBloomsSafeIdSchemaV1, contentBloomsTimeSchemaV1 } from "./schemas";
import {
  CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
  type ContentBloomsRouteComparisonPolicyV1,
  type ContentBloomsRouteComparisonV1,
  type ContentBloomsTranscriptionRouteObservationV1,
} from "./types";

const privacyClasses = ["local", "approved_provider", "restricted"] as const;
const routeObservationInputSchemaV1 = z.object({
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  routeId: contentBloomsSafeIdSchemaV1,
  workerRefDigest: contentBloomsDigestSchemaV1,
  platform: z.enum(["macos", "windows", "linux"]),
  runtimeClass: z.enum(["whisper_mlx", "whisper_cuda", "whisper_cpu"]),
  state: z.enum(["idle", "busy", "offline"]),
  verification: z.enum(["verified", "provisional", "expired", "unavailable"]),
  estimatedDurationSeconds: z.number().int().positive().max(604_800),
  estimatedCostMilliUsd: z.number().int().min(0).max(1_000_000_000),
  qualityRank: z.number().int().min(1).max(5),
  privacyClass: z.enum(privacyClasses),
  benchmarkVersion: contentBloomsSafeIdSchemaV1,
  benchmarkDigest: contentBloomsDigestSchemaV1,
  observedAt: contentBloomsTimeSchemaV1,
  validUntil: contentBloomsTimeSchemaV1,
}).strict();

const routeObservationSchemaV1 = routeObservationInputSchemaV1.extend({
  contractVersion: z.literal(CONTENT_BLOOMS_ADAPTER_CONTRACT_V1),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  routeDigest: contentBloomsDigestSchemaV1,
}).strict();

const policyInputSchemaV1 = z.object({
  policyId: contentBloomsSafeIdSchemaV1,
  maxCostMilliUsd: z.number().int().min(0).max(1_000_000_000),
  minimumQualityRank: z.number().int().min(1).max(5),
  allowedPrivacyClasses: z.array(z.enum(privacyClasses)).min(1).max(3),
  allowBusy: z.boolean(),
  durationWeight: z.number().int().min(0).max(100),
  costWeight: z.number().int().min(0).max(100),
  qualityWeight: z.number().int().min(0).max(100_000),
  privacyWeight: z.number().int().min(0).max(100_000),
}).strict();

const policySchemaV1 = policyInputSchemaV1.extend({
  contractVersion: z.literal(CONTENT_BLOOMS_ADAPTER_CONTRACT_V1),
  policyDigest: contentBloomsDigestSchemaV1,
}).strict();

const rankedRouteSchemaV1 = z.object({
  routeId: contentBloomsSafeIdSchemaV1,
  routeDigest: contentBloomsDigestSchemaV1,
  score: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  rank: z.number().int().positive().max(100),
}).strict();

const comparisonSchemaV1 = z.object({
  contractVersion: z.literal(CONTENT_BLOOMS_ADAPTER_CONTRACT_V1),
  comparisonId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  workItemSourceRecordId: contentBloomsSafeIdSchemaV1,
  workItemRecordDigest: contentBloomsDigestSchemaV1,
  policyId: contentBloomsSafeIdSchemaV1,
  policyDigest: contentBloomsDigestSchemaV1,
  consideredRouteDigests: z.array(contentBloomsDigestSchemaV1).max(100),
  eligibleRoutes: z.array(rankedRouteSchemaV1).max(100),
  rejectedRouteIds: z.array(contentBloomsSafeIdSchemaV1).max(100),
  recommendedRouteId: contentBloomsSafeIdSchemaV1.optional(),
  comparedAt: contentBloomsTimeSchemaV1,
  disposition: z.literal("source_preference_observation"),
  sourceMustDecide: z.literal(true),
  controlRoomMayAssign: z.literal(false),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  comparisonDigest: contentBloomsDigestSchemaV1,
}).strict();

const comparisonInputSchemaV1 = z.object({
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  workItem: z.unknown(),
  routes: z.array(z.unknown()).min(1).max(100),
  policy: z.unknown(),
  comparedAt: contentBloomsTimeSchemaV1,
}).strict();

function withoutDigest<T extends Record<string, unknown>>(value: T, key: keyof T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function atOrAfter(later: string, earlier: string): boolean {
  return Date.parse(later) >= Date.parse(earlier);
}

function sameScope(
  input: Pick<ContentBloomsTranscriptionRouteObservationV1, "tenantId" | "workspaceId" | "projectId" | "adapterId">,
  route: Pick<ContentBloomsTranscriptionRouteObservationV1, "tenantId" | "workspaceId" | "projectId" | "adapterId">,
): boolean {
  return input.tenantId === route.tenantId && input.workspaceId === route.workspaceId
    && input.projectId === route.projectId && input.adapterId === route.adapterId;
}

export function buildContentBloomsTranscriptionRouteObservationV1(inputValue: unknown): ContentBloomsTranscriptionRouteObservationV1 {
  const input = parseExactContentBloomsV1(routeObservationInputSchemaV1, inputValue);
  if (!atOrAfter(input.validUntil, input.observedAt) || input.validUntil === input.observedAt) {
    throw new ContentBloomsContractErrorV1("sequence_invalid");
  }
  const expectedRuntime = { macos: "whisper_mlx", windows: "whisper_cuda", linux: "whisper_cpu" } as const;
  if (input.runtimeClass !== expectedRuntime[input.platform]) throw new ContentBloomsContractErrorV1("invalid_input");
  const unsigned: Omit<ContentBloomsTranscriptionRouteObservationV1, "routeDigest"> = {
    contractVersion: CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
    ...input,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(routeObservationSchemaV1, {
    ...unsigned,
    routeDigest: sha256Digest(unsigned),
  }) as ContentBloomsTranscriptionRouteObservationV1;
}

export function parseContentBloomsTranscriptionRouteObservationV1(value: unknown): ContentBloomsTranscriptionRouteObservationV1 {
  const route = parseExactContentBloomsV1(routeObservationSchemaV1, value) as ContentBloomsTranscriptionRouteObservationV1;
  const expectedRuntime = { macos: "whisper_mlx", windows: "whisper_cuda", linux: "whisper_cpu" } as const;
  if (sha256Digest(withoutDigest(route as unknown as Record<string, unknown>, "routeDigest")) !== route.routeDigest
    || !atOrAfter(route.validUntil, route.observedAt) || route.validUntil === route.observedAt
    || route.runtimeClass !== expectedRuntime[route.platform]) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return route;
}

export function buildContentBloomsRouteComparisonPolicyV1(inputValue: unknown): ContentBloomsRouteComparisonPolicyV1 {
  const input = parseExactContentBloomsV1(policyInputSchemaV1, inputValue);
  if (new Set(input.allowedPrivacyClasses).size !== input.allowedPrivacyClasses.length) {
    throw new ContentBloomsContractErrorV1("invalid_input");
  }
  const unsigned: Omit<ContentBloomsRouteComparisonPolicyV1, "policyDigest"> = {
    contractVersion: CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
    ...input,
    allowedPrivacyClasses: [...input.allowedPrivacyClasses].sort(),
  };
  return parseExactContentBloomsV1(policySchemaV1, { ...unsigned, policyDigest: sha256Digest(unsigned) }) as ContentBloomsRouteComparisonPolicyV1;
}

export function parseContentBloomsRouteComparisonPolicyV1(value: unknown): ContentBloomsRouteComparisonPolicyV1 {
  const policy = parseExactContentBloomsV1(policySchemaV1, value) as ContentBloomsRouteComparisonPolicyV1;
  if (new Set(policy.allowedPrivacyClasses).size !== policy.allowedPrivacyClasses.length
    || policy.allowedPrivacyClasses.join("\0") !== [...policy.allowedPrivacyClasses].sort().join("\0")
    || sha256Digest(withoutDigest(policy as unknown as Record<string, unknown>, "policyDigest")) !== policy.policyDigest) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return policy;
}

export function compareContentBloomsTranscriptionRoutesV1(inputValue: unknown): ContentBloomsRouteComparisonV1 {
  const input = parseExactContentBloomsV1(comparisonInputSchemaV1, inputValue);
  const policy = parseContentBloomsRouteComparisonPolicyV1(input.policy);
  const workItem = parseContentBloomsOperationalRecordV1(input.workItem);
  if (!sameScope(input, workItem)) throw new ContentBloomsContractErrorV1("scope_mismatch");
  if (workItem.kind !== "work_item" || workItem.operation !== "upsert"
    || (workItem.projection as { requiredCapability?: string }).requiredCapability !== "transcription:whisper") {
    throw new ContentBloomsContractErrorV1("authority_conflation");
  }
  const routes = input.routes.map((route) => parseContentBloomsTranscriptionRouteObservationV1(route))
    .sort((left, right) => left.routeId.localeCompare(right.routeId));
  if (new Set(routes.map((route) => route.routeId)).size !== routes.length) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  for (const route of routes) {
    if (!sameScope(input, route)) throw new ContentBloomsContractErrorV1("scope_mismatch");
    if (!atOrAfter(input.comparedAt, route.observedAt)) throw new ContentBloomsContractErrorV1("sequence_invalid");
  }
  const rejectedRouteIds: string[] = [];
  const eligible = routes.flatMap((route) => {
    const eligibleRoute = route.verification === "verified"
      && Date.parse(route.validUntil) > Date.parse(input.comparedAt)
      && route.state !== "offline"
      && (route.state !== "busy" || policy.allowBusy)
      && route.estimatedCostMilliUsd <= policy.maxCostMilliUsd
      && route.qualityRank >= policy.minimumQualityRank
      && policy.allowedPrivacyClasses.includes(route.privacyClass);
    if (!eligibleRoute) {
      rejectedRouteIds.push(route.routeId);
      return [];
    }
    const privacyPenalty = route.privacyClass === "approved_provider" ? policy.privacyWeight : 0;
    const busyPenalty = route.state === "busy" ? 1_000_000 : 0;
    const score = route.estimatedDurationSeconds * policy.durationWeight
      + route.estimatedCostMilliUsd * policy.costWeight
      + (5 - route.qualityRank) * policy.qualityWeight
      + privacyPenalty
      + busyPenalty;
    if (!Number.isSafeInteger(score)) throw new ContentBloomsContractErrorV1("invalid_input");
    return [{ routeId: route.routeId, routeDigest: route.routeDigest, score }];
  }).sort((left, right) => left.score - right.score || left.routeId.localeCompare(right.routeId));
  const ranked = eligible.map((route, index) => ({ ...route, rank: index + 1 }));
  const unsigned: Omit<ContentBloomsRouteComparisonV1, "comparisonDigest"> = {
    contractVersion: CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
    comparisonId: `comparison:cb:${sha256Digest({
      workItemRecordDigest: workItem.recordDigest,
      policyDigest: policy.policyDigest,
      routes: routes.map((route) => route.routeDigest),
      comparedAt: input.comparedAt,
    }).slice(7, 39)}`,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    adapterId: input.adapterId,
    workItemSourceRecordId: workItem.sourceRecordId,
    workItemRecordDigest: workItem.recordDigest,
    policyId: policy.policyId,
    policyDigest: policy.policyDigest,
    consideredRouteDigests: routes.map((route) => route.routeDigest),
    eligibleRoutes: ranked,
    rejectedRouteIds,
    ...(ranked[0] ? { recommendedRouteId: ranked[0].routeId } : {}),
    comparedAt: input.comparedAt,
    disposition: "source_preference_observation",
    sourceMustDecide: true,
    controlRoomMayAssign: false,
    grantsApproval: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(comparisonSchemaV1, {
    ...unsigned,
    comparisonDigest: sha256Digest(unsigned),
  }) as ContentBloomsRouteComparisonV1;
}

export function parseContentBloomsRouteComparisonV1(value: unknown): ContentBloomsRouteComparisonV1 {
  const comparison = parseExactContentBloomsV1(comparisonSchemaV1, value) as ContentBloomsRouteComparisonV1;
  if (sha256Digest(withoutDigest(comparison as unknown as Record<string, unknown>, "comparisonDigest")) !== comparison.comparisonDigest
    || comparison.eligibleRoutes.some((route, index) => route.rank !== index + 1)
    || comparison.recommendedRouteId !== comparison.eligibleRoutes[0]?.routeId
    || new Set([...comparison.eligibleRoutes.map((route) => route.routeId), ...comparison.rejectedRouteIds]).size
      !== comparison.eligibleRoutes.length + comparison.rejectedRouteIds.length) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return comparison;
}
