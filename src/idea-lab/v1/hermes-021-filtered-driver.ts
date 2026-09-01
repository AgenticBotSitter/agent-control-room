import { z } from "zod";
import { sha256Digest } from "../../security";
import {
  createHostCancellationControllerV1,
  createHostResultCollectorV1,
  dataMethodV1,
  exactHostDataArrayV1,
  exactHostDataSnapshotV1,
  isHostProxyV1,
  type HostCancellationSignalV1,
  type HostResultCollectorV1,
} from "../../security/host-value";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import {
  IDEA_LAB_HERMES_021_REVISION_V1,
  IDEA_LAB_HERMES_021_VERSION_V1,
} from "./hermes-021-panel-packet";
import { ideaCodeSchemaV1, ideaDigestSchemaV1, ideaTextSchemaV1 } from "./schemas";
import type { IdeaLabBotPanelDriverV1 } from "./coordinator";

export const HERMES_021_IDEA_LAB_FILTERED_DRIVER_V1 = "control-room-hermes-021-idea-lab-filtered-driver/v1" as const;

const frameBase = {
  sequence: z.number().int().min(1).max(20),
  markerDigest: ideaDigestSchemaV1,
  sessionIdentityDigest: ideaDigestSchemaV1,
} as const;

const readyFrameSchema = z.object({
  ...frameBase,
  type: z.literal("session.ready"),
  payload: z.object({
    participantId: z.string().min(3).max(180),
    participantIdentityDigest: ideaDigestSchemaV1,
    runtimeIdentityDigest: ideaDigestSchemaV1,
    profileIdentityDigest: ideaDigestSchemaV1,
    conversationIdentityDigest: ideaDigestSchemaV1,
    toolsDisabled: z.literal(true),
    mcpDisabled: z.literal(true),
  }).strict(),
}).strict();

const resultFrameSchema = z.object({
  ...frameBase,
  type: z.literal("panel.result"),
  payload: z.object({
    safeOpinion: ideaTextSchemaV1,
    opportunityCode: ideaCodeSchemaV1,
    primaryRiskCode: ideaCodeSchemaV1,
    suggestedExperiment: z.string().min(1).max(500),
    confidencePercent: z.number().int().min(0).max(100),
  }).strict(),
}).strict();

const definiteFailureFrameSchema = z.object({
  ...frameBase,
  type: z.literal("panel.failed_definite"),
  payload: z.object({ safeCode: ideaCodeSchemaV1 }).strict(),
}).strict();

const usageFrameSchema = z.object({
  ...frameBase,
  type: z.literal("session.usage"),
  payload: z.object({
    inputUnits: z.number().int().min(0).max(10_000_000),
    outputUnits: z.number().int().min(0).max(10_000_000),
    reasoningUnits: z.number().int().min(0).max(10_000_000),
    totalUnits: z.number().int().min(0).max(30_000_000),
    calls: z.literal(1),
    costUsd: z.number().min(0).max(25),
  }).strict(),
}).strict();

const completeFrameSchema = z.object({
  ...frameBase,
  type: z.literal("session.complete"),
  payload: z.object({ status: z.literal("settled") }).strict(),
}).strict();

const cleanupSchema = z.object({
  contractVersion: z.literal("control-room-hermes-021-panel-cleanup/v1"),
  markerDigest: ideaDigestSchemaV1,
  sessionIdentityDigest: ideaDigestSchemaV1.optional(),
  outcome: z.literal("completed"),
  processStopped: z.literal(true),
  disposableProfileRemoved: z.literal(true),
  disposableWorkspaceRemoved: z.literal(true),
  retainedNativeReferenceCount: z.literal(0),
  cleanupDigest: ideaDigestSchemaV1,
}).strict();

export interface Hermes021IdeaLabGatewayPortV1 {
  execute(input: Readonly<{
    markerDigest: string;
    participantId: string;
    participantIdentityDigest: string;
    round: number;
    safeInstruction: string;
    runtimeIdentityDigest: string;
    profileIdentityDigest: string;
    conversationIdentityDigest: string;
    maximumOutputCharacters: 800;
    signal: HostCancellationSignalV1;
  }>, collector: HostResultCollectorV1): Promise<void>;
  cleanup(input: Readonly<{ markerDigest: string; sessionIdentityDigest?: string; signal: HostCancellationSignalV1 }>,
    collector: HostResultCollectorV1): Promise<void>;
}

type DriverInput = Parameters<IdeaLabBotPanelDriverV1["invoke"]>[0];

function exactEnvelope(value: unknown): unknown[] {
  const envelope = exactHostDataSnapshotV1(value, ["frames"]);
  const frames = envelope ? exactHostDataArrayV1(envelope.frames, 20) : undefined;
  if (!frames) throw new IdeaLabErrorV1("invalid_input");
  return frames;
}

function frameHeader(value: unknown): Record<string, unknown> {
  const snapshot = exactHostDataSnapshotV1(value, ["sequence", "type", "markerDigest", "sessionIdentityDigest", "payload"]);
  if (!snapshot || typeof snapshot.sequence !== "number" || typeof snapshot.type !== "string") {
    throw new IdeaLabErrorV1("invalid_input");
  }
  return snapshot;
}

function parseFrames(value: unknown, input: DriverInput) {
  const frames = exactEnvelope(value), retained: Record<string, unknown>[] = [];
  let priorSequence = 0;
  for (const valueFrame of frames) {
    const frame = frameHeader(valueFrame);
    const sequence = frame.sequence as number, type = frame.type as string;
    if (sequence !== priorSequence + 1) throw new IdeaLabErrorV1("integrity_failed");
    priorSequence = sequence;
    if (type === "message.delta" || type === "reasoning.delta" || type === "thinking.delta") continue;
    retained.push(frame);
  }
  if (retained.length !== 4) throw new IdeaLabErrorV1("integrity_failed");
  const ready = parseExactIdeaLabV1(readyFrameSchema, retained[0]);
  const terminal = retained[1]?.type === "panel.result"
    ? parseExactIdeaLabV1(resultFrameSchema, retained[1])
    : parseExactIdeaLabV1(definiteFailureFrameSchema, retained[1]);
  const usage = parseExactIdeaLabV1(usageFrameSchema, retained[2]);
  const complete = parseExactIdeaLabV1(completeFrameSchema, retained[3]);
  const admission = input.liveAdmission;
  const binding = admission?.participantBindings.find((item) => item.participantId === input.participant.participantId);
  const all = [ready, terminal, usage, complete];
  if (!admission || !binding || ready.sequence !== 1 || admission.runtime.providerId !== "hermes_bot_mode"
    || admission.runtime.adapterId !== "adapter.hermes.gateway.v2"
    || admission.runtime.runtimeVersion !== IDEA_LAB_HERMES_021_VERSION_V1
    || admission.runtime.runtimeRevision !== IDEA_LAB_HERMES_021_REVISION_V1
    || all.some((frame) => frame.markerDigest !== input.markerDigest
      || frame.sessionIdentityDigest !== ready.sessionIdentityDigest)
    || ready.payload.participantId !== input.participant.participantId
    || ready.payload.participantIdentityDigest !== input.participant.identityDigest
    || ready.payload.runtimeIdentityDigest !== binding.runtimeIdentityDigest
    || ready.payload.profileIdentityDigest !== input.evidence.profileIdDigest
    || ready.payload.conversationIdentityDigest !== input.evidence.conversationIdDigest
    || usage.payload.totalUnits !== usage.payload.inputUnits + usage.payload.outputUnits + usage.payload.reasoningUnits) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  const providerReceiptDigest = sha256Digest({
    markerDigest: input.markerDigest,
    sessionIdentityDigest: ready.sessionIdentityDigest,
    terminal,
    usage,
    complete,
    finalSequence: priorSequence,
  });
  if (terminal.type === "panel.failed_definite") {
    return { outcome: "failed_definite" as const, safeCode: terminal.payload.safeCode,
      providerReceiptDigest, providerContacted: true as const, sessionIdentityDigest: ready.sessionIdentityDigest };
  }
  return {
    outcome: "completed" as const,
    ...terminal.payload,
    costUsd: usage.payload.costUsd,
    providerReceiptDigest,
    providerContacted: true as const,
    sessionIdentityDigest: ready.sessionIdentityDigest,
  };
}

function parseCleanup(value: unknown, markerDigest: string, sessionIdentityDigest?: string): string {
  const parsed = parseExactIdeaLabV1(cleanupSchema, value);
  const { cleanupDigest: _digest, ...material } = parsed;
  void _digest;
  if (parsed.markerDigest !== markerDigest || parsed.sessionIdentityDigest !== sessionIdentityDigest
    || sha256Digest(material) !== parsed.cleanupDigest) throw new IdeaLabErrorV1("integrity_failed");
  return parsed.cleanupDigest;
}

export class Hermes021IdeaLabFilteredDriverV1 implements IdeaLabBotPanelDriverV1 {
  readonly mode = "hermes_bot_mode_filtered" as const;
  readonly #execute: Hermes021IdeaLabGatewayPortV1["execute"];
  readonly #cleanup: Hermes021IdeaLabGatewayPortV1["cleanup"];
  readonly #timeoutMilliseconds: number;

  constructor(port: Hermes021IdeaLabGatewayPortV1, timeoutMilliseconds = 120_000) {
    if (!port || typeof port !== "object" || isHostProxyV1(port)) throw new IdeaLabErrorV1("invalid_input");
    const execute = dataMethodV1(port, "execute"), cleanup = dataMethodV1(port, "cleanup");
    if (!execute || !cleanup || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1 || timeoutMilliseconds > 120_000) throw new IdeaLabErrorV1("invalid_input");
    this.#execute = ((input, collector) => Reflect.apply(execute, port, [input, collector])) as
      Hermes021IdeaLabGatewayPortV1["execute"];
    this.#cleanup = ((input, collector) => Reflect.apply(cleanup, port, [input, collector])) as
      Hermes021IdeaLabGatewayPortV1["cleanup"];
    this.#timeoutMilliseconds = timeoutMilliseconds;
    Object.freeze(this);
  }

  async invoke(input: DriverInput): Promise<unknown> {
    const admission = input.liveAdmission;
    const binding = admission?.participantBindings.find((item) => item.participantId === input.participant.participantId);
    if (!admission || !binding || input.safePrompt.length < 1 || input.safePrompt.length > 800
      || admission.runtime.providerId !== "hermes_bot_mode" || admission.runtime.adapterId !== "adapter.hermes.gateway.v2"
      || admission.runtime.runtimeVersion !== IDEA_LAB_HERMES_021_VERSION_V1
      || admission.runtime.runtimeRevision !== IDEA_LAB_HERMES_021_REVISION_V1
      || input.evidence.mode !== "hermes_bot_mode_filtered"
      || input.evidence.harnessPackage !== "hermes_agent"
      || input.evidence.harnessVersion !== admission.runtime.runtimeVersion
      || input.evidence.sourceRevision !== admission.runtime.runtimeRevision
      || binding.participantIdentityDigest !== input.participant.identityDigest
      || binding.providerEvidenceDigest !== input.evidence.evidenceDigest
      || binding.profileIdentityDigest !== input.evidence.profileIdDigest
      || binding.conversationIdentityDigest !== input.evidence.conversationIdDigest) {
      throw new IdeaLabErrorV1("authorization_denied");
    }
    const controller = createHostCancellationControllerV1(), handoff = createHostResultCollectorV1();
    let timer: ReturnType<typeof setTimeout> | undefined, sessionIdentityDigest: string | undefined;
    const operation = Promise.resolve().then(() => this.#execute({
      markerDigest: input.markerDigest,
      participantId: input.participant.participantId,
      participantIdentityDigest: input.participant.identityDigest,
      round: input.round,
      safeInstruction: input.safePrompt,
      runtimeIdentityDigest: binding.runtimeIdentityDigest,
      profileIdentityDigest: input.evidence.profileIdDigest,
      conversationIdentityDigest: input.evidence.conversationIdDigest,
      maximumOutputCharacters: 800,
      signal: controller.signal,
    }, handoff.collector));
    const effectiveTimeout = Math.min(this.#timeoutMilliseconds, input.session.maxDurationSeconds * 1000);
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), effectiveTimeout); });
    let outcome: "completed" | "timeout";
    try { outcome = await Promise.race([operation.then(() => "completed" as const), timeout]); }
    catch { handoff.abort(); controller.abort(); await this.#cleanupExact(input.markerDigest, undefined);
      throw new IdeaLabErrorV1("integrity_failed"); }
    finally { if (timer) clearTimeout(timer); }
    if (outcome === "timeout") {
      handoff.abort(); controller.abort(); void operation.catch(() => undefined);
      await this.#cleanupExact(input.markerDigest, undefined);
      throw new IdeaLabErrorV1("integrity_failed");
    }
    let result: ReturnType<typeof parseFrames>;
    try { result = parseFrames(handoff.take(), input); sessionIdentityDigest = result.sessionIdentityDigest; }
    catch { handoff.abort(); controller.abort(); await this.#cleanupExact(input.markerDigest, sessionIdentityDigest);
      throw new IdeaLabErrorV1("integrity_failed"); }
    const cleanupDigest = await this.#cleanupExact(input.markerDigest, sessionIdentityDigest);
    const { sessionIdentityDigest: _sessionIdentityDigest, ...safeResult } = result;
    void _sessionIdentityDigest;
    return { ...safeResult, providerReceiptDigest: sha256Digest({
      gatewayReceiptDigest: safeResult.providerReceiptDigest,
      cleanupDigest,
    }) };
  }

  async #cleanupExact(markerDigest: string, sessionIdentityDigest?: string): Promise<string> {
    const cleanup = createHostResultCollectorV1(), controller = createHostCancellationControllerV1();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = Promise.resolve(this.#cleanup({ markerDigest,
        ...(sessionIdentityDigest ? { sessionIdentityDigest } : {}), signal: controller.signal }, cleanup.collector));
      const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.#timeoutMilliseconds); });
      const outcome = await Promise.race([operation.then(() => "completed" as const), timeout]);
      if (outcome === "timeout") { controller.abort(); cleanup.abort(); void operation.catch(() => undefined);
        throw new IdeaLabErrorV1("integrity_failed"); }
      return parseCleanup(cleanup.take(), markerDigest, sessionIdentityDigest);
    } catch { controller.abort(); cleanup.abort(); throw new IdeaLabErrorV1("integrity_failed"); }
    finally { if (timer) clearTimeout(timer); }
  }
}

export const HERMES_021_IDEA_LAB_DRIVER_DISABLED_V1 = Object.freeze({
  contractVersion: HERMES_021_IDEA_LAB_FILTERED_DRIVER_V1,
  driverConfigured: false as const,
  gatewayPortConfigured: false as const,
  nativeQualified: false as const,
  providerContacted: false as const,
  grantsExecutionAuthority: false as const,
});
