"use client";

import { useEffect, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { createProjectOrchestrationBrowserClient, orchestrationErrorMessage } from
  "../../src/web/v1/project-orchestration-browser-client";
import type { ProjectOrchestrationDescribeResultV1, ProjectOrchestrationSettingsV1,
  ProjectOrchestrationSuggestionV1 } from "../../src/web/v1/project-orchestration-wire";

type Client = ReturnType<typeof createProjectOrchestrationBrowserClient>;

export function ProjectOrchestrationPanel({ projectId, client: suppliedClient }: { projectId: string; client?: Client }) {
  const [client] = useState(() => suppliedClient ?? createProjectOrchestrationBrowserClient());
  const [settings, setSettings] = useState<ProjectOrchestrationSettingsV1>();
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState<BrowserRequestError>();
  const [result, setResult] = useState<ProjectOrchestrationDescribeResultV1>();
  useEffect(() => {
    let live = true;
    void client.readSettings(projectId).then(value => { if (live) { setSettings(value); setError(undefined); } }, reason => {
      if (live) setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable"));
    });
    return () => { live = false; };
  }, [client, projectId]);
  if (!settings) return error ? <section className="private-panel"><h2>Chief of staff</h2>
    <p role="alert">{orchestrationErrorMessage[error.code]}</p></section> : null;
  if (settings.choice.mode === "none") return null;
  const submit = async (retry = false) => {
    if (pending || (!retry && !description.trim())) return;
    setPending(true); setError(undefined); setResult(undefined);
    try { setResult(await (retry ? client.retryDescription() : client.describe(projectId, description))); }
    catch (reason) { setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable")); }
    finally { setPending(false); }
  };
  return <section className="private-panel private-orchestration" aria-labelledby="describe-job-heading">
    <h2 id="describe-job-heading">Describe a job</h2>
    <p>Tell your chief of staff what outcome you want. It will prepare a proposal for you to review; nothing starts here.</p>
    <label htmlFor="project-job-description">What should happen?</label>
    <textarea id="project-job-description" rows={6} maxLength={16_000} value={description} disabled={pending}
      placeholder="Describe the outcome, useful context, and what a good result looks like."
      onInput={event => setDescription(event.currentTarget.value)} />
    <button type="button" disabled={pending || !description.trim() || client.hasPendingDescription()}
      onClick={() => { void submit(); }}>{pending ? "Chief of staff is preparing a proposal…" : "Prepare proposal"}</button>
    {pending && <p role="status">Chief of staff is preparing a proposal. No work has started.</p>}
    {result?.status === "proposal" && <p role="status">Proposal ready. <a href={result.href}>Review the proposal on its batch page</a>.</p>}
    {result && result.status !== "proposal" && <p role={result.status === "failed" ? "alert" : "status"}>{result.message}</p>}
    {error && <div className="private-notice"><p role="alert">{orchestrationErrorMessage[error.code]}</p>
      {error.code === "uncertain" && <button type="button" disabled={pending} onClick={() => { void submit(true); }}>
        Check this exact request again</button>}</div>}
    <p className="private-note">You will review and revise the proposal on the batch page. Preparing it never approves, assigns, or starts work.</p>
  </section>;
}

export function ProjectOrchestrationSettings({ projectId, client: suppliedClient }: { projectId: string; client?: Client }) {
  const [client] = useState(() => suppliedClient ?? createProjectOrchestrationBrowserClient());
  const [settings, setSettings] = useState<ProjectOrchestrationSettingsV1>();
  const [choiceKey, setChoiceKey] = useState("none"), [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false), [error, setError] = useState<BrowserRequestError>();
  useEffect(() => {
    let live = true;
    void client.readSettings(projectId).then(value => { if (!live) return; setSettings(value);
      const selected = value.choice;
      setChoiceKey(selected.mode === "none" ? "none" : value.options.find(option => option.workerId === selected.workerId
        && option.workerKind === selected.workerKind && option.modelKey === selected.modelKey
        && option.effort === selected.effort)?.key ?? "none"); setError(undefined); }, reason => {
      if (live) setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable"));
    });
    return () => { live = false; };
  }, [client, projectId]);
  const save = async () => {
    if (!settings || pending) return;
    const selected = settings.options.find(option => option.key === choiceKey);
    setPending(true); setSaved(false); setError(undefined);
    try { const value = await client.saveSettings(projectId, { expectedVersion: settings.version,
      choice: selected ? { mode: "selected", workerId: selected.workerId, workerKind: selected.workerKind,
        modelKey: selected.modelKey, effort: selected.effort } : { mode: "none" } });
      setSettings(value); setSaved(true); }
    catch (reason) { setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable")); }
    finally { setPending(false); }
  };
  return <section className="private-panel private-orchestration" aria-labelledby="chief-of-staff-setting">
    <h2 id="chief-of-staff-setting">Chief of staff</h2>
    <p>Choose the bot and model that can turn a plain description into a proposal. Choose none to hide the Describe a job box.</p>
    <label htmlFor="project-chief-of-staff">Bot and model</label>
    <select id="project-chief-of-staff" value={choiceKey} disabled={pending || !settings}
      onChange={event => { setChoiceKey(event.target.value); setSaved(false); }}>
      <option value="none">None</option>
      {settings?.options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
    </select>
    <button type="button" disabled={pending || !settings} onClick={() => { void save(); }}>
      {pending ? "Saving…" : "Save chief of staff"}</button>
    {saved && <p role="status">Chief-of-staff setting saved.</p>}
    {error && <p role="alert">{orchestrationErrorMessage[error.code]}</p>}
    <p className="private-note">This choice may prepare proposals only. It does not grant approval, assignment, or execution authority.</p>
  </section>;
}

export function ChiefOfStaffSuggestionCard({ suggestion, pending = false, onUse, onDismiss }: {
  suggestion: ProjectOrchestrationSuggestionV1; pending?: boolean;
  onUse: (suggestion: ProjectOrchestrationSuggestionV1) => void;
  onDismiss: (suggestion: ProjectOrchestrationSuggestionV1) => void;
}) {
  return <article className="private-notice private-suggestion" aria-label="Chief of staff suggests a new split">
    <h3>Chief of staff suggests a new split</h3>
    <p>{suggestion.proposal.tasks.length} proposed part{suggestion.proposal.tasks.length === 1 ? "" : "s"}. Using it only fills your revision form below.</p>
    <div className="private-actions"><button type="button" disabled={pending} onClick={() => onUse(suggestion)}>Use this</button>
      <button type="button" disabled={pending} onClick={() => onDismiss(suggestion)}>Dismiss</button></div>
    <p className="private-note">It is never applied automatically and does not start work.</p>
  </article>;
}
