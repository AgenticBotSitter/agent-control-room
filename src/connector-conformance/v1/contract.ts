import type { ConnectorOperationNameV1 } from "../../harness/v1/connector-profile";

/**
 * Schema name of the runner's report. A report is conformance evidence only: it is
 * not a connector profile, it enables no operation and it grants no authority.
 */
export const CONNECTOR_CONFORMANCE_REPORT_SCHEMA_V1 = "control-room.connector-conformance-report/v1" as const;

/** Identifies the runner implementation that produced a report. */
export const CONNECTOR_CONFORMANCE_RUNNER_VERSION_V1 = "control-room.connector-conformance-runner/v1" as const;

/**
 * Disposable fixture instant. The runner never reads a clock, so identical inputs
 * always produce an identical report.
 */
export const CONNECTOR_CONFORMANCE_FIXTURE_OBSERVED_AT_V1 = "2026-01-01T00:00:00.000Z" as const;

/**
 * The finite rule set a conformance scenario may exercise. Each rule delegates to an
 * existing harness rule; the list adds no contract, registry or lifecycle of its own.
 */
export const connectorConformanceRulesV1 = [
  "source_identity",
  "operation_availability",
  "insufficient_evidence",
  "result_envelope",
  "lineage_identity",
  "content_bytes",
  "content_encoding",
  "result_determinism",
  "input_immutability",
  "review_flags",
] as const;
export type ConnectorConformanceRuleV1 = (typeof connectorConformanceRulesV1)[number];

/**
 * `pass` means the existing rule behaved as the scenario declared, `fail` means it did
 * not, and `unsupported` means no existing boundary can express the observation.
 */
export const connectorConformanceOutcomesV1 = ["pass", "fail", "unsupported"] as const;
export type ConnectorConformanceOutcomeV1 = (typeof connectorConformanceOutcomesV1)[number];

/** What a scenario declares the existing rule should return. */
export const connectorConformanceExpectationsV1 = ["admitted", "refused", "unsupported"] as const;
export type ConnectorConformanceExpectationV1 = (typeof connectorConformanceExpectationsV1)[number];

/** Caller-supplied disposable text. The existing result boundary accepts text only. */
export type ConnectorConformanceTextObservationV1 = { form: "utf8_text"; text: string };
/**
 * Caller-supplied raw bytes. Retained so a contributor can show which observations the
 * current text-only boundary cannot express; the runner reports those as unsupported
 * instead of decoding bytes on its own.
 */
export type ConnectorConformanceByteObservationV1 = { form: "raw_bytes"; bytes: readonly number[] };
export type ConnectorConformanceObservationV1 =
  | ConnectorConformanceTextObservationV1
  | ConnectorConformanceByteObservationV1;

/** Exact source and lineage identity the existing result envelope already requires. */
export type ConnectorConformanceIdentityV1 = {
  lineage: {
    tenantId: string;
    projectId: string;
    jobId: string;
    attemptId: string;
    runId: string;
    nodeId: string;
  };
  source: {
    upstreamSessionId: string;
    upstreamExecutionId: string;
    upstreamResultId: string;
    completionEvidenceDigest: string;
  };
};

/**
 * One declared comparison against an existing rule. Scenario identity is supplied by the
 * caller; the runner derives a deterministic disposable identity only when one is absent.
 */
export type ConnectorConformanceScenarioV1 = {
  scenarioId: string;
  rule: ConnectorConformanceRuleV1;
  profileId: string;
  operation?: ConnectorOperationNameV1;
  observationId?: string;
  identity?: ConnectorConformanceIdentityV1;
  observedAt?: string;
  expect: ConnectorConformanceExpectationV1;
};

/** Deterministic evidence for one scenario. Absent fields mean the rule did not reach them. */
export type ConnectorConformanceScenarioEvidenceV1 = {
  scenarioId: string;
  rule: ConnectorConformanceRuleV1;
  expectation: ConnectorConformanceExpectationV1;
  outcome: ConnectorConformanceOutcomeV1;
  reasonCode: string;
  operation?: ConnectorOperationNameV1;
  profileDigest?: string;
  resultDigest?: string;
  contentHash?: string;
  sizeBytes?: number;
  resultFrozen?: boolean;
};

/**
 * Deterministic, immutable conformance evidence. `enabledOperations` is always empty and
 * `nativeQualification` is always false: synthetic conformance is not native qualification.
 */
export type ConnectorConformanceReportV1 = {
  schema: typeof CONNECTOR_CONFORMANCE_REPORT_SCHEMA_V1;
  runner: typeof CONNECTOR_CONFORMANCE_RUNNER_VERSION_V1;
  nativeQualification: false;
  enabledOperations: readonly ConnectorOperationNameV1[];
  profilesEvaluated: readonly string[];
  scenarios: readonly ConnectorConformanceScenarioEvidenceV1[];
  counts: { pass: number; fail: number; unsupported: number };
  reportDigest: string;
};

/** Caller-supplied in-memory inputs. Nothing is read from disk, a registry or a network. */
export type ConnectorConformanceRunInputV1 = {
  profiles: Readonly<Record<string, unknown>>;
  observations?: Readonly<Record<string, ConnectorConformanceObservationV1>>;
  scenarios: readonly ConnectorConformanceScenarioV1[];
};