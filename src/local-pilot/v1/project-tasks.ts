import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import type { WebProjectService } from "../../web/v1/project-service";
import type { WebTaskService } from "../../web/v1/task-service";
import { readSyntheticResultV1 } from "./synthetic-result-read";
import { WebAccessError } from "../../web/v1/access-verifier";

/** Local-pilot composition only. Reuses canonical services after the existing
 * owner-cookie verifier; no alternate project store, task engine, or native ports.
 * HTTP routing/body bounds remain the mounting handler's responsibility.
 */
export function createLocalPilotProjectTasksV1(
  projects: WebProjectService,
  tasks: WebTaskService,
  verify: (request: Request, method: "GET" | "POST") => Promise<VerifiedWebIdentity>,
  synthetic?: Parameters<typeof readSyntheticResultV1>[1],
) {
  const source = synthetic ? { lineage: synthetic.lineage.bind(synthetic),
    storage: { read: synthetic.storage.read.bind(synthetic.storage) } } : undefined;
  return Object.freeze({
    async listProjects(request: Request, after?: string) {
      return projects.listPage(await verify(request, "GET"), after);
    },
    async getProject(request: Request, projectId: string) {
      return projects.getView(await verify(request, "GET"), projectId);
    },
    async createProject(request: Request, draft: unknown, key: string) {
      return projects.create(await verify(request, "POST"), draft, key);
    },
    async transitionProject(request: Request, projectId: string, draft: unknown, key: string) {
      return projects.transition(await verify(request, "POST"), projectId, draft, key);
    },
    async listTasks(request: Request, projectId: string, after?: string) {
      return tasks.list(await verify(request, "GET"), projectId, after);
    },
    async getTask(request: Request, projectId: string, jobId: string) {
      return tasks.detail(await verify(request, "GET"), projectId, jobId);
    },
    async getResults(request: Request, projectId: string, jobId: string, artifactId?: string) {
      return tasks.results(await verify(request, "GET"), projectId, jobId, artifactId);
    },
    async getSyntheticResult(request: Request, projectId: string, jobId: string, artifactId: string) {
      return tasks.readScopedResult(await verify(request, "GET"), projectId, jobId, async scope => {
        if (!source) throw new Error("synthetic_results_not_configured");
        const result = await readSyntheticResultV1({ ...scope, artifactId }, source, request.signal);
        if (!result) throw new WebAccessError("not_found");
        return result;
      });
    },
    async proposeTask(request: Request, projectId: string, draft: unknown, key: string) {
      return tasks.propose(await verify(request, "POST"), projectId, draft, key);
    },
  });
}

export type LocalPilotProjectTasksV1 = ReturnType<typeof createLocalPilotProjectTasksV1>;
