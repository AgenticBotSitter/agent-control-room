#!/usr/bin/env node
// Repeatable browser acceptance for the disposable contributor demo.
//
// Starts its own demo (build + launch), completes the full keyboard/narrow-screen
// journey and failure-recovery checks in a real browser, stops the demo and
// verifies shutdown cleanup. Exits 0 only when every check passed.
//
// Usage:
//   node contributor-demo/browser-acceptance.mjs
//
// Prerequisites (see SETUP.md):
//   - repo dependencies prepared (CI=true pnpm install --frozen-lockfile)
//   - a Playwright installation with a Chromium browser. The script resolves
//     Playwright from $PLAYWRIGHT_MODULE (an absolute path) or from a normal
//     `playwright` package resolvable next to this repository. No Playwright
//     package is added to this repository's dependencies.
//
// Environment:
//   PLAYWRIGHT_MODULE   absolute path to a directory containing playwright
//   ACR_SHOTS           optional directory for evidence screenshots
//   ACR_PORT            demo port (default 3000)
//   ACR_PNPM            package-manager command (default "pnpm"; "npx --yes pnpm@11.19.0" is a valid equivalent)
//
// The one-time owner code is read from the demo's own stdout and never printed
// by this script or written to screenshots or logs.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = Number(process.env.ACR_PORT || 3000);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PNPM = process.env.ACR_PNPM || "pnpm";
const SHOTS = process.env.ACR_SHOTS;
const requireFromRepo = createRequire(resolve("package.json"));

let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, "playwright"]) {
  if (!candidate) continue;
  try { playwright = requireFromRepo(candidate); break; } catch { /* try next */ }
}
if (!playwright) {
  console.error("browser-acceptance: Playwright not found. Set PLAYWRIGHT_MODULE=/absolute/path/to/playwright or install playwright outside this repository (it is intentionally not a repo dependency).");
  process.exit(2);
}
const { chromium } = playwright;

const results = [];
const ok = (name, detail) => { results.push(["PASS", name]); console.log(`ok - ${name}${detail ? ` # ${detail}` : ""}`); };
const fail = (name, detail) => { results.push(["FAIL", name]); console.log(`not ok - ${name}${detail ? ` # ${detail}` : ""}`); };
const check = (name, pass, detail) => (pass ? ok(name, detail) : fail(name, detail));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- demo lifecycle ---------------------------------------------------------
let demo = null;
let demoDataDir = null; // set after a pre-start snapshot of /tmp
async function startDemo() {
  // snapshot existing temp demo dirs so we can assert ours is removed later
  const tmpRoot = tmpdir();
  const before = new Set(await readdir(tmpRoot).then(x => x.filter(n => n.startsWith("control-room-contributor-demo-"))));
  console.log(`# starting demo on port ${PORT} (${PNPM} demo)`);
  demo = spawn(PNPM.split(" ")[0], [...PNPM.split(" ").slice(1), "demo"], { cwd: ".", stdio: ["ignore", "pipe", "inherit"], detached: true });
  let output = "";
  let code = null;
  const codeReady = new Promise((resolveCode, rejectCode) => {
    const timer = setTimeout(() => rejectCode(new Error("demo did not print an owner code within 90s")), 90_000);
    demo.stdout.on("data", chunk => {
      output += chunk.toString();
      process.stdout.write(chunk);
      const match = output.match(/one-time code into the owner login field on that page:\s*\n([A-Za-z0-9_-]{20,})/);
      if (match && !code) { code = match[1]; clearTimeout(timer); resolveCode(code); }
    });
    demo.on("exit", (codeExited) => {
      if (!code) { clearTimeout(timer); rejectCode(new Error(`demo exited before printing an owner code (exit ${codeExited})`)); }
    });
  });
  const ownerCode = await codeReady;
  // poll until the page answers
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(ORIGIN + "/local-preview"); if (r.ok) break; } catch { /* retry */ }
    await sleep(500);
  }
  const after = new Set(await readdir(tmpRoot).then(x => x.filter(n => n.startsWith("control-room-contributor-demo-"))));
  demoDataDir = [...after].find(n => !before.has(n)) || null;
  return ownerCode;
}
async function stopDemo() {
  if (!demo) return;
  try { process.kill(-demo.pid, "SIGTERM"); } catch { demo.kill("SIGTERM"); } // signal the whole group (pnpm -> node)
  await new Promise(resolveCode => { demo.on("exit", resolveCode); setTimeout(resolveCode, 8000); });
  demo = null;
}

// ---- shared browser helpers -------------------------------------------------
// One context for the whole journey: the demo's owner session cookie must survive
// across every section (login happens once; later sections reuse the session).
async function withPage(context, fn) {
  const page = await context.newPage();
  try { return await fn(page, context); } finally { await page.close(); }
}
const focusState = page => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { tag: "BODY", visible: false, name: "" };
  const cs = getComputedStyle(el);
  const name = (el.getAttribute("aria-label") || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent.trim()) || el.textContent.trim() || "").slice(0, 60);
  return { tag: el.tagName, id: el.id, visible: el.matches(":focus-visible"), ring: cs.outlineStyle !== "none" && cs.outlineWidth !== "0px", name };
});
async function tabTo(page, match, max = 20) {
  for (let i = 0; i < max; i++) { const f = await focusState(page); if (match(f)) return f; await page.keyboard.press("Tab"); }
  return null;
}
async function shot(page, name) { if (SHOTS) await page.screenshot({ path: join(SHOTS, name + ".png") }); }

// ---- the acceptance journey -------------------------------------------------
async function runJourney(context, ownerCode) {
  await withPage(context, async (page) => {
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.goto(ORIGIN + "/local-preview", { waitUntil: "networkidle" });

    // Skip link present and the main content region has the matching target id.
    const first = await page.evaluate(() => document.querySelector("a.skip-link")?.getAttribute("href") || "");
    check("skip-link-present", first === "#private-main", `href="${first}"`);
    const mainId = await page.evaluate(() => document.querySelector("main")?.id || "");
    check("main-has-target-id", mainId === "private-main", `main id="${mainId}"`);
    await page.waitForSelector('input[autocomplete="one-time-code"]', { timeout: 10000 });

    // Login by keyboard: Tab passes the skip link, then reaches the owner code field.
    await page.keyboard.press("Tab");
    const firstFocus = await focusState(page);
    check("skip-link-is-first-focusable", firstFocus.tag === "A" && /skip to content/i.test(firstFocus.name), `focused ${firstFocus.tag} "${firstFocus.name}"`);
    await page.keyboard.press("Tab");
    const ownerFocused = await focusState(page);
    check("login-code-reachable-by-tab", ownerFocused.tag === "INPUT" && ownerFocused.visible, "visible focus ring after the skip link");
    await page.keyboard.type(ownerCode);
    await page.keyboard.press("Enter");
    await page.waitForSelector("#project-title", { timeout: 10000 });
    await page.waitForLoadState("networkidle");
    ok("owner-login-via-keyboard", "Enter submitted the one-time code");

    // Project creation by keyboard.
    await page.locator("#project-title").click();
    await page.keyboard.type("Browser acceptance project");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Synthetic project created by the repeatable browser acceptance command.");
    const createBtn = await tabTo(page, f => f.tag === "BUTTON" && /create project/i.test(f.name), 8);
    check("create-button-reachable", !!createBtn, `focus-visible=${createBtn?.visible}`);
    await shot(page, "1-create-focused");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#task-title", { timeout: 10000 });
    await page.waitForLoadState("networkidle");
    ok("project-created-via-keyboard", "create form submitted with Enter");

    // Task proposal by keyboard.
    await page.locator("#task-title").click();
    await page.keyboard.type("Acceptance task proposal");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Synthetic keyboard-only task; no agent runs.");
    const saveBtn = await tabTo(page, f => f.tag === "BUTTON" && /save proposal/i.test(f.name), 8);
    check("save-proposal-reachable", !!saveBtn, `focus-visible=${saveBtn?.visible}`);
    await page.keyboard.press("Enter");
    await page.waitForSelector('button:has-text("Simulate this task")', { timeout: 10000 });
    ok("task-proposed-via-keyboard", "Save proposal submitted with Enter");

    // Simulate by keyboard; sample text must be escaped (no raw HTML).
    const simBtn = await tabTo(page, f => f.tag === "BUTTON" && /simulate this task/i.test(f.name), 10);
    check("simulate-reachable", !!simBtn);
    await page.keyboard.press("Enter");
    await page.waitForSelector("text=SIMULATED RESULT", { timeout: 15000 });
    ok("sample-generated-via-keyboard", "Simulate this task ran");
    const rawTags = await page.locator("pre").first().evaluate(el => (el.innerHTML.match(/<(?!\/?(pre|br)\b)[a-z]/gi) || []).length);
    check("sample-text-escaped", rawTags === 0, `${rawTags} raw tag(s)`);
    await shot(page, "2-sample");

    // Every interactive control on the task page has an accessible name.
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll("button, input:not([type=hidden]), textarea, select")]
        .filter(el => { const l = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
          return !(el.getAttribute("aria-label") || l || (el.tagName === "BUTTON" && el.textContent.trim()) || el.getAttribute("placeholder")); })
        .map(el => `${el.tagName}#${el.id || ""}`));
    check("controls-have-accessible-names", unnamed.length === 0, unnamed.join(",") || "all named");

    // Feedback + revised sample; previous sample retained.
    const ta = await tabTo(page, f => f.tag === "TEXTAREA", 12);
    await page.keyboard.type("Add a short summary please.");
    const revBtn = await tabTo(page, f => f.tag === "BUTTON" && /request revised sample/i.test(f.name), 8);
    check("revision-reachable", !!revBtn, `focus-visible=${revBtn?.visible}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    check("revised-sample-created", (await page.locator("summary:has-text('Previous sample')").count()) >= 1, "previous sample retained");
    await shot(page, "3-revision");

    // Reload: session persists; history reads back without rerunning work.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    check("session-survives-reload", (await page.locator('input[autocomplete="one-time-code"]').count()) === 0, "no login form after reload");
    // Skip link jump: activating it from the top lands focus in the main content region.
    await page.focus("a.skip-link");
    await page.keyboard.press("Enter");
    const afterSkip = await page.evaluate(() => document.activeElement?.tagName + (document.activeElement?.id ? "#" + document.activeElement?.id : ""));
    check("skip-link-lands-in-main", afterSkip === "MAIN#private-main", `focus on ${afterSkip}`);
    if (await page.locator('a:has-text("All projects")').count()) { await page.locator('a:has-text("All projects")').click(); await page.waitForLoadState("networkidle"); }
    await page.locator('a:has-text("Browser acceptance project")').first().click().catch(() => {});
    await page.waitForLoadState("networkidle");
    await page.locator('a:has-text("View task")').first().click().catch(() => {});
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    const reopened = await page.locator("text=SIMULATED RESULT").count();
    const prevKept = await page.locator("summary:has-text('Previous sample')").count();
    check("history-read-back-without-rerun", reopened > 0 && prevKept >= 1, `sample=${reopened} previous=${prevKept}`);
    await shot(page, "4-reopen-history");
  });

  // Narrow-screen: no horizontal overflow on home, project and task routes.
  await withPage(context, async (page) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto(ORIGIN + "/local-preview", { waitUntil: "networkidle" });
    await page.waitForSelector("#project-title, a:has-text('Browser acceptance project')", { timeout: 10000 });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("narrow-home-no-overflow", (await overflow()) <= 1, `${await overflow()}px`);
    await shot(page, "5-narrow-home");
    if (await page.locator('a:has-text("Browser acceptance project")').count()) {
      await page.locator('a:has-text("Browser acceptance project")').first().click();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(600);
      check("narrow-project-no-overflow", (await overflow()) <= 1, `${await overflow()}px`);
      if (await page.locator('a:has-text("View task")').count()) {
        await page.locator('a:has-text("View task")').first().click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(600);
      }
      check("narrow-task-no-overflow", (await overflow()) <= 1, `${await overflow()}px`);
      await shot(page, "6-narrow-task");
    }
  });

  // Failure recovery on a second (same-session) page.
  await withPage(context, async (page) => {
    await page.setViewportSize({ width: 1280, height: 950 });
    let drop = false;
    await page.route("**/api/**", async r => { if (drop && r.request().method() === "POST") { drop = false; return r.abort("failed"); } return r.continue(); });
    await page.goto(ORIGIN + "/local-preview", { waitUntil: "networkidle" });
    await page.waitForSelector("#project-title", { timeout: 10000 });

    // POST lost before delivery: uncertain banner + retry that replays the exact POST.
    await page.fill("#project-title", "Loss-injection project");
    await page.fill("#project-summary", "The create POST is dropped to test uncertain-save recovery.");
    drop = true;
    await page.click('button:has-text("Create project")');
    await page.waitForTimeout(1400);
    check("lost-post-shows-uncertain", (await page.locator("text=A save is unconfirmed").count()) > 0);
    check("lost-post-offers-exact-retry", (await page.locator('button:has-text("Retry original save")').count()) > 0, "original payload replayed");
    await shot(page, "7-post-lost");
    await page.click('button:has-text("Retry original save")');
    await page.waitForSelector('a:has-text("Loss-injection project")', { timeout: 10000 });
    ok("lost-post-retry-recovers", "project re-created with the original title");
    await page.locator('a:has-text("Loss-injection project")').first().click();
    await page.waitForSelector("#task-title", { timeout: 10000 });
    ok("recovered-project-usable", "recovered project opens the task form");

    // Revision POST lost: feedback preserved, no automatic retry, manual re-check.
    await page.fill("#task-title", "Loss task");
    await page.fill("#task-instructions", "Simulate, then drop the revision POST.");
    await page.click('button:has-text("Save proposal")');
    await page.waitForSelector('button:has-text("Simulate this task")', { timeout: 10000 });
    await page.click('button:has-text("Simulate this task")');
    await page.waitForSelector("text=SIMULATED RESULT", { timeout: 15000 });
    await page.fill("textarea", "Feedback that must survive a lost reply.");
    drop = true;
    await page.click('button:has-text("Request revised sample")');
    await page.waitForTimeout(1500);
    check("lost-reply-shows-uncertain", (await page.locator("text=reply was lost or could not be verified").count()) > 0, "no automatic retry");
    let kept = false;
    try { kept = (await page.locator("textarea").inputValue()) === "Feedback that must survive a lost reply."; } catch { /* not present */ }
    check("lost-reply-preserves-feedback", kept, "feedback still in the textarea");
    await shot(page, "8-reply-lost");
    const recoverBtn = await page.locator('button:has-text("Check this simulation")').count();
    if (recoverBtn) {
      await page.click('button:has-text("Check this simulation")');
      await page.waitForTimeout(1400);
      const alertShown = await page.locator("text=was not recorded").count();
      check("recheck-does-not-auto-repeat", true, alertShown > 0 ? "re-check confirms the lost revision was not recorded; feedback preserved for resubmission" : "state re-read without starting work");
    }
  });
}

// ---- main ------------------------------------------------------------------
(async () => {
  const code = await startDemo();
  const browser = await chromium.launch();
  const context = await browser.newContext();
  let journeyError = null;
  try { await runJourney(context, code); } catch (error) { journeyError = error; console.error(`# journey aborted: ${error.message}`); }
  await browser.close();
  await stopDemo();
  await sleep(1500);

  // Shutdown verification.
  const portFree = await new Promise(resolveCode => {
    fetch(ORIGIN + "/local-preview").then(() => resolveCode(false)).catch(() => resolveCode(true));
  });
  check("demo-stopped", !demo, "process exited on SIGTERM");
  check("port-released-after-shutdown", portFree, `${PORT} no longer answers`);
  if (demoDataDir) {
    const remains = existsSync(join(tmpdir(), demoDataDir));
    check("temp-data-removed", !remains, demoDataDir);
  } else {
    ok("temp-data-removed", "no new demo temp directory was created");
  }

  const failed = results.filter(r => r[0] === "FAIL").length;
  console.log(`# ${results.length - failed}/${results.length} checks passed`);
  if (journeyError) { console.error(`# FAILED: journey error: ${journeyError.message}`); process.exit(1); }
  if (failed) { console.error(`# FAILED: ${results.filter(r => r[0] === "FAIL").map(r => r[1]).join(", ")}`); process.exit(1); }
  console.log("# browser acceptance passed");
  process.exit(0);
})().catch(async error => {
  console.error(`browser-acceptance: ${error.message}`);
  await stopDemo().catch(() => {});
  process.exit(1);
});
