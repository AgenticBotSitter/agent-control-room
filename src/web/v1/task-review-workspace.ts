import { BrowserRequestError } from "./browser-client";
import { createTaskReviewBrowserClient } from "./task-review-browser-client";
import type { TaskReviewDraft, TaskReviewReceipt } from "./task-review-wire";
import { createTaskRevisionBrowserClient } from "./task-revision-browser-client";
import type { TaskRevisionRequest, TaskRevisionReceipt } from "./task-revision-wire";

export type ReviewWorkspaceBinding = Pick<TaskReviewDraft, "artifactId" | "targetId" | "targetDigest" | "contentHash">
  & { projectId: string; jobId: string };
type Snapshot = { feedback: string; pending: boolean; receipt?: TaskReviewReceipt; error?: BrowserRequestError;
  revisionPending: boolean; revisionReceipt?: TaskRevisionReceipt; revisionError?: BrowserRequestError };

/** Page-owned, memory-only command state. Protected read failures must not destroy an unresolved save. */
export function createTaskReviewWorkspace(makeClient = createTaskReviewBrowserClient, makeRevisionClient = createTaskRevisionBrowserClient) {
  const sessions = new Map<string, ReturnType<typeof createSession>>();
  function createSession(binding: ReviewWorkspaceBinding) {
    const bound = Object.freeze({ ...binding }), client = makeClient(), revisionClient = makeRevisionClient(), listeners = new Set<() => void>();
    let snapshot: Snapshot = { feedback: "", pending: false, revisionPending: false };
    const update = (patch: Partial<Snapshot>) => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
    return {
      client, revisionClient, getSnapshot: () => snapshot,
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
      async prepareRevision(input?: TaskRevisionRequest) {
        if (snapshot.revisionPending) return undefined;
        update({ revisionPending: true, revisionError: undefined });
        try {
          if (input && (input.targetId !== bound.targetId || input.targetDigest !== bound.targetDigest || input.contentHash !== bound.contentHash))
            throw new BrowserRequestError("invalid_request");
          const revisionReceipt = input ? await revisionClient.prepare(bound.projectId, bound.jobId, input) : await revisionClient.retrySave();
          update({ revisionReceipt }); return revisionReceipt;
        } catch (reason) { update({ revisionError: reason instanceof BrowserRequestError ? reason : new BrowserRequestError("uncertain") }); }
        finally { update({ revisionPending: false }); }
      },
    };
  }
  return {
    hasPending() {
      return [...sessions.values()].some(session => {
        const snapshot = session.getSnapshot();
        return snapshot.pending || snapshot.revisionPending || session.client.hasPending() || session.revisionClient.hasPending();
      });
    },
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
