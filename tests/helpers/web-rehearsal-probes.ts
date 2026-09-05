import { RehearsalProbeError } from "../../src/web/v1/private-rehearsal-probe";
import type { RehearsalCheck } from "../../src/web/v1/private-rehearsal-checks";
import type { DatabaseSession } from "../../src/persistence/database";

/** Deterministic driver recording, not PostgreSQL concurrency/timing evidence. */
export function recordedProbeFixture() {
  let now = 0, locks = 0, txSleeps = 0, idleWait = 0, aClosed = false, bClosed = false;
  let releaseLock: (() => void) | undefined;
  const statements: string[] = [], observed: RehearsalCheck[] = [];
  const make = (slot: "a" | "b") => ({
    isClosed: () => slot === "a" ? aClosed : bClosed,
    close: async () => { if (slot === "a") aClosed = true; else bClosed = true; },
    query: (async (sql: string) => {
      statements.push(`${slot}:${sql}`);
      if (sql.includes("pg_backend_pid")) return { rows: [{ pid: slot === "a" ? 101 : 102 }] };
      if (sql.includes("AS valid")) return { rows: [{ valid: true }] };
      if (sql.startsWith("UPDATE")) throw new RehearsalProbeError("42501");
      if (sql.includes("FOR UPDATE")) {
        if (slot === "a") return { rows: [{ id: "synthetic" }] };
        if (++locks === 1) { await new Promise<void>(resolve => { releaseLock = resolve; }); return { rows: [{ id: "synthetic" }] }; }
        now += 2000; throw new RehearsalProbeError("55P03");
      }
      if (slot === "a" && sql === "ROLLBACK") { releaseLock?.(); releaseLock = undefined; }
      if (sql === "SELECT pg_sleep(6)") { now += 5000; throw new RehearsalProbeError("57014"); }
      if (sql === "SELECT pg_sleep(4)") {
        now += ++txSleeps === 3 ? 2000 : 4000;
        if (txSleeps === 3) throw new RehearsalProbeError("25P04");
      }
      return { rows: [] };
    }) as DatabaseSession["query"],
  });
  return { a: make("a"), b: make("b"), statements, observed,
    observer: { query: (async (sql: string) => ({ rows: sql.includes("AS absent") ? [{ absent: bClosed }]
      : sql.includes("AS idle") ? [{ idle: !bClosed }] : [{ blocked: !!releaseLock }] })) as DatabaseSession["query"] },
    timing: { now: () => now, sleep: async (ms: number) => { now += ms;
      if (ms === 4500 || ms === 1000) idleWait += ms;
      if (idleWait >= 5500) bClosed = true;
    } },
  };
}
