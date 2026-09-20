import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";

export const HERMES_021_MACOS_LOCAL_QUALIFICATION_EVIDENCE_V1 =
  "control-room.hermes-021-macos-local-qualification-evidence/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** The intentionally small, sanitized report emitted by the owner-run check. */
const successfulQualificationReport = z.object({
  qualified: z.literal(true),
  exitCode: z.literal(0),
  exitSignal: z.null(),
  terminalResultObserved: z.literal(true),
  sessionDigest: digest,
  inputTokens: count,
  outputTokens: count,
  totalTokens: count,
  durationMs: count,
  stderrBytes: count.max(65_536),
  failureStage: z.literal("none"),
  failureReason: z.literal("none"),
  profileOverrideUsed: z.boolean(),
  modelOverrideUsed: z.boolean(),
  providerOverrideUsed: z.boolean(),
  retryRequiresFreshOwnerAuthorization: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.totalTokens < value.inputTokens + value.outputTokens) context.addIssue({ code: "custom", message: "qualification token total invalid" });
});

export type Hermes021MacosLocalQualificationEvidenceV1 = Readonly<{
  schema: typeof HERMES_021_MACOS_LOCAL_QUALIFICATION_EVIDENCE_V1;
  evidenceDigest: string;
}>;

/**
 * Converts a successful *sanitized* owner-run report into the opaque proof
 * fingerprint used by installation readiness. It deliberately returns no
 * session hash, model, provider, token counts, path, command, or terminal text.
 */
export function createHermes021MacosLocalQualificationEvidenceV1(value: unknown): Hermes021MacosLocalQualificationEvidenceV1 {
  const report = successfulQualificationReport.parse(value);
  const material = { schema: HERMES_021_MACOS_LOCAL_QUALIFICATION_EVIDENCE_V1, report };
  return Object.freeze({ schema: HERMES_021_MACOS_LOCAL_QUALIFICATION_EVIDENCE_V1, evidenceDigest: sha256Digest(material) });
}
