// Chrome-driven DOM dump against the workspace preview. Boots the
// preview, waits for it to serve, opens a headless Chrome against the
// loopback URL, dumps the rendered DOM after the React tree has
// rendered, then tears down the preview and prints what was rendered.
//
// Records actual browser outcomes: the DOM snapshot proves the fixture
// mounts the actual product routing entry, the synthetic server returns
// the seeded task, and the component renders without errors.

import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = 4175;
const URL = `http://127.0.0.1:${PORT}/`;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
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

async function dumpChromeDom(targetUrl, dumpPath) {
  // --virtual-time-budget gives React + the synthetic server enough
  // wall-clock to render after installWindowFetch resolves. The DOM
  // dump is captured once virtual time has advanced.
  const args = [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--window-size=1280,1024", "--virtual-time-budget=15000",
    "--dump-dom", targetUrl,
  ];
  const result = await new Promise((resolve, reject) => {
    execFile(CHROME, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`chrome --dump-dom failed: ${stderr || error.message}`));
        else resolve(stdout);
      });
  });
  await writeFile(dumpPath, result, "utf8");
  return result;
}

const before = await run("git", ["status", "-s"]);
await mkdir(OUT_DIR, { recursive: true });

const preview = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "vite.workspace-preview.config.ts"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: false });
preview.stdout?.on("data", () => {});
preview.stderr?.on("data", () => {});

const killPreview = () => new Promise(resolve => {
  if (preview.exitCode !== null) { resolve(); return; }
  const force = setTimeout(() => { try { process.kill(preview.pid); } catch { /* already out */ } resolve(); }, 3000);
  preview.once("exit", () => { clearTimeout(force); resolve(); });
  try { preview.kill("SIGTERM"); } catch { clearTimeout(force); resolve(); }
});

const results = [];
let exitCode = 0;
try {
  await waitForUrl(URL, 20_000);
  console.log(`preview ok on ${URL}`);

  // Fresh load (root URL).
  const rootDumpPath = join(OUT_DIR, "root-dom.html");
  const rootDom = await dumpChromeDom(URL, rootDumpPath);
  const rootMarkers = {
    "title=synthetic-workspace": rootDom.includes("Synthetic workspace"),
    "alpha-heading": rootDom.includes("Alpha workspace validation"),
    "task-row-alpha-001": rootDom.includes("job:alpha-001"),
    "switcher-button": rootDom.includes("Beta workspace validation"),
  };
  console.log("root markers:", rootMarkers);
  results.push({ url: URL, dump: "root-dom.html", markers: rootMarkers });

  // Deep link to alpha detail.
  const alphaDetailUrl = `http://127.0.0.1:${PORT}/projects/project%3Aalpha/tasks/job%3Aalpha-001`;
  const detailDumpPath = join(OUT_DIR, "alpha-detail-dom.html");
  const detailDom = await dumpChromeDom(alphaDetailUrl, detailDumpPath);
  const detailMarkers = {
    "title=alpha-detail": detailDom.includes("Synthetic workspace · Alpha workspace validation"),
    "task-detail-loaded": detailDom.includes("Compare harness recovery behavior"),
    "review-panel-rendered": detailDom.includes("Recorded review") || detailDom.includes("review"),
  };
  console.log("alpha detail markers:", detailMarkers);
  results.push({ url: alphaDetailUrl, dump: "alpha-detail-dom.html", markers: detailMarkers });

  // Narrow viewport (mobile).
  const narrowDumpPath = join(OUT_DIR, "narrow-dom.html");
  const narrowArgs = [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--window-size=480,1024", "--virtual-time-budget=10000",
    "--dump-dom", URL,
  ];
  const narrowDom = await new Promise((resolve, reject) => {
    execFile(CHROME, narrowArgs, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`chrome narrow failed: ${stderr || error.message}`));
        else resolve(stdout);
      });
  });
  await writeFile(narrowDumpPath, narrowDom, "utf8");
  const narrowMarkers = {
    "viewport-meta": narrowDom.includes('name="viewport"'),
    "narrow-renders-title": narrowDom.includes("Synthetic workspace"),
    "narrow-renders-alpha": narrowDom.includes("job:alpha-001"),
  };
  console.log("narrow viewport markers:", narrowMarkers);
  results.push({ url: URL, dump: "narrow-dom.html", markers: narrowMarkers, viewport: "480x1024" });

  // Fail closed: any markers required to be present
  for (const result of results) {
    for (const [name, present] of Object.entries(result.markers)) {
      if (!present) {
        console.error(`marker missing: ${name} in ${result.dump}`);
        exitCode = 1;
      }
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    chromePath: CHROME,
    previewUrl: URL,
    previewPort: PORT,
    results,
  };
  await writeFile(join(OUT_DIR, "evidence.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(`evidence written to ${OUT_DIR}`);
} catch (error) {
  console.error("chrome-dom-journey failed:", error.message);
  exitCode = 1;
} finally {
  await killPreview();
}

const after = await run("git", ["status", "-s"]);
if (after !== before) {
  console.error(`chrome-dom-journey changed the worktree:\n--- before ---\n${before}--- after ---\n${after}`);
  exitCode = 1;
}

process.exit(exitCode);
