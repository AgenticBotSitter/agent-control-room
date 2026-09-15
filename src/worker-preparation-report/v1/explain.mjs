// Offline explanation over accepted checkPrivateWorkerPreparationV1 output only.
//
// The explainer never reads raw fact documents: every sentence derives from the
// checker's result object, and the result's identity fields (tenantId, nodeId,
// digests, fingerprints) are stripped before rendering. Unknown future reason
// codes map to one fixed generic sentence — raw codes are allow-listed, never
// echoed. Comparison grants no execution authority.

const KNOWN_REASONS = Object.freeze({
  telemetry_missing: "Freshness telemetry is missing, so storage sufficiency cannot be confirmed.",
  telemetry_stale: "Freshness telemetry has expired, so the facts are treated as stale.",
  static_discovery_stale: "The discovery facts fall outside their observed window, so the outcome is stale.",
  scratch_insufficient: "Reported scratch storage is below the required amount.",
  capability_missing: "The required capability probe has no passing recorded outcome.",
  capability_expired: "The required capability probe outcome has expired.",
  capability_unverified: "The required capability probe outcome is not verified.",
  benchmark_missing: "The required benchmark has no passing recorded outcome.",
  benchmark_expired: "The required benchmark outcome has expired.",
  benchmark_environment_mismatch: "The benchmark was recorded against different facts.",
});
const GENERIC_REASON = "An eligibility condition is not satisfied.";
const REFUSED_LINES = Object.freeze([
  "Preparation outcome: refused.",
  "The supplied facts could not be evaluated. No readiness is inferred.",
]);
const AUTHORITY_LINES = Object.freeze([
  "Comparison grants no execution authority.",
  "A ready result qualifies only the supplied preparation facts, not native execution.",
]);
const SUPPORTED_MODE_LINE = "Supported modes only: the checker starts no harness and grants no execution authority.";

function allowedOperations(operations) {
  const available = [];
  const unavailable = [];
  for (const [name, state] of Object.entries(operations ?? {})) {
    if (state === "available") available.push(name);
    else if (state === "unavailable") unavailable.push(name);
  }
  available.sort();
  unavailable.sort();
  return Object.freeze({ available: Object.freeze(available), unavailable: Object.freeze(unavailable) });
}

function reasonLine(code) {
  return Object.hasOwn(KNOWN_REASONS, code) ? KNOWN_REASONS[code] : GENERIC_REASON;
}

/** Fixed human-readable explanation of one accepted checker result. Never includes identities. */
export function explainPreparation(result) {
  if (!result || typeof result !== "object" || result.schema !== "control-room.private-worker-preparation-result/v1") {
    return Object.freeze({ readiness: "refused", lines: REFUSED_LINES });
  }
  const ops = allowedOperations(result.operations);
  const reasons = Array.isArray(result.eligibility?.reasons) ? [...result.eligibility.reasons].sort() : [];
  const lines = [result.ready === true ? "Preparation outcome: ready." : "Preparation outcome: not ready."];
  for (const code of reasons) lines.push(reasonLine(code));
  lines.push(ops.available.length > 0
    ? `Permitted operations: ${ops.available.join(", ")}.`
    : "Permitted operations: none.");
  lines.push(ops.unavailable.length > 0
    ? `Blocked operations: ${ops.unavailable.join(", ")}.`
    : "Blocked operations: none.");
  lines.push(SUPPORTED_MODE_LINE);
  return Object.freeze({
    readiness: result.ready === true ? "ready" : "not-ready",
    platform: result.platform === "macos" || result.platform === "linux" ? result.platform : "unknown",
    operations: ops,
    lines: Object.freeze(lines),
  });
}

/** Change summary between two accepted explanations. Data only — no authority granted. */
export function comparePreparations(before, after) {
  const lines = [];
  if (before.readiness !== after.readiness) {
    lines.push(`Readiness changed: ${before.readiness} to ${after.readiness}.`);
  } else {
    lines.push(`Readiness unchanged: ${after.readiness}.`);
  }
  const beforeLines = new Set(before.lines ?? []);
  const afterLines = new Set(after.lines ?? []);
  for (const line of [...afterLines].sort()) {
    if (!beforeLines.has(line) && !line.startsWith("Preparation outcome:") && !line.startsWith("Readiness")) lines.push(`Now: ${line}`);
  }
  for (const line of [...beforeLines].sort()) {
    if (!afterLines.has(line) && !line.startsWith("Preparation outcome:") && !line.startsWith("Readiness")) lines.push(`No longer: ${line}`);
  }
  lines.push(...AUTHORITY_LINES);
  return Object.freeze({ lines: Object.freeze(lines), grantsExecutionAuthority: false });
}

export const __test = Object.freeze({ KNOWN_REASONS, GENERIC_REASON, REFUSED_LINES, allowedOperations });
