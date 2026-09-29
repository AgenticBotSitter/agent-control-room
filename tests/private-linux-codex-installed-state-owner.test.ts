import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createPrivateLinuxCodexInstalledStateOwnerV1,
  PRIVATE_LINUX_CODEX_INSTALLED_STATE_OWNER_V1,
  privateLinuxCodexInstalledStateRequirementsV1,
} from "../src/node-bridge/private-linux-codex-installed-state-owner";

function refused(value: unknown) {
  assert.throws(() => createPrivateLinuxCodexInstalledStateOwnerV1(value), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "private_linux_codex_installed_state_native_custody_unavailable");
    assert.equal(error.stack, undefined);
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ["message", "stack"]);
    return true;
  });
}

test("ordinary paths, configuration, claimed verification and other-platform custody grant nothing", () => {
  for (const value of [undefined, null, false, true, 1, "./private", "/private/example", [], {},
    { schema: PRIVATE_LINUX_CODEX_INSTALLED_STATE_OWNER_V1, platform: "linux", verified: true },
    { paths: { bridge: "/private/example" }, releaseDigest: "sha256:" + "a".repeat(64) },
    { schema: "control-room.private-installed-configuration-native-verifier-custody/v1",
      status: "protected_native_verifier_bound", custody: {} },
    { installedConfigurationCapability: Object.freeze({}), ready: true },
  ]) refused(value);
});

test("rejects structural, copied, inherited and overridden resource owners without invoking ports", () => {
  let calls = 0;
  const effect = () => { calls++; throw new Error("private-value"); };
  class FakeOwner {
    open = effect;
    unlock = effect;
    close = effect;
    assertCurrent = effect;
  }
  const fake = new FakeOwner();
  const ports = Object.freeze({ verify: effect, open: effect, clock: effect, signer: effect,
    keys: fake, journal: fake, security: fake, approvals: fake, transport: fake,
    loadEnvelope: effect, unwrap: effect, start: effect, dispose: effect });
  for (const value of [effect, fake, { ...fake }, Object.create(fake), ports,
    { ...ports, open: effect }, Object.create(null)]) refused(value);
  assert.equal(calls, 0);
});

test("hostile proxies, revoked proxies, accessors and coercion hooks are never observed", () => {
  let observations = 0;
  const trap = () => { observations++; throw new Error("private-value"); };
  const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap,
    getOwnPropertyDescriptor: trap, has: trap, isExtensible: trap });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const accessors = Object.defineProperties({}, {
    schema: { get: trap }, installedConfigurationCapability: { get: trap },
    then: { get: trap }, toJSON: { get: trap },
  });
  for (const value of [proxy, revoked.proxy, accessors,
    { toString: trap, valueOf: trap, [Symbol.toPrimitive]: trap },
    { then: trap }, new Proxy(trap, { apply: trap, get: trap })]) refused(value);
  assert.equal(observations, 0);
});

test("repeated and changed requests cannot turn a refusal into authority or leak private input", () => {
  const input = { installation: "private-installation", release: "private-release",
    credentials: "private-credential", key: "private-key", platform: "linux" };
  refused(input);
  refused(input);
  refused({ ...input, platform: "darwin", verified: true });
  refused({ ...input, installation: "other", release: "other", ready: true });
});

test("source requirement metadata is deeply immutable and is not a capability", () => {
  const requirements = privateLinuxCodexInstalledStateRequirementsV1;
  assert.ok(Object.isFrozen(requirements));
  assert.ok(Object.isFrozen(requirements.bindings));
  assert.ok(Object.isFrozen(requirements.resources));
  assert.throws(() => Object.assign(requirements, { ready: true }), TypeError);
  refused(requirements);
  refused({ ...requirements });
});

test("boundary has no runtime imports or resource-opening surface", () => {
  const source = readFileSync(new URL(
    "../src/node-bridge/private-linux-codex-installed-state-owner.ts", import.meta.url), "utf8");
  // Import exclusion prevents constructors in dependencies from acquiring
  // resources before the unconditional refusal can run.
  assert.doesNotMatch(source, /^\s*import\b/mu);
  assert.doesNotMatch(source, /\b(?:import|require)\s*\(/u);
  assert.doesNotMatch(source, /\b(?:process|fetch|globalThis)\s*[.([]/u);
  assert.doesNotMatch(source, /\bnew\s+(?!Error\b)[A-Za-z_$]/u);
});
