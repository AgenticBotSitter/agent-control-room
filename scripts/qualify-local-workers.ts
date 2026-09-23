/**
 * Public, owner-attended wrapper for the existing local Hermes and Claude
 * qualification scripts. The checks remain separate and sequential: Claude is
 * never attempted unless Hermes passed. This wrapper retains no private input,
 * does not retry, and emits only schema-checked sanitized child reports.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  hermes021MacosLocalRunnerQualificationReportSchemaV1,
} from "../src/harness/hermes-021-v1/runner-qualification-evidence";
import {
  claudeCodeTextReviewQualificationReportSchemaV1,
} from "../src/harness/claude-code-v1/qualification-evidence";

const SCHEMA = "control-room.local-worker-qualification-report/v1" as const;
const argv = process.argv.slice(2).filter(value => value !== "--");
const names = ["--hermes-executable", "--hermes-profile", "--hermes-model", "--hermes-provider",
  "--hermes-workdir", "--claude-executable", "--claude-workdir"] as const;
type Name = typeof names[number];

function valueFor(name: Name): string | undefined {
  const hits = argv.reduce<number[]>((all, value, index) => value === name ? [...all, index] : all, []);
  if (hits.length !== 1 || hits[0] === argv.length - 1) return undefined;
  const value = argv[hits[0] + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const values = Object.fromEntries(names.map(name => [name, valueFor(name)])) as Record<Name, string | undefined>;
const accepted = new Set(["--owner-attended", "--reuse-owner-login", ...names,
  ...Object.values(values).filter((value): value is string => Boolean(value))]);
const safePath = (value: string | undefined) => Boolean(value && value.length <= 4_096 && isAbsolute(value)
  && normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value));
const safeSelection = (value: string | undefined) => Boolean(value && value.length <= 120
  && /^[A-Za-z0-9._:/-]+$/u.test(value));
const valid = argv.filter(value => value === "--owner-attended").length === 1
  && argv.filter(value => value === "--reuse-owner-login").length === 1
  && argv.length === 2 + (names.length * 2)
  && argv.every(value => accepted.has(value))
  && safePath(values["--hermes-executable"]) && safePath(values["--hermes-workdir"])
  && safePath(values["--claude-executable"]) && safePath(values["--claude-workdir"])
  && safeSelection(values["--hermes-profile"]) && safeSelection(values["--hermes-model"])
  && safeSelection(values["--hermes-provider"]);

const usage = "Usage: node --import tsx scripts/qualify-local-workers.ts --owner-attended --reuse-owner-login "
  + "--hermes-executable ABSOLUTE_PATH --hermes-profile PROFILE --hermes-model MODEL --hermes-provider PROVIDER "
  + "--hermes-workdir ABSOLUTE_PATH --claude-executable ABSOLUTE_PATH --claude-workdir ABSOLUTE_PATH";

type Attempt = Readonly<{ exitCode: number; output: unknown }>;

async function runQualifier(script: string, args: readonly string[]): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
      shell: false,
      windowsHide: true,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", bytes = 0, stopped = false;
    const consume = (chunk: Buffer, retain: boolean) => {
      if (stopped) return;
      bytes += chunk.byteLength;
      if (bytes > 65_536) { stopped = true; child.kill("SIGTERM"); return; }
      if (retain) stdout += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, false));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (stopped || signal !== null || !Number.isSafeInteger(code)) { reject(new Error("qualification_unavailable")); return; }
      try { resolve(Object.freeze({ exitCode: code!, output: JSON.parse(stdout) })); }
      catch { reject(new Error("qualification_unavailable")); }
    });
  });
}

function result(input: Readonly<{
  qualified: boolean;
  failureReason: "none" | "hermes_qualification_failed" | "hermes_launcher_unavailable"
    | "claude_qualification_failed" | "claude_launcher_unavailable";
  hermes: Readonly<{ state: "qualified" | "failed" | "launcher_unavailable"; report: unknown | null }>;
  claude: Readonly<{ state: "qualified" | "failed" | "launcher_unavailable" | "not_attempted"; report: unknown | null }>;
}>) {
  return Object.freeze({ schema: SCHEMA, qualified: input.qualified, ownerAttended: true as const,
    startsWork: false as const, grantsWorkerAuthority: false as const,
    retryRequiresFreshOwnerAuthorization: !input.qualified, failureReason: input.failureReason,
    hermes: input.hermes, claude: input.claude });
}

if (!valid) {
  console.error(usage);
  process.exitCode = 2;
} else {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let hermesAttempt: Attempt | undefined;
  try {
    hermesAttempt = await runQualifier(join(root, "scripts/qualify-local-hermes-021-runner.ts"), [
      "--owner-attended", "--executable", values["--hermes-executable"]!, "--profile", values["--hermes-profile"]!,
      "--model", values["--hermes-model"]!, "--provider", values["--hermes-provider"]!,
      "--workdir", values["--hermes-workdir"]!,
    ]);
  } catch {
    console.log(JSON.stringify(result({ qualified: false, failureReason: "hermes_launcher_unavailable",
      hermes: { state: "launcher_unavailable", report: null }, claude: { state: "not_attempted", report: null } }), null, 2));
    process.exitCode = 1;
  }

  if (hermesAttempt) {
    const parsed = hermes021MacosLocalRunnerQualificationReportSchemaV1.safeParse(hermesAttempt.output);
    const hermesPassed = parsed.success && parsed.data.qualified && hermesAttempt.exitCode === 0;
    if (!parsed.success || (parsed.data.qualified ? hermesAttempt.exitCode !== 0 : hermesAttempt.exitCode !== 1)) {
      console.log(JSON.stringify(result({ qualified: false, failureReason: "hermes_launcher_unavailable",
        hermes: { state: "launcher_unavailable", report: null }, claude: { state: "not_attempted", report: null } }), null, 2));
      process.exitCode = 1;
    } else if (!hermesPassed) {
      console.log(JSON.stringify(result({ qualified: false, failureReason: "hermes_qualification_failed",
        hermes: { state: "failed", report: parsed.data }, claude: { state: "not_attempted", report: null } }), null, 2));
      process.exitCode = 1;
    } else {
      let claudeAttempt: Attempt | undefined;
      try {
        claudeAttempt = await runQualifier(join(root, "scripts/qualify-local-claude-code.ts"), [
          "--owner-attended", "--reuse-owner-login", "--executable", values["--claude-executable"]!,
          "--workdir", values["--claude-workdir"]!,
        ]);
      } catch {
        console.log(JSON.stringify(result({ qualified: false, failureReason: "claude_launcher_unavailable",
          hermes: { state: "qualified", report: parsed.data }, claude: { state: "launcher_unavailable", report: null } }), null, 2));
        process.exitCode = 1;
      }
      if (claudeAttempt) {
        const claude = claudeCodeTextReviewQualificationReportSchemaV1.safeParse(claudeAttempt.output);
        if (!claude.success || (claude.data.qualified ? claudeAttempt.exitCode !== 0 : claudeAttempt.exitCode !== 1)) {
          console.log(JSON.stringify(result({ qualified: false, failureReason: "claude_launcher_unavailable",
            hermes: { state: "qualified", report: parsed.data }, claude: { state: "launcher_unavailable", report: null } }), null, 2));
          process.exitCode = 1;
        } else {
          const qualified = claude.data.qualified;
          console.log(JSON.stringify(result({ qualified,
            failureReason: qualified ? "none" : "claude_qualification_failed",
            hermes: { state: "qualified", report: parsed.data },
            claude: { state: qualified ? "qualified" : "failed", report: claude.data } }), null, 2));
          if (!qualified) process.exitCode = 1;
        }
      }
    }
  }
}
