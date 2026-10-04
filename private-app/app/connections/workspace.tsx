"use client";
import { useState, type ReactNode } from "react";
import { ConnectionCenterPanel } from "../../../app/components/connection-center";
import { ConnectionBrowserError, readPrivateConnections, type PrivateConnectionSnapshot } from "../../../src/web/v1/connection-browser-client";
import { PrivateHeader } from "../private-header";
import { PrivateOperatorCapacityWorkspace } from "../operator-capacity-workspace";
import { useInstallationTopology } from "../installation-topology";
import { InstallationTopologySummary } from "../installation-topology-summary";
import { LocalWorkerRouteStatus } from "../local-worker-route-status";
import { usePolledRead } from "../use-polled-read";
import { HostedWorkersBoard } from "../workers/workers-board";

export type PrivateConnectionViewState = { state: "loading" } | { state: "ready"; snapshot: PrivateConnectionSnapshot }
  | { state: "unavailable"; code: ConnectionBrowserError["code"] };

export function PrivateConnectionView({ data, onRefresh, children }: { data: PrivateConnectionViewState; onRefresh: () => void; children?: ReactNode }) {
  const unavailableCopy = data.state === "unavailable" ? {
    authentication_required: {
      heading: "Your session has ended",
      message: "Your session ended before the connection inventory could be read. Sign in again; no sample data is shown.",
    },
    access_denied: {
      heading: "Owner access is required",
      message: "Your account is not allowed to view the connection inventory. No sample data is shown.",
    },
    not_found: {
      heading: "Connection inventory is not served here",
      message: "This installation does not serve the connection inventory. No sample data is shown.",
    },
    unavailable: {
      heading: "Connection inventory unavailable",
      message: "The saved inventory could not be verified, or its private setup is not configured. No sample or old connection data is shown.",
    },
  }[data.code] : undefined;
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <div className="private-heading"><h1>Connections</h1><p>Saved enrollments and their last verified signals.</p>
      <p>This inventory covers all workspaces in this Control Room account.</p></div>
    {children}
    <p className="private-note">This is the existing Hermes 0.21 enrollment inventory, not a live fleet monitor.
      Saved setup plans and verified worker signals are shown separately so a planned route is never presented as a running agent.</p>
    <p className="private-note">Worker platform details, eligible capabilities, available slots, current work and usage are not part of this inventory.
      The operator capacity panel below shows the recorded capacity and outcome evidence, read separately and read-only. Cancel and resume are unsupported here. Open a prepared task to see only the assignment choices that its configured service can actually verify.</p>
    <div className="private-actions"><button type="button" onClick={onRefresh} disabled={data.state === "loading"}>Refresh connections</button></div>
    {data.state === "unavailable" ? <section className="private-notice">
      <h2>{unavailableCopy!.heading}</h2>
      {/* The live region is the two sentences that state the failure. The
        * recovery link sits outside it, so navigating to it does not drag the
        * control into the announcement and re-rendering the 30s poll does not
        * re-announce it. */}
      <div role="alert">
        <p>{unavailableCopy!.message}</p>
      </div>
      {data.code === "authentication_required" && <><p>Signing in again through Access logout also ends Access sessions for other protected applications.</p>
        <a href="/cdn-cgi/access/logout">Sign in again</a></>}
    </section> : <>
      {data.state === "ready" && <p className="private-note">Last checked {data.snapshot.projection.generatedAt}. Signals describe that check, not continuous availability.
        {data.snapshot.telemetry === "not_configured" && " Signal verification is not configured; no current signal is claimed."}</p>}
      <ConnectionCenterPanel data={data.state === "loading" ? { state: "loading" } : { state: "available", projection: data.snapshot.projection }} />
    </>}
    {/* Operator capacity, mounted read-only under the inventory. A single mount
        point here covers both render paths: PrivateConnections renders this
        view, so /workers and /connections both show the panel exactly once.
        The panel runs its own independent read with its own loading and
        unavailable states; this inventory's state never gates it. */}
    <PrivateOperatorCapacityWorkspace />
  </main></div>;
}

export function PrivateConnections({ children }: { children?: ReactNode } = {}) {
  const [refresh, setRefresh] = useState(0);
  const installationTopology = useInstallationTopology();
  // The shared polling hook owns the schedule: it pauses while the tab is
  // hidden, refreshes on focus, never overlaps a read, and backs off when
  // nothing changes or a read fails.
  const read = usePolledRead<PrivateConnectionViewState>({
    key: `private-connections-${refresh}`,
    baseIntervalMs: 30_000,
    read: async (signal, transport) => {
      try { return { state: "ready" as const, snapshot: await readPrivateConnections(transport, signal) }; }
      catch (error) {
        return { state: "unavailable" as const,
          code: error instanceof ConnectionBrowserError ? error.code : "unavailable" as const };
      }
    },
  });
  const data: PrivateConnectionViewState = read.value ?? { state: "loading" };
  return <PrivateConnectionView data={data} onRefresh={() => { void read.refresh(); setRefresh(value => value + 1); }}>
    {/* Plain status board leads (owner-ux-feedback-2026-09-27.md); the
        installation and route-setup panels below it are detail, not the
        first thing an owner needs to scan. */}
    <HostedWorkersBoard />
    <InstallationTopologySummary setup={installationTopology?.setup} status={installationTopology?.state} />
    <LocalWorkerRouteStatus setup={installationTopology?.setup} state={installationTopology?.state ?? "loading"} />
    {children}
  </PrivateConnectionView>;
}
