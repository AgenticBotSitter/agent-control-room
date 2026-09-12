import { Pool, type PoolClient } from "pg";
import { boundPrivateDatabase } from "./bounded-database";
import { createPrivatePgDriver } from "./private-pg-driver";
import { privatePgOptions } from "./private-pg-options";
import { qualifyPrivatePgSession } from "./private-pg-qualification";
import type { PrivatePostgresConfiguration } from "./private-postgres";

/** Explicit construction boundary. Pool construction is lazy; no credentials are
 * discovered and no server is contacted by importing this module. */
export function createPrivatePgDatabase(config: PrivatePostgresConfiguration) {
  const pool = new Pool(privatePgOptions(config));
  return bindPrivatePgPool(pool);
}

/** Attach lifecycle observers before any checkout can begin. The pool's end
 * promise alone does not acknowledge clients removed by release(true). */
export function bindPrivatePgPool(pool: Pick<Pool, "connect" | "end" | "on">) {
  const endings = new Set<Promise<void>>();
  pool.on("connect", (client: PoolClient) => {
    let finished!: () => void;
    const ended = new Promise<void>(resolve => { finished = resolve; });
    endings.add(ended);
    client.once("end", () => { endings.delete(ended); finished(); });
    // Keep this observer across checkout/release: pg-pool's idle observer is
    // removed on checkout. Never allow an unhandled checked-out error event.
    client.on("error", () => { void database.close().catch(() => {}); });
  });
  const transport = {
    connect: () => pool.connect(),
    async end() {
      await pool.end();
      await Promise.all([...endings]);
    },
  };
  const database = boundPrivateDatabase(createPrivatePgDriver(transport, qualifyPrivatePgSession));
  // Idle-client failures are EventEmitter errors, not rejected query promises.
  // Quarantine the same bounded database rather than crash or silently reconnect.
  pool.on("error", () => { void database.close().catch(() => {}); });
  return database;
}
