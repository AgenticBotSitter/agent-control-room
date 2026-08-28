import { CODEX_PINNED_MACOS_CDHASH_V1, CODEX_PINNED_VERSION_V1 } from "./manifest";

export interface CodexCompatibilityEvidenceV1 {
  version: string;
  macosCodeDirectoryHash: string;
  execJson: boolean;
  execResume: boolean;
  ignoreUserConfig: boolean;
  ignoreRules: boolean;
  sandboxModes: string[];
}

export type CodexCompatibilityReasonV1 =
  | "version_drift" | "binary_drift" | "json_events_missing" | "resume_missing"
  | "config_isolation_missing" | "rules_isolation_missing" | "sandbox_mode_missing";

export function evaluateCodexCompatibilityV1(evidence: CodexCompatibilityEvidenceV1): { compatible: boolean; reasons: CodexCompatibilityReasonV1[] } {
  const reasons: CodexCompatibilityReasonV1[] = [];
  if (evidence.version !== CODEX_PINNED_VERSION_V1) reasons.push("version_drift");
  if (evidence.macosCodeDirectoryHash !== CODEX_PINNED_MACOS_CDHASH_V1) reasons.push("binary_drift");
  if (!evidence.execJson) reasons.push("json_events_missing");
  if (!evidence.execResume) reasons.push("resume_missing");
  if (!evidence.ignoreUserConfig) reasons.push("config_isolation_missing");
  if (!evidence.ignoreRules) reasons.push("rules_isolation_missing");
  for (const mode of ["read-only", "workspace-write"]) if (!evidence.sandboxModes.includes(mode)) reasons.push("sandbox_mode_missing");
  return { compatible: reasons.length === 0, reasons: [...new Set(reasons)] };
}
