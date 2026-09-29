// Guard-bites mutation helper.
//
// The claim "this guard is covered" is only evidence if disabling the guard
// makes a test fail. This helper performs that experiment mechanically: it
// mutates a source file, runs the named test command, requires the command to
// FAIL, and restores the file — including when the command crashes, hangs past
// its bound, or the caller throws.
//
// It refuses to run on a dirty tree. A mutation applied on top of unrelated
// uncommitted work cannot be restored, and a silently swallowed restore would
// leave the mutation in someone's working tree.

import { spawn } from "node:child_process";
import { shutdownLadder } from "./real-postgres.ts";
import { readFile, writeFile, stat, mkdir, mkdtemp, readdir, rm, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** Grace period between SIGTERM and SIGKILL when a group is torn down. */
const KILL_GRACE_MS = 2_000;

/** Upper bound on captured child output, so a chatty command cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 1 << 26;

/** Bound for a bookkeeping command such as `git status`. */
const BOOKKEEPING_BOUND_MS = 30_000;

export class MutationTimeoutError extends Error {
  constructor(readonly boundMs: number) {
    super(`mutation_test_command_timed_out_after_${boundMs}ms`);
    this.name = "MutationTimeoutError";
  }
}

interface RunOutcome {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A spawned command in its own process group, with a teardown that can be
 * awaited.
 *
 * `detached: true` puts the child in a NEW process group, which is the whole
 * point. Signalling the child's own pid kills only the child: a grandchild it
 * spawned survives, keeps burning CPU, and outlives the test that made it. On
 * 2026-09-28 an orphaned CPU-burner from an earlier job ran for over half an
 * hour after its harness had already reported the bound. Killing the group
 * reaches every descendant.
 */
interface GroupRun {
  /** Resolves on a clean exit; rejects with `{ code, signal, stdout, stderr, killed }`. */
  readonly result: Promise<RunOutcome>;
  /** Resolves once the child process itself has exited. */
  readonly exited: Promise<void>;
  /**
   * Terminate the whole process group and resolve only after the exit is
   * confirmed. Idempotent, and still correct after the child has exited: the
   * group signal reaches anything the child left behind.
   */
  kill(): Promise<void>;
  readonly pid: number | undefined;
}

const signalGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
  // A negative pid addresses the process GROUP led by `pid`. ESRCH means the
  // group is already gone, which is the outcome we want.
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already reaped, or the child never became a group leader.
  }
};

const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

function spawnGroup(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number },
): GroupRun {
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let captured = 0;
  const collect = (chunk: Buffer, target: "out" | "err") => {
    if (captured >= options.maxBuffer) return;
    captured += chunk.length;
    if (target === "out") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };
  child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "out"));
  child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "err"));

  let markExited!: () => void;
  const exited = new Promise<void>(resolve => { markExited = resolve; });
  let done = false;
  child.once("exit", () => { done = true; markExited(); });
  child.once("error", () => { if (!done) { done = true; markExited(); } });

  const result = new Promise<RunOutcome>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(Object.assign(
        new Error(`mutation_command_failed_to_start:${file}:${error.code ?? error.message}`),
        { code: error.code, stdout, stderr, killed: false },
      ));
    });
    child.once("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(
        new Error(`mutation_command_failed:${code ?? signal ?? "unknown"}`),
        { code, signal, stdout, stderr, killed: true },
      ));
    });
  });
  // Nothing may observe an unhandled rejection from a race the caller abandons
  // when the bound wins.
  result.catch(() => {});

  let killed = false;
  const kill = async (): Promise<void> => {
    if (killed) return;
    killed = true;
    if (child.exitCode !== null || child.signalCode !== null) {
      // The child is gone, but a descendant it left behind may not be. The
      // group signal still reaches it, so this is not an early return.
      signalGroup(child.pid, "SIGKILL");
      return;
    }
    signalGroup(child.pid, "SIGTERM");
    await Promise.race([exited, delay(KILL_GRACE_MS)]);
    signalGroup(child.pid, "SIGKILL");
    await exited;
  };

  return { result, exited, kill, pid: child.pid };
}

/**
 * Run a command to completion in its own process group.
 *
 * On expiry the WHOLE group is terminated and the exit is awaited, so the
 * caller can restore a file knowing that nothing is still running against it.
 */
async function runGrouped(
  file: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; maxBuffer?: number; boundMs?: number },
): Promise<RunOutcome> {
  const group = spawnGroup(file, args, {
    cwd: options.cwd,
    env: options.env ?? { ...process.env },
    maxBuffer: options.maxBuffer ?? MAX_CAPTURE_BYTES,
  });
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MutationTimeoutError(options.boundMs ?? BOOKKEEPING_BOUND_MS)),
      options.boundMs ?? BOOKKEEPING_BOUND_MS);
  });
  try {
    return await Promise.race([group.result, bound]);
  } finally {
    if (timer) clearTimeout(timer);
    await group.kill();
  }
}

/** tests/support/attack-kit -> repository root. */
export const ATTACK_KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export class GuardDidNotBiteError extends Error {
  constructor(readonly file: string, readonly testCommand: string) {
    super(`guard_did_not_bite:${file}:the_test_command_passed_with_the_mutation_applied`);
    this.name = "GuardDidNotBiteError";
  }
}

export class DirtyTreeError extends Error {
  constructor(readonly files: readonly string[]) {
    super(`mutation_refused_dirty_tree:${files.slice(0, 5).join(",")}`);
    this.name = "DirtyTreeError";
  }
}

export class InvalidTestCommandError extends Error {
  constructor(readonly testCommand: string, readonly detail: string) {
    super(`invalid_test_command:${testCommand}:${detail}`);
    this.name = "InvalidTestCommandError";
  }
}

/** The registry file the kit's runner writes for each cluster it starts. */
const CLUSTER_REGISTRY = "attack-kit-clusters.json";

interface RegistryEntry {
  readonly port: number;
  readonly dataDirectory: string;
  readonly pgBin: string;
}

/** Every `attack-kit-pg-*` run directory directly under `parent`. */
async function runDirectories(parent: string): Promise<string[]> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith("attack-kit-pg-"))
    .map(entry => join(parent, entry.name));
}

const readRegistry = async (run: string): Promise<RegistryEntry[]> => {
  const text = await readFile(join(run, CLUSTER_REGISTRY), "utf8").catch(() => "");
  const entries: RegistryEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as Partial<RegistryEntry>;
      if (typeof parsed.port === "number" && typeof parsed.dataDirectory === "string" && typeof parsed.pgBin === "string") {
        entries.push({ port: parsed.port, dataDirectory: parsed.dataDirectory, pgBin: parsed.pgBin });
      }
    } catch {
      // A truncated line from a killed process names no cluster.
    }
  }
  return entries;
};

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
};

const readPostmasterPid = async (dataDirectory: string): Promise<number | undefined> => {
  const first = (await readFile(join(dataDirectory, "postmaster.pid"), "utf8").catch(() => ""))
    .split("\n")[0]?.trim();
  return first && /^\d+$/.test(first) ? Number(first) : undefined;
};

/**
 * Stop every cluster the command started under `parent`, and report any that
 * survived.
 *
 * This exists because a group kill cannot reach a PostgreSQL postmaster.
 * `pg_ctl start` runs the postmaster with `setsid`, so the postmaster is a
 * session leader with its own process group and PPID 1: signalling the test
 * command's group leaves it running, holding a SysV segment and a data
 * directory, on a machine that has 32 segments in total. So after the group is
 * down, every cluster the command registered is stopped cooperatively, then by
 * pid, and a survivor is an error naming the pid.
 *
 * The scan is bounded to the private `TMPDIR` this helper gave the command, so
 * it can only ever stop clusters that command started.
 */
export async function reapKitClusters(
  parent: string,
  options: { timeoutMs?: number } = {},
): Promise<{ reaped: RegistryEntry[]; survivors: string[] }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const reaped: RegistryEntry[] = [];
  const survivors: string[] = [];
  for (const run of await runDirectories(parent)) {
    for (const entry of await readRegistry(run)) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run_ = promisify(execFile);
      const pgCtl = (args: string[], timeout: number) =>
        run_(join(entry.pgBin, "pg_ctl"), args,
          { timeout, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: run, NODE_ENV: "test" } })
          .catch(() => { /* the ladder's own liveness check decides */ });
      // The ladder itself, not a copy of its shape. This reaper is the last line
      // of defence for a cluster whose test command was killed, so it is exactly
      // where a too-eager `SIGKILL` turns an orphan into a permanently held
      // segment on a machine with 32 of them — and a hand-copied ladder is how
      // the two copies drift apart. The order is measured in
      // `real-postgres.ts`: `SIGKILL` is the only signal that leaks a segment,
      // because it cannot run PostgreSQL's exit path.
      let pid = await readPostmasterPid(entry.dataDirectory);
      if (pid !== undefined && pidAlive(pid)) {
        await shutdownLadder({
          alive: () => pid !== undefined && pidAlive(pid),
          cooperativeStop: async (mode) => {
            await pgCtl(["-D", entry.dataDirectory, "-m", mode, "-w", "-t", "60", "stop"], 90_000);
          },
          signal: (signal) => { if (pid !== undefined) try { process.kill(pid, signal); } catch { /* gone */ } },
          // This reaper runs on a killed command's leftovers, so it must not
          // block a test run for longer than the caller agreed to wait.
          graceMs: timeoutMs,
        });
        pid = (await readPostmasterPid(entry.dataDirectory)) ?? pid;
      }
      pid = await readPostmasterPid(entry.dataDirectory);
      if (pid !== undefined && pidAlive(pid)) {
        survivors.push(`${entry.port}:pid=${pid}:${entry.dataDirectory}`);
      } else {
        reaped.push(entry);
      }
    }
  }
  return { reaped, survivors };
}

export interface AssertGuardBitesOptions {
  /** File to mutate, absolute or relative to the repository root. */
  file: string;
  /** Literal text to find. Must occur exactly once. */
  find: string;
  /** Replacement for the single occurrence of `find`. */
  replace: string;
  /** Command that must FAIL while the mutation is applied. */
  testCmd: string | readonly string[];
  /** Repository root. Defaults to the kit's own location. */
  root?: string;
  /** Wall-clock bound for the command. */
  boundMs?: number;
  /** Record why the command was expected to fail. */
  because?: string;
  /** Skip the dirty-tree refusal, for a caller that already checked. */
  allowDirtyTree?: boolean;
  /**
   * Skip the unmutated baseline run. Off by default, and it should stay on.
   *
   * The baseline is what makes a failure mean "the guard bit". Without it a
   * typo in a test path, a test that already fails at HEAD, or a mutation that
   * breaks compilation all read as a bite — and every other pull request's
   * "Mutation checks" evidence depends on this helper. Only a caller with its
   * own reason should turn it off, and it is named in the report.
   */
  skipBaseline?: boolean;
  /**
   * Bound for the unmutated baseline run, when it must be shorter than the
   * mutated one. The baseline should finish quickly — it has no cluster to
   * start and nothing to prove — so a caller whose mutated run legitimately
   * takes a minute can keep its own suite fast. The baseline timing out is
   * still reported as an invalid command.
   */
  baselineBoundMs?: number;
  /** Seconds to wait for each reaped cluster to exit. */
  reapTimeoutMs?: number;
}

export interface GuardBitesResult {
  readonly file: string;
  readonly applied: boolean;
  readonly testCommand: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly output: string;
  /** Content digest after the restore, so a caller can assert it landed. */
  readonly restoredDigest: string;
  readonly because?: string;
}

/** Files `git status --porcelain` reports, ignoring untracked build output. */
async function dirtyFiles(root: string): Promise<string[]> {
  const { stdout } = await runGrouped("git", ["status", "--porcelain", "--untracked-files=no"],
    { cwd: root, maxBuffer: 1 << 24 });
  return stdout.split("\n").filter(Boolean).map((line: string) => line.slice(3).trim()).filter(Boolean);
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Split a command string into argv, honouring single and double quotes.
 *
 * A naive `split(" ")` turns `node -e "process.exit(3)"` into an argument that
 * still carries its quotes, the child evaluates a string literal instead of a
 * call, and the command exits 0 — which reads as "the guard did not bite" for
 * the wrong reason. Passing an argv array is still the better option; this
 * exists so the string form is not a trap.
 */
export function tokenizeCommand(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (/\s/u.test(character)) {
      if (current !== "") { tokens.push(current); current = ""; }
      continue;
    }
    current += character;
  }
  if (quote !== null) throw new Error("mutation_command_unterminated_quote");
  if (current !== "") tokens.push(current);
  if (tokens.length === 0) throw new Error("mutation_command_empty");
  return tokens;
}

/**
 * Mutate `file`, require `testCmd` to fail, and always restore `file`.
 *
 * The restore runs in a `finally` around the command, so a failing assertion, a
 * non-zero exit, a spawn error and a thrown error all restore the file. If the
 * restore itself fails it is retried once and the failure is surfaced, because
 * a half-restored tree is worse than a failed test. The result carries the
 * content digest observed after the restore, so a caller can verify the restore
 * rather than infer it from the absence of an exception.
 */
export async function assertGuardBites(options: AssertGuardBitesOptions): Promise<GuardBitesResult> {
  const root = options.root ?? ATTACK_KIT_ROOT;
  const file = isAbsolute(options.file) ? options.file : resolve(root, options.file);
  if (!options.file || !options.find || !options.testCmd) throw new Error("mutation_arguments_incomplete");
  if (options.find === options.replace) throw new Error("mutation_is_a_no_op");
  if (!options.allowDirtyTree) {
    const dirty = await dirtyFiles(root);
    if (dirty.length > 0) throw new DirtyTreeError(dirty);
  }
  const original = await readFile(file, "utf8");
  const occurrences = original.split(options.find).length - 1;
  if (occurrences === 0) throw new Error(`mutation_target_absent:${file}`);
  if (occurrences > 1) throw new Error(`mutation_target_ambiguous:${file}:${occurrences}_occurrences`);

  const argv = typeof options.testCmd === "string" ? tokenizeCommand(options.testCmd) : [...options.testCmd];
  if (argv.length === 0) throw new Error("mutation_command_empty");
  const command = { file: argv[0]!, args: argv.slice(1) };
  const boundMs = options.boundMs ?? 300_000;
  const started = Date.now();
  let restored = false;
  const restore = async (): Promise<string> => {
    if (!restored) {
      restored = true;
      try {
        await writeFile(file, original);
      } catch {
        // One retry: a transient write failure must not leave a live mutation.
        await writeFile(file, original);
      }
    }
    const observed = await readFile(file, "utf8");
    if (observed !== original) {
      throw new Error(`mutation_restore_failed:${file}:digest=${digest(observed)}:expected=${digest(original)}`);
    }
    return observed;
  };

  let output = "";
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let restoredDigest = digest(original);
  // A private TMPDIR for the command. Every cluster the kit's runner starts is
  // created under it and registered there, so after the group is torn down the
  // helper can find and stop the ones a group kill could not reach.
  const privateTmp = await mkdtemp(join(tmpdir(), "attack-kit-mutation-run-"));
  const commandEnv = (): NodeJS.ProcessEnv => {
    // NODE_TEST_CONTEXT must be scrubbed. When this harness is itself run from a
    // `node --test` file, that variable is inherited, and node then runs a
    // nested test command INLINE as a plain script: no runner, no exit code,
    // and the command's failures never reach us. Every such command would look
    // like a clean exit, so `assertGuardBites` would report "the guard did not
    // bite" for a guard that bites perfectly well.
    // Both are set, not just `TMPDIR`: on macOS `tmpdir()` ignores `TMPDIR`
    // and returns a `confstr` path, so a run directory created from it would
    // land outside the scan the reap does below. `ATTACK_KIT_RUN_ROOT` is what
    // actually pins the run directory; `TMPDIR` is set too because the
    // reaper's own `pg_ctl` and any child the command runs both use it.
    const env: NodeJS.ProcessEnv = {
      ...process.env, TMPDIR: privateTmp, ATTACK_KIT_RUN_ROOT: privateTmp,
    };
    delete env.NODE_TEST_CONTEXT;
    return env;
  };
  // Every exit path reaps, and the reaped set is reported rather than assumed.
  const reap = async (): Promise<void> => {
    const { survivors } = await reapKitClusters(privateTmp, { timeoutMs: options.reapTimeoutMs ?? 30_000 });
    if (survivors.length > 0) {
      throw new Error(`mutation_leftover_cluster:${survivors.join(",")}:${privateTmp}`);
    }
    await rm(privateTmp, { recursive: true, force: true }).catch(() => {});
  };
  try {
    // ---- The baseline, UNMUTATED. This is what makes a failure mean
    // "the guard bit". `node --test does-not-exist.mjs` and
    // `node -e "process.exit(1)"` both exit non-zero without ever reading the
    // file under mutation, and both were reported as bites: a typo in a test
    // path, a test that already failed at HEAD, or a mutation that breaks
    // compilation all read as proof the guard works. Every other pull request's
    // "Mutation checks" evidence depends on this helper, so a false bite here
    // manufactures evidence for a guard nobody checked.
    if (options.skipBaseline !== true) {
      let baselineError: { stdout: string; stderr: string; code: string } | undefined;
      try {
        await runGrouped(command.file, command.args,
          { cwd: root, maxBuffer: 1 << 26, env: commandEnv(), boundMs: options.baselineBoundMs ?? boundMs });
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; code?: number | string; signal?: string };
        if (error instanceof MutationTimeoutError) {
          // A baseline that hangs is a broken test command, not a bite.
          await reap();
          throw new InvalidTestCommandError([command.file, ...command.args].join(" "),
            `the_test_command_timed_out_without_the_mutation:${error.message}`);
        }
        baselineError = {
          stdout: failure.stdout ?? "", stderr: failure.stderr ?? "",
          code: `${failure.code ?? failure.signal ?? "unknown"}`,
        };
      }
      await reap();
      if (baselineError !== undefined) {
        throw new InvalidTestCommandError(
          [command.file, ...command.args].join(" "),
          `the_test_command_fails_without_the_mutation:exit=${baselineError.code}`
          + `:stdout_tail=${baselineError.stdout.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`
          + `:stderr_tail=${baselineError.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
      }
    }
    await writeFile(file, original.replace(options.find, options.replace));
    try {
      // `runGrouped` returns only once the child has exited — including on the
      // expiry path, where it signals the whole process group and awaits the
      // exit before rejecting.
      const result = await runGrouped(command.file, command.args,
        { cwd: root, maxBuffer: 1 << 26, env: commandEnv(), boundMs });
      // A resolved command IS the "the guard did not bite" case: exit 0 with
      // the mutation applied. Anything that rejects is examined for a non-zero
      // status, a signal, or a kill.
      output = `${result.stdout}${result.stderr}`;
      exitCode = 0;
      throw new GuardDidNotBiteError(file, command.args.join(" "));
    } catch (error) {
      if (error instanceof GuardDidNotBiteError) throw error;
      const failure = error as { stdout?: string; stderr?: string; code?: number | string; signal?: string; killed?: boolean };
      output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      const bited = (typeof failure.code === "number" && failure.code !== 0)
        || Boolean(failure.signal) || failure.killed === true;
      if (!bited) {
        // The command never ran (ENOENT, bad cwd) or the bound elapsed and the
        // group was torn down. Neither is evidence that the guard bit, so
        // neither is reported as a bite. A timeout keeps its own error, because
        // "the command hung" and "the command could not start" call for
        // different investigations.
        if (error instanceof MutationTimeoutError) throw error;
        if (typeof failure.code === "number" && failure.code === 0) {
          throw new GuardDidNotBiteError(file, command.args.join(" "));
        }
        throw new Error(`mutation_test_command_could_not_run:${failure.code ?? "unknown"}:${file}`);
      }
      exitCode = typeof failure.code === "number" ? failure.code : null;
      signal = (failure.signal as NodeJS.Signals | undefined) ?? null;
    }
  } finally {
    // The reap runs BEFORE the restore, so a cluster that survived the timeout
    // is stopped while the evidence that names it is still on disk.
    await reap();
    restoredDigest = digest(await restore());
  }
  return {
    file, applied: true,
    testCommand: [command.file, ...command.args].join(" "),
    exitCode, signal, durationMs: Date.now() - started, output, restoredDigest,
    ...(options.because === undefined ? {} : { because: options.because }),
  };
}

/** True when the path exists. Lets a test assert a restore landed. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
