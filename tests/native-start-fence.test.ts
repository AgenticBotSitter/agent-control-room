import test from "node:test";
import assert from "node:assert/strict";
import { nativeStartAuthorityFixture } from "./helpers/native-start-authority";
import {
  type AuthenticatedCurrentResourceHolderPortV2,
  createCurrentResourceHolderFenceV2,
  type CurrentResourceHolderExpectationV2,
} from "../src/resource-bound-start/v2";

test("native start rejects asynchronous freshness before admission or effect markers", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close);
  for (const operation of ["check", "mark"] as const) for (const source of ["policy", "profile"] as const)
    for (const failureCall of [1, 2]) for (const rejection of [false, true]) {
      let checks = 0;
      const fence = () => {
        if (++checks === failureCall) return rejection ? Promise.reject(new Error("synthetic_revocation")) : Promise.resolve();
      };
      const controller = f.create(source === "policy"
        ? { readCurrent: async signal => ({ ...await f.dependencies.readCurrent(signal), assertFresh: fence }) }
        : { assertProfileCurrent: async () => fence });
      try {
        await assert.rejects(operation === "mark" ? controller.authority.markStart(f.prepared.binding)
          : controller.authority.check("capabilities", f.prepared.binding), /native_start_authority_unavailable/);
        assert.equal(checks, failureCall);
        assert.equal(f.effects.countFull(), 0);
        assert.equal(f.calls.length, 0);
        await new Promise<void>(resolve => setImmediate(resolve));
      } finally { controller.close(); }
    }
  for (const invalid of [false, null, 0]) {
    const controller = f.create({ readCurrent: async signal => ({ ...await f.dependencies.readCurrent(signal),
      assertFresh: invalid as unknown as () => void }) });
    try { await assert.rejects(controller.authority.markStart(f.prepared.binding), /native_start_authority_unavailable/); }
    finally { controller.close(); }
    assert.equal(f.effects.countFull(), 0);
  }
  const positive = f.create(); t.after(() => positive.close());
  await f.adapter(positive).start(f.prepared.start);
  assert.equal(f.calls.filter(value => value === "start").length, 1);
  assert.equal(f.effects.countFull(), 1);
});

const holderDigest = (character: string) => `sha256:${character.repeat(64)}`;
const holderCheckedAt = "2026-09-13T12:00:00.000Z";
const holderNowMs = Date.parse("2026-09-13T12:00:01.000Z");

const holderExpected = Object.freeze({
  tenantId: "tenant:test",
  projectId: "project:test",
  jobId: "job:test",
  attemptId: "attempt:test",
  leaseId: "lease:test",
  nodeId: "node:test",
  runId: "run:test",
  admissionId: "admission:test",
  resourceAdmissionDigest: holderDigest("a"),
  startAuthorizationDigest: holderDigest("b"),
}) satisfies CurrentResourceHolderExpectationV2;

function holderProof(overrides: Record<string, unknown> = {}) {
  return {
    schema: "control-room.current-resource-holder/v2" as const,
    ...holderExpected,
    admissionVersion: 1,
    state: "held" as const,
    checkedAt: holderCheckedAt,
    expiresAt: "2026-09-13T12:00:10.000Z",
    ...overrides,
  };
}

function holderConfiguration(produce: (value: CurrentResourceHolderExpectationV2) => unknown | Promise<unknown>,
  clock = () => holderNowMs) {
  const holder: AuthenticatedCurrentResourceHolderPortV2 = {
    async lookupCurrentHolder(value, collector) { collector.submit(await produce(value)); },
  };
  return {
    holder,
    clock: { nowMs: clock },
  };
}

function directHolderConfiguration(lookupCurrentHolder: AuthenticatedCurrentResourceHolderPortV2["lookupCurrentHolder"],
  clock = () => holderNowMs) {
  return { holder: { lookupCurrentHolder }, clock: { nowMs: clock } };
}

test("fresh exact holder proof permits the caller to continue without granting an effect itself", async () => {
  let lookups = 0;
  const fence = createCurrentResourceHolderFenceV2(holderConfiguration(input => {
    lookups += 1;
    assert.deepEqual(input, holderExpected);
    assert.equal(Object.isFrozen(input), true);
    return holderProof();
  }));

  const verified = await fence.assertCurrent(holderExpected);
  assert.equal(lookups, 1);
  assert.equal(verified.state, "held");
  assert.equal(Object.isFrozen(verified), true);
  assert.deepEqual(Object.keys(fence), ["assertCurrent"]);
});

test("holder mismatch, expiry, future checks, excessive lifetime, and lookup errors fail closed", async () => {
  const refused = [
    () => holderProof({ runId: "run:other" }),
    () => holderProof({ expiresAt: "2026-09-13T12:00:01.000Z" }),
    () => holderProof({ checkedAt: "2026-09-13T12:00:02.000Z", expiresAt: "2026-09-13T12:00:03.000Z" }),
    () => holderProof({ expiresAt: "2026-09-13T12:00:10.001Z" }),
    () => { throw new Error("private lookup detail"); },
  ];

  for (const lookupCurrentHolder of refused) {
    const fence = createCurrentResourceHolderFenceV2(holderConfiguration(lookupCurrentHolder));
    await assert.rejects(fence.assertCurrent(holderExpected), error => {
      assert.equal((error as Error).message, "current_resource_holder_unavailable");
      assert.equal((error as { safeCode?: string }).safeCode, "current_resource_holder_unavailable");
      return true;
    });
  }
});

test("holder proof and expected-input mutation cannot substitute a different holder", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const mutableExpected: { -readonly [Key in keyof CurrentResourceHolderExpectationV2]: string } = { ...holderExpected };
  const mutableProof: Record<string, unknown> = holderProof();
  const fence = createCurrentResourceHolderFenceV2(holderConfiguration(async captured => {
    await waiting;
    assert.equal(captured.runId, holderExpected.runId);
    return mutableProof;
  }));

  const pending = fence.assertCurrent(mutableExpected);
  mutableExpected.runId = "run:other";
  mutableProof.runId = "run:other";
  release();
  await assert.rejects(pending, /current_resource_holder_unavailable/);

  const accessorProof = holderProof();
  Object.defineProperty(accessorProof, "state", { enumerable: true, get: () => "held" });
  const accessorFence = createCurrentResourceHolderFenceV2(holderConfiguration(() => accessorProof));
  await assert.rejects(accessorFence.assertCurrent(holderExpected), /current_resource_holder_unavailable/);
});

test("holder-fence construction captures original lookup and clock callbacks before replacement", async () => {
  let originalLookups = 0;
  const dependencies = holderConfiguration(() => { originalLookups += 1; return holderProof(); });
  const fence = createCurrentResourceHolderFenceV2(dependencies);
  dependencies.holder.lookupCurrentHolder = async () => { throw new Error("replacement must stay unreachable"); };
  dependencies.clock.nowMs = () => Date.parse("2027-01-01T00:00:00.000Z");

  const verified = await fence.assertCurrent(holderExpected);
  assert.equal(verified.runId, holderExpected.runId);
  assert.equal(originalLookups, 1);
});

test("Proxy and accessor thenable holder results execute no traps or getters and are refused", async () => {
  let proxyTraps = 0;
  const trapped = new Proxy(holderProof(), {
    get() { proxyTraps += 1; throw new Error("proxy get executed"); },
    getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error("proxy descriptor executed"); },
    getPrototypeOf() { proxyTraps += 1; throw new Error("proxy prototype executed"); },
    ownKeys() { proxyTraps += 1; throw new Error("proxy keys executed"); },
  });
  const proxyFence = createCurrentResourceHolderFenceV2(directHolderConfiguration(async (_input, collector) => {
    collector.submit(trapped);
  }));
  await assert.rejects(proxyFence.assertCurrent(holderExpected), /current_resource_holder_unavailable/);
  assert.equal(proxyTraps, 0);

  let thenGets = 0;
  const accessorThenable = holderProof();
  Object.defineProperty(accessorThenable, "then", {
    enumerable: true,
    get() { thenGets += 1; throw new Error("then getter executed"); },
  });
  const thenableFence = createCurrentResourceHolderFenceV2(directHolderConfiguration(async (_input, collector) => {
    collector.submit(accessorThenable);
  }));
  await assert.rejects(thenableFence.assertCurrent(holderExpected), /current_resource_holder_unavailable/);
  assert.equal(thenGets, 0);
});

test("incomplete and double holder submissions refuse without reaching an effect callback", async () => {
  let effects = 0;
  const incomplete = createCurrentResourceHolderFenceV2(directHolderConfiguration(async () => undefined));
  await assert.rejects((async () => {
    await incomplete.assertCurrent(holderExpected);
    effects += 1;
  })(), /current_resource_holder_unavailable/);

  const doubled = createCurrentResourceHolderFenceV2(directHolderConfiguration(async (_input, collector) => {
    collector.submit(holderProof());
    try { collector.submit(holderProof()); } catch { /* collector must retain the conflict */ }
  }));
  await assert.rejects((async () => {
    await doubled.assertCurrent(holderExpected);
    effects += 1;
  })(), /current_resource_holder_unavailable/);
  assert.equal(effects, 0);
});

test("native and Codex effect callbacks remain untouched on every holder refusal", async () => {
  let nativeWrites = 0;
  let workspacePreparations = 0;
  let threadStarts = 0;
  let turnStarts = 0;
  const callbacks = {
    native: () => { nativeWrites += 1; },
    workspace: () => { workspacePreparations += 1; },
    thread: () => { threadStarts += 1; },
    turn: () => { turnStarts += 1; },
  };
  const refusedFence = createCurrentResourceHolderFenceV2(holderConfiguration(() => holderProof({ state: "retired" })));

  for (const callback of Object.values(callbacks)) {
    await assert.rejects((async () => {
      await refusedFence.assertCurrent(holderExpected);
      callback();
    })(), /current_resource_holder_unavailable/);
  }
  assert.deepEqual({ nativeWrites, workspacePreparations, threadStarts, turnStarts },
    { nativeWrites: 0, workspacePreparations: 0, threadStarts: 0, turnStarts: 0 });
});

test("successive holder checks reread authority and catch retirement before the next Codex step", async () => {
  let lookups = 0;
  let workspacePreparations = 0;
  let threadStarts = 0;
  const fence = createCurrentResourceHolderFenceV2(holderConfiguration(() => {
    lookups += 1;
    return lookups === 1 ? holderProof() : holderProof({ state: "retired" });
  }));

  await fence.assertCurrent(holderExpected);
  workspacePreparations += 1;
  await assert.rejects((async () => {
    await fence.assertCurrent(holderExpected);
    threadStarts += 1;
  })(), /current_resource_holder_unavailable/);

  assert.equal(lookups, 2);
  assert.equal(workspacePreparations, 1);
  assert.equal(threadStarts, 0);
});
