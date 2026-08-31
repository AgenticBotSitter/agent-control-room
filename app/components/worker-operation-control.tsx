"use client";

import { useRef, useState, type JSX } from "react";
import {
  WorkerOperationPanel,
  type WorkerOperationPanelModelV1,
  type WorkerOperationRequestV1,
} from "./worker-operation-panel";

interface OperationReceipt {
  requestId: string;
  operation: WorkerOperationRequestV1;
  state: "requested" | "applied" | "rejected";
  applied: boolean;
  safeResultCode?: string;
  resultingNodeVersion?: number;
}

const labels: Record<WorkerOperationRequestV1, string> = {
  request_drain: "drain",
  request_resume: "resume",
  request_quarantine: "quarantine",
};

function safeStatus(receipt: OperationReceipt): string {
  if (receipt.state === "applied") return `Node confirmed ${labels[receipt.operation]}. Node version ${receipt.resultingNodeVersion ?? "updated"}.`;
  if (receipt.state === "rejected") return `Node rejected the request${receipt.safeResultCode ? `: ${receipt.safeResultCode}` : "."}`;
  return "Request recorded. Waiting for signed node confirmation.";
}

export function WorkerOperationControl({ model }: { model: WorkerOperationPanelModelV1 }): JSX.Element {
  const [selection, setSelection] = useState<{ operation: WorkerOperationRequestV1; idempotencyKey: string }>();
  const [receipt, setReceipt] = useState<OperationReceipt>();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const readResponse = async (response: Response): Promise<OperationReceipt | undefined> => {
    const body = await response.json().catch(() => ({})) as Partial<OperationReceipt> & { error?: string };
    if (!response.ok || !body.requestId || !body.operation || !body.state || body.applied === undefined) {
      setStatus(`Request was not recorded${body.error ? `: ${body.error}` : "."}`);
      return undefined;
    }
    return body as OperationReceipt;
  };

  const submit = async () => {
    if (!selection || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setStatus("Recording request…");
    try {
      const response = await fetch(`/api/v1/nodes/${encodeURIComponent(model.nodeId)}/operations`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "idempotency-key": selection.idempotencyKey },
        body: JSON.stringify({
          operation: selection.operation,
          expectedNodeVersion: model.nodeVersion,
          ...(selection.operation === "request_quarantine" ? { safeReasonCode: "operator_security_review" } : {}),
        }),
      });
      const next = await readResponse(response);
      if (next) {
        setReceipt(next);
        setStatus(safeStatus(next));
        setSelection(undefined);
      }
    } catch {
      setStatus("Request service is unavailable.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!receipt || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setStatus("Checking signed node confirmation…");
    try {
      const response = await fetch(
        `/api/v1/nodes/${encodeURIComponent(model.nodeId)}/operations?request_id=${encodeURIComponent(receipt.requestId)}`,
        { credentials: "same-origin", cache: "no-store" },
      );
      const next = await readResponse(response);
      if (next) {
        setReceipt(next);
        setStatus(safeStatus(next));
      }
    } catch {
      setStatus("Confirmation service is unavailable.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div>
      <WorkerOperationPanel model={model} onRequest={(operation) => {
        setSelection({ operation, idempotencyKey: `ui-${crypto.randomUUID()}` });
        setStatus(undefined);
      }} />
      {selection ? (
        <section aria-label="Confirm worker operation request">
          <h3>Confirm request</h3>
          <p>
            Request {labels[selection.operation]} for node {model.nodeId} at version {model.nodeVersion}. This records an intent;
            the node must still confirm it.
          </p>
          <button type="button" disabled={busy} onClick={submit}>Confirm request</button>
          <button type="button" disabled={busy} onClick={() => setSelection(undefined)}>Cancel</button>
        </section>
      ) : null}
      {status ? <p role="status" aria-live="polite">{status}</p> : null}
      {receipt?.state === "requested" ? <button type="button" disabled={busy} onClick={refresh}>Check node confirmation</button> : null}
    </div>
  );
}
