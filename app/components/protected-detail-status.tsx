"use client";

import { useEffect, useState } from "react";
import { fetchOperatorSurfaceSnapshotV1, type OperatorSurfaceDataStateV1 } from "@/src/operator-surfaces/v1/http-client";

function label(value: string): string { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

/** Loads the same authenticated snapshot used by the dashboard; it never treats a fixture identifier as authority. */
export function ProtectedProjectDetailStatus(props: { projectId: string }) {
  const [data, setData] = useState<OperatorSurfaceDataStateV1>({ state: "loading" });
  useEffect(() => { let current = true; void fetchOperatorSurfaceSnapshotV1().then((next) => { if (current) setData(next); }); return () => { current = false; }; }, []);
  if (data.state === "loading") return <p className="operator-data-status loading" role="status">Protected project status is loading; fixture details remain labelled below.</p>;
  if (data.state !== "available") return <p className="operator-data-status unavailable" role="status">Protected project status is unavailable; fixture details remain labelled below.</p>;
  const project = data.snapshot.portfolio.find((item) => item.projectId === props.projectId);
  if (!project) return <p className="operator-data-status unavailable" role="status">No protected record matches this fixture project. Fixture details remain labelled below.</p>;
  return <section className="detail-card protected-detail-status" aria-label="Protected project status"><p className="eyebrow">Protected observation</p><h2>{project.projectId}</h2><dl className="project-stats"><div><dt>Workflows</dt><dd>{project.workflowCount}</dd></div><div><dt>Active jobs</dt><dd>{project.activeJobCount}</dd></div><div><dt>Waiting approval</dt><dd>{project.waitingApprovalJobCount}</dd></div><div><dt>Failed jobs</dt><dd>{project.failedJobCount}</dd></div></dl><small>Last activity {project.lastActivityAt}. This panel cannot schedule or dispatch work.</small></section>;
}

export function ProtectedWorkerDetailStatus(props: { workerId: string }) {
  const [data, setData] = useState<OperatorSurfaceDataStateV1>({ state: "loading" });
  useEffect(() => { let current = true; void fetchOperatorSurfaceSnapshotV1().then((next) => { if (current) setData(next); }); return () => { current = false; }; }, []);
  if (data.state === "loading") return <p className="operator-data-status loading" role="status">Protected worker status is loading; fixture details remain labelled below.</p>;
  if (data.state !== "available") return <p className="operator-data-status unavailable" role="status">Protected worker status is unavailable; fixture details remain labelled below.</p>;
  const worker = data.snapshot.fleet.find((item) => item.workerId === props.workerId);
  if (!worker) return <p className="operator-data-status unavailable" role="status">No protected record matches this fixture worker. Fixture details remain labelled below.</p>;
  return <section className="detail-card protected-detail-status" aria-label="Protected worker status"><p className="eyebrow">Protected observation</p><h2>{worker.workerId}</h2><dl className="project-stats"><div><dt>Observed state</dt><dd>{label(worker.state)}</dd></div><div><dt>Capacity</dt><dd>{worker.capacityState === "reported" ? `${worker.availableSlots}/${worker.totalSlots}` : "Unavailable"}</dd></div><div><dt>Capability</dt><dd>{label(worker.capabilityState)}</dd></div><div><dt>Telemetry</dt><dd>{label(worker.telemetryState)}</dd></div></dl><small>Last observed {worker.lastObservedAt}. This panel cannot dispatch work.</small></section>;
}
