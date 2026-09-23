import assert from "node:assert/strict";
import test from "node:test";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { WebTaskService } from "../src/web/v1/task-service";
import { sha256Digest } from "../src/security";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { request, token, trust } from "./helpers/web-foundation";

test("a task reader without result permission cannot invoke the protected change-evidence projection", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  const input = f.complete("aggregate authorization fixture");
  await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const now = new Date(instant).toISOString();
  await f.db.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:reader','tenant:test','human','Read only',$1,$2,'active',$3,$3)`,
  [trust.issuer, sha256Digest({ provider: trust.issuer, subject: "result-metadata-reader" }), now]);
  await f.db.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:reader','tenant:test','identity:reader','operator',$1::jsonb,$2::jsonb,'low',false,false,$3,$3)`,
  [JSON.stringify(["projects.read", "tasks.read"]), JSON.stringify(["project:test"]), now]);
  let inspections = 0;
  const tasks = new WebTaskService(f.db, f.scope, () => instant + 6000, {
    ...f.taskKeys,
    worktreeChangeEvidence: { inspect: async () => {
      inspections++;
      return { changedFiles: 1, changedBytes: 1, addedFiles: 1, modifiedFiles: 0, deletedFiles: 0,
        evidenceDigest: `sha256:${"c".repeat(64)}` };
    } },
  });
  const jwt = token({ sub: "result-metadata-reader", iat: instant / 1000 - 60, exp: instant / 1000 + 600 });
  const identity = createAccessVerifier(f.accessTrust)(request(undefined, undefined, undefined, undefined, jwt), instant + 6000);
  const page = await tasks.results(identity, "project:test", "job:test");
  if (!("items" in page)) assert.fail("expected result page");
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0]?.worktreeChangeSummary, { source: "not_authorized" });
  assert.equal(inspections, 0, "the protected evidence callback must stay unreachable without tasks.results.read");
});
