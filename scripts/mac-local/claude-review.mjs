#!/usr/bin/env node
// Claude review gate. Reads a diff (stdin, or `git diff BASE...HEAD` with --base) and
// exits 0 = APPROVE, 1 = CHANGES, 2 = no verdict or error. A missing verdict is never approval.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_DIFF_BYTES = 300_000;
const TIMEOUT_MS = 15 * 60_000;
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const model = opt("--model", "sonnet");
const base = opt("--base");
const focus = opt("--focus", "");

function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const root = join(homedir(), "Library/Application Support/Claude/claude-code");
  if (existsSync(root)) {
    const versions = readdirSync(root).filter(v => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
    for (const v of versions) {
      const bin = join(root, v, "claude.app/Contents/MacOS/claude");
      if (existsSync(bin)) return bin;
    }
  }
  try { return execFileSync("/usr/bin/which", ["claude"], { encoding: "utf8" }).trim(); } catch { return ""; }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

async function finish(code, verdict, detail, raw, text = "") {
  const dir = join(process.cwd(), ".relay/logs");
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `claude-review-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  writeFileSync(log, raw ?? "");
  const output = `${text ? `${text}\n\n` : ""}VERDICT: ${verdict}\n${detail ? `detail: ${detail}\n` : ""}log: ${log}\n`;
  await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
  process.exitCode = code;
}

async function main() {
  if (base && execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
    return finish(2, "NONE", "working tree is dirty; commit or remove changes before reviewing BASE...HEAD");
  const diff = base ? execFileSync("git", ["diff", `${base}...HEAD`], { encoding: "utf8", maxBuffer: 64 << 20 }) : await readStdin();
  if (!diff.trim()) return finish(2, "NONE", "empty diff: pass a diff on stdin or use --base <ref>; include untracked files with `git add -N` first");
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES)
    return finish(2, "NONE", `diff is ${Buffer.byteLength(diff)} bytes (limit ${MAX_DIFF_BYTES}); split it by package or directory and review each part`);

  const claude = findClaude();
  if (!claude || !existsSync(claude)) return finish(2, "NONE", "claude CLI not found; set CLAUDE_BIN to its absolute path");

  const prompt = `You are the security and correctness reviewer for Agent Control Room (public repo).
Governing plan: docs/CODEX_MAC_BUILD_EXECUTION.md. Review the diff below.
Check for: secrets, tailnet hosts/IPs or private paths in committed content; weakened trust boundaries;
self-declared readiness or proofs not tied to real evidence; fake/placeholder tests presented as proof;
unbounded processes (missing deadline/kill/reap); broken error handling that reports success on failure.
${focus ? `Extra focus: ${focus}\n` : ""}Be concise: list concrete findings as file:line - problem - fix.
Only request changes for real defects, not style.
The LAST line of your reply must be exactly "VERDICT: APPROVE" or "VERDICT: CHANGES".

--- DIFF START ---
${diff}
--- DIFF END ---`;

  const child = spawn(claude, ["-p", "--model", model, "--tools", "", "--no-session-persistence",
    "--setting-sources", "", "--output-format", "json"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { err += d; });
  const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  child.stdin.end(prompt);
  const exitCode = await new Promise(resolve => child.on("close", resolve));
  clearTimeout(timer);
  const raw = `exit=${exitCode}\n--- stderr ---\n${err}\n--- stdout ---\n${out}\n`;

  let result;
  try { result = JSON.parse(out); }
  catch { return finish(2, "NONE", `CLI output was not JSON (exit ${exitCode}); first stderr line: ${err.split("\n")[0] || "none"}`, raw); }
  if (result.is_error) return finish(2, "NONE", `CLI error: ${String(result.result ?? result.subtype ?? "unknown").slice(0, 300)}`, raw);
  const text = String(result.result ?? "");
  const verdicts = [...text.matchAll(/^\s*\**VERDICT:\s*(APPROVE|CHANGES)\**\s*$/gim)];
  if (verdicts.length === 0) return finish(2, "NONE", "reply had no VERDICT line; treat as not approved", raw);
  const verdict = verdicts.at(-1)[1].toUpperCase();
  return finish(verdict === "APPROVE" ? 0 : 1, verdict, "", raw, text);
}

await main();
