import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectNavigation } from "../private-app/app/project-navigation";
import { ProjectModuleAvailability } from "../private-app/app/project-module-availability";
import type { EffectiveProjectPresentation } from "../src/web/v1/project-wire";

function presentation(overrides: Partial<EffectiveProjectPresentation>): EffectiveProjectPresentation {
  return {
    schema: "control-room.project-presentation/v1",
    templateId: "news-focused",
    templateDisplayName: "News focused",
    displayName: "News focused",
    enabledModules: ["news"],
    availableModules: ["news"],
    templateRemoved: false,
    source: "saved",
    ...overrides,
  } as EffectiveProjectPresentation;
}

test("ProjectNavigation hides the news tab when a saved template enables it but the template's available modules do not", () => {
  // The template includes "news" in enabledModules but the running configuration has flipped it off,
  // so availableModules is empty. Even if the global module were on, the news tab should stay hidden.
  const html = renderToStaticMarkup(createElement(ProjectNavigation, {
    projectId: "project:test", current: "overview",
    presentation: presentation({ enabledModules: ["news"], availableModules: [] }),
  }));
  assert.doesNotMatch(html, />\s*News\s*</);
});

test("ProjectNavigation shows only shared tabs before runtime and module configuration are known", () => {
  // A static render has neither runtime nor module configuration. Hosted-only
  // links appear after the browser identifies the host; local mode never shows them.
  const html = renderToStaticMarkup(createElement(ProjectNavigation, {
    projectId: "project:test", current: "overview", presentation: undefined,
  }));
  assert.doesNotMatch(html, />\s*News\s*</);
  assert.match(html, /Overview/);
  assert.match(html, /Work/);
  assert.doesNotMatch(html, /Inbox/);
});

test("ProjectNavigation is keyboard-accessible: it is a single <nav> with an aria-label", () => {
  const html = renderToStaticMarkup(createElement(ProjectNavigation, {
    projectId: "project:test", current: "overview", presentation: presentation({}),
  }));
  assert.match(html, /<nav class="private-tabs" aria-label="Project pages">/);
  assert.match(html, /aria-current="page"/);
});

test("ProjectModuleAvailability explains the unavailable-template case", () => {
  const html = renderToStaticMarkup(createElement(ProjectModuleAvailability,
    { presentation: presentation({ templateRemoved: true, availableModules: [] }) }));
  assert.match(html, /Saved template:/);
  assert.match(html, /News focused/);
  assert.match(html, /no longer in the operator configuration/);
});

test("ProjectModuleAvailability explains a globally disabled module without rewriting the saved selection", () => {
  const html = renderToStaticMarkup(createElement(ProjectModuleAvailability,
    { presentation: presentation({ enabledModules: ["news"], availableModules: [], templateRemoved: false }) }));
  assert.match(html, /The operator has disabled news globally/);
  assert.match(html, /Saved template: <strong>News focused<\/strong>/);
});

test("ProjectModuleAvailability renders nothing when presentation is absent", () => {
  const html = renderToStaticMarkup(createElement(ProjectModuleAvailability, { presentation: undefined }));
  assert.equal(html, "");
});

test("ProjectModuleAvailability renders a legacy explanation for pre-template projects", () => {
  const html = renderToStaticMarkup(createElement(ProjectModuleAvailability, {
    presentation: { schema: "control-room.project-presentation/v1", templateId: "", templateDisplayName: "",
      displayName: "", enabledModules: [], availableModules: ["ideaLab"], templateRemoved: false, source: "legacy_global" },
  }));
  assert.match(html, /created before templates were available/);
  assert.doesNotMatch(html, /Saved template:/);
});
