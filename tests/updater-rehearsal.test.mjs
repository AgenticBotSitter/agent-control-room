import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { REHEARSAL_CASES_V1 } from "../src/updater/v1/rehearsal/catalog.mjs";
import { assertRehearsalAncestryV1, parseRehearsalConfigV1, prepareRehearsalRootV1 }
  from "../src/updater/v1/rehearsal/config.mjs";
import { runUpdaterRehearsalV1 } from "../src/updater/v1/rehearsal/harness.mjs";
import { REHEARSAL_IMPLEMENTATIONS_V1 } from "../src/updater/v1/rehearsal/scenarios.mjs";

async function fixture(t) {
  const root = join("/private/tmp", `control-room-rehearsal-test-${randomUUID()}`);
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

test("rehearsal config refuses live roots, production ports, aliases, hostile origins and unconfigured accounts", async t => {
  const { config } = await fixture(t), changed = patch => ({ ...config, ...patch });
  assert.throws(() => parseRehearsalConfigV1(changed({ rehearsalRoot: "/Library/Application Support/Control Room" })),
    /rehearsal_live_root_refused/u);
  assert.throws(() => parseRehearsalConfigV1(changed({ ports: { web: 7864, gateway: 59410, postgres: 59420 },
    expectedOrigin: "https://unit-rehearsal.invalid:7864" })), /rehearsal_ports_refused/u);
  assert.throws(() => parseRehearsalConfigV1(changed({ ports: { web: 59400, gateway: 59400, postgres: 59420 } })),
    /rehearsal_ports_refused/u);
  assert.throws(() => parseRehearsalConfigV1(changed({ expectedOrigin: "https://different-rehearsal.invalid:59400" })),
    /rehearsal_expected_origin_refused/u);
  assert.throws(() => parseRehearsalConfigV1(changed({ accounts: { ...config.accounts, service: "_service" } })),
    /rehearsal_accounts_refused/u);
  assert.throws(() => parseRehearsalConfigV1(changed({ daemonLabelPrefix: "xyz.agentcontrolroom" })),
    /rehearsal_daemon_labels_refused/u);
  assert.throws(() => parseRehearsalConfigV1(changed({ mode: "real-root", allowRealRoot: false })),
    /rehearsal_real_root_authority_refused/u);
  assert.throws(() => parseRehearsalConfigV1(changed({ mode: "real-root", allowRealRoot: true,
    rehearsalRoot: "/Volumes/CRRehearsal" })), /rehearsal_real_root_authority_refused/u);
});

test("rehearsal root requires owners and an exact marker before reuse", async t => {
  const { root, config } = await fixture(t);
  await assert.rejects(prepareRehearsalRootV1(config, { ownersEnabled: async () => false }),
    /rehearsal_disk_owners_disabled/u);
  await mkdir(root); await assert.rejects(prepareRehearsalRootV1(config), /rehearsal_root_marker_refused/u);
  await rm(root, { recursive: true }); await prepareRehearsalRootV1(config);
  const marker = JSON.parse(await readFile(join(root, ".control-room-rehearsal-root.json"), "utf8"));
  assert.equal(marker.rehearsalHostname, config.rehearsalHostname);
  await writeFile(join(root, ".control-room-rehearsal-root.json"), JSON.stringify({ ...marker,
    rehearsalHostname: "wrong-rehearsal.invalid" }));
  await assert.rejects(prepareRehearsalRootV1(config), /rehearsal_root_marker_refused/u);
});

test("real-root ancestry must be root-owned, non-writable directories without symlinks", async () => {
  const safe = { isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o40755 };
  assert.equal(await assertRehearsalAncestryV1("/Volumes/CRRehearsal/install", { lstatPath: async () => safe }), true);
  await assert.rejects(assertRehearsalAncestryV1("/Volumes/CRRehearsal/install", { lstatPath: async path =>
    path.endsWith("/install") ? { ...safe, uid: 501 } : safe }), /rehearsal_root_ancestry_refused/u);
  await assert.rejects(assertRehearsalAncestryV1("/Volumes/CRRehearsal/install", { lstatPath: async path =>
    path.endsWith("/install") ? { ...safe, mode: 0o40777 } : safe }), /rehearsal_root_ancestry_refused/u);
});

test("catalog names every v2 hostile and rescue case and keeps future items explicitly pending", () => {
  const ids = new Set(REHEARSAL_CASES_V1.flatMap(item => item.scenarios.map(scenario => scenario.id)));
  for (const id of ["P7.cron-at", "P7.adoption-race", "P7.runner-patch", "P7.export-ignore", "P7.rename",
    "P7.updater-symlink", "P7.fixed-step-wins", "P8.sudo-shim", "P8.origin-and-port",
    "P8.registration-race", "P8.approval-flood", "P8.health-auth", "P8.push-host",
    "P9.all-links-revert", "P9.pg-pin", "P11.rescue-db-points", "P11.failed-heartbeat-links",
    "P10.rescue-reboot-persistence",
    "P13.environment", "P13.profile-shape", "P13.running-identities", "P13.provider-module",
    "P13.static-process-scan", "DB-R8.preimage", "DB-R8.restore"]) assert.ok(ids.has(id), id);
  const future = REHEARSAL_CASES_V1.flatMap(item => item.scenarios).filter(item => item.pending);
  assert.ok(future.some(item => item.pending.includes("item 10a")));
  assert.ok(future.some(item => item.pending.includes("item 11a")));
  assert.ok(future.some(item => item.pending.includes("item 14")));
  assert.ok(future.some(item => item.pending.includes("item 18")));
  assert.ok(future.every(item => /items? \d/u.test(item.pending)), "every pending check names its unblocking item");
});

test("scenario implementations must return positive assertion evidence", async t => {
  const { config } = await fixture(t);
  const noops = Object.fromEntries(Object.keys(REHEARSAL_IMPLEMENTATIONS_V1).map(name => [name, async () => ({})]));
  const result = await runUpdaterRehearsalV1(config, { implementations: noops });
  const runnableCount = REHEARSAL_CASES_V1.flatMap(phase => phase.scenarios)
    .filter(scenario => !scenario.pending).length;
  assert.equal(result.passed, 0);
  assert.equal(result.failed, runnableCount);
  assert.ok(result.phases.flatMap(phase => phase.scenarios)
    .filter(scenario => scenario.status === "fail")
    .every(scenario => scenario.reason === "rehearsal_assertion_evidence_missing"));
});

test("owner-code and clipboard checks inspect planted evidence instead of returning constants", async t => {
  const owner = await fixture(t);
  await prepareRehearsalRootV1(owner.config);
  await mkdir(join(owner.root, "updater-state"));
  await writeFile(join(owner.root, "updater-state/owner-code.txt"), "planted\n");
  const ownerResult = await runUpdaterRehearsalV1(owner.config, {
    cases: selectedCases("P0.no-owner-code-or-clipboard") });
  assert.equal(ownerResult.failed, 1);
  assert.equal(ownerResult.phases[0].scenarios[0].reason, "rehearsal_owner_code_present");

  const clipboard = await fixture(t);
  await prepareRehearsalRootV1(clipboard.config);
  await mkdir(join(clipboard.root, "evidence"));
  await writeFile(join(clipboard.root, "evidence/fake-commands.jsonl"),
    '{"command":"pbcopy","arguments":""}\n');
  const clipboardResult = await runUpdaterRehearsalV1(clipboard.config, {
    cases: selectedCases("P0.no-owner-code-or-clipboard") });
  assert.equal(clipboardResult.failed, 1);
  assert.equal(clipboardResult.phases[0].scenarios[0].reason, "rehearsal_clipboard_invoked");
});

test("named H2 scenarios exercise target, phase, runner and refusal guards", { timeout: 120_000 }, async t => {
  const { config } = await fixture(t);
  const result = await runUpdaterRehearsalV1(config, { cases: selectedCases(
    "P2.torn-pair-switch", "P6.lease-burst", "P8.known-good-injection") });
  assert.equal(result.failed, 0);
  assert.equal(result.passed, 3);
  const detail = new Map(result.phases.flatMap(phase => phase.scenarios).map(scenario => [scenario.id, scenario.detail]));
  assert.equal(detail.get("P2.torn-pair-switch").missingTargetRecovery, "rolled_back");
  assert.equal(detail.get("P2.torn-pair-switch").invalidPhaseRefusal, "updater_link_switch_refused");
  assert.equal(detail.get("P6.lease-burst").busy, 19);
  assert.equal(detail.get("P8.known-good-injection").malformedShapeRefused, "updater_known_good_refused");
});

test("merged watcher, referee and journal scenarios are live and fail closed", { timeout: 120_000 }, async t => {
  const { config } = await fixture(t);
  const ids = ["P6.latest-merge", "P7.protected-edits", "P7.rename", "P7.updater-symlink",
    "P10.poisoned-journal"];
  const result = await runUpdaterRehearsalV1(config, { cases: selectedCases(...ids) });
  assert.equal(result.failed, 0); assert.equal(result.pending, 0); assert.equal(result.passed, ids.length);
  const detail = new Map(result.phases.flatMap(phase => phase.scenarios).map(scenario => [scenario.id, scenario.detail]));
  assert.equal(detail.get("P6.latest-merge").superseded, 1);
  assert.ok(detail.get("P7.protected-edits").classes.includes("protected"));
  assert.equal(detail.get("P7.rename").oldPathProtected, true);
  assert.equal(detail.get("P7.rename").newPathProtected, true);
  assert.equal(detail.get("P7.updater-symlink").changesUpdater, true);
  assert.equal(detail.get("P10.poisoned-journal").reason, "updater_journal_ordinal_refused");
});

test("merged referee classes drive protected owner cards and untrusted metadata stays text", { timeout: 120_000 }, async t => {
  const { config } = await fixture(t);
  const ids = ["P1.c", "P1.d", "P7.lying-metadata"];
  const result = await runUpdaterRehearsalV1(config, { cases: selectedCases(...ids) });
  assert.equal(result.failed, 0); assert.equal(result.pending, 0); assert.equal(result.passed, ids.length);
  const detail = new Map(result.phases.flatMap(phase => phase.scenarios).map(scenario => [scenario.id, scenario.detail]));
  assert.equal(detail.get("P1.c").warningIsAlert, true);
  assert.equal(detail.get("P1.c").redCard, true);
  assert.ok(detail.get("P1.d").classes.includes("dependency"));
  assert.equal(detail.get("P1.d").redCard, true);
  assert.equal(detail.get("P7.lying-metadata").ownerScreenProtected, true);
  assert.equal(detail.get("P7.lying-metadata").botTextStayedText, true);
});

test("a marked root is rerunnable with identical outcomes even when the clock repeats", { timeout: 120_000 }, async t => {
  const { config } = await fixture(t), clock = () => new Date("2026-09-30T12:00:00.000Z");
  const cases = selectedCases("P6.lease-burst");
  const first = await runUpdaterRehearsalV1(config, { clock, cases });
  const second = await runUpdaterRehearsalV1(config, { clock, cases });
  const shape = result => ({ passed: result.passed, pending: result.pending, failed: result.failed,
    acceptanceReady: result.acceptanceReady, phases: result.phases.map(phase => ({ id: phase.id,
      status: phase.status, counts: phase.counts })) });
  assert.deepEqual(shape(second), shape(first));
  assert.notEqual(second.runRoot, first.runRoot);
});

test("twenty same-root callers yield one run and nineteen typed busy refusals", { timeout: 120_000 }, async t => {
  const { config } = await fixture(t);
  await prepareRehearsalRootV1(config);
  const cases = selectedCases("P6.lease-burst");
  const results = await Promise.allSettled(Array.from({ length: 20 }, () =>
    runUpdaterRehearsalV1(config, { cases })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const refusals = results.filter(result => result.status === "rejected").map(result => result.reason?.code);
  assert.deepEqual(refusals, Array(19).fill("rehearsal_root_busy"));
});

test("a failed halfway scenario releases the root lock and a retry can pass", async t => {
  const { config } = await fixture(t); let attempts = 0;
  const cases = [{ id: "P-stop", title: "stop and retry", scenarios: [{ id: "P-stop.halfway",
    title: "a stopped attempt can retry", implementation: "halfway" }] }];
  const implementations = { halfway: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("simulated_stop_halfway");
    return { assertions: 1, retryPassed: true };
  } };
  const stopped = await runUpdaterRehearsalV1(config, { cases, implementations });
  assert.equal(stopped.failed, 1);
  const retried = await runUpdaterRehearsalV1(config, { cases, implementations });
  assert.equal(retried.failed, 0);
  assert.equal(retried.passed, 1);
});

test("a stale lock left by a stopped process is reclaimed before retry", async t => {
  const { root, config } = await fixture(t);
  await prepareRehearsalRootV1(config);
  await mkdir(join(root, ".rehearsal-running"));
  await writeFile(join(root, ".rehearsal-running/owner.json"), JSON.stringify({
    schema: "control-room.rehearsal-lock/v1", pid: 2_147_483_647, token: "stale",
  }));
  const result = await runUpdaterRehearsalV1(config, { cases: selectedCases("P6.lease-burst") });
  assert.equal(result.failed, 0);
  assert.equal(result.passed, 1);
});

test("throwaway harness runs all available scenarios, records four evidence files per case and never promotes pending", { timeout: 120_000 }, async t => {
  const { config } = await fixture(t), phases = [];
  const result = await runUpdaterRehearsalV1(config, { onPhase: phase => phases.push(phase) });
  assert.equal(result.failed, 0); assert.ok(result.passed >= 18); assert.ok(result.pending > 0);
  assert.equal(result.acceptanceReady, false); assert.equal(phases.length, 15);
  assert.ok(phases.every(phase => phase.status === "pending"));
  for (const phase of phases) {
    for (const file of ["result.json", "journal.jsonl", "links.json", "status.json"])
      await readFile(join(result.runRoot, phase.id, file));
    for (const scenario of phase.scenarios) {
      for (const file of ["result.json", "journal.jsonl", "links.json", "status.json"])
        await readFile(join(result.runRoot, phase.id, "scenarios", scenario.id, file));
    }
  }
  assert.match(result.markdown, /\| P7 Hostile candidate \| pending \|/u);
  assert.doesNotMatch(result.markdown, /\/Users\//u);
});


test("A2-13 rehearsal config requires every own account, port and top-level field", async t => {
  const { config } = await fixture(t);
  for (const group of ["accounts", "ports"]) {
    for (const key of Object.keys(config[group])) {
      const nested = { ...config[group] }; delete nested[key];
      assert.throws(() => parseRehearsalConfigV1({ ...config, [group]: nested }), /rehearsal_.*refused/u);
    }
    assert.throws(() => parseRehearsalConfigV1({ ...config, [group]: {} }), /rehearsal_.*refused/u);
  }
  assert.throws(() => parseRehearsalConfigV1({ ...config, ports: {},
    expectedOrigin: 'https://unit-rehearsal.invalid:undefined' }), /rehearsal_ports_refused/u);
  for (const key of Object.keys(config)) {
    const missing = { ...config }; delete missing[key];
    assert.throws(() => parseRehearsalConfigV1(missing), /rehearsal_.*refused/u);
  }
});

test("A2-06 updater rehearsal config and root marker refuse duplicate JSON members", async t => {
  const { root, config } = await fixture(t);
  const { readRehearsalConfigV1 } = await import('../src/updater/v1/rehearsal/config.mjs');
  await mkdir(root);
  const path = join(root, 'input.json'), valid = JSON.stringify(config);
  await writeFile(path, valid.replace('"ports":{', '"ports":{"web":1,'));
  await assert.rejects(readRehearsalConfigV1(path), /rehearsal_config_read_refused/u);
  await writeFile(path, valid); assert.equal((await readRehearsalConfigV1(path)).ports.web, 59400);
  const markerPath = join(root, '.control-room-rehearsal-root.json');
  await writeFile(markerPath, JSON.stringify({ schema: 'control-room.updater-rehearsal-root/v1',
    rehearsalHostname: config.rehearsalHostname, mode: config.mode }).replace('"mode":', '"mode":"bad","mode":'));
  await assert.rejects(prepareRehearsalRootV1(config), /rehearsal_root_marker_refused/u);
});

test("A2-06 strict JSON preserves native values and bounds depth, nodes and bytes", async () => {
  const { parseStrictJsonV1: parse } = await import('../src/installer/shared/strict-json.mjs');
  const samples = [null, true, false, 12.5, -1e20, 'Unicode Ω and \\" quote',
    { a: 1, b: [{ a: 2 }, { a: 3 }], text: 'fake {"a":1,"a":2}' }, ['x', {}, []]];
  for (const value of samples) assert.deepEqual(parse(JSON.stringify(value)), value);
  const proto = parse('{"__proto__":{"value":1},"constructor":2}');
  assert.equal(Object.getPrototypeOf(proto), Object.prototype); assert.ok(Object.hasOwn(proto, '__proto__'));
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}',
    '{"child":{"a":1,"a":2}}', '[{"a":1,"a":2}]', '{"__proto__":1,"__proto__":2}'])
    assert.throws(() => parse(text), /json_duplicate_key/u);
  for (const text of ['', '{', '{"a":1,}', '[1,]', '[01]', 'false false', '"\\x"',
    '{"a" 1}', '{a:1}', '[NaN]', '"unclosed', '"literal\nnewline"'])
    assert.throws(() => parse(text));
  assert.equal(parse('  { "a" : 1 } \n').a, 1);
  assert.throws(() => parse('['.repeat(130) + '0' + ']'.repeat(130)), /json_depth_refused/u);
  assert.deepEqual(parse('[[0]]', { maxDepth: 2 }), [[0]]);
  assert.throws(() => parse('[[[0]]]', { maxDepth: 2 }), /json_depth_refused/u);
  assert.deepEqual(parse('[0,0]', { maxNodes: 3 }), [0,0]);
  assert.throws(() => parse('[0,0,0]', { maxNodes: 3 }), /json_nodes_refused/u);
  assert.equal(parse('"Ω"', { maxBytes: 4 }), 'Ω');
  assert.throws(() => parse('"Ω"', { maxBytes: 3 }), /json_size_refused/u);
  // Same names in different objects are valid; a wide, bounded input stays linear.
  assert.equal(parse(JSON.stringify(Array.from({ length: 20000 }, () => ({ a: 1 })))).length, 20000);
});
