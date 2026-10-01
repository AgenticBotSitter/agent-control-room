import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import { EverythingElseMenu } from "../private-app/app/everything-else-menu";
import { headerPageRegistry, pageRegistry } from "../private-app/app/page-registry";
import { PrivateHeader } from "../private-app/app/private-header";
import { LocalRuntimeContextV1 } from "../private-app/app/local-runtime";
import { ProductConfigurationContextV1 } from "../private-app/app/product-configuration";
import type { ProductConfigurationV1 } from "../src/config/v1/product-configuration";

const APP = join(process.cwd(), "private-app", "app");
const privateCss = readFileSync(join(APP, "private.css"), "utf8");

function appTopLevelRoutes() {
  return readdirSync(APP, { withFileTypes: true }).flatMap(entry => {
    if (entry.isFile() && entry.name === "page.tsx") return ["/"];
    if (!entry.isDirectory() || entry.name.startsWith("[") || entry.name.startsWith("_")) return [];
    return readdirSync(join(APP, entry.name)).includes("page.tsx") ? [`/${entry.name}`] : [];
  }).sort();
}

test("every actual top-level private page appears exactly once in the registry", () => {
  const registryRoutes = pageRegistry.map(entry => entry.href).sort();
  assert.deepEqual(registryRoutes, appTopLevelRoutes(), "the registry has neither a dead route nor a missing top-level page");
  assert.equal(new Set(registryRoutes).size, registryRoutes.length, "each route appears exactly once");
  assert.equal(new Set(pageRegistry.map(entry => entry.key)).size, pageRegistry.length, "each stable page key appears exactly once");
});

test("the registry preserves the pre-change header links and order", () => {
  const expected = [
    ["/", "Home"], ["/morning", "Morning summary"], ["/projects", "Projects"], ["/workers", "Workers"],
    ["/session-watch", "Session watch"], ["/setup", "Setup"], ["/workboard", "Control Room"],
    ["/needs-me", "Action Inbox"], ["/settings", "Settings"], ["/ideas", "Idea Lab"],
  ];
  assert.deepEqual(headerPageRegistry.map(entry => [entry.headerHref ?? entry.href, entry.headerTitle ?? entry.title]), expected);
  const html = renderToStaticMarkup(React.createElement(LocalRuntimeContextV1.Provider,
    { value: { mode: "local", status: undefined } }, React.createElement(PrivateHeader)));
  const document = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  assert.deepEqual([...document.querySelectorAll("#private-workspace-navigation a")]
    .map(link => [link.getAttribute("href"), (link.textContent ?? "").replace(/Optional|needing you/g, "").trim()]),
  [...expected.filter(([href]) => ["/", "/morning", "/projects", "/workers", "/session-watch", "/needs-me"].includes(href)), ["/sign-out", "Sign out"]]);
});

type Modules = ProductConfigurationV1["modules"];

function configuration(modules: Modules): ProductConfigurationV1 {
  return { schema: "control-room.product-configuration/v1", displayName: "Control Room", defaultTimezone: "UTC", modules,
    limits: { maxProjects: 1, maxTasksPerProject: 1, maxResultsPerTask: 1, maxArticleSources: 0, maxIdeaParticipants: 0 },
    projectTemplates: [{ id: "control-room", displayName: "Control Room", enabledModules: [] }] };
}

function navigationPageKeys(component: React.ReactElement, mode: "checking" | "local" | "hosted", modules: Modules) {
  const runtime = mode === "local" ? { mode, status: { taskWorkersStarted: true, workers: [], projectSections: [] } } : { mode };
  const html = renderToStaticMarkup(React.createElement(LocalRuntimeContextV1.Provider, { value: runtime },
    React.createElement(ProductConfigurationContextV1.Provider, { value: configuration(modules) }, component)));
  const document = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  const links = component.type === PrivateHeader
    ? [...document.querySelectorAll("#private-workspace-navigation a")]
    : [...document.querySelectorAll("#everything-else-pages a")];
  return links.filter(link => link.getAttribute("href") !== "/sign-out").map(link => {
    const entry = pageRegistry.find(candidate => (component.type === PrivateHeader
      ? candidate.headerHref ?? candidate.href : candidate.href) === link.getAttribute("href"));
    assert.ok(entry, `every rendered navigation link belongs to the page registry: ${link.getAttribute("href")}`);
    return entry.key;
  });
}

test("the rendered header and Home menu share page visibility for every mode and module state", () => {
  const headerKeys = new Set(headerPageRegistry.map(entry => entry.key));
  for (const ideaLab of [false, true]) for (const news of [false, true]) for (const sessionObservations of [false, true]) {
    const modules = { ideaLab, news, sessionObservations };
    for (const mode of ["checking", "local", "hosted"] as const) {
      const header = navigationPageKeys(React.createElement(PrivateHeader), mode, modules).sort();
      const menu = navigationPageKeys(React.createElement(EverythingElseMenu), mode, modules).sort();
      const label = `${mode}; ideaLab=${ideaLab}; news=${news}; sessionObservations=${sessionObservations}`;
      assert.deepEqual(header, menu.filter(key => headerKeys.has(key)), `header and menu differ on shared pages: ${label}`);
      if (mode === "hosted") assert.equal(menu.includes("ideas"), ideaLab, `Idea Lab visibility: ${label}`);
      if (mode === "local") for (const hidden of ["setup", "settings", "workboard", "session"])
        assert.equal(menu.includes(hidden), false, `Mac-local menu must hide ${hidden}: ${label}`);
    }
  }
});

function saveGlobals() {
  return Object.fromEntries(["window", "document", "HTMLElement", "HTMLInputElement", "Event", "EventTarget",
    "KeyboardEvent", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
}

function restoreGlobals(saved: Record<string, PropertyDescriptor | undefined>) {
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
}

test("everything else filters labels and groups, announces every result count change, and follows the phone disclosure rules", async () => {
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: "https://control.invalid/", pretendToBeVisual: true });
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 375 });
  Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: () => ({ matches: true,
    addEventListener() {}, removeEventListener() {} }) });
  const saved = saveGlobals();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Event: dom.window.Event,
    EventTarget: dom.window.EventTarget, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => { root.render(React.createElement(EverythingElseMenu)); });
    const toggle = dom.window.document.querySelector<HTMLButtonElement>(".private-everything-else-toggle")!;
    const pages = dom.window.document.getElementById("everything-else-pages")!;
    assert.equal(toggle.getAttribute("aria-expanded"), "false", "the 375px menu starts closed");
    assert.equal(toggle.getAttribute("aria-controls"), pages.id);
    await act(async () => { toggle.click(); });
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    const input = dom.window.document.querySelector<HTMLInputElement>("#everything-else-filter")!;
    const setInput = (value: string) => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    };
    await act(async () => {
      setInput("workers & connections");
    });
    assert.match(pages.textContent ?? "", /Workers[\s\S]*Connections[\s\S]*Session watch/);
    assert.doesNotMatch(pages.textContent ?? "", /Projects & Work/);
    const resultCount = pages.querySelector('[role="status"]');
    assert.equal(resultCount?.getAttribute("aria-live"), "polite");
    assert.equal(resultCount?.textContent, "2 pages found");
    await act(async () => {
      setInput("not a registered page");
    });
    assert.match(pages.textContent ?? "", /No pages match 'not a registered page'\./);
    assert.equal(resultCount?.textContent, "0 pages found", "the live region updates when a query has no matches");
    await act(async () => { setInput("morning"); });
    assert.equal(resultCount?.textContent, "1 page found", "the live region updates again when the count changes");
    await act(async () => { setInput("<img src=x onerror=alert(1)>"); });
    assert.equal(pages.querySelector("img"), null, "a hostile filter remains text, never markup");
    assert.match(pages.textContent ?? "", /No pages match '<img src=x onerror=alert\(1\)>'\./);
    await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(dom.window.document.activeElement, toggle, "Escape returns focus to the disclosure control");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    restoreGlobals(saved);
  }
});

test("the 375px page menu has no horizontal layout escape hatch and keeps labelled controls", () => {
  assert.match(privateCss, /\.private-everything-else-pages input\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/);
  assert.match(privateCss, /\.private-page-groups\s*\{[^}]*minmax\(min\(12rem,\s*100%\),\s*1fr\)/);
  assert.match(privateCss, /@media \(max-width: 560px\)[\s\S]*?\.private-page-groups\s*\{\s*grid-template-columns:\s*1fr/,
    "at 375px every page group is one column, so no group can force a horizontal row");
  const html = renderToStaticMarkup(React.createElement(EverythingElseMenu));
  const document = new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
  const input = document.querySelector("#everything-else-filter");
  assert.equal(document.querySelector(`label[for="${input?.id}"]`)?.textContent, "Find a page…");
  assert.equal(document.querySelector(".private-everything-else-toggle")?.getAttribute("aria-controls"), "everything-else-pages");
});
