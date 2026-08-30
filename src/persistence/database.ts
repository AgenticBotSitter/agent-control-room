import postgres from "postgres";

export interface QueryResult<T> {
  rows: T[];
}

export interface DatabaseSession {
  query<T = Record<string, unknown>>(statement: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface DatabaseClient extends DatabaseSession {
  transaction<T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T>;
  transactionWithPreCommitCheck<T>(callback: (session: DatabaseSession) => Promise<T>,
    preCommitCheck: () => void): Promise<T>;
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
      transactionWithPreCommitCheck<T>(callback: (session: DatabaseSession) => Promise<T>, preCommitCheck: () => void) {
        return sql.begin(async (transaction) => {
          const result = await callback(adapt(transaction as typeof sql));
          preCommitCheck();
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
    transactionWithPreCommitCheck<T>(callback: (session: DatabaseSession) => Promise<T>, preCommitCheck: () => void): Promise<T> {
      return transaction<T>(async (tx) => {
      const result = await callback(Object.freeze({
        query: <U = Record<string, unknown>>(statement: string, params: unknown[] = []) => tx.query<U>(statement, params),
      }));
      preCommitCheck();
      return result;
      });
    },
  };
  return Object.freeze(client);
}
