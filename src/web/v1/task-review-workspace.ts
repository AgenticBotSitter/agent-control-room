import { BrowserRequestError } from "./browser-client";
import { createTaskReviewBrowserClient } from "./task-review-browser-client";
import type { TaskReviewDraft, TaskReviewReceipt } from "./task-review-wire";

export type ReviewWorkspaceBinding = Pick<TaskReviewDraft, "artifactId" | "targetId" | "targetDigest" | "contentHash">
  & { projectId: string; jobId: string };
type Snapshot = { feedback: string; pending: boolean; receipt?: TaskReviewReceipt; error?: BrowserRequestError };

/** Page-owned, memory-only command state. Protected read failures must not destroy an unresolved save. */
export function createTaskReviewWorkspace(makeClient = createTaskReviewBrowserClient) {
  const sessions = new Map<string, ReturnType<typeof createSession>>();
  function createSession(binding: ReviewWorkspaceBinding) {
    const bound = Object.freeze({ ...binding }), client = makeClient(), listeners = new Set<() => void>();
    let snapshot: Snapshot = { feedback: "", pending: false };
    const update = (patch: Partial<Snapshot>) => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
    return {
      client, getSnapshot: () => snapshot,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      setFeedback(feedback: string) { if (!snapshot.pending && !client.hasPending()) update({ feedback }); },
      async save(decision?: TaskReviewDraft["decision"]) {
        if (snapshot.pending) return undefined;
        update({ pending: true, error: undefined });
        try {
          const receipt = decision ? await client.record(bound.projectId, bound.jobId, { artifactId: bound.artifactId,
            targetId: bound.targetId, targetDigest: bound.targetDigest, contentHash: bound.contentHash, decision,
            feedback: decision === "changes_requested" ? snapshot.feedback : "" }) : await client.retrySave();
          update({ receipt, feedback: "" }); return receipt;
        } catch (reason) { update({ error: reason instanceof BrowserRequestError ? reason : new BrowserRequestError("uncertain") }); }
        finally { update({ pending: false }); }
      },
    };
  }
  return {
    get(binding: ReviewWorkspaceBinding) {
      const key = JSON.stringify([binding.projectId, binding.jobId, binding.artifactId, binding.targetId, binding.targetDigest, binding.contentHash]);
      let session = sessions.get(key);
      if (!session) {
        // Never silently evict an unfinished command to make room for another one.
        if (sessions.size >= 128) throw new BrowserRequestError("unavailable");
        session = createSession(binding); sessions.set(key, session);
      }
      return session;
    },
  };
}
export type TaskReviewWorkspace = ReturnType<typeof createTaskReviewWorkspace>;
export type TaskReviewSession = ReturnType<TaskReviewWorkspace["get"]>;
