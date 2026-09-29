"use client";
import { useState } from "react";
import { projectCreateSchema } from "../../src/web/v1/project-wire";

export interface ProjectTemplateOption {
  readonly templateId: string;
  readonly displayName: string;
  readonly configurationDigest: string;
}

export function validateProjectDraft(value: { title: string; summary: string; templateSelection?: { templateId: string; configurationDigest: string } }):
  { ok: true; draft: { title: string; summary: string; templateSelection?: { templateId: string; configurationDigest: string } } } | { ok: false } {
  const parsed = projectCreateSchema.safeParse(value);
  return parsed.success ? { ok: true, draft: parsed.data } : { ok: false };
}
export function ProjectCreateForm({ pending, result, templates, onCreate }: {
  pending: boolean; result: "idle" | "created" | "invalid" | "unavailable";
  templates?: readonly ProjectTemplateOption[];
  onCreate: (draft: { title: string; summary: string; templateSelection?: { templateId: string; configurationDigest: string } }) => void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [templateId, setTemplateId] = useState<string>("");
  const [invalid, setInvalid] = useState(false);
  const canPickTemplate = !!templates && templates.length > 0;
  // Mirror the server's two constraints so the announced message can name the
  // field that is actually at fault, and so each field's `aria-describedby`
  // only ever references ids that are really rendered below it. A dangling
  // `aria-describedby` target is read out as an empty or literal id.
  const showError = invalid || result === "invalid";
  const titleError = title.trim().length < 1 || title.trim().length > 120;
  const summaryError = summary.trim().length > 1000;
  const describedBy = (...ids: readonly string[]) => ids.join(" ");
  return <form className="private-create" onSubmit={event => {
    event.preventDefault(); if (pending) return;
    const selected = canPickTemplate && templateId ? templates!.find(option => option.templateId === templateId) : undefined;
    const draft = { title, summary, ...(selected ? { templateSelection: { templateId: selected.templateId, configurationDigest: selected.configurationDigest } } : {}) };
    const checked = validateProjectDraft(draft); setInvalid(!checked.ok);
    if (checked.ok) onCreate(checked.draft);
  }}>
    <h2>New project</h2>
    <label htmlFor="project-title">Project name</label>
    {/* `aria-invalid` plus `aria-describedby` tie each field to the error that
      * describes it. The single shared sentence named two fields without
      * saying which was wrong, so a screen-reader user who tabbed back to the
      * first field got no indication of the fault or of its constraint. */}
    <input id="project-title" value={title} onChange={event => setTitle(event.target.value)} required maxLength={120}
      disabled={pending} aria-invalid={showError && titleError ? true : undefined}
      aria-describedby={showError ? describedBy(...(titleError ? ["project-title-error"] : []), "project-create-error") : undefined} />
    {showError && titleError && <p className="private-field-error" id="project-title-error">Enter a name of 1–120 characters.</p>}
    <label htmlFor="project-summary">What do you want to accomplish?</label>
    <textarea id="project-summary" value={summary} onChange={event => setSummary(event.target.value)} maxLength={1000} rows={4}
      disabled={pending} aria-invalid={showError && summaryError ? true : undefined}
      aria-describedby={showError ? describedBy(...(summaryError ? ["project-summary-error"] : []), "project-create-error") : undefined} />
    {showError && summaryError && <p className="private-field-error" id="project-summary-error">Enter a summary of at most 1,000 characters.</p>}
    {canPickTemplate && <>
      <label htmlFor="project-template">Project template</label>
      <select id="project-template" value={templateId} onChange={event => setTemplateId(event.target.value)} disabled={pending}>
        <option value="">No template (use global modules)</option>
        {templates!.map(option => <option key={option.templateId} value={option.templateId}>{option.displayName}</option>)}
      </select>
      <p className="private-note">The template selection is saved with the project and can be reviewed on the project page. Existing modules remain visible to projects that selected them.</p>
    </>}
    <button type="submit" disabled={pending}>{pending ? "Saving…" : "Create project"}</button>
    {showError && <p role="alert" id="project-create-error">Enter a name of 1–120 characters and a summary of at most 1,000 characters.</p>}
    {result === "created" && <p role="status">Project saved.</p>}
    {result === "unavailable" && <p role="alert">The save could not be confirmed. Check the message above before trying again.</p>}
  </form>;
}
