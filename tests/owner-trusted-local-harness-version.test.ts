import assert from "node:assert/strict";
import test from "node:test";
import { ownerTrustedLocalHarnessVersionV1 } from "../src/harness/v1/owner-trusted-local-enablements";

test("the run record takes the version token from the pinned --version line", () => {
  for (const [line, token] of [["codex-cli 0.46.0", "0.46.0"], ["2.1.3 (Claude Code)", "2.1.3"], ["Hermes Agent v0.21.0", "0.21.0"],
    ["hermes 1.0.0", "1.0.0"], ["0.9.1-beta.2", "0.9.1-beta.2"], ["tool (v1.2)", "1.2"], ["build-7", "build-7"]] as const)
    assert.equal(ownerTrustedLocalHarnessVersionV1(line), token, line);
});

test("a pinned line with no usable version token refuses", () => {
  for (const line of ["unknown version", "", "x".repeat(81), "v 1"]) assert.throws(() => ownerTrustedLocalHarnessVersionV1(line), line);
});
