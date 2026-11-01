import assert from "node:assert/strict";
import test from "node:test";
import { createHook } from "node:async_hooks";
import { requireFirstWebsiteRehearsalPart2V1 } from "./helpers/improve-control-room-first-website";

// PART 2 STUB. This file is deliberately incapable of B5-REHEARSAL-GREEN.
// Part 2 adds the separately qualified real-launch denial probe, scripted
// transport injection, actual two-argument CLI child (exit 1/B5_PROVIDER_FIXTURE),
// question/restart/answer/plan/spec/defect/rejection/repair/cold-report joins,
// provider relabelling negatives and all forced-abort cleanup outcomes.
test("B5 controller-postgres missing qualification refuses before acquisition", async () => {
  let acquisitions = 0;
  const resources: string[] = [];
  const hook = createHook({ init(_id, type) {
    if (["PROCESSWRAP", "TCPSERVERWRAP", "TCPWRAP"].includes(type)) resources.push(type);
  } });
  hook.enable();
  try {
    await assert.rejects(requireFirstWebsiteRehearsalPart2V1().then(() => { acquisitions++; }),
      { code: "B5_A2_QUALIFICATION_REQUIRED" }, "B5 controller-postgres missing qualification guard");
  } finally { hook.disable(); }
  assert.equal(acquisitions, 0); assert.deepEqual(resources, []);
  console.log("RESULT: PASS B5 controller-postgres missing qualification acquisitions=0 child=0 PG=0 listener=0");
});

test("B5 controller-postgres part 2 stub refuses supplied packets", async () => {
  await assert.rejects(requireFirstWebsiteRehearsalPart2V1({ supplied: true }), { code: "B5_PROVIDER_SEAM_PART2_REQUIRED" });
  console.log("RESULT: PASS B5 part 2 stub cannot qualify a supplied seam packet");
});

if (process.env.CONTROL_ROOM_B5_REHEARSAL_REQUIRE_A2 === "1") {
  test("B5 real engine fixture-provider complete rehearsal", async () => {
    // Intentional hard refusal: no skipped or empty native body can claim green.
    await requireFirstWebsiteRehearsalPart2V1(process.env.CONTROL_ROOM_B5_REHEARSAL_PACKET);
  });
}
