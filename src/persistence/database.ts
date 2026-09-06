import type { PGlite as PGliteType } from "@electric-sql/pglite";
import postgres from "postgres";
import { dataMethodV1, isHostProxyV1 } from "../security/host-value";
import { createExactPgliteReceiverV1 } from "./pglite-provenance";

export interface QueryResult<T> {
  rows: T[];
}

export interface DatabaseSession {
  query<T = Record<string, unknown>>(statement: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface DatabaseClient extends DatabaseSession {
  transaction<T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T>;
  /** Runs the check inside the transaction and awaits it before COMMIT. Wrappers
   * must return/await the check too; rejection must prevent commit. Production
   * callers use the bounded driver to retain a whole-transaction deadline. */
  transactionWithPreCommitCheck<T>(callback: (session: DatabaseSession) => Promise<T>,
    preCommitCheck: () => void | Promise<void>): Promise<T>;
}

const repositorySimulationDatabaseClients = new WeakSet<object>();
const bindFunction = Function.call.bind(Function.bind) as
  <T extends (...args: never[]) => unknown>(fn: T, receiver: unknown) => T;

/** True only for the frozen client created around a module-private PGlite instance. */
export function isRepositorySimulationDatabaseClientV1(value: unknown): value is DatabaseClient {
  return !!value && typeof value === "object" && !isHostProxyV1(value)
    && repositorySimulationDatabaseClients.has(value) && Object.isFrozen(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export interface RepositorySimulationDatabaseV1 {
  client: DatabaseClient;
  exec(statement: string): Promise<void>;
  query<T = Record<string, unknown>>(statement: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
}

/**
 * Creates the effect-free AUTO-040 repository database. The PGlite receiver is
 * never returned, and every exposed operation closes over that private receiver
 * with a fixed implementation. This is deliberately separate from the generic
 * PGlite and networked PostgreSQL adapters below.
 */
export async function createRepositorySimulationDatabaseV1(options: { testOnly: true }):
  Promise<RepositorySimulationDatabaseV1> {
  if (options.testOnly !== true) throw new Error("repository simulation database is test-only");
  const packageName = ["@electric-sql", "pglite"].join("/");
  const { PGlite } = await import(/* @vite-ignore */ packageName) as { PGlite: typeof PGliteType };
  const exact = createExactPgliteReceiverV1(PGlite);
  const db = exact.receiver;
  const query = bindFunction(exact.query, db) as typeof db.query;
  const transaction = bindFunction(exact.transaction, db) as typeof db.transaction;
  const exec = bindFunction(exact.exec, db) as typeof db.exec;
  const close = bindFunction(exact.close, db) as typeof db.close;
  const session = (tx: { query<U>(statement: string, params?: unknown[]): Promise<{ rows: U[] }> }): DatabaseSession => {
    const method = dataMethodV1(tx, "query");
    if (!method) throw new Error("repository simulation transaction implementation drift");
    const txQuery = bindFunction(method, tx) as typeof tx.query;
    return Object.freeze({
      query: <U = Record<string, unknown>>(statement: string, params: unknown[] = []) => txQuery<U>(statement, params),
    });
  };
  const client: DatabaseClient = Object.freeze({
    query<T = Record<string, unknown>>(statement: string, params: unknown[] = []) {
      return query<T>(statement, params);
    },
    transaction<T>(callback: (databaseSession: DatabaseSession) => Promise<T>): Promise<T> {
      return transaction<T>((tx) => callback(session(tx)));
    },
    transactionWithPreCommitCheck<T>(callback: (databaseSession: DatabaseSession) => Promise<T>,
      preCommitCheck: () => void | Promise<void>): Promise<T> {
      return transaction<T>(async (tx) => {
        const result = await callback(session(tx)); await preCommitCheck(); return result;
      });
    },
  });
  repositorySimulationDatabaseClients.add(client);
  return Object.freeze({
    client,
    exec: async (statement: string) => { await exec(statement); },
    query: <T = Record<string, unknown>>(statement: string, params: unknown[] = []) => query<T>(statement, params),
    close: async () => { await close(); },
  });
}

export function createPostgresClient(connectionString: string): {
  client: DatabaseClient;
  close: () => Promise<void>;
} {
  const sql = postgres(connectionString, {
    max: 8,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: true,
  });

  const adapt = (session: typeof sql): DatabaseSession => ({
    async query<T>(statement: string, params: unknown[] = []) {
      const rows = await session.unsafe(statement, params as never[]);
      return { rows: rows as unknown as T[] };
    },
  });

  return {
    client: {
      ...adapt(sql),
      transaction<T>(callback: (session: DatabaseSession) => Promise<T>) {
        return sql.begin((transaction) => callback(adapt(transaction as typeof sql))) as Promise<T>;
      },
      transactionWithPreCommitCheck<T>(callback: (session: DatabaseSession) => Promise<T>, preCommitCheck: () => void | Promise<void>) {
        return sql.begin(async (transaction) => {
          const result = await callback(adapt(transaction as typeof sql));
          await preCommitCheck();
          return result;
        }) as Promise<T>;
      },
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

export function adaptPglite(db: {
  query<T>(statement: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(callback: (tx: { query<U>(statement: string, params?: unknown[]): Promise<{ rows: U[] }> }) => Promise<T>): Promise<T>;
}): DatabaseClient {
  const query = db.query.bind(db) as typeof db.query;
  const transaction = db.transaction.bind(db) as typeof db.transaction;
  const client: DatabaseClient = {
    query<T = Record<string, unknown>>(statement: string, params: unknown[] = []) { return query<T>(statement, params); },
    transaction<T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T> {
      return transaction<T>((tx) => callback(Object.freeze({
        query: <U = Record<string, unknown>>(statement: string, params: unknown[] = []) => tx.query<U>(statement, params),
      })));
    },
    transactionWithPreCommitCheck<T>(callback: (session: DatabaseSession) => Promise<T>, preCommitCheck: () => void | Promise<void>): Promise<T> {
      return transaction<T>(async (tx) => {
      const result = await callback(Object.freeze({
        query: <U = Record<string, unknown>>(statement: string, params: unknown[] = []) => tx.query<U>(statement, params),
      }));
      await preCommitCheck();
      return result;
      });
    },
  };
  return Object.freeze(client);
}
