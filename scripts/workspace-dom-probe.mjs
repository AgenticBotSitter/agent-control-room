// Standalone browser-DOM probe. Boots vite, dumps via headless Chrome,
// prints markers, tears down. Used while iterating on the chrome-dom
// driver; not part of the regular test lane.
import { spawn, execFile } from "node:child_process";
const PORT = 4175;
const URL = `http://127.0.0.1:${PORT}/`;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const child = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "vite.workspace-preview.config.ts"], { stdio: ["ignore", "pipe", "pipe"] });
const kill = () => new Promise(r => { try { child.kill("SIGTERM"); } catch {} setTimeout(r, 500); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

for (let i = 0; i < 30; i++) {
  try { const r = await fetch(URL); if (r.ok) break; } catch {}
  await sleep(300);
}
console.log("preview up");

const args = [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--window-size=1280,1024", "--virtual-time-budget=30000",
  "--run-all-compositor-stages-before-draw", "--dump-dom", URL,
];
const dom = await new Promise((resolve, reject) => {
  execFile(CHROME, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error(stderr || err.message)); else resolve(stdout);
  });
});
console.log(`dom size: ${dom.length}`);
for (const m of ["job:alpha-001", "Synthetic workspace", "Alpha workspace validation", "private-main", "private-shell", "Beta workspace validation", "Loading protected tasks"]) {
  console.log(`  ${m}: ${dom.includes(m)}`);
}

const args2 = [
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--window-size=1280,1024", "--virtual-time-budget=30000",
  "--run-all-compositor-stages-before-draw", "--dump-dom",
  `http://127.0.0.1:${PORT}/projects/project%3Aalpha/tasks/job%3Aalpha-001`,
];
const dom2 = await new Promise((resolve, reject) => {
  execFile(CHROME, args2, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error(stderr || err.message)); else resolve(stdout);
  });
});
console.log(`detail dom size: ${dom2.length}`);
for (const m of ["Compare harness recovery behavior", "Recorded review", "Synthetic review"]) {
  console.log(`  ${m}: ${dom2.includes(m)}`);
}

await kill();
process.exit(0);
