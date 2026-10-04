"use client";
import { useEffect, useState } from "react";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import { createReusableSkillBrowserClientV1, newSkillCreateActionKeyV1, type ReusableSkillViewV1 } from "../../src/web/v1/reusable-skill-browser-client";

const defaultReusableSkillClient = createReusableSkillBrowserClientV1();

export function ReusableSkillsPanel({ projectId, client = defaultReusableSkillClient }: {
  projectId: string; client?: ReturnType<typeof createReusableSkillBrowserClientV1>;
}) {
  const [skills, setSkills] = useState<readonly ReusableSkillViewV1[]>([]), [name, setName] = useState("");
  const [instructions, setInstructions] = useState(""), [editing, setEditing] = useState<ReusableSkillViewV1>();
  const [pending, setPending] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState("");
  const [conflict, setConflict] = useState(false), [uncertain, setUncertain] = useState(false);
  const [checked, setChecked] = useState(false);
  // The action key for the create currently being attempted. It is generated
  // when the owner first presses Create and REUSED for every retry of that same
  // action, so a save whose reply was lost returns the original skill instead
  // of creating a second one. A new press after a success makes a new key, so
  // a deliberate duplicate stays deliberate. Cleared with the form.
  const [createKey, setCreateKey] = useState<string>();
  const load = (after?: string, into: { all: ReusableSkillViewV1[]; seen: Set<string> } = { all: [], seen: new Set() }): Promise<void> => {
    // Follow every page, so a skill beyond the first page is actually shown
    // here rather than only existing. The server reports `nextCursor` when a
    // page is full, so there is never a silent truncation to guess about. A
    // cursor that repeated would loop forever, so the seen set bounds it.
    return client.list(projectId, after).then(page => {
      for (const skill of page.skills) if (!into.seen.has(skill.skillId)) { into.seen.add(skill.skillId); into.all.push(skill); }
      const next = page.nextCursor && !into.seen.has(page.nextCursor) ? page.nextCursor : null;
      return next ? load(next, into) : undefined;
    });
  };
  useEffect(() => {
    let live = true;
    const into = { all: [] as ReusableSkillViewV1[], seen: new Set<string>() };
    void load(undefined, into).then(() => { if (live) setSkills(into.all); }, failure => {
      if (live) setError(browserErrorMessage[failure instanceof BrowserRequestError ? failure.code : "unavailable"]);
    });
    return () => { live = false; };
  }, [client, projectId]);
  async function refresh() {
    if (pending) return;
    setPending(true);
    try {
      const into = { all: [] as ReusableSkillViewV1[], seen: new Set<string>() };
      await load(undefined, into);
      setSkills(into.all);
      if (conflict && editing) {
        const current = into.all.find(skill => skill.skillId === editing.skillId && skill.state === "active");
        if (!current) throw new BrowserRequestError("not_found");
        setEditing(current); setName(current.name); setConflict(false);
        setSaved(`Current version ${current.currentVersion} loaded. Your unsaved instructions are preserved; review them before saving.`);
      }
      setChecked(true); setError(undefined);
    } catch (failure) { setError(browserErrorMessage[failure instanceof BrowserRequestError ? failure.code : "unavailable"]); }
    finally { setPending(false); }
  }
  async function save(actionKey?: string) {
    if (pending || conflict || uncertain) return;
    setPending(true); setError(undefined); setSaved("");
    try {
      if (editing) await client.update(projectId, editing.skillId,
        { instructions, expectedVersion: editing.currentVersion });
      else await client.create(projectId, { name, instructions }, actionKey ?? createKey ?? newSkillCreateActionKeyV1());
      setSaved(editing ? "A new skill version was created." : "Reusable skill created at version 1.");
      setEditing(undefined); setCreateKey(undefined); setName(""); setInstructions("");
      const into = { all: [] as ReusableSkillViewV1[], seen: new Set<string>() };
      await load(undefined, into).then(() => { setSkills(into.all); setError(undefined); }, () => {});
    } catch (failure) {
      const code = failure instanceof BrowserRequestError ? failure.code : "uncertain";
      if (code === "conflict" && editing) setConflict(true);
      if (code === "uncertain") { setUncertain(true); setChecked(false); }
      setError(code === "conflict" && editing ? "A newer version exists. Refresh the current version; your unsaved instructions will be kept."
        : code === "uncertain" ? undefined : browserErrorMessage[code]);
    } finally { setPending(false); }
  }
  return <section className="private-panel" aria-label="Reusable skills">
    <h2>Reusable skills</h2>
    <p>Save proven instructions as text. Updating one creates a new version; tasks keep the exact version they used.</p>
    {/* Editing the draft after a failed save makes it a DIFFERENT action, so
        the key is cleared with it. Reusing the key for changed content would
        return 409, because the server binds one key to one exact body - which
        is the right refusal, and a dead end here. An UNCHANGED retry still
        reuses the key, which is the case the key exists for. */}
    <label htmlFor="skill-name">Name</label><input id="skill-name" value={name} disabled={pending || uncertain || !!editing}
      onChange={event => { setName(event.target.value); setCreateKey(undefined); }} />
    <label htmlFor="skill-instructions">Instruction block</label><textarea id="skill-instructions" value={instructions}
      disabled={pending || uncertain} onChange={event => { setInstructions(event.target.value); setCreateKey(undefined); }} />
    {editing && <details><summary>Loaded saved instructions (version {editing.currentVersion})</summary><pre>{editing.instructions}</pre></details>}
    <div className="private-actions"><button type="button" disabled={pending || conflict || uncertain || !instructions || (!editing && !name)}
      onClick={() => { if (editing) { void save(); return; }
        // The key is generated HERE and passed into the call, not stored first
        // and read back: setState is asynchronous, so a key stashed in state
        // this tick would still be undefined inside save(). The stored value
        // is what a RETRY reuses, and a retry happens on a later tick, by which
        // point the state is committed.
        const key = createKey ?? newSkillCreateActionKeyV1();
        setCreateKey(key); void save(key);
      }}>{pending ? "Saving…" : editing ? "Create new version" : "Create skill"}</button>
      {editing && <button type="button" disabled={pending || uncertain} onClick={() => {
        setEditing(undefined); setCreateKey(undefined); setName(""); setInstructions(""); setConflict(false);
      }}>Cancel edit</button>}</div>
    {conflict && <button type="button" disabled={pending} onClick={() => { void refresh(); }}>Refresh current version</button>}
    {error && !conflict && !uncertain && <button type="button" disabled={pending}
      onClick={() => { void refresh(); }}>Refresh saved skills</button>}
    {uncertain && <><p role="alert">The save may have completed. Refresh saved skills and inspect their versions and instructions.
      This draft will not be sent again.</p>
      <button type="button" disabled={pending} onClick={() => { void refresh(); }}>Refresh saved skills</button>
      <button type="button" disabled={pending || !checked} onClick={() => {
        setUncertain(false); setEditing(undefined); setName(""); setInstructions(""); setSaved(""); setError(undefined);
      }}>Discard draft after checking saved skills</button></>}
    {saved && <p role="status">{saved}</p>}{error && <p role="alert">{error}</p>}
    {!skills.length ? <p className="private-note">No reusable skills are saved for this project.</p>
      : <ul>{skills.map(skill => <li key={skill.skillId}><strong>{skill.name}</strong> — version {skill.currentVersion}
        {uncertain && <details><summary>Saved instructions</summary><pre>{skill.instructions}</pre></details>}
        <div className="private-actions"><button type="button" disabled={pending || uncertain} onClick={() => {
          setEditing(skill); setName(skill.name); setInstructions(skill.instructions); setConflict(false); setError(undefined); setSaved("");
        }}>Create new version</button></div></li>)}</ul>}
    <p className="private-note">Skills are inert text. They do not run code or grant authority.</p>
  </section>;
}
