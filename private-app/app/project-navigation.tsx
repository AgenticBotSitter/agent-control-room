"use client";
import { useProductModule } from "./product-configuration";
import type { EffectiveProjectPresentation } from "../../src/web/v1/project-wire";

type ProjectPage = "overview" | "inbox" | "work" | "agents" | "automations" | "files" | "reviews" | "activity" | "news" | "settings";

export function ProjectNavigation({ projectId, current, presentation }: {
  projectId: string; current: ProjectPage; presentation?: EffectiveProjectPresentation;
}) {
  const newsModuleGlobal = useProductModule("news");
  // Legacy projects (no presentation) keep the global module decision. Saved presentations
  // additionally constrain news to templates that include it.
  const newsSaved = presentation === undefined || presentation.availableModules.includes("news");
  const news = newsModuleGlobal && newsSaved;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const link = (href: string, label: string, page: ProjectPage) =>
    <a href={href} aria-current={current === page ? "page" : undefined}>{label}</a>;
  return <nav className="private-tabs" aria-label="Project pages">
    {link(base, "Overview", "overview")}
    {link(`${base}/inbox`, "Inbox", "inbox")}
    {link(`${base}/tasks`, "Work", "work")}
    {link(`${base}/agents`, "Agents", "agents")}
    {link(`${base}/automations`, "Automations", "automations")}
    {link(`${base}/files`, "Files", "files")}
    {link(`${base}/reviews`, "Reviews", "reviews")}
    {link(`${base}/activity`, "Activity", "activity")}
    {news && link(`${base}/news`, "News", "news")}
    {link(`${base}/settings`, "Settings", "settings")}
  </nav>;
}
