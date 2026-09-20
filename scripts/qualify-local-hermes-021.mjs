#!/usr/bin/env node
/**
 * Owner-attended, one-shot qualification of an existing local Hermes Agent.
 * This is deliberately not the permanent worker service. It proves only that
 * the installed Hermes CLI can return one text-only stream-json result.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = new Set(process.argv.slice(2));
const ownerAttended = args.has("--owner-attended");
const dryRun = args.has("--dry-run");
if (!ownerAttended || [...args].some(value => value !== "--owner-attended" && value !== "--dry-run")) {
  console.error("Usage: node scripts/qualify-local-hermes-021.mjs --owner-attended [--dry-run]");
  process.exitCode = 2;
} else {
  const nonce = randomBytes(16).toString("hex");
  const query = `Reply with exactly this text and nothing else: CONTROL_ROOM_HERMES_021_${nonce}`;
  const invocation = Object.freeze({
    executable: "hermes",
    arguments: ["chat", "--query-file", "<temporary-query-file>", "--format", "stream-json",
      "--toolsets", "bot_room", "--ignore-rules", "--max-turns", "1", "--run-budget", "120",
      "--source", "control-room-local-qualification", "--in", "<temporary-work-directory>"],
    toolAccess: "none", maxTurns: 1, runBudgetSeconds: 120,
  });
  if (dryRun) {
    console.log(JSON.stringify({ qualificationReady: true, ownerAttended: true, invocation }, null, 2));
  } else {
    const directory = await mkdtemp(join(tmpdir(), "control-room-hermes-021-"));
    const queryFile = join(directory, "qualification.txt");
    let stdout = "", stderrBytes = 0, timedOut = false, launchError = false;
    try {
      await writeFile(queryFile, query, { encoding: "utf8", mode: 0o600 });
      const child = spawn("hermes", ["chat", "--query-file", queryFile, "--format", "stream-json",
        "--toolsets", "bot_room", "--ignore-rules", "--max-turns", "1", "--run-budget", "120",
        "--source", "control-room-local-qualification", "--in", directory],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 130_000);
      const exit = await new Promise(resolve => {
        child.stdout.on("data", chunk => { if (stdout.length < 262_144) stdout += String(chunk); });
        child.stderr.on("data", chunk => { stderrBytes += Buffer.byteLength(chunk); });
        child.once("error", () => { launchError = true; resolve({ code: null, signal: "error" }); });
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      clearTimeout(timeout);
      let terminal;
      try {
        const candidates = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line))
          .filter(value => value?.type === "result");
        terminal = candidates.length === 1 ? candidates[0] : undefined;
      } catch { terminal = undefined; }
      const completed = exit.code === 0 && terminal?.exit_code === 0 && terminal?.text === `CONTROL_ROOM_HERMES_021_${nonce}`;
      // Keep diagnostics useful without ever printing the provider's terminal
      // text or stderr: either may include account, routing, or host detail.
      // These are only coarse facts needed to decide whether a later,
      // separately-authorized retry is meaningful.
      const terminalInputTokens = Number.isSafeInteger(terminal?.tokens?.input) ? terminal.tokens.input : null;
      const terminalOutputTokens = Number.isSafeInteger(terminal?.tokens?.output) ? terminal.tokens.output : null;
      const terminalTotalTokens = Number.isSafeInteger(terminal?.tokens?.total) ? terminal.tokens.total : null;
      const failureStage = completed ? "none"
        : !terminal ? "before_terminal_result"
          : terminalTotalTokens === 0 ? "before_model_response"
            : "after_model_response";
      // A deliberately small, non-sensitive reason to make an owner-run
      // attempt actionable.  Do not expose command output: it can include
      // account, provider, or local-machine information.
      const failureReason = completed ? "none"
        : launchError ? "runner_unavailable"
          : timedOut ? "timed_out"
            : !terminal ? "terminal_result_missing"
              : terminalTotalTokens === 0 ? "model_response_missing"
                : exit.code !== 0 ? "runner_exit_nonzero"
                  : "terminal_result_unexpected";
      const safe = {
        qualified: completed,
        exitCode: Number.isInteger(exit.code) ? exit.code : null,
        exitSignal: typeof exit.signal === "string" ? exit.signal : null,
        terminalResultObserved: Boolean(terminal),
        sessionDigest: typeof terminal?.session_id === "string"
          ? `sha256:${createHash("sha256").update(terminal.session_id).digest("hex")}` : null,
        inputTokens: terminalInputTokens,
        outputTokens: terminalOutputTokens,
        totalTokens: terminalTotalTokens,
        durationMs: Number.isSafeInteger(terminal?.duration_ms) ? terminal.duration_ms : null,
        stderrBytes: Math.min(stderrBytes, 65_536),
        failureStage,
        failureReason,
        // A non-dry native attempt must be explicitly authorized again; the
        // script never interprets a failed attempt as permission to retry.
        retryRequiresFreshOwnerAuthorization: !completed,
      };
      console.log(JSON.stringify(safe, null, 2));
      if (!completed) process.exitCode = 1;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
