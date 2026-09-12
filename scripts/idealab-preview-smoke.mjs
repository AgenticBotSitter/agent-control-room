// Repeatable preview smoke check for the Idea Lab browser fixture.
// Starts vite on the fixture config, asserts the page + transformed entry
// serve over loopback, then kills the server and proves the port is freed
// and no tracked file changed. Usage: node scripts/idealab-preview-smoke.mjs
// Must run from the checkout root. No dependencies beyond node.

import { spawn, execFile } from "node:child_process";

const PORT = 4176;
const ROOT = new URL("..", import.meta.url);
const TIMEOUT_MS = 30_000;

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd: ROOT }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || error.message}`));
    else resolve(stdout);
  });
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor200(url, timeoutMs) {
  const start = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const response = await fetch(url);
      if (response.ok) return { attempts, status: response.status, body: await response.text() };
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`preview did not serve ${url} within ${timeoutMs}ms`);
    await sleep(500);
  }
}

async function waitForRefused(url, timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      await fetch(url);
    } catch (error) {
      if (String(error).includes("ECONNREFUSED") || String(error.cause || "").includes("ECONNREFUSED")) return true;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`port ${PORT} still serves after kill`);
    await sleep(500);
  }
}

const before = await run("git", ["status", "-s"]);
const child = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "vite.idealab-preview.config.ts"],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout?.on("data", chunk => { output += String(chunk); });
child.stderr?.on("data", chunk => { output += String(chunk); });

const kill = () => new Promise(resolve => {
  if (child.exitCode !== null) { resolve(); return; }
  const force = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already out */ } resolve(); }, 5000);
  child.once("exit", () => { clearTimeout(force); resolve(); });
  try { child.kill("SIGTERM"); } catch { clearTimeout(force); resolve(); }
});

try {
  const page = await waitFor200(`http://127.0.0.1:${PORT}/`, TIMEOUT_MS);
  // The React tree renders client-side, so the static entry must carry the
  // fixture title and the module script; the transformed entry proves the
  // vite pipeline serves the fixture code.
  if (!page.body.includes("<title>Idea Lab disposable browser validation</title>")
    || !page.body.includes('src="/main.tsx"')) {
    throw new Error("preview root does not serve the fixture entry");
  }
  const entry = await waitFor200(`http://127.0.0.1:${PORT}/main.tsx`, TIMEOUT_MS);
  if (entry.body.length < 1000) throw new Error(`transformed entry suspiciously small: ${entry.body.length} bytes`);
  console.log(`preview ok: pid=${child.pid} root=${page.status}/${page.body.length}b entry=${entry.status}/${entry.body.length}b polls=${page.attempts}`);
} finally {
  await kill();
}

await waitForRefused(`http://127.0.0.1:${PORT}/`, 10_000);
const after = await run("git", ["status", "-s"]);
if (after !== before) throw new Error(`preview run changed the worktree:\n--- before ---\n${before}--- after ---\n${after}`);
console.log(`cleanup ok: port ${PORT} freed, worktree unchanged`);
