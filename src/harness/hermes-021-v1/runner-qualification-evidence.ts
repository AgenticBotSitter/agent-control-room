import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";

export const HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1 =
  "control-room.hermes-021-macos-local-runner-qualification-report/v1" as const;
export const HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_EVIDENCE_V1 =
  "control-room.hermes-021-macos-local-runner-qualification-evidence/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Sanitized output of the owner-run fixed-argument runner check. */
export const hermes021MacosLocalRunnerQualificationReportSchemaV1 = z.object({
  schema: z.literal(HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1),
  qualified: z.boolean(),
  terminalResultObserved: z.boolean(),
  sessionDigest: digest.nullable(),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  totalTokens: count.nullable(),
  durationMs: count.nullable(),
  failureReason: z.enum(["none", "owner_configuration_invalid", "runner_bridge_unavailable", "terminal_result_unexpected"]),
  retryRequiresFreshOwnerAuthorization: z.boolean(),
}).strict();

const successfulReport = hermes021MacosLocalRunnerQualificationReportSchemaV1.superRefine((value, context) => {
  if (!value.qualified || !value.terminalResultObserved || !value.sessionDigest || value.inputTokens === null
    || value.outputTokens === null || value.totalTokens === null || value.durationMs === null
    || value.totalTokens < value.inputTokens + value.outputTokens || value.failureReason !== "none"
    || value.retryRequiresFreshOwnerAuthorization) context.addIssue({ code: "custom", message: "runner qualification did not pass" });
});

/** Converts the successful sanitized bridge report into a plan-safe fingerprint. */
export function createHermes021MacosLocalRunnerQualificationEvidenceV1(value: unknown) {
  const report = successfulReport.parse(value);
  return Object.freeze({ schema: HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_EVIDENCE_V1,
    evidenceDigest: sha256Digest({ schema: HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_EVIDENCE_V1, report }) });
}
