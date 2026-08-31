import type { JSX } from "react";
import type { ReadyFrontierCycleProjectViewV1, ReadyFrontierCycleProjectionV1 } from "@/src/ready-frontier/v1/integration-types";
import type { ReadyFrontierAutomationProjectionV1 } from "@/src/ready-frontier/v1/automation-types";

export type ReadyFrontierViewStateV1 =
  | { state: "available"; projection: ReadyFrontierCycleProjectionV1 }
  | { state: "empty" }
  | { state: "unavailable"; safeCode: "source_unavailable" | "source_stale" | "integrity_failed" };

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stateMessage(state: Exclude<ReadyFrontierViewStateV1, { state: "available" }>): JSX.Element {
  if (state.state === "empty") return <p className="empty-state">No authenticated proposal cycle has been recorded yet.</p>;
  const message = state.safeCode === "source_stale"
    ? "The proposal frontier is unavailable because one or more source observations are stale."
    : state.safeCode === "integrity_failed"
      ? "The proposal frontier failed its integrity check and is hidden."
      : "The authenticated proposal sources are currently unavailable.";
  return <p className="operator-data-status unavailable" role="status">{message} No work was created or sent.</p>;
}

export function ReadyFrontierPortfolioView(props: { data: ReadyFrontierViewStateV1; automation?: ReadyFrontierAutomationProjectionV1;
  projectIds?: ReadonlySet<string> }): JSX.Element {
  if (props.data.state !== "available") return stateMessage(props.data);
  const projects = props.data.projection.projects.filter((project) => !props.projectIds || props.projectIds.has(project.projectId));
  if (!projects.length) return <p className="empty-state">No proposal-frontier projects are in this view.</p>;
  return <div className="frontier-shell" aria-label="Authenticated proposal frontier">
    {props.automation ? <div className="frontier-policy-strip" role="status">
      <span><small>Standing policy</small><strong>{props.automation.standingPolicyState === "repository_fixture_active" ? "Repository simulation active" : label(props.automation.standingPolicyState)}</strong></span>
      <span><small>Production policy</small><strong>Not enrolled</strong></span>
      <span><small>Automatic next step</small><strong>Proposed work only</strong></span>
    </div> : null}
    <div className="frontier-summary">
      <div><small>Proposed</small><strong>{projects.reduce((sum, project) => sum + project.proposed.length, 0)}</strong></div>
      <div><small>Blocked</small><strong>{projects.reduce((sum, project) => sum + project.blocked.length, 0)}</strong></div>
      <div><small>Needs review</small><strong>{projects.reduce((sum, project) => sum + project.needsReview.length, 0)}</strong></div>
      <div><small>Deferred</small><strong>{projects.reduce((sum, project) => sum + project.deferred.length, 0)}</strong></div>
    </div>
    <div className="frontier-project-grid">
      {projects.map((project) => <article className="frontier-project-card" key={project.projectId}>
        <div className="project-topline"><span className="project-monogram">RF</span><span className="health health-active">Proposal only</span></div>
        <p>Authenticated ready frontier</p>
        <h3>{project.projectId}</h3>
        <dl className="project-stats">
          <div><dt>Proposed</dt><dd>{project.proposed.length}</dd></div>
          <div><dt>Blocked</dt><dd>{project.blocked.length}</dd></div>
          <div><dt>Review</dt><dd>{project.needsReview.length}</dd></div>
          <div><dt>Deferred</dt><dd>{project.deferred.length}</dd></div>
        </dl>
        {project.proposed[0] ? <p className="frontier-next"><small>Highest-ranked proposal</small>{project.proposed[0].title}</p> : <p className="frontier-next"><small>Current result</small>No eligible new proposal</p>}
        <a href={`/projects/${encodeURIComponent(project.projectId)}#ready-frontier`}>Inspect frontier <span aria-hidden="true">→</span></a>
      </article>)}
    </div>
    <p className="frontier-boundary">Repository-only proposal and policy evidence. No real standing policy is enrolled; this view cannot materialize, approve, ready, schedule, claim, lease, dispatch, or execute work.</p>
  </div>;
}

function GateList(props: { title: string; items: ReadyFrontierCycleProjectViewV1["blocked"] }): JSX.Element {
  return <section className="frontier-lane">
    <div className="frontier-lane-title"><h3>{props.title}</h3><span>{props.items.length}</span></div>
    {props.items.length ? <div className="frontier-lane-items">{props.items.map((item) => <article key={item.itemId}>
      <strong>{item.label}</strong>
      <p>{item.reasonCodes.map(label).join(" · ")}</p>
    </article>)}</div> : <p className="empty-state">Nothing in this section.</p>}
  </section>;
}

export function ReadyFrontierProjectView(props: { data: ReadyFrontierViewStateV1; projectId: string;
  automation?: ReadyFrontierAutomationProjectionV1 }): JSX.Element {
  if (props.data.state !== "available") return <section id="ready-frontier" className="detail-card section-block"><h2>Ready frontier</h2>{stateMessage(props.data)}</section>;
  const project = props.data.projection.projects.find((item) => item.projectId === props.projectId);
  const automation = props.automation?.projects.find((item) => item.projectId === props.projectId);
  if (!project) return <section id="ready-frontier" className="detail-card section-block"><h2>Ready frontier</h2><p className="empty-state">This project is not present in the authenticated proposal cycle.</p></section>;
  return <section id="ready-frontier" className="detail-card section-block frontier-workspace">
    <div className="section-heading"><div><p className="eyebrow">Authenticated repository cycle</p><h2>Ready frontier</h2></div><span className="simulation-only">Proposal only · owner review required</span></div>
    <p>What Control Room currently recommends proposing next, plus the exact gates holding other candidates back.</p>
    <div className="frontier-lanes">
      <section className="frontier-lane frontier-proposed">
        <div className="frontier-lane-title"><h3>Proposed</h3><span>{project.proposed.length}</span></div>
        {project.proposed.length ? <div className="frontier-lane-items">{project.proposed.map((item) => {
          const policy = automation?.proposals.find((proposal) => proposal.proposalId === item.proposalId);
          const policyText = policy?.materializationState === "materialized_proposed" ? `Recorded as proposed work · ${policy.materializedJobId}`
            : policy?.policyDisposition === "eligible_repository_simulation" ? "Eligible in repository simulation · materialization not requested"
              : policy ? `${label(policy.policyDisposition)} · no work created` : "Standing policy state unavailable · no work created";
          return <article key={item.itemId}>
            <small>Rank {item.rank} · Priority {item.priority}</small>
            <strong>{item.title}</strong>
            <p>{label(item.platform)} · {label(item.risk)} risk · {item.routeId}</p>
            <em>{policyText}</em>
          </article>;
        })}</div> : <p className="empty-state">No new work is eligible for proposal.</p>}
      </section>
      <GateList title="Blocked" items={project.blocked} />
      <GateList title="Needs review" items={project.needsReview} />
      <GateList title="Deferred" items={project.deferred} />
    </div>
    {project.suppressedCount > 0 ? <p className="frontier-suppressed">{project.suppressedCount} unchanged or duplicate candidate{project.suppressedCount === 1 ? " was" : "s were"} safely suppressed.</p> : null}
    <p className="frontier-boundary">This is a read-only explanation of local repository policy and materialization truth. Production policy is not enrolled, and this surface contains no materialization, approval, scheduling, agent-message, or execution control.</p>
  </section>;
}
