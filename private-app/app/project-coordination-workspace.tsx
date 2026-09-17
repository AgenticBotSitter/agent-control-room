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
  readProjectCoordination,
  replaceProjectCoordinator,
  revokeProjectCoordinator,
} from "../../src/web/v1/project-coordination-browser-client";
import type {
  ProjectCoordinationPage,
  ProjectCoordinationRevision,
  ProjectCoordinatorAppointRequest,
} from "../../src/web/v1/project-coordination-wire";
import { ConfiguredTimestamp } from "./configured-timestamp";

type CoordinationState =
  | { state: "loading" }
  | { state: "ready"; page: ProjectCoordinationPage; revision: ProjectCoordinationRevision }
  | { state: "unavailable"; code: BrowserRequestError["code"]; message: string };

function nextRevision(page: ProjectCoordinationPage): ProjectCoordinationRevision {
  // Exact saved versions, sent back unchanged. Never recomputed from array
  // lengths or presence flags: the server refused anything else.
  return {
    projectId: page.project.projectId,
    expectedCoordinatorVersion: page.versions.coordinatorVersion,
    expectedPolicyVersion: page.versions.policyVersion,
    expectedConflictsVersion: page.versions.conflictsVersion,
    expectedAttentionVersion: page.versions.attentionVersion,
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
      <NextActionHint nextAction={page.nextAction} />
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
        onAction={async (action, selection) => {
          const guard: ProjectCoordinatorAppointRequest["revision"] = revision;
          switch (action) {
            case "appoint-coordinator":
            case "replace-coordinator": {
              if (!selection) return { ok: false, reason: "coordinator_required" };
              const payload = {
                projectId,
                revision: guard,
                coordinatorActorType: selection.coordinatorActorType,
                coordinatorIdentityId: selection.coordinatorIdentityId,
                ...(selection.coordinatorActorType === "agent"
                  ? {
                    executorId: selection.executorId,
                    adapterId: selection.adapterId,
                    connectorProfileDigest: selection.connectorProfileDigest,
                  }
                  : {}),
              };
              const call = action === "appoint-coordinator"
                ? appointProjectCoordinator(payload)
                : replaceProjectCoordinator(payload);
              return submit(
                () => call,
                async () => { onReloaded(await readProjectCoordination(projectId)); },
              );
            }
            case "revoke-coordinator":
              return submit(
                () => revokeProjectCoordinator({
                  projectId,
                  revision: guard,
                  coordinatorActorType: "human",
                  coordinatorIdentityId: page.coordinatorHead.coordinatorIdentityId ?? page.viewerOwnerIdentityId,
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

// The canonical safe next action, rendered as a read-only hint. It never
// authorises anything: lifecycle steps point at the controls below, ledger
// steps point at their section, and policy steps name the deferral instead
// of offering a control that cannot run retry-safe yet.
const NEXT_ACTION_COPY: Record<
  ProjectCoordinationPage["nextAction"],
  { heading: string; detail: string; anchor: string | null }
> = {
  "appoint-coordinator": {
    heading: "Suggested next step: appoint a coordinator",
    detail: "No coordinator head is saved. Name one explicitly in Lifecycle controls below.",
    anchor: "coord-lifecycle-heading",
  },
  "replace-coordinator": {
    heading: "Suggested next step: replace the coordinator",
    detail: "The saved head can be replaced from Lifecycle controls below.",
    anchor: "coord-lifecycle-heading",
  },
  "revoke-coordinator": {
    heading: "Suggested next step: revoke the coordinator",
    detail: "The saved head can be revoked from Lifecycle controls below.",
    anchor: "coord-lifecycle-heading",
  },
  "pause-policy": {
    heading: "Suggested next step: pause the delegation policy",
    detail: "Policy pause controls return with the retry-safe policy package and are not offered on this page.",
    anchor: null,
  },
  "resume-policy": {
    heading: "Suggested next step: resume the delegation policy",
    detail: "Policy resume controls return with the retry-safe policy package and are not offered on this page.",
    anchor: null,
  },
  "revoke-policy": {
    heading: "Suggested next step: revoke the delegation policy",
    detail: "Policy revoke controls return with the retry-safe policy package and are not offered on this page.",
    anchor: null,
  },
  "review-attention": {
    heading: "Suggested next step: review owner attention",
    detail: "Open items are listed under Owner attention below.",
    anchor: "coord-attention-heading",
  },
  "resolve-conflict": {
    heading: "Suggested next step: resolve a resource conflict",
    detail: "Open conflicts are listed under Resource conflicts below.",
    anchor: "coord-conflicts-heading",
  },
  "view-active-work": {
    heading: "Suggested next step: view active work",
    detail: "Adopted tasks are listed under Active work below.",
    anchor: "coord-active-heading",
  },
  none: {
    heading: "No pending coordination step",
    detail: "The saved page names no next action. This is not an all-clear for the fleet.",
    anchor: null,
  },
};

export function NextActionHint({
  nextAction,
}: {
  nextAction: ProjectCoordinationPage["nextAction"];
}) {
  const copy = NEXT_ACTION_COPY[nextAction];
  return (
    <section aria-labelledby="coord-next-action-heading">
      <h3 id="coord-next-action-heading">{copy.heading}</h3>
      <p>
        {copy.detail}
        {copy.anchor && (
          <> See <a href={`#${copy.anchor}`}>the section below</a>.</>
        )}
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

export function AttentionSection({ page }: { page: ProjectCoordinationPage }) {
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
              <strong>Saved question:</strong> {item.ownerQuestion}
            </p>
            <p className="private-note">{describeAttention(item.category)}</p>
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

export type CoordinatorLifecycleAction = "appoint-coordinator" | "replace-coordinator" | "revoke-coordinator";

export interface CoordinatorSelection {
  coordinatorActorType: "human" | "agent";
  coordinatorIdentityId: string;
  executorId: string;
  adapterId: string;
  connectorProfileDigest: string;
}

/**
 * Pure validation for the explicit coordinator choice. Appoint and replace
 * stay disabled until this passes: the browser never invents an identity,
 * pre-fills one, or sends a half-bound agent. Mirrors the server's
 * superRefine (agent binding required, identity must differ from executor).
 */
export function parseCoordinatorSelection(value: {
  coordinatorActorType: "human" | "agent";
  coordinatorIdentityId: string;
  executorId: string;
  adapterId: string;
  connectorProfileDigest: string;
}): { ok: true; selection: CoordinatorSelection } | { ok: false; reason: string } {
  const identityId = value.coordinatorIdentityId.trim();
  if (!identityId) return { ok: false, reason: "Name the coordinator identity explicitly." };
  if (value.coordinatorActorType === "human") {
    return {
      ok: true,
      selection: {
        coordinatorActorType: "human",
        coordinatorIdentityId: identityId,
        executorId: "",
        adapterId: "",
        connectorProfileDigest: "",
      },
    };
  }
  if (!value.executorId.trim() || !value.adapterId.trim() || !value.connectorProfileDigest.trim()) {
    return { ok: false, reason: "An agent coordinator needs executor, adapter, and connector digest." };
  }
  if (identityId === value.executorId.trim()) {
    return { ok: false, reason: "The coordinator identity must differ from the executor." };
  }
  return {
    ok: true,
    selection: {
      coordinatorActorType: "agent",
      coordinatorIdentityId: identityId,
      executorId: value.executorId.trim(),
      adapterId: value.adapterId.trim(),
      connectorProfileDigest: value.connectorProfileDigest.trim(),
    },
  };
}

export function LifecycleControls({
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
    action: CoordinatorLifecycleAction,
    selection?: CoordinatorSelection,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}) {
  const head = page.coordinatorHead;
  const policy = page.delegationPolicy;
  const selfApproval = head.coordinatorActorType === "human"
    && head.coordinatorIdentityId !== null
    && head.coordinatorIdentityId === page.viewerOwnerIdentityId;

  const [feedback, setFeedback] = useState<string | null>(null);
  const [actorType, setActorType] = useState<"human" | "agent">("human");
  const [identityId, setIdentityId] = useState("");
  const [executorId, setExecutorId] = useState("");
  const [adapterId, setAdapterId] = useState("");
  const [connectorProfileDigest, setConnectorProfileDigest] = useState("");
  const parsed = parseCoordinatorSelection({
    coordinatorActorType: actorType,
    coordinatorIdentityId: identityId,
    executorId,
    adapterId,
    connectorProfileDigest,
  });

  const run = (
    action: CoordinatorLifecycleAction,
    label: string,
    selection?: CoordinatorSelection,
  ) => {
    setFeedback(null);
    void onAction(action, selection).then((result) => {
      if (result.ok) {
        setFeedback(`Saved: ${label}.`);
        return;
      }
      setFeedback(`Not saved: ${result.reason}.`);
    });
  };

  const button = (
    action: CoordinatorLifecycleAction,
    label: string,
    enabled: boolean,
    selection?: CoordinatorSelection,
    reasonWhenDisabled?: string,
  ) => (
    <li>
      <button
        type="button"
        disabled={busy || disabled || !enabled}
        onClick={() => run(action, label, selection)}
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
      <p className="private-note">
        Delegation policy pause, resume, and revoke are not offered here: those writes are not
        retry-safe yet and land with the follow-on policy package. Coordinator appoint, replace,
        and revoke below run against the durable receipt ledger today.
      </p>
      <div>
        <label htmlFor="coord-actor-type">Coordinator actor type</label>
        <select
          id="coord-actor-type"
          value={actorType}
          disabled={busy || disabled}
          onChange={(event) => setActorType(event.target.value === "agent" ? "agent" : "human")}
        >
          <option value="human">Human</option>
          <option value="agent">Agent</option>
        </select>
        <label htmlFor="coord-identity">Coordinator identity</label>
        <input
          id="coord-identity"
          type="text"
          value={identityId}
          disabled={busy || disabled}
          placeholder="identity:…"
          onChange={(event) => setIdentityId(event.target.value)}
        />
        {actorType === "agent" && (
          <>
            <label htmlFor="coord-executor">Executor</label>
            <input
              id="coord-executor"
              type="text"
              value={executorId}
              disabled={busy || disabled}
              onChange={(event) => setExecutorId(event.target.value)}
            />
            <label htmlFor="coord-adapter">Adapter</label>
            <input
              id="coord-adapter"
              type="text"
              value={adapterId}
              disabled={busy || disabled}
              onChange={(event) => setAdapterId(event.target.value)}
            />
            <label htmlFor="coord-digest">Connector digest</label>
            <input
              id="coord-digest"
              type="text"
              value={connectorProfileDigest}
              disabled={busy || disabled}
              onChange={(event) => setConnectorProfileDigest(event.target.value)}
            />
          </>
        )}
        <p className="private-note">
          Name the coordinator explicitly — nothing is pre-filled. Your owner identity is{" "}
          <code>{page.viewerOwnerIdentityId}</code>; naming it here is refused by the server.
        </p>
        {!parsed.ok && identityId.trim() !== "" && <p role="status">{parsed.reason}</p>}
      </div>
      <ul>
        {button("appoint-coordinator", "Appoint coordinator", head.state === "none" && parsed.ok,
          parsed.ok ? parsed.selection : undefined,
          head.state === "active" ? "An active coordinator head is already appointed. Replace or revoke instead."
            : !parsed.ok ? "Choose the coordinator above first." : undefined)}
        {button("replace-coordinator", "Replace coordinator head", head.state !== "none" && parsed.ok,
          parsed.ok ? parsed.selection : undefined,
          head.state === "none" ? "There is no current head to replace. Appoint first."
            : !parsed.ok ? "Choose the coordinator above first." : undefined)}
        {button("revoke-coordinator", "Revoke coordinator head", head.state === "active")}
      </ul>
      {feedback && <p role="status">{feedback}</p>}
      {selfApproval && (
        <p role="status" className="private-note">
          The current head names you as the coordinator. Replacing or revoking that head from this
          session is the documented owner flow; the page will not let the coordinator identity
          approve its own proposal through the lifecycle controls.
        </p>
      )}
      {policy && (
        <p className="private-note">
          Policy <code>{policy.policyId}</code> is <strong>{policy.state}</strong>; its pause,
          resume, and revoke controls return with the retry-safe policy package.
        </p>
      )}
    </section>
  );
}
