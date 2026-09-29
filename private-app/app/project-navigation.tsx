"use client";
import { useProductModule } from "./product-configuration";
import { useLocalRuntime } from "./local-runtime";
import type { EffectiveProjectPresentation } from "../../src/web/v1/project-wire";

type ProjectPage = "overview" | "inbox" | "work" | "pipelines" | "agents" | "automations" | "files" | "reviews" | "activity" | "news" | "coordination" | "settings";

export function ProjectNavigation({ projectId, current, presentation }: {
  projectId: string; current: ProjectPage; presentation?: EffectiveProjectPresentation;
}) {
  const runtime = useLocalRuntime();
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
    {runtime.mode === "local" ? <>
      {runtime.status?.projectSections.includes("inbox") && link(`${base}/inbox`, "Inbox", "inbox")}
      {link(`${base}/tasks`, "Tasks", "work")}
      {runtime.status?.projectSections.includes("pipelines") && link(`${base}/pipelines`, "Pipelines", "pipelines")}
      {runtime.status?.projectSections.includes("agents") && link(`${base}/agents`, "Agents", "agents")}
      {runtime.status?.projectSections.includes("reviews") && link(`${base}/reviews`, "Reviews", "reviews")}
      {runtime.status?.projectSections.includes("activity") && link(`${base}/activity`, "Activity", "activity")}
      {runtime.status?.projectSections.includes("files") && link(`${base}/files`, "Files", "files")}
      {runtime.status?.projectSections.includes("settings") && link(`${base}/settings`, "Settings", "settings")}
    </> : runtime.mode === "checking" ? link(`${base}/tasks`, "Tasks", "work") : <>
    {link(`${base}/inbox`, "Inbox", "inbox")}
    {link(`${base}/tasks`, "Tasks", "work")}
    {link(`${base}/pipelines`, "Pipelines", "pipelines")}
    {link(`${base}/agents`, "Agents", "agents")}
    {link(`${base}/automations`, "Automations", "automations")}
    {link(`${base}/files`, "Files", "files")}
    {link(`${base}/reviews`, "Reviews", "reviews")}
    {link(`${base}/activity`, "Activity", "activity")}
    {link(`${base}/coordination`, "Coordination", "coordination")}
    {news && link(`${base}/news`, "News", "news")}
    {link(`${base}/settings`, "Settings", "settings")}
    </>}
  </nav>;
}
