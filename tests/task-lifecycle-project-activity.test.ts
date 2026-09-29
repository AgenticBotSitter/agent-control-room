import assert from "node:assert/strict";
import test from "node:test";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { WebProjectService } from "../src/web/v1/project-service";
import { WebTaskService } from "../src/web/v1/task-service";
import { fixture, now, request, trust } from "./helpers/web-foundation";
import { taskDraft } from "./helpers/web-task";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
const eventKey = new Uint8Array(32).fill(93);

test("real task and project lifecycle mutations append once and roll back with a rejected event", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const identity = createAccessVerifier(trust)(request(), now);
  const { project } = await f.service.create(identity,
    { title: "Lifecycle activity", summary: "Atomic event integration proof" }, "activity-project-create");
  const tasks = new WebTaskService(f.client, scope, () => now, { harnessIntegrityKey: eventKey });

  const created = await tasks.propose(identity, project.projectId, taskDraft, "activity-task-create");
  const replay = await tasks.propose(identity, project.projectId, taskDraft, "activity-task-create");
  assert.equal(replay.replayed, true);

  const projects = new WebProjectService(f.client, scope, () => now, undefined, undefined, undefined, eventKey);
  await projects.transition(identity, project.projectId, { lifecycle: "completed", expectedVersion: 1 },
    "activity-project-complete");
  await projects.transition(identity, project.projectId, { lifecycle: "archived", expectedVersion: 2 },
    "activity-project-archive");
  const archivedReplay = await projects.transition(identity, project.projectId,
    { lifecycle: "archived", expectedVersion: 2 }, "activity-project-archive");
  assert.equal(archivedReplay.replayed, true);

  const events = await f.client.query<{ safe_summary: string; subject_id: string; sequence: number | string }>(
    `SELECT payload->>'safeSummary' AS safe_summary,payload->'subject'->>'subjectId' AS subject_id,sequence FROM control_project_events
     WHERE tenant_id=$1 AND project_id=$2 ORDER BY sequence`, [scope.tenantId, project.projectId]);
  assert.deepEqual(events.rows.map(row => [row.safe_summary, row.subject_id, Number(row.sequence)]), [
    ["Task created", created.receipt.jobId, 1], ["Project completed", project.projectId, 2],
    ["Project archived", project.projectId, 3],
  ]);

  const { project: rejectedProject } = await f.service.create(identity,
    { title: "Rejected event", summary: "The canonical mutation must roll back" }, "activity-rejected-project");
  await f.db.exec(`CREATE FUNCTION reject_project_activity_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic event rejection'; END $$;
    CREATE TRIGGER reject_project_activity_event BEFORE INSERT ON control_project_events
    FOR EACH ROW EXECUTE FUNCTION reject_project_activity_event();`);
  await assert.rejects(tasks.propose(identity, rejectedProject.projectId, taskDraft, "activity-rejected-task"),
    /source_unavailable/);
  assert.equal((await f.client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_jobs WHERE tenant_id=$1 AND project_id=$2",
    [scope.tenantId, rejectedProject.projectId])).rows[0]?.count, "0");
  assert.equal((await f.client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_project_events WHERE tenant_id=$1 AND project_id=$2",
    [scope.tenantId, rejectedProject.projectId])).rows[0]?.count, "0");
});
