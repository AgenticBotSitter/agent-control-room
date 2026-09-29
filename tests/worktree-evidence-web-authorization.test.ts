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
    worktreeChangeEvidence: { inspectMany: async scopes => {
      inspections++;
      return scopes.map(() => ({ changedFiles: 1, changedBytes: 1, addedFiles: 1, modifiedFiles: 0, deletedFiles: 0,
        evidenceDigest: `sha256:${"c".repeat(64)}` }));
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

test("another fully privileged project owner cannot read the requester's detailed diff", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  const input = f.complete("owner-exclusive evidence fixture");
  await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const ownerPage = await f.tasks.results(f.identity, "project:test", "job:test");
  if (!("items" in ownerPage) || !ownerPage.items[0]) assert.fail("expected result");
  const artifactId = ownerPage.items[0].artifactId, now = new Date(instant).toISOString();
  await f.db.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:other-owner','tenant:test','human','Other owner',$1,$2,'active',$3,$3)`,
  [trust.issuer, sha256Digest({ provider: trust.issuer, subject: "other-owner" }), now]);
  await f.db.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:other-owner','tenant:test','identity:other-owner','owner',$1::jsonb,$2::jsonb,'critical',false,false,$3,$3)`,
  [JSON.stringify(["projects.read", "tasks.read", "tasks.results.read"]), JSON.stringify(["project:test"]), now]);
  let detailReads = 0;
  const tasks = new WebTaskService(f.db, f.scope, () => instant + 6000, { ...f.taskKeys,
    worktreeChangeEvidence: { inspectMany: async scopes => scopes.map(() => undefined), async inspectOne() {
      detailReads++; return { mustNotReachBrowser: true };
    } } });
  const jwt = token({ sub: "other-owner", iat: instant / 1000 - 60, exp: instant / 1000 + 600 });
  const identity = createAccessVerifier(f.accessTrust)(request(undefined, undefined, undefined, undefined, jwt), instant + 6000);
  const content = await tasks.results(identity, "project:test", "job:test", artifactId);
  if (!("artifact" in content)) assert.fail("expected result content");
  assert.equal(content.worktreeChangeEvidence, undefined);
  assert.equal(detailReads, 0, "requester-only evidence callback must remain unreachable");
});

test("the requesting owner receives detailed evidence only for the exact open result", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  const input = f.complete("requester evidence fixture");
  await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const base = await f.tasks.results(f.identity, "project:test", "job:test");
  if (!("items" in base) || !base.items[0]) assert.fail("expected result");
  const requestRow = (await f.db.query<{ payload: { requestedBy: { actorId: string } } }>(
    "SELECT payload FROM control_requests WHERE tenant_id='tenant:test' AND id='request:test'" )).rows[0];
  assert.equal(requestRow?.payload.requestedBy.actorId, "identity:test");
  const detail = { schema: "control-room.worktree-change-audit-detail/v1" as const,
    baseRevision: "a".repeat(40), headRevision: "b".repeat(40), changes: [], commits: [], commitsTruncated: false,
    unifiedDiff: { text: "", originalBytes: 0, retainedBytes: 0, truncated: false,
      contentDigest: `sha256:${"c".repeat(64)}`, retainedDigest: `sha256:${"c".repeat(64)}` },
    confinement: { kind: "workspace_write" as const, outsideWorktree: "refused" as const,
      evidenceDigest: `sha256:${"d".repeat(64)}` }, evidenceDigest: `sha256:${"e".repeat(64)}` };
  let requestedScope: unknown;
  const tasks = new WebTaskService(f.db, f.scope, () => instant + 6000, { ...f.taskKeys,
    worktreeChangeEvidence: { inspectMany: async scopes => scopes.map(() => undefined), async inspectOne(scope) {
      requestedScope = scope; return detail;
    } } });
  const content = await tasks.results(f.identity, "project:test", "job:test", base.items[0].artifactId);
  if (!("artifact" in content)) assert.fail("expected result content");
  assert.deepEqual(content.worktreeChangeEvidence, detail);
  assert.deepEqual(requestedScope, { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test",
    attemptId: content.artifact.attemptId, runId: content.artifact.runId, artifactId: content.artifact.artifactId });
});
