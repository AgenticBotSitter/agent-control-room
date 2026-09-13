import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PrivateHeader } from "../private-app/app/private-header";
import { ProductConfigurationProvider, useProductModule } from "../private-app/app/product-configuration";
import { ProjectNavigation } from "../private-app/app/project-navigation";
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
      globalThis.fetch = () => new Promise(resolve => { respond = resolve; });
      await act(async () => root.render(React.createElement(ProductConfigurationProvider, null,
        React.createElement(PrivateHeader),
        React.createElement(ProjectNavigation, { projectId: "project:alpha", current: "overview" }),
        React.createElement(OptionalObservationMarker))));
      assert.equal(dom.window.document.querySelector(".private-brand")?.textContent, "Control Room");
      assert.equal(dom.window.document.querySelector('a[href="/ideas"]'), null);
      assert.equal(dom.window.document.querySelector('a[href="/projects/project%3Aalpha/news"]'), null);

      await act(async () => { respond(Response.json(configuration)); await Promise.resolve(); });
      assert.equal(dom.window.document.querySelector(".private-brand")?.textContent, configuration.displayName);
      const workspaceLinks = [...dom.window.document.querySelectorAll("#private-workspace-navigation a")]
        .map(link => [link.textContent?.replaceAll(/\s+/g, " ").trim(), link.getAttribute("href")]);
      assert.deepEqual(workspaceLinks.slice(0, 5), [["Home", "/"], ["Projects", "/projects"], ["Workers", "/workers"],
        ["Needs attention", "/needs-me"], ["Settings", "/settings"]]);
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
