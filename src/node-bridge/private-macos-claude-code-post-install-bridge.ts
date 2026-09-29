import { types } from "node:util";
import {
  consumePrivateMacosClaudeCodeInstalledProcessHostPortsForPostInstallV1,
  PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_CAPABILITY_V1,
} from "./private-macos-claude-code-installed-port-composer";
import type { PrivateClaudeCodeInstalledProcessHostPortsV1 } from
  "../harness/claude-code-v1/private-installed-process-host";

/**
 * The only source-only join from the verified macOS process-port composer to
 * the pre-existing private Claude post-install tuple.  The opaque composer
 * capability is consumed here, before the normal private installation
 * assembly captures the tuple.  It is never returned, serialized, or made a
 * field of ordinary installation configuration.
 */
export const PRIVATE_MACOS_CLAUDE_CODE_POST_INSTALL_BRIDGE_V1 =
  "control-room.private-macos-claude-code-post-install-bridge/v1" as const;

const refused = (): never => {
  const error = new Error("private_macos_claude_code_post_install_bridge_refused");
  error.stack = undefined;
  throw error;
};

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || names.some(name => !keys.includes(name)) || keys.some(key => !names.includes(key))) return refused();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return refused();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

export type PrivateMacosClaudeCodePostInstallTupleV1 = Readonly<{
  admissionInput: unknown;
  admissionRuntime: unknown;
  compositionInput: Readonly<{
    tenantId: unknown;
    installedProcessConfiguration: unknown;
    ports: PrivateClaudeCodeInstalledProcessHostPortsV1;
    execution: unknown;
    reviewCheckpoints: unknown;
    assertCurrentProcess: unknown;
    assertCurrentDelivery: unknown;
  }>;
}>;

/**
 * Replace only the existing tuple's native process ports with the exact port
 * retained by the verified one-use composer. Construction is inert: neither
 * `verifyInstallation` nor `launch` is called here. The returned tuple has no
 * reference to the opaque capability, so ordinary configuration capture can
 * only retain the two fixed ports, not recreate or reuse the capability.
 */
export function composePrivateMacosClaudeCodePostInstallV1(value: unknown): PrivateMacosClaudeCodePostInstallTupleV1 {
  try {
    const input = exact(value, ["schema", "claudePostInstall", "capability"]);
    if (input.schema !== PRIVATE_MACOS_CLAUDE_CODE_POST_INSTALL_BRIDGE_V1) return refused();
    const tuple = exact(input.claudePostInstall, ["admissionInput", "admissionRuntime", "compositionInput"]);
    const composition = exact(tuple.compositionInput, ["tenantId", "installedProcessConfiguration", "ports", "execution",
      "reviewCheckpoints", "assertCurrentProcess", "assertCurrentDelivery"]);
    // The caller-supplied placeholder must be ordinary data. It is never used
    // as a port; rejecting exotic values makes the replacement unambiguous.
    if (!composition.ports || typeof composition.ports !== "object" || types.isProxy(composition.ports)) return refused();
    const capability = input.capability;
    if (!capability || typeof capability !== "object" || types.isProxy(capability)
      || (capability as { schema?: unknown }).schema !== PRIVATE_MACOS_CLAUDE_CODE_INSTALLED_PORT_CAPABILITY_V1) return refused();
    const admissionInput = tuple.admissionInput;
    if (!admissionInput || typeof admissionInput !== "object" || types.isProxy(admissionInput)) return refused();
    const qualification = Object.getOwnPropertyDescriptor(admissionInput, "qualificationReport");
    if (!qualification || !("value" in qualification) || qualification.enumerable !== true) return refused();
    const ports = consumePrivateMacosClaudeCodeInstalledProcessHostPortsForPostInstallV1(capability,
      Object.freeze({ installedProcessConfiguration: composition.installedProcessConfiguration,
        qualificationReport: qualification.value }));
    return Object.freeze({ admissionInput: tuple.admissionInput, admissionRuntime: tuple.admissionRuntime,
      compositionInput: Object.freeze({ tenantId: composition.tenantId,
        installedProcessConfiguration: composition.installedProcessConfiguration, ports,
        execution: composition.execution, reviewCheckpoints: composition.reviewCheckpoints,
        assertCurrentProcess: composition.assertCurrentProcess,
        assertCurrentDelivery: composition.assertCurrentDelivery }) });
  } catch { return refused(); }
}
