import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnerTaskVerification, OwnerVerificationPanel } from "../private-app/app/task-owner-verification";
import { OwnerTaskReview, OwnerReviewPanel } from "../private-app/app/task-owner-review";
import { TaskResultsPanel } from "../private-app/app/task-results";
import { sha256Digest } from "../src/security";
import { MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1, MAC_LOCAL_TEXT_SCENARIO_V1 } from "../src/web/v1/mac-local-owner-review-profile";
import { createTaskReviewWorkspace } from "../src/web/v1/task-review-workspace";
import { createTaskVerificationWorkspace } from "../src/web/v1/task-verification-workspace";
import { BrowserRequestError } from "../src/web/v1/browser-client";
import { createTaskVerificationBrowserClient } from "../src/web/v1/task-verification-browser-client";
import type { TaskVerificationDraft, TaskVerificationOptions } from "../src/web/v1/task-verification-wire";
import type { TaskResultContent, TaskResultsPage } from "../src/web/v1/task-result-wire";
import type { TaskReviewOptions } from "../src/web/v1/task-review-wire";

const at = "2026-09-27T12:00:00.000Z", digest = (value: string) => `sha256:${value.repeat(64)}`;
const binding = { projectId: "project:one", jobId: "job:one", artifactId: "artifact:one", targetId: "target:one",
  targetDigest: digest("a"), contentHash: digest("b") };
const resultBinding = { artifactId: binding.artifactId, targetId: binding.targetId,
  targetDigest: binding.targetDigest, contentHash: binding.contentHash };
const instructionsDigest = digest("c");
const options: TaskVerificationOptions = { ...binding, source: "configured", grantsExecutionAuthority: false, scenarios: [{
  scenarioId: MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1, label: "Owner human verification",
  instructions: "Read the protected text result and record what you observed.", instructionsDigest,
  availability: "available", ownVerification: null,
}] };

async function flushRead() { await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }

test("Mac-local result page exposes a human-only control and records its explicit owner result", async () => {
  const markup = renderToStaticMarkup(<OwnerVerificationPanel options={options}
    scenarioId={MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1} result="passed" note="Observed the requested answer."
    pending={false} held={false} onScenario={() => {}} onResult={() => {}} onNote={() => {}} onRecord={() => {}} />);
  assert.match(markup, /Human verification/); assert.match(markup, /Record human verification/);
  assert.match(markup, /does not report an automated check or complete this job/);
  assert.doesNotMatch(markup, new RegExp(MAC_LOCAL_TEXT_SCENARIO_V1));
  assert.equal(options.scenarios[0]!.ownVerification, null,
    "an automated result cannot silently populate the human verification record");

  const note = "Observed the requested answer.";
  const draft: TaskVerificationDraft = { ...resultBinding, scenarioId: MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1,
    instructionsDigest, outcome: "passed", note };
  const client = createTaskVerificationBrowserClient(async (url, init) => {
    assert.match(String(url), /\/verifications\/target%3Aone$/); assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), draft);
    return Response.json({ receipt: { ...binding, scenarioId: draft.scenarioId, instructionsDigest, outcome: "passed",
      noteDigest: sha256Digest(note), verificationId: "verification:one", recordedAt: at,
      grantsApproval: false, grantsExecutionAuthority: false, completesJob: false }, replayed: false });
  });
  const receipt = await client.record(binding.projectId, binding.jobId, draft);
  assert.equal(receipt.outcome, "passed"); assert.equal(receipt.completesJob, false);
  assert.equal(receipt.grantsApproval, false); assert.equal(receipt.grantsExecutionAuthority, false);
});

test("owner acceptance presents the configured read-and-correct attestation beside both decisions", () => {
  const reviewOptions: TaskReviewOptions = { ...binding, canReview: true, availability: "available", ownReview: null,
    acceptanceAttestation: { scenarioId: MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1,
      label: "Owner human verification", instructions: "Read the protected text result and confirm it satisfies the task.",
      instructionsDigest }, grantsExecutionAuthority: false };
  const markup = renderToStaticMarkup(<OwnerReviewPanel options={reviewOptions} feedback="" pending={false} held={false}
    onFeedback={() => {}} onRecord={() => {}} />);
  assert.match(markup, /I read it and it’s correct/);
  assert.match(markup, />Accept</);
  assert.match(markup, /Request changes/);
});

test("a delayed revised-target read binds the newest revision and enables Accept after attestation", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://control.invalid/tasks/job%3Aone" });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  let resolveOptions!: (value: TaskReviewOptions) => void;
  const delayedOptions = new Promise<TaskReviewOptions>(resolve => { resolveOptions = resolve; });
  const requestedTargets: string[] = [];
  const client = { hasPending: () => false,
    async options(_projectId: string, _jobId: string, requested: { targetId: string }) {
      requestedTargets.push(requested.targetId); return delayedOptions;
    }, async record() { throw new Error("record_not_expected"); }, async retrySave() { throw new Error("retry_not_expected"); } };
  const workspace = createTaskReviewWorkspace(() => client as never);
  const artifact = { artifactId: "artifact:revised", attemptId: "attempt:one", runId: "run:one",
    contentHash: binding.contentHash, sizeBytes: 12, receivedAt: at, byteCheck: "matched_recorded_claim" as const,
    qualityAccepted: false as const };
  const evidence = (targetId: string, revision: number) => ({ targetId, kind: "document" as const,
    targetDigest: binding.targetDigest, contentHash: binding.contentHash, revision, supersedesTargetId: null,
    status: "pending" as const, matchingArtifactIds: [artifact.artifactId], additionalEvidenceOmitted: false,
    reviews: [], verifications: [], findings: [], missingVerificationScenarioIds: [], openFindingCount: 0,
    grantsApproval: false as const, grantsExecutionAuthority: false as const });
  const page: TaskResultsPage = { projectId: binding.projectId, jobId: binding.jobId, observedAt: at,
    resultSource: "configured", reviewSource: "configured", items: [artifact],
    reviews: [evidence("target:stale-first", 0), evidence("target:revised", 1)],
    additionalResultsOmitted: false, additionalTargetsOmitted: false, canReadContent: true,
    reviewCommands: "configured", verificationCommands: "not_connected" };
  const content: TaskResultContent = { projectId: page.projectId, jobId: page.jobId, artifact,
    text: "Revised result", contentVerifiedAt: at, untrustedContent: true };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await React.act(async () => { root.render(<TaskResultsPanel page={page} content={content} pending={false}
      onOpen={() => {}} onClose={() => {}} reviewWorkspace={workspace} />); });
    assert.deepEqual(requestedTargets, ["target:revised"]);
    assert.match(dom.window.document.body.textContent ?? "", /Revision 1 · Review in progress/);
    assert.match(dom.window.document.body.textContent ?? "", /Loading owner review/);

    resolveOptions({ ...binding, artifactId: artifact.artifactId, targetId: "target:revised",
      canReview: true, availability: "available", ownReview: null, acceptanceAttestation: {
        scenarioId: MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1, label: "Owner human verification",
        instructions: "Read the protected text result and confirm it satisfies the task.", instructionsDigest,
      }, grantsExecutionAuthority: false, revisionPlanning: "configured" });
    await React.act(async () => { await delayedOptions; });
    const accept = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === "Accept")!;
    const attestation = dom.window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assert.equal(accept.disabled, true); assert.ok(attestation);
    await React.act(async () => { attestation.click(); });
    assert.equal(accept.disabled, false);
  } finally {
    await React.act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("failed review and verification refreshes remove stale owner actions until a successful re-read", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://control.invalid/tasks/job%3Aone" });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(dom.window.document, "hidden", { configurable: true, get: () => false });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  let reviewMode: "ok" | "fail" = "ok", verificationMode: "ok" | "fail" = "ok";
  const reviewOptions: TaskReviewOptions = { ...binding, canReview: true, availability: "available", ownReview: null,
    acceptanceAttestation: undefined, grantsExecutionAuthority: false, revisionPlanning: "configured" };
  const verificationOptions: TaskVerificationOptions = { ...binding, source: "configured", grantsExecutionAuthority: false, scenarios: [{
    scenarioId: MAC_LOCAL_TEXT_SCENARIO_V1, label: "Finish accepted review", instructions: "Read the result.", instructionsDigest,
    recordingMode: "read_correct_attestation", availability: "available", ownVerification: null,
  }] };
  const reviewWorkspace = createTaskReviewWorkspace(() => ({ hasPending: () => false,
    options: async () => { if (reviewMode === "fail") throw new BrowserRequestError("access_denied"); return reviewOptions; },
    record: async () => { throw new Error("record_not_expected"); }, retrySave: async () => { throw new Error("retry_not_expected"); } }) as never,
  () => ({ hasPending: () => false, prepare: async () => { throw new Error("revision_not_expected"); }, retrySave: async () => { throw new Error("revision_not_expected"); } }) as never);
  const verificationWorkspace = createTaskVerificationWorkspace(() => ({ hasPending: () => false,
    options: async () => { if (verificationMode === "fail") throw new BrowserRequestError("access_denied"); return verificationOptions; },
    record: async () => { throw new Error("record_not_expected"); }, checkSave: async () => { throw new Error("check_not_expected"); } }) as never);
  const root = createRoot(dom.window.document.getElementById("root")!);
  const action = (label: string) => [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === label);
  try {
    reviewWorkspace.get(binding).setFeedback("Please correct the missing evidence.");
    await React.act(async () => { root.render(<><OwnerTaskReview {...binding} workspace={reviewWorkspace} onSaved={() => {}} />
      <OwnerTaskVerification {...binding} workspace={verificationWorkspace} onSaved={() => {}} /></>); });
    await flushRead();
    assert.equal(action("Accept")?.disabled, false, "the successful review read enables its action");
    assert.equal(action("I read it and it’s correct")?.disabled, false, "the successful verification read enables its action");
    assert.equal(action("Request changes")?.disabled, false, "the successful review read enables its change-request action");

    reviewMode = "fail"; verificationMode = "fail";
    await React.act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
    await flushRead();
    assert.equal(action("Accept"), undefined, "a failed review refresh removes stale acceptance actions");
    assert.equal(action("Request changes"), undefined, "a failed review refresh removes stale change-request actions");
    assert.equal(action("I read it and it’s correct"), undefined, "a failed verification refresh removes stale verification actions");
    assert.match(dom.window.document.body.textContent ?? "", /current access does not permit/);

    reviewMode = "ok"; verificationMode = "ok";
    await React.act(async () => { action("Refresh recorded review")?.click(); action("Refresh human verification")?.click(); });
    await flushRead();
    assert.equal(action("Accept")?.disabled, false, "a fresh review success restores its action");
    assert.equal(action("Request changes")?.disabled, false, "a fresh review success restores its change-request action");
    assert.equal(action("I read it and it’s correct")?.disabled, false, "a fresh verification success restores its action");
  } finally {
    await React.act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("an accepted legacy result presents one clear pass-only follow-up verification", () => {
  const legacy: TaskVerificationOptions = { ...binding, source: "configured", grantsExecutionAuthority: false, scenarios: [{
    scenarioId: MAC_LOCAL_TEXT_SCENARIO_V1, label: "Finish accepted review",
    instructions: "Read the protected text result and confirm that it satisfies the task instructions.", instructionsDigest,
    recordingMode: "read_correct_attestation", availability: "available", ownVerification: null,
  }] };
  const markup = renderToStaticMarkup(<OwnerVerificationPanel options={legacy} scenarioId="" note=""
    pending={false} held={false} onScenario={() => {}} onResult={() => {}} onNote={() => {}} onRecord={() => {}} />);
  assert.match(markup, /Finish accepted review/);
  assert.match(markup, /I read it and it’s correct/);
  assert.doesNotMatch(markup, /Choose a result|Required observation note|Configured human check/);
});
