import assert from "node:assert/strict";
import test from "node:test";
import { captureNativePrivateAddress, prepareNativeHttpsDestination } from "../src/node-bridge/native-https-destination";
import { preparePinnedHttpsConnection, verifyPinnedTlsPeer } from "../src/node-policy/v1/network-target-guard";

const destination = "https://native.example.test:443", resolvedAt = "2026-09-06T18:00:00.000Z";
const allowed = ["10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.254", "192.168.0.1", "192.168.255.254",
  "fc00::1", "fdff::ffff", "100.64.0.1", "100.127.255.254"];

test("canonical RFC1918, ULA and 100.64/10 pins produce exact DNS-host plans without a literal task exception", async t => {
  for (const pin of allowed) await t.test(pin, async () => {
    assert.equal(captureNativePrivateAddress(destination, pin), pin);
    let calls = 0;
    const answers = Array(16).fill(pin) as string[];
    const plan = await prepareNativeHttpsDestination(destination, pin, { async resolve(host) {
      calls++; assert.equal(host, "native.example.test"); return answers;
    } }, resolvedAt);
    assert.equal(calls, 1);
    assert.deepEqual(plan, { canonicalDestination: destination, host: "native.example.test", port: 443,
      hostKind: "dns", pinnedAddresses: [pin], literalAddressException: false, resolvedAt });
    answers.fill("8.8.8.8"); assert.deepEqual(plan.pinnedAddresses, [pin]);
    assert.doesNotThrow(() => verifyPinnedTlsPeer(plan, { connectedAddress: pin, connectedPort: 443,
      serverName: "native.example.test", certificateHostnameVerified: true }));
    assert.throws(() => verifyPinnedTlsPeer(plan, { connectedAddress: "8.8.8.8", connectedPort: 443,
      serverName: "native.example.test", certificateHostnameVerified: true }));
  });
});

test("private-pin capture rejects noncanonical, global, loopback, metadata, link-local and reserved values", () => {
  for (const pin of ["127.0.0.1", "::1", "169.254.169.254", "169.254.1.1", "fe80::1", "224.0.0.1", "ff02::1",
    "0.0.0.0", "::", "240.0.0.1", "192.0.0.1", "198.18.0.1", "192.0.2.1", "2001:db8::1", "8.8.8.8",
    "2001:4860:4860::8888", "100.63.255.254", "100.128.0.1", "172.15.255.254", "172.32.0.1",
    "10.01.2.3", " 10.1.2.3", "10.1.2.3 ", "FD00::1", "fd00:0:0:0:0:0:0:1", "[fd00::1]", "fd00::1%eth0",
    "::ffff:10.1.2.3", "not-an-address", "", "10.1.2.3:443"])
    assert.throws(() => captureNativePrivateAddress(destination, pin), pin);
  assert.equal(captureNativePrivateAddress(destination), undefined);
  for (const target of ["https://10.1.2.3:443", "https://8.8.8.8:443", "http://native.example.test:443",
    "https://native.example.test", "https://native.example.test:443/path", "https://NATIVE.example.test:443"])
    assert.throws(() => captureNativePrivateAddress(target, "10.1.2.3"), target);
});

test("every private DNS answer must match the pin; empty, oversized, mixed, changed and malformed sets are denied", async t => {
  const pin = "10.1.2.3";
  for (const [name, answers] of [
    ["empty", []], ["oversized", Array(17).fill(pin)], ["mixed global", [pin, "8.8.8.8"]],
    ["mixed private", [pin, "10.1.2.4"]], ["changed", ["10.1.2.4"]], ["malformed", [pin, "not-an-address"]],
    ["metadata", [pin, "169.254.169.254"]],
  ] as [string, string[]][]) await t.test(name, async () => {
    let calls = 0;
    await assert.rejects(prepareNativeHttpsDestination(destination, pin, { async resolve() { calls++; return answers; } }, resolvedAt));
    assert.equal(calls, 1);
  });
  let calls = 0;
  await assert.rejects(prepareNativeHttpsDestination(destination, pin, { async resolve() { calls++; throw new Error("synthetic resolver failure"); } }, resolvedAt));
  assert.equal(calls, 1);
});

test("each new plan resolves again and cannot reuse a formerly matching private DNS answer", async () => {
  let answers = ["10.1.2.3"], calls = 0;
  const resolver = { async resolve() { calls++; return answers; } };
  const first = await prepareNativeHttpsDestination(destination, "10.1.2.3", resolver, resolvedAt);
  answers = ["10.1.2.4"];
  await assert.rejects(prepareNativeHttpsDestination(destination, "10.1.2.3", resolver, resolvedAt));
  assert.equal(calls, 2); assert.deepEqual(first.pinnedAddresses, ["10.1.2.3"]);
});

test("unpinned private DNS and generic task destinations retain their original prohibitions", async () => {
  for (const pin of ["10.1.2.3", "fd00::1", "100.100.10.20"]) {
    const resolver = { async resolve() { return [pin]; } };
    await assert.rejects(prepareNativeHttpsDestination(destination, undefined, resolver, resolvedAt));
    await assert.rejects(preparePinnedHttpsConnection({ canonicalDestination: destination, allowedDestinations: [destination],
      resolver, resolvedAt, executor: { exposesFinalDestination: true, supportsPinnedTlsConnection: true } }));
    assert.deepEqual((await prepareNativeHttpsDestination(destination, pin, resolver, resolvedAt)).pinnedAddresses, [pin]);
  }
  const global = await prepareNativeHttpsDestination(destination, undefined, { async resolve() { return ["8.8.8.8"]; } }, resolvedAt);
  assert.deepEqual(global.pinnedAddresses, ["8.8.8.8"]); assert.equal(global.literalAddressException, false);
});
