// R4U-10: signed out in another tab -- no prompt to sign in again, and a save
// lost without saying so.
//
// The measurement from the round-4 browser run: with the session ended in
// another tab, Home showed every panel "unavailable" and nothing anywhere said
// the session had ended. Then the owner pressed Save on a project's settings and
// the panel said "Sign in again to see this project's settings." -- which is
// about READING the settings, not about the change they had just made. The
// field kept their edit, so the change was not visibly lost, but nothing said
// it was not saved either: an owner who reads that sentence and signs back in
// has every reason to believe the save went through.
//
// So two things must hold, and neither is a wording tweak:
//
//   1. The 401 message on a SAVE says the change was NOT saved. A read and a
//      write are different facts about the same session, and the panel has to
//      say which one it is reporting. The panel is the only place that knows,
//      because only it knows whether the failure followed a save.
//   2. There is ONE sign-in notice, and it names the state rather than the
//      symptom. Every other panel on the page already says "unavailable"; a
//      single explicit "you are signed out" is what lets the owner connect those
//      six failures to one cause instead of six.
//
// The panel is mounted here with a REAL client against a fetch answering with
// the status under test. No injected error object: the thing under test is
// which failure the message describes, and that is decided by the response code
// on the wire.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";

import { ProjectSettingsPanel } from "../private-app/app/project-settings-panel";
import { createProjectSettingsBrowserClient } from "../src/web/v1/project-settings-browser-client";
import { projectSettingsSchema, type ProjectSettings } from "../src/web/v1/project-settings-wire";

// Built by the wire's OWN schema from a value with no invented fields. A first
// attempt included `schema` and `tenantId`, which `projectSettingsSchema` is
// `.strict()` about and which made the READ fail -- so the panel never loaded
// the form and the save was never attempted. That is the test being wrong in a
// way that read as the product being wrong, and it is why the fixture is parsed
// rather than cast.
const SETTINGS = projectSettingsSchema.parse({
  projectId: "project:one", version: 3, eligibleWorkerKinds: null, maxConcurrentTasks: 2,
  defaultWorkerKind: null, defaultModel: null, defaultEffort: null,
  updatedAt: "2026-09-29T07:00:00.000Z",
});

/** Mount the real panel with a real client against `onSave`'s answer.
 *
 * `readStatus` refuses the panel's INITIAL read instead of answering it, which
 * is the case where there is no loaded settings at all -- the owner opened the
 * page with a session that had already ended, or ended it in another tab before
 * this tab's first read came back. */
async function mountPanel(saveStatus: number, readStatus?: number) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>",
    { url: "https://control.invalid/", pretendToBeVisual: true });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  let saves = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    // The read succeeds: the owner was signed in when the page loaded and was
    // signed out in ANOTHER tab afterwards, which is exactly the reported case
    // and the only way a save can fail while the form is filled in.
    if ((init?.method ?? "GET") === "GET") {
      if (readStatus === undefined) return Response.json(SETTINGS);
      return new Response(JSON.stringify({ error: "authentication_required" }),
        { status: readStatus, headers: { "content-type": "application/json" } });
    }
    saves += 1;
    return new Response(JSON.stringify({ error: "authentication_required" }),
      { status: saveStatus, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => { root.render(createElement(ProjectSettingsPanel,
    { projectId: "project:one", client: createProjectSettingsBrowserClient() })); });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await React.act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 5)); });
    if (dom.window.document.querySelector("#project-settings-max-concurrent")) break;
  }
  const settled = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await React.act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 5)); });
      if (dom.window.document.querySelector('[role="alert"]')) return;
    }
  };
  const click = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll("button")]
      .find(node => node.textContent === label);
    assert.ok(button, `no ${label} button to press`);
    await React.act(async () => { (button as HTMLButtonElement).click(); });
  };
  const restore = async () => {
    try { await React.act(async () => { root.unmount(); }); } catch { /* already torn down */ }
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  return { document: dom.window.document, saves: () => saves, click, settled, restore };
}

test("a save refused because the session ended says the change was NOT saved, and offers one way back", async () => {
  const mounted = await mountPanel(401);
  try {
    await mounted.click("Save settings");
    for (let attempt = 0; attempt < 40 && mounted.saves() === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(mounted.saves(), 1, "the save was not attempted, so this test is not covering a refused save");
    const alert = mounted.document.querySelector('[role="alert"]')?.textContent ?? "";
    assert.match(alert, /signed out|sign in again/i,
      `the refusal must name the session, not a symptom the owner has to interpret: ${alert}`);
    assert.match(alert, /not saved|was not saved|not been saved/i,
      `the refusal must say the change was NOT saved; an owner who signs back in would otherwise assume it was: ${alert}`);
    // ...and there is ONE way back, as a link, not a dead end.
    const links = [...mounted.document.querySelectorAll("a")].map(node => node.getAttribute("href"));
    assert.ok(links.includes("/session"),
      `a signed-out owner needs a link to sign in again; the panel offers ${JSON.stringify(links)}`);
    // The edit is KEPT, so the owner can retry without retyping it.
    assert.equal((mounted.document.querySelector("#project-settings-max-concurrent") as HTMLInputElement).value, "2",
      "the refused save must not discard what the owner typed");
  } finally { await mounted.restore(); }
});

test("a READ refused because the session ended must not promise a change that was never made", async () => {
  // The signed-out note ("your change above is still here ... press Save
  // settings to apply it") belongs to a refused SAVE. On a refused READ the
  // owner has nothing above to keep and the Save button is disabled, so
  // rendering it there tells them to do something impossible and claims a
  // change that never existed. The ALERT still names the ended session: one
  // explicit statement, no promise attached to it.
  const mounted = await mountPanel(401, 401);
  try {
    await mounted.settled();
    const alert = mounted.document.querySelector('[role="alert"]')?.textContent ?? "";
    assert.match(alert, /signed out|could not be read/iu,
      `a refused READ must still say the session ended; the one notice is the point of R4U-10: ${alert}`);
    const notes = [...mounted.document.querySelectorAll("p.private-note")]
      .map(node => node.textContent ?? "").join(" ");
    assert.doesNotMatch(notes, /your change above is still here|press Save settings to apply it/iu,
      "a refused READ promised a kept change and a usable Save button that do not exist; the form never loaded");
    assert.equal(mounted.saves(), 0, "a refused READ must not attempt a save");
    const save = [...mounted.document.querySelectorAll("button")].find(node => node.textContent === "Save settings");
    assert.equal((save as HTMLButtonElement | undefined)?.disabled, true,
      "with no settings loaded the Save button is disabled, so the note's instruction was impossible");
  } finally { await mounted.restore(); }
});

test("a save refused for any OTHER reason must NOT claim the session ended", async () => {
  // The other direction, and the one a wording fix easily breaks: a 403 or a 409
  // is not a signed-out session, and telling an owner to sign in again when they
  // are already signed in sends them down the wrong path.
  for (const [status, expected] of [[403, /does not have access|does not allow/i], [409, /changed elsewhere/i]] as const) {
    const mounted = await mountPanel(status);
    try {
      await mounted.click("Save settings");
      for (let attempt = 0; attempt < 40 && mounted.saves() === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const alert = mounted.document.querySelector('[role="alert"]')?.textContent ?? "";
      assert.match(alert, expected, `a ${status} refusal must name its own cause: ${alert}`);
      assert.doesNotMatch(alert, /signed out/i,
        `a ${status} refusal told the owner their session ended, which sends them to the wrong page`);
    } finally { await mounted.restore(); }
  }
});