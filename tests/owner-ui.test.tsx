import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { StateChip, chipToneForStateV1, stateLabelV1, stateToneKeysV1, EmptyState, UnavailableState, LoadingState,
  PanelHeading, PrivateCount, workerChipToneV1 } from "../private-app/app/owner-ui";
import { HomeDashboard, type HomeDashboardState } from "../private-app/app/home-workspace";
import { PrivateNeedsMe } from "../private-app/app/needs-me/workspace";
import { LocalRuntimeContextV1 } from "../private-app/app/local-runtime";
import { artifactStates, approvalStates, attemptStates, checkpointStates, effectIntentStates, jobStates, leaseStates,
  nodeStates, requestStates, serviceStates } from "../src/domain/v1/types";
import { harnessRunStates } from "../src/harness/v1/types";
import { effectClaimStates } from "../src/node-policy/v1/effect-claim";
import { lifecycleSchema } from "../src/web/v1/project-wire";
import { nativeRunStateValues } from "../src/web/v1/task-wire";
import { taskReviewEvidenceSchema } from "../src/web/v1/task-result-wire";

/** The project lifecycle values the wire schema accepts, read from the schema
 * itself rather than copied, so this test cannot drift from the contract. */
const lifecycleSchemaValues = lifecycleSchema.options;

/** The states a saved review target can be in, read off the exported evidence
 * schema's shape rather than copied, so a new status cannot slip past this test. */
const reviewTargetStatusValues = taskReviewEvidenceSchema.shape.status.options;

/** The decisions a saved review can record, and the outcomes a saved verification
 * can record, read off the same schema's element shapes. */
const reviewDecisionValues = taskReviewEvidenceSchema.shape.reviews.element.def.shape.decision.options;
const verificationOutcomeValues = taskReviewEvidenceSchema.shape.verifications.element.def.shape.outcome.options;

/** The three read outcomes the shared vocabulary renders itself, plus the states
 * its own pages pass a chip (a local worker route, an attention reason, a Hermes
 * delivery recovery status). */
const readOutcomeValues = ["loading", "ready", "unavailable", "not_configured",
  "no_authenticated_delivery", "delivery_receipt_unresolved", "terminal_result_staged",
  // Connection signal freshness, which the connection centre renders as a chip.
  "current", "stale", "missing"] as const;

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

test("a real call site's count renders as a chip beside the heading, not inside it", () => {
  // The `count` prop had zero production call sites: every real one passed a
  // <PrivateCount> as a child, because the number is usually conditional on the
  // read having succeeded. That child landed INSIDE the <h2>, where it inherited
  // the heading's font size and stacked inline after the heading text, so the
  // panel rendered "Running work3" instead of a heading plus a count chip. The
  // old test only covered the prop, which is the path no page takes.
  //
  // So render the actual call site's shape: the heading text and the count as a
  // child, exactly as HomeDashboard and ProjectCatalog write it.
  const asThePagesCallIt = documentFor(renderToStaticMarkup(createElement(PanelHeading, { id: "home-active" },
    "Running work", createElement(PrivateCount, { value: 3 }))));

  const count = asThePagesCallIt.querySelector(".private-count");
  assert.ok(count, "the count must render");
  assert.equal(count!.textContent, "3", "the real number is shown, not a placeholder");
  assert.equal(count!.closest("h2"), null,
    "the count must not be a child of the heading, or it inherits the h2's font size");
  // It is a sibling inside the flex row the chip styling is designed for.
  assert.equal(count!.parentElement?.className, "private-panel-heading");
  assert.equal(count!.previousElementSibling?.tagName, "H2");
  // And the heading's own text is unchanged, which is what the journey matches on.
  const heading = asThePagesCallIt.querySelector("h2")!;
  assert.equal(heading.textContent, "Running work", "the heading must not absorb the count");
  // The chip is not glued on: the pill is a flex sibling, so the stylesheet's
  // space-between row applies and the count sits at the far end.
  assert.match(privateStylesheet, /\.private-panel-heading\s*\{[^}]*display:\s*flex/);
  assert.match(privateStylesheet, /\.private-count\s*\{[^}]*flex:\s*none/);
});

test("a count chip is dropped, not rendered, when the read was not successful", () => {
  // The pages render `{state === "ready" ? <PrivateCount .../> : null}`. A null
  // child must leave the heading as plain text rather than as an empty pill, so
  // an unread panel still does not show a count.
  const notRead = documentFor(renderToStaticMarkup(createElement(PanelHeading, { id: "home-active" },
    "Running work", null)));
  assert.equal(notRead.querySelector(".private-count"), null, "no pill at all for a panel that was not read");
  assert.equal(notRead.querySelector("h2")!.textContent, "Running work");
});

test("every adverse state reads as adverse, never as the neutral default", () => {
  // The mapping used to leave 11 real states unmapped, including the two that
  // matter most for honesty: `interrupted` (the agent was cut off) and
  // `ambiguous` (the outcome could not be established). Both fell through to the
  // neutral grey, painting an adverse outcome as ordinary — the same class of
  // defect as the green `ready` dot this file's sibling test pins.
  for (const state of ["interrupted", "ambiguous", "orphaned", "disconnected",
    "blocked", "failed", "rejected", "unavailable", "offline", "stale", "denied"]) {
    assert.equal(chipToneForStateV1(state), "bad",
      `${state} is an adverse outcome and must not render neutral`);
  }
  // The states that used to be unmapped and are genuinely progress, not trouble.
  for (const [state, tone] of [["prepared", "busy"], ["dispatching", "busy"], ["stopping", "busy"],
    ["waiting", "warn"], ["waiting_approval", "warn"], ["offered", "busy"], ["leased", "busy"]] as const) {
    assert.equal(chipToneForStateV1(state), tone, `${state} is a real record state and needs a real tone`);
  }
  // And the neutral default still holds for a state nobody has heard of.
  assert.equal(chipToneForStateV1("a_state_this_build_has_never_heard_of"), "neutral");
});

test("stateTones covers every real record state and invents none", () => {
  // The map used to be 25 keys of which 19 corresponded to no record state at
  // all, so it read as a considered mapping of the domain and was not one. This
  // checks both directions against the enums the records actually carry: a real
  // state must be mapped to something other than the neutral fall-through, and a
  // key that no record can carry is a guess that will rot.
  const enums = [
    ...jobStates, ...attemptStates, ...leaseStates, ...harnessRunStates,
    ...nativeRunStateValues, ...lifecycleSchemaValues, ...requestStates,
    ...reviewTargetStatusValues,
  ];
  const mapped = new Set(stateToneKeysV1());
  // `ready` is a real jobStates value and is deliberately NOT in the map: a bare
  // `ready` is ambiguous across surfaces, so it is never painted healthy, and a
  // worker row takes its tone from the caller instead (see
  // "a `ready` worker is not painted healthy" above). It is a considered
  // exemption, not an unmapped gap, so it is excluded from this direction.
  const DELIBERATELY_UNMAPPED = new Set(["ready"]);
  mapped.delete("ready");

  const unmappedRealStates = [...new Set(enums)]
    .filter(state => !mapped.has(state) && !DELIBERATELY_UNMAPPED.has(state));
  assert.deepEqual(unmappedRealStates, [],
    `real record states with no tone, so they render neutral: ${unmappedRealStates.join(", ")}`);

  // Every key must be a value some record can carry. The reachable set is the
  // union of the state enums the owner-facing pages actually render a chip for:
  // the domain lifecycle states, the harness/native run states, the review
  // decision and verification outcomes, the effect-intent and claim outcomes,
  // the approval, service, node and artifact states, and the three read outcomes
  // the shared vocabulary renders itself.
  const reachable = new Set<string>([
    ...enums, ...nativeRunStateValues,
    ...artifactStates, ...approvalStates, ...serviceStates, ...nodeStates,
    ...effectIntentStates, ...effectClaimStates, ...checkpointStates,
    ...reviewDecisionValues, ...verificationOutcomeValues, ...readOutcomeValues,
  ]);
  const invented = stateToneKeysV1().filter(key => !reachable.has(key));
  assert.deepEqual(invented, [],
    `stateTones keys no record can carry: ${invented.join(", ")}`);
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

test("no rendered chip label reintroduces the framing the adversarial test forbids", () => {
  // tests/browser/adversarial-owner.spec.ts asserts the dashboard does NOT say
  // "readiness not proven". An earlier version of the Home worker list built its
  // chip label as `${state} · readiness ${proof}`, which for proof="not_proven"
  // renders exactly that string and failed CI.
  //
  // A chip shows the raw state and nothing else. It must not restate the
  // sentence beside it, because that sentence is where the proof lives and
  // restating it is how the forbidden phrasing got in.
  for (const state of ["ready", "unavailable", "stopped"]) {
    const html = renderToStaticMarkup(createElement(StateChip,
      { state, tone: workerChipToneV1({ state }) }));
    const text = html.replace(/<[^>]*>/g, "");
    assert.doesNotMatch(text, /readiness/i, `state=${state} must not mention readiness`);
    assert.doesNotMatch(text, /proof/i, `state=${state} must not mention proof`);
    assert.equal(text, state, "a worker chip shows the raw state and only the raw state");
  }
  // The neutral tone is what keeps a `ready` worker from reading as healthy,
  // which is the thing the surrounding prose exists to qualify.
  const ready = renderToStaticMarkup(createElement(StateChip,
    { state: "ready", tone: workerChipToneV1({ state: "ready" }) }));
  assert.match(ready, /class="private-state private-chip"/, "ready must not be tinted good");
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

/* ------------------------------------------------------------------ *
 * The REAL call sites, not the shared component.
 *
 * The three tests above render `UnavailableState`/`LoadingState` directly. That
 * proves the component honours its own `urgent` prop, and nothing more: a page
 * that passes the wrong prop, or renders its failure as a bare <p role="alert">
 * and never touches the component at all, still passes. These render the actual
 * pages instead, mounted, so the assertion is about the role a browser ends up
 * with on Home and on Needs attention.
 * ------------------------------------------------------------------ */

/** Every `[role]` a page announced, with the text it announced, so an assertion
 * can name a region and not just count one. Takes a Document or a JSDOM. */
function liveRegions(source: Document | JSDOM) {
  const document = "window" in source ? source.window.document : source;
  return [...document.querySelectorAll('[role="status"], [role="alert"]')].map(region => ({
    role: region.getAttribute("role"),
    text: (region.textContent ?? "").replace(/\s+/g, " ").trim(),
  }));
}

const allLoading: HomeDashboardState = { projects: { state: "loading" }, activity: { state: "loading" },
  attention: { state: "loading" }, connections: { state: "loading" } };
const allUnavailable: HomeDashboardState = { projects: { state: "unavailable" }, activity: { state: "unavailable" },
  attention: { state: "unavailable" }, connections: { state: "unavailable" } };

test("the real Home panels announce loading politely and a failed read as its own thing", () => {
  // Home renders the shared vocabulary, but it wraps `UnavailableState` in its
  // own `Unavailable`, and it is `UnavailableState` (role="status") rather than
  // role="alert" it uses — one unread section beside three healthy ones. These
  // are the two states the dashboard can actually be in, rendered as Home
  // renders them.
  const loading = documentFor(renderToStaticMarkup(createElement(HomeDashboard, { data: allLoading })));
  const loadingRegions = liveRegions(loading);
  // Seven panels since "Update ready" joined the dashboard. It owns a
  // separate protected read, while "Stuck, blocked or offline" shares the
  // `connections` state with "Worker status".
  assert.equal(loadingRegions.length, 7,
    `every one of the seven Home panels is loading and each announces: ${JSON.stringify(loadingRegions)}`);
  for (const region of loadingRegions) {
    assert.equal(region.role, "status", "a load in progress is new but not urgent");
    assert.ok(region.text.length > 0, "a status region with no text announces nothing");
  }
  assert.match(loading.body.textContent ?? "", /Loading saved work…/);
  assert.equal(loading.querySelector('[role="alert"]'), null,
    "nothing on Home has failed yet, so nothing may interrupt the owner");

  const failed = documentFor(renderToStaticMarkup(createElement(HomeDashboard, { data: allUnavailable })));
  const failedRegions = liveRegions(failed);
  assert.equal(failedRegions.length, 7, `each dashboard panel announces once: ${JSON.stringify(failedRegions)}`);
  const candidateRead = failedRegions.find(region => /Checking signed-off update candidates/.test(region.text));
  assert.equal(candidateRead?.role, "status",
    "the independently loaded update-candidate read remains an honest loading status during static rendering");
  for (const region of failedRegions.filter(region => region !== candidateRead)) {
    assert.equal(region.role, "status", "one unread section is a polite report, not an interruption");
    // Each carries its OWN sentence, so an owner can tell which read failed and
    // that no all-clear was invented for it.
    assert.match(region.text, /unavailable\.? No zero count or all-clear is inferred\./i,
      `the unavailable treatment must name the failure and refuse an all-clear: ${region.text}`);
  }
  const unavailable = failed.querySelectorAll(".private-state-unavailable");
  assert.equal(unavailable.length, 6, "a failed read is visibly distinct from an empty one");
  // The six different sentences, so a glance can tell which panel failed.
  const texts = new Set([...unavailable].map(node => (node.textContent ?? "").split(" No zero")[0]));
  assert.deepEqual([...texts].sort(), ["Attention items are unavailable.", "Projects are unavailable.",
    "Running work is unavailable.", "Verified result records are unavailable.", "Worker signals are unavailable.",
    "Worker status is unavailable."],
    "each Home panel must name its own failed read");
});

test("the real Needs-attention read failure keeps role=alert, and the loading state does not", async () => {
  // Needs attention is a page whose whole purpose IS the attention items, so a
  // failed read there is the one thing that must interrupt — it keeps
  // `<UnavailableState urgent>`. The component test can only prove the prop
  // works; only mounting the page proves the page passes it.
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  // A read that never settles, so the page is genuinely mid-check and the
  // assertions below are about the in-flight state rather than about a race.
  const never = () => new Promise<never>(() => {});
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => never() });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => { root.render(createElement(LocalRuntimeContextV1.Provider, { value: { mode: "hosted" } },
      createElement(PrivateNeedsMe))); });
    await act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 25)); });
    const document = dom.window.document;
    // While the check is in flight the page says "Checking…" politely, and must
    // not be alerting about a failure that has not happened.
    const checking = liveRegions(dom).filter(region => /Checking…/.test(region.text));
    assert.equal(checking.length, 1, `the in-flight check announces politely: ${JSON.stringify(liveRegions(dom))}`);
    assert.equal(checking[0].role, "status", "an in-flight check must not interrupt the owner");
    assert.equal(document.querySelector('[role="alert"]'), null,
      "nothing has failed yet, so nothing may be announced as a failure");

    // Now every protected read fails, which is the state under test: the
    // recovery read and the saved-task inbox read both land on their branches.
    // A fresh mount is used rather than the re-check button, because the
    // in-flight read from the phase above holds that button disabled.
    Object.assign(globalThis, { fetch: async () => { throw new TypeError("network"); } });
    const failed = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://control.invalid/", pretendToBeVisual: true });
    const failedRoot = createRoot(failed.window.document.getElementById("root")!);
    failed.window.document.body.id = "failed-root";
    await act(async () => { root.render(createElement("div", { hidden: true })); });
    await act(async () => { failedRoot.render(createElement(LocalRuntimeContextV1.Provider, { value: { mode: "hosted" } },
      createElement(PrivateNeedsMe))); });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await act(async () => { await new Promise(resolve => failed.window.setTimeout(resolve, 5)); });
      if (/Recovery status is unavailable/.test(failed.window.document.body.textContent ?? "")) break;
    }
    const failedDocument = failed.window.document;
    const alert = failedDocument.querySelector('[role="alert"].private-state-unavailable');
    assert.ok(alert, `a failed recovery read keeps the interrupted alert, not a quiet status: ${failedDocument.body.textContent}`);
    assert.match(alert.textContent ?? "", /Recovery status is unavailable or not configured\. No all-clear is claimed\./);
    assert.equal(failedDocument.querySelectorAll('[role="alert"].private-state-unavailable').length, 1,
      "the failure is announced once, not once per re-render");
    assert.equal(failedDocument.querySelector('[role="status"].private-state-unavailable'), null,
      "it must not also be a polite status region");
    // The pipeline inbox and the saved-task inbox are both rendered on this
    // page alongside the Action Inbox, and all three must be interrupted: a
    // page that quietly swallowed one of them would pass an assertion on the
    // others. Every failure sentence is asserted here, each from its own
    // role=alert element, rather than one of them being left unchecked.
    const savedTaskAlerts = [...failedDocument.querySelectorAll('[role="alert"]')]
      .map(node => node.textContent ?? "")
      .filter(text => /could not be checked\./.test(text))
      .sort();
    assert.equal(savedTaskAlerts.length, 3,
      `the pipeline inbox and both Action Inbox sources announce their own failed read, not just one: ${JSON.stringify(savedTaskAlerts)}`);
    assert.match(savedTaskAlerts.find(text => text.startsWith("The protected pipeline inbox")) ?? "",
      /^The protected pipeline inbox could not be checked\. No empty inbox or owner decision is inferred\./);
    assert.match(savedTaskAlerts.find(text => text.startsWith("Saved task attention")) ?? "",
      /^Saved task attention could not be checked\. No empty inbox or all-clear is inferred\./);
    assert.match(savedTaskAlerts.find(text => text.startsWith("Saved attention notifications")) ?? "",
      /^Saved attention notifications could not be checked\. No empty inbox or all-clear is inferred\./);
    assert.doesNotMatch(failedDocument.body.textContent ?? "", /No actions are waiting in the sources you can access\./,
      "failed reads must never be rendered as an empty inbox");
    assert.doesNotMatch(failedDocument.body.textContent ?? "", /No pipeline proposals are waiting for your decision\./,
      "a failed pipeline read must never be rendered as an empty inbox");
    await act(async () => { failedRoot.unmount(); });
    failed.window.close();
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
