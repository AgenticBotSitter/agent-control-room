import assert from "node:assert/strict";
import test from "node:test";
import { WebAccessError } from "../src/web/v1/access-verifier";
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
import { decodeSelectionEditsV1, encodeSelectionEditsV1, normalizeSelectionRunEditsV1, loopSelectionEffortSchemaV1, loopSelectionSchemaV1,
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
      { integrityKey: new Uint8Array(32).fill(65), adapter, policy, selectionReady:()=>true, selectionGuard:{capture:async()=>snapshot,assertCurrent:async()=>{}} }, () => now);
    await assert.rejects(service.intakeSelection(f.identity,f.project.projectId,
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
  let check: (text: string, context?: LoopSelectionCheckContextV1) => Promise<LoopPolicyCheckWithV1> = async () => ({ eligible: true, reasons: [], projection: projection(), snapshot: { ...snapshot } });
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
    f.setCheck(async () => ({ ...expected, projection: projected, snapshot: { ...snapshot } }));
    const value = await f.preview({ selection: selection(), overrides: { reviewFamily: true, standardFinal: true } });
    assert.equal(value.available, true, item.code);
    if (value.available) { assert.deepEqual(value.check, expected); assert.deepEqual(value.projection, projected); assert.deepEqual(value.blockers, []); }
  }
  assert.equal(f.checks.length, cases.length); await f.noWrites();
});

test('U81 T10 paid projection has separate product blocker and false readiness without changing checker eligibility', async t => {
  const f = await selectionFixture(t), projected = projection(); projected.lineup[1]!.requested.cost = 'paid'; projected.lineup[1]!.fallback = true;
  f.setCheck(async () => ({ eligible: true, reasons: [], projection: projected, snapshot: { ...snapshot } }));
  const value = await f.preview(); assert.equal(value.available, true);
  if (value.available) { assert.deepEqual(value.check, { eligible: true, reasons: [] });
    assert.deepEqual(value.blockers, [{ code: 'paid_execution_unavailable', explanation: 'Paid execution is unavailable.' }]); assert.equal(value.paidExecutionReady, false); }
  await f.noWrites();
});

test('U81 T12-P missing checker/projection, malformed check and unattested snapshots fail unavailable', async t => {
  const f = await selectionFixture(t);
  const failures = [async () => { throw new Error('private diagnostic never exposed'); },
    async () => ({ eligible: true, reasons: [] }),
    async () => ({ eligible: true, reasons: [], projection: projection() }), async () => ({ eligible: false, reasons: [], projection: projection(), snapshot: { ...snapshot } }),
    async () => ({ eligible: false, reasons: [{ code: 'FIXTURE', explanation: 'bad\nreason' }], projection: projection(), snapshot: { ...snapshot } }),
    async () => { const p = projection(); p.family_policy = 'wrong' as 'review-only'; return { eligible: true, reasons: [], projection: p, snapshot: { ...snapshot } }; },
    async () => { const p = projection(); p.lineup[0]!.requested.model = 'different'; return { eligible: true, reasons: [], projection: p, snapshot: { ...snapshot } }; },
    async () => { const p = projection(); p.lineup[1] = p.lineup[0]!; return { eligible: true, reasons: [], projection: p, snapshot: { ...snapshot } }; },
    async () => { const p = projection(); p.rosterDigest = 'd'.repeat(64); return { eligible: true, reasons: [], projection: p, snapshot: { ...snapshot } }; },
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
  f.setCheck(async () => { await new Promise(resolve => setTimeout(resolve, 6000)); f.advance(6000); return { eligible: true, reasons: [], projection: projection(), snapshot: { ...snapshot } }; });
  const value = await f.preview({ selection: selection(), overrides: { reviewFamily: true } });
  assert.equal(value.available, true); assert.equal(f.checks.length, 1); await f.noWrites();
  assert.doesNotMatch(JSON.stringify(value), /accepted_at|sameFamilyAcknowledgement|commandId|auth_tag/);
});

test('U81 T12-P snapshot drift during checker refuses preview without asserting admission serialization', async t => {
  const f = await selectionFixture(t);
  f.setCheck(async () => { f.setSnapshot({ ...snapshot, revision: 'fixture-2' }); return { eligible: true, reasons: [], projection: projection(), snapshot: { ...snapshot } }; });
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
  f.setCheck(async () => { await f.db.query('UPDATE control_role_grants SET revoked_at=$1', [new Date(now).toISOString()]); return { eligible: true, reasons: [], projection: projection(), snapshot: { ...snapshot } }; });
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
  assert.ok(scripts['test:improve-control-room'].includes('pnpm run test:improve-control-room:linux-without-macos-host-gates'));
  assert.ok(scripts['test:improve-control-room:linux-without-macos-host-gates'].includes("--test-name-pattern='^(?!(?:<root>|P71 real (?:provider )?settings check|P72 real Start final policy admission)$).+'"));
  assert.equal(scripts['test:loop-selection:real'], 'CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern=\'^U81 real selection check$\' tests/loop-selection-native.test.ts');
  assert.equal(scripts['test:loop-selection:host'], 'node scripts/check-loop-selection-host-gate.mjs');
  for (const [name, body] of Object.entries(scripts)) if (name !== 'test:loop-selection:real')
    assert.ok(!(body as string).includes('tests/loop-selection-native.test.ts'), 'host-only test excluded from '+name);
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /node scripts\/check-loop-selection-host-gate\.mjs/);
  assert.ok(!workflow.includes('tests/loop-selection-native.test.ts'));

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
    checkSettings: async text => { checked.push(text); return { eligible: false, reasons: [{ code: 'SYNTHETIC_STOP', explanation: 'Recorded checker stop' }],projection:projection(),snapshot }; },
  }, () => now);
  const adapter = { adapterId: 'adapter:fixture', toolingRevision: `sha256:${'a'.repeat(64)}`,
    schemaDigest: `sha256:${'b'.repeat(64)}`, contract: {}, available: () => true, reserveRun:()=>'fixture-reset-run' } as unknown as LoopAdapterV1;
  const service = new ImproveControlRoomLoopServiceV1(f.client, scope,
    { integrityKey: new Uint8Array(32).fill(65), adapter, policy, selectionReady:()=>true,selectionGuard:{capture:async()=>snapshot,assertCurrent:async()=>{}} }, () => now);
  for (const overrides of [undefined, { reviewFamily: false, standardFinal: false }, { reviewFamily: true, standardFinal: false }]) {
    const edits = { ...selection(), roles: { ...selection().roles, extra_role: { kept: true } }, kept: ['unchanged'], ...(overrides ? { overrides } : {}) };
    await assert.rejects(service.intakeSelection(f.identity,f.project.projectId,
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
    await assert.rejects(service.mutate(f.identity,f.project.projectId,null,'intake',
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
  await f.db.query(`UPDATE control_role_grants SET allowed_actions='["loop_policy.manage","loop_policy.read","loop_selection.read","providers.manage"]'::jsonb,project_ids='["*"]'::jsonb`);
  const { LoopProviderServiceV1 } = await import('../src/web/v1/loop-provider-service');
  await f.db.query(`INSERT INTO control_loop_roster_models(tenant_id,name,position,launcher,provider,family,model_class,roles,efforts,default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at)
    VALUES('tenant:web','fixture-model',1,'fixture','','','','','','','','on','','','','identity:web',$1)`, [new Date(now).toISOString()]);
  const providers = new LoopProviderServiceV1(f.db, scope, {availability: async () => { throw Error('no secret probe'); }}, () => now);
  await providers.upsert(f.identity, 'fixture-provider', {expectedVersion:0,provider:{provider_id:'fixture-provider',display_name:'Synthetic U81',
    base_url:'https://example.com/api',billing_kind:'subscription',secret_ref:{kind:'launcher',launcher:'fixture'},
    models:[{roster_name:'fixture-model',launcher:'fixture',served_model_id:'served/fixture'}],credit_amount_nano_usd:null,credit_expires_on:null,
    credit_note:'',price_source_url:null,price_source_format:null}}, 'u81-provider-create-0001');
  const policy = new LoopPolicyServiceV1(f.db, scope, f.tools, () => now, providers);
  const current = '{"providerRoute":{"providerId":"fixture-provider","model":"fixture-model"},"roles":{"other":{"kept":true}},"kept":[1,2]}';
  await policy.put(f.identity, f.project.projectId, 'selection', { expectedVersion: 0, settings: current }, 'u81-layer-initial-0001');
  const whole = mergeSelectionLayerV1(current, selection());
  assert.deepEqual(await policy.put(f.identity, f.project.projectId, 'selection', { expectedVersion: 1, settings: whole }, 'u81-layer-replace-0001'), { replayed: false, version: 2 });
  await assert.rejects(policy.put(f.identity, f.project.projectId, 'selection', { expectedVersion: 1, settings: '{}' }, 'u81-layer-stale-000001'), { code: 'conflict' });
  const reloaded = await policy.view(f.identity, f.project.projectId);
  assert.equal(reloaded.selection.version, 2); assert.equal(reloaded.selection.settingsText, whole);
  assert.deepEqual(JSON.parse(whole).providerRoute, JSON.parse(current).providerRoute);
  assert.deepEqual(JSON.parse(whole).roles.other, { kept: true });
  for (const pair of [null, { providerId: 'fixture' }, { model: 'fixture' }, { providerId: 'fixture', model: 'fixture', extra: true }]) {
    assert.throws(() => mergeSelectionLayerV1(JSON.stringify({ providerRoute: pair }), selection()), invalid);
    assert.throws(() => decodeSelectionEditsV1(JSON.stringify({ ...selection(), providerRoute: pair })), invalid);
  }
});

test('U81 direct preview handler enforces its own 8192-byte budget',async t=>{
  const f=await selectionFixture(t);
  const response=await f.handler(request(f.path,'POST',{padding:'x'.repeat(8192)}));
  assert.equal(response.status,413);assert.deepEqual(await response.json(),{error:'request_too_large'});
  assert.equal(f.checks.length,0);await f.noWrites();
});

test('U81 overrides-only edits reject unbound authority fields at the P71 boundary',()=>{
  for(const field of ['run','by','consent','cap','accepted_at','sameFamilyAcknowledgement','acceptSameFamilyRisk'])
    assert.throws(()=>normalizeSelectionRunEditsV1(JSON.stringify({overrides:{},[field]:'synthetic'})),{code:'invalid_request'},field);
});

test('U81-B R2 fresh intake intent checks the full frozen candidate before creating authority', async t => {
  const started = performance.now(), clock = () => now + Math.floor(performance.now() - started);
  const f = await taskFixture(clock); t.after(() => f.db.close());
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"templateId":"control-room"}'::jsonb) WHERE id=$1`, [f.project.projectId]);
  const adapter = recordedIntakeAdapter();
  const contexts: LoopSelectionCheckContextV1[] = [];
  const policy = new LoopPolicyServiceV1(f.client, scope, { settingsText: '{}', checkSettings: async (_text, context) => {
    assert.ok(context); contexts.push(context);
    for (const table of ['control_loop_improvement_requests', 'control_loop_policy_input_sources', 'control_loop_improvement_commands'])
      assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length, 0, 'checker precedes all admission writes');
    return { eligible: true, reasons: [], projection: projection(), snapshot };
  } }, clock);
  const guard: LoopSelectionSnapshotGuardV1 = { capture: async () => snapshot, assertCurrent: async () => {} };
  const service = new ImproveControlRoomLoopServiceV1(f.client, scope,
    { integrityKey: new Uint8Array(32).fill(65), adapter, policy, selectionReady:()=>true,selectionGuard: guard }, clock);
  const receipt = await service.intakeSelection(f.identity,f.project.projectId,
    { description: 'Check the immutable selection', settingsEdits: encodeSelectionEditsV1(selection(), { reviewFamily: true, standardFinal: false }),
      acceptSameFamilyRisk: true }, 'u81-b-fresh-intent-0001');
  assert.equal(receipt.state, 'accepted');
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]!.mode, 'admission');
  const row = (await f.db.query<{binding: LoopBridgeBindingV1;command_id:string}>(`SELECT binding,command_id FROM control_loop_improvement_commands WHERE entry_kind='claim'`)).rows[0]!;
  assert.deepEqual(contexts[0], { mode: 'admission', binding: row.binding, commandId: row.command_id });
  const acceptedAt = row.binding.sameFamilyAcknowledgement!.accepted_at;
  assert.ok(Date.parse(acceptedAt) >= now);
  assert.deepEqual(row.binding.sameFamilyAcknowledgement, { schema_version: 1, rule: 'R296', run: 'fixture-u81-run',
    by: 'owner', accepted_at: acceptedAt, acknowledgement: 'same-family-risk-accepted' });
});

/** Deterministic recorded engine with signed receipts. It never spawns or calls a provider. */
async function selectionAdmissionFixture(t: TestContext, freshness=5000) {
  let offset=0;
  const started = performance.now(), clock = () => now + offset + Math.floor(performance.now() - started);
  const f = await taskFixture(clock); t.after(() => f.db.close());
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"templateId":"control-room"}'::jsonb) WHERE id=$1`, [f.project.projectId]);
  const adapter = recordedIntakeAdapter(), original = adapter.intake;
  let current: Awaited<ReturnType<LoopAdapterV1['status']>>;
  let spawns = 0, changed = false, refuse = false, missing = false, malformed = false;
  const checks: {text:string;context:LoopSelectionCheckContextV1}[] = [];
  const dispatches: import('../src/web/v1/loop-selection-service').LoopSelectionDispatchV1[] = [];
  adapter.intake = async (...args) => { spawns++; if(args[5]) dispatches.push(args[5]); return current = await original(...args); };
  adapter.status = async () => structuredClone(current);
  adapter.contract.matchesSavedInput = (_run, observation, input) => observation.settingsDigest === input.settingsSha256 && sha(current.description) === input.requestSha256;
  const next = (state:'ready'|'running', commandId:string, binding:LoopBridgeBindingV1, fence:()=>void,
    capsule?:import('../src/web/v1/loop-selection-service').LoopSelectionDispatchV1) => {
    fence(); spawns++; if(capsule) dispatches.push(capsule);
    current.state=state; current.revision++;
    if(state==='ready') current.confirmation={path:'request.md',sha256:sha(current.description),who:'owner',at:new Date(clock()).toISOString(),input_version:current.inputVersion};
    current.receipts.push({commandId,bindingDigest:sha256Digest(binding),state:'accepted',error:null,evidenceDigest:sha256Digest({commandId})});
    return structuredClone(current);
  };
  adapter.confirmRequest = async (id,b,fence,_text,capsule) => next('ready',id,b,fence,capsule);
  adapter.start = async (id,b,fence,_text,_admission,capsule) => next('running',id,b,fence,capsule);
  const policy = new LoopPolicyServiceV1(f.client,scope,{settingsText:'{}',checkSettings:async(text,context)=>{
    assert.ok(context);checks.push({text,context});
    if(missing) return {eligible:true,reasons:[]};
    if(JSON.parse(text).overrides?.reviewFamily && context.mode==='admission' && !context.binding.sameFamilyAcknowledgement)
      return {eligible:false,reasons:[{code:'REVIEW_FAMILY',explanation:'Current input requires review acceptance.'}],projection:projection(),snapshot};
    return {eligible:!refuse,reasons:refuse&&!malformed?[{code:'MODEL_OFF',explanation:'The selected model is off.'}]:[],projection:projection(),snapshot};
  }},clock);
  const guard:LoopSelectionSnapshotGuardV1={capture:async()=>snapshot,assertCurrent:async()=>{if(changed)throw new Error('selection_snapshot_changed');}};
  const service=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:new Uint8Array(32).fill(65),adapter,policy,selectionReady:()=>true,selectionGuard:guard,admissionFreshnessMs:freshness},clock);
  const intake=async(accept=false)=>service.intakeSelection(f.identity,f.project.projectId,{
    description:'Check immutable B8 admission',settingsEdits:encodeSelectionEditsV1(selection(),{reviewFamily:accept,standardFinal:false}),
    ...(accept?{acceptSameFamilyRisk:true}:{})},'u81-b-ordinary-intake-0001');
  const confirm=async(rid:string,accept=false)=>service.mutate(f.identity,f.project.projectId,rid,'confirm',{
    expectedVersion:1,expectedRevision:current.revision,requestSha256:sha(current.description),settingsSha256:current.settingsSha256,
    ...(accept?{acceptSameFamilyRisk:true}:{})},'u81-b-ordinary-confirm-0001');
  const start=async(rid:string,accept=false)=>{
    const status=await service.status(f.identity,f.project.projectId,rid),request=status.request;
    return service.mutate(f.identity,f.project.projectId,rid,'start',{expectedVersion:request.currentVersion,expectedRevision:current.revision,
      runLinkId:request.runLink!.runLinkId,...(accept?{acceptSameFamilyRisk:true}:{})},'u81-b-ordinary-start-0001');
  };
  return {...f,service,adapter,policy,guard,clock,advanceTime(ms:number){offset+=ms;},intake,confirm,start,checks,dispatches,get spawns(){return spawns;},
    drift(){changed=true;},off(){refuse=true;},missing(){missing=true;},malformed(){refuse=true;malformed=true;},
    normalize(){current.description+=' Normalized.';current.inputVersion=2;current.revision++;}};
}

test('U81-B R3/T6/T11 intake Confirm Start check exact saved bytes and immutable dispatch identities',async t=>{
  const f=await selectionAdmissionFixture(t),r=await f.intake(); assert.equal(r.state,'accepted');
  assert.equal((await f.confirm(r.requestId)).state,'accepted');
  assert.equal((await f.start(r.requestId)).state,'accepted');
  assert.equal(f.checks.length,3);assert.equal(f.spawns,3);assert.equal(f.dispatches.length,3);
  const rows=(await f.db.query<{binding:LoopBridgeBindingV1;command_id:string}>(`SELECT binding,command_id FROM control_loop_improvement_commands WHERE entry_kind='claim' ORDER BY created_at,command_id`)).rows;
  assert.equal(rows.length,3);
  for(const row of rows){
    const checked=f.checks.find(x=>x.context.mode==='admission'&&x.context.commandId===row.command_id)!;
    assert.ok(checked);assert.equal(checked.context.mode,'admission');
    assert.deepEqual(checked.context,{mode:'admission',commandId:row.command_id,binding:row.binding});
    assert.equal(sha(checked.text),row.binding.settingsSha256);
    assert.deepEqual(f.dispatches.find(x=>x.commandId===row.command_id),{commandId:row.command_id,bindingDigest:sha256Digest(row.binding),snapshot,lineupDigest:'c'.repeat(64)});
  }
  assert.equal(new Set(f.checks.map(x=>x.text)).size,1);
});

test('U81-B R4 model switched off after intake refuses Start with zero additional claims or spawns',async t=>{
  const f=await selectionAdmissionFixture(t),r=await f.intake();await f.confirm(r.requestId);f.off();
  await assert.rejects(f.start(r.requestId),{message:'loop_policy_refused'});
  assert.equal(f.checks.length,3);assert.equal(f.spawns,2);
  assert.equal((await f.db.query(`SELECT * FROM control_loop_improvement_commands WHERE operation='start'`)).rows.length,0);
});

for(const failure of ['drift','missing','malformed'] as const)test(`U81-B T9/T12 ${failure} refuses intake before any draft/source/claim`,async t=>{
  const f=await selectionAdmissionFixture(t);f[failure]();await assert.rejects(f.intake());assert.equal(f.spawns,0);
  for(const table of ['control_loop_improvement_requests','control_loop_policy_input_sources','control_loop_improvement_commands'])
    assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length,0);
});

test('U81-B T7 exact replay keeps one checked record and one dispatch',async t=>{
  const f=await selectionAdmissionFixture(t),r=await f.intake(true),again=await f.intake(true);
  assert.equal(again.commandId,r.commandId);assert.equal(again.replayed,true);assert.equal(f.spawns,1);assert.equal(f.checks.length,1);
  assert.equal((await f.db.query(`SELECT * FROM control_loop_improvement_commands WHERE entry_kind='claim'`)).rows.length,1);
});

test('U81-B T7 accepted lineage retains its original timestamp beyond five seconds',async t=>{
  const f=await selectionAdmissionFixture(t),r=await f.intake(true);
  const accepted=f.checks[0]!.context;assert.equal(accepted.mode,'admission');if(accepted.mode!=='admission')throw Error('context');
  const ack=structuredClone(accepted.binding.sameFamilyAcknowledgement);
  f.advanceTime(6000);assert.equal((await f.confirm(r.requestId)).state,'accepted');
  f.advanceTime(6000);assert.equal((await f.start(r.requestId)).state,'accepted');
  for(const checked of f.checks){assert.equal(checked.context.mode,'admission');if(checked.context.mode==='admission')assert.deepEqual(checked.context.binding.sameFamilyAcknowledgement,ack);}
});

test('U81-B T7 explicit fresh intent at unchanged Confirm and Start mints a new timestamp',async t=>{
  const f=await selectionAdmissionFixture(t),r=await f.intake(true);
  f.advanceTime(6000);assert.equal((await f.confirm(r.requestId,true)).state,'accepted');
  f.advanceTime(6000);assert.equal((await f.start(r.requestId,true)).state,'accepted');
  const times=f.checks.map(x=>x.context.mode==='admission'?Date.parse(x.context.binding.sameFamilyAcknowledgement!.accepted_at):0);
  assert.ok(times[1]!>times[0]!+5000);assert.ok(times[2]!>times[1]!+5000);
});

test('U81-B T7 normalized Confirm requires new intent for the changed input',async t=>{
  const f=await selectionAdmissionFixture(t),r=await f.intake(true);f.normalize();
  await assert.rejects(f.confirm(r.requestId),{message:'loop_policy_refused'});
  assert.equal(f.spawns,1);assert.equal((await f.db.query(`SELECT * FROM control_loop_improvement_commands WHERE operation='confirm'`)).rows.length,0);
  assert.equal((await f.confirm(r.requestId,true)).state,'accepted');
  const c=f.checks.at(-1)!.context;assert.equal(c.mode,'admission');if(c.mode==='admission')assert.equal(c.binding.localVersion,2);
});

test('U81-B T7 acceptance flag without review override refuses before checker or claim',async t=>{
  const f=await selectionAdmissionFixture(t);
  await assert.rejects(f.service.intakeSelection(f.identity,f.project.projectId,{
    description:'SYNTHETIC inapplicable acceptance',settingsEdits:encodeSelectionEditsV1(selection()),acceptSameFamilyRisk:true
  },'u81-b-not-applicable-0001'),{message:'loop_policy_refused'});
  assert.equal(f.checks.length,0);assert.equal(f.spawns,0);
  assert.equal((await f.db.query('SELECT * FROM control_loop_improvement_commands')).rows.length,0);
});

for(const freshness of [1000,999,1])test(`U81-B T12 window ${freshness} refuses before checker`,async t=>{
  const f=await selectionAdmissionFixture(t,freshness);await assert.rejects(f.intake());
  assert.equal(f.checks.length,0);assert.equal(f.spawns,0);
});

test('U81-B T12 shortened window cancels checker at the single reserve cutoff with zero rows',async t=>{
  const f=await selectionAdmissionFixture(t,1500);let aborted=false;
  t.mock.method(f.policy,'checkWith',async(_text:string, _context:LoopSelectionCheckContextV1, execution:import('../src/web/v1/loop-policy-service').LoopSelectionCheckExecutionV1)=>{
    await new Promise<void>(resolve=>execution.signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));
    throw Error('cancelled fixture checker reaped');
  });
  const started=performance.now();await assert.rejects(f.intake());
  assert.ok(aborted);assert.ok(performance.now()-started>=400);assert.ok(performance.now()-started<2000);
  for(const table of ['control_loop_improvement_requests','control_loop_policy_input_sources','control_loop_improvement_commands'])
    assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length,0);
});

test('U81-B T12 current-reader delay cannot reset the candidate deadline',async t=>{
  const f=await selectionAdmissionFixture(t,1500);
  t.mock.method(f.guard,'assertCurrent',async()=>{await new Promise(r=>setTimeout(r,1550));});
  await assert.rejects(f.intake());assert.equal(f.spawns,0);
  assert.equal((await f.db.query('SELECT * FROM control_loop_improvement_commands')).rows.length,0);
  assert.equal((await f.db.query('SELECT * FROM control_loop_improvement_requests')).rows.length,0);
});

test('U81-B T8 same key changed body conflicts without rechecking or dispatching',async t=>{
  const f=await selectionAdmissionFixture(t);await f.intake(true);
  await assert.rejects(f.intake(false),{code:'conflict'});assert.equal(f.checks.length,1);assert.equal(f.spawns,1);
});

for(const kind of ['revoked-owner','expired-session','wall-forward','wall-backward'] as const)
  test(`U81-B T8/T14 ${kind} during checking leaves zero authority`,async t=>{
    const f=await selectionAdmissionFixture(t),original=f.policy.checkWith.bind(f.policy);
    t.mock.method(f.policy,'checkWith',async(...args:Parameters<typeof original>)=>{
      const result=await original(...args);
      if(kind==='revoked-owner')await f.db.query('UPDATE control_role_grants SET revoked_at=$1',[new Date(f.clock()).toISOString()]);
      else f.advanceTime(kind==='expired-session'?400000:kind==='wall-forward'?5001:-5001);
      return result;
    });
    await assert.rejects(f.intake(true));assert.equal(f.spawns,0);
    for(const table of ['control_loop_improvement_requests','control_loop_policy_input_sources','control_loop_improvement_commands'])
      assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length,0);
  });

test('U81-B T12 shortened window succeeds after preparation without restamping',async t=>{
  const f=await selectionAdmissionFixture(t,1500),original=f.policy.checkWith.bind(f.policy);
  let entered=0,completed=0;
  t.mock.method(f.policy,'checkWith',async(...args:Parameters<typeof original>)=>{
    entered=performance.now();await new Promise(r=>setTimeout(r,100));
    assert.ok(args[2]!.timeoutMs>1000&&args[2]!.timeoutMs<=1500,'full remaining-to-D allowance');
    const result=await original(...args);completed=performance.now();return result;
  });
  const result=await f.intake(true);assert.equal(result.state,'accepted');
  assert.ok(completed-entered>=90);assert.ok(performance.now()-entered<1500);
  const row=(await f.db.query<{binding:LoopBridgeBindingV1}>("SELECT binding FROM control_loop_improvement_commands WHERE entry_kind='claim'")).rows[0]!;
  assert.equal(f.checks[0]!.context.mode,'admission');
  if(f.checks[0]!.context.mode==='admission')assert.deepEqual(row.binding,f.checks[0]!.context.binding,'entire checked binding retained');
});

test('U81-B T7 claim without accepted result cannot supply copied acceptance',async t=>{
  const f=await selectionAdmissionFixture(t),intake=await f.intake(true);
  assert.equal(intake.state,'accepted');
  // Recorded interrupted journal: retain the signed claim and run, remove only its result.
  await f.db.exec("SET session_replication_role=replica; DELETE FROM control_loop_improvement_commands WHERE entry_kind='result'; SET session_replication_role=origin;");
  assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_commands WHERE entry_kind='result'")).rows.length,0);
  await assert.rejects(f.confirm(intake.requestId),{message:'loop_policy_refused'});
  assert.equal(f.spawns,1);
  assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_commands WHERE operation='confirm'")).rows.length,0);
});

test('U81-B D29 copied and retained provenance',async t=>{
  const f=await selectionAdmissionFixture(t),r=await f.intake();f.normalize();
  await f.service.mutate(f.identity,f.project.projectId,r.requestId,'confirm',{expectedVersion:1,expectedRevision:2,
    requestSha256:sha('Check immutable B8 admission Normalized.'),settingsSha256:sha(f.checks[0]!.text)},'u81-d29-normalized-confirm-0001');
  assert.deepEqual((await f.db.query('SELECT input_version,admission_kind FROM control_loop_policy_input_admissions ORDER BY input_version')).rows,
    [{input_version:1,admission_kind:'product-b8'},{input_version:2,admission_kind:'product-b8'}]);
  const restarted=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:new Uint8Array(32).fill(65),adapter:f.adapter,policy:f.policy,selectionGuard:f.guard,selectionReady:()=>true},f.clock);
  const status=await restarted.status(f.identity,f.project.projectId,r.requestId);assert.ok(status.selection);
  // Native endpoint cannot reuse the exact B8 key, body and settings to downgrade it.
  const body={description:'Check immutable B8 admission',settingsEdits:encodeSelectionEditsV1(selection(),{reviewFamily:false,standardFinal:false})};
  const before=(await f.db.query('SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind')).rows;
  await assert.rejects(restarted.mutate(f.identity,f.project.projectId,null,'intake',body,'u81-b-ordinary-intake-0001'),{code:'conflict'});
  assert.deepEqual((await f.db.query('SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind')).rows,before);
  assert.equal(f.spawns,2);
});

test('U81-B D29 source resolver and copy fail closed with typed unavailable',async t=>{
  const f=await selectionAdmissionFixture(t);
  const resolve=(rows:unknown[])=>f.policy.inputAdmissionKind({query:async()=>({rows})} as DatabaseSession,'request:fixture',2);
  for(const rows of [[{input_version:1,admission_kind:'product-b8'}],[{input_version:2,admission_kind:'product-b8'}],
    [{input_version:1,admission_kind:'native-p71'},{input_version:2,admission_kind:'product-b8'}],
    [{input_version:1,admission_kind:'spoofed'},{input_version:2,admission_kind:'spoofed'}]])
    await assert.rejects(resolve(rows),error=>error instanceof WebAccessError&&error.code==='service_unavailable');
  assert.equal(await resolve([]),'historical-native');
  assert.equal(await resolve([{input_version:1,admission_kind:'native-p71'},{input_version:2,admission_kind:'native-p71'}]),'native-p71');
  let copies=0;
  const tx={query:async(sql:string)=>{if(sql.startsWith('SELECT s.input_version'))return {rows:[{input_version:1,admission_kind:'product-b8'}]};copies++;return {rows:[]};}} as DatabaseSession;
  await assert.rejects(f.policy.copyInputSources(tx,{requestId:'request:fixture',fromVersion:1,toVersion:2}),error=>error instanceof WebAccessError&&error.code==='service_unavailable');assert.equal(copies,1);
});

test('U81-B D29 B8 missing guard refuses with zero claims',async t=>{
  const f=await selectionAdmissionFixture(t);
  const unguarded=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:new Uint8Array(32).fill(65),adapter:f.adapter,policy:f.policy,selectionReady:()=>true},f.clock);
  for(const text of [encodeSelectionEditsV1(selection()),JSON.stringify({...selection(),overrides:{reviewFamily:false,standardFinal:false}}),'{}'])
    await assert.rejects(unguarded.intakeSelection(f.identity,f.project.projectId,{description:'Recorded B8 refusal',settingsEdits:text},'u81-d29-missing-guard-'+sha(text).slice(0,16)),/loop_bridge_contract_unavailable/);
  assert.equal(f.spawns,0);assert.equal((await f.db.query('SELECT * FROM control_loop_improvement_commands')).rows.length,0);
  const r=await f.intake();
  await assert.rejects(unguarded.mutate(f.identity,f.project.projectId,r.requestId,'confirm',{expectedVersion:1,expectedRevision:1,
    requestSha256:sha('Check immutable B8 admission'),settingsSha256:sha(f.checks[0]!.text)},'u81-d29-retained-guard-0001'),/loop_bridge_contract_unavailable/);
  assert.equal(f.spawns,1);
});

test('U81-B D29 missing provenance blocks linked status without hiding the request',async t=>{
  const f=await selectionAdmissionFixture(t),r=await f.intake();
  t.mock.method(f.policy,'inputAdmissionKind',async()=>{throw new WebAccessError('service_unavailable');});
  const before=(await f.db.query('SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind')).rows;
  const status=await f.service.status(f.identity,f.project.projectId,r.requestId);
  assert.equal(status.display.canStart,false);assert.equal(status.selection,undefined);assert.equal(status.decisions?.gate?.kind,'blocked');
  assert.equal((status.decisions?.gate as {code:string}).code,'UNAVAILABLE');
  const desk=await f.service.viewDesk(f.identity,f.project.projectId);assert.ok(JSON.stringify(desk).includes(r.requestId));
  await assert.rejects(f.confirm(r.requestId),error=>error instanceof WebAccessError&&error.code==='service_unavailable');
  assert.deepEqual((await f.db.query('SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind')).rows,before);assert.equal(f.spawns,1);
});

test('U81-B D29 readiness refuses before capture or checker',async t=>{
  const f=await selectionAdmissionFixture(t);let captures=0;
  const guard={capture:async()=>{captures++;return snapshot;},assertCurrent:async()=>{}};
  for(const ready of [undefined,()=>false,()=>{throw Error('startup failed');}]){
    const service=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:new Uint8Array(32).fill(65),adapter:f.adapter,policy:f.policy,selectionGuard:guard,selectionReady:ready},f.clock);
    await assert.rejects(service.intakeSelection(f.identity,f.project.projectId,{description:'B8 startup readiness',settingsEdits:encodeSelectionEditsV1(selection())},'u81-d29-readiness-intake-0001'),/loop_bridge_contract_unavailable/);
  }
  assert.equal(captures,0,'unready source must never be captured');assert.equal(f.checks.length,0);assert.equal(f.spawns,0);
});

test('U81-B D29 native rejects product intent',async t=>{
  const f=await selectionAdmissionFixture(t);
  await assert.rejects(f.service.mutate(f.identity,f.project.projectId,null,'intake',{
    description:'Native cannot issue acknowledgement',settingsEdits:encodeSelectionEditsV1(selection(),{reviewFamily:true}),acceptSameFamilyRisk:true},'u81-d29-native-intent-0001'),{code:'invalid_request'});
  assert.equal(f.checks.length,0);assert.equal(f.spawns,0);assert.equal((await f.db.query('SELECT * FROM control_loop_improvement_commands')).rows.length,0);
});

test('U81-B D33 admission insert failure rolls back signed input source and claim',async t=>{
  const f=await selectionAdmissionFixture(t),record=f.policy.recordInputSources.bind(f.policy);
  t.mock.method(f.policy,'recordInputSources',(tx: DatabaseSession,value: Parameters<typeof record>[1])=>record({query:async(sql,params)=>{
    if(sql.includes('INSERT INTO control_loop_policy_input_admissions'))throw new WebAccessError('service_unavailable');
    return tx.query(sql,params);
  }} as DatabaseSession,value));
  await assert.rejects(f.intake(),{code:'service_unavailable'});
  for(const table of ['control_loop_improvement_requests','control_loop_improvement_inputs','control_loop_policy_input_sources','control_loop_policy_input_admissions','control_loop_improvement_commands'])
    assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length,0,table);
  assert.equal(f.spawns,0);
});

test('U81-B D33 copied admission insert failure rolls back normalized input and claim',async t=>{
  const f=await selectionAdmissionFixture(t),r=await f.intake(),copy=f.policy.copyInputSources.bind(f.policy);f.normalize();
  const tables=['control_loop_improvement_inputs','control_loop_policy_input_sources','control_loop_policy_input_admissions','control_loop_improvement_commands'];
  const saved=()=>Promise.all(tables.map(async table=>(await f.db.query(`SELECT * FROM ${table} ORDER BY 1,2,3`)).rows));
  const before=await saved();
  t.mock.method(f.policy,'copyInputSources',(tx: DatabaseSession,value: Parameters<typeof copy>[1])=>copy({query:async(sql,params)=>{
    if(sql.includes('INSERT INTO control_loop_policy_input_admissions'))throw new WebAccessError('service_unavailable');
    return tx.query(sql,params);
  }} as DatabaseSession,value));
  await assert.rejects(f.confirm(r.requestId),{code:'service_unavailable'});
  assert.deepEqual(await saved(),before);assert.equal(f.spawns,1);
});

for(const linked of [false,true]) test(`U81-B D33 provenance query failure blocks ${linked?'linked':'unlinked'} status without hiding request`,async t=>{
  const f=await selectionAdmissionFixture(t);
  if(!linked)t.mock.method(f.adapter,'intake',async()=>{throw new Error('Recorded unavailable intake');});
  const r=await f.intake();
  t.mock.method(f.policy,'inputAdmissionKind',async()=>{throw new WebAccessError('service_unavailable');});
  const before=(await f.db.query('SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind')).rows;
  const status=await f.service.status(f.identity,f.project.projectId,r.requestId);
  assert.equal(status.display.canStart,false);assert.equal(status.selection,undefined);assert.equal(status.decisions?.gate?.kind,'blocked');
  assert.equal((status.decisions?.gate as {code:string}).code,'UNAVAILABLE');
  assert.ok((await f.service.viewDesk(f.identity,f.project.projectId)).loopRequests.some(row=>row.requestId===r.requestId));
  assert.deepEqual((await f.db.query('SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind')).rows,before);
});

test('U81-B T10 paid slot in saved candidate refuses with zero admission authority',async t=>{
  const f=await selectionAdmissionFixture(t),check=f.policy.checkWith.bind(f.policy);
  t.mock.method(f.policy,'checkWith',async(...args:Parameters<typeof check>)=>{
    const result=await check(...args),paid=projection();paid.lineup[0]!.requested.cost='paid';
    return {...result,projection:paid};
  });
  await assert.rejects(f.intake(),/loop_bridge_contract_unavailable/);assert.equal(f.spawns,0);
  for(const table of ['control_loop_improvement_requests','control_loop_improvement_inputs','control_loop_policy_input_sources','control_loop_policy_input_admissions','control_loop_improvement_commands'])
    assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length,0);
});

test('U81-B D29 historical draft key cannot issue B8 provenance',async t=>{
  const f=await selectionAdmissionFixture(t);
  const {ImproveControlRoomDeskServiceV1}=await import('../src/improve-control-room/v1/service');
  const text=composeLoopSettingsV1({defaultsText:'{}',runEdits:encodeSelectionEditsV1(selection(),{reviewFamily:false,standardFinal:false})}).text;
  const desk=new ImproveControlRoomDeskServiceV1(f.client,scope,new Uint8Array(32).fill(65),undefined,f.clock,f.adapter.contract);
  const old=await desk.saveLoopDraft(f.identity,f.project.projectId,{description:'Check immutable B8 admission',settingsText:text},'u81-b-ordinary-intake-0001');
  const tables=['control_loop_improvement_requests','control_loop_improvement_inputs','control_loop_policy_input_sources','control_loop_policy_input_admissions','control_loop_improvement_commands'];
  const saved=()=>Promise.all(tables.map(async table=>(await f.db.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows));
  const before=await saved();
  await assert.rejects(f.intake(),error=>error instanceof WebAccessError&&error.code==='service_unavailable');
  assert.deepEqual(await saved(),before);assert.equal(f.spawns,0);
  assert.equal((await desk.viewLoopDesk(f.identity,f.project.projectId)).loopRequests[0]!.requestId,old.request.requestId);
});


test('U81-B R11 migration header describes the admissions table', async () => {
  const header = (await readFile('db/migrations/0316_control_loop_selection_acknowledgement.sql','utf8')).split('\n')[0]!;
  assert.match(header, /admission provenance/);
  assert.doesNotMatch(header, /no new tables/);
});


test('U81-B R11 migration explicitly locks sources before admission DDL and backfill', async () => {
  const ddl = await readFile('db/migrations/0316_control_loop_selection_acknowledgement.sql','utf8');
  const lock = ddl.indexOf('LOCK TABLE control_loop_policy_input_sources IN SHARE ROW EXCLUSIVE MODE;');
  assert.ok(lock >= 0, 'explicit bounded source lock required');
  assert.ok(ddl.indexOf("SET LOCAL lock_timeout = '1s'") < lock);
  assert.ok(lock < ddl.indexOf('CREATE TABLE control_loop_policy_input_admissions'));
  assert.ok(lock < ddl.indexOf('INSERT INTO control_loop_policy_input_admissions'));
});
