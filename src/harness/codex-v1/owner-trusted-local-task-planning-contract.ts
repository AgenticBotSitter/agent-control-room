/**
 * Identifiers for an owner-trusted, Mac-local Codex CLI task.  They do not
 * describe a command line, account, workspace, or model choice.  Those stay
 * in the protected local installation configuration.  A saved plan is only a
 * proposal; the existing assignment, approval, queue, and final authority
 * checks remain responsible for deciding whether it may run.
 */
export const CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 = "connector:codex-owner-trusted-local-v1" as const;
export const CODEX_OWNER_TRUSTED_LOCAL_CAPABILITY_V1 = "harness.codex.owner-trusted.local.v1" as const;
export const CODEX_OWNER_TRUSTED_LOCAL_JOB_TYPE_V1 = "harness.codex.owner-trusted.local.task" as const;
export const CODEX_OWNER_TRUSTED_LOCAL_START_OPERATION_V1 = "harness.codex.owner-trusted.local.start" as const;
