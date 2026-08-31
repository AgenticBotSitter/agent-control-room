import { z } from "zod";
import { sha256Digest } from "../../../security";
import { ContentBloomsContractErrorV1 } from "./errors";
import { parseExactContentBloomsV1 } from "./exact";
import { parseContentBloomsAdapterReleaseV1 } from "./release";
import {
  contentBloomsAdapterControlStateSchemaV1,
  contentBloomsAdapterReleaseSchemaV1,
  contentBloomsControlTransitionReceiptSchemaV1,
  contentBloomsControlTransitionSchemaV1,
  contentBloomsDigestSchemaV1,
  contentBloomsReadReceiptSchemaV1,
  contentBloomsSafeIdSchemaV1,
  contentBloomsTimeSchemaV1,
} from "./schemas";
import {
  CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
  type ContentBloomsAdapterControlStateV1,
  type ContentBloomsAdapterReleaseV1,
  type ContentBloomsControlTransitionReceiptV1,
  type ContentBloomsControlTransitionV1,
  type ContentBloomsReadReceiptV1,
} from "./types";

const initialStateInputSchemaV1 = z.object({
  stateId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  initializedAt: contentBloomsTimeSchemaV1,
}).strict();

const transitionInputSchemaV1 = z.object({
  transitionId: contentBloomsSafeIdSchemaV1,
  tenantId: contentBloomsSafeIdSchemaV1,
  workspaceId: contentBloomsSafeIdSchemaV1,
  projectId: contentBloomsSafeIdSchemaV1,
  adapterId: contentBloomsSafeIdSchemaV1,
  action: z.enum(["enable_release", "disable", "rollback_release"]),
  expectedStateDigest: contentBloomsDigestSchemaV1,
  targetReleaseDigest: contentBloomsDigestSchemaV1.optional(),
  requestedByActorDigest: contentBloomsDigestSchemaV1,
  reasonCode: contentBloomsSafeIdSchemaV1,
  requestedAt: contentBloomsTimeSchemaV1,
}).strict().superRefine((value, context) => {
  const targetRequired = value.action === "enable_release" || value.action === "rollback_release";
  if (targetRequired !== (value.targetReleaseDigest !== undefined)) {
    context.addIssue({ code: "custom", message: "transition target does not match action" });
  }
});

function stateWithoutDigest(state: ContentBloomsAdapterControlStateV1): Omit<ContentBloomsAdapterControlStateV1, "stateDigest"> {
  const { stateDigest: _stateDigest, ...unsigned } = state;
  void _stateDigest;
  return unsigned;
}

function transitionWithoutDigest(transition: ContentBloomsControlTransitionV1): Omit<ContentBloomsControlTransitionV1, "transitionDigest"> {
  const { transitionDigest: _transitionDigest, ...unsigned } = transition;
  void _transitionDigest;
  return unsigned;
}

function transitionReceiptWithoutDigest(
  receipt: ContentBloomsControlTransitionReceiptV1,
): Omit<ContentBloomsControlTransitionReceiptV1, "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...unsigned } = receipt;
  void _receiptDigest;
  return unsigned;
}

function sameScope(
  left: Pick<ContentBloomsAdapterControlStateV1, "tenantId" | "workspaceId" | "projectId" | "adapterId">,
  right: Pick<ContentBloomsAdapterControlStateV1, "tenantId" | "workspaceId" | "projectId" | "adapterId">,
): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId
    && left.projectId === right.projectId && left.adapterId === right.adapterId;
}

function atOrAfter(later: string, earlier: string): boolean {
  return Date.parse(later) >= Date.parse(earlier);
}

function finalizeState(unsigned: Omit<ContentBloomsAdapterControlStateV1, "stateDigest">): ContentBloomsAdapterControlStateV1 {
  return parseExactContentBloomsV1(contentBloomsAdapterControlStateSchemaV1, {
    ...unsigned,
    stateDigest: sha256Digest(unsigned),
  }) as ContentBloomsAdapterControlStateV1;
}

export function buildInitialContentBloomsControlStateV1(inputValue: unknown): ContentBloomsAdapterControlStateV1 {
  const input = parseExactContentBloomsV1(initialStateInputSchemaV1, inputValue);
  return finalizeState({
    contractVersion: CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
    stateId: input.stateId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    adapterId: input.adapterId,
    revision: 0,
    lifecycleRevision: 0,
    status: "disabled",
    previousReleaseDigests: [],
    updatedAt: input.initializedAt,
    readsEligible: false,
    commandsEnabled: false,
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    sourceOwnsDomainTransitions: true,
    controlRoomMayLease: false,
    controlRoomMayMutateSource: false,
    grantsNetworkAuthority: false,
    grantsExecutionAuthority: false,
  });
}

export function parseContentBloomsControlStateV1(value: unknown): ContentBloomsAdapterControlStateV1 {
  const state = parseExactContentBloomsV1(contentBloomsAdapterControlStateSchemaV1, value) as ContentBloomsAdapterControlStateV1;
  if (sha256Digest(stateWithoutDigest(state)) !== state.stateDigest
    || new Set(state.previousReleaseDigests).size !== state.previousReleaseDigests.length) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return state;
}

export function contentBloomsControlLifecycleDigestV1(stateValue: unknown): string {
  const state = parseContentBloomsControlStateV1(stateValue);
  return sha256Digest({
    stateId: state.stateId,
    tenantId: state.tenantId,
    workspaceId: state.workspaceId,
    projectId: state.projectId,
    adapterId: state.adapterId,
    lifecycleRevision: state.lifecycleRevision,
    status: state.status,
    ...(state.configuredReleaseDigest === undefined ? {} : { configuredReleaseDigest: state.configuredReleaseDigest }),
    ...(state.activeReleaseDigest === undefined ? {} : { activeReleaseDigest: state.activeReleaseDigest }),
    previousReleaseDigests: state.previousReleaseDigests,
    readsEligible: state.readsEligible,
    commandsEnabled: state.commandsEnabled,
  });
}

export function buildContentBloomsControlTransitionV1(inputValue: unknown): ContentBloomsControlTransitionV1 {
  const input = parseExactContentBloomsV1(transitionInputSchemaV1, inputValue);
  const unsigned: Omit<ContentBloomsControlTransitionV1, "transitionDigest"> = {
    contractVersion: CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
    transitionId: input.transitionId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    adapterId: input.adapterId,
    action: input.action,
    expectedStateDigest: input.expectedStateDigest,
    ...(input.targetReleaseDigest === undefined ? {} : { targetReleaseDigest: input.targetReleaseDigest }),
    requestedByActorDigest: input.requestedByActorDigest,
    reasonCode: input.reasonCode,
    requestedAt: input.requestedAt,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactContentBloomsV1(contentBloomsControlTransitionSchemaV1, {
    ...unsigned,
    transitionDigest: sha256Digest(unsigned),
  }) as ContentBloomsControlTransitionV1;
}

export function parseContentBloomsControlTransitionV1(value: unknown): ContentBloomsControlTransitionV1 {
  const transition = parseExactContentBloomsV1(contentBloomsControlTransitionSchemaV1, value) as ContentBloomsControlTransitionV1;
  if (sha256Digest(transitionWithoutDigest(transition)) !== transition.transitionDigest) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return transition;
}

function releaseCatalog(value: unknown): Map<string, ContentBloomsAdapterReleaseV1> {
  const inputs = parseExactContentBloomsV1(z.array(contentBloomsAdapterReleaseSchemaV1).max(50), value);
  const catalog = new Map<string, ContentBloomsAdapterReleaseV1>();
  for (const input of inputs) {
    const release = parseContentBloomsAdapterReleaseV1(input);
    if (catalog.has(release.releaseDigest)) throw new ContentBloomsContractErrorV1("release_untrusted");
    catalog.set(release.releaseDigest, release);
  }
  return catalog;
}

function requireReleaseScope(state: ContentBloomsAdapterControlStateV1, release: ContentBloomsAdapterReleaseV1 | undefined): ContentBloomsAdapterReleaseV1 {
  if (!release) throw new ContentBloomsContractErrorV1("release_untrusted");
  if (!sameScope(state, release)) throw new ContentBloomsContractErrorV1("scope_mismatch");
  return release;
}

function requireAcceptedBy(release: ContentBloomsAdapterReleaseV1, time: string): void {
  if (!atOrAfter(time, release.acceptedAt)) throw new ContentBloomsContractErrorV1("sequence_invalid");
}

function historyWith(history: string[], digest: string | undefined): string[] {
  if (!digest || history.includes(digest)) return [...history];
  if (history.length >= 50) throw new ContentBloomsContractErrorV1("rollback_invalid");
  return [...history, digest];
}

export function applyContentBloomsControlTransitionV1(inputValue: unknown): {
  state: ContentBloomsAdapterControlStateV1;
  receipt: ContentBloomsControlTransitionReceiptV1;
} {
  const input = parseExactContentBloomsV1(z.object({
    state: z.unknown(),
    transition: z.unknown(),
    releases: z.unknown(),
  }).strict(), inputValue);
  const state = parseContentBloomsControlStateV1(input.state);
  const transition = parseContentBloomsControlTransitionV1(input.transition);
  const catalog = releaseCatalog(input.releases);
  if (!sameScope(state, transition)) throw new ContentBloomsContractErrorV1("scope_mismatch");
  if (transition.expectedStateDigest !== state.stateDigest) throw new ContentBloomsContractErrorV1("stale_state");
  if (!atOrAfter(transition.requestedAt, state.updatedAt)) throw new ContentBloomsContractErrorV1("sequence_invalid");
  if (state.configuredReleaseDigest) {
    requireAcceptedBy(requireReleaseScope(state, catalog.get(state.configuredReleaseDigest)), state.updatedAt);
  }
  for (const digest of state.previousReleaseDigests) {
    requireAcceptedBy(requireReleaseScope(state, catalog.get(digest)), state.updatedAt);
  }

  let status = state.status;
  let configuredReleaseDigest = state.configuredReleaseDigest;
  let activeReleaseDigest = state.activeReleaseDigest;
  let previousReleaseDigests = [...state.previousReleaseDigests];
  if (transition.action === "disable") {
    if (state.status !== "enabled" || !state.configuredReleaseDigest) {
      throw new ContentBloomsContractErrorV1("stale_state");
    }
    status = "disabled";
    activeReleaseDigest = undefined;
  } else if (transition.action === "enable_release") {
    const target = requireReleaseScope(state, catalog.get(transition.targetReleaseDigest!));
    requireAcceptedBy(target, transition.requestedAt);
    if (state.status === "enabled" && target.releaseDigest === state.activeReleaseDigest) {
      throw new ContentBloomsContractErrorV1("stale_state");
    }
    if (state.previousReleaseDigests.includes(target.releaseDigest)) {
      throw new ContentBloomsContractErrorV1("rollback_invalid");
    }
    previousReleaseDigests = historyWith(
      previousReleaseDigests,
      configuredReleaseDigest === target.releaseDigest ? undefined : configuredReleaseDigest,
    );
    configuredReleaseDigest = target.releaseDigest;
    activeReleaseDigest = target.releaseDigest;
    status = "enabled";
  } else {
    const targetDigest = transition.targetReleaseDigest!;
    const target = requireReleaseScope(state, catalog.get(targetDigest));
    requireAcceptedBy(target, transition.requestedAt);
    if (!state.previousReleaseDigests.includes(target.releaseDigest)) {
      throw new ContentBloomsContractErrorV1("rollback_invalid");
    }
    previousReleaseDigests = historyWith(
      state.previousReleaseDigests.filter((digest) => digest !== target.releaseDigest),
      configuredReleaseDigest,
    );
    configuredReleaseDigest = target.releaseDigest;
    activeReleaseDigest = status === "enabled" ? target.releaseDigest : undefined;
  }

  const nextState = finalizeState({
    contractVersion: CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
    stateId: state.stateId,
    tenantId: state.tenantId,
    workspaceId: state.workspaceId,
    projectId: state.projectId,
    adapterId: state.adapterId,
    revision: state.revision + 1,
    lifecycleRevision: state.lifecycleRevision + 1,
    status,
    ...(configuredReleaseDigest === undefined ? {} : { configuredReleaseDigest }),
    ...(activeReleaseDigest === undefined ? {} : { activeReleaseDigest }),
    previousReleaseDigests,
    ...(state.lastCommittedCursorDigest === undefined ? {} : { lastCommittedCursorDigest: state.lastCommittedCursorDigest }),
    ...(state.lastReadReceiptDigest === undefined ? {} : { lastReadReceiptDigest: state.lastReadReceiptDigest }),
    updatedAt: transition.requestedAt,
    readsEligible: status === "enabled",
    commandsEnabled: false,
    sourceOwnsEligibility: true,
    sourceOwnsLeases: true,
    sourceOwnsDomainTransitions: true,
    controlRoomMayLease: false,
    controlRoomMayMutateSource: false,
    grantsNetworkAuthority: false,
    grantsExecutionAuthority: false,
  });
  const unsignedReceipt: Omit<ContentBloomsControlTransitionReceiptV1, "receiptDigest"> = {
    contractVersion: CONTENT_BLOOMS_ADAPTER_CONTRACT_V1,
    receiptId: `cb-transition:${transition.transitionDigest.slice(7, 39)}`,
    transitionId: transition.transitionId,
    transitionDigest: transition.transitionDigest,
    action: transition.action,
    tenantId: state.tenantId,
    workspaceId: state.workspaceId,
    projectId: state.projectId,
    adapterId: state.adapterId,
    beforeStateDigest: state.stateDigest,
    afterStateDigest: nextState.stateDigest,
    beforeLifecycleRevision: state.lifecycleRevision,
    afterLifecycleRevision: nextState.lifecycleRevision,
    beforeLifecycleDigest: contentBloomsControlLifecycleDigestV1(state),
    afterLifecycleDigest: contentBloomsControlLifecycleDigestV1(nextState),
    ...(nextState.configuredReleaseDigest === undefined ? {} : { configuredReleaseDigest: nextState.configuredReleaseDigest }),
    ...(nextState.activeReleaseDigest === undefined ? {} : { activeReleaseDigest: nextState.activeReleaseDigest }),
    previousReleaseDigests: [...nextState.previousReleaseDigests],
    ...(state.lastCommittedCursorDigest === undefined ? {} : { preservedCursorDigest: state.lastCommittedCursorDigest }),
    ...(state.lastReadReceiptDigest === undefined ? {} : { preservedReadReceiptDigest: state.lastReadReceiptDigest }),
    appliedAt: transition.requestedAt,
    status: "applied",
    commandsEnabled: false,
    controlRoomMayLease: false,
    controlRoomMayMutateSource: false,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  const receipt = parseExactContentBloomsV1(contentBloomsControlTransitionReceiptSchemaV1, {
    ...unsignedReceipt,
    receiptDigest: sha256Digest(unsignedReceipt),
  }) as ContentBloomsControlTransitionReceiptV1;
  return { state: nextState, receipt };
}

export function advanceContentBloomsReadHighWaterV1(inputValue: unknown): ContentBloomsAdapterControlStateV1 {
  const input = parseExactContentBloomsV1(z.object({ state: z.unknown(), receipt: z.unknown() }).strict(), inputValue);
  const state = parseContentBloomsControlStateV1(input.state);
  const receipt = parseExactContentBloomsV1(contentBloomsReadReceiptSchemaV1, input.receipt) as ContentBloomsReadReceiptV1;
  const { receiptDigest, ...unsignedReceipt } = receipt;
  if (sha256Digest(unsignedReceipt) !== receiptDigest || receipt.recordDigests.length !== receipt.recordCount) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  if (!sameScope(state, receipt)) throw new ContentBloomsContractErrorV1("scope_mismatch");
  if (state.lastReadReceiptDigest === receipt.receiptDigest) {
    if (state.lastCommittedCursorDigest !== receipt.nextCursorDigest
      || state.configuredReleaseDigest !== receipt.releaseDigest) throw new ContentBloomsContractErrorV1("replay_drift");
    return state;
  }
  if (state.status !== "enabled" || state.activeReleaseDigest !== receipt.releaseDigest) {
    throw new ContentBloomsContractErrorV1("adapter_disabled");
  }
  if (receipt.controlStateDigest !== state.stateDigest) throw new ContentBloomsContractErrorV1("stale_state");
  if (!atOrAfter(receipt.recordedAt, state.updatedAt)) throw new ContentBloomsContractErrorV1("sequence_invalid");
  return finalizeState({
    ...stateWithoutDigest(state),
    revision: state.revision + 1,
    lastCommittedCursorDigest: receipt.nextCursorDigest,
    lastReadReceiptDigest: receipt.receiptDigest,
    updatedAt: receipt.recordedAt,
  });
}

export function parseContentBloomsControlTransitionReceiptV1(value: unknown): ContentBloomsControlTransitionReceiptV1 {
  const receipt = parseExactContentBloomsV1(
    contentBloomsControlTransitionReceiptSchemaV1,
    value,
  ) as ContentBloomsControlTransitionReceiptV1;
  if (sha256Digest(transitionReceiptWithoutDigest(receipt)) !== receipt.receiptDigest
    || new Set(receipt.previousReleaseDigests).size !== receipt.previousReleaseDigests.length) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return receipt;
}

export function requireExactContentBloomsControlReplayV1(
  existingValue: unknown,
  candidateValue: unknown,
): ContentBloomsControlTransitionReceiptV1 {
  const existing = parseContentBloomsControlTransitionReceiptV1(existingValue);
  const candidate = parseContentBloomsControlTransitionReceiptV1(candidateValue);
  if (existing.transitionId !== candidate.transitionId) {
    throw new ContentBloomsContractErrorV1("invalid_input");
  }
  if (existing.receiptId !== candidate.receiptId || existing.receiptDigest !== candidate.receiptDigest) {
    throw new ContentBloomsContractErrorV1("replay_drift");
  }
  return existing;
}
