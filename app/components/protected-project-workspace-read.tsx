"use client";

import { useEffect, useState } from "react";
import {
  fetchProjectWorkspaceReadModelV1,
  type ProjectWorkspaceProtectedDataStateV1,
} from "@/src/project-workspace/v1/http-client";

function label(value: string): string { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

function sectionDetail(state: Extract<ProjectWorkspaceProtectedDataStateV1, { state: "available" }>, sectionId: string): string {
  const model = state.model;
  if (sectionId === "inbox") return `${model.actionInbox.filter((item) => item.state === "open").length} open protected attention records`;
  if (sectionId === "work") return `${model.activeWork.length} active protected jobs`;
  if (sectionId === "automations") return `${model.services.length} services · ${model.schedules.length} schedules`;
  if (sectionId === "reviews") return `${model.actionInbox.filter((item) => item.kind === "review" || item.kind === "approval").length} protected review records`;
  if (sectionId === "activity") return `${model.serviceIncidents.length} service incidents in the project read`;
  if (sectionId === "settings") return `${model.workspaceId} · server-resolved scope`;
  if (sectionId === "agents") return "The protected operator port does not expose agent transcripts or credentials";
  if (sectionId === "artifacts") return "The protected operator port does not expose artifact bodies or locators";
  return `${model.portfolio.workflowCount} workflows observed`;
}

export function ProtectedProjectWorkspaceReadPanel(props: { data: ProjectWorkspaceProtectedDataStateV1; sectionId: string }) {
  if (props.data.state === "loading") {
    return <p className="operator-data-status loading" role="status">Protected project read is loading. Development fixture content remains separately labelled below.</p>;
  }
  if (props.data.state === "unavailable") {
    return <p className="operator-data-status unavailable" role="status">Protected project read is unavailable ({label(props.data.code)}). No fixture record is being presented as protected truth.</p>;
  }
  const { model } = props.data;
  return <section className={`detail-card protected-detail-status protected-project-read ${model.freshness === "stale" ? "is-stale" : ""}`} aria-label="Protected project read">
    <div className="protected-project-read-heading"><div><p className="eyebrow">Protected project read</p><h3>{model.projectId}</h3></div>
      <span className={`health ${model.freshness === "current" ? "health-healthy" : "health-attention"}`}>{label(model.freshness)}</span></div>
    <dl className="project-stats"><div><dt>Active jobs</dt><dd>{model.portfolio.activeJobCount}</dd></div>
      <div><dt>Waiting approval</dt><dd>{model.portfolio.waitingApprovalJobCount}</dd></div>
      <div><dt>Failed jobs</dt><dd>{model.portfolio.failedJobCount}</dd></div>
      <div><dt>This section</dt><dd>{sectionDetail(props.data, props.sectionId)}</dd></div></dl>
    <small>Read {model.sourceGeneratedAt}. Protected data never falls back to fixtures and this panel cannot approve, schedule, dispatch, or execute work.</small>
  </section>;
}

export function ProtectedProjectWorkspaceRead(props: { projectId: string; sectionId: string }) {
  const [data, setData] = useState<ProjectWorkspaceProtectedDataStateV1>({ state: "loading" });
  useEffect(() => {
    let current = true;
    void fetchProjectWorkspaceReadModelV1(props.projectId).then((next) => { if (current) setData(next); });
    return () => { current = false; };
  }, [props.projectId]);
  return <ProtectedProjectWorkspaceReadPanel data={data} sectionId={props.sectionId} />;
}
