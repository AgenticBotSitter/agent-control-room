#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, normalize, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { isMainModuleV1 } from "../../../src/installer/shared/is-main-module.mjs";

const runFile = promisify(execFile);
const refuse = code => { throw Object.assign(new Error(code), { code }); };
const PS_FIELDS = "uid=,pid=,ppid=,comm=,args=";
const COMM_COLUMN = 16;
const FAMILY = "claude|codex|hermes|opencode";
const FAMILY_FILE_NAME = new RegExp(String.raw`^[a-z]{0,4}(${FAMILY})(?:[-_.][^\s/]*|\d[^\s/]*)?$`, "u");
const VERSION_MANAGER = new RegExp(String.raw`(?:^|/)\.?(${FAMILY})/versions?/\d+(?:\.\d+)*(?=$|[\s/])`, "u");
const RUNTIME = /^(?:node(?:js)?|pythonw?(?:\d+(?:\.\d+)*)?|ruby|perl|php(?:-cgi|-fpm)?|lua|bun|deno|java|jrunscript|jsc|osascript|automator|shortcuts|swift(?:c|-frontend)?|awk|tclsh|wish|expect|tsx|ts-node)\d*(?:\.\d+)*$/iu;
const SHELL = /^(?:sh|bash|zsh|dash|ksh|fish|tcsh|csh)$/u;
const LAUNCHER = /^(?:env|npx|bunx|dlx|pnpm|npm|yarn)$/u;
// The writable Data volume has a realpath beneath /System but is not a SIP path.
const SYSTEM_PREFIX = /^\/(?:System(?!\/Volumes\/Data(?:\/|$))|Library\/Apple|bin|sbin|usr(?=\/(?!local(?:\/|$))))\//u;
const ENV = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin", LANG: "C", LC_ALL: "C" });
const OPTIONS = Object.freeze({ encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, env: ENV });

// Reviewed products, exact bundle locations and signing identities. A vendor's
// other products do not inherit this permission. Worker and image-generation
// applications are intentionally absent. Nested helpers must also verify.
const APPS = Object.freeze([
  { bundle: "/System/Applications/Utilities/Terminal.app", id: "com.apple.Terminal", apple: true, kind: "terminal" },
  { bundle: "/Applications/iTerm.app", id: "com.googlecode.iterm2", team: "H7V7XYVQ7D", kind: "terminal" },
  { bundle: "/Applications/Safari.app", id: "com.apple.Safari", apple: true },
  { bundle: "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app", id: "com.apple.Safari", apple: true },
  { bundle: "/System/Applications/TextEdit.app", id: "com.apple.TextEdit", apple: true },
  { bundle: "/Applications/Google Chrome.app", id: "com.google.Chrome", team: "EQHXZ8M8AV" },
  { bundle: "/Applications/Firefox.app", id: "org.mozilla.firefox", team: "43AQ936H96" },
  { bundle: "/Applications/Visual Studio Code.app", id: "com.microsoft.VSCode", team: "UBF8T346G9" },
]);

function commandPath(name) {
  const testPath = process.env[`CONTROL_ROOM_REHEARSAL_${name.toUpperCase()}_PATH`];
  if (process.env.CONTROL_ROOM_REHEARSAL_TESTING === "1" && testPath) {
    const path = resolve(testPath);
    if (!path.startsWith(`${resolve(tmpdir())}/`)) refuse("bot_check_command_refused");
    return path;
  }
  return { ps: "/bin/ps", lsof: "/usr/sbin/lsof" }[name];
}

function namedFamily(path) { return FAMILY_FILE_NAME.exec(basename(path ?? ""))?.[1]; }
function segmentFamily(path) {
  for (const segment of (path ?? "").split("/")) {
    if (/^\.(?:claude|codex|hermes|opencode)$/iu.test(segment)) return segment.slice(1).toLowerCase();
    const found = namedFamily(segment) ?? namedFamily(segment.endsWith(".app") ? segment.toLowerCase() : "");
    if (found) return found;
  }
}
function scriptFamily(path) {
  return /\/\.hermes\//u.test(path ?? "") ? "hermes"
    : VERSION_MANAGER.exec(path ?? "")?.[1] ?? namedFamily(path) ?? segmentFamily(path);
}
function toolchain(path) {
  return /\/\.hermes\/(?:node\/bin\/|tools\/[^/]+\/bin\/|installs\/[^/]+\/environments\/[^/]+\/venv\/bin\/)/u.test(path ?? "");
}

// Display text is used only to label a refusal. No word, title, script extension,
// existing file, or absolute path in argv can make a process safe.
function entryScript(words) {
  const at = words.findIndex(word => RUNTIME.test(basename(word)));
  const from = at >= 0 ? at + 1 : LAUNCHER.test(basename(words[0] ?? "")) ? 1 : -1;
  if (from < 0) return undefined;
  const rest = words.slice(from).filter(word => !word.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word));
  return rest.length > 1 && /^(?:run|exec|x|dlx)$/u.test(rest[0]) ? rest[1] : rest[0];
}

function processRows(output) {
  const rows = [];
  for (const line of `${output}`.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/u.exec(line);
    if (!fields) refuse("bot_check_output_refused");
    const [uid, pid, ppid] = fields.slice(1, 4).map(Number);
    if (![uid, pid, ppid].every(Number.isSafeInteger) || pid < 1) refuse("bot_check_output_refused");
    const tail = fields[4], comm = tail.slice(0, COMM_COLUMN).trimEnd(), command = tail.slice(COMM_COLUMN).trim();
    if (!comm || tail.length < COMM_COLUMN) refuse("bot_check_output_refused");
    // A parenthesised display name is not evidence that the process has exited.
    // Membership is removed only after a kernel liveness probe says ESRCH.
    if (command && !command.startsWith(comm) && !/^\(.*\)$/u.test(command)) refuse("bot_check_output_refused");
    if (comm.length === COMM_COLUMN && !command) refuse("bot_check_output_refused");
    const candidates = comm.length === COMM_COLUMN ? [] : [comm];
    candidates.push(command);
    for (let index = 1; index < command.length; index += 1) if (command[index] === " ") candidates.push(command.slice(0, index));
    rows.push({ uid, pid, ppid, candidates, words: command.split(/\s+/u).filter(Boolean) });
  }
  return rows;
}

// -u and -R fields reconcile owner membership and parents, including PIDs born
// after ps. The first txt file is the executable image; its inode binds signature
// verification to the mapped file rather than an unrelated replacement at its path.
export function parseKernelFactsV1(output) {
  const facts = new Map();
  let pid, descriptor, file;
  for (const line of `${output}`.split(/\r?\n/u)) {
    if (!line) continue;
    if (/^[puR]/u.test(line)) {
      const value = line.slice(1);
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || (line[0] === "p" && Number(value) < 1)) refuse("bot_check_kernel_refused");
      if (line[0] === "p") {
        pid = String(Number(value)); descriptor = undefined; file = undefined;
        if (!facts.has(pid)) facts.set(pid, {});
      } else {
        if (!pid) refuse("bot_check_kernel_refused");
        facts.get(pid)[line[0] === "u" ? "uid" : "ppid"] = Number(value);
      }
    } else if (line.startsWith("f")) {
      if (!pid) refuse("bot_check_kernel_refused");
      descriptor = line.slice(1); file = {};
    } else if (line.startsWith("i") && descriptor === "txt") {
      if (!/^\d+$/u.test(line.slice(1))) refuse("bot_check_kernel_refused");
      file.inode = line.slice(1);
    } else if (line.startsWith("n")) {
      if (!pid || !descriptor) refuse("bot_check_kernel_refused");
      const fact = facts.get(pid), path = line.slice(1);
      if (!path.startsWith("/") || /[\x00-\x1f\x7f]/u.test(path)) refuse("bot_check_kernel_refused");
      if (descriptor === "cwd" && !fact.cwd) fact.cwd = path;
      if (descriptor === "txt" && !fact.executable) { fact.executable = path; fact.inode = file.inode; }
    }
  }
  return facts;
}

const FILES = Object.freeze({ realpath: realpathSync, stat: path => statSync(path, { bigint: true }), read: readFileSync });
function stamp(path, files = FILES) {
  return fileStamp(files.stat(path));
}
function fileStamp(stat) {
  if (!stat.isFile()) refuse("bot_check_identity_refused");
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function postgresConfig(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value.executable !== "string" || !value.executable.startsWith("/")
    || normalize(value.executable) !== value.executable || basename(value.executable) !== "postgres"
    || /[\x00-\x1f\x7f]/u.test(value.executable) || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? "")) refuse("bot_check_postgres_config_refused");
  return value;
}

// Every command is bounded. Apple system metadata tolerates obsolete resource
// envelopes; reviewed apps and shells still require verification. Production
// always invokes the system codesign executable through this injectable port.
export async function readSipEnabledV1(run = runFile) {
  try {
    const result = await run("/usr/bin/csrutil", ["status"], OPTIONS);
    return !result.stderr && /^System Integrity Protection status: enabled\.(?:\r?\n)?$/u.test(result.stdout);
  } catch { return false; }
}

export async function trustedExecutableV1(fact, { run = runFile, postgres, files = FILES, sipEnabled } = {}) {
  postgresConfig(postgres);
  try {
    const path = files.realpath(fact.executable);
    const mapped = files.stat(path), before = fileStamp(mapped);
    if (fact.inode === undefined || String(mapped.ino) !== fact.inode) return undefined;
    const verify = async (target, requirement) => {
      await run("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", ...(requirement ? ["-R", requirement] : []), target], OPTIONS);
    };
    const display = async target => {
      const result = await run("/usr/bin/codesign", ["-d", "--verbose=4", target], OPTIONS);
      return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    };
    const app = APPS.find(item => path.startsWith(`${item.bundle}/Contents/`));
    let kind;
    if (app) {
      // Check both the enclosing product and its actual executable. A valid team
      // signature on another product or an ad-hoc re-sign is insufficient.
      const rootStamp = stamp(`${app.bundle}/Contents/Info.plist`, files);
      const requirement = app.apple ? "=anchor apple" : `=anchor apple generic and certificate leaf[subject.OU] = "${app.team}"`;
      await verify(app.bundle, requirement);
      const root = await display(app.bundle);
      if (!root.split("\n").includes(`Identifier=${app.id}`)) return undefined;
      await verify(path, requirement);
      const binary = await display(path);
      const id = /^Identifier=(.+)$/mu.exec(binary)?.[1];
      if (id !== app.id && !id?.startsWith(`${app.id}.`)) return undefined;
      if (!app.apple && (!root.split("\n").includes(`TeamIdentifier=${app.team}`) || !binary.split("\n").includes(`TeamIdentifier=${app.team}`))) return undefined;
      if (rootStamp !== stamp(`${app.bundle}/Contents/Info.plist`, files)) return undefined;
      kind = app.kind ?? "app";
    } else if (SYSTEM_PREFIX.test(path) && !RUNTIME.test(basename(path)) && !SHELL.test(basename(path)) && !LAUNCHER.test(basename(path))) {
      const details = await display(path);
      // Only verified full SIP permits a missing Platform identifier. Standalone
      // inspections read it here; a full check passes its single status result.
      if (!(sipEnabled ?? await readSipEnabledV1(run)) && !/^Platform identifier=\d+$/mu.test(details)) return undefined;
      const authorities = (details.match(/^Authority=.*$/gmu) ?? []).join("\n");
      if (!/^CDHash=[a-fA-F0-9]{40}$/mu.test(details)
        || !/^Authority=(?:macOS )?Software Signing\nAuthority=Apple Code Signing Certification Authority\nAuthority=Apple Root CA$/u.test(authorities)) return undefined;
      kind = "system";
    } else if (SYSTEM_PREFIX.test(path) && SHELL.test(basename(path))) {
      await verify(path, "=anchor apple");
      if (!/^Platform identifier=\d+$/mu.test(await display(path))) return undefined;
      kind = "shell"; // Only an ancestor tied to the check's terminal can use this.
    } else if (postgres && path === files.realpath(postgres.executable)) {
      if (createHash("sha256").update(files.read(path)).digest("hex") !== postgres.sha256) return undefined;
      await verify(path); // A pinned local distribution may use an ad-hoc signature.
      kind = "postgres";
    }
    if (before !== stamp(path, files)) return undefined;
    return kind;
  } catch { return undefined; }
}

function ownTree(rows, identities, selfPid, facts) {
  const safe = new Set();
  if (!Number.isSafeInteger(selfPid) || selfPid < 1) return safe;
  safe.add(selfPid);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (facts.get(String(row.pid))?.ppid === row.ppid && safe.has(row.ppid) && !safe.has(row.pid)) { safe.add(row.pid); changed = true; }
  }
  // Other shells are conservatively listed. The invoking shell chain is exempt
  // only when verified Apple shells connect this check to a reviewed terminal.
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const chain = [], seen = new Set([selfPid]);
  let parent = facts.get(String(selfPid))?.ppid;
  while (parent && !seen.has(parent) && identities.get(parent) === "shell"
    && facts.get(String(parent))?.ppid === byPid.get(parent)?.ppid) {
    seen.add(parent); chain.push(parent); parent = byPid.get(parent)?.ppid;
  }
  if (identities.get(parent) === "terminal") for (const pid of chain) safe.add(pid);
  return safe;
}

export function parseOwnerBotProcessesV1(output, ownerUid, kernel = {}) {
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 1) refuse("bot_check_uid_refused");
  const facts = kernel.facts ?? new Map(), identities = kernel.identities ?? new Map();
  const rows = kernel.rows ?? processRows(output);
  const safe = ownTree(rows.filter(row => row.uid === ownerUid), identities, kernel.selfPid, facts);
  const matches = [];
  for (const row of rows) {
    if (row.uid !== ownerUid || safe.has(row.pid)) continue;
    const fact = facts.get(String(row.pid)) ?? {};
    if (fact.uid !== undefined && fact.uid !== ownerUid) continue;
    const identity = identities.get(row.pid);
    const entry = entryScript(row.words);
    const runtime = RUNTIME.test(basename(fact.executable ?? "")) || row.words.some(word => RUNTIME.test(basename(word)));
    const realFamily = !toolchain(fact.executable) ? segmentFamily(fact.executable) ?? VERSION_MANAGER.exec(fact.executable ?? "")?.[1] : undefined;
    const family = realFamily ?? (entry ? scriptFamily(entry) : undefined)
      ?? (!entry && !runtime ? row.candidates.map(scriptFamily).find(Boolean) : undefined);
    const folder = segmentFamily(fact.cwd);
    // Folder and script evidence can only add a refusal, never an exemption.
    if (family) { matches.push({ pid: row.pid, ppid: row.ppid, family }); continue; }
    if (!folder && ["system", "app", "terminal", "postgres"].includes(identity)) continue;
    matches.push({ pid: row.pid, ppid: row.ppid, family: folder ?? "unidentified",
      reason: folder ? `works in a ${folder} folder` : "may be a bot — quit it first; no verified non-worker identity",
      executable: fact.executable ?? null, cwd: fact.cwd ?? null });
  }
  return Object.freeze(matches.sort((a, b) => a.pid - b.pid).map(Object.freeze));
}

function aliveV1(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}
async function readPs(run) {
  let result;
  try { result = await run(commandPath("ps"), ["-axo", PS_FIELDS], OPTIONS); }
  catch { refuse("bot_check_command_refused"); }
  if (result.stderr) refuse("bot_check_command_refused");
  return processRows(result.stdout);
}
async function readKernel(run, selector) {
  let result;
  try { result = await run(commandPath("lsof"), ["-nP", "-a", ...selector, "-R", "-d", "txt,cwd", "-FpuRftin"], OPTIONS); }
  catch { refuse("bot_check_command_refused"); }
  if (result.stderr) refuse("bot_check_command_refused");
  return parseKernelFactsV1(result.stdout);
}

export async function checkOwnerBotsStoppedV1({ ownerUid = process.getuid?.(), run = runFile,
  alive = aliveV1, identify = trustedExecutableV1, selfPid = process.pid, postgres, timeoutMs = 30_000,
  warn = line => process.stdout.write(`${line}\n`) } = {}) {
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 1) refuse("bot_check_uid_refused");
  postgresConfig(postgres);
  const nativeRun = run, deadline = Date.now() + timeoutMs;
  run = async (file, args, options) => {
    const remaining = Math.min(OPTIONS.timeout, deadline - Date.now());
    if (remaining <= 0) refuse("bot_check_command_refused");
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        nativeRun(file, args, { ...options, timeout: remaining, signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(Object.assign(new Error("bot_check_command_refused"), { code: "bot_check_command_refused" }));
        }, remaining); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const sipEnabled = await readSipEnabledV1(run);
  if (!sipEnabled) warn("SIP is not fully on, so Apple background programs may be listed. Show the lead.");
  const rows = new Map(), facts = new Map();
  const ingest = kernel => {
    for (const [pid, fact] of kernel) {
      if (fact.uid !== undefined && fact.uid !== ownerUid) { rows.delete(Number(pid)); continue; }
      facts.set(pid, fact);
      const row = rows.get(Number(pid)) ?? { uid: ownerUid, pid: Number(pid), ppid: 0, candidates: [], words: [] };
      if (fact.ppid !== undefined) row.ppid = fact.ppid;
      rows.set(row.pid, row);
    }
  };
  const snapshot = async () => {
    for (const row of await readPs(run)) {
      if (row.uid === ownerUid) rows.set(row.pid, row);
      else rows.delete(row.pid);
    }
    // Earlier facts must not exempt a reused PID or a process now unreadable.
    facts.clear();
    ingest(await readKernel(run, ["-u", String(ownerUid)]));
  };
  // Union both sources twice. New lsof-only PIDs are members immediately, even
  // when no later ps row describes them. No finite scan prevents a future launch.
  for (let round = 0; round < 2; round += 1) await snapshot();
  const missing = [...rows.values()].filter(row => !facts.get(String(row.pid))?.executable && alive(row.pid));
  if (missing.length) {
    // Selector is intersected with uid, so PID reuse cannot bring another user in.
    const retry = await readKernel(run, ["-u", String(ownerUid), "-p", missing.map(row => row.pid).join(",")]);
    ingest(retry);
  }
  const liveRows = [...rows.values()].filter(row => alive(row.pid));
  const identities = new Map(), cache = new Map();
  // Serialize signature probes, bound their number by unique executable/inode,
  // and keep the cache local to this scan. No trust survives another invocation.
  for (const row of liveRows) {
    const fact = facts.get(String(row.pid));
    if (!fact?.executable) continue;
    const key = `${fact.executable}:${fact.inode}`;
    if (!cache.has(key)) {
      let verifiedStamp;
      try { verifiedStamp = stamp(fact.executable); } catch { /* no identity can be bound to an unreadable file */ }
      const identity = await identify(fact, { run, postgres, sipEnabled });
      cache.set(key, { identity, verifiedStamp });
    }
  }
  // Signing can take time. Scan membership again immediately after it, without
  // running more signature commands afterward. Newly appeared or changed images
  // have no exemption. This prevents a birth during signing from using an old PASS.
  await snapshot();
  const finalRows = [...rows.values()].filter(row => alive(row.pid));
  for (const row of finalRows) {
    const fact = facts.get(String(row.pid));
    if (!fact?.executable) continue;
    const verified = cache.get(`${fact.executable}:${fact.inode}`);
    try {
      if (verified?.verifiedStamp && stamp(fact.executable) === verified.verifiedStamp) identities.set(row.pid, verified.identity);
    } catch { /* changed or unreadable: deny by default */ }
  }
  if (Date.now() >= deadline) refuse("bot_check_command_refused");
  return parseOwnerBotProcessesV1("", ownerUid, { facts, identities, rows: finalRows, selfPid });
}

function exactArguments(argv) {
  const handoff = argv[0] === "--password-handoff";
  if (handoff) argv = argv.slice(1);
  if (!argv.length) return { handoff };
  if (argv.length !== 4 || argv[0] !== "--postgres-executable" || argv[2] !== "--postgres-sha256") refuse("arguments_refused");
  return { handoff, postgres: postgresConfig({ executable: argv[1], sha256: argv[3] }) };
}
export async function main(argv = process.argv.slice(2)) {
  const options = exactArguments(argv);
  if (options.handoff) delete process.env.CONTROL_ROOM_REHEARSAL_TESTING;
  const matches = await checkOwnerBotsStoppedV1(options);
  if (matches.length) {
    process.stdout.write("STOP: bot worker processes are still running under the owner's uid:\n");
    for (const row of matches) {
      process.stdout.write(`PID ${row.pid} PPID ${row.ppid} FAMILY ${row.family}\n`);
      if (row.reason) process.stdout.write(`  program: ${row.executable ?? "unknown"}\n  folder: ${row.cwd ?? "unknown"}\n  why: ${row.reason}\n`);
    }
    process.stdout.write("Each listed process may be a bot — quit it first. Quit these programs; folders are left alone. If you do not recognise one, show the lead. Paste this check again after quitting them. This check never kills a process.\n");
    process.exitCode = 2;
  } else process.stdout.write("PASS: no codex/claude/hermes/opencode worker processes under the owner's uid. This check did not kill anything.\n");
}
if (isMainModuleV1(process.argv[1], import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`STOP: The Mac could not complete the stopped-process check (${error?.code ?? "bot_check_failed"}). Do not enter the password; show the lead.\n`);
    process.exitCode = 1;
  });
}
