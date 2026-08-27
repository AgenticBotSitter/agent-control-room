import { useState, type JSX } from "react";
import type { OwnerFocusPinV1 } from "@/src/operator-surfaces/v1";

export type OwnerFocusDraftRequestV1 =
  | { operation: "set_owner_focus"; projectId: string; level: "p0" | "today"; reason: string }
  | { operation: "clear_owner_focus"; projectId: string };

function projectName(projectId: string, projects: readonly { id: string; label: string }[]): string {
  return projects.find((project) => project.id === projectId)?.label ?? projectId;
}

/** Displays and submits priority intent only. The protected endpoint separately authorizes every save. */
export function OwnerFocusStrip(props: {
  pins: readonly OwnerFocusPinV1[];
  projects: readonly { id: string; label: string }[];
  onSubmit(request: OwnerFocusDraftRequestV1): void | Promise<void>;
  notice?: string;
}): JSX.Element {
  const { pins, projects, onSubmit, notice } = props;
  const [reason, setReason] = useState("");
  const submitSet = (projectId: string, level: "p0" | "today") => {
    const normalizedReason = reason.trim();
    if (!normalizedReason) return;
    void onSubmit({ operation: "set_owner_focus", projectId, level, reason: normalizedReason });
  };
  return (
    <section className="owner-focus-strip" aria-label="Owner Focus">
      <header>
        <div><p className="eyebrow">Owner Focus</p><h2>What you want kept visible</h2></div>
        <p>Priority signal only. It cannot change fairness, authority, capacity, or dispatch.</p>
      </header>
      {pins.length === 0 ? <p className="empty-state">No P0 or Today focus is recorded.</p> : (
        <ul className="owner-focus-pins">
          {pins.map((pin) => (
            <li key={pin.id}>
              <span className={`focus-level focus-${pin.level}`}>{pin.level === "p0" ? "P0" : "Today"}</span>
              <div><strong>{projectName(pin.projectId, projects)}</strong><small>{pin.reason}</small></div>
              <button type="button" onClick={() => void onSubmit({ operation: "clear_owner_focus", projectId: pin.projectId })}>Clear focus</button>
            </li>
          ))}
        </ul>
      )}
      <div className="owner-focus-editor" aria-label="Save Owner Focus request">
        <span>Save focus intent</span>
        <label htmlFor="owner-focus-reason">Reason</label>
        <input id="owner-focus-reason" value={reason} maxLength={240} onChange={(event) => setReason(event.target.value)} placeholder="Why should this remain visible?" />
        {projects.map((project) => (
          <div key={project.id}>
            <strong>{project.label}</strong>
            <button type="button" disabled={!reason.trim()} onClick={() => submitSet(project.id, "p0")}>Save P0</button>
            <button type="button" disabled={!reason.trim()} onClick={() => submitSet(project.id, "today")}>Save Today</button>
          </div>
        ))}
      </div>
      <p className="owner-focus-notice">{notice ?? "No focus intent has been saved. This never changes scheduling or dispatch."}</p>
    </section>
  );
}
