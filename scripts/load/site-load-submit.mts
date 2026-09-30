// Submit N real tasks through the owner's own API, while a load test is running,
// so the website is measured with pretend workers actually delivering work.
//
//   node --import tsx scripts/load/site-load-submit.mts ROOT_DIR --count 30
//     [--port 39610] [--db-port 59610]
//
// This is the "10 tabs while 3 pretend workers run 30 tasks" scenario as a
// separate, explicit step: the load tool only ever reads, so the writes that make
// the site interesting (queue churn, the quality sweep, result publication,
// supervisor reconciliation) have to come from somewhere. They come from here,
// through the same public API the task page uses, so every row they produce is a
// row the coordinator really wrote.
//
// It reports exactly what happened rather than a single pass/fail, because on a
// shared Mac the installation pauses itself and a refusal may be the machine
// rather than the product: refusals are counted by status and printed.
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const root = process.argv[2];
const numberOf = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const dbPort = numberOf("--db-port", 59610), webPort = numberOf("--port", 39610);
const target = Number(numberOf("--count", 30));
const origin = `http://127.0.0.1:${webPort}`;
if (!root || !isAbsolute(root) || resolve(root) !== root || !Number.isInteger(target) || target < 1 || target > 60)
  throw new Error("site_load_submit_arguments_invalid");

const protectedRoot = join(root, "protected");
const seed = JSON.parse(await readFile(join(root, "load-seed.json"), "utf8"));
const macLocal = JSON.parse(await readFile(join(protectedRoot, "config/mac-local.json"), "utf8"));
if (macLocal.port !== webPort || macLocal.localOwnerSession?.origin !== origin
  || macLocal.database?.port !== dbPort || macLocal.database?.database !== "control_room")
  throw new Error("load_test_scope_refused: configuration is not this load-test install");

const ownerCode = (await readFile(join(protectedRoot, "config/owner-sign-in.txt"), "utf8")).trim();
const signIn = await fetch(new URL("/api/v1/local-owner-session", origin), { method: "POST",
  headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) });
if (signIn.status !== 201) throw new Error(`load_test_sign_in_refused: ${signIn.status}`);
const cookie = (signIn.headers.get("set-cookie") ?? "").split(";", 1)[0];
const idOf = (value: string) => encodeURIComponent(value);
type ApiInit = RequestInit & { expect?: number[] };
async function api(path: string, init: ApiInit = {}): Promise<Response> {
  const response = await fetch(new URL(path, origin), { ...init, headers: { origin, cookie,
    ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  const expect = init.expect ?? [];
  if (expect.length && !expect.includes(response.status))
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} (wanted ${expect.join("/")}): ${(await response.text()).slice(0, 240)}`);
  return response;
}

/** A paused installation refuses every claim, which is the machine's health
 *  decision and not this test's. Resume it through the owner's own endpoint. */
let resumes = 0;
async function ensureRunning() {
  const current = await (await api("/api/v1/operations-mode", { expect: [200] })).json();
  if (current?.mode === "running") return;
  const resumed = await api("/api/v1/operations-mode", { method: "POST", expect: [200],
    body: JSON.stringify({ mode: "running", reason: "site load test resumed after an automatic machine-health pause" }) });
  if ((await resumed.json())?.mode !== "running") throw new Error("load_test_resume_refused");
  resumes += 1;
}
await ensureRunning();

// The three configured local workers, with the two spellings the product uses
// for each: the plan template id carries `claude`, the node id carries `claude`.
const workers = [
  { kind: "hermes", templateToken: "hermes", nodeSuffix: "hermes" },
  { kind: "claude-code", templateToken: "claude", nodeSuffix: "claude" },
  { kind: "codex", templateToken: "codex", nodeSuffix: "codex" },
];
const projects = seed.projects;
const counts = { proposed: 0, planned: 0, assigned: 0, submitted: 0, refused: 0 };
const byStatus: Record<string, number> = {};
const byWorker: Record<string, number> = {};

let submitted = 0, index = 0, consecutiveMisses = 0;
while (submitted < target && index < projects.length * 12 && consecutiveMisses < 12) {
  index += 1;
  // The supervisor pauses this installation whenever the machine fails a health
  // check, and resumes nothing on its own: a proposal made in that second is
  // plannable later, not lost. So the loop retries after a resume instead of
  // walking the whole catalogue while paused.
  await ensureRunning();
  const projectId = projects[index % projects.length];
  const worker = workers[index % workers.length];
  const n = Math.floor(index / projects.length) + 1;
  const proposed = await api(`/api/v1/projects/${idOf(projectId)}/tasks`, { method: "POST", expect: [201, 409, 503],
    headers: { "idempotency-key": `loadtest-worker-${Date.now()}-${index}` },
    body: JSON.stringify({ title: `Load worker task ${n}`, instructions: "Return one harmless short line.",
      // A distinct file scope per task: a proposal with no declared scope is the
      // whole repository, so two of them in one project would overlap and the
      // second assignment would be refused.
      scopes: [{ kind: "file", path: `loadtest/run/${index}.txt` }] }) });
  byStatus[`propose-${proposed.status}`] = (byStatus[`propose-${proposed.status}`] ?? 0) + 1;
  if (proposed.status !== 201) { counts.refused += 1; await ensureRunning(); continue; }
  counts.proposed += 1;
  const sourceJobId = (await proposed.json()).receipt.jobId;
  const { inputDigest } = await (await api(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(sourceJobId)}`,
    { expect: [200] })).json();
  const choice = await (await api(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(sourceJobId)}/plan`,
    { expect: [200] })).json();
  const templateId = (choice.templates ?? []).find((template: { id: string; adapter?: string }) =>
    template.id.includes(`:${worker.templateToken}:`) || (template.adapter ?? "").includes(worker.kind))?.id;
  if (choice.availability !== "available" || !templateId) {
    counts.refused += 1;
    consecutiveMisses += 1;
    if (choice.availability && choice.availability !== "available") byStatus[`plan-unavailable-${choice.availability}`] =
      (byStatus[`plan-unavailable-${choice.availability}`] ?? 0) + 1;
    await new Promise<void>(wait => setTimeout(wait, 5_000));
    continue;
  }
  consecutiveMisses = 0;
  const planned = await api(`/api/v1/projects/${idOf(projectId)}/tasks/${idOf(sourceJobId)}/plan`, { method: "POST",
    expect: [200, 201, 409], body: JSON.stringify({ expectedInputDigest: inputDigest, templateId }) });
  byStatus[`plan-${planned.status}`] = (byStatus[`plan-${planned.status}`] ?? 0) + 1;
  if (planned.status === 409) { counts.refused += 1; continue; }
  counts.planned += 1;
  const receipt = (await planned.json()).receipt;
  const base = `/api/v1/projects/${idOf(projectId)}/tasks/${idOf(receipt.jobId)}`;
  const assignment = await (await api(`${base}/assignment`, { expect: [200] })).json();
  const nodeId = (assignment.candidates ?? []).find((candidate: { nodeId: string }) => candidate.nodeId.endsWith(`.${worker.nodeSuffix}`))?.nodeId;
  if (!nodeId) { counts.refused += 1; continue; }
  // Every configured local route carries maxConcurrentTasks: 1, so a node holds
  // one task at a time. A 409 here is that ceiling, not a fault: wait for the
  // node to drain and try this same task again, bounded so a genuinely stuck
  // node cannot loop forever.
  let assigned = await api(`${base}/assignment`, { method: "POST", expect: [200, 201, 409],
    body: JSON.stringify({ action: "assign", nodeId, expectedInputDigest: receipt.inputDigest }) });
  for (let wait = 0; assigned.status === 409 && wait < 6; wait += 1) {
    await new Promise(done => setTimeout(done, 10_000));
    byStatus["assign-409-retried"] = (byStatus["assign-409-retried"] ?? 0) + 1;
    assigned = await api(`${base}/assignment`, { method: "POST", expect: [200, 201, 409],
      body: JSON.stringify({ action: "assign", nodeId, expectedInputDigest: receipt.inputDigest }) });
  }
  byStatus[`assign-${assigned.status}`] = (byStatus[`assign-${assigned.status}`] ?? 0) + 1;
  if (assigned.status === 409) { counts.refused += 1; await ensureRunning(); continue; }
  counts.assigned += 1;
  const submission = await (await api(`${base}/submission?inputDigest=${idOf(receipt.inputDigest)}`,
    { expect: [200] })).json();
  const packetDigest = submission?.preview?.packetDigest;
  if (!packetDigest) {
    // Already queued by an earlier attempt: count it and move on.
    submitted += 1;
    counts.submitted += 1;
    byWorker[worker.kind] = (byWorker[worker.kind] ?? 0) + 1;
    continue;
  }
  const sent = await api(`${base}/submission`, { method: "POST", expect: [200, 201, 409],
    body: JSON.stringify({ expectedInputDigest: receipt.inputDigest, expectedPacketDigest: packetDigest }) });
  byStatus[`submit-${sent.status}`] = (byStatus[`submit-${sent.status}`] ?? 0) + 1;
  if (sent.status === 409) { counts.refused += 1; await ensureRunning(); continue; }
  submitted += 1;
  counts.submitted += 1;
  byWorker[worker.kind] = (byWorker[worker.kind] ?? 0) + 1;
}

console.log(JSON.stringify({ schema: "control-room.site-load-submit/v1", ...counts, byStatus, byWorker, resumes }, null, 2));
await writeFile(join(root, "load-worker-tasks.json"), `${JSON.stringify({ schema: "control-room.site-load-submit/v1",
  ...counts, byStatus, byWorker, resumes, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
