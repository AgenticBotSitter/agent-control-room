export type DesiredServiceStateV1 = "running" | "paused" | "retired";
export type ObservedServiceStateV1 = "running" | "degraded" | "stopped" | "failed" | "unknown";

export interface ServiceReconciliationInputV1 {
  serviceId: string;
  desiredState: DesiredServiceStateV1;
  observedState: ObservedServiceStateV1;
  observedAt: string;
  freshUntil: string;
  now: string;
  existingIncident?: { id: string; correlationKey: string };
}

export interface ServiceReconciliationV1 {
  serviceState: "active" | "degraded" | "paused" | "failed" | "retired";
  incidentAction: "none" | "open_or_update" | "resolve";
  correlationKey?: string;
  severity?: "warning" | "critical";
  safeReasonCode?: string;
  safeRemedyCode?: string;
  explanation: string;
}

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
function instant(value: string): boolean { const parsed = new Date(value); return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value; }

function invalid(input: ServiceReconciliationInputV1): boolean {
  return !safeId.test(input.serviceId) || !["running", "paused", "retired"].includes(input.desiredState)
    || !["running", "degraded", "stopped", "failed", "unknown"].includes(input.observedState)
    || !instant(input.observedAt) || !instant(input.freshUntil) || !instant(input.now)
    || Date.parse(input.freshUntil) < Date.parse(input.observedAt)
    || Boolean(input.existingIncident && (!safeId.test(input.existingIncident.id) || !safeId.test(input.existingIncident.correlationKey)));
}

function result(input: ServiceReconciliationInputV1, serviceState: ServiceReconciliationV1["serviceState"], reason?: string, severity?: "warning" | "critical", remedy?: string): ServiceReconciliationV1 {
  const correlationKey = reason ? `service:${input.serviceId}:${reason}` : undefined;
  const existingMatches = Boolean(correlationKey && input.existingIncident?.correlationKey === correlationKey);
  if (!reason) return input.existingIncident
    ? { serviceState, incidentAction: "resolve", correlationKey: input.existingIncident.correlationKey, explanation: "Declared desired state and fresh observed state agree; the correlated incident may be resolved." }
    : { serviceState, incidentAction: "none", explanation: "Declared desired state and fresh observed state agree." };
  return { serviceState, incidentAction: "open_or_update", correlationKey, severity, safeReasonCode: reason, safeRemedyCode: remedy, explanation: existingMatches ? "Fresh evidence continues the correlated service incident." : "Fresh evidence requires a correlated service incident projection." };
}

/** Compares declared intent with fresh observation and produces only a safe incident/recovery projection. */
export function reconcileServiceV1(input: ServiceReconciliationInputV1): ServiceReconciliationV1 | undefined {
  if (invalid(input)) return undefined;
  if (Date.parse(input.now) > Date.parse(input.freshUntil)) return result(input, input.desiredState === "running" ? "failed" : input.desiredState, "observation_stale", "warning", "refresh_observation");
  if (input.desiredState === "running") {
    if (input.observedState === "running") return result(input, "active");
    if (input.observedState === "degraded") return result(input, "degraded", "service_degraded", "warning", "inspect_service");
    return result(input, "failed", input.observedState === "unknown" ? "observation_unknown" : "service_not_running", "critical", input.observedState === "unknown" ? "refresh_observation" : "inspect_service");
  }
  if (input.desiredState === "paused") {
    return input.observedState === "running"
      ? result(input, "paused", "running_while_paused", "warning", "verify_pause")
      : result(input, "paused");
  }
  return input.observedState === "running"
    ? result(input, "retired", "running_while_retired", "critical", "inspect_retirement")
    : result(input, "retired");
}
