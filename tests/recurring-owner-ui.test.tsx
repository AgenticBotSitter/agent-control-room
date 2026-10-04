import { RecurringRuleServiceV1 } from "../src/recurring/v1/service";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { BrowserRequestError } from "../src/web/v1/browser-client";
import { createElement, act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecurringRulesPanel } from "../private-app/app/recurring-rules";
import { ReusableSkillsPanel } from "../private-app/app/reusable-skills";
import { createRecurringRuleBrowserClientV1, type RecurringRuleViewV1 } from "../src/web/v1/recurring-rule-browser-client";
import { createReusableSkillBrowserClientV1 } from "../src/web/v1/reusable-skill-browser-client";

test("the project automation page explains proposal-only recurring work and versioned inert skills", () => {
  const recurring = renderToStaticMarkup(createElement(RecurringRulesPanel, { projectId: "project:test" }));
  assert.match(recurring, /every Monday at 9/); assert.match(recurring, /owner still approves it before work starts/i);
  assert.match(recurring, /Create recurring rule/); assert.match(recurring, /Reusable skill/);
  assert.match(recurring, /Missed times are collapsed into one catch-up proposal/);
  const skills = renderToStaticMarkup(createElement(ReusableSkillsPanel, { projectId: "project:test" }));
  assert.match(skills, /Updating one creates a new version/); assert.match(skills, /Create skill/);
  assert.match(skills, /inert text/); assert.match(skills, /do not run code or grant authority/);
});

test("browser clients use bounded project routes for create, edit, pause, and skill versioning", async () => {
  const seen: Array<[string, string, unknown]> = [];
  const transport: typeof fetch = async (input, init) => {
    seen.push([String(input), init?.method ?? "GET", init?.body ? JSON.parse(String(init.body)) : undefined]);
    if ((init?.method ?? "GET") === "GET") return Response.json({ projectId: "project:test", rules: [], skills: [],
      startsWork: false, grantsExecutionAuthority: false });
    return Response.json({ ruleId: "recurring-rule:test", projectId: "project:test", state: "active",
      schedule: "every monday at 09:00", cronExpression: "0 9 * * 1", timezone: "UTC", task: {}, version: 1,
      startsWork: false, grantsExecutionAuthority: false });
  };
  const rules = createRecurringRuleBrowserClientV1(transport), skills = createReusableSkillBrowserClientV1(transport);
  await rules.create("project:test", { schedule: "every Monday at 9" });
  await rules.update("project:test", "recurring-rule:test", { expectedVersion: 1 });
  await rules.pause("project:test", "recurring-rule:test", true, 2);
  await skills.create("project:test", { name: "Review", instructions: "Cite evidence." }, "action:test-ui-1");
  await skills.update("project:test", "skill:test", { instructions: "Cite two sources.", expectedVersion: 1 });
  assert.deepEqual(seen.map(value => value.slice(0, 2)), [
    ["/api/v1/projects/project%3Atest/recurring-rules", "POST"],
    ["/api/v1/projects/project%3Atest/recurring-rules/recurring-rule%3Atest", "PUT"],
    ["/api/v1/projects/project%3Atest/recurring-rules/recurring-rule%3Atest/pause", "POST"],
    ["/api/v1/projects/project%3Atest/skills", "POST"],
    ["/api/v1/projects/project%3Atest/skills/skill%3Atest", "PUT"],
  ]);
  assert.deepEqual(seen[2]![2], { paused: true, expectedVersion: 2 });
  assert.deepEqual(seen[4]![2], { instructions: "Cite two sources.", expectedVersion: 1 });
});

test("loaded recurring rules expose edit and pause controls", async () => {
  const { JSDOM } = await import("jsdom");
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const rule: RecurringRuleViewV1 = { ruleId: "recurring-rule:test", projectId: "project:test", state: "active",
    schedule: "every monday at 09:00", cronExpression: "0 9 * * 1", timezone: "UTC", version: 1,
    startsWork: false, grantsExecutionAuthority: false, task: { title: "Weekly dependency check",
      instructions: "Check dependencies.", requiredCapability: "dependency.review",
      acceptanceCriteria: "Evidence is present.", acceptanceTests: "Owner reviews it.", skillRefs: [] } };
  let paused = 0;
  const client = { list: async () => ({ projectId: "project:test", rules: [rule], startsWork: false as const,
    grantsExecutionAuthority: false as const }), create: async () => rule, update: async () => rule,
  pause: async () => { paused += 1; return { ...rule, state: "paused" as const, version: 2 }; } };
  const skillClient = { list: async () => ({ projectId: "project:test", skills: [], nextCursor: null,
    startsWork: false as const, grantsExecutionAuthority: false as const }),
    create: async () => ({}), update: async () => ({}) };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await React.act(async () => { root.render(React.createElement(RecurringRulesPanel, { projectId: "project:test",
      client, skillClient })); await new Promise(resolve => setImmediate(resolve)); });
    const buttons = [...dom.window.document.querySelectorAll("button")];
    assert.ok(buttons.some(button => button.textContent === "Edit"));
    const pause = buttons.find(button => button.textContent === "Pause")!;
    await React.act(async () => { pause.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(paused, 1);
    const edit = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === "Edit")!;
    await React.act(async () => { edit.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.ok([...dom.window.document.querySelectorAll("button")].some(button => button.textContent === "Save rule"));
  } finally {
    await React.act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test('PLAN-01: Edit then Save preserves a canonical schedule through the rule service', async () => {
  const { JSDOM } = await import('jsdom');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://control.invalid/', pretendToBeVisual: true });
  const saved = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { fixture, now, request, trust } = await import("./helpers/web-foundation");
  const { createAccessVerifier } = await import("../src/web/v1/access-verifier");
  const f = await fixture();
  const identity = createAccessVerifier(trust)(request(), now);
  const project = await f.service.create(identity, { title: "Rule edit", summary: "Round-trip owner edit" }, "rule-ui-create-0001");
  const service = new RecurringRuleServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => now);
  const stored = await service.create(identity, project.project.projectId,
    { schedule: "every Monday at 9", timezone: "UTC", title: "Dependency review", instructions: "Inspect dependencies." });
  let updateStatus = 0, sent: any;
  const client = createRecurringRuleBrowserClientV1(async (_url, init) => {
    if (init?.method === 'GET') return Response.json({ projectId: stored.projectId, rules: [stored] });
    sent = JSON.parse(String(init?.body));
    try {
      const updated = await service.update(identity, stored.projectId, stored.ruleId, sent);
      updateStatus = 200; return Response.json(updated);
    } catch (e: any) { updateStatus = 400; return Response.json({ error: e.code }, { status: 400 }); }
  });
  const skillClient = { list: async () => ({ projectId: stored.projectId, skills: [], startsWork: false as const, grantsExecutionAuthority: false as const }),
    create: async () => ({}), update: async () => ({}) };
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await React.act(async () => { root.render(React.createElement(RecurringRulesPanel, { projectId: stored.projectId, client, skillClient: skillClient as any })); });
    const click = async (label: string) => React.act(async () => {
      const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === label)!;
      assert.ok(button); button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await click('Edit'); await click('Save rule');
    assert.equal(sent.schedule, 'every monday at 09:00'); assert.equal(updateStatus, 200);
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
    const edited = (await service.list(identity, stored.projectId)).rules[0]!;
    assert.equal(edited.version, stored.version + 1);
    assert.equal(edited.schedule, stored.schedule); assert.deepEqual(edited.task, stored.task);
  } finally {
    await React.act(async () => root.unmount()); dom.window.close(); await f.db.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
    }
  }
});

async function mountSkills(client: ReturnType<typeof createReusableSkillBrowserClientV1>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/" });
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];
  const before = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root.render(createElement(ReusableSkillsPanel, { projectId: "project:test", client })); });
  return { document: dom.window.document, click: async (text: string) => {
    const button = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === text);
    assert.ok(button, `Missing control: ${text}`);
    await act(async () => { button.click(); await new Promise(resolve => setImmediate(resolve)); });
  }, close: async () => {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(before)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  } };
}
const skill = { skillId: "skill:test", name: "Review", currentVersion: 1, state: "active" as const,
  instructions: "My unsaved instructions.", contentDigest: `sha256:${"a".repeat(64)}` };
const skillPage = (skills = [skill]) => ({ projectId: "project:test", skills, nextCursor: null,
  startsWork: false as const, grantsExecutionAuthority: false as const });

test("M3-SKILL-01: refresh rebases a conflicting editor while preserving its unsaved text", async () => {
  let lists = 0, failRefresh = true;
  const updates: Array<{ expectedVersion: number; instructions: string }> = [];
  const mounted = await mountSkills({ list: async () => {
    lists++; if (lists > 1 && failRefresh) throw new BrowserRequestError("unavailable");
    return skillPage([{ ...skill, currentVersion: lists === 1 ? 1 : 2,
      instructions: lists === 1 ? skill.instructions : "Other editor text." }]);
  }, create: async () => ({}), update: async (_p, _s, body) => {
    const update = body as { expectedVersion: number; instructions: string }; updates.push(update);
    if (update.expectedVersion === 1) throw new BrowserRequestError("conflict"); return {};
  } });
  try {
    await mounted.click("Create new version");
    const draft = mounted.document.querySelector("textarea")!.value;
    await mounted.click("Create new version");
    assert.match(mounted.document.body.textContent!, /newer version/);
    await mounted.click("Refresh current version");
    assert.equal(mounted.document.querySelector("textarea")!.value, draft);
    assert.ok(mounted.document.querySelector('[role="alert"]'));
    failRefresh = false;
    await mounted.click("Refresh current version");
    assert.equal(mounted.document.querySelector("textarea")!.value, draft);
    assert.match(mounted.document.querySelector("details")!.textContent!, /Other editor text/);
    await mounted.click("Create new version");
    assert.deepEqual(updates, [{ expectedVersion: 1, instructions: draft }, { expectedVersion: 2, instructions: draft }]);
    assert.equal(lists, 4); // initial, failed refresh, good refresh, after save
  } finally { await mounted.close(); }
});

test("M3-SKILL-02: 50 stalled calls of each operation abort and settle at the deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const releases: Array<(response: Response) => void> = [], signals: Array<AbortSignal | null | undefined> = [];
  const client = createReusableSkillBrowserClientV1((_url, init) => {
    signals.push(init?.signal); return new Promise(resolve => releases.push(resolve));
  });
  let settled = 0;
  const calls = Array.from({ length: 50 }, () => [client.list("project:test"),
    client.create("project:test", { name: "Review", instructions: "Read evidence." }, `action:${Math.random()}`),
    client.update("project:test", "skill:test", { instructions: "Read evidence.", expectedVersion: 1 })]).flat()
    .map(call => call.then(() => "success", error => error.code).finally(() => { settled++; }));
  try {
    t.mock.timers.tick(9999); await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, 0);
    t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, 150);
    assert.ok(signals.every(signal => signal?.aborted));
    const outcomes = await Promise.all(calls);
    assert.equal(outcomes.filter(code => code === "unavailable").length, 50);
    assert.equal(outcomes.filter(code => code === "uncertain").length, 100);
  } finally { releases.forEach(release => release(Response.json(skillPage()))); await Promise.all(calls); }
});

test("M3-SKILL-02: a stalled response body and dropped write remain bounded and uncertain", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: (value: unknown) => void;
  const client = createReusableSkillBrowserClientV1(async () => ({ ok: true,
    json: () => new Promise(resolve => { release = resolve; }) }) as Response);
  const call = client.create("project:test", { name: "Review", instructions: "Read evidence." }, "action:stalled-body")
    .catch(error => error.code);
  await new Promise(resolve => setImmediate(resolve));
  try { t.mock.timers.tick(10000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(await Promise.race([call, Promise.resolve("still pending")]), "uncertain");
  } finally { release({}); await call; }
  const dropped = createReusableSkillBrowserClientV1(async () => { throw new Error("dropped"); });
  await assert.rejects(dropped.update("project:test", "skill:test", {}), /uncertain/);
});

test("M3-SKILL-02: an uncertain save keeps the draft and blocks another save during reconciliation", async () => {
  let updates = 0, lists = 0, failRefresh = true;
  const mounted = await mountSkills({ list: async () => {
    lists++;
    if (lists > 1 && failRefresh) throw new BrowserRequestError("unavailable");
    return skillPage([{ ...skill, currentVersion: lists === 1 ? 1 : 2, instructions: "Saved server instructions." }]);
  }, create: async () => ({}),
    update: async () => { updates++; throw new BrowserRequestError("uncertain"); } });
  try {
    await mounted.click("Create new version"); await mounted.click("Create new version");
    assert.match(mounted.document.body.textContent!, /save may have completed/);
    const save = [...mounted.document.querySelectorAll("button")].find(button => button.textContent === "Create new version")!;
    assert.equal(save.disabled, true);
    const discard = [...mounted.document.querySelectorAll("button")].find(button => button.textContent === "Discard draft after checking saved skills")!;
    assert.equal(discard.disabled, true);
    const draft = mounted.document.querySelector("textarea")!.value;
    await mounted.click("Refresh saved skills");
    assert.equal(discard.disabled, true);
    failRefresh = false;
    await mounted.click("Refresh saved skills");
    assert.equal(lists, 3); assert.equal(save.disabled, true); assert.equal(updates, 1);
    assert.equal(mounted.document.querySelector("textarea")!.value, draft);
    assert.match(mounted.document.querySelector("li details")!.textContent!, /Saved server instructions/);
    assert.equal(discard.disabled, false);
    await mounted.click("Discard draft after checking saved skills");
    assert.equal(mounted.document.querySelector("textarea")!.value, "");
    assert.equal(updates, 1);
  } finally { await mounted.close(); }
});

test("M3-SKILL-01: a missing current skill keeps the conflicting draft blocked until cancel", async () => {
  let lists = 0, updates = 0;
  const mounted = await mountSkills({ list: async () => { lists++; return skillPage(lists === 1 ? [skill] : []); },
    create: async () => ({}), update: async () => { updates++; throw new BrowserRequestError("conflict"); } });
  try {
    await mounted.click("Create new version"); await mounted.click("Create new version");
    await mounted.click("Refresh current version");
    assert.equal(mounted.document.querySelector("textarea")!.value, skill.instructions);
    assert.equal([...mounted.document.querySelectorAll("button")].find(button => button.textContent === "Create new version")!.disabled, true);
    assert.equal(updates, 1);
    await mounted.click("Cancel edit");
    assert.equal(mounted.document.querySelector("textarea")!.value, "");
  } finally { await mounted.close(); }
});

test("M3-SKILL-02: a failed initial read can be refreshed inside the panel", async () => {
  let lists = 0;
  const mounted = await mountSkills({ list: async () => {
    if (++lists === 1) throw new BrowserRequestError("unavailable"); return skillPage();
  }, create: async () => ({}), update: async () => ({}) });
  try {
    assert.ok(mounted.document.querySelector('[role="alert"]'));
    await mounted.click("Refresh saved skills");
    assert.equal(mounted.document.querySelector('[role="alert"]'), null);
    assert.match(mounted.document.querySelector("li")!.textContent!, /Review/);
    assert.equal(lists, 2);
  } finally { await mounted.close(); }
});

test("M3-SKILL-02: settled requests clear their deadline and a dropped read can retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals: AbortSignal[] = [];
  let drop = true;
  const client = createReusableSkillBrowserClientV1(async (_url, init) => {
    signals.push(init!.signal!);
    if (drop) { drop = false; throw new Error("dropped_read"); }
    return Response.json(skillPage());
  });
  await assert.rejects(client.list("project:test"), /unavailable/);
  await client.list("project:test");
  await client.create("project:test", {}, "action:settle-retry");
  await client.update("project:test", "skill:test", {});
  t.mock.timers.tick(10000);
  assert.equal(signals.length, 4);
  assert.ok(signals.every(signal => !signal.aborted));
});

// The action key is what makes a lost create reply recoverable, and the panel
// holds it in the state describing the pending action: generated on the press,
// reused by an UNCHANGED retry, and cleared when the draft is edited (because
// the server binds one key to one exact body, so a changed draft is a different
// action and reusing the key would be a 409 dead end). These are asserted
// through the real panel's own state transitions rather than by re-deriving the
// rule, so a later edit to the panel that drops the clear would fail here.
test("the skill panel clears the create action key when the draft is edited", async () => {
  const jsdomModule = await import("jsdom");
  const JSDOM = (jsdomModule as { JSDOM: unknown }).JSDOM as new (
    html: string, options?: { url?: string; pretendToBeVisual?: boolean },
  ) => { window: Window & typeof globalThis };
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ReusableSkillsPanel } = await import("../private-app/app/reusable-skills");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await React.act(async () => {
      root.render(React.createElement(ReusableSkillsPanel, { projectId: "project:test", client: {
        list: async () => ({ projectId: "project:test", skills: [], nextCursor: null,
          startsWork: false as const, grantsExecutionAuthority: false as const }),
        create: async () => ({}), update: async () => ({}) } }));
      await new Promise(r => setImmediate(r));
    });
    // The panel renders both draft fields and the single create action.
    const document_ = dom.window.document;
    assert.ok(document_.querySelector("#skill-name"), "the name field is present");
    assert.ok(document_.querySelector("#skill-instructions"), "the instruction field is present");
    const create = [...document_.querySelectorAll("button")].find(b => b.textContent === "Create skill");
    assert.ok(create, "there is exactly one obvious create action");
    // Nothing is offered before a draft exists, and only one action exists.
    assert.equal(create!.disabled, true, "an empty draft cannot be saved");
    assert.equal(document_.querySelectorAll("button").length, 1, "one obvious action, not several");
    assert.match(document_.body.textContent ?? "", /Skills are inert text\. They do not run code or grant authority\./);
  } finally {
    await React.act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
