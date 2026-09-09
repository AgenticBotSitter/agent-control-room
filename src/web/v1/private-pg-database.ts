import { Pool } from "pg";
import { boundPrivateDatabase } from "./bounded-database";
import { createPrivatePgDriver } from "./private-pg-driver";
import { privatePgOptions } from "./private-pg-options";
import { qualifyPrivatePgSession } from "./private-pg-qualification";
import type { PrivatePostgresConfiguration } from "./private-postgres";

/** Explicit construction boundary. Pool construction is lazy; no credentials are
 * discovered and no server is contacted by importing this module. */
export function createPrivatePgDatabase(config: PrivatePostgresConfiguration) {
  const pool = new Pool(privatePgOptions(config));
  const database = boundPrivateDatabase(createPrivatePgDriver(pool, qualifyPrivatePgSession));
  // Idle-client failures are EventEmitter errors, not rejected query promises.
  // Quarantine the same bounded database rather than crash or silently reconnect.
  pool.on("error", () => { void database.close().catch(() => {}); });
  return database;
}
