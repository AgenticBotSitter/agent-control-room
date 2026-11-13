import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export type LoopRosterCheckResultV1 = Readonly<{ exitCode: number; lines: readonly string[] }>;

/** The tools side of the roster: where the export lives, the shipped seed, and cr's own rules check.
 * The product holds no copy of the roster rules; `check` runs `cr models check` on a candidate file. */
export interface LoopRosterToolsV1 {
  /** `<install>/roster`, created by the installer; the product never creates it. */
  readonly rosterRoot: string;
  /** `<install>/tools/loop/models.tsv`, the frozen seed shipped with the tools. */
  readonly toolsSeed: string;
  check(file: string): Promise<LoopRosterCheckResultV1>;
}

/** `<python> -B <tools>/loop/cr.py models check` with only CR_MODELS (plus the adapter's fixed locale/NODE_ENV) set.
 * Not -I: cr.py imports its sibling modules from the script directory. The interpreter must be the
 * configured one (cr.py asserts it). Any spawn failure, timeout or oversized output is exit -1. */
export function runLoopModelsCheckV1(input: { interpreter: string; crScript: string; cwd: string; file: string;
  timeoutMs?: number }): Promise<LoopRosterCheckResultV1> {
  const timeoutMs = input.timeoutMs ?? 30000;
  return new Promise(fulfill => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(input.interpreter, ["-B", input.crScript, "models", "check"], { cwd: input.cwd, shell: false,
        env: { NODE_ENV: "production", CR_MODELS: input.file, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    } catch { fulfill({ exitCode: -1, lines: [] }); return; }
    const output: Buffer[] = [];
    let bytes = 0, failed = false, killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { failed = true; child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000); };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) stop(); else output.push(Buffer.from(chunk)); });
    child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) stop(); else output.push(Buffer.from(chunk)); });
    child.on("error", () => { failed = true; });
    child.on("close", code => {
      clearTimeout(timer); clearTimeout(killTimer);
      const lines = Buffer.concat(output).toString("utf8").split("\n").filter(line => line.trim() !== "");
      fulfill({ exitCode: failed || code === null ? -1 : code, lines });
    });
  });
}
