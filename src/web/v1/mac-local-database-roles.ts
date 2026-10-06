import { sha256Digest } from "../../security/canonical-digest";
import { validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "./private-postgres";

export const MAC_LOCAL_DATABASE_ROLES_V1 = "control-room.mac-local-database-roles/v1" as const;

/**
 * The restricted PostgreSQL connections used by one Mac installation. Every
 * entry must identify the same one authority database; only the login role
 * differs. This is configuration data only and never opens a connection.
 */
export type MacLocalDatabaseRolesV1 = Readonly<{
  schema: typeof MAC_LOCAL_DATABASE_ROLES_V1;
  web: PrivatePostgresConfiguration;
  coordinator: PrivatePostgresConfiguration;
  results: PrivatePostgresConfiguration;
  publisher: PrivatePostgresConfiguration;
  agentReviewer: PrivatePostgresConfiguration;
  queueWorker: PrivatePostgresConfiguration;
  fleetGateway?: PrivatePostgresConfiguration;
  fleetOwner?: PrivatePostgresConfiguration;
}>;

const invalid = (): never => { throw new Error("mac_local_database_roles_invalid"); };

function endpointDigest(configuration: PrivatePostgresConfiguration) {
  return sha256Digest({ host: configuration.host, port: configuration.port, database: configuration.database,
    majorVersion: configuration.majorVersion, privateEndpoint: configuration.privateEndpoint ?? null });
}

/** Validates the one-database/multiple-restricted-roles invariant before any
 * caller can open a pool. Passwords are retained only in the returned local
 * configuration; they are never digested or rendered. */
export function captureMacLocalDatabaseRolesV1(value: unknown,
  context: Readonly<{ installRoot?: string }> = {}): MacLocalDatabaseRolesV1 {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
      return invalid();
    const input = value as Record<string, unknown>;
    const requiredNames = ["schema", "web", "coordinator", "results", "publisher", "agentReviewer", "queueWorker"];
    const names = [...requiredNames, "fleetGateway", "fleetOwner"];
    if (requiredNames.some(name => !(name in input)) || Object.keys(input).some(name => !names.includes(name))
      || input.schema !== MAC_LOCAL_DATABASE_ROLES_V1
      || (Object.hasOwn(input, "fleetGateway") !== Object.hasOwn(input, "fleetOwner"))
      || (Object.hasOwn(input, "fleetGateway") && (input.fleetGateway === undefined || input.fleetOwner === undefined)))
      return invalid();
    const web = validatePrivatePostgresConfiguration(input.web as PrivatePostgresConfiguration, context);
    const coordinator = validatePrivatePostgresConfiguration(input.coordinator as PrivatePostgresConfiguration, context);
    const results = validatePrivatePostgresConfiguration(input.results as PrivatePostgresConfiguration, context);
    const publisher = validatePrivatePostgresConfiguration(input.publisher as PrivatePostgresConfiguration, context);
    const agentReviewer = validatePrivatePostgresConfiguration(input.agentReviewer as PrivatePostgresConfiguration, context);
    const queueWorker = validatePrivatePostgresConfiguration(input.queueWorker as PrivatePostgresConfiguration, context);
    const fleetGateway = input.fleetGateway === undefined ? undefined
      : validatePrivatePostgresConfiguration(input.fleetGateway as PrivatePostgresConfiguration, context);
    const fleetOwner = input.fleetOwner === undefined ? undefined
      : validatePrivatePostgresConfiguration(input.fleetOwner as PrivatePostgresConfiguration, context);
    const configurations = [web, coordinator, results, publisher, agentReviewer, queueWorker,
      ...(fleetGateway && fleetOwner ? [fleetGateway, fleetOwner] : [])];
    if (new Set(configurations.map(endpointDigest)).size !== 1
      || new Set(configurations.map(configuration => configuration.username)).size !== configurations.length)
      return invalid();
    return Object.freeze({ schema: MAC_LOCAL_DATABASE_ROLES_V1, web, coordinator, results, publisher, agentReviewer,
      queueWorker, ...(fleetGateway && fleetOwner ? { fleetGateway, fleetOwner } : {}) });
  } catch { return invalid(); }
}
