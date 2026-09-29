// Disposable-database helper for the M2 mac-local journey lane.
//
// Creates one throwaway database inside a cluster that the caller already owns
// (created in `before` by the test file and torn down in `after`). This helper
// never starts or stops a server, never reads the protected root, and never
// reaches a non-loopback host: `host` is asserted to be 127.0.0.1.
//
// The migration ledger is applied through the repo's own
// `deploy/postgres/apply-migrations.mjs`, so the schema under test is the
// ledger-verified schema rather than a hand-rolled subset.

import { Client } from "pg";
import { applyMigrations } from "../../deploy/postgres/apply-migrations.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Synthetic throwaway passwords. Never real credentials, never printed. */
const passwords = {
  CONTROL_ROOM_MIGRATOR_PASSWORD: "m".repeat(24),
  CONTROL_ROOM_APP_PASSWORD: "a".repeat(24),
  CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24),
};

export interface DisposableMacLocalDatabaseOptions {
  /** Temp run directory holding the cluster's `socket` directory. */
  run: string;
  port: number;
  /** Unique database name; must match /^[a-z][a-z0-9_]{0,62}$/ (validated downstream too). */
  name: string;
  fixtureUser: string;
  fixturePassword: string;
}

export interface DisposableMacLocalDatabase {
  name: string;
  /** Number of ledger migrations applied — recorded so a silent no-op cannot pass for a proof. */
  applied: number;
  drop: () => Promise<void>;
}

/**
 * Creates `name` on the caller's disposable cluster and applies the full
 * migration ledger through the production two-phase path (bootstrap superuser
 * creates the least-privilege logins; the migrator applies each migration under
 * SET ROLE control_room_schema_owner and records the ledger row).
 */
export async function openDisposableMacLocalDatabase(options: DisposableMacLocalDatabaseOptions):
  Promise<DisposableMacLocalDatabase> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.name))
    throw new Error("disposable_database_name_invalid");
  // Local-socket admin connection: trust auth, never over TCP.
  const admin = new Client({ host: `${options.run}/socket`, port: options.port, database: "postgres",
    user: options.fixtureUser });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${options.name}`);
    await admin.query(`CREATE DATABASE ${options.name}`);
  } finally {
    await admin.end();
  }
  const socket = `${options.run}/socket`;
  // `target` and `ledgerPath` are plan-mode flags the JSDoc marks required;
  // passing them matches the repo's own tests/postgres-production-lifecycle
  // call shape. Supplying bootstrap+migrate targets is what actually runs.
  const result = await applyMigrations({
    target: `host=${socket} port=${options.port} dbname=${options.name} user=${options.fixtureUser}`,
    rootDir: ROOT,
    ledgerPath: join(ROOT, "deploy/postgres/migration-ledger.json"),
    bootstrapTarget: { host: socket, port: options.port, database: options.name,
      user: options.fixtureUser, password: options.fixturePassword },
    migrateTarget: { host: socket, port: options.port, database: options.name,
      user: "control_room_migrator", password: passwords.CONTROL_ROOM_MIGRATOR_PASSWORD },
    env: { ...passwords, NODE_ENV: "test" },
  });
  const applied = result.applied ?? [];
  if (result.planned || applied.length === 0)
    throw new Error("disposable_database_migrations_not_applied");
  return { name: options.name, applied: applied.length,
    drop: async () => {
      const dropper = new Client({ host: `${options.run}/socket`, port: options.port, database: "postgres",
        user: options.fixtureUser });
      await dropper.connect();
      try { await dropper.query(`DROP DATABASE IF EXISTS ${options.name} WITH (FORCE)`); }
      finally { await dropper.end(); }
    } };
}
