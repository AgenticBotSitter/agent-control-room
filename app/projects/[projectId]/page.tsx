import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectWorkspacePage } from "@/app/project-workspace-page";
import { IdeaPromotedProjectWorkspace } from "@/app/components/idea-promoted-project-workspace";
import { buildIdeaLabUiFixtureV1 } from "@/app/fixtures/idea-lab-ui";
import { projects } from "@/src/fixtures/data";
import { IdeaProtectedProjectWorkspace } from "@/app/components/idea-protected-project-workspace";
import { isControlRoomLocalPilotConfiguredV1 } from "@/app/control-room-local-pilot-runtime";

function decodedProjectId(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function generateStaticParams() {
  return [...projects.map((project) => ({ projectId: project.id })), { projectId: buildIdeaLabUiFixtureV1().promotedProject.projectId }];
}

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  const raw = await params; const projectId = decodedProjectId(raw.projectId);
  const project = projects.find((candidate) => candidate.id === projectId);
  const promoted = buildIdeaLabUiFixtureV1().promotedProject;
  return { title: project ? `${project.title} · Overview` : projectId === promoted.projectId ? `${promoted.title} · Overview` : "Project" };
}

export default async function ProjectDetail({ params }: { params: Promise<{ projectId: string }> }) {
  const raw = await params; const projectId = decodedProjectId(raw.projectId);
  const ideaLab = buildIdeaLabUiFixtureV1();
  if (projectId === ideaLab.promotedProject.projectId) return <IdeaPromotedProjectWorkspace fixture={ideaLab} />;
  if (projects.some((project) => project.id === projectId)) return <ProjectWorkspacePage projectId={projectId} />;
  if(isControlRoomLocalPilotConfiguredV1())return <IdeaProtectedProjectWorkspace projectId={projectId}/>;
  notFound();
}
