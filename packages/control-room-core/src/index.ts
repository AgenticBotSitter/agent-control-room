import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { z } from "zod";

/** Stable, public-only contracts for observing a harness without controlling it. */
export const PUBLIC_OBSERVATION_CONTRACT_V1 = "control-room-public-observation/v1" as const;
export const PUBLIC_OBSERVATION_EVENT_V1 = "control-room-public-observation-event/v1" as const;

const identifier = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const version = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const observationKindsV1 = ["discover", "stream", "usage"] as const;
export type ObservationKindV1 = (typeof observationKindsV1)[number];

export const observationAdapterManifestSchemaV1 = z.object({
  schemaVersion: z.literal(PUBLIC_OBSERVATION_CONTRACT_V1),
  adapterId: identifier,
  adapterVersion: version,
  harness: z.enum(["hermes", "codex", "example", "other"]),
  harnessVersion: version,
  harnessRevision: z.string().regex(/^[a-f0-9]{40}$/),
  runtime: z.object({ name: z.enum(["node", "synthetic"]), minimumVersion: version, supportedPlatforms: z.array(z.enum(["linux", "macos", "windows"])).min(1).max(3) }).strict(),
  observationKinds: z.array(z.enum(observationKindsV1)).min(1).max(3),
  eventSchemaVersion: z.literal(PUBLIC_OBSERVATION_EVENT_V1),
  effectAuthority: z.literal("none"),
  accessMode: z.literal("none"),
  outputForms: z.array(z.enum(["structured_events", "usage"])) .min(1).max(2),
  license: z.string().min(1).max(80),
  distribution: z.literal("redistributable"),
}).strict().superRefine((value, context) => {
  for (const field of ["observationKinds", "outputForms", "runtime.supportedPlatforms"] as const) {
    const values = field === "runtime.supportedPlatforms" ? value.runtime.supportedPlatforms : value[field];
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: `${field} must be unique`, path: field.split(".") });
  }
});
export type ObservationAdapterManifestV1 = z.infer<typeof observationAdapterManifestSchemaV1>;

const observationPayloadSchemaV1 = z.discriminatedUnion("category", [
  z.object({ category: z.literal("transport"), state: z.enum(["connected", "disconnected", "drift"]), reasonCode: identifier.optional() }).strict(),
  z.object({ category: z.literal("activity"), activity: z.enum(["tool", "file", "test", "checkpoint"]), phase: z.enum(["observed", "progress", "completed", "failed"]), count: count.optional() }).strict(),
  z.object({ category: z.literal("usage"), inputTokens: count, outputTokens: count, cachedInputTokens: count, reasoningTokens: count }).strict(),
]);

export const observationEventSchemaV1 = z.object({
  schemaVersion: z.literal(PUBLIC_OBSERVATION_EVENT_V1),
  tenantId: identifier,
  runId: identifier,
  sequence: z.number().int().positive(),
  occurredAt: timestamp,
  source: z.literal("adapter"),
  sourceEventKeyDigest: digest,
  payload: observationPayloadSchemaV1,
}).strict();
export type ObservationEventV1 = z.infer<typeof observationEventSchemaV1>;

type Canonical = null | boolean | number | string | readonly Canonical[] | { readonly [key: string]: Canonical };

const MAX_PUBLIC_DATA_DEPTH_V1 = 64;
const MAX_PUBLIC_DATA_NODES_V1 = 10_000;
const MAX_PUBLIC_DATA_KEYS_V1 = 512;
const MAX_PUBLIC_DATA_KEY_LENGTH_V1 = 256;
const MAX_PUBLIC_STRING_LENGTH_V1 = 1_000_000;
const FORBIDDEN_PUBLIC_DATA_KEYS_V1 = new Set(["__proto__", "constructor", "prototype"]);

interface PublicDataSnapshotStateV1 { readonly seen: WeakSet<object>; nodes: number; }

function snapshotPublicDataInternalV1(value: unknown, state: PublicDataSnapshotStateV1, depth: number): Canonical {
  if (depth > MAX_PUBLIC_DATA_DEPTH_V1 || ++state.nodes > MAX_PUBLIC_DATA_NODES_V1) throw new TypeError("public data exceeds structural limits");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_PUBLIC_STRING_LENGTH_V1) throw new TypeError("public data string too large");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("public data must contain finite numbers");
    return value;
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value) || state.seen.has(value)) throw new TypeError("public data must be acyclic ordinary data");
  state.seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new TypeError("public data array prototype invalid");
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_PUBLIC_DATA_KEYS_V1) throw new TypeError("public data array length invalid");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== lengthDescriptor.value + 1 || keys.some((key) => typeof key !== "string")) throw new TypeError("public data array shape invalid");
    const result: Canonical[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || descriptor.get || descriptor.set) throw new TypeError("public data array entry invalid");
      result.push(snapshotPublicDataInternalV1(descriptor.value, state, depth + 1));
    }
    return result;
  }
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("public data must be plain data");
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_PUBLIC_DATA_KEYS_V1 || keys.some((key) => typeof key !== "string")) throw new TypeError("public data object shape invalid");
  const result = Object.create(null) as Record<string, Canonical>;
  for (const rawKey of keys) {
    if (typeof rawKey !== "string") throw new TypeError("public data object shape invalid");
    const key = rawKey;
    if (key.length === 0 || key.length > MAX_PUBLIC_DATA_KEY_LENGTH_V1 || FORBIDDEN_PUBLIC_DATA_KEYS_V1.has(key)) throw new TypeError("public data property name invalid");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || descriptor.get || descriptor.set) throw new TypeError("public data property invalid");
    Object.defineProperty(result, key, { value: snapshotPublicDataInternalV1(descriptor.value, state, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

/** Copies only bounded, dense, accessor-free, non-Proxy JSON-shaped data. */
export function snapshotPublicDataV1<T>(value: T): T {
  return snapshotPublicDataInternalV1(value, { seen: new WeakSet<object>(), nodes: 0 }, 0) as T;
}

function canonicalizeSnapshotV1(value: Canonical): Canonical {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeSnapshotV1);
  const objectValue = value as { readonly [key: string]: Canonical };
  const result = Object.create(null) as Record<string, Canonical>;
  for (const key of Object.keys(objectValue).sort()) Object.defineProperty(result, key, { value: canonicalizeSnapshotV1(objectValue[key]!), enumerable: true, writable: true, configurable: true });
  return result;
}

/** Hashes only canonical plain data; it never reads files, processes, or environment values. */
export function sha256DigestV1(value: unknown): string {
  const snapshot = snapshotPublicDataV1(value) as Canonical;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalizeSnapshotV1(snapshot))).digest("hex")}`;
}

/** Rejects values that look like sensitive material before an observation is returned. */
export function assertNoSensitiveValuesV1(value: unknown, label: string): void {
  const sensitiveKey = /(?:secret|password|authorization|cookie|private[_-]?key)/i;
  const sensitiveValue = /(?:-----BEGIN [A-Z ]+-----|(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,})/;
  const visit = (current: Canonical, path: string): void => {
    if (typeof current === "string") {
      if (sensitiveValue.test(current)) throw new TypeError(`${label} includes sensitive material at ${path}`);
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (Array.isArray(current)) { current.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
    const objectValue = current as { readonly [key: string]: Canonical };
    for (const key of Object.keys(objectValue)) {
      if (sensitiveKey.test(key)) throw new TypeError(`${label} includes a sensitive key at ${path}.${key}`);
      visit(objectValue[key]!, `${path}.${key}`);
    }
  };
  visit(snapshotPublicDataV1(value) as Canonical, "$");
}

function freezeSnapshotV1<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) freezeSnapshotV1((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

export function freezePublicDataV1<T>(value: T): T {
  return freezeSnapshotV1(snapshotPublicDataV1(value));
}
