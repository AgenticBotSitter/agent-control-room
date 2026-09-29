/**
 * Stable identifiers for the update-aware Mac-local Hermes worker.  These
 * identify a Control Room delivery shape, not a particular Hermes release,
 * executable, account, model, or provider.  The protected installation
 * record supplies and re-qualifies those changing details separately.
 */
export const HERMES_LOCAL_ADAPTER_V1 = "connector:hermes-macos-local-v1" as const;
export const HERMES_LOCAL_CAPABILITY_V1 = "harness.hermes.macos.local.v1" as const;
export const HERMES_LOCAL_JOB_TYPE_V1 = "harness.hermes.macos.task" as const;
export const HERMES_LOCAL_START_OPERATION_V1 = "harness.hermes.macos.start" as const;
