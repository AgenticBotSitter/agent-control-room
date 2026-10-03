import { PrivateDatabaseError, type PrivateDatabaseDriver } from "./bounded-database";
import { databaseSqlStateV1 } from "../../persistence/database";

function definiteSqlState(error: unknown): string | undefined {
  const code = databaseSqlStateV1(error);
  if (!code) return undefined;
  // Connection loss (08), operator/crash shutdown (57P), resource exhaustion
  // (53), internal errors (XX) and statement_completion_unknown (40003) do not
  // prove what the server did; they stay uncertain and quarantine the pool.
  return /^(08|57P|53|XX)/u.test(code) || code === "40003" ? undefined : code;
}

/** Trusted node-postgres pool surface. Construction and credentials belong to
 * server composition; importing this adapter performs no connection attempt. */
export interface PrivatePgPool {
  connect(): Promise<{
    query(statement: string, params: unknown[]): Promise<{ rows: unknown[] }>;
    release(destroy?: boolean): void;
  }>;
  end(): Promise<void>;
}

export function createPrivatePgDriver(pool: PrivatePgPool,
  qualify: (client: Awaited<ReturnType<PrivatePgPool["connect"]>>) => Promise<void> = async () => {}): PrivateDatabaseDriver {
  let stopped = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const releases = new Set<() => void>();
  return {
    async acquire() {
      if (stopped) throw new PrivateDatabaseError("database_unavailable");
      const acquisition = Promise.resolve().then(() => {
        if (stopped) throw new PrivateDatabaseError("database_unavailable");
        return pool.connect();
      }).then(async client => {
        let released = false;
        let rejected = false;
        const release = () => {
          if (released) return;
          released = true;
          releases.delete(release);
          client.release(stopped || rejected);
        };
        releases.add(release);
        if (stopped) {
          release();
          throw new PrivateDatabaseError("database_unavailable");
        }
        try {
          await qualify(client);
          if (stopped || released) throw new PrivateDatabaseError("database_unavailable");
        } catch {
          rejected = true; release();
          throw new PrivateDatabaseError("database_unavailable");
        }
        return {
          async query<T>(statement: string, params: unknown[] = []) {
            if (stopped || released) throw new PrivateDatabaseError("database_unavailable");
            try {
              const result = await client.query(statement, params);
              if (stopped || released) throw new PrivateDatabaseError("database_outcome_uncertain");
              return { rows: result.rows as T[] };
            } catch (error) {
              const sqlState = definiteSqlState(error);
              if (sqlState) throw new PrivateDatabaseError("database_unavailable", sqlState);
              throw new PrivateDatabaseError("database_outcome_uncertain");
            }
          },
          release,
        };
      });
      pending.add(acquisition);
      try { return await acquisition; }
      catch { throw new PrivateDatabaseError("database_unavailable"); }
      finally { pending.delete(acquisition); }
    },
    terminate() {
      if (closing) return closing;
      stopped = true;
      closing = (async () => {
        // Destroy active leases before ending the pool. Late acquisitions are
        // destroyed by the branch above, never admitted to application code.
        const failures: unknown[] = [];
        for (const release of [...releases]) {
          try { release(); } catch (error) { failures.push(error); }
        }
        // Start pool shutdown even if an acquisition has not settled. The outer
        // bounded wrapper reports close uncertainty if either operation hangs.
        const ending = Promise.resolve().then(() => pool.end());
        const outcomes = await Promise.allSettled([ending, ...pending]);
        if (failures.length || outcomes[0]?.status === "rejected")
          throw new PrivateDatabaseError("database_close_uncertain");
      })();
      return closing;
    },
  };
}
