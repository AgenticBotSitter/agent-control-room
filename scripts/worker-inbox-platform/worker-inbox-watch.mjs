// Read-only local watcher for the accepted public worker inbox.
//
// One tick reads the inbox through the accepted client, fingerprints the assigned action,
// and signals the operator only when that action changes. It reuses
// `scripts/public-worker-inbox.mjs` rather than implementing another GitHub queue client.
//
// What this deliberately does not do: it cannot wake an idle agent. GitHub cannot wake a
// local process, so the honest signal is a bounded local file plus one console line. The
// limitation is restated in docs/contributors/worker-inbox/README.md.
//
// No credential value is ever read into the state file, the log, a signal, or a generated
// scheduler artifact. A token is only ever taken from the operator's environment or from
// `gh auth token`, held in memory for the request, and redacted from any message.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { readWorkerInbox } from "../public-worker-inbox.mjs";
import { actionsFingerprint, describeChange } from "./lib/inbox-fingerprint.mjs";
import {
  RUNTIME_VERSION, appendBoundedLog, assertRepository, assertWorkerId, ensureWorkerDirectory,
  logFile, readState, signalFile, stateFile, workerDirectory, workerSlug, writeSignal, writeJsonAtomic,
} from "./lib/runtime.mjs";

export const DEFAULT_INTERVAL_SECONDS = 300;
export const EXIT_OK = 0;
export const EXIT_CONFIG = 1;
export const EXIT_TRANSIENT = 2;

const FATAL_ERRORS = new Set([
  "worker_inbox_worker_id_invalid",
  "worker_inbox_repository_invalid",
]);

export function isFatalError(code) {
  return typeof code === "string" && (code.startsWith("worker_inbox_platform_") || FATAL_ERRORS.has(code));
}

export function redactSecrets(text, secrets = []) {
  let value = String(text);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) value = value.split(secret).join("[REDACTED]");
  }
  return value;
}

export function resolveToken({ environment = process.env, tokenFromGh = false, runCommand = spawnSync } = {}) {
  const direct = environment?.GITHUB_TOKEN;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (!tokenFromGh) return undefined;
  // gh keeps its own credential; this only reads the derived token into memory.
  const result = runCommand("gh", ["auth", "token"], { encoding: "utf8" });
  if (!result || result.status !== 0) throw new Error("worker_inbox_platform_gh_token_unavailable");
  const value = String(result.stdout ?? "").trim();
  return value || undefined;
}

export function argumentsFor(argv) {
  const options = {
    repository: "AgenticBotSitter/agent-control-room",
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    maxLogBytes: 65536,
    once: false,
    json: false,
    tokenFromGh: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--worker-id") options.workerId = argv[++index];
    else if (flag === "--repository") options.repository = argv[++index];
    else if (flag === "--runtime-root") options.runtimeRoot = argv[++index];
    else if (flag === "--signal-directory") options.signalDirectory = argv[++index];
    else if (flag === "--interval") options.intervalSeconds = Number(argv[++index]);
    else if (flag === "--max-log-bytes") options.maxLogBytes = Number(argv[++index]);
    else if (flag === "--once") options.once = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--token-from-gh") options.tokenFromGh = true;
    else if (flag === "--help") options.help = true;
    else throw new Error(`worker_inbox_platform_argument_invalid:${flag}`);
  }
  if (options.help) return options;
  assertWorkerId(options.workerId);
  assertRepository(options.repository);
  if (!Number.isFinite(options.intervalSeconds) || options.intervalSeconds < 1) {
    throw new Error("worker_inbox_platform_interval_invalid");
  }
  return options;
}

export function usage() {
  return [
    "Usage: node scripts/worker-inbox-platform/worker-inbox-watch.mjs --worker-id ID [options]",
    "",
    "Reads the public worker inbox on an interval and signals only when the assigned",
    "action changes. Read-only: it never writes to GitHub.",
    "",
    "Options:",
    "  --worker-id ID            Stable worker ID (required).",
    "  --repository OWNER/NAME   Default AgenticBotSitter/agent-control-room.",
    "  --runtime-root DIR        Where state, logs and signals live.",
    "  --signal-directory DIR    Optional extra directory for the signal file.",
    "  --interval SECONDS        Poll interval in loop mode (default 300).",
    "  --max-log-bytes N         Bounded log size (default 65536).",
    "  --once                    Run a single tick and exit.",
    "  --json                    Print the tick result as JSON.",
    "  --token-from-gh           Use `gh auth token` in memory when GITHUB_TOKEN is unset.",
    "  --help                    Show this message.",
    "",
    "Exit codes: 0 tick completed, 1 configuration error, 2 read failure.",
  ].join("\n");
}

// One tick. A read failure never rewrites the observed action, so a network problem can
// never be mistaken for the assignment being cleared.
export async function runTick({ options, reader = readWorkerInbox, token, now = () => new Date(), tokenFromGh = false }) {
  const at = now().toISOString();
  const directory = workerDirectory({ workerId: options.workerId, runtimeRoot: options.runtimeRoot });
  ensureWorkerDirectory(directory, { workerId: options.workerId });
  const statePath = stateFile(directory), logPath = logFile(directory), signalPath = signalFile(directory);
  const secrets = [token];
  const previous = readState(statePath);

  let actions;
  try {
    actions = await reader({
      workerId: options.workerId, repository: options.repository, token, fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    const message = redactSecrets(error?.message ?? "worker_inbox_platform_failure", secrets);
    appendBoundedLog(logPath, `${at} outcome=failure error=${message}`, { maxBytes: options.maxLogBytes });
    writeJsonAtomic(statePath, {
      ...(previous ?? {}),
      version: RUNTIME_VERSION,
      workerId: options.workerId,
      repository: options.repository,
      updatedAt: at,
      lastOutcome: "failure",
      lastError: message,
    });
    return { outcome: "failure", error: message, directory, statePath, logPath, signalPath, notified: false, changed: false };
  }

  const current = actionsFingerprint(actions);
  const change = describeChange({ previous: previous?.observed, current, workerId: options.workerId });
  const observed = { fingerprint: current.fingerprint, count: current.count, states: current.states, issues: current.issues };
  const maxBytes = options.maxLogBytes ?? 65536;

  let notified = false;
  if (change.notify) {
    const payload = {
      version: RUNTIME_VERSION,
      workerId: options.workerId,
      repository: options.repository,
      at,
      kind: change.kind,
      message: change.message,
      fingerprint: current.fingerprint,
      issues: current.issues,
      states: current.states,
    };
    writeSignal(signalPath, payload);
    if (options.signalDirectory) {
      writeFileSync(join(options.signalDirectory, `${workerSlug(options.workerId)}.signal`), `${JSON.stringify(payload)}\n`, "utf8");
    }
    notified = true;
  }

  writeJsonAtomic(statePath, {
    version: RUNTIME_VERSION,
    workerId: options.workerId,
    repository: options.repository,
    updatedAt: at,
    lastOutcome: "ok",
    observed,
    lastChange: { kind: change.kind, changed: change.changed, at },
  });
  appendBoundedLog(logPath, `${at} outcome=ok change=${change.kind} count=${current.count} notify=${notified}`, {
    maxBytes: options.maxLogBytes,
  });

  return { outcome: "ok", change: change.kind, changed: change.changed, notified, message: change.message, directory, statePath, logPath, signalPath, observed };
}

// Decides what, if anything, the console should show for one tick.
//
// Extracted so the rule is testable rather than buried in a loop: the console is for the
// operator, not a transcript. A change is worth printing, a failure is worth printing once,
// and an unchanged poll in a long-running loop is not — the bounded log still records every
// tick, so nothing is lost by staying quiet.
export function consoleDecision({ result, options, lastReported }) {
  if (options.json) return { print: true, stream: "stdout", line: JSON.stringify(result, null, 2), signature: undefined };
  const signature = result.outcome === "failure"
    ? `failure:${result.error}`
    : result.notified ? `change:${result.change}:${result.observed.fingerprint}` : "unchanged";
  if (!options.once && signature === lastReported) return { print: false, signature };
  const line = result.outcome === "failure"
    ? `worker-inbox-watch: read failed (${result.error})`
    : result.notified ? result.message : `worker-inbox-watch: ${result.message}`;
  return {
    print: true,
    stream: result.outcome === "failure" ? "stderr" : "stdout",
    line,
    signature,
  };
}

export async function main(argv = process.argv.slice(2), { reader, environment = process.env, runCommand, now } = {}) {
  let options;
  try {
    options = argumentsFor(argv);
  } catch (error) {
    console.error(`worker-inbox-watch: ${error.message}`);
    return isFatalError(error?.message) ? EXIT_CONFIG : EXIT_TRANSIENT;
  }
  if (options.help) {
    console.log(usage());
    return EXIT_OK;
  }
  let token;
  try {
    token = resolveToken({ environment, tokenFromGh: options.tokenFromGh, runCommand });
  } catch (error) {
    console.error(`worker-inbox-watch: ${error.message}`);
    return EXIT_CONFIG;
  }
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  let stopped = false;
  let lastReported;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  do {
    let result;
    try {
      result = await runTick({ options, reader, token, now });
    } catch (error) {
      console.error(`worker-inbox-watch: ${redactSecrets(error?.message, [token])}`);
      return isFatalError(error?.message) ? EXIT_CONFIG : EXIT_TRANSIENT;
    }
    const decision = consoleDecision({ result, options, lastReported });
    if (decision.print) {
      (decision.stream === "stderr" ? console.error : console.log)(decision.line);
      lastReported = decision.signature;
    }

    if (result.outcome === "failure" && options.once) return EXIT_TRANSIENT;
    if (options.once) return EXIT_OK;
    await sleep(options.intervalSeconds * 1000);
  } while (!stopped);

  return EXIT_OK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`worker-inbox-watch: ${error.message}`);
    process.exitCode = isFatalError(error?.message) ? EXIT_CONFIG : EXIT_TRANSIENT;
  });
}
