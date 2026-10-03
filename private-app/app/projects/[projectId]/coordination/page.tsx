// Project coordination page route.
//
// The coordination surface is a section of the project page tree: owners
// appoint, replace, and revoke coordinators here, and manage the delegation
// policy. Reads are human-only. The page tree enforces the same single-origin
// JWT verifier as the rest of the private app; this file adds nothing to
// the security boundary, it only composes the workspace onto an existing
// route.

import { ProjectCoordinationWorkspace } from "../../../project-coordination-workspace";
import { decodePrivateRouteSegment } from "../../../route-segment";
import { PrivateHeader } from "../../../private-header";
import { ProjectNavigation } from "../../../project-navigation";

export const dynamic = "force-dynamic";

export default async function ProjectCoordinationPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId: rawProjectId } = await params;
  const projectId = decodePrivateRouteSegment(rawProjectId);
  return <div className="private-shell">
    <PrivateHeader />
    <main id="private-main" tabIndex={-1}>
      <a className="private-back" href={`/projects/${encodeURIComponent(projectId)}`}>Back to project</a>
      <div className="private-heading"><h1>Coordination</h1></div>
      <ProjectNavigation projectId={projectId} current="coordination" />
      <ProjectCoordinationWorkspace key={projectId} projectId={projectId} />
    </main>
  </div>;
}
