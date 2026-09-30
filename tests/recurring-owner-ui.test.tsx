import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
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
  await skills.create("project:test", { name: "Review", instructions: "Cite evidence." });
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
  const skillClient = { list: async () => ({ projectId: "project:test", skills: [], startsWork: false as const,
    grantsExecutionAuthority: false as const }), create: async () => ({}), update: async () => ({}) };
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
