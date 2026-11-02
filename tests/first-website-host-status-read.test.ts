import assert from "node:assert/strict";
import test from "node:test";
import { ZodError } from "zod";
import { loopImprovementStatusSchemaV1 } from "../src/improve-control-room/v1/schemas";
import { loopDecisionStatusSchemaV1 } from "../src/web/v1/improve-control-room-loop-attention-wire";
import { parseFirstWebsiteStatusBodyV1 } from "../scripts/workflow-journeys/first-website-host";

const h = "a".repeat(64), rev = "b".repeat(40), at = "2026-01-01T00:00:00.000Z";
const display = { schemaVersion: 1, projectId: "project:alpha", requestId: "request:alpha", localVersion: 1, description: "Build a site",
  requestSha256: h, settingsSha256: h, runLinkId: "link:alpha", engineRevision: 7, state: null, startState: "started",
  confirmationCurrent: true, canStart: false, canStop: false, progress: null, attention: null, observedAt: at };
const body = loopDecisionStatusSchemaV1.parse({ schemaVersion: 1,
  request: { requestId: "request:alpha", projectId: "project:alpha", currentVersion: 1, description: "Build a site", requestSha256: h, settingsSha256: h,
    runLink: { adapterId: "adapter:a2", loopRunId: "run-1", toolingRevision: "sha256:" + h, a2SchemaVersion: 1, runLinkId: "link:alpha", initialInputVersion: 1 },
    savedAuthorization: true, createdAt: at, startsWork: false, grantsDeployAuthority: false },
  display, engine: { revision: 7, state: "finished", draft: "Build a site", requestSha256: h, settingsSha256: h, inputVersion: 1,
    confirmation: { sha256: h, at, who: "owner", inputVersion: 1 }, progress: { step: null, completed: 3, attention: "none" },
    approval: null, question: null, identity: "unverified" } });

test("finished /status body is the nested wrapper: flat schema rejects it, host parse returns display", () => {
  assert.throws(() => loopImprovementStatusSchemaV1.parse(body), ZodError);
  const observed = parseFirstWebsiteStatusBodyV1(body);
  assert.equal(observed.engineRevision, 7); assert.equal(observed.startState, "started");
  assert.equal(observed.confirmationCurrent, true); assert.equal(observed.runLinkId, "link:alpha"); assert.equal(observed.localVersion, 1);
});
test("host status parse still rejects a flat body", () => {
  assert.throws(() => parseFirstWebsiteStatusBodyV1(display), ZodError);
});
