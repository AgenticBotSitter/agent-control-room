import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

// ESLint's lockfile-pinned YAML dependency parses the complete workflow and
// rejects duplicate mapping keys; no handwritten YAML parser or new dependency.
const require = createRequire(import.meta.resolve("eslint"));
const { load } = require("js-yaml");
const workflow = load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const baseline = JSON.parse(readFileSync(new URL("./fixtures/ci-component-steps-main.json", import.meta.url), "utf8"));
const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
const components = workflow.jobs["test-components"];
const shards = components.strategy?.matrix?.shard ?? [];
const originalChecks = baseline.job.steps.filter(step => step.if);
const setup = baseline.job.steps.filter(step => !step.if);
const chain = originalChecks.find(step => step.name === "Component lanes");
const expected = originalChecks.flatMap(step => step === chain
  ? baseline.units.map(unit => ({ name: unit.name, command: unit.command, env: chain.env }))
  : [{ name: step.name, command: step.run, env: step.env ?? {} }]);
const sort = values => [...values].sort((a, b) => a.name.localeCompare(b.name, "en"));

function selectedChecks() {
  return shards.flatMap(shard => components.steps.filter(step =>
    step.if === `\${{ !cancelled() && matrix.shard == '${shard}' }}`
    && step.name !== "Component shard workflow guard").flatMap(step => {
    const units = /^node scripts\/ci\/run-scripts-keep-going\.mjs ((?:test:[a-z0-9:.-]+ ?)+)$/u.exec(step.run)?.[1];
    return units ? units.split(" ").map(name => ({ name, command: scripts[name], env: step.env ?? {} }))
      : [{ name: step.name, command: step.run, env: step.env ?? {} }];
  }));
}

test("component shard fixture records the independently pinned main workflow", () => {
  assert.equal(baseline.source, "23fc87989feece081e9b4e8073e357d640998905");
  assert.equal(originalChecks.length, 9);
  assert.equal(baseline.units.length, 83);
  assert.equal(setup.length, 8);
});

test("five component shards run independently without cancelling their peers", () => {
  assert.deepEqual(shards, ["1", "2", "3", "4", "5"]);
  assert.deepEqual(Object.keys(components.strategy.matrix), ["shard"]);
  assert.equal(components.strategy["fail-fast"], false);
  assert.equal(components["continue-on-error"], undefined);
  assert.equal(components.strategy["max-parallel"], undefined);
});

test("component shards cover every baseline command and environment exactly once", () => {
  assert.deepEqual(sort(selectedChecks()), sort(expected));
});

test("component shard commands are not duplicated", () => {
  const names = selectedChecks().map(step => step.name);
  assert.equal(names.length, new Set(names).size, "each component command must have one owner shard");
});

test("every shard preserves setup and continues its selected checks after a failure", () => {
  assert.deepEqual(components.steps.filter(step => !step.if), setup);
  assert.equal(components["runs-on"], baseline.job["runs-on"]);
  assert.deepEqual(components.env, baseline.job.env);
  for (const step of components.steps.filter(step => step.if)) {
    assert.match(step.if, /^\$\{\{ !cancelled\(\) && matrix\.shard == '[1-5]' \}\}$/u);
    assert.equal(step["continue-on-error"], undefined);
  }
  const guard = components.steps.filter(step => step.name === "Component shard workflow guard");
  assert.equal(guard.length, 1);
  assert.equal(guard[0].run, "pnpm run test:ci-component-shards");
  assert.equal(scripts["test:ci-component-shards"], "node scripts/run-tests-with-quarantine.mjs --test tests/ci-component-shards.test.mjs");
});

test("merge gate depends on all component shards", () => {
  const gate = workflow.jobs["merge-gate"];
  // A needs edge to the matrix job waits for all its runs, rather than a
  // selected run. The fixed matrix and fail-fast tests protect that expansion.
  assert.ok(gate.needs.includes("test-components"), "merge gate must wait for every component shard");
  assert.equal(gate.if, "${{ always() }}");
});

test("merge gate refuses failed cancelled skipped and missing component results", () => {
  const gate = workflow.jobs["merge-gate"];
  assert.equal(gate.steps.length, 1);
  const source = gate.steps[0].run;
  for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
    const script = source.replace(/\$\{\{ needs\.([a-z-]+)\.result \}\}/gu,
      (_, name) => name === "test-components" ? result : "success");
    assert.doesNotMatch(script, /\$\{\{/u, "all workflow expressions must be resolved before execution");
    const run = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000, env: { ...process.env, COMPONENTS_ROUTED: "true" } });
    assert.equal(run.error, undefined);
    assert.equal(run.signal, null);
    assert.equal(run.status, result === "success" ? 0 : 1, `component result=${result}: ${run.stdout}\n${run.stderr}`);
  }
});


test("routing omits the whole matrix only when the component catch-up succeeds", () => {
  assert.equal(components.if, baseline.job.if, "routing is evaluated before matrix expansion");
  const catchUp = workflow.jobs["full-gate"].steps.find(step => step.name === "Component lanes (merge gate)");
  assert.equal(catchUp.if, "${{ !cancelled() && matrix.lane == 'components' && needs.route.result == 'success' && needs.route.outputs.components == 'false' }}");
  const gate = workflow.jobs["merge-gate"].steps[0];
  // Literal decisions and results are independent of the aggregation script.
  // Failed/cancelled/missing shards cannot borrow the catch-up's success.
  for (const component of ["failure", "cancelled", "skipped", ""]) {
    for (const route of ["success", "failure", "cancelled", "skipped", ""]) {
      for (const routed of ["true", "false", ""]) {
        for (const caughtUp of ["success", "failure", "cancelled", "skipped", ""]) {
          const script = gate.run.replace(/\$\{\{ needs\.([a-z-]+)\.result \}\}/gu,
            (_, name) => ({ "test-components": component, route, "full-gate": caughtUp }[name] ?? "success"));
          const run = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000,
            env: { ...process.env, COMPONENTS_ROUTED: routed } });
          const accepted = component === "skipped" && route === "success" && routed === "false" && caughtUp === "success";
          assert.equal(run.error, undefined);
          assert.equal(run.signal, null);
          assert.equal(run.status, accepted ? 0 : 1,
            `component=${component} route=${route} routed=${routed} catchUp=${caughtUp}: ${run.stdout}`);
        }
      }
    }
  }
  assert.deepEqual(gate.env, { COMPONENTS_ROUTED: "${{ needs.route.outputs.components }}" });
});
