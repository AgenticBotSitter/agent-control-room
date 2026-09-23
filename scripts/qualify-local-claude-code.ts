/**
 * Owner-attended, one-shot Claude Code text-review qualification. This script
 * never configures Control Room, saves a credential, enables a worker, or
 * retries. It prints only the sanitized report required by the private
 * installation binding.
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { sha256Digest } from "../src/security/canonical-digest";
import { qualifyPrivateLocalClaudeTextReviewV1,
  PRIVATE_LOCAL_CLAUDE_QUALIFICATION_V1 } from "../src/installer/v1/private-local-claude-qualification";

const argv = process.argv.slice(2).filter(value => value !== "--");
const names = ["--executable", "--workdir"] as const;
type Name = typeof names[number];
const valueFor = (name: Name): string | undefined => {
  const hits = argv.reduce<number[]>((all, value, index) => value === name ? [...all, index] : all, []);
  if (hits.length !== 1 || hits[0] === argv.length - 1) return undefined;
  const value = argv[hits[0] + 1];
  return value && !value.startsWith("--") ? value : undefined;
};
const values = Object.fromEntries(names.map(name => [name, valueFor(name)])) as Record<Name, string | undefined>;
const ownerAttended = argv.includes("--owner-attended"), dryRun = argv.includes("--dry-run"), reuseOwnerLogin = argv.includes("--reuse-owner-login");
const accepted = new Set(["--owner-attended", "--dry-run", "--reuse-owner-login", ...names,
  ...Object.values(values).filter((value): value is string => Boolean(value))]);
const safePath = (value: string | undefined) => Boolean(value && isAbsolute(value) && normalize(value) === value
  && !/[\u0000-\u001f\u007f]/u.test(value));
const valid = ownerAttended && reuseOwnerLogin && argv.every(value => accepted.has(value))
  && safePath(values["--executable"]) && safePath(values["--workdir"]);

if (!valid) {
  console.error("Usage: node --import tsx scripts/qualify-local-claude-code.ts --owner-attended [--dry-run] --reuse-owner-login --executable ABSOLUTE_PATH --workdir ABSOLUTE_PATH");
  process.exitCode = 2;
} else if (dryRun) {
  console.log(JSON.stringify({ qualificationReady: true, ownerAttended: true,
    invocation: "fixed-argument local Claude Code text-review bridge", startsWork: false }, null, 2));
} else {
  const nonce = `CONTROL_ROOM_CLAUDE_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    // Resolve and fingerprint the actual selected paths before launch. The
    // resulting digests bind a successful report to one installed binary and
    // one workspace without printing either private path or its version text.
    const [executablePath, workingDirectory, executableBytes] = await Promise.all([
      realpath(values["--executable"]!), realpath(values["--workdir"]!), readFile(values["--executable"]!),
    ]);
    const executableSha256 = `sha256:${createHash("sha256").update(executableBytes).digest("hex")}`;
    const workingDirectoryBindingDigest = sha256Digest({ purpose: "local-claude-working-directory-binding/v1", workingDirectory });
    const report = await qualifyPrivateLocalClaudeTextReviewV1({ executablePath,
      workingDirectory, executableSha256, workingDirectoryBindingDigest, expectedText: nonce, signal: controller.signal }, {
      launch(request) {
        const child = spawn(request.executablePath, [...request.args], { cwd: request.workingDirectory, shell: false,
          // A detached POSIX child owns its own process group. Both close paths
          // signal that group, so a CLI descendant cannot outlive qualification.
          detached: process.platform !== "win32",
          windowsHide: true, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" },
          stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
        const exited = new Promise<Readonly<{ code: number | null; signal: string | null }>>(resolve =>
          child.once("close", (code, signal) => resolve({ code, signal })));
        const signalGroup = (signal: NodeJS.Signals) => {
          if (!child.pid) return;
          try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); }
          catch (error: unknown) { if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error; }
        };
        const groupStillRuns = () => {
          if (!child.pid || process.platform === "win32") return true;
          try { process.kill(-child.pid, 0); return true; }
          catch (error: unknown) {
            if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
            throw error;
          }
        };
        let stopping: Promise<void> | undefined;
        const terminateGroup = () => stopping ??= (async () => {
          // A valid one-shot CLI can finish between its final frame and our
          // bounded cleanup. Give its normal exit a very short opportunity to
          // settle, then probe the owned process group so a surviving child is
          // still removed even when the leader is already gone.
          await Promise.race([exited.then(() => undefined), new Promise(resolve => setTimeout(resolve, 25))]);
          if (groupStillRuns()) signalGroup("SIGTERM");
          // Even if the CLI leader exits quickly, re-check its POSIX group and
          // kill any descendant that ignored TERM. This is deliberately
          // bounded below the session's two-second cleanup deadline.
          await new Promise(resolve => setTimeout(resolve, 200));
          if (groupStillRuns()) signalGroup("SIGKILL");
          await exited;
        })();
        const reader = (stream: NodeJS.ReadableStream) => {
          const chunks: Uint8Array[] = [], waiters: ((value: Uint8Array | undefined) => void)[] = [];
          let ended = false;
          const flush = () => { while (waiters.length && (chunks.length || ended)) waiters.shift()!(chunks.shift()); };
          stream.on("data", (chunk: Buffer) => { chunks.push(Uint8Array.from(chunk)); flush(); });
          stream.once("end", () => { ended = true; flush(); });
          stream.once("error", () => { ended = true; flush(); });
          return async (_signal: AbortSignal) => chunks.length ? chunks.shift() : ended ? undefined
            : new Promise<Uint8Array | undefined>(resolve => waiters.push(resolve));
        };
        const stdout = reader(child.stdout), stderr = reader(child.stderr);
        return Object.freeze({ ready: Promise.resolve(Object.freeze({
          async writeStdin(bytes: Uint8Array) { await new Promise<void>((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve())); },
          readStdout: stdout, readStderr: stderr,
          async closeStdin() { child.stdin.end(); },
          async terminate() { await terminateGroup(); },
          exited,
        })), async close() { await terminateGroup(); } });
      },
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.qualified) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  }
}
