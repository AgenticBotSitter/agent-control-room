import assert from "node:assert/strict";
import test from "node:test";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";
import { WebTaskService } from "../src/web/v1/task-service";
import { taskFixture } from "./helpers/web-task";
import { now, request, token, trust } from "./helpers/web-foundation";

test("an owner scoped to another project cannot read task or project usage", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const { project: otherProject } = await f.service.create(f.identity, { title: "Other project", summary: "Separate owner scope" },
    "usage-other-project-create");
  const when = new Date(now).toISOString();
  await f.client.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:other','tenant:web','human','Other owner',$1,$2,'active',$3,$3)`,
  [trust.issuer, sha256Digest({ provider: trust.issuer, subject: "other-owner" }), when]);
  await f.client.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:other','tenant:web','identity:other','operator',$1::jsonb,$2::jsonb,'low',false,false,$3,$3)`,
  [JSON.stringify(["projects.read", "tasks.read"]), JSON.stringify([otherProject.projectId]), when]);
  const jwt = token({ sub: "other-owner" });
  const other = createAccessVerifier(trust)(request(undefined, undefined, undefined, undefined, jwt), now);
  const tasks = new WebTaskService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => now,
    { usagePriceTable: { schema: "control-room.usage-price-table/v1", tableId: "owner-price-table", recordedAt: when, entries: [] } });
  await assert.rejects(tasks.projectOverview(other, f.project.projectId), /access_denied/);
  const proposed = await f.tasks.propose(f.identity, f.project.projectId,
    { title: "Private usage", instructions: "Keep usage scoped to this project." }, "private-usage-task");
  await assert.rejects(tasks.detail(other, f.project.projectId, proposed.receipt.jobId), /access_denied/);
});
