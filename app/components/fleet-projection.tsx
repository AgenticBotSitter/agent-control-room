import type { JSX } from "react";
import type { FleetWorkerSummaryV1 } from "@/src/operator-surfaces/v1/types";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function platformMark(platform: FleetWorkerSummaryV1["platform"]): string {
  return platform === "macos" ? "M" : platform === "windows" ? "W" : platform === "linux" ? "L" : "C";
}

function capacity(worker: FleetWorkerSummaryV1): string {
  return worker.capacityState === "reported" ? `${worker.availableSlots}/${worker.totalSlots} slots available` : "Capacity is unavailable";
}

/** Renders only redacted fleet projection facts. It cannot imply a worker is dispatchable. */
export function FleetProjection(props: { workers: readonly FleetWorkerSummaryV1[] }): JSX.Element {
  const { workers } = props;
  if (workers.length === 0) return <p className="empty-state">No protected worker facts are currently recorded.</p>;
  return (
    <div className="worker-table" role="table" aria-label="Protected fleet projection">
      <div className="table-row table-head" role="row"><span>Worker</span><span>Observed state</span><span>Capacity</span><span>Capability</span><span>Telemetry</span></div>
      {workers.map((worker) => (
        <div className="table-row" role="row" key={worker.workerId}>
          <span className="worker-cell"><i className={`os-${worker.platform}`}>{platformMark(worker.platform)}</i><b>{worker.workerId}</b><small>{label(worker.platform)} · {worker.lastObservedAt}</small></span>
          <span><em className={`status-dot state-${worker.state}`} />{label(worker.state)}<small>{worker.stateReasonCode ? label(worker.stateReasonCode) : "No state reason recorded"}</small></span>
          <span>{capacity(worker)}<small>{worker.capacityState === "reported" ? "Reported capacity only" : "Not assumed from state"}</small></span>
          <span>{label(worker.capabilityState)}<small>No route or dispatch decision implied</small></span>
          <span>{label(worker.telemetryState)}<small>Last observation above</small></span>
        </div>
      ))}
    </div>
  );
}
