import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { StateChip, chipToneForStateV1, stateLabelV1, EmptyState, UnavailableState, LoadingState, PanelHeading,
  workerChipToneV1 } from "../private-app/app/owner-ui";

const privateStylesheet = readFileSync(fileURLToPath(new URL("../private-app/app/private.css", import.meta.url)), "utf8");
const stylesheet = readFileSync(fileURLToPath(new URL("../styles/control-room.css", import.meta.url)), "utf8");

function documentFor(html: string): Document {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
}

test("an unrecognised state is neutral, never guessed into a healthy tone", () => {
  // A new backend state must not be able to render as green "good" by omission.
  assert.equal(chipToneForStateV1("a_state_this_build_has_never_heard_of"), "neutral");
  assert.equal(chipToneForStateV1(""), "neutral");
  // The strings the real records actually carry.
  assert.equal(chipToneForStateV1("succeeded"), "good");
  assert.equal(chipToneForStateV1("failed"), "bad");
  assert.equal(chipToneForStateV1("pending"), "warn");
});

test("a chip keeps the state text the page copy already rendered", () => {
  // The Playwright owner journey asserts on the text form of these states, so a
  // chip must not reword them. This pins that contract.
  assert.equal(stateLabelV1("changes_requested"), "changes requested");
  assert.equal(stateLabelV1("proposed"), "proposed");
  assert.equal(stateLabelV1("pending"), "pending");
  const document = documentFor(renderToStaticMarkup(createElement(StateChip, { state: "changes_requested" })));
  assert.match(document.body.textContent ?? "", /changes requested/);
  assert.ok(document.querySelector(".private-chip.is-warn"), "a changes-requested result is a warning tone");
});

test("a `ready` worker is not painted healthy, because its own row says it is not proven", () => {
  // Found by looking at the rendered dark-mode Home page: the worker row read
  // "Ready · readiness not proven" with a green dot beside it, so the colour
  // contradicted the sentence on the same row. A worker's `ready` means its
  // pinned executable passed startup checks — a fact about a route, not proof
  // that anything is healthy.
  assert.equal(workerChipToneV1({ state: "ready" }), "neutral");
  assert.equal(workerChipToneV1({ state: "unavailable" }), "bad");
  // And `ready` must not be a healthy tone for any other caller either.
  assert.equal(chipToneForStateV1("ready"), "neutral",
    "a bare `ready` is ambiguous across surfaces, so it is never painted healthy");
  // A genuinely healthy task state still is.
  assert.equal(chipToneForStateV1("succeeded"), "good");
});

test("the three read outcomes render as three different things", () => {
  // This is the regression the design system exists to prevent: the page copy
  // already refused to call an empty read an all-clear, but the two looked the
  // same, so a glance could not tell a checked nothing from an unchecked
  // anything. The distinct class names are what make them distinguishable.
  const empty = documentFor(renderToStaticMarkup(createElement(EmptyState, {})));
  const unavailable = documentFor(renderToStaticMarkup(createElement(UnavailableState, {})));
  const loading = documentFor(renderToStaticMarkup(createElement(LoadingState, {})));

  assert.ok(empty.querySelector(".private-state-empty"), "empty has its own class");
  assert.ok(unavailable.querySelector(".private-state-unavailable"), "unavailable has its own class");
  assert.ok(loading.querySelector(".private-state-loading"), "loading has its own class");
  const classes = [".private-state-empty", ".private-state-unavailable", ".private-state-loading"];
  assert.equal(new Set(classes).size, 3, "the three states must not share a class");
  // And all three are actually styled, not just named.
  for (const selector of classes) {
    assert.ok(privateStylesheet.includes(`${selector} {`) || privateStylesheet.includes(`${selector},`),
      `${selector} must be declared in private.css`);
  }
});

test("no read state invents a count, a zero or a dash", () => {
  // The app deliberately does not infer a zero it did not read. A chip or a
  // state that rendered "0" would be exactly that inference, made visually.
  for (const node of [createElement(EmptyState, {}), createElement(UnavailableState, {}),
    createElement(LoadingState, {}), createElement(StateChip, { state: "proposed" })]) {
    const text = renderToStaticMarkup(node).replace(/<[^>]*>/g, "");
    assert.doesNotMatch(text, /(^|\s)0(\s|$)|—|–/, `no placeholder number: ${text}`);
  }
});

test("an unavailable state is announced, and an empty one is not", () => {
  // "Could not read" is new information when a region updates; "nothing found"
  // is not, and announcing it every refresh would be noise.
  assert.equal(documentFor(renderToStaticMarkup(createElement(UnavailableState, {})))
    .querySelector('[role="status"]') !== null, true);
  assert.equal(documentFor(renderToStaticMarkup(createElement(EmptyState, {})))
    .querySelector('[role="status"]'), null);
  assert.equal(documentFor(renderToStaticMarkup(createElement(LoadingState, {})))
    .querySelector('[role="status"]') !== null, true);
});

test("an urgent unavailable state keeps role=alert, and adopting the component never downgrades one", () => {
  // Both call sites this replaced already announced with role="alert"
  // (ProjectCatalog's unavailable branch, and Needs attention's read failure).
  // Routing them through a shared component that always used role="status" would
  // have silently made a failed read quieter — a behaviour change dressed as a
  // refactor. `urgent` restores the alert explicitly, and this pins both.
  const urgent = documentFor(renderToStaticMarkup(createElement(UnavailableState, { urgent: true })));
  assert.ok(urgent.querySelector('[role="alert"]'), "an urgent unavailable state must still alert");
  assert.equal(urgent.querySelector('[role="status"]'), null, "it must not be both");
  assert.match(urgent.body.textContent ?? "", /could not be read/i, "the text is unchanged");
});

test("a live region never wraps a control", () => {
  // Same rule the existing accessibility suite enforces elsewhere.
  for (const node of [createElement(UnavailableState, {}), createElement(LoadingState, {}),
    createElement(EmptyState, {})]) {
    const document = documentFor(renderToStaticMarkup(node));
    for (const region of document.querySelectorAll('[role="status"], [role="alert"]')) {
      assert.equal(region.querySelectorAll("button, a[href], input, select, textarea, summary").length, 0,
        "a read-state message must not contain a control");
    }
  }
});

test("a panel count renders only when a real number was supplied", () => {
  // There is deliberately no default of 0: showing "0" on a panel that was
  // never read would be a claim the client did not make.
  const withCount = documentFor(renderToStaticMarkup(createElement(PanelHeading, { id: "h", children: "Tasks", count: 3 })));
  assert.equal(withCount.querySelector(".private-count")?.textContent, "3");
  const without = documentFor(renderToStaticMarkup(createElement(PanelHeading, { id: "h", children: "Tasks" })));
  assert.equal(without.querySelector(".private-count"), null, "no count is invented when none was read");
});

test("the chip dot is decorative and never the only carrier of meaning", () => {
  // The dot is a ::before pseudo-element, so it is not in the accessibility tree
  // at all; the label beside it is the content. This asserts the label survives.
  const document = documentFor(renderToStaticMarkup(createElement(StateChip, { state: "failed" })));
  assert.match(document.body.textContent ?? "", /failed/);
  assert.equal(document.querySelectorAll("[aria-hidden]").length, 0,
    "the dot is a pseudo-element, so it needs no aria-hidden in the markup");
});

test("the shared vocabulary does not suppress focus or add an outline kill", () => {
  // The existing suite forbids `outline: none|0` in both stylesheets; keep the
  // new block honest against the same rule.
  assert.doesNotMatch(privateStylesheet, /outline:\s*(none|0)\b/);
  assert.doesNotMatch(stylesheet, /outline:\s*(none|0)\b/);
});

test("the loading spinner is suppressed when the owner asked for less motion", () => {
  // A looping animation with no reduced-motion escape is a real accessibility
  // regression, so the animation is scoped to the no-preference case.
  assert.match(privateStylesheet, /@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*?private-state-loading::before\s*\{\s*animation/);
  assert.ok(privateStylesheet.includes("@media (prefers-reduced-motion: reduce)"),
    "a reduced-motion rule must still exist");
});

test("the task state chip keeps the hook the owner journey selects on", () => {
  // The journey reads `.private-task-detail .private-state` and expects the task's
  // own state label there ("Completed · Accepted"). When the task heading became a
  // chip, the route-observation panel also matched that selector — and its prose
  // ("Control Room has a saved ... route observation, but it is not current task
  // activity.") is what the journey then read, so it timed out.
  //
  // Two halves to this: the chip carries .private-state, and prose about a state
  // carries its own class. Neither half is enough on its own, which is why the
  // journey broke before either was fixed.
  const html = renderToStaticMarkup(createElement(StateChip, { state: "succeeded", label: "Completed · Accepted" }));
  assert.match(html, /class="private-state private-chip is-good"/,
    "the chip must still match .private-state for the journey's selector");
  assert.match(html, /Completed · Accepted/);
});

test("a chip next to a sibling string leaves the element's matched text unchanged", () => {
  // The owner journey asserts `page.getByText(/^paused ·/)` and `/^archived ·/`
  // against the project heading, whose text is the lifecycle, a middle dot and
  // the project origin. Wrapping the whole span in a chip would have moved the
  // " · Ordinary project" suffix out of the match and broken the journey, so the
  // chip wraps only the lifecycle word. This renders the exact shape to prove it.
  //
  // The chip's ::before dot is a pseudo-element, so it is not in textContent —
  // that is what makes the substitution safe rather than merely lucky.
  const html = renderToStaticMarkup(createElement("span", { className: "private-state" },
    createElement(StateChip, { state: "paused" }), " · ", "Ordinary project"));
  const text = html.replace(/<[^>]*>/g, "");
  assert.equal(text, "paused · Ordinary project",
    "the heading's text must stay byte-identical, because the journey matches on it");
  assert.match(text, /^paused ·/);
  // And the chip contributed no stray characters of its own.
  assert.equal(html.includes("::before"), false, "the dot is a pseudo-element, not markup");
});

test("dark mode is reachable from the OS preference and stays overridable", () => {
  // The dark palette was already declared and contrast-checked but nothing ever
  // set data-theme, so it was dead CSS. These pin the two ways it now applies.
  assert.match(stylesheet, /@media \(prefers-color-scheme: dark\)/,
    "the dark tokens must apply under the OS preference");
  assert.match(stylesheet, /:root:not\(\[data-theme="light"\]\)/,
    "an explicit light choice must beat the OS preference");
  // The block the existing contrast test reads must survive untouched.
  assert.ok(stylesheet.includes(':root[data-theme="dark"] {'),
    "tests/mac-local-accessibility.test.tsx reads this exact selector");
});
