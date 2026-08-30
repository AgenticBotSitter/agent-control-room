import { isHostProxyV1 } from "../../security/host-value";
import { parseHermesBotModeProjectionV1, hermesBotModeManifestV1 } from "./hermes-bot-mode-adapter";
import {
  HERMES_BOT_MODE_ADAPTER_V1,
  HERMES_BOT_MODE_RESOURCE_CEILINGS_V1,
  type HermesBotModeCompatibilityDecisionV1,
  type HermesBotModeConformanceFixtureV1,
  type HermesBotModeConformanceReasonV1,
  type HermesBotModeConformanceResultV1,
  type HermesBotModeReadAdapterV1,
} from "./hermes-bot-mode-types";

const EMPTY_CHECKS: HermesBotModeConformanceResultV1["checks"] = Object.freeze({
  exactPin: false,
  injectedOnly: false,
  safeProjection: false,
  resourceCeilings: false,
  negativeAuthority: false,
});

function exactFrozenRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || isHostProxyV1(value)
    || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return undefined;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string") || (ownKeys as string[]).sort().join("|") !== [...keys].sort().join("|")) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable
      || descriptor.writable || descriptor.configurable) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function deepFrozenData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) return true;
  if (!value || typeof value !== "object" || isHostProxyV1(value) || seen.has(value) || !Object.isFrozen(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || descriptor.writable || descriptor.configurable
      || !deepFrozenData(descriptor.value, seen)) return false;
  }
  return true;
}

function failure(reason: HermesBotModeConformanceReasonV1, adapterId = "adapter:invalid"): HermesBotModeConformanceResultV1 {
  return {
    adapterId,
    compatible: false,
    fixtureCount: 0,
    normalizedProfiles: 0,
    normalizedRooms: 0,
    normalizedRoutines: 0,
    checks: EMPTY_CHECKS,
    reasons: [reason],
  };
}

function snapshotFixture(value: HermesBotModeConformanceFixtureV1): HermesBotModeConformanceFixtureV1 | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || isHostProxyV1(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = ["name", "observation", "expectedProfiles", "expectedRooms", "expectedRoutines", "expectedWorking"];
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string") || (ownKeys as string[]).sort().join("|") !== keys.sort().join("|")) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const item = Object.fromEntries(keys.map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) throw new Error("invalid fixture");
      return [key, descriptor.value];
    })) as unknown as HermesBotModeConformanceFixtureV1;
    if (typeof item.name !== "string" || item.name.length < 3 || item.name.length > 120
      || !Number.isSafeInteger(item.expectedProfiles) || item.expectedProfiles < 0 || item.expectedProfiles > HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxProfiles
      || !Number.isSafeInteger(item.expectedRooms) || item.expectedRooms < 0 || item.expectedRooms > HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRooms
      || !Number.isSafeInteger(item.expectedRoutines) || item.expectedRoutines < 0 || item.expectedRoutines > HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoutines
      || !Number.isSafeInteger(item.expectedWorking) || item.expectedWorking < 0 || item.expectedWorking > item.expectedProfiles) return undefined;
    return item;
  } catch {
    return undefined;
  }
}

function negativeAuthority(value: ReturnType<typeof parseHermesBotModeProjectionV1>): boolean {
  return value.nativeQualified === false && value.retainsFullMessages === false && value.sharesProviderAccess === false
    && value.createsSchedules === false && value.createsWorkItems === false && value.dispatchesWork === false
    && value.grantsApproval === false && value.grantsLeaseAuthority === false && value.grantsCommandAuthority === false
    && value.grantsExecutionAuthority === false && (!value.workspace || (
      value.workspace.presentationOnly === true && value.workspace.retainsFullMessages === false
      && value.workspace.sharesProviderAccess === false && value.workspace.createsWorkItems === false
      && value.workspace.dispatchesWork === false && value.workspace.grantsApproval === false
      && value.workspace.grantsLeaseAuthority === false && value.workspace.grantsCommandAuthority === false
      && value.workspace.grantsExecutionAuthority === false
    ));
}

export function runHermesBotModeConformanceV1(input: {
  adapter: HermesBotModeReadAdapterV1;
  compatibilityEvidence: unknown;
  fixtures: readonly HermesBotModeConformanceFixtureV1[];
}): HermesBotModeConformanceResultV1 {
  let adapter: Record<string, unknown> | undefined;
  try {
    adapter = exactFrozenRecord(input.adapter, ["manifest", "evaluateCompatibility", "normalizeObservation"]);
    if (!adapter || typeof adapter.evaluateCompatibility !== "function" || typeof adapter.normalizeObservation !== "function"
      || !deepFrozenData(adapter.manifest) || JSON.stringify(adapter.manifest) !== JSON.stringify(hermesBotModeManifestV1)) {
      return failure("adapter_shape_invalid");
    }
  } catch {
    return failure("adapter_shape_invalid");
  }
  const evaluateCompatibility = adapter.evaluateCompatibility as HermesBotModeReadAdapterV1["evaluateCompatibility"];
  const normalizeObservation = adapter.normalizeObservation as HermesBotModeReadAdapterV1["normalizeObservation"];
  let decision: HermesBotModeCompatibilityDecisionV1;
  try {
    decision = Reflect.apply(evaluateCompatibility, undefined, [input.compatibilityEvidence]);
  } catch {
    return failure("compatibility_rejected", HERMES_BOT_MODE_ADAPTER_V1);
  }
  try {
    if (!deepFrozenData(decision) || typeof decision.compatible !== "boolean" || !Array.isArray(decision.reasons)
      || decision.reasons.some((reason) => typeof reason !== "string")
      || (decision.compatible ? decision.reasons.length !== 0 : decision.reasons.length === 0)) {
      return failure("compatibility_rejected", HERMES_BOT_MODE_ADAPTER_V1);
    }
  } catch { return failure("compatibility_rejected", HERMES_BOT_MODE_ADAPTER_V1); }
  if (!decision.compatible) return failure("compatibility_rejected", HERMES_BOT_MODE_ADAPTER_V1);

  let normalizedProfiles = 0;
  let normalizedRooms = 0;
  let normalizedRoutines = 0;
  let negativeAuthorityPassed = true;
  let resourceCeilingsPassed = true;
  let safeProjectionPassed = true;
  for (const fixtureValue of input.fixtures) {
    const fixture = snapshotFixture(fixtureValue);
    if (!fixture) return failure("fixture_invalid", HERMES_BOT_MODE_ADAPTER_V1);
    try {
      const projection = parseHermesBotModeProjectionV1(Reflect.apply(normalizeObservation, undefined, [fixture.observation]));
      const profiles = projection.workspace?.agents.length ?? 0;
      const rooms = projection.workspace?.rooms.length ?? 0;
      const routines = projection.workspace?.routines.length ?? 0;
      const working = projection.workspace?.activeAgentCount ?? 0;
      if (profiles !== fixture.expectedProfiles || rooms !== fixture.expectedRooms
        || routines !== fixture.expectedRoutines || working !== fixture.expectedWorking) {
        return failure("normalization_failed", HERMES_BOT_MODE_ADAPTER_V1);
      }
      normalizedProfiles += profiles;
      normalizedRooms += rooms;
      normalizedRoutines += routines;
      negativeAuthorityPassed &&= negativeAuthority(projection);
      resourceCeilingsPassed &&= (projection.workspace?.rooms.every((room) => room.maxRounds === 3 && room.maxMessages === 10
        && room.maxAgentPairMessages === 4 && room.maxDurationSeconds === 1_800
        && room.maxReasoningUnits === 100_000 && room.maxCostUsd === 25) ?? true);
      safeProjectionPassed &&= deepFrozenData(projection);
    } catch {
      return failure("normalization_failed", HERMES_BOT_MODE_ADAPTER_V1);
    }
  }
  if (!negativeAuthorityPassed) return failure("authority_ceiling_failed", HERMES_BOT_MODE_ADAPTER_V1);
  if (!safeProjectionPassed || !resourceCeilingsPassed) return failure("normalization_failed", HERMES_BOT_MODE_ADAPTER_V1);
  return {
    adapterId: HERMES_BOT_MODE_ADAPTER_V1,
    compatible: true,
    fixtureCount: input.fixtures.length,
    normalizedProfiles,
    normalizedRooms,
    normalizedRoutines,
    checks: {
      exactPin: true,
      injectedOnly: true,
      safeProjection: safeProjectionPassed,
      resourceCeilings: resourceCeilingsPassed,
      negativeAuthority: negativeAuthorityPassed,
    },
    reasons: [],
  };
}
