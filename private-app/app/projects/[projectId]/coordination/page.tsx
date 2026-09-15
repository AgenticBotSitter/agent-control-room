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

export const dynamic = "force-dynamic";

export default async function ProjectCoordinationPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId: rawProjectId } = await params;
  const projectId = decodePrivateRouteSegment(rawProjectId);
  return <ProjectCoordinationWorkspace projectId={projectId} />;
}
