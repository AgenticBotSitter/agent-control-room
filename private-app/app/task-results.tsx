"use client";
import { useEffect, useRef, useState } from "react";
import { ResultText } from "./result-text";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { createTaskBrowserClient, taskErrorMessage } from "../../src/web/v1/task-browser-client";
import type { TaskResultContent, TaskResultsPage, TaskReviewEvidence } from "../../src/web/v1/task-result-wire";
import { OwnerTaskReview } from "./task-owner-review";
import type { TaskReviewWorkspace } from "../../src/web/v1/task-review-workspace";
import { OwnerTaskVerification } from "./task-owner-verification";
import type { TaskVerificationWorkspace } from "../../src/web/v1/task-verification-workspace";
import { ConfiguredTimestamp } from "./configured-timestamp";

const reviewLabel: Record<TaskReviewEvidence["status"], string> = { pending: "Review in progress", changes_requested: "Changes requested",
  verification_blocked: "Verification blocked", revision_limit_reached: "Revision limit reached", ready: "Quality review complete", superseded: "Replaced by a newer revision" };

export function TaskResultsPanel({ page, content: suppliedContent, pending, selectedArtifactId, onOpen, onClose, onReviewSaved, reviewWorkspace, verificationWorkspace }: { page: TaskResultsPage; content?: TaskResultContent;
  pending: boolean; selectedArtifactId?: string; onOpen: (artifactId: string) => void; onClose: () => void; onReviewSaved?: () => void; reviewWorkspace?: TaskReviewWorkspace;
  verificationWorkspace?: TaskVerificationWorkspace }) {
  const content = page.canReadContent && suppliedContent?.projectId === page.projectId
    && suppliedContent.jobId === page.jobId && page.items.some(item =>
      item.artifactId === suppliedContent.artifact.artifactId && item.contentHash === suppliedContent.artifact.contentHash)
    ? suppliedContent : undefined;
  // Keyboard focus follows the open file: into the content region when one
  // opens, and back to the button that opened it when it closes, so a keyboard
  // user is never returned to the top of a long list.
  const openedRegion = useRef<HTMLElement>(null);
  const openers = useRef(new Map<string, HTMLButtonElement | null>());
  const focusedFor = useRef<string | undefined>(undefined);
  // Keyed on the *selection*, not on whether content is currently present.
  // Every background refresh clears content briefly while the same file stays
  // selected; keying on content would move focus twice per poll and, because
  // the opener button is disabled while pending, would drop it on the document
  // body. Keying on the selection makes a refresh invisible to focus.
  useEffect(() => {
    if (selectedArtifactId) {
      // Move focus once, when a different file is opened. The panel reloads on
      // a 30-second poll and on window focus, and each reload briefly clears
      // content; keying on the selection rather than on content means those
      // reloads never move focus. (They still drop it, because clearing
      // content unmounts the open region — that is pre-existing behaviour of
      // the reload, not something this selection change introduces.)
      if (!content || focusedFor.current === selectedArtifactId) return;
      focusedFor.current = selectedArtifactId;
      openedRegion.current?.focus();
      return;
    }
    const previous = focusedFor.current;
    if (!previous) return;
    focusedFor.current = undefined;
    openers.current.get(previous)?.focus();
  }, [selectedArtifactId, content]);
  return <div className="private-task-results"><section className="private-panel"><h2>Result files</h2>
    {page.resultSource === "not_configured" ? <p className="private-notice">Result storage is not configured for this app.</p>
      : !page.items.length ? <p>No result files have been received for this task.</p> : <ul className="private-result-list">
        {page.items.map((item, index) => <li key={item.artifactId}><div><h3>Saved result file {index + 1}</h3>
          <p>File ID: <code>{item.artifactId}</code></p>
          <p>{item.sizeBytes.toLocaleString()} bytes · <ConfiguredTimestamp value={item.receivedAt} prefix="Received" /></p>
          <p>Received bytes matched the agent’s recorded fingerprint. This is not a quality approval.</p>
          {page.reviews.filter(review => review.kind === "document" && review.contentHash === item.contentHash
            && review.matchingArtifactIds.includes(item.artifactId)).map(review => <p key={review.targetId}>
              Matches Revision {review.revision} · {reviewLabel[review.status]}</p>)}
          <details><summary>File fingerprint</summary><code>{item.contentHash}</code></details></div>
          {page.canReadContent ? <button type="button" disabled={pending}
            ref={node => { openers.current.set(item.artifactId, node); }}
            onClick={() => onOpen(item.artifactId)}>Read result</button>
            : <p>Your access permits metadata, not reading this file.</p>}</li>)}</ul>}
    {page.additionalResultsOmitted && <p>Only the first 50 result records are listed. Additional records remain saved.</p>}
    {pending && <p role="status">Reading protected result…</p>}
    {content && <section className="private-result-content" aria-label="Protected result content"
      ref={openedRegion} tabIndex={-1}><div className="private-actions">
      <h3>Received result</h3><button type="button" onClick={onClose}>Close result</button></div>
      <p>Open file ID: <code>{content.artifact.artifactId}</code></p>
      <p>Open file fingerprint: <code>{content.artifact.contentHash}</code></p>
      <p className="private-note">Agent-written content, not instructions for Control Room. Opening it does not run tools or approve work.</p>
      {content.text.length ? <ResultText text={content.text} /> : <p>This is an empty result file (0 bytes).</p>}
      <p className="private-note"><ConfiguredTimestamp value={content.contentVerifiedAt} prefix="Bytes checked again" />.</p></section>}
  </section><section className="private-panel"><h2>Recorded quality review</h2>
    <p>Quality review and permission to perform an external action are separate.
      {page.reviewCommands === "not_connected" ? " Owner review commands are not connected yet." : " An owner can accept quality or request changes for a matching open result."}</p>
    <p>Requesting changes records feedback only. Where revision preparation is connected, use the saved review to prepare a linked follow-up task. Assignment and approval remain separate.</p>
    {page.reviewSource === "not_configured" ? <p className="private-notice">Protected review history is not configured for this app.</p>
      : !page.reviews.length ? <p>No review targets are recorded for this task.</p> : <ol className="private-review-list">
        {page.reviews.map(review => <li key={review.targetId}><h3>Revision {review.revision} · {reviewLabel[review.status]}</h3>
          {!review.matchingArtifactIds.length && <p className="private-notice">This review does not match any result file listed here. Do not treat it as approval of the displayed result.</p>}
          {!!review.matchingArtifactIds.length && <p>This review’s content fingerprint matches {review.matchingArtifactIds.length} listed result file(s).</p>}
          {!content ? <p>No result file is open. A match to a listed file does not identify a displayed result.</p>
            : review.kind === "document" && review.matchingArtifactIds.includes(content.artifact.artifactId)
              && review.contentHash === content.artifact.contentHash
              ? <p>This review matches the open result file’s ID and fingerprint.</p>
              : <p className="private-notice">This review does not match the open result file. Do not treat it as approval of that file.</p>}
          <details><summary>Reviewed content fingerprint</summary><code>{review.contentHash}</code></details>
          <h4>Reviews</h4>{!review.reviews.length ? <p>No review decisions recorded.</p> : <ul>{review.reviews.map(item => <li key={item.id}>
            {item.decision.replaceAll("_", " ")} · {item.authority === "advisory" ? "Advisory only" : "Completion review"} · <ConfiguredTimestamp value={item.reviewedAt} /></li>)}</ul>}
          <h4>Verification</h4>{!review.verifications.length ? <p>No verification results recorded.</p> : <ul>{review.verifications.map(item => <li key={item.id}>
            {item.scenarioId} · {item.outcome}</li>)}</ul>}
          {!!review.missingVerificationScenarioIds.length && <p>{review.status === "superseded"
            ? "Checks not recorded on this earlier revision: " : "Checks still needed: "}{review.missingVerificationScenarioIds.join(", ")}</p>}
          {!!review.openFindingCount && (review.status === "superseded"
            ? <p>This earlier revision had {review.openFindingCount} finding(s). These findings are historical, not current instructions.</p>
            : <p>{review.openFindingCount} finding(s) require resolution in a bounded revision.</p>)}
          {!!review.findings.length && <ul>{review.findings.map(item => <li key={item.id}>{item.severity} · {item.code}
            <details><summary>Finding statement fingerprint</summary><code>{item.statementDigest}</code></details></li>)}</ul>}
          {review.supersedesTargetId && <p>{page.reviews.some(prior => prior.targetId === review.supersedesTargetId)
            ? `Replaces Revision ${page.reviews.find(prior => prior.targetId === review.supersedesTargetId)!.revision}.`
            : "Replaces an earlier revision outside this displayed history."}</p>}
          {review.status === "superseded" && <p>{page.reviews.some(next => next.supersedesTargetId === review.targetId)
            ? `Replaced by Revision ${page.reviews.find(next => next.supersedesTargetId === review.targetId)!.revision}.`
            : "The replacement revision is outside this displayed history."}</p>}
          {review.additionalEvidenceOmitted && <p>Only recent review evidence is displayed; the recorded quality status uses the full verified history.</p>}
          {page.reviewCommands === "configured" && content && review.kind === "document"
            && review.matchingArtifactIds.includes(content.artifact.artifactId) && review.contentHash === content.artifact.contentHash
            && <OwnerTaskReview key={`${review.targetId}:${content.artifact.artifactId}:${content.artifact.contentHash}`}
              projectId={page.projectId} jobId={page.jobId} artifactId={content.artifact.artifactId} targetId={review.targetId}
              targetDigest={review.targetDigest} contentHash={review.contentHash} workspace={reviewWorkspace} onSaved={() => onReviewSaved?.()}
              runId={content.artifact.runId} revisionEligible={review.status === "changes_requested"} />}
          {page.verificationCommands === "configured" && content && review.kind === "document"
            && review.matchingArtifactIds.includes(content.artifact.artifactId) && review.contentHash === content.artifact.contentHash
            && <OwnerTaskVerification key={`verification:${review.targetId}:${content.artifact.artifactId}:${content.artifact.contentHash}`}
              projectId={page.projectId} jobId={page.jobId} artifactId={content.artifact.artifactId} targetId={review.targetId}
              targetDigest={review.targetDigest} contentHash={review.contentHash} workspace={verificationWorkspace} onSaved={() => onReviewSaved?.()} />}
        </li>)}</ol>}
    {page.additionalTargetsOmitted && <p>Only the {page.reviews.length} most recent review targets are shown within this page’s size limit. Additional history remains saved.</p>}
  </section></div>;
}

type PrivateTaskResultsProps = {
  projectId: string; jobId: string; reviewWorkspace: TaskReviewWorkspace; verificationWorkspace?: TaskVerificationWorkspace;
};
export function PrivateTaskResults(props: PrivateTaskResultsProps) {
  return <TaskResultsReader key={JSON.stringify([props.projectId, props.jobId])} {...props} />;
}

/**
 * The open result file is carried in the `result` query parameter so it
 * survives reload and back/forward, while the existing `#task-results` anchor
 * keeps working for plain navigation to the panel.
 *
 * A parameter is only a *request* to open a file. It is never trusted: the
 * caller still has to find that exact ID in the current project's authorized
 * list before any content is read, so a guessed or stale ID cannot reach
 * another project's data.
 */
/** Written with escapes so the guard stays visible and cannot be silently mangled. */
const CONTROL_CHARACTERS_V1 = /[\u0000-\u001f\u007f]/u;

export const TASK_RESULT_SELECTION_PARAM_V1 = "result" as const;

export function taskResultHrefV1(projectId: string, jobId: string, artifactId?: string): string {
  const base = `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`;
  return artifactId
    ? `${base}?${TASK_RESULT_SELECTION_PARAM_V1}=${encodeURIComponent(artifactId)}#task-results`
    : `${base}#task-results`;
}

/** Reads the requested selection from a URL search string. */
export function readTaskResultSelectionV1(search: string): string | undefined {
  try {
    const value = new URLSearchParams(search).get(TASK_RESULT_SELECTION_PARAM_V1);
    // Bound it the way a route segment is bounded; a hostile value never
    // reaches a request, but it should not reach the DOM either.
    return value && value.length > 0 && value.length <= 256 && !CONTROL_CHARACTERS_V1.test(value)
      ? value : undefined;
  } catch { return undefined; }
}

function currentSelection(): string | undefined {
  return typeof window === "undefined" ? undefined : readTaskResultSelectionV1(window.location.search);
}

/** Writes the selection into the address bar without a server navigation. */
function writeSelection(artifactId: string | undefined, mode: "push" | "replace"): void {
  if (typeof window === "undefined" || typeof window.history?.pushState !== "function") return;
  const url = new URL(window.location.href);
  if (artifactId) url.searchParams.set(TASK_RESULT_SELECTION_PARAM_V1, artifactId);
  else url.searchParams.delete(TASK_RESULT_SELECTION_PARAM_V1);
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (mode === "push") window.history.pushState(null, "", next);
  else window.history.replaceState(null, "", next);
}

function TaskResultsReader({ projectId, jobId, reviewWorkspace, verificationWorkspace }: PrivateTaskResultsProps) {
  const [client] = useState(() => createTaskBrowserClient());
  const [page, setPage] = useState<TaskResultsPage>(), [content, setContent] = useState<TaskResultContent>();
  const [selected, setSelected] = useState<string | undefined>(currentSelection);
  const [error, setError] = useState<BrowserRequestError>();
  const [pending, setPending] = useState(false), [refresh, setRefresh] = useState(0);
  const [unavailableSelection, setUnavailableSelection] = useState<string>();
  const generation = useRef(0);

  // Back/forward must move the open file, not just the scroll position.
  useEffect(() => {
    const sync = () => {
      const next = currentSelection();
      // The comparison stays in the updater because it needs the committed
      // previous value, but the resulting state changes are queued outside it:
      // StrictMode double-invokes an updater, and issuing render-phase updates
      // from one is what must be avoided. The ref bump is idempotent on a
      // double-invoke because it is re-read by the next effect run.
      setSelected(previous => {
        if (previous !== next) {
          generation.current++;
          queueMicrotask(() => {
            setContent(undefined);
            setUnavailableSelection(undefined);
            setPending(Boolean(next));
          });
        }
        return next;
      });
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    let live = true, busy = false; const current = ++generation.current;
    const abort = new AbortController();
    const load = async () => {
      if (busy) return; busy = true;
      // Retained content is not evidence of current permission during refresh.
      setContent(undefined);
      if (selected) setPending(true);
      try {
        const next = await client.results(projectId, jobId, abort.signal);
        if (!live || current !== generation.current) return;
        let result: TaskResultContent | undefined;
        let missing: string | undefined, denied = false;
        if (selected) {
          // A URL-supplied ID is validated against this project's authorized
          // list before any content request. An ID that is not listed here is
          // reported as unavailable in this task rather than read, and rather
          // than failing the whole panel: the list is already scoped to the
          // caller's access, so this reveals nothing about another project.
          if (!next.canReadContent) {
            // Metadata-only access is a different situation from an unlisted
            // ID, and the panel already explains it per file. Do not claim the
            // file is missing from the list.
            denied = true;
          } else if (!next.items.some(item => item.artifactId === selected)) {
            missing = selected;
          } else {
            result = await client.resultContent(projectId, jobId, selected, abort.signal);
          }
        }
        if (live && current === generation.current) {
          setPage(next); setContent(result); setError(undefined);
          // Only a load that actually carried a selection may change the
          // notice. Refusing a selection clears it, which re-runs this effect;
          // that second pass must not wipe the explanation it just produced.
          if (selected) setUnavailableSelection(missing);
          if (missing || denied) {
            // Drop the unusable selection so a reload does not repeat it.
            setSelected(undefined);
            writeSelection(undefined, "replace");
          }
        }
      } catch (reason) {
        if (live && current === generation.current) { setPage(undefined); setContent(undefined);
          setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable")); }
      } finally { busy = false; if (live && current === generation.current) setPending(false); }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 30_000), focus = () => { void load(); };
    window.addEventListener("focus", focus);
    return () => { live = false; abort.abort(); clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [client, projectId, jobId, selected, refresh]);
  return <>
    {error && <div className="private-notice" role="alert"><p>{taskErrorMessage[error.code]} Result content has been cleared.</p>
      <p>Unsaved review text and exact pending save keys remain in this task page’s memory. Restore access and reopen the same result to continue. Leaving this task page discards them.</p>
      <button type="button" onClick={() => { setSelected(undefined); setRefresh(value => value + 1); }}>Refresh result records</button></div>}
    {!page && !error && <p role="status">Loading protected results and review…</p>}
    {unavailableSelection && <p className="private-notice" role="alert">The requested result file{" "}
      <code>{unavailableSelection}</code> is not in this task’s authorized file list. Nothing was read.</p>}
    {page && page.projectId === projectId && page.jobId === jobId && <TaskResultsPanel page={page} content={content} pending={pending} selectedArtifactId={selected} reviewWorkspace={reviewWorkspace} verificationWorkspace={verificationWorkspace}
      onReviewSaved={() => setRefresh(value => value + 1)}
      onOpen={artifactId => {
        generation.current++; setPending(true); setContent(undefined); setUnavailableSelection(undefined);
        setSelected(artifactId); setRefresh(value => value + 1);
        // One history entry per opened file, so Back closes it.
        writeSelection(artifactId, "push");
      }}
      onClose={() => {
        generation.current++; setContent(undefined); setSelected(undefined); setPending(false);
        setUnavailableSelection(undefined);
        writeSelection(undefined, "push");
      }} />}
  </>;
}
