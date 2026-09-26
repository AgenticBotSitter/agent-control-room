/**
 * LCOI-1 composition boundary. This is an inert refusal, not an installed
 * owner and not evidence of Linux qualification.
 *
 * The existing installed-configuration verifier derives its authority from a
 * verified macOS expanded launcher and its pinned ACRCFG1 helper. That custody
 * cannot authorize Linux state. validatePrivateNativeStatePaths is useful
 * validation precedent, but checks followed by pathname-based database opens
 * do not establish retained native identity. The Hermes configuration opener
 * and the injectable Codex host therefore cannot mint this owner either.
 *
 * There is deliberately no capability minter, injectable verifier, factory,
 * platform override, or fallback opener here. Adding a successful branch
 * requires the protected native implementation described below, not a new
 * structural configuration interface. No module with resource-opening import
 * effects is imported at this boundary.
 */
export const PRIVATE_LINUX_CODEX_INSTALLED_STATE_OWNER_V1 =
  "control-room.private-linux-codex-installed-state-owner/v1" as const;

/** Static source requirements only; these strings attest to no installation. */
export const privateLinuxCodexInstalledStateRequirementsV1 = Object.freeze({
  installedConfiguration: "opaque_one_use_linux_release_verified_configuration" as const,
  nativeCustody: "retained_owner_mode_realpath_inode_link_and_sqlite_sidecar_identity" as const,
  bindings: Object.freeze([
    "installation", "release", "tenant", "node", "node_class", "key_reference",
    "enrollment", "connector_profile", "workspace_intent", "journal",
  ] as const),
  resources: Object.freeze([
    "one_shared_bridge_journal", "distinct_security_artifact_and_high_water_databases",
    "codex_start_and_result_journals", "protected_owner_approval_pins",
    "linux_encrypted_file_key_envelope", "separately_protected_unwrap_source",
  ] as const),
  lifecycle: "unlock_before_entry_bounded_close_partial_open_and_cleanup_uncertainty_refuse" as const,
  futureOutput: "opaque_one_use_bridge_owner_factory" as const,
});

/**
 * Reserved outer entry point: every input fails until genuine Linux native
 * installed custody exists. Do not even inspect the proposed capability:
 * getters, proxies, promises, callbacks, paths and claimed readiness carry no
 * authority. In particular, do not echo or serialize rejected private input.
 * No key, database, credential, transport, process, or filesystem is touched.
 */
export function createPrivateLinuxCodexInstalledStateOwnerV1(
  installedConfigurationCapability: unknown,
): never {
  void installedConfigurationCapability;
  const error = new Error("private_linux_codex_installed_state_native_custody_unavailable");
  error.stack = undefined;
  throw error;
}
