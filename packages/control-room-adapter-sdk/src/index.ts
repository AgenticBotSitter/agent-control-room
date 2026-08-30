import {
  assertNoSensitiveValuesV1,
  freezePublicDataV1,
  observationAdapterManifestSchemaV1,
  observationEventSchemaV1,
  snapshotPublicDataV1,
  type ObservationAdapterManifestV1,
  type ObservationEventV1,
} from "@control-room/public-core";
import { types as nodeTypes } from "node:util";

export const OBSERVATION_ADAPTER_SDK_VERSION_V1 = "control-room-observation-adapter-sdk/v1" as const;

export interface ObservationContextV1 {
  tenantId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
}

export interface ObservationCompatibilityV1 { compatible: boolean; reasons: string[]; }
export interface ObservationAdapterV1 {
  sdkVersion: typeof OBSERVATION_ADAPTER_SDK_VERSION_V1;
  manifest: ObservationAdapterManifestV1;
  evaluateCompatibility(evidence: unknown): ObservationCompatibilityV1;
  normalizeObservation(frame: unknown, context: ObservationContextV1): { events: ObservationEventV1[] };
}
export interface ObservationFixtureV1 { name: string; frame: unknown; context: ObservationContextV1; expectedEventCount: number; }
export interface ObservationConformanceResultV1 {
  adapterId: string;
  compatible: boolean;
  normalizedEventCount: number;
  reasons: Array<"compatibility_rejected" | "fixture_invalid" | "normalization_failed">;
}

const ADAPTER_KEYS_V1 = ["evaluateCompatibility", "manifest", "normalizeObservation", "sdkVersion"] as const;

function exactObjectValuesV1(value: unknown, expectedKeys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) throw new TypeError(`${label} must be an ordinary object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} prototype invalid`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") || (keys as string[]).sort().join("|") !== [...expectedKeys].sort().join("|")) throw new TypeError(`${label} shape invalid`);
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || descriptor.get || descriptor.set) throw new TypeError(`${label} property invalid`);
    result[key] = descriptor.value;
  }
  return result;
}

function collectAdapterV1(value: unknown): ObservationAdapterV1 {
  const parts = exactObjectValuesV1(value, ADAPTER_KEYS_V1, "adapter");
  if (parts.sdkVersion !== OBSERVATION_ADAPTER_SDK_VERSION_V1 || typeof parts.evaluateCompatibility !== "function" || typeof parts.normalizeObservation !== "function") {
    throw new TypeError("adapter member invalid");
  }
  const manifestInput = snapshotPublicDataV1(parts.manifest);
  const manifest = observationAdapterManifestSchemaV1.parse(manifestInput);
  assertNoSensitiveValuesV1(manifest, "adapter manifest");
  return Object.freeze({
    sdkVersion: OBSERVATION_ADAPTER_SDK_VERSION_V1,
    manifest: freezePublicDataV1(manifest),
    evaluateCompatibility: parts.evaluateCompatibility as ObservationAdapterV1["evaluateCompatibility"],
    normalizeObservation: parts.normalizeObservation as ObservationAdapterV1["normalizeObservation"],
  });
}

function parseContextV1(value: unknown): ObservationContextV1 {
  const context = exactObjectValuesV1(snapshotPublicDataV1(value), ["occurredAt", "runId", "sequence", "tenantId"], "observation context");
  if (typeof context.tenantId !== "string" || typeof context.runId !== "string" || !Number.isSafeInteger(context.sequence) || (context.sequence as number) <= 0
    || typeof context.occurredAt !== "string" || new Date(Date.parse(context.occurredAt)).toISOString() !== context.occurredAt) throw new TypeError("observation context invalid");
  return freezePublicDataV1(context as unknown as ObservationContextV1);
}

function parseCompatibilityV1(value: unknown): ObservationCompatibilityV1 {
  const decision = exactObjectValuesV1(snapshotPublicDataV1(value), ["compatible", "reasons"], "compatibility decision");
  if (typeof decision.compatible !== "boolean" || !Array.isArray(decision.reasons) || decision.reasons.some((reason) => typeof reason !== "string" || !/^[a-z][a-z0-9_]{2,63}$/.test(reason))
    || (decision.compatible ? decision.reasons.length !== 0 : decision.reasons.length === 0)) throw new TypeError("compatibility decision invalid");
  return freezePublicDataV1(decision as unknown as ObservationCompatibilityV1);
}

function invalidResultV1(adapterId: string, normalizedEventCount: number, reason: ObservationConformanceResultV1["reasons"][number]): ObservationConformanceResultV1 {
  return freezePublicDataV1({ adapterId, compatible: false, normalizedEventCount, reasons: [reason] });
}

/** Makes an adapter immutable and validates its public manifest before any observations are read. */
export function defineObservationAdapterV1(adapter: ObservationAdapterV1): ObservationAdapterV1 {
  return collectAdapterV1(adapter);
}

/** Runs supplied adapter code and fixtures only. The caller must isolate and trust adapter code; this function is not a JavaScript sandbox. */
export function runObservationAdapterConformanceV1(input: {
  adapter: ObservationAdapterV1;
  compatibilityEvidence: unknown;
  fixtures: readonly ObservationFixtureV1[];
}): ObservationConformanceResultV1 {
  let adapter: ObservationAdapterV1, compatibilityEvidence: unknown, fixtures: unknown[];
  try {
    const parts = exactObjectValuesV1(input, ["adapter", "compatibilityEvidence", "fixtures"], "conformance input");
    adapter = collectAdapterV1(parts.adapter);
    compatibilityEvidence = freezePublicDataV1(parts.compatibilityEvidence);
    const fixtureSnapshot = snapshotPublicDataV1(parts.fixtures);
    if (!Array.isArray(fixtureSnapshot)) throw new TypeError("fixtures invalid");
    fixtures = fixtureSnapshot;
  } catch { return invalidResultV1("adapter:invalid", 0, "fixture_invalid"); }
  let decision: ObservationCompatibilityV1;
  try { decision = parseCompatibilityV1(adapter.evaluateCompatibility.call(undefined, compatibilityEvidence)); }
  catch { return invalidResultV1(adapter.manifest.adapterId, 0, "compatibility_rejected"); }
  if (!decision.compatible) return invalidResultV1(adapter.manifest.adapterId, 0, "compatibility_rejected");
  let normalizedEventCount = 0;
  const keys = new Set<string>();
  for (const rawFixture of fixtures) {
    let fixture: ObservationFixtureV1, context: ObservationContextV1;
    try {
      const parts = exactObjectValuesV1(rawFixture, ["context", "expectedEventCount", "frame", "name"], "fixture");
      context = parseContextV1(parts.context);
      if (typeof parts.name !== "string" || !Number.isInteger(parts.expectedEventCount) || (parts.expectedEventCount as number) < 0 || (parts.expectedEventCount as number) > 10) throw new TypeError("fixture invalid");
      fixture = { name: parts.name, frame: freezePublicDataV1(parts.frame), context, expectedEventCount: parts.expectedEventCount as number };
    } catch { return invalidResultV1(adapter.manifest.adapterId, normalizedEventCount, "fixture_invalid"); }
    let output: { events: ObservationEventV1[] };
    try {
      const rawOutput = adapter.normalizeObservation.call(undefined, fixture.frame, fixture.context);
      output = snapshotPublicDataV1(rawOutput);
      assertNoSensitiveValuesV1(output, "normalized observation");
    } catch { return invalidResultV1(adapter.manifest.adapterId, normalizedEventCount, "normalization_failed"); }
    if (!output || !Array.isArray(output.events) || output.events.length !== fixture.expectedEventCount || output.events.length > 10) {
      return invalidResultV1(adapter.manifest.adapterId, normalizedEventCount, "normalization_failed");
    }
    try {
      for (const [index, event] of output.events.entries()) {
        const parsed = observationEventSchemaV1.parse(event);
        if (parsed.tenantId !== fixture.context.tenantId || parsed.runId !== fixture.context.runId || parsed.sequence !== fixture.context.sequence + index
          || parsed.occurredAt !== fixture.context.occurredAt || keys.has(parsed.sourceEventKeyDigest)) throw new TypeError("event boundary invalid");
        keys.add(parsed.sourceEventKeyDigest);
      }
    } catch { return invalidResultV1(adapter.manifest.adapterId, normalizedEventCount, "normalization_failed"); }
    normalizedEventCount += output.events.length;
  }
  return freezePublicDataV1({ adapterId: adapter.manifest.adapterId, compatible: true, normalizedEventCount, reasons: [] });
}
