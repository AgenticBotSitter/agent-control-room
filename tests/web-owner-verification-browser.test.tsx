import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnerTaskVerification, OwnerVerificationPanel } from "../private-app/app/task-owner-verification";
import { sha256Digest } from "../src/security";
import { createTaskVerificationBrowserClient } from "../src/web/v1/task-verification-browser-client";
import { createTaskVerificationWorkspace } from "../src/web/v1/task-verification-workspace";
import type { TaskVerificationDraft, TaskVerificationOptions, TaskVerificationReceipt } from "../src/web/v1/task-verification-wire";
import { ownerVerificationFixture } from "./helpers/owner-verification";
import { binding, instant } from "./hermes-native-fixture";
import { WebTaskService } from "../src/web/v1/task-service";
import { taskResultContentSchema, taskResultsPageSchema } from "../src/web/v1/task-result-wire";
import { taskDetailSchema } from "../src/web/v1/task-wire";
import { TaskResultsPanel } from "../private-app/app/task-results";
import { TaskDetailResults } from "../private-app/app/task-workspace";
import { createTaskReviewWorkspace } from "../src/web/v1/task-review-workspace";

const bound = { projectId: "project:one", jobId: "job:one", artifactId: "artifact:one", targetId: "target:one",
  targetDigest: sha256Digest("target"), contentHash: sha256Digest("content") };
const wireBound = { artifactId: bound.artifactId, targetId: bound.targetId, targetDigest: bound.targetDigest, contentHash: bound.contentHash };
const scenario = { scenarioId: "scenario:human-layout", label: "Check the rendered layout",
  instructions: "Open the exact result and confirm <all headings> remain visible at 200% zoom.",
  instructionsDigest: sha256Digest({ profile: "profile:one", instruction: "layout" }) };

function commandReceipt(note: string, overrides: Partial<TaskVerificationReceipt> = {}): TaskVerificationReceipt {
  return { ...bound, scenarioId: scenario.scenarioId, instructionsDigest: scenario.instructionsDigest, outcome: "passed",
    noteDigest: sha256Digest(note), verificationId: "verification:owner-one:target-one:layout",
    recordedAt: "2026-09-05T23:50:00.000Z", grantsApproval: false, grantsExecutionAuthority: false, completesJob: false, ...overrides };
}
function optionReceipt(note: string, overrides: Partial<TaskVerificationReceipt> = {}) {
  const { noteDigest: _noteDigest, ...receipt } = commandReceipt(note, overrides); void _noteDigest; return receipt;
}
function configured(overrides: Partial<TaskVerificationOptions> = {}): TaskVerificationOptions {
  return { ...bound, scenarios: [{ ...scenario, availability: "available", ownVerification: null }], source: "configured",
    grantsExecutionAuthority: false, ...overrides };
}
const draft = (note = "Headings stayed visible at 200% zoom."): TaskVerificationDraft =>
  ({ ...wireBound, scenarioId: scenario.scenarioId, instructionsDigest: scenario.instructionsDigest, outcome: "passed", note });

test("browser reads only exact configured human checks and never sends an idempotency key", async () => {
  const calls: { url: string; method?: string; headers: Headers }[] = [];
  const client = createTaskVerificationBrowserClient(async (url, init) => {
    calls.push({ url: String(url), method: init?.method, headers: new Headers(init?.headers) });
    return Response.json(configured());
  });
  const value = await client.options(bound.projectId, bound.jobId, bound);
  assert.equal(value.scenarios[0]?.instructions, scenario.instructions);
  assert.deepEqual(calls.map(call => call.method), ["GET"]);
  assert.match(calls[0]!.url, /\/results\/artifact%3Aone\/verifications\/target%3Aone$/);
  assert.equal(calls[0]!.headers.get("idempotency-key"), null);

  const missing = configured({ source: "not_configured", scenarios: [] });
  assert.deepEqual(await createTaskVerificationBrowserClient(async () => Response.json(missing))
    .options(bound.projectId, bound.jobId, bound), missing);
  await assert.rejects(createTaskVerificationBrowserClient(async () => Response.json({ ...missing,
    scenarios: configured().scenarios })).options(bound.projectId, bound.jobId, bound), { code: "unavailable" });
});

test("browser accepts the maximum configured multibyte human-verification options within the one-MiB bound", async () => {
  const scenarios = Array.from({ length: 50 }, (_, index) => ({ scenarioId: `scenario:unicode-${index}`,
    label: `${index}:` + "界".repeat(117), instructions: "界".repeat(2000),
    instructionsDigest: sha256Digest({ index, kind: "maximum-unicode-instructions" }),
    availability: "available" as const, ownVerification: null }));
  const options = configured({ scenarios }), serialized = JSON.stringify(options);
  const size = new TextEncoder().encode(serialized).byteLength;
  assert.ok(size > 131_072, `expected prior 131-KiB bound to be exceeded, got ${size}`);
  assert.ok(size < 1_048_576, `expected schema maximum to fit one MiB, got ${size}`);
  const value = await createTaskVerificationBrowserClient(async () => new Response(serialized,
    { headers: { "content-type": "application/json; charset=utf-8" } })).options(bound.projectId, bound.jobId, bound);
  assert.equal(value.scenarios.length, 50); assert.equal(value.scenarios.at(-1)?.instructions.length, 2000);
});

test("browser stops and refuses a verification response as soon as its stream exceeds one MiB", async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls <= 18) controller.enqueue(new Uint8Array(65_536).fill(120));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const client = createTaskVerificationBrowserClient(async () => new Response(body, { headers: { "content-type": "application/json" } }));
  await assert.rejects(client.options(bound.projectId, bound.jobId, bound), { code: "unavailable" });
  assert.equal(pulls, 17, "the seventeenth 64-KiB chunk is the first byte range beyond one MiB");
  assert.equal(cancelled, true);
});

test("browser records only an explicit draft and matches every command binding plus canonical note digest", async () => {
  const note = "Observed line one.\nObserved line two."; const calls: RequestInit[] = [];
  const client = createTaskVerificationBrowserClient(async (_url, init) => {
    calls.push(init!); return Response.json({ receipt: commandReceipt(note), replayed: false }, { status: 201 });
  });
  assert.equal(calls.length, 0);
  const receipt = await client.record(bound.projectId, bound.jobId, draft(note));
  assert.equal(receipt.noteDigest, sha256Digest(note)); assert.equal(client.hasPending(), false);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.method, "POST");
  assert.equal(new Headers(calls[0]!.headers).get("idempotency-key"), null);
  assert.deepEqual(JSON.parse(String(calls[0]!.body)), draft(note));
});

test("wrong command receipts, authority flags and changed observation notes stay uncertain", async () => {
  const note = "Observed exact result.";
  const changed: unknown[] = [
    commandReceipt(note, { projectId: "project:other" }), commandReceipt(note, { jobId: "job:other" }),
    commandReceipt(note, { artifactId: "artifact:other" }), commandReceipt(note, { targetId: "target:other" }),
    commandReceipt(note, { targetDigest: sha256Digest("other target") }), commandReceipt(note, { contentHash: sha256Digest("other content") }),
    commandReceipt(note, { scenarioId: "scenario:other" }), commandReceipt(note, { instructionsDigest: sha256Digest("other instructions") }),
    commandReceipt(note, { outcome: "failed" }), commandReceipt("a changed note"),
    { ...commandReceipt(note), grantsApproval: true }, { ...commandReceipt(note), grantsExecutionAuthority: true },
    { ...commandReceipt(note), completesJob: true },
  ];
  for (const receipt of changed) {
    const client = createTaskVerificationBrowserClient(async () => Response.json({ receipt, replayed: false }));
    await assert.rejects(client.record(bound.projectId, bound.jobId, draft(note)), { code: "uncertain" });
    assert.equal(client.hasPending(), true);
  }
});

test("wrong option identities, receipt bindings and recorded-state claims deny display", async () => {
  const saved = optionReceipt("Prior observation");
  const changed: unknown[] = [
    { ...configured(), projectId: "project:other" }, { ...configured(), targetDigest: sha256Digest("other") },
    configured({ scenarios: [{ ...scenario, scenarioId: "scenario:duplicate", availability: "available", ownVerification: null },
      { ...scenario, scenarioId: "scenario:duplicate", availability: "available", ownVerification: null }] }),
    configured({ scenarios: [{ ...scenario, availability: "available", ownVerification: saved }] }),
    configured({ scenarios: [{ ...scenario, availability: "already_recorded", ownVerification: { ...saved, contentHash: sha256Digest("other") } }] }),
    { ...configured(), grantsExecutionAuthority: true },
  ];
  for (const options of changed)
    await assert.rejects(createTaskVerificationBrowserClient(async () => Response.json(options))
      .options(bound.projectId, bound.jobId, bound), { code: "unavailable" });
});

test("lost response preserves one exact pending draft through denial until explicit check", async () => {
  const note = "  Exact observation retained across uncertainty.  ";
  let phase: "lost" | "denied" | "recover" = "lost"; const bodies: string[] = [], keys: (string | null)[] = [];
  const client = createTaskVerificationBrowserClient(async (_url, init) => {
    bodies.push(String(init?.body)); keys.push(new Headers(init?.headers).get("idempotency-key"));
    if (phase === "lost") throw new Error("synthetic_lost_response");
    if (phase === "denied") return Response.json({}, { status: 403 });
    return Response.json({ receipt: commandReceipt(note.trim()), replayed: true });
  });
  await assert.rejects(client.record(bound.projectId, bound.jobId, draft(note)), { code: "uncertain" });
  assert.equal(client.hasPending(), true);
  await assert.rejects(client.record(bound.projectId, bound.jobId, draft("changed observation")), { code: "uncertain" });
  assert.equal(bodies.length, 1);
  phase = "denied"; await assert.rejects(client.checkSave(), { code: "access_denied" }); assert.equal(client.hasPending(), true);
  phase = "recover"; const receipt = await client.checkSave();
  assert.equal(receipt.noteDigest, sha256Digest(note.trim())); assert.equal(client.hasPending(), false);
  assert.equal(new Set(bodies).size, 1); assert.deepEqual(keys, [null, null, null]);
});

test("task workspace retains unsaved and uncertain input across result teardown without crossing bindings", async () => {
  let phase: "lost" | "recover" = "lost"; const bodies: string[] = [];
  const workspace = createTaskVerificationWorkspace(() => createTaskVerificationBrowserClient(async (_url, init) => {
    bodies.push(String(init?.body));
    if (phase === "lost") throw new Error("synthetic_lost_response");
    return Response.json({ receipt: commandReceipt("Exact workspace observation."), replayed: true });
  }));
  const session = workspace.get(bound); session.selectScenario(scenario.scenarioId); session.setOutcome("passed");
  session.setNote("  Exact workspace observation.  ");
  const detach = session.subscribe(() => {}); detach();
  await session.save(scenario); assert.equal(session.client.hasPending(), true);
  assert.equal(session.getSnapshot().scenarioId, scenario.scenarioId); assert.equal(session.getSnapshot().outcome, "passed");
  assert.equal(session.getSnapshot().note, "Exact workspace observation."); assert.equal(session.getSnapshot().pending, false);
  assert.equal(session.getSnapshot().error?.code, "uncertain"); assert.equal(session.getSnapshot().receipt, undefined);
  assert.equal(workspace.get(bound), session);
  assert.equal(workspace.get({ ...bound, artifactId: "artifact:other" }).getSnapshot().note, "");
  const protectedShell = renderToStaticMarkup(createElement(OwnerTaskVerification, { ...bound, workspace, onSaved() {} }));
  assert.doesNotMatch(protectedShell, /Exact workspace observation/); assert.match(protectedShell, /earlier human verification save is unresolved/);
  phase = "recover"; await workspace.get(bound).save();
  assert.equal(session.client.hasPending(), false); assert.equal(session.getSnapshot().note, ""); assert.equal(new Set(bodies).size, 1);
});

test("an in-flight human verification remains bound while its result subtree is detached", async () => {
  let release!: (response: Response) => void, calls = 0;
  const workspace = createTaskVerificationWorkspace(() => createTaskVerificationBrowserClient(async () => {
    calls++; return new Promise<Response>(resolve => { release = resolve; });
  }));
  const session = workspace.get(bound); session.selectScenario(scenario.scenarioId); session.setOutcome("blocked"); session.setNote("Viewport unavailable.");
  const detach = session.subscribe(() => {}); const saving = session.save(scenario); detach();
  assert.equal(session.getSnapshot().pending, true); assert.equal(workspace.get(bound), session);
  await session.save(scenario); assert.equal(calls, 1);
  release(Response.json({ receipt: commandReceipt("Viewport unavailable.", { outcome: "blocked" }), replayed: false }));
  await saving; assert.equal(session.getSnapshot().pending, false); assert.equal(session.getSnapshot().receipt?.outcome, "blocked");
});

test("human verification presentation shows actual instructions, requires outcome and note, and labels historical readback truthfully", () => {
  const render = (options: TaskVerificationOptions, scenarioId = "", result?: TaskVerificationDraft["outcome"], note = "", held = false) =>
    renderToStaticMarkup(createElement(OwnerVerificationPanel, { options, scenarioId, result, note, pending: false, held,
      onScenario() {}, onResult() {}, onNote() {}, onRecord() {} }));
  const missing = render(configured({ source: "not_configured", scenarios: [] }));
  assert.match(missing, /Human verification is not configured/); assert.doesNotMatch(missing, /Record human verification/);
  const empty = render(configured(), scenario.scenarioId);
  assert.match(empty, /Actual configured instructions/); assert.match(empty, /&lt;all headings&gt;/);
  for (const label of ["Passed", "Failed", "Blocked", "Inconclusive"]) assert.match(empty, new RegExp(label));
  assert.match(empty, /button[^>]*disabled[^>]*>Record human verification/);
  const ready = render(configured(), scenario.scenarioId, "inconclusive", "Could not distinguish the final color.");
  assert.doesNotMatch(ready, /button[^>]*disabled[^>]*>Record human verification/);
  assert.match(ready, /does not report an automated check or complete this job/);
  const historical = configured({ scenarios: [{ ...scenario, availability: "already_recorded", ownVerification: optionReceipt("Prior observation") }] });
  const saved = render(historical, scenario.scenarioId);
  assert.match(saved, /Recorded human result: Passed/); assert.doesNotMatch(saved, /Required observation note|Record human verification/);
});

test("workspace capacity retains earlier human verification notes", () => {
  const workspace = createTaskVerificationWorkspace(), existing = workspace.get(bound); existing.setNote("Retained at capacity");
  for (let index = 1; index < 128; index++) workspace.get({ ...bound, artifactId: `artifact:${index}` });
  const shell = renderToStaticMarkup(createElement(OwnerTaskVerification,
    { ...bound, artifactId: "artifact:overflow", workspace, onSaved() {} }));
  assert.match(shell, /workspace limit/); assert.doesNotMatch(shell, /Retained at capacity/);
  assert.equal(workspace.get(bound), existing); assert.equal(existing.getSnapshot().note, "Retained at capacity");
});

test("configured matching results mount human verification and retain its task-owned workspace across close and reopen", async t => {
  const f = await ownerVerificationFixture(); t.after(f.close);
  const tasks = new WebTaskService(f.db, f.scope, () => instant + 6000,
    { ...f.ownerKeys, manualVerificationScenarios: [f.scenario] });
  const page = taskResultsPageSchema.parse(await tasks.results(f.identity, binding.projectId, binding.jobId));
  const content = taskResultContentSchema.parse(await tasks.results(f.identity, binding.projectId, binding.jobId, f.artifact.artifactId));
  const detail = taskDetailSchema.parse(await tasks.detail(f.identity, binding.projectId, binding.jobId));
  const reviewWorkspace = createTaskReviewWorkspace(), verificationWorkspace = createTaskVerificationWorkspace();
  const exact = { projectId: binding.projectId, jobId: binding.jobId, artifactId: f.artifact.artifactId, targetId: f.target.id,
    targetDigest: sha256Digest(f.target), contentHash: f.artifact.contentHash };
  const session = verificationWorkspace.get(exact); session.selectScenario(f.scenario.scenarioId); session.setOutcome("inconclusive");
  session.setNote("The viewport was unavailable; this is an unsaved human observation.");

  assert.equal(page.verificationCommands, "configured");
  const mounted = TaskDetailResults({ detail, projectId: binding.projectId, reviewWorkspace, verificationWorkspace });
  assert.equal(mounted?.props.verificationWorkspace, verificationWorkspace);
  assert.equal(TaskDetailResults({ detail: undefined, projectId: binding.projectId, reviewWorkspace, verificationWorkspace }), null);
  assert.equal(verificationWorkspace.get(exact), session);
  assert.equal(verificationWorkspace.get(exact).getSnapshot().note,
    "The viewport was unavailable; this is an unsaved human observation.");
  const reopened = TaskDetailResults({ detail, projectId: binding.projectId, reviewWorkspace, verificationWorkspace });
  assert.equal(reopened?.props.verificationWorkspace, verificationWorkspace);

  const render = (source = page, value = content) => renderToStaticMarkup(createElement(TaskResultsPanel,
    { page: source, content: value, pending: false, onOpen() {}, onClose() {}, reviewWorkspace, verificationWorkspace }));
  assert.match(render(), /Loading human verification/);
  assert.doesNotMatch(render({ ...page, verificationCommands: "not_connected" }), /Loading human verification/);
  assert.doesNotMatch(render(page, { ...content, artifact: { ...content.artifact, artifactId: "artifact:different" } }),
    /Loading human verification/);
});
