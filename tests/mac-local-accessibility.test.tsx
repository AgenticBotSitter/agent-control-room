import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import { ProjectCreateForm } from "../app/components/project-create-form";
import { ConnectionCenterPanel } from "../app/components/connection-center";
import { OrdinaryProjectStatusActions, IdeaProjectStatusActions } from "../private-app/app/workspace";
import { ScheduleStatusView } from "../private-app/app/schedule-status";
import { PrivateConnectionView } from "../private-app/app/connections/workspace";
import { PrivateHeader } from "../private-app/app/private-header";
import { LocalRuntimeContextV1 } from "../private-app/app/local-runtime";
import type { ConnectionCenterDataStateV1 } from "../src/connection-center/v1/types";
import type { WebProject } from "../src/web/v1/project-wire";

const stylesheet = readFileSync(fileURLToPath(new URL("../styles/control-room.css", import.meta.url)), "utf8");
const privateStylesheet = readFileSync(fileURLToPath(new URL("../private-app/app/private.css", import.meta.url)), "utf8");

/* ------------------------------------------------------------------ *
 * Contrast
 *
 * These assertions read the shipped token values out of the stylesheet
 * and compute the WCAG 2.x ratios, so a future palette edit that
 * regresses a token fails here instead of silently shipping. The audit
 * that motivated this was static analysis only; this pins the numbers.
 * ------------------------------------------------------------------ */

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map(index => Number.parseInt(value.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map(channel =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground), second = relativeLuminance(background);
  const lighter = Math.max(first, second), darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function themeTokens(selector: string): Record<string, string> {
  const start = stylesheet.indexOf(selector);
  assert.notEqual(start, -1, `stylesheet must declare ${selector}`);
  const body = stylesheet.slice(start, stylesheet.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)]
    .map(match => [match[1], match[2].toLowerCase()]));
}

const LIGHT = themeTokens(":root {");
const DARK = themeTokens(':root[data-theme="dark"] {');
const SURFACES = ["bg", "surface", "surface-2", "surface-3", "sidebar"] as const;
const STATE_COLOURS = ["green", "amber", "red", "blue", "violet"] as const;

test("light-theme secondary text clears WCAG AA on every surface it is painted on", () => {
  // The regression this pins: --muted and --faint were 3.90:1 and 2.42:1 on
  // --sidebar, so secondary text failed AA on all five backgrounds in the
  // system. Both must now clear 4.5:1 on the darkest surface, not just --bg.
  for (const token of ["muted", "faint"] as const) {
    for (const surface of SURFACES) {
      const ratio = contrastRatio(LIGHT[token], LIGHT[surface]);
      assert.ok(ratio >= 4.5,
        `light --${token} on --${surface} is ${ratio.toFixed(2)}:1, below the 4.5:1 AA minimum`);
    }
  }
});

test("dark-theme secondary text clears WCAG AA on every surface", () => {
  for (const token of ["muted", "faint"] as const) {
    for (const surface of SURFACES) {
      const ratio = contrastRatio(DARK[token], DARK[surface]);
      assert.ok(ratio >= 4.5,
        `dark --${token} on --${surface} is ${ratio.toFixed(2)}:1, below the 4.5:1 AA minimum`);
    }
  }
});

test("every state chip colour clears AA against its own soft background and any plain surface", () => {
  for (const [theme, tokens] of [["light", LIGHT], ["dark", DARK]] as const) {
    for (const colour of STATE_COLOURS) {
      for (const background of [`${colour}-soft`, ...SURFACES]) {
        const ratio = contrastRatio(tokens[colour], tokens[background]);
        assert.ok(ratio >= 4.5,
          `${theme} --${colour} on --${background} is ${ratio.toFixed(2)}:1, below the 4.5:1 AA minimum`);
      }
    }
  }
});

test("faint stays visually distinct from muted in both themes", () => {
  // Both tokens are pinned to the same 4.5:1 floor over the same backgrounds, so
  // the ordering has to be asserted explicitly or the two collapse into one.
  assert.ok(relativeLuminance(LIGHT.faint) > relativeLuminance(LIGHT.muted),
    "light --faint must be lighter than --muted");
  assert.ok(relativeLuminance(DARK.muted) > relativeLuminance(DARK.faint),
    "dark --faint must be darker than --muted");
});

test("the focus ring is a solid indicator that clears 3:1 on every surface", () => {
  // A focus ring is a non-text UI indicator, so the 3:1 minimum applies. The
  // 55%-alpha color-mix this replaced composited to roughly 2.2:1 in the light
  // theme and 2.96:1 on --surface-3 in the dark theme.
  const ring = /button:focus-visible[^{]*\{[^}]*outline:\s*([^;]+);/.exec(stylesheet);
  assert.ok(ring, "the button focus ring must declare an outline");
  const declared = ring[1] ?? "";
  assert.doesNotMatch(declared, /color-mix|transparent|alpha/i,
    `the focus ring must not be translucent: ${declared}`);
  assert.match(declared, /var\(--green\)/, "the focus ring must use the theme focus token");
  for (const [theme, tokens] of [["light", LIGHT], ["dark", DARK]] as const) {
    for (const surface of SURFACES) {
      const ratio = contrastRatio(tokens.green, tokens[surface]);
      assert.ok(ratio >= 3,
        `${theme} focus ring on --${surface} is ${ratio.toFixed(2)}:1, below the 3:1 non-text minimum`);
    }
  }
});

test("the private shell also paints a solid focus ring for inputs, links and tabindex targets", () => {
  for (const selector of [".private-shell a:focus-visible", ".private-shell [tabindex]:focus-visible",
    ".private-shell textarea:focus-visible", ".private-shell input:focus-visible"]) {
    const rule = new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")}[^{]*\\{[^}]*outline:\\s*([^;]+);`).exec(privateStylesheet);
    assert.ok(rule, `${selector} must declare a visible focus outline`);
    const declared = rule[1] ?? "";
    assert.doesNotMatch(declared, /color-mix|transparent|alpha/i,
      `${selector} focus ring must not be translucent: ${declared}`);
  }
});

test("no rule suppresses a focus indicator", () => {
  for (const [name, source] of [["control-room.css", stylesheet], ["private.css", privateStylesheet]] as const) {
    assert.doesNotMatch(source, /outline:\s*(none|0)\b/, `${name} must never remove a focus outline`);
  }
});

/* ------------------------------------------------------------------ *
 * 360px: no page-wide horizontal scroll from a data-driven string
 * ------------------------------------------------------------------ */

test("the interpolated metric caption can wrap instead of overflowing a 360px viewport", () => {
  const rule = /\.metric-card em\s*\{([^}]*)\}/.exec(stylesheet);
  assert.ok(rule, ".metric-card em must be styled");
  const declared = rule[1] ?? "";
  assert.doesNotMatch(declared, /white-space:\s*nowrap/,
    ".metric-card em carries interpolated counts, so nowrap can push it past a 360px viewport");
  assert.match(declared, /overflow-wrap:\s*anywhere/,
    ".metric-card em must be able to break at any character");
});

test("the metric grid and the shell itself cannot force horizontal overflow", () => {
  // The card is safe because the track is minmax(0, 1fr) and collapses to one
  // column below 620px; the text inside it was the actual hazard.
  assert.match(stylesheet, /\.metric-grid\s*\{[^}]*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  const narrow = /@media \(max-width: 620px\)\s*\{([\s\S]*?)\n\}/.exec(stylesheet);
  assert.ok(narrow, "the stylesheet must collapse the metric grid at narrow widths");
  // The rule is a grouped selector, so the declaration follows several names.
  const group = /([^{}]*\.metric-grid[^{}]*)\{([^}]*grid-template-columns:\s*1fr[^}]*)\}/.exec(narrow[1] ?? "");
  assert.ok(group, "the narrow-width block must set .metric-grid to a single column");
  // The shell clips its own overflow. That is load-bearing for the layout, so
  // it stays; it is also why the nowrap caption had to be fixed rather than
  // left to scroll.
  assert.match(privateStylesheet, /\.private-shell\s*\{[^}]*overflow-x:\s*clip/);
  assert.match(privateStylesheet, /\.private-columns\s*\{[^}]*minmax\(0,\s*1fr\)/);
});

/* ------------------------------------------------------------------ *
 * Labels and announced errors
 * ------------------------------------------------------------------ */

function documentFor(html: string): Document {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
}

test("the create form ties each field to the error that describes it", () => {
  const html = renderToStaticMarkup(createElement(ProjectCreateForm,
    { pending: false, result: "invalid", templates: undefined, onCreate() {} }));
  const document = documentFor(html);

  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "an invalid submission must still announce one alert");
  assert.equal(alert!.id, "project-create-error");

  for (const [id, labelText] of [["project-title", "Project name"], ["project-summary", "What do you want to accomplish?"]]) {
    const field = document.getElementById(id);
    assert.ok(field, `${id} must exist`);
    const label = document.querySelector(`label[for="${id}"]`);
    assert.ok(label, `${id} must have a <label for>`);
    assert.equal(label!.textContent, labelText);
    const described = (field!.getAttribute("aria-describedby") ?? "").split(/\s+/);
    assert.ok(described.includes("project-create-error"),
      `${id} must reference the announced error through aria-describedby`);
    // Every id it names must resolve, or the reference is dangling.
    for (const target of described) assert.ok(document.getElementById(target),
      `${id} references missing id "${target}"`);
  }
});

test("the create form names the field that is actually invalid", () => {
  // The single shared sentence named two fields without saying which was
  // wrong, so a user who tabbed back to the first field learned nothing.
  const beforeSubmit = documentFor(renderToStaticMarkup(createElement(ProjectCreateForm,
    { pending: false, result: "idle", templates: undefined, onCreate() {} })));
  assert.equal(beforeSubmit.getElementById("project-summary")!.getAttribute("aria-invalid"), null,
    "no field is marked invalid before submission");
  assert.equal(beforeSubmit.querySelector('[role="alert"]'), null,
    "no error is announced before submission");

  // A server rejection carries no per-field detail, but the form can still say
  // which of its own two constraints is violated. An empty title is 0
  // characters, which breaks "1-120", so it is marked; the summary is empty
  // and within "at most 1,000", so it is not. Only the field at fault is
  // marked, and both still point at the announced sentence.
  const rejected = documentFor(renderToStaticMarkup(createElement(ProjectCreateForm,
    { pending: false, result: "invalid", templates: undefined, onCreate() {} })));
  assert.equal(rejected.getElementById("project-title")!.getAttribute("aria-invalid"), "true",
    "an empty title violates the 1-120 constraint");
  assert.equal(rejected.getElementById("project-summary")!.getAttribute("aria-invalid"), null,
    "an empty summary is within the at-most-1,000 constraint");
  for (const id of ["project-title", "project-summary"]) {
    const described = (rejected.getElementById(id)!.getAttribute("aria-describedby") ?? "").split(/\s+/);
    assert.ok(described.includes("project-create-error"), `${id} must reference the announced error`);
  }
});

test("a per-field message is rendered only for the field that is at fault", () => {
  // The server is the authority on the constraint, so this drives the form
  // through a real submission with a title that is too long, which is the
  // client-side case the form can distinguish.
  const html = renderToStaticMarkup(createElement(ProjectCreateForm,
    { pending: false, result: "invalid", templates: undefined, onCreate() {} }));
  // With result="invalid" and empty fields, the title constraint is violated
  // and the summary constraint is not, so exactly one field message renders.
  const document = documentFor(html);
  const titleMessage = document.getElementById("project-title-error");
  assert.ok(titleMessage, "the offending field carries its own message");
  assert.match(titleMessage!.textContent ?? "", /1.120 characters/);
  assert.equal(document.getElementById("project-summary-error"), null,
    "a field within its own constraint carries no message");
  assert.equal(document.getElementById("project-title")!.getAttribute("aria-invalid"), "true");
  assert.equal(document.getElementById("project-summary")!.getAttribute("aria-invalid"), null,
    "the field at fault is marked, the other is not");
});

test("every form control on the six Mac-local pages is labelled", () => {
  const controls = documentFor(renderToStaticMarkup(createElement(ProjectCreateForm,
    { pending: false, result: "idle",
      templates: [{ templateId: "t1", displayName: "Starter", configurationDigest: "sha256:0" }],
      onCreate() {} })));
  for (const control of controls.querySelectorAll("input, textarea, select")) {
    const id = control.getAttribute("id");
    const label = id ? controls.querySelector(`label[for="${id}"]`) : null;
    const owner = label ?? control.closest("label");
    assert.ok(owner, `control ${control.tagName}#${id ?? "(no id)"} has no associated label`);
    assert.match(owner!.textContent ?? "", /\S/,
      `control ${control.tagName}#${id ?? "(no id)"} has an empty label`);
  }
});

test("no button or link is unnamed", () => {
  const surfaces: readonly [string, string][] = [
    ["create form", renderToStaticMarkup(createElement(ProjectCreateForm,
      { pending: false, result: "idle", templates: undefined, onCreate() {} }))],
    ["create form with template", renderToStaticMarkup(createElement(ProjectCreateForm,
      { pending: false, result: "idle",
        templates: [{ templateId: "t1", displayName: "Starter", configurationDigest: "sha256:0" }], onCreate() {} }))],
  ];
  for (const [name, html] of surfaces) {
    const document = documentFor(html);
    for (const control of document.querySelectorAll("button, a[href]")) {
      const label = (control.getAttribute("aria-label") ?? control.textContent ?? "").trim();
      assert.ok(label.length > 0, `${name}: ${control.outerHTML} has no accessible name`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Live regions must not swallow interactive controls
 * ------------------------------------------------------------------ */

function assertLiveRegionsExcludeControls(html: string, context: string) {
  const document = documentFor(html);
  for (const region of document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')) {
    assert.equal(region.querySelectorAll("button, a[href], input, select, textarea, summary").length, 0,
      `${context}: a live region must not contain an interactive control: ${region.outerHTML.slice(0, 160)}`);
  }
}

test("an announced error is announced alone, not as a wrapper around its own recovery control", () => {
  const connectionProjection = {
    summary: { connectionCount: 2, currentSignalCount: 3, staleSignalCount: 12, missingSignalCount: 7,
      attentionCount: 1, livePanelEligibleCount: 0 },
    reviewedRuntime: { releaseLine: "0.21", runtimeRevision: "abcdef0123456789abcdef0123456789abcdef01" },
    connections: [],
  };
  const unavailable = renderToStaticMarkup(createElement(PrivateConnectionView,
    { data: { state: "unavailable", code: "unavailable" }, onRefresh() {} }));
  assertLiveRegionsExcludeControls(unavailable, "connection inventory");

  const data = { state: "available", projection: connectionProjection } as unknown as ConnectionCenterDataStateV1;
  assertLiveRegionsExcludeControls(renderToStaticMarkup(createElement(ConnectionCenterPanel, { data })),
    "connection summary");

  for (const code of ["unavailable", "not_found", "access_denied", "authentication_required"] as const) {
    const html = renderToStaticMarkup(createElement(ScheduleStatusView,
      { state: { state: "unavailable", code, message: "read failed", projectId: "project:alpha" },
        projectId: "project:alpha", onRetry() {} }));
    assertLiveRegionsExcludeControls(html, `schedule ${code}`);
    assert.match(html, /role="alert"/, `schedule ${code} must still announce its failure`);
  }
});

test("the schedule failure alert covers the failure text and not the Retry button", () => {
  const html = renderToStaticMarkup(createElement(ScheduleStatusView,
    { state: { state: "unavailable", code: "not_found", message: "read failed", projectId: "project:alpha" },
      projectId: "project:alpha", onRetry() {} }));
  const document = documentFor(html);
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the failure must be announced");
  assert.ok(alert!.querySelector("p"), "the alert must carry the failure sentences");
  assert.equal(alert!.querySelectorAll("button").length, 0,
    "the Retry button must sit outside the live region");
  assert.equal(document.querySelectorAll("button").length, 1, "the Retry control must still be reachable");
});

/* ------------------------------------------------------------------ *
 * Decorative glyphs
 * ------------------------------------------------------------------ */

test("metric glyphs are decorative and carry no information alone", () => {
  const data = { state: "available", projection: {
    summary: { connectionCount: 2, currentSignalCount: 3, staleSignalCount: 12, missingSignalCount: 7,
      attentionCount: 1, livePanelEligibleCount: 0 },
    reviewedRuntime: { releaseLine: "0.21", runtimeRevision: "abcdef0123456789abcdef0123456789abcdef01" },
    connections: [] } } as unknown as ConnectionCenterDataStateV1;
  const document = documentFor(renderToStaticMarkup(createElement(ConnectionCenterPanel, { data })));
  for (const icon of document.querySelectorAll(".metric-icon")) {
    assert.equal(icon.getAttribute("aria-hidden"), "true",
      "a decorative glyph must be hidden from assistive technology");
  }
  // Hiding the glyph must not hide the meaning: each card still names itself.
  for (const label of ["Enrolled", "Recent signals", "Needs setup", "Live panels"]) {
    assert.ok(document.querySelector(`.metric-card small`)?.textContent, "cards must keep their text label");
    assert.match(document.body.textContent ?? "", new RegExp(label));
  }
});

/* ------------------------------------------------------------------ *
 * Focusability
 * ------------------------------------------------------------------ */

test("the header disclosure is a real button with correct state, and Escape closes it", async () => {
  // The disclosure already had aria-expanded/aria-controls; this pins that a
  // keyboard user can dismiss it, which the audit found was impossible.
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: "http://127.0.0.1:3210/projects" });
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  install("window", dom.window);
  install("document", dom.window.document);
  install("navigator", dom.window.navigator);
  install("location", dom.window.location);
  install("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    const root = createRoot(dom.window.document.getElementById("root")!);
    await act(async () => {
      root.render(createElement(LocalRuntimeContextV1.Provider,
        { value: { mode: "local", status: undefined } }, createElement(PrivateHeader)));
    });
    const toggle = dom.window.document.querySelector<HTMLButtonElement>(".private-navigation-toggle")!;
    assert.ok(toggle, "the disclosure must be a real <button>, reachable by Tab");
    assert.equal(toggle.tagName, "BUTTON");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("aria-controls"), "private-workspace-navigation");
    assert.ok(dom.window.document.getElementById(toggle.getAttribute("aria-controls")!),
      "aria-controls must reference the existing nav");

    await act(async () => { toggle.click(); });
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(toggle.getAttribute("aria-expanded"), "false", "Escape must close the disclosure");
    assert.equal(dom.window.document.activeElement, toggle,
      "Escape must return focus to the control that opened the menu");
    await act(async () => { root.unmount(); });
  } finally {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("a lifecycle action that remounts the button set keeps focus in the group", async () => {
  // Activating "Pause project" unmounts it and mounts "Resume project", so the
  // focused element is removed and focus fell back to <body>.
  const dom = new JSDOM("<!doctype html><div id=root></div>", { url: "http://127.0.0.1:3210/projects/project:alpha" });
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  install("window", dom.window);
  install("document", dom.window.document);
  install("navigator", dom.window.navigator);
  install("location", dom.window.location);
  install("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    const base = { projectId: "project:alpha", title: "Alpha", summary: "Saved", lifecycle: "active" as WebProject["lifecycle"],
      version: 1, createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T10:00:00.000Z",
      origin: "ordinary" as const, lifecycleEditable: true };
    const root = createRoot(dom.window.document.getElementById("root")!);
    const document_ = dom.window.document;
    const render = async (project: typeof base) => {
      await act(async () => {
        root.render(createElement(OrdinaryProjectStatusActions, { project, pending: false, onTransition() {} }));
      });
    };
    await render(base);
    const pause = [...document_.querySelectorAll("button")].find(b => b.textContent === "Pause project");
    assert.ok(pause, "an active project offers Pause project");
    assert.equal(pause!.tagName, "BUTTON");

    // Focus the button the way a keyboard user would, then activate it.
    await act(async () => { pause!.focus(); });
    assert.equal(document_.activeElement, pause);
    await act(async () => { pause!.click(); });
    // The component under test owns the transition; simulate the state change
    // the parent would make by re-rendering with the new lifecycle.
    await render({ ...base, lifecycle: "paused", version: 2 });
    // An ordinary project's control set is Reopen / Pause / Mark complete /
    // Archive, minus the current state, so a paused project now offers Reopen
    // where "Pause project" used to be. The button that had focus is gone.
    const reopen = [...document_.querySelectorAll("button")].find(b => b.textContent === "Reopen project");
    assert.ok(reopen, "a paused project offers Reopen project in its place");
    assert.equal([...document_.querySelectorAll("button")].some(b => b.textContent === "Pause project"), false,
      "the activated button must be unmounted, which is why focus was lost");
    assert.notEqual(document_.activeElement, document_.body,
      "focus must not fall back to <body> when the activated button is remounted");
    assert.ok(document_.contains(document_.activeElement!), "focus must stay inside the page");
    assert.equal((document_.activeElement as HTMLElement).tagName, "BUTTON",
      "focus must land on a real control inside the re-rendered group");
    assert.ok(document_.activeElement!.closest(".private-actions"),
      "focus must land inside the same action group the user was operating");
    await act(async () => { root.unmount(); });
  } finally {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("every focusable control on the audited pages is natively focusable", () => {
  // No div/span/li stands in for a button, and no role="button" duplicates a
  // native control. Every tabIndex is -1, a programmatic focus target only.
  const views: readonly [string, string][] = [
    ["create form", renderToStaticMarkup(createElement(ProjectCreateForm,
      { pending: false, result: "invalid", templates: undefined, onCreate() {} }))],
    ["lifecycle actions", renderToStaticMarkup(createElement(IdeaProjectStatusActions,
      { project: { projectId: "project:alpha", title: "Alpha", summary: "s", lifecycle: "active", version: 1,
        createdAt: "2026-09-04T10:00:00.000Z", updatedAt: "2026-09-04T10:00:00.000Z",
        origin: "idea_lab", lifecycleEditable: true, ideaLifecycleActions: ["pause", "complete"] } as never,
      pending: false, onAction() {} }))],
  ];
  for (const [name, html] of views) {
    const document = documentFor(html);
    assert.equal(document.querySelectorAll('[role="button"]').length, 0,
      `${name}: no role="button" is needed because every action is a native button`);
    for (const element of document.querySelectorAll("[tabindex]")) {
      assert.equal(element.getAttribute("tabindex"), "-1",
        `${name}: ${element.outerHTML} must use tabindex="-1" only`);
      assert.ok(!element.hasAttribute("onclick"), `${name}: click handlers belong on native controls`);
    }
    for (const element of document.querySelectorAll("div, span, li, p")) {
      assert.doesNotMatch(element.outerHTML, /onclick|onkeydown|onkeypress|onkeyup/,
        `${name}: ${element.tagName} must not carry a click or key handler`);
    }
  }
});
