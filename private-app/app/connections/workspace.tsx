"use client";
import { useEffect, useState } from "react";
import { ConnectionCenterPanel } from "../../../app/components/connection-center";
import { ConnectionBrowserError, readPrivateConnections, type PrivateConnectionSnapshot } from "../../../src/web/v1/connection-browser-client";
import { PrivateHeader } from "../private-header";

export type PrivateConnectionViewState = { state: "loading" } | { state: "ready"; snapshot: PrivateConnectionSnapshot }
  | { state: "unavailable"; code: ConnectionBrowserError["code"] };

export function PrivateConnectionView({ data, onRefresh }: { data: PrivateConnectionViewState; onRefresh: () => void }) {
  return <div className="private-shell"><PrivateHeader /><main id="private-main">
    <div className="private-heading"><h1>Connections</h1><p>Saved enrollments and their last verified signals.</p>
      <p>This inventory covers all workspaces in this Control Room account.</p></div>
    <p className="private-note">This is the existing Hermes 0.21 enrollment inventory, not a live fleet monitor.
      The new cross-machine agent connection and task runner are not connected here yet.</p>
    <div className="private-actions"><button type="button" onClick={onRefresh} disabled={data.state === "loading"}>Refresh connections</button></div>
    {data.state === "unavailable" ? <section className="private-notice" role="alert">
      <h2>{data.code === "authentication_required" ? "Your session has ended" : data.code === "access_denied" ? "Owner access is required" : "Connection inventory unavailable"}</h2>
      <p>{data.code === "unavailable" ? "The saved inventory could not be verified, or its private setup is not configured. No sample or old connection data is shown." : "Sign in with an account allowed to view the connection inventory."}</p>
      {data.code === "authentication_required" && <><p>Signing in again through Access logout also ends Access sessions for other protected applications.</p>
        <a href="/cdn-cgi/access/logout">Sign in again</a></>}
    </section> : <>
      {data.state === "ready" && <p className="private-note">Last checked {data.snapshot.projection.generatedAt}. Signals describe that check, not continuous availability.
        {data.snapshot.telemetry === "not_configured" && " Signal verification is not configured; no current signal is claimed."}</p>}
      <ConnectionCenterPanel data={data.state === "loading" ? { state: "loading" } : { state: "available", projection: data.snapshot.projection }} />
    </>}
  </main></div>;
}

export function PrivateConnections() {
  const [data, setData] = useState<PrivateConnectionViewState>({ state: "loading" });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true, generation = 0;
    const load = async () => {
      const current = ++generation;
      setData({ state: "loading" });
      try {
        const snapshot = await readPrivateConnections();
        if (live && current === generation) setData({ state: "ready", snapshot });
      } catch (error) {
        if (live && current === generation) setData({ state: "unavailable", code: error instanceof ConnectionBrowserError ? error.code : "unavailable" });
      }
    };
    void load();
    const interval = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    const focus = () => { void load(); };
    window.addEventListener("focus", focus);
    return () => { live = false; generation++; clearInterval(interval); window.removeEventListener("focus", focus); };
  }, [refresh]);
  return <PrivateConnectionView data={data} onRefresh={() => setRefresh(value => value + 1)} />;
}
