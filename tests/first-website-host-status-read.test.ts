import assert from "node:assert/strict";
import test from "node:test";
import { ZodError } from "zod";
import { loopImprovementStatusSchemaV1 } from "../src/improve-control-room/v1/schemas";
import { loopDecisionStatusSchemaV1 } from "../src/web/v1/improve-control-room-loop-attention-wire";
import { readFirstWebsiteColdStatusV1 } from "../scripts/workflow-journeys/first-website-host";

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

const path = "/api/v1/projects/project:alpha/improvements/loop/request:alpha";
const expected = { engineRevision: 7, runLinkId: "link:alpha", localVersion: 1 };
const stub = (payload: unknown, status = 200) => async (p: string) => {
  assert.equal(p, path + "/status"); return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
};

test("flat schema rejects the real nested /status body (the old failure)", () => {
  assert.throws(() => loopImprovementStatusSchemaV1.parse(body), ZodError);
});
test("host finished-read accepts the nested /status body and returns display", async () => {
  const observed = await readFirstWebsiteColdStatusV1(stub(body), path, expected);
  assert.equal(observed.engineRevision, 7); assert.equal(observed.runLinkId, "link:alpha"); assert.equal(observed.localVersion, 1);
});
test("host finished-read refuses a flat body, a mismatched display and a non-200", async () => {
  await assert.rejects(readFirstWebsiteColdStatusV1(stub(display), path, expected), ZodError);
  await assert.rejects(readFirstWebsiteColdStatusV1(stub(body), path, { ...expected, engineRevision: 8 }), { code: "B5_HOST_COLD_STATUS" });
  await assert.rejects(readFirstWebsiteColdStatusV1(stub(body, 500), path, expected), { code: "B5_HOST_COLD_STATUS" });
});
