import { createPrivatePgDatabase } from "./private-pg-database";

export interface PrivatePostgresConfiguration {
  /** First supported topology: app and private primary on the same VPS, TCP loopback only. */
  host: "127.0.0.1"; port: number; database: string; username: string; password: string;
  majorVersion: 17;
}
export function validatePrivatePostgresConfiguration(input: PrivatePostgresConfiguration) {
  if (input.host !== "127.0.0.1" || input.majorVersion !== 17 || !Number.isInteger(input.port)
    || input.port < 1 || input.port > 65535 || !/^[a-z][a-z0-9_]{0,62}$/.test(input.database)
    || !/^[a-z][a-z0-9_]{0,62}$/.test(input.username) || input.username === "control_room_private_web"
    || typeof input.password !== "string" || input.password.length < 1 || input.password.length > 4096 || input.password.includes("\0"))
    throw new Error("invalid_private_database_config");
  return Object.freeze({ host: input.host, port: input.port, database: input.database,
    username: input.username, password: input.password, majorVersion: input.majorVersion });
}

/** Pure explicit options. No URL query, DNS/multi-host, PG* credential or OS-user fallback. */
export function privatePostgresOptions(input: PrivatePostgresConfiguration) {
  const config = validatePrivatePostgresConfiguration(input);
  return { host: config.host, port: config.port, database: config.database, username: config.username,
    password: config.password, ssl: false as const, max: 8, connect_timeout: 5, idle_timeout: 20,
    max_lifetime: 1800, max_pipeline: 1, backoff: false as const, keep_alive: 60, prepare: false, debug: false as const,
    fetch_types: false, publications: "alltables", target_session_attrs: "primary" as const,
    onnotice: () => {}, connection: { application_name: "control-room-private-web", search_path: "pg_catalog, public",
      statement_timeout: 5000, lock_timeout: 2000, transaction_timeout: 10000,
      idle_in_transaction_session_timeout: 5000, timezone: "UTC" } };
}

/** Explicit effect boundary. Merely importing this module creates no client or connection.
 * The factory seam is trusted server composition/test code, never request input.
 */
export function createPrivatePostgresDatabase(config: PrivatePostgresConfiguration) {
  return createPrivatePgDatabase(config);
}
