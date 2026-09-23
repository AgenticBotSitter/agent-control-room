import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskDetail } from "../src/web/v1/task-wire.ts";
import type { ActionInboxItemV1 } from "../src/operator-surfaces/v1/types.ts";
import type { JobState } from "../src/domain/v1/types.ts";
import {
  OWNER_NOTIFICATIONS_CONTRACT_V1,
  createNotificationLedgerV1,
  deliverOwnerNotificationV1,
  notificationEnvelopeFromDecisionV1,
  notificationEnvelopeHasNoAuthorityV1,
  notificationEnvelopeSchemaV1,
  notificationKeyV1,
  ownerNotificationSettingsSchemaV1,
  planOwnerNotificationsV1,
} from "../src/notifications/v1/index.ts";
import type {
  NotificationAcknowledgementV1,
  NotificationDecisionV1,
  NotificationEnvelopeV1,
  NotificationPlanV1,
  NotificationSourceRecordV1,
  OwnerNotificationSettingsV1,
} from "../src/notifications/v1/index.ts";
import { NotificationDecisionList, NotificationSettingsSurface } from "../private-app/app/notification-settings.tsx";
import { HermesDeliveryRecoveryPanel, TaskDetailPanel, TaskStateGuidance, taskStateGuidance } from "../private-app/app/task-panels.tsx";
import { PrivateSettingsWorkspace } from "../private-app/app/settings/workspace.tsx";
import { readOwnerNotificationsV1, unavailableOwnerNotificationsV1 } from "../src/web/v1/owner-notifications-browser-client.ts";
import { OwnerNotificationsPanel } from "../private-app/app/owner-notifications-workspace.tsx";
import { OPERATOR_SURFACES_CONTRACT_V1, type OperatorSurfaceSnapshotV1 } from "../src/operator-surfaces/v1/types.ts";

test("Settings mounts the read-only owner notifications boundary", () => {
  const html = renderToStaticMarkup(<PrivateSettingsWorkspace />);
  assert.match(html, /Owner notifications/);
  assert.match(html, /fixed read-only default/i);
  assert.match(html, /completion\/failure job-outcome notifications are not shown/i);
  assert.doesNotMatch(html, /Save notification policy/);
});

const at = "2026-09-13T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
function detail(state: TaskDetail["task"]["state"], run?: Partial<TaskDetail["attempts"][number]["runs"][number]>,
  progressSource: TaskDetail["progressSource"] = "configured"): TaskDetail {
  return { project: { projectId: "project:test", title: "Test project", summary: "Test summary", origin: "ordinary",
    lifecycle: "active", version: 1, createdAt: at, updatedAt: at, lifecycleEditable: true },
    task: { jobId: "job:test", projectId: "project:test", requestId: "request:test", title: "Test task",
      state, version: 1, createdAt: at, updatedAt: at }, instructions: "Deliver the requested result", inputDigest: digest,
    observedAt: at, attempts: run ? [{ attemptId: "attempt:test", attemptNumber: 1, state: "running", additionalRunsOmitted: false,
      runs: [{ runId: "run:test", harness: "codex", state: "running", lastObservedAt: at, stale: false,
        firstObservedExecutionAt: at, finishedObservedAt: null, cancellation: "not_requested", source: "native_snapshot",
        nativeState: "running", availability: "current", usage: null, resultClaim: null, timeline: [],
        earlierObservationsOmitted: false, ...run }] }] : [], earlierAttemptsOmitted: false,
    preparedFor: null, hermesDeliveryRecovery: { source: "not_applicable" },
    progressSource, dispatch: "configured", artifacts: "configured", review: "recorded" };
}

test("local Hermes recovery tells the owner only what saved evidence proves", () => {
  const staged = renderToStaticMarkup(<HermesDeliveryRecoveryPanel recovery={{ source: "configured", status: {
    state: "terminal_result_staged", terminal: { terminalResultDigest: digest, contentDigest: digest, sizeBytes: 12,
      inputTokens: 4, outputTokens: 5, totalTokens: 9, durationMs: 8 },
    startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsResume: false,
  } }} />);
  assert.match(staged, /Terminal result safely staged/);
  assert.match(staged, /text and private runner settings are not shown/i);
  assert.match(staged, /Saved result size/);
  assert.match(staged, />12 bytes</);
  assert.match(staged, /Reported tokens/);
  assert.match(staged, />9</);
  assert.match(staged, /Reported duration/);
  assert.match(staged, />8 ms</);
  assert.match(staged, /cannot start, retry, resume, publish, or contact Hermes/i);
  assert.doesNotMatch(staged, /<button|<form|Start Hermes|Retry Hermes|Resume Hermes/);
  assert.doesNotMatch(staged, /sha256:|session:/);
  const ambiguous = renderToStaticMarkup(<HermesDeliveryRecoveryPanel recovery={{ source: "ambiguous_attempt" }} />);
  assert.match(ambiguous, /will not guess which delivery record to inspect/i);
});

test("a prepared task shows only its safe worker category and no assignment claim", () => {
  for (const [preparedFor, label] of [["hermes", "Hermes Agent"], ["codex", "Codex"], ["claude", "Claude Code"],
    ["configured_worker", "Configured worker"]] as const) {
    const html = renderToStaticMarkup(<TaskDetailPanel detail={{ ...detail("ready"), preparedFor }} />);
    assert.match(html, new RegExp(`prepared for ${label}`));
    assert.match(html, /Preparation does not assign or start this worker/);
    assert.match(html, /not a current availability or running-work signal/);
    assert.doesNotMatch(html, /template:|worker:|credential:|sha256:/);
  }
});

test("a prepared local worker explains its route limit without advertising an enabled process", () => {
  const hermes = renderToStaticMarkup(<TaskDetailPanel detail={{ ...detail("ready"), preparedFor: "hermes" }} />);
  assert.match(hermes, /limited to a supplied-text review/);
  assert.match(hermes, /Before it can receive even that work/);
  const claude = renderToStaticMarkup(<TaskDetailPanel detail={{ ...detail("ready"), preparedFor: "claude" }} />);
  assert.match(claude, /one text-only review/);
  assert.match(claude, /does not allow tools, add-ons, saved sessions, or unattended permission prompts/);
  assert.doesNotMatch(`${hermes}${claude}`, /<button|<form|<input|available now|running now/i);
});

test("each ordinary task state points to one safe next destination or explanation", () => {
  const expected = new Map<TaskDetail["task"]["state"], string | undefined>([
    ["proposed", "#task-planning"], ["ready", "#task-assignment"], ["leased", "#task-assignment"],
    ["running", undefined], ["waiting_approval", "#task-approval"], ["succeeded", "#task-results"],
    ["failed", undefined], ["cancelled", undefined], ["orphaned", undefined], ["rejected", undefined],
  ]);
  for (const [state, href] of expected) {
    const guidance = taskStateGuidance(state === "running" ? detail(state, {}) : detail(state));
    assert.equal(guidance.href, href, state);
    assert.equal(guidance.uncertain, state === "orphaned", state);
  }
});

test("old, disconnected and ambiguous latest observations allow only a read-only recheck", () => {
  const cases = [{ stale: true }, { state: "disconnected" as const }, { nativeState: "ambiguous" as const },
    { availability: "offline" as const }, { availability: "expired" as const }, { availability: "unknown" as const }];
  for (const patch of cases) {
    const value = detail("running", patch);
    const guidance = taskStateGuidance(value);
    assert.equal(guidance.uncertain, true);
    assert.equal(guidance.href, undefined);
    const html = renderToStaticMarkup(<TaskStateGuidance detail={value} refreshing={false} onRefresh={() => {}} />);
    assert.match(html, /does not retry this task or send replacement work/);
    assert.match(html, />Check latest saved status</);
    assert.doesNotMatch(html, /Go to (assignment|approval|preparation)/);
    assert.doesNotMatch(html, /Retry task|Resubmit|Start replacement/i);
  }
});

test("current states render semantic links and a disabled read-only check while refreshing", () => {
  const succeeded = renderToStaticMarkup(<TaskStateGuidance detail={detail("succeeded")} refreshing={true} onRefresh={() => {}} />);
  assert.match(succeeded, /href="#task-results"/);
  assert.match(succeeded, /disabled=""/);
  assert.match(succeeded, /Checking saved status/);
  const proposed = renderToStaticMarkup(<TaskStateGuidance detail={detail("proposed")} refreshing={false} onRefresh={() => {}} />);
  assert.match(proposed, /href="#task-planning"/);
  assert.match(proposed, /This does not assign or start an agent/);
});

test("a running task never claims current work when agent evidence is absent or terminal", () => {
  const cases = [detail("running"), detail("running", undefined, "not_configured"),
    ...(["completed", "failed", "cancelled", "interrupted"] as const).map(nativeState => detail("running", { nativeState })),
    ...(["succeeded", "failed", "cancelled"] as const).map(state => detail("running", { state }))];
  for (const value of cases) {
    const guidance = taskStateGuidance(value);
    assert.equal(guidance.uncertain, true);
    assert.equal(guidance.href, undefined);
    assert.doesNotMatch(guidance.explanation, /current progress|work is in progress/i);
    assert.match(guidance.explanation, /does not retry/);
  }
});

function notificationSnapshot(): OperatorSurfaceSnapshotV1 {
  return { contractVersion: OPERATOR_SURFACES_CONTRACT_V1, tenantId: "tenant:test", generatedAt: at,
    fleet: [], bottlenecks: [], activeWork: [], portfolio: [], services: [], schedules: [], ownerFocus: [],
    actionInbox: [attentionItem("approval", "open"), attentionItem("review", "resolved")],
    serviceIncidents: [{ id: "incident:test", serviceId: "service:test", severity: "critical", state: "open",
      reasonCode: "check_failed", remedyCode: "inspect_logs", openedAt: at, lastObservedAt: at }] };
}

test("notification reader maps only attention and incidents using the fixed default", async () => {
  const snapshot = notificationSnapshot();
  snapshot.activeWork.push({ jobId: "job:active", projectId: "project:other", state: "waiting_approval",
    jobType: "test", priority: 1, requiredCapability: "test", updatedAt: at });
  const calls: unknown[] = [];
  const view = await readOwnerNotificationsV1(async (url, init) => {
    calls.push([url, init]);
    return Response.json({ snapshot });
  });
  assert.equal(calls.length, 1);
  const [url, init] = calls[0] as [string, RequestInit];
  assert.equal(url, "/api/v1/operator-surface");
  assert.equal(init.credentials, "same-origin"); assert.equal(init.cache, "no-store");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(view.state, "available");
  assert.equal(ownerNotificationSettingsSchemaV1.safeParse(view.settings).success, true);
  assert.equal(view.settings.tenantId, snapshot.tenantId);
  assert.equal(view.settings.quietHours, null);
  assert.ok(view.settings.projectScopes.every(scope => scope.enabled && scope.severityFloor === "routine"));
  assert.deepEqual(view.plan.decisions.map(d => [d.recordId, d.recordKind, d.state]), [
    ["attention:approval:open", "attention", "notify"], ["attention:review:resolved", "attention", "suppressed"],
    ["incident:test", "service_incident", "notify"],
  ]);
  assert.equal(view.plan.decisions[0].projectId, "project:test");
  assert.equal(view.plan.decisions[2].severity, "urgent");
  assert.ok(view.plan.decisions.every(d => !d.mayAct));
  assert.doesNotMatch(JSON.stringify(view.plan), /approve_exact_operation|legalResponses/);
  const html = renderToStaticMarkup(<OwnerNotificationsPanel view={view} />);
  assert.match(html, /Decide the waiting item is waiting on a decision/);
  assert.equal((html.match(/<fieldset disabled="">/g) ?? []).length, 3);
  assert.doesNotMatch(html, /Save notification policy/);
});

test("failed notification source reads render missing observation, never an empty healthy panel", async () => {
  const invalid = { ...notificationSnapshot(), actionInbox: [{}] };
  const fetchers = [
    async () => new Response(null, { status: 401 }),
    async () => new Response(null, { status: 503 }),
    async () => Response.json({ snapshot: invalid }),
    async () => new Response("not json"),
    async () => { throw new Error("private diagnostic must not escape"); },
  ];
  for (const fetcher of fetchers) {
    const view = await readOwnerNotificationsV1(fetcher);
    assert.equal(view.state, "unavailable");
    assert.deepEqual(view.plan.decisions.map(d => [d.state, d.reasonCode]), [["unavailable", "missing_observation"]]);
    assert.deepEqual(view.plan.deliverableKeys, []);
    const html = renderToStaticMarkup(<OwnerNotificationsPanel view={view} />);
    assert.match(html, /Notification source unavailable/);
    assert.match(html, /missing data is not healthy state/);
    assert.doesNotMatch(html, /No saved record is in|private diagnostic|Save notification policy/);
  }
  const loading = renderToStaticMarkup(<OwnerNotificationsPanel view={unavailableOwnerNotificationsV1()} loading />);
  assert.match(loading, /Loading saved notification sources/);
  assert.match(loading, /Notification source unavailable/);
});

test("an observed empty notification source is distinct from an unavailable read", async () => {
  const snapshot = { ...notificationSnapshot(), actionInbox: [], serviceIncidents: [] };
  const view = await readOwnerNotificationsV1(async () => Response.json({ snapshot }));
  assert.equal(view.state, "available");
  assert.deepEqual(view.plan.decisions, []);
  const html = renderToStaticMarkup(<OwnerNotificationsPanel view={view} />);
  assert.match(html, /No saved record is in the notification scope/);
  assert.doesNotMatch(html, /Notification source unavailable/);
});

// --- Owner notification policy (issue #298) ---

const notificationNow = "2026-09-17T03:00:00.000Z";

function attentionItem(kind: ActionInboxItemV1["kind"], state: ActionInboxItemV1["state"]): ActionInboxItemV1 {
  return { id: `attention:${kind}:${state}`, tenantId: "tenant:test", projectId: "project:test", kind, state,
    requestedAction: "Decide the waiting item", reasonCode: "owner_decision_needed", blockedWorkItemIds: [],
    legalResponses: [
      { id: "response:approve", kind: "approve_exact_operation", label: "Approve the exact operation", requiresConfirmation: true, available: true },
      { id: "response:decline", kind: "decline", label: "Decline", requiresConfirmation: false, available: true },
    ], evidence: [], createdAt: notificationNow, deliveryState: "not_requested" };
}

function attentionRecord(kind: ActionInboxItemV1["kind"], state: ActionInboxItemV1["state"], projectId = "project:test"): NotificationSourceRecordV1 {
  const item = attentionItem(kind, state);
  return { recordId: item.id, recordKind: "attention", projectId, title: "Waiting item", observedAt: notificationNow, item };
}

function outcomeRecord(state: JobState, projectId = "project:test"): NotificationSourceRecordV1 {
  return { recordId: `outcome:${state}`, recordKind: "work_outcome", projectId, title: `Delivery ${state}`,
    observedAt: notificationNow, jobId: `job:${state}`, state };
}

function incidentRecord(state: "open" | "resolved", severity: "warning" | "critical"): NotificationSourceRecordV1 {
  return { recordId: `incident:guard:${state}`, recordKind: "service_incident", projectId: "project:test",
    title: "Watchdog incident", observedAt: notificationNow,
    incident: { id: `incident:guard:${state}`, serviceId: "service:guard", severity, state, reasonCode: "check_failed",
      remedyCode: "inspect_logs", openedAt: notificationNow, lastObservedAt: notificationNow } };
}

function missingRecord(sourceLabel = "task result index"): NotificationSourceRecordV1 {
  return { recordId: `missing:${sourceLabel}`, recordKind: "missing", projectId: "project:test",
    title: `Missing ${sourceLabel}`, observedAt: notificationNow, sourceLabel };
}

function notificationSettings(patch: Partial<OwnerNotificationSettingsV1> = {}): OwnerNotificationSettingsV1 {
  return { contractVersion: OWNER_NOTIFICATIONS_CONTRACT_V1, tenantId: "tenant:test", revision: 3, updatedAt: notificationNow,
    projectScopes: [{ projectId: "project:test", enabled: true, severityFloor: "routine" }], quietHours: null,
    channels: [{ channel: "in_app", available: true },
      { channel: "email", available: false, unavailableReasonCode: "external_not_sent", unavailableReasonText: "Declared only; no message is sent." },
      { channel: "push", available: false, unavailableReasonCode: "external_not_sent" }],
    ...patch };
}

function planOf(records: NotificationSourceRecordV1[], patch: Partial<OwnerNotificationSettingsV1> = {},
  acknowledgements: NotificationAcknowledgementV1[] = [], now = notificationNow): NotificationPlanV1 {
  return planOwnerNotificationsV1({ settings: notificationSettings(patch), records, acknowledgements, now });
}

const decisionFor = (plan: NotificationPlanV1, record: NotificationSourceRecordV1): NotificationDecisionV1 | undefined =>
  plan.decisions.find(decision => decision.key === notificationKeyV1(record));

function recordingSink() {
  const envelopes: NotificationEnvelopeV1[] = [];
  return { envelopes, sink: { channel: "in_app" as const,
    async record(envelope: NotificationEnvelopeV1) { envelopes.push(envelope); return { acknowledged: true }; } } };
}

test("each meaningful saved state produces exactly one deduplicated notification", () => {
  const completion = outcomeRecord("succeeded");
  const plan = planOf([completion, completion, outcomeRecord("failed"), attentionRecord("approval", "open"),
    attentionRecord("ambiguity", "open")]);
  assert.equal(plan.counts.notify, 4);
  assert.equal(plan.counts.deduplicated, 1);
  assert.equal(new Set(plan.decisions.map(decision => decision.key)).size, 4);
  assert.deepEqual(plan.deliverableKeys, [completion, outcomeRecord("failed"), attentionRecord("approval", "open"),
    attentionRecord("ambiguity", "open")].map(notificationKeyV1));
  const duplicate = plan.decisions[1];
  assert.equal(duplicate.state, "deduplicated");
  assert.equal(duplicate.reasonCode, "duplicate_record");
  assert.equal(plan.decisions.find(decision => decision.key === notificationKeyV1(completion))?.state, "notify");
  assert.equal(decisionFor(plan, outcomeRecord("failed"))?.needKind, "failure");
  assert.equal(decisionFor(plan, attentionRecord("approval", "open"))?.needKind, "owner_decision");
  assert.equal(decisionFor(plan, attentionRecord("ambiguity", "open"))?.needKind, "uncertainty");
});

test("healthy and idle states stay quiet and a decision can never act", () => {
  const plan = planOf([outcomeRecord("running"), outcomeRecord("leased"), outcomeRecord("cancelled"), outcomeRecord("rejected"),
    attentionRecord("native_session", "open"), attentionRecord("review", "resolved"), incidentRecord("resolved", "critical")]);
  assert.equal(plan.counts.notify, 0);
  assert.equal(plan.counts.suppressed, 7);
  assert.deepEqual(plan.deliverableKeys, []);
  for (const decision of plan.decisions) {
    assert.equal(decision.reasonCode, "unchanged_healthy_state");
    assert.equal(decision.mayAct, false);
  }
});

test("repeated reads and restart re-derive the same keys and notify once", async () => {
  const record = outcomeRecord("succeeded");
  const first = planOf([record]);
  const { envelopes, sink } = recordingSink();
  const ledger = createNotificationLedgerV1();
  const delivered = await deliverOwnerNotificationV1({ decision: first.decisions[0], sink, ledger, now: notificationNow });
  assert.equal(delivered.state, "delivered");
  assert.equal(envelopes.length, 1);
  const second = planOf([record], {}, ledger.entries());
  assert.equal(second.counts.notify, 0);
  assert.equal(second.counts.deduplicated, 1);
  assert.equal(second.decisions[0].reasonCode, "restart_replay");
  assert.deepEqual(second.decisions.map(decision => decision.key), first.decisions.map(decision => decision.key));
  const again = await deliverOwnerNotificationV1({ decision: second.decisions[0], sink, ledger, now: notificationNow });
  assert.equal(again.state, "refused");
  assert.equal(again.reasonCode, "restart_replay");
  assert.equal(envelopes.length, 1);
});

test("a lost acknowledgement reserves the key and never sends a second notification", async () => {
  const record = attentionRecord("approval", "open");
  const ledger = createNotificationLedgerV1();
  const key = notificationKeyV1(record);
  assert.equal(await ledger.reserve(key, notificationNow), true);
  const plan = planOf([record], {}, ledger.entries());
  assert.equal(plan.counts.notify, 0);
  assert.equal(plan.decisions[0].state, "deduplicated");
  assert.equal(plan.decisions[0].reasonCode, "delivery_attempt_unknown");
  const { envelopes, sink } = recordingSink();
  const result = await deliverOwnerNotificationV1({ decision: plan.decisions[0], sink, ledger, now: notificationNow });
  assert.equal(result.state, "refused");
  assert.equal(result.reasonCode, "delivery_attempt_unknown");
  assert.equal(envelopes.length, 0);
});

test("quiet hours suppress only the saved severities, in the saved timezone", () => {
  const quietHours = { timezone: "UTC", startLocalTime: "22:00", endLocalTime: "07:00", appliesTo: ["routine", "notable"] as const };
  const patch = { quietHours: { ...quietHours, appliesTo: [...quietHours.appliesTo] } };
  const inside = planOf([outcomeRecord("succeeded"), attentionRecord("approval", "open"), missingRecord()], patch);
  assert.equal(inside.quietHoursActive, true);
  assert.equal(decisionFor(inside, outcomeRecord("succeeded"))?.reasonCode, "quiet_hours");
  assert.equal(decisionFor(inside, outcomeRecord("succeeded"))?.state, "suppressed");
  assert.equal(decisionFor(inside, attentionRecord("approval", "open"))?.state, "notify");
  assert.equal(decisionFor(inside, missingRecord())?.reasonCode, "missing_observation");
  const outside = planOf([outcomeRecord("succeeded")], patch, [], "2026-09-17T12:00:00.000Z");
  assert.equal(outside.quietHoursActive, false);
  assert.equal(outside.decisions[0].state, "notify");
  const otherZone = planOf([outcomeRecord("succeeded")], { quietHours: { ...patch.quietHours, timezone: "Pacific/Auckland" } }, [],
    "2026-09-17T03:00:00.000Z");
  assert.equal(otherZone.decisions[0].state, "notify");
});

test("project scope and severity floor are explicit, and missing data is unavailable rather than healthy", () => {
  const scopes = { projectScopes: [{ projectId: "project:test", enabled: true, severityFloor: "urgent" as const },
    { projectId: "project:other", enabled: false, severityFloor: "routine" as const }] };
  const plan = planOf([outcomeRecord("succeeded"), outcomeRecord("failed", "project:other"), outcomeRecord("failed", "project:unknown"),
    attentionRecord("approval", "open"), missingRecord()], scopes);
  assert.equal(decisionFor(plan, outcomeRecord("succeeded"))?.reasonCode, "below_project_severity_floor");
  assert.equal(decisionFor(plan, outcomeRecord("failed", "project:other"))?.reasonCode, "project_not_in_scope");
  assert.equal(decisionFor(plan, outcomeRecord("failed", "project:unknown"))?.reasonCode, "project_not_in_scope");
  assert.equal(decisionFor(plan, attentionRecord("approval", "open"))?.state, "notify");
  const missing = decisionFor(plan, missingRecord());
  assert.equal(missing?.state, "unavailable");
  assert.equal(missing?.reasonCode, "missing_observation");
  assert.match(missing?.summary ?? "", /unavailable rather than healthy/i);
});

test("an unavailable in-product channel is reported unavailable, and external channels are never sent", async () => {
  const record = outcomeRecord("succeeded");
  const unavailable = planOf([record], { channels: [{ channel: "in_app", available: false, unavailableReasonCode: "collector_offline",
    unavailableReasonText: "The in-product inbox collector is offline." }, { channel: "email", available: false, unavailableReasonCode: "external_not_sent" }] });
  assert.equal(unavailable.decisions[0].state, "unavailable");
  assert.equal(unavailable.decisions[0].reasonCode, "channel_unavailable");
  assert.deepEqual(unavailable.deliverableKeys, []);
  const { envelopes, sink } = recordingSink();
  const ledger = createNotificationLedgerV1();
  const external = await deliverOwnerNotificationV1({ decision: { ...unavailable.decisions[0], state: "notify", channel: "email" },
    sink, ledger, now: notificationNow });
  assert.equal(external.state, "refused");
  assert.equal(external.reasonCode, "external_channel_not_permitted");
  assert.equal(envelopes.length, 0);
});

test("the envelope carries description only and parses as an authority-free record", () => {
  const decision = decisionFor(planOf([attentionRecord("approval", "open")]), attentionRecord("approval", "open"));
  assert.ok(decision);
  const envelope = notificationEnvelopeFromDecisionV1(decision);
  assert.equal(envelope.authority, "none");
  assert.deepEqual(envelope.actions, []);
  assert.equal("legalResponses" in envelope, false);
  assert.equal("command" in envelope, false);
  assert.equal(notificationEnvelopeHasNoAuthorityV1(envelope), true);
  assert.equal(notificationEnvelopeSchemaV1.safeParse(envelope).success, true);
  assert.doesNotMatch(JSON.stringify(envelope), /legalResponses|record_decision|approve_exact_operation/);
  const smuggled: Record<string, unknown> = { ...envelope, legalResponses: [] };
  assert.equal(notificationEnvelopeSchemaV1.safeParse(smuggled).success, false);
});

test("settings validation refuses an unusable notification policy", () => {
  assert.equal(ownerNotificationSettingsSchemaV1.safeParse(notificationSettings()).success, true);
  const cases: Record<string, unknown>[] = [
    { ...notificationSettings(), quietHours: { timezone: "UTC", startLocalTime: "07:00", endLocalTime: "07:00", appliesTo: ["routine"] } },
    { ...notificationSettings(), projectScopes: [{ projectId: "project:test", enabled: true, severityFloor: "routine" },
      { projectId: "project:test", enabled: false, severityFloor: "urgent" }] },
    { ...notificationSettings(), channels: [{ channel: "in_app", available: true }, { channel: "email", available: true }] },
    { ...notificationSettings(), channels: [{ channel: "in_app", available: true }, { channel: "email", available: false }] },
    { ...notificationSettings(), channels: [{ channel: "email", available: false, unavailableReasonCode: "external_not_sent" }] },
    { ...notificationSettings(), quietHours: { timezone: "UTC", startLocalTime: "7:00", endLocalTime: "07:00", appliesTo: ["routine"] } },
  ];
  for (const value of cases) assert.equal(ownerNotificationSettingsSchemaV1.safeParse(value).success, false, JSON.stringify(value));
});

test("the settings surface renders labelled keyboard and text controls, never pointer-only ones", () => {
  const plan = planOf([outcomeRecord("succeeded"), attentionRecord("approval", "open")]);
  const settings = notificationSettings();
  const html = renderToStaticMarkup(<NotificationSettingsSurface settings={settings} decisions={plan.decisions} onChange={() => {}} onSave={() => {}} />);
  const control = (id: string, selector = "input") => new RegExp(`<${selector}[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
  assert.match(html, /<label for="quiet-hours-start">/);
  assert.match(html, /<label for="quiet-hours-start-text">/);
  assert.match(html, /<label for="quiet-hours-timezone">/);
  assert.equal((html.match(/type="time"/g) ?? []).length, 2);
  assert.equal((html.match(/inputMode="numeric"/g) ?? []).length, 2);
  assert.match(control("quiet-hours-start-text"), /pattern="\(\[01\]\[0-9\]\|2\[0-3\]\):\[0-5\]\[0-9\]"/);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 3);
  assert.match(control("project-project:test-floor-urgent"), /name="project-project:test-floor"/);
  assert.match(control("project-project:test-enabled"), /type="checkbox"/);
  assert.ok(control("channel-email").includes("disabled"));
  assert.match(control("channel-email"), /aria-describedby="channel-email-reason"/);
  assert.match(html, /data-field="policy-summary"/);
  assert.match(html, /Quiet hours: no quiet hours saved/);
  assert.match(html, /data-field="keyboard-alternatives"/);
  assert.match(html, /<caption>Saved records considered under this policy<\/caption>/);
  assert.match(html, /<th scope="col">Reason<\/th>/);
  assert.match(html, /A notification describes a saved completion, failure, uncertainty or waiting decision/);
  assert.doesNotMatch(html, /onmousedown|ondrag|role="slider"|tabindex="-1"|aria-hidden="true"/i);
  const readOnly = renderToStaticMarkup(<NotificationSettingsSurface settings={settings} decisions={plan.decisions} />);
  assert.match(readOnly, /Read-only/);
  assert.equal((readOnly.match(/<fieldset disabled="">/g) ?? []).length, 3);
  const empty = renderToStaticMarkup(<NotificationDecisionList decisions={[]} />);
  assert.match(empty, /No saved record is in the notification scope right now/);
  assert.equal((empty.match(/<tr>/g) ?? []).length, 3);
  assert.equal((html.match(/<td>Delivery succeeded recorded complete<\/td>/g) ?? []).length, 1);
  assert.equal((html.match(/<tr>/g) ?? []).length, 4);
});
