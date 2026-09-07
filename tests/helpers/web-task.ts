import { fixture, now, origin, request, trust } from "./web-foundation";
import { WebTaskService } from "../../src/web/v1/task-service";
import { createTaskHttpHandler } from "../../src/web/v1/task-http";
import { createAccessVerifier } from "../../src/web/v1/access-verifier";

export async function taskFixture(clock = () => now) {
  const f = await fixture(clock);
  const identity = createAccessVerifier(trust)(request(), now);
  const { project } = await f.service.create(identity, { title: "Task project", summary: "Real disposable SQL" }, "task-project-create-001");
  const tasks = new WebTaskService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, clock);
  const handler = createTaskHttpHandler({ origin, trust, service: tasks, clock });
  const path = `/api/v1/projects/${encodeURIComponent(project.projectId)}/tasks`;
  return { ...f, identity, project, tasks, handler, path };
}
export const taskDraft = { title: "Compare two launch ideas", instructions: "Compare the audience, effort and useful next steps. Return a short recommendation." };
