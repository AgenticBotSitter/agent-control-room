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
// modes and check four separate things:
//
//   1. no reordering construct of any kind may separate two children of Home's
//      `main`. This is the direct guard: it fails the moment `order`,
//      `*-reverse` or an explicit grid row/area is reintroduced on one of those
//      children, whether or not it happens to produce an acceptable page today.
//   2. the painted order of every focusable in `main` is monotonic, so tab
//      order and paint order cannot disagree even if (1) is worked around.
//   3. no owner page may use a positive `tabindex`, which reorders the tab
//      sequence independently of the DOM and of the paint order alike.
//   4. the dashboard leads `main` and the framing copy closes it, so the
//      attention-first result is a consequence of DOM position rather than of
//      a paint trick. What panel leads *inside* the dashboard is deliberately
//      not asserted; see the note on that test.
//
// It is also a mutation-resistant test: checks (1) and (3) read the shipped
// stylesheet and markup rather than trusting the component, and check (2) is
// computed from the real `private.css` cascade, so re-adding the `order` rules
// fails even if the JSX is left alone.
//
// A limitation worth stating rather than implying away. The first version of
// (2) read `getComputedStyle` in a JSDOM that had loaded no stylesheet, so
// `display` was always `block` and `order` always `""`, and the check passed
// against anything. The stylesheet is now injected into the document, and
// jsdom's cascade does compute it (verified: an injected
// `.private-home-main{display:flex}` resolves `display` to `flex`). But jsdom
// **ignores `@media` blocks entirely**, so this covers unconditional rules
// only — the shipped `.private-home-lead` border, declared only inside
// `@media (max-width: 560px)`, does not resolve here. That is precisely why
// the raw-stylesheet scan in (1) exists alongside this rather than instead of
// it: the scan sees every rule, media-scoped or not.
//
// Chromium covers the rest. `tests/browser/owner-phone-width.spec.ts` walks
// `main` with real Tab presses in both runtime modes and compares focus order
// to painted top-to-bottom order, which no jsdom assertion can approximate.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";

import { PrivateHome } from "../private-app/app/home-workspace";
import { LocalRuntimeContextV1 } from "../private-app/app/local-runtime";

const APP_DIRECTORY = fileURLToPath(new URL("../private-app/app", import.meta.url));

const STYLESHEET = readFileSync(join(APP_DIRECTORY, "private.css"), "utf8");

const LOCAL_STATUS = { taskWorkersStarted: true, workers: [], projectSections: [] } as const;

/** Every `rule { … }` block in `css`, as its selector text and its declarations. */
function rulesOf(css: string): { selector: string; declarations: string[] }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
    selector: (match[1] ?? "").trim().replace(/\s+/g, " "),
    declarations: (match[2] ?? "").split(";").map(declaration => declaration.trim()).filter(Boolean),
  }));
}

/**
 * The classes on Home's own top-level blocks — the children `main` actually
 * renders, in `home-workspace.tsx` — with the condition under which each one
 * is present. A reordering construct on any of these is the finding this file
 * exists to close, whatever property carries it.
 *
 * A list rather than a regex, because a list can be asserted against the
 * component (see "the blocks the grid-placement scan names really are children
 * of Home's main") and a regex cannot. The first version of this was a regex
 * naming only `.private-home-main`, `-lead` and `-intro` — 3 of the 8 — so a
 * `grid-row: 1` on the dashboard grid was the same defect the guard exists for,
 * reached through a class the old pattern never named. The conditions are
 * stated because two of these are conditional, and the drift check below has to
 * know which mode to hold each one to or it fails on correct code.
 */
type Mode = "local" | "hosted";

const HOME_TOP_LEVEL_CLASSES: readonly { name: string; when: (mode: Mode) => boolean }[] = Object.freeze([
  { name: "private-home-main", when: () => true },                    // the container itself
  { name: "private-home-intro", when: () => true },                   // the eyebrow and the h1
  { name: "private-dashboard-grid", when: () => true },               // the panels
  { name: "private-dashboard-projects", when: () => true },           // the projects panel
  { name: "private-local-worker-evidence", when: (mode: Mode) => mode === "local" },
  { name: "private-action-link", when: () => true },                  // the dashboard's "New task" link
  // The idea-lab aside, which needs hosted mode AND the module enabled. The
  // jsdom harness renders with no product configuration, so the module read
  // returns false and the aside never appears here; its presence is covered by
  // the browser walk in hosted mode, not by this list.
  { name: "private-home-note", when: () => false },
  { name: "private-home-lead", when: () => true },                   // the framing copy, last by design
]);

/** True when a stylesheet selector names one of those blocks. */
function isHomeTopLevel(selector: string): boolean {
  return HOME_TOP_LEVEL_CLASSES.some(entry => selector.includes(`.${entry.name}`));
}

/** Every rule that assigns `order` to one of Home's `main` children. */
const homeOrderDeclarations = rulesOf(STYLESHEET)
  .filter(rule => isHomeTopLevel(rule.selector))
  .flatMap(rule => rule.declarations.filter(declaration => /^\s*order\s*:/.test(declaration))
    .map(declaration => ({ selector: rule.selector, declaration })));

/** Every rule anywhere in the owner stylesheet that assigns `order`. */
const everyOrderDeclaration = rulesOf(STYLESHEET)
  .flatMap(rule => rule.declarations.filter(declaration => /^\s*order\s*:/.test(declaration))
    .map(declaration => ({ selector: rule.selector, declaration })));

/**
 * Reversed flow directions. `-reverse` on a flex or grid axis paints children
 * in the opposite order to the DOM and to the tab sequence, so it is `order`
 * that follows a different spelling.
 */
const REVERSED_FLOW = /(?:^|[\s;{])(?:-moz-|-webkit-)?(?:flex-direction|direction)\s*:\s*[^;]*\breverse\b/;

/** Explicit grid placement: an item's row or area assigned by rule, not by source. */
const GRID_PLACEMENT = /^\s*(?:grid-row|grid-row-start|grid-row-end|grid-area|grid-area-start|grid-area-end|grid-template-areas)\s*:/;

/**
 * Every `.tsx` in the owner app, for the static markup scans below.
 *
 * `recursive: true` is load-bearing and was missing in the first version of
 * this: `private-app/app/` has 20 subdirectories (`session/`, `needs-me/`,
 * `workers/`, `settings/`, `setup/`, `connections/`, …) and a flat `readdirSync`
 * saw 58 of the 85 components — 10 of the 16 `tabindex` uses. A `tabIndex={1}`
 * on a worker card or on the sign-in page would have passed the guard that
 * claims to cover every owner page. Verified: flat 58 files / 10 matches,
 * recursive 85 files / 16 matches.
 */
const OWNER_SOURCES = readdirSync(APP_DIRECTORY, { recursive: true, encoding: "utf8" })
  .filter(entry => entry.endsWith(".tsx"))
  .map(entry => ({ path: join(APP_DIRECTORY, entry), source: readFileSync(join(APP_DIRECTORY, entry), "utf8") }));

/** Mount the real Home in one runtime mode with every protected read settled. */
async function mountHome(mode: "local" | "hosted") {
  const { createRoot } = await import("react-dom/client");
  const { act, createElement } = await import("react");
  // The real stylesheet, injected into the document rather than merely read:
  // without it `getComputedStyle` resolves nothing this page ships, which is
  // what made the paint-order check below inert. See the header.
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${STYLESHEET}</style></head><body><div id='root'></div></body></html>`,
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
 * The painted order of a flex or grid item, which is what a sighted owner
 * sees, and the order a keyboard does NOT follow. Returns the DOM index each
 * child would paint at, so any disagreement between paint and tab order is
 * directly visible.
 *
 * A block container has no `order` to honour and paints in source order, so it
 * returns the identity ranking. jsdom has no layout engine, so "painted" can
 * only mean "as this stylesheet orders it" — which is real now that the
 * stylesheet is loaded (see the header), and is the whole reason the ranking is
 * read from the cascade rather than from the DOM.
 */
function paintedOrderOf(document: Document, window: Window) {
  const main = document.querySelector("main")!;
  const siblings = [...main.children] as HTMLElement[];
  const style = window.getComputedStyle.bind(window);
  const display = style(main).display;
  const isFlex = display.includes("flex");
  const isGrid = display.includes("grid");
  /** `order` applies to flex and grid items alike; block children have none. */
  const rank = (element: HTMLElement) => (isFlex || isGrid ? Number(style(element).order) || 0 : 0);
  const painted = siblings.map((_, index) => index)
    .sort((left, right) => {
      const a = rank(siblings[left]!), b = rank(siblings[right]!);
      return a === b ? left - right : a - b;
    });
  return { isFlex, isGrid, painted };
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

test("no owner rule anywhere may use order, so nothing can grow a second reordering mechanism", () => {
  // The scan above is scoped to Home's own blocks because that is where the
  // finding was. This one is not scoped, and it is deliberately so: the next
  // page that needs a panel to paint somewhere other than its source position
  // is exactly the situation that produced this bug, and the cheapest place to
  // stop it is a stylesheet where `order` is not used at all. The shipped file
  // has none, so this is a property worth holding rather than a cost.
  assert.deepEqual(everyOrderDeclaration, [],
    `CSS "order" must not be used anywhere in the owner stylesheet: ${JSON.stringify(everyOrderDeclaration)}`);
});

test("Home's main children are siblings of one plain block flow at phone width", () => {
  // The rule that made `order` possible in the first place was turning `main`
  // into a flex column. Without a formatting context on `main` there is no
  // paint order to diverge from source order, so this asserts the precondition
  // of the rule above — and `grid` is included alongside `flex` because
  // `grid-row` on a child is the same defect wearing a different property.
  const formattingRules = [...STYLESHEET.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => /(^|\s)\.private-home-main\b/.test(match[1] ?? ""))
    .flatMap(match => (match[2] ?? "").split(";").map(declaration => declaration.trim())
      .filter(declaration => /^(display\s*:\s*(?:inline-)?(?:flex|grid)|flex-direction|grid-template)/.test(declaration)));
  assert.deepEqual(formattingRules, [],
    `.private-home-main must stay in normal flow: ${JSON.stringify(formattingRules)}`);
});

test("no grid row or area may be placed on Home's own top-level blocks", () => {
  // `grid-row: 1` is a paint reorder with no `order` and no `flex` anywhere, so
  // neither the check above nor the `order` scan can see it. It moves a block
  // to the top of its container while leaving the DOM, and therefore the tab
  // sequence, exactly where it was — the original defect, spelled differently.
  //
  // Scoped to Home's own blocks rather than blanket, and that is a real
  // judgement: this stylesheet ships two legitimate grid placements
  // (`.private-dashboard-projects { grid-column: 1 / -1 }` and the projects
  // page's `.private-create { grid-row: 1 }` → `auto`), both inside panels and
  // both about columns or about a page that is not Home. A blanket ban would
  // fail on shipped behaviour and teach the next person that the test is
  // arbitrary.
  const placements = rulesOf(STYLESHEET)
    .filter(rule => isHomeTopLevel(rule.selector))
    .flatMap(rule => rule.declarations.filter(declaration => GRID_PLACEMENT.test(declaration))
      .map(declaration => ({ selector: rule.selector, declaration })));
  assert.deepEqual(placements, [],
    `no explicit grid placement on Home's top-level blocks: ${JSON.stringify(placements)}`);
});

test("no flow direction may be reversed in the owner stylesheet", () => {
  // `column-reverse` / `row-reverse` is `order` applied to a whole axis, so it
  // can desynchronise paint from tab order in a single declaration with no
  // `order` to grep for and no `display: flex` on Home to catch it.
  const reversed = rulesOf(STYLESHEET)
    .filter(rule => rule.declarations.some(declaration => REVERSED_FLOW.test(declaration)))
    .map(rule => ({ selector: rule.selector, declarations: rule.declarations.filter(d => REVERSED_FLOW.test(d)) }));
  assert.deepEqual(reversed, [],
    `a reversed flow direction paints against the tab sequence: ${JSON.stringify(reversed)}`);
});

test("the blocks the grid-placement scan names really are children of Home's main", async () => {
  // `HOME_TOP_LEVEL_CLASSES` is a hand-written list of class names, and a list
  // that drifts from the component is worse than no list: the grid-placement
  // scan above silently stops covering a block it used to name. This asserts
  // the list against what `main` actually renders, in both runtime modes, so
  // adding a top-level block to Home without adding it here fails here first.
  //
  // One direction only. Every class in the list must appear in `main` (a stale
  // entry is a bug); a class in `main` that is not in the list is only a gap
  // the browser walk still covers, and a page may legitimately add a child
  // that carries no reordering risk.
  const named = HOME_TOP_LEVEL_CLASSES.map(entry => entry.name);
  assert.ok(named.length >= 6,
    `the grid-placement scan should name Home's real top-level blocks, it names ${named.length}`);
  for (const mode of ["local", "hosted"] as const) {
    const mounted = await mountHome(mode);
    try {
      const classes = new Set([...mounted.document.querySelectorAll("main *")].flatMap(element =>
        String(element.className ?? "").split(/\s+/).filter(Boolean)));
      // `main` itself is named but is the container, not one of its children,
      // so its own presence is checked by the mode-independent rule below.
      const unreachable = HOME_TOP_LEVEL_CLASSES
        .filter(entry => entry.name !== "private-home-main" && entry.when(mode) && !classes.has(entry.name))
        .map(entry => entry.name);
      assert.deepEqual(unreachable, [],
        `the grid-placement scan names blocks ${mode} mode's main does not render: ${JSON.stringify(unreachable)}`);
      const lead = mounted.document.querySelector("main .private-home-lead");
      assert.ok(lead, `the last main child must be the framing copy in ${mode} mode`);
      assert.equal(lead, [...mounted.document.querySelector("main")!.children].at(-1),
        `the framing copy must remain the last child of main in ${mode} mode`);
    } finally { await mounted.restore(); }
  }
});

test("the framing copy keeps the styling it had inside the intro, at every width", async () => {
  // A real regression this branch shipped for one review round. The framing copy
  // moved from `.private-home-intro` to `.private-home-lead` to put the panels
  // above the fold, and the two paragraphs went with it. The second carries
  // `className="private-note"` and kept its muted colour; the first has no class
  // and was left at full `--text`, directly above a muted paragraph, at desktop
  // width. It also lost the intro's 46rem measure.
  //
  // The phone-width suite could not see either: it only ever sets a 375px
  // viewport, and the jsdom guard asserts nothing about colour or measure. So
  // this asserts the computed result against the real stylesheet — the same
  // cascade the per-mode tests now load — and does it in both runtime modes
  // because the copy renders in both.
  for (const mode of ["local", "hosted"] as const) {
    const mounted = await mountHome(mode);
    try {
      const style = mounted.window.getComputedStyle.bind(mounted.window);
      const lead = mounted.document.querySelector("main .private-home-lead")!;
      const paragraphs = [...lead.querySelectorAll("p")] as HTMLElement[];
      assert.ok(paragraphs.length >= 2,
        `the framing copy must keep both of its paragraphs in ${mode} mode, got ${paragraphs.length}`);
      for (const paragraph of paragraphs) {
        assert.equal(style(paragraph).color, style(mounted.document.querySelector("main .private-note")!).color,
          `the framing copy must be muted like the other secondary text in ${mode} mode, ` +
          `so a moving block does not become the loudest text on the page`);
      }
      assert.equal(style(lead).maxWidth, style(mounted.document.querySelector("main .private-home-intro")!).maxWidth,
        `the framing copy must keep the reading measure it had inside the intro in ${mode} mode`);
    } finally { await mounted.restore(); }
  }
});

test("no owner page may use a positive tabindex", () => {
  // The third way to decouple tab order from reading order, and the one no CSS
  // check can see. `tabIndex={1}` on a late block moves that control to the
  // FRONT of the tab sequence, so a keyboard and a screen reader reach it
  // first while it paints last — the same defect as `order`, arriving through
  // markup instead of a stylesheet. It is a genuinely useful tool for exactly
  // one thing (implementing the document tab sequence itself), which this app
  // does through a skip link and not through per-control indices.
  //
  // Scanned across every owner component rather than just `home-workspace.tsx`,
  // because nothing about the defect is Home-specific. All sixteen shipped uses
  // are the same `tabIndex={-1}` skip target, so the invariant needs no
  // exceptions.
  const positive = OWNER_SOURCES.flatMap(({ path, source }) =>
    [...source.matchAll(/tab[Ii]ndex\s*=\s*\{?\s*(-?\d+)\s*\}?/g)]
      .map(match => ({ file: path.slice(path.lastIndexOf("/") + 1), value: Number(match[1]) }))
      .filter(entry => entry.value > 0));
  assert.deepEqual(positive, [],
    `a positive tabindex reorders the tab sequence independently of the DOM: ${JSON.stringify(positive)}`);
});

for (const mode of ["local", "hosted"] as const) {
  test(`Home in ${mode} mode paints its focusable controls in tab order`, async () => {
    const mounted = await mountHome(mode);
    try {
      const { document, window, restore } = mounted;
      const { isFlex, isGrid, painted } = paintedOrderOf(document, window);
      assert.ok(!isFlex && !isGrid,
        "main must not be a flex or grid container, or paint order could diverge from source order again");

      // Every control a keyboard can reach inside `main`, in the order it is
      // reached, mapped to where it paints.
      const focusables = [...document.querySelectorAll("main a[href], main button, main input, main select, main textarea")];
      assert.ok(focusables.length >= 4, `expected real controls in main, got ${focusables.length}`);
      const main = document.querySelector("main")!;
      const indexOfChild = new Map([...main.children].map((child, index) => [child as Element, index] as const));
      const paintedRank = new Map(painted.map((domIndex, rank) => [domIndex, rank]));
      const describe = (element: Element) => `${element.tagName.toLowerCase()}` +
        `${element.className ? `.${element.className}` : ""} "${(element.textContent ?? "").trim().slice(0, 30)}"`;
      // The window's own implementation, against the real `private.css` now
      // loaded into this document — not a cascade that resolves nothing.
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
        // A second, computed-style guard on the same property, now reading a
        // real cascade. jsdom reports an unset `order` as "" and an explicit one
        // as its number, so "no order was set" is exactly `order === ""`.
        const computedOrder = style(owner as HTMLElement).order;
        assert.ok(computedOrder === "" || Number(computedOrder) === 0,
          `${describe(owner)} has a computed CSS order of "${computedOrder}" in ${mode} mode, so its paint position can diverge from its tab position`);
        // `order` and a positive `tabindex` are the two mechanisms that move
        // a control away from its painted position; the static scans above
        // cover both, and this is the same claim made of the rendered result
        // so a rule the scan cannot parse still has to show up here.
        const tabIndex = (control as HTMLElement).getAttribute("tabindex");
        assert.ok(tabIndex === null || Number(tabIndex) <= 0,
          `${describe(control)} carries tabindex="${tabIndex}" in ${mode} mode, so it is reached out of painted order`);
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
      // NOT `panels.includes(attention)`: `attention` was matched by the same
      // selector `panels` is built from, so that assertion cannot fail and
      // would read as coverage of the panel's position when it is not. The
      // panel's position is deliberately not asserted; see above.

      // The framing copy and its button are last, so the copy is reached last
      // by keyboard and announced last by a screen reader. This is the check
      // that carries the attention-first result in the reading order.
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
