"use client";

// Renders the project-coordination workspace, composing the existing
// navigation and overview-activity components with the coordination-only
// children (active work, dependencies, conflicts, owner-attention, lifecycle
// controls). This is the page body for the coordination subroute that lives
// under each project's existing tabs.

import { useEffect, useMemo, useState } from "react";
import {
  appointProjectCoordinator,
  BrowserAuthenticationRecoveryError,
  BrowserRequestError,
  browserErrorMessage,
  pauseProjectDelegationPolicy,
  readProjectCoordination,
  replaceProjectCoordinator,
  resumeProjectDelegationPolicy,
  revokeProjectCoordinator,
  revokeProjectDelegationPolicy,
} from "../../src/web/v1/project-coordination-browser-client";
import type {
  ProjectCoordinationPage,
  ProjectCoordinationRevision,
  ProjectCoordinatorAppointRequest,
  ProjectCoordinatorRevokePolicyRequest,
  ProjectCoordinatorRevokeRequest,
} from "../../src/web/v1/project-coordination-wire";
import { ConfiguredTimestamp } from "./configured-timestamp";

type CoordinationState =
  | { state: "loading" }
  | { state: "ready"; page: ProjectCoordinationPage; revision: ProjectCoordinationRevision }
  | { state: "unavailable"; code: BrowserRequestError["code"]; message: string };

function nextRevision(page: ProjectCoordinationPage): ProjectCoordinationRevision {
  return {
    projectId: page.project.projectId,
    expectedCoordinatorVersion: page.coordinatorHead.version,
    expectedPolicyVersion: page.delegationPolicy ? 1 : 0,
    expectedConflictsVersion: page.conflicts.length,
    expectedAttentionVersion: page.attention.length,
    observedAt: page.observedAt,
  };
}

function describeAttention(category: ProjectCoordinationPage["attention"][number]["category"]): string {
  switch (category) {
    case "uncertainty": return "What was already recorded, and is it safe to continue?";
    case "failure": return "What failed, and what evidence should be reviewed before new work?";
    case "approval": return "Is the saved request ready for your approval or submission?";
    case "review": return "Does the saved result meet the requested outcome, or does it need changes?";
    case "preparation": return "Is this saved work ready for its next preparation or assignment step?";
  }
}

function readRevisionFromPage(page: ProjectCoordinationPage): ProjectCoordinationRevision {
  return nextRevision(page);
}

export function ProjectCoordinationWorkspace({ projectId }: { projectId: string }) {
  const [state, setState] = useState<CoordinationState>({ state: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setState({ state: "loading" });
    void readProjectCoordination(projectId)
      .then((page) => {
        if (!live) return;
        setState({ state: "ready", page, revision: readRevisionFromPage(page) });
      })
      .catch((error: unknown) => {
        if (!live) return;
        if (error instanceof BrowserAuthenticationRecoveryError) {
          setState({ state: "unavailable", code: "authentication_required", message: error.message });
          return;
        }
        if (error instanceof BrowserRequestError) {
          const message = error.code === "invalid_request"
            ? "This project is not a coordination target. Return to the project overview."
            : error.code === "not_found"
              ? "This project no longer exists or your access has changed."
              : error.code === "access_denied"
                ? "Your current access does not include coordination for this project."
                : browserErrorMessage[error.code];
          setState({ state: "unavailable", code: error.code, message });
          return;
        }
        setState({
          state: "unavailable",
          code: "unavailable",
          message: browserErrorMessage.unavailable,
        });
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  if (state.state === "loading") {
    return (
      <section className="private-panel" aria-label="Project coordination">
        <h2>Project coordination</h2>
        <p role="status">Reading this project’s coordination state…</p>
      </section>
    );
  }
  if (state.state === "unavailable") {
    return (
      <section className="private-panel" aria-label="Project coordination">
        <h2>Project coordination</h2>
        <p role="alert">{state.message}</p>
        {state.code === "authentication_required" && (
          <p>Sign in again in another tab and return here. Retry will not start an agent.</p>
        )}
      </section>
    );
  }

  return (
    <CoordinationReadyView
      projectId={projectId}
      state={state}
      busy={busy}
      setBusy={setBusy}
      onReloaded={(page) => setState({ state: "ready", page, revision: readRevisionFromPage(page) })}
    />
  );
}

function CoordinationReadyView({
  projectId,
  state,
  busy,
  setBusy,
  onReloaded,
}: {
  projectId: string;
  state: { state: "ready"; page: ProjectCoordinationPage; revision: ProjectCoordinationRevision };
  busy: boolean;
  setBusy: (value: boolean) => void;
  onReloaded: (page: ProjectCoordinationPage) => void;
}) {
  const { page, revision } = state;
  const disabled = !page.coordinationEnabled;

  const submit = async (
    work: () => Promise<{ status: "accepted" | "refused"; reasonCode?: string }>,
    onAccepted: () => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    setBusy(true);
    try {
      const result = await work();
      if (result.status === "accepted") {
        await onAccepted();
        return { ok: true as const };
      }
      return { ok: false as const, reason: result.reasonCode ?? "refused" };
    } catch (error: unknown) {
      if (error instanceof BrowserAuthenticationRecoveryError) {
        return { ok: false as const, reason: "authentication_required" };
      }
      if (error instanceof BrowserRequestError) {
        return { ok: false as const, reason: error.code };
      }
      return { ok: false as const, reason: "uncertain" };
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="private-panel" aria-label="Project coordination">
      <h2>Project coordination</h2>
      <p>
        Saved <ConfiguredTimestamp value={page.observedAt} prefix="Observed" />
      </p>
      {disabled && (
        <p role="status" className="private-note">
          Coordination is disabled for this project. The page still shows the saved head; lifecycle
          controls are unavailable until the operator enables coordination in the product
          configuration.
        </p>
      )}
      <CoordinatorHeadSummary projectId={projectId} page={page} revision={revision} />
      <DelegationPolicySummary projectId={projectId} page={page} revision={revision} />
      <ActiveWorkSection projectId={projectId} page={page} />
      <DependenciesSection page={page} />
      <ConflictsSection projectId={projectId} page={page} />
      <AttentionSection page={page} />
      <LifecycleControls
        projectId={projectId}
        page={page}
        revision={revision}
        busy={busy}
        disabled={disabled}
        onAction={async (action) => {
          const guard: ProjectCoordinatorRevokePolicyRequest["revision"] = revision;
          switch (action) {
            case "appoint-coordinator":
              return submit(
                () => appointProjectCoordinator({
                  projectId,
                  revision: guard,
                  coordinatorActorType: "human",
                  coordinatorIdentityId: "owner-self",
                }),
                async () => { onReloaded(await readProjectCoordination(projectId)); },
              );
            case "replace-coordinator":
              return submit(
                () => replaceProjectCoordinator({
                  projectId,
                  revision: guard,
                  coordinatorActorType: "human",
                  coordinatorIdentityId: "owner-self",
                }),
                async () => { onReloaded(await readProjectCoordination(projectId)); },
              );
            case "revoke-coordinator":
              return submit(
                () => revokeProjectCoordinator({
                  projectId,
                  revision: guard,
                  coordinatorActorType: "human",
                  coordinatorIdentityId: page.coordinatorHead.coordinatorIdentityId ?? "owner-self",
                }),
                async () => { onReloaded(await readProjectCoordination(projectId)); },
              );
            case "pause-policy":
              if (!page.delegationPolicy) return { ok: false, reason: "policy_required" };
              return submit(
                () => pauseProjectDelegationPolicy({
                  projectId,
                  revision: guard,
                  policyId: page.delegationPolicy!.policyId,
                }),
                async () => { onReloaded(await readProjectCoordination(projectId)); },
              );
            case "resume-policy":
              if (!page.delegationPolicy) return { ok: false, reason: "policy_required" };
              return submit(
                () => resumeProjectDelegationPolicy({
                  projectId,
                  revision: guard,
                  policyId: page.delegationPolicy!.policyId,
                }),
                async () => { onReloaded(await readProjectCoordination(projectId)); },
              );
            case "revoke-policy":
              if (!page.delegationPolicy) return { ok: false, reason: "policy_required" };
              return submit(
                () => revokeProjectDelegationPolicy({
                  projectId,
                  revision: guard,
                  policyId: page.delegationPolicy!.policyId,
                }),
                async () => { onReloaded(await readProjectCoordination(projectId)); },
              );
          }
        }}
      />
    </section>
  );
}

function CoordinatorHeadSummary({ projectId, page, revision }: {
  projectId: string;
  page: ProjectCoordinationPage;
  revision: ProjectCoordinationRevision;
}) {
  const head = page.coordinatorHead;
  const appointed = head.state === "active" && head.coordinatorActorType
    ? `${head.coordinatorActorType} coordinator ${head.coordinatorIdentityId ?? "(unknown)"}`
    : head.state === "revoked"
      ? "revoked coordinator head"
      : "no coordinator appointed";
  return (
    <section aria-labelledby="coord-head-heading">
      <h3 id="coord-head-heading">Coordinator</h3>
      <p>{appointed}</p>
      {head.state === "active" && head.executorId && head.adapterId && (
        <p>
          Bound executor <code>{head.executorId}</code> via adapter <code>{head.adapterId}</code>; execution
          binding digest <code>{head.executionBindingDigest ?? "(missing)"}</code>.
        </p>
      )}
      <p>
        Head version {head.version}; checked at <ConfiguredTimestamp value={revision.observedAt} prefix="" />.{" "}
        Owner-only controls below require the head version the page was loaded with. A stale page
        refuses the action; refresh first.
      </p>
    </section>
  );
}

function DelegationPolicySummary({ projectId, page, revision }: {
  projectId: string;
  page: ProjectCoordinationPage;
  revision: ProjectCoordinationRevision;
}) {
  if (!page.delegationPolicy) {
    return (
      <section aria-labelledby="coord-policy-heading">
        <h3 id="coord-policy-heading">Delegation policy</h3>
        <p>No delegation policy is attached to this coordinator head.</p>
      </section>
    );
  }
  const policy = page.delegationPolicy;
  return (
    <section aria-labelledby="coord-policy-heading">
      <h3 id="coord-policy-heading">Delegation policy</h3>
      <p>
        Policy <code>{policy.policyId}</code> is <strong>{policy.state}</strong> for coordinator version{" "}
        {policy.coordinatorVersion}. Allowed actions: {policy.allowedActions.join(", ")}.
      </p>
      <p>
        Task allowance: {policy.taskUnitsUsed} of {policy.taskAllowance}. Micro-USD: {policy.microUsdUsed} of{" "}
        {policy.microUsdCeiling}. Concurrency: {policy.concurrencyUnitsUsed} of {policy.concurrencyAllowance}.
      </p>
      <p>
        Validity window: <ConfiguredTimestamp value={policy.validFrom} prefix="from" /> to{" "}
        <ConfiguredTimestamp value={policy.validUntil} prefix="until" />.
      </p>
      <p>
        Head version {policy.coordinatorVersion}; checked at <ConfiguredTimestamp value={revision.observedAt} prefix="" />.
      </p>
    </section>
  );
}

function ActiveWorkSection({ projectId, page }: { projectId: string; page: ProjectCoordinationPage }) {
  if (page.activeWork.length === 0) {
    return (
      <section aria-labelledby="coord-active-heading">
        <h3 id="coord-active-heading">Active work</h3>
        <p>No coordinator-adopted tasks on this project.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="coord-active-heading">
      <h3 id="coord-active-heading">Active work</h3>
      <ul>
        {page.activeWork.map((item) => (
          <li key={item.jobId}>
            <a href={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(item.jobId)}`}>
              {item.title}
            </a>
            <p>
              State <code>{item.state}</code>; updated <ConfiguredTimestamp value={item.updatedAt} prefix="" />.
              Proposal <code>{item.proposalId}</code> digest <code>{item.proposalDigest}</code>.
            </p>
            {item.writeScopes.length > 0 && (
              <p>Write scopes: {item.writeScopes.map((scope) => <code key={scope}>{scope}</code>).reduce((acc, el, idx) => idx === 0 ? [el] : [...acc, ", ", el], [] as React.ReactNode[])}</p>
            )}
            {item.readScopes.length > 0 && (
              <p>Read scopes: {item.readScopes.map((scope) => <code key={scope}>{scope}</code>).reduce((acc, el, idx) => idx === 0 ? [el] : [...acc, ", ", el], [] as React.ReactNode[])}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DependenciesSection({ page }: { page: ProjectCoordinationPage }) {
  if (page.dependencies.length === 0) return null;
  return (
    <section aria-labelledby="coord-deps-heading">
      <h3 id="coord-deps-heading">Dependencies</h3>
      <ul>
        {page.dependencies.map((edge) => (
          <li key={`${edge.fromJobId}->${edge.toJobId}`}>
            <code>{edge.fromJobId}</code> → <code>{edge.toJobId}</code> ({edge.required ? "required" : "soft"})
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConflictsSection({ projectId, page }: { projectId: string; page: ProjectCoordinationPage }) {
  if (page.conflicts.length === 0) {
    return (
      <section aria-labelledby="coord-conflicts-heading">
        <h3 id="coord-conflicts-heading">Resource conflicts</h3>
        <p>No active conflicts on this project.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="coord-conflicts-heading">
      <h3 id="coord-conflicts-heading">Resource conflicts</h3>
      <ul>
        {page.conflicts.map((entry) => (
          <li key={entry.ledgerId}>
            <strong>{entry.reasonCode}</strong> on <code>{entry.resourcePath}</code> ({entry.resourceKind}) in
            repository <code>{entry.repository}</code>
            {entry.conflictingJobId && (
              <>: job <a href={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(entry.conflictingJobId)}`}><code>{entry.conflictingJobId}</code></a></>
            )}
            {entry.resolutionKind ? (
              <p>Resolved by <code>{entry.resolutionKind}</code> at {entry.resolvedAt ? <ConfiguredTimestamp value={entry.resolvedAt} prefix="" /> : "an unknown time"}.</p>
            ) : (
              <p>Open conflict; raised at <ConfiguredTimestamp value={entry.raisedAt} prefix="" />.</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AttentionSection({ page }: { page: ProjectCoordinationPage }) {
  if (page.attention.length === 0) {
    return (
      <section aria-labelledby="coord-attention-heading">
        <h3 id="coord-attention-heading">Owner attention</h3>
        <p>No coordination items need owner attention. This is not an all-clear for the fleet.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="coord-attention-heading">
      <h3 id="coord-attention-heading">Owner attention</h3>
      <ul>
        {page.attention.map((item) => (
          <li key={item.attentionId}>
            <strong>{item.severity}</strong> · {item.category.replaceAll("_", " ")}
            <p>
              <strong>Question for you:</strong> {describeAttention(item.category)}
            </p>
            {item.referencedJobId && (
              <p>
                Task <code>{item.referencedJobId}</code> observed at{" "}
                <ConfiguredTimestamp value={item.observedAt} prefix="" />.
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function LifecycleControls({
  projectId,
  page,
  revision,
  busy,
  disabled,
  onAction,
}: {
  projectId: string;
  page: ProjectCoordinationPage;
  revision: ProjectCoordinationRevision;
  busy: boolean;
  disabled: boolean;
  onAction: (
    action: "appoint-coordinator" | "replace-coordinator" | "revoke-coordinator" | "pause-policy" | "resume-policy" | "revoke-policy",
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}) {
  const head = page.coordinatorHead;
  const policy = page.delegationPolicy;
  const isHuman = head.coordinatorActorType === "human";
  const selfApproval = head.coordinatorActorType === "human" && head.coordinatorIdentityId === "owner-self";

  const [feedback, setFeedback] = useState<string | null>(null);

  const button = (
    action: "appoint-coordinator" | "replace-coordinator" | "revoke-coordinator" | "pause-policy" | "resume-policy" | "revoke-policy",
    label: string,
    enabled: boolean,
    reasonWhenDisabled?: string,
  ) => (
    <li>
      <button
        type="button"
        disabled={busy || disabled || !enabled}
        onClick={() => {
          setFeedback(null);
          void onAction(action).then((result) => {
            if (result.ok) {
              setFeedback(`Saved: ${label}.`);
              return;
            }
            setFeedback(`Not saved: ${result.reason}.`);
          });
        }}
      >
        {label}
      </button>
      {!enabled && reasonWhenDisabled && <span> {reasonWhenDisabled}</span>}
    </li>
  );

  return (
    <section aria-labelledby="coord-lifecycle-heading">
      <h3 id="coord-lifecycle-heading">Lifecycle controls</h3>
      <p>
        Every action runs against head version {head.version} checked at{" "}
        <ConfiguredTimestamp value={revision.observedAt} prefix="" />. The page re-renders only after
        the server returns an accepted result and a new revision. Disabled controls are explained in
        line; the reasons are the only authority for why a control is unavailable.
      </p>
      <ul>
        {button("appoint-coordinator", "Appoint human coordinator", head.state === "none",
          head.state === "active" ? "An active coordinator head is already appointed. Replace or revoke instead." : undefined)}
        {button("replace-coordinator", "Replace coordinator head", head.state !== "none",
          head.state === "none" ? "There is no current head to replace. Appoint first." : undefined)}
        {button("revoke-coordinator", "Revoke coordinator head", head.state === "active")}
        {button("pause-policy", "Pause delegation policy", policy?.state === "active",
          !policy ? "No delegation policy is attached." : policy.state !== "active" ? "Policy is not active." : undefined)}
        {button("resume-policy", "Resume delegation policy", policy?.state === "paused",
          !policy ? "No delegation policy is attached." : policy.state !== "paused" ? "Policy is not paused." : undefined)}
        {button("revoke-policy", "Revoke delegation policy", policy?.state === "active",
          !policy ? "No delegation policy is attached." : policy.state === "revoked" ? "Already revoked." : undefined)}
      </ul>
      {feedback && <p role="status">{feedback}</p>}
      {isHuman && selfApproval && (
        <p role="status" className="private-note">
          The current head names you as the coordinator. Replacing or revoking that head from this
          session is the documented owner flow; the page will not let the coordinator identity
          approve its own proposal through the lifecycle controls.
        </p>
      )}
    </section>
  );
}
