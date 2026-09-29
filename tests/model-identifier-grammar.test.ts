import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_IDENTIFIER_PATTERN_V1 } from "../src/domain/v1/model-identifier";
import { createTaskHttpHandler } from "../src/web/v1/task-http";
import { captureTaskModelCatalogV1, resolveTaskModelV1, validateRequestedTaskModelV1 } from "../src/web/v1/task-model-selection";
import { WebTaskService } from "../src/web/v1/task-service";
import { taskDraftSchema } from "../src/web/v1/task-wire";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, captureOwnerTrustedLocalEnablementV1 } from "../src/harness/v1/owner-trusted-local-enablements";
import { createOwnerTrustedLocalCodexExecV1 } from "../src/harness/codex-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalClaudeExecV1 } from "../src/harness/claude-code-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalHermesExecV1 } from "../src/harness/hermes-local-v1/owner-trusted-local-exec";
import { now, origin, request, trust } from "./helpers/web-foundation";
import { taskFixture } from "./helpers/web-task";

/** Every value here is either a leading flag, whitespace, a quote, a shell
 * metacharacter, or out of the 1..180 length band. None can be an argument of a
 * reviewed CLI invocation, so the shared grammar must refuse all of them. */
const HOSTILE = Object.freeze([
  { name: "leading dash", value: "-x" },
  { name: "long flag", value: "--dangerously-skip-permissions" },
  { name: "flag with a value", value: "-oProxyCommand=id" },
  { name: "inner space", value: "a b" },
  { name: "double quote", value: 'a"b' },
  { name: "single quote", value: "a'b" },
  { name: "backtick", value: "a`b" },
  { name: "semicolon", value: "a;b" },
  { name: "shell substitution", value: "a$(id)b" },
  { name: "pipe", value: "a|b" },
  { name: "redirect", value: "a>b" },
  { name: "newline", value: "a\nb" },
  { name: "carriage return", value: "a\rb" },
  { name: "tab", value: "a\tb" },
  { name: "null byte", value: "a\u0000b" },
  { name: "ampersand", value: "a&b" },
  { name: "leading space", value: " a" },
  { name: "trailing space", value: "a " },
  { name: "empty", value: "" },
  { name: "over the 180 bound", value: `a${"b".repeat(180)}` },
  { name: "wildcard", value: "*" },
  { name: "brace", value: "a{b}" },
  { name: "tilde home", value: "~root" },
]);

const GRAMMAR_ACCEPTED = Object.freeze(["gpt-build", "model.one", "vendor/model:tag+build-2", "x".repeat(180)]);

const catalog = captureTaskModelCatalogV1([
  { kind: "codex", policy: { models: ["gpt-build", "model.one"], defaultModel: "gpt-build",
    efforts: ["medium", "high"], defaultEffort: "medium" } },
  { kind: "claude-code", policy: { models: ["sonnet"], defaultModel: "sonnet",
    efforts: ["high"], defaultEffort: "high" } },
  { kind: "hermes", policy: { profiles: [{ name: "build", provider: "provider-one", model: "model-one" }],
    defaultProfile: "build", efforts: ["default"], defaultEffort: "default" } },
]);

test("the shared grammar refuses every hostile identifier and accepts the listed shapes", () => {
  for (const { value } of HOSTILE) assert.equal(MODEL_IDENTIFIER_PATTERN_V1.test(value), false, JSON.stringify(value));
  for (const value of GRAMMAR_ACCEPTED) assert.equal(MODEL_IDENTIFIER_PATTERN_V1.test(value), true, value);
  // The bound is part of the guard: 180 characters pass, 181 do not.
  assert.equal(MODEL_IDENTIFIER_PATTERN_V1.test("x".repeat(180)), true);
  assert.equal(MODEL_IDENTIFIER_PATTERN_V1.test("x".repeat(181)), false);
});

test("the task wire refuses a hostile model before it can become a stored row", () => {
  for (const { name, value } of HOSTILE) assert.equal(taskDraftSchema.safeParse({
    title: "Compare two launch ideas", instructions: "Return a short recommendation.", model: value }).success, false, name);
  // A hostile effort is refused by its own closed set, not by the identifier grammar.
  for (const value of ["-x", "high ", "DEFAULT", ""]) assert.equal(taskDraftSchema.safeParse({
    title: "Compare two launch ideas", instructions: "Return a short recommendation.", effort: value }).success, false, value);
  assert.equal(taskDraftSchema.safeParse({ title: "Compare two launch ideas",
    instructions: "Return a short recommendation.", model: "gpt-build", effort: "high" }).success, true);
});

test("protected enablement refuses a hostile model, provider, or profile value", () => {
  const worker = { workerId: "worker:codex", kind: "codex" as const, executablePath: "/Applications/Codex.app/Contents/MacOS/codex",
    recordedVersion: "codex 0.155.0" };
  for (const { name, value } of HOSTILE) {
    for (const policy of [{ models: [value], defaultModel: value, efforts: ["medium"], defaultEffort: "medium" as const },
      { models: ["gpt-build", value], defaultModel: "gpt-build", efforts: ["medium"], defaultEffort: "medium" as const }])
      assert.throws(() => captureOwnerTrustedLocalEnablementV1({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1,
        mode: "mac-local", nodeId: "mac-1", workers: [{ ...worker, modelPolicy: policy }] }), /owner_trusted_local_enablement_invalid/, name);
    assert.throws(() => captureOwnerTrustedLocalEnablementV1({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1,
      mode: "mac-local", nodeId: "mac-1", workers: [{ workerId: "worker:hermes-worker", kind: "hermes" as const,
        executablePath: "/usr/local/bin/hermes", recordedVersion: "hermes 1.0.0", modelPolicy: { profiles: [{ name: "build",
          provider: value, model: "model-one" }], defaultProfile: "build", efforts: ["default"], defaultEffort: "default" } }] }),
    /owner_trusted_local_enablement_invalid/, name);
  }
  // A listed identifier still captures, so the refusal above is the value and not the shape.
  const captured = captureOwnerTrustedLocalEnablementV1({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local",
    nodeId: "mac-1", workers: [{ ...worker, modelPolicy: { models: ["gpt-build"], defaultModel: "gpt-build",
      efforts: ["medium"], defaultEffort: "medium" } }] });
  const policy = captured.workers[0]!.modelPolicy;
  assert.equal(policy && "models" in policy ? policy.models[0] : undefined, "gpt-build");
});

test("every executor refuses a hostile identifier before any process is spawned", async () => {
  const workingDirectory = process.cwd();
  const executablePath = process.execPath;
  for (const name of ["codex", "claude", "hermes"] as const) {
    for (const { name: caseName, value } of HOSTILE) {
      let spawned = 0, listed = 0;
      const dependencies = { async readDirectory() { listed++; return []; },
        spawn() { spawned++; throw new Error("must_not_spawn"); } };
      const executor = name === "codex" ? createOwnerTrustedLocalCodexExecV1(dependencies)
        : name === "claude" ? createOwnerTrustedLocalClaudeExecV1(dependencies)
          : createOwnerTrustedLocalHermesExecV1(dependencies);
      const base = { executablePath, workingDirectory, deadlineMs: 10_000, prompt: "hello" };
      const input = name === "hermes" ? { ...base, profile: "build", provider: value, model: value }
        : { ...base, model: value, effort: "high", ...(name === "claude" ? { supportsEffort: true } : {}) };
      const result = await executor.execute(input as never);
      assert.equal(result.status, "failed", `${name} ${caseName}`);
      assert.equal(result.status === "failed" ? result.reason : "", "invalid_input", `${name} ${caseName}`);
      assert.equal(spawned, 0, `${name} ${caseName} must refuse before spawn`);
      // The refusal happens in the input guard, so the working directory is never even listed.
      assert.equal(listed, 0, `${name} ${caseName} must refuse before any filesystem access`);
    }
  }
});

test("a task HTTP proposal with a hostile model writes no task and no selection row", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const service = new WebTaskService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => now,
    { modelCatalog: catalog });
  const handler = createTaskHttpHandler({ origin, trust, service, clock: () => now });
  let index = 0;
  for (const { name, value } of HOSTILE) {
    const response = await handler(request(f.path, "POST", { title: "Compare two launch ideas",
      instructions: "Compare the audience, effort and useful next steps.", model: value }, `model-grammar-${String(index++).padStart(3, "0")}`));
    assert.equal(response.status, 400, name);
  }
  assert.equal((await f.client.query("SELECT id FROM control_jobs")).rows.length, 0);
  assert.equal((await f.client.query("SELECT job_id FROM control_task_model_selections")).rows.length, 0);
});

test("a hostile identifier cannot pass the allowlist oracle either", () => {
  for (const { name, value } of HOSTILE) assert.throws(() => validateRequestedTaskModelV1(catalog, { model: value, effort: "medium" }),
    /task_model_selection_refused/, name);
  for (const { name, value } of HOSTILE) assert.throws(() => resolveTaskModelV1(catalog, "hermes", { model: value }),
    /task_model_selection_refused/, name);
  assert.deepEqual(resolveTaskModelV1(catalog, "codex", { model: "model.one", effort: "high" }),
    { workerKind: "codex", selectionKey: "model.one", model: "model.one", effort: "high", usesMoreClaudeLimit: false });
});
