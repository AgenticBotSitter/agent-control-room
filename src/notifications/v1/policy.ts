import type { JobState } from "../../domain/v1/types";
import type { AttentionKindV1 } from "../../operator-surfaces/v1/types";
import { notificationQuietSummaryV1, notificationSummaryV1 } from "./presentation";
import type {
  NotificationAcknowledgementV1,
  NotificationChannelAvailabilityV1,
  NotificationChannelV1,
  NotificationDecisionStateV1,
  NotificationDecisionV1,
  NotificationDeliveryLedgerV1,
  NotificationDeliveryResultV1,
  NotificationEnvelopeV1,
  NotificationNeedKindV1,
  NotificationPlanV1,
  NotificationReasonCodeV1,
  NotificationSeverityV1,
  NotificationSinkV1,
  NotificationSourceRecordV1,
  OwnerNotificationSettingsV1,
} from "./types";
import { OWNER_NOTIFICATIONS_CONTRACT_V1 } from "./types";

const severityRank: Record<NotificationSeverityV1, number> = { routine: 0, notable: 1, urgent: 2 };

/** Delivery preference. Only `in_app` is ever attempted. */
const channelPreference: NotificationChannelV1[] = ["in_app", "email", "push"];

const attentionNeed: Record<AttentionKindV1, NotificationNeedKindV1 | null> = {
  approval: "owner_decision",
  question: "owner_decision",
  review: "owner_decision",
  authority_expiry: "owner_decision",
  failure: "failure",
  incident: "failure",
  ambiguity: "uncertainty",
  native_session: null,
};

const jobNeed: Record<JobState, NotificationNeedKindV1 | null> = {
  proposed: null,
  ready: null,
  leased: null,
  running: null,
  waiting_approval: "owner_decision",
  succeeded: "completion",
  failed: "failure",
  cancelled: null,
  orphaned: "uncertainty",
  rejected: null,
};

const needSeverity: Record<NotificationNeedKindV1, NotificationSeverityV1> = {
  completion: "notable",
  failure: "notable",
  uncertainty: "urgent",
  owner_decision: "urgent",
};

/**
 * Deterministic dedupe key. It is derived from the canonical record identity and
 * its recorded state only — never from a timestamp — so a repeated read, a
 * restart or a lost acknowledgement all reproduce the same key.
 */
export function notificationKeyV1(record: NotificationSourceRecordV1): string {
  switch (record.recordKind) {
    case "attention":
      return `owner-notification:attention:${record.item.id}:${record.item.state}`;
    case "work_outcome":
      return `owner-notification:work_outcome:${record.jobId}:${record.state}`;
    case "service_incident":
      return `owner-notification:service_incident:${record.incident.id}:${record.incident.state}`;
    case "missing":
      return `owner-notification:missing:${record.sourceLabel}:${record.projectId ?? "tenant"}`;
  }
}

/** `null` means the recorded state is healthy or idle: it stays quiet. */
export function notificationNeedV1(record: NotificationSourceRecordV1): NotificationNeedKindV1 | null {
  switch (record.recordKind) {
    case "missing":
      return null;
    case "attention": {
      if (record.item.state !== "open") return null;
      return attentionNeed[record.item.kind];
    }
    case "work_outcome":
      return jobNeed[record.state];
    case "service_incident":
      return record.incident.state === "open" ? "failure" : null;
  }
}

export function notificationSeverityV1(record: NotificationSourceRecordV1, needKind: NotificationNeedKindV1): NotificationSeverityV1 {
  if (record.recordKind === "service_incident" && record.incident.severity === "critical") return "urgent";
  return needSeverity[needKind];
}

function minutesOfLocalTime(value: string): number | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Local minutes in the saved timezone; `null` when the value or zone is unusable. */
export function localMinutesInTimezoneV1(instantIso: string, timezone: string): number | null {
  const instant = new Date(instantIso);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour12: false, hour: "2-digit", minute: "2-digit" })
      .formatToParts(instant);
    const hour = parts.find((part) => part.type === "hour")?.value;
    const minute = parts.find((part) => part.type === "minute")?.value;
    if (hour === undefined || minute === undefined) return null;
    return (Number(hour) % 24) * 60 + Number(minute);
  } catch {
    return null;
  }
}

/**
 * Quiet hours are a local-time window. A window whose end precedes its start
 * wraps past midnight. An unusable timezone is treated as *no* quiet hours and
 * reported by the caller's settings validation, never as silence by accident.
 */
export function quietHoursActiveV1(
  quietHours: OwnerNotificationSettingsV1["quietHours"],
  severity: NotificationSeverityV1,
  nowIso: string,
): boolean {
  if (!quietHours || !quietHours.appliesTo.includes(severity)) return false;
  const start = minutesOfLocalTime(quietHours.startLocalTime);
  const end = minutesOfLocalTime(quietHours.endLocalTime);
  const current = localMinutesInTimezoneV1(nowIso, quietHours.timezone);
  if (start === null || end === null || current === null || start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function scopeFor(settings: OwnerNotificationSettingsV1, projectId: string | undefined) {
  if (projectId === undefined) return undefined;
  return settings.projectScopes.find((entry) => entry.projectId === projectId);
}

function selectChannel(channels: NotificationChannelAvailabilityV1[]): NotificationChannelAvailabilityV1 {
  for (const channel of channelPreference) {
    const entry = channels.find((candidate) => candidate.channel === channel);
    if (entry?.available && channel === "in_app") return entry;
  }
  const inApp = channels.find((candidate) => candidate.channel === "in_app");
  return inApp ?? { channel: "in_app", available: false, unavailableReasonCode: "channel_not_configured" };
}

function baseDecision(record: NotificationSourceRecordV1, needKind: NotificationNeedKindV1, severity: NotificationSeverityV1,
  state: NotificationDecisionStateV1, reasonCode: NotificationReasonCodeV1, channel: NotificationChannelV1,
  title: string, summary: string): NotificationDecisionV1 {
  return {
    key: notificationKeyV1(record),
    recordId: record.recordId,
    recordKind: record.recordKind,
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    needKind,
    severity,
    state,
    reasonCode,
    channel,
    title,
    summary,
    observedAt: record.observedAt,
    mayAct: false,
  };
}

export interface NotificationPlanInputV1 {
  settings: OwnerNotificationSettingsV1;
  records: NotificationSourceRecordV1[];
  acknowledgements: NotificationAcknowledgementV1[];
  now: string;
}

/**
 * One pass over canonical records. Each record yields at most one decision, and a
 * record that appears twice in the same read yields one notification plus a
 * `duplicate_record` entry. A previously acknowledged key never notifies again.
 */
export function planOwnerNotificationsV1(input: NotificationPlanInputV1): NotificationPlanV1 {
  const { settings, records, acknowledgements, now } = input;
  const acknowledged = new Map(acknowledgements.map((entry) => [entry.key, entry]));
  const decisions: NotificationDecisionV1[] = [];
  const seen = new Set<string>();
  const quietHoursActive = settings.quietHours
    ? settings.quietHours.appliesTo.some((severity) => quietHoursActiveV1(settings.quietHours, severity, now))
    : false;

  for (const record of records) {
    const key = notificationKeyV1(record);
    const needKind = notificationNeedV1(record);
    const severity = needKind ? notificationSeverityV1(record, needKind) : "routine";
    const title = needKind ? notificationTitleV1(record, needKind) : "No notification needed";

    if (record.recordKind === "missing") {
      decisions.push(baseDecision(record, "uncertainty", "urgent", "unavailable", "missing_observation", "in_app",
        "Notification source unavailable", notificationSummaryV1(record, "uncertainty")));
      seen.add(key);
      continue;
    }

    if (seen.has(key)) {
      decisions.push(baseDecision(record, needKind ?? "uncertainty", severity, "deduplicated", "duplicate_record", "in_app",
        title, "The same saved record appeared again in this read; only one notification is produced."));
      continue;
    }
    seen.add(key);

    const prior = acknowledged.get(key);
    if (prior && (prior.deliveryState === "reserved" || prior.deliveryState === "delivery_unknown")) {
      decisions.push(baseDecision(record, needKind ?? "uncertainty", severity, "deduplicated", "delivery_attempt_unknown", "in_app",
        title, "An earlier attempt at this saved state was never confirmed. It is not sent again; the saved record stays available in the product."));
      continue;
    }
    if (prior) {
      decisions.push(baseDecision(record, needKind ?? "uncertainty", severity, "deduplicated", "restart_replay", "in_app",
        title, "This saved state was already notified. A repeated read, restart or reconnect does not notify again."));
      continue;
    }

    if (needKind === null) {
      decisions.push(baseDecision(record, "uncertainty", "routine", "suppressed", "unchanged_healthy_state", "in_app",
        "No notification needed", notificationQuietSummaryV1()));
      continue;
    }

    const scope = scopeFor(settings, record.projectId);
    if (record.projectId !== undefined && (scope === undefined || !scope.enabled)) {
      decisions.push(baseDecision(record, needKind, severity, "suppressed", "project_not_in_scope", "in_app", title,
        "This project is outside the saved notification scope. The record itself is unchanged."));
      continue;
    }
    if (scope && severityRank[severity] < severityRank[scope.severityFloor]) {
      decisions.push(baseDecision(record, needKind, severity, "suppressed", "below_project_severity_floor", "in_app", title,
        `Below the saved severity floor for ${scope.projectId}.`));
      continue;
    }
    if (quietHoursActiveV1(settings.quietHours, severity, now)) {
      decisions.push(baseDecision(record, needKind, severity, "suppressed", "quiet_hours", "in_app", title,
        "Inside the saved quiet hours for this severity. The saved record stays in the product; nothing is sent now."));
      continue;
    }

    const channel = selectChannel(settings.channels);
    if (!channel.available) {
      decisions.push(baseDecision(record, needKind, severity, "unavailable", "channel_unavailable", "in_app", title,
        `The in-product channel is unavailable${channel.unavailableReasonText ? `: ${channel.unavailableReasonText}` : ""}. Missing delivery is not a healthy state.`));
      continue;
    }

    decisions.push(baseDecision(record, needKind, severity, "notify", "new_meaningful_state", "in_app", title,
      notificationSummaryV1(record, needKind)));
  }

  const counts = { notify: 0, deduplicated: 0, suppressed: 0, unavailable: 0, } as Record<NotificationDecisionStateV1, number>;
  for (const decision of decisions) counts[decision.state] += 1;
  return {
    contractVersion: OWNER_NOTIFICATIONS_CONTRACT_V1,
    generatedAt: now,
    decisions,
    counts,
    quietHoursActive,
    deliverableKeys: decisions.filter((decision) => decision.state === "notify").map((decision) => decision.key),
  };
}

function notificationTitleV1(record: NotificationSourceRecordV1, needKind: NotificationNeedKindV1): string {
  switch (needKind) {
    case "completion": return `${record.title} recorded complete`;
    case "failure": return `${record.title} recorded a failure`;
    case "owner_decision": return `${record.title} is waiting on a decision`;
    case "uncertainty": return `${record.title} outcome is uncertain`;
  }
}

/**
 * The envelope is the only thing a sink may see. It carries description and no
 * command: the canonical response options on the underlying record are
 * deliberately dropped here.
 */
export function notificationEnvelopeFromDecisionV1(decision: NotificationDecisionV1): NotificationEnvelopeV1 {
  return {
    contractVersion: OWNER_NOTIFICATIONS_CONTRACT_V1,
    key: decision.key,
    recordId: decision.recordId,
    recordKind: decision.recordKind,
    ...(decision.projectId === undefined ? {} : { projectId: decision.projectId }),
    needKind: decision.needKind,
    severity: decision.severity,
    channel: "in_app",
    title: decision.title,
    summary: decision.summary,
    ...(decision.observedAt === undefined ? {} : { observedAt: decision.observedAt }),
    authority: "none",
    actions: [],
  };
}

/** A notification can never carry authority. Used as a real guard, not as prose. */
export function notificationEnvelopeHasNoAuthorityV1(envelope: NotificationEnvelopeV1): boolean {
  return envelope.authority === "none" && envelope.actions.length === 0
    && !("legalResponses" in envelope) && !("command" in envelope) && !("approve" in envelope);
}

const refused = (key: string, reasonCode: NotificationReasonCodeV1): NotificationDeliveryResultV1 =>
  ({ key, state: "refused", reasonCode });

/**
 * Reserve, then send, then confirm. The reservation is written before the sink is
 * called, so a crash or lost acknowledgement leaves `reserved` and the next run
 * plans `delivery_attempt_unknown` instead of sending a second notification.
 */
export async function deliverOwnerNotificationV1(input: {
  decision: NotificationDecisionV1;
  sink: NotificationSinkV1;
  ledger: NotificationDeliveryLedgerV1;
  now: string;
}): Promise<NotificationDeliveryResultV1> {
  const { decision, sink, ledger, now } = input;
  if (decision.state !== "notify") return refused(decision.key, decision.reasonCode);
  if (decision.channel !== "in_app") return refused(decision.key, "external_channel_not_permitted");
  if (sink.channel !== "in_app") return refused(decision.key, "external_channel_not_permitted");
  if (!(await ledger.reserve(decision.key, now))) return refused(decision.key, "delivery_attempt_unknown");
  const envelope = notificationEnvelopeFromDecisionV1(decision);
  if (!notificationEnvelopeHasNoAuthorityV1(envelope)) {
    await ledger.confirm(decision.key, "delivery_unknown", now);
    return refused(decision.key, "channel_unavailable");
  }
  try {
    const outcome = await sink.record(envelope);
    if (!outcome.acknowledged) {
      await ledger.confirm(decision.key, "delivery_unknown", now);
      return { key: decision.key, state: "delivery_unknown", reasonCode: "delivery_attempt_unknown" };
    }
    await ledger.confirm(decision.key, "delivered", now);
    return { key: decision.key, state: "delivered", reasonCode: "new_meaningful_state" };
  } catch {
    await ledger.confirm(decision.key, "delivery_unknown", now);
    return { key: decision.key, state: "delivery_unknown", reasonCode: "delivery_attempt_unknown" };
  }
}

/** In-memory ledger for tests and single-process callers. Durable stores implement the same port. */
export function createNotificationLedgerV1(): NotificationDeliveryLedgerV1 & { entries(): NotificationAcknowledgementV1[] } {
  const records = new Map<string, NotificationAcknowledgementV1>();
  return {
    async reserve(key, at) {
      if (records.has(key)) return false;
      records.set(key, { key, deliveryState: "reserved", observedAt: at });
      return true;
    },
    async confirm(key, outcome, at) {
      records.set(key, { key, deliveryState: outcome, observedAt: at });
    },
    entries() {
      return [...records.values()];
    },
  };
}