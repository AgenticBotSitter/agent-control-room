// Phone-width usability, enforced rather than described (M12, plan item A-071).
//
// The owner interface is read on a phone, so "it looked fine at desktop width"
// is not evidence. This walks every owner page at 375px — the narrowest of the
// two audited devices (375x812 and 390x844) — and fails on the defects that
// make a page unusable there:
//
//   1. horizontal overflow, measured as each element's painted right edge
//      against the viewport rather than `document.scrollingElement.scrollWidth`
//      (the shell clips, so the document number is blind to it);
//   2. any standalone interactive control smaller than 44x44, which is below the
//      WCAG 2.2 SC 2.5.8 target size and too small to hit reliably with a thumb;
//   3. text clipped rather than wrapped;
//   4. the first status or attention element below the fold;
//   5. focus order disagreeing with the order the page paints in.
//
// It runs against the same disposable rehearsal stack the other owner browser
// suites use, and refuses any origin that is not that stack — in particular the
// live app on port 3210. No network, no clock and no randomness are used: the
// page under test is the built artifact.
//
// The 44px rule is not applied to every <a>. WCAG 2.5.8 explicitly exempts
// targets "in a sentence or block of text", and `private.css` already encodes
// that judgement with a 24px inline floor for prose links. This test therefore
// separates the two groups rather than skipping small targets wholesale, so a
// new undersized *control* fails the lane while a prose link is asserted to keep
// its own documented floor.
//
// WHY (5) is here, in a browser, and not only in a jsdom assertion. PR #404
// first shipped Home as a phone-width flex column with CSS `order` pushing the
// framing copy below the panels, which desynchronised the tab sequence from the
// paint order: a keyboard reached the "Check saved dashboard again" button first
// while it painted last. jsdom has no layout engine, so the jsdom guard could
// only read a cascade — and the first version of it read a cascade that was
// never loaded, which made it pass against anything. Tab-walking in real
// Chromium is the check that cannot be argued with: it measures where the owner
// actually looks and where the keyboard actually lands.
//
// The walk runs twice: once against the real rehearsal stack (Mac-local Home)
// and once with `/api/v1/local-workers` answered 404, which is exactly how
// `LocalRuntimeProvider` decides this browser is not on a Mac-local host. That
// is the app's own runtime detection, running normally, with only the HTTP
// response intercepted — no stubbed component, no injected state — so hosted
// Home's focus order is measured rather than assumed. Hosted Home is where the
// original defect was worse, and nothing in the rehearsal stack serves it.
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { assertDisposableBrowserOrigin } from "../../private-app/app/browser-test-origin";

const ownerCode = process.env.CONTROL_ROOM_E2E_OWNER_CODE;
if (!ownerCode) throw new Error("CONTROL_ROOM_E2E_OWNER_CODE is required");
// The live-app refusal lives in `browser-test-origin.ts`, not inline here, so
// that `tests/owner-phone-width-origin-refusal.test.ts` can import and assert
// the same guard this call uses. An inline condition in this file was the only
// refusal the suite had, and removing it left discovery green.
assertDisposableBrowserOrigin(process.env.CONTROL_ROOM_E2E_ORIGIN);

/** 375x812 is the narrowest audited device. 390x844 is covered by the audit run
 * recorded in the PR body; 375 is the one that fails first, so it gates CI. */
const PHONE_WIDTH = 375;
const PHONE_HEIGHT = 812;

/** The owner routes. The project/task routes need ids, so they are appended once
 * the fixture has created them. */
const OWNER_ROUTES: readonly string[] = ["/", "/projects", "/workers", "/workers/connect", "/needs-me"];

type Measurement = {
  scrollWidth: number;
  clientWidth: number;
  /** Standalone controls that measured under 44x44 on either axis. */
  undersized: readonly { label: string; width: number; height: number }[];
  /** Prose links, which WCAG 2.5.8 exempts, reported so the exemption is
   * visible in a failure rather than silently applied. */
  proseLinks: readonly { label: string; width: number; height: number }[];
  /** Elements whose painted text is wider than their box. */
  clipped: readonly { label: string }[];
  /** Elements painted past the viewport's right edge with no scrollable
   * ancestor to reach them. See the note on `scrollingElement` below. */
  offscreen: readonly { label: string; right: number }[];
  /** Document offset of the first status/attention element on the page, and
   * whether it is inside the first viewport. */
  firstAttention: { top: number; aboveFold: boolean; label: string } | null;
};

/** Links that are genuinely inside running prose, and so carry the documented
 * 24px inline floor rather than the 44px control target. Matched on the parent
 * element being a text-bearing block that also holds non-link content. */
function isProseLink(link: HTMLAnchorElement): boolean {
  const container = link.closest("p, li, dd, figcaption, blockquote");
  if (!container) return false;
  // A container that is *only* the link is a standalone target even inside <p>.
  const ownText = (container.textContent ?? "").replace(link.textContent ?? "", "").trim();
  return ownText.length > 0;
}

async function measure(page: Page): Promise<Measurement> {
  return page.evaluate(({ proseCheck, minTarget }) => {
    // eslint-disable-next-line no-new-func
    const isProse = new Function("link", `return (${proseCheck})(link);`) as (link: HTMLAnchorElement) => boolean;
    const scroller = document.scrollingElement ?? document.documentElement;
    const clientWidth = scroller.clientWidth;
    const undersized: { label: string; width: number; height: number }[] = [];
    const proseLinks: { label: string; width: number; height: number }[] = [];
    const clipped: { label: string }[] = [];
    const describe = (element: Element) => `${element.tagName.toLowerCase()}`
      + (element.getAttribute("class") ? `.${element.getAttribute("class")!.split(/\s+/).join(".")}` : "")
      + ` "${(element.textContent ?? "").trim().slice(0, 40)}"`;
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    };

    const interactive = document.querySelectorAll(
      "a[href], button, input, select, textarea, summary, [role=button], [role=checkbox]");
    for (const element of interactive) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      // Inline links wrap across the lines of a sentence, so a multi-line prose
      // link is measured by its widest line, not its union box.
      const box = element.tagName === "A" && isProse(element as HTMLAnchorElement)
        ? element.getClientRects()[0] ?? rect
        : rect;
      const record = { label: describe(element), width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 };
      if (box.width >= minTarget && box.height >= minTarget) continue;
      if (element.tagName === "A" && isProse(element as HTMLAnchorElement)) proseLinks.push(record);
      else undersized.push(record);
    }

    // Text that is painted wider than the box that contains it has lost meaning
    // rather than wrapped. `overflow-x: clip` on the shell hides this from a
    // scrollbar, so it is only visible to a measurement like this one.
    for (const element of document.querySelectorAll("h1, h2, h3, p, li, dd, span, a, button, label, td, th")) {
      if (!visible(element) || element.closest("script, style, noscript")) continue;
      const style = getComputedStyle(element);
      if (!["hidden", "clip"].includes(style.overflowX) && style.textOverflow !== "ellipsis") continue;
      if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1)
        clipped.push({ label: describe(element) });
    }

    // The real horizontal-overflow check. `document.scrollingElement.scrollWidth`
    // is NOT sufficient here and is not used as the gate: `.private-shell`
    // carries `overflow-x: clip`, so an over-wide child is clipped at the
    // shell and the document's scrollWidth stays equal to its clientWidth.
    // Measured on a 900px-wide block inside a 375px viewport: scrollWidth 375,
    // clientWidth 375, and `scrollLeft = 50` then read back as 0 — the page
    // reports no overflow while the content is silently cut off to the right.
    // So the gate is the element's own painted right edge against the viewport,
    // which catches the clipping that the document-level number cannot.
    const offscreen: { label: string; right: number }[] = [];
    for (const element of document.querySelectorAll("main *, header *")) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.right <= clientWidth + 0.5) continue;
      // An element inside a scrollable ancestor is reachable by scrolling that
      // ancestor, so it is not "pushed off the screen" — `clip` is not scrollable
      // and is deliberately not treated as one, because clipped content is lost.
      let node = element.parentElement, reachable = false;
      while (node) {
        const style = getComputedStyle(node);
        if (["auto", "scroll"].includes(style.overflowX) && node.scrollWidth > node.clientWidth + 0.5) {
          reachable = true;
          break;
        }
        node = node.parentElement;
      }
      if (reachable) continue;
      offscreen.push({ label: describe(element), right: Math.round(rect.right) });
    }

    // The owner's-attention-first rule: the first status or attention element
    // on the page must be inside the first viewport, so a phone owner sees it
    // without scrolling. Only pages that actually carry one are judged — a page
    // with no state to report has nothing to put above the fold, and inventing
    // a requirement for it would force markup that has no purpose.
    const attentionSelector = ".private-notice, .private-state-unavailable, .private-chip.is-bad, "
      + ".private-chip.is-warn, .private-state";
    let firstAttention: Measurement["firstAttention"] = null;
    for (const element of document.querySelectorAll(attentionSelector)) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.height === 0) continue;
      const top = Math.round(rect.top + window.scrollY);
      if (firstAttention === null || top < firstAttention.top) {
        firstAttention = { top, aboveFold: rect.top + window.scrollY < window.innerHeight, label: describe(element) };
      }
    }

    return { scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth,
      undersized, proseLinks, clipped, offscreen: offscreen.slice(0, 8), firstAttention };
  }, {
    proseCheck: isProseLink.toString(),
    minTarget: 44,
  });
}

async function signIn(page: Page) {
  await page.goto("/session");
  await page.getByLabel("Owner code").fill(ownerCode!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
}

/**
 * Press Tab through every control in `main` and return them in the order the
 * keyboard reaches them, with where each one paints.
 *
 * Focus is seeded on `main` itself rather than left wherever the previous
 * measurement left it. `main` carries `tabIndex={-1}`, so it is focusable but
 * not a tab stop, and focusing it sets the sequential navigation start point to
 * the top of the page content — the first Tab then lands on the first control
 * inside `main`, which is what this walk means to measure. (Walking from the
 * document body instead reaches the header's controls first, so a walk that
 * simply pressed Tab until it entered `main` would have to model a
 * legitimate exception: a skip link is *supposed* to paint at the very top and
 * be reached first. That is the document tab sequence working as designed, not
 * a desynchronisation, and it belongs to the header rather than to this page.)
 *
 * The walk is bounded three ways — a tab budget, a repeat-detection set, and
 * the first stop outside `main` — so a focus cycle cannot hang the lane.
 *
 * A positive `tabindex` moves an element to the FRONT of the document's tab
 * order, so seeding focus on `main` does not put the walk past it: the
 * re-check button is reached first, and the walk legitimately stops there
 * having left `main`. That is the defect being reported, and the walk must not
 * be reshaped to hide it — so the result carries how far it got, and the
 * per-mode tests say what a complete walk looks like rather than accepting a
 * short one.
 */
async function tabWalkInMain(page: Page, tabBudget = 400): Promise<readonly Stop[]> {
  await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!(main instanceof HTMLElement)) throw new Error("owner pages must render a <main>");
    // A fresh navigation start point, and a page scrolled to the top so the
    // document offsets below are the ones the owner first sees.
    main.focus();
    window.scrollTo(0, 0);
  });
  const seen = new Set<string>();
  const stops: Stop[] = [];
  for (let pressed = 0; pressed < tabBudget; pressed += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        inMain: element.closest("main") !== null,
        // A stable identity for cycle detection that survives re-layout.
        key: `${element.tagName}#${element.id}.${element.className}|${(element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}`,
        label: `${element.tagName.toLowerCase()}${element.className ? `.${element.className.split(/\s+/).join(".")}` : ""} "${(element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}"`,
        tabIndex: element.getAttribute("tabindex"),
        // Document offset, so the comparison is unaffected by scroll position.
        top: rect.top + window.scrollY,
        left: rect.left + window.scrollX,
        painted: style.display !== "none" && style.visibility !== "hidden"
          && (rect.width > 0 || rect.height > 0),
      };
    });
    if (!stop || !stop.inMain) break;
    if (seen.has(stop.key)) break;
    seen.add(stop.key);
    stops.push(stop);
  }
  return stops;
}

/** One stop on the tab walk: a control, where it paints, and its tabindex. */
type Stop = {
  inMain: boolean;
  key: string;
  label: string;
  tabIndex: string | null;
  top: number;
  left: number;
  painted: boolean;
};

/**
 * Failures from a tab walk, as owner-visible sentences.
 *
 * The rule is that the keyboard and the eye agree: a control reached later must
 * not paint above one reached earlier. Two controls legitimately share a top —
 * they sit side by side in one grid row — so a step that does not move down is
 * only accepted if it also does not move left.
 *
 * `tolerance` exists because sub-pixel layout puts a control's border box a
 * fraction of a pixel off its neighbour's when a row of four is distributed
 * across a 375px viewport. It is 1px, which is far below any real reordering.
 */
function focusOrderFailures(route: string, mode: string, stops: readonly Stop[]): string[] {
  const tolerance = 1;
  const failures: string[] = [];
  for (const stop of stops) {
    if (stop.tabIndex !== null && Number(stop.tabIndex) > 0) {
      failures.push(`${route} (${mode}): ${stop.label} carries tabindex="${stop.tabIndex}", which moves it to the front of the tab sequence independently of where it paints`);
    }
    if (!stop.painted) {
      failures.push(`${route} (${mode}): ${stop.label} takes keyboard focus but is not painted, so a keyboard owner lands on something they cannot see`);
    }
  }
  for (const [index, stop] of stops.entries()) {
    if (index === 0) continue;
    const previous = stops[index - 1]!;
    if (stop.top < previous.top - tolerance) {
      failures.push(`${route} (${mode}): the keyboard reaches ${stop.label} at y=${Math.round(stop.top)} after ${previous.label} at y=${Math.round(previous.top)}, so focus order disagrees with the order the page paints in`);
    } else if (Math.abs(stop.top - previous.top) <= tolerance && stop.left < previous.left - tolerance) {
      failures.push(`${route} (${mode}): ${stop.label} paints left of ${previous.label} on the same line but is reached after it`);
    }
  }
  return failures;
}

/** Sign in and create one project and one task, returning the routes to walk. */
async function seedOwnerFixture(page: Page) {
  const projectTitle = "Phone width coverage project with a deliberately long title";
  await page.goto("/projects");
  await page.getByRole("textbox", { name: "Project name", exact: true }).fill(projectTitle);
  await page.getByLabel("What do you want to accomplish?")
    .fill("A summary long enough to need several lines on a narrow phone viewport without losing any of its meaning.");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/projects\/[^/]+$/);
  const projectPath = new URL(page.url()).pathname;
  const projectId = decodeURIComponent(projectPath.split("/").at(-1)!);

  const taskTitle = "A saved task whose title is long enough to wrap on a phone";
  await page.goto(`${projectPath}/tasks#new-task`);
  await page.getByLabel("Task title").fill(taskTitle);
  await page.getByLabel("What should the agent deliver?").fill("Return one harmless short line.");
  await page.getByRole("button", { name: "Save task" }).click();
  await expect(page.getByRole("heading", { name: taskTitle, exact: true })).toBeVisible();
  const taskPath = new URL(page.url()).pathname;

  const routes = [...OWNER_ROUTES, projectPath, `${projectPath}/tasks`, taskPath,
    `${projectPath}/reviews`, `${projectPath}/activity`, `${projectPath}/files`];
  return { projectId, routes };
}

test("every owner page is usable at phone width", async ({ page }, testInfo: TestInfo) => {
  await page.setViewportSize({ width: PHONE_WIDTH, height: PHONE_HEIGHT });
  await signIn(page);
  const { projectId, routes } = await seedOwnerFixture(page);

  const failures: string[] = [];
  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator("main")).toBeVisible();
    // Every page's reads are async. Measuring mid-poll would report a loading
    // state rather than the page the owner would actually read.
    await expect(page.locator('[role="status"]').filter({ hasText: /Loading|Checking saved|Reading|Saving…/i }))
      .toHaveCount(0, { timeout: 30_000 });
    if (route === "/workers/connect")
      await page.screenshot({ path: testInfo.outputPath("workers-connect-375.png"), fullPage: true, animations: "disabled" });
    if (route.endsWith("/files"))
      await page.screenshot({ path: testInfo.outputPath("project-files-375.png"), fullPage: true, animations: "disabled" });
    const measured = await measure(page);

    if (measured.scrollWidth > measured.clientWidth) {
      failures.push(`${route}: horizontal overflow, scrollWidth ${measured.scrollWidth} > clientWidth ${measured.clientWidth}`);
    }
    for (const element of measured.offscreen) {
      failures.push(`${route}: ${element.label} is painted to x=${element.right}, past the ${measured.clientWidth}px viewport, with no scrollable ancestor to reach it`);
    }
    for (const control of measured.undersized) {
      failures.push(`${route}: target ${control.width}x${control.height} is under 44x44 at ${control.label}`);
    }
    for (const text of measured.clipped) {
      failures.push(`${route}: text is clipped rather than wrapped at ${text.label}`);
    }
    // The prose exemption is a deliberate, documented judgement, so assert it
    // still holds instead of letting the floor drift downward unnoticed.
    for (const link of measured.proseLinks) {
      expect(link.height, `${route}: prose link ${link.label} lost its 24px inline floor`).toBeGreaterThanOrEqual(24);
    }
    if (measured.firstAttention && !measured.firstAttention.aboveFold) {
      failures.push(`${route}: the first status/attention element ${measured.firstAttention.label} sits at ${measured.firstAttention.top}px, below the ${PHONE_HEIGHT}px fold, so the owner has to scroll to see it`);
    }
    // The same real page, walked by keyboard rather than measured.
    const stops = await tabWalkInMain(page);
    // A walk that reached nothing would satisfy every comparison above, so
    // each route has to prove it was actually walked. Every owner route has
    // controls in `main` — a back link or a panel action at minimum — and a
    // route that loses them all is a route whose controls a keyboard cannot
    // reach, which is the defect this walk is here to find.
    if (stops.length < 1) failures.push(`${route}: the keyboard reached no control in main at all, so its focus order cannot be checked`);
    failures.push(...focusOrderFailures(route, "mac-local", stops));
  }

  expect(failures, failures.join("\n")).toEqual([]);
  expect(projectId).toBeTruthy();
});

/** A real 375px capture is retained with the browser test result. The status
 * may honestly be either calm Off or the red attention state on a rehearsal
 * without an updater, but it must be visible without a horizontal scroll. */
test("Home updater status is captured at phone width", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: PHONE_WIDTH, height: PHONE_HEIGHT });
  await signIn(page); await page.goto("/");
  await expect(page.getByText(/Self-update(?: needs your attention|: Off)/u)).toBeVisible();
  const capture = await page.screenshot({ fullPage: false });
  await testInfo.attach("home-updater-status-375", { body: capture, contentType: "image/png" });
  expect(capture.byteLength).toBeGreaterThan(1_000);
  const measured = await measure(page);
  expect(measured.offscreen).toEqual([]);
});

/** The card is driven by the updater's own bounded projection, so this browser
 * capture supplies that projection at the HTTP boundary rather than mounting a
 * stubbed component. It catches the actual 375px layout of every phone button. */
test("Install card is captured at 375px with updater facts", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: PHONE_WIDTH, height: PHONE_HEIGHT });
  await page.route("**/api/v1/updater-owner-ui", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    schema: "control-room.updater-owner-ui/v1", observedAt: "2026-09-30T12:00:00.000Z", state: "ready_for_approval", selfUpdate: "On",
    activeSubscriptions: 0, availableControls: ["pause", "backup_now", "check_now", "repair", "rollback"],
    message: "The updater checked this update.", plan: { planId: "plan:phone", classes: ["database", "updater"], filesChanged: 4,
      filesAdded: 2, filesDeleted: 1, changesDatabase: true, changesUpdater: true, downtimeEstimateSeconds: 30,
      restoreMayLoseRecentWrites: true, macConfirmationRequired: true, botSays: { title: "A bot summary", changedAreas: ["one area"] } },
  }) }));
  await signIn(page); await page.goto("/");
  await expect(page.getByRole("heading", { name: "Install" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm with Face ID" })).toBeVisible();
  await expect(page.getByText(/Phone alerts are off/u)).toBeVisible();
  const capture = await page.screenshot({ fullPage: true });
  await testInfo.attach("updater-install-card-375", { body: capture, contentType: "image/png" });
  expect(capture.byteLength).toBeGreaterThan(1_000);
  const measured = await measure(page);
  expect(measured.offscreen).toEqual([]); expect(measured.undersized).toEqual([]);
});

for (const mode of ["mac-local", "hosted"] as const) {
  // Named with explicit literals rather than a `${mode}` template so that the
  // PR-claims checker can resolve a citation to a single named test: its
  // `hasNamedTest` pattern matches a string literal passed directly to
  // `test(...)`, so neither a backtick template nor a name held in a variable
  // can be cited. A guard nobody can name is a guard nobody reviews.
  if (mode === "hosted") {
    test("Home reads in one order in hosted mode at phone width", async ({ page }) => {
      await assertHomeReadsInOneOrder(page, mode);
    });
  } else {
    test("Home reads in one order in mac-local mode at phone width", async ({ page }) => {
      await assertHomeReadsInOneOrder(page, mode);
    });
  }
}

/** Everything the two per-mode Home tests assert, given the mode they run in. */
async function assertHomeReadsInOneOrder(page: Page, mode: "mac-local" | "hosted") {
  await page.setViewportSize({ width: PHONE_WIDTH, height: PHONE_HEIGHT });

  if (mode === "hosted") {
    // Hosted mode is reached the way the app itself decides it.
    // `LocalRuntimeProvider` treats HTTP 404 from /api/v1/local-workers as
    // "this browser is not on a Mac-local host" — see
    // private-app/app/local-runtime.tsx. Fulfilling that one response runs
    // the app's real detection, its real rendering and its real focus order;
    // no component is stubbed and no state is injected. The rehearsal stack
    // only ever serves Mac-local, so without this the hosted Home that the
    // original defect hurt worst would go unmeasured.
    await page.route("**/api/v1/local-workers", route => route.fulfill({ status: 404 }));
  }

  await signIn(page);
  await page.goto("/");
  await expect(page.locator("main")).toBeVisible();
  // Prove the mode really is the one under test rather than whatever the
  // stack happened to serve. Hosted Home shows the operator-capacity panel and
  // no local-worker-evidence panel; Mac-local Home is the reverse.
  const operatorCapacity = page.locator('main section[aria-labelledby="operator-capacity-title"]');
  const localEvidence = page.locator("main .private-local-worker-evidence");
  await expect(operatorCapacity, `${mode} mode must be the one under test`).toHaveCount(mode === "hosted" ? 1 : 0, { timeout: 30_000 });
  await expect(localEvidence).toHaveCount(mode === "hosted" ? 0 : 1);
  await expect(page.locator('[role="status"]').filter({ hasText: /Loading|Checking saved|Reading|Saving…/i }))
    .toHaveCount(0, { timeout: 30_000 });

  const stops = await tabWalkInMain(page);
  // Every focusable in `main`, read from the DOM rather than from the walk.
  // A positive `tabindex` moves an element to the FRONT of the document's
  // tab order, and Chromium's sequential navigation from a seeded start
  // point does not necessarily visit it — so the walk alone can report a
  // positive tabindex only as "something is wrong upstream". This reads the
  // attribute directly, on every control the page actually rendered, and
  // names the control when it is wrong.
  const positiveTabIndex = await page.evaluate(() => [...document.querySelectorAll("main *")]
    .map(element => ({ element, tabIndex: element.getAttribute("tabindex") }))
    .filter(entry => entry.tabIndex !== null && Number(entry.tabIndex) > 0)
    .map(({ element, tabIndex }) => `main element ${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(/\s+/).join(".")}` : ""} carries tabindex="${tabIndex}", which moves it ahead of every other control in the document's tab sequence`));
  const failures = [...positiveTabIndex, ...focusOrderFailures("/", mode, stops)];
  // A walk that reached nothing, or stopped before the last control, would
  // satisfy every comparison above — so a complete walk is asserted rather
  // than assumed. The re-check button is the one control the original defect
  // moved, and it is last by design, so a walk that never reached it did not
  // walk the whole of `main` and its verdict is not a verdict.
  //
  // A positive `tabindex` also produces a short walk, because the element
  // jumps to the front of the document's tab order and the walk stops there.
  // That case is already reported above with the element named, so the count
  // is only asked for once the walk itself is known to be clean.
  if (failures.length === 0) {
    expect(stops.some(stop => stop.label.includes("Check saved dashboard again")),
      `${mode}: the walk reached ${stops.length} controls and stopped before the re-check button, so it did not walk the whole of main`)
      .toBe(true);
    expect(stops.length, `${mode}: the tab walk reached ${stops.length} controls in main, too few to judge the order`)
      .toBeGreaterThanOrEqual(6);
  }
  expect(failures, failures.join("\n")).toEqual([]);
}
