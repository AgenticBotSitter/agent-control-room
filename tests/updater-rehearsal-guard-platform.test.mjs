// R5V-08 follow-up (m-r5v08b): the rehearsal harness is the SECOND call site that
// spawns the real Mac-only rescue guard, and it was ungated. These tests run on
// ANY host by reporting `process.platform` as "linux" -- the same seam
// tests/updater-journal-linux.test.mjs uses -- so the gate itself is exercised on
// this Mac rather than only being trusted to work on an Ubuntu runner.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { REHEARSAL_CASES_V1, REHEARSAL_GUARD_PLATFORM_PENDING_V1, rehearsalScenarioPendingV1 }
  from "../src/updater/v1/rehearsal/catalog.mjs";
import { parseRehearsalConfigV1 } from "../src/updater/v1/rehearsal/config.mjs";
import { GUARD_HOST_CODE_V1 } from "../src/updater/v1/rehearsal/scenarios.mjs";

const GUARD_SCENARIOS = ["P9.all-links-revert", "P11.rescue-code-points", "P11.failed-heartbeat-links"];

async function fixture(t) {
  const root = join("/private/tmp", `control-room-rehearsal-guard-platform-${randomUUID()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = parseRehearsalConfigV1({ schema: "control-room.updater-rehearsal-config/v1", mode: "throwaway",
    rehearsalRoot: root, rehearsalHostname: "unit-rehearsal.invalid",
    expectedOrigin: "https://unit-rehearsal.invalid:59400",
    ports: { web: 59400, gateway: 59410, postgres: 59420 },
    accounts: { service: "_rehearsal_service", database: "_rehearsal_database", builder: "_rehearsal_builder" },
    daemonLabelPrefix: "xyz.agentcontrolroom.rehearsal.unit", allowRealRoot: false });
  return { root, config };
}

function selectedCases(...ids) {
  const wanted = new Set(ids);
  return REHEARSAL_CASES_V1.map(phase => ({ ...phase,
    scenarios: phase.scenarios.filter(scenario => wanted.has(scenario.id)) }))
    .filter(phase => phase.scenarios.length > 0);
}

/** Report the host as Linux for the duration of `body`, exactly as
 * tests/updater-journal-linux.test.mjs does, and restore it afterwards. */
async function asLinuxHost(body) {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...real, value: "linux", configurable: true });
  try { return await body(); }
  finally { Object.defineProperty(process, "platform", real); }
}

test("the three guard scenarios are Mac-only and name their unblocking item", () => {
  for (const id of GUARD_SCENARIOS) {
    const scenario = REHEARSAL_CASES_V1.flatMap(phase => phase.scenarios).find(item => item.id === id);
    assert.ok(scenario, `${id} is in the catalog`);
    assert.equal(scenario.requiresMacHost, true, id);
    assert.equal(scenario.pending, undefined, `${id} must not be pending on the Mac`);
    assert.equal(scenario.unavailable, REHEARSAL_GUARD_PLATFORM_PENDING_V1, id);
  }
  // Every scenario that runs the real guard is marked, not just the three named.
  for (const phase of REHEARSAL_CASES_V1)
    for (const scenario of phase.scenarios)
      if (["guard_all_links", "guard_rescue_points"].includes(scenario.implementation))
        assert.equal(scenario.requiresMacHost, true, `${scenario.id} runs the Mac-only guard`);
});

test("a non-Mac host reports every guard scenario pending with its stated reason", async () => {
  await asLinuxHost(async () => {
    for (const phase of REHEARSAL_CASES_V1)
      for (const scenario of phase.scenarios)
        if (scenario.requiresMacHost === true) {
          assert.equal(rehearsalScenarioPendingV1(scenario), REHEARSAL_GUARD_PLATFORM_PENDING_V1,
            `${scenario.id} names its unblocking item`);
          assert.match(rehearsalScenarioPendingV1(scenario), /items? \d/u,
            `${scenario.id} pending reason names a numbered design item`);
        }
  });
  // The portable cases keep no platform requirement at all.
  for (const id of ["P6.lease-burst", "P2.torn-pair-switch", "P8.known-good-injection"])
    assert.equal(REHEARSAL_CASES_V1.flatMap(phase => phase.scenarios)
      .find(item => item.id === id).requiresMacHost, undefined, id);
  assert.equal(rehearsalScenarioPendingV1({}), undefined, "an ordinary scenario is never gated");
});

test("on this Mac the guard scenarios are runnable, so the gate is not over-broad", () => {
  if (process.platform !== "darwin") return;
  for (const phase of REHEARSAL_CASES_V1)
    for (const scenario of phase.scenarios)
      if (scenario.requiresMacHost === true) {
        assert.equal(rehearsalScenarioPendingV1(scenario), undefined, scenario.id);
        assert.equal(scenario.pending, undefined, scenario.id);
      }
});

test("a non-Mac host skips the guard scenarios instead of failing them, and runs the portable ones", {
  timeout: 120_000,
}, async t => {
  const { config } = await fixture(t);
  const { runUpdaterRehearsalV1 } = await import("../src/updater/v1/rehearsal/harness.mjs");
  const result = await asLinuxHost(() => runUpdaterRehearsalV1(config,
    { cases: selectedCases(...GUARD_SCENARIOS, "P6.lease-burst", "P8.known-good-injection") }));
  assert.equal(result.failed, 0, "no guard scenario may fail on a non-Mac host");
  const rows = new Map(result.phases.flatMap(phase => phase.scenarios).map(row => [row.id, row]));
  for (const id of GUARD_SCENARIOS) {
    const row = rows.get(id);
    assert.equal(row.status, "pending", `${id} is pending, not pass or fail`);
    assert.equal(row.reason, REHEARSAL_GUARD_PLATFORM_PENDING_V1, id);
    assert.equal(row.detail, undefined, `${id} asserts nothing it did not run`);
  }
  assert.equal(rows.get("P6.lease-burst").status, "pass", "portable checks still run");
  assert.equal(rows.get("P8.known-good-injection").status, "pass", "portable checks still run");
  // The pending reason is written to the evidence, not just to memory.
  const evidence = JSON.parse(await readFile(join(result.runRoot, "P9", "scenarios",
    "P9.all-links-revert", "result.json"), "utf8"));
  assert.equal(evidence.status, "pending");
  assert.match(evidence.reason, /guard_refused:unsupported_platform/u);
});

test("the harness still refuses to promote a pending phase, so a Linux run is not acceptance-ready", {
  timeout: 120_000,
}, async t => {
  const { config } = await fixture(t);
  const { runUpdaterRehearsalV1 } = await import("../src/updater/v1/rehearsal/harness.mjs");
  const result = await asLinuxHost(() => runUpdaterRehearsalV1(config,
    { cases: selectedCases(...GUARD_SCENARIOS, "P6.lease-burst") }));
  assert.equal(result.failed, 0);
  for (const id of ["P9", "P11"]) {
    const phase = result.phases.find(item => item.id === id);
    assert.equal(phase.status, "pending", id);
    assert.equal(phase.counts.pass, 0, id);
  }
  assert.equal(result.pending, GUARD_SCENARIOS.length);
  assert.equal(result.acceptanceReady, false, "a skipped guard case is never acceptance-ready");
});

test("the scenario implementation refuses by name if the catalog's gate is ever bypassed", async t => {
  // The catalog gate is the visible skip; this is the defence in depth. Without
  // it, a catalog edit or a direct implementation call would spawn the real guard
  // on a host it refuses to run on, and the scenario would report a bare
  // assertion failure instead of the named refusal.
  await asLinuxHost(async () => {
    const { REHEARSAL_IMPLEMENTATIONS_V1 } = await import("../src/updater/v1/rehearsal/scenarios.mjs");
    const { root, config } = await fixture(t), work = join(root, "work");
    await mkdir(work, { recursive: true });
    for (const name of ["guard_all_links", "guard_rescue_points"]) {
      await assert.rejects(REHEARSAL_IMPLEMENTATIONS_V1[name]({ work, config }),
        error => error.code === GUARD_HOST_CODE_V1 && /guard_refused:unsupported_platform/u.test(error.message), name);
    }
  });
});

test("on this Mac the real guard scenarios still pass through the same implementations", {
  timeout: 120_000, skip: process.platform === "darwin" ? false : "requires the macOS rescue guard",
}, async t => {
  const { config } = await fixture(t);
  const { runUpdaterRehearsalV1 } = await import("../src/updater/v1/rehearsal/harness.mjs");
  const result = await runUpdaterRehearsalV1(config, { cases: selectedCases(...GUARD_SCENARIOS) });
  assert.equal(result.failed, 0, "the guard scenarios are unchanged on the Mac");
  assert.equal(result.pending, 0, "on the Mac these cases are runnable, not pending");
  assert.equal(result.passed, GUARD_SCENARIOS.length);
});