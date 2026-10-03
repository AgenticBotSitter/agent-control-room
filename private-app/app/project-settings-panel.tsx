"use client";
import { useEffect, useRef, useState } from "react";
import { BrowserRequestError, type BrowserFailureCode } from "../../src/web/v1/browser-client";
import { createProjectSettingsBrowserClient, projectSettingsErrorMessage } from "../../src/web/v1/project-settings-browser-client";
import { projectSettingsDraftSchema, type ProjectSettings } from "../../src/web/v1/project-settings-wire";

const WORKER_KINDS = ["codex", "claude-code", "hermes"] as const;
type WorkerKind = (typeof WORKER_KINDS)[number];

/** The sentence for a refusal, which must name the OPERATION that failed (R4U-10).
 *
 * The shared map in `project-settings-browser-client` is written for the page's
 * two reads. On a write it is not merely incomplete, it is misleading: "Sign in
 * again to see this project's settings" after a Save tells the owner nothing
 * about whether their change landed, and the natural reading is that it did.
 *
 * Exported so a test reads the sentences from here rather than restating them.
 */
export function projectSettingsRefusalMessage(code: BrowserFailureCode, operation: "read" | "save"): string {
  if (code !== "authentication_required") return projectSettingsErrorMessage[code];
  return operation === "save"
    ? "You are signed out, so this change was not saved. Your edits are still here."
    : "You are signed out, so this project's settings could not be read.";
}

function toDraftShape(settings: ProjectSettings) {
  return {
    expectedVersion: settings.version,
    eligibleWorkerKinds: settings.eligibleWorkerKinds,
    maxConcurrentTasks: settings.maxConcurrentTasks,
    defaultWorkerKind: settings.defaultWorkerKind,
    defaultModel: settings.defaultModel,
    defaultEffort: settings.defaultEffort,
  };
}

/** Owner-only project settings: eligible worker kinds, a concurrency cap, and the default worker,
 * model and effort offered when proposing a task. Review policy is fixed and installation-wide --
 * shown read-only, never editable here (a single-owner install has exactly one reviewer). */
export function ProjectSettingsPanel({ projectId, client: suppliedClient }: {
  projectId: string; client?: ReturnType<typeof createProjectSettingsBrowserClient>;
}) {
  const [client] = useState(() => suppliedClient ?? createProjectSettingsBrowserClient());
  const [settings, setSettings] = useState<ProjectSettings>();
  const [eligible, setEligible] = useState<readonly WorkerKind[] | null>(null);
  const [restrict, setRestrict] = useState(false);
  const [maxConcurrent, setMaxConcurrent] = useState("");
  const [defaultWorker, setDefaultWorker] = useState<WorkerKind | "">("");
  const [defaultModel, setDefaultModel] = useState("");
  const [defaultEffort, setDefaultEffort] = useState<"" | "default" | "low" | "medium" | "high" | "xhigh" | "max">("");
  const [error, setError] = useState<BrowserRequestError>();
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<"maxConcurrentTasks" | "defaultModel", string>>>({});
  // WHICH operation produced the refusal. A read and a write are different
  // facts about the same ended session (R4U-10), and only this panel knows
  // which happened -- the error code alone cannot say it.
  const [operation, setOperation] = useState<"read" | "save">("read");
  const [saved, setSaved] = useState(false), [pending, setPending] = useState(false);
  const alive = useRef(true), busy = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let live = true;
    void client.read(projectId).then(value => {
      if (!live) return;
      setSettings(value); setSaved(false); setError(undefined); setOperation("read");
      setRestrict(value.eligibleWorkerKinds !== null); setEligible(value.eligibleWorkerKinds as readonly WorkerKind[] | null);
      setMaxConcurrent(value.maxConcurrentTasks === null ? "" : String(value.maxConcurrentTasks));
      setDefaultWorker((value.defaultWorkerKind ?? "") as WorkerKind | "");
      setDefaultModel(value.defaultModel ?? ""); setDefaultEffort((value.defaultEffort ?? "") as typeof defaultEffort);
    }).catch(reason => { if (live) { setOperation("read"); setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable")); } });
    return () => { live = false; };
  }, [client, projectId]);
  function toggleKind(kind: WorkerKind) {
    setEligible(previous => {
      const current = previous ?? [];
      return current.includes(kind) ? current.filter(value => value !== kind) : [...current, kind].sort();
    });
  }
  async function save() {
    if (busy.current || !settings || pending) return;
    const draft = {
      expectedVersion: settings.version,
      eligibleWorkerKinds: restrict ? [...(eligible ?? [])].sort() : null,
      maxConcurrentTasks: maxConcurrent.trim() === "" ? null : Number(maxConcurrent),
      defaultWorkerKind: defaultWorker || null,
      defaultModel: defaultWorker && defaultModel.trim() ? defaultModel.trim() : null,
      defaultEffort: defaultWorker && defaultEffort ? defaultEffort : null,
    };
    const parsed = projectSettingsDraftSchema.safeParse(draft);
    const issues: typeof fieldErrors = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === "maxConcurrentTasks") issues.maxConcurrentTasks = "Maximum concurrent tasks: enter a whole number from 1 to 20, or leave blank for no limit.";
        if (issue.path[0] === "defaultModel") issues.defaultModel = "Default model: use an identifier of 1–180 characters, starting with a letter or number, followed by letters, numbers, dots, underscores, colons, slashes, plus or minus signs.";
      }
      setFieldErrors(issues); setSaved(false); setOperation("save"); setError(new BrowserRequestError("invalid_request"));
      return;
    }
    setFieldErrors({});
    busy.current = true; setPending(true); setError(undefined); setSaved(false); setOperation("save");
    try {
      const value = await client.save(projectId, parsed.data);
      if (alive.current) { setSettings(value); setSaved(true); }
    } catch (reason) {
      if (alive.current) { setOperation("save"); setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable")); }
    } finally { busy.current = false; if (alive.current) setPending(false); }
  }
  return <section id="project-settings" className="private-panel" aria-label="Project settings" onChange={() => setSaved(false)}><h2>Settings</h2>
    <h3>Review policy</h3>
    <p className="private-note">Owner review, installation-wide: one independent human review, up to 3 revision rounds, a low risk ceiling.
      This is fixed for every project on this computer and is not editable here.</p>
    <h3>Eligible workers</h3>
    <p>By default every configured worker kind may claim this project's tasks.</p>
    <label><input type="checkbox" checked={restrict} disabled={pending || !settings}
      onChange={event => setRestrict(event.target.checked)} /> Restrict to specific worker kinds</label>
    {restrict && <fieldset><legend>Eligible worker kinds</legend>
      {WORKER_KINDS.map(kind => <label key={kind} style={{ display: "block" }}>
        <input type="checkbox" checked={(eligible ?? []).includes(kind)} disabled={pending}
          onChange={() => toggleKind(kind)} /> {kind}</label>)}
      {(eligible ?? []).length === 0 && <p role="alert">No worker kind is eligible: no task in this project can be assigned until at least one is checked.</p>}
    </fieldset>}
    <h3>Maximum concurrent tasks</h3>
    <p>Leave blank for no project-specific limit.</p>
    <label htmlFor="project-settings-max-concurrent">Maximum concurrent tasks</label>
    <input id="project-settings-max-concurrent" type="number" min={1} max={20} value={maxConcurrent} disabled={pending}
      aria-invalid={fieldErrors.maxConcurrentTasks ? true : undefined}
      aria-describedby={fieldErrors.maxConcurrentTasks ? "project-settings-max-concurrent-error" : undefined}
      onChange={event => setMaxConcurrent(event.target.value)} />
    {fieldErrors.maxConcurrentTasks && <p id="project-settings-max-concurrent-error" className="private-field-error">{fieldErrors.maxConcurrentTasks}</p>}
    <h3>Default worker, model and effort</h3>
    <p>Offered when proposing a new task in this project; the owner can still choose differently at assignment time.</p>
    <label htmlFor="project-settings-default-worker">Default worker</label>
    <select id="project-settings-default-worker" value={defaultWorker} disabled={pending}
      onChange={event => setDefaultWorker(event.target.value as WorkerKind | "")}>
      <option value="">No default</option>
      {WORKER_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
    </select>
    {defaultWorker && <>
      <label htmlFor="project-settings-default-model">Default model</label>
      <input id="project-settings-default-model" type="text" value={defaultModel} disabled={pending}
        aria-invalid={fieldErrors.defaultModel ? true : undefined}
        aria-describedby={fieldErrors.defaultModel ? "project-settings-default-model-error" : undefined}
        onChange={event => setDefaultModel(event.target.value)} />
      {fieldErrors.defaultModel && <p id="project-settings-default-model-error" className="private-field-error">{fieldErrors.defaultModel}</p>}
      <label htmlFor="project-settings-default-effort">Default effort</label>
      <select id="project-settings-default-effort" value={defaultEffort} disabled={pending}
        onChange={event => setDefaultEffort(event.target.value as typeof defaultEffort)}>
        <option value="">No default</option>
        {(["default", "low", "medium", "high", "xhigh", "max"] as const).map(value => <option key={value} value={value}>{value}</option>)}
      </select>
    </>}
    <div><button type="button" disabled={pending || !settings} onClick={() => { void save(); }}>{pending ? "Saving…" : "Save settings"}</button></div>
    {saved && <p role="status">Settings saved.</p>}
    {/* A failed SAVE and a failed READ are different facts about the same
        session, and only this panel knows which one happened (R4U-10). The
        shared message map says "Sign in again to see this project's settings" --
        true, and about a READ. On a save the owner had already read them, made
        a change, and pressed Save; that sentence leaves them believing the
        change went through. So the refusal carries which operation failed, and
        the sign-in path is offered exactly once, here, where it is needed. */}
    {error && <p role="alert">{Object.keys(fieldErrors).length
      ? `${[fieldErrors.maxConcurrentTasks, fieldErrors.defaultModel].filter(Boolean).join(" ")} Settings were not saved.`
      : projectSettingsRefusalMessage(error.code, operation)}</p>}
    {/* Only on a failed SAVE. The note promises "your change above is still
        here" and "press Save settings to apply it" -- both false when the READ
        failed: nothing was ever loaded, so there is no change above, and the
        Save button is disabled (`disabled={pending || !settings}`) because there
        is no version to save against. An owner whose session had already ended
        when the page loaded would be told to press a button that cannot be
        pressed. The alert above still says the session ended either way. */}
    {error?.code === "authentication_required" && operation === "save"
      && <p className="private-note">Your session ended in this browser. Your change above is still here.
        <a href="/session">Sign in again</a>, then press Save settings to apply it.</p>}
  </section>;
}
