import { z } from "zod";
import {
  CONTRACT_VERSION,
  allocationModes,
  authorityModes,
  normalizedStates,
  workerStates,
} from "./types";

const isoDate = z.string().datetime({ offset: true });
const safeId = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const sourceReferenceSchema = z.object({
  sourceSystem: safeId,
  adapterId: safeId,
  adapterVersion: z.literal(CONTRACT_VERSION),
  workspaceId: safeId,
  projectId: safeId,
  recordType: safeId,
  recordId: safeId,
  sourceVersion: z.string().min(1).max(180),
  sourceChecksum: z.string().max(256).optional(),
  observedAt: isoDate,
});

export const projectSummarySchema = z.object({
  id: safeId,
  source: sourceReferenceSchema,
  workspaceName: z.string().min(1).max(120),
  title: z.string().min(1).max(180),
  description: z.string().max(600).optional(),
  deepLink: z.string().url().optional(),
  normalizedState: z.enum(normalizedStates),
  domainState: z.string().min(1).max(120),
  health: z.enum(["healthy", "watch", "at_risk", "blocked"]),
  progressPercent: z.number().min(0).max(100).optional(),
  forecastAt: isoDate.optional(),
  attentionCount: z.number().int().min(0),
  blockerCount: z.number().int().min(0),
  priority: z.number().int().min(0).max(100),
  authorityMode: z.enum(authorityModes),
});

export const workerSchema = z.object({
  id: safeId,
  source: sourceReferenceSchema.optional(),
  displayName: z.string().min(1).max(120),
  machineId: safeId,
  runtimeId: safeId,
  nodeId: safeId,
  nodeVersion: z.number().int().nonnegative(),
  nodeState: z.enum(["active", "draining", "offline", "quarantined", "revoked"]),
  os: z.enum(["windows", "macos", "linux", "cloud"]),
  state: z.enum(workerStates),
  stateReason: z.string().max(300).optional(),
  lastHeartbeatAt: isoDate,
  availableSlots: z.number().int().min(0),
  totalSlots: z.number().int().positive(),
  scratchClass: z.enum(["healthy", "caution", "low", "critical"]),
  allocationMode: z.enum(allocationModes),
  preferredProjectIds: z.array(safeId).optional(),
  capabilities: z.array(
    z.object({
      id: safeId,
      capability: safeId,
      runtime: z.string().min(1).max(160),
      workerId: safeId,
      verification: z.enum(["verified", "provisional", "expired", "unavailable"]),
      estimatedDurationMinutes: z.number().positive().optional(),
      estimatedCostUsd: z.number().min(0).optional(),
      qualityClass: z.string().max(80).optional(),
      privacyClass: z.enum(["local", "approved_provider", "restricted"]).optional(),
      benchmarkVersion: z.string().max(120).optional(),
      benchmarkObservedAt: isoDate.optional(),
    }),
  ),
  currentWorkItemIds: z.array(safeId).optional(),
});

export const commandReceiptSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  receiptId: safeId,
  idempotencyKey: z.string().min(12).max(180),
  sourceCommandId: safeId.optional(),
  status: z.enum(["accepted", "rejected", "already_applied", "scheduled"]),
  appliedVersion: z.string().max(180).optional(),
  safeReasonCode: safeId.optional(),
  message: z.string().min(1).max(500),
  receivedAt: isoDate,
  completedAt: isoDate.optional(),
});

const forbiddenKeyFragments = [
  "transcript",
  "prompt",
  "draftbody",
  "draft_text",
  "rawmedia",
  "signedurl",
  "mediaurl",
  "voiceexample",
  "knowledgefact",
  "password",
  "secret",
  "apikey",
  "api_key",
  "credential",
  "token",
  "exceptionbody",
];

const forbiddenValuePatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /(?:api[_-]?key|password|secret)\s*[:=]\s*\S+/i,
  /(?:X-Amz-Signature|X-Amz-Credential)=/i,
  /bearer\s+[a-z0-9._-]{12,}/i,
];

const nativeArrayIsArray = Array.isArray, nativeError = Error, nativeObjectEntries = Object.entries,
  nativeReflectApply = Reflect.apply, nativeRegExpExec = RegExp.prototype.exec,
  nativeStringIncludes = String.prototype.includes, nativeStringToLowerCase = String.prototype.toLowerCase;

function patternMatches(pattern: RegExp, value: string): boolean {
  return nativeReflectApply(nativeRegExpExec, pattern, [value]) !== null;
}

function normalizedProjectionKey(value: string): string {
  const lowered = nativeReflectApply(nativeStringToLowerCase, value, []) as string;
  let normalized = "";
  for (let index = 0; index < lowered.length; index += 1) {
    const character = lowered[index];
    if (character && ((character >= "a" && character <= "z") || (character >= "0" && character <= "9")
      || character === "_")) normalized += character;
  }
  return normalized;
}

export function assertSafeProjection(value: unknown, path = "$"): void {
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    for (let index = 0; index < forbiddenValuePatterns.length; index += 1) {
      const pattern = forbiddenValuePatterns[index];
      if (pattern && patternMatches(pattern, value)) {
        throw new nativeError(`Unsafe projection value at ${path}`);
      }
    }
    return;
  }

  if (nativeArrayIsArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertSafeProjection(value[index], `${path}[${index}]`);
    return;
  }

  if (typeof value === "object") {
    const entries = nativeObjectEntries(value as Record<string, unknown>);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      const key = entry[0], child = entry[1], normalizedKey = normalizedProjectionKey(key);
      for (let fragmentIndex = 0; fragmentIndex < forbiddenKeyFragments.length; fragmentIndex += 1) {
        const fragment = forbiddenKeyFragments[fragmentIndex];
        if (fragment && nativeReflectApply(nativeStringIncludes, normalizedKey, [fragment]) as boolean) {
          throw new nativeError(`Forbidden projection field ${path}.${key}`);
        }
      }
      assertSafeProjection(child, `${path}.${key}`);
    }
  }
}

export function redactLogValue(value: unknown): unknown {
  assertSafeProjection(value);
  return value;
}
