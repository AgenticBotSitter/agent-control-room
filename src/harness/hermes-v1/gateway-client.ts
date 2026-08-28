import { z } from "zod";
import { sha256Digest } from "../../security";
import { evaluateHermesCompatibilityV1, type HermesCompatibilityEvidenceV1 } from "./compatibility";
import { hermesAdapterManifestV1 } from "./manifest";

const id = z.string().min(1).max(256);
const boundedText = z.string().trim().min(1).max(16_384);
const boundedCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const HERMES_NO_EFFECT_TOOLSET_V1 = "context_engine" as const;

export const hermesGatewayLaunchAttestationSchemaV1 = z.object({
  disposableProfile: z.literal(true),
  disposableWorkspace: z.literal(true),
  ignoreContextFiles: z.literal(true),
  enabledToolsets: z.tuple([z.literal(HERMES_NO_EFFECT_TOOLSET_V1)]),
  callableToolCount: z.literal(0),
  mcpServerCount: z.literal(0),
}).strict();

export type HermesGatewayLaunchAttestationV1 = z.infer<typeof hermesGatewayLaunchAttestationSchemaV1>;

export type HermesGatewayMethodV1 =
  | "session.create"
  | "prompt.submit"
  | "session.steer"
  | "session.interrupt"
  | "session.resume"
  | "session.status"
  | "session.usage";

export interface HermesGatewayRpcTransportV1 {
  call(method: HermesGatewayMethodV1, params: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** Node-local only. Raw Hermes identifiers must never cross the adapter boundary. */
export interface HermesNativeSessionReferenceV1 {
  liveSessionId: string;
  storedSessionId: string;
  sessionKeyDigest: string;
}

export interface HermesGatewayUsageV1 {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  calls: number;
}

const sessionInfoSchema = z.object({
  tools: z.record(z.string(), z.unknown()),
  mcp_servers: z.array(z.unknown()).max(0).optional(),
}).passthrough();

const createResultSchema = z.object({
  session_id: id,
  stored_session_id: id,
  info: sessionInfoSchema,
}).passthrough();

const resumeResultSchema = z.object({
  session_id: id,
  resumed: id,
  status: z.enum(["idle", "running"]),
  info: sessionInfoSchema,
}).passthrough();

const usageResultSchema = z.object({
  input: boundedCount.default(0),
  output: boundedCount.default(0),
  reasoning: boundedCount.default(0),
  total: boundedCount.default(0),
  calls: boundedCount.default(0),
}).passthrough();

export class HermesGatewayLifecycleClientV1 {
  private readonly attestation: HermesGatewayLaunchAttestationV1;

  constructor(
    private readonly transport: HermesGatewayRpcTransportV1,
    compatibility: HermesCompatibilityEvidenceV1,
    attestation: HermesGatewayLaunchAttestationV1,
  ) {
    const decision = evaluateHermesCompatibilityV1(compatibility);
    if (!decision.compatible) throw new Error(`Hermes gateway incompatible: ${decision.reasons.join(",")}`);
    this.attestation = hermesGatewayLaunchAttestationSchemaV1.parse(attestation);
  }

  async start(input: { tenantId: string; nodeId: string; cwd: string; prompt: string }): Promise<HermesNativeSessionReferenceV1> {
    this.assertAttested();
    const prompt = boundedText.parse(input.prompt);
    const created = createResultSchema.parse(await this.transport.call("session.create", {
      cwd: z.string().min(1).max(4_096).parse(input.cwd),
      source: "tui",
    }));
    assertNoCallableTools(created.info);

    const started = z.object({ status: z.literal("streaming") }).passthrough().parse(
      await this.transport.call("prompt.submit", { session_id: created.session_id, text: prompt }),
    );
    void started;
    return nativeReference(input.tenantId, input.nodeId, created.session_id, created.stored_session_id);
  }

  async steer(reference: HermesNativeSessionReferenceV1, text: string): Promise<void> {
    const result = z.object({ status: z.literal("queued") }).passthrough().parse(
      await this.transport.call("session.steer", { session_id: reference.liveSessionId, text: boundedText.max(4_096).parse(text) }),
    );
    void result;
  }

  async cancel(reference: HermesNativeSessionReferenceV1): Promise<void> {
    const result = z.object({ status: z.literal("interrupted") }).passthrough().parse(
      await this.transport.call("session.interrupt", { session_id: reference.liveSessionId }),
    );
    void result;
  }

  async resume(input: { tenantId: string; nodeId: string; storedSessionId: string }): Promise<HermesNativeSessionReferenceV1> {
    this.assertAttested();
    const storedSessionId = id.parse(input.storedSessionId);
    const resumed = resumeResultSchema.parse(await this.transport.call("session.resume", { session_id: storedSessionId }));
    if (resumed.resumed !== storedSessionId) throw new Error("Hermes resumed a different native session");
    assertNoCallableTools(resumed.info);
    return nativeReference(input.tenantId, input.nodeId, resumed.session_id, storedSessionId);
  }

  async usage(reference: HermesNativeSessionReferenceV1): Promise<HermesGatewayUsageV1> {
    const usage = usageResultSchema.parse(await this.transport.call("session.usage", { session_id: reference.liveSessionId }));
    return { inputTokens: usage.input, outputTokens: usage.output, reasoningTokens: usage.reasoning, totalTokens: usage.total, calls: usage.calls };
  }

  private assertAttested(): void {
    hermesGatewayLaunchAttestationSchemaV1.parse(this.attestation);
  }
}

function assertNoCallableTools(info: z.infer<typeof sessionInfoSchema>): void {
  if (Object.keys(info.tools).length !== 0) throw new Error("Hermes session exposed callable tools");
  if (info.mcp_servers && info.mcp_servers.length !== 0) throw new Error("Hermes session exposed MCP servers");
}

function nativeReference(tenantId: string, nodeId: string, liveSessionId: string, storedSessionId: string): HermesNativeSessionReferenceV1 {
  return {
    liveSessionId,
    storedSessionId,
    sessionKeyDigest: sha256Digest({ tenantId, nodeId, adapterId: hermesAdapterManifestV1.adapterId, storedSessionId }),
  };
}
