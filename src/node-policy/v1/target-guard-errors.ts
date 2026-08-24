export const targetGuardFailureCodes = [
  "invalid_target",
  "target_not_allowed",
  "target_unavailable",
  "prohibited_address",
  "identity_mismatch",
  "unsupported_executor",
] as const;

export type TargetGuardFailureCode = (typeof targetGuardFailureCodes)[number];

export class TargetGuardError extends Error {
  constructor(readonly code: TargetGuardFailureCode) {
    super(`Target guard denied: ${code}`);
    this.name = "TargetGuardError";
  }
}
