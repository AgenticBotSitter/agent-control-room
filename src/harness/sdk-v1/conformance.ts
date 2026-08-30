import { assertNoSecretMaterial } from "../../security";
import { harnessAdapterManifestSchemaV1, harnessRunEventSchemaV1 } from "../v1";
import {
  HARNESS_ADAPTER_SDK_VERSION_V1,
  type HarnessAdapterConformanceFixtureV1,
  type HarnessAdapterConformanceResultV1,
  type HarnessAdapterV1,
} from "./types";

const safeReason = /^[a-z][a-z0-9_]{2,63}$/;

function deepFreeze<T>(value:T):T {
  if (value && typeof value==="object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey,unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function frozenDataSnapshot(value:unknown,keys:readonly string[],deep=false):Record<string,unknown>|undefined {
  if (!value || typeof value!=="object" || Array.isArray(value) || (Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null)
    || !Object.isFrozen(value)) return undefined;
  const own=Reflect.ownKeys(value); const expected=[...keys].sort();
  if (own.some((key)=>typeof key!=="string") || (own as string[]).sort().join("|")!==expected.join("|")) return undefined;
  const descriptors=Object.getOwnPropertyDescriptors(value); const snapshot:Record<string,unknown>={};
  for (const key of expected) {
    const descriptor=descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || descriptor.writable || descriptor.configurable || !descriptor.enumerable) return undefined;
    snapshot[key]=descriptor.value;
  }
  if (deep && !deepFrozenData(value)) return undefined;
  return snapshot;
}

function deepFrozenData(value:unknown,seen=new Set<object>()):boolean {
  if (value===null || ["string","number","boolean","undefined"].includes(typeof value)) return true;
  if (typeof value!=="object" || seen.has(value as object) || !Object.isFrozen(value)) return false;
  seen.add(value as object);
  const prototype=Object.getPrototypeOf(value);
  if (prototype!==Object.prototype && prototype!==Array.prototype && prototype!==null) return false;
  const descriptors=Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key!=="string") return false;
    const descriptor=descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || descriptor.writable || descriptor.configurable
      || !deepFrozenData(descriptor.value,seen)) return false;
  }
  return true;
}

/** Produces the only adapter shape accepted by conformance and freezes all returned data. */
export function defineHarnessAdapterV1(input:HarnessAdapterV1):HarnessAdapterV1 {
  const manifest=deepFreeze(input.manifest);
  return Object.freeze({sdkVersion:input.sdkVersion,manifest,
    evaluateCompatibility:(evidence:unknown)=>deepFreeze(input.evaluateCompatibility(evidence)),
    normalizeEvent:(frame:unknown,context:Parameters<HarnessAdapterV1["normalizeEvent"]>[1])=>deepFreeze(input.normalizeEvent(frame,context))});
}

function validContext(value: HarnessAdapterConformanceFixtureV1["context"]): boolean {
  return typeof value.tenantId === "string" && typeof value.nodeId === "string" && typeof value.runId === "string"
    && Number.isSafeInteger(value.sequence) && value.sequence > 0 && typeof value.occurredAt === "string"
    && new Date(Date.parse(value.occurredAt)).toISOString() === value.occurredAt;
}

/**
 * Verifies the stable public boundary. It deliberately does not invoke a harness,
 * open a process, load credentials, or assert that a declared verb is executable.
 */
export function runHarnessAdapterConformanceV1(input: {
  adapter: HarnessAdapterV1;
  compatibilityEvidence: unknown;
  fixtures: readonly HarnessAdapterConformanceFixtureV1[];
}): HarnessAdapterConformanceResultV1 {
  let adapter:Record<string,unknown>;
  try {
    const snapshot=frozenDataSnapshot(input.adapter,["sdkVersion","manifest","evaluateCompatibility","normalizeEvent"]);
    if (!snapshot || snapshot.sdkVersion!==HARNESS_ADAPTER_SDK_VERSION_V1 || typeof snapshot.evaluateCompatibility!=="function"
      || typeof snapshot.normalizeEvent!=="function" || !deepFrozenData(snapshot.manifest)) throw new Error("SDK shape invalid");
    adapter=snapshot;
    harnessAdapterManifestSchemaV1.parse(adapter.manifest); assertNoSecretMaterial(adapter.manifest,"adapter manifest");
  } catch { return { adapterId: "adapter:invalid", compatible: false, normalizedEventCount: 0, reasons: ["fixture_invalid"] }; }
  const manifest=adapter.manifest as HarnessAdapterV1["manifest"];
  const evaluateCompatibility=adapter.evaluateCompatibility as HarnessAdapterV1["evaluateCompatibility"];
  const normalizeEvent=adapter.normalizeEvent as HarnessAdapterV1["normalizeEvent"];

  let decision:Record<string,unknown>;
  try { const snapshot=frozenDataSnapshot(Reflect.apply(evaluateCompatibility,undefined,[input.compatibilityEvidence]),["compatible","reasons"],true); if (!snapshot) throw new Error("decision invalid"); decision=snapshot; }
  catch { return { adapterId: manifest.adapterId, compatible: false, normalizedEventCount: 0, reasons: ["compatibility_rejected"] }; }
  if (typeof decision.compatible !== "boolean" || !Array.isArray(decision.reasons)
    || decision.reasons.some((reason) => typeof reason !== "string" || !safeReason.test(reason)) || new Set(decision.reasons).size !== decision.reasons.length
    || (decision.compatible ? decision.reasons.length!==0 : decision.reasons.length===0)) {
    return { adapterId: manifest.adapterId, compatible: false, normalizedEventCount: 0, reasons: ["compatibility_rejected"] };
  }
  if (!decision.compatible) return { adapterId: manifest.adapterId, compatible: false, normalizedEventCount: 0, reasons: ["compatibility_rejected"] };

  let normalizedEventCount = 0;
  const priorSequences = new Map<string,number>();
  const sourceEventKeys = new Set<string>();
  for (const fixture of input.fixtures) {
    if (!fixture || typeof fixture.name !== "string" || fixture.name.length < 3 || !validContext(fixture.context)
      || !Number.isSafeInteger(fixture.expectedEventCount) || fixture.expectedEventCount < 0 || fixture.expectedEventCount > 10) {
      return { adapterId: manifest.adapterId, compatible: false, normalizedEventCount, reasons: ["fixture_invalid"] };
    }
    let normalized;
    try { normalized = Reflect.apply(normalizeEvent,undefined,[fixture.frame,structuredClone(fixture.context)]); }
    catch { return { adapterId: manifest.adapterId, compatible: false, normalizedEventCount, reasons: ["normalization_failed"] }; }
    const normalizedKeys = normalized && typeof normalized === "object" && !Array.isArray(normalized)
      ? Object.prototype.hasOwnProperty.call(normalized,"nativeSessionKeyDigest") || Object.prototype.hasOwnProperty.call(normalized,"finalTextDigest")
        ? ["events",...(Object.prototype.hasOwnProperty.call(normalized,"nativeSessionKeyDigest") ? ["nativeSessionKeyDigest"] : []),
          ...(Object.prototype.hasOwnProperty.call(normalized,"finalTextDigest") ? ["finalTextDigest"] : [])] : ["events"]
      : [];
    const normalizedSnapshot=frozenDataSnapshot(normalized,normalizedKeys,true);
    if (!normalizedSnapshot || !Array.isArray(normalizedSnapshot.events) || normalizedSnapshot.events.length !== fixture.expectedEventCount
      || normalizedSnapshot.events.length > 10 || (normalizedSnapshot.nativeSessionKeyDigest && (typeof normalizedSnapshot.nativeSessionKeyDigest!=="string" || !/^sha256:[a-f0-9]{64}$/.test(normalizedSnapshot.nativeSessionKeyDigest)))
      || (normalizedSnapshot.finalTextDigest && (typeof normalizedSnapshot.finalTextDigest!=="string" || !/^sha256:[a-f0-9]{64}$/.test(normalizedSnapshot.finalTextDigest)))) {
      return { adapterId: manifest.adapterId, compatible: false, normalizedEventCount, reasons: ["normalization_failed"] };
    }
    normalized=normalizedSnapshot as unknown as ReturnType<HarnessAdapterV1["normalizeEvent"]>;
    try {
      assertNoSecretMaterial(normalized,"normalized adapter frame");
      for (const [index,event] of normalized.events.entries()) {
        const parsed = harnessRunEventSchemaV1.parse(event);
        const priorSequence = priorSequences.get(parsed.runId) ?? 0;
        if (parsed.tenantId !== fixture.context.tenantId || parsed.runId !== fixture.context.runId || parsed.source !== "adapter"
          || parsed.occurredAt!==fixture.context.occurredAt || parsed.sequence!==fixture.context.sequence+index || parsed.sequence <= priorSequence
          || sourceEventKeys.has(parsed.sourceEventKeyDigest)) {
          throw new Error("normalized event invalid");
        }
        priorSequences.set(parsed.runId,parsed.sequence);
        sourceEventKeys.add(parsed.sourceEventKeyDigest);
      }
    } catch { return { adapterId: manifest.adapterId, compatible: false, normalizedEventCount, reasons: ["normalization_failed"] }; }
    normalizedEventCount += normalized.events.length;
  }
  return { adapterId: manifest.adapterId, compatible: true, normalizedEventCount, reasons: [] };
}
