export type FleetSignalKind = "discovery" | "telemetry" | "capability" | "benchmark";
export type FleetSignalTrust = "reported" | "verified" | "blocked" | "unavailable";
export const FLEET_SIGNAL_CONTRACT_V1 = "control-room-fleet-signal/v1" as const;
export const FLEET_SIGNAL_MAX_AGE_MS_V1: Readonly<Record<FleetSignalKind, number>> = {
  discovery: 24 * 60 * 60 * 1_000,
  telemetry: 5 * 60 * 1_000,
  capability: 7 * 24 * 60 * 60 * 1_000,
  benchmark: 30 * 24 * 60 * 60 * 1_000,
};
export type FleetSignalFreshnessCode = "eligible" | "signal_expired" | "signal_from_future" | "signal_lifetime_exceeded" | "unsupported_schema";

export interface FleetSignalFreshnessResult {
  eligible: boolean;
  code: FleetSignalFreshnessCode;
}
