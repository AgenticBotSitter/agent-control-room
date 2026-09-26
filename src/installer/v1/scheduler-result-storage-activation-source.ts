import { types } from "node:util";
import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";

/**
 * Source-only assessment of the common scheduler/result-storage activation
 * gap. Current scheduler settings and backup/restore records are public data
 * shapes, not opaque producer evidence. Supplying either shape must therefore
 * refuse rather than upgrade it into activation proof. This adapter can emit
 * only a blocked assessment; it owns no issuer, callback, store, or effect.
 */
export const SCHEDULER_RESULT_STORAGE_ACTIVATION_SOURCE_V1 =
  "control-room.scheduler-result-storage-activation-source/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const installationId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u);
const inputNames = ["installationId", "releaseDigest", "topologyPlanDigest",
  "schedulerReadinessEvidence", "protectedStorageRestoreEvidence"] as const;
const schema = z.object({ schema: z.literal(SCHEDULER_RESULT_STORAGE_ACTIVATION_SOURCE_V1),
  installationId, releaseDigest: digest, topologyPlanDigest: digest,
  state: z.literal("blocked"), blocker: z.literal("opaque_scheduler_and_restore_proof_missing"),
  acceptsStructuralSchedulerSettings: z.literal(false),
  acceptsStructuralRestoreRecord: z.literal(false), performsEffect: z.literal(false),
  opensScheduler: z.literal(false), opensStorage: z.literal(false), runsBackup: z.literal(false),
  runsRestore: z.literal(false), startsService: z.literal(false), evidenceDigest: digest }).strict();
export type SchedulerResultStorageActivationSourceV1 = Readonly<z.infer<typeof schema>>;
const verifiedNames = ["schema", "installationId", "releaseDigest", "topologyPlanDigest", "state", "blocker",
  "acceptsStructuralSchedulerSettings", "acceptsStructuralRestoreRecord", "performsEffect", "opensScheduler",
  "opensStorage", "runsBackup", "runsRestore", "startsService", "evidenceDigest"] as const;

function refused(): never { const error = new Error("scheduler_result_storage_activation_source_refused");
  error.stack = undefined; throw error; }
function exact(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== inputNames.length || keys.some(key => !inputNames.includes(key as typeof inputNames[number])))
    return refused();
  const captured: Record<string, unknown> = {};
  for (const name of inputNames) { const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return refused(); captured[name] = descriptor.value; }
  return captured;
}

/** Snapshot the complete retained report before the structural parser can
 * inspect it. Every field is primitive, so class instances, accessors,
 * inherited values, proxies, and nested capability shapes are all refused. */
function captureVerified(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== verifiedNames.length || keys.some(key => !verifiedNames.includes(key as typeof verifiedNames[number])))
    return refused();
  const captured: Record<string, unknown> = {};
  for (const name of verifiedNames) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)
      || (typeof descriptor.value !== "string" && typeof descriptor.value !== "boolean")) return refused();
    captured[name] = descriptor.value;
  }
  return Object.freeze(captured);
}

/**
 * Records absence only. When concrete producer modules expose opaque,
 * installation-bound consumers, this adapter can be revised to consume those
 * exact capabilities. Until then, any supplied evidence is necessarily an
 * unsupported structural substitute and is refused.
 */
export function assessSchedulerResultStorageActivationSourceV1(value: unknown):
SchedulerResultStorageActivationSourceV1 {
  const input = exact(value);
  if (input.schedulerReadinessEvidence !== undefined || input.protectedStorageRestoreEvidence !== undefined)
    return refused();
  const material = { schema: SCHEDULER_RESULT_STORAGE_ACTIVATION_SOURCE_V1,
    installationId: installationId.parse(input.installationId), releaseDigest: digest.parse(input.releaseDigest),
    topologyPlanDigest: digest.parse(input.topologyPlanDigest), state: "blocked" as const,
    blocker: "opaque_scheduler_and_restore_proof_missing" as const,
    acceptsStructuralSchedulerSettings: false as const, acceptsStructuralRestoreRecord: false as const,
    performsEffect: false as const, opensScheduler: false as const, opensStorage: false as const,
    runsBackup: false as const, runsRestore: false as const, startsService: false as const };
  return Object.freeze(schema.parse({ ...material, evidenceDigest: sha256Digest({
    purpose: "scheduler-result-storage-activation-source/v1", assessment: material }) }));
}

/** Rechecks a retained, redacted assessment before another private projection
 * can present it. This accepts no structural scheduler or restore evidence. */
export function verifySchedulerResultStorageActivationSourceV1(value: unknown):
SchedulerResultStorageActivationSourceV1 {
  try {
    const parsed = schema.parse(captureVerified(value));
    const { evidenceDigest, ...material } = parsed;
    if (evidenceDigest !== sha256Digest({ purpose: "scheduler-result-storage-activation-source/v1", assessment: material }))
      return refused();
    return Object.freeze(parsed);
  } catch { return refused(); }
}
