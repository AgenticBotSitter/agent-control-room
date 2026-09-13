"use client";

import { useProductModule } from "./product-configuration";

type ProjectPage = "overview" | "work" | "files" | "news" | "settings";

export function ProjectNavigation({ projectId, current }: { projectId: string; current: ProjectPage }) {
  const news = useProductModule("news");
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const link = (href: string, label: string, page: ProjectPage) =>
    <a href={href} aria-current={current === page ? "page" : undefined}>{label}</a>;
  return <nav className="private-tabs" aria-label="Project pages">
    {link(base, "Overview", "overview")}
    {link(`${base}/tasks`, "Work", "work")}
    {link(`${base}/files`, "Files", "files")}
    {news && link(`${base}/news`, "News", "news")}
    {link(`${base}/settings`, "Settings", "settings")}
  </nav>;
}
