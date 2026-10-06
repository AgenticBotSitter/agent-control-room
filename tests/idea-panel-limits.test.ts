import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Digest } from '../src/security';
import { buildIdeaLabFixtureV1 } from '../src/idea-lab/v1/fixture';
import { buildIdeaLabSessionV1 } from '../src/idea-lab/v1/contracts';
import { buildRepositoryFakeProviderEvidenceV1, DeterministicIdeaLabFakeDriverV1,
  IdeaLabBotCoordinatorV1 } from '../src/idea-lab/v1/coordinator';
import { IdeaLabBotRunStoreV1 } from '../src/idea-lab/v1/coordinator-store';
import { Hermes021IdeaLabFilteredDriverV1 } from '../src/idea-lab/v1/hermes-021-filtered-driver';
import { IDEA_LAB_HERMES_021_VERSION_V1, IDEA_LAB_HERMES_021_REVISION_V1 }
  from '../src/idea-lab/v1/hermes-021-panel-packet';
import type { IdeaLabProjectRegistryStoreV1 } from '../src/idea-lab/v1/store';
import type { DatabaseClient, DatabaseSession } from '../src/persistence/database';

const at = '2026-10-02T12:00:00.000Z';
const digest = (label: string) => sha256Digest({ synthetic: label });

// Strict in-memory query port, not a SQL engine. Production ledger code still
// authenticates its records, computes totals and performs every transition.
function ledgerFixture(afterMark?: () => void) {
  const events: Record<string, unknown>[] = [];
  const session: DatabaseSession = { async query<T>(sql: string, params: unknown[] = []) {
    if (sql.startsWith('SELECT id FROM workspaces')) return { rows: [{ id: params[1] }] as T[] };
    if (sql.startsWith('SELECT version,payload,run_digest,run_auth_tag')) {
      const rows = events.filter(row => row.run_id === params[0]);
      return { rows: structuredClone(sql.includes('DESC LIMIT 1') ? rows.slice(-1) : rows) as T[] };
    }
    if (sql.startsWith('INSERT INTO control_idea_bot_run_events')) {
      const initial = sql.includes('VALUES($1,1,');
      events.push({ run_id: params[0], version: initial ? 1 : params[1],
        payload: JSON.parse(params[initial ? 7 : 8] as string),
        run_digest: params[initial ? 5 : 6], run_auth_tag: params[initial ? 6 : 7] });
      if ((events.at(-1)!.payload as { safeCode: string }).safeCode === 'provider_marked') afterMark?.();
      return { rows: [] };
    }
    throw new Error('unexpected_fake_query');
  } };
  let tail = Promise.resolve();
  const db: DatabaseClient = { query: session.query,
    async transaction<T>(work: (tx: DatabaseSession) => Promise<T>) {
      const before = tail; let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await before; const length = events.length;
      try { return await work(session); } catch (error) { events.length = length; throw error; }
      finally { release(); }
    },
    async transactionWithPreCommitCheck<T>(work: (tx: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) {
      return db.transaction(async tx => { const value = await work(tx); await check(); return value; });
    } };
  return new IdeaLabBotRunStoreV1(db, new Uint8Array(32).fill(7));
}

function inputFixture(label: string) {
  const source = buildIdeaLabFixtureV1().session;
  const session = buildIdeaLabSessionV1({ tenantId: source.tenantId, workspaceId: source.workspaceId,
    title: source.title, ideaSummary: source.ideaSummary, targetCustomer: source.targetCustomer,
    participants: source.participants, createdByIdentityDigest: source.createdByIdentityDigest,
    sessionId: `idea:${label}`, maxRounds: 1,
    maxDurationSeconds: 60, maxCostUsd: 4, createdAt: at });
  const evidence = session.participants.map((participant, index) => buildRepositoryFakeProviderEvidenceV1(session, participant,
    { evidenceId: `evidence:${label}:${index}`, capturedAt: at, expiresAt: '2026-10-02T12:05:00.000Z' }));
  return { runId: `run:${label}`, session, evidence, safePrompt: 'Compare this bounded idea.' };
}

function registryFixture() {
  const contributions: unknown[] = [];
  return { registry: { async recordContribution(value: unknown) { contributions.push(value); },
    async listContributions() { return contributions; } } as unknown as IdeaLabProjectRegistryStoreV1, contributions };
}

test('R6S-01: a four-dollar panel stops before a second three-dollar call', { timeout: 2000 }, async () => {
  const input = inputFixture('overspend'), ledger = ledgerFixture(), registry = registryFixture();
  const fake = new DeterministicIdeaLabFakeDriverV1(); let calls = 0;
  const driver = { mode: 'repository_fake' as const, maximumCallCostUsd: 3, async invoke(value: Parameters<typeof fake.invoke>[0]) {
    calls++; return { ...await fake.invoke(value), costUsd: 3 };
  } };
  const coordinator = new IdeaLabBotCoordinatorV1(ledger, registry.registry, driver, () => at);
  const run = await coordinator.execute(input);
  assert.equal(calls, 1);
  assert.equal(run.safeCode, 'budget_exhausted_before_provider');
  assert.equal(run.state, 'failed_definite');
  assert.equal(run.costUsd, 3);
  assert.equal(run.messagesUsed, 1);
  assert.equal(run.attempts.length, 1);
  assert.equal(registry.contributions.length, 1);
  assert.deepEqual(await coordinator.execute(input), run);
  assert.equal(calls, 1, 'terminal retry must not reinvoke');
  console.log(JSON.stringify({ finding: 'R6S-01', cap: 4, simulatedCallCost: 3, recordedCost: run.costUsd, calls }));
});

test('R6S-01 stress: fifty separate panels each refuse at the budget edge', { timeout: 3000 }, async () => {
  const fake = new DeterministicIdeaLabFakeDriverV1(); let calls = 0;
  const runs = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
    const ledger = ledgerFixture(), registry = registryFixture();
    const driver = { mode: 'repository_fake' as const, maximumCallCostUsd: 3, async invoke(value: Parameters<typeof fake.invoke>[0]) {
      calls++; return { ...await fake.invoke(value), costUsd: 3 };
    } };
    return new IdeaLabBotCoordinatorV1(ledger, registry.registry, driver, () => at).execute(inputFixture(`burst${index}`));
  }));
  assert.equal(calls, 50);
  assert.equal(runs.filter(run => run.safeCode === 'budget_exhausted_before_provider' && run.costUsd === 3).length, 50);
});

function gatewayFixture(failure = false) {
  const input = inputFixture('gateway');
  const participant = input.session.participants[0]!;
  const evidence = { ...input.evidence[0]!, mode: 'hermes_bot_mode_filtered' as const, harnessPackage: 'hermes_agent' as const,
    harnessVersion: IDEA_LAB_HERMES_021_VERSION_V1, sourceRevision: IDEA_LAB_HERMES_021_REVISION_V1 };
  const binding = { participantId: participant.participantId, participantIdentityDigest: participant.identityDigest,
    providerEvidenceDigest: evidence.evidenceDigest, runtimeIdentityDigest: digest('runtime'),
    profileIdentityDigest: evidence.profileIdDigest, conversationIdentityDigest: evidence.conversationIdDigest };
  // This driver receives admission already verified by the coordinator. This
  // fixture exercises only its gateway projection, not admission authorization.
  const liveAdmission = { runtime: { providerId: 'hermes_bot_mode', adapterId: 'adapter.hermes.gateway.v2',
    runtimeVersion: IDEA_LAB_HERMES_021_VERSION_V1, runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1 },
    participantBindings: [binding], ceilings: { maxDurationSeconds: 60, maxCostUsd: 4 },
    ownerWindow: { expiresAt: '2026-10-02T12:01:00.000Z' } };
  const invocation = { session: input.session, participant, round: 1, safePrompt: input.safePrompt, evidence,
    markerDigest: digest('marker'), maximumCostUsd: 4, panelDeadlineMilliseconds: Date.parse(at) + 60000, liveAdmission } as unknown as Parameters<Hermes021IdeaLabFilteredDriverV1['invoke']>[0];
  let received: Record<string, unknown> | undefined;
  const port = {
    enforcesMaximumCostUsd: true,
    async execute(value: Record<string, unknown>, collector: { submit(value: unknown): void }) {
      received = value;
      const common = { markerDigest: invocation.markerDigest, sessionIdentityDigest: digest('session') };
      const { providerEvidenceDigest: _ignored, ...ready } = binding;
      collector.submit({ frames: [
        { ...common, sequence: 1, type: 'session.ready', payload: { ...ready, toolsDisabled: true, mcpDisabled: true } },
        { ...common, sequence: 2, type: failure ? 'panel.failed_definite' : 'panel.result', payload: failure
          ? { safeCode: 'provider_refused' } : { safeOpinion: 'A bounded synthetic opinion.', opportunityCode: 'test_opportunity',
            primaryRiskCode: 'test_risk', suggestedExperiment: 'Run one synthetic test.', confidencePercent: 70 } },
        { ...common, sequence: 3, type: 'session.usage', payload: { inputUnits: 1, outputUnits: 1, reasoningUnits: 0,
          totalUnits: 2, calls: 1, costUsd: 3 } },
        { ...common, sequence: 4, type: 'session.complete', payload: { status: 'settled' } },
      ] });
    },
    async cleanup(value: { markerDigest: string; sessionIdentityDigest?: string }, collector: { submit(value: unknown): void }) {
      const material = { contractVersion: 'control-room-hermes-021-panel-cleanup/v1', markerDigest: value.markerDigest,
        ...(value.sessionIdentityDigest ? { sessionIdentityDigest: value.sessionIdentityDigest } : {}), outcome: 'completed',
        processStopped: true, disposableProfileRemoved: true, disposableWorkspaceRemoved: true, retainedNativeReferenceCount: 0 };
      collector.submit({ ...material, cleanupDigest: sha256Digest(material) });
    },
  };
  return { invocation, port, received: () => received };
}

test('R6S-01 gateway: the actual filtered driver forwards the reserved allowance and absolute deadline', { timeout: 2000 }, async () => {
  const f = gatewayFixture();
  const driver = new Hermes021IdeaLabFilteredDriverV1(f.port as never, 50, 50, () => Date.parse(at));
  const result = await driver.invoke(f.invocation) as { costUsd: number };
  assert.equal(result.costUsd, 3);
  assert.equal(f.received()!.maximumCostUsd, 4);
  assert.equal(f.received()!.panelDeadlineMilliseconds, Date.parse(at) + 60000);
});

test('R6S-02: a definite provider failure retains validated usage and cost', { timeout: 2000 }, async () => {
  const f = gatewayFixture(true);
  const driver = new Hermes021IdeaLabFilteredDriverV1(f.port as never, 50, 50, () => Date.parse(at));
  const result = await driver.invoke(f.invocation) as Record<string, unknown>;
  assert.equal(result.outcome, 'failed_definite');
  assert.equal(result.providerContacted, true);
  assert.equal(result.costUsd, 3);
  assert.deepEqual(result.usage, { inputUnits: 1, outputUnits: 1, reasoningUnits: 0, totalUnits: 2, calls: 1, costUsd: 3 });
  console.log(JSON.stringify({ finding: 'R6S-02', validatedUsageCost: 3, returnedCost: result.costUsd ?? 'missing' }));
});

test('R6S-03: a call started at second 59 has only one second left', { timeout: 2000 }, async t => {
  const f = gatewayFixture();
  let entered = false;
  const port = { ...f.port, async execute() { entered = true; await new Promise<void>(() => {}); } };
  const driver = new Hermes021IdeaLabFilteredDriverV1(port as never, 120000, 5000, () => Date.now());
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse(at) + 59000 });
  const pending = driver.invoke(f.invocation);
  await Promise.resolve(); assert.equal(entered, true);
  let settled = false;
  const caught = pending.then(() => { settled = true; }, () => { settled = true; });
  // One absolute run deadline bounds the second call.
  t.mock.timers.tick(1000); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, true);
  await caught;
  assert.equal(settled, true);
  assert.equal(Date.now() - Date.parse(at), 60000);
});

test('R6S-03 coordinator: the next call starts at second 59 and receives the same panel deadline', { timeout: 2000 }, async () => {
  const input = inputFixture('duration'), ledger = ledgerFixture(), registry = registryFixture();
  const fake = new DeterministicIdeaLabFakeDriverV1(); let elapsed = 0, calls = 0;
  const driver = { mode: 'repository_fake' as const, maximumCallCostUsd: 3, async invoke(value: Parameters<typeof fake.invoke>[0]) {
    calls++; assert.equal(value.panelDeadlineMilliseconds, Date.parse(at) + 60000); elapsed += calls === 1 ? 59000 : 1000; return fake.invoke(value);
  } };
  const run = await new IdeaLabBotCoordinatorV1(ledger, registry.registry, driver,
    () => new Date(Date.parse(at) + elapsed).toISOString()).execute(input);
  assert.equal(calls, 2); assert.equal(elapsed, 60000);
  assert.equal(run.safeCode, 'duration_budget_exceeded'); assert.equal(run.messagesUsed, 1);
});

test('unhappy paths: cancellation between calls, lost reply, malformed receipt, and retry', { timeout: 2000 }, async () => {
  const input = inputFixture('cancel'), fake = new DeterministicIdeaLabFakeDriverV1();
  let stop = false, calls = 0;
  const ledger = ledgerFixture(), registry = registryFixture();
  const cancelled = await new IdeaLabBotCoordinatorV1(ledger, registry.registry,
    { mode: 'repository_fake', async invoke(value) { calls++; stop = true; return fake.invoke(value); } }, () => at)
    .execute({ ...input, cancelRequested: () => stop });
  assert.equal(cancelled.state, 'cancelled'); assert.equal(calls, 1);
  for (const [label, invoke] of [
    ['dropped', async () => { throw new Error('injected_drop'); }],
    ['malformed', async () => ({ outcome: 'completed' })],
  ] as const) {
    let attempts = 0;
    const coordinator = new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry,
      { mode: 'repository_fake', async invoke() { attempts++; return invoke(); } }, () => at);
    const value = inputFixture(label), first = await coordinator.execute(value);
    assert.equal(first.state, 'ambiguous');
    assert.deepEqual(await coordinator.execute(value), first); assert.equal(attempts, 1);
  }
  await assert.rejects(new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry, fake, () => at)
    .execute({ ...inputFixture('missing'), evidence: [] }));
});

// This is one shared panel allowance, with overlapping calls held until the
// entire burst has tried to reserve. No database, native processes or providers.
test('R6S-01 shared budget: fifty overlapping gateway callers cannot exceed four dollars', { timeout: 3000 }, async () => {
  const { IdeaLabPanelBudgetV1 } = await import('../src/idea-lab/v1/panel-budget');
  const budget = new IdeaLabPanelBudgetV1(4);
  let release!: () => void, charged = 0, refused = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = gatewayFixture();
  const driver = new Hermes021IdeaLabFilteredDriverV1({ ...f.port,
    async execute(value, collector) {
      await held;
      charged += 0.1;
      assert.equal(value.maximumCostUsd, 0.1);
      await f.port.execute(value as unknown as Record<string, unknown>, { submit(value: unknown) {
        const envelope = value as { frames: { type: string; payload: Record<string, unknown> }[] };
        envelope.frames.find(frame => frame.type === 'session.usage')!.payload.costUsd = 0.1;
        collector.submit(envelope);
      } });
    },
  }, 50, 50, () => Date.parse(at));
  const calls = Array.from({ length: 50 }, async () => {
    const reservation = budget.reserve(0.1);
    if (!reservation) { refused++; return; }
    const result = await driver.invoke({ ...f.invocation, maximumCostUsd: reservation.maximumCostUsd }) as { outcome: string; costUsd: number };
    assert.equal(result.outcome, 'completed');
    assert.equal(reservation.settle(result.costUsd), true);
  });
  try {
    assert.equal(refused, 10);
    assert.equal(budget.remainingCostUsd, 0);
    assert.equal(budget.reserve(0.1), undefined);
  } finally { release(); await Promise.all(calls); }
  assert.ok(charged <= 4.00000000001);
  assert.equal(budget.remainingCostUsd, 0);
});

test('R6S-01 reservation unhappy paths: invalid bound, unknown bill, overcharge, exact retry and rounding', { timeout: 2000 }, async () => {
  const { IdeaLabPanelBudgetV1 } = await import('../src/idea-lab/v1/panel-budget');
  for (const value of [NaN, Infinity, -1, 451]) assert.throws(() => new IdeaLabPanelBudgetV1(value));
  const budget = new IdeaLabPanelBudgetV1(4);
  for (const value of [NaN, Infinity, -1, 451]) assert.throws(() => budget.reserve(value));
  const reservation = budget.reserve(3)!;
  assert.equal(budget.remainingCostUsd, 1);
  assert.equal(budget.reserve(3), undefined);
  assert.equal(reservation.settle(3), true);
  assert.throws(() => reservation.settle(3), /already_settled/);
  assert.equal(budget.remainingCostUsd, 1);
  const unknown = budget.reserve(1)!;
  assert.equal(unknown.settle(null), false);
  assert.equal(budget.remainingCostUsd, 0);
  assert.equal(budget.reserve(0), undefined);
  const breached = new IdeaLabPanelBudgetV1(4).reserve(1)!;
  assert.equal(breached.settle(2), false);
  const fractions = new IdeaLabPanelBudgetV1(0.3);
  assert.equal(fractions.reserve(0.1)!.settle(0.1), true);
  assert.equal(fractions.reserve(0.2)!.settle(0.2), true);
  assert.equal(fractions.reserve(0.000000001), undefined);
  assert.equal(new IdeaLabPanelBudgetV1(0.0000000009).reserve(0.0000000001), undefined);
});

test('R6S-01 gateways without an enforceable bound, invalid allowances and elapsed deadlines never execute', { timeout: 2000 }, async () => {
  const f = gatewayFixture(); let calls = 0;
  const execute = async () => { calls++; };
  const unsupported = new Hermes021IdeaLabFilteredDriverV1({ ...f.port, enforcesMaximumCostUsd: false, execute }, 50, 50, () => Date.parse(at));
  assert.equal(unsupported.costBounded, false);
  await assert.rejects(unsupported.invoke(f.invocation));
  const driver = new Hermes021IdeaLabFilteredDriverV1({ ...f.port, execute }, 50, 50, () => Date.parse(at));
  for (const maximumCostUsd of [-1, NaN, Infinity, 5]) {
    await assert.rejects(driver.invoke({ ...f.invocation, maximumCostUsd }));
  }
  for (const panelDeadlineMilliseconds of [NaN, Infinity, Date.parse(at), Date.parse(at) - 1, Date.parse(at) + 60001, Date.parse(at) + 0.5]) {
    await assert.rejects(driver.invoke({ ...f.invocation, panelDeadlineMilliseconds }));
  }
  for (const bound of [0, 5001, NaN]) assert.throws(() => new Hermes021IdeaLabFilteredDriverV1(f.port, 50, bound));
  assert.equal(calls, 0);
});

const usage = { inputUnits: 1, outputUnits: 1, reasoningUnits: 0, totalUnits: 2, calls: 1 as const, costUsd: 3 };

test('R6S-02 ledger retains bills for failed, ambiguous, invalid-output, late and over-limit replies', { timeout: 3000 }, async () => {
  const fake = new DeterministicIdeaLabFakeDriverV1();
  for (const kind of ['failed', 'ambiguous', 'invalid', 'late', 'over', 'write_failed', 'unknown'] as const) {
    const input = inputFixture(`bill_${kind}`), ledger = ledgerFixture(), registry = registryFixture();
    let elapsed = 0, calls = 0;
    if (kind === 'write_failed') registry.registry.recordContribution = async () => { throw new Error('injected_write_failure'); };
    const coordinator = new IdeaLabBotCoordinatorV1(ledger, registry.registry, {
      mode: 'repository_fake', maximumCallCostUsd: kind === 'over' ? 1 : 3,
      async invoke(value) {
        calls++;
        if (kind === 'late') elapsed = 60000;
        if (kind === 'unknown') return { outcome: 'ambiguous', safeCode: 'stop_unconfirmed', costUsd: null, usage: null,
          providerReceiptDigest: digest(kind), providerContacted: false };
        const bill = { costUsd: 3, usage, providerReceiptDigest: digest(kind), providerContacted: false };
        if (kind === 'failed' || kind === 'ambiguous') return { outcome: kind === 'failed' ? 'failed_definite' : 'ambiguous', safeCode: 'provider_refused', ...bill };
        return { ...await fake.invoke(value), ...bill, ...(kind === 'invalid' ? { safeOpinion: '' } : {}) };
      },
    }, () => new Date(Date.parse(at) + elapsed).toISOString());
    const run = await coordinator.execute(input);
    assert.equal(run.costUsd, kind === 'unknown' ? null : 3, kind);
    assert.equal(run.attempts[0]!.costUsd, kind === 'unknown' ? null : 3, kind);
    assert.deepEqual(run.attempts[0]!.usage, kind === 'unknown' ? null : usage, kind);
    assert.equal(run.messagesUsed, 0, kind);
    assert.equal(run.attempts[0]!.receiptDigest, digest(kind), kind);
    assert.equal(calls, 1, kind);
    assert.deepEqual(await coordinator.execute(input), run);
    assert.equal(calls, 1);
  }
});

test('R6S-02 incomplete or invalid terminal text preserves a separately bound usage frame', { timeout: 2000 }, async () => {
  for (const fault of ['invalid_text', 'missing_complete', 'wrong_complete', 'reject_after_bill', 'extra_complete', 'wrong_terminal_marker', 'wrong_terminal_session'] as const) {
    const f = gatewayFixture();
    const driver = new Hermes021IdeaLabFilteredDriverV1({ ...f.port, async execute(value, collector) {
      await f.port.execute(value as unknown as Record<string, unknown>, { submit(value: unknown) {
        const envelope = value as { frames: { type: string; payload: Record<string, unknown>; markerDigest: string; sessionIdentityDigest: string }[] };
        if (fault === 'invalid_text') envelope.frames[1]!.payload.safeOpinion = '';
        if (fault === 'wrong_terminal_marker') envelope.frames[1]!.markerDigest = digest('wrong');
        if (fault === 'wrong_terminal_session') envelope.frames[1]!.sessionIdentityDigest = digest('wrong');
        if (fault === 'missing_complete') envelope.frames.pop();
        if (fault === 'wrong_complete') envelope.frames[3]!.markerDigest = digest('wrong');
        if (fault === 'extra_complete') envelope.frames.push({ ...envelope.frames[3]!, ...{ sequence: 5 } });
        collector.submit(envelope);
      } });
      if (fault === 'reject_after_bill') throw new Error('injected_drop');
    } }, 50, 50, () => Date.parse(at));
    const result = await driver.invoke(f.invocation) as { costUsd: number; usage: unknown; outcome: string };
    assert.equal(result.costUsd, 3, fault);
    assert.deepEqual(result.usage, usage, fault);
    if (fault !== 'reject_after_bill') assert.equal(result.outcome, 'ambiguous');
  }
});

test('R6S-02 wrong billing binding or invalid usage is unknown, never zero', { timeout: 2000 }, async () => {
  for (const fault of ['wrong_marker', 'wrong_session', 'wrong_total', 'negative_cost', 'duplicate_usage'] as const) {
    const f = gatewayFixture();
    const driver = new Hermes021IdeaLabFilteredDriverV1({ ...f.port, async execute(value, collector) {
      await f.port.execute(value as unknown as Record<string, unknown>, { submit(value: unknown) {
        const envelope = value as { frames: { markerDigest: string; sessionIdentityDigest: string; payload: Record<string, unknown> }[] };
        if (fault === 'wrong_marker') envelope.frames[2]!.markerDigest = digest('wrong');
        if (fault === 'wrong_session') envelope.frames[2]!.sessionIdentityDigest = digest('wrong');
        if (fault === 'wrong_total') envelope.frames[2]!.payload.totalUnits = 1;
        if (fault === 'negative_cost') envelope.frames[2]!.payload.costUsd = -1;
        if (fault === 'duplicate_usage') envelope.frames.push({ ...envelope.frames[2]!, ...{ sequence: 5 } });
        collector.submit(envelope);
      } });
    } }, 50, 50, () => Date.parse(at));
    const result = await driver.invoke(f.invocation) as { costUsd: null; usage: null; outcome: string };
    assert.equal(result.outcome, 'ambiguous');
    assert.equal(result.costUsd, null, fault);
    assert.equal(result.usage, null, fault);
  }
});

test('R6S-03 cleanup failures preserve the bill and report stop unconfirmed for fifty simultaneous replies', { timeout: 3000 }, async t => {
  const f = gatewayFixture(); let cleanups = 0;
  const driver = new Hermes021IdeaLabFilteredDriverV1({ ...f.port, async cleanup(input) {
    cleanups++;
    assert.equal(input.cleanupTimeoutMilliseconds, 25);
    await new Promise<void>(() => {});
  } }, 50, 25, () => Date.parse(at));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse(at) });
  const pending = Promise.all(Array.from({ length: 50 }, () => driver.invoke(f.invocation)));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cleanups, 50);
  t.mock.timers.tick(25);
  const results = await pending as { outcome: string; safeCode: string; costUsd: number; usage: unknown }[];
  for (const result of results) {
    assert.equal(result.outcome, 'ambiguous');
    assert.equal(result.safeCode, 'stop_unconfirmed');
    assert.equal(result.costUsd, 3);
    assert.deepEqual(result.usage, usage);
  }
});

test('R6S-03 a dropped gateway and dropped cleanup finish within separate bounds without inventing a bill', { timeout: 2000 }, async t => {
  const f = gatewayFixture();
  let signal: unknown, lateCollector: { submit(value: unknown): void } | undefined;
  const driver = new Hermes021IdeaLabFilteredDriverV1({ ...f.port, async execute(value, collector) {
    signal = value.signal; lateCollector = collector;
    await new Promise<void>(() => {});
  }, async cleanup() { await new Promise<void>(() => {}); } }, 50, 25, () => Date.now());
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse(at) + 59990 });
  let settled = false;
  const pending = driver.invoke(f.invocation).then(result => { settled = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(10);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  const { hostCancellationAbortedV1 } = await import('../src/security/host-value');
  assert.equal(hostCancellationAbortedV1(signal), true);
  t.mock.timers.tick(25);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, true);
  const result = await pending as { safeCode: string; costUsd: null; usage: null };
  assert.equal(result.safeCode, 'stop_unconfirmed');
  assert.equal(result.costUsd, null);
  assert.equal(result.usage, null);
  // Late handoff is sealed and cannot change the saved terminal result.
  assert.throws(() => lateCollector!.submit({ frames: [] }));
});

test('R6S-03 cleanup has its own bound and does not consume the successful call deadline', { timeout: 2000 }, async t => {
  const f = gatewayFixture();
  const driver = new Hermes021IdeaLabFilteredDriverV1({ ...f.port, async cleanup(value, collector) {
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
    await f.port.cleanup(value, collector);
  } }, 2000, 1500, () => Date.now());
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse(at) + 59999 });
  const pending = driver.invoke(f.invocation);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  const result = await pending as { outcome: string; costUsd: number };
  assert.equal(result.outcome, 'completed');
  assert.equal(result.costUsd, 3);
});

test('R6S-03 invalid or rejected stop proofs are unconfirmed, retaining validated cost', { timeout: 2000 }, async () => {
  for (const fault of ['rejected', 'wrong_digest', 'process_alive', 'wrong_marker', 'wrong_session'] as const) {
    const f = gatewayFixture();
    const driver = new Hermes021IdeaLabFilteredDriverV1({ ...f.port, async cleanup(value, collector) {
      if (fault === 'rejected') throw new Error('injected_cleanup_failure');
      await f.port.cleanup(value, { submit(value: unknown) {
        const proof = value as Record<string, unknown>;
        if (fault === 'wrong_digest') proof.cleanupDigest = digest('wrong');
        if (fault === 'process_alive') proof.processStopped = false;
        if (fault === 'wrong_marker') proof.markerDigest = digest('wrong');
        if (fault === 'wrong_session') proof.sessionIdentityDigest = digest('wrong');
        collector.submit(proof);
      } });
    } }, 50, 25, () => Date.parse(at));
    const result = await driver.invoke(f.invocation) as { safeCode: string; costUsd: number };
    assert.equal(result.safeCode, 'stop_unconfirmed', fault);
    assert.equal(result.costUsd, 3, fault);
  }
});

test('R6S-01 a lying gateway cannot make an overcharge disappear from accounting', { timeout: 2000 }, async () => {
  const f = gatewayFixture();
  const result = await new Hermes021IdeaLabFilteredDriverV1(f.port, 50, 50, () => Date.parse(at))
    .invoke({ ...f.invocation, maximumCostUsd: 1 }) as { outcome: string; safeCode: string; costUsd: number };
  assert.equal(result.outcome, 'failed_definite');
  assert.equal(result.safeCode, 'provider_cost_bound_breached');
  assert.equal(result.costUsd, 3);
});

test('R6S coordinator refuses live drivers without a cost-bound contract before marking or calling', { timeout: 2000 }, async () => {
  const { buildIdeaLabLivePanelAdmissionCandidateV1 } = await import('../src/idea-lab/v1/live-panel-admission');
  const input = inputFixture('live_bound');
  const evidence = input.evidence.map(value => {
    const { evidenceDigest: _old, ...material } = value;
    const live = { ...material, mode: 'hermes_bot_mode_filtered' as const, harnessPackage: 'hermes_agent' as const,
      harnessVersion: IDEA_LAB_HERMES_021_VERSION_V1, sourceRevision: IDEA_LAB_HERMES_021_REVISION_V1,
      liveProviderAuthorized: true, providerContacted: true };
    return { ...live, evidenceDigest: sha256Digest(live) };
  });
  const admission = buildIdeaLabLivePanelAdmissionCandidateV1({ admissionId: 'admission:live_bound', runId: input.runId,
    session: input.session, evidence, runtimeIdentityDigests: Object.fromEntries(evidence.map(item => [item.participantId, digest(item.participantId)])),
    runtime: { providerId: 'hermes_bot_mode', adapterId: 'adapter.hermes.gateway.v2', adapterVersion: '2.0.0',
      runtimeVersion: IDEA_LAB_HERMES_021_VERSION_V1, runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
      compatibilityEvidenceDigest: digest('compatibility'), nativeQualificationReceiptDigest: digest('qualification'),
      runtimeManifestDigest: digest('manifest'), protectedValueCustodyMode: 'host_broker',
      protectedValueCustodyEvidenceDigest: digest('custody'), controlRoomCanReadProtectedValue: false, protectedValueMaterialPresent: false,
      toolsDisabled: true, mcpDisabled: true, start: true, filteredEvents: true, usage: true, cancel: true, steer: true, resume: true },
    ownerWindow: { windowId: 'window:live_bound', decisionDigest: digest('owner'), strongFactorEvidenceDigest: digest('factor'),
      authorizedAction: 'idea_lab_live_panel', singleUse: true, ownerAttended: true, openedAt: at, expiresAt: '2026-10-02T12:01:00.000Z' },
    issuedAt: at, expiresAt: '2026-10-02T12:01:00.000Z' });
  let calls = 0;
  const coordinator = new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry,
    { mode: 'hermes_bot_mode_filtered', async invoke() { calls++; throw new Error('unexpected_contact'); } }, () => at,
    { async verify() { return true; } }, { async consume() { return true; } });
  const run = await coordinator.execute({ ...input, evidence, liveAdmission: admission });
  assert.equal(run.safeCode, 'provider_cost_bound_unavailable');
  assert.equal(run.attempts.length, 0);
  assert.equal(calls, 0);
});

test('R6S coordinator bounds slow marker storage and invalid conservative maxima before contact', { timeout: 2000 }, async () => {
  let calls = 0, elapsed = 0;
  const ledger = ledgerFixture(() => { elapsed = 60000; });
  const run = await new IdeaLabBotCoordinatorV1(ledger, registryFixture().registry,
    { mode: 'repository_fake', async invoke() { calls++; throw new Error('unexpected_contact'); } },
    () => new Date(Date.parse(at) + elapsed).toISOString()).execute(inputFixture('slow_marker'));
  assert.equal(run.safeCode, 'duration_budget_exceeded');
  assert.equal(run.costUsd, 0);
  assert.equal(run.providerContacted, false);
  for (const maximumCallCostUsd of [NaN, -1, Infinity]) {
    const refused = await new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry,
      { mode: 'repository_fake', maximumCallCostUsd, async invoke() { calls++; throw new Error('unexpected_contact'); } }, () => at)
      .execute(inputFixture(`bad_max_${calls}`));
    assert.equal(refused.safeCode, 'provider_cost_bound_invalid');
    assert.equal(refused.attempts.length, 0);
  }
  assert.equal(calls, 0);
});

test('R6S billing fallback never invokes hostile usage getters', { timeout: 2000 }, async () => {
  let touched = false;
  const hostile = { ...usage };
  Object.defineProperty(hostile, 'costUsd', { enumerable: true, get() { touched = true; return 3; } });
  const run = await new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry,
    { mode: 'repository_fake', async invoke() { return { outcome: 'completed', costUsd: 3, usage: hostile,
      providerContacted: false, providerReceiptDigest: digest('hostile') }; } }, () => at).execute(inputFixture('hostile'));
  assert.equal(run.costUsd, null);
  assert.equal(touched, false);
});

test('R6S coordinator uses provider completion time while cleanup has a separate allowance', { timeout: 2000 }, async () => {
  const fake = new DeterministicIdeaLabFakeDriverV1(); let elapsed = 0, calls = 0;
  const coordinator = new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry,
    { mode: 'repository_fake', async invoke(value) {
      calls++; elapsed = 64000;
      return { ...await fake.invoke(value), providerEndedAtMilliseconds: Date.parse(at) + 59000 };
    } }, () => new Date(Date.parse(at) + elapsed).toISOString());
  const run = await coordinator.execute(inputFixture('cleanup_window'));
  assert.equal(run.messagesUsed, 1);
  assert.equal(run.safeCode, 'budget_exhausted_before_provider');
  assert.equal(calls, 1);
});

test('R6S charged costs include a failed overcharge beyond the panel cap, and mismatched usage is refused', { timeout: 2000 }, async () => {
  const fake = new DeterministicIdeaLabFakeDriverV1(); let calls = 0;
  const coordinator = new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry,
    { mode: 'repository_fake', async invoke(value) {
      calls++;
      if (calls === 1) return { ...await fake.invoke(value), costUsd: 3, usage };
      return { outcome: 'failed_definite', safeCode: 'provider_refused', costUsd: 25, usage: { ...usage, costUsd: 25 },
        providerContacted: false, providerReceiptDigest: digest('overcharge') };
    } }, () => at);
  const run = await coordinator.execute(inputFixture('overcharge_total'));
  assert.equal(run.costUsd, 28);
  assert.equal(run.messagesUsed, 1);
  assert.deepEqual(run.attempts.map(item => item.costUsd), [3, 25]);
  assert.deepEqual(run.attempts[0]!.usage, usage);
  const { parseIdeaLabBotRunV1 } = await import('../src/idea-lab/v1/coordinator');
  const { runDigest: _old, ...material } = run;
  for (const change of [
    { ...material, costUsd: 3 },
    { ...material, attempts: [{ ...run.attempts[0]!, usage: { ...usage, costUsd: 2 } }, run.attempts[1]!] },
  ]) assert.throws(() => parseIdeaLabBotRunV1({ ...change, runDigest: sha256Digest(change) }));
  const invalid = await new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry,
    { mode: 'repository_fake', async invoke() { return { outcome: 'failed_definite', safeCode: 'provider_refused',
      costUsd: 3, usage: { ...usage, costUsd: 2 }, providerContacted: false, providerReceiptDigest: digest('conflict') }; } }, () => at)
    .execute(inputFixture('usage_conflict'));
  assert.equal(invalid.costUsd, null);
  assert.equal(invalid.attempts[0]!.usage, null);
});

test('R6S a billing contact mismatch still retains its charge', { timeout: 2000 }, async () => {
  const fake = new DeterministicIdeaLabFakeDriverV1();
  const run = await new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry,
    { mode: 'repository_fake', async invoke(value) { return { ...await fake.invoke(value), costUsd: 3, usage, providerContacted: true }; } }, () => at)
    .execute(inputFixture('contact_mismatch'));
  assert.equal(run.safeCode, 'provider_contact_evidence_mismatch');
  assert.equal(run.costUsd, 3);
  assert.equal(run.providerContacted, true);
});

test('R6S unknown total cannot be resigned as zero and provider end time cannot predate its marker', { timeout: 2000 }, async () => {
  const fake = new DeterministicIdeaLabFakeDriverV1();
  const run = await new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry,
    { mode: 'repository_fake', async invoke() { throw new Error('injected_drop'); } }, () => at)
    .execute(inputFixture('unknown_total'));
  const { parseIdeaLabBotRunV1 } = await import('../src/idea-lab/v1/coordinator');
  const { runDigest: _old, ...material } = run;
  const changed = { ...material, costUsd: 0 };
  assert.throws(() => parseIdeaLabBotRunV1({ ...changed, runDigest: sha256Digest(changed) }));
  const invalid = await new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry,
    { mode: 'repository_fake', async invoke(value) { return { ...await fake.invoke(value), providerEndedAtMilliseconds: Date.parse(at) - 1 }; } }, () => at)
    .execute(inputFixture('bad_end'));
  assert.equal(invalid.messagesUsed, 0);
  assert.equal(invalid.safeCode, 'duration_budget_exceeded');
});

test('R6S a marker write failure contacts nobody and can be retried without a spent reservation', { timeout: 2000 }, async () => {
  let fail = true, calls = 0;
  const ledger = ledgerFixture(() => { if (fail) { fail = false; throw new Error('injected_marker_failure'); } });
  const fake = new DeterministicIdeaLabFakeDriverV1();
  const coordinator = new IdeaLabBotCoordinatorV1(ledger, registryFixture().registry,
    { mode: 'repository_fake', async invoke(value) { calls++; return fake.invoke(value); } }, () => at);
  const input = inputFixture('marker_retry');
  await assert.rejects(coordinator.execute(input));
  assert.equal(calls, 0);
  assert.equal((await coordinator.execute(input)).state, 'completed');
  assert.equal(calls, 4);
});

test('R6S-03 deadline is rechecked at gateway dispatch and a nonfinite clock refuses contact', { timeout: 2000 }, async () => {
  const f = gatewayFixture(); let calls = 0, observations = 0;
  const port = { ...f.port, async execute() { calls++; }, async cleanup() { throw new Error('unexpected_cleanup'); } };
  const driver = new Hermes021IdeaLabFilteredDriverV1(port, 50, 25,
    () => Date.parse(at) + (observations++ === 0 ? 59999 : 60000));
  const result = await driver.invoke(f.invocation) as { costUsd: number; providerContacted: boolean; outcome: string };
  assert.equal(result.outcome, 'failed_definite');
  assert.equal(result.costUsd, 0);
  assert.equal(result.providerContacted, false);
  await assert.rejects(new Hermes021IdeaLabFilteredDriverV1(port, 50, 25, () => NaN).invoke(f.invocation));
  assert.equal(calls, 0);
});

test('R6S-03 a cleanup proof arriving beyond its own bound is refused', { timeout: 2000 }, async () => {
  const f = gatewayFixture(); let elapsed = 0;
  const driver = new Hermes021IdeaLabFilteredDriverV1({ ...f.port, async cleanup(value, collector) {
    elapsed = 26;
    await f.port.cleanup(value, collector);
  } }, 50, 25, () => Date.parse(at) + elapsed);
  const result = await driver.invoke(f.invocation) as { safeCode: string; costUsd: number };
  assert.equal(result.safeCode, 'stop_unconfirmed');
  assert.equal(result.costUsd, 3);
});


test('R6S a directly supplied usage total must match its validated units', { timeout: 2000 }, async () => {
  const run = await new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry,
    { mode: 'repository_fake', async invoke() { return { outcome: 'failed_definite', safeCode: 'provider_refused',
      costUsd: 3, usage: { ...usage, totalUnits: 1 }, providerContacted: false, providerReceiptDigest: digest('bad_total') }; } }, () => at)
    .execute(inputFixture('bad_total'));
  assert.equal(run.costUsd, null);
  assert.equal(run.attempts[0]!.usage, null);
});


test('R6S-03 a retained prepared start fixes the deadline even when execution starts fifty-nine seconds later', { timeout: 2000 }, async () => {
  const { buildIdeaLabBotRunV1 } = await import('../src/idea-lab/v1/coordinator');
  const input = inputFixture('retained_start'), ledger = ledgerFixture();
  await ledger.prepare(buildIdeaLabBotRunV1({ runId: input.runId, tenantId: input.session.tenantId,
    workspaceId: input.session.workspaceId, sessionId: input.session.sessionId, sessionDigest: input.session.sessionDigest,
    evidenceDigests: input.evidence.map(item => item.evidenceDigest).sort(), state: 'prepared', attempts: [],
    messagesUsed: 0, costUsd: 0, safeCode: 'prepared', providerContacted: false, startedAt: at, updatedAt: at }));
  let elapsed = 59000, calls = 0;
  const fake = new DeterministicIdeaLabFakeDriverV1();
  const run = await new IdeaLabBotCoordinatorV1(ledger, registryFixture().registry,
    { mode: 'repository_fake', async invoke(value) { calls++;
      assert.equal(value.panelDeadlineMilliseconds, Date.parse(at) + 60000);
      elapsed = 60000; return fake.invoke(value);
    } }, () => new Date(Date.parse(at) + elapsed).toISOString()).execute(input);
  assert.equal(calls, 1);
  assert.equal(run.safeCode, 'duration_budget_exceeded');
  assert.equal(run.messagesUsed, 0);
});

test('R6S-03 an invalid owner window refuses gateway contact', { timeout: 2000 }, async () => {
  const f = gatewayFixture(); let calls = 0;
  const driver = new Hermes021IdeaLabFilteredDriverV1({ ...f.port, async execute() { calls++; } }, 50, 25, () => Date.parse(at));
  await assert.rejects(driver.invoke({ ...f.invocation, liveAdmission: { ...f.invocation.liveAdmission!,
    ownerWindow: { ...f.invocation.liveAdmission!.ownerWindow, expiresAt: 'not_a_time' } } }));
  assert.equal(calls, 0);
});

test('R6S-03 the default clock is captured before gateway code can replace Date.now', { timeout: 2000 }, async () => {
  const f = gatewayFixture(), originalNow = Date.now, before = originalNow();
  const invocation = { ...f.invocation, panelDeadlineMilliseconds: before + 1000,
    liveAdmission: { ...f.invocation.liveAdmission!, ownerWindow: { ...f.invocation.liveAdmission!.ownerWindow,
      expiresAt: new Date(before + 60000).toISOString() } } };
  const driver = new Hermes021IdeaLabFilteredDriverV1({ ...f.port, async execute(value, collector) {
    Date.now = () => before + 60000;
    await f.port.execute(value as unknown as Record<string, unknown>, collector);
  } }, 1000, 25);
  try {
    const result = await driver.invoke(invocation) as { outcome: string; costUsd: number };
    assert.equal(result.outcome, 'completed');
    assert.equal(result.costUsd, 3);
  } finally { Date.now = originalNow; }
});


test('R6S provider completion metadata rejects invalid ranges and fractional time', { timeout: 2000 }, async () => {
  const fake = new DeterministicIdeaLabFakeDriverV1();
  for (const providerEndedAtMilliseconds of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, Date.parse(at) + 0.5]) {
    const run = await new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry,
      { mode: 'repository_fake', async invoke(value) { return { ...await fake.invoke(value), providerEndedAtMilliseconds }; } }, () => at)
      .execute(inputFixture('invalid_end_metadata'));
    assert.equal(run.safeCode, 'provider_receipt_invalid');
    assert.equal(run.costUsd, 0);
    assert.equal(run.messagesUsed, 0);
  }
});

test('R6S the protected operator projection preserves an unknown bill', { timeout: 2000 }, async () => {
  const { IdeaLabProtectedOperatorServiceV1 } = await import('../src/idea-lab/v1/operator-service');
  const input = inputFixture('unknown_projection');
  const run = await new IdeaLabBotCoordinatorV1(ledgerFixture(), registryFixture().registry,
    { mode: 'repository_fake', async invoke() { throw new Error('injected_drop'); } }, () => at).execute(input);
  const projection = IdeaLabProtectedOperatorServiceV1.prototype.project(input.session, run, undefined, undefined, at);
  assert.equal(projection.costUsd, null);
  assert.equal(projection.state, 'ambiguous');
});
