import type { JSX } from "react";
import type { BottleneckProjectionV1 } from "@/src/operator-surfaces/v1/types";

/** Renders read-only capacity pressure evidence; it does not offer a release, reservation, or dispatch control. */
export function BottleneckList(props: { bottlenecks: readonly BottleneckProjectionV1[] }): JSX.Element {
  const { bottlenecks } = props;
  if (bottlenecks.length === 0) return <p className="empty-state">No protected bottleneck facts are currently recorded.</p>;
  return (
    <ol className="bottleneck-list" aria-label="Protected bottlenecks">
      {bottlenecks.map((bottleneck) => (
        <li key={bottleneck.resourceKey}>
          <article className="bottleneck-projection">
            <div><span>{bottleneck.utilizationPercent}% utilized</span><small>{bottleneck.resourceKey}</small></div>
            <h3>{bottleneck.explanation}</h3>
            <p>{bottleneck.blockedWorkItemIds.length} blocked work item{bottleneck.blockedWorkItemIds.length === 1 ? "" : "s"}: {bottleneck.blockedWorkItemIds.join(", ")}</p>
            <small>Read-only projection. Capacity is not changed here.</small>
          </article>
        </li>
      ))}
    </ol>
  );
}
