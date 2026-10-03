import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PrivateHeader } from "../private-app/app/private-header";
import { ProductConfigurationProvider, useProductModule } from "../private-app/app/product-configuration";
import { ProjectNavigation } from "../private-app/app/project-navigation";
import { LocalRuntimeProvider } from "../private-app/app/local-runtime";
import { InstallationTopologyProvider } from "../private-app/app/installation-topology";
import { WorkersWorkspace } from "../private-app/app/workers/workers-workspace";
import { PRODUCT_CONFIGURATION_SCHEMA_V1 } from "../src/config/v1/product-configuration";

/** A Mac-local host serves `/api/v1/needs-me/tasks` unconditionally
 * (src/web/v1/mac-local-web-process.ts:291 — unlike the action-inbox and
 * pipelines siblings, it has no host-option gate), so the header's "Needs
 * you" badge read is legitimate in every configuration this file exercises.
 *
 * The truncated form is deliberately honest about the wire contract:
 * readTaskAttention only accepts a `nextCursor` when the page reports
 * `examined: 25` and every returned jobId sorts at or before the cursor, so a
 * shorter cursor page is rejected by the client rather than shown as a
 * confident exact count. */
const canonicalSource = () => Response.json({ observedAt: "2026-09-29T07:00:00.000Z", items: [], truncated: false });
const attentionPage = (items, nextCursor = null) => ({ items, nextCursor,
  examined: nextCursor === null ? items.length : 25,
  observedAt: "2026-09-29T07:00:00.000Z", startsWork: false,
  planningSource: "not_configured", deliverySource: "not_configured",
  sources: { ordinary: "included", ideas: "not_configured" } });
const attentionItem = (jobId) => ({ task: { jobId, projectId: "project:alpha", requestId: `request-${jobId}`,
  title: `Saved task ${jobId}`, state: "succeeded", version: 1,
  createdAt: "2026-09-29T06:00:00.000Z", updatedAt: "2026-09-29T06:30:00.000Z" },
  inputDigest: `sha256:${"a".repeat(64)}`, reasons: ["review"] });
/** The badge read is deferred by a zero-delay timer (private-header.tsx's
 * useNeedsAttentionBadge, so StrictMode's double mount issues one request).
 * Every act() in this file must therefore flush a macrotask turn before it
 * asserts on request order, or the assertion races the timer. */
const flushBadgeRead = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };

const profile = (displayName, enabled) => ({
  schema: PRODUCT_CONFIGURATION_SCHEMA_V1,
  displayName,
  defaultTimezone: enabled ? "America/Denver" : "UTC",
  modules: { ideaLab: enabled, news: enabled, sessionObservations: enabled },
  limits: { maxProjects: 12, maxTasksPerProject: 100, maxResultsPerTask: 20,
    maxArticleSources: enabled ? 10 : 0, maxIdeaParticipants: enabled ? 6 : 0 },
  projectTemplates: [{ id: enabled ? "research" : "operations",
    displayName: enabled ? "Research projects" : "Operations projects",
    enabledModules: enabled ? ["ideaLab", "news", "sessionObservations"] : [] }],
});

function OptionalObservationMarker() {
  return useProductModule("sessionObservations")
    ? React.createElement("span", { "data-module": "session-observations" }, "Session observations") : null;
}

test("one client shell binds truthful links to two distinct sanitized configurations", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: "https://control-room.invalid/projects/project%3Aalpha" });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root"));
  try {
    for (const [configuration, optionalLinks] of [[profile("Research Room", true), true],
      [profile("Operations Room", false), false]]) {
      let respond;
      // Per-path routing, not a single shared responder: the mounted
      // PrivateHeader issues its own deferred badge read for
      // /api/v1/needs-me/tasks, so a one-slot `respond` would hand that
      // response to the configuration read (leaving the brand on the neutral
      // "Control Room" shell) or starve the badge. Each path is answered by
      // the read that owns it; anything else is an error, so an unexpected
      // request cannot pass unnoticed as a silent 404.
      const attentionReads = [];
      globalThis.fetch = path => {
        if (path === "/api/v1/local-workers") return Promise.resolve(new Response(null, { status: 404 }));
        if (path === "/api/v1/needs-me/action-items") return Promise.resolve(canonicalSource());
        if (path === "/api/v1/needs-me/tasks") {
          // No saved work needs the owner here, so this configuration's badge
          // reports a checked zero once both sources finish, as asserted below.
          attentionReads.push(path);
          return Promise.resolve(Response.json(attentionPage([])));
        }
        if (path === "/api/v1/product-configuration") return new Promise(resolve => { respond = resolve; });
        throw new Error(`unsupported shell fetch: ${path}`);
      };
      await act(async () => root.render(React.createElement(LocalRuntimeProvider, null,
        React.createElement(ProductConfigurationProvider, null,
        React.createElement(PrivateHeader),
        React.createElement(ProjectNavigation, { projectId: "project:alpha", current: "overview" }),
        React.createElement(OptionalObservationMarker)))));
      assert.equal(dom.window.document.querySelector(".private-brand")?.textContent, "Control Room");
      assert.equal(dom.window.document.querySelector('a[href="/ideas"]'), null);
      assert.equal(dom.window.document.querySelector('a[href="/projects/project%3Aalpha/news"]'), null);

      await act(async () => { respond(Response.json(configuration)); await Promise.resolve(); });
      // The badge read is deferred by a macrotask; flush it before asserting
      // on the finished shell, or this asserts on a half-rendered header.
      await flushBadgeRead();
      assert.deepEqual(attentionReads, ["/api/v1/needs-me/tasks"],
        "the header reads the served needs-you page exactly once per mount");
      assert.equal(dom.window.document.querySelector(".private-nav-badge")?.firstChild.textContent, "0",
        "a successfully read empty attention page shows a known zero outside the menu");
      assert.equal(dom.window.document.querySelector(".private-brand")?.textContent, configuration.displayName);
      const workspaceLinks = [...dom.window.document.querySelectorAll("#private-workspace-navigation a")]
        .map(link => [link.textContent?.replaceAll(/\s+/g, " ").trim(), link.getAttribute("href")]);
      assert.deepEqual(workspaceLinks.slice(0, 9), [["Home", "/"], ["Morning summary", "/morning"], ["Projects", "/projects"],
        ["Workers", "/workers"], ["Session watch", "/session-watch"], ["Setup", "/setup"], ["Control Room", "/workboard"],
        ["Action Inbox", "/needs-me"], ["Settings", "/settings"]]);
      assert.equal(dom.window.document.querySelector('a[href="/ideas"]') !== null, optionalLinks);
      assert.equal(dom.window.document.querySelector('a[href="/projects/project%3Aalpha/news"]')?.textContent === "News", optionalLinks);
      assert.equal(dom.window.document.querySelector('[data-module="session-observations"]') !== null, optionalLinks);
      assert.doesNotMatch(dom.window.document.body.textContent ?? "", /password|api key|secret key/i);
      await act(async () => root.render(React.createElement(React.Fragment)));
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test("local client shell exposes only reachable routes and reads only local worker status", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: "http://127.0.0.1:3210/workers" });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root"));
  const reads = [];
  globalThis.fetch = path => {
    reads.push(path);
    if (path === "/api/v1/needs-me/action-items") return Promise.resolve(canonicalSource());
    if (path === "/api/v1/needs-me/tasks") return Promise.resolve(Response.json(attentionPage([])));
    if (path === "/api/v1/product-configuration") return Promise.resolve(Response.json(profile("Control Room", false)));
    if (path !== "/api/v1/local-workers") throw new Error(`unsupported local fetch: ${path}`);
    return Promise.resolve(Response.json({ taskWorkersStarted: true,
      projectSections: ["overview", "inbox", "work", "agents", "reviews", "activity", "files"], workers: [
      { kind: "hermes-021", state: "ready", proof: "not_proven" },
      { kind: "claude-code", state: "ready", proof: "not_proven" },
      { kind: "codex", state: "ready", proof: "not_proven" },
    ] }));
  };
  try {
    await act(async () => root.render(React.createElement(LocalRuntimeProvider, null,
      React.createElement(ProductConfigurationProvider, null,
        React.createElement(InstallationTopologyProvider, null,
          React.createElement(WorkersWorkspace),
          React.createElement(ProjectNavigation, { projectId: "project:alpha", current: "overview" }))))));
    // WorkersWorkspace mounts the shared PrivateHeader, and the Mac-local host
    // serves the fleet board and the worker scorecard from that same private web
    // process, alongside the sanitized product configuration and
    // both attention sources. All six are identity-gated reads rather than
    // hosted-only routes -- /api/v1/fleet through the fleet owner handler,
    // /api/v1/workers-scorecard through `projects.read` in private-process.ts --
    // so the header polls them here legitimately. What must stay bounded is that
    // no hosted-only route is contacted.
    await flushBadgeRead();
    assert.deepEqual(reads, ["/api/v1/workers-scorecard", "/api/v1/local-workers", "/api/v1/fleet",
      "/api/v1/product-configuration", "/api/v1/needs-me/tasks", "/api/v1/needs-me/action-items"]);
    const links = [...dom.window.document.querySelectorAll("a[href]")].map(link => link.getAttribute("href"));
    assert.ok(links.includes("/workers"));
    assert.ok(links.includes("/morning"));
    assert.ok(links.includes("/session-watch"));
    assert.ok(links.includes("/needs-me"));
    assert.ok(links.includes("/projects/project%3Aalpha/tasks"));
    for (const supported of ["inbox", "agents", "reviews", "activity", "files"])
      assert.ok(links.includes(`/projects/project%3Aalpha/${supported}`));
    assert.equal(links.includes("/projects/project%3Aalpha/settings"), false,
      "a supported project route the local runtime does not advertise is not navigable");
    for (const unsupported of ["/setup", "/workboard", "/settings", "/ideas", "/connections"])
      assert.equal(links.includes(unsupported), false, unsupported);
    assert.match(dom.window.document.body.textContent ?? "",
      /Hermes Agent.*Startup check passed.*no result proof recorded.*Claude Code.*Startup check passed.*no result proof recorded.*Codex.*Startup check passed.*no result proof recorded/s);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

/** The "Needs you" badge is the one header read that is allowed to fail
 * without degrading the page, so it gets its own test: a Mac-local host
 * serves the endpoint, and a host that does not — or whose read fails — must
 * keep navigation usable while showing that attention could not be checked. A count is
 * only ever shown when it was actually read. */
test("the header needs-you badge counts only what it read, and a failed or absent page is simply not badged", async () => {
  const cases = [
    { name: "exact count", response: () => Response.json(attentionPage([attentionItem("job-a"), attentionItem("job-b")])),
      expected: "2" },
    { name: "truncated count", response: () => Response.json(attentionPage([attentionItem("job-a")], "job-z")),
      expected: "1+" },
    { name: "no work needs the owner", response: () => Response.json(attentionPage([])), expected: "0" },
    { name: "endpoint absent", response: () => new Response(null, { status: 404 }), expected: null },
    { name: "read fails outright", response: () => { throw new Error("host unreachable"); }, expected: null },
    // A body that is not a valid attention page is refused, never half-read
    // into a count.
    { name: "malformed page", response: () => Response.json({ items: "not-a-list" }), expected: null },
  ];
  for (const { name, response, expected } of cases) {
    const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: "http://127.0.0.1:3210/" });
    const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"]
      .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
    const root = createRoot(dom.window.document.getElementById("root"));
    try {
      globalThis.fetch = path => {
        if (path === "/api/v1/needs-me/action-items") return Promise.resolve(canonicalSource());
        if (path === "/api/v1/needs-me/tasks") return Promise.resolve().then(response);
        return Promise.resolve(new Response(null, { status: 404 }));
      };
      await act(async () => root.render(React.createElement(LocalRuntimeProvider, null,
        React.createElement(ProductConfigurationProvider, null, React.createElement(PrivateHeader)))));
      await flushBadgeRead();
      const badge = dom.window.document.querySelector(".private-nav-badge");
      assert.equal(badge?.textContent?.replaceAll(/\s+/g, " ").trim().replace(/ needing you$/, "") ?? null,
        expected, name);
      // Whatever the read did, the nav still works and the brand is intact: a
      // failed badge read must not cost the owner the page.
      const inbox = dom.window.document.querySelector('a[href="/needs-me"]');
      assert.ok(inbox, `${name}: the Action Inbox link survives a failed badge read`);
      assert.equal(dom.window.document.querySelector(".private-brand")?.textContent, "Control Room", name);
      assert.doesNotMatch(dom.window.document.body.textContent ?? "", /error|failed|could not read/i, name);
      await act(async () => root.render(React.createElement(React.Fragment)));
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    }
  }
});
