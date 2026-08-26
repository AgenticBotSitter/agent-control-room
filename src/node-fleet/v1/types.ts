export const FLEET_SIGNAL_CONTRACT_V1 = "control-room-fleet-signal/v1" as const;

export type FleetSignalKind = "discovery" | "telemetry" | "capability" | "benchmark";
export type FleetSignalTrust = "reported" | "verified" | "blocked" | "unavailable";
export type FleetSignalFreshnessCode = "eligible" | "signal_expired" | "signal_from_future" | "unsupported_schema";

export interface FleetSignalFreshnessResult {
  eligible: boolean;
  code: FleetSignalFreshnessCode;
}
