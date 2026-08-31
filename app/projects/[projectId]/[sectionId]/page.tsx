import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectWorkspacePage } from "@/app/project-workspace-page";
import { IdeaPromotedProjectWorkspace } from "@/app/components/idea-promoted-project-workspace";
import { buildIdeaLabUiFixtureV1 } from "@/app/fixtures/idea-lab-ui";
import { buildProjectWorkspaceUiFixtureV1 } from "@/app/fixtures/project-workspace-ui";
import { projects } from "@/src/fixtures/data";

function decodedProjectId(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function generateStaticParams() {
  const regular = projects.flatMap((project) => buildProjectWorkspaceUiFixtureV1(project.id)?.sections.map((section) => ({
    projectId: project.id,
    sectionId: section.sectionId,
  })) ?? []);
  const promoted = buildIdeaLabUiFixtureV1();
  return [...regular, ...promoted.workspace.sections.map((section) => ({ projectId: promoted.promotedProject.projectId, sectionId: section.sectionId }))];
}

export async function generateMetadata({ params }: { params: Promise<{ projectId: string; sectionId: string }> }): Promise<Metadata> {
  const raw = await params; const projectId = decodedProjectId(raw.projectId), { sectionId } = raw;
  const project = projects.find((candidate) => candidate.id === projectId);
  const section = buildProjectWorkspaceUiFixtureV1(projectId)?.sections.find((candidate) => candidate.sectionId === sectionId);
  const promoted = buildIdeaLabUiFixtureV1();
  const promotedSection = promoted.workspace.sections.find((candidate) => candidate.sectionId === sectionId);
  return { title: project && section ? `${project.title} · ${section.label}` : projectId === promoted.promotedProject.projectId && promotedSection ? `${promoted.promotedProject.title} · ${promotedSection.label}` : "Project" };
}

export default async function ProjectSection({ params }: { params: Promise<{ projectId: string; sectionId: string }> }) {
  const raw = await params; const projectId = decodedProjectId(raw.projectId), { sectionId } = raw;
  const ideaLab = buildIdeaLabUiFixtureV1();
  if (projectId === ideaLab.promotedProject.projectId) {
    if (!ideaLab.workspace.sections.some((section) => section.sectionId === sectionId)) notFound();
    return <IdeaPromotedProjectWorkspace fixture={ideaLab} sectionId={sectionId} />;
  }
  if (!buildProjectWorkspaceUiFixtureV1(projectId)?.sections.some((section) => section.sectionId === sectionId)) notFound();
  return <ProjectWorkspacePage projectId={projectId} sectionId={sectionId} />;
}
