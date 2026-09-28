import { Pool, type PoolClient } from "pg";
import { boundPrivateDatabase } from "./bounded-database";
import { createPrivatePgDriver } from "./private-pg-driver";
import { privatePgOptions } from "./private-pg-options";
import { qualifyPrivatePgSession } from "./private-pg-qualification";
import type { PrivatePostgresConfiguration } from "./private-postgres";
import type { DatabaseClient } from "../../persistence/database";
import { isHostProxyV1 } from "../../security/host-value";
import { recoveringPrivateDatabase } from "./recovering-private-database";

const privatePgDatabaseClients = new WeakSet<object>();

/** True only for the application client created around this module's real pg Pool. */
export function isPrivatePgDatabaseClientV1(value: unknown): value is DatabaseClient {
  return !!value && typeof value === "object" && !isHostProxyV1(value)
    && privatePgDatabaseClients.has(value) && Object.isFrozen(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** Explicit construction boundary. Pool construction is lazy; no credentials are
 * discovered and no server is contacted by importing this module. */
export function createPrivatePgDatabase(config: PrivatePostgresConfiguration) {
  const options = privatePgOptions(config);
  const database = recoveringPrivateDatabase(reportFault => bindPrivatePgPool(new Pool(options), { reportFault }));
  privatePgDatabaseClients.add(database.client);
  return database;
}

/** Attach lifecycle observers before any checkout can begin. The pool's end
 * promise alone does not acknowledge clients removed by release(true). */
export function bindPrivatePgPool(pool: Pick<Pool, "connect" | "end" | "on">, options: { reportFault?: () => void } = {}) {
  if (options.reportFault !== undefined && typeof options.reportFault !== "function") throw new Error("private_pg_pool_config_invalid");
  const endings = new Set<Promise<void>>();
  pool.on("connect", (client: PoolClient) => {
    let finished!: () => void;
    const ended = new Promise<void>(resolve => { finished = resolve; });
    endings.add(ended);
    client.once("end", () => { endings.delete(ended); finished(); });
    // Keep this observer across checkout/release: pg-pool's idle observer is
    // removed on checkout. Never allow an unhandled checked-out error event.
    client.on("error", () => { reportFault(); });
  });
  const transport = {
    connect: () => pool.connect(),
    async end() {
      await pool.end();
      await Promise.all([...endings]);
    },
  };
  let database!: ReturnType<typeof boundPrivateDatabase>;
  let faulted = false;
  const reportFault = () => {
    if (faulted) return;
    faulted = true;
    void database.close().catch(() => {});
    try { options.reportFault?.(); } catch { /* Fault notification cannot expose or replace the sanitized refusal. */ }
  };
  database = boundPrivateDatabase(createPrivatePgDriver(transport, qualifyPrivatePgSession, { reportTransportFault: reportFault }));
  // Idle-client failures are EventEmitter errors, not rejected query promises.
  // Quarantine the same bounded database rather than crash or silently reconnect.
  pool.on("error", reportFault);
  return database;
}
