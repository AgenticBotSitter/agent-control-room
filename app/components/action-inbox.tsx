import type { JSX } from "react";
import type { ActionInboxItemV1 } from "@/src/operator-surfaces/v1";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function expiry(item: ActionInboxItemV1): string {
  if (!item.expiresAt) return "No expiry recorded";
  return item.state === "expired" ? `Expired ${item.expiresAt}` : `Expires ${item.expiresAt}`;
}

function responseStatus(response: ActionInboxItemV1["legalResponses"][number]): string {
  const confirmation = response.requiresConfirmation ? "Confirmation required" : "No confirmation required";
  return response.available ? confirmation : `Unavailable: ${label(response.unavailableReasonCode ?? "not_available")}. ${confirmation}`;
}

/** Presents declared response options only; it never submits, approves, or performs an operation. */
export function ActionInbox(props: { items: readonly ActionInboxItemV1[]; title?: string }): JSX.Element {
  const { items, title = "Action Inbox" } = props;
  return (
    <section aria-label={title}>
      <header>
        <h2>{title}</h2>
        <p>Items remain visible until their recorded state changes. Response choices are not actions.</p>
      </header>
      {items.length === 0 ? <p>No action items match this view.</p> : (
        <ol>
          {items.map((item) => (
            <li key={item.id}>
              <article>
                <p>{label(item.kind)} · {label(item.state)} · Delivery: {label(item.deliveryState)}</p>
                <h3>{item.requestedAction}</h3>
                <dl>
                  <dt>Reason</dt><dd>{label(item.reasonCode)}</dd>
                  <dt>Blocked work</dt><dd>{item.blockedWorkItemIds.length ? item.blockedWorkItemIds.join(", ") : "None declared"}</dd>
                  <dt>Evidence</dt><dd>{item.evidence.length} reference{item.evidence.length === 1 ? "" : "s"}</dd>
                  <dt>Timing</dt><dd>Created {item.createdAt}. {expiry(item)}</dd>
                </dl>
                <h4>Legal responses</h4>
                <ul>
                  {item.legalResponses.map((response) => (
                    <li key={response.id}>
                      <button type="button" disabled={!response.available}>{response.label}</button>
                      <span>{responseStatus(response)}</span>
                    </li>
                  ))}
                </ul>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
