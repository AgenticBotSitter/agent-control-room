import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChiefOfStaffSuggestionCard, ProjectOrchestrationPanel } from "../private-app/app/project-orchestration";
import { PipelineBatchDetail } from "../private-app/app/project-pipelines-workspace";
import type { ProjectOrchestrationSettingsV1, ProjectOrchestrationSuggestionV1 } from
  "../src/web/v1/project-orchestration-wire";
import type { createProjectOrchestrationBrowserClient } from "../src/web/v1/project-orchestration-browser-client";
import type { WorkBatchOwnerViewV1 } from "../src/work-intake/v1/owner-schemas";

const projectId = "project:test", batchId = "batch:test", now = "2026-09-29T12:00:00.000Z";
const option = { key: "planner:1", label: "worker:chief · model:plan · high", workerId: "worker:chief",
  workerKind: "codex" as const, modelKey: "model:plan", effort: "high" as const };
const settings = (mode: "selected" | "none"): ProjectOrchestrationSettingsV1 => ({ projectId, version: 1,
  choice: mode === "none" ? { mode: "none" } : { mode: "selected", workerId: option.workerId,
    workerKind: option.workerKind, modelKey: option.modelKey, effort: option.effort }, options: [option],
  startsWork: false, grantsExecutionAuthority: false });
const proposal = { schema: "control-room.work-batch-proposal/v1" as const, projectId,
  tasks: [{ localId: "first", title: "First part", instructions: "Do the first bounded part.",
    requiredCapability: "code.change", role: "builder" as const, acceptanceCriteria: "The first part works.",
    acceptanceTests: "Run the focused test." }], edges: [] };
const suggestion: ProjectOrchestrationSuggestionV1 = { suggestionId: "suggestion:test", batchId, projectId,
  baseRevision: 2, proposal, createdAt: now, dismissed: false, startsWork: false,
  grantsExecutionAuthority: false, savesRevision: false };

function enter(window: Window & typeof globalThis, textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  textarea.dispatchEvent(new window.Event("change", { bubbles: true }));
}

type Client = ReturnType<typeof createProjectOrchestrationBrowserClient>;
function client(readValue: ProjectOrchestrationSettingsV1,
  describe: Client["describe"] = async () => ({ status: "proposal", batchId,
    href: `/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(batchId)}`,
    startsWork: false, grantsExecutionAuthority: false })) {
  return { hasPendingDescription: () => false, readSettings: async () => readValue,
    saveSettings: async () => readValue, describe, retryDescription: async () => describe(projectId, "retry"),
    listSuggestions: async () => ({ projectId, batchId, suggestions: [], startsWork: false as const,
      grantsExecutionAuthority: false as const }),
    useSuggestion: async () => ({ proposal, startsWork: false as const, grantsExecutionAuthority: false as const,
      savesRevision: false as const }), dismissSuggestion: async () => {} } as Client;
}

async function mount(element: unknown) {
  const { JSDOM } = await import("jsdom"), React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => { root.render(element as never); });
  await React.act(async () => { await Promise.resolve(); });
  return { document: dom.window.document, window: dom.window, act: React.act, close: async () => {
    await React.act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) descriptor
      ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as Record<string, unknown>)[key];
  } };
}

test("describe moves from pending to a proposal link without claiming work started", async () => {
  let finish: ((value: Awaited<ReturnType<Client["describe"]>>) => void) | undefined;
  const deferred = new Promise<Awaited<ReturnType<Client["describe"]>>>(resolve => { finish = resolve; });
  const view = await mount(createElement(ProjectOrchestrationPanel, { projectId,
    client: client(settings("selected"), async () => deferred) }));
  try {
    const textarea = view.document.querySelector("textarea") as HTMLTextAreaElement;
    await view.act(async () => { enter(view.window, textarea, "Prepare a safe launch plan"); });
    const button = [...view.document.querySelectorAll("button")].find(value => value.textContent === "Prepare proposal");
    assert.ok(button); await view.act(async () => { button.click(); });
    assert.match(view.document.body.textContent ?? "", /preparing a proposal[\s\S]*No work has started/);
    assert.equal(button.disabled, true);
    await view.act(async () => { finish?.({ status: "proposal", batchId,
      href: "/projects/project%3Atest/pipelines/batch%3Atest", startsWork: false, grantsExecutionAuthority: false });
      await deferred; });
    const link = view.document.querySelector("a[href='/projects/project%3Atest/pipelines/batch%3Atest']");
    assert.ok(link); assert.match(link.textContent ?? "", /Review the proposal/);
    assert.doesNotMatch(view.document.body.textContent ?? "", /work has started successfully/i);
  } finally { await view.close(); }
});

test("none hides Describe a job, while planner failure is a plain Needs-you alert", async () => {
  const hidden = await mount(createElement(ProjectOrchestrationPanel, { projectId, client: client(settings("none")) }));
  try { assert.equal(hidden.document.body.textContent, ""); } finally { await hidden.close(); }
  const failed = await mount(createElement(ProjectOrchestrationPanel, { projectId,
    client: client(settings("selected"), async () => ({ status: "failed", needsYou: true,
      message: "Needs-you: the chief of staff could not prepare a proposal.", startsWork: false,
      grantsExecutionAuthority: false })) }));
  try {
    const textarea = failed.document.querySelector("textarea") as HTMLTextAreaElement;
    await failed.act(async () => { enter(failed.window, textarea, "Plan this"); });
    const button = [...failed.document.querySelectorAll("button")].find(value => value.textContent === "Prepare proposal");
    assert.ok(button); await failed.act(async () => { button.click(); await Promise.resolve(); });
    const alert = failed.document.querySelector("[role='alert']"); assert.ok(alert);
    assert.match(alert.textContent ?? "", /Needs-you: the chief of staff could not prepare a proposal/);
  } finally { await failed.close(); }
});

test("suggestion Use this and Dismiss are owner gestures, and the revision form shows the prefill", async () => {
  const calls: string[] = [];
  const view = await mount(createElement(ChiefOfStaffSuggestionCard, { suggestion,
    onUse: () => calls.push("use"), onDismiss: () => calls.push("dismiss") }));
  try {
    const buttons = [...view.document.querySelectorAll("button")];
    await view.act(async () => { buttons.find(value => value.textContent === "Use this")?.click(); });
    await view.act(async () => { buttons.find(value => value.textContent === "Dismiss")?.click(); });
    assert.deepEqual(calls, ["use", "dismiss"]);
    assert.match(view.document.body.textContent ?? "", /never applied automatically/);
  } finally { await view.close(); }
  const batchView = { batchId, projectId, state: "proposed", revision: 2, proposedByIdentityId: "identity:agent",
    proposedAt: now, approvalIdentityId: null, decidedAt: null, proposal, revisions: [], items: [], queue: [],
    queueDepthLimit: 10, flagsByLocalId: {}, startsWork: false, grantsExecutionAuthority: false } as WorkBatchOwnerViewV1;
  const html = renderToStaticMarkup(createElement(PipelineBatchDetail, { projectId,
    data: { state: "ready", value: batchView }, suggestions: [suggestion], revisionOpen: true,
    revisionReason: "chief_of_staff_split", revisionText: JSON.stringify(suggestion.proposal) }));
  assert.match(html, /Chief of staff suggests a new split/);
  assert.match(html, /<details open=""><summary>Revise this proposal/);
  assert.match(html, /chief_of_staff_split/);
  assert.match(html, /First part/);
});
