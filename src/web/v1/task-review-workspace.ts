import { BrowserRequestError } from "./browser-client";
import type { BrowserAuthenticationBinding, BrowserAuthenticationObserver } from "./browser-client";
import { createTaskReviewBrowserClient } from "./task-review-browser-client";
import type { TaskReviewDraft, TaskReviewReceipt } from "./task-review-wire";
import { createTaskRevisionBrowserClient } from "./task-revision-browser-client";
import type { TaskRevisionRequest, TaskRevisionReceipt } from "./task-revision-wire";

export type ReviewWorkspaceBinding = Pick<TaskReviewDraft, "artifactId" | "targetId" | "targetDigest" | "contentHash">
  & { projectId: string; jobId: string };
type Snapshot = { feedback: string; pending: boolean; receipt?: TaskReviewReceipt; error?: BrowserRequestError;
  revisionPending: boolean; revisionReceipt?: TaskRevisionReceipt; revisionError?: BrowserRequestError;
  attestations: Readonly<Record<string, boolean>> };
/** The attestation a gesture applies to. The instructions a scenario asks the
 * owner to carry out are part of the identity, not decoration: if the digest
 * changes, the owner was asked to do something different and must say so
 * again. */
type AttestationIdentity = { scenarioId: string; instructionsDigest: string };
const attestationKey = (authentication: BrowserAuthenticationBinding, identity: AttestationIdentity) =>
  JSON.stringify([authentication.actorId, authentication.sessionEpoch, identity.scenarioId, identity.instructionsDigest]);
type ReviewClientFactory = (observeAuthentication?: BrowserAuthenticationObserver) => ReturnType<typeof createTaskReviewBrowserClient>;

/** Page-owned, memory-only command state. Protected read failures must not destroy an unresolved save. */
export function createTaskReviewWorkspace(
  makeClient: ReviewClientFactory = observe => createTaskReviewBrowserClient(fetch, () => crypto.randomUUID(), observe),
  makeRevisionClient = createTaskRevisionBrowserClient,
) {
  const sessions = new Map<string, ReturnType<typeof createSession>>();
  let authentication: BrowserAuthenticationBinding | undefined;
  const sameAuthentication = (left?: BrowserAuthenticationBinding, right?: BrowserAuthenticationBinding) =>
    left?.actorId === right?.actorId && left?.sessionEpoch === right?.sessionEpoch;
  const bindAuthenticatedSession = (next?: BrowserAuthenticationBinding) => {
    if (sameAuthentication(authentication, next)) return;
    authentication = next ? Object.freeze({ ...next }) : undefined;
    // A gesture is authority from one authenticated browser session. It must
    // never survive a direct handoff, a 401, logout, or a later sign-in.
    for (const session of sessions.values()) session.clearAttestations();
  };
  function createSession(binding: ReviewWorkspaceBinding) {
    const bound = Object.freeze({ ...binding }), client = makeClient(bindAuthenticatedSession), revisionClient = makeRevisionClient(), listeners = new Set<() => void>();
    let snapshot: Snapshot = { feedback: "", pending: false, revisionPending: false, attestations: {} };
    let retryAttestation: AttestationIdentity | undefined;
    /* The owner's read-and-correct gesture lives HERE, on the result-bound
     * session, rather than in the panel or in a module-global map. This is the
     * result-binding fix: the map that used to hold it was keyed only on the scenario and
     * the instructions digest, none of which distinguish one result from
     * another, so ticking the box for result A arrived already ticked for
     * result B — a different artifact with a different content hash — and
     * enabled Accept without a second owner gesture.
     *
     * Keying on the result session and authenticated binding means the gesture is scoped to the exact review
     * identity: project, job, artifact, target, target digest and content hash
     * are the workspace's own key, while actor and session epoch are part of
     * the attestation key. Two results or two authenticated sessions can never
     * share a tick. Within a session the scenario and instructions decide, so
     * changed instructions also reset it. The lifetime is right too — the
     * session is page-owned and memory-only, and is capped at 128 alongside the
     * drafts it already retains rather than living for the process.
     *
     * It is part of the snapshot, not a side table read during render, so
     * `useSyncExternalStore` sees a changed snapshot and re-renders on a tick
     * and on an uncheck. */
    const update = (patch: Partial<Snapshot>) => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
    // A spread alone would not clear a retracted key, so the record is rebuilt
    // without it. The entry is removed rather than set false, so the snapshot
    // only ever carries a gesture that is live.
    const setAttestation = (identity: AttestationIdentity, attested: boolean) => {
      if (!authentication) return;
      const key = attestationKey(authentication, identity), { [key]: _dropped, ...rest } = snapshot.attestations;
      update({ attestations: attested ? { ...rest, [key]: true } : rest });
    };
    const isAttested = (identity: AttestationIdentity) => !!authentication
      && snapshot.attestations[attestationKey(authentication, identity)] === true;
    return {
      client, revisionClient, getSnapshot: () => snapshot,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      clearAttestations() { if (Object.keys(snapshot.attestations).length) update({ attestations: {} }); },
      setFeedback(feedback: string) { if (!snapshot.pending && !client.hasPending()) update({ feedback }); },
      /** The owner's gesture for one exact attestation of THIS result, or false
       * for any attestation the owner has not been shown or has retracted. */
      attested(identity: AttestationIdentity) { return isAttested(identity); },
      /** An explicit uncheck retracts the gesture rather than parking a `false`
       * next to it, so the record only ever holds a gesture that is live. */
      setAttested(identity: AttestationIdentity, value: boolean) { setAttestation(identity, value); },
      async save(decision?: TaskReviewDraft["decision"], acceptanceAttestation?: TaskReviewDraft["acceptanceAttestation"]) {
        if (snapshot.pending) return undefined;
        const requiredGesture = acceptanceAttestation ?? (!decision ? retryAttestation : undefined);
        if (requiredGesture && !isAttested(requiredGesture)) {
          update({ error: new BrowserRequestError("invalid_request") });
          return undefined;
        }
        update({ pending: true, error: undefined });
        try {
          if (decision === "accepted" && acceptanceAttestation) retryAttestation = acceptanceAttestation;
          const receipt = decision ? await client.record(bound.projectId, bound.jobId, { artifactId: bound.artifactId,
            targetId: bound.targetId, targetDigest: bound.targetDigest, contentHash: bound.contentHash, decision,
            feedback: decision === "changes_requested" ? snapshot.feedback : "", ...(acceptanceAttestation ? { acceptanceAttestation } : {}) }) : await client.retrySave();
          // The decision is saved against this exact binding, so the gesture
          // that authorised it has been spent. Leaving it set would let a later
          // re-render re-enable Accept with a gesture the owner already used.
          if (decision && acceptanceAttestation && isAttested(acceptanceAttestation))
            setAttestation(acceptanceAttestation, false);
          retryAttestation = undefined;
          update({ receipt, feedback: "" }); return receipt;
        } catch (reason) {
          if (!client.hasPending()) retryAttestation = undefined;
          update({ error: reason instanceof BrowserRequestError ? reason : new BrowserRequestError("uncertain") });
        }
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
    bindAuthenticatedSession,
    invalidateAuthenticatedSession() { bindAuthenticatedSession(undefined); },
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
