import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security";
import {
  dataMethodV1,
  exactHostCancellationSignalV1,
  exactHostDataSnapshotV1,
  hostCancellationAbortedV1,
  isHostProxyV1,
  type HostCancellationSignalV1,
  type HostResultCollectorV1,
} from "../../security/host-value";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import {
  IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1,
  ideaLabHermes021BuiltInConnectionSourceV1,
  parseIdeaLabHermes021ConnectionSafeResultV1,
  type IdeaLabHermes021ConnectionSafeResultV1,
} from "./hermes-021-enrolled-connection";
import {
  IDEA_LAB_HERMES_021_REVISION_V1,
  IDEA_LAB_HERMES_021_VERSION_V1,
} from "./hermes-021-panel-packet";
import { IDEA_LAB_HERMES_021_GATEWAY_OPERATION_SET_DIGEST_V1 } from "./hermes-021-fixed-operation-set";
import type { Hermes021IdeaLabGatewayPortV1 } from "./hermes-021-filtered-driver";
import { capturedPatternMatchesV1, ideaDigestSchemaV1, ideaIdSchemaV1, ideaTimeSchemaV1 } from "./schemas";

export const IDEA_LAB_HERMES_021_QUALIFICATION_PERMIT_V1 =
  "control-room-hermes-021-qualification-permit/v1" as const;
export const IDEA_LAB_HERMES_021_ENROLLED_GATEWAY_PORT_V1 =
  "control-room-hermes-021-enrolled-gateway-port/v1" as const;

const nativeDateV1 = Date, nativeDateParseV1 = Date.parse,
  nativeDateToISOStringV1 = Date.prototype.toISOString;
const nativeNumberIsFiniteV1 = Number.isFinite, nativeNumberIsSafeIntegerV1 = Number.isSafeInteger;
const nativeObjectFreezeV1 = Object.freeze, nativePromiseV1 = Promise, nativeReflectApplyV1 = Reflect.apply;

const base64url = z.string().min(40).max(256)
  .refine((value) => capturedPatternMatchesV1(/^[A-Za-z0-9_-]+$/, value));

const permitBodySchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_021_QUALIFICATION_PERMIT_V1),
  permitId: ideaIdSchemaV1,
  attemptId: ideaIdSchemaV1,
  tenantId: ideaIdSchemaV1,
  nodeId: ideaIdSchemaV1,
  connectionId: ideaIdSchemaV1,
  enrollmentResultDigest: ideaDigestSchemaV1,
  sourceCandidateDigest: z.literal(ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest),
  runtimeVersion: z.literal(IDEA_LAB_HERMES_021_VERSION_V1),
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  transport: z.enum(["local_loopback", "ssh_tunnel"]),
  connectorRouteDigest: ideaDigestSchemaV1,
  profileIdentityDigest: ideaDigestSchemaV1,
  conversationIdentityDigest: ideaDigestSchemaV1,
  participantId: ideaIdSchemaV1,
  participantIdentityDigest: ideaDigestSchemaV1,
  runtimeIdentityDigest: ideaDigestSchemaV1,
  markerDigest: ideaDigestSchemaV1,
  ownerWindowDigest: ideaDigestSchemaV1,
  operationSetDigest: z.literal(IDEA_LAB_HERMES_021_GATEWAY_OPERATION_SET_DIGEST_V1),
  purpose: z.literal("one_disposable_native_qualification"),
  maximumNativeAttempts: z.literal(1),
  maximumProviderCalls: z.literal(1),
  maximumDurationSeconds: z.literal(300),
  maximumOutputCharacters: z.literal(800),
  toolsAllowed: z.literal(0),
  mcpServersAllowed: z.literal(0),
  pluginsAllowed: z.literal(0),
  genericShellAllowed: z.literal(false),
  automaticRetryAllowed: z.literal(false),
  oneUse: z.literal(true),
  issuedAt: ideaTimeSchemaV1,
  expiresAt: ideaTimeSchemaV1,
  bodyDigest: ideaDigestSchemaV1,
}).strict();

const permitEnvelopeSchema = z.object({
  body: permitBodySchema,
  attestation: z.object({
    algorithm: z.literal("ed25519"),
    keyId: ideaIdSchemaV1,
    publicKeySpki: base64url,
    signature: base64url,
  }).strict(),
}).strict();

const permitContextSchema = z.object({
  evaluatedAt: ideaTimeSchemaV1,
  expectedAttemptId: ideaIdSchemaV1,
  expectedTenantId: ideaIdSchemaV1,
  expectedNodeId: ideaIdSchemaV1,
  expectedConnectionId: ideaIdSchemaV1,
  expectedMarkerDigest: ideaDigestSchemaV1,
  expectedOwnerWindowDigest: ideaDigestSchemaV1,
  expectedParticipantId: ideaIdSchemaV1,
  expectedParticipantIdentityDigest: ideaDigestSchemaV1,
  expectedRuntimeIdentityDigest: ideaDigestSchemaV1,
  expectedConversationIdentityDigest: ideaDigestSchemaV1,
  trustedAuthorityKeyId: ideaIdSchemaV1,
  trustedAuthorityPublicKeySpki: base64url,
  inputMode: z.literal("injected_signed_owner_window_only"),
}).strict();

const verifiedPermitSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_021_QUALIFICATION_PERMIT_V1),
  permitId: ideaIdSchemaV1,
  attemptId: ideaIdSchemaV1,
  tenantId: ideaIdSchemaV1,
  nodeId: ideaIdSchemaV1,
  connectionId: ideaIdSchemaV1,
  enrollmentResultDigest: ideaDigestSchemaV1,
  runtimeVersion: z.literal(IDEA_LAB_HERMES_021_VERSION_V1),
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  transport: z.enum(["local_loopback", "ssh_tunnel"]),
  connectorRouteDigest: ideaDigestSchemaV1,
  profileIdentityDigest: ideaDigestSchemaV1,
  conversationIdentityDigest: ideaDigestSchemaV1,
  participantId: ideaIdSchemaV1,
  participantIdentityDigest: ideaDigestSchemaV1,
  runtimeIdentityDigest: ideaDigestSchemaV1,
  markerDigest: ideaDigestSchemaV1,
  ownerWindowDigest: ideaDigestSchemaV1,
  authorityKeyDigest: ideaDigestSchemaV1,
  issuedAt: ideaTimeSchemaV1,
  expiresAt: ideaTimeSchemaV1,
  permitDigest: ideaDigestSchemaV1,
  grantsApproval: z.literal(false),
  grantsLivePanelAuthority: z.literal(false),
  grantsProjectCreationAuthority: z.literal(false),
  grantsGenericShell: z.literal(false),
}).strict();

export type IdeaLabHermes021QualificationPermitEnvelopeV1 = z.infer<typeof permitEnvelopeSchema>;
export type IdeaLabHermes021QualificationPermitContextV1 = z.infer<typeof permitContextSchema>;
export type IdeaLabHermes021VerifiedQualificationPermitV1 = z.infer<typeof verifiedPermitSchema>;

function withoutDigest<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const result = { ...value };
  delete result[key];
  return result;
}

function canonicalEd25519Key(spki: string): { key: KeyObject; digest: string } {
  try {
    const supplied = Buffer.from(spki, "base64url");
    const key = createPublicKey({ key: supplied, format: "der", type: "spki" });
    const canonical = key.export({ format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || !Buffer.isBuffer(canonical) || !supplied.equals(canonical)
      || spki !== canonical.toString("base64url")) throw new Error("invalid");
    return { key, digest: `sha256:${createHash("sha256").update(canonical).digest("hex")}` };
  } catch {
    throw new IdeaLabErrorV1("integrity_failed");
  }
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyIdeaLabHermes021QualificationPermitV1(input: {
  enrollment: unknown;
  envelope: unknown;
  context: unknown;
}): IdeaLabHermes021VerifiedQualificationPermitV1 {
  const enrollment = parseIdeaLabHermes021ConnectionSafeResultV1(input.enrollment);
  const envelope = parseExactIdeaLabV1(permitEnvelopeSchema, input.envelope);
  const context = parseExactIdeaLabV1(permitContextSchema, input.context);
  if (!sameText(envelope.attestation.keyId, context.trustedAuthorityKeyId)
    || !sameText(envelope.attestation.publicKeySpki, context.trustedAuthorityPublicKeySpki)) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  const authority = canonicalEd25519Key(envelope.attestation.publicKeySpki);
  let signatureValid = false;
  try {
    signatureValid = verify(null, Buffer.from(canonicalJson(envelope.body)), authority.key,
      Buffer.from(envelope.attestation.signature, "base64url"));
  } catch {
    signatureValid = false;
  }
  const body = envelope.body;
  if (!signatureValid || sha256Digest(withoutDigest(body, "bodyDigest")) !== body.bodyDigest) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  const scopePairs = [
    [body.attemptId, context.expectedAttemptId], [body.tenantId, context.expectedTenantId],
    [body.nodeId, context.expectedNodeId], [body.connectionId, context.expectedConnectionId],
    [body.markerDigest, context.expectedMarkerDigest], [body.ownerWindowDigest, context.expectedOwnerWindowDigest],
    [body.participantId, context.expectedParticipantId],
    [body.participantIdentityDigest, context.expectedParticipantIdentityDigest],
    [body.runtimeIdentityDigest, context.expectedRuntimeIdentityDigest],
    [body.conversationIdentityDigest, context.expectedConversationIdentityDigest],
    [body.tenantId, enrollment.tenantId], [body.nodeId, enrollment.nodeId],
    [body.connectionId, enrollment.connectionId], [body.enrollmentResultDigest, enrollment.resultDigest],
    [body.connectorRouteDigest, enrollment.connectorRouteDigest],
    [body.profileIdentityDigest, enrollment.profileIdentityDigest], [body.transport, enrollment.transport],
  ] as const;
  let scopeMatches = true;
  for (let index = 0; index < scopePairs.length; index += 1) {
    const pair = scopePairs[index];
    if (!sameText(pair[0], pair[1])) { scopeMatches = false; break; }
  }
  const issued = nativeDateParseV1(body.issuedAt), expires = nativeDateParseV1(body.expiresAt),
    evaluated = nativeDateParseV1(context.evaluatedAt), enrollmentExpires = nativeDateParseV1(enrollment.expiresAt);
  if (!scopeMatches || !nativeNumberIsFiniteV1(issued) || !nativeNumberIsFiniteV1(expires)
    || !nativeNumberIsFiniteV1(evaluated) || issued > evaluated || expires <= evaluated
    || !nativeNumberIsFiniteV1(enrollmentExpires) || enrollmentExpires <= evaluated
    || expires <= issued || expires - issued > 300_000) {
    throw new IdeaLabErrorV1("authorization_denied");
  }
  const material = {
    contractVersion: IDEA_LAB_HERMES_021_QUALIFICATION_PERMIT_V1,
    permitId: body.permitId,
    attemptId: body.attemptId,
    tenantId: body.tenantId,
    nodeId: body.nodeId,
    connectionId: body.connectionId,
    enrollmentResultDigest: body.enrollmentResultDigest,
    runtimeVersion: body.runtimeVersion,
    runtimeRevision: body.runtimeRevision,
    transport: body.transport,
    connectorRouteDigest: body.connectorRouteDigest,
    profileIdentityDigest: body.profileIdentityDigest,
    conversationIdentityDigest: body.conversationIdentityDigest,
    participantId: body.participantId,
    participantIdentityDigest: body.participantIdentityDigest,
    runtimeIdentityDigest: body.runtimeIdentityDigest,
    markerDigest: body.markerDigest,
    ownerWindowDigest: body.ownerWindowDigest,
    authorityKeyDigest: authority.digest,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
    grantsApproval: false as const,
    grantsLivePanelAuthority: false as const,
    grantsProjectCreationAuthority: false as const,
    grantsGenericShell: false as const,
  };
  return nativeObjectFreezeV1(verifiedPermitSchema.parse({ ...material, permitDigest: sha256Digest(material) }));
}

export interface IdeaLabHermes021QualificationSpendStoreV1 {
  claim(input: Readonly<{
    permitDigest: string;
    attemptId: string;
    markerDigest: string;
    claimedAt: string;
  }>): Promise<"claimed" | "already_claimed" | "conflict">;
  settle(input: Readonly<{
    permitDigest: string;
    attemptId: string;
    markerDigest: string;
    outcome: "execute_returned" | "terminal_ambiguity" | "cleanup_completed" | "cleanup_uncertain";
    settledAt: string;
  }>): Promise<void>;
}

export interface IdeaLabHermes021NativeBridgeV1 {
  executeFixedSession(input: Readonly<{
    connectionContractVersion: typeof IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1;
    connectionId: string;
    transport: "local_loopback" | "ssh_tunnel";
    connectorRouteDigest: string;
    attemptId: string;
    permitDigest: string;
    markerDigest: string;
    participantId: string;
    participantIdentityDigest: string;
    round: number;
    safeInstruction: string;
    runtimeIdentityDigest: string;
    profileIdentityDigest: string;
    conversationIdentityDigest: string;
    maximumOutputCharacters: 800;
    toolsEnabled: false;
    mcpEnabled: false;
    pluginsEnabled: false;
    genericShellEnabled: false;
    signal: HostCancellationSignalV1;
  }>, collector: HostResultCollectorV1): Promise<void>;
  cleanupFixedSession(input: Readonly<{
    connectionId: string;
    connectorRouteDigest: string;
    attemptId: string;
    permitDigest: string;
    markerDigest: string;
    sessionIdentityDigest?: string;
    signal: HostCancellationSignalV1;
  }>, collector: HostResultCollectorV1): Promise<void>;
}

type ExecuteInput = Parameters<Hermes021IdeaLabGatewayPortV1["execute"]>[0];
type CleanupInput = Parameters<Hermes021IdeaLabGatewayPortV1["cleanup"]>[0];

function exactGatewayExecuteInputV1(value: unknown): ExecuteInput | undefined {
  const snapshot = exactHostDataSnapshotV1(value, ["markerDigest", "participantId", "participantIdentityDigest", "round",
    "safeInstruction", "runtimeIdentityDigest", "profileIdentityDigest", "conversationIdentityDigest",
    "maximumOutputCharacters", "signal"]);
  return snapshot && exactHostCancellationSignalV1(snapshot.signal) ? snapshot as unknown as ExecuteInput : undefined;
}

function exactGatewayCleanupInputV1(value: unknown): CleanupInput | undefined {
  const snapshot = exactHostDataSnapshotV1(value, ["markerDigest", "signal"], ["sessionIdentityDigest"]);
  return snapshot && exactHostCancellationSignalV1(snapshot.signal) ? snapshot as unknown as CleanupInput : undefined;
}

export class IdeaLabHermes021EnrolledGatewayPortV1 implements Hermes021IdeaLabGatewayPortV1 {
  readonly #enrollment: IdeaLabHermes021ConnectionSafeResultV1;
  readonly #permit: IdeaLabHermes021VerifiedQualificationPermitV1;
  readonly #claim: IdeaLabHermes021QualificationSpendStoreV1["claim"];
  readonly #settle: IdeaLabHermes021QualificationSpendStoreV1["settle"];
  readonly #executeFixedSession: IdeaLabHermes021NativeBridgeV1["executeFixedSession"];
  readonly #cleanupFixedSession: IdeaLabHermes021NativeBridgeV1["cleanupFixedSession"];
  readonly #now: () => string;
  #executeStarted = false;
  #cleanupStarted = false;
  #executeSettled?: Promise<void>;
  #resolveExecuteSettled?: () => void;

  constructor(input: {
    enrollment: unknown;
    permitEnvelope: unknown;
    permitContext: unknown;
    spendStore: IdeaLabHermes021QualificationSpendStoreV1;
    nativeBridge: IdeaLabHermes021NativeBridgeV1;
    now?: () => string;
  }) {
    const captured = exactHostDataSnapshotV1(input,
      ["enrollment", "permitEnvelope", "permitContext", "spendStore", "nativeBridge"], ["now"]);
    if (!captured) throw new IdeaLabErrorV1("invalid_input");
    const spendStore = captured.spendStore, nativeBridge = captured.nativeBridge, now = captured.now;
    if (!spendStore || typeof spendStore !== "object" || isHostProxyV1(spendStore)
      || !nativeBridge || typeof nativeBridge !== "object" || isHostProxyV1(nativeBridge)) {
      throw new IdeaLabErrorV1("invalid_input");
    }
    const claim = dataMethodV1(spendStore, "claim"), settle = dataMethodV1(spendStore, "settle");
    const execute = dataMethodV1(nativeBridge, "executeFixedSession");
    const cleanup = dataMethodV1(nativeBridge, "cleanupFixedSession");
    if (!claim || !settle || !execute || !cleanup
      || (now !== undefined && (typeof now !== "function" || isHostProxyV1(now)))) {
      throw new IdeaLabErrorV1("invalid_input");
    }
    this.#enrollment = parseIdeaLabHermes021ConnectionSafeResultV1(captured.enrollment);
    this.#permit = verifyIdeaLabHermes021QualificationPermitV1({
      enrollment: this.#enrollment,
      envelope: captured.permitEnvelope,
      context: captured.permitContext,
    });
    this.#claim = ((value) => nativeReflectApplyV1(claim, spendStore, [value])) as
      IdeaLabHermes021QualificationSpendStoreV1["claim"];
    this.#settle = ((value) => nativeReflectApplyV1(settle, spendStore, [value])) as
      IdeaLabHermes021QualificationSpendStoreV1["settle"];
    this.#executeFixedSession = ((value, collector) => nativeReflectApplyV1(execute, nativeBridge,
      [value, collector])) as IdeaLabHermes021NativeBridgeV1["executeFixedSession"];
    this.#cleanupFixedSession = ((value, collector) => nativeReflectApplyV1(cleanup, nativeBridge,
      [value, collector])) as IdeaLabHermes021NativeBridgeV1["cleanupFixedSession"];
    this.#now = (now as (() => string) | undefined)
      ?? (() => nativeReflectApplyV1(nativeDateToISOStringV1, new nativeDateV1(), []) as string);
  }

  async execute(inputValue: ExecuteInput, collector: HostResultCollectorV1): Promise<void> {
    const input = exactGatewayExecuteInputV1(inputValue);
    if (!input) throw new IdeaLabErrorV1("invalid_input");
    if (this.#executeStarted || this.#cleanupStarted || input.markerDigest !== this.#permit.markerDigest
      || input.participantId !== this.#permit.participantId
      || input.participantIdentityDigest !== this.#permit.participantIdentityDigest
      || input.runtimeIdentityDigest !== this.#permit.runtimeIdentityDigest
      || input.profileIdentityDigest !== this.#permit.profileIdentityDigest
      || input.conversationIdentityDigest !== this.#permit.conversationIdentityDigest
      || input.maximumOutputCharacters !== 800 || typeof input.safeInstruction !== "string"
      || input.safeInstruction.length < 1 || input.safeInstruction.length > 800
      || typeof input.round !== "number" || input.round < 1 || !nativeNumberIsSafeIntegerV1(input.round)
      || !dataMethodV1(collector, "submit")) {
      throw new IdeaLabErrorV1("authorization_denied");
    }
    const claimedAt = this.#now(), claimed = nativeDateParseV1(claimedAt);
    if (!nativeNumberIsFiniteV1(claimed) || claimed < nativeDateParseV1(this.#permit.issuedAt)
      || claimed >= nativeDateParseV1(this.#permit.expiresAt)) throw new IdeaLabErrorV1("authorization_denied");
    this.#executeStarted = true;
    this.#executeSettled = new nativePromiseV1<void>((resolve) => { this.#resolveExecuteSettled = resolve; });
    try {
      const claim = await this.#claim({ permitDigest: this.#permit.permitDigest, attemptId: this.#permit.attemptId,
        markerDigest: this.#permit.markerDigest, claimedAt });
      if (claim !== "claimed") throw new IdeaLabErrorV1("authorization_denied");
      let dispatchedAt: string;
      try {
        dispatchedAt = this.#now();
      } catch {
        await this.#settleExact("terminal_ambiguity", claimedAt);
        throw new IdeaLabErrorV1("authorization_denied");
      }
      const dispatched = nativeDateParseV1(dispatchedAt);
      if (this.#cleanupStarted || hostCancellationAbortedV1(input.signal) !== false
        || !nativeNumberIsFiniteV1(dispatched) || dispatched < claimed
        || dispatched < nativeDateParseV1(this.#permit.issuedAt)
        || dispatched >= nativeDateParseV1(this.#permit.expiresAt)) {
        await this.#settleExact("terminal_ambiguity",
          nativeNumberIsFiniteV1(dispatched) && dispatched >= claimed ? dispatchedAt : claimedAt);
        throw new IdeaLabErrorV1("authorization_denied");
      }
      try {
        await this.#executeFixedSession({
          connectionContractVersion: IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1,
          connectionId: this.#enrollment.connectionId,
          transport: this.#enrollment.transport,
          connectorRouteDigest: this.#enrollment.connectorRouteDigest,
          attemptId: this.#permit.attemptId,
          permitDigest: this.#permit.permitDigest,
          markerDigest: input.markerDigest,
          participantId: input.participantId,
          participantIdentityDigest: input.participantIdentityDigest,
          round: input.round,
          safeInstruction: input.safeInstruction,
          runtimeIdentityDigest: input.runtimeIdentityDigest,
          profileIdentityDigest: input.profileIdentityDigest,
          conversationIdentityDigest: input.conversationIdentityDigest,
          maximumOutputCharacters: 800,
          toolsEnabled: false,
          mcpEnabled: false,
          pluginsEnabled: false,
          genericShellEnabled: false,
          signal: input.signal,
        }, collector);
        await this.#settleExact("execute_returned");
      } catch {
        await this.#settleExact("terminal_ambiguity");
        throw new IdeaLabErrorV1("integrity_failed");
      }
    } finally {
      this.#resolveExecuteSettled?.();
      this.#resolveExecuteSettled = undefined;
    }
  }

  async cleanup(inputValue: CleanupInput, collector: HostResultCollectorV1): Promise<void> {
    const input = exactGatewayCleanupInputV1(inputValue);
    if (!input) throw new IdeaLabErrorV1("invalid_input");
    if (!this.#executeStarted || this.#cleanupStarted || input.markerDigest !== this.#permit.markerDigest
      || (input.sessionIdentityDigest !== undefined && typeof input.sessionIdentityDigest !== "string")
      || !dataMethodV1(collector, "submit")) throw new IdeaLabErrorV1("authorization_denied");
    this.#cleanupStarted = true;
    const executeSettled = this.#executeSettled;
    if (!executeSettled) throw new IdeaLabErrorV1("integrity_failed");
    try {
      await this.#cleanupFixedSession({
        connectionId: this.#enrollment.connectionId,
        connectorRouteDigest: this.#enrollment.connectorRouteDigest,
        attemptId: this.#permit.attemptId,
        permitDigest: this.#permit.permitDigest,
        markerDigest: input.markerDigest,
        ...(input.sessionIdentityDigest ? { sessionIdentityDigest: input.sessionIdentityDigest } : {}),
        signal: input.signal,
      }, collector);
      await executeSettled;
      await this.#settleExact("cleanup_completed");
    } catch {
      await executeSettled;
      await this.#settleExact("cleanup_uncertain");
      throw new IdeaLabErrorV1("integrity_failed");
    }
  }

  async #settleExact(outcome: "execute_returned" | "terminal_ambiguity" | "cleanup_completed" | "cleanup_uncertain",
    settledAt = this.#now()) {
    await this.#settle({ permitDigest: this.#permit.permitDigest, attemptId: this.#permit.attemptId,
      markerDigest: this.#permit.markerDigest, outcome, settledAt });
  }
}

export const IDEA_LAB_HERMES_021_ENROLLED_GATEWAY_DISABLED_V1 = nativeObjectFreezeV1({
  contractVersion: IDEA_LAB_HERMES_021_ENROLLED_GATEWAY_PORT_V1,
  signedEnrollmentConfigured: false as const,
  signedOwnerWindowConfigured: false as const,
  durableSpendStoreConfigured: false as const,
  nativeBridgeConfigured: false as const,
  providerCallsMade: 0 as const,
  nativeAttemptsMade: 0 as const,
  livePanelEligible: false as const,
  grantsExecutionAuthority: false as const,
});
