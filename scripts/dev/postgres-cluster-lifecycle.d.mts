// Type declarations for the shared disposable-PostgreSQL lifecycle module.
//
// The implementation is `.mjs` because `scripts/ops/verify-database-backup.mjs`
// imports it with bare `node` and no TypeScript loader, and a `.ts` module could
// not be imported by one of its own callers. This declaration is what lets the
// TypeScript lanes — `tests/support/attack-kit/real-postgres.ts` and the `tsx`
// test files — import it under `strict`, without widening the types to `any` and
// without a hand-maintained copy that could drift from the implementation.

/** A cooperative `pg_ctl` stop, or a signal sent to the postmaster. */
export type ShutdownAction = "cooperative" | "signal";

export interface ShutdownStep {
  /** A cooperative `pg_ctl` stop, or a signal sent to the postmaster. */
  readonly action: ShutdownAction;
  /** `fast` or `immediate`, for a cooperative step. */
  readonly mode?: "fast" | "immediate";
  /** The signal, for a signal step. */
  readonly signal?: "SIGQUIT" | "SIGKILL";
  /** True when the postmaster was gone after this step. */
  readonly stopped: boolean;
  /** The cooperative attempt failed, or the wait expired. */
  readonly failed: boolean;
  /** The first line of the error a step raised, when it raised one. */
  readonly error?: string;
}

export interface ShutdownLadderOptions {
  /** Is the postmaster still running? Asked before every step. */
  readonly alive: () => boolean;
  /** Run one cooperative `pg_ctl` stop. A refusal is recorded, not thrown. */
  readonly cooperativeStop: (mode: "fast" | "immediate") => Promise<void>;
  /** Send a signal to the postmaster. Errors are the caller's to absorb. */
  readonly signal: (signal: "SIGQUIT" | "SIGKILL") => void;
  /** Wait up to this long for the postmaster to exit after a signal. */
  readonly graceMs?: number;
  /** Poll interval while waiting. */
  readonly tickMs?: number;
  /** Sleep, injected so a test does not spend real time waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ShutdownLadderResult {
  /** Every step attempted, in order. The order is the contract. */
  readonly steps: readonly ShutdownStep[];
  /** True when the postmaster is gone. */
  readonly stopped: boolean;
  /**
   * True when `SIGKILL` was needed, which is the one path that leaks a SysV
   * shared-memory segment. A caller reports this as a failure.
   */
  readonly forced: boolean;
}

/** Every shutdown step, in the order that releases shared memory. */
export declare const SHUTDOWN_LADDER_ORDER: readonly string[];

/** True when a pid exists. EPERM means it exists and belongs to another user. */
export declare function pidAlive(pid: number | undefined): boolean;

/** The postmaster pid a data directory currently records, if any. */
export declare function readPostmasterPid(dataDirectory: string): Promise<number | undefined>;

/**
 * Stop a postmaster, in the order that releases its shared memory:
 * `cooperative fast` -> `cooperative immediate` -> `SIGQUIT` -> `SIGKILL`.
 */
export declare function shutdownLadder(options: ShutdownLadderOptions): Promise<ShutdownLadderResult>;

export interface ClusterTeardownOptions {
  /** The `-D` the postmaster was started with. Where `postmaster.pid` lives. */
  readonly dataDirectory: string;
  /** The run directory holding the data directory. Removed by `stop()`. */
  readonly runDirectory: string;
  /** A socket directory outside the run directory, when there is one. */
  readonly socketDirectory?: string | undefined;
  /** The port this cluster was given. Named in every failure message. */
  readonly port: number;
  /** The PostgreSQL bin directory. Undefined means `pg_ctl` on PATH. */
  readonly pgBin?: string | undefined;
  /** Remove the directories on a successful stop. Default true. */
  readonly removeDirectories?: boolean | undefined;
  /**
   * Replace the `pg_ctl` invocation, for a test that must reach a branch a
   * healthy postmaster cannot produce. It receives the argv and throws exactly
   * as a refusing `pg_ctl` does. The ladder, the liveness checks, the directory
   * removal and the error shapes all still run.
   */
  readonly pgCtl?: ((args: readonly string[]) => void) | undefined;
  /**
   * How long the ladder waits for the postmaster to exit after a signal, in ms.
   * Default 30 s. Overridable so a test that drives a deliberately wedged
   * process is not made to wait 30 s per step.
   */
  readonly graceMs?: number | undefined;
  /** Poll interval while waiting for an exit after a signal. Default 100 ms. */
  readonly tickMs?: number | undefined;
}

export interface ClusterTeardown {
  /** The recorded postmaster pid, once one has been published. */
  postmasterPid(): number | undefined;
  /**
   * Read the postmaster pid and remember it. A start site calls this the moment
   * `pg_ctl start` returns, so the teardown has a pid even when the caller's own
   * bookkeeping is about to throw. Retried once, because a cluster that is up
   * but whose `postmaster.pid` is not yet visible is exactly the case a leak
   * needs.
   */
  capturePostmasterPid(): Promise<number | undefined>;
  /**
   * Disarm the process-level hooks without stopping the cluster. For a caller
   * that deliberately hands a live cluster to someone else.
   */
  release(): void;
  /** The teardown for the ordinary path. Idempotent, and safe in a `finally`. */
  stop(): Promise<void>;
}

/**
 * The teardown every disposable-cluster start site shares, with its process-level
 * hooks armed before `initdb` runs.
 */
export declare function createClusterTeardown(options: ClusterTeardownOptions): ClusterTeardown;
