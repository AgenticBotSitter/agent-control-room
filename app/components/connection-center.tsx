"use client";

import { useEffect, useState } from "react";
import { fetchConnectionCenterV1 } from "@/src/connection-center/v1/http-client";
import type { ConnectionCenterDataStateV1 } from "@/src/connection-center/v1/types";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function transportLabel(value: "local_loopback" | "ssh_tunnel"): string {
  return value === "local_loopback" ? "Local Mac" : "Private SSH tunnel";
}

export function ConnectionCenterPanel({ data }: { data: ConnectionCenterDataStateV1 }) {
  if (data.state === "loading") return <p className="operator-data-status loading" role="status">Loading protected connection inventory…</p>;
  if (data.state === "unavailable") return <section className="detail-card connection-center-unavailable" role="status">
    <h2>Protected connection inventory unavailable</h2><p>{label(data.code)}</p>
    <small>No fixture connection, hostname, credential, or live status is substituted.</small></section>;
  const { projection } = data;
  return <>
    <section className="metric-grid connection-center-summary" aria-label="Connection summary">
      <article className="metric-card"><span className="metric-icon green">◫</span><div><small>Enrolled</small><strong>{projection.summary.connectionCount}</strong><em>Protected roster entries</em></div></article>
      <article className="metric-card"><span className="metric-icon blue">⌁</span><div><small>Recent signals</small><strong>{projection.summary.currentSignalCount}</strong><em>{projection.summary.staleSignalCount} stale · {projection.summary.missingSignalCount} missing</em></div></article>
      <article className="metric-card"><span className="metric-icon amber">!</span><div><small>Needs setup</small><strong>{projection.summary.attentionCount}</strong><em>Qualification or authority gates</em></div></article>
      <article className="metric-card"><span className="metric-icon violet">◎</span><div><small>Live panels</small><strong>{projection.summary.livePanelEligibleCount}</strong><em>No eligibility inferred</em></div></article>
    </section>
    <section className="detail-card connection-runtime-card">
      <div><p className="eyebrow">Reviewed compatibility baseline</p><h2>Hermes {projection.reviewedRuntime.releaseLine}</h2>
        <p>Exact reviewed revision <code>{projection.reviewedRuntime.runtimeRevision.slice(0, 12)}</code></p></div>
      <span className="health health-healthy">Reviewed</span>
    </section>
    <section className="detail-card"><div className="section-heading"><div><p className="eyebrow">Protected inventory</p><h2>Agent connections</h2></div>
      <span className="simulation-only">Read only · no connect action</span></div>
      {projection.connections.length ? <div className="connection-center-grid">{projection.connections.map((connection) => <article key={connection.connectionReference} className="connection-card">
        <div className="connection-card-heading"><div><small>{transportLabel(connection.transport)}</small><h3>{connection.connectionReference}</h3></div>
          <span className={`health ${connection.signalFreshness === "current" ? "health-healthy" : "health-watch"}`}>Signal {label(connection.signalFreshness)}</span></div>
        <dl><div><dt>Agent reference</dt><dd>{connection.nodeReference}</dd></div><div><dt>Hermes version</dt><dd>0.21 exact reviewed revision</dd></div>
          <div><dt>Enrollment</dt><dd>{label(connection.enrollmentState)}</dd></div><div><dt>Recent authenticated signal</dt><dd>{label(connection.signalFreshness)}</dd></div>
          <div><dt>Qualification</dt><dd>{label(connection.qualificationState)}</dd></div><div><dt>Live panel</dt><dd>{label(connection.livePanelState)}</dd></div></dl>
        <ul>{connection.blockerCodes.map((blocker) => <li key={blocker}>{label(blocker)}</li>)}</ul>
        <footer>Inventory checked {connection.lastEvaluatedAt}. Signal freshness is separate from enrollment, qualification, and permission to run. References are view-only labels; location, SSH details, credentials, and private runtime values are withheld.</footer>
      </article>)}</div> : <div className="connection-center-empty"><span aria-hidden="true">◫</span><h3>No enrolled connections yet</h3>
        <p>The protected local roster is empty. Control Room will not invent a connection from installed software, a hostname, or a prior test.</p>
        <small>Enrollment, qualification, live-panel authority, and execution remain separate gates.</small></div>}
    </section>
    <p className="project-workspace-boundary" role="status">Connection Center is presentation-only. It cannot open SSH, read credentials, start Hermes, contact a provider, approve work, dispatch, or execute.</p>
  </>;
}

export function ConnectionCenter() {
  const [data, setData] = useState<ConnectionCenterDataStateV1>({ state: "loading" });
  useEffect(() => { let current = true; void fetchConnectionCenterV1().then((result) => { if (current) setData(result); });
    return () => { current = false; }; }, []);
  return <ConnectionCenterPanel data={data} />;
}
