import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { PwaRegistration } from "../private-app/app/pwa-registration";
import { PrivateProjectWorkspace } from "../private-app/app/workspace";
import { OperationsControlPanel } from "../private-app/app/operations-control";
import { createProjectBrowserClient } from "../src/web/v1/browser-client";
import { NotificationDecisionList } from "../private-app/app/notification-settings";
import { renderToStaticMarkup } from "react-dom/server";

// Ported from the reviewer's sw-firstload/sw-press/action-detail/action-slow-reply/
// resume-class probes. Same owner gestures, bounded transports, no database.
async function mounted(element: React.ReactNode, transport: typeof fetch, worker: unknown,
  run: (dom: JSDOM, root: import("react-dom/client").Root) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/projects", pretendToBeVisual: true });
  const keys = ["window", "document", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(dom.window.navigator, "serviceWorker", { value: worker });
  const values = [dom.window, dom.window.document, dom.window.navigator, transport, true];
  keys.forEach((key, index) => Object.defineProperty(globalThis, key, { value: values[index], writable: true, configurable: true }));
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try { await act(async () => root.render(element)); await run(dom, root); }
  finally { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } }
}
const noFetch: typeof fetch = async () => new Response(null, { status: 404 });
const button = (dom: JSDOM, label: string) => {
  const found = [...dom.window.document.querySelectorAll("button")].find(item => item.textContent === label);
  assert.ok(found, label); return found;
};
async function edit(dom: JSDOM, selector: string, text: string) {
  const input = dom.window.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  assert.ok(input, selector);
  const prototype = input.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
function workerFixture(controlled = true) {
  const parked = Object.assign(new EventTarget(), { state: "installed", postMessage() { fixture.messages++; } });
  const registration = Object.assign(new EventTarget(), { waiting: parked as typeof parked | null, installing: null });
  const fixture = Object.assign(new EventTarget(), { messages: 0, controller: controlled ? {} : null, register: async () => registration });
  return { worker: fixture, registration, parked };
}

test("R7P-01: first install never offers an update, including installed before activation", async () => {
  for (const hasWaiting of [false, true]) {
    const f = workerFixture(false); if (!hasWaiting) f.registration.waiting = null;
    await mounted(<PwaRegistration />, noFetch, f.worker, async dom => {
      assert.doesNotMatch(dom.window.document.body.textContent!, /update is ready/);
      await act(async () => f.parked.dispatchEvent(new Event("statechange")));
      assert.doesNotMatch(dom.window.document.body.textContent!, /Reload for update/);
      assert.equal(f.worker.messages, 0);
    });
  }
});

test("R7P-02: stale update button gives feedback without posting or reloading", async () => {
  const f = workerFixture();
  await mounted(<PwaRegistration />, noFetch, f.worker, async dom => {
    const reload = button(dom, "Reload for update"); f.registration.waiting = null;
    await act(async () => reload.click());
    assert.equal(f.worker.messages, 0);
    assert.match(dom.window.document.body.textContent!, /No update is waiting/);
  });
});

test("R7P-02: 50 update taps activate once; missing controllerchange times out and allows retry", async () => {
  const f = workerFixture();
  await mounted(<PwaRegistration />, noFetch, f.worker, async dom => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await act(async () => { const reload = button(dom, "Reload for update"); for (let i = 0; i < 50; i++) reload.click(); });
      assert.equal(f.worker.messages, 1);
      assert.equal(button(dom, "Reloading for update…").disabled, true);
      await act(async () => mock.timers.tick(10_000));
      assert.match(dom.window.document.body.textContent!, /couldn't reload/i);
      await act(async () => button(dom, "Reload for update").click());
      assert.equal(f.worker.messages, 2);
    } finally { mock.timers.reset(); }
  });
});

const catalog = { projects: [], nextCursor: null, canCreate: true, sources: { ordinary: "included", ideas: "not_configured" } };
const draft = { title: "Draft the owner typed", summary: "A summary written on the phone." };
const project = { projectId: "project:phone", ...draft, lifecycle: "active", version: 1,
  createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" };

test("R7P-03: offline create sends nothing, keeps both fields mounted, then owner retries", async () => {
  let offline = false, posts = 0;
  const transport: typeof fetch = async (path, init) => {
    if (init?.method === "POST") { posts++; return Response.json({ project, replayed: false }, { status: 201 }); }
    if (String(path) === "/api/v1/projects") { if (offline) throw new TypeError("offline"); return Response.json(catalog); }
    return noFetch(path, init);
  };
  await mounted(<PrivateProjectWorkspace />, transport, {}, async dom => {
    await edit(dom, "#project-title", draft.title); await edit(dom, "#project-summary", draft.summary);
    offline = true; Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, value: false });
    await act(async () => button(dom, "Create project").click());
    assert.equal(posts, 0);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#project-title")?.value, draft.title);
    assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>("#project-summary")?.value, draft.summary);
    assert.match(dom.window.document.body.textContent!, /not sent.*draft.*kept/i);
    offline = false; Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, value: true });
    await act(async () => button(dom, "Check saved state again").click());
    await act(async () => button(dom, "Create project").click());
    assert.equal(posts, 1);
    assert.match(dom.window.document.body.textContent!, /Project saved/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /could not be confirmed/);
  });
});

test("R7P-05: cancelled project read retains draft and last view; failure recovers on focus", async () => {
  let mode = "ok", cancel: (() => void) | undefined;
  const transport: typeof fetch = async (path, init) => {
    if (String(path) !== "/api/v1/projects") return noFetch(path, init);
    if (mode === "held") return new Promise((_, reject) => { cancel = () => reject(new DOMException("cancelled", "AbortError"));
      init?.signal?.addEventListener("abort", cancel, { once: true }); });
    if (mode === "failed") throw new TypeError("connection lost");
    return Response.json({ ...catalog, projects: [{ ...project, title: "Last saved project", origin: "ordinary", lifecycleEditable: true }] });
  };
  await mounted(<PrivateProjectWorkspace />, transport, {}, async dom => {
    await edit(dom, "#project-title", draft.title);
    mode = "held"; await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.match(dom.window.document.body.textContent!, /checking/i);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#project-title")?.value, draft.title);
    await act(async () => cancel?.());
    assert.doesNotMatch(dom.window.document.body.textContent!, /service is unavailable|Projects are unavailable|couldn\'t refresh/i);
    mode = "failed"; await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.match(dom.window.document.body.textContent!, /couldn't refresh/i);
    assert.match(dom.window.document.body.textContent!, /Last saved project/);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#project-title")?.value, draft.title);
    mode = "ok"; await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.doesNotMatch(dom.window.document.body.textContent!, /couldn't refresh|service is unavailable/);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#project-title")?.value, draft.title);
  });
});

test("R7P-03: refused mode change keeps reason; a 50-tap burst writes once", async () => {
  let writes = 0, fail = true;
  const client = { read: async () => ({ mode: "running", revision: 0, admitsNewWork: true } as never),
    set: async () => { writes++; if (fail) throw new Error("refused"); return {} as never; } };
  await mounted(<OperationsControlPanel client={client} />, noFetch, {}, async dom => {
    await edit(dom, "#operations-control-reason", "Keep these words");
    await act(async () => { const pause = button(dom, "Paused"); for (let i = 0; i < 50; i++) pause.click(); });
    assert.equal(writes, 1);
    assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!.value, "Keep these words");
    assert.match(dom.window.document.body.textContent!, /draft.*kept/i);
    fail = false; await act(async () => button(dom, "Paused").click()); assert.equal(writes, 2);
  });
});

test("R7P-04: delayed 201 confirms success; lost reply remains unknown and exact retry resolves it", async () => {
  let posts = 0, release!: (response: Response) => void;
  const keys: unknown[] = [];
  const client = createProjectBrowserClient(async (_path, init) => {
    posts++; keys.push((init?.headers as Record<string, string>)["idempotency-key"]);
    if (posts === 1) return new Promise(resolve => { release = resolve; });
    if (posts === 2) throw new DOMException("slow reply", "TimeoutError");
    return Response.json({ project, replayed: true });
  }, () => "phone-save-key");
  const save = client.create(draft); assert.equal(client.hasPending(), true);
  release(Response.json({ project, replayed: false }, { status: 201 })); assert.deepEqual(await save, project);
  assert.equal(client.hasPending(), false);
  await assert.rejects(client.create(draft), { code: "uncertain" });
  assert.equal(client.hasPending(), true);
  assert.deepEqual(await client.retryPending(), project);
  assert.equal(client.hasPending(), false); assert.equal(keys[1], keys[2]);
});

test("R7P-06: notification table exposes a labelled, keyboard-accessible scrolling region", () => {
  const dom = new JSDOM(`<style>${readFileSync("private-app/app/private.css", "utf8")}</style>` + renderToStaticMarkup(<NotificationDecisionList decisions={[]} />));
  try {
    const region = dom.window.document.querySelector('[role="region"]'); assert.ok(region);
    assert.equal(region.getAttribute("tabindex"), "0");
    assert.equal(region.getAttribute("aria-label"), "Saved notification records");
    assert.ok(region.classList.contains("private-table-scroll"));
    assert.equal(dom.window.getComputedStyle(region).overflowX, "auto");
    (region as HTMLElement).focus(); assert.equal(dom.window.document.activeElement, region);
    assert.match(region.textContent!, /Reason/);
  } finally { dom.window.close(); }
});

test("R7P-03/04: lost create reply retains the exact draft and retry key; confirmed retry clears unknown", async () => {
  let posts = 0; const bodies: unknown[] = [], keys: unknown[] = [];
  const transport: typeof fetch = async (path, init) => {
    if (init?.method === "POST") { posts++; bodies.push(init.body); keys.push((init.headers as Record<string, string>)["idempotency-key"]);
      if (posts === 1) throw new DOMException("lost reply", "TimeoutError");
      return Response.json({ project, replayed: true }, { status: 201 }); }
    return String(path) === "/api/v1/projects" ? Response.json(catalog) : noFetch(path, init);
  };
  await mounted(<PrivateProjectWorkspace />, transport, {}, async dom => {
    await edit(dom, "#project-title", draft.title); await edit(dom, "#project-summary", draft.summary);
    await act(async () => { const submit = button(dom, "Create project"); for (let i = 0; i < 50; i++) submit.click(); });
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#project-title")!.disabled, true);
    assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>("#project-summary")!.disabled, true);
    assert.equal(posts, 1); assert.match(dom.window.document.body.textContent!, /may have completed.*draft is kept/i);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#project-title")!.value, draft.title);
    assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>("#project-summary")!.value, draft.summary);
    await act(async () => button(dom, "Retry original save").click());
    assert.equal(posts, 2); assert.equal(bodies[0], bodies[1]); assert.equal(keys[0], keys[1]);
    assert.match(dom.window.document.body.textContent!, /Project saved/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /could not be confirmed|previous project save is still unconfirmed/i);
  });
});

test("R7P-03: refused project save and failed catalog recheck retain the owner draft", async () => {
  let failed = false;
  const transport: typeof fetch = async (path, init) => {
    if (init?.method === "POST") { failed = true; return new Response(null, { status: 403 }); }
    if (String(path) === "/api/v1/projects") return failed ? new Response(null, { status: 503 }) : Response.json(catalog);
    return noFetch(path, init);
  };
  await mounted(<PrivateProjectWorkspace />, transport, {}, async dom => {
    await edit(dom, "#project-title", draft.title); await edit(dom, "#project-summary", draft.summary);
    await act(async () => button(dom, "Create project").click());
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#project-title")!.value, draft.title);
    assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>("#project-summary")!.value, draft.summary);
    assert.match(dom.window.document.body.textContent!, /not saved.*draft is kept/i);
  });
});

test("R7P-05: review and verification retain drafts on cancelled/failed reads, hold writes, and recover", async () => {
  const { OwnerTaskReview } = await import("../private-app/app/task-owner-review");
  const { OwnerTaskVerification } = await import("../private-app/app/task-owner-verification");
  const { createTaskReviewWorkspace } = await import("../src/web/v1/task-review-workspace");
  const { createTaskVerificationWorkspace } = await import("../src/web/v1/task-verification-workspace");
  const { createTaskReviewBrowserClient } = await import("../src/web/v1/task-review-browser-client");
  const { createTaskVerificationBrowserClient } = await import("../src/web/v1/task-verification-browser-client");
  const digest = `sha256:${"a".repeat(64)}`;
  const binding = { projectId: "project:phone", jobId: "job:phone", artifactId: "artifact:phone", targetId: "target:phone", targetDigest: digest, contentHash: digest };
  for (const kind of ["review", "verification"]) {
    let mode = "ok", posts = 0, releaseRead!: () => void;
    const options = kind === "review" ? { ...binding, canReview: true, availability: "available", ownReview: null, grantsExecutionAuthority: false }
      : { ...binding, source: "configured", grantsExecutionAuthority: false, scenarios: [{ scenarioId: "scenario:phone", instructionsDigest: digest,
        label: "Phone observation", instructions: "Read the saved result.", availability: "available", ownVerification: null }] };
    const transport: typeof fetch = async (_path, init) => {
      if (init?.method === "POST") { posts++; throw new Error("must not write while stale"); }
      if (mode === "held") return new Promise(resolve => { releaseRead = () => resolve(Response.json(options, { headers: { "x-control-room-authenticated-actor": digest, "x-control-room-session-epoch": digest } })); });
      if (mode === "abort") throw new DOMException("cancelled", "AbortError");
      if (mode === "failed") return new Response(null, { status: 503 });
      if (mode === "denied") return new Response(null, { status: 401 });
      return Response.json(options, { headers: { "x-control-room-authenticated-actor": digest, "x-control-room-session-epoch": digest } });
    };
    const review = createTaskReviewWorkspace(observe => createTaskReviewBrowserClient(transport, () => "review:phone", observe));
    const verification = createTaskVerificationWorkspace(() => createTaskVerificationBrowserClient(transport));
    review.get(binding).setFeedback("Retain this review draft");
    const session = verification.get(binding); session.selectScenario("scenario:phone"); session.setOutcome("passed"); session.setNote("Retain this observation draft");
    const element = kind === "review" ? <OwnerTaskReview {...binding} workspace={review} onSaved={() => {}} />
      : <OwnerTaskVerification {...binding} workspace={verification} onSaved={() => {}} />;
    await mounted(element, transport, {}, async dom => {
      const text = kind === "review" ? "Retain this review draft" : "Retain this observation draft";
      const field = kind === "review" ? 'textarea[aria-label="Changes you want"]' : 'textarea[aria-label="Required observation note"]';
      const save = kind === "review" ? "Send back" : "Record human verification";
      assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>(field)!.value, text);
      for (const next of ["abort", "failed"]) {
        mode = next; await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
        assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>(field)!.value, text);
        assert.equal(button(dom, save).disabled, true);
        assert.match(dom.window.document.body.textContent!, next === "abort" ? /Checking/ : /Couldn't refresh/);
        if (next === "abort") assert.equal(dom.window.document.querySelectorAll('[role="alert"]').length, 0);
        await act(async () => button(dom, save).click()); assert.equal(posts, 0);
        if (next === "failed") {
          mode = "held"; await act(async () => button(dom, kind === "review" ? "Refresh recorded review" : "Refresh human verification").click());
          assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>(field)!.value, text, "explicit recheck must never unmount draft fields");
          assert.match(dom.window.document.body.textContent!, /Checking/);
          mode = "ok"; await act(async () => releaseRead());
        } else { mode = "ok"; await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus"))); }
        assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>(field)!.value, text);
        assert.equal(button(dom, save).disabled, false);
        assert.doesNotMatch(dom.window.document.body.textContent!, /Couldn't refresh|Checking/);
      }
      mode = "denied"; await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
      assert.equal(dom.window.document.querySelector(field) === null, true, "expired authority hides protected controls while retaining page-owned draft");
      mode = "ok"; await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
      assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>(field)!.value, text);
    });
  }
});

test("R7P-05: saved article remains readable after cancellation/failure and recovers on focus", async () => {
  const { NewsArticleReader } = await import("../private-app/app/news-article-reader");
  const digest = `sha256:${"a".repeat(64)}`;
  const props = { projectId: "project:phone", storyId: "story:phone", storyDigest: digest, canonicalUrl: "https://example.invalid/article" };
  const record = { tenantId: "tenant:fixture", workspaceId: "workspace:fixture", ...props, status: "extracted", sourceHash: digest, detailDigest: digest,
    extractor: "@mozilla/readability@0.6.0+jsdom@26.1.0", text: "Saved reading text" };
  let mode = "ok";
  const transport: typeof fetch = async () => {
    if (mode === "abort") throw new DOMException("backgrounded", "AbortError");
    return mode === "failed" ? new Response(null, { status: 503 }) : Response.json(record);
  };
  await mounted(<NewsArticleReader {...props} />, transport, {}, async dom => {
    await act(async () => button(dom, "Read saved article").click());
    for (const next of ["abort", "failed", "ok"]) {
      mode = next; await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
      assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!.value, record.text);
      if (next === "abort") assert.doesNotMatch(dom.window.document.body.textContent!, /Article unavailable/);
      if (next === "failed") assert.match(dom.window.document.body.textContent!, /Couldn't refresh/);
      if (next === "ok") assert.doesNotMatch(dom.window.document.body.textContent!, /Couldn't refresh|Article unavailable|Checking/);
    }
  });
});

test("R7P-03/05: task draft survives offline send, read cancellation, and sign-in refusal followed by retry", async () => {
  const { PrivateTaskWorkspace } = await import("../private-app/app/task-workspace");
  let mode = "ok", posts = 0;
  const taskPage = { project: { ...project, origin: "ordinary", lifecycleEditable: true }, tasks: [], nextCursor: null,
    canPropose: true, dispatch: "not_connected", observedAt: project.createdAt };
  const digest = `sha256:${"a".repeat(64)}`;
  const transport: typeof fetch = async (path, init) => {
    if (init?.method === "POST") { posts++; return new Response(null, { status: 401 }); }
    if (!String(path).endsWith("/tasks")) return noFetch(path, init);
    if (mode === "failed") return new Response(null, { status: 503 });
    if (mode === "abort") throw new DOMException("backgrounded", "AbortError");
    return Response.json(taskPage, { headers: { "x-control-room-authenticated-actor": digest, "x-control-room-session-epoch": digest } });
  };
  await mounted(<PrivateTaskWorkspace projectId={project.projectId} />, transport, {}, async dom => {
    await edit(dom, "#task-title", "Phone task draft"); await edit(dom, "#task-instructions", "Keep the owner instructions");
    mode = "abort"; await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#task-title")!.value, "Phone task draft");
    assert.doesNotMatch(dom.window.document.querySelector("main")!.textContent!, /service is unavailable|couldn\'t refresh/i);
    mode = "failed"; await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#task-title")!.value, "Phone task draft");
    assert.match(dom.window.document.querySelector("main")!.textContent!, /Couldn't refresh/);
    await act(async () => dom.window.document.querySelector("form#new-task")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(posts, 0, "even a forced form submit cannot use stale read authority");
    mode = "ok"; await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, value: false });
    await act(async () => button(dom, "Save task").click()); assert.equal(posts, 0);
    assert.match(dom.window.document.body.textContent!, /task was not sent.*draft is kept/);
    Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, value: true });
    await act(async () => button(dom, "Save task").click()); assert.equal(posts, 1);
    await act(async () => button(dom, "Check saved tasks again").click());
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#task-title")!.value, "Phone task draft");
    assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>("#task-instructions")!.value, "Keep the owner instructions");
  });
});

test("R7P-01/02: redundant worker clears prompt; thrown activation and unmount release the deadline", async () => {
  const f = workerFixture();
  await mounted(<PwaRegistration />, noFetch, f.worker, async (dom, root) => {
    await act(async () => { f.parked.state = "redundant"; f.parked.dispatchEvent(new Event("statechange")); });
    assert.doesNotMatch(dom.window.document.body.textContent!, /Reload for update/);
    await act(async () => { f.parked.state = "installed"; f.registration.dispatchEvent(new Event("updatefound")); });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      f.parked.postMessage = () => { throw new Error("worker stopped"); };
      await act(async () => button(dom, "Reload for update").click());
      assert.match(dom.window.document.body.textContent!, /couldn't reload/);
      assert.equal(button(dom, "Reload for update").disabled, false);
      f.parked.postMessage = () => { f.worker.messages++; };
      await act(async () => button(dom, "Reload for update").click()); assert.equal(f.worker.messages, 1);
      await act(async () => root.render(null));
      const errors: Error[] = []; (dom as JSDOM & { virtualConsole: import("jsdom").VirtualConsole }).virtualConsole.on("jsdomError", (error: Error) => errors.push(error));
      await act(async () => { mock.timers.tick(10_000); f.worker.dispatchEvent(new Event("controllerchange")); });
      assert.equal(errors.length, 0, "stopped component cannot reload on a late controller change");
    } finally { mock.timers.reset(); }
  });
});
