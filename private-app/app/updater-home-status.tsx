"use client";

import { useCallback, useRef, useState } from "react";
import { beginUpdaterPasskeyV1, readUpdaterOwnerUiV1, sendUpdaterOwnerRequestV1,
  type UpdaterOwnerUiBrowserReadV1 } from "../../src/web/v1/updater-owner-ui-browser";
import type { UpdaterOwnerControlV1, UpdaterOwnerUiReadV1 } from "../../src/web/v1/updater-owner-ui-wire";
import { readUpdaterHomeStatusV1 } from "../../src/web/v1/updater-home-status-browser";
import { PanelHeading, StateChip } from "./owner-ui";
import { useVisiblePolling } from "./use-visible-polling";

const stateWords: Record<UpdaterOwnerUiReadV1["state"], string> = {
  idle: "Waiting for the next check", watching: "Watching for a safe update", building: "Checking an update",
  ready_for_approval: "Ready for your approval", approval_required: "Approval expired — approve again",
  approved: "Approved — preparing safely", prechecked: "Safety checks passed", staged: "Prepared to install",
  quick_backup: "Making a backup", draining: "Finishing current work", quiesced: "Work is paused for the database",
  backup_verified: "Backup checked", preimage_taken: "Database safety copy made", migrating: "Changing the database",
  migrated: "Database change complete", switched: "Switching versions", restarted: "Restarting Control Room",
  healthy: "Checking that it is healthy", succeeded: "Update installed", rollback_started: "Putting the previous version back",
  restore_started: "Restoring the database", db_restored: "Database restored", code_restored: "Previous version restored",
  rolled_back: "Not installed — previous version is back", refused_build: "Update was refused before installation",
  superseded: "A newer update replaced this one", uncertain: "Update status is uncertain — check before continuing",
  attended_upgrade_required: "Needs an attended Mac upgrade", paused: "Updates are paused", stopped: "Updates are stopped",
  needs_attention: "Update needs your attention",
};

const label: Record<UpdaterOwnerControlV1, string> = {
  pause: "Pause", resume: "Resume", backup_now: "Back up now", check_now: "Check now", repair: "Repair address", rollback: "Roll back",
};

function newKey(action: string) { return `updater-owner:${action}:${crypto.randomUUID()}`; }

function Facts({ value }: { value: UpdaterOwnerUiReadV1 }) {
  const plan = value.plan;
  if (!plan) return <p className="private-updater-facts">{value.message}</p>;
  return <>
    <p className="private-updater-facts"><strong>{value.message}</strong></p>
    <ul className="private-updater-fact-list" aria-label="Facts from the updater">
      <li>{plan.filesChanged} files changed ({plan.filesAdded} added, {plan.filesDeleted} removed).</li>
      <li>{plan.changesDatabase ? "This update changes the database." : "This update does not change the database."}</li>
      <li>{plan.changesUpdater ? "This update changes the updater itself." : "This update does not change the updater."}</li>
      <li>Estimated interruption: {plan.downtimeEstimateSeconds === 0 ? "none" : `up to ${plan.downtimeEstimateSeconds} seconds`}.</li>
    </ul>
    {plan.restoreMayLoseRecentWrites ? <p className="private-updater-warning" role="alert"><strong>Database change:</strong> if Control Room has to restore this update, work saved during the final health check may be lost.</p> : null}
    {plan.botSays ? <details className="private-updater-bot-says"><summary>What the bot says</summary>
      <p>{plan.botSays.title}</p>{plan.botSays.changedAreas.length ? <ul>{plan.botSays.changedAreas.map((area, index) => <li key={index}>{area}</li>)}</ul> : null}
    </details> : null}
  </>;
}

function Controls({ value, onChanged }: { value: UpdaterOwnerUiReadV1; onChanged: () => void }) {
  const [pending, setPending] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const retained = useRef(new Map<string, string>());
  const available = new Set(value.availableControls);
  const request = async (action: UpdaterOwnerControlV1) => {
    if (pending) return;
    const key = retained.current.get(action) ?? newKey(action); retained.current.set(action, key);
    setPending(action); setProblem(undefined);
    try {
      if (action === "rollback") await beginUpdaterPasskeyV1("rollback", value.plan?.planId ?? null, key);
      else await sendUpdaterOwnerRequestV1(action, value.plan?.planId ?? null, key);
      retained.current.delete(action); onChanged();
    } catch { setProblem(action === "rollback" ? "Face ID approval could not be confirmed. Try the same request again." : "Control Room could not confirm this request. Try the same request again."); }
    finally { setPending(undefined); }
  };
  const approve = async () => {
    if (!value.plan || pending) return;
    const action = "approve", key = retained.current.get(action) ?? newKey(action); retained.current.set(action, key);
    setPending(action); setProblem(undefined);
    try { await beginUpdaterPasskeyV1(action, value.plan.planId, key); retained.current.delete(action); onChanged(); }
    catch { setProblem("Face ID approval could not be confirmed. Try the same approval again."); }
    finally { setPending(undefined); }
  };
  return <div className="private-updater-controls">
    {value.plan && value.state === "ready_for_approval" ? <><button type="button" disabled={!!pending}
      onClick={() => { void approve(); }}>Confirm with Face ID</button>
      {value.plan.macConfirmationRequired ? <p className="private-updater-mac-code"><strong>On your Mac:</strong> type the 4-word code Control Room shows after its confirmation prompt.</p> : null}</> : null}
    <div className="private-actions" aria-label="Update controls">{(Object.keys(label) as UpdaterOwnerControlV1[]).map(action => <button
      key={action} type="button" disabled={!available.has(action) || !!pending} onClick={() => { void request(action); }}>
      {pending === action ? "Requesting…" : action === "rollback" ? "Roll back with Face ID" : label[action]}</button>)}</div>
    {problem ? <p role="alert">{problem}</p> : null}
  </div>;
}

export function UpdaterHomeStatus() {
  const [read, setRead] = useState<UpdaterOwnerUiBrowserReadV1>({ state: "not_configured" });
  const [legacyState, setLegacyState] = useState<"off" | "attention">("attention");
  const load = useCallback(async (signal: AbortSignal) => {
    const next = await readUpdaterOwnerUiV1(fetch, signal);
    if (next.state === "not_configured") setLegacyState((await readUpdaterHomeStatusV1(fetch, signal)).state);
    if (!signal.aborted) setRead(next);
  }, []);
  const refresh = useVisiblePolling(load);
  if (read.state === "not_configured") return legacyState === "off"
    ? <p className="private-updater-status">Self-update: Off — fixes are installed by you on this Mac.</p>
    : <p className="private-updater-status private-updater-attention" role="alert"><strong>Self-update needs your attention.</strong> The updater is not answering clearly.</p>;
  if (read.state === "unavailable") return <p className="private-updater-status private-updater-attention" role="alert"><strong>Update status needs your attention.</strong> Control Room could not read the updater.</p>;
  const value = read.value, isAttention = ["uncertain", "attended_upgrade_required", "needs_attention"].includes(value.state);
  return <section className={`private-panel private-updater-card ${isAttention ? "private-attention-box has-items" : ""}`} aria-labelledby="updater-install-title">
    <PanelHeading id="updater-install-title">Install</PanelHeading>
    <StateChip state={value.state} tone={isAttention ? "bad" : value.state === "ready_for_approval" ? "warn" : "neutral"} label={stateWords[value.state]} />
    {value.activeSubscriptions === 0 ? <p className="private-updater-warning" role="alert"><strong>Phone alerts are off.</strong> No phone is subscribed, so update alerts cannot reach you.</p> : null}
    <Facts value={value} /><Controls value={value} onChanged={refresh} />
  </section>;
}
