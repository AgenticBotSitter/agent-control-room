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
      globalThis.fetch = path => path === "/api/v1/local-workers" ? Promise.resolve(new Response(null, { status: 404 }))
        : new Promise(resolve => { respond = resolve; });
      await act(async () => root.render(React.createElement(LocalRuntimeProvider, null,
        React.createElement(ProductConfigurationProvider, null,
        React.createElement(PrivateHeader),
        React.createElement(ProjectNavigation, { projectId: "project:alpha", current: "overview" }),
        React.createElement(OptionalObservationMarker)))));
      assert.equal(dom.window.document.querySelector(".private-brand")?.textContent, "Control Room");
      assert.equal(dom.window.document.querySelector('a[href="/ideas"]'), null);
      assert.equal(dom.window.document.querySelector('a[href="/projects/project%3Aalpha/news"]'), null);

      await act(async () => { respond(Response.json(configuration)); await Promise.resolve(); });
      assert.equal(dom.window.document.querySelector(".private-brand")?.textContent, configuration.displayName);
      const workspaceLinks = [...dom.window.document.querySelectorAll("#private-workspace-navigation a")]
        .map(link => [link.textContent?.replaceAll(/\s+/g, " ").trim(), link.getAttribute("href")]);
      assert.deepEqual(workspaceLinks.slice(0, 8), [["Home", "/"], ["Projects", "/projects"], ["Workers", "/workers"],
        ["Session watch", "/session-watch"], ["Setup", "/setup"], ["Control Room", "/workboard"],
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
    assert.deepEqual(reads, ["/api/v1/local-workers"]);
    const links = [...dom.window.document.querySelectorAll("a[href]")].map(link => link.getAttribute("href"));
    assert.ok(links.includes("/workers"));
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
