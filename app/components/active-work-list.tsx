import type { JSX } from "react";
import type { ActiveWorkProjectionV1 } from "@/src/operator-surfaces/v1/types";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Active-work observation only; no result, worker reservation, or dispatch authority is implied. */
export function ActiveWorkList(props: { work: readonly ActiveWorkProjectionV1[] }): JSX.Element {
  const { work } = props;
  if (work.length === 0) return <p className="empty-state">No protected active work is currently recorded.</p>;
  return (
    <ol className="active-work-list" aria-label="Protected active work">
      {work.map((item) => (
        <li key={item.jobId}>
          <article className="active-work-item">
            <div><span>{label(item.state)}</span><b>Priority {item.priority}</b></div>
            <h3>{item.jobType}</h3>
            <p>Project {item.projectId} · Requires {item.requiredCapability}</p>
            <small>Last changed {item.updatedAt}. This is observation, not dispatch authority.</small>
          </article>
        </li>
      ))}
    </ol>
  );
}
