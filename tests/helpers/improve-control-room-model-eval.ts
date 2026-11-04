// Closed B11 preparation policies. Importing this module never starts a process.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { B5_PROTECTED_TESTS, B5_RECIPES, B5_REQUEST_TEXT, B5_REQUIRED_RISK, B5RefusalV1,
  b5Bytes, requireB5RecipesV1, readFirstWebsitePrivateBytesV1, runIndependentStatusCheckV1 } from "./improve-control-room-first-website";

const exec = promisify(execFile);
function refuse(code: string): never { throw new B5RefusalV1(code); }
export const MODEL_EVAL_ROOT = /^acr-b11-[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
export const MODEL_EVAL_REQUEST = "Add --lean --out DIR to bin/build_prompts.py to render lean variants of tasks that have a lean role into that folder without changing tasks/. Refuse roles without a lean text. Ask me whether the lean version keeps the KIT NOTE before choosing. Change only bin/build_prompts.py and DESIGN.md.";
export const MODEL_EVAL_RISK = Object.freeze({ categories: ["code", "ci"], slots: ["attack-review", "ci-review"] });
export const MODEL_EVAL_PROTECTED = Object.freeze(["bin/test_build_prompts_lean.py", "bin/diagnostic/lean_isolation_check.py"]);
const pythonPinSchema = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type ModelEvalPythonPinV1 = z.infer<typeof pythonPinSchema>;
export const modelEvalProfilePacketSchemaV1 = z.object({ schemaVersion: z.literal(1), id: z.literal("model-eval"),
  kitPin: z.string().regex(/^[a-f0-9]{40}$/u), python: pythonPinSchema,
  protectedTestsDigest: z.string().regex(/^[a-f0-9]{64}$/u), skillsTreeDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

export function modelEvalRecipesV1(python: string) {
  return ([["kit-bin", "bin", "test_*.py", true], ["kit-scoring", "scoring/bin", "test_*.py", true],
    ["lean-isolation", "bin/diagnostic", "lean_isolation_check.py", false]] as const).map(([id, folder, pattern, required]) =>
    ({ id, argv: [python, "-m", "unittest", "discover", "-s", folder, "-p", pattern], parser: "unittest", required }));
}
export async function requireModelEvalPythonV1(pin: ModelEvalPythonPinV1) {
  try {
    pythonPinSchema.parse(pin);
    if (!isAbsolute(pin.path) || resolve(pin.path) !== pin.path || await realpath(pin.path) !== pin.path) refuse("B5_RECIPE_MISMATCH");
    for (let part = pin.path; ; part = dirname(part)) {
      if ((await lstat(part)).isSymbolicLink()) refuse("B5_RECIPE_MISMATCH");
      if (part === dirname(part)) break;
    }
    const stat = await lstat(pin.path);
    if (!stat.isFile() || stat.size > 256 << 20 || !(stat.mode & 0o111)
      || b5Bytes(await readFile(pin.path)).slice(7) !== pin.sha256) refuse("B5_RECIPE_MISMATCH");
  } catch { refuse("B5_RECIPE_MISMATCH"); }
}
export async function requireModelEvalRecipesV1(checks: unknown, _root: string, pin: ModelEvalPythonPinV1) {
  await requireModelEvalPythonV1(pin);
  // Object key order is not authority: compare the closed fields structurally.
  const expected = modelEvalRecipesV1(pin.path);
  if (!Array.isArray(checks) || checks.length !== expected.length) refuse("B5_RECIPE_MISMATCH");
  for (const [i, recipe] of expected.entries()) {
    const value = checks[i];
    if (!value || Object.keys(value).sort().join() !== "argv,id,parser,required"
      || value.id !== recipe.id || value.parser !== recipe.parser || value.required !== recipe.required
      || JSON.stringify(value.argv) !== JSON.stringify(recipe.argv)) refuse("B5_RECIPE_MISMATCH");
  }
}

export const FIRST_WEBSITE_PROFILE = Object.freeze({ id: "first-website" as const,
  rootName: /^acr-b5-[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u, requestText: B5_REQUEST_TEXT,
  recipes: B5_RECIPES, requiredRisk: B5_REQUIRED_RISK, protectedTests: B5_PROTECTED_TESTS,
  validateRecipes: requireB5RecipesV1, diagnostic: runIndependentStatusCheckV1 });
export function modelEvalProfileV1(pin: ModelEvalPythonPinV1) {
  return Object.freeze({ id: "model-eval" as const, rootName: MODEL_EVAL_ROOT, requestText: MODEL_EVAL_REQUEST,
    recipes: modelEvalRecipesV1(pin.path), requiredRisk: MODEL_EVAL_RISK, protectedTests: MODEL_EVAL_PROTECTED,
    validateRecipes: (checks: unknown, root: string) => requireModelEvalRecipesV1(checks, root, pin),
    diagnostic: runModelEvalDiagnosticV1, validateInputs: validateModelEvalFrozenInputsV1, verifySources: verifyModelEvalSourcesUnchangedV1 });
}
export type JourneyProfile = typeof FIRST_WEBSITE_PROFILE | ReturnType<typeof modelEvalProfileV1>;
export function modelEvalStageConstantsV1(pin: ModelEvalPythonPinV1) {
  return { profile: "model-eval", recipes: modelEvalRecipesV1(pin.path), risk: MODEL_EVAL_RISK, python: pin };
}
export async function resolveJourneyProfileV1(root: string, selection?: string): Promise<JourneyProfile> {
  if (selection !== undefined && !["first-website", "model-eval"].includes(selection)) refuse("B11_PROFILE_MISMATCH");
  const file = join(root, "config/model-eval-profile.json");
  const exists = await lstat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
  if (!exists) {
    if (selection === "model-eval" || MODEL_EVAL_ROOT.test(root.slice(dirname(root).length + 1))) refuse("B11_PROFILE_MISMATCH");
    return FIRST_WEBSITE_PROFILE;
  }
  try {
    const bytes = await readFirstWebsitePrivateBytesV1(file, root);
    const handoff = JSON.parse((await readFirstWebsitePrivateBytesV1(join(root, "config/b5-handoff.json"), root)).toString());
    if (handoff.hashes?.["config/model-eval-profile.json"] !== b5Bytes(bytes).slice(7)) refuse("B11_PROFILE_MISMATCH");
    const packet = modelEvalProfilePacketSchemaV1.parse(JSON.parse(bytes.toString()));
    for (const name of ["config/under-evaluation.json", "config/b11-source-state-before.json"]) {
      const input = await readFirstWebsitePrivateBytesV1(join(root, name), root);
      if (handoff.hashes?.[name] !== b5Bytes(input).slice(7)) refuse("B11_PROFILE_MISMATCH");
    }
    if (selection !== undefined && selection !== packet.id) refuse("B11_PROFILE_MISMATCH");
    return modelEvalProfileV1(packet.python);
  } catch (error) { if (error instanceof B5RefusalV1) throw error; return refuse("B11_PROFILE_MISMATCH"); }
}

type RosterRow = { name: string; launcher: string };
export function requireModelEvalAdmissionV1(settings: unknown, availability: unknown, rows: RosterRow[], input: unknown,
  identities: unknown = []) {
  const packet = z.object({ schemaVersion: z.literal(1), models: z.array(z.string()) }).strict().safeParse(input);
  const names = new Map(rows.map(row => [row.name, row.launcher]));
  if (!packet.success || new Set(packet.data.models).size !== packet.data.models.length
    || packet.data.models.some(name => !names.has(name))) refuse("B11_UNDER_EVALUATION_INPUT");
  const evaluated = new Set(packet.data.models);
  function inspect(value: any) {
    if (value.route === "ollama" || names.get(value.model ?? value.identity) === "ollama") refuse("B11_LOCAL_MODEL_REFUSED");
    if (evaluated.has(value.model ?? value.identity)) refuse("B11_MODEL_UNDER_EVALUATION");
  }
  function slots(value: any): void {
    if (Array.isArray(value)) value.forEach(slots);
    else if (value && typeof value === "object") {
      if ("model" in value || "identity" in value) inspect(value);
      else Object.values(value).forEach(slots);
    }
  }
  slots((settings as any)?.roles); slots(identities);
  const entries = (availability as any)?.entries;
  if (!Array.isArray(entries)) refuse("B11_UNDER_EVALUATION_INPUT");
  for (const entry of entries) { if (!entry || typeof entry !== "object") refuse("B11_UNDER_EVALUATION_INPUT"); if (entry.available !== false) inspect(entry); }
}
export async function validateModelEvalFrozenInputsV1(root: string, settings: unknown, availability: unknown, identities?: unknown) {
  const packet = modelEvalProfilePacketSchemaV1.parse(JSON.parse((await readFirstWebsitePrivateBytesV1(join(root, "config/model-eval-profile.json"), root)).toString()));
  if (await modelEvalProtectedDigestV1(join(root, "work/repo")) !== packet.protectedTestsDigest
    || await modelEvalTreeDigestV1(join(root, "lead/skills-src")) !== packet.skillsTreeDigest) refuse("B5_PROTECTED_TEST_CHANGED");
  const roster = (await readFirstWebsitePrivateBytesV1(join(root, "tools/loop/models.tsv"), root)).toString().trimEnd().split("\n");
  const columns = roster.shift()!.replace(/^#\s*/u, "").split("\t");
  const rows = roster.filter(line => line && !line.startsWith("#")).map(line => {
    const fields = line.split("\t"); return { name: fields[columns.indexOf("name")], launcher: fields[columns.indexOf("launcher")] };
  });
  let input: unknown;
  try { input = JSON.parse((await readFirstWebsitePrivateBytesV1(join(root, "config/under-evaluation.json"), root)).toString()); }
  catch { refuse("B11_UNDER_EVALUATION_INPUT"); }
  requireModelEvalAdmissionV1(settings, availability, rows, input, identities);
  const project = (settings as any)?.project;
  if (!Array.isArray(project?.outputs) || project.outputs.some((name: unknown) => typeof name !== "string" || isAbsolute(name)
    || name.split("/").some(part => !part || part === "." || part === ".."))) refuse("INVALID_PATH");
  if (JSON.stringify(project?.outputs) !== JSON.stringify(["bin/build_prompts.py", "DESIGN.md"])
    || JSON.stringify(project?.skills) !== "[]" || project?.host_adapter !== "local-loop") refuse("B5_REPOSITORY_BASE");
}

const sourceSchema = z.record(z.enum(["kit", "product", "tools"]), z.object({ path: z.string(), head: z.string().regex(/^[a-f0-9]{40}$/u),
  porcelain: z.string().regex(/^(?:[a-f0-9]{2})*$/u), indexSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict());
export async function verifyModelEvalSourcesUnchangedV1(root: string, comparisonFile?: string) {
  const comparisons: { label: string; unchanged: boolean; before: Record<string, string>; after?: Record<string, string> }[] = [];
  try {
    const before = sourceSchema.parse(JSON.parse((await readFirstWebsitePrivateBytesV1(join(root, "config/b11-source-state-before.json"), root)).toString()));
    if (Object.keys(before).sort().join() !== "kit,product,tools") refuse("B11_FOREIGN_WRITE");
    for (const [label, state] of Object.entries(before)) {
      const initial = { head: state.head, porcelainSha256: b5Bytes(Buffer.from(state.porcelain, "hex")).slice(7), indexSha256: state.indexSha256 };
      const comparison: typeof comparisons[number] = { label, unchanged: false, before: initial };
      comparisons.push(comparison);
      if (!isAbsolute(state.path) || await realpath(state.path) !== state.path) refuse("B11_FOREIGN_WRITE");
      const git = async (args: string[]) => (await exec("/usr/bin/git", ["-C", state.path, ...args],
        { encoding: "buffer", timeout: 30_000, maxBuffer: 8 << 20, env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })).stdout;
      const observed = { head: (await git(["rev-parse", "HEAD"])).toString().trim(),
        porcelainSha256: b5Bytes(await git(["status", "--porcelain", "--untracked-files=all"])).slice(7),
        indexSha256: b5Bytes(await git(["ls-files", "-s"])).slice(7) };
      comparison.after = observed; comparison.unchanged = JSON.stringify(observed) === JSON.stringify(initial);
    }
    if (comparisons.some(item => !item.unchanged)) refuse("B11_FOREIGN_WRITE");
  } catch { refuse("B11_FOREIGN_WRITE"); }
  finally {
    if (comparisonFile) {
      if (dirname(comparisonFile) !== join(root, "evidence")) refuse("B11_FOREIGN_WRITE");
      await writeFile(comparisonFile, JSON.stringify({ comparisons }) + "\n", { flag: "wx", mode: 0o600 });
    }
  }
}

export function parseModelEvalUnittestV1(output: string) {
  const summaries = [...output.matchAll(/^Ran (\d+) tests? in [0-9.]+s\s*$/gmu)];
  if (summaries.length !== 1) refuse("B11_BASELINE_GATE");
  const match = summaries[0], tail = output.slice(match.index! + match[0].length).trim();
  const outcome = /^(OK|FAILED)(?: \(([^\n]*)\))?(?:\r?\nRESULT: (PASS|FAIL)(?: \((\d+) checks\))?)?$/u.exec(tail);
  if (!outcome || (outcome[2] && !/^(?:failures|errors|skipped|expected failures|unexpected successes)=\d+(?:, (?:failures|errors|skipped|expected failures|unexpected successes)=\d+)*$/u.test(outcome[2]))) refuse("B11_BASELINE_GATE");
  if (outcome[3] && (outcome[3] !== (outcome[1] === "OK" ? "PASS" : "FAIL")
    || outcome[4] !== undefined && Number(outcome[4]) !== Number(match[1]))) refuse("B11_BASELINE_GATE");
  const pairs = [...(outcome[2] ?? "").matchAll(/(failures|errors|skipped|expected failures|unexpected successes)=(\d+)/gu)];
  const fields = Object.fromEntries(pairs.map(item => [item[1], Number(item[2])]));
  const completed = Number(match[1]), skipped = (fields.skipped ?? 0) + (fields["expected failures"] ?? 0),
    failed = (fields.failures ?? 0) + (fields.errors ?? 0) + (fields["unexpected successes"] ?? 0);
  if (pairs.length !== Object.keys(fields).length || completed <= 0 || completed < skipped + failed
    || (outcome[1] === "OK") !== (failed === 0)) refuse("B11_BASELINE_GATE");
  return { completed, passed: completed - skipped - failed, failed, skipped };
}
export function modelEvalCheckRecordSchemaV1(pin: ModelEvalPythonPinV1) {
  return z.object({ label: z.literal("B11 independent diagnostic evidence; not an A2 receipt"), recipe: z.literal("lean-isolation"),
    argv: z.array(z.string()).refine(argv => JSON.stringify(argv) === JSON.stringify(modelEvalRecipesV1(pin.path)[2].argv)),
    head: z.string().regex(/^[a-f0-9]{40}$/u), protectedTestsDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    startedAt: z.string().datetime(), endedAt: z.string().datetime(), durationMs: z.number().int().nonnegative(), exitCode: z.number().int(),
    completed: z.number().int().positive(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
    outputPath: z.string().min(1).max(256), outputSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).strict();
}

export async function modelEvalTreeDigestV1(root: string) {
  const result = createHash("sha256");
  async function visit(folder: string): Promise<void> {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name === "__pycache__") continue;
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) refuse("B5_PROTECTED_TEST_CHANGED");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.update(path.slice(root.length + 1) + "\0").update(await readFile(path)).update("\0");
    }
  }
  await visit(root); return result.digest("hex");
}
export async function modelEvalProtectedDigestV1(repo: string) {
  const result = createHash("sha256");
  for (const name of [...MODEL_EVAL_PROTECTED].sort()) result.update(name + "\0")
    .update(await readFirstWebsitePrivateBytesV1(join(repo, name), repo)).update("\0");
  return result.digest("hex");
}
export async function runModelEvalDiagnosticV1(root: string, repo: string, outputPath: string, pin: ModelEvalPythonPinV1) {
  if (isAbsolute(outputPath) || outputPath.split("/").some(part => !part || part === "." || part === "..")) refuse("INVALID_PATH");
  if (dirname(join(root, outputPath)) !== join(root, "evidence")) refuse("INVALID_PATH");
  await requireModelEvalPythonV1(pin);
  const packet = modelEvalProfilePacketSchemaV1.parse(JSON.parse((await readFirstWebsitePrivateBytesV1(join(root, "config/model-eval-profile.json"), root)).toString()));
  if (packet.python.path !== pin.path || packet.python.sha256 !== pin.sha256) refuse("B5_RECIPE_MISMATCH");
  const protectedTestsDigest = await modelEvalProtectedDigestV1(repo);
  if (protectedTestsDigest !== packet.protectedTestsDigest) refuse("B5_PROTECTED_TEST_CHANGED");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C", LANG: "C", PYTHONDONTWRITEBYTECODE: "1" };
  const options = { cwd: repo, env: env as unknown as NodeJS.ProcessEnv, encoding: "utf8" as const, timeout: 240_000, maxBuffer: 4 << 20 };
  const guardEnv = { ...env, ...(process.env.MODEL_EVAL_MODEL_SIDE === "1" ? { MODEL_EVAL_MODEL_SIDE: "1" } : {}) } as unknown as NodeJS.ProcessEnv;
  await exec(pin.path, ["-I", "-B", "-c", "import importlib.util;from pathlib import Path;p=Path('bin/runner_guard.py').resolve();s=importlib.util.spec_from_file_location('guard',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.require_runner()"], { ...options, env: guardEnv })
    .catch(() => refuse("B11_RUNNER_GUARD"));
  const head = (await exec("/usr/bin/git", ["rev-parse", "HEAD"], options)).stdout.trim();
  const startedAt = new Date().toISOString(), start = Date.now(), argv = modelEvalRecipesV1(pin.path)[2].argv as string[];
  let stdout = "", stderr = "", exitCode = 0;
  try { ({ stdout, stderr } = await exec(pin.path, argv.slice(1), options)); }
  catch (error: any) {
    if (!Number.isInteger(error.code) || error.killed || error.signal) refuse("B11_BASELINE_GATE");
    stdout = error.stdout; stderr = error.stderr; exitCode = error.code;
  }
  const output = stdout + stderr, counts = parseModelEvalUnittestV1(output);
  if ((exitCode === 0) !== (counts.failed === 0) || counts.skipped !== 0) refuse("B11_BASELINE_GATE");
  if ((await exec("/usr/bin/git", ["rev-parse", "HEAD"], options)).stdout.trim() !== head
    || await modelEvalProtectedDigestV1(repo) !== protectedTestsDigest) refuse("B5_PROTECTED_TEST_CHANGED");
  await readFirstWebsitePrivateBytesV1(join(root, "config/model-eval-profile.json"), root);
  // Validate the already-owned directory before creating a new retained output.
  if (await realpath(dirname(join(root, outputPath))) !== join(root, "evidence")) refuse("INVALID_PATH");
  await writeFile(join(root, outputPath), output, { flag: "wx", mode: 0o600 });
  const record = modelEvalCheckRecordSchemaV1(pin).parse({ label: "B11 independent diagnostic evidence; not an A2 receipt", recipe: "lean-isolation", argv,
    head, protectedTestsDigest: `sha256:${protectedTestsDigest}`, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - start,
    exitCode, ...counts, outputPath, outputSha256: b5Bytes(output) });
  return { record, output };
}
