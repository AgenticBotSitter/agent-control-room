"use client";

import { ownerStatusLabels } from "./owner-status-labels";
import { useCallback, useRef, useState } from "react";
import nextActionsV1 from "../../src/updater/v1/policy/next-actions.json";
import { acknowledgeUpdaterAttentionV1, beginUpdaterPasskeyV1, readUpdaterOwnerUiV1,
  sendUpdaterOwnerRequestV1, type UpdaterOwnerUiBrowserReadV1 } from "../../src/web/v1/updater-owner-ui-browser";
import type { UpdaterOwnerControlV1, UpdaterOwnerUiReadV1 } from "../../src/web/v1/updater-owner-ui-wire";
import { readUpdaterHomeStatusV1, type UpdaterHomeStatusV1 } from "../../src/web/v1/updater-home-status-browser";
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
    {plan.classes.includes("protected") ? <p className="private-updater-warning" role="alert"><strong>Safety-sensitive change:</strong> This update changes Control Room&apos;s safety checks and requires independent review.</p> : null}
    {plan.classes.includes("dependency") ? <p className="private-updater-warning"><strong>Installed software change:</strong> This update changes software dependencies.</p> : null}
    {plan.restoreMayLoseRecentWrites ? <p className="private-updater-warning" role="alert"><strong>Database change:</strong> if Control Room has to restore this update, work saved during the final health check may be lost.</p> : null}
    {plan.botSays ? <details className="private-updater-bot-says"><summary>What the bot says</summary>
      <p>{plan.botSays.title}</p>{plan.botSays.changedAreas.length ? <ul>{plan.botSays.changedAreas.map((area, index) => <li key={index}>{area}</li>)}</ul> : null}
    </details> : null}
  </>;
}

/** R7U-01 (lead decision 3): the owner's answer, as ONE obvious action.
 *
 * It sits next to the words that name the failure rather than inside `Controls`,
 * because it is answering a CARD and not asking the updater to do anything to the
 * installation — no Face ID, no idempotency key, and nothing disabled behind an
 * `availableControls` list. The whole point of R7U-01 was that a published failure
 * had no way out except a newer successful update; a button that only appeared
 * when the owner UI said so would have reproduced that.
 *
 * It shows ONLY on a card that is actually outstanding, and it disappears the
 * moment the row is answered. A press that fails says so in plain words and
 * leaves the card alone — the alternative is a card that claims to be settled when
 * the database still holds the row.
 */
function AcknowledgeButton({ onChanged }: { onChanged: () => void }) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  return <div className="private-updater-controls">
    <button type="button" disabled={pending} onClick={() => {
      if (pending) return;
      setPending(true); setProblem(undefined);
      void acknowledgeUpdaterAttentionV1().then(() => { setPending(false); onChanged(); },
        () => { setPending(false);
          setProblem("Control Room could not confirm that. The update still needs you."); });
    }}>{pending ? "Saving…" : "I have seen this"}</button>
    {problem ? <p role="alert">{problem}</p> : null}
  </div>;
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
      {value.plan.macConfirmationRequired ? <p className="private-updater-mac-code"><strong>On your Mac:</strong> type the code of words Control Room shows on your Mac after its confirmation prompt.</p> : null}</> : null}
    <div className="private-actions" aria-label="Update controls">{(Object.keys(label) as UpdaterOwnerControlV1[]).map(action => <button
      key={action} type="button" disabled={!available.has(action) || !!pending} onClick={() => { void request(action); }}>
      {pending === action ? "Requesting…" : action === "rollback" ? "Roll back with Face ID" : label[action]}</button>)}</div>
    {problem ? <p role="alert">{problem}</p> : null}
  </div>;
}

export function UpdaterHomeStatus() {
  const [read, setRead] = useState<UpdaterOwnerUiBrowserReadV1>({ state: "not_configured" });
  const [legacyState, setLegacyState] = useState<UpdaterHomeStatusV1["state"]>("attention");
  const [nextAction, setNextAction] = useState<UpdaterHomeStatusV1["nextAction"]>();
  const [reason, setReason] = useState<string>();
  const load = useCallback(async (signal: AbortSignal) => {
    const [next, status] = await Promise.all([readUpdaterOwnerUiV1(fetch, signal), readUpdaterHomeStatusV1(fetch, signal)]);
    if (!signal.aborted) { setLegacyState(status.state); setNextAction(status.nextAction); setReason(status.reason); setRead(next); }
  }, []);
  const refresh = useVisiblePolling(load);
  // R7U-01: the REASON leads and the key's words follow it.
  //
  // The reason names what actually happened to THIS upgrade ("recovery could not
  // put the previous version back"), and the key's sentence is the generic
  // instruction for that class of outcome. Putting the generic one first would
  // read as though the card were about any failed update, which is the thing the
  // merge of the two branches made nearly happen: one field had come to mean both
  // "which reviewed action is this" and "what happened", and the card could only
  // show one of them.
  //
  // A missing reason falls back to the key's words rather than to nothing, so a
  // status file written before this field existed still shows the instruction.
  const instruction = (reason ?? (nextAction ? nextActionsV1[nextAction] : undefined)) ?? null;
  if (read.state === "not_configured" && nextAction === "rescue_resolved")
    return <p className="private-updater-status" role="status">{nextActionsV1[nextAction]}</p>;
  if (read.state === "not_configured" && !["off", "attention", "needs_owner"].includes(legacyState)) {
    const words = {
      healthy: "Self-update: Healthy — no update is running.",
      in_progress: "Self-update: In progress — Control Room is preparing or installing an update.",
      failed_before_switch: "Update failed before switching — your running version was kept.",
      rolled_back: "Previous version restored — the update did not finish successfully.",
    };
    return <p className="private-updater-status">{words[legacyState as keyof typeof words]} {instruction}</p>;
  }
  if (read.state === "not_configured" && legacyState === "needs_owner")
    return <div className="private-updater-attention" role="alert"><p className="private-updater-status"><strong>Self-update needs your attention.</strong> {instruction ?? "Check the update on this Mac before continuing."}</p>
      {/* Same gate as the configured path: `reason` means there is a durable row
          to answer. A `needs_owner` card with no reason is a damaged switch or a
          rescue, and neither is answered by this button. */}
      {reason ? <AcknowledgeButton onChanged={refresh} /> : null}</div>;
  if (read.state === "not_configured") return legacyState === "off"
    ? <p className="private-updater-status">{ownerStatusLabels.updater.off} — fixes are installed by you on this Mac. {instruction}</p>
    : <p className="private-updater-status private-updater-attention" role="alert"><strong>Self-update needs your attention.</strong> {instruction ?? "The updater is not answering clearly."}</p>;
  if (read.state === "unavailable") return <p className="private-updater-status private-updater-attention" role="alert"><strong>Update status needs your attention.</strong> Control Room could not read the updater.</p>;
  const value = read.value, isAttention = ["uncertain", "attended_upgrade_required", "needs_attention", "rolled_back"].includes(value.state);
  const isProtectedPlan = value.plan?.classes.some(name => ["updater", "protected", "dependency"].includes(name)) ?? false;
  const isRedCard = isAttention || isProtectedPlan || !!nextAction && nextAction !== "rescue_resolved";
  return <section className={`private-panel private-updater-card ${isRedCard ? "private-attention-box has-items" : ""}`} aria-labelledby="updater-install-title">
    <PanelHeading id="updater-install-title">Install</PanelHeading>
    {instruction ? <p className="private-updater-facts" role={nextAction === "rescue_resolved" ? "status" : "alert"}>{instruction}</p> : null}
    {/* R7U-01: the answer, on the card itself and only while the row is
        outstanding.

        GATED ON `reason`, NOT ON `nextAction`, and that is the whole reason this
        button is not on the rescue cards. `nextAction` is also written for
        `review_rescue_on_mac` and for `rescue_resolved`, neither of which is a
        durable run outcome — for those, "I have seen this" has nothing to
        acknowledge and would report "nothing outstanding" every time it was
        pressed. `reason` is written by the loop on exactly one condition: the
        database holds an unacknowledged row. So the button's presence IS the
        answer to "is there something to answer", read off the same bytes as
        everything else on the card rather than re-derived here. */}
    {reason ? <AcknowledgeButton onChanged={refresh} /> : null}
    <StateChip state={value.state} tone={isRedCard ? "bad" : value.state === "ready_for_approval" ? "warn" : "neutral"} label={stateWords[value.state]} />
    {value.activeSubscriptions === 0 ? <p className="private-updater-warning" role="alert"><strong>Phone alerts are off.</strong> No phone is subscribed, so update alerts cannot reach you.</p> : null}
    <Facts value={value} /><Controls value={value} onChanged={refresh} />
  </section>;
}
