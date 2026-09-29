"use client";

import { useEffect, useState } from "react";
import { StateChip, type ChipTone } from "./owner-ui";

export const OPERATIONS_CONTROL_STATES = ["running", "pause_new_claims", "draining", "stopped"] as const;
export type OperationsControlState = (typeof OPERATIONS_CONTROL_STATES)[number];

export interface OperationsControlRecord {
  state: OperationsControlState;
  reason: string;
  setAt: string;
}

const STORAGE_KEY = "control-room:operations-control:v1";
const DEFAULT_RECORD: OperationsControlRecord = { state: "running", reason: "", setAt: "" };

const labels: Record<OperationsControlState, { label: string; tone: ChipTone; explanation: string }> = {
  running: { label: "Running", tone: "good", explanation: "Work proceeds as normal." },
  pause_new_claims: { label: "Pause new claims", tone: "warn", explanation: "No new work should be claimed. Work already in progress is not affected." },
  draining: { label: "Draining", tone: "warn", explanation: "No new work should be claimed, and running work should finish rather than be extended." },
  stopped: { label: "Stopped", tone: "bad", explanation: "Nothing should claim or continue work until this is set back to Running." },
};

function readStoredRecord(): OperationsControlRecord {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RECORD;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_RECORD;
    const record = parsed as Record<string, unknown>;
    if (typeof record.state !== "string" || !OPERATIONS_CONTROL_STATES.includes(record.state as OperationsControlState)) return DEFAULT_RECORD;
    return { state: record.state as OperationsControlState,
      reason: typeof record.reason === "string" ? record.reason : "",
      setAt: typeof record.setAt === "string" ? record.setAt : "" };
  } catch { return DEFAULT_RECORD; }
}

/**
 * Pause / Drain / Stop, the owner-facing control asked for in cook stream W1.
 * No pause mechanism existed anywhere in this app to wire this to (checked:
 * project-coordination-http.ts has a per-project pause/resume policy action,
 * which is a different, narrower thing — a project lead's authority inside
 * one project, not an operation-wide switch). Per the stream instructions,
 * this builds the owner-facing control and its stored state, and says
 * plainly what still has to honour it.
 *
 * The stored state is deliberately `localStorage`, not a new database table.
 * A real cross-device, owner-of-record switch needs a migration, an
 * authenticated endpoint and the real-PostgreSQL-as-production-role tests
 * this build requires for any DB change (COOK_PLAN.md) — the existing
 * migrations in this owner-authority family (e.g. 0102) carry per-tenant RLS,
 * guard triggers and HMAC auth tags, which is not a surface to improvise
 * under time pressure without the independent review cook mode requires
 * before such a change lands. `localStorage` is the honest alternative: it
 * survives a reload on this one browser, and nothing about it is claimed to
 * do more than that. See the report for the concrete migration this should
 * become next.
 */
export function useOperationsControl() {
  const [record, setRecord] = useState<OperationsControlRecord>(DEFAULT_RECORD);
  useEffect(() => { setRecord(readStoredRecord()); }, []);
  const set = (state: OperationsControlState, reason: string) => {
    const next: OperationsControlRecord = { state, reason: reason.trim().slice(0, 240), setAt: new Date().toISOString() };
    setRecord(next);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* best-effort only; the control still reflects in this session */ }
  };
  return { record, set };
}

export function OperationsControlPanel() {
  const { record, set } = useOperationsControl();
  const [reason, setReason] = useState("");
  const current = labels[record.state];
  return <section className="private-panel" aria-labelledby="operations-control-title">
    <h2 id="operations-control-title">Pause, drain or stop</h2>
    <p><StateChip state={record.state} tone={current.tone} label={current.label} /> {current.explanation}</p>
    {record.setAt && <p className="private-note">Set {new Date(record.setAt).toLocaleString()}{record.reason ? ` — ${record.reason}` : ""}.</p>}
    {/* This disclosure is deliberately NOT behind a details toggle, unlike the
        caveats elsewhere on this page: it is the one sentence that says
        whether Stop actually stops anything, and a safety disclosure is not
        the kind of caveat owner-ux-feedback-2026-09-27.md meant to move out
        of the main flow. */}
    <p className="private-notice"><strong>This is a signal only, stored in this browser.</strong> Nothing in Control Room's task claiming,
      dispatch or running work currently checks it. Setting "Stopped" here does not stop a running agent, and reloading this page on a
      different device or browser will not show this state. Treat it as a note to yourself until it is wired to real enforcement.</p>
    <label htmlFor="operations-control-reason">Reason (optional, shown with the state above)</label>
    <textarea id="operations-control-reason" rows={2} maxLength={240} value={reason} onChange={event => setReason(event.target.value)} />
    <div className="private-actions">
      {OPERATIONS_CONTROL_STATES.filter(state => state !== record.state).map(state =>
        <button key={state} type="button" onClick={() => { set(state, reason); setReason(""); }}>{labels[state].label}</button>)}
    </div>
  </section>;
}
