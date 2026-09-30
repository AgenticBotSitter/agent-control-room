"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PrivateHeader } from "../../private-header";
import { LoadingState, StateChip, UnavailableState, type ChipTone } from "../../owner-ui";

type BotKind = "claude-code" | "codex" | "hermes" | "claude-desktop" | "cursor" | "mcp-agent";
type OperatingSystem = "macos" | "windows" | "linux";
type Project = { projectId: string; title: string };
type FleetWorker = { workerId: string; displayName: string; workerKind: string; status: string; lastSeenAt: string | null };
type ConnectorRelease = { version: string; file: string; sha256: string; size: number; builtFrom: string };
type Board = { workers: FleetWorker[]; connectBot: { available: boolean; release?: ConnectorRelease } };
export type ConnectBotInstallResult = { codeId: string; workerId: string; expiresAt: string;
  operatingSystem: OperatingSystem; release: ConnectorRelease; installLine: string };

const bots: readonly [BotKind, string][] = [["claude-code", "Claude Code"], ["codex", "Codex"],
  ["hermes", "Hermes"], ["cursor", "Cursor"], ["claude-desktop", "Claude Desktop"], ["mcp-agent", "Generic MCP"]];
const systems: readonly [OperatingSystem, string, string][] = [["macos", "macOS", "Terminal (zsh)"],
  ["windows", "Windows", "PowerShell"], ["linux", "Linux", "Terminal (bash)"]];
const capabilities = [["code.change", "Change code"], ["code.review", "Review code"], ["research", "Research"],
  ["writing", "Writing"], ["testing", "Testing"]] as const;
const statusWords: Record<string, [string, ChipTone]> = { working: ["Working", "busy"], connected: ["Connected", "good"],
  offline: ["Offline", "warn"], needs_new_key: ["Needs a new key", "bad"] };

async function request(path: string, body?: unknown) {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error("request_failed");
  return response.json() as Promise<unknown>;
}

function expirySentence(expiresAt: string, now: number) {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) return "This code expired. Create a new code before running the line.";
  const minutes = Math.max(1, Math.ceil((expiry - now) / 60_000));
  return `This single-use code expires in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

export function InstallLine({ result }: { result: ConnectBotInstallResult }) {
  const [now, setNow] = useState(Date.now()), [copied, setCopied] = useState(false);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5_000); return () => clearInterval(timer); }, []);
  const expired = Date.parse(result.expiresAt) <= now;
  const os = systems.find(([value]) => value === result.operatingSystem)!;
  return <section className={`private-notice connect-bot-result${expired ? " is-expired" : ""}`} role="status"
    aria-labelledby="connect-bot-line-title">
    <p className="private-eyebrow">{expired ? "Code expired" : "Ready to connect"}</p>
    <h2 id="connect-bot-line-title">One line for {os[1]}</h2>
    <p>{expirySentence(result.expiresAt, now)} Expires at <time dateTime={result.expiresAt}>{new Date(result.expiresAt).toLocaleString()}</time>.
      Paste this into {os[2]} on the computer where the bot runs.</p>
    <pre className="private-summary"><code>{result.installLine}</code></pre>
    <div className="private-actions"><button type="button" disabled={expired} onClick={() => {
      void navigator.clipboard?.writeText(result.installLine).then(() => setCopied(true), () => setCopied(false));
    }}>{expired ? "Expired" : copied ? "Copied" : "Copy line"}</button></div>
    <p className="private-note">The line downloads the connector, checks its release manifest and SHA-256 fingerprint before running it,
      then uses the code once. The code is an install argument, never part of a download address.</p>
    <p className="private-note">Connector release {result.release.version} SHA-256: <code>{result.release.sha256}</code></p>
  </section>;
}

function toggle(values: string[], value: string) {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}

export function ConnectBotWorkspace() {
  const [board, setBoard] = useState<Board | "unavailable">(), [projects, setProjects] = useState<Project[] | "unavailable">();
  const [name, setName] = useState(""), [botKind, setBotKind] = useState<BotKind>("claude-code");
  const [operatingSystem, setOperatingSystem] = useState<OperatingSystem>("macos");
  const [projectIds, setProjectIds] = useState<string[]>([]), [chosenCapabilities, setChosenCapabilities] = useState<string[]>(["writing"]);
  const [result, setResult] = useState<ConnectBotInstallResult>(), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const load = useCallback(async () => {
    try { setBoard(await request("/api/v1/fleet") as Board); }
    catch { setBoard("unavailable"); }
  }, []);
  useEffect(() => { void load(); void request("/api/v1/projects").then(catalog => setProjects(
    ((catalog as { projects?: Project[] }).projects ?? []).map(project => ({ projectId: project.projectId, title: project.title }))),
  () => setProjects("unavailable")); }, [load]);
  const connected = board && board !== "unavailable" ? board.workers.filter(worker => worker.status !== "revoked") : [];
  const validName = /^[^\u0000-\u001F\u007F]{1,80}$/u.test(name.trim());
  const canCreate = board !== undefined && board !== "unavailable" && board.connectBot.available && validName
    && Array.isArray(projects) && projectIds.length > 0 && chosenCapabilities.length > 0 && !busy;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    setBusy(true); setMessage(undefined); setResult(undefined);
    void request("/api/v1/fleet/connect-codes", { botKind, name, operatingSystem, projectIds, capabilities: chosenCapabilities })
      .then(value => { setResult(value as ConnectBotInstallResult); setMessage("Code created. Copy the line before it expires."); void load(); })
      .catch(() => setMessage("The code was not created. Nothing changed. Check the choices and try again."))
      .finally(() => setBusy(false));
  }

  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <a className="private-back" href="/workers">← Workers</a>
    <div className="private-heading"><p className="private-eyebrow">Private setup</p><h1>Connect a bot</h1>
      <p>Choose the bot and computer. Control Room gives you one short-lived line to copy and paste.</p></div>
    {result ? <InstallLine result={result} /> : null}
    {message ? <p role="status">{message}</p> : null}
    {board === undefined ? <LoadingState>Checking connector setup…</LoadingState>
      : board === "unavailable" ? <UnavailableState urgent>Connector setup could not be checked. No code was created.</UnavailableState>
          : !board.connectBot.available ? <UnavailableState>The verified connector release is not ready. No code can be created from this page.</UnavailableState>
          : null}
    <form className="private-create connect-bot-form" aria-label="Connect a bot" onSubmit={submit}>
      <h2>1. Name and choose the bot</h2>
      <label>Name for this bot<input name="bot-name" value={name} maxLength={80} autoComplete="off"
        aria-describedby="connect-bot-name-help"
        onChange={event => setName(event.target.value)} required /></label>
      <p className="private-note" id="connect-bot-name-help">Use a short name you will recognize, such as desktop-codex. New lines are not allowed.</p>
      <label>Bot<select name="bot-kind" value={botKind} onChange={event => setBotKind(event.target.value as BotKind)}>
        {bots.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <fieldset><legend>Computer operating system</legend><div className="connect-bot-choice-grid">
        {systems.map(([value, label, terminal]) => <label key={value}><input type="radio" name="operating-system"
          value={value} checked={operatingSystem === value} onChange={() => setOperatingSystem(value)} /><span><strong>{label}</strong><small>{terminal}</small></span></label>)}
      </div></fieldset>
      <h2>2. Limit what it can reach</h2>
      <fieldset><legend>Projects</legend>{projects === undefined ? <LoadingState>Loading projects…</LoadingState>
        : projects === "unavailable" ? <UnavailableState>Projects could not be checked. No code can be created.</UnavailableState>
          : projects.length === 0 ? <p className="private-note">No projects are available yet.</p> : projects.map(project =>
        <label key={project.projectId}><input type="checkbox" checked={projectIds.includes(project.projectId)}
          onChange={() => setProjectIds(toggle(projectIds, project.projectId))} /> {project.title}</label>)}</fieldset>
      <fieldset><legend>What it may do</legend>{capabilities.map(([value, label]) => <label key={value}>
        <input type="checkbox" checked={chosenCapabilities.includes(value)}
          onChange={() => setChosenCapabilities(toggle(chosenCapabilities, value))} /> {label}</label>)}</fieldset>
      <button type="submit" disabled={!canCreate}>Create code</button>
      <p className="private-note">The bot can work only in the projects and categories you pick. It cannot approve,
        accept or merge work, and it never receives your login or a database password.</p>
    </form>
    <section className="private-panel connect-bot-inventory" aria-labelledby="connected-bots-title">
      <h2 id="connected-bots-title">Connected bots</h2>
      {board === undefined ? <LoadingState>Checking connected bots…</LoadingState>
        : board === "unavailable" ? <UnavailableState>Connected bots could not be checked.</UnavailableState>
          : connected.length === 0 ? <p>No bots are connected yet.</p> : <ul className="private-local-agent-list">{connected.map(worker => {
            const [label, tone] = statusWords[worker.status] ?? [worker.status, "neutral" as ChipTone];
            return <li className="private-local-agent-card" key={worker.workerId}><h3>{worker.displayName}</h3>
              <p><StateChip state={worker.status} label={label} tone={tone} /> {bots.find(([kind]) => kind === worker.workerKind)?.[1] ?? worker.workerKind}</p>
              <div className="private-actions"><button type="button" disabled={busy} onClick={() => {
                if (!confirm(`Remove ${worker.displayName}? It will lose access immediately.`)) return;
                setBusy(true); setMessage(undefined);
                void request(`/api/v1/fleet/workers/${encodeURIComponent(worker.workerId)}/revoke`, {})
                  .then(() => { setMessage(`${worker.displayName} was removed. Its Control Room access no longer works.`); return load(); })
                  .catch(() => setMessage("The bot was not removed. Nothing changed."))
                  .finally(() => setBusy(false));
              }}>Remove</button></div></li>;
          })}</ul>}
    </section>
    <section className="private-panel connect-bot-help" aria-labelledby="connect-bot-help-title"><h2 id="connect-bot-help-title">What happens next</h2>
      <ol><li>Paste the line only into the named terminal on the computer where the bot runs.</li>
        <li>The line downloads the current connector release and checks its manifest, file size and SHA-256 shown by this signed-in Control Room.</li>
        <li>The bot gets its own removable credential. The one-time code expires after 10 minutes.</li></ol>
      <p>Claude Desktop and Cursor need to be restarted after the line finishes. If the fingerprint does not match,
        nothing is installed. Create a fresh code instead of editing the line.</p>
    </section>
  </main></div>;
}
