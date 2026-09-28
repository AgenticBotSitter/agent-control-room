// Home paints in one order, and that order is the reading order.
//
// The finding this file answers: PR #404 made `main` a phone-width flex column
// and used CSS `order` to push Home's framing copy below the panels, leaving
// the focusable "Check saved dashboard again" button ahead of them in the DOM.
// CSS `order` changes paint order only, so a keyboard tabbed to that button —
// the first control in `main` — while it painted last, and a screen reader met
// the copy before the panels. Worse in hosted mode: five of `main`'s seven
// children carried no `order` at all and so painted at the default 0, ahead of
// the dashboard's `order: 1`. The attention-first claim the PR advertised did
// not hold there, and no test covered hosted Home, so nothing noticed.
//
// The browser suite only ever serves Mac-local Home, so this is where hosted
// coverage has to live. These render the real `PrivateHome` in both runtime
// modes and check three separate things:
//
//   1. no `order` may separate two children of Home's `main`. This is the
//      direct guard: it fails the moment any `order:` is reintroduced, whether
//      or not it happens to produce a visually acceptable page today.
//   2. the painted order of every focusable in `main` is monotonic, so tab
//      order and paint order cannot disagree even if (1) is worked around.
//   3. "Needs attention" precedes the other panels, so the attention-first
//      result is a consequence of position rather than of a paint trick.
//
// It is also a mutation-resistant test: check (1) reads the shipped stylesheet
// rather than trusting the component, and check (2) is computed from the DOM
// the component produced, so re-adding the `order` rules fails even if the
// JSX is left alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

import { PrivateHome } from "../private-app/app/home-workspace";
import { LocalRuntimeContextV1 } from "../private-app/app/local-runtime";

const STYLESHEET = readFileSync(
  new URL("../private-app/app/private.css", import.meta.url), "utf8");

const LOCAL_STATUS = { taskWorkersStarted: true, workers: [], projectSections: [] } as const;

/** Every rule that assigns `order` to one of Home's `main` children. */
const homeOrderDeclarations = [...STYLESHEET.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap(match => (match[2] ?? "").split(";")
    .filter(declaration => /^\s*order\s*:/.test(declaration))
    .map(declaration => ({ selector: (match[1] ?? "").trim().replace(/\s+/g, " "), declaration: declaration.trim() })));

/** Mount the real Home in one runtime mode with every protected read settled. */
async function mountHome(mode: "local" | "hosted") {
  const { createRoot } = await import("react-dom/client");
  const { act, createElement } = await import("react");
  const dom = new JSDOM("<!doctype html><div id='root'></div>",
    { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const responseFor = (path: string): Response => {
    if (path === "/api/v1/local-workers") {
      return mode === "hosted" ? new Response(null, { status: 404 }) : Response.json(LOCAL_STATUS);
    }
    if (path === "/api/v1/projects") return Response.json({ projects: [], nextCursor: null, canCreate: true,
      sources: { ordinary: "included", ideas: "not_configured" } });
    if (path === "/api/v1/home/tasks") return Response.json({ active: [], recentResults: [],
      additionalActiveOmitted: false, additionalResultsOmitted: false, resultSource: "not_configured",
      observedAt: "2026-09-28T12:00:00.000Z", startsWork: false });
    if (path === "/api/v1/needs-me/tasks") return Response.json({ items: [], nextCursor: null, examined: 0,
      observedAt: "2026-09-28T12:00:00.000Z", startsWork: false, planningSource: "not_configured",
      deliverySource: "not_configured", sources: { ordinary: "included", ideas: "not_configured" } });
    if (path === "/api/v1/connections") return Response.json({ telemetry: "not_configured", projection: {
      summary: { connectionCount: 0, currentSignalCount: 0, staleSignalCount: 0, missingSignalCount: 0,
        attentionCount: 0 } } });
    return new Response(null, { status: 404 });
  };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (async (input: RequestInfo | URL) => responseFor(String(input))) as typeof fetch });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root.render(createElement(LocalRuntimeContextV1.Provider,
    { value: { mode, ...(mode === "local" ? { status: LOCAL_STATUS } : {}) } },
    createElement(PrivateHome))); });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 5)); });
    if (!/Checking saved|Reading the recorded/.test(dom.window.document.body.textContent ?? "")) break;
  }
  const restore = async () => {
    try { await act(async () => { root.unmount(); }); } catch { /* already torn down */ }
    await new Promise(resolve => setImmediate(resolve));
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  return { document: dom.window.document, window: dom.window, restore };
}

/** Home's `main` children, described well enough to name one in a failure. */
function mainChildren(document: Document) {
  const main = document.querySelector("main");
  assert.ok(main, "Home must render a <main>");
  return [...main.children].map(child => {
    const element = child as HTMLElement;
    return { element, className: element.className || element.tagName.toLowerCase(),
      label: (element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40) };
  });
}

/**
 * The painted order of a flex item, which is what a sighted owner sees, and
 * the order a keyboard does NOT follow. Returns the DOM index each child would
 * paint at, so any disagreement between paint and tab order is directly visible.
 *
 * A non-flex `main` has no `order` to honour and paints in source order, so it
 * returns the identity ranking rather than pretending to measure layout — jsdom
 * has no layout engine, so "painted" can only ever mean "as this stylesheet
 * orders it".
 */
function paintedOrderOf(document: Document, window: Window) {
  const main = document.querySelector("main")!;
  const siblings = [...main.children] as HTMLElement[];
  const style = window.getComputedStyle.bind(window);
  const isFlex = style(main).display.includes("flex");
  const painted = siblings.map((_, index) => index)
    .sort((left, right) => {
      if (!isFlex) return left - right;
      const a = Number(style(siblings[left]!).order) || 0;
      const b = Number(style(siblings[right]!).order) || 0;
      return a === b ? left - right : a - b;
    });
  return { isFlex, painted };
}

test("no CSS order may separate Home's main children, because order breaks tab order", () => {
  // The direct guard. `order` on a flex or grid child changes where it paints
  // and nothing else: the DOM order, and therefore the tab sequence and the
  // screen-reader reading order, are untouched. Any rule that gives one of
  // Home's `main` children an `order` reopens the finding this test exists to
  // close, so the stylesheet is checked directly rather than the rendered
  // result — a rule that happens to be harmless today still gets removed.
  assert.deepEqual(homeOrderDeclarations, [],
    `CSS "order" must not reorder Home's main children: ${JSON.stringify(homeOrderDeclarations)}`);
});

test("Home's main children are siblings of one plain block flow at phone width", () => {
  // The rule that made `order` possible in the first place was turning `main`
  // into a flex column. Without it there is no paint order to diverge from
  // source order, so this asserts the precondition of the rule above.
  const flexRules = [...STYLESHEET.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => /(^|\s)\.private-home-main\b/.test(match[1] ?? ""))
    .flatMap(match => (match[2] ?? "").split(";").map(declaration => declaration.trim())
      .filter(declaration => /^(display\s*:\s*flex|flex-direction)/.test(declaration)));
  assert.deepEqual(flexRules, [],
    `.private-home-main must stay in normal flow: ${JSON.stringify(flexRules)}`);
});

for (const mode of ["local", "hosted"] as const) {
  test(`Home in ${mode} mode paints its focusable controls in tab order`, async () => {
    const mounted = await mountHome(mode);
    try {
      const { document, window, restore } = mounted;
      const { isFlex, painted } = paintedOrderOf(document, window);
      assert.equal(isFlex, false,
        "main must not be a flex container, or paint order could diverge from source order again");

      // Every control a keyboard can reach inside `main`, in the order it is
      // reached, mapped to where it paints.
      const focusables = [...document.querySelectorAll("main a[href], main button, main input, main select, main textarea")];
      assert.ok(focusables.length >= 4, `expected real controls in main, got ${focusables.length}`);
      const main = document.querySelector("main")!;
      const indexOfChild = new Map([...main.children].map((child, index) => [child as Element, index] as const));
      const paintedRank = new Map(painted.map((domIndex, rank) => [domIndex, rank]));
      const describe = (element: Element) => `${element.tagName.toLowerCase()}` +
        `${element.className ? `.${element.className}` : ""} "${(element.textContent ?? "").trim().slice(0, 30)}"`;
      // jsdom carries no layout engine, so `getComputedStyle` resolves the
      // `display` this page actually ships — which is the whole point of the
      // check. The window's own implementation is the one that sees the
      // stylesheet React imported alongside the component.
      const style = mounted.window.getComputedStyle.bind(mounted.window);

      let previousRank = -1;
      for (const control of focusables) {
        // Climb to the child of main that owns this control, then read that
        // child's paint rank. Two controls inside one block share a rank, and
        // the sweep below checks their order within the block separately.
        let owner: Element = control;
        while (owner.parentElement && owner.parentElement.tagName !== "MAIN") owner = owner.parentElement;
        const rank = paintedRank.get(indexOfChild.get(owner)!)!;
        assert.ok(rank >= previousRank,
          `paint order disagrees with tab order in ${mode} mode: ${describe(control)} paints at rank ${rank} after rank ${previousRank}`);
        previousRank = rank;
        // A second, computed-style guard on the same property. jsdom reports an
        // unset `order` as "" and an explicit one as its number, so "no order
        // was set" is exactly `order === ""` — and a stylesheet that
        // reintroduced one is caught here even if the scan above were removed.
        const computedOrder = style(owner as HTMLElement).order;
        assert.ok(computedOrder === "" || Number(computedOrder) === 0,
          `${describe(owner)} has a computed CSS order of "${computedOrder}" in ${mode} mode, so its paint position can diverge from its tab position`);
      }

      // Within one painted block the controls keep their own source order.
      // `order` equal for all of them, so compare document positions directly.
      const byPosition = focusables.map(control => ({
        control, position: [...main.querySelectorAll("*")].indexOf(control),
      }));
      for (const [index, entry] of byPosition.entries()) {
        assert.ok(entry.position > -1, `every control must be reachable in the main tree: ${describe(entry.control)}`);
        if (index === 0) continue;
        const previous = byPosition[index - 1]!;
        // Only compare two controls that share a painted block; across blocks
        // the rank comparison above already decided the order.
        const sameOwner = (() => { let a: Element = entry.control, b: Element = previous.control;
          while (a.parentElement && a.parentElement.tagName !== "MAIN") a = a.parentElement;
          while (b.parentElement && b.parentElement.tagName !== "MAIN") b = b.parentElement;
          return a === b; })();
        if (sameOwner) assert.ok(entry.position > previous.position,
          `within one block ${describe(entry.control)} comes after ${describe(previous.control)} in the DOM but is painted first`);
      }
    } finally { await mounted.restore(); }
  });

  test(`Home in ${mode} mode puts needs-attention ahead of the other panels`, async () => {
    const mounted = await mountHome(mode);
    try {
      const children = mainChildren(mounted.document);
      const dashboard = children.findIndex(child => child.className.includes("private-dashboard-grid"));
      assert.ok(dashboard > -1, `the dashboard must be a child of main in ${mode} mode`);
      // Everything before the dashboard is the workspace heading and the
      // dashboard's own "New task" action — no panel of setup text, which is
      // what pushed attention below the fold in hosted mode.
      assert.ok(children.slice(0, dashboard).every(child => !/private-panel/.test(child.className)),
        `only the heading and the action link may precede the dashboard in ${mode} mode, found: ` +
        `${JSON.stringify(children.slice(0, dashboard).map(child => child.className))}`);

      const attention = mounted.document.querySelector("main .private-dashboard-grid .private-panel[aria-labelledby='home-attention']");
      assert.ok(attention, "the dashboard must carry a Needs attention panel");
      const panels = [...mounted.document.querySelectorAll("main .private-dashboard-grid .private-panel")];
      // Deliberately NOT asserting that Needs attention precedes Running work.
      // The dashboard has always led with Running work, inside a two-column
      // grid that stacks at phone width, and both panels are inside the first
      // block of `main`. Which of the two an owner reads first is not a promise
      // this app makes; what it must promise is that the whole dashboard is
      // reachable without scrolling past another page's worth of text, which is
      // what the `main` children assertions above establish. Asserting the
      // panel order here would be inventing a requirement, and a future panel
      // reordering would then "fail" for no owner-visible reason.
      assert.ok(panels.length >= 4,
        `the dashboard must carry its full panel set, got ${panels.length}`);
      assert.ok(panels.indexOf(attention as Element) > -1);

      // The framing copy and its button are last, so the copy is reached last
      // by keyboard and announced last by a screen reader.
      const lead = children.findIndex(child => child.className.includes("private-home-lead"));
      assert.equal(lead, children.length - 1,
        `the framing copy must be the last child of main in ${mode} mode, found at ${lead} of ${children.length}`);
      const leadButton = mounted.document.querySelector("main .private-home-lead button");
      assert.ok(leadButton, "the lead block keeps its re-check button");
      const leadOwnerIndex = indexOfOwner(children, leadButton as Element);
      assert.equal(leadOwnerIndex, children.length - 1,
        `the re-check button must paint with the last block, found at ${leadOwnerIndex}`);
    } finally { await mounted.restore(); }
  });
}

/** The index in `main`'s children of the block that contains `element`. */
function indexOfOwner(children: readonly { element: Element }[], element: Element): number {
  let owner: Element = element;
  while (owner.parentElement && owner.parentElement.tagName !== "MAIN") owner = owner.parentElement;
  return children.findIndex(child => child.element === owner);
}
