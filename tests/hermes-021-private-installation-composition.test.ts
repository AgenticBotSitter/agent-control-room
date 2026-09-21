import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateHermes021LocalInstallationDeliveryV1 } from "../src/web/v1/hermes-021-private-installation-composition";

const binding = Object.freeze({ localServiceId: "service:local-hermes", workerId: "worker:local-hermes",
  expectedVersion: "0.21.3" as const, sourceRevision: "00570550" });
const subprocess = Object.freeze({ executablePath: "/private/fixture/hermes", profile: "cr",
  model: "qwen3.8:27b-long", provider: "ollama", workingDirectory: "/private/fixture/work" });

function input() {
  return {
    tenantId: "tenant:local",
    execution: { preparation: {}, runs: {}, delivery: { binding, db: {}, integrityKey: new Uint8Array(32),
      policy: { assertAdmitted() {} }, terminalResultStorage: {} } },
    results: {},
    assertAuthority() {},
    subprocess,
  };
}

test("private Hermes installation composition exposes only an inert delivery callback", () => {
  const delivery = createPrivateHermes021LocalInstallationDeliveryV1(input());
  assert.deepEqual(Object.keys(delivery), ["deliver"]);
  assert.equal(typeof delivery.deliver, "function");
  assert.equal(Object.isFrozen(delivery), true);
});

test("private Hermes installation composition refuses test-host and malformed runner substitutions", () => {
  assert.throws(() => createPrivateHermes021LocalInstallationDeliveryV1({ ...input(), host: {} }),
    /hermes_021_private_installation_composition_unavailable/);
  assert.throws(() => createPrivateHermes021LocalInstallationDeliveryV1({ ...input(), subprocess: { ...subprocess, executablePath: "hermes" } }),
    /hermes_021_private_installation_composition_unavailable/);
  assert.throws(() => createPrivateHermes021LocalInstallationDeliveryV1({ ...input(), execution: {
    ...input().execution, delivery: { ...input().execution.delivery, privatePort: {} },
  } }), /hermes_021_private_installation_composition_unavailable/);
});

test("private Hermes installation composition validates an untrusted queue target before dispatch", async () => {
  const delivery = createPrivateHermes021LocalInstallationDeliveryV1(input());
  await assert.rejects(delivery.deliver({ kind: "not-hermes" }, new AbortController().signal));
});
