"use client";
import { useEffect, useState } from "react";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import { createReusableSkillBrowserClientV1, type ReusableSkillViewV1 } from "../../src/web/v1/reusable-skill-browser-client";

const defaultReusableSkillClient = createReusableSkillBrowserClientV1();

export function ReusableSkillsPanel({ projectId, client = defaultReusableSkillClient }: {
  projectId: string; client?: ReturnType<typeof createReusableSkillBrowserClientV1>;
}) {
  const [skills, setSkills] = useState<readonly ReusableSkillViewV1[]>([]), [name, setName] = useState("");
  const [instructions, setInstructions] = useState(""), [editing, setEditing] = useState<ReusableSkillViewV1>();
  const [pending, setPending] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState("");
  const load = () => client.list(projectId).then(page => { setSkills(page.skills); setError(undefined); }, failure => {
    setError(browserErrorMessage[failure instanceof BrowserRequestError ? failure.code : "unavailable"]);
  });
  useEffect(() => { let live = true; void client.list(projectId).then(page => { if (live) setSkills(page.skills); }, failure => {
    if (live) setError(browserErrorMessage[failure instanceof BrowserRequestError ? failure.code : "unavailable"]);
  }); return () => { live = false; }; }, [client, projectId]);
  async function save() {
    if (pending) return;
    setPending(true); setError(undefined); setSaved("");
    try {
      if (editing) await client.update(projectId, editing.skillId,
        { instructions, expectedVersion: editing.currentVersion });
      else await client.create(projectId, { name, instructions });
      setSaved(editing ? "A new skill version was created." : "Reusable skill created at version 1.");
      setEditing(undefined); setName(""); setInstructions(""); await load();
    } catch (failure) {
      setError(browserErrorMessage[failure instanceof BrowserRequestError ? failure.code : "unavailable"]);
    } finally { setPending(false); }
  }
  return <section className="private-panel" aria-label="Reusable skills">
    <h2>Reusable skills</h2>
    <p>Save proven instructions as text. Updating one creates a new version; tasks keep the exact version they used.</p>
    <label htmlFor="skill-name">Name</label><input id="skill-name" value={name} disabled={pending || !!editing}
      onChange={event => setName(event.target.value)} />
    <label htmlFor="skill-instructions">Instruction block</label><textarea id="skill-instructions" value={instructions}
      disabled={pending} onChange={event => setInstructions(event.target.value)} />
    <div className="private-actions"><button type="button" disabled={pending || !instructions || (!editing && !name)}
      onClick={() => { void save(); }}>{pending ? "Saving…" : editing ? "Create new version" : "Create skill"}</button>
      {editing && <button type="button" disabled={pending} onClick={() => {
        setEditing(undefined); setName(""); setInstructions("");
      }}>Cancel edit</button>}</div>
    {saved && <p role="status">{saved}</p>}{error && <p role="alert">{error}</p>}
    {!skills.length ? <p className="private-note">No reusable skills are saved for this project.</p>
      : <ul>{skills.map(skill => <li key={skill.skillId}><strong>{skill.name}</strong> — version {skill.currentVersion}
        <div className="private-actions"><button type="button" disabled={pending} onClick={() => {
          setEditing(skill); setName(skill.name); setInstructions(skill.instructions);
        }}>Create new version</button></div></li>)}</ul>}
    <p className="private-note">Skills are inert text. They do not run code or grant authority.</p>
  </section>;
}
