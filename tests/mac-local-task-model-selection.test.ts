import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMacLocalSelectedTaskModelV1, macLocalClaudeModelSelectionV1,
  macLocalCodexModelSelectionV1, macLocalHermesModelSelectionV1,
  macLocalWorkerModelSelectionV1 } from "../src/web/v1/mac-local-task-model-selection";
import { captureTaskModelCatalogV1 } from "../src/web/v1/task-model-selection";
import { createOwnerTrustedLocalCodexExecV1 } from "../src/harness/codex-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalClaudeExecV1, OWNER_TRUSTED_LOCAL_CLAUDE_ARGS_V1 } from "../src/harness/claude-code-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalHermesExecV1, OWNER_TRUSTED_LOCAL_HERMES_FIXED_ARGS_V1 } from "../src/harness/hermes-local-v1/owner-trusted-local-exec";
import { createOwnerTrustedLocalCodexExecutionAdapterV1, createOwnerTrustedLocalClaudeExecutionAdapterV1 }
  from "../src/harness/v1/owner-trusted-local-cli-execution";
import { createOwnerTrustedLocalHermesExecutionAdapterV1 } from "../src/harness/hermes-local-v1/owner-trusted-local-execution";

/** The real stored row, the real selection closure, the real execution adapter
 * and the real executor argument builders, driven from one prepared job each.
 * Only the CLI process itself is the existing fake. */
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const fakes = {
  codex: join(fixtureDirectory, "fixtures", "codex-owner-trusted-local-exec-fake.mjs"),
  claude: join(fixtureDirectory, "fixtures", "claude-owner-trusted-local-exec-fake.mjs"),
  hermes: join(fixtureDirectory, "fixtures", "hermes-owner-trusted-local-exec-fake.mjs"),
} as const;
type WorkerKind = keyof typeof fakes;
const tenantId = "tenant:test", jobId = "job:prepared";

const catalog = captureTaskModelCatalogV1([
  { kind: "codex", policy: { models: ["gpt-build", "gpt-check", "shared-model"], defaultModel: "gpt-build",
    efforts: ["medium", "high"], defaultEffort: "medium" } },
  { kind: "claude-code", policy: { models: ["sonnet", "opus", "shared-model"], defaultModel: "sonnet",
    efforts: ["high", "max"], defaultEffort: "high", limitedModels: ["opus"] } },
  { kind: "hermes", policy: { profiles: [{ name: "build", provider: "provider-one", model: "model-one" },
    { name: "check", provider: "provider-two", model: "model-two" }], defaultProfile: "build",
    efforts: ["default"], defaultEffort: "default" } },
]);

/** `shared-model` is deliberately listed for both the Codex and the Claude
 * worker with an effort both offer. A row prepared for one is therefore a
 * perfectly valid value for the other, so only the worker-kind check can refuse
 * it. This is the case that makes the check load-bearing. */
const sharedCodex = Object.freeze({ worker_kind: "codex", selection_key: "shared-model", model: "shared-model",
  effort: "high", provider: null, profile: null });

type Row = Readonly<{ worker_kind: string | null; selection_key: string | null; model: string | null;
  effort: string | null; provider: string | null; profile: string | null }>;

const codexRow = Object.freeze({ worker_kind: "codex", selection_key: "gpt-build", model: "gpt-build",
  effort: "high", provider: null, profile: null });
const claudeRow = Object.freeze({ worker_kind: "claude-code", selection_key: "opus", model: "opus",
  effort: "max", provider: null, profile: null });
const hermesRow = Object.freeze({ worker_kind: "hermes", selection_key: "check", model: "model-two",
  effort: "default", provider: "provider-two", profile: "check" });

/** A read port that answers only the one bounded selection query. The guards
 * under test are the closure's own, not the planner's writer. */
function storedRow(value: Row | undefined) {
  const queries: { statement: string; params: unknown[] }[] = [];
  return { queries, read: { async query<T>(statement: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    queries.push({ statement, params });
    return { rows: (value === undefined ? [] : [value]) as T[] };
  } } };
}
const closure = (row: Row | undefined, over = catalog) => {
  const store = storedRow(row);
  return { store, selected: createMacLocalSelectedTaskModelV1({ read: store.read as never, tenantId, catalog: over }) };
};
const refused = (error: unknown) => error instanceof Error
  && (error.message === "mac_local_task_model_selection_unavailable" || error.message === "task_model_selection_refused");
/** The row is absent, foreign, or the protected catalog no longer confirms it.
 * The closure reports the same refusal for the second case as the first, so a
 * caller cannot learn anything from which check failed. */
const refusedRow = (error: unknown) => error instanceof Error && error.message === "mac_local_task_model_selection_unavailable";
const delivery = Object.freeze({ identity: { jobId }, input: Object.freeze({ instructions: "Read only the supplied task.",
  prompt: "Return the bounded result." }) });

test("a matching resolved row reaches each executor as the exact reviewed argv", async () => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "acr-selection-argv-"));
  const captured: Partial<Record<WorkerKind, readonly string[]>> = {};
  const launch = (kind: WorkerKind) => (_file: string, args: readonly string[]) => {
    captured[kind] = args;
    return spawn(process.execPath, [fakes[kind], ...args], { cwd: workingDirectory, detached: true, shell: false,
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: Object.freeze({ HOME: process.env.HOME ?? "", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8",
        TMPDIR: process.env.TMPDIR ?? "/tmp", NODE_ENV: "test" }) });
  };
  const signal = new AbortController().signal;

  const codex = closure(codexRow);
  const codexResult = await createOwnerTrustedLocalCodexExecutionAdapterV1(
    createOwnerTrustedLocalCodexExecV1({ spawn: launch("codex") as never }), { executablePath: process.execPath,
    workingDirectory, deadlineMs: 10_000, select: macLocalCodexModelSelectionV1(codex.selected) })
    .execute({ delivery, signal });
  assert.equal(codexResult.kind, "completed");
  assert.deepEqual(captured.codex, ["exec", "--json", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
    "--color", "never", "-C", workingDirectory, "-m", "gpt-build", "-c", "model_reasoning_effort=high", "-"]);

  // A second Codex row at a different offered effort, driven through the same
  // real argument builder. `codexRow` above already used `high`, so this is
  // what makes a hard-coded `high` visible at the argv boundary, not only at
  // the projection's own return value.
  const codexMedium = closure({ ...codexRow, effort: "medium" });
  const codexMediumResult = await createOwnerTrustedLocalCodexExecutionAdapterV1(
    createOwnerTrustedLocalCodexExecV1({ spawn: launch("codex") as never }), { executablePath: process.execPath,
    workingDirectory, deadlineMs: 10_000, select: macLocalCodexModelSelectionV1(codexMedium.selected) })
    .execute({ delivery, signal });
  assert.equal(codexMediumResult.kind, "completed");
  assert.deepEqual(captured.codex, ["exec", "--json", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check",
    "--color", "never", "-C", workingDirectory, "-m", "gpt-build", "-c", "model_reasoning_effort=medium", "-"]);

  const claude = closure(claudeRow);
  const claudeResult = await createOwnerTrustedLocalClaudeExecutionAdapterV1(
    createOwnerTrustedLocalClaudeExecV1({ spawn: launch("claude") as never }), { executablePath: process.execPath,
    workingDirectory, deadlineMs: 10_000, select: macLocalClaudeModelSelectionV1(claude.selected) })
    .execute({ delivery, signal });
  assert.equal(claudeResult.kind, "completed");
  // The effort reaches argv only because the protected Claude projection always
  // carries it once startup verified the installed CLI supports it.
  assert.deepEqual(captured.claude, ["-p", "--model", "opus", "--effort", "max", ...OWNER_TRUSTED_LOCAL_CLAUDE_ARGS_V1.slice(3)]);

  const hermes = closure(hermesRow);
  const hermesResult = await createOwnerTrustedLocalHermesExecutionAdapterV1(
    createOwnerTrustedLocalHermesExecV1({ spawn: launch("hermes") as never }), { executablePath: process.execPath,
    workingDirectory, deadlineMs: 10_000, select: macLocalHermesModelSelectionV1(hermes.selected) })
    .execute({ delivery, signal });
  assert.equal(hermesResult.kind, "completed");
  assert.deepEqual(captured.hermes, ["-p", "check", ...OWNER_TRUSTED_LOCAL_HERMES_FIXED_ARGS_V1,
    "--run-budget", "10", "--in", workingDirectory, "--model", "model-two", "--provider", "provider-two"]);

  // Each worker read exactly its own row, and only the Hermes worker is ever
  // handed a profile and provider.
  for (const store of [codex.store, claude.store, hermes.store]) assert.equal(store.queries.length, 1);
});

test("the closure refuses a row for another worker, a row the catalog no longer confirms, and a missing row", async () => {
  const unvalidated: Readonly<{ name: string; row: Row | undefined; kind: "codex" | "claude-code" | "hermes" }>[] = [
    { name: "a Hermes row presented to the Codex worker", row: hermesRow, kind: "codex" },
    { name: "a Codex row presented to the Claude worker", row: codexRow, kind: "claude-code" },
    { name: "a Claude row presented to the Hermes worker", row: claudeRow, kind: "hermes" },
    // A model and effort both workers offer. Nothing about the stored value is
    // invalid for the receiving worker, so the worker-kind check is the only
    // thing standing between a prepared-for-Codex row and the Claude CLI.
    { name: "a shared Codex row presented to the Claude worker", row: sharedCodex, kind: "claude-code" },
    { name: "a shared Codex row presented to the Hermes worker", row: sharedCodex, kind: "hermes" },
    { name: "a stored model that left the catalog", row: { ...codexRow, model: "gpt-gone" }, kind: "codex" },
    { name: "a stored key that left the catalog", row: { ...codexRow, selection_key: "gpt-gone" }, kind: "codex" },
    { name: "a stored effort the worker does not offer", row: { ...codexRow, effort: "xhigh" }, kind: "codex" },
    { name: "a stored effort on a Claude row that left the set", row: { ...claudeRow, effort: "medium" }, kind: "claude-code" },
    { name: "a Hermes profile that left the catalog", row: { ...hermesRow, model: "model-gone" }, kind: "hermes" },
    { name: "a Hermes provider that left the catalog", row: { ...hermesRow, provider: "provider-gone" }, kind: "hermes" },
    { name: "a Hermes profile name that disagrees with the key", row: { ...hermesRow, profile: "build" }, kind: "hermes" },
    { name: "a proposal row the coordinator has not materialized", row: { worker_kind: null, selection_key: "gpt-build",
      model: null, effort: "high", provider: null, profile: null }, kind: "codex" },
    { name: "a job with no selection row at all", row: undefined, kind: "codex" },
  ];
  for (const { name, row, kind } of unvalidated) {
    const { store, selected } = closure(row);
    // Every one of these refusals is the same message, whether the row was
    // absent, foreign, or no longer confirmed by the catalog. A caller cannot
    // learn which check failed, and the projections below propagate it exactly.
    await assert.rejects(() => selected(kind, jobId), refusedRow, name);
    assert.equal(store.queries.length, 1, name);
    const second = closure(row);
    const projection = kind === "codex" ? macLocalCodexModelSelectionV1(second.selected)
      : kind === "claude-code" ? macLocalClaudeModelSelectionV1(second.selected) : macLocalHermesModelSelectionV1(second.selected);
    await assert.rejects(() => projection(jobId), refusedRow, name);
    assert.equal(second.store.queries.length, 1, `${name} through the executor projection`);
  }
});

test("no unvalidated stored value ever reaches a process", async () => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "acr-selection-nospawn-"));
  let spawned = 0;
  const dependencies = { async readDirectory() { return []; }, spawn() { spawned++; throw new Error("must_not_spawn"); } };
  const rows: readonly (Row | undefined)[] = [hermesRow, codexRow, claudeRow, sharedCodex, { ...codexRow, model: "gpt-gone" },
    { ...codexRow, effort: "xhigh" }, { ...hermesRow, profile: "build" }, { ...hermesRow, provider: "provider-gone" },
    { worker_kind: null, selection_key: "gpt-build", model: null, effort: "high", provider: null, profile: null } as Row, undefined];
  for (const row of rows) for (const kind of ["codex", "claude-code", "hermes"] as const) {
    if (row?.worker_kind === kind && row.selection_key && row.model && row.effort
      && (kind !== "hermes" || row.profile && row.provider)) continue;
    // Every real adapter, wired to the real closure and the real executor.
    // An unvalidated row must refuse inside the closure, so the executor is
    // never called at all and no process is started.
    const selected = createMacLocalSelectedTaskModelV1({ read: storedRow(row).read as never, tenantId, catalog });
    const base = { executablePath: process.execPath, workingDirectory, deadlineMs: 10_000 };
    const result = kind === "hermes"
      ? await createOwnerTrustedLocalHermesExecutionAdapterV1(createOwnerTrustedLocalHermesExecV1(dependencies),
        { ...base, select: macLocalHermesModelSelectionV1(selected) }).execute({ delivery, signal: new AbortController().signal })
        .catch((error: Error) => error.message)
      : kind === "codex"
        ? await createOwnerTrustedLocalCodexExecutionAdapterV1(createOwnerTrustedLocalCodexExecV1(dependencies),
          { ...base, select: macLocalCodexModelSelectionV1(selected) }).execute({ delivery, signal: new AbortController().signal })
          .catch((error: Error) => error.message)
        : await createOwnerTrustedLocalClaudeExecutionAdapterV1(createOwnerTrustedLocalClaudeExecV1(dependencies),
          { ...base, select: macLocalClaudeModelSelectionV1(selected) }).execute({ delivery, signal: new AbortController().signal })
          .catch((error: Error) => error.message);
    assert.equal(typeof result, "string", `${kind} ${JSON.stringify(row)}`);
    assert.equal(spawned, 0, `${kind} ${JSON.stringify(row)}`);
  }
  assert.equal(spawned, 0);
});

test("a flag-shaped stored value is refused even by a catalog that lists it", async () => {
  // The stored columns carry the same grammar as the wire, so this row cannot be
  // produced. Prove the closure and the executor refuse it anyway rather than
  // relying on one upstream CHECK plus one upstream writer.
  const hostile = { worker_kind: "codex", selection_key: "-m", model: "--dangerously-skip-permissions",
    effort: "high", provider: null, profile: null };
  const permissive = captureTaskModelCatalogV1([{ kind: "codex", policy: {
    models: ["--dangerously-skip-permissions"], defaultModel: "--dangerously-skip-permissions",
    efforts: ["high"], defaultEffort: "high" } }]);
  const { selected } = closure(hostile, permissive);
  const projected = await macLocalCodexModelSelectionV1(selected)(jobId).catch(() => "refused" as const);
  // The closure itself does not re-check the grammar; the executor is the last
  // boundary and it refuses, so no CLI argv can ever carry this value.
  const result = await createOwnerTrustedLocalCodexExecV1({ async readDirectory() { return []; },
    spawn() { throw new Error("must_not_spawn"); } }).execute({ executablePath: process.execPath,
    prompt: "hello", workingDirectory: process.cwd(), deadlineMs: 10_000,
    model: typeof projected === "string" ? hostile.model : projected.model, effort: "high" });
  assert.deepEqual(result, { status: "failed", reason: "invalid_input" });
});

test("each projection carries the stored value and substitutes nothing", async () => {
  // A projection that invents or substitutes a value still produces valid argv,
  // so the argv assertion alone cannot catch it. Assert the projection's own
  // return value for a row that is valid only for one worker.
  assert.deepEqual(await macLocalCodexModelSelectionV1(closure(codexRow).selected)(jobId), { model: "gpt-build", effort: "high" });
  await assert.rejects(() => macLocalClaudeModelSelectionV1(closure(sharedCodex).selected)(jobId), refused);
  assert.deepEqual(await macLocalHermesModelSelectionV1(closure(hermesRow).selected)(jobId),
    { profile: "check", provider: "provider-two", model: "model-two" });
  // The Codex projection must carry the stored model, not a hard-coded default:
  // `gpt-check` is listed and is not the worker's default.
  assert.deepEqual(await macLocalCodexModelSelectionV1(closure({ ...codexRow, model: "gpt-check", selection_key: "gpt-check" })
    .selected)(jobId), { model: "gpt-check", effort: "high" });
  // The Claude projection must carry the stored effort, not a fixed one.
  assert.deepEqual(await macLocalClaudeModelSelectionV1(closure({ ...claudeRow, model: "sonnet", selection_key: "sonnet",
    effort: "high" }).selected)(jobId), { model: "sonnet", effort: "high", supportsEffort: true });
  // The Codex projection must carry the stored effort too: the catalog offers
  // both `medium` and `high`, and `codexRow` above already uses `high`, so a
  // hard-coded `high` would pass unnoticed without this second, differing case.
  assert.deepEqual(await macLocalCodexModelSelectionV1(closure({ ...codexRow, effort: "medium" }).selected)(jobId),
    { model: "gpt-build", effort: "medium" });
});

test("each Mac-local worker gets its own projection, and only its own", async () => {
  // The provider builds one of these per worker. If the mapping ever gave the
  // Claude worker the Codex projection, or dropped a worker onto the Hermes
  // one, every task for that worker would either run a different model or fail
  // at the first row. Assert the mapping, not the three call sites.
  const rows: Readonly<Record<"codex" | "claude-code" | "hermes", Row>> = { codex: codexRow, "claude-code": claudeRow, hermes: hermesRow };
  const expected: Readonly<Record<"codex" | "claude-code" | "hermes", unknown>> = {
    codex: { model: "gpt-build", effort: "high" },
    "claude-code": { model: "opus", effort: "max", supportsEffort: true },
    hermes: { profile: "check", provider: "provider-two", model: "model-two" },
  };
  for (const [kind, row] of Object.entries(rows)) {
    const worker = kind as "codex" | "claude-code" | "hermes";
    // The overloads refuse a widened worker name, so each is spelled out. That
    // is the point: the call a reader would have to change to introduce a swap
    // is also the one that stops compiling.
    const selected = createMacLocalSelectedTaskModelV1({ read: storedRow(row).read as never, tenantId, catalog });
    const project = worker === "codex" ? macLocalWorkerModelSelectionV1("codex", selected)
      : worker === "claude-code" ? macLocalWorkerModelSelectionV1("claude-code", selected)
        : macLocalWorkerModelSelectionV1("hermes", selected);
    assert.deepEqual(await project(jobId), expected[worker], worker);
    // Every *other* worker's projection must refuse this worker's row, so a
    // swapped mapping cannot produce a value that merely looks plausible.
    for (const foreignKind of Object.keys(rows) as ("codex" | "claude-code" | "hermes")[]) {
      if (foreignKind === worker) continue;
      const foreign = createMacLocalSelectedTaskModelV1({ read: storedRow(row).read as never, tenantId, catalog });
      const project2 = foreignKind === "codex" ? macLocalWorkerModelSelectionV1("codex", foreign)
        : foreignKind === "claude-code" ? macLocalWorkerModelSelectionV1("claude-code", foreign)
          : macLocalWorkerModelSelectionV1("hermes", foreign);
      await assert.rejects(() => project2(jobId), refusedRow, `${worker} -> ${foreignKind}`);
    }
  }
  // A worker this product does not run is refused rather than defaulted.
  for (const unknown of ["hermes-021", "codex-app-server", "", "CODEX"] as const) {
    assert.throws(() => macLocalWorkerModelSelectionV1(unknown as never, closure(codexRow).selected),
      /mac_local_task_model_selection_unavailable/, unknown);
  }
});

test("a key/model split is carried to the CLI as the model, not the key", async () => {
  // The stored row is re-resolved from `selection_key`, so `model` is derived,
  // not trusted. For a policy that maps a key to a different underlying model
  // the projection must carry the resolved model. Drive that with a Hermes
  // profile (key `check` -> model `model-two`) through the Hermes projection,
  // and a row whose key and model disagree, which must refuse rather than pick.
  const selected = createMacLocalSelectedTaskModelV1({ read: storedRow(hermesRow).read as never, tenantId, catalog });
  const resolved = await selected("hermes", jobId);
  assert.equal(resolved.selectionKey, "check");
  assert.equal(resolved.model, "model-two");
  assert.notEqual(resolved.selectionKey, resolved.model,
    "the fixture is only meaningful while the key and the model differ");
  // A row whose stored model disagrees with what its key resolves to refuses,
  // so the model the projection emits is always the catalog's, never the row's.
  const tampered = createMacLocalSelectedTaskModelV1({ read: storedRow({ ...hermesRow, model: "gpt-build" }).read as never,
    tenantId, catalog });
  await assert.rejects(() => macLocalHermesModelSelectionV1(tampered)(jobId), refusedRow);
  // The same holds for a model-based worker: `model` is the resolved value, so a
  // row naming a model its key does not resolve to is refused, not substituted.
  const splitCatalog = captureTaskModelCatalogV1([{ kind: "codex", policy: { models: ["gpt-check"], defaultModel: "gpt-check",
    efforts: ["high"], defaultEffort: "high" } }]);
  const split = createMacLocalSelectedTaskModelV1({ read: storedRow({ worker_kind: "codex", selection_key: "gpt-check",
    model: "gpt-other", effort: "high", provider: null, profile: null }).read as never, tenantId, catalog: splitCatalog });
  await assert.rejects(() => macLocalCodexModelSelectionV1(split)(jobId), refusedRow);
  assert.deepEqual(await macLocalCodexModelSelectionV1(closure(codexRow).selected)(jobId), { model: "gpt-build", effort: "high" });
});

test("a Hermes projection refuses a resolved value with no profile rather than inventing one", async () => {
  // A Hermes worker is selected by a named profile. If a resolved value ever
  // carried none, substituting a default would run a different local agent
  // under a name the owner never chose, so the projection must refuse. The
  // projection is driven directly here, because the closure's own re-verification
  // already refuses a row whose profile does not match the catalog.
  const project = macLocalHermesModelSelectionV1;
  const resolved = { workerKind: "hermes" as const, selectionKey: "check", model: "model-two", effort: "default",
    profile: "check", provider: "provider-two", usesMoreClaudeLimit: false };
  for (const stripped of [{ ...resolved, profile: undefined }, { ...resolved, provider: undefined },
    { ...resolved, profile: undefined, provider: undefined },
    { ...resolved, profile: undefined, provider: undefined, model: "gpt-build" }] as const) {
    await assert.rejects(() => project(async () => stripped)(jobId),
      /mac_local_task_model_selection_unavailable/, JSON.stringify(stripped));
  }
  // A Codex- or Claude-shaped value carries no profile at all, so it is refused
  // the same way: the Hermes worker is selected by a named profile, never a model.
  for (const other of [{ workerKind: "codex" as const, selectionKey: "gpt-build", model: "gpt-build",
    effort: "high", usesMoreClaudeLimit: false }, { workerKind: "claude-code" as const, selectionKey: "opus",
    model: "opus", effort: "max", usesMoreClaudeLimit: true }] as const) {
    await assert.rejects(() => project(async () => other)(jobId), /mac_local_task_model_selection_unavailable/);
  }
  // A fully resolved value is unaffected, so the refusals above are the missing
  // profile and provider, not the shape of the value.
  assert.deepEqual(await project(async () => resolved)(jobId),
    { profile: "check", provider: "provider-two", model: "model-two" });
});

test("the closure reads one bounded row for the claimed job and validates its own inputs", async () => {
  const { store, selected } = closure(codexRow);
  assert.deepEqual(await selected("codex", jobId), { workerKind: "codex", selectionKey: "gpt-build",
    model: "gpt-build", effort: "high", usesMoreClaudeLimit: false });
  assert.equal(store.queries.length, 1);
  assert.match(store.queries[0]!.statement, /FROM control_task_model_selections WHERE tenant_id=\$1 AND job_id=\$2/);
  for (const value of [""]) await assert.rejects(() => selected("codex", value), refused, value);
  assert.throws(() => createMacLocalSelectedTaskModelV1({ read: {} as never, tenantId, catalog }), refused);
  assert.throws(() => createMacLocalSelectedTaskModelV1({ read: { query: () => undefined } as never,
    tenantId: "", catalog }), refused);
  assert.throws(() => createMacLocalSelectedTaskModelV1({ read: storedRow(codexRow).read as never, tenantId,
    catalog: undefined as never }), refused);
});
