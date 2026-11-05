import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { transpileModule } from "typescript";
import { B5RefusalV1 } from "./helpers/improve-control-room-first-website";
import * as controller from "../scripts/workflow-journeys/first-website-controller";
import { loopBridgeReceiptSchemaV1 } from "../src/improve-control-room/v1/schemas";

const approval = { step: "plan" as const, inputVersion: 1, head: "a".repeat(40), reportSha256: "b".repeat(64) };
const waiting = () => ({ engine: { state: "waiting" as const, approval: { ...approval } } });
const signal = () => new AbortController().signal;

test("B5 approval waits for delayed progression after validating acceptance exactly once", async () => {
  let now = 0, reads = 0, accepted = 0;
  const events: string[] = [];
  const moved = { engine: { state: "running" as const, approval: null } };
  const result = await controller.waitB5ApprovalProgressV1({ approval, signal: signal(), deadline: 8000,
    accepted: async descriptor => { accepted++; assert.deepEqual(descriptor, approval); events.push("accepted"); },
    read: async () => { events.push("read"); return ++reads <= 5 ? waiting() : moved; },
    clock: () => now, pause: async () => { now += 1000; },
  });
  assert.equal(result, moved); assert.equal(accepted, 1); assert.equal(reads, 6);
  assert.equal(events[0], "accepted"); assert.equal(now, 5000);
});

test("B5 approval recognizes a changed spec descriptor only after acceptance", async () => {
  const moved = { engine: { state: "waiting" as const, approval: { ...approval, step: "spec" as const } } };
  let accepted = false;
  assert.equal(await controller.waitB5ApprovalProgressV1({ approval, signal: signal(), deadline: Date.now() + 1000,
    accepted: async () => { accepted = true; }, read: async () => { assert.equal(accepted, true); return moved; },
  }), moved);
});

test("B5 approval that never moves fails within the owned deadline", async () => {
  let now = 0, reads = 0;
  await assert.rejects(controller.waitB5ApprovalProgressV1({ approval, signal: signal(), deadline: 3000,
    accepted: async () => {}, read: async () => { reads++; return waiting(); },
    clock: () => now, pause: async () => { now += 1000; },
  }), { code: "B5_APPROVAL_NOT_OBSERVED" });
  assert.equal(now, 3000); assert.equal(reads, 3);
});

test("B5 approval bounds stalled reads and acceptance checks", { timeout: 2000 }, async () => {
  for (const stall of ["read", "accepted"]) {
    let active: AbortSignal | undefined;
    await assert.rejects(controller.waitB5ApprovalProgressV1({ approval, signal: signal(), deadline: Date.now() + 30,
      accepted: async () => { if (stall === "accepted") await new Promise<never>(() => {}); },
      read: async s => { active = s; return new Promise<never>(() => {}); },
    }), { code: "B5_APPROVAL_NOT_OBSERVED" });
    if (stall === "read") assert.equal(active?.aborted, true);
  }
});

for (const state of ["stopped", "refused"] as const) test(`B5 approval polling preserves ${state} even if gate disappears`, async () => {
  let reads = 0;
  await assert.rejects(controller.waitB5ApprovalProgressV1({ approval, signal: signal(), deadline: Date.now() + 1000,
    accepted: async () => {}, read: async () => ++reads === 1 ? waiting() : { engine: { state, approval: null } },
    pause: async () => {},
  }), { code: state === "stopped" ? "B5_OWNER_STOP" : "B5_ENGINE_REFUSED" });
  assert.equal(reads, 2);
});

test("B5 approval preserves cancellation, read errors and rejected command evidence", async () => {
  const abort = new AbortController(), failure = new Error("synthetic refusal");
  await assert.rejects(controller.waitB5ApprovalProgressV1({ approval, signal: abort.signal, deadline: Date.now() + 1000,
    accepted: async () => {}, read: async () => waiting(), pause: async () => { abort.abort(failure); },
  }), error => error === failure);
  for (const stage of ["accepted", "read"]) {
    let reads = 0;
    await assert.rejects(controller.waitB5ApprovalProgressV1({ approval, signal: signal(), deadline: Date.now() + 1000,
      accepted: async () => { if (stage === "accepted") throw failure; },
      read: async () => { reads++; throw failure; },
    }), error => error === failure);
    assert.equal(reads, stage === "accepted" ? 0 : 1);
  }
});

// Exercise the browser's actual POST helper without acquiring a browser or PG.
for (const name of ["approve-plan", "approve-spec"]) for (const state of ["accepted", "uncertain", "refused", "waiting", "malformed"]) {
  test(`B5 browser ${name} records approval only for accepted receipt: ${state}`, async () => {
    const source = await readFile("tests/improve-control-room-first-website-controller-postgres.test.ts", "utf8");
    const body = /const post=async\(name:[\s\S]*?=>\{([\s\S]*?)\n      \};/u.exec(source)?.[1];
    assert.ok(body);
    const receipt = state === "malformed" ? { state: "accepted" } : { schemaVersion: 1, requestId: "request:synthetic",
      localVersion: 1, commandId: "command:synthetic", state, replayed: false, engineRevision: 1,
      error: state === "uncertain" ? "LAUNCH_UNCERTAIN" : state === "refused" ? "REFUSED" : null };
    const events: unknown[] = [];
    let clicks = 0, jsonReads = 0;
    const response = { ok: () => true, status: () => 202, finished: async () => {},
      json: async () => { jsonReads++; return receipt; }, url: () => "http://fixture.invalid/approve" };
    const post = new Function("context", `with(context) { return (async () => { ${transpileModule(body, { compilerOptions: { target: 99 } }).outputText} })(); }`);
    const invoke = () => post({ name, suffix: "/approve", click: async () => { clicks++; },
      page: { waitForResponse: async () => response }, events, assert, loopBridgeReceiptSchemaV1 });
    if (state === "accepted") { await invoke(); assert.equal(events.length, 1); }
    else { await assert.rejects(invoke()); assert.deepEqual(events, []); }
    assert.equal(clicks, 1); assert.equal(jsonReads, 1);
  });
}

for (const step of ["plan", "spec"] as const) test(`B5 controller ${step} branch submits once and validates the saved descriptor before polling`, async () => {
  const source = await readFile("scripts/workflow-journeys/first-website-controller.ts", "utf8");
  const body = /else if \(gate\?\.kind === "approve"\) \{([\s\S]*?)\n      \} else if \(s.engine.state === "finished"\)/u.exec(source)?.[1];
  assert.ok(body);
  const original = { ...approval, step }, events: string[] = [];
  const s = { engine: { approval: original } };
  let reads = 0, now = 0;
  const context = { s, planSeen: false, specSeen: false,
    need: (value: unknown) => assert.ok(value), workSignal: signal(), owner: { workAt: () => 8000 },
    phase: async (name: string, device: string) => { events.push(`${name}:${device}`); },
    command: async (operation: string, evidence: { body: unknown; inputVersion: number }) => {
      assert.equal(operation, "approve"); assert.deepEqual(evidence, { inputVersion: original.inputVersion, body: original });
      assert.equal(reads, 0); events.push("accepted");
    },
    status: async () => { reads++; return reads < 3 ? { engine: { state: "waiting" as const, approval: { ...original } } }
      : { engine: { state: "running" as const, approval: null } }; },
    waitB5ApprovalProgressV1: (input: Parameters<typeof controller.waitB5ApprovalProgressV1>[0]) =>
      controller.waitB5ApprovalProgressV1({ ...input, clock: () => now, pause: async () => { now += 1000; } }),
  };
  const invoke = new Function("context", `with(context) { return (async () => { ${transpileModule(body, { compilerOptions: { target: 99 } }).outputText} })(); }`);
  await invoke(context);
  assert.deepEqual(events, [`${step}:phone`, "accepted", ...(step === "spec" ? ["close:phone", "close:desktop"] : [])]);
  assert.equal(reads, 3); assert.equal(context.planSeen, step === "plan"); assert.equal(context.specSeen, step === "spec");
});

test("B5 approval abort cancels a stalled read promptly", { timeout: 2000 }, async () => {
  const abort = new AbortController(), failure = new Error("synthetic cancellation");
  await assert.rejects(controller.waitB5ApprovalProgressV1({ approval, signal: abort.signal, deadline: Date.now() + 60_000,
    accepted: async () => {}, read: async () => { abort.abort(failure); return new Promise<never>(() => {}); },
  }), error => error === failure);
});


test("B5 approval reports missing progression when the owner deadline timer wins", async () => {
  let now = 0;
  const abort = new AbortController();
  await assert.rejects(controller.waitB5ApprovalProgressV1({ approval, signal: abort.signal, deadline: 1000,
    accepted: async () => {}, read: async () => waiting(), clock: () => now,
    pause: async () => { now = 1000; abort.abort(new B5RefusalV1("B5_DEADLINE")); },
  }), { code: "B5_APPROVAL_NOT_OBSERVED" });
});
