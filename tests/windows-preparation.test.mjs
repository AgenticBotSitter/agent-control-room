import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPreparationResult,
  exitCodeFor,
  meetsMinimumVersion,
  preparationCategories,
  REQUIRED_NODE_VERSION,
  REQUIRED_PNPM_VERSION,
  validateProbeCapabilities,
} from "../scripts/windows/classify-preparation-result.mjs";
import { windowsExitCategories, windowsExitCodeFor } from "../scripts/windows/windows-exit-codes.mjs";

const GOOD_STDOUT = `ps: 5.1\nnode: 22.22.3\npnpm: 11.19.0\n`;

test("canonical table is the single shared mapping", () => {
  assert.deepEqual([...preparationCategories], [...windowsExitCategories]);
  assert.equal(exitCodeFor, windowsExitCodeFor);
  assert.equal(exitCodeFor("available"), 0);
  assert.equal(exitCodeFor("missing"), 1);
  assert.equal(exitCodeFor("locked"), 2);
  assert.equal(exitCodeFor("corrupt"), 3);
  assert.equal(exitCodeFor("unavailable_platform"), 4);
  assert.equal(exitCodeFor("permission_denied"), 5);
  assert.equal(exitCodeFor("interaction_required"), 6);
  assert.throws(() => exitCodeFor("totally-made-up"), /unknown windows exit category/);
});

test("ENOENT maps to unavailable_platform (exit 4)", () => {
  const r = classifyPreparationResult({ error: Object.assign(new Error("spawn"), { code: "ENOENT" }) });
  assert.equal(r.category, "unavailable_platform");
  assert.equal(r.exit, 4);
});

test("EACCES maps to permission_denied (exit 5), not locked", () => {
  const r = classifyPreparationResult({ error: Object.assign(new Error("denied"), { code: "EACCES" }) });
  assert.equal(r.category, "permission_denied");
  assert.equal(r.exit, 5);
});

test("EPERM maps to permission_denied (exit 5), not locked", () => {
  const r = classifyPreparationResult({ error: Object.assign(new Error("denied"), { code: "EPERM" }) });
  assert.equal(r.category, "permission_denied");
  assert.equal(r.exit, 5);
});

test("other spawn errors still map to locked (exit 2)", () => {
  const r = classifyPreparationResult({ error: Object.assign(new Error("other"), { code: "ETIMEDOUT" }) });
  assert.equal(r.category, "locked");
  assert.equal(r.exit, 2);
});

test("signal kill maps to locked (exit 2)", () => {
  const r = classifyPreparationResult({ status: null, signal: "SIGTERM", stdout: "", stderr: "" });
  assert.equal(r.category, "locked");
  assert.equal(r.exit, 2);
});

test("non-zero exit maps to locked (exit 2)", () => {
  const r = classifyPreparationResult({ status: 1, signal: null, stdout: "x", stderr: "y" });
  assert.equal(r.category, "locked");
  assert.equal(r.exit, 2);
});

test("zero exit + empty stdout maps to locked (exit 2)", () => {
  const r = classifyPreparationResult({ status: 0, signal: null, stdout: "  \n", stderr: "" });
  assert.equal(r.category, "locked");
  assert.equal(r.exit, 2);
});

test("zero exit + verified capabilities maps to available (exit 0)", () => {
  const r = classifyPreparationResult({ status: 0, signal: null, stdout: GOOD_STDOUT, stderr: "" });
  assert.equal(r.category, "available");
  assert.equal(r.exit, 0);
});

test("zero exit + node: missing is missing, not available", () => {
  const r = classifyPreparationResult({
    status: 0, signal: null, stdout: "ps: 5.1\nnode: missing\npnpm: 11.19.0\n", stderr: "",
  });
  assert.equal(r.category, "missing");
  assert.equal(r.exit, 1);
});

test("zero exit + pnpm: missing is missing, not available", () => {
  const r = classifyPreparationResult({
    status: 0, signal: null, stdout: "ps: 5.1\nnode: 22.22.3\npnpm: missing\n", stderr: "",
  });
  assert.equal(r.category, "missing");
  assert.equal(r.exit, 1);
});

test("zero exit + under-minimum node is missing", () => {
  const r = classifyPreparationResult({
    status: 0, signal: null, stdout: "ps: 5.1\nnode: 20.11.0\npnpm: 11.19.0\n", stderr: "",
  });
  assert.equal(r.category, "missing");
  assert.equal(r.exit, 1);
});

test("zero exit + under-minimum pnpm is missing", () => {
  const r = classifyPreparationResult({
    status: 0, signal: null, stdout: "ps: 5.1\nnode: 22.22.3\npnpm: 10.2.0\n", stderr: "",
  });
  assert.equal(r.category, "missing");
  assert.equal(r.exit, 1);
});

test("extra output lines (e.g. legacy dpapi:) are ignored, not required", () => {
  const withDpapi = `${GOOD_STDOUT}dpapi: missing\n`;
  assert.equal(validateProbeCapabilities(withDpapi).ok, true);
  const r = classifyPreparationResult({ status: 0, signal: null, stdout: withDpapi, stderr: "" });
  assert.equal(r.category, "available");
});

test("meetsMinimumVersion compares numerically and fails closed", () => {
  assert.equal(meetsMinimumVersion("22.22.3", REQUIRED_NODE_VERSION), true);
  assert.equal(meetsMinimumVersion("22.13.0", REQUIRED_NODE_VERSION), true);
  assert.equal(meetsMinimumVersion("22.12.9", REQUIRED_NODE_VERSION), false);
  assert.equal(meetsMinimumVersion("20.11.0", REQUIRED_NODE_VERSION), false);
  assert.equal(meetsMinimumVersion("11.19.0", REQUIRED_PNPM_VERSION), true);
  assert.equal(meetsMinimumVersion("10.9.9", REQUIRED_PNPM_VERSION), false);
  assert.equal(meetsMinimumVersion("missing", REQUIRED_PNPM_VERSION), false);
  assert.equal(meetsMinimumVersion("", REQUIRED_PNPM_VERSION), false);
  assert.equal(meetsMinimumVersion("11.19", REQUIRED_PNPM_VERSION), false);
});

test("validateProbeCapabilities names the failing capability", () => {
  assert.equal(validateProbeCapabilities(GOOD_STDOUT).ok, true);
  assert.match(validateProbeCapabilities("ps: 5.1\npnpm: 11.19.0\n").detail, /node: missing/);
  assert.match(
    validateProbeCapabilities("ps: 5.1\nnode: 22.22.3\npnpm: 9.0.0\n").detail,
    /pnpm: 9\.0\.0 below minimum/,
  );
});
