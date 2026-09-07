import type { createContributorDemoBrowserClient } from "./browser-client";
import type { createTaskBrowserClient } from "../web/v1/task-browser-client";

/** Read-only restoration. Each artifact is read through the existing scope/hash
 * verifier; a partial read is never returned as a complete history.
 */
export async function loadContributorHistory(clients: {
  simulations: Pick<ReturnType<typeof createContributorDemoBrowserClient>, "history">;
  tasks: Pick<ReturnType<typeof createTaskBrowserClient>, "syntheticResult">;
}, projectId: string, jobId: string) {
  const history = await clients.simulations.history(projectId, jobId);
  const samples: Array<{ artifactId: string; text: string }> = [];
  for (const entry of history.entries) {
    if (entry.state === "succeeded") {
      const result = await clients.tasks.syntheticResult(projectId, jobId, entry.artifactId);
      samples.push({ artifactId: entry.artifactId, text: result.text });
    }
  }
  const last = history.entries.at(-1);
  return { samples, unavailable: last?.state === "unavailable", feedback: last?.state === "unavailable" ? last.feedback ?? "" : "" };
}
