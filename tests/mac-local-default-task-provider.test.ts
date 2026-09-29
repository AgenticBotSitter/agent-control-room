import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as provider from "../src/web/v1/mac-local-default-task-provider";
import { MAC_LOCAL_TASK_PROVIDER_V1, MAC_LOCAL_THREE_AGENT_KINDS_V1 } from "../src/web/v1/mac-local-task-provider";

test("default Mac-local provider exposes the exact three-worker provider contract", () => {
  assert.deepEqual(Object.keys(provider).sort(), ["createTaskApplication", "schema", "workerKinds"]);
  assert.equal(provider.schema, MAC_LOCAL_TASK_PROVIDER_V1);
  assert.deepEqual(provider.workerKinds, MAC_LOCAL_THREE_AGENT_KINDS_V1);
  assert.equal(typeof provider.createTaskApplication, "function");
});

test("each Mac-local worker is wired to its own per-task model projection", () => {
  // The provider is a composition root: it never appears in a functional test,
  // because driving it needs the live protected layout. Its one guardable
  // decision is which worker gets which projection, and a swap here would run
  // every task for that worker under a different model. The mapping itself is
  // covered behaviourally in tests/mac-local-task-model-selection.test.ts; this
  // pins that the composition actually uses that mapping, once per worker, with
  // the worker name and the projection argument agreeing.
  const source = readFileSync("src/web/v1/mac-local-default-task-provider.ts", "utf8");
  const calls = [...source.matchAll(/macLocalWorkerModelSelectionV1\("([a-z-]+)", selectedModel\)/g)];
  assert.deepEqual(calls.map(call => call[1]), ["hermes", "claude-code", "codex"],
    "one projection per worker, in the order the three executors are built");
  // Each call sits inside that worker's own executor configuration, gated on
  // that worker actually declaring a protected model policy.
  for (const [index, kind] of (["hermes", "claude-code", "codex"] as const).entries()) {
    const workers = /workers\[(\d)\]!\.worker\.modelPolicy \? \{ select: macLocalWorkerModelSelectionV1\("([a-z-]+)", selectedModel\) \}/g;
    const found = [...source.matchAll(workers)].find(match => match[2] === kind);
    assert.ok(found, `${kind} must gate its projection on its own model policy`);
    assert.equal(found[1], String(index), `${kind} must be built from its own slot in the worker list`);
  }
  // The per-task selection is a real dependency of every worker: a worker whose
  // policy exists must get a `select`, not the fixed protected configuration.
  assert.equal([...source.matchAll(/worker\.modelPolicy \? \{ select:/g)].length, 3);
  assert.equal([...source.matchAll(/createMacLocalSelectedTaskModelV1\(\{ read: readPool\.client, tenantId, catalog: modelCatalog \}\)/g)].length, 1,
    "the closure is built once, from this tenant's own coordinator read and this host's protected catalog");
});
