import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { projects, workers, workItems } from "@/src/fixtures/data";
import { WorkerOperationControl } from "@/app/components/worker-operation-control";
import type { WorkerOperationPanelModelV1, WorkerOperationRequestChoiceV1 } from "@/app/components/worker-operation-panel";
import type { WorkerProjection } from "@/src/contracts/v1";
import { ArtifactEvidenceCard } from "@/app/components/artifact-evidence-card";
import { SyntheticExecutionTimeline } from "@/app/components/synthetic-execution-timeline";
import { cr5dArtifactFixture, cr5dTimelineFixture } from "@/app/fixtures/cr5d-ui";

export function generateStaticParams() {
  return workers.map((worker) => ({ workerId: worker.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ workerId: string }> }): Promise<Metadata> {
  const { workerId } = await params;
  return { title: workers.find((worker) => worker.id === workerId)?.displayName ?? "Worker" };
}

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const historyBars = [42, 68, 58, 83, 77, 35, 92, 88, 63, 71, 46, 95, 79, 66];

function operationModel(worker: WorkerProjection): WorkerOperationPanelModelV1 {
  const requests: WorkerOperationRequestChoiceV1[] = [
    {
      operation: "request_drain",
      enabled: worker.nodeState === "active",
      reason: worker.nodeState === "active" ? "Stop new work and cancel or drain running work safely." : "Node is not active.",
    },
    {
      operation: "request_resume",
      enabled: worker.nodeState === "draining",
      reason: worker.nodeState === "draining" ? "Allow new work after the node confirms resume." : "Node is not draining.",
    },
    {
      operation: "request_quarantine",
      enabled: ["active", "draining", "offline"].includes(worker.nodeState),
      reason: ["active", "draining", "offline"].includes(worker.nodeState)
        ? "Block new work and require security review."
        : "Node is already quarantined or revoked.",
    },
  ];
  return {
    schema: "control-room.worker-operation-panel/v1",
    workerId: worker.id,
    nodeId: worker.nodeId,
    nodeVersion: worker.nodeVersion,
    nodeState: worker.nodeState,
    displayName: worker.displayName,
    platform: worker.os,
    state: worker.state,
    ...(worker.stateReason ? { stateReason: worker.stateReason } : {}),
    lastHeartbeatAt: worker.lastHeartbeatAt,
    requests,
  };
}

export default async function WorkerDetail({ params }: { params: Promise<{ workerId: string }> }) {
  const { workerId } = await params;
  const worker = workers.find((candidate) => candidate.id === workerId);
  if (!worker) notFound();

  const currentWork = workItems.filter((item) => worker.currentWorkItemIds?.includes(item.id));
  const preferredProjects = projects.filter((project) => worker.preferredProjectIds?.includes(project.id));

  return (
    <div className="detail-shell">
      <a className="skip-link" href="#worker-detail">Skip to worker details</a>
      <main id="worker-detail" className="detail-main" tabIndex={-1}>
        <Link className="detail-back" href="/#workers" prefetch={false}>← Back to workers</Link>
        <header className="detail-hero">
          <div>
            <p className="eyebrow">Worker runtime · {worker.os} · Synthetic fixture</p>
            <h1>{worker.displayName}</h1>
            <p>{worker.machineId} · {worker.runtimeId}</p>
          </div>
          <span className={`health ${worker.state === "idle" ? "health-healthy" : "health-watch"}`}>{label(worker.state)}</span>
        </header>

        <p className="operator-data-status unavailable" role="status">This worker detail is a synthetic fixture. Protected fleet status is available on the portfolio dashboard.</p>
        <section className="metric-grid section-block" aria-label="Synthetic worker summary">
          <article className="metric-card"><span className="metric-icon green">◫</span><div><small>Free slots</small><strong>{worker.availableSlots}/{worker.totalSlots}</strong><em>{label(worker.allocationMode)}</em></div></article>
          <article className="metric-card"><span className="metric-icon blue">⌁</span><div><small>Capability routes</small><strong>{worker.capabilities.length}</strong><em>{worker.capabilities.filter((route) => route.verification === "verified").length} verified</em></div></article>
          <article className="metric-card"><span className="metric-icon amber">▤</span><div><small>Scratch</small><strong>{label(worker.scratchClass)}</strong><em>live availability class</em></div></article>
          <article className="metric-card"><span className="metric-icon violet">●</span><div><small>Heartbeat</small><strong>Fresh</strong><em>{new Date(worker.lastHeartbeatAt).toLocaleTimeString("en-US")}</em></div></article>
        </section>

        <div className="detail-grid">
          <section className="detail-card">
            <h2>Synthetic fourteen-period utilization history</h2>
            <div className="history-chart" aria-label="Synthetic utilization history">
              {historyBars.map((height, index) => <i key={`${height}-${index}`} style={{ height: `${height}%` }} title={`Period ${index + 1}: ${height}%`} />)}
            </div>
            <p className="hero-copy">Synthetic history separates calendar utilization from time the worker was actually available. Production telemetry will replace this fixture after a live worker is authorized.</p>
          </section>

          <section className="detail-card">
            <h2>Fixture current assignment</h2>
            <div className="capability-list">
              {currentWork.map((item) => <article key={item.id}><h3>{item.title}</h3><p>{label(item.domainState)} · {item.progressPercent}%</p><small>{projects.find((project) => project.id === item.source.projectId)?.workspaceName}</small></article>)}
              {!currentWork.length && <article><h3>Ready for compatible work</h3><p>{worker.availableSlots} free slots</p><small>{worker.stateReason}</small></article>}
              {preferredProjects.map((project) => <article key={project.id}><h3>Preferred project</h3><p>{project.workspaceName} · {project.title}</p><small>Unused capacity may be lent according to policy.</small></article>)}
            </div>
          </section>
        </div>

        <section className="detail-card section-block">
          <h2>Verified capability routes</h2>
          <div className="project-grid">
            {worker.capabilities.map((route) => (
              <article className="project-card" key={route.id}>
                <div className="project-topline"><span className="project-monogram">{route.capability.split(".").at(-1)?.slice(0, 2).toUpperCase()}</span><span className={`health ${route.verification === "verified" ? "health-healthy" : "health-watch"}`}>{label(route.verification)}</span></div>
                <p>{route.capability}</p><h3>{route.runtime}</h3>
                <dl className="project-stats"><div><dt>Duration</dt><dd>{route.estimatedDurationMinutes ? `${route.estimatedDurationMinutes} min` : "—"}</dd></div><div><dt>Cost</dt><dd>${(route.estimatedCostUsd ?? 0).toFixed(2)}</dd></div><div><dt>Privacy</dt><dd>{label(route.privacyClass ?? "unknown")}</dd></div></dl>
              </article>
            ))}
          </div>
        </section>

        <section className="detail-card section-block">
          <WorkerOperationControl model={operationModel(worker)} />
        </section>

        {worker.id === "worker.mac-m4" ? (
          <section className="detail-card section-block" aria-label="CR-5D synthetic execution evidence fixture">
            <h2>CR-5D execution evidence</h2>
            <p className="hero-copy">Deterministic fixture backed by the same manifest, claim, lineage, and lifecycle contracts used by the node path.</p>
            <SyntheticExecutionTimeline model={cr5dTimelineFixture} />
            <ArtifactEvidenceCard model={cr5dArtifactFixture} />
          </section>
        ) : null}
      </main>
    </div>
  );
}
