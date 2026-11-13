"use client";

import { useCallback, useEffect, useState } from "react";
import { loopRosterColumnsV1, type LoopRosterRowV1 } from "../../src/web/v1/loop-roster-columns";

export type LoopRosterViewV1 = { seeded: boolean; version: number | null; exportedVersion: number | null; exported: boolean;
  canEdit: boolean; message?: string; models: (LoopRosterRowV1 & { updatedBy: string; updatedAt: string })[] };
type Refusal = { message: string; problems: string[] };

export const loopRosterOnOffSentenceV1 = "On/off is necessary, not sufficient. A model also needs an enabled, qualified route in the "
  + "tools release before a job can launch on it.";

/** The roster table. No eligibility explanations here: those come from `cr check lineup` (B8). */
export function LoopRosterTable({ view, pending, onToggle, onSave, refusal }: { view: LoopRosterViewV1; pending: boolean;
  onToggle: (name: string, on: boolean) => void; onSave: (row: LoopRosterRowV1) => void; refusal?: Refusal }) {
  const [editing, setEditing] = useState<LoopRosterRowV1>();
  if (!view.seeded) return <section className="private-panel"><h2>Models</h2><p role="status">{view.message ?? "Roster not seeded."}</p></section>;
  return <section className="private-panel"><h2>Models</h2>
    <p role="status">{view.exported ? `Roster version ${view.version}, exported for the scripts.` : view.message}</p>
    <p>{loopRosterOnOffSentenceV1}</p>
    <div className="private-table-scroll"><table><thead><tr>{loopRosterColumnsV1.map(column => <th key={column} scope="col">{column}</th>)}
      <th scope="col">Last change</th>{view.canEdit && <th scope="col">Actions</th>}</tr></thead>
      <tbody>{view.models.map(model => <tr key={model.name}>{loopRosterColumnsV1.map(column => <td key={column}>{model[column]}</td>)}
        <td>{model.updatedBy}</td>
        {view.canEdit && <td><button type="button" disabled={pending} aria-pressed={model.on === "on"}
          onClick={() => onToggle(model.name, model.on !== "on")}>{model.on === "on" ? "Turn off" : "Turn on"}</button>
          <button type="button" disabled={pending}
            onClick={() => setEditing(Object.fromEntries(loopRosterColumnsV1.map(column => [column, model[column]])) as LoopRosterRowV1)}>Edit</button></td>}
      </tr>)}</tbody></table></div>
    {view.canEdit && <form aria-label="Edit model" onSubmit={event => { event.preventDefault(); if (editing) onSave(editing); }}>
      <h3>{editing && view.models.some(model => model.name === editing.name) ? `Edit ${editing.name}` : "Add a model"}</h3>
      {loopRosterColumnsV1.map(column => <label key={column}>{column}
        <input name={column} value={editing?.[column] ?? ""} disabled={pending}
          onChange={event => setEditing({ ...(editing ?? Object.fromEntries(loopRosterColumnsV1.map(c => [c, ""])) as LoopRosterRowV1),
            [column]: event.target.value })} /></label>)}
      <button type="submit" disabled={pending || !editing?.name}>Save model</button>
    </form>}
    {refusal && <div role="alert"><p>{refusal.message}</p>{!!refusal.problems.length && <ul>{refusal.problems.map(line => <li key={line}>{line}</li>)}</ul>}</div>}
  </section>;
}

const headers = (key?: string) => ({ accept: "application/json", "x-requested-with": "XMLHttpRequest",
  ...(key ? { "content-type": "application/json", "idempotency-key": key } : {}) });

/** Reads `/api/v1/loop-roster`; an installation without the roster (404) shows nothing. */
export function LoopRosterSection() {
  const [view, setView] = useState<LoopRosterViewV1 | "absent" | "unavailable">();
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal>();
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/loop-roster", { credentials: "same-origin", cache: "no-store", redirect: "error", headers: headers() });
      setView(response.status === 404 ? "absent" : response.ok ? await response.json() as LoopRosterViewV1 : "unavailable");
    } catch { setView("unavailable"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (view === undefined || view === "absent") return null;
  if (view === "unavailable") return <section className="private-panel"><h2>Models</h2><p role="alert">The model roster could not be read.</p></section>;
  const send = async (path: string, method: "PUT" | "POST", body: unknown) => {
    setPending(true); setRefusal(undefined);
    try {
      const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: headers(`roster:${crypto.randomUUID()}`), body: JSON.stringify(body) });
      if (response.status === 422) { const value = await response.json() as Refusal; setRefusal({ message: value.message, problems: value.problems ?? [] }); }
      else if (response.status === 409) setRefusal({ message: "The roster changed since it was read. Review the current rows and try again.", problems: [] });
      else if (!response.ok) setRefusal({ message: "The change was not saved.", problems: [] });
    } catch { setRefusal({ message: "The change could not be confirmed. Reload before trying again.", problems: [] }); }
    finally { setPending(false); await load(); }
  };
  const path = (name: string) => `/api/v1/loop-roster/models/${encodeURIComponent(name)}`;
  return <LoopRosterTable view={view} pending={pending} refusal={refusal}
    onToggle={(name, on) => { void send(`${path(name)}/on`, "POST", { expectedVersion: view.version, on }); }}
    onSave={row => { void send(path(row.name), "PUT", { expectedVersion: view.version,
      row: Object.fromEntries(loopRosterColumnsV1.filter(column => column !== "name").map(column => [column, row[column]])) }); }} />;
}
