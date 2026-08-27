"use client";

import type { JSX } from "react";
import { useMemo, useState } from "react";
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

/** Presents declared response options as read-only facts; it never submits, approves, or performs an operation. */
export function ActionInbox(props: { items: readonly ActionInboxItemV1[]; title?: string }): JSX.Element {
  const { items, title = "Action Inbox" } = props;
  const [kind, setKind] = useState<"all" | ActionInboxItemV1["kind"]>("all");
  const [state, setState] = useState<"all" | ActionInboxItemV1["state"]>("all");
  const filtered = useMemo(() => items.filter((item) => (kind === "all" || item.kind === kind) && (state === "all" || item.state === state)), [items, kind, state]);
  const kinds = [...new Set(items.map((item) => item.kind))].sort();
  const states = [...new Set(items.map((item) => item.state))].sort();
  return (
    <section className="action-inbox" aria-label={title}>
      <header>
        <h2>{title}</h2>
        <p>Items remain visible until their recorded state changes. Response choices are not actions.</p>
      </header>
      <fieldset className="action-inbox-filters">
        <legend>Filter displayed items</legend>
        <label>Kind <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="all">All kinds</option>{kinds.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
        <label>State <select value={state} onChange={(event) => setState(event.target.value as typeof state)}><option value="all">All states</option>{states.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
        <output aria-live="polite">{filtered.length} item{filtered.length === 1 ? "" : "s"} shown</output>
      </fieldset>
      {filtered.length === 0 ? <p className="empty-state">No action items match this view.</p> : (
        <ol className="action-inbox-list">
          {filtered.map((item) => (
            <li key={item.id}>
              <article className="action-inbox-item">
                <p className="action-inbox-meta">{label(item.kind)} · {label(item.state)} · Delivery: {label(item.deliveryState)}</p>
                <h3>{item.requestedAction}</h3>
                <dl>
                  <dt>Reason</dt><dd>{label(item.reasonCode)}</dd>
                  <dt>Blocked work</dt><dd>{item.blockedWorkItemIds.length ? item.blockedWorkItemIds.join(", ") : "None declared"}</dd>
                  <dt>Evidence</dt><dd>{item.evidence.length} reference{item.evidence.length === 1 ? "" : "s"}</dd>
                  <dt>Timing</dt><dd>Created {item.createdAt}. {expiry(item)}</dd>
                </dl>
                <h4>Legal responses</h4>
                <ul className="action-inbox-responses">
                  {item.legalResponses.map((response) => (
                    <li key={response.id}>
                      <span className={`action-inbox-response ${response.available ? "available" : "unavailable"}`}>{response.label}</span>
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
