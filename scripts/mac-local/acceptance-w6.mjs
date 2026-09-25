#!/usr/bin/env node
// W6 acceptance against the real running Mac-local site. Exit 0 only if every check passes.
// Usage: node scripts/mac-local/acceptance-w6.mjs --protected-root ABS_PATH [--origin URL] [--restart]
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const origin = opt("--origin", "http://127.0.0.1:3210");
const protectedRoot = opt("--protected-root", process.env.CONTROL_ROOM_PROTECTED_ROOT);
const restart = args.includes("--restart");
if (!protectedRoot || !isAbsolute(protectedRoot)) {
  console.error("usage: --protected-root ABSOLUTE_PATH (or CONTROL_ROOM_PROTECTED_ROOT)");
  process.exit(2);
}
const ownerCode = readFileSync(join(protectedRoot, "config/owner-sign-in.txt"), "utf8").trim();

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); return ok; };
const call = (path, init = {}) => fetch(new URL(path, origin), {
  redirect: "manual", signal: AbortSignal.timeout(5_000), ...init,
});
const post = (path, body, extra = {}) => call(path, { method: "POST",
  headers: { "content-type": "application/json", origin, ...extra }, body: JSON.stringify(body) });

async function signIn() {
  const res = await post("/api/v1/local-owner-session", { ownerCode });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";", 1)[0];
  return { status: res.status, cookie };
}

async function waitForSite(seconds) {
  for (let i = 0; i < seconds; i++) {
    try { if ((await call("/session")).status === 200) return true; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

const reachable = await waitForSite(5);
if (!check("site reachable on loopback", reachable, origin)) process.exit(1);

const wrong = await post("/api/v1/local-owner-session", { ownerCode: `${ownerCode}x` });
check("wrong owner code refused", wrong.status >= 400 && !wrong.headers.get("set-cookie"), `status ${wrong.status}`);

const anon = await call("/api/v1/projects");
check("projects refused without session", anon.status === 401 || anon.status === 403, `status ${anon.status}`);

const forged = await post("/api/v1/local-owner-session", { ownerCode }, { origin: "http://evil.example" });
check("sign-in refused from foreign origin", forged.status >= 400 && !forged.headers.get("set-cookie"), `status ${forged.status}`);

let session = await signIn();
check("owner sign-in issues session", session.status === 201 && session.cookie.startsWith("control_room_local_owner="), `status ${session.status}`);

const workers = await call("/api/v1/local-workers", { headers: { cookie: session.cookie } });
let workerSummary = `status ${workers.status}`;
if (workers.ok) workerSummary = JSON.stringify((await workers.json()).workers ?? []).slice(0, 400);
check("worker readiness readable", workers.ok, workerSummary);

const key = randomUUID();
const title = `W6 acceptance ${new Date().toISOString()}`;
const created = await post("/api/v1/projects", { title, summary: "Created by acceptance-w6." }, { cookie: session.cookie, "idempotency-key": key });
const createdText = await created.text();
const projectId = /"projectId"\s*:\s*"(project:[^"]+)"/.exec(createdText)?.[1];
check("project created", created.status === 201 && Boolean(projectId), `status ${created.status}${projectId ? ` ${projectId}` : ""}`);

const replay = await post("/api/v1/projects", { title, summary: "Created by acceptance-w6." }, { cookie: session.cookie, "idempotency-key": key });
const replayId = /"projectId"\s*:\s*"(project:[^"]+)"/.exec(await replay.text())?.[1];
check("create replay is idempotent", replay.status === 200 && replayId === projectId, `status ${replay.status}`);

const readBack = async cookie => projectId
  ? call(`/api/v1/projects/${encodeURIComponent(projectId)}`, { headers: { cookie } }) : { status: 0 };
check("project readable", (await readBack(session.cookie)).status === 200);

if (restart) {
  try {
    const bounded = { stdio: "inherit", timeout: 90_000, killSignal: "SIGKILL" };
    execFileSync("pnpm", ["mac:down"], bounded);
    execFileSync("pnpm", ["mac:up"], bounded);
    check("mac:down then mac:up ran", true);
  } catch (error) { check("mac:down then mac:up ran", false, String(error.message).split("\n")[0]); }
  check("site back within 90 s", await waitForSite(90));
  session = await signIn();
  check("sign-in after restart", session.status === 201, `status ${session.status}`);
  check("project survived restart", (await readBack(session.cookie)).status === 200, projectId ?? "no project");
} else {
  console.log("SKIP restart survival (pass --restart once mac:up/mac:down exist)");
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${failed === 0 ? "W6 ACCEPTANCE: PASS" : `W6 ACCEPTANCE: FAIL (${failed} failed)`}${restart ? "" : " (restart not checked)"}`);
process.exit(failed === 0 && restart ? 0 : failed === 0 ? 3 : 1);
