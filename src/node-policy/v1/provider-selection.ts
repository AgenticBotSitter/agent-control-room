import { z } from "zod";
import { ProtectedStoreError } from "./stores";
import { nodePrivateKeyProviders, unwrapSecretSourceKinds, type NodePrivateKeyMode, type NodePrivateKeyProvider, type UnwrapSecretSourceKind } from "./types";

export const supportedKeyStorePlatforms = ["darwin", "win32", "linux"] as const;
export type SupportedKeyStorePlatform = (typeof supportedKeyStorePlatforms)[number];

export interface NodePrivateKeyProviderConfig {
  platform: SupportedKeyStorePlatform;
  provider: NodePrivateKeyProvider;
  runtimeMode: "production" | "test";
  unwrapSecretSource?: UnwrapSecretSourceKind;
}

export interface SelectedNodePrivateKeyProvider {
  platform: SupportedKeyStorePlatform;
  provider: NodePrivateKeyProvider;
  mode: NodePrivateKeyMode;
  unwrapSecretSource?: UnwrapSecretSourceKind;
}

const nodePrivateKeyProviderConfigSchema = z.object({
  platform: z.enum(supportedKeyStorePlatforms),
  provider: z.enum(nodePrivateKeyProviders),
  runtimeMode: z.enum(["production", "test"]),
  unwrapSecretSource: z.enum(unwrapSecretSourceKinds).optional(),
}).strict();

export function selectNodePrivateKeyProvider(input: NodePrivateKeyProviderConfig): SelectedNodePrivateKeyProvider {
  const parsed = nodePrivateKeyProviderConfigSchema.safeParse(input);
  if (!parsed.success) throw new ProtectedStoreError("invalid_configuration");
  const config = parsed.data;
  if (config.provider === "memory_test") {
    if (config.runtimeMode !== "test" || config.unwrapSecretSource) throw new ProtectedStoreError("invalid_configuration");
    return { platform: config.platform, provider: config.provider, mode: "test" };
  }
  if (config.runtimeMode === "test") throw new ProtectedStoreError("invalid_configuration");

  if (config.provider === "encrypted_file") {
    if (!config.unwrapSecretSource) throw new ProtectedStoreError("invalid_configuration");
    return { platform: config.platform, provider: config.provider, mode: "encrypted_file", unwrapSecretSource: config.unwrapSecretSource };
  }

  if (config.unwrapSecretSource) throw new ProtectedStoreError("invalid_configuration");
  if (config.provider === "macos_keychain" && config.platform === "darwin") return { platform: config.platform, provider: config.provider, mode: "native" };
  if (config.provider === "windows_dpapi_current_user" && config.platform === "win32") return { platform: config.platform, provider: config.provider, mode: "native" };
  throw new ProtectedStoreError("unavailable_platform");
}
