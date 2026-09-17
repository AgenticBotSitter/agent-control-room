/**
 * Owner-visible wording for every notification outcome. These strings are the
 * text alternative for the settings surface: no decision depends on colour,
 * icon or pointer interaction to be understood.
 */
import type {
  NotificationDecisionV1,
  NotificationNeedKindV1,
  NotificationReasonCodeV1,
  NotificationSeverityV1,
  NotificationSourceRecordV1,
  OwnerNotificationSettingsV1,
} from "./types";

export const notificationNeedKindText: Record<NotificationNeedKindV1, string> = {
  completion: "Work recorded complete",
  failure: "Recorded failure",
  uncertainty: "Outcome uncertain",
  owner_decision: "A decision is waiting",
};

export const notificationSeverityText: Record<NotificationSeverityV1, string> = {
  routine: "Routine",
  notable: "Notable",
  urgent: "Urgent",
};

export const notificationReasonText: Record<NotificationReasonCodeV1, string> = {
  new_meaningful_state: "New state worth telling the owner about",
  unchanged_healthy_state: "Unchanged healthy or idle state — no notification",
  duplicate_record: "The same record appeared more than once in this read",
  restart_replay: "Already notified for this saved state; a repeated read does not notify again",
  delivery_attempt_unknown: "An earlier delivery attempt was never confirmed; it is not repeated",
  quiet_hours: "Suppressed by the saved quiet hours for this severity",
  project_not_in_scope: "This project is outside the saved notification scope",
  below_project_severity_floor: "Below the severity floor saved for this project",
  channel_unavailable: "The saved channel is unavailable",
  external_channel_not_permitted: "External channels are declared only; nothing is sent outside the product",
  missing_observation: "The canonical record could not be read; missing data is not healthy state",
};

const quietHoursNote = "Quiet hours delay nothing; suppressed items stay in the product for the next look.";

function sentence(value: string) {
  return value.endsWith(".") ? value : `${value}.`;
}

/**
 * Descriptive text only. Reads are allowed; the wording never asks the owner to
 * approve, retry, cancel or dispatch anything from the notification itself.
 */
export function notificationSummaryV1(record: NotificationSourceRecordV1, needKind: NotificationNeedKindV1): string {
  if (record.recordKind === "missing") {
    return sentence(`The saved ${record.sourceLabel} could not be read, so this state is unavailable rather than healthy`);
  }
  if (record.recordKind === "attention") {
    const action = record.item.requestedAction;
    switch (needKind) {
      case "owner_decision":
        return sentence(`An item is waiting on a decision: ${action}. Opening the item in the product is the only step this notice offers`);
      case "failure":
        return sentence(`An item records a failure: ${action}. Nothing is retried or replaced automatically`);
      case "uncertainty":
        return sentence(`The recorded state is ambiguous: ${action}. Reading the saved status is the only safe next step`);
      default:
        return sentence(`An item recorded ${action}`);
    }
  }
  if (record.recordKind === "service_incident") {
    const incident = record.incident;
    return sentence(`Service ${incident.serviceId} recorded ${incident.severity} at ${incident.reasonCode}; the remedy code ${incident.remedyCode} is guidance, not a repair request`);
  }
  switch (needKind) {
    case "completion":
      return sentence(`The job record for ${record.jobId} says the work finished. A returned result still needs review before it is accepted`);
    case "failure":
      return sentence(`The job record for ${record.jobId} says the run failed. Control Room does not create replacement work automatically`);
    default:
      return sentence(`The job record for ${record.jobId} says the assignment state is ${record.state}, which is not a healthy result`);
  }
}

/** The status quo is quiet: healthy states produce no notification text at all. */
export function notificationQuietSummaryV1(): string {
  return `Work in progress, prepared, assigned, cancelled and rejected records stay quiet: nothing changed that needs the owner. ${quietHoursNote}`;
}

/** Settings as one readable paragraph — the text alternative for the whole form. */
export function notificationSettingsTextV1(settings: OwnerNotificationSettingsV1): string {
  const scope = settings.projectScopes.length
    ? settings.projectScopes
        .map((entry) => `${entry.projectId} (${entry.enabled ? "in scope" : "excluded"}, at least ${notificationSeverityText[entry.severityFloor].toLowerCase()})`)
        .join("; ")
    : "no project is in scope, so no notification is produced";
  const channels = settings.channels
    .map((entry) => `${entry.channel} ${entry.available ? "available" : `unavailable (${entry.unavailableReasonText ?? entry.unavailableReasonCode ?? "no reason recorded"})`}`)
    .join("; ");
  const quiet = settings.quietHours
    ? `${settings.quietHours.startLocalTime}–${settings.quietHours.endLocalTime} in ${settings.quietHours.timezone}, suppressing ${
        settings.quietHours.appliesTo.map((severity) => notificationSeverityText[severity].toLowerCase()).join(", ") || "no severity"
      }`
    : "no quiet hours saved";
  return `Notification scope: ${scope}. Quiet hours: ${quiet}. Channels: ${channels}. External channels are declared only and never carry a message.`;
}

/** One line per decision: state, need, severity, reason — never colour alone. */
export function notificationDecisionTextV1(decision: NotificationDecisionV1): string {
  return `${decision.title} — ${notificationSeverityText[decision.severity]}; ${notificationReasonText[decision.reasonCode]}.`;
}