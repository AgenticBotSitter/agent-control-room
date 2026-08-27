import type { JSX } from "react";
import type { OwnerFocusPinV1 } from "@/src/operator-surfaces/v1";

export type OwnerFocusDraftRequestV1 =
  | { operation: "set_owner_focus"; projectId: string; level: "p0" | "today" }
  | { operation: "clear_owner_focus"; projectId: string };

function projectName(projectId: string, projects: readonly { id: string; label: string }[]): string {
  return projects.find((project) => project.id === projectId)?.label ?? projectId;
}

/** Displays and prepares focus intent only. A separately authenticated command is required to persist it. */
export function OwnerFocusStrip(props: {
  pins: readonly OwnerFocusPinV1[];
  projects: readonly { id: string; label: string }[];
  onPrepare(request: OwnerFocusDraftRequestV1): void;
  notice?: string;
}): JSX.Element {
  const { pins, projects, onPrepare, notice } = props;
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
              <button type="button" onClick={() => onPrepare({ operation: "clear_owner_focus", projectId: pin.projectId })}>Prepare clear</button>
            </li>
          ))}
        </ul>
      )}
      <div className="owner-focus-editor" aria-label="Prepare Owner Focus request">
        <span>Prepare focus request</span>
        {projects.map((project) => (
          <div key={project.id}>
            <strong>{project.label}</strong>
            <button type="button" onClick={() => onPrepare({ operation: "set_owner_focus", projectId: project.id, level: "p0" })}>Prepare P0</button>
            <button type="button" onClick={() => onPrepare({ operation: "set_owner_focus", projectId: project.id, level: "today" })}>Prepare Today</button>
          </div>
        ))}
      </div>
      <p className="owner-focus-notice">{notice ?? "No request prepared. Nothing has been saved or scheduled."}</p>
    </section>
  );
}
