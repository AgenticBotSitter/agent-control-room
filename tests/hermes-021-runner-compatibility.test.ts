import assert from "node:assert/strict";
import test from "node:test";
import { HERMES_021_SOURCE_REVISION_V1, HERMES_021_VERSION_V1,
  inspectHermes021MacosLocalRunnerCompatibilityV1,
  verifyHermes021MacosLocalRunnerVersionV1 } from "../src/harness/hermes-021-v1";

const observed = "Hermes Agent v0.21.3 (2026.9.14) · upstream 00570550\nInstall directory: /private/owner/hermes\n";

test("local Hermes compatibility accepts only the pinned public version and revision", () => {
  assert.deepEqual(verifyHermes021MacosLocalRunnerVersionV1(observed), {
    version: HERMES_021_VERSION_V1, sourceRevision: HERMES_021_SOURCE_REVISION_V1,
  });
  for (const value of [
    observed.replace("v0.21.3", "v0.21.4"),
    observed.replace("00570550", "deadbeef"),
    "Hermes Agent v0.21.3 · upstream 00570550 extra",
    "Hermes Agent v0.21.3 · upstream 00570550\u0000",
  ]) assert.throws(() => verifyHermes021MacosLocalRunnerVersionV1(value));
});

test("compatibility probe uses only fixed version arguments and never returns private output", async () => {
  const seen: unknown[] = [];
  const result = await inspectHermes021MacosLocalRunnerCompatibilityV1("/private/owner/hermes", async (file, args) => {
    seen.push({ file, args }); return observed;
  });
  assert.deepEqual(result, { version: HERMES_021_VERSION_V1, sourceRevision: HERMES_021_SOURCE_REVISION_V1 });
  assert.deepEqual(seen, [{ file: "/private/owner/hermes", args: ["--version"] }]);
  assert.throws(() => verifyHermes021MacosLocalRunnerVersionV1(observed.replace("00570550", "not-a-revision")));
});
