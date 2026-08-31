import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectWorkspacePage } from "@/app/project-workspace-page";
import { projects } from "@/src/fixtures/data";

export function generateStaticParams() {
  return projects.map((project) => ({ projectId: project.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  const { projectId } = await params;
  const project = projects.find((candidate) => candidate.id === projectId);
  return { title: project ? `${project.title} · Overview` : "Project" };
}

export default async function ProjectDetail({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!projects.some((project) => project.id === projectId)) notFound();
  return <ProjectWorkspacePage projectId={projectId} />;
}
