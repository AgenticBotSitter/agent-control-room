"use client";

import { useEffect, useState } from "react";

const skills = [["code.change", "Change code"], ["code.review", "Review code"], ["research", "Research"],
  ["writing", "Writing"], ["testing", "Testing"]] as const;

/** "Offer to other machines": the owner's consent for any connected machine
 * with the chosen skill, in this project, to claim this one task. Hidden when
 * the installation does not run the fleet gateway. */
export function FleetOfferControl({ projectId, jobId, state }: { projectId: string; jobId: string; state: string }) {
  const [enabled, setEnabled] = useState(false), [skill, setSkill] = useState("code.change");
  const [message, setMessage] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch("/api/v1/fleet", { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } })
      .then(response => setEnabled(response.ok)).catch(() => setEnabled(false));
  }, []);
  if (!enabled || !["proposed", "ready"].includes(state)) return null;
  return <section className="private-panel" aria-label="Other machines"><h2>Other machines</h2>
    <p>Let a connected machine with this skill pick up this task. You still review the result.</p>
    <label>Skill needed<select value={skill} onChange={event => setSkill(event.target.value)}>
      {skills.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <div className="private-actions"><button type="button" disabled={busy} onClick={() => {
      setBusy(true); setMessage(null);
      void fetch("/api/v1/fleet/offers", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
        body: JSON.stringify({ projectId, jobId, capability: skill }) })
        .then(response => setMessage(response.ok ? "Offered. A connected machine with that skill can claim it now."
          : "This task could not be offered. It may already be running or assigned."))
        .catch(() => setMessage("This could not be checked. Nothing was offered."))
        .finally(() => setBusy(false));
    }}>Offer to other machines</button></div>
    {message && <p role="status">{message}</p>}
  </section>;
}
