"use client";
import { useEffect, useRef, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { createProjectSettingsBrowserClient, projectSettingsErrorMessage } from "../../src/web/v1/project-settings-browser-client";
import type { ProjectSettings } from "../../src/web/v1/project-settings-wire";

const WORKER_KINDS = ["codex", "claude-code", "hermes"] as const;
type WorkerKind = (typeof WORKER_KINDS)[number];

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
  const [error, setError] = useState<BrowserRequestError>(), [saved, setSaved] = useState(false), [pending, setPending] = useState(false);
  const alive = useRef(true), busy = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let live = true;
    void client.read(projectId).then(value => {
      if (!live) return;
      setSettings(value); setSaved(false); setError(undefined);
      setRestrict(value.eligibleWorkerKinds !== null); setEligible(value.eligibleWorkerKinds as readonly WorkerKind[] | null);
      setMaxConcurrent(value.maxConcurrentTasks === null ? "" : String(value.maxConcurrentTasks));
      setDefaultWorker((value.defaultWorkerKind ?? "") as WorkerKind | "");
      setDefaultModel(value.defaultModel ?? ""); setDefaultEffort((value.defaultEffort ?? "") as typeof defaultEffort);
    }).catch(reason => { if (live) setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable")); });
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
    busy.current = true; setPending(true); setError(undefined); setSaved(false);
    try {
      const parsedMax = maxConcurrent.trim() === "" ? null : Number(maxConcurrent);
      const value = await client.save(projectId, {
        expectedVersion: settings.version,
        eligibleWorkerKinds: restrict ? [...(eligible ?? [])].sort() : null,
        maxConcurrentTasks: Number.isInteger(parsedMax) ? parsedMax : null,
        defaultWorkerKind: defaultWorker || null,
        defaultModel: defaultWorker && defaultModel.trim() ? defaultModel.trim() : null,
        defaultEffort: defaultWorker && defaultEffort ? defaultEffort : null,
      });
      if (alive.current) { setSettings(value); setSaved(true); }
    } catch (reason) {
      if (alive.current) setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable"));
    } finally { busy.current = false; if (alive.current) setPending(false); }
  }
  return <section id="project-settings" className="private-panel" aria-label="Project settings"><h2>Settings</h2>
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
      onChange={event => setMaxConcurrent(event.target.value)} />
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
        onChange={event => setDefaultModel(event.target.value)} />
      <label htmlFor="project-settings-default-effort">Default effort</label>
      <select id="project-settings-default-effort" value={defaultEffort} disabled={pending}
        onChange={event => setDefaultEffort(event.target.value as typeof defaultEffort)}>
        <option value="">No default</option>
        {(["default", "low", "medium", "high", "xhigh", "max"] as const).map(value => <option key={value} value={value}>{value}</option>)}
      </select>
    </>}
    <div><button type="button" disabled={pending || !settings} onClick={() => { void save(); }}>{pending ? "Saving…" : "Save settings"}</button></div>
    {saved && <p role="status">Settings saved.</p>}
    {error && <p role="alert">{projectSettingsErrorMessage[error.code]}</p>}
  </section>;
}
