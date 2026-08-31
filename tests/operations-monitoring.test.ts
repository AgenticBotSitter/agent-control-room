import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildOperationsMetricSampleV1,
  buildOperationsMonitoringPolicyV1,
  buildOperationsSyntheticMonitoringSamplesV1,
  buildOperationsSyntheticTopologyFixtureV1,
  createOperationsDisabledNotificationAdapterV1,
  evaluateOperationsMonitoringV1,
  OPERATIONS_ALERT_RULE_IDS_V1,
  OPERATIONS_METRIC_IDS_V1,
  OPERATIONS_QUEUE_CLASSES_V1,
  OperationsContractErrorV1,
  OperationsInMemoryIncidentStoreV1,
  OperationsInMemoryTimeSeriesStoreV1,
  parseOperationsMetricSampleV1,
  parseOperationsMonitoringPolicyV1,
  projectOperationsMonitoringV1,
  type OperationsAlertEvaluationBatchV1,
  type OperationsMetricSampleV1,
  type OperationsMonitoringPolicyV1,
} from "../src/operations/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

const distinct = (label: string) => sha256Digest({ test: "operations-monitoring", label });
const code = (safeCode: string) => (error: unknown) => error instanceof OperationsContractErrorV1 && error.safeCode === safeCode;
const clone = <T>(value: T): T => structuredClone(value);
function resign<T extends Record<string, unknown>>(value: T, key: string): T {
  const material = { ...value }; delete material[key]; return { ...value, [key]: sha256Digest(material) };
}
function at(seconds: number) { return new Date(Date.parse("2026-08-30T04:00:00.000Z") + seconds * 1000).toISOString(); }

function policy(tenantId = "tenant:operations:test", projectId = "project:operations:test") {
  const topology = buildOperationsSyntheticTopologyFixtureV1();
  return { topology, policy: buildOperationsMonitoringPolicyV1({ policyId: "monitoring-policy:operations:test",
    tenantId, projectId, topology, createdAt: at(0), expiresAt: at(7200) }) };
}
function append(store: OperationsInMemoryTimeSeriesStoreV1, samples: OperationsMetricSampleV1[]) {
  for (const sample of samples) store.append(sample);
}
function samples(value: OperationsMonitoringPolicyV1, observed: number, mode: Parameters<typeof buildOperationsSyntheticMonitoringSamplesV1>[0]["mode"] = "healthy") {
  return buildOperationsSyntheticMonitoringSamplesV1({ policy: value, observedAt: at(observed), validUntil: at(observed + 300), mode });
}

test("CR10A-OPS-070 freezes thirty bounded safe series and nine deterministic alert rules", () => {
  const { policy: value } = policy();
  assert.deepEqual(parseOperationsMonitoringPolicyV1(value), value);
  assert.equal(value.expectedSeries.length, 30); assert.equal(value.rules.length, 9);
  assert.deepEqual(value.rules.map((rule) => rule.ruleId), [...OPERATIONS_ALERT_RULE_IDS_V1]);
  assert.deepEqual(new Set(value.expectedSeries.map((series) => series.metricId)), new Set(OPERATIONS_METRIC_IDS_V1));
  assert.equal(value.expectedSeries.filter((series) => series.subjectKind === "queue").length, OPERATIONS_QUEUE_CLASSES_V1.length);
  assert.equal(value.expectedSeries.filter((series) => series.subjectKind === "service").length, 21);
  assert.equal(value.maximumSeriesCount, 30); assert.equal(value.maximumSamplesPerSeries, 96);
  assert.equal(value.arbitraryLabelsAllowed || value.rawIdentifiersAllowed || value.notificationDeliveryEnabled
    || !value.monitoringReadOnly || value.grantsApproval || value.grantsNotificationAuthority || value.grantsExecutionAuthority, false);
  assert.equal(JSON.stringify(value).includes("tenant:operations:test") || JSON.stringify(value).includes("project:operations:test"), false);
});

test("CR10A-OPS-070 policy rejects cardinality, threshold, rule-order, and runbook drift after re-signing", () => {
  const { policy: value } = policy();
  const extra = clone(value) as unknown as Record<string, unknown>;
  (extra.expectedSeries as unknown[]).push(clone(value.expectedSeries[0]!));
  assert.throws(() => parseOperationsMonitoringPolicyV1(resign(extra, "policyDigest")));
  const threshold = clone(value); threshold.rules[0]!.criticalThreshold = 1;
  threshold.rules[0] = resign(threshold.rules[0] as unknown as Record<string, unknown>, "ruleDigest") as never;
  assert.throws(() => parseOperationsMonitoringPolicyV1(resign(threshold as unknown as Record<string, unknown>, "policyDigest")), code("scope_mismatch"));
  const reordered = clone(value); reordered.rules.reverse();
  assert.throws(() => parseOperationsMonitoringPolicyV1(resign(reordered as unknown as Record<string, unknown>, "policyDigest")), code("scope_mismatch"));
  const runbook = clone(value); runbook.rules[3]!.runbookId = "runbook:operations:invented";
  runbook.rules[3] = resign(runbook.rules[3] as unknown as Record<string, unknown>, "ruleDigest") as never;
  assert.throws(() => parseOperationsMonitoringPolicyV1(resign(runbook as unknown as Record<string, unknown>, "policyDigest")), code("scope_mismatch"));
});

test("CR10A-OPS-070 samples are scope-bound, exact, digest-only, and append-only", () => {
  const first = policy(), second = policy("tenant:operations:foreign", "project:operations:foreign"),
    store = new OperationsInMemoryTimeSeriesStoreV1(first.policy, { testOnly: true }), sample = samples(first.policy, 30)[0]!;
  assert.deepEqual(parseOperationsMetricSampleV1(sample), sample);
  assert.equal(sample.containsRawIdentifier || sample.containsRawLabel || sample.containsRawOutput
    || sample.containsCredentialMaterial || sample.grantsApproval || sample.grantsNotificationAuthority
    || sample.grantsExecutionAuthority, false);
  assert.equal(store.append(sample).replayed, false); assert.equal(store.append(sample).replayed, true);
  const drift = resign({ ...clone(sample), value: sample.value! + 1 } as unknown as Record<string, unknown>, "sampleDigest");
  assert.throws(() => store.append(drift as unknown as OperationsMetricSampleV1), code("digest_mismatch"));
  assert.throws(() => new OperationsInMemoryTimeSeriesStoreV1(second.policy, { testOnly: true }).append(sample), code("scope_mismatch"));
  const raw = { sampleId: "metric-sample:raw-label", policy: first.policy, metricId: "backup_age_seconds",
    subjectKind: "topology", subjectKey: "production_topology", state: "observed", value: 30,
    evidenceDigest: distinct("raw-label"), safeStatusCode: "current", observedAt: at(30), validUntil: at(330),
    labels: { hostname: "forbidden" } };
  assert.throws(() => buildOperationsMetricSampleV1(raw));
});

test("CR10A-OPS-070 sample input rejects arbitrary subjects, raw labels, accessors, and Proxies", () => {
  const { policy: value } = policy(), input = { sampleId: "metric-sample:operations:hostile", policy: value,
    metricId: "backup_age_seconds" as const, subjectKind: "topology" as const, subjectKey: "production_topology" as const,
    state: "observed" as const, value: 30, evidenceDigest: distinct("hostile"), safeStatusCode: "current",
    observedAt: at(30), validUntil: at(330) };
  assert.throws(() => buildOperationsMetricSampleV1({ ...input, subjectKey: "host:raw:123" }));
  assert.throws(() => buildOperationsMetricSampleV1({ ...input, token: "secret-value" }));
  const accessor = { ...input }; Object.defineProperty(accessor, "value", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => buildOperationsMetricSampleV1(accessor));
  const proxy = observedProxy(input, "throwing"); assert.throws(() => buildOperationsMetricSampleV1(proxy.value));
  assert.equal(proxy.trapCount(), 0);
});

test("CR10A-OPS-070 healthy state needs two current passing samples before it can clear", () => {
  const { policy: value } = policy(), store = new OperationsInMemoryTimeSeriesStoreV1(value, { testOnly: true });
  append(store, samples(value, 60));
  const first = evaluateOperationsMonitoringV1({ batchId: "alert-batch:healthy:first", policy: value, store, evaluatedAt: at(75) });
  assert.equal(first.clearPendingCount, 30); assert.equal(first.clearCandidateCount, 0);
  append(store, samples(value, 90));
  const second = evaluateOperationsMonitoringV1({ batchId: "alert-batch:healthy:second", policy: value, store, evaluatedAt: at(105) });
  assert.equal(second.clearCandidateCount, 30); assert.equal(second.firingCount + second.unknownCount + second.clearPendingCount, 0);
  assert.equal(second.missingDataHealthy || second.performsNotification || second.grantsApproval
    || second.grantsNotificationAuthority || second.grantsExecutionAuthority, false);
});

test("CR10A-OPS-070 missing, stale, and explicitly unknown data stay visible and fail closed", () => {
  const { policy: value } = policy(), missingStore = new OperationsInMemoryTimeSeriesStoreV1(value, { testOnly: true });
  const missing = evaluateOperationsMonitoringV1({ batchId: "alert-batch:missing", policy: value,
    store: missingStore, evaluatedAt: at(30) });
  assert.equal(missing.unknownCount, 30); assert.equal(missing.evaluations.every((item) => item.safeStatusCode === "required_series_missing"), true);
  const incidents = new OperationsInMemoryIncidentStoreV1(value, { testOnly: true }).apply(missing).snapshot;
  assert.equal(incidents.incidents.filter((item) => item.state === "open").length, 30);
  assert.equal(incidents.openCriticalCount > 0 && incidents.openWarningCount > 0, true);
  const staleStore = new OperationsInMemoryTimeSeriesStoreV1(value, { testOnly: true }); append(staleStore, samples(value, 30));
  const stale = evaluateOperationsMonitoringV1({ batchId: "alert-batch:stale", policy: value, store: staleStore, evaluatedAt: at(400) });
  assert.equal(stale.unknownCount, 30); assert.equal(stale.evaluations.every((item) => item.safeStatusCode === "sample_stale"), true);
  const unknownStore = new OperationsInMemoryTimeSeriesStoreV1(value, { testOnly: true }); append(unknownStore, samples(value, 60, "explicit_unknown"));
  const unknown = evaluateOperationsMonitoringV1({ batchId: "alert-batch:explicit-unknown", policy: value,
    store: unknownStore, evaluatedAt: at(75) });
  assert.equal(unknown.unknownCount, 1); assert.equal(unknown.evaluations.find((item) => item.ruleId === "wal_archiving_stale")?.safeStatusCode,
    "synthetic_wal_observer_uncertain");
});

test("CR10A-OPS-070 opens, escalates, correlates, and clears incidents without alert loops", () => {
  const { policy: value } = policy(), store = new OperationsInMemoryTimeSeriesStoreV1(value, { testOnly: true }),
    incidents = new OperationsInMemoryIncidentStoreV1(value, { testOnly: true });
  append(store, samples(value, 30, "queue_warning"));
  const warning = evaluateOperationsMonitoringV1({ batchId: "alert-batch:queue-warning", policy: value, store, evaluatedAt: at(45) }),
    opened = incidents.apply(warning);
  const target = opened.snapshot.incidents.find((item) => item.ruleId === "queue_stalled" && item.subjectKey === "scheduled")!;
  assert.equal(target.state, "open"); assert.equal(target.severity, "warning"); assert.equal(target.generation, 1);
  assert.equal(opened.snapshot.proposals.some((proposal) => proposal.incidentId === target.incidentId && proposal.transition === "open"), true);
  const replay = incidents.apply(warning); assert.equal(replay.replayed, true);
  assert.equal(replay.snapshot.proposals.length, opened.snapshot.proposals.length);
  const criticalSamples = samples(value, 60, "queue_warning");
  const scheduled = criticalSamples.find((sample) => sample.metricId === "queue_progress_age_seconds" && sample.subjectKey === "scheduled")!;
  const critical = buildOperationsMetricSampleV1({ sampleId: "metric-sample:queue:critical", policy: value,
    metricId: scheduled.metricId, subjectKind: scheduled.subjectKind, subjectKey: scheduled.subjectKey, state: "observed",
    value: 2000, evidenceDigest: distinct("queue-critical"), safeStatusCode: "synthetic_metric_current",
    observedAt: at(60), validUntil: at(360) });
  append(store, criticalSamples.filter((sample) => sample.seriesDigest !== scheduled.seriesDigest)); store.append(critical);
  const escalated = incidents.apply(evaluateOperationsMonitoringV1({ batchId: "alert-batch:queue-critical", policy: value,
    store, evaluatedAt: at(75) })).snapshot;
  assert.equal(escalated.incidents.find((item) => item.correlationKey === target.correlationKey)?.severity, "critical");
  assert.equal(escalated.proposals.some((proposal) => proposal.incidentId === target.incidentId && proposal.transition === "escalate"), true);
  append(store, samples(value, 90));
  const pending = incidents.apply(evaluateOperationsMonitoringV1({ batchId: "alert-batch:queue-clear-pending", policy: value,
    store, evaluatedAt: at(105) })).snapshot;
  assert.equal(pending.incidents.find((item) => item.correlationKey === target.correlationKey)?.state, "open");
  append(store, samples(value, 120));
  const resolved = incidents.apply(evaluateOperationsMonitoringV1({ batchId: "alert-batch:queue-clear", policy: value,
    store, evaluatedAt: at(135) })).snapshot;
  assert.equal(resolved.incidents.find((item) => item.correlationKey === target.correlationKey)?.state, "resolved");
  assert.equal(resolved.proposals.length, 0);
});

test("CR10A-OPS-070 refuses forged clear batches even when every ordinary digest is recomputed", () => {
  const { policy: value } = policy(), store = new OperationsInMemoryTimeSeriesStoreV1(value, { testOnly: true }),
    incidents = new OperationsInMemoryIncidentStoreV1(value, { testOnly: true });
  append(store, samples(value, 30, "backup_critical"));
  const real = evaluateOperationsMonitoringV1({ batchId: "alert-batch:forged-clear", policy: value, store, evaluatedAt: at(45) });
  incidents.apply(real); const forged = clone(real), target = forged.evaluations.find((item) => item.ruleId === "backup_stale")!;
  target.state = "clear_candidate"; target.severity = "none"; target.safeStatusCode = "clear_hysteresis_satisfied";
  target.consecutivePassingSamples = 2;
  Object.assign(target, resign(target as unknown as Record<string, unknown>, "evaluationDigest"));
  forged.firingCount -= 1; forged.clearCandidateCount += 1;
  Object.assign(forged, resign(forged as unknown as Record<string, unknown>, "batchDigest"));
  assert.throws(() => incidents.apply(forged as OperationsAlertEvaluationBatchV1), code("unsupported_action"));
});

test("CR10A-OPS-070 notification output is disabled proposal evidence, never approval or delivery", () => {
  const { policy: value } = policy(), store = new OperationsInMemoryTimeSeriesStoreV1(value, { testOnly: true }),
    incidents = new OperationsInMemoryIncidentStoreV1(value, { testOnly: true });
  append(store, samples(value, 30, "recovery_ambiguous"));
  const batch = evaluateOperationsMonitoringV1({ batchId: "alert-batch:notification", policy: value, store, evaluatedAt: at(45) }),
    snapshot = incidents.apply(batch).snapshot, proposal = snapshot.proposals.find((item) => item.severity === "critical")!;
  assert.ok(proposal); assert.equal(proposal.destinationPresent || proposal.messageBodyPresent || proposal.providerConfigured
    || proposal.deliveryEnabled || !proposal.proposalOnly || proposal.grantsApproval || proposal.grantsNotificationAuthority
    || proposal.grantsExecutionAuthority, false);
  const receipt = createOperationsDisabledNotificationAdapterV1().inspect(proposal, at(50));
  assert.equal(receipt.state, "disabled_before_delivery");
  assert.equal(receipt.providerContacted || receipt.networkAttempted || receipt.notificationDelivered
    || receipt.createsMonitoringSignal || receipt.grantsApproval || receipt.grantsNotificationAuthority
    || receipt.grantsExecutionAuthority, false);
  const forged = resign({ ...clone(proposal), deliveryEnabled: true } as unknown as Record<string, unknown>, "proposalDigest");
  assert.throws(() => createOperationsDisabledNotificationAdapterV1().inspect(forged as never, at(50)), code("unsupported_action"));
});

test("CR10A-OPS-070 operator projection is bounded, safe, linked to fixed runbooks, and control-free", () => {
  const { policy: value } = policy(), store = new OperationsInMemoryTimeSeriesStoreV1(value, { testOnly: true }),
    incidents = new OperationsInMemoryIncidentStoreV1(value, { testOnly: true });
  append(store, samples(value, 30, "resource_critical"));
  const batch = evaluateOperationsMonitoringV1({ batchId: "alert-batch:projection", policy: value, store, evaluatedAt: at(45) }),
    snapshot = incidents.apply(batch).snapshot, projection = projectOperationsMonitoringV1(snapshot, value);
  assert.equal(projection.status, "attention_required"); assert.equal(projection.cards.length, 1);
  assert.equal(projection.cards[0]?.runbookId, "runbook:operations:resource-pressure");
  assert.equal(projection.rawLabelsShown || projection.rawIdentifiersShown || projection.actionControlsPresent
    || projection.notificationControlsPresent || projection.grantsApproval || projection.grantsNotificationAuthority, false);
});

test("CR10A-OPS-070 implementation contains no telemetry, provider, notification, network, or process client", () => {
  const source = readFileSync("src/operations/v1/monitoring.ts", "utf8");
  assert.doesNotMatch(source, /node:(?:child_process|net|tls|http|https)|from ["']postgres["']|@aws-sdk|cloudflare|fetch\s*\(|sendgrid|twilio/);
});
