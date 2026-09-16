import { createHash } from "node:crypto";
import {
  connectorOperationAdmissibleV1,
  connectorOperationNamesV1,
  parseConnectorProfileV1,
  type ConnectorOperationNameV1,
  type ConnectorProfileV1,
} from "../../harness/v1/connector-profile";
import { createCanonicalTextResultV1, type CanonicalTextResultV1 } from "../../harness/v1/canonical-text-result";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import {
  CONNECTOR_CONFORMANCE_FIXTURE_OBSERVED_AT_V1,
  CONNECTOR_CONFORMANCE_REPORT_SCHEMA_V1,
  CONNECTOR_CONFORMANCE_RUNNER_VERSION_V1,
  connectorConformanceExpectationsV1,
  connectorConformanceRulesV1,
  type ConnectorConformanceIdentityV1,
  type ConnectorConformanceObservationV1,
  type ConnectorConformanceOutcomeV1,
  type ConnectorConformanceReportV1,
  type ConnectorConformanceRuleV1,
  type ConnectorConformanceRunInputV1,
  type ConnectorConformanceScenarioEvidenceV1,
  type ConnectorConformanceScenarioV1,
} from "./contract";

const scenarioIdPattern = /^[a-z0-9][a-z0-9._-]{2,79}$/;
const operationRules = new Set<ConnectorConformanceRuleV1>([
  "operation_availability",
  "insufficient_evidence",
]);
const resultRules = new Set<ConnectorConformanceRuleV1>([
  "result_envelope",
  "lineage_identity",
  "content_bytes",
  "content_encoding",
  "result_determinism",
  "input_immutability",
  "review_flags",
]);

type Admission = "admitted" | "refused" | "unsupported";

type Evidence = {
  operation?: ConnectorOperationNameV1;
  profileDigest?: string;
  resultDigest?: string;
  contentHash?: string;
  sizeBytes?: number;
  resultFrozen?: boolean;
};

type Evaluation = {
  admission: Admission;
  reasonCode: string;
  violation?: string;
  evidence?: Evidence;
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function isDeepFrozen(value: unknown, seen = new Set<unknown>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).every(key => isDeepFrozen((value as Record<PropertyKey, unknown>)[key], seen));
}

function isOperationName(value: unknown): value is ConnectorOperationNameV1 {
  return typeof value === "string" && connectorOperationNamesV1.includes(value as ConnectorOperationNameV1);
}

/** The runner never reads a clock: an absent identity is derived from the scenario id. */
function derivedIdentity(scenarioId: string): ConnectorConformanceIdentityV1 {
  const ref = (kind: string) => `${kind}:${scenarioId}`;
  return {
    lineage: {
      tenantId: ref("tenant"),
      projectId: ref("project"),
      jobId: ref("job"),
      attemptId: ref("attempt"),
      runId: ref("run"),
      nodeId: ref("node"),
    },
    source: {
      upstreamSessionId: ref("session"),
      upstreamExecutionId: ref("execution"),
      upstreamResultId: ref("result"),
      completionEvidenceDigest: `sha256:${"0".repeat(64)}`,
    },
  };
}

function scenarioInvalid(scenario: ConnectorConformanceScenarioV1, field: string): never {
  const scenarioId = typeof scenario?.scenarioId === "string" ? scenario.scenarioId : "unknown";
  throw new Error(`connector_conformance_scenario_invalid:${scenarioId}:${field}`);
}

/**
 * Structural validation runs before any evaluation so a malformed plan fails closed
 * instead of producing partial evidence.
 */
function assertScenarioValid(
  scenario: ConnectorConformanceScenarioV1,
  profiles: Readonly<Record<string, unknown>>,
  observations: Readonly<Record<string, ConnectorConformanceObservationV1>>,
): void {
  if (typeof scenario?.scenarioId !== "string" || !scenarioIdPattern.test(scenario.scenarioId)) {
    scenarioInvalid(scenario, "scenario_id");
  }
  if (!connectorConformanceRulesV1.includes(scenario.rule)) scenarioInvalid(scenario, "rule");
  if (!connectorConformanceExpectationsV1.includes(scenario.expect)) scenarioInvalid(scenario, "expectation");
  if (typeof scenario.profileId !== "string" || !(scenario.profileId in profiles)) {
    scenarioInvalid(scenario, "profile_id");
  }
  if (scenario.operation !== undefined && !isOperationName(scenario.operation)) {
    scenarioInvalid(scenario, "operation");
  }
  if (operationRules.has(scenario.rule) && !isOperationName(scenario.operation)) {
    scenarioInvalid(scenario, "operation");
  }
  if (resultRules.has(scenario.rule)) {
    if (typeof scenario.observationId !== "string" || !(scenario.observationId in observations)) {
      scenarioInvalid(scenario, "observation_id");
    }
  }
}

function profileAdmission(profileValue: unknown): {
  admission: Admission;
  profile?: ConnectorProfileV1;
  reasonCode: string;
} {
  try {
    const profile = parseConnectorProfileV1(profileValue);
    const hasRevision = profile.sourceRevision !== undefined;
    const hasPackage = profile.sourcePackage !== undefined;
    if (hasRevision === hasPackage) {
      return { admission: "admitted", profile, reasonCode: "source_identity_not_exactly_one" };
    }
    return {
      admission: "admitted",
      profile,
      reasonCode: hasRevision ? "source_revision_identity" : "source_package_identity",
    };
  } catch {
    return { admission: "refused", reasonCode: "profile_refused" };
  }
}

function evaluateSourceIdentity(profileValue: unknown): Evaluation {
  const admission = profileAdmission(profileValue);
  if (admission.admission !== "admitted" || !admission.profile) {
    return { admission: "refused", reasonCode: admission.reasonCode };
  }
  const evidence: Evidence = { profileDigest: sha256Digest(admission.profile) };
  if (admission.reasonCode === "source_identity_not_exactly_one") {
    return { admission: "admitted", reasonCode: "source_identity_not_exactly_one", violation: "source_identity_not_exactly_one", evidence };
  }
  return { admission: "admitted", reasonCode: admission.reasonCode, evidence };
}

function evaluateOperation(profileValue: unknown, operation: ConnectorOperationNameV1): Evaluation {
  let profile: ConnectorProfileV1;
  try {
    profile = parseConnectorProfileV1(profileValue);
  } catch {
    return { admission: "refused", reasonCode: "profile_refused" };
  }
  const declared = profile.operations[operation];
  const evidence: Evidence = { operation, profileDigest: sha256Digest(profile) };
  let admissible = false;
  try {
    admissible = connectorOperationAdmissibleV1(profile, operation);
  } catch {
    admissible = false;
  }
  if (admissible) return { admission: "admitted", reasonCode: "operation_admissible", evidence };
  const reasonCode = declared.status === "supported"
    ? `evidence_insufficient_${declared.evidence}`
    : `operation_${declared.status}`;
  return { admission: "refused", reasonCode, evidence };
}

function refusalReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("canonical_result_operation_unavailable")) return "operation_unavailable";
  if (message.includes("canonical_result_content_unavailable")) return "content_unavailable";
  if (message.includes("secret material")) return "secret_material_refused";
  return "projection_refused";
}

function buildResult(
  profileValue: unknown,
  operation: "result" | "read",
  text: string,
  identity: ConnectorConformanceIdentityV1,
  observedAt: string,
): { admission: "admitted"; result: CanonicalTextResultV1 } | { admission: "refused"; reasonCode: string } {
  try {
    return {
      admission: "admitted",
      result: createCanonicalTextResultV1({
        connectorProfile: profileValue,
        operation,
        lineage: identity.lineage,
        source: identity.source,
        text,
        observedAt,
      }),
    };
  } catch (error) {
    return { admission: "refused", reasonCode: refusalReason(error) };
  }
}

function envelopeEvidence(result: CanonicalTextResultV1): Evidence {
  return {
    operation: result.connector.operation,
    profileDigest: result.connector.profileDigest,
    resultDigest: result.resultDigest,
    contentHash: result.content.contentHash,
    sizeBytes: result.content.sizeBytes,
  };
}

function exactContent(text: string): { sizeBytes: number; contentHash: string } {
  const bytes = Buffer.from(text, "utf8");
  return {
    sizeBytes: bytes.byteLength,
    contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function admissibleFromCaller(profileValue: unknown, operation: "result" | "read"): boolean {
  try {
    return connectorOperationAdmissibleV1(profileValue, operation);
  } catch {
    return false;
  }
}

function evaluateResult(
  scenario: ConnectorConformanceScenarioV1,
  profileValue: unknown,
  observation: ConnectorConformanceObservationV1,
  identity: ConnectorConformanceIdentityV1,
  observedAt: string,
): Evaluation {
  if (observation.form !== "utf8_text") {
    return { admission: "unsupported", reasonCode: "utf8_text_boundary_required" };
  }
  const text = observation.text;
  const operation = (scenario.operation ?? "result") as "result" | "read";
  const callerBefore = canonicalJson({ profile: profileValue, observation, identity });
  const build = () => buildResult(profileValue, operation, text, identity, observedAt);
  const first = build();
  if (first.admission === "refused") return { admission: "refused", reasonCode: first.reasonCode };

  const result = first.result;
  const evidence = envelopeEvidence(result);
  switch (scenario.rule) {
    case "result_envelope":
      if (result.connector.operation !== operation) {
        return { admission: "admitted", reasonCode: "operation_projection_mismatch", violation: "operation_projection_mismatch", evidence };
      }
      return { admission: "admitted", reasonCode: "result_envelope_admitted", evidence };
    case "content_bytes":
      return { admission: "admitted", reasonCode: "content_bytes_preserved", evidence };
    case "content_encoding":
      return { admission: "admitted", reasonCode: "utf8_text_accepted", evidence };
    case "lineage_identity": {
      const projected = canonicalJson({ lineage: result.lineage, source: result.source });
      if (projected !== canonicalJson(identity)) {
        return { admission: "admitted", reasonCode: "identity_projection_mismatch", violation: "identity_projection_mismatch", evidence };
      }
      const expected = exactContent(text);
      if (result.content.sizeBytes !== expected.sizeBytes) {
        return { admission: "admitted", reasonCode: "content_size_mismatch", violation: "content_size_mismatch", evidence };
      }
      if (result.content.contentHash !== expected.contentHash) {
        return { admission: "admitted", reasonCode: "content_hash_mismatch", violation: "content_hash_mismatch", evidence };
      }
      return { admission: "admitted", reasonCode: "identity_preserved", evidence };
    }
    case "result_determinism": {
      const second = build();
      if (second.admission !== "admitted") {
        return { admission: "admitted", reasonCode: "nondeterministic_admission", violation: "nondeterministic_admission", evidence };
      }
      if (second.result.resultDigest !== result.resultDigest) {
        return { admission: "admitted", reasonCode: "nondeterministic_identity", violation: "nondeterministic_identity", evidence };
      }
      if (canonicalJson(second.result) !== canonicalJson(result)) {
        return { admission: "admitted", reasonCode: "nondeterministic_envelope", violation: "nondeterministic_envelope", evidence };
      }
      return { admission: "admitted", reasonCode: "identity_reproduced", evidence };
    }
    case "input_immutability": {
      const admissionBefore = admissibleFromCaller(profileValue, operation);
      const callerAfter = canonicalJson({ profile: profileValue, observation, identity });
      const admissionAfter = admissibleFromCaller(profileValue, operation);
      const frozen = isDeepFrozen(result);
      if (callerAfter !== callerBefore) {
        return { admission: "admitted", reasonCode: "caller_input_mutated", violation: "caller_input_mutated", evidence };
      }
      if (admissionBefore !== admissionAfter) {
        return { admission: "admitted", reasonCode: "operation_admissibility_changed", violation: "operation_admissibility_changed", evidence };
      }
      if (!frozen) {
        return { admission: "admitted", reasonCode: "result_not_frozen", violation: "result_not_frozen", evidence: { ...evidence, resultFrozen: false } };
      }
      return {
        admission: "admitted",
        reasonCode: "caller_input_and_admission_unchanged",
        evidence: { ...evidence, resultFrozen: true },
      };
    }
    case "review_flags": {
      const widened = result.reviewRequired !== true
        || result.qualityAccepted !== false
        || result.completionRecorded !== false
        || result.grantsExecutionAuthority !== false
        || result.permitsRetry !== false
        || result.permitsResume !== false;
      if (widened) {
        return { admission: "admitted", reasonCode: "review_or_authority_flags_widened", violation: "review_or_authority_flags_widened", evidence };
      }
      return { admission: "admitted", reasonCode: "review_still_required", evidence };
    }
    default:
      throw new Error(`connector_conformance_rule_unreachable:${scenario.rule}`);
  }
}

function evaluateScenario(
  scenario: ConnectorConformanceScenarioV1,
  profileValue: unknown,
  observations: Readonly<Record<string, ConnectorConformanceObservationV1>>,
): Evaluation {
  switch (scenario.rule) {
    case "source_identity":
      return evaluateSourceIdentity(profileValue);
    case "operation_availability":
    case "insufficient_evidence":
      return evaluateOperation(profileValue, scenario.operation as ConnectorOperationNameV1);
    default: {
      const observation = observations[scenario.observationId as string];
      const identity = scenario.identity ?? derivedIdentity(scenario.scenarioId);
      const observedAt = scenario.observedAt ?? CONNECTOR_CONFORMANCE_FIXTURE_OBSERVED_AT_V1;
      return evaluateResult(scenario, profileValue, observation, identity, observedAt);
    }
  }
}

function toEvidence(scenario: ConnectorConformanceScenarioV1, evaluation: Evaluation): ConnectorConformanceScenarioEvidenceV1 {
  const outcome: ConnectorConformanceOutcomeV1 = evaluation.admission === "unsupported"
    ? "unsupported"
    : evaluation.violation
      ? "fail"
      : evaluation.admission === scenario.expect
        ? "pass"
        : "fail";
  return {
    scenarioId: scenario.scenarioId,
    rule: scenario.rule,
    expectation: scenario.expect,
    outcome,
    reasonCode: evaluation.violation ?? evaluation.reasonCode,
    ...evaluation.evidence,
  };
}

/**
 * Runs caller-supplied conformance scenarios against the existing connector and canonical
 * result rules. It parses and constructs with the reusable public functions only, returns
 * deterministic per-scenario evidence, and enables nothing: the report always carries
 * `nativeQualification: false` and an empty `enabledOperations` list.
 */
export function runConnectorConformanceV1(input: ConnectorConformanceRunInputV1): ConnectorConformanceReportV1 {
  const profiles = input?.profiles ?? {};
  const observations = input?.observations ?? {};
  const scenarios = input?.scenarios ?? [];
  for (const scenario of scenarios) assertScenarioValid(scenario, profiles, observations);
  const evidenceList = scenarios.map(scenario =>
    toEvidence(scenario, evaluateScenario(scenario, profiles[scenario.profileId], observations)));
  const counts = { pass: 0, fail: 0, unsupported: 0 };
  for (const evidence of evidenceList) counts[evidence.outcome] += 1;
  const material = {
    schema: CONNECTOR_CONFORMANCE_REPORT_SCHEMA_V1,
    runner: CONNECTOR_CONFORMANCE_RUNNER_VERSION_V1,
    nativeQualification: false as const,
    enabledOperations: [] as readonly ConnectorOperationNameV1[],
    profilesEvaluated: [...new Set(scenarios.map(scenario => scenario.profileId))].sort(),
    scenarios: evidenceList,
    counts,
  };
  return deepFreeze({ ...material, reportDigest: sha256Digest(material) });
}