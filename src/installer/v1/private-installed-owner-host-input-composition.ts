import { types } from "node:util";
import { createPrivateInstalledLocalOperatorLoaderV1,
  PRIVATE_INSTALLED_LOCAL_OPERATOR_LOADER_V1,
  type PrivateInstalledLocalOperatorLoaderV1 } from
  "./private-installed-local-operator-loader";
import { PRIVATE_INSTALLED_JOURNAL_CUSTODY_PORTS_V1 } from
  "./private-installed-journal-custody-composer";
import type { PrivateLocalInstallationSetupRuntimesV1 } from
  "./private-installed-local-hermes-runtime-composer";

/**
 * Process-local owner-host composition. It joins already-selected protected
 * custody and runtime ports; it does not discover them from files, arguments,
 * environment variables, or global state and performs no live operation.
 */
export const PRIVATE_INSTALLED_OWNER_HOST_INPUT_COMPOSITION_V1 =
  "control-room.private-installed-owner-host-input-composition/v1" as const;
export const PRIVATE_INSTALLED_OWNER_HOST_PROVIDER_V1 =
  "control-room.private-installed-owner-host-provider/v1" as const;

const stages = Object.freeze(["database_authority", "protected_data", "first_owner", "recovery",
  "platform_service", "agent_readiness", "final_review"] as const);
type Stage = typeof stages[number];

const missing = Object.freeze({
  installedConfigurationCustodyInput: "installed_configuration_custody_input_missing",
  stagedJournalSidecar: "staged_journal_sidecar_missing",
  journalSessionFactory: "journal_session_factory_missing",
  hermesStartupBase: "hermes_startup_base_missing",
  hermesDeliveryIntegrityKey: "hermes_delivery_integrity_key_missing",
  hermesAssertCurrentDelivery: "hermes_assert_current_delivery_missing",
  database_authority: "database_authority_runtime_missing",
  protected_data: "protected_data_runtime_missing",
  first_owner: "first_owner_runtime_missing",
  recovery: "recovery_runtime_missing",
  platform_service: "platform_service_runtime_missing",
  agent_readiness: "agent_readiness_runtime_missing",
  final_review: "final_review_runtime_missing",
  journalOperationDeadlineMs: "journal_operation_deadline_missing",
} as const);

export type PrivateInstalledOwnerHostInputBlockerV1 = typeof missing[keyof typeof missing];

export type PrivateInstalledOwnerHostInputPreflightV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_OWNER_HOST_INPUT_COMPOSITION_V1;
  status: "loader_ready" | "blocked";
  blocker?: PrivateInstalledOwnerHostInputBlockerV1;
  performsEffect: false;
  readsProtectedConfiguration: false;
  opensNativeSession: false;
  opensDatabase: false;
  startsService: false;
  startsWorker: false;
  invokesHermes: false;
}>;

const preparedLoaders = new WeakMap<object, PrivateInstalledLocalOperatorLoaderV1>();
const preparedProviders = new WeakMap<object, PrivateInstalledOwnerHostInputPreflightV1>();

export type PrivateInstalledOwnerHostProviderV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLED_OWNER_HOST_PROVIDER_V1;
  status: "prepared" | "blocked";
  blocker?: PrivateInstalledOwnerHostInputBlockerV1;
  processLocal: true;
  oneUse: true;
  performsEffect: false;
}>;

function refused(): never {
  const error = new Error("private_installed_owner_host_input_composition_refused");
  error.stack = undefined;
  throw error;
}

function record(value: unknown, permitted: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const names = Object.getOwnPropertyNames(value);
  if (names.some(name => !permitted.includes(name))) return refused();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
  }
  return value as Readonly<Record<string, unknown>>;
}

function field(value: Readonly<Record<string, unknown>>, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, name) ? value[name] : undefined;
}

function blocked(blocker: PrivateInstalledOwnerHostInputBlockerV1): PrivateInstalledOwnerHostInputPreflightV1 {
  return Object.freeze({ schema: PRIVATE_INSTALLED_OWNER_HOST_INPUT_COMPOSITION_V1,
    status: "blocked" as const, blocker, performsEffect: false as const,
    readsProtectedConfiguration: false as const, opensNativeSession: false as const,
    opensDatabase: false as const, startsService: false as const, startsWorker: false as const,
    invokesHermes: false as const });
}

/**
 * Returns the first missing required host boundary in a fixed order. A complete
 * input is captured by the existing reviewed loader and represented only by a
 * one-use process-local opaque record.
 */
export function preflightPrivateInstalledOwnerHostInputCompositionV1(value: unknown):
PrivateInstalledOwnerHostInputPreflightV1 {
  const input = record(value, ["schema", "installedConfigurationCustodyInput", "stagedJournalSidecar",
    "journalSessionFactory", "hermesRuntimePorts", "setupRuntimes", "journalOperationDeadlineMs"]);
  if (field(input, "schema") !== PRIVATE_INSTALLED_OWNER_HOST_INPUT_COMPOSITION_V1) return refused();
  if (field(input, "installedConfigurationCustodyInput") === undefined)
    return blocked(missing.installedConfigurationCustodyInput);
  if (field(input, "stagedJournalSidecar") === undefined) return blocked(missing.stagedJournalSidecar);
  if (field(input, "journalSessionFactory") === undefined) return blocked(missing.journalSessionFactory);

  const hermes = record(field(input, "hermesRuntimePorts") ?? {},
    ["startupBase", "deliveryIntegrityKey", "assertCurrentDelivery"]);
  if (field(hermes, "startupBase") === undefined) return blocked(missing.hermesStartupBase);
  if (field(hermes, "deliveryIntegrityKey") === undefined) return blocked(missing.hermesDeliveryIntegrityKey);
  if (field(hermes, "assertCurrentDelivery") === undefined) return blocked(missing.hermesAssertCurrentDelivery);

  const setup = record(field(input, "setupRuntimes") ?? {}, stages) as Partial<PrivateLocalInstallationSetupRuntimesV1>;
  for (const stage of stages) if (!Object.prototype.hasOwnProperty.call(setup, stage) || setup[stage] === undefined)
    return blocked(missing[stage]);
  if (field(input, "journalOperationDeadlineMs") === undefined) return blocked(missing.journalOperationDeadlineMs);

  let loader: PrivateInstalledLocalOperatorLoaderV1;
  try {
    loader = createPrivateInstalledLocalOperatorLoaderV1(Object.freeze({
      schema: PRIVATE_INSTALLED_LOCAL_OPERATOR_LOADER_V1,
      installedConfigurationCustodyInput: field(input, "installedConfigurationCustodyInput"),
      stagedJournalSidecar: field(input, "stagedJournalSidecar"),
      journalCustodyPorts: Object.freeze({ schema: PRIVATE_INSTALLED_JOURNAL_CUSTODY_PORTS_V1,
        createNativeSessionPort: field(input, "journalSessionFactory") }),
      hermesRuntimePorts: Object.freeze({ startupBase: field(hermes, "startupBase"),
        deliveryIntegrityKey: field(hermes, "deliveryIntegrityKey"),
        assertCurrentDelivery: field(hermes, "assertCurrentDelivery"), setupRuntimes: setup }),
      journalOperationDeadlineMs: field(input, "journalOperationDeadlineMs"),
    }));
  } catch { return refused(); }
  const result = Object.freeze({ schema: PRIVATE_INSTALLED_OWNER_HOST_INPUT_COMPOSITION_V1,
    status: "loader_ready" as const, performsEffect: false as const, readsProtectedConfiguration: false as const,
    opensNativeSession: false as const, opensDatabase: false as const, startsService: false as const,
    startsWorker: false as const, invokesHermes: false as const });
  preparedLoaders.set(result, loader);
  return result;
}

/** Burns the opaque record before returning its already-captured one-use
 * loader. A failed or repeated handoff cannot reconstruct owner authority. */
export function consumePrivateInstalledOwnerHostInputCompositionV1(value: unknown):
PrivateInstalledLocalOperatorLoaderV1 {
  if (!value || typeof value !== "object" || types.isProxy(value)) return refused();
  const loader = preparedLoaders.get(value);
  if (!loader || !preparedLoaders.delete(value)) return refused();
  return loader;
}

/**
 * Produces the only value the shipped release entry may register as an
 * owner-host provider. The raw capability graph is captured by the existing
 * reviewed composition first; this provider contains no callback, path,
 * credential, command, or environment selector and is process-local/one-use.
 *
 * A blocked provider is useful rather than exceptional: the release launcher
 * can report the first exact missing boundary without opening protected
 * configuration or starting a native, database, service, worker, or agent
 * effect.
 */
export function createPrivateInstalledOwnerHostProviderV1(value: unknown):
PrivateInstalledOwnerHostProviderV1 {
  const prepared = preflightPrivateInstalledOwnerHostInputCompositionV1(value);
  const provider = Object.freeze({ schema: PRIVATE_INSTALLED_OWNER_HOST_PROVIDER_V1,
    status: prepared.status === "loader_ready" ? "prepared" as const : "blocked" as const,
    ...(prepared.status === "blocked" ? { blocker: prepared.blocker } : {}),
    processLocal: true as const, oneUse: true as const, performsEffect: false as const });
  preparedProviders.set(provider, prepared);
  return provider;
}

/** Burns the provider before releasing its already-prepared opaque input. */
export function consumePrivateInstalledOwnerHostProviderV1(value: unknown):
PrivateInstalledOwnerHostInputPreflightV1 {
  if (!value || typeof value !== "object" || types.isProxy(value)) return refused();
  const prepared = preparedProviders.get(value);
  if (!prepared || !preparedProviders.delete(value)) return refused();
  return prepared;
}
