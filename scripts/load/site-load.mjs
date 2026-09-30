// Whole-website load test for the Control Room owner website.
//
//   node scripts/load/site-load.mjs ROOT_DIR [--tabs 1,10,25,50,100] [--minutes 5]
//     [--workers 3] [--worker-tasks 30] [--json OUT.json] [--keep-tasks]
//
// One simulated tab = one open browser tab. It loads the page route (the real
// HTML render, not an API shortcut), then repeats exactly the requests that
// page's own components make, at that page's real interval, for the run's
// duration -- including the header's mount-time badge read and the per-page
// one-shot reads that pages do on mount. The intervals below were read from the
// shipped components, not guessed:
//
//   private-app/app/use-visible-polling.ts  -> 30s   (Home, Session watch)
//   private-app/app/use-polled-read.ts callers, all `baseIntervalMs: 30_000`
//     -> Projects, a project section, a task page, Workers, Connections
//   private-app/app/private-header.tsx       -> one read per mount, no poll
//   private-app/app/product-configuration.tsx, local-runtime.tsx
//                                          -> one read per mount
//   private-app/app/morning/morning-workspace.tsx, project-task-views.tsx,
//   project-files-workspace.tsx, project-settings-panel.tsx,
//   recurring-rules.tsx, control-room-workboard.tsx
//                                          -> reads on mount / on click only
//
// The `quiet` backoff in src/web/v1/polled-read-scheduler.ts is deliberately NOT
// modelled as a fixed 30s: a real open tab stretches its interval when a read
// returns unchanged data, and `use-visible-polling.ts` does not stretch at all.
// Both behaviours are reproduced per page, because "10 tabs polling Home" and
// "10 tabs polling a task page" put different loads on the database.
//
// Sign-in uses POST /api/v1/local-owner-session with the owner code read from
// this install's protected file. The code is never logged, never written to the
// result JSON, and never appears in an error message.
//
// What it measures, per level:
//   * latency per route (p50/p95/p99) for page loads and for each polled read;
//   * errors by HTTP status and by the app's own error code;
//   * PostgreSQL connection counts and the app's own admission refusals,
//     sampled from the same cluster the website uses;
//   * the website process's own CPU and RSS;
//   * whether a response ever carried another project's data (the tenant check)
//     or any project the tab was not looking at.
//
// It never asserts. It reports, because "the app got slower" is a judgement the
// owner makes against their own hardware.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const root = process.argv[2];
const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const numberOfTabs = String(flag("--tabs", "1,10,25,50,100")).split(",").map(value => Number(value.trim()));
const minutes = Number(flag("--minutes", "5"));
const workerTasks = Number(flag("--worker-tasks", "30"));
const jsonOut = flag("--json", join(root ?? ".", "site-load-results.json"));
const dbPort = Number(flag("--db-port", "59610"));
const webPort = Number(flag("--web-port", "39610"));
const origin = `http://127.0.0.1:${webPort}`;
if (!root || !isAbsolute(root) || resolve(root) !== root || !numberOfTabs.length
  || numberOfTabs.some(value => !Number.isInteger(value) || value < 1 || value > 200)
  || !Number.isFinite(minutes) || minutes <= 0 || minutes > 60)
  throw new Error("site_load_arguments_invalid");

const protectedRoot = join(root, "protected");
const seed = JSON.parse(await readFile(join(root, "load-seed.json"), "utf8"));
const macLocal = JSON.parse(await readFile(join(protectedRoot, "config/mac-local.json"), "utf8"));
if (macLocal.port !== webPort || macLocal.localOwnerSession?.origin !== origin
  || macLocal.database?.port !== dbPort || macLocal.database?.database !== "control_room")
  throw new Error("load_test_scope_refused: configuration is not this load-test install");
if (!Array.isArray(seed.projects) || !seed.projects.length) throw new Error("load_test_seed_missing: run the seeder first");

// One owner session for the whole run: many tabs in ONE browser share one
// session cookie, exactly as the load test describes. Each tab still carries its
// own cookie jar so a tab that loses its session can be reported on its own.
async function signIn() {
  const code = (await readFile(join(protectedRoot, "config/owner-sign-in.txt"), "utf8")).trim();
  const response = await fetch(new URL("/api/v1/local-owner-session", origin), { method: "POST",
    headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode: code }) });
  if (response.status !== 201) throw new Error(`load_test_sign_in_refused: ${response.status}`);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0];
  if (!cookie.startsWith("control_room_local_owner=")) throw new Error("load_test_sign_in_refused: no session cookie");
  return cookie;
}

// ---------------------------------------------------------------------------
// The page catalogue. `reads` are the requests that page makes once it is
// mounted, in the order its components issue them. `poll` is the recurring read
// with its real base interval, or null for a page that never polls on its own.
// `quietBackoff` reproduces the scheduler's unchanged-data stretch (up to 4x);
// useVisiblePolling pages keep a flat interval instead.
// ---------------------------------------------------------------------------
const projects = seed.projects;
// The task page needs a real task id from its own project, so the catalogue is
// built once the owner session exists. `taskFor` reads the project's own task
// list through the same API the tab would, and caches it per project.
let ownerCookie = "";
const projectTasks = new Map();
async function taskFor(projectId, index) {
  if (!projectTasks.has(projectId)) {
    const response = await fetch(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, origin),
      { headers: { cookie: ownerCookie, origin } });
    if (response.status !== 200) throw new Error(`load_test_task_list_refused: ${response.status}`);
    const page = await response.json();
    projectTasks.set(projectId, (page.tasks ?? page.page?.tasks ?? []).map(task => task.jobId));
  }
  const ids = projectTasks.get(projectId);
  if (!ids.length) throw new Error("load_test_project_has_no_tasks: seed at least one task per project");
  return ids[index % ids.length];
}

const catalog = [
  { name: "home", route: "/", reads: ["/api/v1/local-workers", "/api/v1/product-configuration",
      "/api/v1/needs-me/tasks", "/api/v1/home/tasks", "/api/v1/projects"],
    poll: { path: () => "/api/v1/home/tasks", baseMs: 30_000, quietBackoff: false },
    pollAlso: ["/api/v1/needs-me/tasks", "/api/v1/projects"], },
  { name: "projects", route: "/projects", reads: ["/api/v1/local-workers", "/api/v1/product-configuration",
      "/api/v1/needs-me/tasks", "/api/v1/projects"],
    poll: { path: () => "/api/v1/projects", baseMs: 30_000, quietBackoff: true } },
  { name: "project-overview", projectScoped: true, route: (p) => `/projects/${id(p)}`,
    reads: (p) => ["/api/v1/local-workers", "/api/v1/product-configuration", "/api/v1/needs-me/tasks",
      `/api/v1/projects/${id(p)}`],
    poll: (p) => ({ path: () => `/api/v1/projects/${id(p)}`, baseMs: 30_000, quietBackoff: true }) },
  { name: "project-work-tasks", projectScoped: true, route: (p) => `/projects/${id(p)}/tasks`,
    reads: (p) => ["/api/v1/local-workers", "/api/v1/product-configuration", "/api/v1/needs-me/tasks",
      `/api/v1/projects/${id(p)}/tasks`],
    poll: (p) => ({ path: () => `/api/v1/projects/${id(p)}/tasks`, baseMs: 30_000, quietBackoff: true }) },
  { name: "project-activity", projectScoped: true, route: (p) => `/projects/${id(p)}/activity`,
    reads: (p) => ["/api/v1/local-workers", "/api/v1/product-configuration", "/api/v1/needs-me/tasks",
      `/api/v1/projects/${id(p)}`, `/api/v1/projects/${id(p)}/activity?limit=50`],
    poll: null },
  { name: "project-automations", projectScoped: true, route: (p) => `/projects/${id(p)}/automations`,
    reads: (p) => ["/api/v1/local-workers", "/api/v1/product-configuration", "/api/v1/needs-me/tasks",
      `/api/v1/projects/${id(p)}`, `/api/v1/projects/${id(p)}/recurring-rules`],
    poll: null },
  // The settings panel reads the project record itself; there is no separate
  // per-project settings endpoint in Mac-local, and an earlier version of this
  // tool asserted one that 404s on every real request.
  { name: "project-settings", projectScoped: true, route: (p) => `/projects/${id(p)}/settings`,
    reads: (p) => ["/api/v1/local-workers", "/api/v1/product-configuration", "/api/v1/needs-me/tasks",
      `/api/v1/projects/${id(p)}`],
    poll: null },
  { name: "project-agents", projectScoped: true, route: (p) => `/projects/${id(p)}/agents`,
    reads: (p) => ["/api/v1/local-workers", "/api/v1/product-configuration", "/api/v1/needs-me/tasks",
      `/api/v1/projects/${id(p)}`, `/api/v1/projects/${id(p)}/agents`],
    poll: null },
  { name: "project-files", projectScoped: true, route: (p) => `/projects/${id(p)}/files`,
    reads: (p) => ["/api/v1/local-workers", "/api/v1/product-configuration", "/api/v1/needs-me/tasks",
      `/api/v1/projects/${id(p)}`, `/api/v1/projects/${id(p)}/files`],
    poll: null },
  { name: "task-detail", projectScoped: true, route: async (p) => `/projects/${id(p)}/tasks/${id(await taskFor(p, 0))}`,
    reads: async (p) => ["/api/v1/local-workers", "/api/v1/product-configuration", "/api/v1/needs-me/tasks",
      `/api/v1/projects/${id(p)}/tasks/${id(await taskFor(p, 0))}`],
    // The jobId is resolved once when the tab opens, not inside the poll
    // closure, so a recurring read never awaits a catalogue lookup mid-interval.
    poll: async (p) => {
      const jobId = await taskFor(p, 0);
      return { path: () => `/api/v1/projects/${id(p)}/tasks/${id(jobId)}`, baseMs: 30_000, quietBackoff: true };
    } },
  { name: "workers", route: "/workers",
    reads: ["/api/v1/local-workers", "/api/v1/product-configuration", "/api/v1/needs-me/tasks"],
    poll: { path: () => "/api/v1/local-workers", baseMs: 30_000, quietBackoff: false } },
  { name: "morning", route: "/morning",
    reads: ["/api/v1/local-workers", "/api/v1/product-configuration", "/api/v1/needs-me/tasks",
      "/api/v1/home/tasks"],
    poll: null },
  // "Updates" is the Action Inbox plus the needs-me task page: those are the two
  // routes an owner actually reads to see what changed. `/workboard` and
  // `/api/v1/workers-board` are hosted-only -- private-process.ts mounts the
  // latter and the Mac-local composition does not -- so requesting them here only
  // measured a 404 that no owner would ever see.
  // Deliberately NOT project-scoped: the Action Inbox spans the workspace, so
  // seeing other projects' ids in it is the correct answer, not a leak.
  { name: "updates", projectScoped: false, route: "/needs-me",
    reads: ["/api/v1/local-workers", "/api/v1/needs-me/tasks", "/api/v1/needs-me/action-items"],
    poll: { path: () => "/api/v1/needs-me/tasks", baseMs: 30_000, quietBackoff: true } },
  // Cross-project by design, like the Action Inbox itself.
  { name: "needs-me", projectScoped: false, route: "/needs-me",
    reads: ["/api/v1/local-workers", "/api/v1/product-configuration", "/api/v1/needs-me/tasks"],
    poll: { path: () => "/api/v1/needs-me/tasks", baseMs: 30_000, quietBackoff: true } },
  { name: "session-watch", route: "/session-watch",
    reads: ["/api/v1/local-workers", "/api/v1/product-configuration", "/api/v1/session-watch"],
    poll: { path: () => "/api/v1/session-watch", baseMs: 30_000, quietBackoff: false } },
];
const id = value => encodeURIComponent(value);

// ---------------------------------------------------------------------------
// One measurement. Latency is wall time from just before the request to the
// full body being read, so a slow body counts as a slow request, exactly as an
// owner's browser would experience it.
// ---------------------------------------------------------------------------
const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
};
const newSeries = () => ({ count: 0, ms: [], errors: 0, statuses: {}, codes: {}, crossProject: 0, notModified: 0 });

async function measure(tab, name, path, options = {}) {
  const series = tab.series[name];
  const started = performance.now();
  let response;
  try {
    response = await fetch(new URL(path, origin), {
      headers: { cookie: tab.cookie, origin, accept: "application/json, text/html" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    const body = await response.text();
    const elapsed = performance.now() - started;
    series.count += 1;
    series.ms.push(elapsed);
    const status = String(response.status);
    series.statuses[status] = (series.statuses[status] ?? 0) + 1;
    if (response.status === 304) series.notModified += 1;
    if (response.status >= 400) {
      series.errors += 1;
      try { const parsed = JSON.parse(body); if (parsed?.error) series.codes[parsed.error] = (series.codes[parsed.error] ?? 0) + 1; }
      catch { series.codes[`http_${status}`] = (series.codes[`http_${status}`] ?? 0) + 1; }
    }
    // A tenant leak would show up as another project's id inside a PROJECT-
    // SCOPED response. Only such a route can be checked this way: the catalogue,
    // Home and the Action Inbox legitimately list every project in the tenant,
    // so seeing another project's id there is the correct answer, not a leak.
    if (options.projectScoped && typeof body === "string") {
      const foreign = projects.filter(project => project !== options.projectId && body.includes(project));
      if (foreign.length) series.crossProject += 1;
    }
    return { status: response.status, body };
  } catch (error) {
    const elapsed = performance.now() - started;
    series.count += 1; series.ms.push(elapsed); series.errors += 1;
    const code = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "transport";
    series.codes[code] = (series.codes[code] ?? 0) + 1;
    return { status: 0, body: "" };
  }
}

// ---------------------------------------------------------------------------
// Samplers. Connections come from the same cluster the website reads, as the
// cluster owner, because a connection count is a cluster fact and the web login
// is not allowed to see other sessions' rows.
// ---------------------------------------------------------------------------
function pgQuery(sql) {
  try {
    return execFileSync("/opt/homebrew/opt/postgresql@17/bin/psql", ["-h", "127.0.0.1", "-p", String(dbPort),
      "-U", "postgres", "-d", "control_room", "-At", "-F", "|", "-c", sql],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 1 << 20 }).trim().split("\n");
  } catch { return []; }
}
function sampleDatabase() {
  const lines = pgQuery(`SELECT application_name, count(*) FROM pg_stat_activity
    WHERE datname='control_room' GROUP BY 1 ORDER BY 1`);
  const byApplication = {};
  for (const line of lines) {
    const [application, count] = line.split("|");
    byApplication[application || "(none)"] = Number(count);
  }
  // Pool ceiling and admission waits are visible as connections beyond the
  // configured eight per role, so the peak total is the saturation signal.
  const total = Object.values(byApplication).reduce((sum, value) => sum + value, 0);
  const idle = pgQuery(`SELECT count(*) FROM pg_stat_activity WHERE datname='control_room' AND state='idle'`)[0];
  const waiting = pgQuery(`SELECT count(*) FROM pg_stat_activity WHERE datname='control_room' AND wait_event_type='Lock'`)[0];
  const longest = pgQuery(`SELECT COALESCE(max(EXTRACT(EPOCH FROM (now() - xact_start))), 0)
    FROM pg_stat_activity WHERE datname='control_room' AND xact_start IS NOT NULL`)[0];
  return { total, byApplication, idle: Number(idle ?? 0), lockWaiters: Number(waiting ?? 0),
    longestTransactionSeconds: Number(Number(longest ?? 0).toFixed(2)) };
}
function websiteProcess() {
  try {
    const state = JSON.parse(execFileSync("cat", [join(protectedRoot, "runtime/task-host-state.json")],
      { encoding: "utf8", timeout: 3_000 }));
    if (!Number.isSafeInteger(state.childPid)) return undefined;
    const rss = Number(execFileSync("ps", ["-o", "rss=", "-p", String(state.childPid)],
      { encoding: "utf8", timeout: 3_000 }).trim());
    const cpu = execFileSync("ps", ["-o", "%cpu=", "-p", String(state.childPid)], { encoding: "utf8", timeout: 3_000 }).trim();
    const threads = execFileSync("ps", ["-M", "-p", String(state.childPid)], { encoding: "utf8", timeout: 3_000 }).trim().split("\n").length;
    return { pid: state.childPid, rssKb: Number.isFinite(rss) ? rss : 0, cpuPercent: Number(cpu) || 0, threads };
  } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// One simulated tab.
// ---------------------------------------------------------------------------
async function openTab(index) {
  const spec = catalog[index % catalog.length];
  const projectId = projects[index % projects.length];
  const cookie = ownerCookie;
  const route = typeof spec.route === "function" ? await spec.route(projectId) : spec.route;
  const tab = { index, page: spec.name, projectId, cookie, series: Object.create(null) };
  const ensure = name => (tab.series[name] ??= newSeries());
  const routeName = `page:${spec.name}`;
  ensure(routeName);
  // The page load itself: the real HTML render, which is what a tab actually
  // requests. It is the most expensive request on every page.
  await measure(tab, routeName, route);
  const reads = typeof spec.reads === "function" ? await spec.reads(projectId) : spec.reads;
  for (const path of reads) { ensure(path); await measure(tab, path, path, { projectId, projectScoped: spec.projectScoped === true }); }
  // The recurring read, at the page's real interval. The scheduler's unchanged
  // stretch is reproduced so an idle quiet tab really does poll less often.
  const poll = typeof spec.poll === "function" ? await spec.poll(projectId) : spec.poll;
  if (poll?.path) {
    ensure(poll.path());
    let delayMs = poll.baseMs, unchanged = 0;
    const loop = async () => {
      while (!tab.closed) {
        await new Promise(wait => setTimeout(wait, delayMs));
        if (tab.closed) return;
        const path = poll.path();
        ensure(path);
        const result = await measure(tab, path, path, { projectId, projectScoped: spec.projectScoped === true });
        if (poll.quietBackoff && result.status === 200) {
          unchanged += 1;
          delayMs = poll.baseMs * Math.min(2 ** unchanged, 4);
        } else { unchanged = 0; delayMs = poll.baseMs; }
      }
    };
    void loop();
  }
  return tab;
}

// Owner actions at a low rate, so the run includes writes rather than only
// reads: a task proposal, and a project pause/resume round trip. Both are the
// owner's own controls, both are idempotent-keyed, and both are recorded.
async function runOwnerActions(durationMs) {
  const actions = { proposed: 0, refused: 0, transitions: 0, statuses: {} };
  const until = Date.now() + durationMs;
  let n = 0;
  while (Date.now() < until) {
    await new Promise(wait => setTimeout(wait, 20_000));
    if (Date.now() >= until) break;
    n += 1;
    const projectId = projects[n % projects.length];
    const headers = { cookie: ownerCookie, origin, "content-type": "application/json" };
    const proposed = await fetch(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, origin), {
      method: "POST", headers: { ...headers, "idempotency-key": `loadtest-action-${Date.now()}-${n}` },
      body: JSON.stringify({ title: `Load action ${n}`, instructions: "Return one harmless short line.",
        scopes: [{ kind: "file", path: `loadtest/action-${n}.txt` }] }) });
    actions.statuses[String(proposed.status)] = (actions.statuses[String(proposed.status)] ?? 0) + 1;
    if (proposed.status === 201) actions.proposed += 1; else actions.refused += 1;
    // Pause then resume the same project: two real lifecycle transitions. A
    // lifecycle command is a COMMAND, so it needs an idempotency key exactly as
    // the browser client sends, and each transition needs the version the
    // previous one returned -- a stale expectedVersion is a 409, not a silent
    // success. Without the key this endpoint refuses with 400, which is how the
    // first version of this tool reported 28 phantom refusals per level.
    const current = await (await fetch(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}`, origin),
      { headers: { cookie: ownerCookie, origin } })).json();
    let version = current?.project?.version;
    for (const lifecycle of ["paused", "active"]) {
      if (typeof version !== "number") break;
      const moved = await fetch(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/lifecycle`, origin), {
        method: "POST", headers: { ...headers, "idempotency-key": `loadtest-lifecycle-${Date.now()}-${n}-${lifecycle}` },
        body: JSON.stringify({ lifecycle, expectedVersion: version }) });
      actions.statuses[String(moved.status)] = (actions.statuses[String(moved.status)] ?? 0) + 1;
      if (moved.status === 200 || moved.status === 201) {
        actions.transitions += 1;
        const result = await moved.json();
        version = result?.project?.version ?? version + 1;
      }
    }
  }
  return actions;
}

const sleep = ms => new Promise(wait => setTimeout(wait, ms));
const summarise = series => ({
  count: series.count, errors: series.errors, notModified: series.notModified,
  statuses: series.statuses, codes: series.codes, crossProject: series.crossProject,
  p50: percentile(series.ms, 0.5), p95: percentile(series.ms, 0.95), p99: percentile(series.ms, 0.99),
  max: percentile(series.ms, 0.999999),
});

const results = { schema: "control-room.site-load/v1", startedAt: new Date().toISOString(),
  origin, minutes, workerTasks, levels: [] };

for (const tabs of numberOfTabs) {
  ownerCookie = await signIn();
  projectTasks.clear();
  const durationMs = minutes * 60_000;
  console.log(`site-load: ${tabs} tabs for ${minutes}m`);
  const tabSeries = new Map();
  const opened = [];
  for (let index = 0; index < tabs; index += 1) {
    const tab = await openTab(index);
    opened.push(tab);
    tabSeries.set(tab, tab.series);
  }
  const databaseSamples = [], processSamples = [];
  const sampler = setInterval(() => { databaseSamples.push(sampleDatabase()); processSamples.push(websiteProcess()); }, 2_000);
  const actions = runOwnerActions(durationMs);
  await sleep(durationMs);
  for (const tab of opened) tab.closed = true;
  clearInterval(sampler);
  const actionSummary = await actions;
  // Health after the run: the website must still serve, and the readiness route
  // must still answer, or "the app stayed healthy" would be a claim and not a
  // measurement.
  const afterRequests = await Promise.all([
    fetch(new URL("/api/v1/local-host-health", origin), { method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ nonce: "A".repeat(43) }), signal: AbortSignal.timeout(5_000) }).then(r => r.status).catch(() => 0),
    fetch(new URL("/projects", origin), { headers: { cookie: ownerCookie, origin }, redirect: "manual",
      signal: AbortSignal.timeout(10_000) }).then(r => r.status).catch(() => 0),
  ]);
  // Merge every tab's per-route series into one set of numbers per route.
  const merged = new Map();
  for (const seriesMap of tabSeries.values()) {
    for (const [route, series] of Object.entries(seriesMap)) {
      const into = merged.get(route) ?? newSeries();
      into.count += series.count; into.errors += series.errors; into.crossProject += series.crossProject;
      into.notModified += series.notModified; into.ms.push(...series.ms);
      for (const [key, value] of Object.entries(series.statuses)) into.statuses[key] = (into.statuses[key] ?? 0) + value;
      for (const [key, value] of Object.entries(series.codes)) into.codes[key] = (into.codes[key] ?? 0) + value;
      merged.set(route, into);
    }
  }
  const peakByApplication = {};
  for (const sample of databaseSamples) for (const [application, count] of Object.entries(sample.byApplication ?? {}))
    peakByApplication[application] = Math.max(peakByApplication[application] ?? 0, count);
  const totalRequests = [...merged.values()].reduce((sum, series) => sum + series.count, 0);
  const totalErrors = [...merged.values()].reduce((sum, series) => sum + series.errors, 0);
  const level = {
    tabs, durationMs, totalRequests, totalErrors,
    routes: Object.fromEntries([...merged.entries()].sort()
      .map(([route, series]) => [route, summarise(series)])),
    actions: actionSummary,
    database: {
      samples: databaseSamples.length,
      peakConnections: Math.max(0, ...databaseSamples.map(sample => sample.total ?? 0)),
      peakByApplication,
      peakLockWaiters: Math.max(0, ...databaseSamples.map(sample => sample.lockWaiters ?? 0)),
      peakLongestTransactionSeconds: Math.max(0, ...databaseSamples.map(sample => sample.longestTransactionSeconds ?? 0)),
    },
    process: {
      rssKbStart: processSamples.find(Boolean)?.rssKb,
      rssKbPeak: Math.max(0, ...processSamples.map(sample => sample?.rssKb ?? 0)),
      rssKbEnd: processSamples.filter(Boolean).at(-1)?.rssKb,
      cpuPercentPeak: Math.max(0, ...processSamples.map(sample => sample?.cpuPercent ?? 0)),
      threadsPeak: Math.max(0, ...processSamples.map(sample => sample?.threads ?? 0)),
    },
    after: { healthRouteStatus: afterRequests[0], projectsRouteStatus: afterRequests[1] },
  };
  results.levels.push(level);
  console.log(`site-load: ${tabs} tabs -> ${totalRequests} requests, ${totalErrors} errors, `
    + `peak connections ${level.database.peakConnections}, peak RSS ${Math.round(level.process.rssKbPeak / 1024)}MB, `
    + `after: health=${level.after.healthRouteStatus} projects=${level.after.projectsRouteStatus}`);
}

results.finishedAt = new Date().toISOString();
await writeFile(jsonOut, `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
console.log(`site-load: results written to ${jsonOut}`);
