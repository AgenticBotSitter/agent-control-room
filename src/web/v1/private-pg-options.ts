import { validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "./private-postgres";

/** Explicit startup parameters for the selected pg transport. No URL parsing or
 * ambient credential selection. Primary/version qualification remains mandatory
 * before an acquired session is exposed to callers. */
export function privatePgOptions(input: PrivatePostgresConfiguration) {
  const config = validatePrivatePostgresConfiguration(input);
  return Object.freeze({
    host: config.host, port: config.port, database: config.database,
    user: config.username, password: config.password,
    ssl: false, sslnegotiation: "postgres", client_encoding: "UTF8",
    // A nonempty string overrides PGREPLICATION; PostgreSQL accepts 'false'.
    replication: "false",
    application_name: "control-room-private-web",
    options: "-c search_path=pg_catalog,\\ public -c timezone=UTC -c transaction_timeout=10000",
    statement_timeout: 5000, lock_timeout: 2000,
    idle_in_transaction_session_timeout: 5000,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 20000,
    max: 8, maxLifetimeSeconds: 1800,
    keepAlive: true, keepAliveInitialDelayMillis: 60000,
  });
}
