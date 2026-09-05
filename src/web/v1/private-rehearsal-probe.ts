import postgres from "postgres";
import { privatePostgresOptions, type PrivatePostgresConfiguration } from "./private-postgres";
import type { DatabaseSession } from "../../persistence/database";

export class RehearsalProbeError extends Error {
  constructor(readonly code: "42501" | "55P03" | "57014" | "25P04" | "probe_uncertain") {
    super(code); this.name = "RehearsalProbeError";
  }
}
export interface RehearsalProbe extends DatabaseSession {
  /** Becomes true on the original connection's close; never reserves a replacement. */
  isClosed(): boolean;
  close(): Promise<void>;
}
export function rehearsalProbeOptions(config: PrivatePostgresConfiguration, slot: "a" | "b", onclose: () => void) {
  if (slot !== "a" && slot !== "b") throw new Error("invalid_probe_slot");
  const options = privatePostgresOptions(config);
  return { ...options, max: 1, idle_timeout: 0, max_lifetime: 0, onclose,
    connection: { ...options.connection, application_name: `control-room-rehearsal-probe-${slot}` } };
}
export type RehearsalProbeSqlFactory = (options: ReturnType<typeof rehearsalProbeOptions>) => {
  reserve(): Promise<{ unsafe(statement: string, params: never[], options: { prepare: boolean; simple: boolean }): PromiseLike<readonly unknown[]> }>;
  end(options: { timeout: number }): Promise<void>;
};

/** Operator-only, explicitly invoked connection effect. No environment, logging or import-time I/O.
 * One reserved connection, one statement at a time, no replacement after close/error uncertainty.
 * Unlike the application pool, this probe can observe four expected PostgreSQL SQLSTATEs.
 * The fixed workload must decide which one is expected; none is an application write retry signal.
 */
export function createRehearsalProbe(config: PrivatePostgresConfiguration, slot: "a" | "b",
  createSql: RehearsalProbeSqlFactory = options => postgres(options)): RehearsalProbe {
  let closed = false, stopped = false, active = false;
  let closing: Promise<void> | undefined;
  let reserved: ReturnType<ReturnType<RehearsalProbeSqlFactory>["reserve"]> | undefined;
  const sql = createSql(rehearsalProbeOptions(config, slot, () => { closed = true; }));
  const close = () => {
    stopped = true;
    return closing ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([sql.end({ timeout: 0 }), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RehearsalProbeError("probe_uncertain")), 5000);
        })]);
        closed = true;
      } catch { throw new RehearsalProbeError("probe_uncertain"); }
      finally { clearTimeout(timer); }
    })();
  };
  return Object.freeze({ isClosed: () => closed, close,
    async query<T>(statement: string, params: unknown[] = []) {
      if (stopped || closed || active) throw new RehearsalProbeError("probe_uncertain");
      active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const operation = (async () => {
          // Reserve once only. A late acquisition after close must never issue SQL.
          const lease = await (reserved ??= sql.reserve());
          if (stopped || closed) throw new RehearsalProbeError("probe_uncertain");
          const rows = await lease.unsafe(statement, params as never[], { prepare: false, simple: false });
          if (stopped) throw new RehearsalProbeError("probe_uncertain");
          return { rows: rows as unknown as T[] };
        })();
        return await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RehearsalProbeError("probe_uncertain")), 12_000);
        })]);
      } catch (error) {
        // Never retain a driver message/detail/query/parameters/connection locator.
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (["42501", "55P03", "57014", "25P04"].includes(code as string)) {
          if (code === "25P04") stopped = true;
          throw new RehearsalProbeError(code as "42501" | "55P03" | "57014" | "25P04");
        }
        stopped = true;
        try { await close(); } catch { /* fixed uncertainty below, no retry */ }
        throw new RehearsalProbeError("probe_uncertain");
      } finally { clearTimeout(timer); active = false; }
    },
  });
}
