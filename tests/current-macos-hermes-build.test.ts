import assert from "node:assert/strict";
import test from "node:test";
import { captureCurrentMacosHermesBuildV1, createCurrentMacosHermesConnectorProfileV1 } from "../src/harness/hermes-local-v1";

const current = Object.freeze({
  versionOutput: "Hermes Agent v0.20.0+22959.gb50bb77 (2026.9.24) · upstream b50bb77e\nInstall directory: /private/path",
  sourceRevision: "b50bb77ec5cf44babadbd2aa8b6338bf505ef972",
});

test("captures an installed Hermes build and derives the inert profile", () => {
  const build = captureCurrentMacosHermesBuildV1(current);
  const profile = createCurrentMacosHermesConnectorProfileV1(current);
  assert.equal(build.version, "0.20.0+22959.gb50bb77");
  assert.equal(profile.harnessVersion, build.version);
  assert.equal(profile.sourceRevision, build.sourceRevision);
});

test("a normal Hermes update is a new qualifying build, not a hardcoded refusal", () => {
  const updated = { versionOutput: "Hermes Agent v0.20.1 (2026.9.25) · upstream c0ffee12",
    sourceRevision: "c0ffee12aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const previous = captureCurrentMacosHermesBuildV1(current);
  const next = captureCurrentMacosHermesBuildV1(updated);
  assert.equal(next.version, "0.20.1");
  assert.notEqual(next.buildDigest, previous.buildDigest);
});

test("refuses malformed output or an abbreviated source that does not match the local revision", () => {
  for (const value of [
    { ...current, versionOutput: "Hermes Agent v0.20" },
    { ...current, sourceRevision: "00000000c5cf44babadbd2aa8b6338bf505ef972" },
    { versionOutput: current.versionOutput },
    undefined,
  ]) assert.throws(() => captureCurrentMacosHermesBuildV1(value));
});
