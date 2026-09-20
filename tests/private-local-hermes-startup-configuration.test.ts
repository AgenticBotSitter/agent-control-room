import assert from "node:assert/strict";
import test from "node:test";
import { validatePrivateTaskStartupConfiguration } from "../src/web/v1/private-task-startup";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

test("a local Hermes queue route is captured without requiring a remote session transport", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const scenario = fixture.scenario();
  let called = 0;
  const configuration = { ...scenario.configuration, coordinator: {
    ...scenario.configuration.coordinator, sessions: undefined, nativeHttp: undefined,
    hermes021Local: { async deliver() { called++; } },
  } };
  const captured = validatePrivateTaskStartupConfiguration(configuration);
  assert.equal(typeof captured.hermes021Local?.deliver, "function");
  await captured.hermes021Local!.deliver({} as never, new AbortController().signal);
  assert.equal(called, 1);
});
