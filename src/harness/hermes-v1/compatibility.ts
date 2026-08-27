import { HERMES_PINNED_REVISION_V1, hermesAdapterManifestV1 } from "./manifest";

export const HERMES_REQUIRED_GATEWAY_METHODS_V1 = ["prompt.submit", "session.create", "session.interrupt", "session.resume", "session.status", "session.steer", "session.usage"] as const;

export interface HermesCompatibilityEvidenceV1 { harnessVersion: string; harnessRevision: string; gatewayMethods: string[]; }
export interface HermesCompatibilityResultV1 { compatible: boolean; reasons: Array<"version_drift" | "revision_drift" | "gateway_method_missing" | "gateway_method_set_ambiguous">; missingMethods: string[]; }

export function evaluateHermesCompatibilityV1(evidence: HermesCompatibilityEvidenceV1): HermesCompatibilityResultV1 {
  const reasons: HermesCompatibilityResultV1["reasons"] = [];
  if (evidence.harnessVersion !== hermesAdapterManifestV1.harnessVersion) reasons.push("version_drift");
  if (evidence.harnessRevision !== HERMES_PINNED_REVISION_V1) reasons.push("revision_drift");
  const methods = new Set(evidence.gatewayMethods);
  if (methods.size !== evidence.gatewayMethods.length) reasons.push("gateway_method_set_ambiguous");
  const missingMethods = HERMES_REQUIRED_GATEWAY_METHODS_V1.filter((method) => !methods.has(method));
  if (missingMethods.length) reasons.push("gateway_method_missing");
  return { compatible: reasons.length === 0, reasons, missingMethods };
}
