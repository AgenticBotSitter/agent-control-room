import type { JSX } from "react";
import type { PortfolioProjectProjectionV1 } from "@/src/operator-surfaces/v1/types";

/** Read-only canonical portfolio status; it intentionally makes no completion or scheduling promise. */
export function PortfolioProjection(props: { projects: readonly PortfolioProjectProjectionV1[] }): JSX.Element {
  if (props.projects.length === 0) return <p className="empty-state">No protected portfolio projects are currently recorded.</p>;
  return <div className="project-grid" aria-label="Protected portfolio projects">
    {props.projects.map((project) => (
      <article key={project.projectId} className="project-card protected-project-card">
        <div className="project-topline"><span className="project-monogram">CR</span><span className="health health-active">Observed</span></div>
        <p>Protected project</p><h3>{project.projectId}</h3>
        <dl className="project-stats">
          <div><dt>Workflows</dt><dd>{project.workflowCount}</dd></div>
          <div><dt>Active jobs</dt><dd>{project.activeJobCount}</dd></div>
          <div><dt>Waiting approval</dt><dd>{project.waitingApprovalJobCount}</dd></div>
          <div><dt>Failed jobs</dt><dd>{project.failedJobCount}</dd></div>
        </dl>
        <small>Last activity {project.lastActivityAt}. Read-only observation.</small>
      </article>
    ))}
  </div>;
}
