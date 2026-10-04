"use client";

import { useEffect, useId, useRef, useState } from "react";
import { fleetBoardSchemaV1 } from "../../../src/fleet/v1/owner-browser-client";
import { ConfiguredTimestamp } from "../configured-timestamp";

const skills = [["code.change", "Change code"], ["code.review", "Review code"], ["research", "Research"],
  ["writing", "Writing"], ["testing", "Testing"]] as const;

/** "Offer to other machines": the owner's consent for any connected machine
 * with the chosen skill, in this project, to claim this one task. Hidden when
 * the installation does not run the fleet gateway. */
export function FleetOfferControl({ projectId, jobId, state }: { projectId: string; jobId: string; state: string }) {
  const [enabled, setEnabled] = useState(false), [skill, setSkill] = useState("code.change");
  const [message, setMessage] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const id = useId();
  const [workers, setWorkers] = useState<ReturnType<typeof fleetBoardSchemaV1.shape.workers.parse>>([]);
  const [workersUnavailable, setWorkersUnavailable] = useState(false);
  const [specific, setSpecific] = useState(false), [selected, setSelected] = useState<string[]>([]);
  const command = useRef<AbortController | null>(null);
  const [uncertain, setUncertain] = useState(false), inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    inFlight.current = false; setEnabled(false);
    setWorkers([]); setSelected([]); setSpecific(false); setMessage(null); setUncertain(false); setBusy(false);
    void fetch("/api/v1/fleet", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      headers: { accept: "application/json" } })
      .then(async response => {
        if (controller.signal.aborted) return;
        setEnabled(response.ok);
        if (!response.ok) return;
        try {
          const board = await response.json() as { workers: unknown };
          const next = fleetBoardSchemaV1.shape.workers.parse(board.workers);
          if (!controller.signal.aborted) {
            setWorkers(next.filter(worker => worker.projectIds.includes(projectId) && worker.status !== "revoked"));
            setWorkersUnavailable(false);
          }
        } catch { if (!controller.signal.aborted) setWorkersUnavailable(true); }
      }).catch(() => { if (!controller.signal.aborted) setEnabled(false); });
    return () => { controller.abort(); command.current?.abort(); };
  }, [projectId, jobId]);
  // Only a bot with the chosen skill can ever claim this offer (int9 taskwire), so
  // a bot without it is not offered as a choice: picking one would save an offer
  // that no chosen machine can take, and the owner would see a silent wait.
  const eligible = workers.filter(worker => worker.capabilities.includes(skill));
  async function act(check: boolean) {
    if (inFlight.current) return;
    if (!check && specific && (selected.length === 0 || selected.length > 20)) {
      setMessage("Choose from 1 to 20 bots, or choose Any connected bot."); return;
    }
    inFlight.current = true; setBusy(true); setMessage(null);
    const controller = new AbortController(); command.current = controller;
    try {
      const response = await fetch(check ? `/api/v1/fleet/projects/${encodeURIComponent(projectId)}/offers` : "/api/v1/fleet/offers",
        { method: check ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
          ...(check ? {} : { body: JSON.stringify({ projectId, jobId, capability: skill, ...(specific ? { allowedWorkerIds: selected.filter(value => eligible.some(worker => worker.workerId === value)) } : {}) }) }) });
      if (controller.signal.aborted) return;
      if (!check && [400, 401, 403, 404, 409, 422].includes(response.status)) {
        setUncertain(false);
        // A conflict is its own plain sentence: the task is already offered, and a
        // saved offer never changes. Saying so is the only useful thing, because
        // retrying the same draft cannot apply it.
        setMessage(response.status === 409
          ? "This task is already offered, and a saved offer cannot be changed. Check the saved offer first. Your choices are still here."
          : "The offer was refused. A selected bot may no longer belong to this project, or the task may already be offered. Your choices are still here; check them and try again.");
        return;
      }
      if (!response.ok) throw new Error("offer_unconfirmed");
      if (check) {
        const offers = await response.json() as { jobId: string; state: string }[];
        if (controller.signal.aborted) return;
        if (!offers.every(value => value && typeof value.jobId === "string"
          && ["open", "closed", "blocked"].includes(value.state))) throw new Error("offer_status_unavailable");
        const offer = offers.find(value => value.jobId === jobId);
        // `blocked` is a real answer about real work, not an error: this offer
        // is still open but nothing can take it, because the task's authority
        // to be run has ended. The owner is told in one plain sentence and
        // offered the only action that helps -- withdraw it and start again.
        setMessage(offer ? offer.state === "open" ? "The saved offer is open. A connected machine can claim this task."
          : offer.state === "blocked" ? "This offer can't be taken: the task's permission to be run has ended. Withdraw the offer and create the task again to offer fresh work."
          : "The saved offer is closed. Check this task's current status before offering it again."
          : "No saved offer for this task was found. Read its current status before trying again.");
      } else setMessage(specific ? "Offered to your chosen bots. If they are offline, the task will wait until one reconnects."
        : "Offered. Any connected bot in this project with that skill can claim it.");
      setUncertain(false);
    } catch {
      if (controller.signal.aborted) return;
      setUncertain(true);
      setMessage(check ? "Saved offers could not be read. The earlier offer is still unconfirmed. Check again before offering more work."
        : "The offer could not be confirmed. It may have been saved. Check the saved offer before trying again.");
    } finally { if (command.current === controller) { command.current = null; inFlight.current = false;
      if (!controller.signal.aborted) setBusy(false); } }
  }
  if (!enabled || !["proposed", "ready"].includes(state)) return null;
  return <section className="private-panel" aria-label="Other machines"><h2>Other machines</h2>
    <p>Let a connected machine with this skill pick up this task. You still review the result.</p>
    <label>Skill needed<select value={skill} disabled={busy || uncertain} onChange={event => {
      const next = event.target.value;
      setSkill(next);
      // A chosen bot that lacks the new skill stops being chosen.
      setSelected(current => current.filter(value => workers.some(worker => worker.workerId === value
        && worker.capabilities.includes(next))));
    }}>
      {skills.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <fieldset disabled={busy || uncertain} aria-describedby={`${id}-who-note`}><legend>Who can take it</legend>
      <label className="private-offer-choice"><input type="radio" name={`${id}-who`} checked={!specific}
        onChange={() => { setSpecific(false); setMessage(null); }} />Any connected bot</label>
      <label className="private-offer-choice"><input type="radio" name={`${id}-who`} checked={specific}
        onChange={() => { setSpecific(true); setMessage(null); }} />Choose bots</label>
      <p id={`${id}-who-note`}>Only bots in this project are shown. Offline bots can be chosen. If none of your chosen bots are online, the task will wait until one reconnects.</p>
      {specific && (workersUnavailable ? <p role="alert">The bot list could not be read. Refresh to try again; your choices stay here.</p>
        : workers.length === 0 ? <p>No bots are connected to this project yet.</p>
          : eligible.length === 0 ? <p>No bot in this project has this skill yet.</p>
          : eligible.map(worker => <label className="private-offer-choice" key={worker.workerId}>
            <input type="checkbox" checked={selected.includes(worker.workerId)} onChange={event => {
              setSelected(current => event.target.checked ? [...current, worker.workerId] : current.filter(value => value !== worker.workerId));
              setMessage(null);
            }} /><span>{worker.displayName} · {worker.status === "connected" || worker.status === "working" ? "Connected"
              : worker.status === "needs_new_key" ? "Offline · Needs a new key" : "Offline"}<br />
              {worker.lastSeenAt ? <ConfiguredTimestamp value={worker.lastSeenAt} prefix="Last seen" /> : "Last seen: never"}</span>
          </label>))}
    </fieldset>
    <div className="private-actions"><button type="button" disabled={busy || uncertain} onClick={() => { void act(false); }}>Offer to other machines</button>
      {uncertain && <button type="button" disabled={busy} onClick={() => { void act(true); }}>Check saved offer</button>}</div>
    {message && <p role="status">{message}</p>}
  </section>;
}
