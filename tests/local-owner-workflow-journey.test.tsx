import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProjectCreateForm } from "../app/components/project-create-form";
import { LocalWorkerRouteStatus } from "../private-app/app/local-worker-route-status";
import { TaskAttentionPanel } from "../private-app/app/needs-me/task-attention";
import { ProjectResultReviewPanel } from "../private-app/app/project-result-review-workspace";
import { SetupWorkspace } from "../private-app/app/setup/setup-workspace";
import { TaskDetailPanel, TaskProposalForm, TaskStateGuidance } from "../private-app/app/task-panels";
import { localHarnessCapabilitiesV1 } from "../src/harness/v1/local-harness-capabilities";
import { BrowserRequestError } from "../src/web/v1/browser-client";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client";
import { readTaskProjectAttention } from "../src/web/v1/task-project-attention-browser-client";
import type { TaskDetail } from "../src/web/v1/task-wire";

const at = "2026-09-24T12:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const task = {
  projectId: "project:owner-journey", requestId: "request:owner-journey", jobId: "job:owner-journey",
  title: "Review the saved result", state: "succeeded" as const, version: 1, createdAt: at, updatedAt: at,
};

function savedDetail(state: TaskDetail["task"]["state"] = "succeeded"): TaskDetail {
  return {
    project: { projectId: task.projectId, title: "Owner journey", summary: "Disposable owner journey", origin: "ordinary",
      lifecycle: "active", version: 1, createdAt: at, updatedAt: at, lifecycleEditable: true },
    task: { ...task, state }, instructions: "Inspect the returned evidence before accepting it.", inputDigest: digest, observedAt: at,
    attempts: [], earlierAttemptsOmitted: false, preparedFor: "codex", localRouteObservation: { state: "not_observed", adapter: "codex" },
    hermesDeliveryRecovery: { source: "not_applicable" }, progressSource: "configured", dispatch: "configured",
    artifacts: "configured", review: "recorded",
  };
}

function noAgentControl(html: string) {
  assert.doesNotMatch(html, /Start (agent|work|Codex)|Enable (agent|worker|Codex)|Retry (agent|work|task)|Resume (agent|work|task)/i);
  assert.doesNotMatch(html, /running now|available now/i);
}

test("owner can follow the saved local workflow without a false live-worker claim", () => {
  const projectProposal = renderToStaticMarkup(createElement(ProjectCreateForm, {
    pending: false, result: "idle", templates: [], onCreate: () => {},
  }));
  assert.match(projectProposal, /New project/);
  assert.match(projectProposal, /Create project/);

  const taskProposal = renderToStaticMarkup(createElement(TaskProposalForm, {
    draft: { title: "", instructions: "" }, setDraft: () => {}, pending: false, uncertain: false, onSave: () => {},
  }));
  assert.match(taskProposal, /Propose a task/);
  assert.match(taskProposal, /Saving does not assign or start an agent/);
  assert.match(taskProposal, /does not claim that any worker is currently available/);

  const detail = renderToStaticMarkup(createElement(TaskDetailPanel, { detail: savedDetail() }));
  assert.match(detail, /prepared for Codex/);
  assert.match(detail, /does not claim that a local Codex worker is available/);
  const guidance = renderToStaticMarkup(createElement(TaskStateGuidance, {
    detail: savedDetail(), refreshing: false, onRefresh: () => {},
  }));
  assert.match(guidance, /Review the returned result/);
  assert.match(guidance, /href="#task-results"/);

  const review = renderToStaticMarkup(createElement(ProjectResultReviewPanel, { projectId: task.projectId, mode: "reviews", data: {
    state: "ready", value: { projectId: task.projectId, mode: "reviews", items: [{ task, inputDigest: digest,
      reasons: ["changes_requested"], resultArtifactIds: ["artifact:owner-journey"], category: "review", urgency: "soon",
      ownerQuestion: "Does the saved result need a correction?" }], nextCursor: null, examined: 1,
      resultSource: "configured", reviewSource: "configured", resultContent: "authorized", observedAt: at, startsWork: false },
  } }));
  assert.match(review, /Changes were requested/);
  assert.match(review, /Does the saved result need a correction/);
  assert.match(review, /projects\/project%3Aowner-journey\/tasks\/job%3Aowner-journey\?result=artifact%3Aowner-journey#task-results/);
  assert.match(review, /Execution approval remains a separate task decision/);

  const attention = renderToStaticMarkup(createElement(TaskAttentionPanel, { page: {
    items: [{ task, inputDigest: digest, reasons: ["changes_requested"], category: "review", urgency: "soon",
      ownerQuestion: "Does the saved result need a correction?" }], nextCursor: null, examined: 1, observedAt: at,
    startsWork: false, planningSource: "configured", deliverySource: "configured", sources: { ordinary: "included", ideas: "not_configured" },
  } }));
  assert.match(attention, /projects\/project%3Aowner-journey\/tasks\/job%3Aowner-journey/);
  assert.match(attention, /Opening a task does not approve, retry or execute it/);

  const workers = renderToStaticMarkup(createElement(LocalWorkerRouteStatus, { state: "available", setup: {
    localCapabilities: [{ ...localHarnessCapabilitiesV1[2]!, state: "not_available" }],
  } as never, taskWorkerStatus: { state: "available", value: { taskWorkersStarted: true,
    workers: [{ kind: "codex", state: "ready", proof: "not_proven" }] } } }));
  assert.match(workers, /Codex/);
  assert.match(workers, /Not available on this computer/);
  assert.match(workers, /not a live process monitor/);

  const firstStart = renderToStaticMarkup(createElement(LocalWorkerRouteStatus, { state: "available", setup: {
    localCapabilities: [{ ...localHarnessCapabilitiesV1[2]!, state: "owner_enablement_required" }],
  } as never, taskWorkerStatus: { state: "available", value: { taskWorkersStarted: false,
    instruction: "create your first project, then run mac:down && mac:up",
    workers: [{ kind: "codex", state: "unavailable", proof: "not_proven" }] } } }));
  assert.match(firstStart, /Task workers are not started/);
  assert.match(firstStart, /create your first project, then run mac:down &amp;&amp; mac:up/);
  assert.doesNotMatch(firstStart, /Status: Ready for owner enablement|operational/);

  const setup = renderToStaticMarkup(createElement(SetupWorkspace));
  assert.match(setup, /public release and live installation do not/);
  assert.match(setup, /cannot install, start, enable, or configure Control Room/);
  assert.match(setup, /Refreshing never repeats a setup action/);

  noAgentControl(`${projectProposal}${taskProposal}${detail}${guidance}${review}${attention}${workers}${setup}`);
});

test("direct attention reloads are GET-only, and a lost proposal reply holds one exact request", async () => {
  const attention = { projectId: task.projectId, mode: "reviews", items: [{ task, inputDigest: digest,
    reasons: ["review"], resultArtifactIds: ["artifact:owner-journey"], category: "review", urgency: "soon",
    ownerQuestion: "Does the saved result meet the requested outcome?" }], nextCursor: null, examined: 1,
    resultSource: "configured", reviewSource: "configured", resultContent: "authorized", observedAt: at, startsWork: false };
  const reads: Array<[string, string]> = [];
  const reload = (async (url: RequestInfo | URL, init?: RequestInit) => {
    reads.push([String(url), init?.method ?? "GET"]);
    return Response.json(attention);
  }) as typeof fetch;
  await readTaskProjectAttention(task.projectId, "reviews", undefined, reload);
  await readTaskProjectAttention(task.projectId, "reviews", undefined, reload);
  assert.deepEqual(reads, [
    ["/api/v1/projects/project%3Aowner-journey/reviews", "GET"],
    ["/api/v1/projects/project%3Aowner-journey/reviews", "GET"],
  ]);

  const keys: string[] = [];
  let calls = 0;
  const client = createTaskBrowserClient((async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    if (calls === 1) throw new Error("lost reply");
    return Response.json({ receipt: { projectId: task.projectId, requestId: task.requestId, jobId: task.jobId,
      createdAt: at, submission: "proposed", startsWork: false }, replayed: true });
  }) as typeof fetch, () => "owner-journey-save-key");
  await assert.rejects(client.propose(task.projectId, { title: "Save safely", instructions: "Keep one exact request." }),
    (error: unknown) => error instanceof BrowserRequestError && error.code === "uncertain");
  assert.equal(client.hasPending(), true);
  await assert.rejects(client.propose(task.projectId, { title: "Different proposal", instructions: "Must not replace the held request." }),
    (error: unknown) => error instanceof BrowserRequestError && error.code === "uncertain");
  const receipt = await client.retrySave();
  assert.equal(receipt.startsWork, false);
  assert.deepEqual(keys, ["owner-journey-save-key", "owner-journey-save-key"]);
  assert.equal(client.hasPending(), false);
});
