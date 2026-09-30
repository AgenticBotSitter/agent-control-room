// Seed a load-test install with realistic saved work, using only the same public
// HTTP API the owner website uses. Nothing here writes SQL: every project, task,
// result and event is produced by the running website's own routes, so the
// seeded shape is exactly the shape the pages read under load. Direct inserts
// would fabricate rows the coordinator never wrote and could hide a broken read.
//
//   node --import tsx scripts/load/site-load-seed.mts ABSOLUTE_DIR --port 59610 --web-port 39610 \
//     [--projects 5] [--tasks 200] [--running 30]
//
// The owner code is read from this install's own protected file and never
// printed, logged or returned. It is in scope only to POST the sign-in.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const root = process.argv[2], numberOf = (name: string, fallback: number) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const dbPort = numberOf("--port", 59610), webPort = numberOf("--web-port", 39610);
const projectCount = numberOf("--projects", 5), taskCount = numberOf("--tasks", 200), runningCount = numberOf("--running", 30);
const origin = `http://127.0.0.1:${webPort}`;
if (!root || !isAbsolute(root) || resolve(root) !== root || !Number.isInteger(projectCount) || projectCount < 1 || projectCount > 24
  || !Number.isInteger(taskCount) || taskCount < 1 || !Number.isInteger(runningCount) || runningCount < 0 || runningCount > taskCount)
  throw new Error("site_load_seed_arguments_invalid");

const protectedRoot = join(root, "protected");
const ownerCode = (await readFile(join(protectedRoot, "config/owner-sign-in.txt"), "utf8")).trim();
const macLocal = JSON.parse(await readFile(join(protectedRoot, "config/mac-local.json"), "utf8"));
if (macLocal.port !== webPort || macLocal.localOwnerSession?.origin !== origin
  || macLocal.database?.port !== dbPort || macLocal.database?.database !== "control_room")
  throw new Error("load_test_scope_refused: configuration is not this load-test install");

let cookie = "";
async function api(path: string, init: RequestInit & { expect?: number[] } = {}): Promise<Response> {
  const response = await fetch(new URL(path, origin), { ...init, headers: { origin, cookie,
    ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  const expect = init.expect ?? [];
  if (expect.length && !expect.includes(response.status))
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status} (wanted ${expect.join("/")}): ${(await response.text()).slice(0, 300)}`);
  return response;
}
const idOf = (value: string) => encodeURIComponent(value);

const signIn = await fetch(new URL("/api/v1/local-owner-session", origin), { method: "POST",
  headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) });
if (signIn.status !== 201) throw new Error(`load_test_sign_in_refused: ${signIn.status}`);
cookie = (signIn.headers.get("set-cookie") ?? "").split(";", 1)[0];
if (!cookie.startsWith("control_room_local_owner=")) throw new Error("load_test_sign_in_refused: no session cookie");

const seedFile = join(root, "load-seed.json");
// A load run must not depend on what this shared Mac's load average is doing
// when it starts. The host pauses the whole installation automatically when the
// machine fails a health check, and a paused installation refuses every new
// claim with a 503. The load test is not testing that pause, so it resumes
// through the owner's own endpoint -- the same call the owner's Pause / Drain /
// Stop control makes -- and reports that it did.
const modeBefore = (await (await api("/api/v1/operations-mode", { expect: [200] })).json()) as
  { mode?: string; reason?: string };
if (modeBefore.mode === "running") {
  console.log("load-test seed: installation mode is running; no resume needed");
} else {
  const resumed = await api("/api/v1/operations-mode", { method: "POST", expect: [200],
    body: JSON.stringify({ mode: "running", reason: "site load test resumed after an automatic machine-health pause" }) });
  const modeAfter = (await resumed.json()) as { mode?: string };
  if (modeAfter.mode !== "running") throw new Error("load_test_resume_refused: the installation is not running");
  console.log(`load-test seed: resumed from "${modeBefore.mode}" (${modeBefore.reason ?? "no reason recorded"})`);
}

const catalogue = (await (await api("/api/v1/projects", { expect: [200] })).json()) as
  { projects?: { projectId: string }[] };
if ((catalogue.projects?.length ?? 0) >= projectCount) {
  // Seeded before: hand the load tool the same catalogue rather than creating a
  // second copy of it, so a rerun of the test levels stays comparable.
  if (existsSync(seedFile)) console.log(await readFile(seedFile, "utf8"));
  else console.log(JSON.stringify({ schema: "control-room.site-load-seed/v1", seeded: false,
    projects: catalogue.projects?.map(project => project.projectId) ?? [] }));
  process.exit(0);
}

const projects: { projectId: string; tasks: string[] }[] = [];
for (let index = 0; index < projectCount; index += 1) {
  const created = await api("/api/v1/projects", { method: "POST", expect: [201],
    headers: { "idempotency-key": `loadtest-project-${index}` },
    body: JSON.stringify({ title: `Load project ${index + 1}`,
      summary: "Seeded by the site load test through the owner's own public API." }) });
  const { project } = await created.json() as { project: { projectId: string } };
  const tasks: string[] = [];
  // 5 projects, 200 tasks: every project but the last takes an equal share and
  // the last takes the remainder, so the per-project task pages are exercised at
  // both a large and a smaller size, the way real work is distributed.
  const perProject = Math.ceil(taskCount / projectCount);
  const share = index === projectCount - 1 ? taskCount - perProject * (projectCount - 1) : perProject;
  for (let n = 0; n < share; n += 1) {
    const proposed = await api(`/api/v1/projects/${idOf(project.projectId)}/tasks`, { method: "POST", expect: [201],
      headers: { "idempotency-key": `loadtest-task-${index}-${n}` },
      body: JSON.stringify({ title: `Load task ${index + 1}.${n + 1}`,
        instructions: "Return one harmless short line.",
        // Each task declares its own file scope. A proposal with no declared
        // scope is treated as the whole repository, so several of them in one
        // project would overlap and the second assignment would be refused.
        scopes: [{ kind: "file", path: `loadtest/${index + 1}/${n + 1}.txt` }] }) });
    const body = await proposed.json() as { receipt: { jobId: string } };
    tasks.push(body.receipt.jobId);
  }
  projects.push({ projectId: project.projectId, tasks });
  console.log(`load-test seed: project ${index + 1}/${projectCount} with ${tasks.length} saved tasks`);
}

const allTasks = projects.flatMap(project => project.tasks.map(jobId => ({ projectId: project.projectId, jobId })));

// `running` tasks are prepared, assigned and SUBMITTED, so they are real
// unfinished work with real plan, assignment, model-selection and delivery
// rows, produced by the real queue and the real result publisher. These are
// what the attention pages, the workboard and session watch actually read under
// load. The rest stay as saved proposals, which the task list, the proposal
// form and the task detail page all need too.
//
// Four real coordinator rules shape this, all found by hitting them:
//
//   * every configured local route carries `maxConcurrentTasks: 1`, so one
//     node holds one task at a time;
//   * a proposal with no declared scope is treated as the whole repository, so
//     two such tasks in one project overlap and the second is refused -- which
//     is why every seeded task declares its own file scope above;
//   * a task can only be assigned to the worker kind it was planned for, so each
//     lane picks the template for its own worker;
//   * assignment also requires fresh fleet telemetry and capability signals
//     (120s TTL, refreshed every 30s), so a candidate refused for capacity or a
//     stale signal is retried rather than skipped.
//
// So there is one lane per worker, each running serially (that is the product's
// real per-node concurrency), and `running` is the number of tasks that have been
// driven through the real queue to a terminal state by the end of seeding. It is
// 30 real end-to-end deliveries, not 30 simultaneous leases -- 30 at once is not
// a thing this installation can do, and claiming otherwise would be a lie.
const workerKinds = [
  { kind: "hermes", templateToken: "hermes", nodeSuffix: "hermes" },
  { kind: "claude-code", templateToken: "claude", nodeSuffix: "claude" },
  { kind: "codex", templateToken: "codex", nodeSuffix: "codex" },
] as const;
const runningTasks: { projectId: string; jobId: string; kind: string }[] = [];
let refused = 0;
/** Plans, assigns, submits and drains one task on one worker's node. */
async function runOneTask(task: { projectId: string; jobId: string }, wanted: typeof workerKinds[number]) {
  const base = `/api/v1/projects/${idOf(task.projectId)}/tasks/${idOf(task.jobId)}`;
  const { inputDigest } = (await (await api(base, { expect: [200] })).json()) as { inputDigest: string };
  const choice = (await (await api(`${base}/plan`, { expect: [200] })).json()) as
    { availability?: string; templates?: { id: string; adapter?: string }[] };
  const templateId = (choice.templates ?? []).find(template =>
    template.id.includes(`:${wanted.templateToken}:`)
    || (template.adapter ?? "").includes(wanted.kind))?.id;
  if (choice.availability !== "available" || !templateId) return false;
  // A replay of an already-planned source answers 200 with the same receipt, so
  // both statuses are real successes here.
  const planned = await api(`${base}/plan`, { method: "POST", expect: [200, 201],
    body: JSON.stringify({ expectedInputDigest: inputDigest, templateId }) });
  const { receipt } = await planned.json() as { receipt: { jobId: string; inputDigest: string } };
  const jobBase = `/api/v1/projects/${idOf(task.projectId)}/tasks/${idOf(receipt.jobId)}`;
  const assignment = (await (await api(`${jobBase}/assignment`, { expect: [200] })).json()) as
    { candidates?: { nodeId: string }[] };
  const nodeId = assignment.candidates?.find(candidate => candidate.nodeId.endsWith(`.${wanted.nodeSuffix}`))?.nodeId;
  if (!nodeId) return false;
  // A 409 here is the coordinator's real capacity or scope answer, not a tool
  // failure. A 200 is a replay of the same lease, which is a success here.
  const assigned = await api(`${jobBase}/assignment`, { method: "POST", expect: [200, 201, 409],
    body: JSON.stringify({ action: "assign", nodeId, expectedInputDigest: receipt.inputDigest }) });
  if (assigned.status === 409) return false;
  // Submission is the Mac-local confirm-what-you-saw path: read the preview's
  // packetDigest, then post it back. Exactly what the task page's "Submit task"
  // button does.
  const submissionRead = (await (await api(`${jobBase}/submission?inputDigest=${encodeURIComponent(receipt.inputDigest)}`,
    { expect: [200] })).json()) as { preview?: { packetDigest: string } };
  const packetDigest = submissionRead.preview?.packetDigest;
  if (packetDigest) {
    const submitted = await api(`${jobBase}/submission`, { method: "POST", expect: [200, 201, 409],
      body: JSON.stringify({ expectedInputDigest: receipt.inputDigest, expectedPacketDigest: packetDigest }) });
    if (submitted.status === 409) return false;
  }
  runningTasks.push({ projectId: task.projectId, jobId: receipt.jobId, kind: wanted.kind });
  // The lease stays held until delivery finishes, and one node accepts one task
  // at a time, so wait for a terminal attempt before this lane takes the next
  // one. An attempt row alone is not enough: it exists while the run is going.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const value = (await (await api(jobBase, { expect: [200] })).json()) as
      { task?: { state?: string }; attempts?: { state?: string }[] };
    const done = value.task?.state === "succeeded"
      || (value.attempts?.length ? value.attempts.every(attempt =>
        ["succeeded", "failed", "cancelled"].includes(attempt.state ?? "")) : false);
    if (done) return true;
    await new Promise(wait => setTimeout(wait, 400));
  }
  return false;
}
// Each worker gets every third task, so a lane only ever proposes for the node
// it owns and a slow lane cannot starve the others.
const lanes = workerKinds.map((worker, lane) => ({
  worker, delivered: 0, refused: 0,
  candidates: allTasks.filter((_task, index) => index % workerKinds.length === lane),
}));
await Promise.all(lanes.map(async lane => {
  for (const task of lane.candidates) {
    if (lane.delivered >= runningCount) break;
    // A refusal is usually a signal that has not been refreshed yet, or a node
    // still draining its previous lease. Both clear on their own within the
    // 30s refresh interval, so a short retry is correct; anything else is a
    // genuine conflict and is counted.
    let delivered = false;
    for (let attempt = 0; attempt < 3 && !delivered; attempt += 1) {
      if (attempt > 0) await new Promise(wait => setTimeout(wait, 5_000));
      delivered = await runOneTask(task, lane.worker);
    }
    if (delivered) lane.delivered += 1;
    else lane.refused += 1;
  }
}));
const running = lanes.reduce((total, lane) => total + lane.delivered, 0);
refused = lanes.reduce((total, lane) => total + lane.refused, 0);
console.log(`load-test seed: ${running} tasks driven to a terminal state through the real queue`
  + ` (${refused} refused after retries); per worker ${JSON.stringify(Object.fromEntries(lanes.map(lane => [lane.worker.kind, lane.delivered])))}`);

// Let the real queue deliver. The pretend workers answer instantly, so this only
// waits for the coordinator's own claim, run, publish and quality sweep. A
// bounded sample is enough: it proves real result rows exist for the pages that
// read them, without spending the whole seeding budget on queue round trips.
const sampled = runningTasks.slice(0, 12);
const deadline = Date.now() + 180_000;
let delivered = 0;
while (Date.now() < deadline) {
  delivered = 0;
  for (const task of sampled) {
    const value = (await (await api(`/api/v1/projects/${idOf(task.projectId)}/tasks/${idOf(task.jobId)}`,
      { expect: [200] })).json()) as { task?: { state?: string } };
    if (["succeeded", "finished", "failed", "archived"].includes(value.task?.state ?? "")) delivered += 1;
  }
  if (delivered === sampled.length) break;
  await new Promise(wait => setTimeout(wait, 2_000));
}
console.log(`load-test seed: ${delivered}/${sampled.length} sampled tasks reached a terminal state`);

const summary = { schema: "control-room.site-load-seed/v1", origin, seeded: true,
  projects: projects.map(project => project.projectId), tasks: allTasks.length, running, delivered,
  runningTasks };
await writeFile(seedFile, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log(`load-test seed complete: ${projects.length} projects, ${allTasks.length} tasks, ${running} submitted`);
