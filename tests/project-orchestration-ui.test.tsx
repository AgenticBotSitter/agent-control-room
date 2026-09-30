import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChiefOfStaffSuggestionCard, ProjectOrchestrationPanel, ProjectOrchestrationSettings } from
  "../private-app/app/project-orchestration";
import { PipelineBatchDetail, PrivateProjectPipelines } from "../private-app/app/project-pipelines-workspace";
import type { ProjectOrchestrationSettingsV1, ProjectOrchestrationSuggestionV1 } from
  "../src/web/v1/project-orchestration-wire";
import type { createProjectOrchestrationBrowserClient } from "../src/web/v1/project-orchestration-browser-client";
import type { WorkBatchOwnerViewV1 } from "../src/work-intake/v1/owner-schemas";
import { BrowserRequestError } from "../src/web/v1/browser-client";

const projectId = "project:test", batchId = "batch:test", now = "2026-09-29T12:00:00.000Z";
const option = { key: "planner:1", label: "worker:chief · model:plan · high", workerId: "worker:chief",
  workerKind: "codex" as const, modelKey: "model:plan", effort: "high" as const };
type SettingsOverrides = Partial<Pick<ProjectOrchestrationSettingsV1, "choiceStale" | "describeAvailable"
  | "dismissAvailable" | "choice" | "options" | "version">>;
const settings = (mode: "selected" | "none", overrides: SettingsOverrides = {}): ProjectOrchestrationSettingsV1 =>
  ({ projectId, version: 1,
    choice: mode === "none" ? { mode: "none" } : overrides.choice ?? { mode: "selected", workerId: option.workerId,
      workerKind: option.workerKind, modelKey: option.modelKey, effort: option.effort },
    options: overrides.options ?? [option], choiceStale: overrides.choiceStale ?? false,
    describeAvailable: overrides.describeAvailable ?? true, dismissAvailable: overrides.dismissAvailable ?? true,
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
type Calls = { describe: number; retry: number; save: number; use: number; dismiss: number; list: number };
function recordingClient(readValue: ProjectOrchestrationSettingsV1, calls: Calls,
  describe: Client["describe"] = async () => ({ status: "proposal", batchId,
    href: `/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(batchId)}`,
    startsWork: false, grantsExecutionAuthority: false })): Client {
  return Object.freeze({ hasPendingDescription: () => calls.describe > 0 && calls.retry > 0 && calls.describe === calls.retry,
    forgetPendingDescription() {},
    readSettings: async () => readValue,
    saveSettings: async () => { calls.save += 1; return readValue; },
    async describe(...args) { calls.describe += 1; return describe(...args); },
    async retryDescription() { calls.retry += 1; return describe(projectId, "retry"); },
    listSuggestions: async () => { calls.list += 1; return { projectId, batchId, suggestions: [],
      dismissAvailable: readValue.dismissAvailable, startsWork: false as const,
      grantsExecutionAuthority: false as const }; },
    useSuggestion: async () => { calls.use += 1; return { proposal, startsWork: false as const,
      grantsExecutionAuthority: false as const, savesRevision: false as const }; },
    async dismissSuggestion() { calls.dismiss += 1; } });
}
const noCalls = (): Calls => ({ describe: 0, retry: 0, save: 0, use: 0, dismiss: 0, list: 0 });

async function mount(element: ReactElement, environment: { fetch?: typeof fetch } = {}) {
  const { JSDOM } = await import("jsdom"), React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT", "fetch"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  // A page that builds its own browser client from the ambient fetch is only
  // observable if that fetch is recorded, so the global is swapped for the test
  // and restored with everything else.
  if (environment.fetch) Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true,
    value: environment.fetch });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => { root.render(element); });
  await React.act(async () => { await Promise.resolve(); });
  return { document: dom.window.document, window: dom.window, act: React.act, close: async () => {
    await React.act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) descriptor
      ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as Record<string, unknown>)[key];
  } };
}

const buttonNamed = (document: Document, name: string) =>
  [...document.querySelectorAll("button")].find(value => value.textContent === name);

test("describe moves from pending to a proposal link without claiming work started", async () => {
  let finish: ((value: Awaited<ReturnType<Client["describe"]>>) => void) | undefined;
  const deferred = new Promise<Awaited<ReturnType<Client["describe"]>>>(resolve => { finish = resolve; });
  const view = await mount(createElement(ProjectOrchestrationPanel, { projectId,
    client: recordingClient(settings("selected"), noCalls(), async () => deferred) }));
  try {
    const textarea = view.document.querySelector("textarea") as HTMLTextAreaElement;
    await view.act(async () => { enter(view.window, textarea, "Prepare a safe launch plan"); });
    const button = buttonNamed(view.document, "Prepare proposal");
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

test("none hides Describe a job, and a stale stored selection hides it with a reason on Settings", async () => {
  const hidden = await mount(createElement(ProjectOrchestrationPanel, { projectId,
    client: recordingClient(settings("none"), noCalls()) }));
  try { assert.equal(hidden.document.body.textContent, ""); } finally { await hidden.close(); }
  const stale = await mount(createElement(ProjectOrchestrationPanel, { projectId,
    client: recordingClient(settings("selected", { choiceStale: true,
      choice: { mode: "selected", workerId: "worker:removed", workerKind: "codex",
        modelKey: "model:gone", effort: "high" } }), noCalls()) }));
  try { assert.equal(stale.document.body.textContent, "", "a stale selection cannot produce a proposal, so the box is hidden"); }
  finally { await stale.close(); }
  const settingsPanel = await mount(createElement(ProjectOrchestrationSettings, { projectId,
    client: recordingClient(settings("selected", { choiceStale: true,
      choice: { mode: "selected", workerId: "worker:removed", workerKind: "codex",
        modelKey: "model:gone", effort: "high" } }), noCalls()) }));
  try {
    const alert = settingsPanel.document.querySelector("[role='alert']");
    assert.ok(alert, "the stale selection is said out loud");
    assert.match(alert.textContent ?? "", /no longer installed/);
    assert.doesNotMatch(alert.textContent ?? "", /check the wording/i);
  } finally { await settingsPanel.close(); }
});

/** F3: an allowance refusal is announced, and its words name the cause rather
 * than telling the owner to check their wording. */
test("an allowance refusal is an alert naming the allowance, not advice to reword", async () => {
  for (const message of ["No planning allowance is configured for this installation yet, so the chief of staff cannot run. This is not about your description.",
    "This project has used its planning allowance for now. The chief of staff cannot run again until the allowance is refilled."]) {
    const view = await mount(createElement(ProjectOrchestrationPanel, { projectId,
      client: recordingClient(settings("selected"), noCalls(), async () => ({ status: "refused", message,
        allowanceRefused: true, startsWork: false, grantsExecutionAuthority: false })) }));
    try {
      const textarea = view.document.querySelector("textarea") as HTMLTextAreaElement;
      await view.act(async () => { enter(view.window, textarea, "Plan this"); });
      await view.act(async () => { buttonNamed(view.document, "Prepare proposal")?.click(); await Promise.resolve(); });
      const alert = view.document.querySelector("[role='alert']");
      assert.ok(alert, "an allowance refusal must be announced");
      assert.match(alert.textContent ?? "", /allowance/i);
      assert.doesNotMatch(alert.textContent ?? "", /Check the wording/);
    } finally { await view.close(); }
  }
});

/** F6: with no planner host the panel keeps the saved choice but says plainly
 * that describing is not switched on, and offers no control that cannot work. */
test("without a planner host the panel says so plainly and offers no describe control", async () => {
  const view = await mount(createElement(ProjectOrchestrationPanel, { projectId,
    client: recordingClient(settings("selected", { describeAvailable: false }), noCalls()) }));
  try {
    assert.equal(view.document.querySelector("textarea"), null, "no input that cannot succeed");
    assert.equal(buttonNamed(view.document, "Prepare proposal"), undefined, "no button that cannot work");
    assert.match(view.document.body.textContent ?? "", /not switched on/i);
    assert.match(view.document.body.textContent ?? "", /saved/i);
  } finally { await view.close(); }
});

/** M17: "Use this" prefills the owner's revision form and issues NO revision
 * write. This is the product promise, and it can only be observed on a MOUNTED
 * page with a recording transport -- static markup cannot see the click's effect,
 * which is exactly why the guard had no CI anchor before. */
test("Use this issues no revision save; it only pre-fills the owner's own form", async () => {
  const posts: Array<{ path: string; body: string }> = [];
  const view = await mount(createElement(PrivateProjectPipelines, { projectId, batchId }), {
    // The page builds its own clients from the ambient fetch, so recording it is
    // what makes any write it attempted visible.
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") posts.push({ path, body: String(init.body) });
      if (path.endsWith("/use")) return Response.json({ proposal, startsWork: false,
        grantsExecutionAuthority: false, savesRevision: false });
      if (path.endsWith("/dismiss")) return new Response(null, { status: 204 });
      if (path.includes("/suggestions")) return Response.json({ projectId, batchId, dismissAvailable: true,
        suggestions: [suggestion], startsWork: false, grantsExecutionAuthority: false });
      if (path.includes("/pipelines/") && init?.method !== "POST") return Response.json({
        batchId, projectId, state: "proposed", revision: 2, proposedByIdentityId: "identity:agent",
        proposedAt: now, approvalIdentityId: null, decidedAt: null, proposal, revisions: [], items: [],
        queue: [], queueDepthLimit: 10, flagsByLocalId: {}, startsWork: false, grantsExecutionAuthority: false });
      return Response.json({ error: "not_found" }, { status: 404 });
    } });
  try {
    const use = buttonNamed(view.document, "Use this");
    assert.ok(use, "the suggestion card offers one obvious action");
    await view.act(async () => { use.click(); await Promise.resolve(); });
    // Exactly one POST: the prefill read. No revision save, no batch decision.
    assert.deepEqual(posts.map(post => post.path), [
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(batchId)}/suggestions/${encodeURIComponent(suggestion.suggestionId)}/use`]);
    assert.equal(posts.some(post => post.body.includes('"operation":"revise"')), false,
      "Use this must never write a revision");
    // The owner's own form now holds the suggested plan, open, with the reason.
    const textarea = view.document.querySelector("textarea") as HTMLTextAreaElement | null;
    assert.ok(textarea, "the revision form is on the page");
    assert.match(textarea.value, /First part/);
    assert.equal(view.document.querySelector("details[open]")?.textContent?.includes("Revise this proposal"), true);
    // The reason code the prefill set is the INPUT's value, which textContent does
    // not carry; read it as the browser would.
    const reason = [...view.document.querySelectorAll("input")].find(input =>
      input.getAttribute("pattern") === "[a-z][a-z0-9_]{2,63}");
    assert.equal(reason?.value, "chief_of_staff_split", "the prefill records WHY the revision is being made");
    // The only save button on the page is the pre-existing revision save, and it
    // was never pressed: an empty decision set keeps it disabled.
    assert.equal(buttonNamed(view.document, "Save all item decisions")?.disabled, true);
  } finally { await view.close(); }
  // The static markup proves the same card renders on the batch detail component
  // directly, with the reason code the prefill set.
  const batchHtml = renderToStaticMarkup(createElement(PipelineBatchDetail, { projectId,
    data: { state: "ready", value: { batchId, projectId, state: "proposed", revision: 2,
      proposedByIdentityId: "identity:agent", proposedAt: now, approvalIdentityId: null, decidedAt: null,
      proposal, revisions: [], items: [], queue: [], queueDepthLimit: 10, flagsByLocalId: {},
      startsWork: false, grantsExecutionAuthority: false } as WorkBatchOwnerViewV1 },
    suggestions: [suggestion], revisionOpen: true, revisionReason: "chief_of_staff_split",
    revisionText: JSON.stringify(suggestion.proposal), dismissAvailable: true }));
  assert.match(batchHtml, /Chief of staff suggests a new split/);
  assert.match(batchHtml, /<details open=""><summary>Revise this proposal/);
  assert.match(batchHtml, /chief_of_staff_split/);
});

/** M16: a decided batch shows no suggestion card at all. */
test("a decided batch shows no suggestion card", () => {
  const decided: WorkBatchOwnerViewV1 = { batchId, projectId, state: "approved", revision: 2,
    proposedByIdentityId: "identity:agent", proposedAt: now, approvalIdentityId: "identity:owner",
    decidedAt: now, proposal, revisions: [], items: [], queue: [], queueDepthLimit: 10, flagsByLocalId: {},
    startsWork: false, grantsExecutionAuthority: false };
  const html = renderToStaticMarkup(createElement(PipelineBatchDetail, { projectId,
    data: { state: "ready", value: decided }, suggestions: [suggestion], dismissAvailable: true }));
  assert.doesNotMatch(html, /Chief of staff suggests a new split/,
    "a decided batch accepts no new split suggestion");
  assert.match(html, /Recorded item decisions/);
});

/** The Dismiss gesture is offered only when it can be recorded durably. */
test("Dismiss is offered only with a durable record, and says why when it is not", () => {
  const withRecord = renderToStaticMarkup(createElement(ChiefOfStaffSuggestionCard, { suggestion,
    dismissAvailable: true, onUse: () => {}, onDismiss: () => {} }));
  assert.match(withRecord, /Dismiss/);
  assert.doesNotMatch(withRecord, /not recorded yet/);
  const without = renderToStaticMarkup(createElement(ChiefOfStaffSuggestionCard, { suggestion,
    dismissAvailable: false, onUse: () => {}, onDismiss: () => {} }));
  assert.doesNotMatch(without, />Dismiss</);
  assert.match(without, /not recorded yet/);
  assert.match(without, /Use this/);
});

test("a dropped response retains the request: Prepare stays disabled until it is retried or forgotten", async () => {
  // A recording client that reports a retained request, so the panel's held state
  // is driven by the client's own answer rather than by a prop.
  const readValue = settings("selected");
  let retained = true;
  const client: Client = Object.freeze({ ...recordingClient(readValue, noCalls()),
    hasPendingDescription: () => retained,
    async retryDescription() { retained = false; return { status: "proposal", batchId,
      href: `/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(batchId)}`,
      startsWork: false, grantsExecutionAuthority: false } as const; },
    forgetPendingDescription() { retained = false; },
    async describe() { throw new BrowserRequestError("uncertain"); } });
  const view = await mount(createElement(ProjectOrchestrationPanel, { projectId, client }));
  try {
    const textarea = view.document.querySelector("textarea") as HTMLTextAreaElement;
    await view.act(async () => { enter(view.window, textarea, "Prepare it"); });
    await view.act(async () => { buttonNamed(view.document, "Prepare proposal")?.click(); await Promise.resolve(); });
    assert.ok(view.document.querySelector("[role='alert']"), "a dropped response is announced");
    assert.match(view.document.body.textContent ?? "", /Retry only this exact request/);
    // M13: while the request is retained, Prepare must be disabled -- the owner
    // cannot start a second, different run by editing the text and pressing it.
    const prepare = buttonNamed(view.document, "Prepare proposal");
    assert.equal(prepare?.disabled, true, "Prepare stays disabled while a request is retained");
    const retry = buttonNamed(view.document, "Check this exact request again");
    assert.ok(retry, "the exact-request retry is offered");
    const forget = buttonNamed(view.document, "Forget this and start a new description");
    assert.ok(forget, "there is a way out of the retained state without a reload");
    // F8: forgetting releases the hold so a NEW description can be prepared.
    await view.act(async () => { forget.click(); await Promise.resolve(); });
    assert.equal(buttonNamed(view.document, "Prepare proposal")?.disabled, false,
      "after forgetting, a new description can be prepared again");
  } finally { await view.close(); }
});

test("a planner failure is a plain Needs-you alert", async () => {
  const failed = await mount(createElement(ProjectOrchestrationPanel, { projectId,
    client: recordingClient(settings("selected"), noCalls(), async () => ({ status: "failed", needsYou: true,
      message: "Needs-you: the chief of staff could not prepare a proposal.", startsWork: false,
      grantsExecutionAuthority: false })) }));
  try {
    const textarea = failed.document.querySelector("textarea") as HTMLTextAreaElement;
    await failed.act(async () => { enter(failed.window, textarea, "Plan this"); });
    await failed.act(async () => { buttonNamed(failed.document, "Prepare proposal")?.click(); await Promise.resolve(); });
    const alert = failed.document.querySelector("[role='alert']");
    assert.ok(alert);
    assert.match(alert.textContent ?? "", /Needs-you: the chief of staff could not prepare a proposal/);
  } finally { await failed.close(); }
});

test("hostile planner text is rendered as text, never as markup", () => {
  const hostile: ProjectOrchestrationSuggestionV1 = { ...suggestion,
    proposal: { ...proposal, tasks: [{ ...proposal.tasks[0]!,
      title: "<img src=x onerror=\"window.__pwned=1\">", instructions: "<script>window.__pwned=1</script>" }] } };
  // The card itself never renders task text, so the guarantee is proven where the
  // planner's words DO reach the page: the revision textarea it pre-fills.
  const html = renderToStaticMarkup(createElement(PipelineBatchDetail, { projectId,
    data: { state: "ready", value: { batchId, projectId, state: "proposed", revision: 2,
      proposedByIdentityId: "identity:agent", proposedAt: now, approvalIdentityId: null, decidedAt: null,
      proposal: hostile.proposal, revisions: [], items: [], queue: [], queueDepthLimit: 10,
      flagsByLocalId: {}, startsWork: false, grantsExecutionAuthority: false } as WorkBatchOwnerViewV1 },
    suggestions: [hostile], dismissAvailable: true, revisionText: JSON.stringify(hostile.proposal) }));
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img src=x/, "hostile planner text is escaped, not rendered");
  assert.match(html, /&lt;script&gt;/);
});