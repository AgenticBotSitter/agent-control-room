import { freezePublicDataV1 } from "@control-room/public-core";
import {
  runObservationAdapterConformanceV1,
  type ObservationAdapterV1,
  type ObservationConformanceResultV1,
  type ObservationFixtureV1,
} from "@control-room/observation-adapter-sdk";
import { types as nodeTypes } from "node:util";

export const OBSERVATION_CONFORMANCE_KIT_VERSION_V1 = "control-room-observation-conformance-kit/v1" as const;

export interface ObservationConformanceCaseV1 {
  caseId: string;
  adapter: ObservationAdapterV1;
  compatibilityEvidence: unknown;
  fixtures: readonly ObservationFixtureV1[];
}

export interface ObservationConformanceReportV1 {
  kitVersion: typeof OBSERVATION_CONFORMANCE_KIT_VERSION_V1;
  passed: boolean;
  results: readonly ObservationConformanceResultV1[];
}

function ordinaryArrayValuesV1(value: unknown): unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("conformance cases invalid");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 100) throw new TypeError("conformance cases invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== lengthDescriptor.value + 1 || keys.some((key) => typeof key !== "string")) throw new TypeError("conformance cases invalid");
  return Array.from({ length: lengthDescriptor.value }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || descriptor.get || descriptor.set) throw new TypeError("conformance case invalid");
    return descriptor.value;
  });
}

function ordinaryCaseValuesV1(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value)) throw new TypeError("conformance case invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("conformance case invalid");
  const expected = ["adapter", "caseId", "compatibilityEvidence", "fixtures"];
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") || (keys as string[]).sort().join("|") !== expected.join("|")) throw new TypeError("conformance case invalid");
  const result: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || descriptor.get || descriptor.set) throw new TypeError("conformance case invalid");
    result[key] = descriptor.value;
  }
  return result;
}

/** Evaluates supplied adapter code against in-memory cases. It is a validator, not a JavaScript sandbox. */
export function runObservationConformanceKitV1(cases: readonly ObservationConformanceCaseV1[]): ObservationConformanceReportV1 {
  const seen = new Set<string>();
  const results: ObservationConformanceResultV1[] = [];
  let items: unknown[];
  try { items = ordinaryArrayValuesV1(cases); }
  catch { return freezePublicDataV1({ kitVersion: OBSERVATION_CONFORMANCE_KIT_VERSION_V1, passed: false, results: [{ adapterId: "adapter:invalid", compatible: false, normalizedEventCount: 0, reasons: ["fixture_invalid"] }] }); }
  for (const rawItem of items) {
    let item: Record<string, unknown>;
    try { item = ordinaryCaseValuesV1(rawItem); }
    catch {
      results.push({ adapterId: "adapter:invalid", compatible: false, normalizedEventCount: 0, reasons: ["fixture_invalid"] });
      continue;
    }
    if (typeof item.caseId !== "string" || !/^[a-z][a-z0-9._:-]{2,180}$/.test(item.caseId) || seen.has(item.caseId)) {
      results.push({ adapterId: "adapter:invalid", compatible: false, normalizedEventCount: 0, reasons: ["fixture_invalid"] });
      continue;
    }
    seen.add(item.caseId);
    results.push(runObservationAdapterConformanceV1({ adapter: item.adapter as ObservationAdapterV1, compatibilityEvidence: item.compatibilityEvidence, fixtures: item.fixtures as ObservationFixtureV1[] }));
  }
  return freezePublicDataV1({ kitVersion: OBSERVATION_CONFORMANCE_KIT_VERSION_V1, passed: results.length > 0 && results.every((result) => result.compatible), results });
}
