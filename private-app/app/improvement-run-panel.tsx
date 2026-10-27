"use client";

import { useEffect, useRef, useState } from "react";
import type { LoopImprovementRequestViewV1, LoopImprovementStatusV1 } from "../../src/improve-control-room/v1/schemas";
import { clearsLoopAuthority, loopImprovementBrowserClient as client, LoopReadError,
  type FrozenLoopAction } from "../../src/web/v1/improve-control-room-loop-browser-client";
import { usePolledRead } from "./use-polled-read";

const binding = (row: LoopImprovementRequestViewV1) => JSON.stringify([row.projectId, row.requestId,
  row.runLink?.runLinkId, row.currentVersion, row.description, row.requestSha256, row.settingsSha256]);
const matches = (row: LoopImprovementRequestViewV1, status: LoopImprovementStatusV1) =>
  status.runLinkId === row.runLink?.runLinkId
  && status.localVersion === row.currentVersion && status.description === row.description
  && status.requestSha256 === row.requestSha256 && status.settingsSha256 === row.settingsSha256;

export function ImprovementRunPanel({ projectId, requests, fresh }: {
  projectId: string; requests: LoopImprovementRequestViewV1[]; fresh: boolean;
}) {
  const [selection, setSelection] = useState<string>();
  useEffect(() => {
    const select = () => {
      const fragment = window.location.hash;
      try { setSelection(fragment.startsWith("#request=") ? decodeURIComponent(fragment.slice(9)) : undefined); }
      catch { setSelection(""); }
    };
    select(); window.addEventListener("hashchange", select);
    return () => window.removeEventListener("hashchange", select);
  }, [projectId]);
  const selected = selection === undefined ? requests[0] : requests.find(row => row.requestId === selection);
  return <section className="private-panel" aria-label="Saved loop work" style={{ overflowWrap: "anywhere", minWidth: 0 }}>
    <h2>Saved loop work</h2>
    {requests.length ? <ul className="private-dashboard-list">{requests.map(row => <li key={row.requestId}>
      <a href={`/projects/${encodeURIComponent(projectId)}/improvements#request=${encodeURIComponent(row.requestId)}`}
        onClick={() => setSelection(row.requestId)}>{row.description}</a>
    </li>)}</ul> : <p>No saved loop requests.</p>}
    {selection !== undefined && !selected ? <p role="alert">This saved request is unavailable.</p>
      : selected ? <SelectedRun key={binding(selected)} row={selected} fresh={fresh} focus={selection !== undefined} /> : null}
  </section>;
}

function SelectedRun({ row, fresh, focus }: { row: LoopImprovementRequestViewV1; fresh: boolean; focus: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focus) { heading.current?.focus(); heading.current?.scrollIntoView?.({ block: "nearest" }); } }, [focus]);
  const [epoch, setEpoch] = useState(0), writeEpoch = useRef(0), revision = useRef(-1);
  const [safe, setSafe] = useState<LoopImprovementStatusV1>();
  const safeRef = useRef<LoopImprovementStatusV1 | undefined>(undefined);
  const actions = useRef<{ start?: FrozenLoopAction; stop?: FrozenLoopAction }>({});
  const latch = useRef({ start: false, stop: false });
  const [pending, setPending] = useState({ start: false, stop: false });
  const [notices, setNotices] = useState<{ start?: string; stop?: string }>({});
  const [retry, setRetry] = useState({ start: false, stop: false });
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const identity = binding(row);
  const clearProtected = () => { safeRef.current = undefined; setSafe(undefined); actions.current = {}; setRetry({ start: false, stop: false }); setNotices({}); };
  const read = usePolledRead({ key: `loop-status:${identity}:${epoch}`, shareKey: `loop-status:${identity}:${epoch}`,
    baseIntervalMs: 30_000, enabled: !!row.runLink, dropValueOnError: true,
    read: async signal => {
      const captured = writeEpoch.current;
      const status = await client.readStatus(row.projectId, row.requestId, signal);
      if (!matches(row, status)) throw new LoopReadError(0, true);
      if (captured !== writeEpoch.current || signal.aborted || status.engineRevision === null
        || status.engineRevision < revision.current || safeRef.current?.state === "stopped" && status.state !== "stopped") throw new LoopReadError(0);
      revision.current = status.engineRevision;
      return status;
    },
    onAccept: status => { safeRef.current = status; setSafe(status); },
    onFailure: error => { if (clearsLoopAuthority(error)) clearProtected(); },
  });
  const current = read.value;
  const statusFresh = fresh && !!current && !read.loading && !read.checking && !read.error && matches(row, current);
  const canStart = statusFresh && current.canStart && current.confirmationCurrent && current.startState === "not_started"
    && !actions.current.start && !pending.start && !pending.stop;
  const snapshot = current ?? safe;
  const stopTarget = snapshot?.canStop && snapshot.runLinkId && snapshot.state !== "stopped" && snapshot.state !== "candidate_ready";
  async function submit(operation: "start" | "stop", replay = false) {
    if (latch.current[operation] || !navigator.onLine || !row.runLink) return;
    if (replay) {
      if (!actions.current[operation] || operation === "start" && !statusFresh || operation === "stop" && !stopTarget) return;
    } else {
      if (operation === "start" ? !canStart : !stopTarget || !!actions.current.stop) return;
      actions.current[operation] = Object.freeze({ key: `loop-${operation}:${crypto.randomUUID()}`,
        body: JSON.stringify(operation === "start" ? { expectedVersion: row.currentVersion, runLinkId: row.runLink.runLinkId,
          expectedRevision: current!.engineRevision } : { runLinkId: row.runLink.runLinkId }) });
    }
    const action = actions.current[operation]!;
    latch.current[operation] = true;
    setPending(value => ({ ...value, [operation]: true }));
    setRetry(value => ({ ...value, [operation]: false }));
    writeEpoch.current += 1; setEpoch(writeEpoch.current); read.clear();
    try {
      const receipt = await client[operation](row.projectId, row.requestId, action);
      if (receipt.localVersion !== row.currentVersion && operation === "start") throw new LoopReadError(0, true);
      if (!mounted.current) return;
      setNotices(value => ({ ...value, [operation]: receipt.state === "refused" ? "The command was refused. Check status."
        : operation === "stop" ? "Stop requested" : "Start requested; check saved progress." }));
      setRetry(value => ({ ...value, [operation]: receipt.state === "uncertain" }));
    } catch (error) {
      if (!mounted.current) return;
      if (clearsLoopAuthority(error)) { clearProtected(); read.clear(); writeEpoch.current += 1; setEpoch(writeEpoch.current); }
      else {
        setNotices(value => ({ ...value, [operation]: operation === "start"
          ? "Start could not be confirmed; check status" : "Stop could not be confirmed; check status" }));
        setRetry(value => ({ ...value, [operation]: true }));
      }
    } finally {
      latch.current[operation] = false;
      if (mounted.current) { setPending(value => ({ ...value, [operation]: false })); read.refresh(); }
    }
  }
  return <div>
    <h3 ref={heading} tabIndex={-1}>Saved request</h3>
    <p style={{ whiteSpace: "pre-wrap" }}>{row.description}</p>
    {!row.runLink ? <p>Confirmation and a linked run are needed before Start.</p> : <>
      <p role="status" aria-live="polite">{snapshot?.state === "candidate_ready" ? "Finished candidate" : snapshot?.state === "stopped" ? "Stopped"
        : snapshot?.state?.replaceAll("_", " ") ?? "Status unavailable"}</p>
      <p>{snapshot?.confirmationCurrent ? "Confirmation current" : "Confirmation needed"}</p>
      <p>Step: {snapshot?.progress?.stepId ?? "Unavailable"} · Role: {snapshot?.progress?.role ?? "Unavailable"}</p>
      <p>Requested model: {snapshot?.progress?.requestedModel ?? "Unavailable"}</p>
      <p>Observed model: {snapshot?.progress?.identityVerified ? snapshot.progress.observedModel ?? "Unavailable" : "Unverified"}</p>
      <p>Attempt: {snapshot?.progress?.attempt ?? "Unavailable"} · Repairs: {snapshot?.progress?.repairCount ?? "Unavailable"}</p>
      {snapshot?.attention && <div className="private-notice"><p>{snapshot.attention.message}</p><p>{snapshot.attention.nextAction}</p></div>}
      {snapshot && <p>Last checked <time dateTime={snapshot.observedAt}>{snapshot.observedAt}</time></p>}
      {(read.error || !fresh) && <p role="alert">Could not refresh saved progress.</p>}
      {read.checking && <p role="status">Checking saved progress…</p>}
      <button type="button" disabled={!canStart} onClick={() => void submit("start")}>Start confirmed work</button>{" "}
      <button type="button" disabled={!stopTarget || pending.stop || !!actions.current.stop} onClick={() => void submit("stop")}>Stop this run</button>{" "}
      <button type="button" onClick={read.refresh}>Refresh status</button>
      {notices.start && <p role={retry.start ? "alert" : "status"}>{notices.start}</p>}
      {notices.stop && snapshot?.state !== "stopped" && <p role={retry.stop ? "alert" : "status"}>{notices.stop}</p>}
      {retry.start && <button type="button" disabled={!statusFresh || pending.start || snapshot?.state === "stopped"} onClick={() => void submit("start", true)}>Retry this exact Start</button>}
      {retry.stop && <button type="button" disabled={!stopTarget || pending.stop} onClick={() => void submit("stop", true)}>Retry this exact Stop</button>}
    </>}
  </div>;
}
