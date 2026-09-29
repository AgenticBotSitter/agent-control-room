import assert from "node:assert/strict";
import test from "node:test";
import { resolveOwnerSelectedHermesExecutableV1 } from "../src/harness/hermes-021-v1/owner-executable-resolution";

function port(available: readonly string[]) {
  const seen: string[] = [];
  return { seen, value: {
    access: async (path: string) => { seen.push(`access:${path}`); if (!available.includes(path)) throw new Error("missing"); },
    realpath: async (path: string) => { seen.push(`realpath:${path}`); return path.replace("/bin/", "/real/"); },
    lstat: async (path: string) => { seen.push(`lstat:${path}`); return { isFile: () => path.includes("/real/") && !path.endsWith("/not-a-file") }; },
  } };
}

test("owner command resolution pins the first executable PATH candidate without revealing it", async () => {
  const fixture = port(["/private/bin/hermes"]);
  const result = await resolveOwnerSelectedHermesExecutableV1({ executableCommand: "hermes", path: "/missing/bin:/private/bin" }, fixture.value);
  assert.equal(result, "/private/real/hermes");
  assert.deepEqual(fixture.seen, ["access:/missing/bin/hermes", "access:/private/bin/hermes", "realpath:/private/bin/hermes", "lstat:/private/real/hermes"]);
});

test("owner command resolution refuses ambiguous, unsafe, non-file, and missing selections", async () => {
  const fixture = port(["/private/bin/not-a-file"]);
  await assert.rejects(() => resolveOwnerSelectedHermesExecutableV1({ executable: "/private/hermes", executableCommand: "hermes" }, fixture.value));
  await assert.rejects(() => resolveOwnerSelectedHermesExecutableV1({ executableCommand: "../hermes", path: "/private/bin" }, fixture.value));
  await assert.rejects(() => resolveOwnerSelectedHermesExecutableV1({ executableCommand: "not-a-file", path: "/private/bin" }, fixture.value));
  await assert.rejects(() => resolveOwnerSelectedHermesExecutableV1({ executableCommand: "hermes", path: "relative/bin" }, fixture.value));
});
