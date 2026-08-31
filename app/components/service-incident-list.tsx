import type { JSX } from "react";
import type { ServiceIncidentProjectionV1 } from "@/src/operator-surfaces/v1/types";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Read-only incident list. Remedy codes describe a permitted next investigation, not a repair action. */
export function ServiceIncidentList(props: { incidents: readonly ServiceIncidentProjectionV1[] }): JSX.Element {
  const { incidents } = props;
  if (incidents.length === 0) return <p className="empty-state">No protected service incidents are currently recorded.</p>;
  return (
    <ol className="service-incident-list" aria-label="Protected service incidents">
      {incidents.map((incident) => (
        <li key={incident.id} className={`service-incident severity-${incident.severity}`}>
          <div><span>{label(incident.severity)}</span><small>{label(incident.state)} · {incident.serviceId}</small></div>
          <h3>{label(incident.reasonCode)}</h3>
          <p>Suggested next step: {label(incident.remedyCode)}. This screen cannot make the repair.</p>
          <small>Last observed {incident.lastObservedAt}</small>
        </li>
      ))}
    </ol>
  );
}
