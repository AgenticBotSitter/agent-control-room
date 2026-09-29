import { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 } from "./result-publication";

/**
 * Identifiers for a proposed local Claude Code task.  They deliberately do
 * not describe a command line, credentials, a workspace, or a supported
 * Claude operation.  Saving a plan is useful for the shared task/review
 * lifecycle, but assignment remains fail-closed until the separate installed
 * process qualification and host composition exist.
 */
export const CLAUDE_CODE_LOCAL_ADAPTER_V1 = "connector:claude-code-local-v1" as const;
export const CLAUDE_CODE_LOCAL_CAPABILITY_V1 = "harness.claude-code.local.v1" as const;
export const CLAUDE_CODE_LOCAL_JOB_TYPE_V1 = "harness.claude-code.local.task" as const;
export const CLAUDE_CODE_LOCAL_START_OPERATION_V1 = "harness.claude-code.local.start" as const;
export { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 };
