import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import handler from "../dist-vps/server/index.js";
import { evaluateAssignmentRecommendationV1, evaluateConfiguredRouteRecommendationV1, recommendationScopeMatchesV1,
  reportedEffortVocabularyV1, harnessByProbeIdV1, assignmentRecommendationProjectionSchemaV1 } from "../src/assignment-recommendation/v1/index.ts";
import { CODEX_APP_SERVER_CAPABILITY } from "../src/harness/codex-v1/delivery-contract.ts";
import { installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { taskAssignmentFixture } from "./helpers/task-assignment.ts";
import { sha256Digest } from "../src/security/index.ts";
import { binding, instant } from "./hermes-native-fixture.ts";
import { at } from "./native-task-fixture.ts";
import { request, origin } from "./helpers/web-foundation.ts";

test("compiled assignment keeps scheduled planning and allocation server-only", async () => {
  const compiled = await readFile(new URL("../dist-vps/server/taskApplication.js", import.meta.url), "utf8");
  assert.match(compiled, /service:schedule-assignment:v1/);
  assert.match(compiled, /scheduled\.tasks\.plan/);
  assert.doesNotMatch(compiled, /api\/v1\/scheduled-assignment/);
});

test("compiled private assignment API records, reads and expires a real lease under shared logout", async t => {
  const f = await taskAssignmentFixture(); let now = instant + 8000;
  const coordinator = f.create(f.db, () => now);
  const app = installPrivateWebProcess({ ...f.accessTrust, ...f.scope, origin, tasks: f.ownerKeys,
    assignment: coordinator.webOperation(), loadKeys: async () => f.accessTrust.keys,
    database: { client: f.db, close: f.close }, clock: () => now });
  t.after(() => app.close());
  const base = `/api/v1/projects/${f.prepared.receipt.projectId}/tasks/${f.prepared.receipt.jobId}`, path = `${base}/assignment`;
  const req = (url = path, method = "GET", body) => request(url, method, body, undefined, f.jwt);
  assert.deepEqual(Object.keys(coordinator.webOperation()).sort(), ["assign", "expire", "options", "tenantId", "workspaceId"]);
  assert.equal("assignLocked" in coordinator, false);
  const options = await (await handler(req())).json(); assert.equal(options.candidates.length, 1); assert.equal(options.receipt, null);
  const draft = { action: "assign", expectedInputDigest: options.inputDigest, nodeId: options.candidates[0].nodeId };
  const anonymous = new Request(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(draft) });
  assert.equal((await handler(anonymous)).status, 401);
  const saved = await handler(req(path, "POST", draft)); assert.equal(saved.status, 201, await saved.clone().text());
  const { receipt } = await saved.json(); assert.equal(receipt.startsWork, false);
  assert.equal((await (await handler(req(base))).json()).task.state, "leased");
  assert.equal((await handler(req(path, "POST", draft))).status, 200);
  assert.equal((await (await handler(req())).json()).receipt.leaseId, receipt.leaseId);
  now = instant + 70_000;
  const expired = await handler(req(path, "POST", { action: "expire", expectedInputDigest: options.inputDigest }));
  assert.equal(expired.status, 201, await expired.clone().text()); assert.equal((await expired.json()).receipt.leaseState, "expired");
  assert.equal((await handler(req("/api/v1/session/logout", "POST"))).status, 204);
  assert.equal((await handler(req())).status, 401);
});

test("locked assignment preserves owner replay and node capacity", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const coordinator = f.create(f.db, () => instant + 8000, [{ ...f.route, maxConcurrentTasks: 2 }]);
  const first = await coordinator.assign(f.identity, binding.projectId, f.prepared.receipt.jobId,
    binding.nodeId, f.prepared.receipt.inputDigest);
  assert.equal(first.replayed, false);
  const replay = await coordinator.assign(f.identity, binding.projectId, f.prepared.receipt.jobId,
    binding.nodeId, f.prepared.receipt.inputDigest);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, first.receipt);

  const secondDraft = { ...f.sourceDraft, title: "Compare two more launch ideas" };
  const secondSource = await f.tasks.propose(f.identity, binding.projectId, secondDraft, "assignment-source-capacity-002");
  const second = await f.planner.plan(f.identity, binding.projectId, secondSource.receipt.jobId, sha256Digest(secondDraft));
  await assert.rejects(coordinator.assign(f.identity, binding.projectId, second.receipt.jobId,
    binding.nodeId, second.receipt.inputDigest), { message: "conflict" });
  const active = await f.db.query("SELECT id FROM control_leases WHERE tenant_id=$1 AND node_id=$2 AND state='active'",
    [f.scope.tenantId, binding.nodeId]);
  assert.equal(active.rows.length, 2);
});

test("locked assignment preserves current fleet eligibility refusal", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const critical = { ...f.telemetry, sequence: 2, observedAt: at(7000), fingerprint: sha256Digest("critical-telemetry"),
    payload: { ...f.telemetry.payload, thermalState: "critical" } };
  await f.signals.ingestAuthenticated(critical, at(7000), binding);
  await assert.rejects(f.assign(), { message: "conflict" });
  const attempts = await f.db.query("SELECT id FROM control_attempts WHERE tenant_id=$1 AND job_id=$2",
    [f.scope.tenantId, f.prepared.receipt.jobId]);
  const leases = await f.db.query("SELECT id FROM control_leases WHERE tenant_id=$1 AND job_id=$2",
    [f.scope.tenantId, f.prepared.receipt.jobId]);
  assert.equal(attempts.rows.length, 0); assert.equal(leases.rows.length, 0);
});

/** The recommendation input is the same evidence the assignment path already holds: the
 *  packet's own policy, the configured candidates, the persisted fleet signals and the
 *  reported historical outcomes. Nothing here reaches a provider or a live agent. */
const recommendationInput = (f, overrides = {}) => ({
  now: at(7000), projectId: binding.projectId, jobId: f.prepared.receipt.jobId, inputDigest: f.prepared.receipt.inputDigest,
  policy: { requiredCapability: f.route.capabilityProbeId, requireVerifiedCapability: false,
    requiredScratchBytes: f.route.requiredScratchBytes, allowedPlatforms: ["windows", "macos", "linux", "cloud"] },
  candidates: [{ nodeId: f.route.nodeId, label: "Configured machine", platform: "windows", executorId: f.route.executorId,
    capabilityProbeId: f.route.capabilityProbeId, maxConcurrentTasks: f.route.maxConcurrentTasks, activeTaskCount: 0,
    leaseSeconds: f.route.leaseSeconds, requiredScratchBytes: f.route.requiredScratchBytes }],
  signals: [f.telemetry, f.capability], history: [], ...overrides,
});

test("pre-assignment recommendation reuses canonical eligibility and leaves unreported evidence unknown", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const projection = evaluateAssignmentRecommendationV1(recommendationInput(f));
  assert.equal(projection.state, "limited");
  assert.deepEqual(projection.authority, { startsWork: false, assignsWork: false, grantsExecutionAuthority: false });
  const chosen = projection.recommendation;
  assert.equal(chosen.nodeId, binding.nodeId); assert.equal(chosen.platform, "windows");
  assert.equal(chosen.capabilityProbeId, f.route.capabilityProbeId); assert.equal(chosen.harness, "hermes-native");
  assert.equal(chosen.effort, "unknown"); assert.equal(chosen.modelClass, "unreported");
  assert.deepEqual(chosen.costTradeoff, { cost: "unknown", usage: "unknown", sampleSize: 0 });
  assert.deepEqual(chosen.capacity, { available: true, activeTaskCount: 0, maxConcurrentTasks: 2 });
  assert.ok(chosen.basis.includes("capability_probe_current"));
  assert.ok(chosen.basis.includes("telemetry_current"));
  assert.ok(chosen.basis.includes("capacity_available"));
  assert.ok(projection.limits.includes("effort_unreported"));
  assert.ok(projection.limits.includes("cost_unreported"));
  assert.match(projection.explanation, /assigns nothing/);
  assert.deepEqual(assignmentRecommendationProjectionSchemaV1.parse(projection), projection);
});

test("stale fleet evidence produces an unavailable recommendation rather than a guess", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const projection = evaluateAssignmentRecommendationV1(recommendationInput(f, { now: at(500_000) }));
  assert.equal(projection.state, "unavailable"); assert.equal(projection.recommendation, null);
  assert.ok(projection.limits.includes("no_eligible_candidate"));
  assert.match(projection.explanation, /telemetry_stale/);
  assert.match(projection.explanation, /capability_expired/);
  assert.deepEqual(projection.alternatives.map(item => item.eligible), [false]);
  assert.deepEqual(assignmentRecommendationProjectionSchemaV1.parse(projection), projection);
});

test("a historical effort class is recommended only when comparable outcomes agree", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const row = (modelClass, effort, outcome, at_, reportedMinutes, reportedTokens) => ({ capabilityProbeId: f.route.capabilityProbeId,
    modelClass, effort, outcome, recordedAt: at_, ...(reportedMinutes === undefined ? {} : { reportedMinutes }),
    ...(reportedTokens === undefined ? {} : { reportedTokens }) });
  const agreed = [row("reported-class-a", "high", "accepted", at(1000), 40, 12000), row("reported-class-a", "high", "accepted", at(2000), 60, 18000),
    row("reported-class-a", "high", "changes_required", at(3000), 50, 15000), row("reported-class-b", "low", "accepted", at(4000)),
    row("reported-class-b", "low", "changes_required", at(5000))];
  const projection = evaluateAssignmentRecommendationV1(recommendationInput(f, { history: agreed }));
  assert.equal(projection.recommendation.effort, "high"); assert.equal(projection.recommendation.modelClass, "reported-class-a");
  assert.deepEqual(projection.recommendation.costTradeoff, { cost: "reported_historical", usage: "reported_historical",
    sampleSize: 3, reportedMinutesMedian: 50, reportedTokensMedian: 15000 });
  assert.equal(projection.state, "recommended"); assert.deepEqual(projection.limits, []);
  assert.ok(projection.recommendation.basis.includes("historical_outcome_accepted"));

  const tied = [row("reported-class-a", "high", "accepted", at(1000)), row("reported-class-a", "high", "changes_required", at(2000)),
    row("reported-class-b", "medium", "accepted", at(3000)), row("reported-class-b", "medium", "changes_required", at(4000))];
  const conflict = evaluateAssignmentRecommendationV1(recommendationInput(f, { history: tied }));
  assert.equal(conflict.recommendation.effort, "unknown"); assert.equal(conflict.recommendation.modelClass, "unreported");
  assert.ok(conflict.limits.includes("historical_outcome_conflicting"));
  assert.ok(conflict.recommendation.basis.includes("historical_outcome_conflicting"));

  const incomparable = [row("reported-class-a", "unknown", "accepted", at(1000)), row("reported-class-b", "unknown", "accepted", at(2000))];
  const limited = evaluateAssignmentRecommendationV1(recommendationInput(f, { history: incomparable }));
  assert.equal(limited.recommendation.effort, "unknown"); assert.ok(limited.limits.includes("historical_outcome_incomparable"));

  const thin = evaluateAssignmentRecommendationV1(recommendationInput(f,
    { history: [row("reported-class-a", "high", "accepted", at(1000), 30, 9000)] }));
  assert.equal(thin.recommendation.effort, "unknown"); assert.equal(thin.recommendation.modelClass, "unreported");
  assert.deepEqual(thin.recommendation.costTradeoff, { cost: "unknown", usage: "unknown", sampleSize: 0 });
  assert.ok(thin.limits.includes("historical_sample_insufficient"));
  assert.ok(thin.recommendation.basis.includes("historical_outcome_insufficient"));
});

test("the configured-route presentation states the evidence it cannot read, and is project-scoped", async () => {
  const scope = { projectId: "project-alpha", jobId: "job-alpha", inputDigest: sha256Digest("alpha") };
  const projection = evaluateConfiguredRouteRecommendationV1({ now: at(9000), ...scope, requiredCapability: "harness.hermes.native.runs.v1",
    candidates: [{ nodeId: "node-alpha", label: "Alpha machine", platform: "windows" },
      { nodeId: "node-beta", label: "Beta machine", platform: "linux" }] });
  assert.equal(projection.state, "limited"); assert.equal(projection.recommendation.nodeId, "node-alpha");
  assert.equal(projection.recommendation.harness, "hermes-native"); assert.equal(projection.recommendation.effort, "unknown");
  assert.deepEqual(projection.recommendation.costTradeoff, { cost: "unknown", usage: "unknown", sampleSize: 0 });
  for (const limit of ["capacity_evidence_missing", "effort_unreported", "eligibility_incomplete", "cost_unreported", "usage_unreported"])
    assert.ok(projection.limits.includes(limit), `${limit} must be declared`);
  assert.deepEqual(projection.alternatives.map(item => item.nodeId), ["node-alpha", "node-beta"]);
  assert.equal(recommendationScopeMatchesV1(projection, scope), true);
  assert.equal(recommendationScopeMatchesV1(projection, { ...scope, projectId: "project-beta" }), false);
  assert.equal(recommendationScopeMatchesV1(projection, { ...scope, jobId: "job-beta" }), false);
  assert.equal(recommendationScopeMatchesV1(projection, { ...scope, inputDigest: sha256Digest("beta") }), false);
  const none = evaluateConfiguredRouteRecommendationV1({ now: at(9000), ...scope, candidates: [] });
  assert.equal(none.state, "unavailable"); assert.equal(none.recommendation, null); assert.deepEqual(none.limits, ["no_eligible_candidate"]);
  assert.deepEqual(assignmentRecommendationProjectionSchemaV1.parse(projection), projection);
  assert.deepEqual(assignmentRecommendationProjectionSchemaV1.parse(none), none);
});

test("the recommendation surface has no server importer, no write path and no clock of its own", async () => {
  const moduleFiles = ["types.ts", "evidence.ts", "recommendation.ts", "schema.ts", "index.ts"];
  const forbidden = [/\bfetch\s*\(/, /\bDatabaseClient\b/, /\bwebOperation\b/, /\.write\s*\(/, /startsWork:\s*true/,
    /grantsExecutionAuthority:\s*true/, /new Date\(\)/];
  for (const name of moduleFiles) {
    const source = await readFile(new URL(`../src/assignment-recommendation/v1/${name}`, import.meta.url), "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${name} must not contain ${pattern}`);
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const importers = [];
  const walk = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (!["node_modules", "dist-vps", ".git", ".next"].includes(entry.name)) walk(path); }
    else if (/\.(?:ts|tsx|mjs)$/.test(entry.name) && readFileSync(path, "utf8").includes("assignment-recommendation"))
      importers.push(relative(root, path).split(sep).join("/"));
  } };
  walk(join(root, "src")); walk(join(root, "private-app"));
  assert.deepEqual(importers.filter(path => !path.startsWith("src/assignment-recommendation/")).sort(),
    ["private-app/app/assignment-recommendation.tsx", "private-app/app/task-assignment.tsx"]);
  const panel = await readFile(new URL("../private-app/app/assignment-recommendation.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /task-assignment-browser-client|client\.change\(|action: "assign"/);
  assert.match(panel, /assigns no work, reserves no capacity and grants no execution authority/);
  const page = await readFile(new URL("../private-app/app/task-assignment.tsx", import.meta.url), "utf8");
  assert.match(page, /onPrefer=\{setNodeId\}/);
  const compiled = await readFile(new URL("../dist-vps/server/taskApplication.js", import.meta.url), "utf8");
  assert.doesNotMatch(compiled, /assignment-recommendation|assignmentRecommendation/);
});

test("the recommendation vocabularies stay pinned to their canonical sources", async () => {
  const report = await readFile(new URL("../scripts/public-model-outcomes.mjs", import.meta.url), "utf8");
  const match = /const EFFORTS = new Set\(\[([^\]]*)\]\)/.exec(report);
  assert.ok(match, "the reported-effort set must still be discoverable in the public report");
  assert.deepEqual([...reportedEffortVocabularyV1], match[1].split(",").map(value => value.trim().replace(/^"|"$/g, "")));
  assert.equal(harnessByProbeIdV1["harness.hermes.native.runs.v1"], "hermes-native");
  assert.equal(harnessByProbeIdV1[CODEX_APP_SERVER_CAPABILITY], "codex-app-server");
});
