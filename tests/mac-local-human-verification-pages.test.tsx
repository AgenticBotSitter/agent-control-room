import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnerVerificationPanel } from "../private-app/app/task-owner-verification";
import { OwnerReviewPanel } from "../private-app/app/task-owner-review";
import { sha256Digest } from "../src/security";
import { MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1, MAC_LOCAL_TEXT_SCENARIO_V1 } from "../src/web/v1/mac-local-owner-review-profile";
import { createTaskVerificationBrowserClient } from "../src/web/v1/task-verification-browser-client";
import type { TaskVerificationDraft, TaskVerificationOptions } from "../src/web/v1/task-verification-wire";
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
