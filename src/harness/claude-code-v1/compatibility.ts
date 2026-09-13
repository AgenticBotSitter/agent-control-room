import { CLAUDE_CODE_PINNED_VERSION_V1 } from "./manifest";

/**
 * `claude doctor` reports a short build commit distinct from the npm registry's gitHead
 * (see manifest.ts). Captured live in Stage A0 against the pinned version above; checked
 * here as an independent drift signal rather than folded into harnessRevision, since it is
 * the identifier a running node can actually observe without querying the npm registry.
 */
export const CLAUDE_CODE_PINNED_BUILD_COMMIT_V1 = "97ecbf7abeb4" as const;

export interface ClaudeCodeCompatibilityEvidenceV1 {
  version: string;
  buildCommit: string;
  printMode: boolean;
  streamJsonOutputFormat: boolean;
  jsonOutputFormat: boolean;
  resumeSupported: boolean;
}

export type ClaudeCodeCompatibilityReasonV1 =
  | "version_drift" | "build_commit_drift" | "print_mode_missing"
  | "stream_json_missing" | "json_output_missing" | "resume_missing";

export function evaluateClaudeCodeCompatibilityV1(evidence: ClaudeCodeCompatibilityEvidenceV1):
  { compatible: boolean; reasons: ClaudeCodeCompatibilityReasonV1[] } {
  const reasons: ClaudeCodeCompatibilityReasonV1[] = [];
  if (evidence.version !== CLAUDE_CODE_PINNED_VERSION_V1) reasons.push("version_drift");
  if (evidence.buildCommit !== CLAUDE_CODE_PINNED_BUILD_COMMIT_V1) reasons.push("build_commit_drift");
  if (!evidence.printMode) reasons.push("print_mode_missing");
  if (!evidence.streamJsonOutputFormat) reasons.push("stream_json_missing");
  if (!evidence.jsonOutputFormat) reasons.push("json_output_missing");
  if (!evidence.resumeSupported) reasons.push("resume_missing");
  return { compatible: reasons.length === 0, reasons: [...new Set(reasons)] };
}
