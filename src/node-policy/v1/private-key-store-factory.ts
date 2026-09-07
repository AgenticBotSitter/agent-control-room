import type { Clock } from "./clock";
import { EncryptedFileNodePrivateKeyStore, type EncryptedEnvelopeLoader, type UnwrapSecretSource } from "./encrypted-file-key-store";
import {
  MacOsKeychainNodePrivateKeyStore,
  WindowsDpapiNodePrivateKeyStore,
  type OpaqueBlobLoaderV1,
  type SafeCommandRunnerV1,
} from "./native-key-stores";
import { selectNodePrivateKeyProvider, supportedKeyStorePlatforms, type NodePrivateKeyProviderConfig } from "./provider-selection";
import { ProtectedStoreError, type NodePrivateKeyStore } from "./stores";
import type { KeyReferenceV1 } from "./types";

export type NodePrivateKeyStoreRuntimeConfigV1 = NodePrivateKeyProviderConfig & {
  reference: KeyReferenceV1;
};

export interface NodePrivateKeyStoreDependenciesV1 {
  clock: Clock;
  macos?: {
    service: string;
    account: string;
    runner?: SafeCommandRunnerV1;
  };
  windows?: {
    blobLoader: OpaqueBlobLoaderV1;
    entropyLoader?: () => Promise<Uint8Array>;
    runner?: SafeCommandRunnerV1;
  };
  encryptedFile?: {
    envelopeLoader: EncryptedEnvelopeLoader;
    unwrapSource: UnwrapSecretSource;
  };
}

export function createNodePrivateKeyStore(
  config: NodePrivateKeyStoreRuntimeConfigV1,
  dependencies: NodePrivateKeyStoreDependenciesV1,
): NodePrivateKeyStore {
  const runtimePlatform = process.platform;
  if (!(supportedKeyStorePlatforms as readonly string[]).includes(runtimePlatform) || config.platform !== runtimePlatform) {
    throw new ProtectedStoreError("unavailable_platform");
  }
  const selected = selectNodePrivateKeyProvider({
    platform: config.platform,
    provider: config.provider,
    runtimeMode: config.runtimeMode,
    ...(config.unwrapSecretSource === undefined ? {} : { unwrapSecretSource: config.unwrapSecretSource }),
  });
  if (config.reference.provider !== selected.provider || config.reference.mode !== selected.mode) {
    throw new ProtectedStoreError("invalid_configuration");
  }
  switch (selected.provider) {
    case "macos_keychain":
      if (!dependencies.macos || dependencies.windows || dependencies.encryptedFile) throw new ProtectedStoreError("invalid_configuration");
      return new MacOsKeychainNodePrivateKeyStore(config.reference,dependencies.clock,dependencies.macos);
    case "windows_dpapi_current_user":
      if (!dependencies.windows || dependencies.macos || dependencies.encryptedFile) throw new ProtectedStoreError("invalid_configuration");
      return new WindowsDpapiNodePrivateKeyStore(config.reference,dependencies.clock,dependencies.windows.blobLoader,dependencies.windows);
    case "encrypted_file":
      if (!dependencies.encryptedFile || dependencies.macos || dependencies.windows
        || dependencies.encryptedFile.unwrapSource.kind !== selected.unwrapSecretSource) {
        throw new ProtectedStoreError("invalid_configuration");
      }
      return new EncryptedFileNodePrivateKeyStore(
        config.reference,dependencies.clock,dependencies.encryptedFile.envelopeLoader,dependencies.encryptedFile.unwrapSource,
      );
    case "memory_test":
      throw new ProtectedStoreError("invalid_configuration");
  }
}
