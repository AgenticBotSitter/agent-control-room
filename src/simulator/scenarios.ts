import { projects, workers, workItems } from "@/src/fixtures/data";
import { chooseNextProjectWork, chooseRoute } from "./scheduler";

const bloomsProject = projects.find((project) => project.id === "project.blooms.content-ops")!;
const transcription = workItems.find((work) => work.id === "work.blooms.transcription")!;

export const transcriptionScenarios = {
  automatic: chooseRoute(bloomsProject, transcription, workers),
  pinWindows: chooseRoute(bloomsProject, transcription, workers, {
    pinnedWorkerId: "worker.windows-3070",
  }),
  pinVps: chooseRoute(bloomsProject, transcription, workers, {
    pinnedWorkerId: "worker.vps-johnny5",
  }),
  waitForMac: {
    workItemId: transcription.id,
    selectedRouteId: "route.mac.whisper-mlx",
    selectedWorkerId: "worker.mac-m4",
    authorityAction: "request_source_command" as const,
    estimatedDurationMinutes: 12,
    estimatedCostUsd: 0,
    explanation: [
      "Wait for M4 Wayfarer to reach the render checkpoint, then request the verified MLX route.",
      "This preserves the preferred certified local route but delays transcription approximately three hours.",
      "Content Blooms remains lease authority; this is a simulated preference request only.",
    ],
    rejected: [],
  },
};

export const portfolioScheduleScenario = chooseNextProjectWork([
  {
    project: bloomsProject,
    workItem: transcription,
    projectShare: 45,
    recentShareUsed: 18,
  },
  {
    project: projects.find((project) => project.id === "project.wayfarer.lazy-river")!,
    workItem: workItems.find((work) => work.id === "work.wayfarer.storage-offload")!,
    projectShare: 45,
    recentShareUsed: 54,
  },
  {
    project: projects.find((project) => project.id === "project.website.public-site")!,
    workItem: workItems.find((work) => work.id === "work.website.health-check")!,
    projectShare: 10,
    recentShareUsed: 28,
  },
]);
