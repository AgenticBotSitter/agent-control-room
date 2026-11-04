import assert from "node:assert/strict";
import test from "node:test";
import { LoopPolicyServiceV1 } from "../src/web/v1/loop-policy-service";
import { ImproveControlRoomLoopServiceV1 } from "../src/web/v1/improve-control-room-loop-service";
import type { LoopAdapterV1 } from "../src/web/v1/improve-control-room-loop-adapter";
import { sha256Digest } from "../src/security";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1, type LoopBridgeBindingV1 } from "../src/improve-control-room/v1/schemas";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { composeLoopSettingsV1 } from "../src/web/v1/loop-policy-compose";
import { decodeSelectionEditsV1, encodeSelectionEditsV1, loopSelectionEffortSchemaV1, loopSelectionSchemaV1,
  loopSelectionSlotSchemaV1, loopSelectionPresetSchemaV1, mergeSelectionLayerV1, parseSelectionRunOverridesV1,
  type LoopSelectionProjectionV1 } from "../src/web/v1/loop-selection-wire";
import { LoopSelectionServiceV1, type LoopSelectionSnapshotGuardV1, type SelectionSnapshotV1 } from "../src/web/v1/loop-selection-service";
import { createLoopSelectionHttpHandlerV1 } from "../src/web/v1/loop-selection-http";
import { loopSelectionBrowserClientV1 } from "../src/web/v1/loop-selection-browser-client";
import type { LoopPolicyCheckWithV1, LoopSelectionCheckContextV1 } from "../src/web/v1/loop-policy-service";
import type { TestContext } from "node:test";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { origin, request, trust } from "./helpers/web-foundation";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
const slot = (model = "fixture-model", route = "fixture-launcher") => ({ model, route, effort: "default" as const });
const selection = (): import("../src/web/v1/loop-selection-wire").LoopSelectionV1 => ({ roles: { plan: slot(), spec: slot(), build: slot(), final: slot(),
  plan_reviews: [], spec_reviews: [], code_reviews: [slot()] },
  plan_review_count: 0, spec_review_count: 0, code_review_count: 1 });

/** Recorded in-process intake receipt: no child, CLI, model or provider is launched. */
function recordedIntakeAdapter(): LoopAdapterV1 {
  const adapterId = 'adapter:fixture', toolingRevision = `sha256:${'a'.repeat(64)}`;
  const unexpected = async (): Promise<never> => { throw new Error('unexpected recorded intake operation'); };
  return { adapterId, toolingRevision, schemaDigest: `sha256:${'b'.repeat(64)}`, settingsText: '{}',
    available: () => true, reserveRun: () => 'fixture-u81-run',
    contract: { toolingRevision, decodeRunIdentity: value => loopImprovementRunIdentitySchemaV1.parse(value),
      decodeObservation: value => loopImprovementObservationSchemaV1.parse(value), matchesSavedInput: () => false },
    intake: async (commandId: string, binding: LoopBridgeBindingV1, description: string, beforeSpawn: () => void, settingsText = '{}') => {
      beforeSpawn();
      return { run: { adapterId, toolingRevision, loopRunId: binding.loopRunId, a2SchemaVersion: 1 },
        revision: 1, inputVersion: 1, state: 'draft', description, settingsSha256: sha(settingsText), settingsDigest: sha(settingsText),
        confirmation: null, approval: null, question: null, progress: { step: 'intake', completed: 0, attention: 'none' },
        receipts: [{ commandId, bindingDigest: sha256Digest(binding), state: 'accepted', error: null, evidenceDigest: sha256Digest({ commandId }) }] };
    }, confirmRequest: unexpected, start: unexpected, status: unexpected, stop: unexpected, approve: unexpected, answer: unexpected,
    close: async () => {},
  };
}

for (const mutation of ["extra-slot-key", "four-code-reviews", "count-mismatch"] as const) {
  test(`U81 R1 existing intake refuses ${mutation} before checker or writes`, async t => {
    const f = await taskFixture(); t.after(() => f.db.close());
    await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
      '{"templateId":"control-room"}'::jsonb) WHERE id=$1`, [f.project.projectId]);
    const candidate = selection();
    if (mutation === "extra-slot-key") Object.assign(candidate.roles.build, { extra: true });
    if (mutation === "four-code-reviews") { candidate.roles.code_reviews = [slot(), slot(), slot(), slot()]; candidate.code_review_count = 4; }
    if (mutation === "count-mismatch") candidate.code_review_count = 2;
    let checks = 0;
    const policy = new LoopPolicyServiceV1(f.client, scope, { settingsText: '{}', checkSettings: async () => {
      checks++; return { eligible: true, reasons: [] };
    } }, () => now);
    const adapter = recordedIntakeAdapter();
    const service = new ImproveControlRoomLoopServiceV1(f.client, scope,
      { integrityKey: new Uint8Array(32).fill(65), adapter, policy }, () => now);
    await assert.rejects(service.mutate(f.identity, f.project.projectId, null, 'intake',
      { description: 'Check the B8 selection structure', settingsEdits: JSON.stringify(candidate) }, `u81-red-${mutation}-0001`).then(receipt => {
        assert.equal(receipt.state, 'accepted', 'old intake really accepts the malformed projection');
        console.log(`U81 old intake ${mutation}: accepted=true checker_calls=${checks}`);
        return receipt;
      }), { code: 'invalid_request' });
    assert.equal(checks, 0);
    for (const table of ['control_loop_improvement_requests', 'control_loop_policy_input_sources', 'control_loop_improvement_commands'])
      assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length, 0);
  });
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const invalid = { code: 'invalid_request' };
const snapshot: SelectionSnapshotV1 = { rosterDigest: 'a'.repeat(64), availabilityDigest: 'b'.repeat(64), revision: 'fixture-1' };

function projection(): LoopSelectionProjectionV1 {
  const requested = selection();
  return { family_policy: 'review-only', rosterDigest: snapshot.rosterDigest, availabilityDigest: snapshot.availabilityDigest,
    lineupDigest: 'c'.repeat(64), reservedFinal: { ...slot(), family: 'fixture-final', class: 'Frontier', cost: 'subscription' }, waivedReasons: [],
    lineup: (['final', 'build', 'plan', 'spec', 'code_reviews'] as const).map(role => ({ role, index: 0,
      requested: { ...structuredClone(role === 'code_reviews' ? requested.roles.code_reviews[0]! : requested.roles[role]), family: 'fixture-family', class: 'Frontier', cost: 'subscription' },
      effective: { ...slot(), family: role === 'final' ? 'fixture-final' : 'fixture-family', class: 'Frontier', cost: 'subscription' },
      refusals: [], fallback: false })) };
}

test('U81 T1 shared slot/count codec, long roster names, preset independence and duplicate structural positives', () => {
  for (const role of ['plan', 'spec', 'code'] as const) for (const count of [-1, 0, 3, 4]) {
    const value = selection(); value.roles[`${role}_reviews`] = Array.from({ length: Math.max(0, count) }, () => slot());
    value[`${role}_review_count`] = count;
    assert.equal(loopSelectionSchemaV1.safeParse(value).success, count <= 3 && count >= (role === 'code' ? 1 : 0), `${role} ${count}`);
  }
  for (const count of [0.5, NaN, Infinity]) assert.equal(loopSelectionSchemaV1.safeParse({ ...selection(), code_review_count: count }).success, false);
  const long = slot('m'.repeat(179), 'l'.repeat(180));
  assert.deepEqual(loopSelectionSlotSchemaV1.parse(long), long);
  const preset = { spec: long, spec_reviews: [slot()], build: slot(), code_reviews: [slot(), slot()], final: slot() };
  assert.deepEqual(loopSelectionPresetSchemaV1.parse(preset), preset);
  assert.equal(loopSelectionPresetSchemaV1.safeParse({ ...preset, roles: selection().roles }).success, false);
  assert.equal(loopSelectionPresetSchemaV1.safeParse({ ...preset, code_review_count: 2 }).success, false);
  assert.equal(loopSelectionPresetSchemaV1.safeParse({ ...preset, overrides: {} }).success, false);
  const full = selection(); full.roles.spec = long; full.roles.spec_reviews = preset.spec_reviews; full.spec_review_count = 1;
  assert.equal(full.roles.plan.model, 'fixture-model'); assert.equal(full.plan_review_count, 0);
  assert.deepEqual(decodeSelectionEditsV1(encodeSelectionEditsV1(full)).selection, full);
  assert.equal(loopSelectionSchemaV1.safeParse(selection()).success, true, 'identical model/type slots are not a product family policy');
  assert.deepEqual(loopSelectionEffortSchemaV1.options, ['default','low','medium','high','xhigh','max']);
  for (const effort of loopSelectionEffortSchemaV1.options) assert.equal(loopSelectionSlotSchemaV1.safeParse({ ...slot(), effort }).success, true);
});

test('U81 T2/T3 strict selections, run envelope, forbidden persistence and aggregate bounds', () => {
  for (const field of ['schemaVersion', 'overrides', 'consent', 'cap', 'sameFamilyAcknowledgement', 'acceptSameFamilyRisk', 'run', 'by', 'accepted_at'])
    assert.throws(() => encodeSelectionEditsV1(Object.assign(selection(), { [field]: true })), invalid, field);
  for (const edit of [{ model: 'm' }, { ...slot(), route: null }, { ...slot(), launcher: 'fixture' }, { ...slot(), effort: 'extreme' },
    { ...slot(), model: 'line\nbreak' }, { ...slot(), route: 'nul\0byte' }, { ...slot(), api_key: 'SYNTHETIC' }]) {
    const value = selection(); Object.assign(value.roles, { build: edit });
    assert.throws(() => encodeSelectionEditsV1(value), invalid);
  }
  for (const overrides of [null, { extra: true }, { reviewFamily: null }, { reviewFamily: 'false' }, { standardFinal: 0 }])
    assert.throws(() => parseSelectionRunOverridesV1(overrides), invalid);
  assert.deepEqual(parseSelectionRunOverridesV1(), { reviewFamily: false, standardFinal: false });
  for (const reviewFamily of [true, false]) for (const standardFinal of [true, false]) {
    const overrides = { reviewFamily, standardFinal };
    assert.deepEqual(decodeSelectionEditsV1(encodeSelectionEditsV1(selection(), overrides)), { selection: selection(), overrides });
  }
  assert.throws(() => decodeSelectionEditsV1('{"roles":{},"roles":{}}'), invalid);
  const large = selection(); large.roles.build.model = 'm'.repeat(66000);
  assert.throws(() => encodeSelectionEditsV1(large), invalid);
  for (const authority of ['overrides', 'consent', 'cap', 'sameFamilyAcknowledgement', 'acceptSameFamilyRisk'])
    assert.throws(() => mergeSelectionLayerV1(JSON.stringify({ [authority]: {} }), selection()), invalid);
  assert.throws(() => mergeSelectionLayerV1('{"api_key":"SYNTHETIC"}', selection()), invalid);
});

test('U81 T4 merge keeps unknown roles/members and complete route pair, canonical parse and caller replacement', () => {
  const original = { roles: { extra_role: { model: 'extra', future: 42 }, build: 'old' }, keep: { nested: [3, 2, 1] },
    providerRoute: { providerId: 'fixture-provider', model: 'old-model' } };
  const merged = JSON.parse(mergeSelectionLayerV1(JSON.stringify(original), selection()));
  assert.deepEqual(merged, { ...original, ...selection(), roles: { ...original.roles, ...selection().roles } });
  const reload = decodeSelectionEditsV1(JSON.stringify({ ...selection(), unrelated: ['keep'], providerRoute: original.providerRoute,
    overrides: { standardFinal: false, reviewFamily: false } }));
  assert.deepEqual(reload, { selection: selection(), overrides: { reviewFamily: false, standardFinal: false } });
  const withOtherRole = JSON.stringify({ ...selection(), roles: { ...selection().roles, extra_role: { kept: true } } });
  assert.doesNotThrow(() => decodeSelectionEditsV1(withOtherRole), 'run-edit projection retains valid non-B8 role members');
  assert.deepEqual(decodeSelectionEditsV1(withOtherRole).selection, selection());
  const encoded = JSON.parse(encodeSelectionEditsV1(selection()));
  const explicit = { providerId: 'fixture-replacement', model: 'new-model' };
  const assembled = composeLoopSettingsV1({ defaultsText: '{}', runEdits: JSON.stringify({ ...encoded, providerRoute: explicit }) }).text;
  assert.deepEqual(JSON.parse(assembled).providerRoute, explicit);
  assert.deepEqual(decodeSelectionEditsV1(assembled).selection, selection());
  assert.deepEqual(JSON.parse(mergeSelectionLayerV1(JSON.stringify({ ...merged, providerRoute: explicit }), selection())).providerRoute, explicit);
});

async function selectionFixture(t: TestContext, defaults = '{}') {
  let clock = now, inTransaction = false;
  const f = await taskFixture(() => clock); t.after(() => f.db.close());
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"templateId":"control-room"}'::jsonb) WHERE id=$1`, [f.project.projectId]);
  await f.db.query(`UPDATE control_role_grants SET allowed_actions='["loop_selection.read"]'::jsonb,project_ids=$1::jsonb`, [JSON.stringify([f.project.projectId])]);
  const statements: string[] = [], checks: { text: string; context?: LoopSelectionCheckContextV1 }[] = [];
  const session = (tx: DatabaseSession): DatabaseSession => ({ query: (sql, params) => { statements.push(sql); return tx.query(sql, params); } });
  const db: DatabaseClient = { query: f.client.query.bind(f.client), transaction: f.client.transaction.bind(f.client),
    transactionWithPreCommitCheck: (op, check) => f.client.transactionWithPreCommitCheck(async tx => {
      inTransaction = true; try { return await op(session(tx)); } finally { inTransaction = false; }
    }, check) };
  let check: (text: string, context?: LoopSelectionCheckContextV1) => Promise<LoopPolicyCheckWithV1> = async () => ({ eligible: true, reasons: [], projection: projection() });
  const tools = { settingsText: defaults, checkSettings: async (text: string, context?: LoopSelectionCheckContextV1) => {
    assert.equal(inTransaction, false, 'checker must run outside every transaction');
    checks.push({ text, context }); return check(text, context);
  } };
  const policy = new LoopPolicyServiceV1(db, scope, tools, () => clock);
  let current = { ...snapshot }, captures = 0;
  const guard: LoopSelectionSnapshotGuardV1 = { capture: async () => { captures++; assert.equal(inTransaction, false); return { ...current }; },
    assertCurrent: async () => { assert.fail('preview cannot claim admission snapshot serialization'); } };
  class SelectionExtension extends LoopSelectionServiceV1 {
    manage = (op: (tx: DatabaseSession) => Promise<void>) => this.withSelectionAuthorityV1(f.identity, f.project.projectId, 'manage', tx => op(tx));
  }
  const service = new SelectionExtension(db, scope, policy, guard, () => clock);
  const handler = createLoopSelectionHttpHandlerV1({ origin, trust, service, clock: () => clock });
  const path = `/api/v1/projects/${encodeURIComponent(f.project.projectId)}/loop-selection/preview`;
  const preview = (body: unknown = { selection: selection(), overrides: {} }) => service.preview(f.identity, f.project.projectId, body);
  const noWrites = async () => {
    for (const table of ['control_loop_policy_layers', 'control_loop_policy_events', 'control_loop_policy_input_sources',
      'control_loop_improvement_requests', 'control_loop_improvement_commands', 'control_loop_improvement_run_links'])
      assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length, 0, table);
  };
  return { ...f, db, service, policy, tools, guard, handler, path, checks, statements, preview, noWrites,
    setCheck: (next: typeof check) => { check = next; }, advance: (ms: number) => { clock += ms; },
    setSnapshot: (next: typeof snapshot) => { current = next; }, captures: () => captures };
}

test('U81 T3 preview resets installed true defaults and deliberate edits use the same exact P71 bytes', async t => {
  const f = await selectionFixture(t, '{"overrides":{"reviewFamily":true,"standardFinal":true},"kept":17}');
  const value = await f.preview(); assert.equal(value.available, true);
  assert.deepEqual(JSON.parse(f.checks[0]!.text), { ...selection(), overrides: { reviewFamily: false, standardFinal: false }, kept: 17 });
  assert.deepEqual(f.checks[0]!.context, { mode: 'preview', sameFamilyIntent: false });
  const deliberate = await f.preview({ selection: selection(), overrides: { reviewFamily: true, standardFinal: false } });
  assert.equal(deliberate.available, true); assert.deepEqual(JSON.parse(f.checks[1]!.text).overrides, { reviewFamily: true, standardFinal: false });
  assert.deepEqual(f.checks[1]!.context, { mode: 'preview', sameFamilyIntent: true });
  if (value.available) { assert.equal(value.settingsSha256, sha(f.checks[0]!.text)); assert.equal(value.defaultsSha256, sha(f.tools.settingsText)); }
  assert.equal(f.statements.some(sql => /projects.*FOR UPDATE|control_loop_policy_layers[\s\S]*FOR UPDATE/.test(sql)), false);
  await f.noWrites();
});

test('U81 T2 malformed preview bodies and intake share strict projection refusals without writes', async t => {
  const f = await selectionFixture(t);
  for (const body of [{ selection: selection(), overrides: null }, { selection: selection(), overrides: { bad: true } },
    { selection: { ...selection(), run: 'forged' } }, { selection: selection(), acceptSameFamilyRisk: true },
    { selection: selection(), sameFamilyAcknowledgement: {} }, { selection: selection(), providerRoute: { providerId: 'fixture', model: 'model' } }]) {
    const response = await f.handler(request(f.path, 'POST', body));
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'invalid_request' });
  }
  assert.equal(f.checks.length, 0); await f.noWrites();
});

test('U81 T5 preview passes checker-only family, fallback, duplicate, Trial, off and unavailable decisions verbatim', async t => {
  const f = await selectionFixture(t);
  const cases = [
    { code: 'FINAL_FIRST_RESERVED', eligible: true }, { code: 'BUILDER_FALLBACK', eligible: true }, { code: 'REVIEWER_FALLBACK', eligible: true },
    { code: 'UNUSED_FRONTIER_BLOCKS_FALLBACK', eligible: false }, { code: 'NO_OUTSIDE_BUILDER_FINAL', eligible: false },
    { code: 'DUPLICATE_ACCEPTED', eligible: true }, { code: 'DUPLICATE_REFUSED', eligible: false }, { code: 'TRIAL_REFUSED', eligible: false },
    { code: 'CLASS_REFUSED', eligible: false }, { code: 'OFF_REFUSED', eligible: false }, { code: 'UNAVAILABLE_REFUSED', eligible: false },
    { code: 'UNWIRED_REFUSED', eligible: false }, { code: 'FINAL_BUILDER_SAME_FAMILY', eligible: false },
  ];
  for (const [index, item] of cases.entries()) {
    const projected = projection(); projected.lineupDigest = index.toString(16).padStart(64, '0');
    projected.lineup[1]!.fallback = item.code === 'BUILDER_FALLBACK';
    projected.lineup[4]!.fallback = item.code === 'REVIEWER_FALLBACK';
    projected.lineup[1]!.refusals = [{ code: item.code, explanation: `Checker candidate ${index}` }];
    const expected = { eligible: item.eligible, reasons: item.eligible ? [] : [{ code: item.code, explanation: `Checker decision ${index}` }] };
    f.setCheck(async () => ({ ...expected, projection: projected }));
    const value = await f.preview({ selection: selection(), overrides: { reviewFamily: true, standardFinal: true } });
    assert.equal(value.available, true, item.code);
    if (value.available) { assert.deepEqual(value.check, expected); assert.deepEqual(value.projection, projected); assert.deepEqual(value.blockers, []); }
  }
  assert.equal(f.checks.length, cases.length); await f.noWrites();
});

test('U81 T10 paid projection has separate product blocker and false readiness without changing checker eligibility', async t => {
  const f = await selectionFixture(t), projected = projection(); projected.lineup[1]!.requested.cost = 'paid'; projected.lineup[1]!.fallback = true;
  f.setCheck(async () => ({ eligible: true, reasons: [], projection: projected }));
  const value = await f.preview(); assert.equal(value.available, true);
  if (value.available) { assert.deepEqual(value.check, { eligible: true, reasons: [] });
    assert.deepEqual(value.blockers, [{ code: 'paid_execution_unavailable', explanation: 'Paid execution is unavailable.' }]); assert.equal(value.paidExecutionReady, false); }
  await f.noWrites();
});

test('U81 T12-P missing checker/projection, malformed check and unattested snapshots fail unavailable', async t => {
  const f = await selectionFixture(t);
  const failures = [async () => { throw new Error('private diagnostic never exposed'); },
    async () => ({ eligible: true, reasons: [] }), async () => ({ eligible: false, reasons: [], projection: projection() }),
    async () => ({ eligible: false, reasons: [{ code: 'FIXTURE', explanation: 'bad\nreason' }], projection: projection() }),
    async () => { const p = projection(); p.family_policy = 'wrong' as 'review-only'; return { eligible: true, reasons: [], projection: p }; },
    async () => { const p = projection(); p.lineup[0]!.requested.model = 'different'; return { eligible: true, reasons: [], projection: p }; },
    async () => { const p = projection(); p.lineup[1] = p.lineup[0]!; return { eligible: true, reasons: [], projection: p }; },
    async () => { const p = projection(); p.rosterDigest = 'd'.repeat(64); return { eligible: true, reasons: [], projection: p }; },
  ];
  for (const fail of failures) { f.setCheck(fail); const value = await f.preview(); assert.equal(value.available, false); assert.doesNotMatch(JSON.stringify(value), /private diagnostic|different|bad\\nreason/); }
  const noChecker = new LoopPolicyServiceV1(f.db, scope, { settingsText: '{}' }, () => now);
  const unavailable = new LoopSelectionServiceV1(f.db, scope, noChecker, f.guard, () => now);
  assert.equal((await unavailable.preview(f.identity, f.project.projectId, { selection: selection() })).available, false);
  const noGuard = new LoopSelectionServiceV1(f.db, scope, f.policy, undefined, () => now);
  const count = f.checks.length; assert.equal((await noGuard.preview(f.identity, f.project.projectId, { selection: selection() })).available, false);
  assert.equal(f.checks.length, count); await f.noWrites();
});

test('U81 T12-P a 6000 ms preview retains legacy checker timeout and never creates authority', async t => {
  const f = await selectionFixture(t);
  f.setCheck(async () => { await new Promise(resolve => setTimeout(resolve, 6000)); f.advance(6000); return { eligible: true, reasons: [], projection: projection() }; });
  const value = await f.preview({ selection: selection(), overrides: { reviewFamily: true } });
  assert.equal(value.available, true); assert.equal(f.checks.length, 1); await f.noWrites();
  assert.doesNotMatch(JSON.stringify(value), /accepted_at|sameFamilyAcknowledgement|commandId|auth_tag/);
});

test('U81 T12-P snapshot drift during checker refuses preview without asserting admission serialization', async t => {
  const f = await selectionFixture(t);
  f.setCheck(async () => { f.setSnapshot({ ...snapshot, revision: 'fixture-2' }); return { eligible: true, reasons: [], projection: projection() }; });
  assert.deepEqual(await f.preview(), { available: false, reason: { code: 'selection_snapshot_changed', explanation: 'The selection snapshot changed. Preview again.' } });
  await f.noWrites();
});

test('U81 T4 configured provider pair inheritance stays unavailable until U83a hook; launcher selection works', async t => {
  const f = await selectionFixture(t);
  assert.equal((await f.preview()).available, true); const count = f.checks.length;
  f.tools.settingsText = '{"providerRoute":{"providerId":"fixture-provider","model":"fixture-model"}}';
  const value = await f.preview(); assert.equal(value.available, false); assert.equal(f.checks.length, count);
  assert.deepEqual(JSON.parse(f.tools.settingsText).providerRoute, { providerId: 'fixture-provider', model: 'fixture-model' });
  await f.noWrites();
});

for (const denied of ['tasks-only', 'operator', 'wrong-project', 'expired-grant', 'revoked-grant', 'expired-session'] as const) {
  test(`U81 T14 ${denied} spawns zero checkers and captures zero snapshots`, async t => {
    const f = await selectionFixture(t);
    if (denied === 'tasks-only') await f.db.query(`UPDATE control_role_grants SET allowed_actions='["tasks.propose"]'::jsonb`);
    if (denied === 'operator') await f.db.query("UPDATE control_role_grants SET role_key='operator'");
    if (denied === 'wrong-project') await f.db.query(`UPDATE control_role_grants SET project_ids='["project:other"]'::jsonb`);
    if (denied === 'expired-grant') await f.db.query('UPDATE control_role_grants SET expires_at=$1', [new Date(now - 1).toISOString()]);
    if (denied === 'revoked-grant') await f.db.query('UPDATE control_role_grants SET revoked_at=$1', [new Date(now).toISOString()]);
    if (denied === 'expired-session') f.advance(400_000);
    await assert.rejects(f.preview(), { code: denied === 'expired-session' ? 'authentication_required' : 'access_denied' });
    assert.equal(f.checks.length, 0); assert.equal(f.captures(), 0); await f.noWrites();
  });
}

test('U81 T14 checker-time owner revocation and high-risk manage recheck refuse before mutation', async t => {
  const f = await selectionFixture(t);
  f.setCheck(async () => { await f.db.query('UPDATE control_role_grants SET revoked_at=$1', [new Date(now).toISOString()]); return { eligible: true, reasons: [], projection: projection() }; });
  await assert.rejects(f.preview(), { code: 'access_denied' });
  await f.db.query(`UPDATE control_role_grants SET revoked_at=NULL,allowed_actions='["loop_selection.manage"]'::jsonb,risk_ceiling='low'`);
  let mutations = 0; await assert.rejects(f.service.manage(async () => { mutations++; }), { code: 'access_denied' });
  await f.db.query("UPDATE control_role_grants SET risk_ceiling='high'");
  await f.service.manage(async () => { mutations++; }); assert.equal(mutations, 1);
  await f.db.query('UPDATE control_role_grants SET revoked_at=$1', [new Date(now).toISOString()]);
  await assert.rejects(f.service.manage(async () => { mutations++; }), { code: 'access_denied' }); assert.equal(mutations, 1);
  await f.noWrites();
});

test('U81 registration includes the deciding test without altering P71 real-tools exclusion', async () => {
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.match(scripts['test:improve-control-room'], /tests\/loop-selection\.test\.ts/);
  assert.match(scripts['test:improve-control-room'], /--test-skip-pattern='\^P71 real settings check\$'/);
});

test('U81 project preview browser client is a bounded same-origin POST with no authority or idempotency key', async t => {
  const f = await selectionFixture(t), original = globalThis.fetch, controller = new AbortController();
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async (path, init) => {
    assert.equal(path, f.path); assert.equal(init?.method, 'POST'); assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store');
    assert.equal(new Headers(init?.headers).get('idempotency-key'), null);
    return f.handler(request(String(path), 'POST', JSON.parse(String(init?.body))));
  }) as typeof fetch;
  const value = await loopSelectionBrowserClientV1.preview(f.project.projectId, { selection: selection() }, controller.signal);
  assert.equal(value.available, true); await f.noWrites();
});

test('U81 T3 existing intake applies the new-run false reset before checker, retaining unrelated edits', async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}','{"templateId":"control-room"}'::jsonb) WHERE id=$1`, [f.project.projectId]);
  const checked: string[] = [];
  const policy = new LoopPolicyServiceV1(f.client, scope, {
    settingsText: '{"overrides":{"reviewFamily":true,"standardFinal":true},"inherited":17}',
    checkSettings: async text => { checked.push(text); return { eligible: false, reasons: [{ code: 'SYNTHETIC_STOP', explanation: 'Recorded checker stop' }] }; },
  }, () => now);
  const adapter = { adapterId: 'adapter:fixture', toolingRevision: `sha256:${'a'.repeat(64)}`,
    schemaDigest: `sha256:${'b'.repeat(64)}`, contract: {}, available: () => true } as unknown as LoopAdapterV1;
  const service = new ImproveControlRoomLoopServiceV1(f.client, scope,
    { integrityKey: new Uint8Array(32).fill(65), adapter, policy }, () => now);
  for (const overrides of [undefined, { reviewFamily: false, standardFinal: false }, { reviewFamily: true, standardFinal: false }]) {
    const edits = { ...selection(), roles: { ...selection().roles, extra_role: { kept: true } }, kept: ['unchanged'], ...(overrides ? { overrides } : {}) };
    await assert.rejects(service.mutate(f.identity, f.project.projectId, null, 'intake',
      { description: 'Check explicit new-run reset', settingsEdits: JSON.stringify(edits) }, `u81-reset-intake-${checked.length}-0001`), /loop_policy_refused/);
    assert.deepEqual(JSON.parse(checked.at(-1)!).overrides, overrides ?? { reviewFamily: false, standardFinal: false });
    assert.deepEqual(JSON.parse(checked.at(-1)!).kept, ['unchanged']);
    assert.deepEqual(JSON.parse(checked.at(-1)!).roles.extra_role, { kept: true });
    assert.equal(JSON.parse(checked.at(-1)!).inherited, 17);
  }
  for (const [overrides, expected] of [
    [{}, { reviewFamily: false, standardFinal: false }],
    [{ reviewFamily: true }, { reviewFamily: true, standardFinal: false }],
    [{ standardFinal: true }, { reviewFamily: false, standardFinal: true }],
  ]) {
    await assert.rejects(service.mutate(f.identity, f.project.projectId, null, 'intake',
      { description: 'Check overrides-only reset', settingsEdits: JSON.stringify({ overrides, kept: 42 }) },
      `u81-reset-only-${checked.length}-0001`), /loop_policy_refused/);
    assert.deepEqual(JSON.parse(checked.at(-1)!).overrides, expected, 'overrides-only edits reset every omitted B8 switch');
    assert.equal(JSON.parse(checked.at(-1)!).kept, 42);
  }
  assert.equal(checked.length, 6);
  for (const table of ['control_loop_improvement_requests', 'control_loop_policy_input_sources', 'control_loop_improvement_commands'])
    assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length, 0);
});

test('U81 T4 current expectedVersion P71 save reloads the whole merged layer; stale writes cannot overwrite it', async t => {
  const f = await selectionFixture(t);
  await f.db.query(`UPDATE control_role_grants SET allowed_actions='["loop_policy.manage","loop_policy.read","loop_selection.read"]'::jsonb`);
  const current = '{"providerRoute":{"providerId":"fixture-provider","model":"fixture-model"},"roles":{"other":{"kept":true}},"kept":[1,2]}';
  await f.policy.put(f.identity, f.project.projectId, 'selection', { expectedVersion: 0, settings: current }, 'u81-layer-initial-0001');
  const whole = mergeSelectionLayerV1(current, selection());
  assert.deepEqual(await f.policy.put(f.identity, f.project.projectId, 'selection', { expectedVersion: 1, settings: whole }, 'u81-layer-replace-0001'), { replayed: false, version: 2 });
  await assert.rejects(f.policy.put(f.identity, f.project.projectId, 'selection', { expectedVersion: 1, settings: '{}' }, 'u81-layer-stale-000001'), { code: 'conflict' });
  const reloaded = await f.policy.view(f.identity, f.project.projectId);
  assert.equal(reloaded.selection.version, 2); assert.equal(reloaded.selection.settingsText, whole);
  assert.deepEqual(JSON.parse(whole).providerRoute, JSON.parse(current).providerRoute);
  assert.deepEqual(JSON.parse(whole).roles.other, { kept: true });
  for (const pair of [null, { providerId: 'fixture' }, { model: 'fixture' }, { providerId: 'fixture', model: 'fixture', extra: true }]) {
    assert.throws(() => mergeSelectionLayerV1(JSON.stringify({ providerRoute: pair }), selection()), invalid);
    assert.throws(() => decodeSelectionEditsV1(JSON.stringify({ ...selection(), providerRoute: pair })), invalid);
  }
});
