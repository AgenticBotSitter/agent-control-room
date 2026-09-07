import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { parseCanonicalHttpsDestination } from "../../node-policy/v1/network-target-guard";
import { HERMES_NATIVE_ADAPTER, digestSchema, localId } from "./native-run-identifiers";
export { HERMES_NATIVE_ADAPTER, digestSchema, localId } from "./native-run-identifiers";

export const HERMES_NATIVE_REVISION = "29112bef099274229cadff79cdff7bf7b99c4b77" as const;
export const nativeLimits = Object.freeze({ requestBytes: 65_536, jsonBytes: 131_072, resultBytes: 65_536,
  eventBytes: 16_384, streamBytes: 1_048_576, streamEvents: 512, requestMs: 10_000, streamMs: 30_000 });
export const nativeId = z.string().regex(/^run_[a-f0-9]{32}$/);
export const profileName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = (bytes: number) => z.string().refine(value => Buffer.byteLength(value, "utf8") <= bytes);
export const enrollmentSchema = z.object({ adapter: z.literal(HERMES_NATIVE_ADAPTER), revision: z.literal(HERMES_NATIVE_REVISION),
  tenantId: localId, nodeId: localId, connectionId: localId, canonicalDestination: z.string().refine(value => {
    try { parseCanonicalHttpsDestination(value); return true; } catch { return false; }
  }), profile: profileName, credentialRef: localId, profilePolicyDigest: digestSchema, qualificationDigest: digestSchema,
  validUntil: instant, model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/),
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
}).strict();
/** Node-local reviewed configuration. Its digests are references, not self-issued host qualification.
 * The trusted authority port must resolve and verify their current accepted evidence before any I/O.
 */
export type NativeEnrollment = z.infer<typeof enrollmentSchema>;
export const startSchema = z.object({ tenantId: localId, nodeId: localId, projectId: localId, jobId: localId,
  attemptId: localId, runId: localId, effectClaimKey: digestSchema, operationDigest: digestSchema,
  prompt: text(32_768).min(1), instructions: text(8192), deadline: instant,
  maxCostUsd: z.string().optional(),
}).strict();
export type NativeStart = z.infer<typeof startSchema>;
export const bindingSchema = z.object({ adapter: z.literal(HERMES_NATIVE_ADAPTER), tenantId: localId, nodeId: localId,
  projectId: localId, jobId: localId, attemptId: localId, runId: localId, effectClaimKey: digestSchema,
  operationDigest: digestSchema, enrollmentDigest: digestSchema, requestDigest: digestSchema,
  sessionId: z.string().regex(/^cr_[a-f0-9]{64}$/), deadline: instant,
}).strict();
export type NativeBinding = z.infer<typeof bindingSchema>;
export type NativeStartBody = { input: string; instructions: string; session_id: string; model: string; provider: string };
export function bindNativeStart(enrollment: NativeEnrollment, value: unknown): { binding: NativeBinding; body: NativeStartBody } {
  const input = startSchema.parse(value);
  if (input.tenantId !== enrollment.tenantId || input.nodeId !== enrollment.nodeId || input.deadline > enrollment.validUntil
    || input.maxCostUsd !== undefined) throw new Error("native_start_not_supported");
  const sessionId = `cr_${sha256Digest({ adapter: HERMES_NATIVE_ADAPTER, tenantId: input.tenantId,
    projectId: input.projectId, attemptId: input.attemptId, effectClaimKey: input.effectClaimKey }).slice(7)}`;
  const body = { input: input.prompt, instructions: input.instructions, session_id: sessionId, model: enrollment.model, provider: enrollment.provider };
  const binding = bindingSchema.parse({ adapter: HERMES_NATIVE_ADAPTER, tenantId: input.tenantId, nodeId: input.nodeId,
    projectId: input.projectId, jobId: input.jobId, attemptId: input.attemptId, runId: input.runId,
    effectClaimKey: input.effectClaimKey, operationDigest: input.operationDigest, enrollmentDigest: sha256Digest(enrollment),
    requestDigest: sha256Digest(body), sessionId, deadline: input.deadline });
  return { binding: Object.freeze(binding), body: Object.freeze(body) };
}
export const nativeStates = ["prepared", "dispatching", "queued", "running", "waiting_approval", "stopping",
  "completed", "failed", "cancelled", "interrupted", "ambiguous"] as const;
export type NativeState = typeof nativeStates[number];
export const terminalNativeState = (state: NativeState) => ["completed", "failed", "cancelled", "interrupted"].includes(state);
export const usageSchema = z.object({ inputTokens: instant.nullable(),
  outputTokens: instant.nullable(), totalTokens: instant.nullable(),
  provenance: z.literal("upstream_reported"), cachedInputTokens: z.null(), reasoningTokens: z.null(),
  calls: z.null(), costUsd: z.null(), hardCostLimitEnforced: z.literal(false),
}).strict();
export type NativeUsage = z.infer<typeof usageSchema>;
export const snapshotSchema = z.object({ binding: bindingSchema, version: z.number().int().positive(),
  state: z.enum(nativeStates), nativeRunId: nativeId.nullable(), observedAt: instant, upstreamUpdatedAt: instant.nullable(),
  availability: z.enum(["unknown", "current", "offline", "expired"]), streamAttempted: z.boolean(), stopAttempted: z.boolean(),
  resultText: text(nativeLimits.resultBytes).nullable(), usage: usageSchema.nullable(),
  lastActivity: z.enum(["none", "tool_started", "tool_completed", "message_progress", "approval_requested", "status_resnapshot"]),
  safeReason: z.enum(["none", "preflight_failed", "dispatch_uncertain", "run_unavailable", "protocol_mismatch",
    "transport_unavailable", "authority_unavailable", "deadline_reached", "gateway_interrupted", "storage_uncertain"]),
}).strict();
export type NativeSnapshot = z.infer<typeof snapshotSchema>;
export interface NativeRunJournal {
  reserve(binding: NativeBinding, now: number): { created: boolean; snapshot: NativeSnapshot };
  load(runId: string): NativeSnapshot | undefined;
  update(runId: string, version: number, patch: Partial<Omit<NativeSnapshot, "binding" | "version">>): NativeSnapshot;
}
/** Only a known, rolled-back version conflict is retryable as a local observation update. */
export class NativeJournalVersionConflict extends Error {
  constructor() { super("native_journal_version_conflict"); }
}
export type NativeOperation = "capabilities" | "start" | "status" | "events" | "stop";
/** Trusted node controller seam, never provided by a browser/job payload. Check must verify current
 * ceiling/lease, pause, qualification/profile isolation, credential and exact task/payload binding.
 * markStart must durably commit the existing effect claim's pre-effect marker before returning.
 * stop needs its own exact-run preauthorized cleanup permission after the work deadline; not a grace period.
 */
export interface NativeAuthority {
  check(operation: NativeOperation, binding: NativeBinding): Promise<void>;
  markStart(binding: NativeBinding): Promise<void>;
}
export interface NativeWireRequest { operation: NativeOperation; nativeRunId?: string; body?: NativeStartBody;
  idempotencyKey?: string; sessionKey?: string; deadline: number; signal?: AbortSignal;
  /** Recheck current authority immediately before releasing authenticated HTTP bytes. */
  authorize: () => Promise<void> }
export interface NativeWireResponse { status: number; contentType: string; body: Uint8Array }
export interface NativeRunTransport {
  json(request: NativeWireRequest): Promise<NativeWireResponse>;
  events(request: NativeWireRequest, receive: (chunk: Uint8Array) => void): Promise<void>;
}
