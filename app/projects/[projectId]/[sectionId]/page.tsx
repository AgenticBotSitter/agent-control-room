import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectWorkspacePage } from "@/app/project-workspace-page";
import { buildProjectWorkspaceUiFixtureV1 } from "@/app/fixtures/project-workspace-ui";
import { projects } from "@/src/fixtures/data";

export function generateStaticParams() {
  return projects.flatMap((project) => buildProjectWorkspaceUiFixtureV1(project.id)?.sections.map((section) => ({
    projectId: project.id,
    sectionId: section.sectionId,
  })) ?? []);
}

export async function generateMetadata({ params }: { params: Promise<{ projectId: string; sectionId: string }> }): Promise<Metadata> {
  const { projectId, sectionId } = await params;
  const project = projects.find((candidate) => candidate.id === projectId);
  const section = buildProjectWorkspaceUiFixtureV1(projectId)?.sections.find((candidate) => candidate.sectionId === sectionId);
  return { title: project && section ? `${project.title} · ${section.label}` : "Project" };
}

export default async function ProjectSection({ params }: { params: Promise<{ projectId: string; sectionId: string }> }) {
  const { projectId, sectionId } = await params;
  if (!buildProjectWorkspaceUiFixtureV1(projectId)?.sections.some((section) => section.sectionId === sectionId)) notFound();
  return <ProjectWorkspacePage projectId={projectId} sectionId={sectionId} />;
}
