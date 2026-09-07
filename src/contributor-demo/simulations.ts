import { randomUUID } from "node:crypto";
import type { ControlRoomLocalPilotRuntimeV1 } from "../local-pilot/v1/runtime";
import { LOCAL_PILOT_TENANT_ID_V1 } from "../local-pilot/v1/runtime";
import { InMemoryArtifactStorage } from "../node-executor/artifact-storage";
import { buildArtifactLineageRecord, buildTextArtifactBundle, type ArtifactLineageRecordV1 } from "../node-executor/artifact-evidence";
import { runSyntheticExecution } from "../node-executor/synthetic-executor";

/** Session-local simulation only. Does not create native attempts, leases, approval
 * receipts or canonical completion. Completed output is exposed through the existing
 * separately authorized synthetic-result reader. No state survives demo shutdown.
 */
export function createContributorSimulations() {
  const storage = new InMemoryArtifactStorage(100, 6_553_600);
  const lineages = new Map<string, ArtifactLineageRecordV1>();
  type Receipt = { simulationOnly: true; grantsExecutionAuthority: false; artifactId: string; jobId: string; projectId: string };
  const runs = new Map<string, Promise<Receipt>>();
  const controller = new AbortController();
  let closed = false;
  return {
    source: { storage, lineage: (id: string) => lineages.get(id) },
    async start(runtime: ControlRoomLocalPilotRuntimeV1, request: Request, projectId: string, jobId: string): Promise<Receipt> {
      if (closed || request.method !== "POST" || request.headers.get("origin") !== "http://127.0.0.1:3000") {
        throw new Error("demo_simulation_unavailable");
      }
      await runtime.ownerSession.verify(request, new Date().toISOString());
      // Retain the original security headers. The canonical read checks current
      // grants and project/job scope before any cached receipt or new simulation.
      const read = new Request(request.url, { headers: request.headers, signal: request.signal });
      const detail = await runtime.projectTasks.getTask(read, projectId, jobId);
      request.signal.throwIfAborted();
      if (closed) throw new Error("demo_simulation_unavailable");
      const key = JSON.stringify([projectId, jobId]);
      const existing = runs.get(key);
      if (existing) return { ...await existing };
      if (detail.task.state !== "proposed" || runs.size >= 100) throw new Error("demo_simulation_unavailable");
      const work = (async (): Promise<Receipt> => {
        const artifactId = `artifact:demo:${randomUUID()}`, attemptId = `simulation:demo:${randomUUID()}`;
        const text = `SIMULATED RESULT — no agent was called.\n\nTask: ${detail.task.title}\n\nThis sample demonstrates result delivery, not completed research.\n`;
        const result = await runSyntheticExecution({ schema: "control-room.synthetic-execution/v1",
          jobId, attemptId, steps: 3, checkpointEverySteps: 1, stepDelayMilliseconds: 0, artifactText: text }, {
          signal: controller.signal, now: () => new Date().toISOString(), sleep: async () => {}, emit: () => {},
        });
        if (result.state !== "succeeded" || closed) throw new Error("demo_simulation_unavailable");
        const stored = await storage.put({ artifactId, bytes: result.artifactBytes, signal: controller.signal });
        const bundle = buildTextArtifactBundle({ artifactId, claimId: `claim:demo:${randomUUID()}`,
          tenantId: LOCAL_PILOT_TENANT_ID_V1, projectId, jobId, attemptId, producerId: "node:contributor-simulation",
          logicalRole: "synthetic-result", schemaVersion: "1.0.0", storageClass: "local", retentionClass: "demo-session",
          opaqueLocator: stored.opaqueLocator, text, createdAt: new Date().toISOString() });
        lineages.set(artifactId, buildArtifactLineageRecord(bundle));
        return { simulationOnly: true, grantsExecutionAuthority: false, artifactId, jobId, projectId };
      })();
      // Retain failed outcomes too: refreshing must not silently run another attempt.
      runs.set(key, work);
      return { ...await work };
    },
    async close() {
      closed = true;
      controller.abort();
      await Promise.allSettled(runs.values());
      lineages.clear();
      runs.clear();
    },
  };
}
