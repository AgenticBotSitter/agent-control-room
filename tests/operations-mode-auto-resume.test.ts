import assert from "node:assert/strict";
import test from "node:test";
import { machineHealthAutoResumeAllowedV1 } from "../src/web/v1/operations-mode-service";

const automatic = "Paused automatically — this Mac was too busy. It will start again by itself when things calm down.";

test("automatic recovery accepts only the current automatic pause, never an owner action", () => {
  assert.equal(machineHealthAutoResumeAllowedV1({ mode: "paused", reason: automatic }, automatic), true);
  for (const current of [
    undefined,
    { mode: "paused" as const, reason: "owner is checking the Mac" },
    { mode: "draining" as const, reason: "owner is finishing work" },
    { mode: "stopped" as const, reason: "owner stopped work" },
    { mode: "running" as const, reason: "owner resumed work" },
  ]) assert.equal(machineHealthAutoResumeAllowedV1(current, automatic), false);
});
