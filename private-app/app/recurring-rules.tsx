"use client";
import { useEffect, useState } from "react";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import { createRecurringRuleBrowserClientV1, type RecurringRuleViewV1 } from "../../src/web/v1/recurring-rule-browser-client";
import { createReusableSkillBrowserClientV1, type ReusableSkillViewV1 } from "../../src/web/v1/reusable-skill-browser-client";

type Draft = { schedule: string; timezone: string; title: string; instructions: string; requiredCapability: string;
  acceptanceCriteria: string; acceptanceTests: string; skillRefs: Array<{ skillId: string; version: number }> };
const blank: Draft = { schedule: "every Monday at 9", timezone: "UTC", title: "Weekly dependency check",
  instructions: "Check project dependencies and propose safe updates for owner review.",
  requiredCapability: "task.proposal.review", acceptanceCriteria: "The dependency report is complete.",
  acceptanceTests: "Review the report before approving any follow-up work.", skillRefs: [] };
const defaultRecurringRuleClient = createRecurringRuleBrowserClientV1();
const defaultReusableSkillClient = createReusableSkillBrowserClientV1();

export function RecurringRulesPanel({ projectId, client = defaultRecurringRuleClient,
  skillClient = defaultReusableSkillClient }: {
  projectId: string; client?: ReturnType<typeof createRecurringRuleBrowserClientV1>;
  skillClient?: ReturnType<typeof createReusableSkillBrowserClientV1>;
}) {
  const [rules, setRules] = useState<readonly RecurringRuleViewV1[]>([]), [draft, setDraft] = useState(blank);
  const [skills, setSkills] = useState<readonly ReusableSkillViewV1[]>([]);
  const [editing, setEditing] = useState<RecurringRuleViewV1>(), [pending, setPending] = useState(false);
  const [error, setError] = useState<string>(), [saved, setSaved] = useState("");
  const load = () => client.list(projectId).then(page => { setRules(page.rules); setError(undefined); }, failure => {
    const code = failure instanceof BrowserRequestError ? failure.code : "unavailable";
    setError(browserErrorMessage[code]);
  });
  useEffect(() => { let live = true; void client.list(projectId).then(page => { if (live) setRules(page.rules); }, failure => {
    if (live) setError(browserErrorMessage[failure instanceof BrowserRequestError ? failure.code : "unavailable"]);
  }); void skillClient.list(projectId).then(page => { if (live) setSkills(page.skills); }, failure => {
    if (live) setError(browserErrorMessage[failure instanceof BrowserRequestError ? failure.code : "unavailable"]);
  }); return () => { live = false; }; }, [client, projectId, skillClient]);
  const field = (name: "schedule" | "timezone" | "title" | "instructions", value: string) =>
    setDraft(previous => ({ ...previous, [name]: value }));
  async function save() {
    if (pending) return;
    setPending(true); setError(undefined); setSaved("");
    try {
      if (editing) await client.update(projectId, editing.ruleId, { ...draft, expectedVersion: editing.version });
      else await client.create(projectId, draft);
      setEditing(undefined); setDraft(blank); setSaved(editing ? "Recurring rule updated." : "Recurring rule created for owner approval proposals.");
      await load();
    } catch (failure) {
      const code = failure instanceof BrowserRequestError ? failure.code : "unavailable";
      setError(browserErrorMessage[code]);
    } finally { setPending(false); }
  }
  async function pause(rule: RecurringRuleViewV1) {
    if (pending) return;
    setPending(true); setError(undefined);
    try { await client.pause(projectId, rule.ruleId, rule.state === "active", rule.version); await load(); }
    catch (failure) { const code = failure instanceof BrowserRequestError ? failure.code : "unavailable";
      setError(browserErrorMessage[code]); }
    finally { setPending(false); }
  }
  function edit(rule: RecurringRuleViewV1) {
    const skillRefs = rule.task.skillRefs.filter((value): value is { skillId: string; version: number } => {
      const item = value as { skillId?: unknown; version?: unknown };
      return typeof item?.skillId === "string" && Number.isSafeInteger(item.version) && Number(item.version) > 0;
    });
    setEditing(rule); setDraft({ ...blank, ...rule.task, schedule: rule.schedule, timezone: rule.timezone, skillRefs });
  }
  return <section className="private-panel" aria-label="Recurring work">
    <h2>Recurring work</h2>
    <p>Describe a schedule in plain words. When it is due, Control Room proposes one task. The owner still approves it before work starts.</p>
    <label htmlFor="recurring-schedule">When</label>
    <input id="recurring-schedule" value={draft.schedule} disabled={pending}
      onChange={event => field("schedule", event.target.value)} placeholder="every Monday at 9" />
    <label htmlFor="recurring-timezone">Timezone</label>
    <input id="recurring-timezone" value={draft.timezone} disabled={pending}
      onChange={event => field("timezone", event.target.value)} />
    <label htmlFor="recurring-title">Task title</label>
    <input id="recurring-title" value={draft.title} disabled={pending}
      onChange={event => field("title", event.target.value)} />
    <label htmlFor="recurring-instructions">Instructions</label>
    <textarea id="recurring-instructions" value={draft.instructions} disabled={pending}
      onChange={event => field("instructions", event.target.value)} />
    <label htmlFor="recurring-skill">Reusable skill</label>
    <select id="recurring-skill" disabled={pending} value={draft.skillRefs[0]
      ? `${draft.skillRefs[0].skillId}\u0000${draft.skillRefs[0].version}` : ""} onChange={event => {
      const selected = skills.find(skill => `${skill.skillId}\u0000${skill.currentVersion}` === event.target.value);
      setDraft(previous => ({ ...previous, skillRefs: selected
        ? [{ skillId: selected.skillId, version: selected.currentVersion }] : [] }));
    }}><option value="">No reusable skill</option>{skills.filter(skill => skill.state === "active").map(skill =>
      <option key={`${skill.skillId}:${skill.currentVersion}`} value={`${skill.skillId}\u0000${skill.currentVersion}`}>
        {skill.name} — version {skill.currentVersion}</option>)}</select>
    <div className="private-actions"><button type="button" disabled={pending} onClick={() => { void save(); }}>
      {pending ? "Saving…" : editing ? "Save rule" : "Create recurring rule"}</button>
      {editing && <button type="button" disabled={pending} onClick={() => { setEditing(undefined); setDraft(blank); }}>Cancel edit</button>}</div>
    {saved && <p role="status">{saved}</p>}{error && <p role="alert">{error}</p>}
    {!rules.length ? <p className="private-note">No recurring rules are recorded for this project.</p>
      : <ul>{rules.map(rule => <li key={rule.ruleId}><strong>{rule.task.title}</strong> — {rule.schedule} ({rule.timezone}) — {rule.state}
        <div className="private-actions"><button type="button" disabled={pending} onClick={() => edit(rule)}>Edit</button>
          <button type="button" disabled={pending} onClick={() => { void pause(rule); }}>{rule.state === "active" ? "Pause" : "Resume"}</button></div>
      </li>)}</ul>}
    <p className="private-note">Missed times are collapsed into one catch-up proposal. Pause, Drain and Stop prevent new proposals.</p>
  </section>;
}
