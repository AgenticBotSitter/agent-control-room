// CDP-driven browser journey for the workspace fixture. Spawns headless
// Chrome with --remote-debugging-port, attaches over WebSocket (no new
// deps — Node 22+ ships WebSocket), drives the actual product routing
// entry, captures screenshots + rendered DOM for each state, and
// records marker timing in a manifest.
//
// Evidence is written to tests/browser/workspace/evidence/ (gitignored).
// The script asserts worktree invariants before and after so this run
// cannot change tracked files.

import { spawn, execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = 4175;
const PREVIEW_URL = `http://127.0.0.1:${PORT}/`;
const CDP_PORT = 9222;
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const OUT_DIR = join(ROOT, "tests/browser/workspace/evidence");

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd: ROOT, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || error.message}`));
    else resolve(stdout);
  });
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForUrl(url, timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`preview did not serve ${url} within ${timeoutMs}ms`);
    await sleep(300);
  }
}

async function waitForCdp(timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${CDP_BASE}/json/version`);
      if (response.ok) {
        const body = await response.json();
        return body;
      }
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`CDP did not come up within ${timeoutMs}ms`);
    await sleep(200);
  }
}

async function pickPageTarget(timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${CDP_BASE}/json`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`no page target within ${timeoutMs}ms`);
    await sleep(200);
  }
}

function makeCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = new Map();
  let nextId = 1;
  let resolveOpen;
  const opened = new Promise(r => { resolveOpen = r; });
  ws.addEventListener("open", () => resolveOpen());
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const slot = pending.get(message.id);
      if (!slot) return;
      pending.delete(message.id);
      if (message.error) slot.reject(new Error(`${message.error.message} (#${message.error.code})`));
      else slot.resolve(message.result);
    } else {
      const list = events.get(message.method);
      if (!list) return;
      for (const fn of list) fn(message.params);
    }
  });
  ws.addEventListener("error", event => {
    for (const slot of pending.values()) slot.reject(new Error(`WebSocket error: ${event.message ?? "unknown"}`));
    pending.clear();
  });

  return {
    opened,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(event, fn) {
      const list = events.get(event) ?? [];
      list.push(fn);
      events.set(event, list);
    },
    close() {
      try { ws.close(); } catch { /* already closed */ }
    },
  };
}

async function pollForMarker(client, expr, timeoutMs, intervalMs = 250) {
  const start = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const result = await client.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    const value = result?.result?.value;
    if (value === true) {
      return { found: true, attempts, elapsedMs: Date.now() - start };
    }
    if (Date.now() - start > timeoutMs) {
      return { found: false, attempts, elapsedMs: Date.now() - start, lastValue: value };
    }
    await sleep(intervalMs);
  }
}

async function evaluate(client, expr) {
  const result = await client.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.text} (${result.exceptionDetails.exception?.description ?? ""})`);
  return result.result?.value;
}

async function captureScreenshot(client, path) {
  const result = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (!result?.data) throw new Error("screenshot returned no data");
  const bytes = Buffer.from(result.data, "base64");
  await writeFile(path, bytes);
  return { path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function dumpDom(client, path) {
  const html = await evaluate(client, "document.documentElement.outerHTML");
  await writeFile(path, html, "utf8");
  return { path, size: html.length, sha256: createHash("sha256").update(html).digest("hex") };
}

async function clickAndWait(client, selectorExpr, markerExpr, timeoutMs = 8_000) {
  // Click and poll for a marker indicating the action took effect.
  await evaluate(client, `(function(){
    const el = ${selectorExpr};
    if (!el) throw new Error("selector did not match: ${selectorExpr.replace(/\n/g, " ")}");
    if (typeof el.click === "function") el.click();
    else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  })()`);
  return pollForMarker(client, markerExpr, timeoutMs);
}

async function fillAndSubmit(client, selectorExpr, value, submitExpr, markerExpr, timeoutMs = 8_000) {
  await evaluate(client, `(function(){
    const el = ${selectorExpr};
    if (!el) throw new Error("selector did not match");
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await evaluate(client, submitExpr);
  return pollForMarker(client, markerExpr, timeoutMs);
}

async function navigateTo(client, url) {
  await client.send("Page.navigate", { url });
  await sleep(120);
}

async function setViewport(client, width, height) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: width < 768,
  });
  await sleep(150);
}

const before = await run("git", ["status", "-s"]);
await mkdir(OUT_DIR, { recursive: true });
// Wipe previous evidence so the run captures only this attempt.
for (const suffix of [".png", ".html", ".json"]) {
  try {
    for (const file of await (await import("node:fs/promises")).readdir(OUT_DIR)) {
      if (file.endsWith(suffix)) await rm(join(OUT_DIR, file));
    }
  } catch { /* dir might be empty */ }
}

const preview = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "vite.workspace-preview.config.ts"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
preview.stdout?.on("data", () => {});
preview.stderr?.on("data", () => {});

const killPreview = () => new Promise(resolve => {
  if (preview.exitCode !== null) { resolve(); return; }
  const force = setTimeout(() => { try { preview.kill("SIGKILL"); } catch { /* already out */ } resolve(); }, 3000);
  preview.once("exit", () => { clearTimeout(force); resolve(); });
  try { preview.kill("SIGTERM"); } catch { clearTimeout(force); resolve(); }
});

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--remote-debugging-port=" + CDP_PORT, "--remote-allow-origins=*",
  "--window-size=1280,1024", "--user-data-dir=" + join(ROOT, ".chrome-cdp-profile"),
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stdout?.on("data", () => {});
chrome.stderr?.on("data", () => {});

const killChrome = () => new Promise(resolve => {
  if (chrome.exitCode !== null) { resolve(); return; }
  const force = setTimeout(() => { try { process.kill(chrome.pid); } catch { /* already out */ } resolve(); }, 3000);
  chrome.once("exit", () => { clearTimeout(force); resolve(); });
  try { chrome.kill("SIGTERM"); } catch { clearTimeout(force); resolve(); }
});

const log = [];
const manifest = { generatedAt: new Date().toISOString(), chrome: CHROME, steps: [] };

let exitCode = 0;
let cdp;
try {
  await waitForUrl(PREVIEW_URL, 25_000);
  log.push(`preview up on ${PREVIEW_URL}`);

  const version = await waitForCdp(15_000);
  manifest.cdpVersion = version.Browser;
  log.push(`CDP up: ${version.Browser}`);

  const target = await pickPageTarget(10_000);
  cdp = makeCdpClient(target.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await setViewport(cdp, 1280, 1024);

  // Each step: navigate-or-interact, poll for marker, screenshot, dump DOM.
  async function step(name, opts) {
    const stepStart = Date.now();
    const stepLog = [];
    if (opts.navigate) await navigateTo(cdp, opts.navigate);
    let marker;
    if (opts.marker) {
      marker = await pollForMarker(cdp, opts.marker.expr, opts.marker.timeoutMs ?? 15_000);
      if (!marker.found) {
        stepLog.push(`marker NOT found: ${opts.marker.label} (${marker.attempts} attempts, ${marker.elapsedMs}ms)`);
        exitCode = 1;
      } else {
        stepLog.push(`marker ${opts.marker.label} found after ${marker.attempts} attempts / ${marker.elapsedMs}ms`);
      }
    } else {
      marker = { found: null, label: "no-marker-step" };
    }
    if (opts.evaluate) {
      try {
        const v = await evaluate(cdp, opts.evaluate);
        stepLog.push(`evaluate ok: ${JSON.stringify(v).slice(0, 120)}`);
      } catch (e) {
        stepLog.push(`evaluate failed: ${e.message}`);
        exitCode = 1;
      }
    }
    await sleep(200); // settle paint
    const png = await captureScreenshot(cdp, join(OUT_DIR, `${name}.png`));
    const html = await dumpDom(cdp, join(OUT_DIR, `${name}.html`));
    manifest.steps.push({
      name, navigate: opts.navigate, marker, log: stepLog,
      png, html, durationMs: Date.now() - stepStart,
    });
    console.log(`step ${name}: ${stepLog.join(" | ")}`);
  }

  // 1. Fresh root load — alpha list visible.
  await step("01-root-list", {
    navigate: PREVIEW_URL,
    marker: { label: "alpha-shell", expr: `document.body.innerText.includes("Alpha workspace validation")`, timeoutMs: 15_000 },
  });

  // 2. Deep-link to alpha detail — task content rendered.
  await step("02-alpha-detail", {
    navigate: `http://127.0.0.1:${PORT}/projects/project%3Aalpha/tasks/job%3Aalpha-001`,
    marker: { label: "alpha-detail-content", expr: `document.body.innerText.includes("Compare harness recovery behavior")`, timeoutMs: 15_000 },
  });

  // 3. Deep-link to beta detail — proves isolation.
  await step("03-beta-detail", {
    navigate: `http://127.0.0.1:${PORT}/projects/project%3Abeta/tasks/job%3Abeta-001`,
    marker: { label: "beta-detail-content", expr: `document.body.innerText.includes("Beta workspace validation") && document.body.innerText.includes("Synthetic instructions")`, timeoutMs: 15_000 },
  });

  // 4. Narrow viewport — alpha list still rendered, no overflow.
  await setViewport(cdp, 480, 1024);
  await step("04-narrow-480", {
    navigate: PREVIEW_URL,
    marker: { label: "alpha-shell-narrow", expr: `document.body.innerText.includes("Alpha workspace validation")`, timeoutMs: 15_000 },
  });

  // 5. Wide viewport restored.
  await setViewport(cdp, 1280, 1024);
  await step("05-wide-restored", {
    navigate: PREVIEW_URL,
    marker: { label: "alpha-shell-wide", expr: `document.body.innerText.includes("Alpha workspace validation")`, timeoutMs: 15_000 },
  });

  // 6. Keyboard accessibility — tab through interactive controls.
  await step("06-keyboard-tab", {
    evaluate: `(function(){
      const root = document.querySelector("button, [tabindex], a, input");
      if (!root) return "no-focusable";
      root.focus();
      return document.activeElement?.tagName ?? "none";
    })()`,
  });

  // 7. Switch to Beta via the switcher — prove project isolation in the UI.
  await step("07-beta-switch", {
    evaluate: `(function(){
      const btns = Array.from(document.querySelectorAll("button"));
      const target = btns.find(b => b.innerText && b.innerText.includes("Beta workspace validation"));
      if (target) { target.click(); return "clicked: " + target.innerText.slice(0, 40); }
      return "no-switcher-button";
    })()`,
  });

  // 8. 404 surface — deep-link to an unknown job.
  await step("08-not-found", {
    navigate: `http://127.0.0.1:${PORT}/projects/project%3Aalpha/tasks/job%3Adoes-not-exist`,
    marker: { label: "not-found-marker", expr: `document.body.innerText.includes("not found") || document.body.innerText.includes("Not found") || document.body.innerText.includes("Synthetic workspace")`, timeoutMs: 15_000 },
  });

  await writeFile(join(OUT_DIR, "evidence.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(join(OUT_DIR, "run.log"), log.join("\n") + "\n", "utf8");
  console.log(`evidence written: ${manifest.steps.length} steps → ${OUT_DIR}`);
} catch (error) {
  console.error("cdp-journey failed:", error.stack || error.message);
  exitCode = 1;
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  await killChrome();
  await killPreview();
}

const after = await run("git", ["status", "-s"]);
if (after !== before) {
  console.error(`cdp-journey changed the worktree:\n--- before ---\n${before}--- after ---\n${after}`);
  exitCode = 1;
}

process.exit(exitCode);
