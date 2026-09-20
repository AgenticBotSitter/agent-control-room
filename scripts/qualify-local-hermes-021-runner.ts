/**
 * Owner-attended, one-shot check of the same fixed-argument subprocess bridge
 * that a local Hermes worker will use. This is deliberately separate from
 * task activation: it sends one text-only nonce, does not configure a worker,
 * database, queue, or service, and prints only a sanitized result.
 */
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { createHermes021MacosSubprocessStreamJsonHostV1 } from "../src/harness/hermes-021-v1/subprocess-stream-json-host";
import { hermes021MacosTerminalResultSchemaV1 } from "../src/harness/hermes-021-v1/macos-local-worker";

const args = process.argv.slice(2).filter(value => value !== "--");
const ownerAttended = args.includes("--owner-attended");
const dryRun = args.includes("--dry-run");
const names = ["--executable", "--profile", "--model", "--provider", "--workdir"] as const;
type Name = typeof names[number];

const valueFor = (name: Name): string | undefined => {
  const indexes = args.reduce<number[]>((all, value, index) => value === name ? [...all, index] : all, []);
  if (indexes.length !== 1 || indexes[0] === args.length - 1) return undefined;
  const value = args[indexes[0] + 1];
  return value && !value.startsWith("--") ? value : undefined;
};
const supplied = Object.fromEntries(names.map(name => [name, valueFor(name)])) as Record<Name, string | undefined>;
const accepted = new Set<string>(["--owner-attended", "--dry-run", ...names, ...Object.values(supplied).filter((value): value is string => Boolean(value))]);
const valid = ownerAttended && args.every(value => accepted.has(value)) && names.every(name => supplied[name] !== undefined);

function safeResult(value: Readonly<{ qualified: boolean; terminal?: unknown; failureReason: string }>) {
  const terminal = hermes021MacosTerminalResultSchemaV1.safeParse(value.terminal);
  const result = terminal.success ? terminal.data : undefined;
  return Object.freeze({
    qualified: value.qualified,
    terminalResultObserved: Boolean(result),
    sessionDigest: typeof result?.session_id === "string"
      ? `sha256:${createHash("sha256").update(result.session_id).digest("hex")}` : null,
    inputTokens: result?.tokens.input ?? null,
    outputTokens: result?.tokens.output ?? null,
    totalTokens: result?.tokens.total ?? null,
    durationMs: result?.duration_ms ?? null,
    failureReason: value.failureReason,
    retryRequiresFreshOwnerAuthorization: !value.qualified,
  });
}

if (!valid) {
  console.error("Usage: node --import tsx scripts/qualify-local-hermes-021-runner.ts --owner-attended [--dry-run] --executable ABSOLUTE_PATH --profile PROFILE --model MODEL --provider PROVIDER --workdir ABSOLUTE_PATH");
  process.exitCode = 2;
} else if (dryRun) {
  // Do not echo paths, model, provider, or profile: this report may be saved
  // as installation evidence.
  console.log(JSON.stringify({ qualificationReady: true, ownerAttended: true,
    invocation: "fixed-argument local Hermes stream-json bridge", startsWork: false }, null, 2));
} else {
  const executablePath = supplied["--executable"]!;
  const workingDirectory = supplied["--workdir"]!;
  if (!isAbsolute(executablePath) || !isAbsolute(workingDirectory)) {
    console.log(JSON.stringify(safeResult({ qualified: false, failureReason: "owner_configuration_invalid" }), null, 2));
    process.exitCode = 1;
  } else {
    const nonce = randomBytes(16).toString("hex");
    const expected = `CONTROL_ROOM_HERMES_RUNNER_${nonce}`;
    const deadline = Date.now() + 125_000;
    const lines: string[] = [];
    try {
      const host = createHermes021MacosSubprocessStreamJsonHostV1({ executablePath,
        profile: supplied["--profile"]!, model: supplied["--model"]!, provider: supplied["--provider"]!, workingDirectory,
        maximumTurns: 1, maximumRunBudgetSeconds: 120 });
      await host.execute({ task: { tenantId: "tenant:qualification", projectId: "project:qualification",
        jobId: "job:qualification", attemptId: "attempt:qualification", runId: "run:qualification",
        nodeId: "node:qualification", prompt: `Reply with exactly this text and nothing else: ${expected}`,
        instructions: "Use no tools and do not write files.", deadline },
      async onLine(line) { if (lines.length < 64) lines.push(line); } });
      const terminals = lines.flatMap(line => {
        try { const parsed = JSON.parse(line); const result = hermes021MacosTerminalResultSchemaV1.safeParse(parsed); return result.success ? [result.data] : []; }
        catch { return []; }
      });
      const terminal = terminals.length === 1 ? terminals[0] : undefined;
      const qualified = terminal?.exit_code === 0 && terminal.text === expected
        && terminal.tokens.total >= terminal.tokens.input + terminal.tokens.output;
      console.log(JSON.stringify(safeResult({ qualified, terminal, failureReason: qualified ? "none" : "terminal_result_unexpected" }), null, 2));
      if (!qualified) process.exitCode = 1;
    } catch {
      console.log(JSON.stringify(safeResult({ qualified: false, failureReason: "runner_bridge_unavailable" }), null, 2));
      process.exitCode = 1;
    }
  }
}
