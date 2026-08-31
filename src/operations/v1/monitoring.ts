import { z } from "zod";
import { projectWorkspaceDigestSchemaV1 as digest, projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time } from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import { OPERATIONS_SERVICE_IDS_V1, parseOperationsProductionTopologyV1, type OperationsServiceIdV1 } from "./topology";

export const OPERATIONS_MONITORING_CONTRACT_V1 = "control-room-operations-monitoring/v1" as const;
export const OPERATIONS_METRIC_IDS_V1 = [
  "audit_anchor_age_seconds",
  "backup_age_seconds",
  "wal_archive_age_seconds",
  "queue_progress_age_seconds",
  "memory_utilization_permille",
  "cpu_utilization_permille",
  "storage_utilization_permille",
  "recovery_ambiguity_count",
  "lifecycle_failure_count",
] as const;
export const OPERATIONS_ALERT_RULE_IDS_V1 = [
  "audit_anchor_stale",
  "backup_stale",
  "wal_archiving_stale",
  "queue_stalled",
  "memory_pressure",
  "cpu_pressure",
  "storage_pressure",
  "recovery_ambiguity",
  "lifecycle_failure",
] as const;
export const OPERATIONS_QUEUE_CLASSES_V1 = ["interactive", "scheduled", "maintenance", "recovery"] as const;
export type OperationsMetricIdV1 = (typeof OPERATIONS_METRIC_IDS_V1)[number];
export type OperationsAlertRuleIdV1 = (typeof OPERATIONS_ALERT_RULE_IDS_V1)[number];
export type OperationsQueueClassV1 = (typeof OPERATIONS_QUEUE_CLASSES_V1)[number];
export type OperationsMonitoringSubjectKindV1 = "topology" | "service" | "queue";
export type OperationsMonitoringSubjectKeyV1 = "production_topology" | OperationsServiceIdV1 | OperationsQueueClassV1;

export interface OperationsMonitoringSeriesV1 {
  metricId: OperationsMetricIdV1;
  subjectKind: OperationsMonitoringSubjectKindV1;
  subjectKey: OperationsMonitoringSubjectKeyV1;
  subjectDigest: string;
  seriesDigest: string;
}

export interface OperationsAlertRuleV1 {
  ruleId: OperationsAlertRuleIdV1;
  metricId: OperationsMetricIdV1;
  warningThreshold: number;
  criticalThreshold: number;
  maximumSampleAgeSeconds: number;
  requiredPassingSamplesToClear: 2;
  missingDataSeverity: "warning" | "critical";
  comparison: "greater_than_or_equal";
  runbookId: string;
  notificationEligibleTransitions: readonly ["open", "escalate"];
  ruleDigest: string;
}

export interface OperationsMonitoringPolicyV1 {
  contractVersion: typeof OPERATIONS_MONITORING_CONTRACT_V1;
  policyId: string;
  scopeDigest: string;
  topologyDigest: string;
  expectedSeries: OperationsMonitoringSeriesV1[];
  rules: OperationsAlertRuleV1[];
  maximumSeriesCount: 30;
  maximumSamplesPerSeries: 96;
  arbitraryLabelsAllowed: false;
  rawIdentifiersAllowed: false;
  missingDataDisposition: "visible_unknown_alert";
  notificationDeliveryEnabled: false;
  monitoringReadOnly: true;
  grantsApproval: false;
  grantsNotificationAuthority: false;
  grantsExecutionAuthority: false;
  createdAt: string;
  expiresAt: string;
  policyDigest: string;
}

export interface OperationsMetricSampleV1 {
  contractVersion: typeof OPERATIONS_MONITORING_CONTRACT_V1;
  sampleId: string;
  policyDigest: string;
  scopeDigest: string;
  topologyDigest: string;
  metricId: OperationsMetricIdV1;
  subjectKind: OperationsMonitoringSubjectKindV1;
  subjectKey: OperationsMonitoringSubjectKeyV1;
  subjectDigest: string;
  seriesDigest: string;
  state: "observed" | "unknown";
  value?: number;
  evidenceDigest?: string;
  safeStatusCode: string;
  observedAt: string;
  validUntil: string;
  containsRawIdentifier: false;
  containsRawLabel: false;
  containsRawOutput: false;
  containsCredentialMaterial: false;
  grantsApproval: false;
  grantsNotificationAuthority: false;
  grantsExecutionAuthority: false;
  sampleDigest: string;
}

export interface OperationsAlertEvaluationV1 {
  contractVersion: typeof OPERATIONS_MONITORING_CONTRACT_V1;
  evaluationId: string;
  policyDigest: string;
  scopeDigest: string;
  ruleId: OperationsAlertRuleIdV1;
  ruleDigest: string;
  seriesDigest: string;
  subjectKind: OperationsMonitoringSubjectKindV1;
  subjectKey: OperationsMonitoringSubjectKeyV1;
  state: "firing" | "unknown" | "clear_pending" | "clear_candidate";
  severity: "none" | "warning" | "critical" | "unknown";
  safeStatusCode: string;
  sampleDigest?: string;
  consecutivePassingSamples: number;
  evaluatedAt: string;
  grantsApproval: false;
  grantsNotificationAuthority: false;
  grantsExecutionAuthority: false;
  evaluationDigest: string;
}

export interface OperationsAlertEvaluationBatchV1 {
  contractVersion: typeof OPERATIONS_MONITORING_CONTRACT_V1;
  batchId: string;
  policyDigest: string;
  scopeDigest: string;
  evaluations: OperationsAlertEvaluationV1[];
  firingCount: number;
  unknownCount: number;
  clearPendingCount: number;
  clearCandidateCount: number;
  evaluatedAt: string;
  missingDataHealthy: false;
  performsNotification: false;
  grantsApproval: false;
  grantsNotificationAuthority: false;
  grantsExecutionAuthority: false;
  batchDigest: string;
}

export interface OperationsMonitoringIncidentV1 {
  contractVersion: typeof OPERATIONS_MONITORING_CONTRACT_V1;
  incidentId: string;
  scopeDigest: string;
  correlationKey: string;
  generation: number;
  ruleId: OperationsAlertRuleIdV1;
  seriesDigest: string;
  subjectKind: OperationsMonitoringSubjectKindV1;
  subjectKey: OperationsMonitoringSubjectKeyV1;
  state: "open" | "resolved";
  severity: "warning" | "critical";
  safeStatusCode: string;
  openedAt: string;
  lastEvaluatedAt: string;
  resolvedAt?: string;
  grantsApproval: false;
  grantsNotificationAuthority: false;
  grantsExecutionAuthority: false;
  incidentDigest: string;
}

export interface OperationsNotificationProposalV1 {
  contractVersion: typeof OPERATIONS_MONITORING_CONTRACT_V1;
  proposalId: string;
  scopeDigest: string;
  incidentId: string;
  incidentDigest: string;
  transition: "open" | "escalate";
  severity: "warning" | "critical";
  safeTemplateCode: string;
  runbookId: string;
  destinationPresent: false;
  messageBodyPresent: false;
  providerConfigured: false;
  deliveryEnabled: false;
  proposalOnly: true;
  grantsApproval: false;
  grantsNotificationAuthority: false;
  grantsExecutionAuthority: false;
  proposedAt: string;
  proposalDigest: string;
}

export interface OperationsMonitoringSnapshotV1 {
  contractVersion: typeof OPERATIONS_MONITORING_CONTRACT_V1;
  snapshotId: string;
  policyDigest: string;
  scopeDigest: string;
  batchDigest: string;
  incidents: OperationsMonitoringIncidentV1[];
  proposals: OperationsNotificationProposalV1[];
  openWarningCount: number;
  openCriticalCount: number;
  unresolvedUnknownCount: number;
  notificationDeliveryEnabled: false;
  grantsApproval: false;
  grantsNotificationAuthority: false;
  grantsExecutionAuthority: false;
  projectedAt: string;
  snapshotDigest: string;
}

export interface OperationsMonitoringOperatorProjectionV1 {
  contractVersion: typeof OPERATIONS_MONITORING_CONTRACT_V1;
  snapshotDigest: string;
  scopeDigest: string;
  status: "attention_required" | "uncertain" | "clear";
  counts: { warning: number; critical: number; unknown: number; disabledNotificationProposals: number };
  cards: Array<{ incidentId: string; ruleId: OperationsAlertRuleIdV1; subjectKind: OperationsMonitoringSubjectKindV1;
    subjectKey: OperationsMonitoringSubjectKeyV1; state: "open" | "resolved"; severity: "warning" | "critical";
    safeStatusCode: string; runbookId: string; cardDigest: string }>;
  rawLabelsShown: false;
  rawIdentifiersShown: false;
  actionControlsPresent: false;
  notificationControlsPresent: false;
  grantsApproval: false;
  grantsNotificationAuthority: false;
  projectionDigest: string;
}

export interface OperationsDisabledNotificationReceiptV1 {
  contractVersion: typeof OPERATIONS_MONITORING_CONTRACT_V1;
  proposalDigest: string;
  state: "disabled_before_delivery";
  safeCode: "notification_provider_and_destination_absent";
  providerContacted: false;
  networkAttempted: false;
  notificationDelivered: false;
  createsMonitoringSignal: false;
  grantsApproval: false;
  grantsNotificationAuthority: false;
  grantsExecutionAuthority: false;
  recordedAt: string;
  receiptDigest: string;
}

export interface OperationsDisabledNotificationAdapterV1 {
  readonly kind: "disabled_notification_no_io";
  inspect(proposal: OperationsNotificationProposalV1, recordedAt: string): OperationsDisabledNotificationReceiptV1;
}

const metricIdSchema = z.enum(OPERATIONS_METRIC_IDS_V1), ruleIdSchema = z.enum(OPERATIONS_ALERT_RULE_IDS_V1),
  subjectKindSchema = z.enum(["topology", "service", "queue"]), subjectKeySchema = z.enum([
    "production_topology", ...OPERATIONS_SERVICE_IDS_V1, ...OPERATIONS_QUEUE_CLASSES_V1]);
const seriesSchema = z.object({ metricId: metricIdSchema, subjectKind: subjectKindSchema, subjectKey: subjectKeySchema,
  subjectDigest: digest, seriesDigest: digest }).strict();
const ruleSchema = z.object({ ruleId: ruleIdSchema, metricId: metricIdSchema, warningThreshold: z.number().int().min(0).max(604_800),
  criticalThreshold: z.number().int().min(0).max(604_800), maximumSampleAgeSeconds: z.number().int().min(15).max(3600),
  requiredPassingSamplesToClear: z.literal(2), missingDataSeverity: z.enum(["warning", "critical"]),
  comparison: z.literal("greater_than_or_equal"), runbookId: id,
  notificationEligibleTransitions: z.tuple([z.literal("open"), z.literal("escalate")]), ruleDigest: digest }).strict();
const policyInputSchema = z.object({ policyId: id, tenantId: id, projectId: id, topology: z.unknown(), createdAt: time, expiresAt: time }).strict();
const policySchema = z.object({ contractVersion: z.literal(OPERATIONS_MONITORING_CONTRACT_V1), policyId: id, scopeDigest: digest,
  topologyDigest: digest, expectedSeries: z.array(seriesSchema).length(30), rules: z.array(ruleSchema).length(9),
  maximumSeriesCount: z.literal(30), maximumSamplesPerSeries: z.literal(96), arbitraryLabelsAllowed: z.literal(false),
  rawIdentifiersAllowed: z.literal(false), missingDataDisposition: z.literal("visible_unknown_alert"),
  notificationDeliveryEnabled: z.literal(false), monitoringReadOnly: z.literal(true), grantsApproval: z.literal(false),
  grantsNotificationAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), createdAt: time, expiresAt: time,
  policyDigest: digest }).strict();
const sampleInputSchema = z.object({ sampleId: id, policy: z.unknown(), metricId: metricIdSchema, subjectKind: subjectKindSchema,
  subjectKey: subjectKeySchema, state: z.enum(["observed", "unknown"]), value: z.number().int().min(0).max(604_800).optional(),
  evidenceDigest: digest.optional(), safeStatusCode: id, observedAt: time, validUntil: time }).strict();
const sampleSchema = z.object({ contractVersion: z.literal(OPERATIONS_MONITORING_CONTRACT_V1), sampleId: id, policyDigest: digest,
  scopeDigest: digest, topologyDigest: digest, metricId: metricIdSchema, subjectKind: subjectKindSchema,
  subjectKey: subjectKeySchema, subjectDigest: digest, seriesDigest: digest, state: z.enum(["observed", "unknown"]),
  value: z.number().int().min(0).max(604_800).optional(), evidenceDigest: digest.optional(), safeStatusCode: id,
  observedAt: time, validUntil: time, containsRawIdentifier: z.literal(false), containsRawLabel: z.literal(false),
  containsRawOutput: z.literal(false), containsCredentialMaterial: z.literal(false), grantsApproval: z.literal(false),
  grantsNotificationAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), sampleDigest: digest }).strict();
const evaluationSchema = z.object({ contractVersion: z.literal(OPERATIONS_MONITORING_CONTRACT_V1), evaluationId: id,
  policyDigest: digest, scopeDigest: digest, ruleId: ruleIdSchema, ruleDigest: digest, seriesDigest: digest,
  subjectKind: subjectKindSchema, subjectKey: subjectKeySchema, state: z.enum(["firing", "unknown", "clear_pending", "clear_candidate"]),
  severity: z.enum(["none", "warning", "critical", "unknown"]), safeStatusCode: id, sampleDigest: digest.optional(),
  consecutivePassingSamples: z.number().int().min(0).max(96), evaluatedAt: time, grantsApproval: z.literal(false),
  grantsNotificationAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), evaluationDigest: digest }).strict();
const batchSchema = z.object({ contractVersion: z.literal(OPERATIONS_MONITORING_CONTRACT_V1), batchId: id,
  policyDigest: digest, scopeDigest: digest, evaluations: z.array(evaluationSchema).length(30), firingCount: z.number().int().min(0).max(30),
  unknownCount: z.number().int().min(0).max(30), clearPendingCount: z.number().int().min(0).max(30),
  clearCandidateCount: z.number().int().min(0).max(30), evaluatedAt: time, missingDataHealthy: z.literal(false),
  performsNotification: z.literal(false), grantsApproval: z.literal(false), grantsNotificationAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), batchDigest: digest }).strict();
const incidentSchema = z.object({ contractVersion: z.literal(OPERATIONS_MONITORING_CONTRACT_V1), incidentId: id,
  scopeDigest: digest, correlationKey: digest, generation: z.number().int().positive().max(1_000_000), ruleId: ruleIdSchema,
  seriesDigest: digest, subjectKind: subjectKindSchema, subjectKey: subjectKeySchema, state: z.enum(["open", "resolved"]),
  severity: z.enum(["warning", "critical"]), safeStatusCode: id, openedAt: time, lastEvaluatedAt: time,
  resolvedAt: time.optional(), grantsApproval: z.literal(false), grantsNotificationAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), incidentDigest: digest }).strict();
const proposalSchema = z.object({ contractVersion: z.literal(OPERATIONS_MONITORING_CONTRACT_V1), proposalId: id,
  scopeDigest: digest, incidentId: id, incidentDigest: digest, transition: z.enum(["open", "escalate"]),
  severity: z.enum(["warning", "critical"]), safeTemplateCode: id, runbookId: id, destinationPresent: z.literal(false),
  messageBodyPresent: z.literal(false), providerConfigured: z.literal(false), deliveryEnabled: z.literal(false),
  proposalOnly: z.literal(true), grantsApproval: z.literal(false), grantsNotificationAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), proposedAt: time, proposalDigest: digest }).strict();
const snapshotSchema = z.object({ contractVersion: z.literal(OPERATIONS_MONITORING_CONTRACT_V1), snapshotId: id,
  policyDigest: digest, scopeDigest: digest, batchDigest: digest, incidents: z.array(incidentSchema).max(90),
  proposals: z.array(proposalSchema).max(30), openWarningCount: z.number().int().min(0).max(90),
  openCriticalCount: z.number().int().min(0).max(90), unresolvedUnknownCount: z.number().int().min(0).max(30),
  notificationDeliveryEnabled: z.literal(false), grantsApproval: z.literal(false), grantsNotificationAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), projectedAt: time, snapshotDigest: digest }).strict();

const ruleSpecs: Array<Omit<OperationsAlertRuleV1, "ruleDigest">> = [
  { ruleId: "audit_anchor_stale", metricId: "audit_anchor_age_seconds", warningThreshold: 900, criticalThreshold: 3600,
    maximumSampleAgeSeconds: 300, requiredPassingSamplesToClear: 2, missingDataSeverity: "critical",
    comparison: "greater_than_or_equal", runbookId: "runbook:operations:audit-anchor-recovery",
    notificationEligibleTransitions: ["open", "escalate"] },
  { ruleId: "backup_stale", metricId: "backup_age_seconds", warningThreshold: 86_400, criticalThreshold: 172_800,
    maximumSampleAgeSeconds: 900, requiredPassingSamplesToClear: 2, missingDataSeverity: "critical",
    comparison: "greater_than_or_equal", runbookId: "runbook:operations:backup-recovery",
    notificationEligibleTransitions: ["open", "escalate"] },
  { ruleId: "wal_archiving_stale", metricId: "wal_archive_age_seconds", warningThreshold: 300, criticalThreshold: 900,
    maximumSampleAgeSeconds: 120, requiredPassingSamplesToClear: 2, missingDataSeverity: "critical",
    comparison: "greater_than_or_equal", runbookId: "runbook:operations:backup-recovery",
    notificationEligibleTransitions: ["open", "escalate"] },
  { ruleId: "queue_stalled", metricId: "queue_progress_age_seconds", warningThreshold: 600, criticalThreshold: 1800,
    maximumSampleAgeSeconds: 120, requiredPassingSamplesToClear: 2, missingDataSeverity: "warning",
    comparison: "greater_than_or_equal", runbookId: "runbook:operations:queue-stall",
    notificationEligibleTransitions: ["open", "escalate"] },
  { ruleId: "memory_pressure", metricId: "memory_utilization_permille", warningThreshold: 800, criticalThreshold: 900,
    maximumSampleAgeSeconds: 60, requiredPassingSamplesToClear: 2, missingDataSeverity: "warning",
    comparison: "greater_than_or_equal", runbookId: "runbook:operations:resource-pressure",
    notificationEligibleTransitions: ["open", "escalate"] },
  { ruleId: "cpu_pressure", metricId: "cpu_utilization_permille", warningThreshold: 850, criticalThreshold: 950,
    maximumSampleAgeSeconds: 60, requiredPassingSamplesToClear: 2, missingDataSeverity: "warning",
    comparison: "greater_than_or_equal", runbookId: "runbook:operations:resource-pressure",
    notificationEligibleTransitions: ["open", "escalate"] },
  { ruleId: "storage_pressure", metricId: "storage_utilization_permille", warningThreshold: 800, criticalThreshold: 900,
    maximumSampleAgeSeconds: 60, requiredPassingSamplesToClear: 2, missingDataSeverity: "critical",
    comparison: "greater_than_or_equal", runbookId: "runbook:operations:resource-pressure",
    notificationEligibleTransitions: ["open", "escalate"] },
  { ruleId: "recovery_ambiguity", metricId: "recovery_ambiguity_count", warningThreshold: 1, criticalThreshold: 1,
    maximumSampleAgeSeconds: 60, requiredPassingSamplesToClear: 2, missingDataSeverity: "critical",
    comparison: "greater_than_or_equal", runbookId: "runbook:operations:recovery-ambiguity",
    notificationEligibleTransitions: ["open", "escalate"] },
  { ruleId: "lifecycle_failure", metricId: "lifecycle_failure_count", warningThreshold: 1, criticalThreshold: 5,
    maximumSampleAgeSeconds: 60, requiredPassingSamplesToClear: 2, missingDataSeverity: "warning",
    comparison: "greater_than_or_equal", runbookId: "runbook:operations:lifecycle-failure",
    notificationEligibleTransitions: ["open", "escalate"] },
];

function validSubject(metricId: OperationsMetricIdV1, kind: OperationsMonitoringSubjectKindV1,
  key: OperationsMonitoringSubjectKeyV1): boolean {
  if (["memory_utilization_permille", "cpu_utilization_permille", "storage_utilization_permille"].includes(metricId)) {
    return kind === "service" && (OPERATIONS_SERVICE_IDS_V1 as readonly string[]).includes(key);
  }
  if (metricId === "queue_progress_age_seconds") return kind === "queue" && (OPERATIONS_QUEUE_CLASSES_V1 as readonly string[]).includes(key);
  return kind === "topology" && key === "production_topology";
}

function buildSeries(topologyDigest: string): OperationsMonitoringSeriesV1[] {
  const values: ReadonlyArray<readonly [OperationsMetricIdV1, OperationsMonitoringSubjectKindV1,
    OperationsMonitoringSubjectKeyV1]> = [
    ["audit_anchor_age_seconds", "topology", "production_topology"],
    ["backup_age_seconds", "topology", "production_topology"],
    ["wal_archive_age_seconds", "topology", "production_topology"],
    ...OPERATIONS_QUEUE_CLASSES_V1.map((key) => ["queue_progress_age_seconds", "queue", key] as const),
    ...(["memory_utilization_permille", "cpu_utilization_permille", "storage_utilization_permille"] as const)
      .flatMap((metricId) => OPERATIONS_SERVICE_IDS_V1.map((key) => [metricId, "service", key] as const)),
    ["recovery_ambiguity_count", "topology", "production_topology"],
    ["lifecycle_failure_count", "topology", "production_topology"],
  ];
  return values.map(([metricId, subjectKind, subjectKey]) => {
    const subjectDigest = sha256Digest({ topologyDigest, subjectKind, subjectKey });
    const material = { metricId, subjectKind, subjectKey, subjectDigest };
    return { ...material, seriesDigest: sha256Digest(material) };
  });
}

function buildRules(): OperationsAlertRuleV1[] {
  return ruleSpecs.map((material) => ({ ...material, ruleDigest: sha256Digest(material) }));
}

export function buildOperationsMonitoringPolicyV1(inputValue: unknown): OperationsMonitoringPolicyV1 {
  const input = parseExactOperationsV1(policyInputSchema, inputValue, "operations monitoring policy input"),
    topology = parseOperationsProductionTopologyV1(input.topology);
  if (Date.parse(input.expiresAt) <= Date.parse(input.createdAt)) throw new OperationsContractErrorV1("scope_mismatch");
  const material: Omit<OperationsMonitoringPolicyV1, "policyDigest"> = {
    contractVersion: OPERATIONS_MONITORING_CONTRACT_V1, policyId: input.policyId,
    scopeDigest: sha256Digest({ tenantId: input.tenantId, projectId: input.projectId }), topologyDigest: topology.topologyDigest,
    expectedSeries: buildSeries(topology.topologyDigest), rules: buildRules(), maximumSeriesCount: 30,
    maximumSamplesPerSeries: 96, arbitraryLabelsAllowed: false, rawIdentifiersAllowed: false,
    missingDataDisposition: "visible_unknown_alert", notificationDeliveryEnabled: false, monitoringReadOnly: true,
    grantsApproval: false, grantsNotificationAuthority: false, grantsExecutionAuthority: false,
    createdAt: input.createdAt, expiresAt: input.expiresAt,
  };
  return parseOperationsMonitoringPolicyV1({ ...material, policyDigest: sha256Digest(material) });
}

export function parseOperationsMonitoringPolicyV1(value: unknown): OperationsMonitoringPolicyV1 {
  const policy = parseExactOperationsV1(policySchema, value, "operations monitoring policy"),
    expectedSeries = buildSeries(policy.topologyDigest), rules = buildRules();
  if (JSON.stringify(policy.expectedSeries) !== JSON.stringify(expectedSeries) || JSON.stringify(policy.rules) !== JSON.stringify(rules)
    || new Set(policy.expectedSeries.map((series) => series.seriesDigest)).size !== 30) throw new OperationsContractErrorV1("scope_mismatch");
  verifyOperationsDigestV1(policy as unknown as Record<string, unknown>, "policyDigest", policy.policyDigest); return policy;
}

function sampleMaximum(metricId: OperationsMetricIdV1): number {
  if (metricId.endsWith("_permille")) return 1000;
  if (metricId.endsWith("_count")) return 1_000_000;
  return 604_800;
}

export function buildOperationsMetricSampleV1(inputValue: unknown): OperationsMetricSampleV1 {
  const input = parseExactOperationsV1(sampleInputSchema, inputValue, "operations monitoring metric sample input"),
    policy = parseOperationsMonitoringPolicyV1(input.policy), series = policy.expectedSeries.find((item) => item.metricId === input.metricId
      && item.subjectKind === input.subjectKind && item.subjectKey === input.subjectKey);
  if (!series || !validSubject(input.metricId, input.subjectKind, input.subjectKey)
    || Date.parse(input.validUntil) <= Date.parse(input.observedAt)
    || (input.state === "observed") !== (input.value !== undefined && input.evidenceDigest !== undefined)
    || (input.value !== undefined && input.value > sampleMaximum(input.metricId))) throw new OperationsContractErrorV1("scope_mismatch");
  const material: Omit<OperationsMetricSampleV1, "sampleDigest"> = {
    contractVersion: OPERATIONS_MONITORING_CONTRACT_V1, sampleId: input.sampleId, policyDigest: policy.policyDigest,
    scopeDigest: policy.scopeDigest, topologyDigest: policy.topologyDigest, metricId: input.metricId,
    subjectKind: input.subjectKind, subjectKey: input.subjectKey, subjectDigest: series.subjectDigest,
    seriesDigest: series.seriesDigest, state: input.state, ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.evidenceDigest ? { evidenceDigest: input.evidenceDigest } : {}), safeStatusCode: input.safeStatusCode,
    observedAt: input.observedAt, validUntil: input.validUntil, containsRawIdentifier: false, containsRawLabel: false,
    containsRawOutput: false, containsCredentialMaterial: false, grantsApproval: false,
    grantsNotificationAuthority: false, grantsExecutionAuthority: false,
  };
  return parseOperationsMetricSampleV1({ ...material, sampleDigest: sha256Digest(material) });
}

export function parseOperationsMetricSampleV1(value: unknown): OperationsMetricSampleV1 {
  const sample = parseExactOperationsV1(sampleSchema, value, "operations monitoring metric sample");
  if (!validSubject(sample.metricId, sample.subjectKind, sample.subjectKey)
    || (sample.state === "observed") !== (sample.value !== undefined && sample.evidenceDigest !== undefined)
    || (sample.value !== undefined && sample.value > sampleMaximum(sample.metricId))
    || Date.parse(sample.validUntil) <= Date.parse(sample.observedAt)
    || sample.subjectDigest !== sha256Digest({ topologyDigest: sample.topologyDigest,
      subjectKind: sample.subjectKind, subjectKey: sample.subjectKey })) throw new OperationsContractErrorV1("scope_mismatch");
  verifyOperationsDigestV1(sample as unknown as Record<string, unknown>, "sampleDigest", sample.sampleDigest); return sample;
}

export class OperationsInMemoryTimeSeriesStoreV1 {
  readonly #policy: OperationsMonitoringPolicyV1;
  readonly #samples = new Map<string, OperationsMetricSampleV1>();
  readonly #series = new Map<string, OperationsMetricSampleV1[]>();
  constructor(policyValue: OperationsMonitoringPolicyV1, options: { testOnly: true }) {
    if (options.testOnly !== true) throw new OperationsContractErrorV1("unsupported_action");
    this.#policy = parseOperationsMonitoringPolicyV1(policyValue);
  }
  append(sampleValue: OperationsMetricSampleV1): { sample: OperationsMetricSampleV1; replayed: boolean } {
    const sample = parseOperationsMetricSampleV1(sampleValue);
    if (sample.policyDigest !== this.#policy.policyDigest || sample.scopeDigest !== this.#policy.scopeDigest
      || sample.topologyDigest !== this.#policy.topologyDigest
      || !this.#policy.expectedSeries.some((series) => series.seriesDigest === sample.seriesDigest)) throw new OperationsContractErrorV1("scope_mismatch");
    const existing = this.#samples.get(sample.sampleId);
    if (existing) {
      if (existing.sampleDigest !== sample.sampleDigest) throw new OperationsContractErrorV1("digest_mismatch");
      return { sample: structuredClone(existing), replayed: true };
    }
    const values = this.#series.get(sample.seriesDigest) ?? [], latest = values.at(-1);
    if (latest && Date.parse(sample.observedAt) <= Date.parse(latest.observedAt)) throw new OperationsContractErrorV1("invalid_transition");
    if (values.length >= this.#policy.maximumSamplesPerSeries) throw new OperationsContractErrorV1("unsupported_action");
    values.push(structuredClone(sample)); this.#series.set(sample.seriesDigest, values); this.#samples.set(sample.sampleId, structuredClone(sample));
    return { sample: structuredClone(sample), replayed: false };
  }
  list(seriesDigest: string, through: string): OperationsMetricSampleV1[] {
    if (!/^sha256:[a-f0-9]{64}$/.test(seriesDigest) || !Number.isFinite(Date.parse(through))) throw new OperationsContractErrorV1("invalid_input");
    return (this.#series.get(seriesDigest) ?? []).filter((sample) => sample.observedAt <= through).map((sample) => structuredClone(sample));
  }
  get policy(): OperationsMonitoringPolicyV1 { return structuredClone(this.#policy); }
}

const trustedBatches = new WeakSet<object>(), trustedProposals = new WeakSet<object>();

function ruleForMetric(policy: OperationsMonitoringPolicyV1, metricId: OperationsMetricIdV1): OperationsAlertRuleV1 {
  const rule = policy.rules.find((item) => item.metricId === metricId); if (!rule) throw new OperationsContractErrorV1("evidence_missing"); return rule;
}

export function evaluateOperationsMonitoringV1(input: { batchId: string; policy: OperationsMonitoringPolicyV1;
  store: OperationsInMemoryTimeSeriesStoreV1; evaluatedAt: string }): OperationsAlertEvaluationBatchV1 {
  const policy = parseOperationsMonitoringPolicyV1(input.policy);
  if (policy.policyDigest !== input.store.policy.policyDigest || !Number.isFinite(Date.parse(input.evaluatedAt))
    || Date.parse(input.evaluatedAt) < Date.parse(policy.createdAt) || Date.parse(input.evaluatedAt) >= Date.parse(policy.expiresAt)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const evaluations = policy.expectedSeries.map((series): OperationsAlertEvaluationV1 => {
    const rule = ruleForMetric(policy, series.metricId), samples = input.store.list(series.seriesDigest, input.evaluatedAt), latest = samples.at(-1);
    let state: OperationsAlertEvaluationV1["state"], severity: OperationsAlertEvaluationV1["severity"], safeStatusCode: string,
      consecutivePassingSamples = 0;
    if (!latest) { state = "unknown"; severity = "unknown"; safeStatusCode = "required_series_missing"; }
    else if (Date.parse(latest.validUntil) < Date.parse(input.evaluatedAt)
      || Date.parse(input.evaluatedAt) - Date.parse(latest.observedAt) > rule.maximumSampleAgeSeconds * 1000) {
      state = "unknown"; severity = "unknown"; safeStatusCode = "sample_stale";
    } else if (latest.state === "unknown") { state = "unknown"; severity = "unknown"; safeStatusCode = latest.safeStatusCode; }
    else if (latest.value! >= rule.criticalThreshold) { state = "firing"; severity = "critical"; safeStatusCode = "critical_threshold_reached"; }
    else if (latest.value! >= rule.warningThreshold) { state = "firing"; severity = "warning"; safeStatusCode = "warning_threshold_reached"; }
    else {
      for (let position = samples.length - 1; position >= 0; position -= 1) {
        const sample = samples[position]!;
        if (sample.state !== "observed" || sample.value! >= rule.warningThreshold
          || Date.parse(sample.validUntil) < Date.parse(input.evaluatedAt)
          || Date.parse(input.evaluatedAt) - Date.parse(sample.observedAt) > rule.maximumSampleAgeSeconds * 1000) break;
        consecutivePassingSamples += 1;
      }
      state = consecutivePassingSamples >= rule.requiredPassingSamplesToClear ? "clear_candidate" : "clear_pending";
      severity = "none"; safeStatusCode = state === "clear_candidate" ? "clear_hysteresis_satisfied" : "clear_hysteresis_pending";
    }
    const material: Omit<OperationsAlertEvaluationV1, "evaluationDigest"> = {
      contractVersion: OPERATIONS_MONITORING_CONTRACT_V1,
      evaluationId: `evaluation:${input.batchId}:${policy.expectedSeries.indexOf(series)}`, policyDigest: policy.policyDigest,
      scopeDigest: policy.scopeDigest, ruleId: rule.ruleId, ruleDigest: rule.ruleDigest, seriesDigest: series.seriesDigest,
      subjectKind: series.subjectKind, subjectKey: series.subjectKey, state, severity, safeStatusCode,
      ...(latest ? { sampleDigest: latest.sampleDigest } : {}), consecutivePassingSamples, evaluatedAt: input.evaluatedAt,
      grantsApproval: false, grantsNotificationAuthority: false, grantsExecutionAuthority: false,
    };
    const result = parseExactOperationsV1(evaluationSchema, { ...material, evaluationDigest: sha256Digest(material) },
      "operations alert evaluation");
    verifyOperationsDigestV1(result as unknown as Record<string, unknown>, "evaluationDigest", result.evaluationDigest); return result;
  });
  const material: Omit<OperationsAlertEvaluationBatchV1, "batchDigest"> = {
    contractVersion: OPERATIONS_MONITORING_CONTRACT_V1, batchId: input.batchId, policyDigest: policy.policyDigest,
    scopeDigest: policy.scopeDigest, evaluations, firingCount: evaluations.filter((item) => item.state === "firing").length,
    unknownCount: evaluations.filter((item) => item.state === "unknown").length,
    clearPendingCount: evaluations.filter((item) => item.state === "clear_pending").length,
    clearCandidateCount: evaluations.filter((item) => item.state === "clear_candidate").length,
    evaluatedAt: input.evaluatedAt, missingDataHealthy: false, performsNotification: false, grantsApproval: false,
    grantsNotificationAuthority: false, grantsExecutionAuthority: false,
  };
  const batch = parseExactOperationsV1(batchSchema, { ...material, batchDigest: sha256Digest(material) }, "operations alert batch");
  trustedBatches.add(batch); return batch;
}

type IncidentHead = { generation: number; current?: OperationsMonitoringIncidentV1 };
export class OperationsInMemoryIncidentStoreV1 {
  readonly #policy: OperationsMonitoringPolicyV1;
  readonly #heads = new Map<string, IncidentHead>();
  readonly #processed = new Map<string, OperationsMonitoringSnapshotV1>();
  constructor(policyValue: OperationsMonitoringPolicyV1, options: { testOnly: true }) {
    if (options.testOnly !== true) throw new OperationsContractErrorV1("unsupported_action");
    this.#policy = parseOperationsMonitoringPolicyV1(policyValue);
  }
  apply(batch: OperationsAlertEvaluationBatchV1): { snapshot: OperationsMonitoringSnapshotV1; replayed: boolean } {
    if (!trustedBatches.has(batch) || batch.policyDigest !== this.#policy.policyDigest || batch.scopeDigest !== this.#policy.scopeDigest) {
      throw new OperationsContractErrorV1("unsupported_action");
    }
    const replay = this.#processed.get(batch.batchDigest);
    if (replay) {
      const snapshot = structuredClone(replay); for (const proposal of snapshot.proposals) trustedProposals.add(proposal);
      return { snapshot, replayed: true };
    }
    const proposals: OperationsNotificationProposalV1[] = [];
    for (const evaluation of batch.evaluations) {
      const correlationKey = sha256Digest({ scopeDigest: batch.scopeDigest, ruleId: evaluation.ruleId,
        seriesDigest: evaluation.seriesDigest }), head = this.#heads.get(correlationKey) ?? { generation: 0 }, prior = head.current,
        rule = this.#policy.rules.find((item) => item.ruleId === evaluation.ruleId)!;
      if (evaluation.state === "firing" || evaluation.state === "unknown") {
        const severity = evaluation.state === "unknown" ? rule.missingDataSeverity : evaluation.severity as "warning" | "critical";
        const transition = !prior || prior.state === "resolved" ? "open" as const
          : prior.severity === "warning" && severity === "critical" ? "escalate" as const : undefined;
        const generation = !prior || prior.state === "resolved" ? head.generation + 1 : prior.generation;
        const openedAt = !prior || prior.state === "resolved" ? batch.evaluatedAt : prior.openedAt;
        const incidentId = `incident:operations:${evaluation.ruleId}:${evaluation.seriesDigest.slice(7, 19)}:${generation}`;
        const material: Omit<OperationsMonitoringIncidentV1, "incidentDigest"> = {
          contractVersion: OPERATIONS_MONITORING_CONTRACT_V1, incidentId, scopeDigest: batch.scopeDigest,
          correlationKey, generation, ruleId: evaluation.ruleId, seriesDigest: evaluation.seriesDigest,
          subjectKind: evaluation.subjectKind, subjectKey: evaluation.subjectKey, state: "open", severity,
          safeStatusCode: evaluation.safeStatusCode, openedAt, lastEvaluatedAt: batch.evaluatedAt,
          grantsApproval: false, grantsNotificationAuthority: false, grantsExecutionAuthority: false,
        };
        const incident = parseIncident({ ...material, incidentDigest: sha256Digest(material) });
        head.generation = generation; head.current = incident; this.#heads.set(correlationKey, head);
        if (transition) proposals.push(this.proposal(incident, transition, rule, batch.evaluatedAt));
      } else if (prior?.state === "open" && evaluation.state === "clear_candidate") {
        const material: Omit<OperationsMonitoringIncidentV1, "incidentDigest"> = { ...prior, state: "resolved",
          safeStatusCode: "alert_condition_cleared", lastEvaluatedAt: batch.evaluatedAt, resolvedAt: batch.evaluatedAt };
        delete (material as Partial<OperationsMonitoringIncidentV1>).incidentDigest;
        head.current = parseIncident({ ...material, incidentDigest: sha256Digest(material) }); this.#heads.set(correlationKey, head);
      } else if (prior?.state === "open") {
        const material: Omit<OperationsMonitoringIncidentV1, "incidentDigest"> = { ...prior,
          safeStatusCode: evaluation.safeStatusCode, lastEvaluatedAt: batch.evaluatedAt };
        delete (material as Partial<OperationsMonitoringIncidentV1>).incidentDigest;
        head.current = parseIncident({ ...material, incidentDigest: sha256Digest(material) }); this.#heads.set(correlationKey, head);
      }
    }
    const incidents = [...this.#heads.values()].flatMap((head) => head.current ? [head.current] : [])
      .sort((left, right) => left.correlationKey.localeCompare(right.correlationKey));
    const material: Omit<OperationsMonitoringSnapshotV1, "snapshotDigest"> = {
      contractVersion: OPERATIONS_MONITORING_CONTRACT_V1, snapshotId: `monitoring-snapshot:${batch.batchId}`,
      policyDigest: batch.policyDigest, scopeDigest: batch.scopeDigest, batchDigest: batch.batchDigest, incidents,
      proposals, openWarningCount: incidents.filter((item) => item.state === "open" && item.severity === "warning").length,
      openCriticalCount: incidents.filter((item) => item.state === "open" && item.severity === "critical").length,
      unresolvedUnknownCount: batch.unknownCount, notificationDeliveryEnabled: false, grantsApproval: false,
      grantsNotificationAuthority: false, grantsExecutionAuthority: false, projectedAt: batch.evaluatedAt,
    };
    const snapshot = parseSnapshot({ ...material, snapshotDigest: sha256Digest(material) });
    for (const proposal of snapshot.proposals) trustedProposals.add(proposal);
    this.#processed.set(batch.batchDigest, structuredClone(snapshot)); return { snapshot, replayed: false };
  }
  private proposal(incident: OperationsMonitoringIncidentV1, transition: "open" | "escalate",
    rule: OperationsAlertRuleV1, proposedAt: string): OperationsNotificationProposalV1 {
    const material: Omit<OperationsNotificationProposalV1, "proposalDigest"> = {
      contractVersion: OPERATIONS_MONITORING_CONTRACT_V1,
      proposalId: `notification-proposal:${incident.incidentId}:${transition}`, scopeDigest: incident.scopeDigest,
      incidentId: incident.incidentId, incidentDigest: incident.incidentDigest, transition, severity: incident.severity,
      safeTemplateCode: `operations_${incident.ruleId}_${transition}`, runbookId: rule.runbookId,
      destinationPresent: false, messageBodyPresent: false, providerConfigured: false, deliveryEnabled: false,
      proposalOnly: true, grantsApproval: false, grantsNotificationAuthority: false, grantsExecutionAuthority: false, proposedAt,
    };
    const proposal = parseProposal({ ...material, proposalDigest: sha256Digest(material) }); trustedProposals.add(proposal); return proposal;
  }
}

function parseIncident(value: unknown): OperationsMonitoringIncidentV1 {
  const incident = parseExactOperationsV1(incidentSchema, value, "operations monitoring incident");
  if ((incident.state === "resolved") !== Boolean(incident.resolvedAt)
    || Date.parse(incident.lastEvaluatedAt) < Date.parse(incident.openedAt)
    || incident.resolvedAt && incident.resolvedAt !== incident.lastEvaluatedAt) throw new OperationsContractErrorV1("scope_mismatch");
  verifyOperationsDigestV1(incident as unknown as Record<string, unknown>, "incidentDigest", incident.incidentDigest); return incident;
}
function parseProposal(value: unknown): OperationsNotificationProposalV1 {
  const proposal = parseExactOperationsV1(proposalSchema, value, "operations notification proposal");
  verifyOperationsDigestV1(proposal as unknown as Record<string, unknown>, "proposalDigest", proposal.proposalDigest); return proposal;
}
function parseSnapshot(value: unknown): OperationsMonitoringSnapshotV1 {
  const snapshot = parseExactOperationsV1(snapshotSchema, value, "operations monitoring snapshot");
  if (snapshot.openWarningCount !== snapshot.incidents.filter((item) => item.state === "open" && item.severity === "warning").length
    || snapshot.openCriticalCount !== snapshot.incidents.filter((item) => item.state === "open" && item.severity === "critical").length) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(snapshot as unknown as Record<string, unknown>, "snapshotDigest", snapshot.snapshotDigest); return snapshot;
}

export function projectOperationsMonitoringV1(snapshotValue: OperationsMonitoringSnapshotV1,
  policyValue: OperationsMonitoringPolicyV1): OperationsMonitoringOperatorProjectionV1 {
  const snapshot = parseSnapshot(snapshotValue), policy = parseOperationsMonitoringPolicyV1(policyValue);
  if (snapshot.policyDigest !== policy.policyDigest || snapshot.scopeDigest !== policy.scopeDigest) throw new OperationsContractErrorV1("scope_mismatch");
  const open = snapshot.incidents.filter((incident) => incident.state === "open"), cards = snapshot.incidents.map((incident) => {
    const runbookId = policy.rules.find((rule) => rule.ruleId === incident.ruleId)!.runbookId;
    const material = { incidentId: incident.incidentId, ruleId: incident.ruleId, subjectKind: incident.subjectKind,
      subjectKey: incident.subjectKey, state: incident.state, severity: incident.severity,
      safeStatusCode: incident.safeStatusCode, runbookId };
    return { ...material, cardDigest: sha256Digest(material) };
  });
  const material: Omit<OperationsMonitoringOperatorProjectionV1, "projectionDigest"> = {
    contractVersion: OPERATIONS_MONITORING_CONTRACT_V1, snapshotDigest: snapshot.snapshotDigest,
    scopeDigest: snapshot.scopeDigest, status: snapshot.unresolvedUnknownCount > 0 ? "uncertain"
      : open.length > 0 ? "attention_required" : "clear",
    counts: { warning: snapshot.openWarningCount, critical: snapshot.openCriticalCount,
      unknown: snapshot.unresolvedUnknownCount, disabledNotificationProposals: snapshot.proposals.length }, cards,
    rawLabelsShown: false, rawIdentifiersShown: false, actionControlsPresent: false, notificationControlsPresent: false,
    grantsApproval: false, grantsNotificationAuthority: false,
  };
  return { ...material, projectionDigest: sha256Digest(material) };
}

export function createOperationsDisabledNotificationAdapterV1(): OperationsDisabledNotificationAdapterV1 {
  const adapter: OperationsDisabledNotificationAdapterV1 = { kind: "disabled_notification_no_io", inspect(proposal, recordedAt) {
    if (!trustedProposals.has(proposal) || !Number.isFinite(Date.parse(recordedAt))
      || Date.parse(recordedAt) < Date.parse(proposal.proposedAt)) throw new OperationsContractErrorV1("unsupported_action");
    const material: Omit<OperationsDisabledNotificationReceiptV1, "receiptDigest"> = {
      contractVersion: OPERATIONS_MONITORING_CONTRACT_V1, proposalDigest: proposal.proposalDigest,
      state: "disabled_before_delivery", safeCode: "notification_provider_and_destination_absent",
      providerContacted: false, networkAttempted: false, notificationDelivered: false, createsMonitoringSignal: false,
      grantsApproval: false, grantsNotificationAuthority: false, grantsExecutionAuthority: false, recordedAt,
    };
    return { ...material, receiptDigest: sha256Digest(material) };
  } };
  return Object.freeze(adapter);
}

export function buildOperationsSyntheticMonitoringSamplesV1(input: { policy: OperationsMonitoringPolicyV1;
  observedAt: string; validUntil: string; mode?: "healthy" | "backup_critical" | "queue_warning" | "resource_critical" |
    "recovery_ambiguous" | "explicit_unknown" }): OperationsMetricSampleV1[] {
  const policy = parseOperationsMonitoringPolicyV1(input.policy), mode = input.mode ?? "healthy";
  return policy.expectedSeries.map((series, position) => {
    let value = series.metricId.endsWith("_permille") ? 400 : series.metricId.endsWith("_count") ? 0 : 30;
    let state: "observed" | "unknown" = "observed", safeStatusCode = "synthetic_metric_current";
    if (mode === "backup_critical" && series.metricId === "backup_age_seconds") value = 200_000;
    if (mode === "queue_warning" && series.metricId === "queue_progress_age_seconds" && series.subjectKey === "scheduled") value = 900;
    if (mode === "resource_critical" && series.metricId === "storage_utilization_permille"
      && series.subjectKey === "service:operations:postgres") value = 950;
    if (mode === "recovery_ambiguous" && series.metricId === "recovery_ambiguity_count") value = 1;
    if (mode === "explicit_unknown" && series.metricId === "wal_archive_age_seconds") {
      state = "unknown"; safeStatusCode = "synthetic_wal_observer_uncertain";
    }
    return buildOperationsMetricSampleV1({ sampleId: `metric-sample:operations:${position}:${input.observedAt.replaceAll(/[^0-9]/g, "")}`,
      policy, metricId: series.metricId, subjectKind: series.subjectKind, subjectKey: series.subjectKey, state,
      ...(state === "observed" ? { value, evidenceDigest: sha256Digest({ syntheticMonitoring: policy.policyDigest,
        seriesDigest: series.seriesDigest, observedAt: input.observedAt, value }) } : {}), safeStatusCode,
      observedAt: input.observedAt, validUntil: input.validUntil });
  });
}

export const operationsMonitoringSchemasV1 = { policy: policySchema, sample: sampleSchema, evaluation: evaluationSchema,
  batch: batchSchema, incident: incidentSchema, proposal: proposalSchema, snapshot: snapshotSchema } as const;
