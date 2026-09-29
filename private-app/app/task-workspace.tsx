"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRequestError, browserAuthenticationRecovery } from "../../src/web/v1/browser-client";
import { createTaskBrowserClient, taskErrorMessage } from "../../src/web/v1/task-browser-client";
import type { TaskDetail, TaskDraft, TaskPage, TaskReceipt } from "../../src/web/v1/task-wire";
import { PrivateHeader } from "./private-header";
import { ProjectNavigation } from "./project-navigation";
import { TaskCatalogPanel, TaskDetailPanel, TaskProposalForm, TaskStateGuidance, taskUrl } from "./task-panels";
import { PrivateTaskResults } from "./task-results";
import { createTaskReviewWorkspace, type TaskReviewWorkspace } from "../../src/web/v1/task-review-workspace";
import { createTaskVerificationWorkspace, type TaskVerificationWorkspace } from "../../src/web/v1/task-verification-workspace";
import { PrivateTaskPlanning } from "./task-planning";
import { PrivateTaskAssignment } from "./task-assignment";
import { FleetOfferControl } from "./workers/fleet-offer";
import { PrivateTaskApproval } from "./task-approval";
import { TaskWorkflowGuide } from "./task-workflow-guide";
import { installNewsNavigationGuard } from "../../src/web/v1/news-navigation-guard";
import { createTaskExecutionWorkspace } from "../../src/web/v1/task-execution-workspace";
import { createIdeaBrowserClient } from "../../src/web/v1/idea-browser-client";
import { canPrepareIdeaExperiment, prepareIdeaExperimentDraft } from "../../src/web/v1/idea-experiment-draft";
import { useLocalRuntime } from "./local-runtime";
import { StateChip } from "./owner-ui";
import type { PreparedTaskStatus } from "../../src/web/v1/task-planning-wire";
import { usePolledRead } from "./use-polled-read";

/** Polling the same task must retain its object identity. The planning,
 * assignment and result children key their protected reads to this value; a
 * fresh but equal object otherwise fans one 30-second poll into more reads and
 * resets in-progress owner choices. */
export function retainEquivalentTaskDetailV1<T extends { observedAt: string }>(previous: T | undefined, next: T): T {
  if (!previous) return next;
  const { observedAt: _previousObservation, ...previousValue } = previous;
  const { observedAt: _nextObservation, ...nextValue } = next;
  return JSON.stringify(previousValue) === JSON.stringify(nextValue) ? previous : next;
}

export function TaskAuthenticationRecovery({ held }: { held: boolean }) {
  return <p>{browserAuthenticationRecovery(held)}</p>;
}

/** Read-gated child; command memory is owned by the stable keyed task page, not this subtree. */
export function TaskDetailResults({ detail, projectId, reviewWorkspace, verificationWorkspace }: {
  detail?: TaskDetail; projectId: string; reviewWorkspace: TaskReviewWorkspace; verificationWorkspace?: TaskVerificationWorkspace;
}) {
  return detail && (detail.artifacts === "configured" || detail.review === "recorded")
    ? <PrivateTaskResults key={`${projectId}:${detail.task.jobId}`} projectId={projectId}
      jobId={detail.task.jobId} reviewWorkspace={reviewWorkspace} verificationWorkspace={verificationWorkspace} /> : null;
}

/** A proposal has no assignment yet; asking the assignment endpoint for it is
 * an expected 404. Only the separately prepared task has that capability. */
export function TaskExecutionStage({ detail, mode, workspace, onRecorded }: {
  detail: TaskDetail; mode: "checking" | "local" | "hosted"; workspace: ReturnType<typeof createTaskExecutionWorkspace>;
  onRecorded?: () => void;
}) {
  const [preparedContinuation, setPreparedContinuation] = useState<{ sourceJobId: string; task: PreparedTaskStatus }>();
  const recordPreparedTask = useCallback((sourceJobId: string, task?: PreparedTaskStatus) => {
    setPreparedContinuation(task ? { sourceJobId, task } : undefined);
  }, []);
  const preparedFromSource = preparedContinuation?.sourceJobId === detail.task.jobId ? preparedContinuation.task : undefined;
  if (mode === "checking") return <p className="private-note">Checking this installation’s task workflow…</p>;
  const fleet = <FleetOfferControl projectId={detail.task.projectId} jobId={detail.task.jobId} state={detail.task.state} />;
  if (mode === "hosted") return <><PrivateTaskPlanning detail={detail} client={workspace.planning} />
    <PrivateTaskAssignment detail={detail} client={workspace.assignment} onRecorded={onRecorded} />
    <PrivateTaskApproval detail={detail} workspace={workspace} />{fleet}</>;
  if (!detail.preparedFor) return <>{fleet}<PrivateTaskPlanning detail={detail} client={workspace.planning} onPreparedTask={recordPreparedTask} />
    {preparedFromSource ? null : <>
    <section id="task-assignment" className="private-panel" aria-label="Task assignment"><h2>Task assignment</h2>
      <p>Prepare this saved proposal before choosing a configured machine. Assignment will reserve capacity without starting work.</p>
      <button type="button" disabled>Assign after preparation</button></section>
    <section id="task-approval" className="private-panel" aria-label="Execution approval"><h2>Execution approval</h2>
      <p>Execution approval follows preparation and assignment. No permission has been granted and no agent starts from this page automatically.</p>
      <button type="button" disabled>Approve after assignment</button></section></>}</>;
  return <><PrivateTaskAssignment detail={detail} client={workspace.assignment} onRecorded={onRecorded} runOnAssign />
    <PrivateTaskApproval detail={detail} workspace={workspace} local />{fleet}</>;
}

export function PrivateTaskWorkspace({ projectId, jobId, after }: { projectId: string; jobId?: string; after?: string }) {
  const runtime = useLocalRuntime();
  // Neither failed task-detail reads nor failed result reads may discard an unfinished review.
  const [reviewWorkspace] = useState(() => createTaskReviewWorkspace());
  const [client] = useState(() => createTaskBrowserClient(fetch, () => crypto.randomUUID(), reviewWorkspace.bindAuthenticatedSession));
  const [ideas] = useState(() => createIdeaBrowserClient());
  const [verificationWorkspace] = useState(() => createTaskVerificationWorkspace());
  const [executionWorkspace] = useState(() => createTaskExecutionWorkspace());
  const [page, setPage] = useState<TaskPage>();
  const [detail, setDetail] = useState<TaskDetail>();
  const [draft, setDraft] = useState<TaskDraft>({ title: "", instructions: "" });
  const [error, setError] = useState<BrowserRequestError>();
  const [navigationNotice, setNavigationNotice] = useState(false);
  const [preparing, setPreparing] = useState(false), preparingRef = useRef(false);
  const [experimentNotice, setExperimentNotice] = useState<string>();
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [refresh, setRefresh] = useState(0);
  // An invalidated session stops the background loop rather than hammering an
  // endpoint that will keep refusing it. Only an explicit owner retry (below)
  // clears this and lets the loop read again.
  const [authInvalid, setAuthInvalid] = useState(false);
  const generation = useRef(0), busy = useRef(false), alive = useRef(true);
  useEffect(() => installNewsNavigationGuard(window, document,
    () => busy.current || client.hasPending() || reviewWorkspace.hasPending() || verificationWorkspace.hasPending() || executionWorkspace.hasPending(),
    () => setNavigationNotice(true)), [client, reviewWorkspace, verificationWorkspace, executionWorkspace]);
  // `alive` fences the write handlers below from setting state after unmount.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const failure = (reason: unknown) => reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable");
  // Refresh only reads. Closing a browser tab, reconnecting or focusing cannot
  // start/retry a task. The shared polling hook owns the schedule: it pauses
  // while the tab is hidden, refreshes on focus, never overlaps a read, and
  // backs off when nothing changes or the read fails. `generation` fences a
  // retired read from overwriting a newer result, exactly as before.
  usePolledRead<true>({
    key: `task-workspace-${projectId}-${jobId ?? "list"}-${after ?? ""}-${refresh}`,
    baseIntervalMs: 30_000,
    enabled: !authInvalid,
    read: async (signal, transport) => {
      if (busy.current || preparingRef.current) return true;
      const current = ++generation.current;
      try {
        const value = jobId ? await client.detail(projectId, jobId, signal, transport)
          : await client.list(projectId, after, signal, transport);
        if (current === generation.current) {
          if ("task" in value) setDetail(previous => retainEquivalentTaskDetailV1(previous, value)); else setPage(value);
          setError(client.hasPending() ? new BrowserRequestError("uncertain") : undefined);
        }
      } catch (reason) {
        if (current === generation.current) {
          const err = failure(reason);
          if (err.code === "authentication_required") { reviewWorkspace.invalidateAuthenticatedSession(); setAuthInvalid(true); }
          setPage(undefined); setDetail(undefined); setError(err);
        }
      } finally { if (current === generation.current) setLoading(false); }
      return true;
    },
  });
  async function save(retry = false) {
    if (busy.current || preparingRef.current || !page || (!retry && !page.canPropose)) return;
    busy.current = true; generation.current++; setPending(true); setError(undefined);
    try {
      const receipt: TaskReceipt = retry ? await client.retrySave() : await client.propose(projectId, draft);
      // The confirmed command has released its hold; allow the success navigation.
      busy.current = false;
      if (alive.current) window.location.assign(taskUrl(receipt.projectId, receipt.jobId));
    } catch (reason) {
      if (alive.current) {
        const err = failure(reason); setError(err);
        if (err.code === "authentication_required") { reviewWorkspace.invalidateAuthenticatedSession(); setAuthInvalid(true); }
        if (["authentication_required", "access_denied", "not_found"].includes(err.code)) { setPage(undefined); setDetail(undefined); setDraft({ title: "", instructions: "" }); }
      }
    } finally { busy.current = false; if (alive.current) setPending(false); }
  }
  async function prepareExperiment() {
    if (!page || busy.current || preparingRef.current || client.hasPending() || draft.title || draft.instructions) return;
    preparingRef.current = true; setPreparing(true); setExperimentNotice(undefined);
    const current = ++generation.current;
    try {
      const prepared = await prepareIdeaExperimentDraft(page, id => ideas.detail(id));
      if (alive.current && generation.current === current) {
        setDraft(prepared); setExperimentNotice("Experiment draft prepared. Review or edit it below, then save when ready. Nothing has been saved or started.");
      }
    } catch (reason) {
      if (alive.current && generation.current === current) setExperimentNotice(reason instanceof BrowserRequestError
        && reason.code === "authentication_required" ? browserAuthenticationRecovery(false)
        : "The experiment could not be prepared. Refresh your access and source discussion, or write the task below. No task was saved.");
    } finally { preparingRef.current = false; if (alive.current) setPreparing(false); }
  }
  const project = detail?.project ?? page?.project;
  const refreshSaved = () => { if (preparingRef.current) return; setAuthInvalid(false); setLoading(true); setRefresh(value => value + 1); };
  const uncertain = client.hasPending();
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <a className="private-back" href={jobId ? taskUrl(projectId) : "/projects"}>{jobId ? "← Project tasks" : "← All projects"}</a>
    {navigationNotice && <p className="private-notice" role="alert">A save was still unconfirmed when you tried to leave.
      Keep this tab open and check that exact save again. If sign-in has expired, sign in from another tab, then return here.</p>}
    {error && <div className="private-notice" role="alert">{error.code === "authentication_required"
      ? <TaskAuthenticationRecovery held={client.hasPending() || reviewWorkspace.hasPending() || verificationWorkspace.hasPending() || executionWorkspace.hasPending()} />
      : <p>{taskErrorMessage[error.code]}</p>}
      {jobId && <p>Result content has been cleared. Unfinished review text and exact pending save keys remain in this task page’s memory.
        Restore access and reopen the same result to continue. Leaving or reloading the task page discards them.</p>}
      <div className="private-actions"><button type="button" disabled={pending || preparing}
        onClick={() => { setAuthInvalid(false); setRefresh(value => value + 1); }}>Check saved tasks again</button>
        {uncertain && page && <button type="button" disabled={pending} onClick={() => { void save(true); }}>Check this exact save again</button>}</div></div>}
    {loading && <p role="status">Loading protected tasks…</p>}
    {project && <button type="button" disabled={loading || pending || preparing} onClick={refreshSaved}>Check latest saved status</button>}
    {project && <><div className="private-heading"><StateChip state={project.lifecycle} /><h1>{project.title}</h1></div>
      <ProjectNavigation projectId={projectId} current="work" /></>}
    {page && <div className="private-columns"><TaskCatalogPanel page={page} after={after} />
      {page.canPropose ? <div>{canPrepareIdeaExperiment(page) && <section className="private-panel" aria-label="First experiment">
        <h2>Start from your Idea Lab experiment</h2><p>Bring the approved discussion into an editable planning task. It will not run the experiment.</p>
        <button type="button" disabled={pending || preparing || uncertain || !!draft.title || !!draft.instructions}
          onClick={() => { void prepareExperiment(); }}>{preparing ? "Reading experiment…" : "Prepare first experiment task"}</button>
        {(!!draft.title || !!draft.instructions) && <p>Clear both draft fields first if you want to prepare it again. Existing text is never replaced.</p>}
      </section>}{experimentNotice && <p role="status">{experimentNotice}</p>}
        <TaskProposalForm draft={draft} setDraft={setDraft} modelOptions={page.modelOptions} pending={pending} preparing={preparing} uncertain={uncertain} onSave={() => { void save(); }} /></div>
        : <p className="private-note">{page.project.lifecycle !== "active" ? "Reopen this project before proposing more work." : "Your current access allows reading tasks, not proposing new work."}</p>}</div>}
    {/* TaskDetailPanel's own first section is the status lead: state chip,
        title and an explicit "Assigned to" line (owner-ux-feedback-2026-09-27.md
        item 4). Its later sections — Prepared worker, Local task route,
        Ownership leases, Agent progress — are now collapsed behind <details>,
        so "What happens next" (TaskStateGuidance) is reached after one status
        section and a run of one-line collapsed headings, not a wall of
        evidence text. Splitting TaskDetailPanel to put guidance literally
        between its first section and the rest would duplicate the status line
        for no owner-visible gain, since every later section is already
        collapsed by default. */}
    {detail && <TaskDetailPanel detail={detail} />}
    {detail && <TaskStateGuidance detail={detail} refreshing={loading} onRefresh={refreshSaved} />}
    {detail && runtime.mode !== "checking" && <TaskWorkflowGuide local={runtime.mode === "local"} prepared={!!detail.preparedFor} />}
    {jobId && detail && <TaskExecutionStage detail={detail} mode={runtime.mode} workspace={executionWorkspace} onRecorded={refreshSaved} />}
    <div id="task-results"><TaskDetailResults detail={detail} projectId={projectId} reviewWorkspace={reviewWorkspace} verificationWorkspace={verificationWorkspace} /></div>
    {project && <p className="private-note">Saved-state view · Refreshes every 30 seconds while visible. Use the task’s submission controls to queue work when configured. Refreshing this page does not submit a task.</p>}
  </main></div>;
}
