import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHermes021MacosSubprocessStreamJsonHostV1,
  type Hermes021MacosSubprocessHostConfigurationV1 } from
  "../../src/harness/hermes-021-v1/subprocess-stream-json-host";

/** Source-only concrete-host fixture: no filesystem or subprocess operation occurs. */
export function createHermesOwnerQualificationHostFixture(
  configuration: Hermes021MacosSubprocessHostConfigurationV1,
  sessionId = "session:qualified") {
  const events = new EventEmitter();
  const child = Object.assign(events, { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), kill() { return true; } }) as unknown as ChildProcessWithoutNullStreams;
  let expectedText = "", calls = 0;
  const host = createHermes021MacosSubprocessStreamJsonHostV1(configuration, () => {
    calls += 1;
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", session_id: sessionId,
        exit_code: 0, text: expectedText, tokens: { input: 14, output: 8, total: 22, cache_read: 0,
          cache_write: 0 }, duration_ms: 1_250, timestamp: 1_750_000_000_000 })}\n`));
      child.emit("close", 0, null);
    });
    return child;
  }, async () => "/private/tmp/control-room-hermes-qualification-fixture",
  async () => {}, async (_path, contents) => {
    expectedText = /CONTROL_ROOM_HERMES_RUNNER_[a-f0-9]+/u.exec(contents)?.[0] ?? "";
  }, Date.now);
  return Object.freeze({ host, calls: () => calls,
    close() { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); } });
}
