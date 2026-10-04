// Guard-bites proof for the installation operations mode.
//
// Each of these mutates one guard, requires the operations-mode suite to FAIL,
// and restores the file. Without a failing run, "the guard is covered" is a
// claim rather than evidence.
//
// These run against real PostgreSQL as the production logins. Each one costs a
// disposable cluster, so they are in their own file rather than mixed into the
// functional suite.
import assert from "node:assert/strict";
import test from "node:test";
import { assertGuardBites, GuardDidNotBiteError, REPOSITORY_ROOT } from "./support/attack-kit/index";

const SUITE = "tests/operations-mode-postgres.test.ts";
const CMD = ["node", "--import", "tsx", "--test", "--test-concurrency=1", SUITE];
const BOUND = 420_000;

test("the claim guard is a real guard: removing it lets a paused installation claim work", { timeout: 900_000 },
  async () => {
    const find = `  RAISE EXCEPTION 'installation operations mode % refuses a new claim', mode
    USING ERRCODE = 'object_not_in_prerequisite_state';`;
    const replace = `  RETURN NEW;`;
    try {
      await assertGuardBites({ root: REPOSITORY_ROOT, file: "db/migrations/0156_installation_operations_mode_gates.sql",
        find, replace, testCmd: CMD, boundMs: BOUND, baselineBoundMs: BOUND,
        because: "paused, draining and stopped must each refuse a new claim while the trigger is removed" });
    } catch (error) {
      if (error instanceof GuardDidNotBiteError) assert.fail(
        `the claim guard is unpinned: removing it left the operations-mode suite green.\n${error.message}`);
      throw error;
    }
  });

test("the start guard is a real guard: removing it lets a paused installation start work", { timeout: 900_000 },
  async () => {
    const find = `  RAISE EXCEPTION 'installation operations mode % refuses a new start', mode
    USING ERRCODE = 'object_not_in_prerequisite_state';`;
    const replace = `  RETURN NEW;`;
    try {
      await assertGuardBites({ root: REPOSITORY_ROOT, file: "db/migrations/0156_installation_operations_mode_gates.sql",
        find, replace, testCmd: CMD, boundMs: BOUND, baselineBoundMs: BOUND,
        because: "a claim that predates the mode must still not be handed to a worker while the trigger is removed" });
    } catch (error) {
      if (error instanceof GuardDidNotBiteError) assert.fail(
        `the start guard is unpinned: removing it left the operations-mode suite green.\n${error.message}`);
      throw error;
    }
  });

test("the owner check is a real guard: dropping it lets a non-owner record a mode", { timeout: 900_000 },
  async () => {
    const find = `  -- Only the owner's own human session writes this. A worker, an agent and the
  -- shared intake login are all refused here, not merely in the application.
  IF NOT EXISTS (`;
    const replace = `  IF NOT EXISTS (SELECT 1 FROM (SELECT 1) AS always_true WHERE`;
    try {
      await assertGuardBites({ root: REPOSITORY_ROOT, file: "db/migrations/0155_installation_operations_modes.sql",
        find, replace, testCmd: CMD, boundMs: BOUND, baselineBoundMs: BOUND,
        because: "a non-owner identity holding every table right must be refused by the trigger itself" });
    } catch (error) {
      if (error instanceof GuardDidNotBiteError) assert.fail(
        `the owner check is unpinned: removing it left the operations-mode suite green.\n${error.message}`);
      throw error;
    }
  });
