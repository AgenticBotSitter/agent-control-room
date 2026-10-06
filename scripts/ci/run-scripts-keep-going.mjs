import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";

const scriptName = /^[a-z][a-z0-9:.-]*$/u;

// Only expand chains consisting entirely of package-script invocations.
// Build prerequisites and other shell commands inside a leaf keep their semantics.
export function expandScripts(scripts, names, expand = false, ancestors = []) {
  return names.flatMap(name => {
    if (!scriptName.test(name) || typeof scripts[name] !== "string") throw new Error(`Unknown package script: ${name}`);
    if (ancestors.includes(name)) throw new Error(`Cyclic package script: ${name}`);
    const parts = scripts[name].split(/\s*&&\s*/u);
    const references = parts.map(part => /^pnpm\s+(?:run\s+)?([a-z][a-z0-9:.-]*)$/u.exec(part.trim())?.[1]);
    if (expand && references.every(Boolean)) return expandScripts(scripts, references, true, [...ancestors, name]);
    return [name];
  });
}

export function runUnits(units, execute, log = console.log, githubActions = process.env.GITHUB_ACTIONS === "true") {
  const results = [];
  for (const unit of units) {
    const start = performance.now();
    if (githubActions) log(`::group::${unit}`);
    let result;
    try {
      result = execute(unit);
    } catch (error) {
      // Spawn errors are failures of this unit, not permission to hide the rest.
      console.error(`Unit failed to execute: ${unit} (${error.code ?? error.name ?? "Error"})`);
      result = { status: 1 };
    } finally {
      if (githubActions) log("::endgroup::");
    }
    if (githubActions && result.status !== 0) log(`::error::${unit} FAILED (status ${result.status || 1})`);
    results.push({ unit, status: result.status, verdict: result.verdict ?? (result.status === 0 ? "PASS" : "FAIL"),
      seconds: (performance.now() - start) / 1000 });
  }
  log("File / unit | Result | Seconds");
  for (const result of results) log(`${result.unit} | ${result.verdict} | ${result.seconds.toFixed(3)}`);
  const failures = results.filter(result => result.status !== 0);
  log(`Completed ${results.length} unit(s); ${failures.length} failed.`);
  return failures.length === 0 ? 0 : (failures[0].status || 1);
}

export function parseArguments(args) {
  let expand = false;
  const names = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--expand") expand = true;
    else if (arg === "--jobs") {
      if (args[++index] !== "1") throw new Error("Only --jobs 1 is supported; CI units run serially.");
    } else if (!scriptName.test(arg)) throw new Error(`Invalid package script argument: ${arg}`);
    else names.push(arg);
  }
  if (names.length === 0) throw new Error("Supply at least one package script name.");
  return { names, expand };
}

export function runScripts(args, root = process.cwd()) {
  const { names, expand } = parseArguments(args);
  const { scripts = {} } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const units = expandScripts(scripts, names, expand);
  return runUnits(units, name => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync("pnpm", ["run", name], { cwd: root, env, stdio: "inherit" });
    if (child.error) throw child.error;
    return { status: child.status ?? 1 };
  });
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  try { process.exitCode = runScripts(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
