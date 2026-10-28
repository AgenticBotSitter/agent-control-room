"use client";

import { useEffect, useRef, useState } from "react";
import { currentLoopGate, loopDocumentBinding, documentMatchesStatus, type LoopDecisionStatusV1,
  type LoopApprovalDocumentV1 } from "../../src/web/v1/improve-control-room-loop-attention-wire";
import { loopDecisionsBrowserClient as client } from "../../src/web/v1/improve-control-room-loop-decisions-browser-client";
import { clearsLoopAuthority, type FrozenLoopAction } from "../../src/web/v1/improve-control-room-loop-browser-client";
import { refreshSharedTaskAttention } from "./shared-task-attention";

type Operation = "confirm" | "approve" | "answer";
function gateIdentity(status: LoopDecisionStatusV1) {
  const gate = currentLoopGate(status);
  return JSON.stringify([status.request.projectId, status.request.requestId, status.display.runLinkId, status.display.localVersion,
    gate?.kind, gate?.kind === "confirm" ? [status.engine.requestSha256, status.engine.settingsSha256]
      : gate?.kind === "approve" ? status.engine.approval : gate?.kind === "question" ? status.engine.question : gate]);
}
export function ImprovementDecisions({ status, fresh, isFresh, writeEpoch, invalidate, refresh, clearAuthority }: {
  status: LoopDecisionStatusV1; fresh: boolean; isFresh(): boolean; writeEpoch: number; invalidate(): void; refresh(): void; clearAuthority(): void;
}) {
  const gate = currentLoopGate(status), identity = gateIdentity(status), documentKey = loopDocumentBinding(status);
  const [answer, setAnswer] = useState(""), [pending, setPending] = useState(false), [retry, setRetry] = useState(false), [notice, setNotice] = useState("");
  const [document, setDocument] = useState<LoopApprovalDocumentV1>(), [documentError, setDocumentError] = useState(false);
  const frozen = useRef<{ identity: string; operation: Operation; action: FrozenLoopAction } | undefined>(undefined);
  const latch = useRef(false), heading = useRef<HTMLHeadingElement>(null), current = useRef({ identity, fresh, writeEpoch, documentKey });
  current.current = { identity, fresh, writeEpoch, documentKey };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { frozen.current = undefined; setRetry(false); setNotice(""); setAnswer(""); if (gate && gate.kind !== "blocked") heading.current?.focus(); }, [identity]);
  // Keep one read per document binding. Ordinary status polls reuse the complete text.
  const canReadDocument = gate?.kind === "approve" && status.engine.state === "waiting" && status.display.confirmationCurrent;
  const documentRead = useRef<{ abort: AbortController; key: string; epoch: number } | undefined>(undefined);
  useEffect(() => {
    documentRead.current?.abort.abort(); documentRead.current = undefined;
    setDocument(undefined); setDocumentError(false);
    return () => { documentRead.current?.abort.abort(); };
  }, [documentKey, writeEpoch, canReadDocument]);
  useEffect(() => {
    if (!fresh || !canReadDocument || documentRead.current) return;
    const read = { abort: new AbortController(), key: documentKey, epoch: writeEpoch };
    documentRead.current = read;
    void client.readApprovalDocument(status, read.abort.signal).then(value => {
      if (!read.abort.signal.aborted && documentRead.current === read && current.current.writeEpoch === read.epoch
        && current.current.documentKey === read.key) setDocument(value);
    }).catch(error => {
      if (read.abort.signal.aborted || documentRead.current !== read) return;
      setDocumentError(true); if (clearsLoopAuthority(error)) clearAuthority();
    });
  }, [documentKey, writeEpoch, canReadDocument, fresh]);
  const enabled = fresh && !!gate && gate.kind !== "blocked" && !pending && (gate.kind === "confirm" || status.display.confirmationCurrent && status.engine.state === "waiting")
    && (gate.kind !== "question" || status.engine.question?.owner && !status.engine.question.changesInput && gate.text !== null)
    && (gate.kind !== "approve" || !!document && documentMatchesStatus(document, status));
  async function submit(operation: Operation, replay = false) {
    if (latch.current || !current.current.fresh || !isFresh() || !navigator.onLine) return;
    if (replay) {
      if (!frozen.current || frozen.current.identity !== identity || frozen.current.operation !== operation) return;
    } else {
      if (!enabled || frozen.current?.identity === identity || operation === "answer" && (!answer.trim() || answer.length > 8000)) return;
      const common = { expectedVersion: status.request.currentVersion, expectedRevision: status.engine.revision };
      const body = operation === "confirm" ? { ...common, requestSha256: status.engine.requestSha256, settingsSha256: status.engine.settingsSha256 }
        : operation === "approve" ? { ...common, ...status.engine.approval! }
          : { ...common, questionId: status.engine.question!.questionId, inputVersion: status.engine.question!.inputVersion,
            questionReportSha256: status.engine.question!.reportSha256, text: answer };
      frozen.current = { identity, operation, action: Object.freeze({ body: JSON.stringify(body), key: `loop-${operation}:${crypto.randomUUID()}` }) };
    }
    const action = frozen.current!.action;
    latch.current = true; setPending(true); setRetry(false); invalidate();
    try {
      const receipt = await client.command(status.request.projectId, status.request.requestId, operation, action);
      if (!mounted.current || current.current.identity !== identity) return;
      setRetry(receipt.state === "uncertain");
      setNotice(receipt.state === "refused" ? "The decision was refused. Refresh the saved request."
        : receipt.state === "uncertain" ? "The decision could not be confirmed. Check saved status before retrying."
          : "Decision received. Checking saved status…");
    } catch (error) {
      if (!mounted.current || current.current.identity !== identity) return;
      if (clearsLoopAuthority(error)) { frozen.current = undefined; setRetry(false); clearAuthority(); }
      else { setRetry(true); setNotice("The decision could not be confirmed. Check saved status before retrying."); }
    } finally {
      latch.current = false;
      if (mounted.current) { setPending(false); refresh(); void refreshSharedTaskAttention(); heading.current?.focus(); }
    }
  }
  if (!gate) return <p role="status">{status.display.confirmationCurrent ? "Saved confirmation is current." : "No current owner decision."}</p>;
  const textStyle = { whiteSpace: "pre-wrap" as const, overflowWrap: "anywhere" as const };
  return <section style={{ minWidth: 0, overflowWrap: "anywhere" }} aria-label="Saved owner decision">
    <h3 ref={heading} tabIndex={-1}>Saved owner decision</h3>
    {!fresh && <p role="alert">Decision controls are unavailable until saved status is fresh.</p>}
    {gate.kind === "blocked" ? <p role="alert">{gate.message}</p> : gate.kind === "confirm" ? <>
      {status.request.description !== status.engine.draft && <><p>Saved input (draft adoption pending):</p><p style={textStyle}>{status.request.description}</p></>}
      <p>Exact draft · Version {status.request.currentVersion}</p><p style={textStyle}>{status.engine.draft}</p>
      <p>Request SHA-256: {status.engine.requestSha256}</p><p>Settings SHA-256: {status.engine.settingsSha256}</p>
      <button style={{ minHeight: 44 }} disabled={!enabled || !!frozen.current} onClick={() => void submit("confirm")}>Confirm this exact request</button>
    </> : gate.kind === "approve" ? <>
      <p>{status.engine.approval!.step} · Input {String(status.engine.approval!.inputVersion)}</p>
      <p>Head: {status.engine.approval!.head}</p><p>Report SHA-256: {status.engine.approval!.reportSha256}</p>
      {document && documentMatchesStatus(document, status) ? <pre style={textStyle}>{document.text}</pre>
        : <p role={documentError ? "alert" : "status"}>{documentError ? "The complete sealed document is unavailable. Refresh saved status." : "Loading the complete sealed document…"}</p>}
      <button style={{ minHeight: 44 }} disabled={!enabled || !!frozen.current} onClick={() => void submit("approve")}>Approve this {status.engine.approval!.step}</button>
    </> : <>
      <p style={textStyle}>{gate.text}</p>
      {status.engine.question?.changesInput ? <p role="alert">This question changes inputs. Ask the lead to pause the run and renew the affected confirmation and plan/spec approvals.</p>
        : !status.engine.question?.owner ? <p>This technical question is waiting for the orchestrator. No owner answer is requested.</p> : <>
          <label htmlFor="loop-owner-answer">Your answer</label>
          <textarea id="loop-owner-answer" rows={5} maxLength={8000} value={answer} disabled={!fresh || pending || !!frozen.current}
            onChange={event => setAnswer(event.target.value)} style={{ width: "100%", maxWidth: "100%" }} />
          <button style={{ minHeight: 44 }} disabled={!enabled || !answer.trim() || !!frozen.current} onClick={() => void submit("answer")}>Send answer</button>
        </>}
    </>}
    {notice && <p role={retry ? "alert" : "status"} aria-live="polite">{notice}</p>}
    {retry && frozen.current?.identity === identity && <button style={{ minHeight: 44 }} disabled={!fresh || pending}
      onClick={() => void submit(frozen.current!.operation, true)}>Retry this exact {frozen.current.operation === "answer" ? "answer" : frozen.current.operation === "confirm" ? "confirmation" : "approval"}</button>}
  </section>;
}
