export type RediscoveryReason =
  | "initial_discovery"
  | "material_change"
  | "discovery_expired"
  | "supervisor_continuity_unknown"
  | "owner_requested"
  | "not_required";

export interface RediscoveryInput {
  currentFingerprint?: string;
  currentExpiresAt?: string;
  candidateFingerprint: string;
  now: string;
  supervisorContinuityKnown?: boolean;
  ownerRequested?: boolean;
}

export interface RediscoveryDecision {
  required: boolean;
  reason: RediscoveryReason;
}

function validInstant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * Makes rediscovery triggers explicit. Telemetry is intentionally absent from
 * this API, so a volatile resource reading can never trigger rediscovery.
 */
export function decideRediscovery(input: RediscoveryInput): RediscoveryDecision {
  if (!validInstant(input.now)) throw new Error("invalid rediscovery evaluation time");
  if (input.ownerRequested) return { required: true, reason: "owner_requested" };
  if (input.supervisorContinuityKnown === false) return { required: true, reason: "supervisor_continuity_unknown" };
  if (!input.currentFingerprint) return { required: true, reason: "initial_discovery" };
  if (!input.currentExpiresAt || !validInstant(input.currentExpiresAt) || Date.parse(input.currentExpiresAt) <= Date.parse(input.now)) {
    return { required: true, reason: "discovery_expired" };
  }
  if (input.currentFingerprint !== input.candidateFingerprint) return { required: true, reason: "material_change" };
  return { required: false, reason: "not_required" };
}
