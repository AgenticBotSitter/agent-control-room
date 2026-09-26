import { types } from "node:util";

/**
 * Source-only custody join for a future installed recovery sidecar.
 *
 * A recovery port is more sensitive than the reusable sequencing host: its
 * inputs eventually identify protected installation state, a release-bound
 * sidecar, and an owner-attended qualification.  None of those producers
 * exists in the source tree today.  In particular, a plain object that says
 * it was verified is not an acceptable substitute for one of their
 * process-local capabilities.
 *
 * Keep this seam deliberately closed until all three producers exist.  It
 * never accepts callbacks, paths, argv, credentials, or an execution port,
 * and it deliberately returns no "ready" state or reconstruction path.
 */
export const PRIVATE_RECOVERY_INSTALLED_PORT_COMPOSER_V1 =
  "control-room.private-recovery-installed-port-composer/v1" as const;
export const PRIVATE_RECOVERY_INSTALLED_PORT_CAPABILITY_V1 =
  "control-room.private-recovery-installed-port-capability/v1" as const;

function refused(): never {
  const error = new Error("private_recovery_installed_port_composer_refused");
  error.stack = undefined;
  throw error;
}

/** Reject exotic values and accessors before observing a caller value. */
function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))
    || names.some(name => !keys.includes(name))) return refused();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
    result[name] = descriptor.value;
  }
  return Object.freeze(result);
}

export type PrivateRecoveryInstalledPortComposerV1 = Readonly<{
  schema: typeof PRIVATE_RECOVERY_INSTALLED_PORT_COMPOSER_V1;
  status: "blocked";
  blocker: "opaque_recovery_manifest_sidecar_and_owner_qualification_custody_missing";
  oneUse: true;
  /** A future producer may return only this process-local, non-ready token. */
  capability: Readonly<{ schema: typeof PRIVATE_RECOVERY_INSTALLED_PORT_CAPABILITY_V1 }>;
  capabilityClaimsReady: false;
  acceptsManifestCapability: true;
  acceptsSidecarCapability: true;
  acceptsOwnerQualificationCapability: true;
  acceptsCallback: false;
  acceptsPath: false;
  acceptsArgv: false;
  acceptsCredentials: false;
  acceptsProcessPort: false;
  performsEffectOnConstruction: false;
  readsProtectedConfiguration: false;
  opensStorage: false;
  opensDatabase: false;
  startsProcess: false;
}>;

/**
 * This is intentionally a fail-closed placeholder, rather than a generic
 * capability adapter.  Its only allowed fields are the three future opaque
 * capabilities.  Because no source producer can mint any of them yet, every
 * invocation refuses and no structural copy, proxy, callback, or replay can
 * manufacture an installed recovery port.
 */
export function createPrivateRecoveryInstalledPortComposerV1(value: unknown): PrivateRecoveryInstalledPortComposerV1 {
  const input = exact(value, ["schema", "manifestCapability", "sidecarCapability", "ownerQualificationCapability"]);
  if (input.schema !== PRIVATE_RECOVERY_INSTALLED_PORT_COMPOSER_V1
    || !input.manifestCapability || typeof input.manifestCapability !== "object" || types.isProxy(input.manifestCapability)
    || !input.sidecarCapability || typeof input.sidecarCapability !== "object" || types.isProxy(input.sidecarCapability)
    || !input.ownerQualificationCapability || typeof input.ownerQualificationCapability !== "object"
    || types.isProxy(input.ownerQualificationCapability)) return refused();
  return refused();
}
