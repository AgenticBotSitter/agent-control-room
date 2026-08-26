import { verifyServicePackages } from "./conformance";

export type ServicePackagePlatform = "linux" | "macos" | "windows";
export type ServicePackageDiagnosticCode =
  | "ready_for_owner_start"
  | "configuration_invalid"
  | "state_incompatible"
  | "runtime_missing"
  | "supervisor_unavailable"
  | "unsupported_context"
  | "native_evidence_required";

export interface ServicePackageDiagnosticInput {
  platform: ServicePackagePlatform;
  runtimePath: string;
  releaseDirectory: string;
  configPath: string;
  stateRoot: string;
  logRoot: string;
  runtimePresent?: boolean;
  systemdAvailable?: boolean;
  nativeEvidenceClaim?: boolean;
}

export interface ServicePackageDiagnosticResult {
  platform: ServicePackagePlatform;
  code: ServicePackageDiagnosticCode;
  checks: string[];
}

function isAbsolutePath(platform: ServicePackagePlatform, value: string): boolean {
  if (platform === "windows") return /^[A-Za-z]:[\\/][^\0]+/.test(value);
  return value.startsWith("/");
}

function hasValidConfiguration(input: ServicePackageDiagnosticInput): boolean {
  const values = [input.runtimePath, input.releaseDirectory, input.configPath, input.stateRoot, input.logRoot];
  return values.every((value) => value.length > 0 && isAbsolutePath(input.platform, value))
    && new Set(values).size === values.length;
}

/**
 * Performs static-only checks. This never reads the supplied paths, starts a
 * supervisor, loads a package, or returns private configuration values.
 */
export async function diagnoseServicePackage(input: ServicePackageDiagnosticInput): Promise<ServicePackageDiagnosticResult> {
  await verifyServicePackages();
  if (!hasValidConfiguration(input)) {
    return { platform: input.platform, code: "configuration_invalid", checks: ["configuration shape rejected"] };
  }
  if (input.runtimePresent === false) {
    return { platform: input.platform, code: "runtime_missing", checks: ["runtime availability supplied as missing"] };
  }
  if (input.platform === "linux" && input.systemdAvailable === false) {
    return { platform: input.platform, code: "supervisor_unavailable", checks: ["systemd availability supplied as unavailable"] };
  }
  if (input.nativeEvidenceClaim === true) {
    return { platform: input.platform, code: "native_evidence_required", checks: ["native claim requires owner rehearsal"] };
  }
  return { platform: input.platform, code: "ready_for_owner_start", checks: ["static package and configuration shape accepted"] };
}
