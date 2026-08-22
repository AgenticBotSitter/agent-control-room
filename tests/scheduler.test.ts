import assert from "node:assert/strict";
import test from "node:test";
import { projects, workers, workItems } from "../src/fixtures/data.ts";
import { chooseNextProjectWork, chooseRoute } from "../src/simulator/scheduler.ts";

const blooms = projects.find((project) => project.id === "project.blooms.content-ops")!;
const transcription = workItems.find((item) => item.id === "work.blooms.transcription")!;

test("automatic placement avoids a busy Mac and explains source authority", () => {
  const decision = chooseRoute(blooms, transcription, workers);
  assert.equal(decision.selectedWorkerId, "worker.windows-3070");
  assert.equal(decision.selectedRouteId, "route.pc.whisper-cuda");
  assert.equal(decision.authorityAction, "request_source_command");
  assert.ok(decision.rejected.some((entry) => entry.routeId === "route.mac.whisper-mlx"));
  assert.match(decision.explanation.join(" "), /remains lease authority/i);
});

test("operator can simulate the slower VPS fallback", () => {
  const decision = chooseRoute(blooms, transcription, workers, { pinnedWorkerId: "worker.vps-johnny5" });
  assert.equal(decision.selectedWorkerId, "worker.vps-johnny5");
  assert.equal(decision.estimatedDurationMinutes, 96);
  assert.equal(decision.estimatedCostUsd, 0);
});

test("Control Room-native and advisory projects produce different actions", () => {
  const wayfarer = projects.find((project) => project.authorityMode === "control_room_native")!;
  const archive = workItems.find((item) => item.id === "work.wayfarer.storage-offload")!;
  assert.equal(chooseRoute(wayfarer, archive, workers).authorityAction, "assign");

  const website = projects.find((project) => project.authorityMode === "advisory")!;
  const check = workItems.find((item) => item.id === "work.website.health-check")!;
  assert.equal(chooseRoute(website, check, workers).authorityAction, "recommend_only");
});

test("weighted fair share prevents the busiest project from always winning", () => {
  const result = chooseNextProjectWork([
    { project: blooms, workItem: transcription, projectShare: 45, recentShareUsed: 12 },
    {
      project: projects.find((item) => item.id === "project.wayfarer.lazy-river")!,
      workItem: workItems.find((item) => item.id === "work.wayfarer.storage-offload")!,
      projectShare: 45,
      recentShareUsed: 60,
    },
  ]);
  assert.equal(result.selected?.project.id, blooms.id);
  assert.match(result.explanation.join(" "), /fair-share/i);
});
