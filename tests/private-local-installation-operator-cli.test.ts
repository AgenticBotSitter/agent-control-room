import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { parsePrivateLocalInstallationOperatorArgumentsV1,
  PRIVATE_LOCAL_INSTALLATION_OPERATOR_CLI_V1,
  runPrivateLocalInstallationOperatorCliV1 } from "../src/installer/v1/private-local-installation-operator-cli";

function runtime(overrides: Record<string, unknown> = {}) {
  const lines: string[] = [], errors: string[] = [];
  return {
    value: {
      async loadInstalledConfiguration() { return { custody: {}, journal: {} }; },
      report(message: string) { lines.push(message); },
      reportError(message: string) { errors.push(message); },
      signals: new EventEmitter(),
      createOperator: undefined,
      startLifecycle: undefined,
      ...overrides,
    }, lines, errors,
  };
}

test("the operator CLI accepts only its fixed help and one-shot command grammar", () => {
  assert.deepEqual(parsePrivateLocalInstallationOperatorArgumentsV1(["--help"]), { help: true });
  for (const command of ["status", "setup-next", "start"] as const)
    assert.deepEqual(parsePrivateLocalInstallationOperatorArgumentsV1([command]), { command });
  for (const args of [[], ["status", "--configuration", "/private/config"], ["status", "x"], ["--help", "status"],
    ["shell"], ["setup-next", "--loop"], ["start", "--open-browser"]])
    assert.throws(() => parsePrivateLocalInstallationOperatorArgumentsV1(args), /private_local_installation_operator_cli_refused/u);
});

test("help and malformed commands are inert before the installed custody loader", async () => {
  let loads = 0;
  const help = runtime({ async loadInstalledConfiguration() { loads++; return { custody: {}, journal: {} }; } });
  assert.equal(await runPrivateLocalInstallationOperatorCliV1(["--help"], help.value), 0);
  assert.equal(loads, 0);
  assert.match(help.lines.join(""), /status \| setup-next \| start/u);

  const malformed = runtime({ async loadInstalledConfiguration() { loads++; return { custody: {}, journal: {} }; } });
  assert.equal(await runPrivateLocalInstallationOperatorCliV1(["status", "--loop"], malformed.value), 2);
  assert.equal(loads, 0);
  assert.equal(malformed.errors.length, 1);
});

test("one exact installed custody and journal handoff produces sanitized status only", async () => {
  let loads = 0, custody: unknown, journal: unknown;
  const fixture = runtime({
    async loadInstalledConfiguration() { loads++; return { custody: { private: "never printed" }, journal: { canonical: true } }; },
    createOperator(receivedCustody: unknown, receivedRuntime: { journal: unknown }) {
      custody = receivedCustody; journal = receivedRuntime.journal;
      return { async status() { return { status: "ready", nextStage: "database_authority", privatePath: "/do-not-print" }; },
        async setupNext() { throw new Error("not selected"); }, async start() { throw new Error("not selected"); } };
    },
  });
  assert.equal(await runPrivateLocalInstallationOperatorCliV1(["status"], fixture.value), 0);
  assert.equal(loads, 1);
  assert.deepEqual(custody, { private: "never printed" }); assert.deepEqual(journal, { canonical: true });
  const result = JSON.parse(fixture.lines.join(""));
  assert.deepEqual(result, { schema: PRIVATE_LOCAL_INSTALLATION_OPERATOR_CLI_V1, command: "status", status: "ready",
    nextStage: "database_authority", startsService: false, startsWorker: false, opensBrowser: false });
  assert.doesNotMatch(JSON.stringify(result), /never printed|do-not-print/u);
});

test("setup-next dispatches once and truthfully reports the platform-service effect boundary", async () => {
  for (const [command, result] of [["setup-next", { status: "completed", requestedStage: "database_authority" }],
    ["setup-next", { status: "completed", requestedStage: "platform_service" }]] as const) {
    let setupCalls = 0;
    const fixture = runtime({
      createOperator() { return {
        async status() { throw new Error("not selected"); },
        async setupNext() { setupCalls++; return result; },
        async start() { throw new Error("not selected"); },
      }; },
    });
    assert.equal(await runPrivateLocalInstallationOperatorCliV1([command], fixture.value), 0);
    assert.equal(setupCalls, command === "setup-next" ? 1 : 0);
    const printed = fixture.lines.join("");
    assert.doesNotMatch(printed, /privateService|browser|path/u);
    assert.equal(JSON.parse(printed).startsService, result.requestedStage === "platform_service");
  }
});

test("termination racing startup owns the returned bootstrap once and removes lifecycle handlers", async () => {
  const signals = new EventEmitter(); let starts = 0, closes = 0;
  const canceled = runtime({ signals, createOperator() { return {
    async status() { throw new Error("not selected"); }, async setupNext() { throw new Error("not selected"); },
    async start() { starts++; signals.emit("SIGTERM"); return { async close() { closes++; } }; },
  }; } });
  assert.equal(await runPrivateLocalInstallationOperatorCliV1(["start"], canceled.value), 1);
  assert.equal(starts, 1); assert.equal(closes, 1);
  assert.equal(signals.listenerCount("SIGINT"), 0); assert.equal(signals.listenerCount("SIGTERM"), 0);

  const successfulSignals = new EventEmitter(); let successfulCloses = 0;
  const successful = runtime({ signals: successfulSignals, createOperator() { return {
    async status() { throw new Error("not selected"); }, async setupNext() { throw new Error("not selected"); },
    async start() { const host = { async close() { successfulCloses++; } };
      setImmediate(() => successfulSignals.emit("SIGTERM")); return host; },
  }; } });
  assert.equal(await runPrivateLocalInstallationOperatorCliV1(["start"], successful.value), 0);
  assert.equal(successfulCloses, 1);
  assert.equal(successfulSignals.listenerCount("SIGINT"), 0); assert.equal(successfulSignals.listenerCount("SIGTERM"), 0);

  let calls = 0;
  const malformed = runtime({ async loadInstalledConfiguration() { return { custody: {}, journal: {}, extra: true }; },
    createOperator() { calls++; throw new Error("must not create"); } });
  assert.equal(await runPrivateLocalInstallationOperatorCliV1(["setup-next"], malformed.value), 1);
  assert.equal(calls, 0);
});

test("a real operator start custody blocker is projected immediately without a host close", async () => {
  const signals = new EventEmitter();
  let custodyLoads = 0, journalCalls = 0;
  const fixture = runtime({
    signals,
    async loadInstalledConfiguration() {
      return {
        custody: { async loadPrivateConfiguration() { custodyLoads++; return undefined; } },
        journal: {
          async append() { journalCalls++; throw new Error("journal must not run"); },
          async readHistory() { journalCalls++; throw new Error("journal must not run"); },
          async inspectSettledHistory() { journalCalls++; throw new Error("journal must not run"); },
        },
      };
    },
    // Deliberately omit the seam: this exercises the installed operator's
    // missing-custody admission result rather than a synthetic blocked value.
    createOperator: undefined,
  });
  assert.equal(await runPrivateLocalInstallationOperatorCliV1(["start"], fixture.value), 0);
  assert.equal(custodyLoads, 1);
  assert.equal(journalCalls, 0);
  assert.equal(fixture.errors.length, 0);
  assert.deepEqual(JSON.parse(fixture.lines.join("")), {
    schema: PRIVATE_LOCAL_INSTALLATION_OPERATOR_CLI_V1,
    command: "start",
    status: "blocked",
    blocker: "private_configuration_custody_missing",
    startsService: false,
    startsWorker: false,
    opensBrowser: false,
  });
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
