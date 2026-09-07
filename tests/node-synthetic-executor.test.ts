import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  runSyntheticExecution,
  SyntheticExecutorCrash,
  type SyntheticExecutionEventV1,
  type SyntheticExecutionPortsV1,
  type SyntheticExecutionSpecV1,
} from "../src/node-executor/synthetic-executor";

const baseSpec: SyntheticExecutionSpecV1 = {
  schema: "control-room.synthetic-execution/v1",
  jobId: "job-1",
  attemptId: "attempt-1",
  steps: 4,
  checkpointEverySteps: 2,
  stepDelayMilliseconds: 0,
  artifactText: "artifact body",
};

function spec(overrides: Partial<SyntheticExecutionSpecV1> = {}): SyntheticExecutionSpecV1 {
  return { ...baseSpec, ...overrides };
}

function makePorts(signal = new AbortController().signal): {
  ports: SyntheticExecutionPortsV1;
  events: SyntheticExecutionEventV1[];
  sleepCalls: number[];
} {
  const events: SyntheticExecutionEventV1[] = [];
  const sleepCalls: number[] = [];
  let clock = 0;
  return {
    events,
    sleepCalls,
    ports: {
      signal,
      now: () => new Date((clock += 1_000)).toISOString(),
      sleep: async (milliseconds) => {
        sleepCalls.push(milliseconds);
      },
      emit: (event) => {
        events.push(event);
      },
    },
  };
}

it("reuses the executor without Node globals and preserves UTF-8 bounds and cancellation", async () => {
  // Execute repository source in a separate realm with browser-standard encoding
  // only. No Buffer/process polyfill and no package or Node module resolution.
  // This tests portability, not a security sandbox or browser interaction.
  function load(path: string, dependencies: Record<string, unknown> = {}) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS } });
    const context = { exports: {}, TextEncoder, require: (name: string) => {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`unexpected_dependency:${name}`);
      return dependencies[name];
    } };
    runInNewContext(outputText, context, { timeout: 1000 });
    return context.exports;
  }
  const redaction = load("../src/security/redaction.ts");
  const portable = load("../src/node-executor/synthetic-executor.ts", { "../security/redaction": redaction }) as {
    runSyntheticExecution: typeof runSyntheticExecution;
  };
  const text = "A🚀é\ud800";
  const harness = makePorts();
  const result = await portable.runSyntheticExecution(spec({ artifactText: text }), harness.ports);
  assert.equal(result.state, "succeeded");
  if (result.state !== "succeeded") throw new Error("expected successful result");
  assert.deepEqual(Array.from(result.artifactBytes), Array.from(Buffer.from(text, "utf8")));
  assert.deepEqual(harness.events.map(event => event.event), ["started", "progress", "progress", "checkpointed",
    "progress", "progress", "checkpointed", "completed"]);
  const accepted = await portable.runSyntheticExecution(spec({ artifactText: "🚀".repeat(16_384) }), makePorts().ports);
  assert.equal(accepted.state, "succeeded");
  const rejected = makePorts();
  await assert.rejects(portable.runSyntheticExecution(spec({ artifactText: "🚀".repeat(16_384) + "a" }), rejected.ports), /65536/);
  await assert.rejects(portable.runSyntheticExecution(spec({ artifactText: "api_key=synthetic-example-only" }), rejected.ports), /secret material/);
  assert.deepEqual(rejected.events, []);
  const controller = new AbortController(), cancelled = makePorts(controller.signal);
  cancelled.ports.sleep = async () => { controller.abort(); };
  const stopped = await portable.runSyntheticExecution(baseSpec, cancelled.ports);
  assert.equal(stopped.state, "cancelled");
  assert.equal("artifactBytes" in stopped, false);
  assert.deepEqual(cancelled.events.map(event => event.event), ["started", "cancelled"]);
});

describe("synthetic executor validation", () => {
  it("rejects an unknown or missing schema before calling a port", async () => {
    let portCalls = 0;
    const ports: SyntheticExecutionPortsV1 = {
      signal: new AbortController().signal,
      now: () => {
        portCalls += 1;
        return "";
      },
      sleep: async () => {
        portCalls += 1;
      },
      emit: () => {
        portCalls += 1;
      },
    };

    await assert.rejects(runSyntheticExecution(spec({ schema: "other/v1" as never }), ports));
    await assert.rejects(runSyntheticExecution(spec({ schema: undefined as never }), ports));
    assert.equal(portCalls, 0);
  });

  for (const [field, value] of [
    ["jobId", ""],
    ["jobId", "with space"],
    ["jobId", "with\u00a0nbsp"],
    ["jobId", "x".repeat(201)],
    ["attemptId", "bad\u0000control"],
    ["attemptId", "with\u2003space"],
  ] as const) {
    it(`rejects invalid ${field}`, async () => {
      const { ports } = makePorts();
      await assert.rejects(
        runSyntheticExecution(spec({ [field]: value } as Partial<SyntheticExecutionSpecV1>), ports),
      );
    });
  }

  it("rejects invalid numeric bounds, oversized UTF-8 text, and secret material", async () => {
    const invalid = [
      spec({ steps: 0 }),
      spec({ steps: 101 }),
      spec({ steps: 2.5 }),
      spec({ checkpointEverySteps: 0 }),
      spec({ checkpointEverySteps: 5 }),
      spec({ stepDelayMilliseconds: -1 }),
      spec({ stepDelayMilliseconds: 60_001 }),
      spec({ crashAfterStep: 0 }),
      spec({ crashAfterStep: 5 }),
      spec({ artifactText: "é".repeat(32_769) }),
      spec({ artifactText: "api_key = supersecretvalue9" }),
    ];

    for (const invalidSpec of invalid) {
      const { ports } = makePorts();
      await assert.rejects(runSyntheticExecution(invalidSpec, ports));
    }
  });

  it("accepts the numeric boundary values", async () => {
    const { ports, events } = makePorts();
    const result = await runSyntheticExecution(
      spec({ steps: 100, checkpointEverySteps: 1, stepDelayMilliseconds: 60_000 }),
      ports,
    );
    assert.equal(result.state, "succeeded");
    assert.equal(events.length, 202);
  });
});

describe("synthetic executor execution", () => {
  it("keeps validated inputs when a caller edits the draft during progress", async () => {
    const draft = spec(), harness = makePorts();
    const emit = harness.ports.emit;
    harness.ports.emit = async event => {
      await emit(event);
      draft.steps = 101; draft.jobId = "changed-job"; draft.attemptId = "changed-attempt";
      draft.artifactText = "api_key=synthetic-example-only";
    };
    const result = await runSyntheticExecution(draft, harness.ports);
    assert.equal(result.state, "succeeded");
    if (result.state !== "succeeded") throw new Error("expected successful result");
    assert.equal(result.completedSteps, 4);
    assert.equal(new TextDecoder().decode(result.artifactBytes), "artifact body");
    assert.ok(harness.events.every(event => event.jobId === baseSpec.jobId && event.attemptId === baseSpec.attemptId));
  });

  it("emits ordered events, deterministic time, progress, and checkpoints", async () => {
    const { ports, events, sleepCalls } = makePorts();
    const result = await runSyntheticExecution(baseSpec, ports);

    assert.equal(result.state, "succeeded");
    assert.deepEqual(sleepCalls, [0, 0, 0, 0]);
    assert.deepEqual(
      events.map((event) => `${event.event}@${event.sequence}`),
      [
        "started@1",
        "progress@2",
        "progress@3",
        "checkpointed@4",
        "progress@5",
        "progress@6",
        "checkpointed@7",
        "completed@8",
      ],
    );
    assert.deepEqual(
      events.filter((event) => event.event === "progress").map((event) => event.progressPercent),
      [25, 50, 75, 100],
    );
    assert.deepEqual(
      events.map((event) => event.occurredAt),
      Array.from({ length: 8 }, (_, index) => new Date((index + 1) * 1_000).toISOString()),
    );
    if (result.state !== "succeeded") {
      throw new Error("expected successful result");
    }
    assert.equal(Buffer.from(result.artifactBytes).toString("utf8"), "artifact body");
    assert.deepEqual(result.checkpointIds, ["checkpoint:attempt-1:2", "checkpoint:attempt-1:4"]);
  });

  it("adds a final checkpoint when the cadence does not land on the final step", async () => {
    const { ports, events } = makePorts();
    const result = await runSyntheticExecution(spec({ steps: 5, checkpointEverySteps: 3 }), ports);
    assert.deepEqual(
      events.filter((event) => event.event === "checkpointed").map((event) => event.completedSteps),
      [3, 5],
    );
    assert.deepEqual(result.checkpointIds, ["checkpoint:attempt-1:3", "checkpoint:attempt-1:5"]);
  });

  it("emits exactly one terminal cancellation before start and returns no artifact", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ports, events, sleepCalls } = makePorts(controller.signal);
    const result = await runSyntheticExecution(baseSpec, ports);

    assert.deepEqual(result, {
      state: "cancelled",
      completedSteps: 0,
      checkpointIds: [],
      safeReasonCode: "cancelled",
    });
    assert.deepEqual(sleepCalls, []);
    assert.deepEqual(events.map((event) => event.event), ["cancelled"]);
    assert.equal(events[0]?.sequence, 1);
  });

  it("emits exactly one terminal cancellation when aborted during sleep", async () => {
    const controller = new AbortController();
    const harness = makePorts(controller.signal);
    let sleeps = 0;
    harness.ports.sleep = async () => {
      sleeps += 1;
      if (sleeps === 2) {
        controller.abort();
      }
    };

    const result = await runSyntheticExecution(baseSpec, harness.ports);
    assert.deepEqual(result, {
      state: "cancelled",
      completedSteps: 1,
      checkpointIds: [],
      safeReasonCode: "cancelled",
    });
    assert.deepEqual(harness.events.map((event) => event.event), ["started", "progress", "cancelled"]);
  });

  for (const boundary of ["progress", "checkpointed"] as const) {
    it(`honors cancellation during final ${boundary} without completing or returning an artifact`, async () => {
      const controller = new AbortController();
      const { ports, events } = makePorts(controller.signal);
      ports.emit = async event => {
        events.push(event);
        if (event.event === boundary && event.completedSteps === baseSpec.steps) {
          await Promise.resolve();
          controller.abort();
        }
      };
      const result = await runSyntheticExecution(baseSpec, ports);
      assert.equal(result.state, "cancelled");
      assert.equal(result.completedSteps, baseSpec.steps);
      assert.equal("artifactBytes" in result, false);
      assert.equal(events.filter(event => event.event === "cancelled").length, 1);
      assert.equal(events.some(event => event.event === "completed"), false);
      assert.equal(events.at(-1)?.event, "cancelled");
      assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
      assert.deepEqual(result.checkpointIds, boundary === "progress"
        ? ["checkpoint:attempt-1:2"] : ["checkpoint:attempt-1:2", "checkpoint:attempt-1:4"]);
    });
  }

  it("throws at the exact crash boundary after progress and before checkpoint", async () => {
    const { ports, events } = makePorts();
    await assert.rejects(runSyntheticExecution(spec({ crashAfterStep: 3 }), ports), (error: unknown) => {
      assert.ok(error instanceof SyntheticExecutorCrash);
      assert.equal(error.safeFailureCode, "synthetic_crash");
      assert.equal(error.completedSteps, 3);
      return true;
    });
    assert.equal(events.at(-1)?.event, "progress");
    assert.deepEqual(
      events.filter((event) => event.event === "checkpointed").map((event) => event.completedSteps),
      [2],
    );
  });

  it("does not catch or relabel injected sleep, now, or emit failures", async () => {
    for (const ports of [
      { ...makePorts().ports, sleep: async () => { throw new Error("sleep failure"); } },
      { ...makePorts().ports, now: () => { throw new Error("now failure"); } },
      { ...makePorts().ports, emit: () => { throw new Error("emit failure"); } },
    ]) {
      await assert.rejects(runSyntheticExecution(baseSpec, ports), /failure/);
    }
  });

  it("does not mutate a frozen input spec", async () => {
    const frozen = Object.freeze(spec());
    const before = { ...frozen };
    const { ports } = makePorts();
    await runSyntheticExecution(frozen, ports);
    assert.deepEqual(frozen, before);
  });
});
