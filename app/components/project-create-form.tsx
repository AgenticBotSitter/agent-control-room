"use client";
import { useState } from "react";
import { projectCreateSchema } from "../../src/web/v1/project-wire";

export function validateProjectDraft(value: { title: string; summary: string }):
  { ok: true; draft: { title: string; summary: string } } | { ok: false } {
  const parsed = projectCreateSchema.safeParse(value);
  return parsed.success ? { ok: true, draft: parsed.data } : { ok: false };
}
export function ProjectCreateForm({ pending, result, onCreate }: {
  pending: boolean; result: "idle" | "created" | "invalid" | "unavailable";
  onCreate: (draft: { title: string; summary: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [invalid, setInvalid] = useState(false);
  return <form className="private-create" onSubmit={event => {
    event.preventDefault(); if (pending) return;
    const checked = validateProjectDraft({ title, summary }); setInvalid(!checked.ok);
    if (checked.ok) onCreate(checked.draft);
  }}>
    <h2>New project</h2>
    <label htmlFor="project-title">Project name</label>
    <input id="project-title" value={title} onChange={event => setTitle(event.target.value)} required maxLength={120} disabled={pending} />
    <label htmlFor="project-summary">What do you want to accomplish?</label>
    <textarea id="project-summary" value={summary} onChange={event => setSummary(event.target.value)} maxLength={1000} rows={4} disabled={pending} />
    <button type="submit" disabled={pending}>{pending ? "Saving…" : "Create project"}</button>
    {(invalid || result === "invalid") && <p role="alert">Enter a name of 1–120 characters and a summary of at most 1,000 characters.</p>}
    {result === "created" && <p role="status">Project saved.</p>}
    {result === "unavailable" && <p role="alert">The save could not be confirmed. Check the message above before trying again.</p>}
  </form>;
}
