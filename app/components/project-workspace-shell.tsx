import type { ReactNode } from "react";
import type { ProjectWorkspaceSnapshotV1 } from "@/src/project-workspace/v1";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sectionCount(snapshot: ProjectWorkspaceSnapshotV1, sectionId: string): number | undefined {
  const section = snapshot.sections.find((candidate) => candidate.sectionId === sectionId);
  if (section?.itemCount !== undefined) return section.itemCount;
  if (sectionId === "work") return snapshot.activeItemCount;
  if (sectionId === "inbox" || sectionId === "reviews") return snapshot.waitingReviewCount;
  return undefined;
}

export function ProjectWorkspaceShell(props: {
  snapshot: ProjectWorkspaceSnapshotV1;
  workspaceName: string;
  health: string;
  currentSectionId: string;
  children: ReactNode;
}) {
  const current = props.snapshot.sections.find((section) => section.sectionId === props.currentSectionId);
  return (
    <div className="detail-shell">
      <a className="skip-link" href="#project-workspace-content">Skip to project workspace</a>
      <main className="detail-main" tabIndex={-1}>
        {/* This shared shell is rendered by the node-only contract tests, where the vinext next/link alias is unavailable. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a className="detail-back" href="/">← Back to all projects</a>
        <header className="detail-hero project-workspace-hero">
          <div>
            <p className="eyebrow">{props.workspaceName} · Project Workspace</p>
            <h1>{props.snapshot.title}</h1>
            <p>{props.snapshot.summary}</p>
          </div>
          <span className={`health health-${props.health}`}>{label(props.health)}</span>
        </header>

        <nav className="project-workspace-nav project-workspace-route-nav" aria-label="Project workspace navigation">
          {props.snapshot.sections.map((section) => {
            const count = sectionCount(props.snapshot, section.sectionId);
            const active = section.sectionId === props.currentSectionId;
            return <a key={section.sectionId} href={section.deepLinkPath}
              className={active ? "current" : "planned"} aria-current={active ? "page" : undefined}>
              {section.label}{count !== undefined ? <small>{count}</small> : null}
            </a>;
          })}
        </nav>

        <div className="project-workspace-status-grid" aria-label="Project workspace summary">
          <article><small>Current section</small><strong>{current?.label ?? "Unavailable"}</strong><span>{current?.kind === "project_extension" ? "Project-specific view" : "Shared Control Room view"}</span></article>
          <article><small>Active work</small><strong>{props.snapshot.activeItemCount}</strong><span>Observed, not commanded</span></article>
          <article><small>Waiting review</small><strong>{props.snapshot.waitingReviewCount}</strong><span>No approval inferred</span></article>
          <article><small>Authority</small><strong>{label(props.snapshot.authorityMode)}</strong><span>Source boundary retained</span></article>
        </div>

        <div className="abs-source-strip project-workspace-sources" aria-label="Project source status">
          {props.snapshot.sourceStatuses.map((source) => <article key={source.sourceId} className={`source-${source.state}`}>
            <span>{source.label}</span><strong>{label(source.state)}</strong>
            <small>{source.mode === "synthetic" ? "Injected fixture only" : label(source.safeStatusCode)}</small>
          </article>)}
        </div>

        <p className="project-workspace-boundary" role="status">
          This workspace is presentation-only. Navigation grants no approval, network, command, lease, dispatch, or execution authority.
        </p>

        <section id="project-workspace-content" className="project-workspace-content" aria-labelledby="project-workspace-section-title">
          <div className="section-heading project-workspace-section-heading">
            <div><p className="eyebrow">{current?.kind === "project_extension" ? "Project extension" : "Shared project view"}</p>
              <h2 id="project-workspace-section-title">{current?.label ?? "Section unavailable"}</h2></div>
            <span className="simulation-only">Synthetic projection · no effects</span>
          </div>
          {props.children}
        </section>
      </main>
    </div>
  );
}
