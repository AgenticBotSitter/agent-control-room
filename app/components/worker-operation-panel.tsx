import type { JSX } from "react";

export type WorkerOperationRequestV1 =
  | "request_drain"
  | "request_resume"
  | "request_quarantine";

export interface WorkerOperationRequestChoiceV1 {
  operation: WorkerOperationRequestV1;
  enabled: boolean;
  reason: string;
}

export interface WorkerOperationPanelModelV1 {
  schema: "control-room.worker-operation-panel/v1";
  workerId: string;
  nodeId: string;
  nodeVersion: number;
  nodeState: "active" | "draining" | "offline" | "quarantined" | "revoked";
  displayName: string;
  platform: "macos" | "windows" | "linux" | "cloud";
  state:
    | "online"
    | "idle"
    | "busy"
    | "draining"
    | "degraded"
    | "offline"
    | "maintenance"
    | "quarantined"
    | "revoked";
  stateReason?: string;
  lastHeartbeatAt: string;
  requests: readonly WorkerOperationRequestChoiceV1[];
}

const OPERATION_LABELS: Record<WorkerOperationRequestV1, string> = {
  request_drain: "Request drain",
  request_resume: "Request resume",
  request_quarantine: "Request quarantine",
};

function OperationButton(props: {
  choice: WorkerOperationRequestChoiceV1;
  onRequest(operation: WorkerOperationRequestV1): void;
}): JSX.Element {
  const { choice, onRequest } = props;
  return (
    <li>
      <button
        type="button"
        disabled={!choice.enabled}
        onClick={() => {
          if (choice.enabled) {
            onRequest(choice.operation);
          }
        }}
      >
        {OPERATION_LABELS[choice.operation]}
      </button>
      <p>{choice.reason}</p>
    </li>
  );
}

export function WorkerOperationPanel(props: {
  model: WorkerOperationPanelModelV1;
  onRequest(operation: WorkerOperationRequestV1): void;
}): JSX.Element {
  const { model, onRequest } = props;
  return (
    <section aria-label={`Worker operation requests for ${model.workerId}`}>
      <h2>{model.displayName}</h2>
      <dl>
        <dt>Worker</dt>
        <dd>{model.workerId}</dd>
        <dt>Platform</dt>
        <dd>{model.platform}</dd>
        <dt>Node</dt>
        <dd>{model.nodeId}</dd>
        <dt>Node version</dt>
        <dd>{model.nodeVersion}</dd>
        <dt>Node state</dt>
        <dd>{model.nodeState}</dd>
        <dt>State</dt>
        <dd>{model.state}</dd>
        {model.stateReason === undefined ? null : (
          <>
            <dt>State reason</dt>
            <dd>{model.stateReason}</dd>
          </>
        )}
        <dt>Last heartbeat at</dt>
        <dd>{model.lastHeartbeatAt}</dd>
      </dl>
      {model.requests.length === 0 ? (
        <p>No operations available.</p>
      ) : (
        <ul>
          {model.requests.map((choice) => (
            <OperationButton key={choice.operation} choice={choice} onRequest={onRequest} />
          ))}
        </ul>
      )}
      <p>
        Requests are intents only. They remain subject to server authority and
        confirmation; no operation is applied by this panel.
      </p>
    </section>
  );
}
