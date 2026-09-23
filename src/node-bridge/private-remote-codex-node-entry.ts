import { z } from "zod";
import { digestSchema, localId } from "../harness/v1/native-run-identifiers";
import { assertSynchronousFence } from "../security/synchronous-fence";
import { createCodexWorkerCompositionV1, type CodexWorkerCompositionInputV1 } from "./codex-worker-composition";

/**
 * Private, installation-owned node entry for the first Linux Codex worker.
 * It joins the existing private Codex configuration/worker composition to an
 * already-authenticated node session. It deliberately does not open journals,
 * acquire a process, connect a bridge, start Codex, or read credentials.
 */
export const PRIVATE_REMOTE_CODEX_NODE_ENTRY_V1 =
  "control-room.private-remote-codex-node-entry/v1" as const;

const identitySchema = z.object({
  tenantId: localId,
  nodeId: localId,
  enrollmentDigest: digestSchema,
  connectorProfileDigest: digestSchema,
  sessionIdentityDigest: digestSchema,
  assertCurrent: z.function(),
}).strict();

const unavailable = (): never => { throw new Error("private_remote_codex_node_entry_unavailable"); };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type ProtectedNodeIdentityV1 = z.infer<typeof identitySchema>;

function captureInput(value: unknown): { identity: ProtectedNodeIdentityV1; composition: CodexWorkerCompositionInputV1 } {
  const input = isRecord(value) ? value : unavailable();
  if (Object.keys(input).length !== 2 || !("identity" in input) || !("composition" in input)) unavailable();
  const parsedIdentity = identitySchema.safeParse(input.identity);
  if (!parsedIdentity.success) unavailable();
  const parsed = parsedIdentity.data ?? unavailable();
  const identity: ProtectedNodeIdentityV1 = {
    tenantId: parsed.tenantId ?? unavailable(),
    nodeId: parsed.nodeId ?? unavailable(),
    enrollmentDigest: parsed.enrollmentDigest ?? unavailable(),
    connectorProfileDigest: parsed.connectorProfileDigest ?? unavailable(),
    sessionIdentityDigest: parsed.sessionIdentityDigest ?? unavailable(),
    assertCurrent: parsed.assertCurrent ?? unavailable(),
  };
  const rawComposition = input.composition;
  if (!isRecord(rawComposition) || Object.keys(rawComposition).length !== 5
    || !("initial" in rawComposition) || !("recovery" in rawComposition) || !("result" in rawComposition)
    || !("binding" in rawComposition) || !("assertSessionCurrent" in rawComposition)) unavailable();
  const composition = rawComposition as unknown as CodexWorkerCompositionInputV1;
  const binding = composition.binding;
  if (!binding || binding.tenantId !== identity.tenantId || binding.nodeId !== identity.nodeId
    || binding.enrollmentDigest !== identity.enrollmentDigest
    || binding.connectorProfileDigest !== identity.connectorProfileDigest
    || binding.sessionIdentityDigest !== identity.sessionIdentityDigest
    || !digestSchema.safeParse(binding.activationFrameDigest).success
    || typeof composition.assertSessionCurrent !== "function") unavailable();
  return { identity: Object.freeze({ ...identity }), composition };
}

/**
 * Captures only protected inputs. The returned operations retain the existing
 * one-shot Codex worker behavior, but this constructor itself is inert. A
 * caller cannot choose a path, credential, transport, worker identity, or
 * callback through browser/task data: all such ports stay inside the supplied
 * installation-owned composition.
 */
export function createPrivateRemoteCodexNodeEntryV1(value: unknown) {
  const captured = captureInput(value);
  const worker = createCodexWorkerCompositionV1({ ...captured.composition,
    binding: Object.freeze({ ...captured.composition.binding }),
    assertSessionCurrent() {
      assertSynchronousFence(captured.identity.assertCurrent, unavailable);
      assertSynchronousFence(captured.composition.assertSessionCurrent, unavailable);
    },
  });
  return Object.freeze({
    schema: PRIVATE_REMOTE_CODEX_NODE_ENTRY_V1,
    startsWork: false as const,
    grantsExecutionAuthority: false as const,
    async start(signal: AbortSignal) { return worker.start(signal); },
    async recoverAndReturn(signal: AbortSignal) { return worker.recoverAndReturn(signal); },
    async close() { await worker.close(); },
  });
}
