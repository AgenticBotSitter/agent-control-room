import { agents, attentionItems, blockers, projects, recentActivity, workers, workItems } from "@/src/fixtures/data";
import { CONTRACT_VERSION, assertSafeProjection } from "@/src/contracts/v1";

export function GET() {
  const snapshot = {
    contractVersion: CONTRACT_VERSION,
    generatedAt: "2026-08-22T17:30:00.000Z",
    synthetic: true,
    projects,
    workItems,
    blockers,
    attentionItems,
    workers,
    agents,
    recentActivity,
  };
  assertSafeProjection(snapshot);
  return Response.json(snapshot, {
    headers: {
      "cache-control": "no-store",
      "x-control-room-data-class": "synthetic",
      "x-control-room-contract": CONTRACT_VERSION,
    },
  });
}
