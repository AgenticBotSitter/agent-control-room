import { BrowserRequestError } from "./browser-client";
import { createTaskVerificationBrowserClient } from "./task-verification-browser-client";
import type { TaskVerificationDraft, TaskVerificationReceipt } from "./task-verification-wire";

export type VerificationWorkspaceBinding = Pick<TaskVerificationDraft, "artifactId" | "targetId" | "targetDigest" | "contentHash">
  & { projectId: string; jobId: string };
type DraftSelection = Pick<TaskVerificationDraft, "scenarioId" | "instructionsDigest">;
type Snapshot = { scenarioId: string; outcome?: TaskVerificationDraft["outcome"]; note: string; pending: boolean;
  receipt?: TaskVerificationReceipt; error?: BrowserRequestError };

/** Task-page-owned, memory-only command state. Protected read failures never expose or destroy a draft. */
export function createTaskVerificationWorkspace(makeClient = createTaskVerificationBrowserClient) {
  const sessions = new Map<string, ReturnType<typeof createSession>>();
  function createSession(binding: VerificationWorkspaceBinding) {
    const bound = Object.freeze({ ...binding }), client = makeClient(), listeners = new Set<() => void>();
    let snapshot: Snapshot = { scenarioId: "", note: "", pending: false };
    const update = (patch: Partial<Snapshot>) => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
    const editable = () => !snapshot.pending && !client.hasPending();
    return {
      client, getSnapshot: () => snapshot,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      selectScenario(scenarioId: string) { if (editable()) update({ scenarioId, outcome: undefined, note: "", receipt: undefined, error: undefined }); },
      setOutcome(outcome?: TaskVerificationDraft["outcome"]) { if (editable()) update({ outcome, receipt: undefined, error: undefined }); },
      setNote(note: string) { if (editable()) update({ note, receipt: undefined, error: undefined }); },
      clearError() { if (!client.hasPending()) update({ error: undefined }); },
      async save(selection?: DraftSelection) {
        if (snapshot.pending) return undefined;
        if (selection && client.hasPending()) { update({ error: new BrowserRequestError("uncertain") }); return undefined; }
        const note = snapshot.note.trim();
        update({ pending: true, error: undefined, ...(selection ? { note } : {}) });
        try {
          let receipt: TaskVerificationReceipt;
          if (selection) {
            if (snapshot.scenarioId !== selection.scenarioId || !snapshot.outcome) throw new BrowserRequestError("invalid_request");
            receipt = await client.record(bound.projectId, bound.jobId, { artifactId: bound.artifactId, targetId: bound.targetId,
              targetDigest: bound.targetDigest, contentHash: bound.contentHash, scenarioId: selection.scenarioId,
              instructionsDigest: selection.instructionsDigest, outcome: snapshot.outcome, note });
          } else receipt = await client.checkSave();
          update({ receipt, scenarioId: "", outcome: undefined, note: "" });
          return receipt;
        } catch (reason) {
          update({ error: reason instanceof BrowserRequestError ? reason : new BrowserRequestError("uncertain") });
          return undefined;
        } finally { update({ pending: false }); }
      },
    };
  }
  return {
    hasPending() {
      return [...sessions.values()].some(session => session.getSnapshot().pending || session.client.hasPending());
    },
    get(binding: VerificationWorkspaceBinding) {
      const key = JSON.stringify([binding.projectId, binding.jobId, binding.artifactId, binding.targetId,
        binding.targetDigest, binding.contentHash]);
      let session = sessions.get(key);
      if (!session) {
        // Never silently evict unfinished owner input to make room for another result.
        if (sessions.size >= 128) throw new BrowserRequestError("unavailable");
        session = createSession(binding); sessions.set(key, session);
      }
      return session;
    },
  };
}

export type TaskVerificationWorkspace = ReturnType<typeof createTaskVerificationWorkspace>;
export type TaskVerificationSession = ReturnType<TaskVerificationWorkspace["get"]>;
