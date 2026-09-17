import type {
  NotificationChannelAvailabilityV1,
  NotificationDecisionV1,
  NotificationSeverityV1,
  OwnerNotificationSettingsV1,
} from "../../src/notifications/v1/types";
import {
  notificationDecisionTextV1,
  notificationReasonText,
  notificationSeverityText,
  notificationSettingsTextV1,
} from "../../src/notifications/v1/presentation";

const severityOptions: NotificationSeverityV1[] = ["routine", "notable", "urgent"];

function channelReasonText(channel: NotificationChannelAvailabilityV1) {
  if (channel.available) return channel.channel === "in_app" ? "Available in the product." : "Declared only.";
  return channel.unavailableReasonText ?? channel.unavailableReasonCode ?? "No reason recorded.";
}

/**
 * Every value on this surface has a labelled text form: the time pickers have
 * text fields beside them, the severity floor is a radio group with words, the
 * project scope is checkboxes, and the policy summary repeats every saved value
 * in a sentence. Nothing here is drag-only, colour-only or pointer-only.
 * The surface reads and saves policy; it never sends a message and never acts on
 * the records it describes.
 */
export function NotificationSettingsSurface({ settings, decisions, pending = false, onChange, onSave }: {
  settings: OwnerNotificationSettingsV1;
  decisions: NotificationDecisionV1[];
  pending?: boolean;
  onChange?: (next: OwnerNotificationSettingsV1) => void;
  onSave?: (settings: OwnerNotificationSettingsV1) => void;
}) {
  const editable = onChange !== undefined && !pending;
  const quietHours = settings.quietHours;
  const update = (patch: Partial<OwnerNotificationSettingsV1>) => onChange?.({ ...settings, ...patch });
  const updateQuietHours = (patch: Partial<NonNullable<OwnerNotificationSettingsV1["quietHours"]>>) =>
    update({ quietHours: { timezone: quietHours?.timezone ?? "UTC", startLocalTime: quietHours?.startLocalTime ?? "22:00",
      endLocalTime: quietHours?.endLocalTime ?? "07:00", appliesTo: quietHours?.appliesTo ?? ["routine", "notable"], ...patch } });
  return <section className="private-panel" aria-labelledby="owner-notifications-heading">
    <h2 id="owner-notifications-heading">Owner notifications</h2>
    <p className="private-note">A notification describes a saved completion, failure, uncertainty or waiting decision.
      It cannot approve, retry, cancel or start anything. Email, push and SMS are declared here only — no message leaves the product.</p>
    <p id="owner-notification-policy-summary" data-field="policy-summary">{notificationSettingsTextV1(settings)}</p>
    <p className="private-note" data-field="keyboard-alternatives">Every setting below is a labelled form control you can reach with the
      keyboard and complete with text: the clock fields have a keyboard-editable picker and an adjacent HH:MM text field, severity is
      chosen from words, and project scope is a checkbox list. The summary paragraph above repeats each saved value in words.</p>

    <fieldset disabled={!editable}>
      <legend>Quiet hours</legend>
      <label htmlFor="quiet-hours-enabled"><input id="quiet-hours-enabled" type="checkbox" checked={quietHours !== null}
        onChange={event => update({ quietHours: event.target.checked ? quietHours ?? { timezone: "UTC", startLocalTime: "22:00",
          endLocalTime: "07:00", appliesTo: ["routine", "notable"] } : null })} />Suppress the selected severities during quiet hours</label>
      <label htmlFor="quiet-hours-start">Quiet hours start (picker; keyboard editable)</label>
      <input id="quiet-hours-start" type="time" value={quietHours?.startLocalTime ?? "22:00"} aria-describedby="quiet-hours-format"
        onChange={event => updateQuietHours({ startLocalTime: event.target.value })} />
      <label htmlFor="quiet-hours-start-text">Quiet hours start as text (HH:MM)</label>
      <input id="quiet-hours-start-text" type="text" inputMode="numeric" pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
        value={quietHours?.startLocalTime ?? "22:00"} aria-describedby="quiet-hours-format"
        onChange={event => updateQuietHours({ startLocalTime: event.target.value })} />
      <label htmlFor="quiet-hours-end">Quiet hours end (picker; keyboard editable)</label>
      <input id="quiet-hours-end" type="time" value={quietHours?.endLocalTime ?? "07:00"} aria-describedby="quiet-hours-format"
        onChange={event => updateQuietHours({ endLocalTime: event.target.value })} />
      <label htmlFor="quiet-hours-end-text">Quiet hours end as text (HH:MM)</label>
      <input id="quiet-hours-end-text" type="text" inputMode="numeric" pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
        value={quietHours?.endLocalTime ?? "07:00"} aria-describedby="quiet-hours-format"
        onChange={event => updateQuietHours({ endLocalTime: event.target.value })} />
      <label htmlFor="quiet-hours-timezone">Quiet hours timezone (IANA name, typed as text)</label>
      <input id="quiet-hours-timezone" type="text" value={quietHours?.timezone ?? "UTC"}
        onChange={event => updateQuietHours({ timezone: event.target.value })} />
      <p id="quiet-hours-format" className="private-note">Text fields accept 24-hour HH:MM. A window whose end is earlier than its
        start crosses midnight. Quiet hours never delete or hide a saved record.</p>
      <fieldset><legend>Severities suppressed during quiet hours</legend>
        {severityOptions.map(severity => <label key={severity} htmlFor={`quiet-hours-severity-${severity}`}>
          <input id={`quiet-hours-severity-${severity}`} type="checkbox" checked={quietHours?.appliesTo.includes(severity) ?? false}
            onChange={event => updateQuietHours({ appliesTo: event.target.checked
              ? [...(quietHours?.appliesTo ?? []).filter(value => value !== severity), severity]
              : (quietHours?.appliesTo ?? []).filter(value => value !== severity) })} />{notificationSeverityText[severity]}</label>)}
      </fieldset>
    </fieldset>

    <fieldset disabled={!editable}>
      <legend>Project scope and severity floor</legend>
      {!settings.projectScopes.length ? <p>A project with no saved scope produces no notification.</p> : null}
      {settings.projectScopes.map(scope => <article key={scope.projectId}>
        <h3>{scope.projectId}</h3>
        <label htmlFor={`project-${scope.projectId}-enabled`}><input id={`project-${scope.projectId}-enabled`} type="checkbox"
          checked={scope.enabled} onChange={event => update({ projectScopes: settings.projectScopes.map(entry => entry.projectId === scope.projectId
            ? { ...entry, enabled: event.target.checked } : entry) })} />Include this project</label>
        <fieldset><legend>Notify for {scope.projectId} at or above</legend>
          {severityOptions.map(severity => <label key={severity} htmlFor={`project-${scope.projectId}-floor-${severity}`}>
            <input id={`project-${scope.projectId}-floor-${severity}`} type="radio" name={`project-${scope.projectId}-floor`}
              checked={scope.severityFloor === severity} onChange={() => update({ projectScopes: settings.projectScopes.map(entry =>
                entry.projectId === scope.projectId ? { ...entry, severityFloor: severity } : entry) })} />{notificationSeverityText[severity]} and above</label>)}
        </fieldset>
      </article>)}
    </fieldset>

    <fieldset disabled={!editable}>
      <legend>Channel availability</legend>
      {settings.channels.map(channel => <div key={channel.channel}>
        <label htmlFor={`channel-${channel.channel}`}><input id={`channel-${channel.channel}`} type="checkbox"
          checked={channel.available} disabled={channel.channel !== "in_app"}
          aria-describedby={`channel-${channel.channel}-reason`}
          onChange={event => update({ channels: settings.channels.map(entry => entry.channel === channel.channel
            ? { ...entry, available: event.target.checked } : entry) })} />{channel.channel === "in_app" ? "In-product notifications" : `${channel.channel} (declared, not sent)`}</label>
        <p id={`channel-${channel.channel}-reason`} className="private-note" data-field={`channel-${channel.channel}-reason`}>
          {channelReasonText(channel)}</p>
      </div>)}
    </fieldset>

    <div className="private-actions">
      {onSave
        ? <button type="button" disabled={!editable} onClick={() => onSave(settings)}>{pending ? "Saving policy…" : "Save notification policy"}</button>
        : null}
      <p role="status" aria-live="polite" className="private-note">{onSave
        ? pending ? "Saving the saved policy. Nothing is sent while saving." : "Saving records policy only; it does not enable external messages."
        : "Read-only: this surface is not yet mounted on the settings page, so no owner policy endpoint is being called."}</p>
    </div>

    <NotificationDecisionList decisions={decisions} />
  </section>;
}

/**
 * Text-only view of what the saved policy would do. Colours carry no meaning
 * here: each row names the record, need, severity, outcome and reason.
 */
export function NotificationDecisionList({ decisions }: { decisions: NotificationDecisionV1[] }) {
  return <table>
    <caption>Saved records considered under this policy</caption>
    <thead><tr><th scope="col">Record</th><th scope="col">Need</th><th scope="col">Severity</th>
      <th scope="col">Outcome</th><th scope="col">Reason</th></tr></thead>
    <tbody>
      {!decisions.length ? <tr><td colSpan={5}>No saved record is in the notification scope right now.</td></tr> : null}
      {decisions.map(decision => <tr key={decision.key}>
        <td>{decision.title}</td>
        <td>{decision.needKind}</td>
        <td>{notificationSeverityText[decision.severity]}</td>
        <td>{decision.state}</td>
        <td>{notificationReasonText[decision.reasonCode]}</td>
      </tr>)}
    </tbody>
    <tfoot><tr><td colSpan={5}>A row marked <code>notify</code> describes a message the product would show in-app.
      No row approves, retries, cancels or dispatches anything. {decisions.length
        ? notificationDecisionTextV1(decisions[0]) : "Nothing is pending."}</td></tr></tfoot>
  </table>;
}