import { FLEET_SIGNAL_CONTRACT_V1, type FleetSignalFreshnessResult } from "./types";
import type { FleetSignalEnvelope } from "./schemas";

export function evaluateFleetSignalFreshness(signal: FleetSignalEnvelope, now: string, contractVersion = FLEET_SIGNAL_CONTRACT_V1): FleetSignalFreshnessResult {
  if (contractVersion !== FLEET_SIGNAL_CONTRACT_V1) return { eligible: false, code: "unsupported_schema" };
  if (Date.parse(signal.observedAt) > Date.parse(now)) return { eligible: false, code: "signal_from_future" };
  if (Date.parse(signal.expiresAt) <= Date.parse(now)) return { eligible: false, code: "signal_expired" };
  return { eligible: true, code: "eligible" };
}
