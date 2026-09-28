// Phone-width usability, enforced rather than described (M12, plan item A-071).
//
// The owner interface is read on a phone, so "it looked fine at desktop width"
// is not evidence. This walks every owner page at 375px — the narrowest of the
// two audited devices (375x812 and 390x844) — and fails on the two defects that
// make a page unusable there:
//
//   1. horizontal overflow (document.scrollingElement.scrollWidth > clientWidth),
//      which pushes controls off the right edge where no amount of scrolling in
//      the intended axis reaches them;
//   2. any standalone interactive control smaller than 44x44, which is below the
//      WCAG 2.2 SC 2.5.8 target size and too small to hit reliably with a thumb.
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
import { expect, test, type Page } from "@playwright/test";
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
const OWNER_ROUTES: readonly string[] = ["/", "/projects", "/workers", "/needs-me"];

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

test("every owner page is usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: PHONE_WIDTH, height: PHONE_HEIGHT });
  await signIn(page);

  // A populated project and task: empty states render none of the status,
  // attention or control markup a phone owner actually has to operate.
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

  const failures: string[] = [];
  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator("main")).toBeVisible();
    // Every page's reads are async. Measuring mid-poll would report a loading
    // state rather than the page the owner would actually read.
    await expect(page.locator('[role="status"]').filter({ hasText: /Loading|Checking saved|Reading|Saving…/i }))
      .toHaveCount(0, { timeout: 30_000 });
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
  }

  expect(failures, failures.join("\n")).toEqual([]);
  expect(projectId).toBeTruthy();
});
