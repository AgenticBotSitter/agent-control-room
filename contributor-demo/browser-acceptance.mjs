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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

// Names of every live process whose /proc/<pid>/cmdline contains the marker.
// Used after shutdown to prove the demo server process (not just the pnpm
// wrapper) is actually gone. Zombies have no cmdline and are not matched.
function processesWithCmdline(marker) {
  const found = [];
  let pids = [];
  try { pids = readdirSync("/proc").filter(n => /^\d+$/.test(n)); } catch { return found; }
  for (const pid of pids) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      if (cmd.includes(marker)) found.push(Number(pid));
    } catch { /* process vanished between readdir and read */ }
  }
  return found;
}

// ---- demo lifecycle ---------------------------------------------------------
let demo = null;
let demoDataDir = null; // set after a pre-start snapshot of /tmp
let demoDataAmbiguous = 0; // >0 when multiple new temp dirs appeared at startup
async function startDemo() {
  // snapshot existing temp demo dirs so we can assert ours is removed later
  const tmpRoot = tmpdir();
  const before = new Set(await readdir(tmpRoot).then(x => x.filter(n => n.startsWith("control-room-contributor-demo-"))));
  console.log(`# starting demo on port ${PORT} (${PNPM} demo)`);
  demo = spawn(PNPM.split(" ")[0], [...PNPM.split(" ").slice(1), "demo"], { cwd: ".", stdio: ["ignore", "pipe", "inherit"], detached: true });
  let output = "";
  let code = null;
  let suppressed = false;
  const codeReady = new Promise((resolveCode, rejectCode) => {
    const timer = setTimeout(() => rejectCode(new Error("demo did not print an owner code within 90s")), 90_000);
    demo.stdout.on("data", chunk => {
      const text = chunk.toString();
      output += text;
      // Forward the demo's build output only up to the one-time-code announcement.
      // From that point on (which includes the code itself) nothing is written to
      // our stdout, so the code can never reach a log, terminal or screenshot.
      if (!suppressed) {
        const idx = output.indexOf("Paste this one-time code");
        if (idx === -1) {
          process.stdout.write(chunk);
        } else {
          const chunkStart = output.length - text.length;
          const safeLen = Math.max(0, Math.min(text.length, idx - chunkStart));
          if (safeLen > 0) process.stdout.write(text.slice(0, safeLen));
          suppressed = true;
        }
      }
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
  const newDirs = [...after].filter(n => !before.has(n));
  // Exact ownership: only when exactly one new demo temp directory appeared is
  // that directory unambiguously this run's. Multiple new dirs would mean a
  // concurrent demo — then no specific directory is provably ours.
  if (newDirs.length === 1) { demoDataDir = newDirs[0]; demoDataAmbiguous = 0; }
  else { demoDataDir = null; demoDataAmbiguous = newDirs.length; }
  return ownerCode;
}
async function stopDemo() {
  // Signal the whole process group (pnpm -> node) and return whether the demo
  // process actually exited. Callers use this boolean as real evidence; the
  // caller's cleanup checks must not pass merely because this object was nulled.
  if (!demo) return true;
  const exited = new Promise(resolveExit => demo.once("exit", () => resolveExit(true)));
  try { process.kill(-demo.pid, "SIGTERM"); } catch { demo.kill("SIGTERM"); }
  const didExit = await Promise.race([exited, sleep(8000).then(() => false)]);
  return didExit === true;
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

    // --- Two-project isolation (issue #1 acceptance: two distinct projects) ---
    // Keyboard-create a second project and verify the two stay fully isolated.
    await page.locator('a:has-text("All projects")').first().click().catch(() => {});
    await page.waitForLoadState("networkidle");
    await page.waitForSelector("#project-title", { timeout: 10000 });
    await page.locator("#project-title").click();
    await page.keyboard.type("Isolation project B");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Second synthetic project; must not share the first project's task data.");
    const createB = await tabTo(page, f => f.tag === "BUTTON" && /create project/i.test(f.name), 8);
    check("second-project-create-reachable", !!createB, `focus-visible=${createB?.visible}`);
    await page.keyboard.press("Enter");
    await page.waitForSelector("#task-title", { timeout: 10000 });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    const bTaskLinks = await page.locator('a:has-text("View task")').count();
    const bBodyText = await page.locator("body").innerText();
    check("project-isolation-no-cross-task", bTaskLinks === 0 && !bBodyText.includes("Acceptance task proposal"),
      `project B shows ${bTaskLinks} task link(s)${bBodyText.includes("Acceptance task proposal") ? "; leaks project A's task title" : ""}`);
    await shot(page, "10-isolation-b");

    // Catalog lists both projects; reopening A restores its history intact.
    await page.locator('a:has-text("All projects")').first().click();
    await page.waitForLoadState("networkidle");
    await page.waitForSelector("h1", { timeout: 10000 });
    const projA = await page.locator('a:has-text("Browser acceptance project")').count();
    const projB = await page.locator('a:has-text("Isolation project B")').count();
    check("catalog-lists-both-projects", projA === 1 && projB === 1, `projectA=${projA} projectB=${projB}`);
    const aLink = await tabTo(page, f => f.tag === "A" && /browser acceptance project/i.test(f.name), 30);
    check("reopen-project-a-by-keyboard", !!aLink, `focused ${aLink?.tag || ""} "${aLink?.name || ""}"`);
    if (aLink) {
      await page.keyboard.press("Enter");
      await page.waitForLoadState("networkidle");
      await page.waitForSelector('a:has-text("View task")', { timeout: 10000 });
      await page.locator('a:has-text("View task")').first().click();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1000);
      const aData = await page.locator("text=SIMULATED RESULT").count();
      check("project-a-history-intact-after-b", aData > 0, `SIMULATED RESULT present=${aData}`);
    }

    // --- Lifecycle archive / reopen, keyboard-driven (issue #1 acceptance) ---
    await page.locator('a:has-text("All projects")').first().click();
    await page.waitForLoadState("networkidle");
    await page.waitForSelector("h1", { timeout: 10000 });
    const aLink2 = await tabTo(page, f => f.tag === "A" && /browser acceptance project/i.test(f.name), 30);
    if (aLink2) {
      await page.keyboard.press("Enter");
      await page.waitForLoadState("networkidle");
    }
    await page.waitForTimeout(700);
    const complete = await tabTo(page, f => f.tag === "BUTTON" && /mark complete/i.test(f.name), 25);
    check("archive-mark-complete-reachable", !!complete, `focus-visible=${complete?.visible}`);
    if (complete) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1100);
      await shot(page, "11-before-archive");
      const archiveBtn = await tabTo(page, f => f.tag === "BUTTON" && /archive project/i.test(f.name), 25);
      check("archive-action-reachable-after-complete", !!archiveBtn, `focus-visible=${archiveBtn?.visible}`);
      if (archiveBtn) {
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1300);
        const reopenVisible = await page.locator('button:has-text("Reopen project")').count();
        const archiveGone = await page.locator('button:has-text("Archive project")').count();
        const statusArchived = (await page.locator("body").innerText()).toLowerCase().includes("archived");
        check("project-archived", reopenVisible === 1 && archiveGone === 0 && statusArchived,
          `reopen=${reopenVisible} archiveButton=${archiveGone} statusArchived=${statusArchived}`);
        await shot(page, "12-archived");
        const reopen = await tabTo(page, f => f.tag === "BUTTON" && /reopen project/i.test(f.name), 25);
        check("reopen-from-archived-reachable", !!reopen, `focus-visible=${reopen?.visible}`);
        if (reopen) {
          await page.keyboard.press("Enter");
          await page.waitForTimeout(1300);
          const activeAgain = await page.locator('button:has-text("Archive project")').count();
          check("project-reopened-active", activeAgain === 1, `archive button available again=${activeAgain}`);
          await shot(page, "13-reopened");
        }
      }
    }
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

  // Failure recovery on a second (same-session) page. Every POST is logged
  // (url, body, idempotency key, whether the server accepted it) so assertions
  // count actual requests — visible samples alone cannot prove a retry did or
  // did not happen.
  await withPage(context, async (page) => {
    await page.setViewportSize({ width: 1280, height: 950 });
    // Two distinct loss modes:
    //  "request"  — the POST is aborted before it reaches the server (lost before delivery).
    //  "response" — the request is delivered and the server accepts it (route.fetch),
    //               then the client's copy of the response is dropped (lost after acceptance).
    let dropMode = null;
    const postLog = [];
    await page.route("**/api/**", async r => {
      const req = r.request();
      if (req.method() !== "POST") return r.continue();
      const entry = { url: req.url(), body: req.postData() || "", key: req.headers()["idempotency-key"] || "", delivered: false };
      postLog.push(entry);
      const mode = dropMode;
      if (mode) dropMode = null;
      if (mode === "request") return r.abort("failed"); // never reaches the server
      if (mode === "response") {
        try { await r.fetch(); entry.delivered = true; } catch { /* server unreachable */ }
        return r.abort("failed"); // server accepted; drop only the client's copy
      }
      await r.continue();
      entry.delivered = true; // ordinary POST reached the server (no drop armed)
    });
    await page.goto(ORIGIN + "/local-preview", { waitUntil: "networkidle" });
    await page.waitForSelector("#project-title", { timeout: 10000 });

    // POST lost before delivery: uncertain banner + retry that replays the exact
    // POST. The client stores the pending request (body + idempotency key) and
    // retryPending re-sends the identical request, so the two create POSTs must
    // carry the same body and the same key.
    await page.fill("#project-title", "Loss-injection project");
    await page.fill("#project-summary", "The create POST is dropped to test uncertain-save recovery.");
    dropMode = "request";
    await page.click('button:has-text("Create project")');
    await page.waitForTimeout(1400);
    check("lost-post-shows-uncertain", (await page.locator("text=A save is unconfirmed").count()) > 0);
    check("lost-post-offers-exact-retry", (await page.locator('button:has-text("Retry original save")').count()) > 0, "original payload replayed");
    await shot(page, "7-post-lost");
    await page.click('button:has-text("Retry original save")');
    await page.waitForSelector('a:has-text("Loss-injection project")', { timeout: 10000 });
    const createPosts = postLog.filter(e => e.body.includes("Loss-injection project"));
    check("exactly-two-create-posts", createPosts.length === 2, `${createPosts.length} create POST(s) observed`);
    check("retry-replays-exact-payload", createPosts.length === 2 && createPosts[0].body === createPosts[1].body,
      createPosts.length === 2 && createPosts[0].body === createPosts[1].body ? "bodies identical" : "bodies DIFFER");
    check("retry-reuses-idempotency-key", createPosts.length === 2 && createPosts[0].key && createPosts[0].key === createPosts[1].key,
      createPosts.length === 2 && createPosts[0].key === createPosts[1].key ? `same key (${String(createPosts[0]?.key).slice(0, 8)}…)` : "keys missing or differ");
    check("first-dropped-second-delivered", createPosts[0]?.delivered === false && createPosts[1]?.delivered === true,
      `first delivered=${createPosts[0]?.delivered} second delivered=${createPosts[1]?.delivered}`);
    ok("lost-post-retry-recovers", "project re-created with the original title");
    await page.locator('a:has-text("Loss-injection project")').first().click();
    await page.waitForSelector("#task-title", { timeout: 10000 });
    ok("recovered-project-usable", "recovered project opens the task form");

    // Reply lost AFTER the server accepted the revision: the POST is delivered
    // (route.fetch), the server records the revision, and only the client's copy
    // of the response is dropped. The proof of "no automatic retry" is the count
    // of simulation POSTs: exactly one revision POST may exist, before and after
    // the manual re-check. An automatic retry would emit a second POST.
    await page.fill("#task-title", "Loss task");
    await page.fill("#task-instructions", "Simulate, then lose the revision reply after the server accepts it.");
    await page.click('button:has-text("Save proposal")');
    await page.waitForSelector('button:has-text("Simulate this task")', { timeout: 10000 });
    const simPosts = () => postLog.filter(e => e.url.includes("/contributor-demo/simulations"));
    const revisionPosts = () => simPosts().filter(e => e.body.includes("revision"));
    await page.click('button:has-text("Simulate this task")');
    await page.waitForSelector("text=SIMULATED RESULT", { timeout: 15000 });
    check("initial-simulate-sent-one-post", simPosts().length === 1 && simPosts()[0].delivered, `${simPosts().length} simulation POST(s) after simulate`);
    await page.fill("textarea", "Feedback that must survive a lost reply.");
    dropMode = "response";
    await page.click('button:has-text("Request revised sample")');
    await page.waitForTimeout(1500);
    check("lost-reply-shows-uncertain", (await page.locator("text=reply was lost or could not be verified").count()) > 0, "no automatic retry");
    let kept = false;
    try { kept = (await page.locator("textarea").inputValue()) === "Feedback that must survive a lost reply."; } catch { /* not present */ }
    check("lost-reply-preserves-feedback", kept, "feedback still in the textarea");
    check("revision-request-delivered-once", revisionPosts().length === 1 && revisionPosts()[0].delivered
      && revisionPosts()[0].body.includes("Feedback that must survive a lost reply."),
      revisionPosts().length === 1 ? "exactly one delivered revision POST with the feedback" : `${revisionPosts().length} revision POST(s) observed`);
    const beforeRecheck = await page.locator("summary:has-text('Previous sample')").count();
    check("no-revision-shown-before-recheck", beforeRecheck === 0, `${beforeRecheck} previous sample(s) shown before re-check`);
    await shot(page, "8-reply-lost");
    const recoverBtn = await page.locator('button:has-text("Check this simulation")').count();
    if (recoverBtn) {
      await page.click('button:has-text("Check this simulation")');
      await page.waitForTimeout(1500);
      check("no-auto-retry-after-lost-reply", simPosts().length === 2, `${simPosts().length} simulation POST(s) total (exactly simulate + revision; re-check added none)`);
      const prevCount = await page.locator("summary:has-text('Previous sample')").count();
      const alertShown = await page.locator("text=was not recorded").count();
      check("recheck-reconciles-recorded-revision", prevCount === 1 && alertShown === 0,
        prevCount === 1 ? "server recorded the revision exactly once; re-check surfaced it" : `prev=${prevCount} alert=${alertShown}`);
      await shot(page, "9-reply-reconciled");
    } else {
      fail("recheck-reconciles-recorded-revision", "Check this simulation control not shown after a lost reply");
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
  const demoStopped = await stopDemo(); // launcher (pnpm wrapper) exit evidence
  await sleep(1500);

  // Shutdown verification, split into honest claims:
  //  - demo-launcher-stopped: the package-manager wrapper's own exit event fired;
  //  - demo-server-stopped:  no process with the demo server in its cmdline remains
  //    (the wrapper exiting alone does not prove the server it spawned stopped);
  //  - port-3000-refuses-connections and temp-data-removed then build on those.
  check("demo-launcher-stopped", demoStopped, demoStopped ? "pnpm wrapper exited on SIGTERM" : "wrapper did not exit within 8s of SIGTERM");
  const serverProcs = processesWithCmdline("contributor-demo.mjs");
  const serverGone = serverProcs.length === 0;
  check("demo-server-stopped", serverGone, serverGone ? "no contributor-demo.mjs process remains" : `STILL RUNNING pid(s): ${serverProcs.join(",")}`);
  const portFree = await new Promise(resolveCode => {
    fetch(ORIGIN + "/local-preview").then(() => resolveCode(false)).catch(() => resolveCode(true));
  });
  check("port-3000-refuses-connections", portFree, `${PORT} ${portFree ? "refuses connections" : "still answers"}`);
  const stoppedCleanly = demoStopped && serverGone;
  if (demoDataDir) {
    const remains = existsSync(join(tmpdir(), demoDataDir));
    check("temp-data-removed", stoppedCleanly && !remains,
      stoppedCleanly ? (remains ? `temp dir still present: ${demoDataDir}` : `removed: ${demoDataDir}`) : "process not stopped; temp-dir check deferred");
  } else if (demoDataAmbiguous > 0) {
    fail("temp-data-removed", `${demoDataAmbiguous} new temp dirs appeared at startup; no single dir is provably this run's`);
  } else {
    ok("temp-data-removed", "no new demo temp directory was created");
  }
  if (!serverGone) {
    for (const pid of serverProcs) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } else if (!demoStopped) {
    try { process.kill(-demo.pid, "SIGKILL"); } catch { /* already gone */ }
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
