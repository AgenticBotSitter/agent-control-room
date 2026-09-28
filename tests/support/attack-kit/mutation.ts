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

import { execFile } from "node:child_process";
import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

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
  const { stdout } = await run("git", ["status", "--porcelain", "--untracked-files=no"],
    { cwd: root, maxBuffer: 1 << 24 });
  return stdout.split("\n").filter(Boolean).map(line => line.slice(3).trim()).filter(Boolean);
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
  let timer: NodeJS.Timeout | undefined;
  let restoredDigest = digest(original);
  try {
    await writeFile(file, original.replace(options.find, options.replace));
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`mutation_test_command_timed_out_after_${boundMs}ms`)), boundMs);
      timer.unref?.();
    });
    try {
      const done = run(command.file, command.args, { cwd: root, maxBuffer: 1 << 26, env: process.env });
      // execFile resolves only on a clean exit, so a resolved promise IS the
      // "the guard did not bite" case and is reported as such. Anything that
      // rejects is examined for a non-zero status, a signal, or a kill.
      const result = await Promise.race([done, bound]);
      output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      exitCode = 0;
      throw new GuardDidNotBiteError(file, command.args.join(" "));
    } catch (error) {
      if (error instanceof GuardDidNotBiteError) throw error;
      const failure = error as { stdout?: string; stderr?: string; code?: number | string; signal?: string; killed?: boolean };
      output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      const bited = (typeof failure.code === "number" && failure.code !== 0)
        || Boolean(failure.signal) || failure.killed === true;
      if (!bited) {
        // The command never ran (ENOENT, bad cwd) or the bound elapsed. Neither
        // is evidence that the guard bit, so neither is reported as a bite.
        if (typeof failure.code === "number" && failure.code === 0) {
          throw new GuardDidNotBiteError(file, command.args.join(" "));
        }
        throw new Error(`mutation_test_command_could_not_run:${failure.code ?? "unknown"}:${file}`);
      }
      exitCode = typeof failure.code === "number" ? failure.code : null;
      signal = (failure.signal as NodeJS.Signals | undefined) ?? null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
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
