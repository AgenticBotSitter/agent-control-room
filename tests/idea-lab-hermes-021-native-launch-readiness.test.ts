import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sha256Digest } from "../src/security/index.ts";
import {
  IdeaLabErrorV1,
  ideaLabHermes021NativeLaunchReadinessV1,
  parseIdeaLabHermes021NativeLaunchReadinessV1,
} from "../src/idea-lab/v1/index.ts";

test("CR12B-IDEA-108 blocks the owner command on the exact Hermes profile isolation contradiction", () => {
  const readiness = parseIdeaLabHermes021NativeLaunchReadinessV1(ideaLabHermes021NativeLaunchReadinessV1);
  assert.deepEqual(readiness.observedProfileSemantics, {
    freshProfileSeedsEmptyProtectedValueFile: true,
    cloneCopiesProtectedValueFile: true,
    cloneCopiesSoulSkillsAndMemory: true,
    noSkillsCannotCombineWithClone: true,
    protectedValueOnlyCloneAvailable: false,
  });
  assert.deepEqual([readiness.status, readiness.profileIsolationEligible, readiness.ownerCommandEmitted,
    readiness.nativeAttemptsMade, readiness.providerCallsMade, readiness.protectedValuesAccessed],
  ["blocked_before_owner_command", false, false, 0, 0, false]);
});

test("CR12B-IDEA-108 rejects re-digested eligibility, command, authority, and source claims", () => {
  for (const changed of [
    { profileIsolationEligible: true }, { ownerCommandEmitted: true }, { grantsCommandAuthority: true },
    { profileSourceDigests: [{ ...ideaLabHermes021NativeLaunchReadinessV1.profileSourceDigests[0],
      sha256: `sha256:${"a".repeat(64)}` }, ideaLabHermes021NativeLaunchReadinessV1.profileSourceDigests[1]] },
  ]) {
    const unsigned = { ...ideaLabHermes021NativeLaunchReadinessV1, ...changed } as Record<string, unknown>;
    delete unsigned.readinessDigest;
    assert.throws(() => parseIdeaLabHermes021NativeLaunchReadinessV1({ ...unsigned,
      readinessDigest: sha256Digest(unsigned) }), (error) => error instanceof IdeaLabErrorV1);
  }
});

test("CR12B-IDEA-108 exact boundary rejects accessors and Proxies without executing behavior", () => {
  let traps = 0;
  const accessor = { ...ideaLabHermes021NativeLaunchReadinessV1 };
  Object.defineProperty(accessor, "status", { enumerable: true, get() { traps += 1; return "blocked_before_owner_command"; } });
  assert.throws(() => parseIdeaLabHermes021NativeLaunchReadinessV1(accessor),
    (error) => error instanceof IdeaLabErrorV1);
  assert.throws(() => parseIdeaLabHermes021NativeLaunchReadinessV1(new Proxy(
    ideaLabHermes021NativeLaunchReadinessV1, { ownKeys() { traps += 1; return []; } })),
  (error) => error instanceof IdeaLabErrorV1);
  assert.equal(traps, 0);
});

test("CR12B-IDEA-108 readiness implementation contains no process, filesystem, network, credential, or provider client", async () => {
  const source = await readFile("src/idea-lab/v1/hermes-021-native-launch-readiness.ts", "utf8");
  for (const forbidden of ['from "node:child_process"', 'from "node:fs"', 'from "node:net"', "fetch(", "spawn(",
    "execFile(", "createPostgresClient(", "Keychain", "auth.json", ".env"]) assert.equal(source.includes(forbidden), false, forbidden);
});
